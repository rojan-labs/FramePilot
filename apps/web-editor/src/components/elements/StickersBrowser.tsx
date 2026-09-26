/**
 * The Stickers sub-tab of Elements (plan/elements EL6a.5, EL6b.2): Fluent Emoji stickers by
 * collection, group and search; a click (or Enter) copies the sticker into the project (main does
 * that, by catalogue id) and places it at the playhead as one undoable edit, and a drag places it
 * on a lane. In replace mode — opened from the Inspector's Sticker section — a click swaps the
 * selected sticker instead.
 *
 * Every build lists the curated stickers, whose tiles are same-origin files the renderer ships
 * (`public/elements/stickers/thumbs`). A desktop build with the packaged set lists the whole
 * library; those tiles come from main (`packaged-tiles.ts`), only for the rows on screen. The grid
 * draws only the rows in view, so 1,595 stickers cost what one screenful does.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  STICKER_ID_PATTERN,
  loadStickerCatalog,
  searchStickers,
  type StickerCatalog,
  type StickerItem,
} from '@framepilot/ai-sdk';
import { elementAssetId } from '@framepilot/editor-core';
import type { ElementAssetWire } from '@framepilot/shared-types';
import { elementsMaterialize } from '../../editor/bridge.js';
import { stickerErrorSentence } from '../../editor/sticker-builders.js';
import { useViewPreference } from '../../editor/useViewPreference.js';
import { ICON_SIZE, Star } from '../icons.js';
import { ELEMENT_DND_TYPE, encodeElementDrag } from './element-dnd.js';
import { packagedTiles as appPackagedTiles, type PackagedTileSource } from './packaged-tiles.js';
import { useTileGrid } from './useTileGrid.js';

/** Where the renderer ships the bundled sticker files, relative to its page. */
export const STICKERS_BASE = 'elements/stickers/';

/** The sticker being replaced, when the Inspector opened this tab to swap one. */
export interface StickerReplaceTarget {
  readonly clipId: string;
  readonly name: string;
}

export interface StickersBrowserProps {
  /** The open project: its id for the copy, its assets to mark stickers it already holds. */
  readonly project: { readonly id: string; readonly assets: readonly { readonly id: string }[] };
  /** Place a materialised sticker at the playhead; returns the refusal sentence, or `null`. */
  readonly onAddSticker: (asset: ElementAssetWire, item: StickerItem) => string | null;
  readonly replaceTarget?: StickerReplaceTarget | null;
  /** Swap the replace target's sticker for this one; returns the refusal sentence, or `null`. */
  readonly onReplaceSticker?: (asset: ElementAssetWire, item: StickerItem) => string | null;
  readonly onCancelReplace?: () => void;
  /** Tests pass a catalogue; the app loads the generated one. */
  readonly loadCatalog?: () => Promise<StickerCatalog>;
  /** Tests pass their own; the app asks main. */
  readonly packagedTiles?: PackagedTileSource;
}

const ALL = 'all';
const RECENT = 'recent';
const FAVOURITES = 'favourites';
const GROUP_PREFIX = 'group:';
/** How many recently added stickers the Recent chip keeps. */
const RECENT_LIMIT = 24;
/** How many favourites are kept; far more than a person stars, small enough to store. */
const FAVOURITES_LIMIT = 500;
/** 02 §2.2: `columns = floor(width / 80)`; the tile fills its column less the gap. */
const COLUMN_PX = 80;
const GAP_PX = 4;
/** Before layout (and in a test DOM, which has none): four 72 px columns in a 480 px view. */
const FALLBACK_COLUMNS = 4;
const FALLBACK_TILE_PX = 72;
const FALLBACK_VIEWPORT_PX = 480;
/** Rows drawn beyond the view each way, so a quick scroll does not show empty rows. */
const OVERSCAN_ROWS = 3;

/** A stored list of sticker ids: a view preference, so anything malformed reads as empty. */
const idList =
  (limit: number) =>
  (raw: unknown): readonly string[] | undefined =>
    Array.isArray(raw)
      ? raw
          .filter((id): id is string => typeof id === 'string' && STICKER_ID_PATTERN.test(id))
          .slice(0, limit)
      : undefined;
