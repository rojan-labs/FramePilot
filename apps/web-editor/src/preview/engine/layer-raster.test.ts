import { describe, expect, it } from 'vitest';
import { framePlanAt } from '@framepilot/editor-core';
import {
  MaskLayerSchema,
  maskLayerFromLegacyMaskEffect,
  type Asset,
  type Clip,
  type Timeline,
} from '@framepilot/timeline-schema';
import {
  cappedDecodeSize,
  cropRect,
  fittedDecodeSize,
  pictureRasterStep,
  type PictureRasterStep,
} from './layer-raster.js';

const TARGET = { width: 1280, height: 720 };

const video = (id: string, width: number, height: number): Asset => ({
  id,
  path: `${id}.mp4`,
  kind: 'video',
  durationSeconds: 10,
  media: { width, height },
});

const clip = (id: string, assetId: string, extra: Partial<Clip> = {}): Clip => ({
  id,
  assetId,
  trackId: 't',
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
  ...extra,
});

function stepFor(c: Clip, asset: Asset, t = 1): PictureRasterStep | null {
  const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [c] }] };
  const plan = framePlanAt(timeline, [asset], t, TARGET, { sourceFps: { [asset.id]: 30 } });
  const layer = plan.layers.find((l) => l.kind === 'picture');
  if (!layer) throw new Error('no picture layer');
  return pictureRasterStep(layer, c, asset, TARGET);
}

describe('layer raster steps mirror compile_timeline pixel decisions', () => {
  it('decodes a static landscape fit straight to the frame (swscale scaled path)', () => {
    const step = stepFor(clip('c', 'land'), video('land', 1920, 1080));
    expect(step).toMatchObject({
      decode: { kind: 'scaled', width: 1280, height: 720 },
      crop: null,
      resize: null,
      opacity: null,
      x: 0,
      y: 0,
      frame: 30,
    });
  });

  it('rounds a pillarboxed portrait to even dimensions and centres it with int()', () => {
    // 1080x1920 at 0.375 = 405x720 → round(202.5) = 202 (banker's) → 404 wide.
    expect(fittedDecodeSize({ width: 1080, height: 1920 }, TARGET)).toEqual({
      width: 404,
      height: 720,
    });
    const step = stepFor(clip('c', 'port'), video('port', 1080, 1920));
    expect(step).toMatchObject({ resize: null, x: 438, y: 0 });
  });

  it('never upscales in the decoder: a small source is converted at its own size and resized by Pillow', () => {
    const step = stepFor(clip('c', 'small'), video('small', 640, 360));
    expect(step).toMatchObject({
      decode: { kind: 'native' },
      resize: { width: 1280, height: 720 },
      x: 0,
      y: 0,
    });
  });

  it('decodes an opacity-keyframed clip natively, resizes with a truncated size, and masks it', () => {
    const c = clip('c', 'square', {
      keyframes: [
        { property: 'opacity', time: 0, value: 0.5, easing: 'linear' },
        { property: 'opacity', time: 4, value: 0.5, easing: 'linear' },
      ],
    } as Partial<Clip>);
    const step = stepFor(c, video('square', 1080, 1080));
    expect(step?.decode).toEqual({ kind: 'native' });
    expect(step?.opacity).toBe(0.5);
    expect(step?.resize?.height).toBe(720);
    expect(step?.x).toBe(Math.trunc((1280 - (step?.resize?.width ?? 0)) / 2));
  });

  it('caps a cropped clip decode and slices the crop with int() bounds', () => {
    const c = clip('c', 'land', { crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 } });
    // cap = ceil(1280 / 0.5 * 1.25) = 3200 ≥ 1920: no scaling in the decoder.
    expect(cappedDecodeSize({ width: 1920, height: 1080 }, 3200)).toBeNull();
    const step = stepFor(c, video('land', 1920, 1080));
    expect(step?.decode).toEqual({ kind: 'native' });
    expect(step?.crop).toEqual({ x: 480, y: 108, width: 960, height: 864 });
    expect(cropRect(c, { width: 1920, height: 1080 })).toEqual(step?.crop);
  });

  it('returns null for an asset with no measurable size', () => {
    const asset: Asset = { id: 'x', path: 'x.mp4', kind: 'video', durationSeconds: 4 };
    expect(stepFor(clip('c', 'x'), asset)).toBeNull();
  });

  it('carries a single-shape clip mask into the alpha pass at the clip opacity', () => {
    const land = video('land', 1920, 1080);
    const host = clip('c', 'land');
    const mask = MaskLayerSchema.parse(
      maskLayerFromLegacyMaskEffect(
        {
          id: 'c__mask',
          params: { shape: 'ellipse', bounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
          keyframes: [],
        },
        host as unknown as Record<string, unknown>,
        { width: 1920, height: 1080 },
      ),
    );
    const step = stepFor({ ...host, masks: [mask] }, land);
    expect(step?.opacity).toBe(1);
    expect(step?.mask).toMatchObject({ shape: 'ellipse', width: 0.5, height: 0.5 });
    expect(stepFor(host, land)?.mask).toBeNull();
  });
});
