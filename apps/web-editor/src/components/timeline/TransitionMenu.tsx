/**
 * Right-click menu for an on-cut transition block (revamp Phase 8, F7).
 *
 * ## What belongs here and what does not
 *
 * Everything in this menu is a **timeline** thought — something you want while
 * looking at the cut, not while looking at a panel. "Make that one quicker",
 * "put this on every cut like it", "get rid of it". The *look* parameters
 * (direction, intensity, softness, easing and the render kind's own numbers) are
 * deliberately absent: a menu of sliders is the wrong surface, and the Inspector's
 * Transition section already renders exactly the ones this kind reads.
 *
 * Every action beyond the core three is OPTIONAL. A host that cannot do one — a
 * timeline with no clipboard yet, a review player with no library — simply does
 * not pass the callback, and the item is not drawn rather than drawn-and-dead.
 *
 * Mirrors `EffectLayerMenu`'s dismissal and clamping behaviour deliberately: two
 * context menus in the same view that dismiss differently is a bug the user
 * experiences as flakiness.
 *
 * ## Chrome
 *
 * `.context-menu` — the same surface the clip and track menus use. It used to ask
 * for `.clip-menu`, which no stylesheet defines, so this menu rendered as bare
 * buttons wrapping over the timeline with no panel behind them. One popover class,
 * shared, is also what keeps the three menus looking like one product.
 */
import { useEffect, useRef } from 'react';
import type { TransitionAlignment } from '@framepilot/editor-core';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { ArrowLeftRight, Copy, ICON_SIZE, Play, RotateCcw, Star, Trash2 } from '../icons.js';
import { TransitionThumbnail } from '../TransitionThumbnail.js';
import { usePrefersReducedMotion } from '../usePrefersReducedMotion.js';

/**
 * The preset durations offered, in the language of cuts rather than numbers.
 *
 * Four rather than three: "very fast" is a real editorial register (a flash frame
 * on a beat) and rounding it into "fast" made the fastest available transition
 * twice as long as the music wanted.
 */
export const TRANSITION_DURATION_PRESETS: readonly {
  seconds: number;
  /** The accessible name — the register AND the number, because a chip reading
   *  "0.25s" alone tells you nothing about which register you are picking. */
  label: string;
  /** What the chip prints. The row is four chips wide, so it prints the number. */
  short: string;
}[] = [
  { seconds: 0.15, label: 'Very fast (0.15s)', short: '0.15s' },
  { seconds: 0.25, label: 'Fast (0.25s)', short: '0.25s' },
  { seconds: 0.5, label: 'Standard (0.5s)', short: '0.5s' },
  { seconds: 1, label: 'Slow (1s)', short: '1s' },
];

/** The three placements, with the diagram each one is described by. */
export const ALIGNMENT_CHOICES: readonly {
  id: TransitionAlignment;
  label: string;
  /** A three-character picture of where the ramp sits around the cut. */
  glyph: string;
}[] = [
  { id: 'end', label: 'End at cut', glyph: '▓│ ' },
  { id: 'centre', label: 'Centre on cut', glyph: '░│░' },
  { id: 'start', label: 'Start at cut', glyph: ' │▓' },
];

export interface TransitionMenuProps {
  readonly x: number;
  readonly y: number;
  /**
   * The catalog id of the transition on this cut, for the header's name and live
   * preview. Optional: a kind the catalog does not know still gets the menu, just
   * without artwork — the actions are what the menu is for.
   */
  readonly kind?: string;
  /** The transition's current duration, so the active preset can be marked. */
  readonly durationSeconds: number;
  /**
   * The longest duration this cut can hold. Presets beyond it are **omitted, not
   * disabled** — the validator would reject them, and a menu entry that exists only
   * to refuse is noise at the moment the user is trying to act.
   */
  readonly maxDurationSeconds: number;
  /** Where the ramp currently sits, so the active choice can be marked. */
  readonly alignment?: TransitionAlignment;
  /** True when this kind is already starred, for the favourite toggle's wording. */
  readonly isFavourite?: boolean;
  /** How many cuts "apply to similar" would touch, so the label can say. */
  readonly similarCount?: number;
  /** How many edit points are selected, so "apply to selected" can say. */
  readonly selectedCount?: number;
  /** True when something is on the transition clipboard, so Paste can be offered. */
  readonly canPaste?: boolean;

  readonly onReplace: () => void;
  readonly onSetDuration: (seconds: number) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;

  readonly onPreview?: () => void;
  readonly onSetAlignment?: (alignment: TransitionAlignment) => void;
  readonly onCopy?: () => void;
  readonly onPaste?: () => void;
  readonly onReset?: () => void;
  readonly onToggleFavourite?: () => void;
  readonly onApplyToSimilar?: () => void;
  readonly onApplyToSelected?: () => void;
  readonly onApplyToAll?: () => void;
  readonly onSaveAsPreset?: () => void;
}

