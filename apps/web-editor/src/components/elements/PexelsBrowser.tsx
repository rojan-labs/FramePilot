/**
 * Elements → Photos / Videos — search Pexels for one kind of media, preview it, and
 * place one on the timeline as a cutaway.
 *
 * ## One kind per instance
 *
 * The kind is the Elements sub-tab the user chose (`kind` prop), not a control inside
 * the panel: CapCut keeps photos and videos apart, and a select in a sidebar this
 * narrow cost a control's width to say something the tab already says. The query is
 * the panel's own state, so switching between Photos and Videos re-searches the same
 * words in the other kind — the behaviour the old kind select had.
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
 * ## Two ways to place, and a drag
 *
 * **Add** is a cutaway: it is disabled — with the reason visible before the
 * click — whenever the playhead is over picture media (ADR 0140, see
 * `addStockClipPatch`). **Add as overlay** lays the media over whatever is there
 * as a centred picture-in-picture at 40% size, and is never refused for covering
 * picture: that is what it is for (ADR 0193). On a screen recording or a talking
 * head — a timeline full of footage — Overlay is the placement that works almost
 * everywhere, so it is one key away: the tile's own button takes **Enter** for Add
 * (or says why Add is blocked) and **Shift+Enter** for Overlay. Dragging a tile
 * onto a lane places it at the drop time. All three download through one flow
 * (`editor/stock-download.ts`), so the tile shows the same progress, Cancel and
 * failure whichever the user chose.
 *
 * ## One tab stop per grid
 *
 * Each tile's stop is a real button over its picture, named by the clip and
 * described by what Enter does there. Add, Overlay, Cancel and the credit link
 * sit out of the Tab order (Escape cancels a download), so 24 tiles are one stop,
 * not 72, before "Load more".
 *
 * ## Categories and shape
 *
 * A category chip is one curated search, and the orientation filter starts on
 * the project's own shape and travels with the search as Pexels' own parameter.
 * The curated and popular feeds take no orientation, so an empty box filters the
 * page Pexels already sent instead of buying it again.
 *
 * ## No provider URL is in this file
 *
 * Search returns items with no URLs at all. Tiles and previews ask main for
 * bytes and wrap them in `blob:`, which the existing CSP already permits. The
 * renderer has nothing to reach a provider host *with*.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  type StockOrientationWire,
  type StockQuotaSnapshot,
} from '../../editor/bridge.js';
import { stockDownloads, useDownloads } from '../../editor/download-registry.js';
import {
  STOCK_ALREADY_DOWNLOADING,
  downloadAndPlaceStock,
  stockAssetIdOf,
  stockDownloadKey,
  stockErrorText,
  type StockPlacementAction,
} from '../../editor/stock-download.js';
import { useLiveAnnouncement } from '../../editor/useLiveAnnouncement.js';
import { ICON_SIZE, RectangleHorizontal, RectangleVertical, Square, X } from '../icons.js';
import { writeElementDrag } from './element-dnd.js';

// The sentences live with the download flow the drop shares; re-exported for the panel's callers.
export { stockErrorText };

/** Typing pause before a search fires. Long enough not to bill every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
/** Skeleton tiles during the first search, at a real tile's aspect ratio. */
const SKELETON_TILES = 8;
/** Horizontal travel before a hover becomes a scrub. Below this it is a jitter. */
const SCRUB_THRESHOLD_PX = 3;
/** Warn below this share of the monthly allowance. */
const LOW_QUOTA_RATIO = 0.1;
/**
 * How far from 1:1 a frame may be and still read as square. A pixel or two off square (1081×1080)
 * is square to anyone looking at it; a 4:5 portrait (0.8) is not.
 */
const SQUARE_ASPECT_TOLERANCE = 0.05;

/**
 * The curated categories (plan/elements 02 §2.1). Each chip is ONE search of its query — the
 * words a person would type for it — cached like any other search.
 */
export const STOCK_CATEGORIES = [
  { id: 'business', label: 'Business', query: 'business' },
  { id: 'technology', label: 'Technology', query: 'technology' },
  { id: 'people', label: 'People', query: 'people' },
  { id: 'nature', label: 'Nature', query: 'nature' },
  { id: 'city', label: 'City', query: 'city' },
  { id: 'abstract', label: 'Abstract', query: 'abstract' },
  { id: 'backgrounds', label: 'Backgrounds', query: 'background' },
  { id: 'food', label: 'Food', query: 'food' },
  { id: 'travel', label: 'Travel', query: 'travel' },
  { id: 'textures', label: 'Textures', query: 'texture' },
] as const;
export type StockCategoryId = (typeof STOCK_CATEGORIES)[number]['id'];

