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
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import {
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
  /** Derive kind/duration/thumbnails for a downloaded file. Failure is non-fatal. */
  readonly deriveAssetMedia: (absolutePath: string) => Promise<{
    kind?: string | null;
    durationSeconds?: number | null;
    peaks?: number[] | null;
    peaksPerSecond?: number | null;
    proxyPath?: string | null;
    thumbnailPaths?: string[] | null;
  } | null>;
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
   */
  private readonly knownItems = new Map<string, StockItem>();
  private readonly downloads = new Map<string, AbortController>();
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

  public async search(request: StockSearchRequest): Promise<StockSearchResult> {
    const page = Math.max(1, Math.trunc(request.page ?? 1));
    const limit = Math.max(1, Math.trunc(request.limit ?? STOCK_SEARCH_DEFAULT_LIMIT));
    const key = cacheKey({ ...request, page, limit });

    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      // Cache first, always. A cached hit spent no request, so it deliberately
      // does NOT touch the quota store — moving the meter here would make the
      // Settings readout drift away from what the provider actually counted.
      for (const item of cached.items) this.knownItems.set(item.remoteId, item);
      return {
        ok: true,
        items: cached.items.map(toStockItemWire),
        page: cached.page,
        totalResults: cached.totalResults,
        hasMore: cached.hasMore,
      };
    }

    // A superseded search is cancelled, not merely ignored — an abandoned
    // request still counts against the hourly limit.
    this.inFlightSearch?.abort();
    const controller = new AbortController();
    this.inFlightSearch = controller;

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
    for (const item of result.items) this.knownItems.set(item.remoteId, item);
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
      const data = Buffer.from(await response.arrayBuffer());
      const contentType =
        response.headers.get('content-type') ?? (which === 'preview' ? 'video/mp4' : 'image/jpeg');
      this.rememberBytes(which, remoteId, { contentType, data });
      return { ok: true, contentType, data: toArrayBuffer(data) };
    } catch (error) {
      return { ok: false, ...toWireError(normalizeFetchError(error)) };
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

  public cancelDownload(operationId: string): void {
    this.downloads.get(operationId)?.abort();
  }

  public async download(request: StockDownloadRequest): Promise<StockDownloadResult> {
    const item = this.knownItems.get(request.remoteId);
    if (!item) {
      return { ok: false, error: 'provider_unavailable', detail: 'unknown item' };
    }

    const variant = this.resolveVariant(item, request);
    if (variant.approxBytes !== undefined && variant.approxBytes > STOCK_MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: 'too_large' };
    }

    const relativeDir = mediaRelativeDir(request.projectId);
    const absoluteDir = resolveWithin(this.options.projectsRoot, relativeDir);
    await mkdir(absoluteDir, { recursive: true });

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
      const bytes = await this.streamToTemp(variant, tempPath, request, controller);
      await rename(tempPath, absolutePath);
      await appendLedger(ledgerPath, {
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
      const cancelled = controller.signal.aborted;
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
    let completed = 0;
    let lastProgressAt = this.now();
    const reader = body.getReader();

    try {
      for (;;) {
        const stall = setTimeout(() => controller.abort(), STOCK_DOWNLOAD_STALL_MS);
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } finally {
          clearTimeout(stall);
        }
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
    } finally {
      await closeStream(sink);
    }

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
      media: derived
        ? {
            proxyPath: derived.proxyPath ?? null,
            peaks: derived.peaks ?? null,
            peaksPerSecond: derived.peaksPerSecond ?? null,
            thumbnailPaths: derived.thumbnailPaths ?? null,
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

function closeStream(sink: NodeJS.WritableStream & { close?: () => void }): Promise<void> {
  return new Promise((resolve) => {
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
