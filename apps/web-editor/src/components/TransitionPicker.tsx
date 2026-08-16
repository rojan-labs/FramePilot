/**
 * The on-cut transition popover — what opens when you click between two clips.
 *
 * ## Why this is not just a menu of names
 *
 * It used to be: seven words in a list. That is fine for seven and useless for
 * seventy-seven, and it also asked the user to know what "Luma Fade" looks like
 * before choosing it. This is a compact version of the transitions panel instead —
 * the same search, the same shelves, the same animated tiles running the same
 * shader — so the choice is made by looking rather than by remembering.
 *
 * It stays a POPOVER rather than sending people to the panel because the whole
 * point of clicking a cut is that you are already looking at the cut. "Open the
 * full library" is offered for when the compact grid is not enough.
 *
 * Closes on selection, outside pointer press, or Escape (mirrors ClipContextMenu).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@framepilot/ui';
import type { CatalogTransition } from '@framepilot/timeline-schema/transition-catalog';
import { TransitionThumbnail } from './TransitionThumbnail.js';
import { useTransitionLibrary, type TransitionFilter } from './useTransitionLibrary.js';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';
import { ICON_SIZE, Search, Star } from './icons.js';

/** Where the picker opened, and on which cut (the outgoing/earlier clip id). */
export interface TransitionPickerTarget {
  readonly fromClipId: string;
  readonly x: number;
  readonly y: number;
}

/** The shelves offered in the compact grid, in order. */
const QUICK_SHELVES: readonly { id: TransitionFilter; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'recents', label: 'Recent' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'all', label: 'All' },
];

export interface TransitionPickerProps {
  readonly target: TransitionPickerTarget;
  /** Add the chosen transition at the target cut. */
  readonly onPick: (fromClipId: string, kind: string, durationSeconds: number) => void;
  /**
   * Add the chosen transition to **every** cut that can take one.
   * Absent = the route is not offered on this surface.
   */
  readonly onPickAll?: (kind: string, durationSeconds: number) => void;
  /** Switch to the full transitions panel. Absent = no such rail here. */
  readonly onOpenLibrary?: () => void;
  readonly onClose: () => void;
}

export function TransitionPicker({
  target,
  onPick,
  onPickAll,
  onOpenLibrary,
  onClose,
}: TransitionPickerProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const library = useTransitionLibrary();
  const reducedMotion = usePrefersReducedMotion();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  /**
   * Capped at 24: a popover anchored to a cut cannot become the whole library
   * without covering the thing it is about. "Open the full transitions library"
   * is the escape hatch, and it is the last thing in the popover for that reason.
   */
  const results = useMemo<readonly CatalogTransition[]>(
    () => (library.results.length > 0 ? library.results.slice(0, 24) : []),
    [library.results],
  );

  const pick = (entry: CatalogTransition): void => {
    const seconds = library.durationFor(entry);
    onPick(target.fromClipId, entry.id, seconds);
    library.noteUsed(entry.id);
    library.noteDuration(seconds);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="context-menu transition-picker"
      role="dialog"
      aria-label="Choose a transition"
      style={{
        // Clamped so a cut near the right or bottom edge does not open a popover
        // half off-screen — and offset down-right of the click so the popover
        // never covers the cut it is about to change.
        // Kept in step with the popover's own width/max-height in styles.css.
        left: `${Math.min(target.x, Math.max(8, globalThis.innerWidth - 348))}px`,
        top: `${Math.min(target.y, Math.max(8, globalThis.innerHeight - 432))}px`,
      }}
    >
      <div className="transition-picker-search">
        <Input
          uiSize="sm"
          type="search"
          autoFocus
          aria-label="search transitions"
          placeholder="Search transitions…"
          icon={<Search size={ICON_SIZE.sm} />}
          value={library.query}
          onChange={(event) => library.setQuery(event.target.value)}
        />
      </div>

      <div className="transition-picker-shelves" role="group" aria-label="transition shelves">
        {QUICK_SHELVES.map((shelf) => (
          <button
            key={shelf.id}
            type="button"
            className={`fx-filter${library.filter === shelf.id ? ' is-active' : ''}`}
            aria-pressed={library.filter === shelf.id}
            onClick={() => library.setFilter(shelf.id)}
          >
            {shelf.label}
          </button>
        ))}
      </div>

      {results.length === 0 ? (
        <p className="panel-empty transition-picker-empty">
          Nothing matches. Try a direction (“left”), a feel (“fast”) or the full library.
        </p>
      ) : (
        <div className="transition-picker-grid" role="list">
          {results.map((entry) => (
            <div className="fx-card tr-card" role="listitem" key={entry.id}>
              <button
                type="button"
                className="fx-card-apply tr-card-apply"
                aria-label={`${entry.label}. ${entry.description}`}
                title={entry.description}
                onMouseEnter={() => setActiveId(entry.id)}
                onMouseLeave={() => setActiveId((c) => (c === entry.id ? null : c))}
                onFocus={() => setActiveId(entry.id)}
                onBlur={() => setActiveId((c) => (c === entry.id ? null : c))}
                onClick={() => pick(entry)}
              >
                <TransitionThumbnail
                  transition={entry}
                  active={activeId === entry.id}
                  reducedMotion={reducedMotion}
                />
                <span className="fx-card-label">{entry.label}</span>
              </button>
              <button
                type="button"
                className={`fx-card-fav${library.isFavourite(entry.id) ? ' is-on' : ''}`}
                aria-label={
                  library.isFavourite(entry.id)
                    ? `Remove ${entry.label} from favourites`
                    : `Add ${entry.label} to favourites`
                }
                aria-pressed={library.isFavourite(entry.id)}
                onClick={() => library.toggleFavourite(entry.id)}
              >
                <Star size={ICON_SIZE.sm} />
              </button>
              {onPickAll !== undefined && !entry.isCut && (
                <button
                  type="button"
                  className="transition-picker-all"
                  aria-label={`Add ${entry.label} to every eligible cut`}
                  title={`Add ${entry.label} to every eligible cut`}
                  onClick={() => {
                    onPickAll(entry.id, library.durationFor(entry));
                    library.noteUsed(entry.id);
                    onClose();
                  }}
                >
                  All
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {onOpenLibrary !== undefined && (
        <button
          type="button"
          className="transition-picker-more"
          onClick={() => {
            onOpenLibrary();
            onClose();
          }}
        >
          Open the full transitions library
        </button>
      )}
    </div>
  );
}
