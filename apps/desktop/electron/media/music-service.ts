/**
 * Main-process music sourcing: search, audition, and download.
 *
 * ## Why this lives in main
 *
 * The renderer's CSP is `connect-src 'self' fp-media: <engine>`
 * (`security/media-protocol.ts`), so it cannot reach a provider host — and this
 * feature does **not** change that. Main does the network; the renderer gets
 * bytes over IPC and wraps them in a `blob:` URL, which `media-src ... blob:`
 * already allows. The renderer is never handed a provider URL at all, so the
 * guarantee is structural rather than a rule someone can forget
 * (`plan/3rd-party-sourcing/README.md` §3).
 *
 * If you find yourself wanting to add a provider origin to `connect-src`, the
 * slice is wrong — stop and re-read that section.
 *
 * ## Caching, and why it is not an optimization
 *
 * Openverse serves anonymous callers 20 requests/minute and 200/day. A user
 * typing into a search box with a 300 ms debounce will burn through that in
 * under a minute without a cache, and the failure they get is a 429 that looks
 * like the feature is broken. The search cache is what makes the free tier
 * usable, following the footage-map precedent: serve the cache first and stay
 * independent of the remote index.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import {
  MusicProviderError,
  createMusicProvider,
  type MusicProvider,
  type ProviderTrack,
} from '@framepilot/ai-sdk';
import type {
  MusicDownloadProgressWire,
  MusicDownloadRequest,
  MusicDownloadResult,
  MusicDownloadedAssetWire,
  MusicErrorCodeWire,
  MusicPreviewResult,
  MusicSearchResult,
  MusicTrackWire,
} from '../ipc/contract.js';
import { dedupeName, mediaRelativeDir, safeFileName } from '../projects/media-import.js';

const log = createLogger('desktop:music');

/** Search cache TTL. Stale music results have no value across sessions. */
const SEARCH_TTL_MS = 5 * 60 * 1000;
/** Bounded so a long session cannot grow the cache without limit. */
const SEARCH_CACHE_MAX = 50;
/** Preview bytes held in memory, so re-auditioning a heard track costs nothing. */
const PREVIEW_CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** Preview requests are user-visible waits; fail fast rather than hang the row. */
const PREVIEW_TIMEOUT_MS = 15_000;
/**
 * A download with no bytes for this long has stalled. There is no wall-clock cap
 * on a download — a long track on a slow line is not an error — but silence is.
 */
const DOWNLOAD_STALL_MS = 30_000;
/** Refuse an implausibly large audio file rather than filling the user's disk. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 20;

/** The download ledger's on-disk shape. */
interface SourcesLedgerEntry {
  readonly fileName: string;
  readonly provider: string;
  readonly remoteId: string;
  readonly license: string;
  readonly attributionRequired: boolean;
  readonly downloadedAt: string;
}

interface SourcesLedger {
  readonly version: 1;
  readonly entries: readonly SourcesLedgerEntry[];
}

interface CachedSearch {
  readonly tracks: readonly ProviderTrack[];
  readonly expiresAt: number;
}

interface CachedPreview {
  readonly contentType: string;
  readonly data: Buffer;
}

export interface MusicServiceOptions {
  /** Absolute path of the projects root; every write is resolved inside it. */
  readonly projectsRoot: string;
  /** Derive duration/peaks/proxy for a downloaded file. Failure is non-fatal. */
  readonly deriveAssetMedia: (absolutePath: string) => Promise<{
    durationSeconds?: number | null;
    peaks?: number[] | null;
    peaksPerSecond?: number | null;
    proxyPath?: string | null;
    thumbnailPaths?: string[] | null;
  } | null>;
  /** Injected for tests. Defaults to the real Openverse adapter. */
  readonly provider?: MusicProvider;
  /** Injected for tests; used only for preview and download bytes. */
  readonly fetchImpl?: typeof fetch;
  /** Emit a progress event to the renderer. */
  readonly onProgress?: (message: MusicDownloadProgressWire) => void;
  readonly now?: () => number;
}

/** Strip provider URLs before a track can cross to the renderer. */
function toWire(track: ProviderTrack): MusicTrackWire {
  const { previewUrl: _preview, downloadUrl: _download, ...wire } = track;
  return wire;
}

