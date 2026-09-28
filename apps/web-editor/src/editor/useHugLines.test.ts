/**
 * A wrapped title's box narrows to its longest line (the engine's chip does); one line and
 * environments without Range geometry are left to CSS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { huggedWidth } from './useHugLines.js';

function rect(left: number, top: number, width: number): DOMRect {
  return { left, top, width, right: left + width, height: 20, bottom: top + 20 } as DOMRect;
}

function boxOf(offsetWidth: number, renderedWidth = offsetWidth): HTMLElement {
  const box = document.createElement('div');
  box.style.padding = '0 10px';
  document.body.append(box);
  Object.defineProperty(box, 'offsetWidth', { value: offsetWidth });
  box.getBoundingClientRect = () => ({ width: renderedWidth }) as DOMRect;
  return box;
}

function withLines(rects: readonly DOMRect[]): void {
  vi.spyOn(document, 'createRange').mockReturnValue({
    selectNodeContents: () => undefined,
    getClientRects: () => rects,
  } as unknown as Range);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('huggedWidth', () => {
  it('narrows a two-line box to its longest line plus padding', () => {
    withLines([rect(0, 0, 150), rect(0, 24, 90)]);
    const box = boxOf(300);
    expect(huggedWidth(box, box)).toBe(150 + 20 + 1);
  });

  it('measures through the entrance scale', () => {
    withLines([rect(0, 0, 75), rect(0, 12, 40)]);
    const box = boxOf(300, 150); // drawn at half size
    expect(huggedWidth(box, box)).toBe(150 + 20 + 1);
  });

  it('merges the pieces of one line and leaves a single line to CSS', () => {
    withLines([rect(0, 0, 50), rect(50, 0, 60)]);
    const box = boxOf(300);
    expect(huggedWidth(box, box)).toBeNull();
  });

  it('never widens a box', () => {
    withLines([rect(0, 0, 295), rect(0, 24, 90)]);
    const box = boxOf(300);
    expect(huggedWidth(box, box)).toBeNull();
  });
});
