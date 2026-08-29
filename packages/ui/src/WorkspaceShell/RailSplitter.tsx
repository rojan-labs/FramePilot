/**
 * A draggable vertical splitter that resizes a workspace rail (J1 extraction —
 * plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6). While the rail is collapsed the
 * splitter is hidden and inert: a collapsed strip must read as one quiet edge,
 * not an edge plus a grabbable divider.
 *
 * It is also a **keyboard** control (P8.5). It declared `role="separator"` with
 * no tab stop, no keys and no aria values, which made resizing a panel a
 * pointer-only capability on a 2px target — unusable with a trackpad at speed,
 * impossible without a pointer, and silent to a screen reader.
 */
import type { RefObject } from 'react';
import { RAIL_BOUNDS, type RailSide } from './useRailLayout.js';

/** Arrow step (px). One press should be visible without being a jump. */
const STEP_PX = 16;
/** Shift+Arrow step (px) — the coarse move across a rail in a few presses. */
const COARSE_STEP_PX = 64;

export interface RailSplitterProps {
  readonly side: RailSide;
  readonly boundsRef: RefObject<HTMLElement>;
  readonly onResize: (width: number) => void;
  readonly hidden?: boolean;
  /** Current effective rail width (px) — announced as the separator's value. */
  readonly width: number;
}

export function RailSplitter({
  side,
  boundsRef,
  onResize,
  hidden = false,
  width,
}: RailSplitterProps): JSX.Element {
  const { min, max } = RAIL_BOUNDS[side];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (hidden) return;
    const step = event.shiftKey ? COARSE_STEP_PX : STEP_PX;
    // The left rail grows rightwards and the right rail grows leftwards, so the
    // arrow that widens a rail is the one pointing away from its own edge.
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    let next: number;
    switch (event.key) {
      case grow:
        next = width + step;
        break;
      case shrink:
        next = width - step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onResize(Math.min(max, Math.max(min, next)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      aria-hidden={hidden}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      // A hidden splitter is out of the tab ring as well as out of the hit test:
      // a collapsed rail has no width to adjust.
      tabIndex={hidden ? -1 : 0}
      className={`rail-splitter${hidden ? ' is-hidden' : ''}`}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (hidden) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (hidden) return;
        if (event.buttons === 0) return; // only while the primary button is held
        const rect = boundsRef.current?.getBoundingClientRect();
        if (!rect) return;
        onResize(side === 'left' ? event.clientX - rect.left : rect.right - event.clientX);
      }}
    />
  );
}
