import { describe, expect, it } from 'vitest';
import type { MaskPathVertex } from './mask-geometry.js';
import {
  constrainToAngle,
  cubicPoint,
  dragBox,
  dragTangent,
  frameSnapLines,
  hitTangent,
  hitVertex,
  identityTransform,
  moveVertices,
  nearestPointOnPath,
  rectFromCorners,
  segmentControlPoints,
  snapPoint,
  toggleVertexSmooth,
  transformPoint,
  transformVertices,
  verticesBounds,
  verticesInRect,
} from './mask-path-editing.js';

const corner = (x: number, y: number): MaskPathVertex => ({
  x,
  y,
  inX: 0,
  inY: 0,
  outX: 0,
  outY: 0,
  type: 'corner',
});

const square: MaskPathVertex[] = [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)];

describe('nearestPointOnPath', () => {
  it('finds the segment and parameter under a click, sub-pixel', () => {
    const hit = nearestPointOnPath(square, { x: 37.25, y: 3 })!;
    expect(hit.segment).toBe(0);
    // A zero-tangent cubic is not arc-length parameterised; `t` is whatever lands on the
    // point, which is the parameter insert_mask_vertex splits at.
    const onCurve = cubicPoint(segmentControlPoints(square, 0), hit.t);
    expect(onCurve.x).toBeCloseTo(37.25, 6);
    expect(hit.point.x).toBeCloseTo(37.25, 6);
    expect(hit.point.y).toBeCloseTo(0, 9);
    expect(hit.distance).toBeCloseTo(3, 6);
  });

  it('follows curved segments', () => {
    const curved = [
      { ...corner(0, 0), outX: 0, outY: -50 },
      { ...corner(100, 0), inX: 0, inY: -50 },
      corner(100, 100),
      corner(0, 100),
    ];
    const top = cubicPoint(segmentControlPoints(curved, 0), 0.5);
    const hit = nearestPointOnPath(curved, { x: top.x, y: top.y - 4 })!;
    expect(hit.segment).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 4);
    expect(hit.distance).toBeCloseTo(4, 4);
  });

  it('refuses a path with fewer than two vertices', () => {
    expect(nearestPointOnPath([corner(0, 0)], { x: 0, y: 0 })).toBeNull();
  });
});

describe('hit testing', () => {
  it('picks the nearest vertex inside the tolerance', () => {
    expect(hitVertex(square, { x: 98, y: 2 }, 5)).toBe(1);
    expect(hitVertex(square, { x: 50, y: 50 }, 5)).toBe(-1);
  });

  it('hits only visible, non-zero tangent handles of candidate vertices', () => {
    const path = [{ ...corner(0, 0), outX: 20, outY: 0 }, corner(100, 0), corner(50, 80)];
    expect(hitTangent(path, [0], { x: 21, y: 1 }, 4)).toEqual({ vertex: 0, side: 'out' });
    expect(hitTangent(path, [1], { x: 21, y: 1 }, 4)).toBeNull();
    expect(hitTangent(path, [0], { x: 0, y: 0 }, 4)).toBeNull();
  });
});

describe('moving and transforming', () => {
  it('moves only the chosen vertices, tangents riding along', () => {
    const moved = moveVertices(square, new Set([1, 2]), 10.5, -2.25);
    expect(moved[0]).toBe(square[0]);
    expect(moved[1]).toMatchObject({ x: 110.5, y: -2.25 });
    expect(moved[2]).toMatchObject({ x: 110.5, y: 97.75 });
  });

  it('scales and rotates about an anchor, rotating tangents but never translating them', () => {
    const path = [{ ...corner(10, 0), outX: 5, outY: 0 }, corner(0, 10), corner(-10, 0)];
    const rotated = transformVertices(path, null, {
      ...identityTransform({ x: 0, y: 0 }),
      rotation: 90,
      scaleX: 2,
      scaleY: 2,
    });
    expect(rotated[0]!.x).toBeCloseTo(0, 9);
    expect(rotated[0]!.y).toBeCloseTo(20, 9);
    expect(rotated[0]!.outX).toBeCloseTo(0, 9);
    expect(rotated[0]!.outY).toBeCloseTo(10, 9);
  });

  it('translates through transformPoint and keeps unselected vertices', () => {
    const transform = { ...identityTransform({ x: 50, y: 50 }), translateX: 3, translateY: 4 };
    expect(transformPoint({ x: 0, y: 0 }, transform)).toEqual({ x: 3, y: 4 });
    const partial = transformVertices(square, new Set([0]), transform);
    expect(partial[1]).toBe(square[1]);
  });
});

