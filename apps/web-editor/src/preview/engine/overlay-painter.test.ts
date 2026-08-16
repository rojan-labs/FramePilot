/**
 * Unit tests for the pure line-wrapping used by the canvas overlay painter
 * (P3b). `paintTextOverlay` itself needs a real canvas 2D context (font
 * metrics, `fillText`) and is verified in the real-Chrome e2e
 * (`preview-webcodecs-p3.spec.ts`); the wrapping logic is pure and tested here
 * with an injected width measurer.
 */
import { describe, expect, it } from 'vitest';
import { wrapLines } from './overlay-painter.js';

// A deterministic stand-in for `ctx.measureText().width`: every character is
// 10px wide, so a line's width is `text.length * 10`.
const measure = (text: string): number => text.length * 10;

describe('wrapLines', () => {
  it('keeps a short line on one line', () => {
    expect(wrapLines(measure, 'hi there', 1000)).toEqual(['hi there']);
  });

  it('wraps greedily at the width budget', () => {
    // "aaa bbb ccc" = 11 chars; budget 70px = 7 chars, so "aaa bbb" (7) fits,
    // "ccc" overflows to the next line.
    expect(wrapLines(measure, 'aaa bbb ccc', 70)).toEqual(['aaa bbb', 'ccc']);
  });

  it('honors hard line breaks (pre-wrap)', () => {
    expect(wrapLines(measure, 'line one\nline two', 1000)).toEqual(['line one', 'line two']);
  });

  it('puts an over-long word on its own line rather than dropping it', () => {
    // A 12-char word exceeds a 50px (5-char) budget; it still gets a line.
    expect(wrapLines(measure, 'supercalifrag', 50)).toEqual(['supercalifrag']);
  });

  it('collapses internal whitespace runs to single spaces', () => {
    expect(wrapLines(measure, 'a   b', 1000)).toEqual(['a b']);
  });

  it('preserves empty lines from consecutive breaks', () => {
    expect(wrapLines(measure, 'a\n\nb', 1000)).toEqual(['a', '', 'b']);
  });
});
