/**
 * Openverse audio search adapter.
 *
 * Openverse (https://openverse.org) aggregates over a million openly-licensed
 * audio records and needs no API key and no commercial agreement, which is why
 * it is what FramePilot actually ships (`plan/3rd-party-sourcing/README.md` §D4).
 * It also returns a **pre-formatted `attribution` string** per result — the exact
 * thing schema v20 persists so a credit survives to publish time.
 *
 * ## Two things this adapter refuses, and why they are refusals rather than badges
 *
 * **Non-commercial licences.** FramePilot users monetize. A badge saying "not for
 * commercial use" in a search panel does not stop a sponsored video from going
 * out with that track under it. Openverse filters these server-side via
 * `license_type=commercial`; this adapter filters again on the way in, because a
 * query-string parameter is not a guarantee and the cost of the second check is
 * one boolean.
 *
 * **Licence codes we do not recognise.** An unknown code is treated as
 * non-commercial and dropped. Openverse's vocabulary can grow, and the failure
 * modes are not symmetric: wrongly hiding a usable track costs a search result,
 * wrongly showing an unusable one costs the user a licence violation.
 *
 * ## No API key
 *
 * Openverse serves anonymous requests (20/min, 200/day). Its optional
 * authentication is an OAuth2 client-credentials exchange, not a bearer key, so
 * there is deliberately no key field anywhere in this feature — see the divergence
 * note in `plan/3rd-party-sourcing/PHASE-2-search-and-audition.md`. The in-main
 * search cache is what keeps a typing user inside the anonymous budget.
 */
import { z } from 'zod';
import { createLogger } from '@framepilot/shared-types';
import {
  MUSIC_SEARCH_MAX_LIMIT,
  MUSIC_SEARCH_TIMEOUT_MS,
  MusicProviderError,
  type MusicProvider,
  type MusicSearchQuery,
  type ProviderTrack,
  isHttpsUrl,
} from './music-types.js';
import type { FetchLike } from './types.js';

const log = createLogger('ai-sdk:providers:openverse-music');

export const OPENVERSE_API_BASE = 'https://api.openverse.org/v1';

/**
 * The Openverse endpoint this process should use.
 *
 * Read per call rather than captured, and overridable with `FRAMEPILOT_OPENVERSE_BASE`.
 * The override exists because the failure that matters here — the music library being
 * unreachable — could not otherwise be provoked honestly: the provider binds `fetch` in
 * its constructor, so a test that patches `globalThis.fetch` after the app has started is
 * patching something nobody will call, and the search quietly succeeds against the real
 * internet while claiming to be offline. Pointing the base at an unroutable address makes
 * the outage real instead of simulated.
 */
export function openverseApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['FRAMEPILOT_OPENVERSE_BASE']?.trim();
  return configured !== undefined && configured !== '' ? configured : OPENVERSE_API_BASE;
}

/**
 * Openverse asks integrators to identify themselves. A generic agent string gets
 * throttled harder, and being anonymous about it would be rude to a free service.
 */
const USER_AGENT = 'FramePilot/1.0 (+https://framepilot.app)';

/**
 * Licence codes that oblige **no** credit. Everything else does.
 *
 * Kept as an allow-list of the two public-domain marks rather than a deny-list:
 * a licence code this adapter has never seen is far more likely to require
 * attribution than to waive it, so the unknown case must fall on the
 * credit-required side.
 */
const NO_CREDIT_LICENSES: ReadonlySet<string> = new Set(['cc0', 'pdm']);

/**
 * Licence codes that permit commercial use **of an edited bed**.
 *
 * An allow-list, again deliberately. `by-nc*` are the obvious exclusions, but so
 * is anything unrecognised: see the module note on asymmetric failure modes.
 * `sampling+` is excluded — it permits commercial *sampling* but not commercial
 * advertising use, which is exactly the case a badge cannot make safe.
 *
 * **`by-nd` is excluded** (maintainer decision 2026-08-25), even though Openverse's
 * own `license_type=commercial` filter includes it. ND permits commercial *use*
 * but restricts **derivatives** — and the first thing this feature does to a bed
 * is duck it under narration and automate its level, which is precisely the gray
 * zone ND exists for. Licence safety is this feature's whole premise, so the
 * ambiguous case is refused rather than shipped with a caveat the user would have
 * to read to be safe.
 */
