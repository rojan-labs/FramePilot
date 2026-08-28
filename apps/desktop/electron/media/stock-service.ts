/**
 * Main-process stock sourcing: search, tile bytes, hover preview, and download.
 *
 * ## Why this lives in main
 *
 * Same reason as music: the renderer's CSP is `connect-src 'self' fp-media:
 * <engine>` (`security/media-protocol.ts`) and this feature does **not** change
 * it. Main does the network; the renderer receives bytes over IPC and wraps them
 * in a `blob:` URL, which `img-src`/`media-src ... blob:` already allow. The
 * renderer is never handed a provider URL at all, so the guarantee is structural
 * rather than a rule someone can forget.
 *
 * If you find yourself wanting to add `api.pexels.com` to `connect-src`, the
 * slice is wrong — stop and re-read `plan/3rd-party-sourcing/photo-video/README.md` §4.
 *
 * ## Caching is what makes a metered key usable
 *
 * Pexels allows ~200 requests/hour. A user typing into a search box with a 300 ms
 * debounce burns that in minutes without a cache, and the failure they get is a
 * 429 that reads as "the feature is broken". Serve the cache first, and never
 * spend a request the user did not ask for.
 *
 * ## Video is not audio, and the difference shows here
 *
 * A music track is 4 MB; a 1080p stock clip is routinely 200 MB. So progress is
 * throttled rather than per-chunk, the body streams to disk instead of being
 * concatenated in memory, and the size cap is checked before the first byte and
 * again as a running total.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import {
  STOCK_DOWNLOAD_MAX_MS,
  STOCK_DOWNLOAD_STALL_MS,
  STOCK_MAX_DOWNLOAD_BYTES,
  STOCK_SEARCH_DEFAULT_LIMIT,
  STOCK_THUMBNAIL_TIMEOUT_MS,
  StockProviderError,
  chooseVariant,
  createStockProvider,
  isVariantBelowTarget,
  safeStockFormat,
  type StockItem,
  type StockMediaKind,
  type StockProvider,
  type StockVariant,
  toStockItemWire,
} from '@framepilot/ai-sdk';
import type {
  StockBytesResult,
  StockDownloadProgressWire,
  StockDownloadRequest,
  StockDownloadResult,
  StockDownloadedAssetWire,
  StockErrorCodeWire,
  StockSearchRequest,
  StockSearchResult,
} from '../ipc/contract.js';
import { dedupeName, mediaRelativeDir, safeFileName } from '../projects/media-import.js';
import type { DerivedAssetMedia } from './asset-media-client.js';
import type { StockQuotaStore } from './stock-quota.js';

const log = createLogger('desktop:stock');

/** Search cache TTL. Stale stock results have no value across sessions. */
const SEARCH_TTL_MS = 5 * 60 * 1000;
/** Bounded so a long session cannot grow the cache without limit. */
const SEARCH_CACHE_MAX = 50;
/**
 * Tile bytes held in memory. Double the music preview budget: a grid holds many
 * more images than a track list holds previews, and re-searching a query the
 * user already looked at must cost nothing.
 */
/**
 * How many searched items stay actionable by `remoteId`. Generous — many pages
 * of results — but finite: the renderer can only act on what it is still
 * showing, and an unbounded table is a slow leak in the process that also runs
 * the window.
 */
const KNOWN_ITEMS_MAX = 2000;
const THUMBNAIL_CACHE_MAX_BYTES = 40 * 1024 * 1024;
/**
 * Hover-scrub renditions. Their own budget, because one of them outweighs a
 * hundred tiles and would otherwise evict the entire grid on first hover.
 */
const PREVIEW_CACHE_MAX_BYTES = 120 * 1024 * 1024;
/** Progress announcements. Per-chunk on a 400 MB file is 6,400 IPC messages. */
const PROGRESS_INTERVAL_MS = 250;

/** The download ledger's on-disk shape, shared with the music slice. */
interface SourcesLedgerEntry {
  readonly fileName: string;
  readonly provider: string;
  readonly remoteId: string;
  /** Stock only: the same clip at 720p and 1080p are different files. */
  readonly variantId?: string;
  readonly kind?: string;
  readonly license: string;
  readonly attributionRequired: boolean;
  readonly downloadedAt: string;
}

interface SourcesLedger {
  readonly version: 1;
  readonly entries: readonly SourcesLedgerEntry[];
}

interface CachedSearch {
  readonly items: readonly StockItem[];
  readonly page: number;
  readonly totalResults: number;
  readonly hasMore: boolean;
  readonly expiresAt: number;
}

interface CachedBytes {
  readonly contentType: string;
  readonly data: Buffer;
}

