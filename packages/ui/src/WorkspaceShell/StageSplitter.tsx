/**
 * A full-width draggable horizontal splitter between the top region (assets ·
 * preview · panels) and the full-width timeline dock (Premiere-style; J1
 * extraction — plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6). Resizing only changes
 * the **dock** height; the top region flexes to fill the rest, so
 * loading/clearing footage never reflows the layout.
 */
import type { RefObject } from 'react';
import { TIMELINE_MIN, TOP_REGION_MIN } from './useDockHeight.js';

export interface StageSplitterProps {
  readonly boundsRef: RefObject<HTMLElement>;
  readonly onResize: (height: number) => void;
}

export function StageSplitter({ boundsRef, onResize }: StageSplitterProps): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      className="stage-splitter"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 0) return;
        const rect = boundsRef.current?.getBoundingClientRect();
        if (!rect) return;
        const fromBottom = rect.bottom - event.clientY;
        const max = rect.height - TOP_REGION_MIN;
        onResize(Math.max(TIMELINE_MIN, Math.min(max, fromBottom)));
      }}
    />
  );
}