const COMMERCIAL_LICENSES: ReadonlySet<string> = new Set(['cc0', 'pdm', 'by', 'by-sa']);

/**
 * One Openverse audio record, as loosely as the API actually behaves.
 *
 * Nearly everything is nullish: Openverse aggregates dozens of upstream sources
 * and a record from one of them routinely omits what another always supplies
 * (`category`, `genres`, `thumbnail` and `sample_rate` all come back `null` in
 * practice). Only the four fields a track cannot exist without are required, and
 * a record missing any of them is skipped rather than failing the whole search —
 * one malformed row must not cost the user their other nineteen results.
 */
const OpenverseAudioSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullish(),
  /** **Milliseconds.** The single most important normalization in this file. */
  duration: z.number().nullish(),
  url: z.string().nullish(),
  filetype: z.string().nullish(),
  license: z.string().min(1),
  license_url: z.string().nullish(),
  attribution: z.string().nullish(),
  creator: z.string().nullish(),
  creator_url: z.string().nullish(),
  foreign_landing_url: z.string().nullish(),
});

const OpenverseSearchResponseSchema = z.object({
  result_count: z.number().nullish(),
  results: z.array(z.unknown()).nullish(),
});

/**
 * Reduce a provider `filetype` to a safe file extension.
 *
 * This value becomes part of an on-disk filename, so it is sanitized rather than
 * trusted: anything that is not a short run of letters and digits is discarded in
 * favour of `mp3`. That also normalizes a real quirk — Openverse reports Jamendo
 * records as `mp32`, which is Jamendo's *quality* code for a 96 kbps MP3, not a
 * container. Writing `bed.mp32` would produce a file nothing opens.
 */
export function safeFormat(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(value)) return 'mp3';
  if (value === 'mp32' || value === 'mp31') return 'mp3';
  return value;
}

/** Openverse durations are milliseconds; a track's is `0`/absent surprisingly often. */
function durationSeconds(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const seconds = raw / 1000;
  // A 24-hour "track" is a bad record, not a long one. Range-check before this
  // value can reach `placeAssetPatch` and produce an absurd clip.
  return seconds > 0 && seconds <= 60 * 60 * 6 ? seconds : null;
}

/**
 * Normalize one Openverse record, or `null` if it cannot be used.
 *
 * Returning `null` rather than throwing is the point: a search that dropped
 * everything because one aggregated record from one upstream source was odd
 * would be worse than a search that returns nineteen good rows.
 */
export function normalizeOpenverseTrack(raw: unknown): ProviderTrack | null {
  const parsed = OpenverseAudioSchema.safeParse(raw);
  if (!parsed.success) return null;
  const record = parsed.data;

  const license = record.license.toLowerCase();
  if (!COMMERCIAL_LICENSES.has(license)) return null;

  const url = record.url ?? '';
  if (!isHttpsUrl(url)) return null;

  const seconds = durationSeconds(record.duration);
  if (seconds === null) return null;

  const title = record.title?.trim();
  const licenseUrl = record.license_url ?? undefined;
  const creatorUrl = record.creator_url ?? undefined;
  const sourceUrl = record.foreign_landing_url ?? undefined;

  return {
    remoteId: record.id,
    provider: 'openverse',
    title: title && title.length > 0 ? title : 'Untitled',
    durationSeconds: seconds,
    // Openverse serves one file per record — the audition stream and the download
    // are the same bytes. Keeping both fields makes the contract survive a
    // provider that separates them without changing anything downstream.
    previewUrl: url,
    downloadUrl: url,
    format: safeFormat(record.filetype),
    license,
    ...(licenseUrl !== undefined && isHttpsUrl(licenseUrl) ? { licenseUrl } : {}),
    attributionRequired: !NO_CREDIT_LICENSES.has(license),
    commercialUse: true,
    ...(record.attribution ? { attribution: record.attribution } : {}),
    ...(record.creator ? { creator: record.creator } : {}),
    ...(creatorUrl !== undefined && isHttpsUrl(creatorUrl) ? { creatorUrl } : {}),
    ...(sourceUrl !== undefined && isHttpsUrl(sourceUrl) ? { sourceUrl } : {}),
  };
}