/** The orientation filter: Pexels' own three shapes, or no filter at all. */
export type StockOrientationChoice = 'any' | StockOrientationWire;

const ORIENTATION_CHOICES: readonly {
  readonly id: StockOrientationChoice;
  readonly label: string;
}[] = [
  { id: 'any', label: 'Any' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'square', label: 'Square' },
];

/** The shape of a `width × height` frame, as the orientation filter names it. */
export function orientationOf(width: number, height: number): StockOrientationWire {
  const ratio = width / height;
  if (Math.abs(ratio - 1) <= SQUARE_ASPECT_TOLERANCE) return 'square';
  return ratio > 1 ? 'landscape' : 'portrait';
}

/**
 * The filter a project starts on: its own shape (1920×1080 → landscape, 1080×1920 → portrait).
 * A project with no frame size yet has no shape to match, so it filters nothing.
 */
export function projectOrientation(
  resolution: { readonly width: number; readonly height: number } | undefined,
): StockOrientationChoice {
  if (resolution === undefined || !(resolution.width > 0) || !(resolution.height > 0)) {
    return 'any';
  }
  return orientationOf(resolution.width, resolution.height);
}

export interface PexelsBrowserProps {
  /** Which Pexels library this instance searches — the Elements sub-tab. */
  readonly kind: StockMediaKindWire;
  /** The query to start with, so a remount (a sub-tab round trip) keeps the words. */
  readonly initialQuery?: string;
  /** Reports every change of the query, so the host can hand it back on remount. */
  readonly onQueryChange?: (query: string) => void;
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
  /**
   * Place the downloaded asset as a picture-in-picture at the playhead (**Add as overlay**,
   * ADR 0193). Returns a refusal sentence or `null`. Absent, the tiles offer Add only.
   */
  readonly onAddStockOverlay?: (asset: Asset) => string | null;
  /** The category to start with, so a remount (a sub-tab round trip) keeps it. */
  readonly initialCategory?: StockCategoryId | null;
  readonly onCategoryChange?: (category: StockCategoryId | null) => void;
  /** The orientation to start with; absent, the project's own. */
  readonly initialOrientation?: StockOrientationChoice;
  readonly onOrientationChange?: (orientation: StockOrientationChoice) => void;
  /** Opens Settings → Photos & videos (Pexels), for the no-key and quota states. */
  readonly onOpenSettings?: () => void;
  /**
   * Show an asset in Assets (the bin), for a tile already in the project: its "In this project"
   * pill, and Enter on it. Absent, the pill is a plain label.
   */
  readonly onShowInAssets?: (assetId: string) => void;
}

/** Said by Enter on a tile already in the project when there is no Assets panel to show it in. */
const ALREADY_IN_PROJECT = 'Already in this project. Drag it from Assets to use it again.';

/**
 * What a tile is doing.
 *
 * `downloading` and `failed` are read from {@link stockDownloads} rather than
 * component state, because a download outlives the panel: the Elements tab unmounts
 * on a tab switch, which is exactly what a user does while a clip lands. See
 * `download-registry.ts`.
 */
type TileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly operationId: string; readonly percent: number | null }
  | {
      readonly kind: 'failed';
      readonly message: string;
      /** Which placement failed (`StockPlacementAction`), so its own button says Retry. */
      readonly action?: string;
    };

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
  return stockAssetIdOf(item.provider, item.remoteId);
}

/** The rendition main would pick: smallest that covers the project height. */
export function tileVariant(
  item: StockItemWire,
  targetHeight: number,
): StockItemWire['variants'][number] | undefined {
  const sorted = [...item.variants].sort((a, b) => a.height - b.height);
  return sorted.find((variant) => variant.height >= targetHeight) ?? sorted[sorted.length - 1];
}