export interface StockServiceOptions {
  /** Absolute path of the projects root; every write is resolved inside it. */
  readonly projectsRoot: string;
  /** Resolves the current key, or undefined. Read per call: it can change. */
  readonly resolveApiKey: () => string | undefined;
  /** Observes quota from every provider response. */
  readonly quota: StockQuotaStore;
  /**
   * Derive kind/duration/thumbnails/proxy for a downloaded file. Failure is non-fatal.
   *
   * Typed as {@link DerivedAssetMedia} — the sidecar client's own result — so the derived
   * media can only be read from where it actually lives (`media`), never from a flat shape
   * that type-checks and reads `undefined`.
   */
  readonly deriveAssetMedia: (absolutePath: string) => Promise<DerivedAssetMedia | null>;
  /** Injected for tests. Defaults to the real Pexels adapter. */
  readonly provider?: StockProvider;
  /** Injected for tests; used for tile, preview and download bytes. */
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (message: StockDownloadProgressWire) => void;
  readonly now?: () => number;
}

/** Normalize a query so "City  Skyline" and "city skyline" share one cache entry. */
function cacheKey(
  request: Required<Pick<StockSearchRequest, 'text' | 'kind'>> & {
    page: number;
    limit: number;
    orientation?: string;
  },
): string {
  const text = request.text.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${text}::${request.kind}::${request.page}::${request.limit}::${request.orientation ?? ''}`;
}

/** Convert any thrown value into a wire error, never letting one escape untyped. */
function toWireError(error: unknown): { error: StockErrorCodeWire; detail?: string } {
  if (error instanceof StockProviderError) {
    return error.detail === undefined
      ? { error: error.code }
      : { error: error.code, detail: error.detail };
  }
  const detail = error instanceof Error ? error.message : undefined;
  return detail === undefined
    ? { error: 'provider_unavailable' }
    : { error: 'provider_unavailable', detail };
}

/** ENOSPC has one honest answer, and it is not "the download failed". */
function isDiskFull(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOSPC';
}

/**
 * How a caller relates to the searches around it. Main-process only — deliberately NOT on
 * the IPC `StockSearchRequest`, because this is about the caller's own concurrency, not
 * about what to search for.
 */
export interface StockSearchOptions {
  /**
   * Does this search REPLACE the one this caller issued a moment ago?
   *
   * True (the default) for the Stock panel, where each keystroke revises one question and
   * only the last answer is wanted. False for the agent, whose searches are independent
   * questions asked in parallel — see the note in `search` for the run this cost.
   */
  readonly supersedePrevious?: boolean;
  /** The caller's own lifetime, if it has one (an agent run's Stop). */
  readonly signal?: AbortSignal;
}

/**
 * Transport failures worth one more attempt, and nothing else.
 *
 * Read from the captured run's own failure ladder: timeout → `ERR_QUIC_PROTOCOL_ERROR` →
 * `ERR_NAME_NOT_RESOLVED` → `ERR_INTERNET_DISCONNECTED`, the last of them failing in 74ms
 * without reaching the network. Those are Chromium session state, not Pexels refusing —
 * six of eighteen downloads died that way, clustered at the tail of a long serial chain.
 *
 * `too_large`, `unauthorized`, `not_found` and `cancelled` are deliberately absent: they
 * are answers, and replaying them wastes the user's quota to be told the same thing twice.
 */
const RETRYABLE_DOWNLOAD_ERRORS: ReadonlySet<string> = new Set([
  'download_failed',
  'timeout',
  'rate_limited',
]);

/** Is this failure the transport wobbling rather than the provider answering? */
function isRetryableDownloadFailure(error: unknown, aborted: boolean): boolean {
  // A user's own cancel aborts the same controller a stall does. Never replay one.
  if (aborted && !(error instanceof StockProviderError)) return false;
  if (error instanceof StockProviderError) return RETRYABLE_DOWNLOAD_ERRORS.has(error.code);
  // A raw network error (`net::ERR_*`) never reached the classifier — that is the QUIC and
  // DNS family, which is exactly what this retry exists for.
  return error instanceof Error && error.name !== 'AbortError';
}

/**
 * Abort `controller` when `signal` does, and hand back the unsubscribe.
 *
 * Returns a no-op when there is no signal, so the caller's `finally` needs no branch. An
 * already-aborted signal aborts immediately rather than waiting for an event that has
 * been and gone.
 */
function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export class StockService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly searchCache = new Map<string, CachedSearch>();
  private readonly thumbnailCache = new Map<string, CachedBytes>();
  private readonly previewCache = new Map<string, CachedBytes>();
  private thumbnailBytes = 0;
  private previewBytes = 0;
  /**
   * Items seen in a search, so the renderer can act on one by `remoteId` alone.
   * This is the table that lets every provider URL stay in main.
   *
   * Bounded, like every other cache here: a long session of searches would
   * otherwise grow it without limit. Oldest-first eviction is right because
   * "act on a result" only ever means a result the user can still see.
   */
  private readonly knownItems = new Map<string, StockItem>();
  private readonly downloads = new Map<string, AbortController>();
  /**
   * Downloads currently in flight, keyed `provider|remoteId|variantId`.
   *
   * The agent now issues a turn's downloads CONCURRENTLY (03), and two calls for the same
   * clip would otherwise both miss the ledger — it is written only after the rename — take
   * the same `dedupeName` (the real file does not exist yet, only two `.tmp`s), and both
   * rename onto the same path. Last writer wins atomically, so nothing corrupts, but the
   * bytes are paid for twice. Sharing the promise makes the second caller wait for the
   * first instead.
   */
  private readonly inFlight = new Map<string, Promise<StockDownloadResult>>();
  /**
   * Serializes `sources.json` writes.
   *
   * `appendLedger` is a read-modify-write. It re-reads rather than trusting a stale
   * snapshot, which is necessary but not sufficient: two concurrent completions can still
   * interleave read/read/write/write and lose an entry, and a lost entry costs a redundant
   * download later — the exact cost this concurrency exists to remove.
   */
  private ledgerWrites: Promise<unknown> = Promise.resolve();
  /**
   * Projects already swept for crash-left `.tmp` fragments this session.
   *
   * Swept lazily on a project's first download rather than at startup: it needs no new IPC,
   * it cannot delay app launch, and a project that never downloads has nothing to sweep.
   */
  private readonly swept = new Set<string>();
  private inFlightSearch: AbortController | null = null;
  /** Built per call, because the key can change without restarting the app. */
  private cachedProvider: { key: string; provider: StockProvider } | null = null;

  public constructor(private readonly options: StockServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private provider(): StockProvider {
    if (this.options.provider) return this.options.provider;
    const apiKey = this.options.resolveApiKey();
    if (apiKey === undefined) throw new StockProviderError('no_key');
    if (this.cachedProvider?.key !== apiKey) {
      this.cachedProvider = { key: apiKey, provider: createStockProvider('pexels', { apiKey }) };
    }
    return this.cachedProvider.provider;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  public async search(
    request: StockSearchRequest,
    options: StockSearchOptions = {},
  ): Promise<StockSearchResult> {
    const page = Math.max(1, Math.trunc(request.page ?? 1));
    const limit = Math.max(1, Math.trunc(request.limit ?? STOCK_SEARCH_DEFAULT_LIMIT));
    const key = cacheKey({ ...request, page, limit });

    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      // Cache first, always. A cached hit spent no request, so it deliberately
      // does NOT touch the quota store — moving the meter here would make the
      // Settings readout drift away from what the provider actually counted.
      for (const item of cached.items) this.rememberItem(item);
      return {
        ok: true,
        items: cached.items.map(toStockItemWire),
        page: cached.page,
        totalResults: cached.totalResults,
        hasMore: cached.hasMore,
      };
    }

    const controller = new AbortController();
    // A superseded search is cancelled, not merely ignored — an abandoned request still
    // counts against the hourly limit. That is the panel's contract: a person typing
    // "waterfall" issues six searches and means the last one.
    //
    // It is the wrong contract for the agent, and applying it to both callers cost a run.
    // The agent batches concurrency-safe calls four at a time (`DEFAULT_MAX_TOOL_CONCURRENCY`),
    // so four DELIBERATE, different searches arrive together — and each one aborted the
    // one before it. In run `f014f3ac` fifteen of twenty-one stock searches died that way:
    // the fourth query of every batch returned forty clips in ~1.8s while the first three
    // came back `cancelled` in ~120ms. Worse, `cancelled` renders as the empty string by
    // design (a user's own Stop should not be narrated back at them), so the model was
    // handed three failures with no reason and simply asked again. The run never got past
    // gathering footage.
    //
    // So superseding is now the CALLER's declaration, defaulting to the panel behaviour so
    // the IPC path is untouched. Only a superseding search registers itself, which also
    // means a person browsing the Stock panel mid-run cannot cancel the agent's fetch, or
    // the agent theirs.
    if (options.supersedePrevious !== false) {
      this.inFlightSearch?.abort();
      this.inFlightSearch = controller;
    }
    // A caller that owns a lifetime (the agent run's Stop) links it here rather than
    // through the superseding slot, which is about replacement, not cancellation.
    const unlink = linkAbort(options.signal, controller);

    try {
      const result = await this.provider().search(
        {
          text: request.text,
          kind: request.kind,
          limit,
          page,
          ...(request.orientation !== undefined ? { orientation: request.orientation } : {}),
        },
        controller.signal,
      );

      if (result.quota !== undefined) this.options.quota.observe(quotaHeadersOf(result.quota));

      this.remember(key, result);
      return {
        ok: true,
        items: result.items.map(toStockItemWire),
        page: result.page,
        totalResults: result.totalResults,
        hasMore: result.hasMore,
      };
    } catch (error) {
      // A 429 must reach the quota store, or the Settings panel will keep
      // showing a healthy monthly bar while every search fails.
      if (error instanceof StockProviderError && error.code === 'rate_limited') {
        this.options.quota.observeRateLimited();
      }
      return { ok: false, ...toWireError(error) };
    } finally {
      unlink();
      if (this.inFlightSearch === controller) this.inFlightSearch = null;
    }
  }

  private remember(
    key: string,
    result: { items: readonly StockItem[]; page: number; totalResults: number; hasMore: boolean },
  ): void {
    if (this.searchCache.size >= SEARCH_CACHE_MAX) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.searchCache.keys().next();
      if (!oldest.done) this.searchCache.delete(oldest.value);
    }
    this.searchCache.set(key, {
      items: result.items,
      page: result.page,
      totalResults: result.totalResults,
      hasMore: result.hasMore,
      expiresAt: this.now() + SEARCH_TTL_MS,
    });
    for (const item of result.items) this.rememberItem(item);
  }

  // -------------------------------------------------------------------------
  // Tile and hover-preview bytes
  // -------------------------------------------------------------------------

  public async thumbnail(remoteId: string): Promise<StockBytesResult> {
    return this.bytes(remoteId, 'thumbnail');
  }

  public async preview(remoteId: string): Promise<StockBytesResult> {
    return this.bytes(remoteId, 'preview');
  }

  private async bytes(remoteId: string, which: 'thumbnail' | 'preview'): Promise<StockBytesResult> {
    const item = this.knownItems.get(remoteId);
    if (!item) {
      // Not a provider failure: the renderer asked about an item this process
      // never saw, which means its results are from a previous run. Say that
      // rather than reporting the provider is down.
      return { ok: false, error: 'provider_unavailable', detail: 'unknown item' };
    }

    const url = which === 'preview' ? item.previewUrl : item.thumbnailUrl;
    if (url === undefined) {
      return { ok: false, error: 'provider_unavailable', detail: 'no preview for this item' };
    }

    const cache = which === 'preview' ? this.previewCache : this.thumbnailCache;
    const cached = cache.get(remoteId);
    if (cached) {
      return { ok: true, contentType: cached.contentType, data: toArrayBuffer(cached.data) };
    }

    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(STOCK_THUMBNAIL_TIMEOUT_MS),
      });
      if (!response.ok) throw statusError(response.status);
      // Checked BEFORE buffering, not after. The cache budget below refuses an
      // oversized entry, but by then the bytes are already resident in main —
      // a provider serving a 2 GB "preview" would spike the process that also
      // runs the window's event loop. A declared length above the whole cache
      // budget cannot be worth showing, so it is declined unread.
      const declared = Number(response.headers.get('content-length') ?? '0');
      const budget = which === 'preview' ? PREVIEW_CACHE_MAX_BYTES : THUMBNAIL_CACHE_MAX_BYTES;
      if (Number.isFinite(declared) && declared > budget) {
        throw new StockProviderError('too_large', 'preview is implausibly large');
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > budget) {
        // A missing or lying Content-Length is the case the check above cannot
        // cover; the bytes are spent either way, but they are not kept.
        throw new StockProviderError('too_large', 'preview is implausibly large');
      }
      const contentType =
        response.headers.get('content-type') ?? (which === 'preview' ? 'video/mp4' : 'image/jpeg');
      this.rememberBytes(which, remoteId, { contentType, data });
      return { ok: true, contentType, data: toArrayBuffer(data) };
    } catch (error) {
      return { ok: false, ...toWireError(normalizeFetchError(error)) };
    }
  }

  /** Remember an item by id, evicting the oldest once the table is full. */
  private rememberItem(item: StockItem): void {
    // Re-inserting moves it to the back of the insertion order, so an item the
    // user keeps seeing is never the one evicted.
    this.knownItems.delete(item.remoteId);
    this.knownItems.set(item.remoteId, item);
    while (this.knownItems.size > KNOWN_ITEMS_MAX) {
      const oldest = this.knownItems.keys().next();
      if (oldest.done === true) break;
      this.knownItems.delete(oldest.value);
    }
  }

  private rememberBytes(
    which: 'thumbnail' | 'preview',
    remoteId: string,
    entry: CachedBytes,
  ): void {
    const cache = which === 'preview' ? this.previewCache : this.thumbnailCache;
    const budget = which === 'preview' ? PREVIEW_CACHE_MAX_BYTES : THUMBNAIL_CACHE_MAX_BYTES;
    // One oversized entry must not evict everything else, so refuse to cache it
    // rather than emptying the cache to fit it.
    if (entry.data.byteLength > budget) return;

    let used = which === 'preview' ? this.previewBytes : this.thumbnailBytes;
    while (used + entry.data.byteLength > budget) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      used -= cache.get(oldest.value)?.data.byteLength ?? 0;
      cache.delete(oldest.value);
    }
    cache.set(remoteId, entry);
    used += entry.data.byteLength;
    if (which === 'preview') this.previewBytes = used;
    else this.thumbnailBytes = used;
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * {@link appendLedger}, one writer at a time.
   *
   * Chained rather than locked: each append waits for the previous one to settle (including
   * a rejection — a failed write must not stall every later one), so a turn's concurrent
   * downloads cannot interleave their read-modify-write and drop an entry.
   */
  private async appendLedgerSerially(ledgerPath: string, entry: SourcesLedgerEntry): Promise<void> {
    const write = this.ledgerWrites
      .catch(() => undefined)
      .then(() => appendLedger(ledgerPath, entry));
    this.ledgerWrites = write.catch(() => undefined);
    await write;
  }

  /**
   * Remove `.tmp` files a previous session left behind in a project's media directory.
   *
   * A download writes to `<file>.<pid>.<uuid>.tmp` and renames on success; a failure
   * unlinks it. A CRASH does neither, so the fragment survives — invisible to the media
   * bin (it is not in the ledger) and to `fp-media://`, but occupying disk forever. Nothing
   * ever swept them, and a run that downloads eighteen clips has eighteen chances to leave
   * one.
   *
   * Best-effort by construction: a fragment that cannot be read or removed is skipped
   * rather than failing the caller. Losing a sweep costs disk; failing a project open over
   * one would cost the session.
   *
   * @param projectId - The project whose media directory to sweep.
   * @returns How many fragments were removed.
   */
  public async sweepPartialDownloads(projectId: string): Promise<number> {
    const relativeDir = mediaRelativeDir(projectId);
    let absoluteDir: string;
    try {
      absoluteDir = resolveWithin(this.options.projectsRoot, relativeDir);
    } catch {
      return 0;
    }
    let entries: string[];
    try {
      entries = await readdir(absoluteDir);
    } catch {
      // No media directory yet — nothing downloaded, nothing to sweep.
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.tmp')) continue;
      try {
        await unlink(path.join(absoluteDir, entry));
        removed += 1;
      } catch {
        // A fragment held open by another window, or already gone. Skip it.
      }
    }
    if (removed > 0) log.action('swept partial downloads', { projectId, removed });
    return removed;
  }

  public cancelDownload(operationId: string): void {
    this.downloads.get(operationId)?.abort();
  }

  public async download(request: StockDownloadRequest): Promise<StockDownloadResult> {
    const item = this.knownItems.get(request.remoteId);
    if (!item) {
      return { ok: false, error: 'provider_unavailable', detail: 'unknown item' };
    }

    const variant = this.resolveVariant(item, request);
    // Share one fetch between concurrent callers asking for the same file (see `inFlight`).
    // Keyed on the variant as well as the id, for the same reason the ledger dedupe is: the
    // same clip at 720p and at 1080p are different files.
    const flightKey = `${item.provider}|${item.remoteId}|${variant.id}`;
    const inFlight = this.inFlight.get(flightKey);
    if (inFlight) return inFlight;
    const flight = this.downloadUnshared(request, item, variant);
    this.inFlight.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /** {@link download} without the in-flight sharing — never call this directly. */
  private async downloadUnshared(
    request: StockDownloadRequest,
    item: StockItem,
    variant: StockVariant,
  ): Promise<StockDownloadResult> {
    if (variant.approxBytes !== undefined && variant.approxBytes > STOCK_MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: 'too_large' };
    }

    const relativeDir = mediaRelativeDir(request.projectId);
    const absoluteDir = resolveWithin(this.options.projectsRoot, relativeDir);
    await mkdir(absoluteDir, { recursive: true });
    // First download into this project: clear any fragment a crashed session left behind.
    // Awaited, not fire-and-forget — sweeping WHILE this download writes its own `.tmp`
    // could delete the file being streamed.
    if (!this.swept.has(request.projectId)) {
      this.swept.add(request.projectId);
      await this.sweepPartialDownloads(request.projectId);
    }

    const ledgerPath = path.join(absoluteDir, 'sources.json');
    const ledger = await readLedger(ledgerPath);

    // Dedupe before spending bandwidth. Keyed on the VARIANT too: the same clip
    // at 720p and at 1080p are different files, and a user who deliberately
    // reaches for the larger one should get it.
    const existing = ledger.entries.find(
      (entry) =>
        entry.provider === item.provider &&
        entry.remoteId === item.remoteId &&
        (entry.variantId ?? '') === variant.id,
    );
    if (existing) {
      const relativePath = path.posix.join(relativeDir, existing.fileName);
      const absolutePath = resolveWithin(this.options.projectsRoot, relativePath);
      if (await exists(absolutePath)) {
        log.action('download → deduped', { remoteId: item.remoteId, variantId: variant.id });
        return {
          ok: true,
          asset: await this.materialize(item, variant, relativePath, absolutePath, true),
        };
      }
      // The ledger says we have it but the file is gone (the user deleted it).
      // Fall through and fetch again rather than returning a broken asset.
    }

    const controller = new AbortController();
    this.downloads.set(request.operationId, controller);
    const fileName = await dedupeName(
      absoluteDir,
      safeFileName(`${item.title}-${item.remoteId}.${variant.format}`),
      nodeExists,
    );
    const relativePath = path.posix.join(relativeDir, fileName);
    const absolutePath = resolveWithin(this.options.projectsRoot, relativePath);
    const tempPath = `${absolutePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;

    try {
      log.action('download → start', {
        remoteId: item.remoteId,
        variantId: variant.id,
        height: variant.height,
        operationId: request.operationId,
      });
      const bytes = await this.streamWithOneRetry(variant, tempPath, request, controller);
      await rename(tempPath, absolutePath);
      await this.appendLedgerSerially(ledgerPath, {
        fileName,
        provider: item.provider,
        remoteId: item.remoteId,
        variantId: variant.id,
        kind: item.kind,
        license: item.license,
        attributionRequired: item.attributionRequired,
        downloadedAt: new Date().toISOString(),
      });
      log.action('download → installed', { remoteId: item.remoteId, bytes });

      this.emit(request, 'deriving', bytes, bytes);
      const asset = await this.materialize(item, variant, relativePath, absolutePath, false);
      this.emit(request, 'installed', bytes, bytes);
      return { ok: true, asset };
    } catch (error) {
      // A partial file must never be reachable — not by the bin, not by
      // `fp-media://`, not by a later dedupe check.
      await unlink(tempPath).catch(() => undefined);
      // A stall aborts the SAME controller a user cancel does, so "the signal is
      // aborted" no longer identifies a cancel on its own. An error the stream
      // classified deliberately (`StockProviderError`) is trusted over the
      // signal: a raw `AbortError` is what a real user cancel leaves behind.
      const cancelled = controller.signal.aborted && !(error instanceof StockProviderError);
      const wire = cancelled
        ? { error: 'cancelled' as const }
        : isDiskFull(error)
          ? { error: 'disk_full' as const }
          : toWireError(normalizeFetchError(error, 'download_failed'));
      this.emit(
        request,
        cancelled ? 'cancelled' : 'failed',
        0,
        0,
        wire.error,
        'detail' in wire ? wire.detail : undefined,
      );
      log.warn('download → failed', { remoteId: item.remoteId, code: wire.error });
      return { ok: false, ...wire };
    } finally {
      this.downloads.delete(request.operationId);
    }
  }

  /**
   * Which rendition to fetch.
   *
   * An explicit `variantId` wins, because a user who picked a size meant it.
   * Otherwise the project's own height decides, which is what keeps a 1080p
   * timeline from pulling 400 MB of 4K it will only downscale.
   */
  private resolveVariant(item: StockItem, request: StockDownloadRequest): StockVariant {
    if (request.variantId !== undefined) {
      const named = item.variants.find((variant) => variant.id === request.variantId);
      if (named) return named;
    }
    return chooseVariant(item.variants, {
      height: request.targetHeight ?? 1080,
      ...(request.targetFps !== undefined ? { fps: request.targetFps } : {}),
    });
  }

  /**
   * {@link streamToTemp} with one retry for a transport failure.
   *
   * One, and only for the transport: a second attempt at a provider ANSWER is a second bill
   * for the same information. The temp file from the failed attempt is removed first, so
   * the retry cannot append to a partial body — which would rename a corrupt file into the
   * bin and pass every length check.
   */
  private async streamWithOneRetry(
    variant: StockVariant,
    tempPath: string,
    request: StockDownloadRequest,
    controller: AbortController,
  ): Promise<number> {
    try {
      return await this.streamToTemp(variant, tempPath, request, controller);
    } catch (error) {
      if (!isRetryableDownloadFailure(error, controller.signal.aborted)) throw error;
      await unlink(tempPath).catch(() => undefined);
      log.warn('download → retrying once after a transport failure', {
        remoteId: request.remoteId,
        error: error instanceof Error ? error.message : String(error),
      });
      // A FRESH controller: the first attempt's was aborted by the stall or deadline timer,
      // and reusing it would abort the retry before its first read.
      const retryController = new AbortController();
      this.downloads.set(request.operationId, retryController);
      return await this.streamToTemp(variant, tempPath, request, retryController);
    }
  }

  /** Stream the body to a temp file, emitting progress and failing on a stall. */
  private async streamToTemp(
    variant: StockVariant,
    tempPath: string,
    request: StockDownloadRequest,
    controller: AbortController,
  ): Promise<number> {
    const response = await this.fetchImpl(variant.url, { signal: controller.signal });
    if (!response.ok) throw statusError(response.status);

    const declared = Number(response.headers.get('content-length') ?? '0');
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (total > STOCK_MAX_DOWNLOAD_BYTES) throw new StockProviderError('too_large');

    const body = response.body;
    if (!body) throw new StockProviderError('download_failed', 'empty response body');

    // Streamed to disk rather than concatenated in memory: a 400 MB clip held as
    // an array of Buffers is a 400 MB spike in the main process, and main is also
    // the window's event loop.
    const sink = createWriteStream(tempPath);
    // A write stream that fails to open or flush (EACCES on the projects root,
    // EMFILE under load, ENOSPC at flush time) emits 'error' asynchronously. With
    // no listener that is an UNCAUGHT exception in the main process — the whole
    // app, not this one download. Captured here and re-thrown through the normal
    // failure path so it becomes a tool error the user can read.
    let sinkError: Error | null = null;
    sink.on('error', (error: Error) => {
      sinkError = error;
    });
    let completed = 0;
    let lastProgressAt = this.now();
    const reader = body.getReader();
    // A stall and a user cancel both reach the reader as an abort, and they are
    // not the same event: a cancel is deliberate and renders as silence, a stall
    // is a failure the user needs told about. The flag is what tells them apart
    // after the fact, since `AbortSignal.reason` is not carried through the
    // reader's rejection.
    let stalled = false;
    // A TOTAL cap, alongside the per-chunk stall timer. A download that keeps trickling
    // bytes never stalls, so before this the only bound was the file's size: the captured
    // run's longest successful download took 154s and its longest failure took 154s too,
    // and nothing could tell them apart until one of them ended. `STOCK_DOWNLOAD_MAX_MS`
    // sits above the observed good maximum so a legitimate 4K pull still completes.
    const deadline = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STOCK_DOWNLOAD_MAX_MS);

    try {
      for (;;) {
        const stall = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, STOCK_DOWNLOAD_STALL_MS);
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } finally {
          clearTimeout(stall);
        }
        if (sinkError !== null) throw sinkError;
        if (chunk.done) break;

        completed += chunk.value.byteLength;
        // Enforced again as a running total: a lying `Content-Length` must not
        // be able to fill the user's disk.
        if (completed > STOCK_MAX_DOWNLOAD_BYTES) throw new StockProviderError('too_large');

        await writeChunk(sink, Buffer.from(chunk.value));

        if (this.now() - lastProgressAt > PROGRESS_INTERVAL_MS) {
          lastProgressAt = this.now();
          this.emit(request, 'downloading', completed, total);
        }
      }
    } catch (error) {
      // Re-labelled before it escapes: an abort we caused by timing out must not
      // reach the user as "cancelled", which the UI renders as silence.
      if (stalled && error instanceof Error && error.name === 'AbortError') {
        throw new StockProviderError('timeout', 'the download stalled');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      await closeStream(sink);
    }

    // Only reachable once the loop drained cleanly, so a flush error raised
    // during `end()` still fails the download rather than renaming a short file
    // into the bin.
    if (sinkError !== null) throw sinkError;

    // A body that stopped short of its declared length is a corrupt file, not a
    // small one. Catching it here keeps a truncated MP4 out of the bin.
    if (total > 0 && completed !== total) {
      throw new StockProviderError('download_failed', 'truncated response');
    }
    if (completed === 0) throw new StockProviderError('download_failed', 'empty file');
    return completed;
  }

  /**
   * Turn an on-disk file into an asset payload, with provenance attached.
   *
   * `source` is built HERE, in main, from what the provider actually returned —
   * not assembled in the renderer from a search tile. The renderer's copy of an
   * item is display state, and provenance must not depend on it still being on
   * screen (schema v20).
   */
  private async materialize(
    item: StockItem,
    variant: StockVariant,
    relativePath: string,
    absolutePath: string,
    deduped: boolean,
  ): Promise<StockDownloadedAssetWire> {
    // A missing thumbnail is a degraded bin tile; a missing asset is a lost
    // download. So derivation failure never fails the add.
    const derived = await this.options.deriveAssetMedia(absolutePath).catch(() => null);
    // Read the derived media from `derived.media`, which is where the sidecar client puts
    // it. Reading it off `derived` itself compiled and silently produced an all-null
    // `media` for every sourced asset — see `DerivedAssetMedia`.
    const derivedMedia = derived?.media;

    // Trust the engine's classification over our own expectation: it reads the
    // container, and a provider that served a PNG under a `.jpg` name has not
    // changed what the file is.
    const kind: 'video' | 'image' =
      derived?.kind === 'video' || derived?.kind === 'image'
        ? derived.kind
        : item.kind === 'video'
          ? 'video'
          : 'image';

    const durationSeconds = derived?.durationSeconds ?? item.durationSeconds;

    return {
      relativePath,
      kind,
      // A photo genuinely has no duration; do not manufacture one here. The
      // placement builder applies the project's default still length instead.
      ...(kind === 'video' && durationSeconds !== undefined && durationSeconds !== null
        ? { durationSeconds }
        : {}),
      width: variant.width,
      height: variant.height,
      media: derivedMedia
        ? {
            proxyPath: derivedMedia.proxyPath ?? null,
            peaks: derivedMedia.peaks ?? null,
            peaksPerSecond: derivedMedia.peaksPerSecond ?? null,
            thumbnailPaths: derivedMedia.thumbnailPaths ?? null,
          }
        : null,
      source: {
        provider: item.provider,
        remoteId: item.remoteId,
        license: item.license,
        ...(item.licenseUrl !== undefined ? { licenseUrl: item.licenseUrl } : {}),
        attributionRequired: item.attributionRequired,
        ...(item.attribution !== undefined ? { attribution: item.attribution } : {}),
        ...(item.creator !== undefined ? { creator: item.creator } : {}),
        ...(item.creatorUrl !== undefined ? { creatorUrl: item.creatorUrl } : {}),
        ...(item.sourceUrl !== undefined ? { sourceUrl: item.sourceUrl } : {}),
        fetchedAt: new Date().toISOString(),
      },
      deduped,
    };
  }

  private emit(
    request: StockDownloadRequest,
    phase: StockDownloadProgressWire['phase'],
    completedBytes: number,
    totalBytes: number,
    errorCode?: StockErrorCodeWire,
    detail?: string,
  ): void {
    this.options.onProgress?.({
      operationId: request.operationId,
      remoteId: request.remoteId,
      phase,
      completedBytes,
      totalBytes,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** Exposed for the agent tool, which needs the item to build its summary. */
  public knownItem(remoteId: string): StockItem | undefined {
    return this.knownItems.get(remoteId);
  }

  /**
   * Why an id cannot be acted on, in words the caller can act on.
   *
   * The searched-item table lives in this process's memory and nowhere else, while the
   * ids that reference it live in the run's evidence store, which outlives the process.
   * So a resumed run — or one that recalls a search from before a restart — can hold a
   * perfectly valid remoteId that this service has never heard of. "Unknown item" told
   * neither the model nor the editor what to do about that; naming the session boundary
   * and the recovery does.
   *
   * @param remoteId - The id the caller wants to download.
   * @returns `null` when the id is actionable, otherwise the sentence explaining why not.
   */
  public unresolvableReason(remoteId: string): string | null {
    if (remoteId.trim() === '') {
      return 'add_stock needs the remoteId of an item from search_stock.';
    }
    if (this.knownItems.has(remoteId)) return null;
    return (
      `Stock item "${remoteId}" is not in this session's search results — they are held in ` +
      'memory and do not survive a restart, so an id recalled from an earlier session ' +
      'cannot be downloaded. Run search_stock again and pass a remoteId from the fresh ' +
      'results.'
    );
  }

  /** Whether the chosen rendition falls short of the project frame. */
  public variantBelowTarget(item: StockItem, targetHeight: number): boolean {
    return isVariantBelowTarget(chooseVariant(item.variants, { height: targetHeight }), {
      height: targetHeight,
    });
  }
}

/**
 * Re-present a parsed observation as headers, so the store keeps exactly one
 * parsing path.
 *
 * The alternative — a second `observeParsed()` entry point — would let the two
 * paths validate differently, which is how a "resets in 1970" ships.
 */
function quotaHeadersOf(quota: { limit: number; remaining: number; resetAt: string }): {
  get(name: string): string | null;
} {
  const values: Record<string, string> = {
    'x-ratelimit-limit': String(quota.limit),
    'x-ratelimit-remaining': String(quota.remaining),
    'x-ratelimit-reset': String(Math.floor(Date.parse(quota.resetAt) / 1000)),
  };
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

/** Map an HTTP status from a bytes/download fetch onto the closed union. */
function statusError(status: number): StockProviderError {
  if (status === 401 || status === 403) return new StockProviderError('unauthorized');
  if (status === 429) return new StockProviderError('rate_limited');
  return new StockProviderError('provider_unavailable', `HTTP ${status}`);
}

/**
 * Give an untyped fetch rejection the right code.
 *
 * An abort and a dropped connection arrive indistinguishable at the type level,
 * and calling a timeout "offline" would send the user to check their wifi over a
 * slow provider.
 */
function normalizeFetchError(error: unknown, fallback?: StockErrorCodeWire): unknown {
  if (error instanceof StockProviderError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return new StockProviderError('timeout');
  if (name === 'AbortError') return new StockProviderError('cancelled');
  if (fallback !== undefined) {
    return new StockProviderError(fallback, error instanceof Error ? error.message : undefined);
  }
  return new StockProviderError('offline', error instanceof Error ? error.message : undefined);
}

function writeChunk(sink: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Close the sink, never rejecting and never hanging.
 *
 * `end()`'s callback does not fire on a stream that has already errored, so a
 * failed write would leave this promise pending forever inside a `finally` — the
 * download would never settle and its temp file would never be swept. The
 * 'error' listener resolves the same promise; the error itself is reported by
 * the caller's own `sinkError` capture.
 */
function closeStream(sink: NodeJS.WritableStream & { close?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    sink.once('error', () => resolve());
    sink.end(() => resolve());
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The minimal IO surface `dedupeName` needs. */
const nodeExists = {
  mkdirp: async () => undefined,
  writeFile: async () => undefined,
  appendFile: async () => undefined,
  rename: async () => undefined,
  exists,
  size: async () => 0,
} as unknown as Parameters<typeof dedupeName>[2];

/**
 * Read the download ledger.
 *
 * This is **not** the provenance record — the project file is (`Asset.source`,
 * schema v20). It exists for one job main can do without loading the project:
 * answer "have I already downloaded this?" before spending bandwidth.
 */
async function readLedger(ledgerPath: string): Promise<SourcesLedger> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as SourcesLedger).entries)
    ) {
      return parsed as SourcesLedger;
    }
  } catch {
    // A missing or corrupt ledger costs a redundant download, which is strictly
    // better than refusing to download at all. Start clean.
  }
  return { version: 1, entries: [] };
}

/** Append one entry atomically (temp + rename), same as media import. */
async function appendLedger(ledgerPath: string, entry: SourcesLedgerEntry): Promise<void> {
  // Re-read rather than trusting the snapshot taken before the download: a
  // second download may have finished while this one was streaming.
  const current = await readLedger(ledgerPath);
  const merged = [
    // Replace only the exact same provider + item + rendition. Matching on
    // `remoteId` alone would let a Pexels photo evict an Openverse track that
    // happened to share an id, and the ledger is shared between them.
    ...current.entries.filter(
      (existing) =>
        !(
          existing.provider === entry.provider &&
          existing.remoteId === entry.remoteId &&
          (existing.variantId ?? '') === (entry.variantId ?? '')
        ),
    ),
    entry,
  ];
  const temp = `${ledgerPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`, 'utf8');
  await rename(temp, ledgerPath);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

/** Re-exported so the IPC layer can narrow an untrusted `kind` without importing the SDK. */
export function isStockKind(value: unknown): value is StockMediaKind {
  return value === 'photo' || value === 'video';
}

export { safeStockFormat };
