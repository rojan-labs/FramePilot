/**
 * Picture transform (revamp Phase 3) — the preview↔export parity arithmetic.
 *
 * The rotation-sign case is the reason this module was extracted. The canvas
 * compositor is only checkable in a real browser (jsdom has no
 * `CanvasRenderingContext2D`), which is the right place to check pixels and the
 * wrong place to discover that a sign is inverted.
 */
import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@framepilot/timeline-schema';
import {
  NO_TRANSITION,
  baseTransformOf,
  pictureTransformAt,
  rotationToCanvasRadians,
  rotationToCssDegrees,
  withBaseTransform,
} from './picture-transform.js';

const CANVAS = { width: 1280, height: 720 };
const RESOLUTION = { width: 1920, height: 1080 };

/** A static keyframe: one entry pins the property for the whole clip. */
const kf = (property: string, value: number, time = 0): Keyframe => ({
  id: `${property}@${time}`,
  time,
  property,
  value,
  easing: 'linear',
});

describe('rotationToCanvasRadians', () => {
  it('NEGATES: the project turns anticlockwise, the canvas clockwise', () => {
    // MoviePy's `rotated()` is anticlockwise-positive ("Rotates the specified clip
    // by angle degrees ... anticlockwise"); canvas `rotate()` is clockwise-positive
    // in a y-down space. Passing degrees through unnegated would rotate the preview
    // the OPPOSITE way from the export — a divergence that looks like it works.
    expect(rotationToCanvasRadians(90)).toBeCloseTo(-Math.PI / 2, 12);
    expect(rotationToCanvasRadians(-90)).toBeCloseTo(Math.PI / 2, 12);
    expect(rotationToCanvasRadians(180)).toBeCloseTo(-Math.PI, 12);
    expect(rotationToCanvasRadians(0)).toBe(-0);
  });
});

describe('pictureTransformAt', () => {
  it('is the identity for a clip with no keyframes', () => {
    const t = pictureTransformAt([], 0, CANVAS, RESOLUTION);
    expect(t).toEqual({ scale: 1, rotationRad: -0, alpha: 1, dxPx: 0, dyPx: 0 });
  });

  it('leaves un-keyframed properties alone (mirrors evaluate_clip_transform)', () => {
    // A clip animating only scale must not have its position, rotation or opacity
    // quietly moved off identity.
    const t = pictureTransformAt([kf('scale', 2)], 0, CANVAS, RESOLUTION);
    expect(t.scale).toBe(2);
    expect(t.rotationRad).toBe(-0);
    expect(t.alpha).toBe(1);
    expect(t.dxPx).toBe(0);
    expect(t.dyPx).toBe(0);
  });

  it('converts x/y from PROJECT pixels to this canvas pixels', () => {
    // The preview canvas is capped at CANVAS_MAX_EDGE, so it is smaller than the
    // project. A reframe expressed in project pixels must be scaled through, or it
    // would preview at the wrong magnitude — 1920→1280 is a 2/3 ratio.
    const t = pictureTransformAt([kf('x', 192), kf('y', 108)], 0, CANVAS, RESOLUTION);
    expect(t.dxPx).toBeCloseTo(128, 10);
    expect(t.dyPx).toBeCloseTo(72, 10);
  });

  it('passes offsets through 1:1 when canvas and project match', () => {
    const t = pictureTransformAt([kf('x', 100), kf('y', -50)], 0, CANVAS, CANVAS);
    expect(t.dxPx).toBe(100);
    expect(t.dyPx).toBe(-50);
  });

  it('yields no offset for a degenerate resolution rather than NaN', () => {
    // NaN in the context matrix silently blanks the whole frame instead of failing
    // visibly, so a corrupt project must not be able to produce one.
    const t = pictureTransformAt([kf('x', 100)], 0, CANVAS, { width: 0, height: 0 });
    expect(t.dxPx).toBe(0);
    expect(t.dyPx).toBe(0);
  });

  it('clamps opacity into [0,1], like the render mask does', () => {
    expect(pictureTransformAt([kf('opacity', 0.4)], 0, CANVAS, RESOLUTION).alpha).toBeCloseTo(
      0.4,
      10,
    );
    expect(pictureTransformAt([kf('opacity', 5)], 0, CANVAS, RESOLUTION).alpha).toBe(1);
    expect(pictureTransformAt([kf('opacity', -2)], 0, CANVAS, RESOLUTION).alpha).toBe(0);
  });

  it('interpolates every property at a time between keyframes', () => {
    const keyframes = [
      kf('scale', 1, 0),
      kf('scale', 3, 2),
      kf('rotation', 0, 0),
      kf('rotation', 90, 2),
      kf('opacity', 1, 0),
      kf('opacity', 0, 2),
    ];
    const t = pictureTransformAt(keyframes, 1, CANVAS, RESOLUTION);
    expect(t.scale).toBeCloseTo(2, 10);
    expect(t.rotationRad).toBeCloseTo(-Math.PI / 4, 10);
    expect(t.alpha).toBeCloseTo(0.5, 10);
  });

  describe('composing a transition on top', () => {
    it('multiplies the transition scale and opacity into the clip’s own', () => {
      const t = pictureTransformAt([kf('scale', 2), kf('opacity', 0.5)], 0, CANVAS, RESOLUTION, {
        scale: 1.5,
        offsetPx: [0, 0],
        opacity: 0.4,
      });
      expect(t.scale).toBeCloseTo(3, 10);
      // The export composes exactly this product into one alpha mask.
      expect(t.alpha).toBeCloseTo(0.2, 10);
    });

    it('adds the transition offset in CANVAS pixels, on top of the converted x/y', () => {
      // The transition envelope already works in canvas/target pixels (the export
      // applies it in target pixels the same way), so it must NOT be run through
      // the project→canvas conversion a second time.
      const t = pictureTransformAt([kf('x', 192)], 0, CANVAS, RESOLUTION, {
        scale: 1,
        offsetPx: [40, -10],
        opacity: 1,
      });
      expect(t.dxPx).toBeCloseTo(168, 10); // 128 converted + 40 raw
      expect(t.dyPx).toBeCloseTo(-10, 10);
    });

    it('clamps a transition opacity out of range', () => {
      const t = pictureTransformAt([], 0, CANVAS, RESOLUTION, {
        scale: 1,
        offsetPx: [0, 0],
        opacity: 3,
      });
      expect(t.alpha).toBe(1);
    });

    it('is unchanged by the steady-state contribution', () => {
      const withNone = pictureTransformAt([kf('scale', 2)], 0, CANVAS, RESOLUTION, NO_TRANSITION);
      const without = pictureTransformAt([kf('scale', 2)], 0, CANVAS, RESOLUTION);
      expect(withNone).toEqual(without);
    });
  });
});

