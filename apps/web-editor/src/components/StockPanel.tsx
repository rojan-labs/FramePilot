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
import { Button } from '@framepilot/ui';
import {
  isDesktop,
  onStockDownloadProgress,
  onStockQuotaChanged,
  stockDownload,
  stockDownloadCancel,
  stockPreview,
  stockQuota,
  stockSearch,
  stockThumbnail,
  type StockDownloadProgressWire,
  type StockErrorCodeWire,
  type StockItemWire,
  type StockMediaKindWire,
  type StockQuotaSnapshot,
} from '../editor/bridge.js';
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
   * Why placement is currently impossible, or `null` when it is fine. Computed
   * by the caller because it holds the timeline; passed in so the tile can
   * disable Add *before* the click rather than explaining afterwards.
   */
  readonly placementBlockedReason: string | null;
  /** Place the downloaded asset. Owned by the caller because it holds the store. */
  readonly onAddStock: (asset: Asset) => void;
  /** Opens Settings → Stock media, for the no-key and quota states. */
  readonly onOpenSettings?: () => void;
}

type TileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly operationId: string; readonly percent: number | null }
  | { readonly kind: 'failed'; readonly message: string };

type SearchState =
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
  placementBlockedReason,
  onAddStock,
  onOpenSettings,
}: StockPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<StockMediaKindWire>('video');
  const [search, setSearch] = useState<SearchState>({ kind: 'empty' });
  const [tiles, setTiles] = useState<Readonly<Record<string, TileState>>>({});
  const [quota, setQuota] = useState<StockQuotaSnapshot>({ kind: 'unmeasured' });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLUListElement | null>(null);

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

  const setTile = useCallback((remoteId: string, state: TileState): void => {
    setTiles((current) => ({ ...current, [remoteId]: state }));
  }, []);

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
      const result = await stockSearch({ text, kind: mediaKind, page });
      if (!result.ok) {
        if (result.error === 'cancelled') return;
        setSearch({
          kind: 'error',
          code: result.error,
          message: stockErrorText(result.error, result.detail),
        });
        return;
      }
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
    const text = query.trim();
    if (text === '') {
      setSearch({ kind: 'empty' });
      return;
    }

    // Previous results stay visible and dimmed rather than clearing: a grid that
    // blanks on every keystroke makes the panel feel broken while it works.
    setSearch((current) =>
      current.kind === 'results' ? { ...current, stale: true } : { kind: 'loading' },
    );

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void runSearch(text, kind, 1);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, kind, runSearch]);

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return onStockDownloadProgress((message: StockDownloadProgressWire) => {
      if (message.phase !== 'downloading') return;
      setTiles((current) => {
        const tile = current[message.remoteId];
        if (tile?.kind !== 'downloading') return current;
        const percent =
          message.totalBytes > 0
            ? Math.min(100, Math.round((message.completedBytes / message.totalBytes) * 100))
            : null;
        return { ...current, [message.remoteId]: { ...tile, percent } };
      });
    });
  }, []);

  const add = useCallback(
    async (item: StockItemWire): Promise<void> => {
      const operationId = `stock_${item.remoteId}_${Date.now()}`;
      setTile(item.remoteId, { kind: 'downloading', operationId, percent: null });

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
        setTile(
          item.remoteId,
          result.error === 'cancelled'
            ? { kind: 'idle' }
            : { kind: 'failed', message: stockErrorText(result.error, result.detail) },
        );
        return;
      }

      const { asset: downloaded } = result;
      onAddStock({
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
      setTile(item.remoteId, { kind: 'idle' });
    },
    [onAddStock, project.fps, project.id, projectHeight, setTile],
  );

  // ---------------------------------------------------------------------------
  // Keyboard: one tab stop, arrows move between tiles (mirrors the bin grid)
  // ---------------------------------------------------------------------------

  const items = search.kind === 'results' ? search.items : [];
  const tabbableId = focusedId ?? items[0]?.remoteId ?? null;

  const onTileKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number, item: StockItemWire): void => {
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
      // Two columns, so vertical movement is a two-step. Derived from the
      // rendered grid rather than assumed, so a narrower panel still navigates.
      const columns = gridColumnCount(gridRef.current);
      switch (event.key) {
        case 'ArrowRight':
          move(index + 1);
          break;
        case 'ArrowLeft':
          move(index - 1);
          break;
        case 'ArrowDown':
          move(index + columns);
          break;
        case 'ArrowUp':
          move(index - columns);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(items.length - 1);
          break;
        case 'Enter':
          if (placementBlockedReason === null && !presentRemoteIds.has(item.remoteId)) {
            event.preventDefault();
            void add(item);
          }
          break;
        default:
          break;
      }
    },
    [add, items, placementBlockedReason, presentRemoteIds],
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

  const noKey = quota.kind === 'no_key' || (search.kind === 'error' && search.code === 'no_key');

  return (
    <div className="stock-panel">
      <div className="stock-controls">
        <label className="stock-search" htmlFor="stock-search-input">
          <span className="sr-only">Search for photos and video</span>
          <input
            id="stock-search-input"
            type="search"
            className="stock-search-input"
            placeholder={kind === 'video' ? 'Search for video…' : 'Search for photos…'}
            value={query}
            disabled={noKey}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="stock-kinds" role="group" aria-label="Media kind">
          {(['video', 'photo'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="stock-kind"
              data-active={kind === option ? 'true' : undefined}
              aria-pressed={kind === option}
              disabled={noKey}
              onClick={() => setKind(option)}
            >
              {option === 'video' ? (
                <Film size={ICON_SIZE.sm} aria-hidden="true" />
              ) : (
                <ImageIcon size={ICON_SIZE.sm} aria-hidden="true" />
              )}
              {option === 'video' ? 'Video' : 'Photos'}
            </button>
          ))}
        </div>
      </div>

      {/* Announced politely so a screen-reader user hears the count and the
          quota state without the grid stealing focus mid-type. */}
      <span className="sr-only" aria-live="polite">
        {search.kind === 'results' && !search.stale
          ? `${search.items.length} ${kind === 'video' ? 'clip' : 'photo'}${
              search.items.length === 1 ? '' : 's'
            } found`
          : ''}
      </span>

      <QuotaStrip quota={quota} {...(onOpenSettings ? { onOpenSettings } : {})} />

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
          {placementBlockedReason !== null && search.kind === 'results' ? (
            <p className="stock-blocked" role="status">
              {placementBlockedReason}
            </p>
          ) : null}

          {search.kind === 'empty' && (
            <p className="stock-note">
              Search for a shot you don&rsquo;t have — &ldquo;city skyline at dusk&rdquo;,
              &ldquo;hands typing&rdquo;. For screen recordings, a punch-in on your own footage is
              usually the better cut.
            </p>
          )}

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
              Nothing matched &ldquo;{search.query}&rdquo;. Try a broader word — a subject rather
              than a scene.
            </p>
          )}

          {search.kind === 'error' && search.message !== '' && (
            <p className="stock-error" role="alert">
              {search.message}
            </p>
          )}

          {search.kind === 'results' && (
            <>
              <ul
                ref={gridRef}
                className={`stock-grid${search.stale ? ' is-stale' : ''}`}
                aria-label={kind === 'video' ? 'Stock video results' : 'Stock photo results'}
              >
                {search.items.map((item, index) => (
                  <StockTile
                    key={item.remoteId}
                    item={item}
                    index={index}
                    state={tiles[item.remoteId] ?? { kind: 'idle' }}
                    inProject={presentRemoteIds.has(item.remoteId)}
                    blockedReason={placementBlockedReason}
                    targetHeight={projectHeight}
                    tabbable={tabbableId === item.remoteId}
                    onFocus={() => setFocusedId(item.remoteId)}
                    onKeyDown={onTileKeyDown}
                    onAdd={() => void add(item)}
                    onCancel={(operationId) => stockDownloadCancel(operationId)}
                  />
                ))}
              </ul>
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
            </>
          )}
        </>
      )}

      {/* Required by the Pexels API guidelines, and rendered in every state
          rather than only where it is convenient. */}
      <p className="stock-credit">
        Photos and video from{' '}
        <a href="https://www.pexels.com" target="_blank" rel="noreferrer noopener">
          Pexels
        </a>
      </p>
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

/** How many tiles fit per row, read from the rendered grid. */
function gridColumnCount(grid: HTMLElement | null): number {
  if (!grid) return 2;
  const columns = getComputedStyle(grid).gridTemplateColumns;
  const count = columns.split(' ').filter((value) => value.trim() !== '').length;
  return count > 0 ? count : 2;
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
        // The provider's own average colour, so the tile has its final shape and
        // roughly its final weight before a byte of image arrives.
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