/** Normalize a query so "Calm  Lofi" and "calm lofi" share one cache entry. */
function cacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase().replace(/\s+/g, ' ')}::${limit}`;
}

/** Convert any thrown value into a wire error, never letting one escape untyped. */
function toWireError(error: unknown): { error: MusicErrorCodeWire; detail?: string } {
  if (error instanceof MusicProviderError) {
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

export class MusicService {
  private readonly provider: MusicProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly searchCache = new Map<string, CachedSearch>();
  private readonly previewCache = new Map<string, CachedPreview>();
  private previewBytes = 0;
  /**
   * Tracks seen in a search, kept so the renderer can act on one by `remoteId`
   * alone. This is the table that lets the provider URL stay in main.
   */
  private readonly knownTracks = new Map<string, ProviderTrack>();
  private readonly downloads = new Map<string, AbortController>();
  /** In-flight search, aborted when a newer one supersedes it. */
  private inFlightSearch: AbortController | null = null;

  public constructor(private readonly options: MusicServiceOptions) {
    this.provider = options.provider ?? createMusicProvider('openverse');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  public async search(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MusicSearchResult> {
    const key = cacheKey(query, limit);
    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      // Cache first, always. Re-opening the panel must not spend a request.
      for (const track of cached.tracks) this.knownTracks.set(track.remoteId, track);
      return { ok: true, tracks: cached.tracks.map(toWire) };
    }

    // A superseded search is cancelled, not merely ignored — an abandoned
    // request still counts against the provider's rate limit.
    this.inFlightSearch?.abort();
    const controller = new AbortController();
    this.inFlightSearch = controller;

    try {
      const tracks = await this.provider.search({ text: query, limit }, controller.signal);
      this.rememberSearch(key, tracks);
      return { ok: true, tracks: tracks.map(toWire) };
    } catch (error) {
      return { ok: false, ...toWireError(error) };
    } finally {
      if (this.inFlightSearch === controller) this.inFlightSearch = null;
    }
  }

  private rememberSearch(key: string, tracks: readonly ProviderTrack[]): void {
    if (this.searchCache.size >= SEARCH_CACHE_MAX) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.searchCache.keys().next();
      if (!oldest.done) this.searchCache.delete(oldest.value);
    }
    this.searchCache.set(key, { tracks, expiresAt: this.now() + SEARCH_TTL_MS });
    for (const track of tracks) this.knownTracks.set(track.remoteId, track);
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  public async preview(remoteId: string): Promise<MusicPreviewResult> {
    const track = this.knownTracks.get(remoteId);
    if (!track) {
      // Not a provider failure: the renderer asked about a track this process
      // never saw, which means the search results it holds are from a previous
      // run. Say so rather than reporting the provider is down.
      return { ok: false, error: 'provider_unavailable', detail: 'unknown track' };
    }

    const cached = this.previewCache.get(remoteId);
    if (cached) {
      return { ok: true, contentType: cached.contentType, data: toArrayBuffer(cached.data) };
    }

    try {
      const response = await this.fetchImpl(track.previewUrl, {
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      });
      if (!response.ok) throw statusError(response.status);
      const data = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      this.rememberPreview(remoteId, { contentType, data });
      return { ok: true, contentType, data: toArrayBuffer(data) };
    } catch (error) {
      return { ok: false, ...toWireError(normalizeFetchError(error)) };
    }
  }

  private rememberPreview(remoteId: string, entry: CachedPreview): void {
    // One oversized preview must not evict everything else, so refuse to cache
    // it rather than emptying the cache to fit it.
    if (entry.data.byteLength > PREVIEW_CACHE_MAX_BYTES) return;
    while (this.previewBytes + entry.data.byteLength > PREVIEW_CACHE_MAX_BYTES) {
      const oldest = this.previewCache.keys().next();
      if (oldest.done) break;
      this.previewBytes -= this.previewCache.get(oldest.value)?.data.byteLength ?? 0;
      this.previewCache.delete(oldest.value);
    }
    this.previewCache.set(remoteId, entry);
    this.previewBytes += entry.data.byteLength;
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  public cancelDownload(operationId: string): void {
    this.downloads.get(operationId)?.abort();
  }

  public async download(request: MusicDownloadRequest): Promise<MusicDownloadResult> {
    const track = this.knownTracks.get(request.remoteId);
    if (!track) {
      return { ok: false, error: 'provider_unavailable', detail: 'unknown track' };
    }

    // Refused before any byte is fetched. FramePilot users monetize, and no
    // badge makes a non-commercial track safe in a sponsored video.
    if (!track.commercialUse) {
      return { ok: false, error: 'non_commercial_only' };
    }

    const relativeDir = mediaRelativeDir(request.projectId);
    const absoluteDir = resolveWithin(this.options.projectsRoot, relativeDir);
    await mkdir(absoluteDir, { recursive: true });

    const ledgerPath = path.join(absoluteDir, 'sources.json');
    const ledger = await readLedger(ledgerPath);

    // Dedupe before spending a request. A track already in this project is
    // never downloaded — or billed — twice.
    const existing = ledger.entries.find(
      (entry) => entry.remoteId === track.remoteId && entry.provider === track.provider,
    );
    if (existing) {
      const relativePath = path.posix.join(relativeDir, existing.fileName);
      const absolutePath = resolveWithin(this.options.projectsRoot, relativePath);
      if (await exists(absolutePath)) {
        log.action('download → deduped', { remoteId: track.remoteId });
        return {
          ok: true,
          asset: await this.materialize(track, relativePath, absolutePath, true),
        };
      }
      // The ledger says we have it but the file is gone (the user deleted it).
      // Fall through and fetch again rather than returning a broken asset.
    }

    const controller = new AbortController();
    this.downloads.set(request.operationId, controller);
    const fileName = await dedupeName(
      absoluteDir,
      safeFileName(`${track.title}.${track.format}`),
      nodeExists,
    );
    const relativePath = path.posix.join(relativeDir, fileName);
    const absolutePath = resolveWithin(this.options.projectsRoot, relativePath);
    const tempPath = `${absolutePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;

    try {
      log.action('download → start', {
        remoteId: track.remoteId,
        operationId: request.operationId,
      });
      const bytes = await this.streamToTemp(track, tempPath, request, controller);
      await rename(tempPath, absolutePath);
      await appendLedger(ledgerPath, {
        fileName,
        provider: track.provider,
        remoteId: track.remoteId,
        license: track.license,
        attributionRequired: track.attributionRequired,
        downloadedAt: new Date().toISOString(),
      });
      log.action('download → installed', { remoteId: track.remoteId, bytes });

      this.emit(request, 'deriving', bytes, bytes);
      const asset = await this.materialize(track, relativePath, absolutePath, false);
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
      log.warn('download → failed', { remoteId: track.remoteId, code: wire.error });
      return { ok: false, ...wire };
    } finally {
      this.downloads.delete(request.operationId);
    }
  }

  /** Stream the body to a temp file, emitting progress and failing on a stall. */
  private async streamToTemp(
    track: ProviderTrack,
    tempPath: string,
    request: MusicDownloadRequest,
    controller: AbortController,
  ): Promise<number> {
    const response = await this.fetchImpl(track.downloadUrl, { signal: controller.signal });
    if (!response.ok) throw statusError(response.status);

    const declared = Number(response.headers.get('content-length') ?? '0');
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new MusicProviderError('download_failed', 'file is implausibly large');
    }

    const body = response.body;
    if (!body) throw new MusicProviderError('download_failed', 'empty response body');

    const chunks: Buffer[] = [];
    let completed = 0;
    let lastProgressAt = this.now();
    const reader = body.getReader();

    for (;;) {
      const stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } finally {
        clearTimeout(stall);
      }
      if (chunk.done) break;
      completed += chunk.value.byteLength;
      if (completed > MAX_DOWNLOAD_BYTES) {
        throw new MusicProviderError('download_failed', 'file is implausibly large');
      }
      chunks.push(Buffer.from(chunk.value));
      // Coarse progress: announcing every chunk would spam the renderer and, on
      // the accessibility side, produce an unreadable live region.
      if (this.now() - lastProgressAt > 200) {
        lastProgressAt = this.now();
        this.emit(request, 'downloading', completed, total);
      }
    }

    // A body that stopped short of its declared length is a corrupt file, not a
    // small one. Catching it here is what keeps a truncated MP3 out of the bin.
    if (total > 0 && completed !== total) {
      throw new MusicProviderError('download_failed', 'truncated response');
    }
    if (completed === 0) {
      throw new MusicProviderError('download_failed', 'empty file');
    }

    await writeFile(tempPath, Buffer.concat(chunks));
    return completed;
  }

  /**
   * Turn an on-disk file into an asset payload, with provenance attached.
   *
   * `source` is built HERE, in main, from what the provider actually returned —
   * not assembled in the renderer from a search row. The renderer's copy of a
   * track is display state; a credit obligation must not depend on it still
   * being on screen (schema v20, ADR 0138).
   */
  private async materialize(
    track: ProviderTrack,
    relativePath: string,
    absolutePath: string,
    deduped: boolean,
  ): Promise<MusicDownloadedAssetWire> {
    // A missing waveform is a degraded timeline row; a missing asset is a lost
    // download. So derivation failure never fails the add.
    const derived = await this.options.deriveAssetMedia(absolutePath).catch(() => null);

    return {
      relativePath,
      kind: 'audio',
      durationSeconds: derived?.durationSeconds ?? track.durationSeconds,
      media: derived
        ? {
            proxyPath: derived.proxyPath ?? null,
            peaks: derived.peaks ?? null,
            peaksPerSecond: derived.peaksPerSecond ?? null,
            thumbnailPaths: derived.thumbnailPaths ?? null,
          }
        : null,
      source: {
        provider: track.provider,
        remoteId: track.remoteId,
        license: track.license,
        ...(track.licenseUrl !== undefined ? { licenseUrl: track.licenseUrl } : {}),
        attributionRequired: track.attributionRequired,
        ...(track.attribution !== undefined ? { attribution: track.attribution } : {}),
        ...(track.creator !== undefined ? { creator: track.creator } : {}),
        ...(track.creatorUrl !== undefined ? { creatorUrl: track.creatorUrl } : {}),
        ...(track.sourceUrl !== undefined ? { sourceUrl: track.sourceUrl } : {}),
        fetchedAt: new Date().toISOString(),
      },
      deduped,
    };
  }

  private emit(
    request: MusicDownloadRequest,
    phase: MusicDownloadProgressWire['phase'],
    completedBytes: number,
    totalBytes: number,
    errorCode?: MusicErrorCodeWire,
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
}

