/**
 * MK8.1: the split, mirror and gradient handles — where they sit and what a drag on each changes.
 */
import { describe, expect, it } from 'vitest';
import { MaskLayerSchema } from '@framepilot/timeline-schema';
import {
  analyticDrawGeometry,
  analyticGuides,
  analyticHandlePoints,
  analyticValuesAt,
  dragAnalyticHandle,
  hitsAnalyticMask,
  type AnalyticMaskLayer,
} from './analytic-mask-handles';

const PICTURE = { width: 1920, height: 1080 };

describe('analytic draw geometry', () => {
  it('lays a split along the drag, level for a click, and snaps to 15° with Shift', () => {
    expect(
      analyticDrawGeometry('split', { x: 100, y: 100 }, { x: 200, y: 200 }, PICTURE, {
        constrain: false,
        radial: false,
      }),
    ).toMatchObject({ kind: 'linear', originX: 100, originY: 100, angle: 45 });
    expect(
      analyticDrawGeometry('split', { x: 100, y: 100 }, { x: 100.5, y: 100 }, PICTURE, {
        constrain: false,
        radial: false,
      }),
    ).toMatchObject({ angle: 0 });
    expect(
      analyticDrawGeometry('split', { x: 0, y: 0 }, { x: 100, y: 30 }, PICTURE, {
        constrain: true,
        radial: false,
      }),
    ).toMatchObject({ angle: 15 });
  });

  it('starts a mirror band a quarter of the smaller side wide', () => {
    expect(
      analyticDrawGeometry('mirror', { x: 960, y: 540 }, { x: 960, y: 540 }, PICTURE, {
        constrain: false,
        radial: false,
      }),
    ).toMatchObject({ kind: 'band', widthPx: 270, angle: 0 });
  });

  it('runs a gradient from press to release and refuses a click', () => {
    expect(
      analyticDrawGeometry('gradient', { x: 10, y: 20 }, { x: 110, y: 20 }, PICTURE, {
        constrain: false,
        radial: true,
      }),
    ).toMatchObject({ kind: 'gradient', shape: 'radial', startX: 10, endX: 110, curve: 'smooth' });
    expect(
      analyticDrawGeometry('gradient', { x: 10, y: 20 }, { x: 10, y: 20 }, PICTURE, {
        constrain: false,
        radial: false,
      }),
    ).toBeNull();
  });
});

describe('analytic handles', () => {
  const base = { originX: 500, originY: 400, angle: 0, widthPx: 200, softnessPx: 40 };

  it('places the band edges either side of the centre line and the softness beyond them', () => {
    const points = Object.fromEntries(
      analyticHandlePoints('band', base, 60).map(({ handle, point }) => [handle, point]),
    );
    expect(points.origin).toEqual({ x: 500, y: 400 });
    expect(points.rotate).toEqual({ x: 560, y: 400 });
    // Angle 0: the normal points down (the cut-away side of a split), so the far edge is below.
    expect(points['edge-far']).toEqual({ x: 500, y: 500 });
    expect(points['edge-near']).toEqual({ x: 500, y: 300 });
    expect(points.softness).toEqual({ x: 440, y: 520 });
  });

  it('turns drags into the fields each handle owns', () => {
    const start = { x: 500, y: 400 };
    expect(dragAnalyticHandle('band', 'origin', base, start, { x: 510, y: 395 }, false)).toEqual({
      originX: 510,
      originY: 395,
    });
    expect(
      dragAnalyticHandle('band', 'rotate', base, start, { x: 500, y: 500 }, false),
    ).toEqual({ angle: 90 });
    expect(
      dragAnalyticHandle('band', 'rotate', base, start, { x: 600, y: 420 }, true),
    ).toEqual({ angle: 15 });
    expect(
      dragAnalyticHandle('band', 'edge-near', base, start, { x: 500, y: 250 }, false),
    ).toEqual({ widthPx: 300 });
    expect(
      dragAnalyticHandle('band', 'softness', base, start, { x: 0, y: 530 }, false),
    ).toEqual({ softnessPx: 60 });
    expect(
      dragAnalyticHandle('linear', 'softness', base, start, { x: 0, y: 300 }, false),
    ).toEqual({ softnessPx: 0 });
    const gradient = { startX: 0, startY: 0, endX: 100, endY: 0 };
    expect(
      dragAnalyticHandle('gradient', 'body', gradient, { x: 50, y: 0 }, { x: 60, y: 5 }, false),
    ).toEqual({ startX: 10, startY: 5, endX: 110, endY: 5 });
  });

  it('draws guides and hit-tests the lines', () => {
    const { lines } = analyticGuides('band', base, 5000, false);
    expect(lines.filter((line) => line.role === 'edge')).toHaveLength(2);
    expect(lines.filter((line) => line.role === 'soft')).toHaveLength(4);
    expect(hitsAnalyticMask('band', base, { x: 1200, y: 503 }, 5, 5000)).toBe(true);
    expect(hitsAnalyticMask('band', base, { x: 1200, y: 400 }, 5, 5000)).toBe(false);
    const radial = analyticGuides('gradient', { startX: 0, startY: 0, endX: 30, endY: 40 }, 1, true);
    expect(radial.circle).toEqual({ cx: 0, cy: 0, r: 50 });
  });

  it('reads keyframed values at the source instant, with a live drag laid over them', () => {
    const mask = MaskLayerSchema.parse({
      id: 'm',
      kind: 'linear',
      originX: 10,
      originY: 20,
      keyframes: [
        { id: 'a', sourceTime: 0, property: 'angle', value: 0 },
        { id: 'b', sourceTime: 2, property: 'angle', value: 90 },
      ],
    }) as AnalyticMaskLayer;
    expect(analyticValuesAt(mask, 1, null)).toMatchObject({ originX: 10, angle: 45 });
    expect(analyticValuesAt(mask, 1, { originX: 99 })).toMatchObject({ originX: 99, angle: 45 });
  });
});
