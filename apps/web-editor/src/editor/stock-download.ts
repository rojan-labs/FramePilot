/**
 * Getting a Pexels photo or video into the project, for every way the Photos and Videos panel
 * places one: **Add** (a cutaway), **Add as overlay** (a picture-in-picture) and a tile dropped
 * on the timeline (plan/elements EL9).
 *
 * One flow, so all three show the same thing on the tile: the download is recorded in the tile
 * registry (`download-registry.ts`) before main is asked, which is what gives the tile its
 * progress bar and a working Cancel — and keeps them across a tab switch — and a failure is
 * written there too, so the tile says it. Only the placement differs, and the caller supplies it.
 *
 * The renderer names an item by its provider id; main holds the provider URL and does the fetch
 * (ADR 0139). Nothing here can reach a provider host.
 */
import {
  createLogger,
  type StockDownloadedAssetWire,
  type StockDownloadRequest,
  type StockDownloadResult,
  type StockErrorCodeWire,
  type StockMediaKindWire,
} from '@framepilot/shared-types';
import type { Patch, ValidationIssue } from '@framepilot/editor-core';
import type { Asset } from '@framepilot/timeline-schema';
import type { DownloadRegistry } from './download-registry.js';

const log = createLogger('web-editor:stock-download');

/** The sentence for each failure. No generic "something went wrong". */
export function stockErrorText(code: StockErrorCodeWire, detail?: string): string {
  switch (code) {
    case 'no_key':
      return 'Add your Pexels API key in Settings to search.';
    case 'unauthorized':
      return 'Pexels rejected this key. Check it in Settings.';
    case 'rate_limited':
      return detail
        ? `You've hit the hourly limit of about 200 requests (${detail}).`
        : "You've hit the hourly limit of about 200 requests. It clears within the hour.";
    case 'quota_exhausted':
      return "You've used this month's request allowance.";
    case 'provider_unavailable':
      return 'Pexels is not responding. Try again shortly.';
    case 'offline':
      return 'No network connection.';
    case 'timeout':
      return 'Pexels took too long to answer.';
    case 'cancelled':
      return '';
    case 'too_large':
      return 'That file is larger than the 2 GB limit. Pick a smaller size.';
    case 'disk_full':
      return 'Not enough disk space to save this file.';
    case 'download_failed':
      return "The download didn't finish. Nothing was added.";
    case 'derive_failed':
      return "Saved the file, but couldn't read its thumbnails.";
  }
}

/**
 * The key a tile's download is kept under in the registry: the kind and the provider id. A Pexels
 * photo and a video can share a numeric id; keyed by the id alone, one tile would show the
 * other's progress. (The asset id stays `stock_<provider>_<id>`: projects store it.)
 */
export function stockDownloadKey(kind: StockMediaKindWire, remoteId: string): string {
  return `${kind}:${remoteId}`;
}

/** Which way a tile's media was being placed: Add, Add as overlay, or a drag to the timeline. */
export type StockPlacementAction = 'cutaway' | 'overlay' | 'drop';

/**
 * Said when the timeline refused the placement's patch (the validator's reason is logged): the
 * download is on disk but nothing was added, and the user can try again.
 */
export const STOCK_PLACEMENT_REJECTED =
  "The timeline couldn't take this clip, so nothing was added. Try again at another moment.";

/**
 * Put a placement's patch on the timeline through the editor's checked apply: `null` once it is
 * there, else {@link STOCK_PLACEMENT_REJECTED} — the validator's reasons are logged, not shown,
 * because they name clip ids an editor never sees.
 *
 * @param applyChecked - The editor's `applyPatchChecked`: the error issues, empty when applied.
 * @param patch - The placement.
 */
export function applyStockPatch(
  applyChecked: (patch: Patch) => readonly ValidationIssue[],
  patch: Patch,
): string | null {
  const issues = applyChecked(patch);
  if (issues.length === 0) return null;
  log.warn('stock placement refused by the timeline', {
    patchId: patch.patchId,
    issues: issues.map((issue) => issue.message),
  });
  return STOCK_PLACEMENT_REJECTED;
}

