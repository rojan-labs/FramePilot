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
import { createWriteStream } from 'node:fs';
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
import type { DerivedAssetMedia } from './asset-media-client.js';

const log = createLogger('desktop:music');

/** Search cache TTL. Stale music results have no value across sessions. */
const SEARCH_TTL_MS = 5 * 60 * 1000;
/** Bounded so a long session cannot grow the cache without limit. */
const SEARCH_CACHE_MAX = 50;
/** Preview bytes held in memory, so re-auditioning a heard track costs nothing. */
const PREVIEW_CACHE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * How many searched tracks stay actionable by `remoteId`.
 *
 * Generous — many pages of results — but finite: the renderer can only act on
 * what it is still showing, and an unbounded table is a slow leak in the process
 * that also runs the window.
 */
const KNOWN_TRACKS_MAX = 2000;
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
  readonly deriveAssetMedia: (absolutePath: string) => Promise<DerivedAssetMedia | null>;
  /** Injected for tests. Defaults to the real Openverse adapter. */
  readonly provider?: MusicProvider;
  /** Injected for tests; used only for preview and download bytes. */
  readonly fetchImpl?: typeof fetch;
  /** Emit a progress event to the renderer. */
  readonly onProgress?: (message: MusicDownloadProgressWire) => void;
  readonly now?: () => number;
}

/**
 * Words that carry no signal in a catalogue keyword search.
 *
 * Deliberately tiny: these are the joins a person writes in a mood sentence, not a
 * general stop-word list. Dropping more than this starts throwing away the search.
 */
const MUSIC_QUERY_FILLER = new Set([
  'a',
  'an',
  'and',
  'build',
  'for',
  'of',
  'style',
  'the',
  'track',
  'vibe',
  'with',
]);

/** How many words a relaxed retry keeps. Two is a mood plus a qualifier. */
const RELAXED_QUERY_WORDS = 2;

/**
 * A shorter query worth one retry, or `null` when there is nothing to shorten.
 *
 * WHY this lives here rather than in the caller: the catalogue matches keywords, so a
 * whole descriptive phrase — "dark cinematic tension build with beat drop" — returns
 * nothing, reliably, however good the phrase is. Every caller would otherwise have to
 * learn that separately, and one of them is a model whose only feedback was "no tracks
 * matched, try a broader mood word" — advice it received once, mid-run, and never acted
 * on. A run then finished a music-led brief with no audio at all.
 *
 * @param query - The query the caller asked for.
 * @returns The relaxed query, or `null` when the original was already short enough.
 */
