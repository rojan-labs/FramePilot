/**
 * @framepilot/ai-sdk/ledger-client — read the shot ledger for a run (ADR 0175,
 * `plan/visual-understanding/03-MODEL-SURFACES.md` VU2.1).
 *
 * The host fetches this ONCE at run start, for the assets the timeline actually references,
 * and hands the snapshot to `assembleContext` the same way it hands over the footage map.
 * Everything downstream — the clip-row facts, the picture digest, the cut deltas — is a pure
 * function of what this returns, so a run's understanding of its footage is fixed for the
 * turn and cacheable as prompt prefix.
 *
 * Four rules, each of which is a cost or a truth claim:
 *
 * 1. **Never throws.** A missing sidecar, a timeout, an HTTP error or a payload the schema
 *    rejects all degrade to `null` (or to whatever was already cached). The ledger is an
 *    optimization: without it the agent knows less and the run continues, exactly as today.
 * 2. **Paged, and bounded.** `/brain/shots` returns at most `limit` rows per call with a
 *    `(assetId, shotIndex)` cursor; this pages until the engine stops handing one back, or
 *    until {@link LEDGER_MAX_PAGES} — a cursor that fails to advance can never spin.
 * 3. **Cached per `(assetId, contentHash, tierVersions)` for the process lifetime.** Shots
 *    are derived from bytes, so an asset whose content hash and tier versions are unchanged
 *    can never have different facts. A ten-turn run therefore costs ONE read, and a second
 *    run on the same project costs none. Only assets added mid-run (an `add_clip` /
 *    `add_stock` outcome) or explicitly invalidated (a tier finished indexing) are refetched.
 * 4. **Coverage is recomputed from the rows served, not copied from the last response.**
 *    A snapshot assembled from three cached assets and one freshly fetched one must report
 *    what it actually contains; a `coverage` block carried over from one page would describe
 *    a different set of assets.
 *
 * The engine half of the route is `plan/visual-understanding/02-*` (brain schema v4); this
 * file mirrors `visual-index-client.ts`'s shape — injectable `fetch`, a timeout, a chained
 * abort signal, typed honest failure — so there is one HTTP idiom in this package, not two.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  parseLedgerSnapshot,
  type AssetDigest,
  type LedgerSnapshot,
  type ShotRecord,
  type TierCoverage,
} from './ledger.js';

const log = createLogger('ai-sdk:ledger-client');

/**
 * Per-request timeout. A shots read is a bounded SQLite query over derived rows — no decode,
 * no network beyond localhost — so it is far shorter than an index slice. Long enough that a
 * cold page cache on a large project still answers; short enough that a wedged sidecar costs
 * the run seconds, not a turn.
 */
export const LEDGER_TIMEOUT_MS = 30_000;

/**
 * Rows per page. The route's own bound (plan VU2.1); asking for more is refused engine-side,
 * and asking for fewer only costs round trips.
 */
export const LEDGER_PAGE_LIMIT = 5_000;

/**
 * Safety bound on pages per fetch — 100,000 shots at the default limit, which is roughly
 * 140 hours of typical material. A cursor that repeats is caught separately and stops the
 * loop immediately; this is the backstop for one that keeps advancing forever.
 */
export const LEDGER_MAX_PAGES = 20;

/** What one run asks for: the assets its timeline references, on one project. */
export interface LedgerSnapshotRequest {
  readonly projectId: string;
  /** Asset ids to read. Duplicates are collapsed; an empty list yields an empty snapshot. */
  readonly assetIds: readonly string[];
  /**
   * Asset ids to re-read even if cached — the ONLY way a cached entry is dropped.
   *
   * Two callers have a reason to: the run loop, when an asset's index job reports `done`
   * (a tier that was absent now has rows), and a re-import of the same asset id with new
   * bytes. Neither is guessable from here, which is why this is explicit rather than a TTL:
   * a clock cannot know that a tier finished, and a wrong guess either re-bills every turn
   * or serves stale facts.
   */
  readonly refresh?: readonly string[];
  /** Rows per page; defaults to {@link LEDGER_PAGE_LIMIT}. */
  readonly limit?: number;
}

export interface LedgerClientOptions {
  /** Sidecar base URL (e.g. `http://127.0.0.1:8765`). */
  readonly baseUrl: string;
  /** Injectable `fetch` (defaults to the global) for testing / Electron net. */
  readonly fetchFn?: typeof fetch;
  /** Per-request timeout in ms; a hung sidecar must not stall a run. */
  readonly timeoutMs?: number;
  /** Rows per page; defaults to {@link LEDGER_PAGE_LIMIT}. */
  readonly pageLimit?: number;
  /** Page safety bound; defaults to {@link LEDGER_MAX_PAGES}. */
  readonly maxPages?: number;
}

