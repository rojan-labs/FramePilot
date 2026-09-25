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
  readerDecodeSize,
  textRasterStep,
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

  it('carries the clip mask stack into the alpha pass at the clip opacity', () => {
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
    expect(step?.mask?.stack.alpha.map((layer) => layer.kind)).toEqual(['ellipse']);
    expect(step?.maskRefusal).toBeNull();
    expect(stepFor(host, land)?.mask).toBeNull();
  });

  it('refuses, visibly, a stack the export cannot draw yet and keeps effect ids', () => {
    const land = video('land', 1920, 1080);
    const host = {
      ...clip('c', 'land'),
      effects: [{ id: 'g1', type: 'color_grade', params: { exposure: 0.5 } }],
    } as unknown as Clip;
    // A key cannot be fixed to the frame: it reads the clip's own picture (MK9.1).
    const frameSpace = MaskLayerSchema.parse({
      id: 'k',
      kind: 'key',
      model: 'hsl',
      space: 'frame',
    });
    const step = stepFor({ ...host, masks: [frameSpace] }, land);
    expect(step?.mask).toBeNull();
    expect(step?.maskRefusal?.task).toBeNull();
    expect(step?.maskRefusal?.message).toMatch(/Set its space to Source/);
    expect(stepFor(host, land)?.effectIds).toEqual(['g1']);
  });

  it('stretches the upright height of a quarter-turned anamorphic source (PX2.11)', () => {
    // Upright storage 1080x1440 (stored 1440x1080, turned 90), PAR 4/3: displays 1080x1920.
    expect(readerDecodeSize({ width: 1080, height: 1440 }, null, null, 4 / 3, 90)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(readerDecodeSize({ width: 1440, height: 1080 }, null, null, 4 / 3, 0)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(
      readerDecodeSize(
        { width: 1080, height: 1440 },
        null,
        { width: 1280, height: 720 },
        4 / 3,
        90,
      ),
    ).toEqual({ width: 404, height: 720 });
  });
});

describe('stills and titles take the picture pipeline (plan/elements EL2a)', () => {
  const still = (width: number, height: number): Asset => ({
    id: 'png',
    path: 'still.png',
    kind: 'image',
    media: { width, height },
  });
  const opacity = (value: number) =>
    [{ id: 'o', property: 'opacity', time: 0, value, easing: 'linear' }] as Clip['keyframes'];

  it('crops a still and draws its opacity, as the export does', () => {
    const c = clip('s', 'png', {
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
      keyframes: opacity(0.25),
    });
    const step = stepFor(c, still(800, 400));
    expect(step?.crop).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    expect(step?.opacity).toBe(0.25);
    // The 400x400 crop fits the 1280x720 frame by height.
    expect(step?.resize).toEqual({ width: 720, height: 720 });
  });

  it('draws a still’s legacy wipe and catalog transition', () => {
    const wiped = clip('s', 'png', {
      effects: [
        {
          id: 'w',
          type: 'transition',
          params: { kind: 'wipe', durationSeconds: 2 },
          keyframes: [],
        },
      ],
    });
    expect(stepFor(wiped, still(800, 600), 0.5)?.wipe).not.toBeNull();
    const dissolved = clip('s', 'png', {
      effects: [
        {
          id: 'd',
          type: 'transition',
          params: { kind: 'soft-dissolve', durationSeconds: 2 },
          keyframes: [],
        },
      ],
    });
    expect(stepFor(dissolved, still(800, 600), 0.5)?.transitions).toHaveLength(1);
  });

  it('never draws a still’s mask stack, which the export does not draw yet', () => {
    const host = clip('s', 'png');
    const mask = MaskLayerSchema.parse(
      maskLayerFromLegacyMaskEffect(
        {
          id: 's__mask',
          params: { shape: 'ellipse', bounds: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
          keyframes: [],
        },
        host as unknown as Record<string, unknown>,
        { width: 800, height: 600 },
      ),
    );
    const step = stepFor({ ...host, masks: [mask] }, still(800, 600));
    expect(step?.mask).toBeNull();
    expect(step?.maskRefusal).toBeNull();
  });

  const title = (params: Record<string, unknown>, extra: Partial<Clip> = {}): Clip =>
    clip('t', '__text__', {
      effects: [{ id: 't__text', type: 'text', params: { text: 'Hi', ...params }, keyframes: [] }],
      ...extra,
    });

  function titleStep(c: Clip, t: number): PictureRasterStep | null {
    const timeline: Timeline = { tracks: [{ id: 't', type: 'overlay', clips: [c] }] };
    const layer = framePlanAt(timeline, [], t, TARGET).layers.find((l) => l.kind === 'text');
    if (!layer) throw new Error('no text layer');
    return textRasterStep(layer, c, { width: 200, height: 100 }, { x: 640, y: 360 });
  }

  it('draws a title’s opacity keyframe', () => {
    expect(titleStep(title({}, { keyframes: opacity(0.25) }), 1)?.opacity).toBe(0.25);
    expect(titleStep(title({}), 1)?.opacity).toBeNull();
  });

  it('pops a title in from smaller and settles at its own size', () => {
    const popping = title({ inAnimation: 'pop', animDurationSeconds: 0.4 });
    const early = titleStep(popping, 0.1);
    // 0.7 + 0.3 × 0.25 = 0.775 of 200x100, around the layout centre; int() truncates the
    // float 154.99999… exactly as Pillow's size does.
    expect(early?.opacity).toBe(0.25);
    expect(early?.resize).toEqual({ width: 154, height: 77 });
    expect(early?.x).toBe(Math.trunc(640 - (200 * 0.775) / 2));
    const settled = titleStep(popping, 1);
    expect(settled?.resize).toBeNull();
    expect(settled?.x).toBe(540);
  });

  it('slides a title up by a share of the frame height', () => {
    const sliding = title({ inAnimation: 'slide-up', animDurationSeconds: 0.4 });
    // At t=0 it sits 5% of 720 = 36px below its place.
    expect(titleStep(sliding, 0)?.y).toBe(310 + 36);
    expect(titleStep(sliding, 1)?.y).toBe(310);
  });
});