export function PexelsBrowser({
  kind,
  initialQuery = '',
  onQueryChange,
  project,
  placementBlockedReasonFor,
  onAddStock,
  onAddStockOverlay,
  initialCategory = null,
  onCategoryChange,
  initialOrientation,
  onOrientationChange,
  onOpenSettings,
  onShowInAssets,
}: PexelsBrowserProps): JSX.Element {
  const [query, setQueryState] = useState(initialQuery);
  const [category, setCategoryState] = useState<StockCategoryId | null>(initialCategory);
  const [orientation, setOrientationState] = useState<StockOrientationChoice>(
    () => initialOrientation ?? projectOrientation(project.resolution),
  );
  const setCategory = useCallback(
    (next: StockCategoryId | null): void => {
      setCategoryState(next);
      onCategoryChange?.(next);
    },
    [onCategoryChange],
  );
  const setQuery = useCallback(
    (next: string): void => {
      setQueryState(next);
      onQueryChange?.(next);
    },
    [onQueryChange],
  );
  const setOrientation = useCallback(
    (next: StockOrientationChoice): void => {
      setOrientationState(next);
      onOrientationChange?.(next);
    },
    [onOrientationChange],
  );
  /**
   * Whether the next search waits for typing to pause. Only keystrokes are debounced — that is
   * what stops billing a request per keystroke. A chip or a shape is one deliberate click, and
   * makes the user wait for nothing.
   */
  const debounceNextSearchRef = useRef(false);
  /** Typing is its own search: it leaves the category, whose chip no longer describes the grid. */
  const typeQuery = useCallback(
    (next: string): void => {
      debounceNextSearchRef.current = true;
      setQuery(next);
      if (category !== null) setCategory(null);
    },
    [category, setCategory, setQuery],
  );
  /** A chip (or the feed's, with `null`) replaces whatever was typed: the chip is the search. */
  const chooseCategory = useCallback(
    (next: StockCategoryId | null): void => {
      debounceNextSearchRef.current = false;
      if (query !== '') setQuery('');
      setCategory(next);
    },
    [query, setCategory, setQuery],
  );
  /** A new shape re-runs the current search at once. */
  const chooseOrientation = useCallback(
    (next: StockOrientationChoice): void => {
      debounceNextSearchRef.current = false;
      setOrientation(next);
    },
    [setOrientation],
  );
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
  /** What Enter said on a tile (a blocked Add's reason, say): read out in the polite region. */
  const [posted, announce] = useLiveAnnouncement();
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

  /**
   * Items already downloaded into this project, so a tile can say so — by kind and id, since a
   * Pexels photo and video can share an id. The asset's own kind says which it is. Mapped to the
   * asset's id, so the tile can show it in Assets.
   */
  const presentAssets = useMemo(
    () =>
      new Map(
        project.assets.flatMap((asset) =>
          asset.source?.provider === 'pexels' && typeof asset.source.remoteId === 'string'
            ? [
                [
                  stockDownloadKey(
                    asset.kind === 'image' ? 'photo' : 'video',
                    asset.source.remoteId,
                  ),
                  asset.id,
                ] as const,
              ]
            : [],
        ),
      ),
    [project.assets],
  );
  /** The project's asset for this item, when it has been downloaded already. */
  const presentAssetId = useCallback(
    (item: StockItemWire): string | undefined =>
      presentAssets.get(stockDownloadKey(item.kind, item.remoteId)),
    [presentAssets],
  );
  const inProject = useCallback(
    (item: StockItemWire): boolean => presentAssetId(item) !== undefined,
    [presentAssetId],
  );

  /** The tile's download state. Absent from the registry means nothing is going on. */
  const tileState = useCallback(
    (item: StockItemWire): TileState =>
      downloads[stockDownloadKey(item.kind, item.remoteId)] ?? { kind: 'idle' },
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

  /** The category chip in force, if any. */
  const categoryEntry = STOCK_CATEGORIES.find((entry) => entry.id === category);
  /** What is being asked of Pexels: the chip's curated words, else what was typed. */
  const searchText = categoryEntry?.query ?? query.trim();
  /** An empty search is the provider's own feed ("Curated" / "Popular"). */
  const browsing = searchText === '';
  /**
   * The orientation sent with the request. Never with a browse: Pexels' feeds take no
   * orientation, so sending one would only buy the same page again under another cache key.
   */
  const requestOrientation: StockOrientationWire | undefined =
    browsing || orientation === 'any' ? undefined : orientation;

  const runSearch = useCallback(
    async (
      text: string,
      mediaKind: StockMediaKindWire,
      page: number,
      shape: StockOrientationWire | undefined,
    ): Promise<void> => {
      const generation = ++searchGenerationRef.current;
      const result = await stockSearch({
        text,
        kind: mediaKind,
        page,
        ...(shape === undefined ? {} : { orientation: shape }),
      });
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
    // Previous results stay visible and dimmed rather than clearing: a grid that
    // blanks on every keystroke makes the panel feel broken while it works.
    setSearch((current) =>
      current.kind === 'results' ? { ...current, stale: true } : { kind: 'loading' },
    );

    let cancelled = false;
    // An empty box is a browse, and a browse is not typing — it fires at once, as
    // does a category chip or a change of shape: each is one deliberate click. The
    // debounce exists to stop billing a request per keystroke, and there are no
    // keystrokes there.
    const timer = setTimeout(
      () => {
        if (cancelled) return;
        void runSearch(searchText, kind, 1, requestOrientation);
      },
      searchText !== '' && debounceNextSearchRef.current ? SEARCH_DEBOUNCE_MS : 0,
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
    // a loop. The request's own parts are the other deps, so a second click on the
    // chip already in force — the same words, kind and shape — asks for nothing.
  }, [searchText, kind, requestOrientation, runSearch, keyless]);

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  /**
   * Download `item` and place it — as a cutaway (**Add**) or a picture-in-picture (**Add as
   * overlay**). Guarded against a second download of an item in flight inside the shared flow,
   * because the tile's Enter shortcut reaches this too.
   */
  const add = useCallback(
    async (item: StockItemWire, placement: 'cutaway' | 'overlay' = 'cutaway'): Promise<void> => {
      // The verdict is the CALLER's, taken after the download with the timeline
      // as it is now — the playhead may have moved onto occupied ground while
      // the bytes were in flight. The flow shows a refusal on the tile.
      const overlay = placement === 'overlay' && onAddStockOverlay !== undefined;
      const action: StockPlacementAction = overlay ? 'overlay' : 'cutaway';
      await downloadAndPlaceStock(
        { download: stockDownload, registry: stockDownloads },
        {
          projectId: project.id,
          remoteId: item.remoteId,
          kind: item.kind,
          targetHeight: projectHeight,
          ...(project.fps ? { targetFps: project.fps } : {}),
        },
        overlay ? onAddStockOverlay : onAddStock,
        action,
      );
    },
    [onAddStock, onAddStockOverlay, project.fps, project.id, projectHeight],
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

  /**
   * The tiles to show. A search already came back in the chosen shape; the feed did not (it
   * takes no orientation), so its page is filtered here by each item's own shape.
   */
  const items = useMemo((): readonly StockItemWire[] => {
    if (search.kind !== 'results') return [];
    if (!browsing || orientation === 'any') return search.items;
    return search.items.filter((item) => orientationOf(item.width, item.height) === orientation);
  }, [search, browsing, orientation]);
  const tabbableId = focusedId ?? items[0]?.remoteId ?? null;

  /**
   * What the tile's own button does — Enter, a click on the picture — and Shift+Enter. Over
   * footage Add is blocked and the reason is said rather than swallowed; Overlay still works. A
   * tile already in the project shows its asset in Assets.
   */
  const activate = useCallback(
    (item: StockItemWire, placement: 'cutaway' | 'overlay'): void => {
      if (tileState(item).kind === 'downloading') {
        announce(STOCK_ALREADY_DOWNLOADING);
        return;
      }
      const present = presentAssetId(item);
      if (present !== undefined) {
        if (onShowInAssets !== undefined) onShowInAssets(present);
        else announce(ALREADY_IN_PROJECT);
        return;
      }
      if (placement === 'overlay' && onAddStockOverlay !== undefined) {
        void add(item, 'overlay');
        return;
      }
      const blocked = blockedReasonFor(item);
      if (blocked !== null) {
        announce(blocked);
        return;
      }
      void add(item);
    },
    [add, announce, blockedReasonFor, onAddStockOverlay, onShowInAssets, presentAssetId, tileState],
  );

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
        gridRef.current?.querySelectorAll<HTMLElement>('.stock-tile-main')[clamped]?.focus();
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
          // Handled here, not by the button's own click, so Shift is read and the click that
          // Enter would synthesise does not act a second time.
          event.preventDefault();
          activate(item, event.shiftKey ? 'overlay' : 'cutaway');
          break;
        case 'Escape': {
          // Cancel sits out of the Tab order with the tile's other controls; Escape is its key.
          const state = tileState(item);
          if (state.kind !== 'downloading') break;
          event.preventDefault();
          event.stopPropagation();
          stockDownloadCancel(state.operationId);
          break;
        }
        default:
          break;
      }
    },
    [activate, items, tileState],
  );

  // Browser build: the sub-tab is absent entirely (see ElementsPanel). This is the
  // backstop for a direct render, and says why rather than showing a dead input.
  if (!isDesktop()) {
    return (
      <div className="stock-panel">
        <p className="stock-note" role="note">
          Photos and videos come from Pexels through the FramePilot desktop app, which fetches media
          outside the browser sandbox. Open this project in the desktop app to search them.
        </p>
      </div>
    );
  }

  const noKey = keyless || (search.kind === 'error' && search.code === 'no_key');
  const browseLabel = kind === 'video' ? 'Popular on Pexels' : 'Curated on Pexels';
  /** The feed's own chip: what an empty box shows. */
  const feedChip = kind === 'video' ? 'Popular' : 'Curated';
  const kindNoun = kind === 'video' ? 'videos' : 'photos';
  const shapeWord = orientation === 'any' ? '' : orientation;
  /** The panel-level note answers "why is everything disabled?" — only when nothing can be added. */
  const allBlocked = items.length > 0 && items.every((item) => blockedReasonFor(item) !== null);

  return (
    <div className="stock-panel">
      {/* One row holds everything that is not a result: what to search for, the
          shape to search in, and who the media comes from. The kind is the
          Elements sub-tab, so it needs no control here. Without a key there is
          nothing to search or filter, so the row is not shown at all: a disabled
          box above the explanation reads as broken. */}
      {noKey ? null : (
        <div className="stock-controls">
          <label className="stock-search" htmlFor="stock-search-input">
            <span className="sr-only">{kind === 'video' ? 'Search videos' : 'Search photos'}</span>
            <input
              id="stock-search-input"
              type="search"
              className="elements-search"
              data-ui="input"
              data-size="sm"
              placeholder={kind === 'video' ? 'Search videos' : 'Search photos'}
              value={query}
              onChange={(event) => typeQuery(event.target.value)}
            />
          </label>
          {/* Starts on the project's own shape, so a vertical short is offered
              vertical footage first. Plain toggle buttons, like the chips. */}
          <div className="stock-orientation" role="group" aria-label="Orientation">
            {ORIENTATION_CHOICES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="stock-orientation-option"
                aria-pressed={orientation === id}
                {...(id === 'any' ? {} : { 'aria-label': label })}
                title={id === 'any' ? `${label} shape` : `${label} ${kindNoun} only`}
                onClick={() => chooseOrientation(id)}
              >
                {id === 'any' ? label : <OrientationGlyph shape={id} />}
              </button>
            ))}
          </div>
          {/* Required by the Pexels API guidelines. It lives in this row for the
              same reason everything else does — it is not a result. */}
          <PexelsCredit />
        </div>
      )}

      {noKey ? null : (
        <div
          className="stock-chips"
          role="group"
          aria-label={kind === 'video' ? 'Video categories' : 'Photo categories'}
        >
          <button
            type="button"
            className="shapes-chip"
            aria-pressed={category === null && query.trim() === ''}
            title={browseLabel}
            onClick={() => chooseCategory(null)}
          >
            {feedChip}
          </button>
          {STOCK_CATEGORIES.map(({ id, label, query: words }) => (
            <button
              key={id}
              type="button"
              className="shapes-chip"
              aria-pressed={category === id}
              title={`Search Pexels for “${words}”. ${CATEGORY_COST_NOTE}`}
              onClick={() => chooseCategory(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Announced politely so a screen-reader user hears the count and the
          quota state without the grid stealing focus mid-type. */}
      <span className="sr-only" aria-live="polite">
        {search.kind === 'results' && !search.stale
          ? `${items.length} ${kind === 'video' ? 'clip' : 'photo'}${
              items.length === 1 ? '' : 's'
            } ${browsing ? 'shown' : 'found'}`
          : ''}
      </span>
      {/* What a tile's Enter said: a blocked Add's reason, a download already running. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-live="posted">
        {posted}
      </p>

      <QuotaStrip
        quota={quota ?? { kind: 'unmeasured' }}
        {...(onOpenSettings ? { onOpenSettings } : {})}
      />

      {noKey ? (
        <div className="stock-hint">
          <p className="stock-note">
            Photos and videos need a free Pexels API key. It takes about a minute to get one, and
            the only thing that leaves your machine is the words you type.
          </p>
          {/* The credit the guidelines ask for, in every state: here, with the note. */}
          <PexelsCredit />
          {onOpenSettings ? (
            // The one thing to do here, so the loud button; it opens Settings on the key field.
            <Button variant="primary" type="button" onClick={onOpenSettings}>
              Add Pexels key
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {/* Per-tile reasons live on the tiles; this speaks only when NOTHING
              here can be added as a cutaway. The sentence already names Overlay, the
              placement that still works over footage. Mounted empty, so the region
              exists before it has anything to say. */}
          <p className="stock-blocked live-slot" role="status">
            {search.kind === 'results' && allBlocked ? blockedReasonFor(items[0]!) : ''}
          </p>

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

          {/* The hourly limit is said once: by the quota strip when it knows, else here. */}
          {search.kind === 'error' &&
            search.message !== '' &&
            !(search.code === 'rate_limited' && quota?.kind === 'hourly_limited') && (
              <div className="stock-error-row">
                <p className="stock-error" role="alert">
                  {search.message}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => void runSearch(searchText, kind, 1, requestOrientation)}
                >
                  Try again
                </Button>
              </div>
            )}

          {search.kind === 'results' && items.length === 0 ? (
            // The feed's page is filtered here, and none of it is this shape.
            <p className="stock-note">
              Nothing here is {shapeWord}. Pick a category or search to get {shapeWord} {kindNoun}{' '}
              only.
            </p>
          ) : null}

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
                    : categoryEntry !== undefined
                      ? `${categoryEntry.label} — ${kind === 'video' ? 'video' : 'photos'}`
                      : kind === 'video'
                        ? 'Video results'
                        : 'Photo results'
                }
              >
                {items.map((item, index) => (
                  <StockTile
                    key={item.remoteId}
                    item={item}
                    index={index}
                    state={tileState(item)}
                    inProject={inProject(item)}
                    blockedReason={blockedReasonFor(item)}
                    targetHeight={projectHeight}
                    tabbable={tabbableId === item.remoteId}
                    onFocus={() => setFocusedId(item.remoteId)}
                    onKeyDown={onTileKeyDown}
                    onActivate={(placement) => activate(item, placement)}
                    overlayOffered={onAddStockOverlay !== undefined}
                    showInAssetsOffered={onShowInAssets !== undefined}
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
                  onClick={() =>
                    void runSearch(searchText, kind, search.page + 1, requestOrientation)
                  }
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

/** The credit the Pexels API guidelines require: a prominent link, in the spec's words. */
function PexelsCredit(): JSX.Element {
  return (
    <a
      className="stock-credit"
      href="https://www.pexels.com"
      target="_blank"
      rel="noreferrer noopener"
    >
      Photos and videos from Pexels
    </a>
  );
}

/** The orientation filter's picture of each shape: a box of that aspect. */
function OrientationGlyph({ shape }: { readonly shape: StockOrientationWire }): JSX.Element {
  const Glyph =
    shape === 'landscape' ? RectangleHorizontal : shape === 'portrait' ? RectangleVertical : Square;
  return <Glyph size={ICON_SIZE.sm} aria-hidden="true" />;
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

/**
 * What a category costs: each chip is one provider request. Said in the chip's tooltip, where the
 * choice is made — announcing it on every click was billing noise.
 */
export const CATEGORY_COST_NOTE = 'Each category is one search of your Pexels allowance.';

function QuotaStrip({
  quota,
  onOpenSettings,
}: {
  readonly quota: StockQuotaSnapshot;
  readonly onOpenSettings?: () => void;
}): JSX.Element | null {
  if (quota.kind === 'hourly_limited') {
    // Fixed: a countdown in a status line is a number that changes while it is read. Settings
    // shows how long is left.
    return (
      <p className="stock-quota-strip" data-tone="warning" role="status">
        You&apos;ve hit Pexels&apos; hourly limit. It clears within the hour; search again then.
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
  /** Add (a cutaway, or the reason it is blocked), or Add as overlay: the panel decides. */
  readonly onActivate: (placement: 'cutaway' | 'overlay') => void;
  /** The host offers **Add as overlay**. */
  readonly overlayOffered: boolean;
  /** The host can show an asset in Assets, so "In this project" is a button. */
  readonly showInAssetsOffered: boolean;
  readonly onCancel: (operationId: string) => void;
}

/** `City skyline at dusk, 0:12, 1920×1080 · 24 MB` — the tile's name: what it is and costs. */
function tileName(item: StockItemWire, variant: StockItemWire['variants'][number] | undefined) {
  return [
    item.title,
    ...(item.durationSeconds === undefined ? [] : [formatClipLength(item.durationSeconds)]),
    ...(variant === undefined ? [] : [variantLabel(variant)]),
  ].join(', ');
}

/** What the tile's button says it does, read after its name. */
function tileHint(
  state: TileState,
  inProject: boolean,
  blockedReason: string | null,
  overlayOffered: boolean,
  showInAssetsOffered: boolean,
): string {
  if (state.kind === 'downloading') return 'Downloading. Escape cancels.';
  if (inProject) {
    return showInAssetsOffered ? 'In this project. Enter shows it in Assets.' : 'In this project.';
  }
  const overlay = overlayOffered ? ' Shift+Enter adds it as an overlay.' : '';
  const failed = state.kind === 'failed' ? `${state.message} ` : '';
  if (blockedReason !== null) return `${failed}${blockedReason}${overlay}`;
  return `${failed}Enter adds it at the playhead.${overlay}`;
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
  onActivate,
  overlayOffered,
  showInAssetsOffered,
  onCancel,
}: StockTileProps): JSX.Element {
  const thumbnail = useObjectUrl(() => stockThumbnail(item.remoteId));
  const preview = useScrubPreview(item);
  const hintId = useId();
  const downloading = state.kind === 'downloading';
  const variant = tileVariant(item, targetHeight);
  const downloadBlocked = blockedReason !== null;
  // A tile in flight is already on its way somewhere, and one in the project is in Assets,
  // where it can be dragged from: neither starts a second download by drag.
  const draggable = !downloading && !inProject;
  /**
   * The placement whose download failed, so its own button offers it again. A failed drop is
   * retried by dragging again (the tile stays draggable), so neither button changes for it; a
   * failure recorded with no action is Add's, as it always was.
   */
  const failedAction: StockPlacementAction | null =
    state.kind !== 'failed'
      ? null
      : state.action === 'overlay' || state.action === 'drop'
        ? state.action
        : 'cutaway';

  return (
    <li
      className="stock-tile"
      data-remote-id={item.remoteId}
      {...(item.durationSeconds === undefined ? {} : { 'data-has-duration': 'true' })}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        // The provider id and the kind, nothing else: the drop asks main to download the item
        // it fetched itself, exactly as Add does (ADR 0139).
        event.dataTransfer.effectAllowed = 'copy';
        writeElementDrag(event.dataTransfer, {
          kind: 'stock',
          mediaKind: item.kind,
          remoteId: item.remoteId,
        });
      }}
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
      onPointerEnter={preview.onEnter}
      onPointerMove={preview.onMove}
      onPointerLeave={preview.onLeave}
    >
      {/* The tile's one Tab stop, over its picture: a real button, named by the clip, so a
          screen reader is told what it is and what Enter does there. */}
      <button
        type="button"
        className="stock-tile-main"
        tabIndex={tabbable ? 0 : -1}
        aria-label={tileName(item, variant)}
        aria-keyshortcuts={
          downloading ? 'Escape' : overlayOffered && !inProject ? 'Enter Shift+Enter' : 'Enter'
        }
        aria-describedby={hintId}
        onFocus={() => {
          onFocus();
          // The keyboard's hover: a focused video tile previews, as a pointed-at one does.
          preview.onEnter();
        }}
        onBlur={preview.onLeave}
        onKeyDown={(event) => onKeyDown(event, index, item)}
        onClick={(event) => onActivate(event.shiftKey ? 'overlay' : 'cutaway')}
      >
        {thumbnail ? (
          <img className="stock-thumb" src={thumbnail} alt="" draggable={false} />
        ) : (
          <span className="stock-thumb stock-thumb--pending" aria-hidden="true" />
        )}
      </button>
      <span id={hintId} hidden>
        {tileHint(state, inProject, blockedReason, overlayOffered, showInAssetsOffered)}
      </span>

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

      {/* The first thing an editor reads on a clip, so it is on the picture at rest. */}
      {item.durationSeconds !== undefined ? (
        <span className="stock-tile-dur tabular" aria-hidden="true">
          {formatClipLength(item.durationSeconds)}
        </span>
      ) : null}

      <div className="stock-tile-meta">
        <span className="stock-tile-title">{item.title}</span>
        {variant ? (
          <span className="stock-tile-facts">
            <span className="stock-tile-size">{variantLabel(variant)}</span>
          </span>
        ) : null}
        {item.creator ? (
          <span className="stock-tile-creator">
            {item.creatorUrl ? (
              <a href={item.creatorUrl} target="_blank" rel="noreferrer noopener" tabIndex={-1}>
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
              tabIndex={-1}
              aria-label={`Cancel downloading ${item.title}`}
              title="Cancel (Escape)"
              onClick={() => onCancel(state.operationId)}
            >
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </>
        ) : inProject ? (
          showInAssetsOffered ? (
            <button
              type="button"
              className="stock-present"
              tabIndex={-1}
              aria-label={`Show ${item.title} in Assets`}
              title="Show it in Assets"
              onClick={() => onActivate('cutaway')}
            >
              In this project
            </button>
          ) : (
            <span className="stock-present">In this project</span>
          )
        ) : (
          <>
            {/* Out of the Tab order, like everything in the tile but its own button: Enter
                is this button's key. Blocked, it still answers a click — with the reason. */}
            <Button
              variant="ghost"
              size="sm"
              type="button"
              tabIndex={-1}
              {...(downloadBlocked ? { 'aria-disabled': true } : {})}
              {...(failedAction === 'cutaway'
                ? { 'aria-label': 'Retry adding at the playhead' }
                : {})}
              title={blockedReason ?? 'Add at the playhead as a cutaway'}
              onClick={() => onActivate('cutaway')}
            >
              {failedAction === 'cutaway' ? 'Retry' : 'Add'}
            </Button>
            {overlayOffered ? (
              // Never disabled for covering picture: sitting over footage is the point (ADR 0193).
              // Shift+Enter on the tile is its key.
              <Button
                variant="ghost"
                size="sm"
                type="button"
                tabIndex={-1}
                className="stock-overlay-action"
                aria-label={
                  failedAction === 'overlay' ? 'Retry adding as an overlay' : 'Add as overlay'
                }
                title="Add as overlay: a smaller picture over what is at the playhead (Shift+Enter)"
                onClick={() => onActivate('overlay')}
              >
                {failedAction === 'overlay' ? 'Retry' : 'Overlay'}
              </Button>
            ) : null}
          </>
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
  const fetchingRef = useRef(false);
  /** The pointer or focus is on the tile, so a preview that lands should play. */
  const wantPlayRef = useRef(false);
  const enterXRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (blobRef.current !== null) URL.revokeObjectURL(blobRef.current);
    };
  }, []);

  /**
   * Autoplay is the motion the app initiates, so it is what `prefers-reduced-motion` switches
   * off. Scrubbing stays: the user is driving it, which is the distinction the setting is about.
   */
  const autoplay = useCallback((): void => {
    if (!wantPlayRef.current || prefersReducedMotion()) return;
    void videoRef.current?.play()?.catch(() => undefined);
  }, []);

  // The first hover's bytes land after the pointer arrived: the video mounts with them, and
  // plays then if the pointer (or focus) is still on the tile.
  useEffect(() => {
    if (url !== null) autoplay();
  }, [url, autoplay]);

  const onEnter = useCallback((): void => {
    if (!item.hasPreview) return;
    wantPlayRef.current = true;
    // Fetched once; a second hover (or focus) plays what is already here.
    if (blobRef.current !== null) {
      autoplay();
      return;
    }
    // A click both points at the tile and focuses it: one request, not two.
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    void stockPreview(item.remoteId).then((result) => {
      fetchingRef.current = false;
      if (!result.ok || blobRef.current !== null) return;
      const created = URL.createObjectURL(new Blob([result.data], { type: result.contentType }));
      blobRef.current = created;
      setUrl(created);
    });
  }, [autoplay, item.hasPreview, item.remoteId]);

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
    wantPlayRef.current = false;
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