/** One asset's ledger rows, and the identity that makes them reusable. */
interface CachedAsset {
  /** `assetId|contentHash|t0.t1.t2` — the cache identity, exposed for tests and logs. */
  readonly key: string;
  readonly shots: readonly ShotRecord[];
  readonly digest: AssetDigest | null;
}

const EMPTY_COVERAGE: TierCoverage = { measured: 0, labelled: 0, described: 0, total: 0 };

/** Tier versions present on an asset's rows; `0` means the tier has not run at all. */
function tierVersionsOf(shots: readonly ShotRecord[]): [number, number, number] {
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const shot of shots) {
    t0 = Math.max(t0, shot.measured?.tier0Version ?? 0);
    t1 = Math.max(t1, shot.labelled?.tier1Version ?? 0);
    t2 = Math.max(t2, shot.described?.tier2Version ?? 0);
  }
  return [t0, t1, t2];
}

/**
 * The cache identity of one asset's rows.
 *
 * Content hash first because it is what makes the facts true: different bytes are a
 * different asset as far as the ledger is concerned (`ledger.ts`). The tier versions follow
 * because a model swap bumps one of them and must invalidate exactly that asset's entry.
 * An asset the engine knows nothing about hashes as `-` and versions `0.0.0`, which is a
 * real, distinguishable identity: "asked, told nothing".
 */
function cacheKey(
  assetId: string,
  shots: readonly ShotRecord[],
  digest: AssetDigest | null,
): string {
  const contentHash = digest?.contentHash ?? shots[0]?.contentHash ?? '-';
  const [t0, t1, t2] = tierVersionsOf(shots);
  return `${assetId}|${contentHash}|${String(t0)}.${String(t1)}.${String(t2)}`;
}

/** Count how many of the served rows carry each tier. */
function coverageOf(shots: readonly ShotRecord[]): TierCoverage {
  let measured = 0;
  let labelled = 0;
  let described = 0;
  for (const shot of shots) {
    if (shot.measured) measured += 1;
    if (shot.labelled) labelled += 1;
    if (shot.described) described += 1;
  }
  return { measured, labelled, described, total: shots.length };
}

/**
 * Read the shot ledger for a run's assets, cached for the process lifetime.
 *
 * One instance per host process (the desktop main, the MCP server session); the cache lives
 * on the instance so a test gets a clean one for free and a host gets the shared one it
 * wants without a module-level singleton.
 */
