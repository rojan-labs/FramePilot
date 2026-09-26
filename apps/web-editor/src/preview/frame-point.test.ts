/**
 * Where on the picture a drop on the program monitor lands (plan/elements 02 §3: "centred where
 * it was dropped"). The monitor measures the displayed frame's box — the picture itself, inside
 * any letterbox, after any zoom or pan — and this maps a client point into it, then into the units
 * a shape's `at` and a sticker's `offset` take.
 */
import { describe, expect, it } from 'vitest';
import {
  clientPointToFrame,
  shapeAtForFramePoint,
  stickerOffsetForFramePoint,
  type FrameRect,
} from './frame-point.js';

/** A 16:9 monitor stage, 1600 × 900, at the viewport's origin. */
const STAGE = { width: 1600, height: 900 };

/** A 9:16 project contained in that stage: pillarboxed, 506.25 px wide, centred. */
const PORTRAIT: FrameRect = {
  left: (STAGE.width - (STAGE.height * 9) / 16) / 2,
  top: 0,
  width: (STAGE.height * 9) / 16,
  height: STAGE.height,
};
const VERTICAL = { width: 1080, height: 1920 };

describe('clientPointToFrame', () => {
  it('maps into the picture, not the monitor, on a letterboxed 9:16 project', () => {
    // The stage's centre is the picture's centre…
    expect(clientPointToFrame({ x: 800, y: 450 }, PORTRAIT)).toEqual({ x: 0.5, y: 0.5 });
    // …but a quarter of the way across the picture is not a quarter of the way across the stage.
    const quarter = PORTRAIT.left + PORTRAIT.width / 4;
    expect(clientPointToFrame({ x: quarter, y: 675 }, PORTRAIT)).toEqual({ x: 0.25, y: 0.75 });
    expect(quarter).not.toBe(STAGE.width / 4);
  });

  it('clamps a point in the letterbox to the picture’s edge', () => {
    expect(clientPointToFrame({ x: 100, y: 450 }, PORTRAIT)).toEqual({ x: 0, y: 0.5 });
    expect(clientPointToFrame({ x: 1590, y: -20 }, PORTRAIT)).toEqual({ x: 1, y: 0 });
    expect(clientPointToFrame({ x: 800, y: 5000 }, PORTRAIT)).toEqual({ x: 0.5, y: 1 });
  });

  it('follows a zoomed and panned monitor: the frame box is bigger than the stage and offset', () => {
    // 200% zoom of a 1280 × 720 fit, scrolled so the stage shows the picture's middle.
    const zoomed: FrameRect = { left: -640, top: -360, width: 2560, height: 1440 };
    expect(clientPointToFrame({ x: 640, y: 360 }, zoomed)).toEqual({ x: 0.5, y: 0.5 });
    // 100 client pixels are 100 / 2560 of the picture at this zoom, not 100 / 1280.
    expect(clientPointToFrame({ x: 740, y: 360 }, zoomed)).toEqual({ x: 0.5390625, y: 0.5 });
    // Zoomed out to 50%, the picture floats in the stage, and the letterbox around it clamps.
    const small: FrameRect = { left: 480, top: 270, width: 640, height: 360 };
    expect(clientPointToFrame({ x: 640, y: 360 }, small)).toEqual({ x: 0.25, y: 0.25 });
    expect(clientPointToFrame({ x: 20, y: 20 }, small)).toEqual({ x: 0, y: 0 });
  });

  it('has no answer before the frame is laid out', () => {
    expect(clientPointToFrame({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toBe(
      null,
    );
    expect(
      clientPointToFrame({ x: 10, y: 10 }, { left: 0, top: 0, width: Number.NaN, height: 9 }),
    ).toBe(null);
    expect(clientPointToFrame({ x: Number.NaN, y: 10 }, PORTRAIT)).toBe(null);
  });
});

describe('the placement units', () => {
  it('gives a shape its centre as a percent of each axis', () => {
    expect(shapeAtForFramePoint({ x: 0.5, y: 0.5 })).toEqual({ x: 50, y: 50 });
    expect(shapeAtForFramePoint({ x: 0.3, y: 0.4 })).toEqual({ x: 30, y: 40 });
    // Tidy numbers in the project file, far finer than a pixel on any frame.
    expect(shapeAtForFramePoint({ x: 1 / 3, y: 2 / 3 })).toEqual({ x: 33.33, y: 66.67 });
  });

  it('gives a sticker its offset in canvas pixels from the frame centre, on a vertical frame', () => {
    expect(stickerOffsetForFramePoint({ x: 0.5, y: 0.5 }, VERTICAL)).toEqual({ x: 0, y: 0 });
    expect(stickerOffsetForFramePoint({ x: 0.25, y: 0.75 }, VERTICAL)).toEqual({ x: -270, y: 480 });
    expect(stickerOffsetForFramePoint({ x: 0, y: 1 }, VERTICAL)).toEqual({ x: -540, y: 960 });
  });

  it('puts a drop on a letterboxed monitor where it was dropped, end to end', () => {
    const point = clientPointToFrame({ x: PORTRAIT.left + PORTRAIT.width / 4, y: 675 }, PORTRAIT)!;
    expect(stickerOffsetForFramePoint(point, VERTICAL)).toEqual({ x: -270, y: 480 });
    expect(shapeAtForFramePoint(point)).toEqual({ x: 25, y: 75 });
  });
});