describe('tangents and vertex types', () => {
  const smooth: MaskPathVertex[] = [
    { x: 50, y: 0, inX: -10, inY: 0, outX: 30, outY: 0, type: 'smooth' },
    corner(100, 100),
    corner(0, 100),
  ];

  it('mirrors a smooth vertex opposite tangent, keeping its own length', () => {
    const dragged = dragTangent(smooth, 0, 'out', { x: 0, y: 40 }, false);
    expect(dragged[0]).toMatchObject({ outX: 0, outY: 40, type: 'smooth' });
    expect(dragged[0]!.inX).toBeCloseTo(0, 9);
    expect(dragged[0]!.inY).toBeCloseTo(-10, 9);
  });

  it('breaks the tangents with Alt', () => {
    const dragged = dragTangent(smooth, 0, 'in', { x: 0, y: -5 }, true);
    expect(dragged[0]).toMatchObject({ inX: 0, inY: -5, outX: 30, outY: 0, type: 'broken' });
  });

  it('converts corner to smooth with neighbour-parallel tangents and back', () => {
    const smoothed = toggleVertexSmooth(square, 1);
    expect(smoothed[1]!.type).toBe('smooth');
    // Neighbours (0,0) and (100,100): direction (1,1)/√2, lengths 100/3.
    expect(smoothed[1]!.outX).toBeCloseTo(100 / 3 / Math.SQRT2, 9);
    expect(smoothed[1]!.inY).toBeCloseTo(-100 / 3 / Math.SQRT2, 9);
    const cornered = toggleVertexSmooth(smoothed, 1);
    expect(cornered[1]).toEqual(corner(100, 0));
  });
});

describe('constrainToAngle (Shift pen segments)', () => {
  it('snaps a segment to the nearest 45° keeping the projected length', () => {
    expect(constrainToAngle({ x: 0, y: 0 }, { x: 100, y: 8 })).toEqual({ x: 100, y: 0 });
    const diagonal = constrainToAngle({ x: 10, y: 10 }, { x: 60, y: 55 });
    expect(diagonal.x - 10).toBeCloseTo(diagonal.y - 10, 9);
    expect(constrainToAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    expect(constrainToAngle({ x: 0, y: 0 }, { x: -3, y: -90 })).toEqual({ x: 0, y: -90 });
  });
});

describe('boxes and marquee', () => {
  it('builds a drag box from a corner, square with Shift, centred with Alt', () => {
    expect(dragBox({ x: 10, y: 10 }, { x: 30, y: 50 })).toEqual({
      cx: 20,
      cy: 30,
      width: 20,
      height: 40,
    });
    expect(dragBox({ x: 10, y: 10 }, { x: 30, y: -30 }, { square: true })).toEqual({
      cx: 30,
      cy: -10,
      width: 40,
      height: 40,
    });
    expect(dragBox({ x: 10, y: 10 }, { x: 15, y: 20 }, { fromCentre: true })).toEqual({
      cx: 10,
      cy: 10,
      width: 10,
      height: 20,
    });
  });

  it('selects vertices inside a marquee and bounds a selection', () => {
    const rect = rectFromCorners({ x: 120, y: -5 }, { x: 50, y: 105 });
    expect([...verticesInRect(square, rect)].sort()).toEqual([1, 2]);
    expect(verticesBounds(square, new Set([1, 2]))).toEqual({
      x: 100,
      y: 0,
      width: 0,
      height: 100,
    });
    expect(verticesBounds(square, new Set())).toBeNull();
  });
});

describe('snapPoint', () => {
  const lines = frameSnapLines({ width: 1920, height: 1080 });

  it('prefers another mask vertex over lines', () => {
    const snapped = snapPoint({ x: 958, y: 500 }, { ...lines, points: [{ x: 955, y: 502 }] }, 6);
    expect(snapped.point).toEqual({ x: 955, y: 502 });
    expect(snapped.target).toEqual({ x: 955, y: 502 });
  });

  it('snaps each axis to frame edges and centre independently', () => {
    const snapped = snapPoint({ x: 963, y: 3.5 }, { ...lines, points: [] }, 6);
    expect(snapped.point).toEqual({ x: 960, y: 0 });
    expect(snapped).toMatchObject({ guideX: 960, guideY: 0, target: null });
    const free = snapPoint({ x: 400.25, y: 300.75 }, { ...lines, points: [] }, 6);
    expect(free.point).toEqual({ x: 400.25, y: 300.75 });
  });
});