export class LedgerClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageLimit: number;
  private readonly maxPages: number;
  private readonly cache = new Map<string, CachedAsset>();
  /** The last snapshot returned, and the asset identities it was assembled from. */
  private lastKey: string | null = null;
  private lastSnapshot: LedgerSnapshot | null = null;

  public constructor(options: LedgerClientOptions) {
    this.baseUrl = options.baseUrl;
    // Bind to globalThis: native `fetch` throws "Illegal invocation" when `this` is rebound
    // to the client instance (same reason as `visual-index-client.ts`).
    this.fetchFn = options.fetchFn ?? (globalThis.fetch.bind(globalThis) as typeof fetch);
    this.timeoutMs = options.timeoutMs ?? LEDGER_TIMEOUT_MS;
    this.pageLimit = options.pageLimit ?? LEDGER_PAGE_LIMIT;
    this.maxPages = options.maxPages ?? LEDGER_MAX_PAGES;
  }

  /**
   * The ledger snapshot for a run's assets — cached rows plus a paged read of the rest.
   *
   * @param request - Project, asset ids, and any assets to re-read.
   * @param signal - Caller abort; chained into the per-request timeout.
   * @returns The merged snapshot, or `null` when nothing at all could be served (the
   *   transport failed and no asset was cached). A read that fails while SOME assets are
   *   cached returns those: they are real rows about real assets, and the recomputed
   *   `coverage` says exactly how much is in hand — dropping them would make a mid-run
   *   sidecar hiccup erase the picture facts of every clip on the timeline.
   */
  public async snapshot(
    request: LedgerSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<LedgerSnapshot | null> {
    for (const assetId of request.refresh ?? []) this.cache.delete(assetId);

    const wanted = [...new Set(request.assetIds)];
    const missing = wanted.filter((assetId) => !this.cache.has(assetId));
    let failed = false;
    if (missing.length > 0) {
      const pages = await this.fetchPages(request.projectId, missing, request.limit, signal);
      if (pages === null) failed = true;
      else this.store(missing, pages);
    }

    const shots: ShotRecord[] = [];
    const digests: AssetDigest[] = [];
    const identity: string[] = [];
    for (const assetId of wanted) {
      const entry = this.cache.get(assetId);
      if (!entry) continue;
      identity.push(entry.key);
      shots.push(...entry.shots);
      if (entry.digest) digests.push(entry.digest);
    }
    if (failed && identity.length === 0) return null;

    // Return the SAME object when the served assets and their identities have not changed.
    // Every downstream projection — the picture slice, the row facts, the digest — memoizes
    // on this object (`pictureSliceFor`'s WeakMap), so a stable identity is what turns "one
    // derivation per turn" into "one derivation per run" on the turns that change no media.
    const key = identity.join('\n');
    if (this.lastSnapshot && this.lastKey === key) return this.lastSnapshot;
    const snapshot: LedgerSnapshot = {
      shots,
      digests,
      coverage: shots.length > 0 ? coverageOf(shots) : EMPTY_COVERAGE,
    };
    this.lastKey = key;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Drop cached rows for these assets, so the next {@link snapshot} re-reads them. */
  public invalidate(assetIds: readonly string[]): void {
    for (const assetId of assetIds) this.cache.delete(assetId);
  }

  /** Drop every cached asset. */
  public clearCache(): void {
    this.cache.clear();
  }

  /** The cache identity currently held for an asset, or `undefined` when it is not cached. */
  public cacheKeyFor(assetId: string): string | undefined {
    return this.cache.get(assetId)?.key;
  }

  /**
   * Page `/brain/shots` until the engine stops returning a cursor.
   *
   * Returns `null` on the FIRST failed page rather than a partial read: a half-paged asset
   * would be cached as complete and its missing shots would read as footage with nothing in
   * it, which is precisely the lie the whole ledger exists to prevent.
   */
  private async fetchPages(
    projectId: string,
    assetIds: readonly string[],
    limit: number | undefined,
    signal?: AbortSignal,
  ): Promise<LedgerSnapshot[] | null> {
    const pages: LedgerSnapshot[] = [];
    let after: string | undefined;
    for (let page = 0; page < this.maxPages; page += 1) {
      const query = new URLSearchParams({
        projectId,
        assetIds: assetIds.join(','),
        limit: String(limit ?? this.pageLimit),
      });
      if (after !== undefined) query.set('after', after);
      const got = await this.request(`/brain/shots?${query.toString()}`, signal);
      if (!got) return null;
      pages.push(got);
      const next = got.nextCursor ?? undefined;
      if (next === undefined || next === '') return pages;
      if (next === after) {
        // A cursor that does not advance is an engine bug, not a reason to spin: keep what
        // arrived and say so, loudly enough that the next page's absence is explicable.
        log.warn('shot ledger cursor did not advance; stopping with a partial read', {
          projectId,
          pages: pages.length,
        });
        return pages;
      }
      after = next;
    }
    log.warn('shot ledger read hit the page safety bound', { projectId, pages: pages.length });
    return pages;
  }

  /**
   * Fold the pages into one cache entry per requested asset.
   *
   * Every requested asset gets an entry, INCLUDING the ones the engine returned nothing for:
   * "this asset has no shots yet" is an answer, and caching it is what stops a run re-asking
   * on every turn for footage that has not been analysed.
   */
  private store(requested: readonly string[], pages: readonly LedgerSnapshot[]): void {
    const shotsByAsset = new Map<string, ShotRecord[]>();
    const digestByAsset = new Map<string, AssetDigest>();
    for (const page of pages) {
      for (const shot of page.shots) {
        const bucket = shotsByAsset.get(shot.assetId);
        if (bucket) bucket.push(shot);
        else shotsByAsset.set(shot.assetId, [shot]);
      }
      for (const digest of page.digests) digestByAsset.set(digest.assetId, digest);
    }
    for (const assetId of requested) {
      const shots = shotsByAsset.get(assetId) ?? [];
      const digest = digestByAsset.get(assetId) ?? null;
      this.cache.set(assetId, { key: cacheKey(assetId, shots, digest), shots, digest });
    }
  }

  /**
   * One fetch + tolerant parse with a timeout. Never throws: an aborted or failed request, a
   * non-2xx status, or a payload `parseLedgerSnapshot` rejects all resolve to `undefined`.
   */
  private async request(path: string, signal?: AbortSignal): Promise<LedgerSnapshot | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onExternalAbort);
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        log.debug('shot ledger route → HTTP error; degrading', { status: response.status });
        return undefined;
      }
      const parsed = parseLedgerSnapshot(await response.json());
      if (!parsed) {
        log.warn('shot ledger route → payload did not match the ledger schema; degrading');
        return undefined;
      }
      return parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.debug('shot ledger route → request failed; degrading', { reason });
      return undefined;
      // v8 reports a phantom uncovered branch on an async try's `finally`; both paths are
      // exercised (see ledger-client.test.ts). Same quirk as `visual-index-client.ts`.
      /* v8 ignore next */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