/** Map an HTTP status from a preview/download fetch onto the closed union. */
function statusError(status: number): MusicProviderError {
  if (status === 401 || status === 403) return new MusicProviderError('unauthorized');
  if (status === 429) return new MusicProviderError('rate_limited');
  return new MusicProviderError('provider_unavailable', `HTTP ${status}`);
}

/**
 * Give an untyped fetch rejection the right code.
 *
 * An abort and a dropped connection arrive here indistinguishable at the type
 * level, and calling a timeout "offline" would send the user to check their
 * wifi over a slow provider.
 */
function normalizeFetchError(error: unknown, fallback?: MusicErrorCodeWire): unknown {
  if (error instanceof MusicProviderError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return new MusicProviderError('timeout');
  if (name === 'AbortError') return new MusicProviderError('cancelled');
  if (fallback !== undefined) {
    return new MusicProviderError(fallback, error instanceof Error ? error.message : undefined);
  }
  return new MusicProviderError('offline', error instanceof Error ? error.message : undefined);
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
 * answer "have I already downloaded this?" before spending a request. Nothing
 * reads it to decide what renders or what to credit.
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
  // Matched on provider AND id: the ledger is shared with the stock slice, and a
  // Pexels item that happened to share a numeric id with an Openverse track must
  // not evict it.
  const merged = [
    ...current.entries.filter(
      (e) => !(e.provider === entry.provider && e.remoteId === entry.remoteId),
    ),
    entry,
  ];
  const temp = `${ledgerPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`, 'utf8');
  await rename(temp, ledgerPath);
}

/** A stable id for a track, for callers that need one without a provider round-trip. */
export function trackFingerprint(provider: string, remoteId: string): string {
  return createHash('sha256').update(`${provider}:${remoteId}`).digest('hex').slice(0, 16);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}
