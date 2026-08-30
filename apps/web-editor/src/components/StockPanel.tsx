/**
 * Stock — search Pexels for photos and video, preview them, and place one on the
 * timeline as a cutaway.
 *
 * ## Hover is a scrub, not an autoplay loop
 *
 * Pointing at a video tile starts its low-res rendition. Moving the cursor
 * across the tile then hands the playhead to the cursor: x maps to time, the
 * clip pauses, and a hairline marks the position. That is the difference between
 * "this tile is animated at me" and "I am looking through this clip" — an editor
 * deciding whether a shot works needs to reach 0:07 in half a second, and a
 * looping autoplay makes them wait for it.
 *
 * Under `prefers-reduced-motion` the autoplay half is dropped and the scrub half
 * is kept: scrubbing is motion the user is actively driving, which is the
 * distinction that setting is about.
 *
 * ## Placement can be refused, on purpose
 *
 * The preview flattens picture clips from every track while the export
 * composites them, so a stock clip stacked over existing footage would preview
 * differently from how it renders. Add is therefore disabled — with the reason
 * visible before the click — whenever the playhead is over picture media. See
 * `addStockClipPatch` and `plan/3rd-party-sourcing/photo-video/README.md` §2.
 *
 * ## No provider URL is in this file
 *
 * Search returns items with no URLs at all. Tiles and previews ask main for
 * bytes and wrap them in `blob:`, which the existing CSP already permits. The
 * renderer has nothing to reach a provider host *with*.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Project } from '@framepilot/timeline-schema';
import { DEFAULT_STOCK_STILL_SECONDS } from '@framepilot/editor-core';
import { Button } from '@framepilot/ui';
import {
  isDesktop,
  onStockQuotaChanged,
  stockDownload,
  stockDownloadCancel,
  stockPreview,
  stockQuota,
  stockSearch,
  stockThumbnail,
  type StockErrorCodeWire,
  type StockItemWire,
  type StockMediaKindWire,
  type StockQuotaSnapshot,
} from '../editor/bridge.js';
import { stockDownloads, useDownloads } from '../editor/download-registry.js';
import { Film, ICON_SIZE, Image as ImageIcon, X } from './icons.js';

/** Typing pause before a search fires. Long enough not to bill every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
/** Skeleton tiles during the first search, at a real tile's aspect ratio. */
const SKELETON_TILES = 8;
/** Horizontal travel before a hover becomes a scrub. Below this it is a jitter. */
const SCRUB_THRESHOLD_PX = 3;
/** Warn below this share of the monthly allowance. */
const LOW_QUOTA_RATIO = 0.1;

export interface StockPanelProps {
  readonly project: Project;
  /**
   * Why placing a clip of this length would be impossible, or `null` when it is
   * fine. Computed by the caller because it holds the timeline, and asked
   * PER TILE because the answer depends on the clip's own duration: a panel-wide
   * probe passes a 12-second clip that a 5-second one would fit, and the user
   * then waits through a download for nothing.
   */
  readonly placementBlockedReasonFor: (durationSeconds: number) => string | null;
  /**
   * Place the downloaded asset. Owned by the caller because it holds the store.
   * Returns the reason it could not be placed — the playhead can move onto
   * occupied ground while the download is in flight — or `null` on success. A
   * dropped clip must be *said*, not swallowed: the user watched it download.
   */
  readonly onAddStock: (asset: Asset) => string | null;
  /** Opens Settings → Stock media, for the no-key and quota states. */
  readonly onOpenSettings?: () => void;
}

/**
 * What a tile is doing.
 *
 * `downloading` and `failed` are read from {@link stockDownloads} rather than
 * component state, because a download outlives the panel: the Stock tab unmounts
 * on a tab switch, which is exactly what a user does while a clip lands. See
 * `download-registry.ts`.
 */
type TileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly operationId: string; readonly percent: number | null }
  | { readonly kind: 'failed'; readonly message: string };

