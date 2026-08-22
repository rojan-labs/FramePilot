/**
 * Tests for crop-as-the-render-does-it.
 *
 * The case that matters is the one a real run hit: a 9:16 slice of a 16:9 source in a 9:16
 * frame must FILL, because that is what the export produces. Masking it in place is what made
 * the editor report "extremely many black spaces around" a picture that would have exported
 * full-bleed — and made the agent write compensating zoom into the project.
 */
import { describe, expect, it } from 'vitest';
import { cropFillPlacement, cropObjectPosition } from './crop-fill.js';

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 };

describe('cropFillPlacement', () => {
  it('fills a 9:16 frame with a full-height 9:16 slice of a 16:9 source', () => {
    // 640x360 cropped to width 0.3164 (= 9/16 ÷ 16/9) at full height — the vertical-reframe
    // workflow's own arithmetic, and the exact numbers from the captured run.
    const { source, destination } = cropFillPlacement(640, 360, 1080, 1920, {
      x: 0.3418,
      y: 0,
      width: 0.3164,
      height: 1,
    });
    expect(source.width).toBeCloseTo(202.5, 1);
    expect(source.height).toBe(360);
    // Within a pixel of the full canvas in both axes: no letterbox, no pillarbox.
    expect(destination.height).toBeCloseTo(1920, 0);
    expect(destination.width).toBeGreaterThan(1070);
    expect(destination.x).toBeLessThan(6);
    expect(destination.y).toBeCloseTo(0, 5);
  });

  it('reads the crop from the right place in the source', () => {
    const { source } = cropFillPlacement(1000, 500, 100, 100, {
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
    expect(source).toEqual({ x: 250, y: 250, width: 500, height: 250 });
  });

  it('still letterboxes a crop whose aspect does not match the frame', () => {
    // Fit, not cover: the engine centres a mismatched crop rather than showing pixels the
    // export would drop, so the monitor must do the same.
    const { destination } = cropFillPlacement(1000, 1000, 200, 100, FULL_FRAME);
    expect(destination.width).toBe(100);
    expect(destination.height).toBe(100);
    expect(destination.x).toBe(50);
  });

  it('is the plain fitted frame when nothing is cropped', () => {
    const { source, destination } = cropFillPlacement(1920, 1080, 960, 540, FULL_FRAME);
    expect(source).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(destination).toEqual({ x: 0, y: 0, width: 960, height: 540 });
  });
});

describe('cropObjectPosition', () => {
  it('centres a centred crop and pins the edges of an edge crop', () => {
    expect(cropObjectPosition({ x: 0.3418, y: 0, width: 0.3164, height: 1 })[0]).toBeCloseTo(
      50,
      0,
    );
    expect(cropObjectPosition({ x: 0, y: 0, width: 0.5, height: 1 })[0]).toBe(0);
    expect(cropObjectPosition({ x: 0.5, y: 0, width: 0.5, height: 1 })[0]).toBe(100);
  });

  it('centres the axis a crop does not narrow', () => {
    // Full height means no vertical travel: 50% is the only honest answer.
    expect(cropObjectPosition({ x: 0.25, y: 0, width: 0.5, height: 1 })[1]).toBe(50);
  });

  it('clamps a crop that runs past the frame instead of drifting off it', () => {
    expect(cropObjectPosition({ x: 0.9, y: 0, width: 0.5, height: 1 })[0]).toBe(100);
    expect(cropObjectPosition({ x: -0.2, y: 0, width: 0.5, height: 1 })[0]).toBe(0);
  });
});