describe('baseTransformOf', () => {
  it('is the identity for a clip with no keyframes', () => {
    expect(baseTransformOf([])).toEqual({ scale: 1, x: 0, y: 0, rotation: 0 });
  });

  it('reads TIME 0, not the playhead', () => {
    // Time 0 is what the handles edit and what setClipTransformPatch writes.
    // Reading at the playhead would make a drag on an animated clip silently
    // rewrite its start value to whatever the mid-animation value happened to be.
    const animated = [kf('scale', 1, 0), kf('scale', 3, 2)];
    expect(baseTransformOf(animated).scale).toBe(1);
  });

  it('picks up every handle-writable property', () => {
    const keyframes = [kf('scale', 2), kf('x', 10), kf('y', -20), kf('rotation', 45)];
    expect(baseTransformOf(keyframes)).toEqual({ scale: 2, x: 10, y: -20, rotation: 45 });
  });
});

describe('withBaseTransform', () => {
  it('replaces the time-0 transform', () => {
    const result = withBaseTransform([kf('scale', 1), kf('x', 5)], {
      scale: 2,
      x: 100,
      y: -50,
      rotation: 30,
    });
    // One keyframe per property at time 0 — exactly what the commit will write, so
    // the picture cannot jump on release.
    const at0 = result.filter((k) => k.time === 0);
    expect(at0.length).toBe(4);
    expect(at0.find((k) => k.property === 'scale')?.value).toBe(2);
    expect(at0.find((k) => k.property === 'x')?.value).toBe(100);
    expect(at0.find((k) => k.property === 'y')?.value).toBe(-50);
    expect(at0.find((k) => k.property === 'rotation')?.value).toBe(30);
  });

  it('defaults an omitted rotation to 0 rather than dropping the property', () => {
    const result = withBaseTransform([], { scale: 1, x: 0, y: 0 });
    expect(result.find((k) => k.property === 'rotation')?.value).toBe(0);
  });

  it('PRESERVES keyframes at other times, so animation still previews', () => {
    // Dragging the base transform of an animated clip must show the animation from
    // its new starting point, not flatten it.
    const animated = [kf('scale', 1, 0), kf('scale', 3, 2), kf('opacity', 0.5, 1)];
    const result = withBaseTransform(animated, { scale: 2, x: 0, y: 0 });
    expect(result.find((k) => k.property === 'scale' && k.time === 2)?.value).toBe(3);
    expect(result.find((k) => k.property === 'opacity' && k.time === 1)?.value).toBe(0.5);
  });

  it('leaves a non-transform property at time 0 alone', () => {
    // Only the four transform properties are the handles' business; a time-0
    // opacity keyframe belongs to something else and must survive.
    const result = withBaseTransform([kf('opacity', 0.3, 0)], { scale: 1, x: 0, y: 0 });
    expect(result.find((k) => k.property === 'opacity')?.value).toBe(0.3);
  });

  it('composites through pictureTransformAt exactly as the commit will', () => {
    // The end-to-end point of the helper: a drag override evaluates to the values
    // the user is dragging to.
    const overridden = withBaseTransform([], { scale: 1.5, x: 96, y: 0, rotation: 90 });
    const t = pictureTransformAt(overridden, 0, CANVAS, RESOLUTION);
    expect(t.scale).toBe(1.5);
    expect(t.dxPx).toBeCloseTo(64, 10);
    expect(t.rotationRad).toBeCloseTo(-Math.PI / 2, 10);
  });
});

describe('rotationToCssDegrees', () => {
  it('negates, and agrees with the canvas conversion', () => {
    expect(rotationToCssDegrees(30)).toBe(-30);
    expect(rotationToCssDegrees(-45)).toBe(45);
    // The two conversions must describe the same rotation, or the selection box
    // would sit at a different angle from the picture it frames.
    const degrees = 37;
    expect((rotationToCssDegrees(degrees) * Math.PI) / 180).toBeCloseTo(
      rotationToCanvasRadians(degrees),
      12,
    );
  });
});
