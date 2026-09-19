/**
 * MK6.1: the eyedropper turns a sampled pixel into a key an editor can work with, and adding a
 * second colour widens the key rather than intersecting it away.
 */
import { describe, expect, it, vi } from 'vitest';
import { KeyMaskSchema } from '@framepilot/timeline-schema';

import { keyAlphaAt, keyUniforms, type KeyMask } from './key-mask';
import { SAMPLE_TOLERANCE, keySampleChanges, sampleCanvasColour } from './eyedropper';

const parse = (raw: Record<string, unknown>): KeyMask =>
  KeyMaskSchema.parse({ id: 'k', kind: 'key', ...raw }) as KeyMask;

/** The mask after applying the eyedropper's changes, as `update_mask` would store them. */
const applied = (mask: KeyMask, changes: Readonly<Record<string, unknown>>): KeyMask =>
  parse({ ...mask, ...changes });

const alphaOf = (mask: KeyMask, r: number, g: number, b: number): number =>
  keyAlphaAt(keyUniforms(mask, mask.opacity), r / 255, g / 255, b / 255);

const GREEN = [0, 177, 64] as const;
const LIT_GREEN = [60, 200, 110] as const;
const SKIN = [222, 170, 135] as const;

describe('a sampled colour becomes a key', () => {
  it('opens hue and saturation ranges that match the sampled backing, not skin', () => {
    const mask = parse({ model: 'hsl' });
    const keyed = applied(mask, keySampleChanges(mask, { r: 0, g: 177 / 255, b: 64 / 255 }, false));
    expect(keyed.ranges.map((range) => range.channel)).toEqual(['hue', 'saturation']);
    expect(alphaOf(keyed, ...GREEN)).toBeGreaterThan(0.99);
    expect(alphaOf(keyed, ...SKIN)).toBe(0);
  });

  it('collects the colours themselves for the 3d model, with a usable first tolerance', () => {
    const mask = parse({ model: '3d' });
    const changes = keySampleChanges(mask, { r: 0, g: 177 / 255, b: 64 / 255 }, false);
    expect(changes.softness).toBe(SAMPLE_TOLERANCE);
    const keyed = applied(mask, changes);
    expect(keyed.samples3d).toHaveLength(1);
    expect(alphaOf(keyed, ...GREEN)).toBe(1);
    expect(alphaOf(keyed, ...SKIN)).toBe(0);
  });

  it('adds a second sampled colour instead of replacing it', () => {
    const mask = parse({ model: '3d' });
    const first = applied(mask, keySampleChanges(mask, { r: 0, g: 177 / 255, b: 64 / 255 }, false));
    const second = applied(
      first,
      keySampleChanges(first, { r: 60 / 255, g: 200 / 255, b: 110 / 255 }, true),
    );
    expect(second.samples3d).toHaveLength(2);
    expect(alphaOf(second, ...GREEN)).toBe(1);
    expect(alphaOf(second, ...LIT_GREEN)).toBe(1);
  });

  it('widens an existing range rather than intersecting a second one onto the channel', () => {
    const mask = parse({ model: 'luma' });
    const dark = applied(mask, keySampleChanges(mask, { r: 0.1, g: 0.1, b: 0.1 }, false));
    const both = applied(dark, keySampleChanges(dark, { r: 0.8, g: 0.8, b: 0.8 }, true));
    expect(both.ranges).toHaveLength(1);
    expect(both.ranges[0]!.low).toBeLessThanOrEqual(dark.ranges[0]!.low);
    expect(both.ranges[0]!.high).toBeGreaterThan(dark.ranges[0]!.high);
    // Both sampled brightnesses are now fully in the key; a replaced range would have lost one.
    expect(alphaOf(both, 26, 26, 26)).toBe(1);
    expect(alphaOf(both, 204, 204, 204)).toBe(1);
  });

  it('opens a wrapping hue arc when the sample sits near the wrap', () => {
    const mask = parse({ model: 'hsl' });
    // Pure red is hue 0, so a band around it must run through the wrap.
    const keyed = applied(mask, keySampleChanges(mask, { r: 1, g: 0, b: 0 }, false));
    const hue = keyed.ranges.find((range) => range.channel === 'hue')!;
    expect(hue.low).toBeGreaterThan(hue.high);
    expect(alphaOf(keyed, 255, 0, 0)).toBeGreaterThan(0.99);
  });

  it('replaces a wrapping arc rather than widening it into nonsense', () => {
    const mask = parse({ model: 'hsl' });
    const red = applied(mask, keySampleChanges(mask, { r: 1, g: 0, b: 0 }, false));
    const green = applied(red, keySampleChanges(red, { r: 0, g: 1, b: 0 }, true));
    const hue = green.ranges.find((range) => range.channel === 'hue')!;
    expect(hue.low).toBeLessThan(hue.high);
    expect(alphaOf(green, 0, 255, 0)).toBeGreaterThan(0.99);
  });
});

describe('sampling the monitor', () => {
  /** A canvas stub whose 2D context answers with one known pixel. */
  const canvasWith = (
    pixel: [number, number, number, number],
    size = { width: 100, height: 50 },
  ): HTMLCanvasElement => {
    const getImageData = vi.fn(() => ({ data: Uint8ClampedArray.from(pixel) }));
    return {
      width: size.width,
      height: size.height,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
      getContext: () => ({ getImageData }),
    } as unknown as HTMLCanvasElement;
  };

  it('maps CSS pixels onto canvas pixels', () => {
    const canvas = canvasWith([10, 20, 30, 255]);
    expect(sampleCanvasColour(canvas, 110, 70)).toEqual({
      r: 10 / 255,
      g: 20 / 255,
      b: 30 / 255,
    });
  });

  it('returns nothing outside the canvas or before a frame exists', () => {
    expect(sampleCanvasColour(canvasWith([0, 0, 0, 0]), 5, 5)).toBeNull();
    const empty = canvasWith([0, 0, 0, 0], { width: 0, height: 0 });
    expect(sampleCanvasColour(empty, 110, 70)).toBeNull();
  });
});