const RECENT_IDS = idList(RECENT_LIMIT);
const FAVOURITE_IDS = idList(FAVOURITES_LIMIT);
const EMPTY: readonly string[] = [];

/** `id` first, without a duplicate, at most `limit` long. */
const pushFront = (ids: readonly string[], id: string, limit: number): readonly string[] =>
  [id, ...ids.filter((other) => other !== id)].slice(0, limit);

/** A jsdom-safe rect: a real browser measures; a DOM without layout gets a fixed view. */
const observeRectWithFallback: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) =>
    cb({ width: rect.width, height: rect.height || FALLBACK_VIEWPORT_PX }),
  );

/**
 * The scroll area's content width, 0 until measured (and where nothing is laid out). It takes the
 * element rather than a ref: the scroll area mounts only once the catalogue has loaded.
 */
function useContentWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** The chip strip: All, Recent and Favourites when they hold any, collections, then groups. */
function chipsFor(
  catalog: StickerCatalog,
  groups: readonly string[],
  recent: readonly string[],
  favourites: readonly string[],
): readonly { readonly id: string; readonly name: string }[] {
  const collectionNames = new Set(catalog.collections.map((collection) => collection.name));
  return [
    { id: ALL, name: 'All' },
    ...(recent.length > 0 ? [{ id: RECENT, name: 'Recent' }] : []),
    ...(favourites.length > 0 ? [{ id: FAVOURITES, name: 'Favourites' }] : []),
    ...catalog.collections,
    // An upstream group named like a curated collection ("Objects") is the whole group, not the
    // curated pick, so it says so.
    ...groups.map((group) => ({
      id: `${GROUP_PREFIX}${group}`,
      name: collectionNames.has(group) ? `${group} (all)` : group,
    })),
  ];
}

