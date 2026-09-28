/**
 * Narrow a wrapped text overlay's box to its longest line, as the engine's raster is.
 *
 * CSS cannot do this on its own: a box whose text wraps stays as wide as its `max-width`, never
 * as wide as its longest line. The engine sizes a text overlay's chip to the longest line plus padding
 * (`captions.py`), so without this a selected two-line text overlay's chip jumps wider in the monitor
 * than it exports, and left- or right-aligned lines shift sideways. One line needs nothing:
 * `width: max-content` already hugs it.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** The pixel width `box` should take so it hugs `text`'s longest line, or `null` to leave it. */
export function huggedWidth(box: HTMLElement, text: HTMLElement): number | null {
  if (typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  range.selectNodeContents(text);
  if (typeof range.getClientRects !== 'function') return null;
  const lines = new Map<number, { left: number; right: number }>();
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0) continue;
    const key = Math.round(rect.top);
    const line = lines.get(key);
    lines.set(
      key,
      line
        ? { left: Math.min(line.left, rect.left), right: Math.max(line.right, rect.right) }
        : { left: rect.left, right: rect.right },
    );
  }
  if (lines.size < 2) return null;
  // Client rects are after the box's transform (the entrance scale); its layout width is not.
  const scale = box.getBoundingClientRect().width / (box.offsetWidth || 1);
  if (!(scale > 0)) return null;
  const longest = Math.max(...Array.from(lines.values(), (l) => l.right - l.left)) / scale;
  const css = getComputedStyle(box);
  const px = (value: string): number => parseFloat(value) || 0;
  const frame =
    px(css.paddingLeft) + px(css.paddingRight) + px(css.borderLeftWidth) + px(css.borderRightWidth);
  // One pixel of slack so the narrower box never re-wraps its own longest line.
  const width = Math.ceil(longest + frame + 1);
  return width < box.offsetWidth ? width : null;
}

/**
 * Keep `boxRef` hugging `textRef`'s lines while `enabled`, re-measuring when `key` changes (the
 * text or anything that moves its line breaks) and when the frame is resized. The box's own
 * inline width is restored before each measurement and on cleanup, because React leaves a style
 * key alone when it believes it has not changed.
 */
export function useHugLines(
  boxRef: RefObject<HTMLElement>,
  textRef: RefObject<HTMLElement>,
  enabled: boolean,
  key: string,
): void {
  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!enabled || !box || !text) return undefined;
    const authored = box.style.width;
    const measure = (): void => {
      box.style.width = authored;
      const width = huggedWidth(box, text);
      if (width !== null) box.style.width = `${String(width)}px`;
    };
    measure();
    const frame = box.parentElement;
    const observer =
      typeof ResizeObserver === 'undefined' || frame === null ? null : new ResizeObserver(measure);
    if (observer && frame) observer.observe(frame);
    return () => {
      observer?.disconnect();
      box.style.width = authored;
    };
  }, [boxRef, textRef, enabled, key]);
}