export function TransitionMenu({
  x,
  y,
  kind,
  durationSeconds,
  maxDurationSeconds,
  alignment = 'start',
  isFavourite = false,
  similarCount = 0,
  selectedCount = 0,
  canPaste = false,
  onReplace,
  onSetDuration,
  onRemove,
  onClose,
  onPreview,
  onSetAlignment,
  onCopy,
  onPaste,
  onReset,
  onToggleFavourite,
  onApplyToSimilar,
  onApplyToSelected,
  onApplyToAll,
  onSaveAsPreset,
}: TransitionMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const entry = kind === undefined ? undefined : getTransition(kind);

  useEffect(() => {
    ref.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // `capture` so a dismiss happens before the timeline's own pointer handlers
    // start a drag underneath the menu.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const presets = TRANSITION_DURATION_PRESETS.filter(
    (preset) => preset.seconds <= maxDurationSeconds,
  );
  /** Run an action and dismiss — every item here is a one-shot. */
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="context-menu transition-menu"
      role="menu"
      aria-label="transition actions"
      tabIndex={-1}
      style={{
        // Kept in step with the menu's own width/max-height in styles.css.
        left: `${Math.min(x, Math.max(8, globalThis.innerWidth - 252))}px`,
        top: `${Math.min(y, Math.max(8, globalThis.innerHeight - 428))}px`,
      }}
    >
      {/* What you right-clicked, shown rather than named — the same running tile
          the library and the on-cut popover use, so the menu is unambiguously
          about THIS transition and not the last one you touched. */}
      {entry !== undefined && (
        <div className="transition-menu-head">
          <span className="transition-menu-head-thumb">
            <TransitionThumbnail transition={entry} active reducedMotion={reducedMotion} />
          </span>
          <span className="transition-menu-head-text">
            <span className="transition-menu-head-name">{entry.label}</span>
            <span className="transition-menu-head-meta">{durationSeconds.toFixed(2)}s</span>
          </span>
        </div>
      )}

      {onPreview !== undefined && (
        <button type="button" role="menuitem" onClick={run(onPreview)}>
          <Play size={ICON_SIZE.sm} aria-hidden="true" />
          Preview transition
        </button>
      )}
      <button type="button" role="menuitem" onClick={onReplace}>
        <ArrowLeftRight size={ICON_SIZE.sm} aria-hidden="true" />
        Replace transition…
      </button>

      <div className="context-menu-sep" role="separator" />

      {/* Duration and placement are CHOICES OF ONE, so they are drawn as segmented
          rows rather than as seven near-identical menu lines. Four durations and
          three placements as full-width rows made the menu twice as tall as the
          actions it exists to offer, and buried "remove" below the fold. */}
      <p className="transition-menu-group">Duration</p>
      <div className="transition-menu-chips">
        {presets.map((preset) => {
          // Within a frame at 30fps — "is this already the preset?" should not hinge
          // on float noise from a previous drag.
          const active = Math.abs(preset.seconds - durationSeconds) < 0.02;
          return (
            <button
              key={preset.seconds}
              type="button"
              role="menuitemradio"
              className={`transition-menu-chip${active ? ' is-active' : ''}`}
              aria-checked={active}
              aria-label={preset.label}
              title={preset.label}
              onClick={() => onSetDuration(preset.seconds)}
            >
              {preset.short}
            </button>
          );
        })}
      </div>

      {onSetAlignment !== undefined && (
        <>
          <p className="transition-menu-group">Placement</p>
          <div className="transition-menu-chips">
            {ALIGNMENT_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                className={`transition-menu-chip${alignment === choice.id ? ' is-active' : ''}`}
                aria-checked={alignment === choice.id}
                aria-label={choice.label}
                title={choice.label}
                onClick={run(() => onSetAlignment(choice.id))}
              >
                {/* A picture, not a word: "centre on cut" is much clearer as a bar
                    straddling a line than as a sentence. The accessible name
                    carries the wording. */}
                <span className="transition-menu-glyph" aria-hidden="true">
                  {choice.glyph}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {(onCopy !== undefined || onPaste !== undefined || onReset !== undefined) && (
        <div className="context-menu-sep" role="separator" />
      )}
      {onCopy !== undefined && (
        <button type="button" role="menuitem" onClick={run(onCopy)}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Copy transition
        </button>
      )}
      {onPaste !== undefined && canPaste && (
        <button type="button" role="menuitem" onClick={run(onPaste)}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Paste settings
        </button>
      )}
      {onReset !== undefined && (
        <button type="button" role="menuitem" onClick={run(onReset)}>
          <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
          Reset to defaults
        </button>
      )}

      {(onApplyToSimilar !== undefined ||
        onApplyToSelected !== undefined ||
        onApplyToAll !== undefined ||
        onSaveAsPreset !== undefined ||
        onToggleFavourite !== undefined) && <div className="context-menu-sep" role="separator" />}
      {/* Counted, so "apply to 6 cuts" is a decision rather than a leap of faith —
          the brief's "show a summary before a large bulk action", at the moment
          the action is offered rather than in a dialog after the fact. */}
      {onApplyToSelected !== undefined && selectedCount > 0 && (
        <button type="button" role="menuitem" onClick={run(onApplyToSelected)}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Apply to {selectedCount} selected cut{selectedCount === 1 ? '' : 's'}
        </button>
      )}
      {onApplyToSimilar !== undefined && similarCount > 0 && (
        <button type="button" role="menuitem" onClick={run(onApplyToSimilar)}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Apply to {similarCount} similar cut{similarCount === 1 ? '' : 's'}
        </button>
      )}
      {onApplyToAll !== undefined && (
        <button type="button" role="menuitem" onClick={run(onApplyToAll)}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Apply to every cut
        </button>
      )}
      {onSaveAsPreset !== undefined && (
        <button type="button" role="menuitem" onClick={run(onSaveAsPreset)}>
          <Star size={ICON_SIZE.sm} aria-hidden="true" />
          Save as preset
        </button>
      )}
      {onToggleFavourite !== undefined && (
        <button type="button" role="menuitem" onClick={run(onToggleFavourite)}>
          <Star size={ICON_SIZE.sm} aria-hidden="true" />
          {isFavourite ? 'Remove from favourites' : 'Add to favourites'}
        </button>
      )}

      <div className="context-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="is-destructive" onClick={onRemove}>
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
        Remove transition
      </button>
    </div>
  );
}