export function StickersBrowser({
  project,
  onAddSticker,
  replaceTarget = null,
  onReplaceSticker,
  onCancelReplace,
  loadCatalog = loadStickerCatalog,
  packagedTiles = appPackagedTiles(),
}: StickersBrowserProps): JSX.Element {
  const [catalog, setCatalog] = useState<StickerCatalog | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [packaged, setPackaged] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [, setTilesLoaded] = useState(0);
  const [chip, setChip] = useViewPreference<string>('stickersChip', ALL, (raw) =>
    typeof raw === 'string' ? raw : undefined,
  );
  const [recent, setRecent] = useViewPreference<readonly string[]>(
    'stickersRecent',
    EMPTY,
    RECENT_IDS,
  );
  const [favourites, setFavourites] = useViewPreference<readonly string[]>(
    'stickersFavourites',
    EMPTY,
    FAVOURITE_IDS,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollArea, setScrollArea] = useState<HTMLDivElement | null>(null);
  const inProjectNoteId = useId();

  useEffect(() => {
    let live = true;
    loadCatalog().then(
      (loaded) => {
        if (live) setCatalog(loaded);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    void packagedTiles.present().then((present) => {
      if (live) setPackaged(present);
    });
    return () => {
      live = false;
    };
  }, [loadCatalog, packagedTiles]);

  const listed = useMemo(
    () =>
      catalog === null
        ? []
        : catalog.items.filter((item) => packaged || item.availability === 'bundled'),
    [catalog, packaged],
  );
  const groups = useMemo(() => [...new Set(listed.map((item) => item.group))], [listed]);
  const chips = useMemo(
    () => (catalog === null ? [] : chipsFor(catalog, groups, recent, favourites)),
    [catalog, groups, recent, favourites],
  );
  const scope = chips.some((candidate) => candidate.id === chip) ? chip : ALL;

  const found = useMemo((): { items: readonly StickerItem[]; total: number } => {
    if (catalog === null) return { items: [], total: 0 };
    const includePackaged = packaged;
    if (scope === RECENT || scope === FAVOURITES) {
      const ids = scope === RECENT ? recent : favourites;
      const matched =
        query.trim() === ''
          ? null
          : new Set(searchStickers(catalog, query, { includePackaged }).items.map((i) => i.id));
      const items = ids
        .map((id) => catalog.byId.get(id))
        .filter(
          (item): item is StickerItem =>
            item !== undefined &&
            (includePackaged || item.availability === 'bundled') &&
            (matched === null || matched.has(item.id)),
        );
      return { items, total: items.length };
    }
    return searchStickers(catalog, query, {
      includePackaged,
      ...(scope === ALL
        ? {}
        : scope.startsWith(GROUP_PREFIX)
          ? { group: scope.slice(GROUP_PREFIX.length) }
          : { collection: scope }),
    });
  }, [catalog, packaged, query, scope, recent, favourites]);

  const inProject = useMemo(
    () => new Set(project.assets.map((asset) => asset.id)),
    [project.assets],
  );
  const favouriteSet = useMemo(() => new Set(favourites), [favourites]);

  const width = useContentWidth(scrollArea);
  const columns = width > 0 ? Math.max(1, Math.floor(width / COLUMN_PX)) : FALLBACK_COLUMNS;
  const tile = width > 0 ? (width - GAP_PX * (columns - 1)) / columns : FALLBACK_TILE_PX;
  const rowHeight = tile + GAP_PX;
  const rowCount = Math.ceil(found.items.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollArea,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
    initialRect: { width: 0, height: FALLBACK_VIEWPORT_PX },
    observeElementRect: observeRectWithFallback,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);

  const { gridRef, focusIndex, setActive, onGridKey } = useTileGrid(
    found.items.length,
    '.stickers-grid-tile',
    {
      columns,
      reveal: (index) => virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'auto' }),
    },
  );

  const rows = virtualizer.getVirtualItems();
  const drawn = rows.flatMap((row) =>
    found.items
      .slice(row.index * columns, row.index * columns + columns)
      .map((item, column) => ({ item, index: row.index * columns + column, column, row })),
  );

  // Ask main for the packaged tiles on screen that are not loaded yet; redraw when they arrive.
  const missingTiles = drawn
    .filter(({ item }) => item.availability === 'packaged' && !packagedTiles.url(item.id))
    .map(({ item }) => item.id);
  const missingKey = missingTiles.join(' ');
  useEffect(() => {
    if (missingKey === '') return;
    let live = true;
    void packagedTiles.load(missingKey.split(' ')).then(() => {
      if (live) setTilesLoaded((count) => count + 1);
    });
    return () => {
      live = false;
    };
  }, [missingKey, packagedTiles]);

  const toggleFavourite = (item: StickerItem): void => {
    setFavourites((current) =>
      current.includes(item.id)
        ? current.filter((id) => id !== item.id)
        : pushFront(current, item.id, FAVOURITES_LIMIT),
    );
  };

  const pick = async (item: StickerItem): Promise<void> => {
    if (busy !== null) return;
    setBusy(item.id);
    setRefusal(null);
    try {
      const result = await elementsMaterialize({ projectId: project.id, elementId: item.id });
      if (!result.ok) {
        setRefusal(stickerErrorSentence(result.error, result.detail));
        return;
      }
      const place =
        replaceTarget !== null && onReplaceSticker !== undefined ? onReplaceSticker : onAddSticker;
      const refused = place(result.asset, item);
      setRefusal(refused);
      if (refused === null) setRecent((current) => pushFront(current, item.id, RECENT_LIMIT));
    } finally {
      setBusy(null);
    }
  };

  if (loadFailed) {
    return (
      <p className="stock-note" role="status">
        The sticker library could not be loaded. Restart FramePilot and try again.
      </p>
    );
  }
  if (catalog === null) {
    return <p className="stock-note">Loading stickers…</p>;
  }

  const tileSource = (item: StickerItem): string | undefined =>
    item.availability === 'bundled'
      ? `${STICKERS_BASE}${item.thumb ?? ''}`
      : packagedTiles.url(item.id);

  return (
    <div
      className="stickers-browser"
      onKeyDown={(event) => {
        if (event.key === '/' && event.target !== searchRef.current) {
          event.preventDefault();
          searchRef.current?.focus();
        }
      }}
    >
      {replaceTarget !== null && (
        <div className="stickers-replace" role="note">
          <span>Pick a sticker to replace “{replaceTarget.name}”.</span>
          {onCancelReplace !== undefined && (
            <button type="button" className="stickers-replace-cancel" onClick={onCancelReplace}>
              Cancel
            </button>
          )}
        </div>
      )}
      <input
        ref={searchRef}
        type="search"
        className="shapes-search"
        aria-label="Search stickers"
        placeholder="Search stickers — try 🔥 or “party”"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            setQuery('');
          }
        }}
      />
      <div className="stickers-chips" role="group" aria-label="Sticker collections">
        {chips.map(({ id, name }) => (
          <button
            key={id}
            type="button"
            className="shapes-chip"
            aria-pressed={scope === id}
            onClick={() => {
              setChip(id);
              setActive(0);
              if (scrollArea !== null) scrollArea.scrollTop = 0;
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {`${String(found.total)} stickers`}
      </p>
      {found.items.length === 0 ? (
        <p className="stock-note">
          {query.trim() === ''
            ? 'No stickers here yet.'
            : `Nothing matched “${query.trim()}”. Try a simpler word — “fire”, “party”, “check”.`}
        </p>
      ) : (
        <div ref={setScrollArea} className="stickers-scroll">
          <ul
            ref={gridRef}
            className="stickers-grid"
            aria-label="Stickers"
            style={{ height: virtualizer.getTotalSize() }}
            onKeyDown={(event) => {
              const focused = found.items[focusIndex];
              if (
                (event.key === 'f' || event.key === 'F') &&
                focused !== undefined &&
                (event.target as HTMLElement).classList.contains('stickers-grid-tile')
              ) {
                event.preventDefault();
                toggleFavourite(focused);
                return;
              }
              onGridKey(event);
            }}
          >
            {drawn.map(({ item, index, column, row }) => {
              const favourite = favouriteSet.has(item.id);
              const held = inProject.has(elementAssetId(catalog.library, item.id));
              const source = tileSource(item);
              return (
                <li
                  key={item.id}
                  className="stickers-grid-cell"
                  aria-setsize={found.total}
                  aria-posinset={index + 1}
                  style={{
                    width: tile,
                    height: tile,
                    transform: `translate(${String(column * (tile + GAP_PX))}px, ${String(row.start)}px)`,
                  }}
                >
                  <button
                    type="button"
                    className="stickers-grid-tile"
                    data-tile-index={index}
                    tabIndex={index === focusIndex ? 0 : -1}
                    aria-label={`${replaceTarget !== null ? 'Use' : 'Add'} ${item.name}`}
                    aria-describedby={held ? inProjectNoteId : undefined}
                    aria-busy={busy === item.id}
                    title={
                      replaceTarget !== null
                        ? `Use ${item.name} instead`
                        : `Add ${item.name} at the playhead, or drag it onto a lane`
                    }
                    disabled={busy !== null && busy !== item.id}
                    draggable={replaceTarget === null}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData(
                        ELEMENT_DND_TYPE,
                        encodeElementDrag({ kind: 'sticker', elementId: item.id }),
                      );
                    }}
                    onFocus={() => setActive(index)}
                    onClick={() => void pick(item)}
                  >
                    {source === undefined ? (
                      <span className="stickers-grid-glyph" aria-hidden="true">
                        {item.glyph}
                      </span>
                    ) : (
                      <img src={source} alt="" loading="lazy" draggable={false} />
                    )}
                    {held && <span className="stickers-grid-held" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="stickers-grid-star"
                    tabIndex={-1}
                    aria-label={`Favourite ${item.name}`}
                    aria-pressed={favourite}
                    title={favourite ? 'Remove from favourites (F)' : 'Add to favourites (F)'}
                    onClick={() => toggleFavourite(item)}
                  >
                    <Star
                      size={ICON_SIZE.sm}
                      aria-hidden="true"
                      fill={favourite ? 'currentColor' : 'none'}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p id={inProjectNoteId} hidden>
        Already in this project
      </p>
      {refusal !== null && (
        <p className="stock-note" role="status">
          {refusal}
        </p>
      )}
      <p className="stickers-credit">Stickers: Fluent Emoji by Microsoft (MIT)</p>
    </div>
  );
}
