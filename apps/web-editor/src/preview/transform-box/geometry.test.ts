/**
 * The bounding box's math: zoom-correct pointer mapping, moves with snapping and axis lock,
 * resizes that keep aspect by default, stretch with Shift, anchor at the opposite handle or the
 * centre, follow a turned box's own axes, and never turn a layer inside out.
 */
import { describe, expect, it } from 'vitest';
import {
  type Box,
  boxCorners,
  moveBox,
  passedDragThreshold,
  pointerAngle,
  projectPerScreenPixel,
  resizeBox,
  resizeCursor,
  rotateBox,
  toProjectPoint,
} from './geometry.js';

const FRAME = { width: 1920, height: 1080 };
const LIMITS = { minSize: 10, maxSize: 20000 };
const box: Box = { cx: 960, cy: 540, width: 400, height: 200, rotation: 0 };

const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);

describe('toProjectPoint', () => {
  it('maps ten screen pixels to twenty project pixels on a half-size monitor', () => {
    const rect = { left: 100, top: 50, width: 960, height: 540 };
    const a = toProjectPoint({ x: 100, y: 50 }, rect, FRAME);
    const b = toProjectPoint({ x: 110, y: 50 }, rect, FRAME);
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b.x - a.x).toBe(20);
    expect(projectPerScreenPixel(rect, FRAME)).toBe(2);
  });

  it('maps one to one at 100 %', () => {
    const rect = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(toProjectPoint({ x: 37, y: 11 }, rect, FRAME)).toEqual({ x: 37, y: 11 });
  });
});

describe('passedDragThreshold', () => {
  it('ignores the tremor of a click and takes a real drag', () => {
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(false);
    expect(passedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(true);
  });
});

describe('moveBox', () => {
  it('moves by the pointer travel', () => {
    const { box: moved } = moveBox(box, { x: 30, y: -20 }, FRAME);
    expect(moved).toMatchObject({ cx: 990, cy: 520, width: 400, height: 200 });
  });

  it('locks to the dominant axis with Shift', () => {
    const { box: moved } = moveBox(box, { x: 40, y: 12 }, FRAME, { constrainAxis: true });
    expect(moved).toMatchObject({ cx: 1000, cy: 540 });
  });

  it('snaps the centre onto the frame centre and says so', () => {
    const { box: moved, guides } = moveBox({ ...box, cx: 900 }, { x: 50, y: 0 }, FRAME, {
      snapTolerance: 20,
    });
    expect(moved.cx).toBe(960);
    expect(guides.x).toBe(0.5);
  });

  it('snaps a box flush to an edge by its covered extent', () => {
    const { box: moved, guides } = moveBox(box, { x: -752, y: 0 }, FRAME, { snapTolerance: 20 });
    close(moved.cx - moved.width / 2, 0);
    expect(guides.x).toBe(0);
  });
});

describe('resizeBox', () => {
  const uniform = { uniform: true, fromCenter: false, limits: LIMITS };
  const free = { uniform: false, fromCenter: false, limits: LIMITS };

  it('keeps the aspect from a corner, anchored at the opposite corner', () => {
    // se handle dragged from (1160, 640) to (1360, 700): x ratio 1.5, y ratio 1.3 → 1.5.
    const next = resizeBox(box, 'se', { x: 1360, y: 700 }, uniform);
    close(next.width, 600);
    close(next.height, 300);
    // The nw corner did not move.
    const [nw] = boxCorners(next);
    close(nw!.x, 760);
    close(nw!.y, 440);
  });

  it('stretches freely with Shift', () => {
    const next = resizeBox(box, 'se', { x: 1360, y: 700 }, free);
    close(next.width, 600);
    close(next.height, 260);
  });

  it('keeps the aspect from an edge by default and grows about the edge midpoint', () => {
    const next = resizeBox(box, 'e', { x: 1360, y: 999 }, uniform);
    close(next.width, 600);
    close(next.height, 300);
    close(next.cy, 540);
    close(next.cx - next.width / 2, 760);
  });

  it('stretches one axis from an edge with Shift', () => {
    const next = resizeBox(box, 'n', { x: 0, y: 340 }, free);
    close(next.width, 400);
    close(next.height, 300);
    close(next.cy + next.height / 2, 640);
  });

  it('resizes about the centre with Alt', () => {
    const next = resizeBox(box, 'e', { x: 1260, y: 540 }, { ...free, fromCenter: true });
    close(next.width, 600);
    close(next.cx, 960);
  });

  it('never turns the box inside out: past the anchor it stops at the minimum', () => {
    const next = resizeBox(box, 'se', { x: 100, y: 100 }, free);
    expect(next.width).toBe(10);
    expect(next.height).toBe(10);
    const [nw] = boxCorners(next);
    close(nw!.x, 760);
    close(nw!.y, 440);
  });

  it('holds the aspect at the minimum too', () => {
    const next = resizeBox(box, 'se', { x: 100, y: 100 }, uniform);
    close(next.height, 10);
    close(next.width, 20);
  });

  it("pulls along a turned box's own axes", () => {
    // Turned 90° anticlockwise: its local east edge points up on screen.
    const turned: Box = { ...box, rotation: 90 };
    const next = resizeBox(turned, 'e', { x: 960, y: 540 - 300 }, free);
    close(next.width, 500);
    close(next.height, 200);
    // The west edge (now at the bottom, y = 740) stayed put; the centre moved up by 50.
    close(next.cx, 960);
    close(next.cy, 490);
  });
});

describe('rotateBox', () => {
  it('turns anticlockwise when the hand sweeps anticlockwise on screen', () => {
    const start = pointerAngle(box, { x: 1060, y: 540 });
    const now = pointerAngle(box, { x: 960, y: 440 }); // a quarter turn anticlockwise
    close(rotateBox(box, start, now, false).rotation, 90);
  });

  it('snaps to 15° with Shift', () => {
    const next = rotateBox(box, 0, (-37 * Math.PI) / 180, true);
    expect(next.rotation).toBe(30);
  });

  it('does not jump when the sweep crosses ±180°', () => {
    const next = rotateBox(
      { ...box, rotation: 170 },
      (179 * Math.PI) / 180,
      (-179 * Math.PI) / 180,
      false,
    );
    close(next.rotation, 168);
  });
});

describe('resizeCursor', () => {
  it('names the double arrow each handle pulls along', () => {
    expect(resizeCursor('e', 0)).toBe('ew-resize');
    expect(resizeCursor('s', 0)).toBe('ns-resize');
    expect(resizeCursor('se', 0)).toBe('nwse-resize');
    expect(resizeCursor('ne', 0)).toBe('nesw-resize');
  });

  it('turns with the box', () => {
    expect(resizeCursor('e', 90)).toBe('ns-resize');
    expect(resizeCursor('e', 45)).toBe('nesw-resize');
  });
});
