/**
 * Timeline minimap / overview strip (plan/TIMELINE-REVAMP.md §4, §7 M2b-2).
 *
 * A compressed full-sequence strip under the timeline: every clip is a tiny block
 * and the lane viewport is a draggable window. It is **pure navigation chrome** —
 * it never edits the timeline (invariant 5); dragging it only changes the lane
 * `scrollLeft` via the supplied callback. All geometry is the pure
 * {@link minimapGeometry} / {@link minimapScrollLeft} selector pair, so this
 * component is the thin DOM/pointer shell over them (mirrors {@link TimelineView}).
 *
 * The window is keyboard-operable as a slider (←/→ nudge, Home/End jump) and the
 * strip honours `prefers-reduced-motion` through the shared token reset.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '@framepilot/timeline-schema';
import { minimapGeometry, minimapScrollLeft } from '../editor/selectors.js';

export interface TimelineMinimapProps {
  readonly timeline: Timeline;
  /** Visible track ids, top→bottom (must match the rendered lane rows). */
  readonly trackOrder: readonly string[];
  readonly pxPerSecond: number;
  /** Total lane width in px at the current zoom. */
  readonly contentWidth: number;
  /** Current viewport scroll offset, px. */
  readonly scrollLeft: number;
  /** Viewport width, px. */
  readonly clientWidth: number;
  /** Apply a new lane `scrollLeft` (px) — the strip's only side effect. */
  readonly onScrollTo: (scrollLeft: number) => void;
}

/** How far (px) one arrow-key nudge pans the viewport via the minimap. */
const KEY_NUDGE_PX = 80;

/**
 * The compressed overview strip. Renders only when the sequence overflows its
 * viewport (otherwise there is nothing to navigate) — the parent decides whether
 * to mount it, but we also no-op a window drag when everything already fits.
 *
 * `memo`-wrapped (perf slice 4, plan Phase 12.1): the parent {@link TimelineView}
 * re-renders ~60×/s during playback, but the minimap's props are unchanged by a
 * seek (the playhead is not one of them), so it skips those renders entirely.
 */
function TimelineMinimapImpl({
  timeline,
  trackOrder,
  pxPerSecond,
  contentWidth,
  scrollLeft,
  clientWidth,
  onScrollTo,
}: TimelineMinimapProps): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [width, setWidth] = useState(0);

  // Measure the strip's own width so the geometry maps the sequence onto it. All
  // px values are recomputed every render from the live width, so a resize
  // self-corrects; `width` starts at 0 only until the first measurement lands.
  const measure = useCallback((): number => {
    const w = stripRef.current?.getBoundingClientRect().width ?? 0;
    if (w > 0 && w !== width) setWidth(w);
    return w || width;
  }, [width]);

  // Measure BEFORE the first paint, and again whenever the strip resizes.
  //
  // This used to run only from `onPointerDown`/`scrollToX`, so the strip mounted
  // at `width = 0`: every block and the viewport window computed to zero px and
  // the map rendered as an empty bar. It only appeared once the user clicked it —
  // which is exactly backwards for a navigation aid, since you have to be able to
  // see where you are before you decide where to drag to. A layout effect paints
  // it correctly on the first frame; the observer keeps it correct when the
  // window, the rails, or the timeline dock resize (none of which are clicks).
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const node = stripRef.current;
    // jsdom and older embedders have no ResizeObserver — the layout effect above
    // still gives a correct first paint; only live resize tracking is lost.
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Memoised so a re-render that doesn't change the sequence/viewport (and any that
  // slip through the memo boundary) doesn't re-walk every clip (perf slice 4).
  const geometry = useMemo(
    () =>
      minimapGeometry(
        timeline,
        trackOrder,
        pxPerSecond,
        contentWidth,
        scrollLeft,
        clientWidth,
        width,
      ),
    [timeline, trackOrder, pxPerSecond, contentWidth, scrollLeft, clientWidth, width],
  );

  /** Scroll so the viewport window centres on a minimap-x (clamped by the selector). */
  const scrollToX = useCallback(
    (minimapX: number): void => {
      const w = measure();
      if (w <= 0) return;
      onScrollTo(minimapScrollLeft(minimapX, contentWidth, clientWidth, w));
    },
    [measure, onScrollTo, contentWidth, clientWidth],
  );

  const localX = (clientX: number): number =>
    clientX - (stripRef.current?.getBoundingClientRect().left ?? 0);

  const onPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (event.button !== 0) return;
      measure();
      draggingRef.current = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom / lost capture — the click still seeks via the move/up below. */
      }
      scrollToX(localX(event.clientX));
    },
    [measure, scrollToX],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      if (!draggingRef.current) return;
      scrollToX(localX(event.clientX));
    },
    [scrollToX],
  );

  const onPointerUp = useCallback((event: React.PointerEvent): void => {
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore lost capture */
    }
  }, []);

  const maxScroll = Math.max(0, contentWidth - clientWidth);
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = scrollLeft - KEY_NUDGE_PX;
      else if (event.key === 'ArrowRight') next = scrollLeft + KEY_NUDGE_PX;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = maxScroll;
      if (next === null) return;
      event.preventDefault();
      onScrollTo(Math.max(0, Math.min(maxScroll, next)));
    },
    [scrollLeft, maxScroll, onScrollTo],
  );

  const rowBand = geometry.rows > 0 ? 100 / geometry.rows : 100;

  return (
    <div
      ref={stripRef}
      className="minimap"
      role="slider"
      tabIndex={0}
      aria-label="Timeline overview"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(maxScroll)}
      aria-valuenow={Math.round(scrollLeft)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {geometry.blocks.map((block, i) => (
        <span
          key={`${block.clipId}:${i}`}
          className="mm-block"
          aria-hidden="true"
          style={{
            left: `${block.x}px`,
            width: `${block.width}px`,
            top: `${block.row * rowBand}%`,
            height: `${rowBand}%`,
          }}
        />
      ))}
      <span
        className="mm-view"
        aria-hidden="true"
        style={{ left: `${geometry.viewport.x}px`, width: `${geometry.viewport.width}px` }}
      />
    </div>
  );
}

export const TimelineMinimap = memo(TimelineMinimapImpl);
