/**
 * Shape handle geometry (plan/elements EL4a): what a drag does to a shape's params, including
 * under the clip's rotation and scale.
 */
import { describe, expect, it } from 'vitest';
import { presetShapeParams } from '@framepilot/timeline-schema';
import {
  boxDragChanges,
  boxRect,
  segmentDragChanges,
  shapeHitRect,
  shapePivot,
  toShapeDelta,
} from './shape-handles.js';

const ASPECT = 16 / 9;
const box = {
  ...presetShapeParams('rounded-rect/highlight')!,
  x: 50,
  y: 50,
  width: 36,
  height: 20,
};
const arrow = presetShapeParams('line-arrow/red', { x: 60, y: 40 })!;

describe('boxRect', () => {
  it('turns a height-relative box into percent of each frame axis', () => {
    // 36% of the height is 20.25% of a 16:9 width.
    expect(boxRect(box, ASPECT)).toEqual({ left: 39.875, top: 40, width: 20.25, height: 20 });
  });
});

describe('boxDragChanges', () => {
  it('moves the centre with the body', () => {
    expect(boxDragChanges(box, 'move', 5, -10, ASPECT)).toEqual({ x: 55, y: 40 });
  });

  it('resizes from a side and keeps the opposite side put', () => {
    const changes = boxDragChanges(box, 'e', 10, 0, ASPECT);
    const before = boxRect(box, ASPECT);
    const after = boxRect({ ...box, ...changes }, ASPECT);
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(after.width).toBeCloseTo(before.width + 10, 1);
    expect(changes.height).toBe(20);
  });

  it('resizes from a corner on both axes', () => {
    const changes = boxDragChanges(box, 'nw', -5, -5, ASPECT);
    expect(changes.height).toBe(25);
    expect(changes.y).toBe(47.5);
  });

  it('never flips or shrinks a box below the minimum', () => {
    const changes = boxDragChanges(box, 'e', -500, 0, ASPECT);
    expect(changes.width).toBeCloseTo(0.1, 2);
  });

  it('keeps the centre on the frame', () => {
    expect(boxDragChanges(box, 'move', 500, 500, ASPECT)).toEqual({ x: 100, y: 100 });
  });
});

describe('segmentDragChanges', () => {
  it('moves one end, or both', () => {
    expect(segmentDragChanges(arrow, 'end', 5, 5)).toEqual({ x2: 65, y2: 45 });
    expect(segmentDragChanges(arrow, 'start', -5, 0)).toEqual({ x1: 43, y1: 28 });
    expect(segmentDragChanges(arrow, 'move', 1, 1)).toEqual({ x1: 49, y1: 29, x2: 61, y2: 41 });
  });

  it('lets an end leave the frame, within the schema’s reach', () => {
    expect(segmentDragChanges(arrow, 'start', -500, 0).x1).toBe(-50);
  });
});

describe('toShapeDelta', () => {
  it('is a plain percentage with no transform', () => {
    expect(toShapeDelta(128, -72, 1280, 720, 0, 1)).toEqual({ dx: 10, dy: -10 });
  });

  it('undoes the clip’s scale', () => {
    expect(toShapeDelta(128, 0, 1280, 720, 0, 2).dx).toBeCloseTo(5, 10);
  });

  it('undoes a quarter turn: dragging up moves along the shape’s own x axis', () => {
    // A shape turned 90° counter-clockwise has its x axis pointing up the screen.
    const delta = toShapeDelta(0, -128, 1280, 720, 90, 1);
    expect(delta.dx).toBeCloseTo(10, 10);
    expect(delta.dy).toBeCloseTo(0, 10);
  });
});

describe('pivot and hit area', () => {
  it('turns a box about its centre and a segment about its midpoint', () => {
    expect(shapePivot(box)).toEqual({ x: 50, y: 50 });
    expect(shapePivot(arrow)).toEqual({ x: 54, y: 34 });
  });

  it('makes a thin line easy to hit', () => {
    const flat = { ...arrow, y1: 40, y2: 40 };
    expect(shapeHitRect(flat, ASPECT).height).toBeGreaterThan(4);
  });
});