/** A stable asset id for a provider item, so re-adding the same rendition is detectable. */
export function stockAssetIdOf(provider: string, remoteId: string): string {
  return `stock_${provider}_${remoteId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * The project asset a finished download becomes.
 *
 * @param assetId - {@link stockAssetIdOf} for the item.
 * @param downloaded - What main saved into the project's media folder.
 */
export function stockAssetFromDownload(
  assetId: string,
  downloaded: StockDownloadedAssetWire,
): Asset {
  return {
    id: assetId,
    path: downloaded.relativePath,
    kind: downloaded.kind,
    ...(downloaded.durationSeconds === undefined
      ? {}
      : { durationSeconds: downloaded.durationSeconds }),
    // The wire type is readonly; `Asset` is not, so arrays are copied rather
    // than cast — a shared frozen array is a mutation bug in waiting.
    ...(downloaded.media
      ? {
          media: {
            // Both or neither, as everywhere else that carries this pair. Dropping it
            // here would undo the whole point of the wire type carrying it: a stock
            // library is overwhelmingly 16:9, so a shapeless stock asset is exactly
            // the landscape-in-portrait case `list_assets`' letterbox note and the
            // review's reframe check exist to catch, and both go quiet without it.
            ...(downloaded.media.width != null && downloaded.media.height != null
              ? {
                  width: downloaded.media.width,
                  height: downloaded.media.height,
                  pixelAspectRatio: downloaded.media.pixelAspectRatio ?? null,
                  rotation: downloaded.media.rotation ?? null,
                }
              : {}),
            proxyPath: downloaded.media.proxyPath ?? null,
            peaks: downloaded.media.peaks ? [...downloaded.media.peaks] : null,
            peaksPerSecond: downloaded.media.peaksPerSecond ?? null,
            thumbnailPaths: downloaded.media.thumbnailPaths
              ? [...downloaded.media.thumbnailPaths]
              : null,
          },
        }
      : {}),
    source: downloaded.source,
  };
}

/** What the flow reaches outside the editor (the panel and the drop pass the bridge's). */
export interface StockFetchDeps {
  readonly download: (request: StockDownloadRequest) => Promise<StockDownloadResult>;
  /** The registry the tile reads its state from. */
  readonly registry: DownloadRegistry;
}

/** One item to fetch at the project's size. */
export interface StockFetch {
  readonly projectId: string;
  readonly remoteId: string;
  /** The kind the tile shows; main refuses the id if it now names the other kind. */
  readonly kind: StockMediaKindWire;
  /** Project frame height, so main can size the download to the timeline. */
  readonly targetHeight: number;
  readonly targetFps?: number;
}

/** How a fetch-and-place ended. `message` is what the caller shows ('' says nothing). */
export type StockPlaced =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `busy` — already downloading; `cancelled` — the user pressed Cancel; `failed` — the
       * download did not finish; `refused` — it landed but the placement said no.
       */
      readonly reason: 'busy' | 'cancelled' | 'failed' | 'refused';
      readonly message: string;
    };

/** Said when a second placement of an item already in flight is asked for. */
export const STOCK_ALREADY_DOWNLOADING =
  'That clip is already downloading. Wait for it to land, then drag it from Assets.';

/**
 * Download `request.remoteId` into the project, then hand the asset to `place`.
 *
 * `place` reads the editor as it is when the bytes land — the playhead and the timeline move
 * while a clip downloads — and returns the sentence that explains a refusal, or `null` once the
 * clip is placed. A refusal is shown on the tile the user was watching: dropping it in silence
 * would leave them waiting for a clip that was never coming.
 *
 * @param deps - The download bridge and the tile registry.
 * @param request - What to fetch.
 * @param place - Places the finished asset; returns a refusal sentence or `null`.
 * @param action - Which placement this is, recorded with a failure so the tile offers that one
 *   again.
 */
export async function downloadAndPlaceStock(
  deps: StockFetchDeps,
  request: StockFetch,
  place: (asset: Asset) => string | null,
  action: StockPlacementAction = 'cutaway',
): Promise<StockPlaced> {
  const { registry, download } = deps;
  const key = stockDownloadKey(request.kind, request.remoteId);
  // A second download of an item in flight would fight the first over the same destination file.
  if (registry.getSnapshot()[key]?.kind === 'downloading') {
    return { ok: false, reason: 'busy', message: STOCK_ALREADY_DOWNLOADING };
  }
  const operationId = `stock_${request.kind}_${request.remoteId}_${Date.now()}`;
  // Registered before the await, so switching tabs mid-download and coming back still shows the
  // progress bar and a working Cancel.
  registry.start(key, operationId);

  // Main may not answer at all (the window is closing, the licence lapsed): that is a download
  // that did not finish, said as one, never a tile stuck "downloading" forever.
  const result = await download({
    projectId: request.projectId,
    remoteId: request.remoteId,
    kind: request.kind,
    operationId,
    targetHeight: request.targetHeight,
    ...(request.targetFps ? { targetFps: request.targetFps } : {}),
  }).catch((cause: unknown): StockDownloadResult => {
    log.warn('stock download did not answer', { remoteId: request.remoteId, cause: String(cause) });
    return { ok: false, error: 'download_failed' };
  });

  if (!result.ok) {
    // A cancel is not a failure — the user did it deliberately, so the tile returns to idle with
    // no error text.
    if (result.error === 'cancelled') {
      registry.clear(key);
      return { ok: false, reason: 'cancelled', message: '' };
    }
    const message = stockErrorText(result.error, result.detail);
    registry.fail(key, message, action);
    log.warn('stock download failed', { remoteId: request.remoteId, error: result.error });
    return { ok: false, reason: 'failed', message };
  }

  const asset = stockAssetFromDownload(
    stockAssetIdOf(result.asset.source.provider, request.remoteId),
    result.asset,
  );
  const refusal = place(asset);
  if (refusal !== null) {
    registry.fail(key, refusal, action);
    return { ok: false, reason: 'refused', message: refusal };
  }
  registry.clear(key);
  log.action('stock placed', { remoteId: request.remoteId, assetId: asset.id, action });
  return { ok: true };
}
