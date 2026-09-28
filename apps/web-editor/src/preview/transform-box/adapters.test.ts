/**
 * Gestures become model changes relative to what is stored: a picture's scale ratio, stretch,
 * centre travel and turn; a text overlay's position, word size or wrap width.
 */
import { describe, expect, it } from 'vitest';
import {
  boxOfPlacement,
  pictureTransformAfter,
  textOverlayParamsAfter,
  type PictureBaseTransform,
} from './adapters.js';
import type { Box } from './geometry.js';

const FRAME = { width: 1920, height: 1080 };
const base: PictureBaseTransform = { scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0 };
const from: Box = { cx: 960, cy: 540, width: 1920, height: 1080, rotation: 0 };

describe('boxOfPlacement', () => {
  it('reads a frame-plan geometry as a box', () => {
    expect(
      boxOfPlacement({ anchorX: 10, anchorY: 20, width: 30, height: 40, rotation: 5 }),
    ).toEqual({ cx: 10, cy: 20, width: 30, height: 40, rotation: 5 });
  });
});

describe('pictureTransformAfter', () => {
  it('adds the centre travel of a move to the offset', () => {
    const next = pictureTransformAfter(
      { ...base, x: 12 },
      from,
      { ...from, cx: 1000, cy: 500 },
      { kind: 'move' },
    );
    expect(next).toMatchObject({ x: 52, y: -40, scale: 1 });
  });

  it('multiplies the uniform scale, and moves the centre an anchored resize moved', () => {
    const to: Box = { cx: 480, cy: 270, width: 960, height: 540, rotation: 0 };
    const next = pictureTransformAfter({ ...base, scale: 2 }, from, to, {
      kind: 'resize',
      handle: 'nw',
      uniform: true,
    });
    expect(next).toMatchObject({ scale: 1, scaleX: 1, scaleY: 1, x: -480, y: -270 });
  });

  it('stretches per axis when free, leaving the uniform scale for zooms', () => {
    const to: Box = { ...from, width: 960 };
    const next = pictureTransformAfter({ ...base, scale: 1.5 }, from, to, {
      kind: 'resize',
      handle: 'e',
      uniform: false,
    });
    expect(next).toMatchObject({ scale: 1.5, scaleX: 0.5, scaleY: 1 });
  });

  it('adds the turn of a rotation, wrapped', () => {
    const next = pictureTransformAfter(
      { ...base, rotation: 170 },
      from,
      { ...from, rotation: 30 },
      {
        kind: 'rotate',
      },
    );
    expect(next.rotation).toBe(-160);
  });
});

describe('textOverlayParamsAfter', () => {
  const params = { xPercent: 50, yPercent: 50, fontSizePercent: 8, boxWidthPercent: 80 };
  const box: Box = { cx: 960, cy: 540, width: 600, height: 120, rotation: 0 };

  it('moves the centre in percent of each axis', () => {
    const next = textOverlayParamsAfter(
      params,
      box,
      { ...box, cx: 1152, cy: 432 },
      { kind: 'move' },
      FRAME,
    );
    expect(next).toMatchObject({ xPercent: 60, yPercent: 40, fontSizePercent: 8 });
  });

  it('scales the words and the wrap together on a uniform resize', () => {
    const next = textOverlayParamsAfter(
      params,
      box,
      { ...box, width: 900, height: 180 },
      { kind: 'resize', handle: 'se', uniform: true },
      FRAME,
    );
    expect(next).toMatchObject({ fontSizePercent: 12, boxWidthPercent: 100 });
  });

  it('reflows on a free side resize: new wrap width, same word size', () => {
    const next = textOverlayParamsAfter(
      params,
      box,
      { ...box, cx: 864, width: 408 },
      { kind: 'resize', handle: 'e', uniform: false },
      FRAME,
    );
    expect(next).toMatchObject({ fontSizePercent: 8, boxWidthPercent: 70, xPercent: 45 });
  });

  it('leaves the params to the clip transform on a rotation', () => {
    expect(
      textOverlayParamsAfter(params, box, { ...box, rotation: 30 }, { kind: 'rotate' }, FRAME),
    ).toEqual(params);
  });
});
