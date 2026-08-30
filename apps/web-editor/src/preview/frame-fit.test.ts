import { describe, expect, it } from 'vitest';
import { aspectLabel, describeFrameFit } from './frame-fit.js';

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

describe('describeFrameFit (UX-14)', () => {
  // The finding itself: 4K landscape footage dropped into a 9:16 sequence, and the
  // monitor said nothing about the bars the export would have.
  it('names the bars a landscape source gets in a portrait frame', () => {
    const notice = describeFrameFit({ width: 3840, height: 2160 }, PORTRAIT);
    expect(notice?.kind).toBe('letterboxed');
    expect(notice?.label).toBe('Letterboxed');
    expect(notice?.detail).toContain('16:9 footage in a 9:16 frame');
    expect(notice?.detail).toContain('above and below');
  });

  it('names the bars a portrait source gets in a landscape frame', () => {
    const notice = describeFrameFit({ width: 1080, height: 1920 }, LANDSCAPE);
    expect(notice?.kind).toBe('pillarboxed');
    expect(notice?.detail).toContain('at the sides');
  });

  it('says nothing when the source already fills the frame', () => {
    expect(describeFrameFit({ width: 3840, height: 2160 }, LANDSCAPE)).toBeNull();
  });

  // A crop is exactly how a mismatched source is made to fill the frame. Comparing
  // the source file's aspect would keep accusing a correctly reframed clip.
  it('compares the CROPPED region, so a reframed clip reports nothing', () => {
    const cropTo9x16 = { x: 0.3418, y: 0, width: 0.3164, height: 1 };
    expect(describeFrameFit({ width: 3840, height: 2160 }, PORTRAIT, cropTo9x16)).toBeNull();
  });

  it('still reports bars when the crop does not reach the frame’s shape', () => {
    const halfCrop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    expect(describeFrameFit({ width: 3840, height: 2160 }, PORTRAIT, halfCrop)?.kind).toBe(
      'letterboxed',
    );
  });

  // Schema v21 made the probed dimensions optional. Guessing a shape would be worse
  // than silence — an unprobed asset is not a claim that it fits.
  it('says nothing about a source the engine has not probed', () => {
    expect(describeFrameFit(undefined, PORTRAIT)).toBeNull();
    expect(describeFrameFit({ width: null, height: null }, PORTRAIT)).toBeNull();
    expect(describeFrameFit({ width: 1920 }, PORTRAIT)).toBeNull();
  });
});

describe('aspectLabel', () => {
  it('reduces to the ratio an editor reads', () => {
    expect(aspectLabel(3840, 2160)).toBe('16:9');
    expect(aspectLabel(1080, 1920)).toBe('9:16');
    expect(aspectLabel(1000, 1000)).toBe('1:1');
  });

  // 4096x2160 reduces to 256:135, which nobody recognises.
  it('falls back to a decimal ratio when the reduced integers stop being readable', () => {
    expect(aspectLabel(4096, 2160)).toBe('1.90:1');
  });
});
