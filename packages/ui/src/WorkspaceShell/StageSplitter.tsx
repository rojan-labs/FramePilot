/**
 * A full-width draggable horizontal splitter between the top region (assets ·
 * preview · panels) and the full-width timeline dock (Premiere-style; J1
 * extraction — plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6). Resizing only changes
 * the **dock** height; the top region flexes to fill the rest, so
 * loading/clearing footage never reflows the layout.
 *
 * Keyboard-operable for the same reason as {@link RailSplitter} (P8.5): it
 * declared `role="separator"` and offered no way to move it without a pointer,
 * on a 2px target.
 */
import type { RefObject } from 'react';
import { TIMELINE_MIN, TOP_REGION_MIN, maxDockHeight } from './useDockHeight.js';

/** Arrow step (px). */
const STEP_PX = 16;
/** Shift+Arrow step (px). */
const COARSE_STEP_PX = 64;

export interface StageSplitterProps {
  readonly boundsRef: RefObject<HTMLElement>;
  readonly onResize: (height: number) => void;
  /** Current dock height (px) — announced as the separator's value. */
  readonly height: number;
}

export function StageSplitter({ boundsRef, onResize, height }: StageSplitterProps): JSX.Element {
  // Unlike the rails, the dock's ceiling is not a constant — it depends on how
  // tall the window is. `maxDockHeight` is the same window-derived bound the
  // persisted height is already loaded and clamped against, so the announced
  // maximum and the keyboard's End are the value the hook would accept anyway.
  // The drag keeps measuring the live element instead, because mid-drag the
  // element's own box is the truth the pointer is following.
  const max = maxDockHeight();

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? COARSE_STEP_PX : STEP_PX;
    let next: number;
    switch (event.key) {
      // Up grows the dock: the splitter is the dock's top edge, so dragging it
      // up is what makes the timeline taller.
      case 'ArrowUp':
        next = height + step;
        break;
      case 'ArrowDown':
        next = height - step;
        break;
      case 'Home':
        next = TIMELINE_MIN;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onResize(Math.max(TIMELINE_MIN, Math.min(max, next)));
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      aria-valuenow={height}
      aria-valuemin={TIMELINE_MIN}
      aria-valuemax={max}
      tabIndex={0}
      className="stage-splitter"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 0) return;
        const rect = boundsRef.current?.getBoundingClientRect();
        if (!rect) return;
        const fromBottom = rect.bottom - event.clientY;
        const dragMax = rect.height - TOP_REGION_MIN;
        onResize(Math.max(TIMELINE_MIN, Math.min(dragMax, fromBottom)));
      }}
    />
  );
}