/** Map a transport failure or HTTP status onto the closed error union. */
function statusToError(status: number, retryAfter: string | null): MusicProviderError {
  if (status === 401 || status === 403) return new MusicProviderError('unauthorized');
  if (status === 429) {
    return new MusicProviderError(
      'rate_limited',
      retryAfter ? `retry after ${retryAfter}` : undefined,
    );
  }
  return new MusicProviderError('provider_unavailable', `HTTP ${status}`);
}

export class OpenverseMusicProvider implements MusicProvider {
  public readonly name = 'openverse' as const;

  public constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as FetchLike,
  ) {}

  public async search(
    query: MusicSearchQuery,
    signal?: AbortSignal,
  ): Promise<readonly ProviderTrack[]> {
    const text = query.text.trim();
    // No words means browse, not "no results". The same endpoint answers without
    // `q` — a panel that shows nothing until the user types reads as broken, and
    // an editor looking for a bed usually wants to hear one before they can name
    // what they are after.
    const limit = Math.max(1, Math.min(query.limit, MUSIC_SEARCH_MAX_LIMIT));

    const url = new URL(`${openverseApiBase()}/audio/`);
    if (text !== '') url.searchParams.set('q', text);
    // Server-side commercial-use filtering, so an NC track never arrives to be
    // mishandled. `normalizeOpenverseTrack` checks again anyway.
    url.searchParams.set('license_type', 'commercial');
    url.searchParams.set('page_size', String(limit));

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), MUSIC_SEARCH_TIMEOUT_MS);
    const onCallerAbort = (): void => timeout.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      // The query text goes to the provider; nothing else about the project does.
      log.action('search → request', {
        provider: 'openverse',
        mode: text === '' ? 'browse' : 'search',
        limit,
      });
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: timeout.signal,
      });

      if (!response.ok) {
        throw statusToError(response.status, response.headers?.get?.('retry-after') ?? null);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new MusicProviderError('provider_unavailable', 'malformed JSON');
      }

      const envelope = OpenverseSearchResponseSchema.safeParse(payload);
      if (!envelope.success) {
        throw new MusicProviderError('provider_unavailable', 'unexpected response shape');
      }

      const raw = envelope.data.results ?? [];
      const tracks = raw
        .map(normalizeOpenverseTrack)
        .filter((track): track is ProviderTrack => track !== null);
      log.action('search → results', {
        provider: 'openverse',
        returned: raw.length,
        usable: tracks.length,
      });
      return tracks;
    } catch (error) {
      throw this.toProviderError(error, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Distinguish the three ways an aborted or failed fetch can look identical.
   *
   * A caller-cancelled search, a timed-out one, and a dropped connection all
   * arrive here as thrown errors, and telling the user "no network connection"
   * when they simply typed another letter would be a lie the UI then acts on.
   */
  private toProviderError(error: unknown, signal?: AbortSignal): MusicProviderError {
    if (error instanceof MusicProviderError) return error;
    if (signal?.aborted === true) return new MusicProviderError('cancelled');
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new MusicProviderError('timeout');
    }
    return new MusicProviderError('offline', error instanceof Error ? error.message : undefined);
  }
}

/**
 * Build the configured provider.
 *
 * `fetchImpl` is injected so adapter tests run against recorded fixture
 * responses with **no live network in CI**.
 */
export function createMusicProvider(name: 'openverse', fetchImpl?: FetchLike): MusicProvider {
  // The union has one member today. The switch exists so adding the second
  // provider is a compile error here rather than a silent fallthrough.
  switch (name) {
    case 'openverse':
      return new OpenverseMusicProvider(fetchImpl);
  }
}
