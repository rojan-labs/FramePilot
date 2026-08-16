/**
 * A transition as an object on the cut (revamp Phase 8, F7 — was `TransitionPill`).
 *
 * ## What changed from the pill
 *
 * The pill was already the right *idea* — straddle the cut, drag an edge to resize,
 * one patch on release. What it could not do:
 *
 *  - **Say what it is.** It rendered an arrow glyph and nothing else, so a timeline
 *    of six transitions was six identical arrows. Which one is the dissolve?
 *  - **Survive zoom.** Width was `max(8px, duration × zoom)` with no awareness of the
 *    next transition, so at low zoom two adjacent blocks overlapped and a click hit
 *    whichever happened to be later in the DOM.
 *  - **Report the duration while you set it.** The accessible name updated, but there
 *    was nothing on screen — you dragged blind and read the result afterwards.
 *
 * Geometry now comes from `transition-blocks.ts`, which resolves the whole track at
 * once; this file is the affordance.
 *
 * The live drag width stays ephemeral local state (invariant 5) — only the committed
 * patch on pointer-up touches the timeline.
 */
import { useRef, useState } from 'react';
import type { TransitionBlockBox } from './transition-blocks.js';
import { describeTransition, transitionKindLabel } from './transition-blocks.js';
import { ArrowLeftRight, ICON_SIZE } from '../icons.js';

export interface TransitionBlockProps {
  readonly box: TransitionBlockBox;
  readonly pxPerSecond: number;
  readonly selected: boolean;
  /** Select the transition (by its incoming clip id). */
  /**
   * Select this transition. `additive` is true when the user held shift or the
   * platform's multi-select modifier — the caller decides what that means for its
   * own selection model; the block only reports the intent.
   */
  readonly onSelect: (toClipId: string, additive: boolean, preserveSelection?: boolean) => void;
  /**
   * True when this cut is one of several the user has gathered for a bulk action.
   * Drawn distinctly from `selected` because they mean different things: one cut
   * is being LOOKED at, several are being AIMED at.
   */
  readonly multiSelected?: boolean;
  /** Commit a new duration (seconds) on pointer-up. */
  readonly onResize: (toClipId: string, durationSeconds: number) => void;
  /** Open the block's actions (replace / remove) at a viewport point. */
  readonly onContextMenu?: (toClipId: string, x: number, y: number) => void;
}

/** Smallest legal transition (seconds) — keeps the block grabbable and > 0. */
const MIN_TRANSITION_SECONDS = 0.05;
/** Drag distance (px) before a press becomes a resize rather than a click. */
const RESIZE_THRESHOLD_PX = 3;

export function TransitionBlock({
  box,
  pxPerSecond,
  selected,
  onSelect,
  multiSelected = false,
  onResize,
  onContextMenu,
}: TransitionBlockProps): JSX.Element {
  const { placement, leftPx, widthPx, density, crowded } = box;
  const { toClipId, kind, durationSeconds, maxDurationSeconds } = placement;
  const [dragDuration, setDragDuration] = useState<number | null>(null);
  const dragRef = useRef<{ downX: number; edge: 1 | -1; moved: boolean } | null>(null);

  const shown = dragDuration ?? durationSeconds;
  const resizing = dragDuration !== null;

  // While resizing, the block follows the pointer directly rather than through the
  // track layout: the layout resolves collisions against COMMITTED durations, and
  // re-running it per pointer move would make the block being dragged fight its
  // neighbours mid-gesture. It re-joins the layout on release.
  const centrePx = placement.cutTime * pxPerSecond;
  const drawnWidth = resizing ? Math.max(2, shown * pxPerSecond) : widthPx;
  const drawnLeft = resizing ? centrePx - drawnWidth / 2 : leftPx;
  // A crowded block drops its label rather than clipping the text mid-word.
  const shownDensity = crowded && density === 'label' ? 'icon' : density;

  const clampDuration = (d: number): number =>
    Math.max(MIN_TRANSITION_SECONDS, Math.min(maxDurationSeconds, d));

  const beginResize = (event: React.PointerEvent, edge: 1 | -1): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { downX: event.clientX, edge, moved: false };
  };

  const onResizeMove = (event: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(event.clientX - d.downX) <= RESIZE_THRESHOLD_PX) return;
    d.moved = true;
    // The block is symmetric about the cut, so moving an edge by Δpx changes the
    // half-width by Δ and the duration by 2·Δ (in the edge's outward direction).
    const deltaPx = (event.clientX - d.downX) * d.edge;
    setDragDuration(clampDuration(durationSeconds + (2 * deltaPx) / pxPerSecond));
  };

  const endResize = (event: React.PointerEvent): void => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may already be lost; the gesture still finalises. */
    }
    const next = dragDuration;
    setDragDuration(null);
    if (!d || !d.moved || next === null) return;
    if (Math.abs(next - durationSeconds) > 1e-4) onResize(toClipId, next);
  };

  return (
    <span
      className="clip-transition-pill"
      role="button"
      tabIndex={0}
      data-density={shownDensity}
      data-resizing={resizing ? 'true' : undefined}
      // The accessible name carries the duration at every density, including
      // `marker` — a block too narrow to print its label is exactly the one a
      // screen-reader user has no other way to identify.
      aria-label={`${transitionKindLabel(kind)} transition, ${shown.toFixed(2)}s${
        placement.disabled ? ', held off' : ''
      }`}
      aria-pressed={selected}
      data-selected={selected || undefined}
      data-multi={multiSelected || undefined}
      data-disabled={placement.disabled || undefined}
      title={describeTransition(placement)}
      style={{ left: `${drawnLeft}px`, width: `${drawnWidth}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(toClipId, event.shiftKey || event.metaKey || event.ctrlKey);
      }}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        // `preserveSelection`: right-clicking one of several gathered cuts must
        // not throw the others away — the menu is about to offer an action that
        // operates on all of them.
        onSelect(toClipId, false, true);
        onContextMenu(toClipId, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(toClipId, event.shiftKey);
      }}
    >
      <span
        className="clip-transition-pill-edge clip-transition-pill-edge-l"
        aria-hidden="true"
        onPointerDown={(event) => beginResize(event, -1)}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
      />
      {shownDensity !== 'marker' && <ArrowLeftRight size={ICON_SIZE.sm} aria-hidden="true" />}
      {shownDensity === 'label' && (
        <span className="clip-transition-label" aria-hidden="true">
          {describeTransition(placement)}
        </span>
      )}
      {/*
        Live duration while dragging — the pill's real gap. Floated above the block
        rather than inside it, because at 0.2s the block is narrower than the text.
        aria-hidden: the same number is already in the block's accessible name, which
        updates on every move.
      */}
      {resizing && (
        <span className="clip-transition-readout tabular" aria-hidden="true">
          {shown.toFixed(2)}s
        </span>
      )}
      <span
        className="clip-transition-pill-edge clip-transition-pill-edge-r"
        aria-hidden="true"
        onPointerDown={(event) => beginResize(event, 1)}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
      />
    </span>
  );
}
