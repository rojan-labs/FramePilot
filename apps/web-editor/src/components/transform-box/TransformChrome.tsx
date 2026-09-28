/**
 * Where the bounding box draws: an unclipped, unscaled layer laid exactly over the monitor frame.
 *
 * WHY a layer of its own. The frame (`.preview-frame`) clips its content (`overflow: hidden`, so a
 * zoomed or off-frame picture never spills onto the stage) and is scaled by the monitor's zoom (a
 * CSS `scale()`). Drawn inside it, a box around a full-frame clip lost its corner handles and its
 * rotation lollipop to the clip (they sit ON and OUTSIDE the frame's edge), and at 200 % every
 * 1.5 px rule and 8 px handle doubled. Here the chrome is the frame's on-screen rectangle, tracked
 * as it resizes, zooms, pans and scrolls, so handles reach past the edge and stay crisp at any
 * zoom, and a pointer maps through the same rectangle the frame shows.
 *
 * The box renders into it through {@link TransformChromeContext} (a portal); without a provider it
 * renders in place.
 */
import { createContext, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Fired on the layer after it follows the frame to a new place: what lives in it (the box's
 * controls outside its edges) re-checks the room it has.
 */
export const CHROME_MOVED_EVENT = 'transformchromemove';

/** The chrome layer a bounding box portals into, or `null` to render in place. */
export const TransformChromeContext = createContext<HTMLElement | null>(null);

export interface TransformChromeLayerProps {
  /** The monitor frame the layer covers. */
  readonly frameRef: RefObject<HTMLElement>;
  /** Hands the layer element to the owner (which provides it through the context). */
  readonly onHost: (host: HTMLElement | null) => void;
  /** Anything that moves the frame without resizing it (the zoom and pan), to re-measure on. */
  readonly watch?: unknown;
}

/**
 * The layer itself: a sibling of the frame inside the stage (its offset parent), kept on the
 * frame's rectangle by direct style writes (no React state, so tracking never re-renders the
 * monitor).
 */
export function TransformChromeLayer({
  frameRef,
  onHost,
  watch,
}: TransformChromeLayerProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    onHost(layer);
    return () => onHost(null);
  }, [onHost]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const frame = frameRef.current;
    const stage = layer?.offsetParent as HTMLElement | null | undefined;
    if (!layer || !frame || !stage) return undefined;
    const measure = (): void => {
      const f = frame.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      layer.style.left = `${f.left - s.left + stage.scrollLeft - stage.clientLeft}px`;
      layer.style.top = `${f.top - s.top + stage.scrollTop - stage.clientTop}px`;
      layer.style.width = `${f.width}px`;
      layer.style.height = `${f.height}px`;
      layer.dispatchEvent(new Event(CHROME_MOVED_EVENT));
    };
    measure();
    // A zoom animates the frame's transform: follow it frame by frame while it runs.
    let raf: number | null = null;
    const follow = (): void => {
      measure();
      raf = requestAnimationFrame(follow);
    };
    const start = (): void => {
      if (raf === null) raf = requestAnimationFrame(follow);
    };
    const stop = (): void => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      measure();
    };
    frame.addEventListener('transitionrun', start);
    frame.addEventListener('transitionend', stop);
    frame.addEventListener('transitioncancel', stop);
    stage.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    observer?.observe(stage);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      frame.removeEventListener('transitionrun', start);
      frame.removeEventListener('transitionend', stop);
      frame.removeEventListener('transitioncancel', stop);
      stage.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [frameRef, watch]);

  return <div ref={layerRef} className="transform-chrome" />;
}
