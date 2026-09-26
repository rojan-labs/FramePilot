/**
 * The Stickers sub-tab of Elements (plan/elements EL6a.5): the curated Fluent Emoji stickers by
 * collection and search; a click (or Enter) copies the sticker into the project (main does that,
 * by catalogue id) and places it at the playhead as one undoable edit. In replace mode — opened
 * from the Inspector's Sticker section — a click swaps the selected sticker instead.
 *
 * The catalogue is loaded on first open (it is ~0.5 MB); tiles are same-origin files the renderer
 * ships (`public/elements/stickers/thumbs`), so nothing is fetched from anywhere else.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadStickerCatalog,
  searchStickers,
  type StickerCatalog,
  type StickerItem,
} from '@framepilot/ai-sdk';
import type { ElementAssetWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { elementsMaterialize } from '../../editor/bridge.js';
import { stickerErrorSentence } from '../../editor/sticker-builders.js';
import { useViewPreference } from '../../editor/useViewPreference.js';
import { useTileGrid } from './useTileGrid.js';

/** Where the renderer ships the bundled sticker files, relative to its page. */
export const STICKERS_BASE = 'elements/stickers/';

/** The sticker being replaced, when the Inspector opened this tab to swap one. */
export interface StickerReplaceTarget {
  readonly clipId: string;
  readonly name: string;
}

export interface StickersBrowserProps {
  readonly project: Pick<Project, 'id'>;
  /** Place a materialised sticker at the playhead; returns the refusal sentence, or `null`. */
  readonly onAddSticker: (asset: ElementAssetWire, item: StickerItem) => string | null;
  readonly replaceTarget?: StickerReplaceTarget | null;
  /** Swap the replace target's sticker for this one; returns the refusal sentence, or `null`. */
  readonly onReplaceSticker?: (asset: ElementAssetWire, item: StickerItem) => string | null;
  readonly onCancelReplace?: () => void;
  /** Tests pass a catalogue; the app loads the generated one. */
  readonly loadCatalog?: () => Promise<StickerCatalog>;
}

const ALL = 'all';

export function StickersBrowser({
  project,
  onAddSticker,
  replaceTarget = null,
  onReplaceSticker,
  onCancelReplace,
  loadCatalog = loadStickerCatalog,
}: StickersBrowserProps): JSX.Element {
  const [catalog, setCatalog] = useState<StickerCatalog | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [chip, setChip] = useViewPreference<string>('stickersChip', ALL, (raw) =>
    typeof raw === 'string' ? raw : undefined,
  );
  const searchRef = useRef<HTMLInputElement>(null);

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
    return () => {
      live = false;
    };
  }, [loadCatalog]);

  const collection =
    catalog !== null && catalog.collections.some((c) => c.id === chip) ? chip : ALL;
  const found = useMemo(
    () =>
      catalog === null
        ? { items: [], total: 0 }
        : searchStickers(catalog, query, collection === ALL ? {} : { collection }),
    [catalog, query, collection],
  );
  const { gridRef, focusIndex, setActive, onGridKey } = useTileGrid(
    found.items.length,
    '.stickers-grid-tile',
  );

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
      setRefusal(place(result.asset, item));
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
      <div className="shapes-chips" role="group" aria-label="Sticker collections">
        {[{ id: ALL, name: 'All' }, ...catalog.collections].map(({ id, name }) => (
          <button
            key={id}
            type="button"
            className="shapes-chip"
            aria-pressed={collection === id}
            onClick={() => {
              setChip(id);
              setActive(0);
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
          Nothing matched “{query.trim()}”. Try a simpler word — “fire”, “party”, “check”.
        </p>
      ) : (
        <ul ref={gridRef} className="stickers-grid" aria-label="Stickers" onKeyDown={onGridKey}>
          {found.items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                className="stickers-grid-tile"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-label={`${replaceTarget !== null ? 'Use' : 'Add'} ${item.name}`}
                aria-busy={busy === item.id}
                title={
                  replaceTarget !== null
                    ? `Use ${item.name} instead`
                    : `Add ${item.name} at the playhead`
                }
                disabled={busy !== null && busy !== item.id}
                onFocus={() => setActive(index)}
                onClick={() => void pick(item)}
              >
                <img src={`${STICKERS_BASE}${item.thumb ?? ''}`} alt="" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {refusal !== null && (
        <p className="stock-note" role="status">
          {refusal}
        </p>
      )}
      <p className="stickers-credit">Stickers: Fluent Emoji by Microsoft (MIT)</p>
    </div>
  );
}
