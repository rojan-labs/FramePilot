/**
 * Gestures become model changes relative to what is stored: a picture's scale ratio, stretch,
 * centre travel and turn; a text overlay's position, word size or wrap width.
 */
import { describe, expect, it } from 'vitest';
import {
  boxOfPlacement,
  pictureTransformAfter,
  shapeBoxOf,
  shapeEditAfter,
  textOverlayEditAfter,
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

describe('textOverlayEditAfter', () => {
  const params = { xPercent: 50, yPercent: 50, fontSizePercent: 8, boxWidthPercent: 80 };
  const box: Box = { cx: 960, cy: 540, width: 600, height: 120, rotation: 0 };

  it('turns the clip on a rotation and leaves the words alone', () => {
    const edit = textOverlayEditAfter(
      params,
      base,
      box,
      { ...box, rotation: 15 },
      { kind: 'rotate' },
      FRAME,
    );
    expect(edit.params).toEqual(params);
    expect(edit.transform.rotation).toBe(15);
  });

  it('reflows from a side even when free', () => {
    const edit = textOverlayEditAfter(
      params,
      base,
      box,
      { ...box, width: 792, cx: 1056 },
      { kind: 'resize', handle: 'e', uniform: false },
      FRAME,
    );
    expect(edit.transform).toEqual(base);
    expect(edit.params.boxWidthPercent).toBe(90);
  });

  it('stretches the letters from a free corner, the centre travel going to the params', () => {
    const edit = textOverlayEditAfter(
      params,
      base,
      box,
      { cx: 1260, cy: 570, width: 1200, height: 180, rotation: 0 },
      { kind: 'resize', handle: 'se', uniform: false },
      FRAME,
    );
    expect(edit.transform).toMatchObject({ scaleX: 2, scaleY: 1.5, x: 0, y: 0, scale: 1 });
    expect(edit.params).toMatchObject({ xPercent: 65.63, yPercent: 52.78, fontSizePercent: 8 });
  });
});

describe('shapes', () => {
  const limits = { position: { min: 0, max: 100 }, size: { min: 0.1, max: 400 } };
  const shape = { x: 50, y: 50, width: 20, height: 10 };

  it('boxes a shape: size in percent of the height, placed by the clip transform', () => {
    expect(shapeBoxOf(shape, { ...base, x: 96, scale: 2 }, FRAME)).toEqual({
      cx: 1056,
      cy: 540,
      width: 432,
      height: 216,
      rotation: 0,
    });
  });

  it('moves and resizes the params, stretching natively when free', () => {
    const from = shapeBoxOf(shape, base, FRAME);
    const edit = shapeEditAfter(
      shape,
      base,
      from,
      { ...from, cx: from.cx + 96, width: from.width * 2 },
      { kind: 'resize', handle: 'e', uniform: false },
      FRAME,
      limits,
    );
    expect(edit.params).toEqual({ x: 55, y: 50, width: 40, height: 10 });
    expect(edit.transform).toEqual(base);
  });

  it('turns the clip', () => {
    const from = shapeBoxOf(shape, base, FRAME);
    const edit = shapeEditAfter(
      shape,
      base,
      from,
      { ...from, rotation: -45 },
      { kind: 'rotate' },
      FRAME,
      limits,
    );
    expect(edit.params).toEqual(shape);
    expect(edit.transform.rotation).toBe(-45);
  });
});
