import { describe, expect, it } from 'vitest';
import { animationProgress, textOverlayStyle } from './textOverlay.js';
import { DEFAULT_TEXT_PARAMS } from './patch-builders.js';

describe('animationProgress', () => {
  it('is fully on-screen for the whole clip when there is no animation window', () => {
    expect(animationProgress(1, 5, 0)).toEqual({ inProgress: 1, outProgress: 1 });
  });

  it('eases in over the first window and out over the last', () => {
    // 0.4s window on a 5s clip.
    expect(animationProgress(0, 5, 0.4).inProgress).toBe(0); // just appeared
    expect(animationProgress(0.2, 5, 0.4).inProgress).toBeCloseTo(0.5);
    expect(animationProgress(0.4, 5, 0.4).inProgress).toBe(1); // fully in
    expect(animationProgress(5, 5, 0.4).outProgress).toBe(0); // about to leave
    expect(animationProgress(4.8, 5, 0.4).outProgress).toBeCloseTo(0.5);
    expect(animationProgress(2.5, 5, 0.4).outProgress).toBe(1); // mid-clip, fully in
  });
});

describe('textOverlayStyle', () => {
  it('applies percent position/size and cqh font size', () => {
    const style = textOverlayStyle(DEFAULT_TEXT_PARAMS, 2, 5);
    expect(style.left).toBe('50%');
    expect(style.top).toBe('50%');
    expect(style.width).toBe('80%');
    expect(style.fontSize).toBe('8cqh');
    expect(style.textAlign).toBe('center');
    expect(style.opacity).toBe(1); // no animation → fully visible mid-clip
  });

  it('fades the opacity toward the clip edges for a fade animation', () => {
    const params = { ...DEFAULT_TEXT_PARAMS, inAnimation: 'fade' as const };
    const atStart = textOverlayStyle(params, 0, 5).opacity as number;
    const midway = textOverlayStyle(params, 2.5, 5).opacity as number;
    expect(atStart).toBe(0);
    expect(midway).toBe(1);
  });

  it('includes a background box only when set', () => {
    expect(textOverlayStyle(DEFAULT_TEXT_PARAMS, 2, 5).background).toBeUndefined();
    const boxed = textOverlayStyle({ ...DEFAULT_TEXT_PARAMS, background: '#000' }, 2, 5);
    expect(boxed.background).toBe('#000');
  });
});