type SearchState =
  /** No key: there is nothing to browse and nothing to search. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'results';
      readonly items: readonly StockItemWire[];
      readonly hasMore: boolean;
      readonly page: number;
      readonly stale: boolean;
    }
  | { readonly kind: 'noResults'; readonly query: string }
  | { readonly kind: 'error'; readonly code: StockErrorCodeWire; readonly message: string };

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

/** `92` → `1:32`. Duration is the first thing an editor reads on a clip. */
export function formatClipLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * `24000000` → `24 MB`. Sized so a download is a considered click.
 *
 * Decimal, not binary: this number sits next to the one the OS file browser
 * shows and the one the provider quotes, and both of those are decimal. Being
 * technically-correct-in-mebibytes here would just look like an off-by-4%.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** `1920×1080 · 24 MB` — what the user is about to spend, before they spend it. */
export function variantLabel(variant: StockItemWire['variants'][number]): string {
  const size = `${variant.width}×${variant.height}`;
  return variant.approxBytes === undefined ? size : `${size} · ${formatBytes(variant.approxBytes)}`;
}

/** A stable asset id, so re-adding the same rendition is detectable. */
export function stockAssetId(item: StockItemWire): string {
  return `stock_${item.provider}_${item.remoteId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** The rendition main would pick: smallest that covers the project height. */
export function tileVariant(
  item: StockItemWire,
  targetHeight: number,
): StockItemWire['variants'][number] | undefined {
  const sorted = [...item.variants].sort((a, b) => a.height - b.height);
  return sorted.find((variant) => variant.height >= targetHeight) ?? sorted[sorted.length - 1];
}

export function StockPanel({
  project,
  placementBlockedReasonFor,
  onAddStock,
  onOpenSettings,
}: StockPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<StockMediaKindWire>('video');
  // Starts loading, not empty: the browse request is fired by the mount effect
  // below, and a skeleton is the honest thing to show while it is in flight.
  const [search, setSearch] = useState<SearchState>({ kind: 'loading' });
  /**
   * Why the last "Load more" failed, shown beside the retained results.
   *
   * Separate from `search` because it is NOT a search state: the results the
   * user already has are still good, and only the next page is missing.
   */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  /**
   * `null` until main has answered, which is NOT the same as "unmeasured".
   * Browsing before the answer arrives would spend a request on a session that
   * has no key to spend it with.
   */
  const [quota, setQuota] = useState<StockQuotaSnapshot | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLUListElement | null>(null);
  const downloads = useDownloads(stockDownloads);
  /**
   * Which search the grid is currently showing.
   *
   * Requests are not cancellable once sent, and a slow page-1 for "cat" can land
   * after a fast page-1 for "dog" — replacing the results the user is actually
   * looking at with the ones they abandoned. Each request captures the counter
   * and only writes if it is still the newest. Debouncing narrows this window
   * but does not close it: "Load more" fires with no debounce at all.
   */
  const searchGenerationRef = useRef(0);

  /** Whether main has told us there is no key to search with. */
  const keyless = quota?.kind === 'no_key';

  const projectHeight = project.resolution?.height ?? 1080;

  /** Items already downloaded into this project, so a tile can say so. */
  const presentRemoteIds = useMemo(
    () =>
      new Set(
        project.assets
          .filter((asset) => asset.source?.provider === 'pexels')
          .map((asset) => asset.source?.remoteId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    [project.assets],
  );

  /** The tile's download state. Absent from the registry means nothing is going on. */
  const tileState = useCallback(
    (remoteId: string): TileState => downloads[remoteId] ?? { kind: 'idle' },
    [downloads],
  );

  // ---------------------------------------------------------------------------
  // Quota — one source, pushed by main, shared with Settings
  // ---------------------------------------------------------------------------

  useEffect(() => {
    void stockQuota().then(setQuota);
    return onStockQuotaChanged(setQuota);
  }, []);

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  const runSearch = useCallback(
    async (text: string, mediaKind: StockMediaKindWire, page: number): Promise<void> => {
      const generation = ++searchGenerationRef.current;
      const result = await stockSearch({ text, kind: mediaKind, page });
      // Superseded while in flight. Dropped in silence: the newer search owns
      // the grid, and reporting this one's outcome — results OR an error — would
      // talk about a query the user has already moved on from.
      if (searchGenerationRef.current !== generation) return;
      if (!result.ok) {
        if (result.error === 'cancelled') return;
        const message = stockErrorText(result.error, result.detail);
        setSearch((current) => {
          // A failed "Load more" must not destroy the pages the user already
          // has. Those results are still valid and still placeable; replacing
          // them with an error screen costs a search the user already paid a
          // provider request for.
          if (page > 1 && current.kind === 'results') {
            setLoadMoreError(message);
            return current;
          }
          return { kind: 'error', code: result.error, message };
        });
        return;
      }
      setLoadMoreError(null);
      setSearch((current) =>
        page > 1 && current.kind === 'results'
          ? {
              kind: 'results',
              items: [...current.items, ...result.items],
              hasMore: result.hasMore,
              page: result.page,
              stale: false,
            }
          : result.items.length === 0
            ? { kind: 'noResults', query: text }
            : {
                kind: 'results',
                items: result.items,
                hasMore: result.hasMore,
                page: result.page,
                stale: false,
              },
      );
    },
    [],
  );

  useEffect(() => {
    // Nothing to browse and nothing to search without a key. The panel says so
    // instead. This is a state check, not a request check: main answers `no_key`
    // from the key store without touching the provider, so an unconfigured
    // session costs nothing either way.
    if (keyless) {
      setSearch({ kind: 'empty' });
      return;
    }
    const text = query.trim();

    // Previous results stay visible and dimmed rather than clearing: a grid that
    // blanks on every keystroke makes the panel feel broken while it works.
    setSearch((current) =>
      current.kind === 'results' ? { ...current, stale: true } : { kind: 'loading' },
    );

    let cancelled = false;
    // An empty box is a browse, and a browse is not typing — it fires at once.
    // The debounce exists to stop billing a request per keystroke, and there are
    // no keystrokes here.
    const timer = setTimeout(
      () => {
        if (cancelled) return;
        void runSearch(text, kind, 1);
      },
      text === '' ? 0 : SEARCH_DEBOUNCE_MS,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Also retire any request already sent for the previous query. Clearing
      // the box shows the empty state, and a straggler landing afterwards would
      // repopulate a grid the user just emptied.
      searchGenerationRef.current += 1;
    };
    // `keyless` is a boolean, deliberately: depending on the quota OBJECT would
    // re-run this on every observation — and each search produces one, which is
    // a loop.
  }, [query, kind, runSearch, keyless]);

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  const add = useCallback(
    async (item: StockItemWire): Promise<void> => {
      // Guarded here rather than only in the click handler, because the tile's
      // Enter shortcut reaches this too — and a second download of an item
      // already in flight would fight the first over the same destination file.
      if (stockDownloads.getSnapshot()[item.remoteId]?.kind === 'downloading') return;
      const operationId = `stock_${item.remoteId}_${Date.now()}`;
      // Registered before the await, so switching tabs mid-download and coming
      // back still shows the progress bar and a working Cancel.
      stockDownloads.start(item.remoteId, operationId);

      const result = await stockDownload({
        projectId: project.id,
        remoteId: item.remoteId,
        operationId,
        targetHeight: projectHeight,
        ...(project.fps ? { targetFps: project.fps } : {}),
      });

      if (!result.ok) {
        // A cancel is not a failure — the user did it deliberately, so the tile
        // returns to idle with no error text.
        if (result.error === 'cancelled') stockDownloads.clear(item.remoteId);
        else stockDownloads.fail(item.remoteId, stockErrorText(result.error, result.detail));
        return;
      }

      const { asset: downloaded } = result;
      // The verdict is the CALLER's, taken after the download with the timeline
      // as it is now — the playhead may have moved onto occupied ground while
      // the bytes were in flight. A refusal is shown on the tile the user was
      // watching; silently dropping it would leave them waiting for a clip that
      // was never coming.
      const refusal = onAddStock({
        id: stockAssetId(item),
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
                  ? { width: downloaded.media.width, height: downloaded.media.height }
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
      });
      if (refusal === null) stockDownloads.clear(item.remoteId);
      else stockDownloads.fail(item.remoteId, refusal);
    },
    [onAddStock, project.fps, project.id, projectHeight],
  );

  /**
   * Why THIS item cannot be placed, or `null`. A still has no duration of its
   * own, so it is probed at the length a placed still actually gets — the same
   * number the builder will use, which is what keeps the button honest.
   */
  const blockedReasonFor = useCallback(
    (item: StockItemWire): string | null =>
      placementBlockedReasonFor(item.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS),
    [placementBlockedReasonFor],
  );

  // ---------------------------------------------------------------------------
  // Keyboard: one tab stop, arrows move between tiles (mirrors the bin grid)
  // ---------------------------------------------------------------------------

  const items = search.kind === 'results' ? search.items : [];
  const tabbableId = focusedId ?? items[0]?.remoteId ?? null;

  const onTileKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number, item: StockItemWire): void => {
      // A tile contains its own controls — Cancel, the licence link. Enter
      // belongs to whatever is focused, so when focus is INSIDE the tile the
      // tile must not also act: otherwise Enter on Cancel starts a second
      // download, and Enter on the licence link is swallowed instead of opening
      // the page the user is trying to read. Arrow navigation still works from
      // anywhere in the tile.
      const onTileItself = event.target === event.currentTarget;
      const move = (to: number): void => {
        const clamped = Math.max(0, Math.min(items.length - 1, to));
        const next = items[clamped];
        if (!next) return;
        event.preventDefault();
        setFocusedId(next.remoteId);
        // By position, not by an attribute selector built from a provider id:
        // a `remoteId` is arbitrary provider text and escaping it correctly for
        // a selector is a needless dependency on `CSS.escape`.
        gridRef.current?.querySelectorAll<HTMLElement>('.stock-tile')[clamped]?.focus();
      };
      // A masonry has no rows to step across: tiles are different heights and
      // flow DOWN one column before starting the next, so "the tile below" is
      // simply the next one. Stepping by a column count here would skip past
      // whatever the user is looking at.
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          move(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          move(index - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(items.length - 1);
          break;
        case 'Enter':
          if (
            onTileItself &&
            blockedReasonFor(item) === null &&
            !presentRemoteIds.has(item.remoteId)
          ) {
            event.preventDefault();
            void add(item);
          }
          break;
        default:
          break;
      }
    },
    [add, blockedReasonFor, items, presentRemoteIds],
  );

  // Browser build: the tab is absent entirely (see Editor.tsx). This is the
  // backstop for a direct render, and says why rather than showing a dead input.
  if (!isDesktop()) {
    return (
      <div className="stock-panel">
        <p className="stock-note" role="note">
          Stock search runs in the FramePilot desktop app, which fetches media outside the browser
          sandbox. Open this project in desktop to search for photos and video.
        </p>
      </div>
    );
  }

  const noKey = keyless || (search.kind === 'error' && search.code === 'no_key');
  /** An empty box shows the provider's own curated feed rather than a blank panel. */
  const browsing = query.trim() === '';
  const browseLabel = kind === 'video' ? 'Popular on Pexels' : 'Curated on Pexels';

  return (
    <div className="stock-panel">
      {/* One row holds everything that is not a result: what to search, what to
          search for, and who the media comes from. Below it is the grid and
          nothing else — a sidebar this narrow cannot spend two lines on prose
          the user reads once. */}
      <div className="stock-controls">
        <label className="stock-search" htmlFor="stock-search-input">
          <span className="sr-only">Search for photos and video</span>
          <input
            id="stock-search-input"
            type="search"
            className="stock-search-input"
            placeholder={kind === 'video' ? 'Search video…' : 'Search photos…'}
            value={query}
            disabled={noKey}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {/* A select rather than the old segmented pair: it states the current
            kind in the width of one control instead of two. */}
        <label className="stock-kind-select" htmlFor="stock-kind-select">
          <span className="sr-only">Media kind</span>
          {kind === 'video' ? (
            <Film size={ICON_SIZE.sm} aria-hidden="true" />
          ) : (
            <ImageIcon size={ICON_SIZE.sm} aria-hidden="true" />
          )}
          <select
            id="stock-kind-select"
            value={kind}
            disabled={noKey}
            onChange={(event) => setKind(event.target.value as StockMediaKindWire)}
          >
            <option value="video">Video</option>
            <option value="photo">Photos</option>
          </select>
        </label>
        {/* Required by the Pexels API guidelines. It lives in this row for the
            same reason everything else does — it is not a result. */}
        <a
          className="stock-credit"
          href="https://www.pexels.com"
          target="_blank"
          rel="noreferrer noopener"
        >
          Pexels
        </a>
      </div>

      {/* Announced politely so a screen-reader user hears the count and the
          quota state without the grid stealing focus mid-type. */}
      <span className="sr-only" aria-live="polite">
        {search.kind === 'results' && !search.stale
          ? `${search.items.length} ${kind === 'video' ? 'clip' : 'photo'}${
              search.items.length === 1 ? '' : 's'
            } ${browsing ? 'shown' : 'found'}`
          : ''}
      </span>

      <QuotaStrip
        quota={quota ?? { kind: 'unmeasured' }}
        {...(onOpenSettings ? { onOpenSettings } : {})}
      />

      {noKey ? (
        <div className="stock-hint">
          <p className="stock-note">
            Stock search needs a free Pexels API key. It takes about a minute to get one, and the
            only thing that leaves your machine is the words you type.
          </p>
          {onOpenSettings ? (
            <Button variant="ghost" type="button" onClick={onOpenSettings}>
              Open Settings
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {/* The panel-level note answers "why is everything disabled?", so it
              speaks only when NOTHING here can be placed. Per-tile reasons live
              on the tiles. */}
          {search.kind === 'results' &&
          search.items.length > 0 &&
          search.items.every((item) => blockedReasonFor(item) !== null) ? (
            <p className="stock-blocked" role="status">
              {blockedReasonFor(search.items[0]!)}
            </p>
          ) : null}

          {search.kind === 'loading' && (
            <ul className="stock-grid" aria-busy="true">
              {Array.from({ length: SKELETON_TILES }, (_, index) => (
                // Real tile proportions, so nothing shifts when results land.
                <li key={index} className="stock-tile stock-tile--skeleton" aria-hidden="true" />
              ))}
            </ul>
          )}

          {search.kind === 'noResults' && (
            <p className="stock-note">
              {search.query === ''
                ? 'Pexels returned nothing to browse. Search for a subject instead.'
                : `Nothing matched “${search.query}”. Try a broader word — a subject rather than a scene.`}
            </p>
          )}

          {search.kind === 'error' && search.message !== '' && (
            <p className="stock-error" role="alert">
              {search.message}
            </p>
          )}

          {search.kind === 'results' && (
            // The scroll lives HERE, not on the grid. A multi-column box with a
            // fixed height fills that height and then adds columns sideways —
            // the grid has to be free to grow so its columns stay vertical.
            <div className="stock-results">
              <ul
                ref={gridRef}
                className={`stock-grid${search.stale ? ' is-stale' : ''}`}
                aria-label={
                  browsing
                    ? `${browseLabel} — ${kind === 'video' ? 'video' : 'photos'}`
                    : kind === 'video'
                      ? 'Stock video results'
                      : 'Stock photo results'
                }
              >
                {search.items.map((item, index) => (
                  <StockTile
                    key={item.remoteId}
                    item={item}
                    index={index}
                    state={tileState(item.remoteId)}
                    inProject={presentRemoteIds.has(item.remoteId)}
                    blockedReason={blockedReasonFor(item)}
                    targetHeight={projectHeight}
                    tabbable={tabbableId === item.remoteId}
                    onFocus={() => setFocusedId(item.remoteId)}
                    onKeyDown={onTileKeyDown}
                    onAdd={() => void add(item)}
                    onCancel={(operationId) => stockDownloadCancel(operationId)}
                  />
                ))}
              </ul>
              {loadMoreError !== null ? (
                <p className="stock-error" role="alert">
                  {loadMoreError}
                </p>
              ) : null}
              {search.hasMore ? (
                // A button, never infinite scroll: every page is one of ~200
                // requests an hour, and it should be one the user asked for.
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => void runSearch(query.trim(), kind, search.page + 1)}
                >
                  Load more
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Whether the viewer asked for less motion.
 *
 * Guarded because `matchMedia` is absent in jsdom and in some embedded webviews,
 * and an autoplay preview is not worth a thrown TypeError. Absent means "no
 * stated preference", which is the same answer a browser gives.
 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

// ---------------------------------------------------------------------------
// Quota strip
// ---------------------------------------------------------------------------

function QuotaStrip({
  quota,
  onOpenSettings,
}: {
  readonly quota: StockQuotaSnapshot;
  readonly onOpenSettings?: () => void;
}): JSX.Element | null {
  if (quota.kind === 'hourly_limited') {
    return (
      <p className="stock-quota-strip" data-tone="warning" role="status">
        Hourly limit reached. It clears within the hour
        {quota.retryAfterSeconds !== undefined
          ? ` — about ${Math.ceil(quota.retryAfterSeconds / 60)} min`
          : ''}
        .
      </p>
    );
  }
  if (quota.kind !== 'measured') return null;

  const { remaining, limit } = quota.monthly;
  if (remaining > limit * LOW_QUOTA_RATIO) return null;
  return (
    <p className="stock-quota-strip" data-tone="warning" role="status">
      {remaining.toLocaleString()} of {limit.toLocaleString()} monthly requests left.{' '}
      {onOpenSettings !== undefined ? (
        <button type="button" className="stock-inline-link" onClick={onOpenSettings}>
          See details
        </button>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

interface StockTileProps {
  readonly item: StockItemWire;
  readonly index: number;
  readonly state: TileState;
  readonly inProject: boolean;
  readonly blockedReason: string | null;
  readonly targetHeight: number;
  readonly tabbable: boolean;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent, index: number, item: StockItemWire) => void;
  readonly onAdd: () => void;
  readonly onCancel: (operationId: string) => void;
}

function StockTile({
  item,
  index,
  state,
  inProject,
  blockedReason,
  targetHeight,
  tabbable,
  onFocus,
  onKeyDown,
  onAdd,
  onCancel,
}: StockTileProps): JSX.Element {
  const thumbnail = useObjectUrl(() => stockThumbnail(item.remoteId));
  const preview = useScrubPreview(item);
  const downloading = state.kind === 'downloading';
  const variant = tileVariant(item, targetHeight);
  const downloadBlocked = blockedReason !== null;

  return (
    <li
      className="stock-tile"
      data-remote-id={item.remoteId}
      tabIndex={tabbable ? 0 : -1}
      style={{
        // The provider's own average colour and the item's own shape, so the tile
        // has its final size and roughly its final weight before a byte of image
        // arrives — and a portrait clip is not cropped to a landscape cell.
        //
        // This only holds because everything inside the tile is absolutely
        // positioned. A single in-flow child (the caption used to be one) makes
        // the tile taller than its ratio via `min-height: auto`, and THAT is what
        // made tiles overlap the ones beneath them.
        backgroundColor: item.avgColor,
        aspectRatio: `${item.width} / ${item.height}`,
      }}
      onFocus={onFocus}
      onKeyDown={(event) => onKeyDown(event, index, item)}
      onPointerEnter={preview.onEnter}
      onPointerMove={preview.onMove}
      onPointerLeave={preview.onLeave}
    >
      {thumbnail ? (
        <img className="stock-thumb" src={thumbnail} alt={item.title} draggable={false} />
      ) : (
        <span className="stock-thumb stock-thumb--pending" aria-hidden="true" />
      )}

      {preview.url ? (
        <video
          ref={preview.videoRef}
          className="stock-preview"
          src={preview.url}
          muted
          playsInline
          loop
          aria-hidden="true"
        />
      ) : null}

      {preview.scrubRatio !== null ? (
        <span
          className="stock-scrub"
          style={{ left: `${preview.scrubRatio * 100}%` }}
          aria-hidden="true"
        />
      ) : null}

      <div className="stock-tile-meta">
        <span className="stock-tile-title">{item.title}</span>
        <span className="stock-tile-facts">
          {item.durationSeconds !== undefined ? (
            <span className="stock-tile-duration">{formatClipLength(item.durationSeconds)}</span>
          ) : null}
          {variant ? <span className="stock-tile-size">{variantLabel(variant)}</span> : null}
        </span>
        {item.creator ? (
          <span className="stock-tile-creator">
            {item.creatorUrl ? (
              <a href={item.creatorUrl} target="_blank" rel="noreferrer noopener">
                {item.creator}
              </a>
            ) : (
              item.creator
            )}
          </span>
        ) : null}
      </div>

      <div className="stock-tile-action">
        {downloading ? (
          <>
            <div
              className="stock-progress"
              role="progressbar"
              aria-label={`Downloading ${item.title}`}
              {...(state.percent === null
                ? {}
                : { 'aria-valuenow': state.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
            >
              <span
                className="stock-progress-fill"
                style={{ width: `${state.percent ?? 0}%` }}
                aria-hidden="true"
              />
            </div>
            <button
              type="button"
              className="stock-cancel"
              aria-label={`Cancel downloading ${item.title}`}
              onClick={() => onCancel(state.operationId)}
            >
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </>
        ) : inProject ? (
          <span className="stock-present">In this project</span>
        ) : (
          <Button
            variant="ghost"
            type="button"
            disabled={downloadBlocked}
            title={blockedReason ?? undefined}
            onClick={onAdd}
          >
            {state.kind === 'failed' ? 'Retry' : 'Add'}
          </Button>
        )}
      </div>

      {state.kind === 'failed' && (
        <span className="stock-tile-error" role="alert">
          {state.message}
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Fetch bytes once and hold them as a `blob:` URL for the component's lifetime.
 *
 * Revoked on unmount, because a leaked object URL pins its bytes for the life of
 * the document — and a grid the user scrolls for a minute is a lot of bytes.
 */
function useObjectUrl(
  fetcher: () => Promise<{ ok: true; contentType: string; data: ArrayBuffer } | { ok: false }>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let created: string | null = null;
    let cancelled = false;
    void fetcherRef.current().then((result) => {
      if (cancelled || !result.ok) return;
      created = URL.createObjectURL(new Blob([result.data], { type: result.contentType }));
      setUrl(created);
    });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, []);

  return url;
}

/**
 * Hover preview with cursor-driven scrubbing.
 *
 * Three states, in order: idle, playing (hover with no travel), scrubbing (the
 * cursor owns the playhead). The transition to scrubbing is one-way for the
 * duration of the hover — flipping back to autoplay when the user briefly holds
 * still would yank the frame out from under them mid-decision.
 *
 * Bytes are fetched on first hover, not on mount: a grid of 24 clips would
 * otherwise pull tens of megabytes nobody asked to see.
 */
function useScrubPreview(item: StockItemWire): {
  readonly url: string | null;
  readonly scrubRatio: number | null;
  readonly videoRef: React.RefObject<HTMLVideoElement>;
  readonly onEnter: () => void;
  readonly onMove: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onLeave: () => void;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const blobRef = useRef<string | null>(null);
  const enterXRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (blobRef.current !== null) URL.revokeObjectURL(blobRef.current);
    };
  }, []);

  const onEnter = useCallback((): void => {
    if (!item.hasPreview || blobRef.current !== null) return;
    void stockPreview(item.remoteId).then((result) => {
      if (!result.ok) return;
      const created = URL.createObjectURL(new Blob([result.data], { type: result.contentType }));
      blobRef.current = created;
      setUrl(created);
      // Autoplay is the motion the app initiates, so it is what
      // `prefers-reduced-motion` switches off. Scrubbing stays: the user is
      // driving it, which is the distinction the setting is actually about.
      if (!prefersReducedMotion()) {
        queueMicrotask(() => void videoRef.current?.play().catch(() => undefined));
      }
    });
  }, [item.hasPreview, item.remoteId]);

  const onMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const video = videoRef.current;
    if (!video) return;

    const rect = event.currentTarget.getBoundingClientRect();
    if (enterXRef.current === null) enterXRef.current = event.clientX;
    if (!scrubbingRef.current && Math.abs(event.clientX - enterXRef.current) < SCRUB_THRESHOLD_PX) {
      // Below the threshold this is hand jitter, not an intent to scrub.
      return;
    }
    scrubbingRef.current = true;
    video.pause();

    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setScrubRatio(ratio);

    // Coalesce to one seek per frame. A pointermove stream can outrun the
    // decoder, and queuing every sample makes the picture lag the cursor.
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration <= 0) return;
      const time = ratio * duration;
      // `fastSeek` lands on the nearest keyframe without a full decode, which is
      // the right trade for a scrub: approximate and immediate beats exact and late.
      if (typeof video.fastSeek === 'function') video.fastSeek(time);
      else video.currentTime = time;
    });
  }, []);

  const onLeave = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    enterXRef.current = null;
    scrubbingRef.current = false;
    setScrubRatio(null);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, []);

  return { url, scrubRatio, videoRef, onEnter, onMove, onLeave };
}
