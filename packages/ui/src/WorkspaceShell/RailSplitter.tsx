/**
 * A draggable vertical splitter that resizes a workspace rail (J1 extraction —
 * plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6). While the rail is collapsed the
 * splitter is hidden and inert: a collapsed strip must read as one quiet edge,
 * not an edge plus a grabbable divider.
 */
import type { RefObject } from 'react';
import type { RailSide } from './useRailLayout.js';

export interface RailSplitterProps {
  readonly side: RailSide;
  readonly boundsRef: RefObject<HTMLElement>;
  readonly onResize: (width: number) => void;
  readonly hidden?: boolean;
}

export function RailSplitter({ side, boundsRef, onResize, hidden = false }: RailSplitterProps): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} panel`}
      aria-hidden={hidden}
      className={`rail-splitter${hidden ? ' is-hidden' : ''}`}
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