export function relaxedMusicQuery(query: string): string | null {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const strong = words.filter((word) => !MUSIC_QUERY_FILLER.has(word.toLowerCase()));
  const kept = (strong.length > 0 ? strong : words).slice(0, RELAXED_QUERY_WORDS);
  const relaxed = kept.join(' ');
  return relaxed === '' || relaxed === query.trim() ? null : relaxed;
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

/**
 * How a caller relates to the searches around it. Main-process only, and the exact
 * counterpart of `stock-service.ts#StockSearchOptions` — the two services have the same
 * shape because they had the same bug.
 */
export interface MusicSearchOptions {
  /**
   * Does this search REPLACE the one this caller issued a moment ago? True (the default)
   * for the Sounds panel; false for the agent, whose parallel searches are independent
   * questions rather than revisions of one.
   */
  readonly supersedePrevious?: boolean;
  /** The caller's own lifetime, if it has one (an agent run's Stop). */
  readonly signal?: AbortSignal;
}

/**
 * Abort `controller` when `signal` does, and hand back the unsubscribe. A no-op when
 * there is no signal; an already-aborted signal aborts immediately.
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
   *
   * Bounded, unlike a plain accumulator: a long session of searches would
   * otherwise grow it without limit, and every other cache in this service has a
   * ceiling. Oldest-first eviction is right here because "act on a result" only
   * ever means a result the user can still see.
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

  public async search(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    options: MusicSearchOptions = {},
  ): Promise<MusicSearchResult> {
    const key = cacheKey(query, limit);
    const cached = this.searchCache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      // Cache first, always. Re-opening the panel must not spend a request.
      for (const track of cached.tracks) this.rememberTrack(track);
      return { ok: true, tracks: cached.tracks.map(toWire) };
    }

    const controller = new AbortController();
    // A superseded search is cancelled, not merely ignored — an abandoned request still
    // counts against the provider's rate limit. That is the Sounds panel's contract: a
    // person typing revises one question and means the last version of it.
    //
    // The agent's searches are not revisions of each other. It batches concurrency-safe
    // calls four at a time, so four independent queries arrive together and each aborted
    // its predecessor — and `cancelled` renders as the empty string by design, so the
    // model was handed failures with no reason and asked the same thing again. See the
    // fuller note in `stock-service.ts#search`, where the same bug cost run `f014f3ac`
    // fifteen of its twenty-one footage searches.
    if (options.supersedePrevious !== false) {
      this.inFlightSearch?.abort();
      this.inFlightSearch = controller;
    }
    const unlink = linkAbort(options.signal, controller);

    try {
      const tracks = await this.provider.search({ text: query, limit }, controller.signal);
      if (tracks.length > 0) {
        this.rememberSearch(key, tracks);
        return { ok: true, tracks: tracks.map(toWire) };
      }
      // Nothing matched the whole phrase. Try the strongest words in it once before
      // reporting an empty library — see `relaxedMusicQuery` for why this is not the
      // caller's job.
      const relaxed = relaxedMusicQuery(query);
      if (relaxed === null) {
        this.rememberSearch(key, tracks);
        return { ok: true, tracks: [] };
      }
      log.action('search → retrying relaxed', { query, relaxed });
      const second = await this.provider.search({ text: relaxed, limit }, controller.signal);
      this.rememberSearch(key, second);
      return {
        ok: true,
        tracks: second.map(toWire),
        ...(second.length > 0 ? { matchedQuery: relaxed } : {}),
      };
    } catch (error) {
      return { ok: false, ...toWireError(error) };
    } finally {
      unlink();
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
    for (const track of tracks) this.rememberTrack(track);
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /** Remember a track by id, evicting the oldest once the table is full. */
  private rememberTrack(track: ProviderTrack): void {
    // Re-inserting moves it to the back of the insertion order, so a track the
    // user keeps seeing is never the one evicted.
    this.knownTracks.delete(track.remoteId);
    this.knownTracks.set(track.remoteId, track);
    while (this.knownTracks.size > KNOWN_TRACKS_MAX) {
      const oldest = this.knownTracks.keys().next();
      if (oldest.done === true) break;
      this.knownTracks.delete(oldest.value);
    }
  }

  public async preview(remoteId: string): Promise<MusicPreviewResult> {
    const track = this.knownTracks.get(remoteId);
    if (!track) {
      // Not a provider failure: the caller asked about a track this process never saw,
      // which means the search results it holds are from a previous run. Say so rather
      // than reporting the provider is down — this comment described the intent, and the
      // code returned the opposite until `unknown_track` existed to carry it.
      return { ok: false, error: 'unknown_track', detail: 'unknown track' };
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
      // Checked BEFORE buffering, not after. `rememberPreview` refuses an
      // oversized entry, but by then the bytes are already resident in main —
      // a provider serving a 2 GB "preview" would spike the process that also
      // runs the window's event loop.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > PREVIEW_CACHE_MAX_BYTES) {
        throw new MusicProviderError('download_failed', 'preview is implausibly large');
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > PREVIEW_CACHE_MAX_BYTES) {
        // A missing or lying Content-Length is the case the check above cannot
        // cover; the bytes are spent either way, but they are not kept.
        throw new MusicProviderError('download_failed', 'preview is implausibly large');
      }
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
      // Same reasoning as `preview`: a stale id, not an outage. The agent shares this
      // service with the panel (ADR 0148), and "try again shortly" bought three retries.
      return { ok: false, error: 'unknown_track', detail: 'unknown track' };
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
      // A stall aborts the SAME controller a user cancel does, so "the signal is
      // aborted" no longer identifies a cancel on its own. An error the stream
      // classified deliberately (`MusicProviderError`) is trusted over the
      // signal: a raw `AbortError` is what a real user cancel leaves behind.
      const cancelled = controller.signal.aborted && !(error instanceof MusicProviderError);
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

    // Streamed to disk, not concatenated in memory: this runs in the main
    // process, which is also the window's event loop, and a 200 MB ceiling held
    // as an array of Buffers is a 200 MB spike the whole app feels. The temp
    // file is renamed into place only after every check below passes, so a
    // failed download never leaves a playable-looking file in the bin.
    const sink = createWriteStream(tempPath);
    // A write stream that fails to open or flush (EACCES, EMFILE, ENOSPC at
    // flush time) emits 'error' asynchronously; with no listener that is an
    // UNCAUGHT exception in main — the whole app, not this one download.
    let sinkError: Error | null = null;
    sink.on('error', (error: Error) => {
      sinkError = error;
    });
    let completed = 0;
    let lastProgressAt = this.now();
    const reader = body.getReader();
    // A stall and a user cancel both reach the reader as an abort, and they are
    // not the same event: a cancel is deliberate and renders as silence, a stall
    // is a failure the user needs told about.
    let stalled = false;

    try {
      for (;;) {
        const stall = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, DOWNLOAD_STALL_MS);
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } finally {
          clearTimeout(stall);
        }
        if (sinkError !== null) throw sinkError;
        if (chunk.done) break;
        completed += chunk.value.byteLength;
        if (completed > MAX_DOWNLOAD_BYTES) {
          throw new MusicProviderError('download_failed', 'file is implausibly large');
        }
        await writeChunk(sink, Buffer.from(chunk.value));
        // Coarse progress: announcing every chunk would spam the renderer and, on
        // the accessibility side, produce an unreadable live region.
        if (this.now() - lastProgressAt > 200) {
          lastProgressAt = this.now();
          this.emit(request, 'downloading', completed, total);
        }
      }
    } catch (error) {
      // Re-labelled before it escapes: an abort we caused by timing out must not
      // reach the user as "cancelled", which the UI renders as silence.
      if (stalled && error instanceof Error && error.name === 'AbortError') {
        throw new MusicProviderError('timeout', 'the download stalled');
      }
      throw error;
    } finally {
      await closeStream(sink);
    }

    if (sinkError !== null) throw sinkError;

    // A body that stopped short of its declared length is a corrupt file, not a
    // small one. Catching it here is what keeps a truncated MP3 out of the bin.
    if (total > 0 && completed !== total) {
      throw new MusicProviderError('download_failed', 'truncated response');
    }
    if (completed === 0) {
      throw new MusicProviderError('download_failed', 'empty file');
    }

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
    // The derived media lives under `media` — see `DerivedAssetMedia`. Read off `derived`
    // itself it compiled, read `undefined`, and stored `peaks: null` for every sourced
    // track, so the timeline drew a skeleton waveform over a real, already-derived one.
    const derivedMedia = derived?.media;

    return {
      relativePath,
      kind: 'audio',
      durationSeconds: derived?.durationSeconds ?? track.durationSeconds,
      media: derivedMedia
        ? {
            proxyPath: derivedMedia.proxyPath ?? null,
            peaks: derivedMedia.peaks ?? null,
            peaksPerSecond: derivedMedia.peaksPerSecond ?? null,
            thumbnailPaths: derivedMedia.thumbnailPaths ?? null,
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
function writeChunk(sink: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Close the sink, never rejecting and never hanging.
 *
 * `end()`'s callback does not fire on a stream that has already errored, so a
 * failed write would leave this promise pending forever inside a `finally`. The
 * 'error' listener resolves the same promise; the error itself is reported by
 * the caller's own `sinkError` capture.
 */
function closeStream(sink: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    sink.once('error', () => resolve());
    sink.end(() => resolve());
  });
}

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
