import { describe, expect, it } from 'vitest';
import {
  BRUSH_EDGE,
  BRUSH_KEEP,
  BRUSH_REMOVE,
  BRUSH_UNTOUCHED,
  paintCorrection,
} from './matteCorrectionPng.js';

describe('paintCorrection', () => {
  it('paints each brush kind with its one host value and nothing in between (BR6.10)', () => {
    const gray = paintCorrection(
      [
        { kind: 'keep', radiusPx: 1, points: [{ x: 2, y: 2 }] },
        { kind: 'remove', radiusPx: 1, points: [{ x: 10, y: 2 }] },
        {
          kind: 'edge',
          radiusPx: 2,
          points: [
            { x: 5, y: 7 },
            { x: 14, y: 7 },
          ],
        },
      ],
      16,
      10,
    );
    expect(new Set(gray)).toEqual(new Set([BRUSH_KEEP, BRUSH_REMOVE, BRUSH_EDGE, BRUSH_UNTOUCHED]));
    expect(gray[2 * 16 + 2]).toBe(255);
    expect(gray[2 * 16 + 10]).toBe(0);
    expect(gray[7 * 16 + 9]).toBe(64);
    expect(gray[0]).toBe(128);
  });

  it('lets a later stroke overwrite an earlier one where they cross', () => {
    const gray = paintCorrection(
      [
        { kind: 'keep', radiusPx: 2, points: [{ x: 4, y: 4 }] },
        { kind: 'edge', radiusPx: 1, points: [{ x: 4, y: 4 }] },
      ],
      8,
      8,
    );
    expect(gray[4 * 8 + 4]).toBe(BRUSH_EDGE);
    expect(gray[4 * 8 + 6]).toBe(BRUSH_KEEP);
  });
});
