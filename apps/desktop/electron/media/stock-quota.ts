/**
 * Last-observed stock-provider quota, owned by main and persisted.
 *
 * ## Why this is observed and never computed
 *
 * The obvious implementation keeps a local counter and decrements it per request.
 * It is also wrong: the same API key can be used by another FramePilot window,
 * another machine, or a script the user wrote last month, and a local counter
 * would drift away from the truth silently — while looking authoritative on
 * screen. So `remaining` is only ever set from a response header, and the UI
 * always shows when it was observed.
 *
 * ## Why the hourly limit is not modelled
 *
 * Pexels enforces ~200 requests/hour **and** 20,000/month, but reports only the
 * monthly figure in `X-Ratelimit-*`. A 429 can therefore arrive while the monthly
 * numbers look perfectly healthy, and both facts are true simultaneously. Rather
 * than invent an hourly counter, {@link StockQuotaStore.observeRateLimited}
 * records that a 429 happened and *preserves* the monthly observation, so the UI
 * can state two facts instead of contradicting itself
 * (`plan/3rd-party-sourcing/photo-video/PEXELS-API.md` §3).
 *
 * ## Why its own file rather than a field in `ai-config.json`
 *
 * This is observed telemetry, not configuration. It changes on its own schedule,
 * it is disposable, and a corrupt read here must degrade to "not measured" rather
 * than take the AI provider settings down with it.
 *
 * No `electron` import — the store takes a file path and stays unit-testable
 * without an Electron runtime, exactly as `ai/ai-config.ts` does.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type { StockQuotaObservationWire, StockQuotaSnapshot } from '@framepilot/shared-types';
import { parseQuotaHeaders, parseRetryAfterSeconds, type HeaderLike } from '@framepilot/ai-sdk';

const log = createLogger('desktop:stock-quota');

/** The on-disk shape. Versioned so a future field is additive, not a guess. */
interface StoredQuota {
  readonly version: 1;
  readonly monthly?: StockQuotaObservationWire;
  /** ISO-8601 of the most recent 429, when one is still worth reporting. */
  readonly rateLimitedSince?: string;
  readonly retryAfterSeconds?: number;
}

/**
 * How long a 429 keeps colouring the UI.
 *
 * The hourly window is invisible to us, so the alternative to a timeout is a
 * banner that stays up until the next successful request — which, for a user who
 * gave up and came back tomorrow, would be a lie about the present.
 */
const RATE_LIMIT_STICKY_MS = 60 * 60 * 1000;

export interface StockQuotaStoreOptions {
  readonly filePath: string;
  /**
   * Whether a provider key is configured right now.
   *
   * Injected rather than tracked, because key custody lives in `ai/ai-config.ts`.
   * A copy here would be a second answer to "is there a key" that could disagree
   * with the first, and the disagreement would surface as a quota panel for a key
   * the user already deleted.
   */
  readonly isKeyConfigured: () => boolean;
  readonly now?: () => number;
}

export class StockQuotaStore {
  private readonly filePath: string;
  private readonly isKeyConfigured: () => boolean;
  private readonly now: () => number;
  private state: StoredQuota;
  private listeners = new Set<(snapshot: StockQuotaSnapshot) => void>();

  public constructor(options: StockQuotaStoreOptions) {
    this.filePath = options.filePath;
    this.isKeyConfigured = options.isKeyConfigured;
    this.now = options.now ?? Date.now;
    this.state = this.hydrate();
  }

  private hydrate(): StoredQuota {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredQuota>;
      return {
        version: 1,
        ...(isObservation(parsed.monthly) ? { monthly: parsed.monthly } : {}),
        ...(typeof parsed.rateLimitedSince === 'string'
          ? { rateLimitedSince: parsed.rateLimitedSince }
          : {}),
        ...(typeof parsed.retryAfterSeconds === 'number'
          ? { retryAfterSeconds: parsed.retryAfterSeconds }
          : {}),
      };
    } catch {
      // Missing or corrupt costs the user one "not measured yet" until their next
      // search. Throwing here would take the whole stock surface down over a file
      // that exists only to save them a single request.
      return { version: 1 };
    }
  }

  /**
   * Record what a provider response said about the quota.
   *
   * Silently ignores a response with no rate-limit headers — CDN hosts serving
   * thumbnails and downloads do not send them, and treating their absence as
   * "quota unknown" would blank a good reading every time a tile loaded.
   */
  public observe(headers: HeaderLike, at: Date = new Date(this.now())): void {
    const observation = parseQuotaHeaders(headers, at);
    if (observation === undefined) return;

    // Only ever move forward. A slow response that started before a faster one
    // must not overwrite the newer numbers with its staler view.
    const current = this.state.monthly;
    if (
      current !== undefined &&
      Date.parse(current.observedAt) > Date.parse(observation.observedAt)
    ) {
      return;
    }

    // `rateLimitedSince` is deliberately dropped rather than carried over: a
    // successful, header-bearing response is direct evidence that the hourly
    // window has reopened, which beats waiting out a timer.
    this.state = { version: 1, monthly: observation };
    this.persist();
    this.emit();
  }

  /** Record a 429, preserving whatever the monthly figures last said. */
  public observeRateLimited(headers?: HeaderLike, at: Date = new Date(this.now())): void {
    const retryAfterSeconds = headers ? parseRetryAfterSeconds(headers) : undefined;
    this.state = {
      version: 1,
      ...(this.state.monthly !== undefined ? { monthly: this.state.monthly } : {}),
      rateLimitedSince: at.toISOString(),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
    log.warn('stock quota → rate limited', { retryAfterSeconds });
    this.persist();
    this.emit();
  }

  /** The snapshot the UI renders. */
  public snapshot(): StockQuotaSnapshot {
    if (!this.isKeyConfigured()) return { kind: 'no_key' };

    const { monthly, rateLimitedSince, retryAfterSeconds } = this.state;
    if (rateLimitedSince !== undefined) {
      const age = this.now() - Date.parse(rateLimitedSince);
      if (Number.isFinite(age) && age < RATE_LIMIT_STICKY_MS) {
        return {
          kind: 'hourly_limited',
          ...(monthly !== undefined ? { monthly } : {}),
          since: rateLimitedSince,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        };
      }
    }

    // Not a zero, not a guessed maximum: the honest answer before any request.
    return monthly === undefined ? { kind: 'unmeasured' } : { kind: 'measured', monthly };
  }

  /** Key cleared. A stale quota for a key you no longer have is noise. */
  public reset(): void {
    this.state = { version: 1 };
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // A quota file we cannot delete is a cosmetic problem, not a failure worth
      // propagating to a user who was only clearing a key.
    }
    this.emit();
  }

  public subscribe(listener: (snapshot: StockQuotaSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(temp, this.filePath);
    } catch (error) {
      // Losing the persisted quota costs one "not measured yet" after a restart.
      // It is not worth failing a search the user is waiting on.
      log.warn('stock quota → persist failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function isObservation(value: unknown): value is StockQuotaObservationWire {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['limit'] === 'number' &&
    typeof record['remaining'] === 'number' &&
    typeof record['resetAt'] === 'string' &&
    typeof record['observedAt'] === 'string'
  );
}
