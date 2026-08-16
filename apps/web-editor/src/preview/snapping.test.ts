/**
 * Canvas snapping (revamp Phase 3). Pure geometry, so this is where the magnet's
 * behaviour is actually pinned down — the component test only proves the wiring.
 */
import { describe, expect, it } from 'vitest';
import { normalizeRotation, snapAxis, snapRotation, snapTransform } from './snapping.js';

/** A 1920-wide axis, so thirds land on 640/1280 and the centre on 960. */
const FRAME = 1920;
const RESOLUTION = { width: 1920, height: 1080 };

describe('snapAxis', () => {
  it('pulls a near-centred box to dead centre', () => {
    const snap = snapAxis(20, FRAME, FRAME, 50);
    expect(snap.offset).toBe(0);
    expect(snap.guide).toBe(0.5);
    expect(snap.kind).toBe('center');
  });

  it('pulls onto a rule-of-thirds line', () => {
    // Box centre on the left third = offset −frameSize/6 = −320.
    const left = snapAxis(-310, FRAME, FRAME, 50);
    expect(left.offset).toBeCloseTo(-320, 10);
    expect(left.guide).toBeCloseTo(1 / 3, 10);
    expect(left.kind).toBe('third');

    const right = snapAxis(330, FRAME, FRAME, 50);
    expect(right.offset).toBeCloseTo(320, 10);
    expect(right.guide).toBeCloseTo(2 / 3, 10);
  });

  it('pulls a scaled-down box flush to an edge', () => {
    // A half-size box (960 wide) is flush left at offset 960/2 − 1920/2 = −480.
    const flushLeft = snapAxis(-470, 960, FRAME, 50);
    expect(flushLeft.offset).toBe(-480);
    expect(flushLeft.guide).toBe(0);
    expect(flushLeft.kind).toBe('edge');

    const flushRight = snapAxis(470, 960, FRAME, 50);
    expect(flushRight.offset).toBe(480);
    expect(flushRight.guide).toBe(1);
  });

  it('tracks the zoom: the flush-edge target moves with the box size', () => {
    // Why edge targets are derived from boxSize rather than being fixed. From the
    // SAME offset, a half-size box is a hair from flush-left (−480) and snaps,
    // while a full-size box has no target anywhere near (its flush-left IS centre,
    // at 0) and is left alone.
    expect(snapAxis(-475, 960, FRAME, 20)).toMatchObject({ offset: -480, kind: 'edge' });
    expect(snapAxis(-475, FRAME, FRAME, 20)).toMatchObject({ offset: -475, kind: null });
  });

  it('leaves the offset alone when nothing is in range', () => {
    const snap = snapAxis(100, FRAME, FRAME, 10);
    expect(snap.offset).toBe(100);
    expect(snap.guide).toBeNull();
    expect(snap.kind).toBeNull();
  });

  it('prefers the stronger alignment on a tie', () => {
    // Centre (offset 0) and the left third (−320) are equidistant from −160.
    // Centre must win: it is the stronger compositional alignment.
    expect(snapAxis(-160, FRAME, FRAME, 500).kind).toBe('center');
  });

  it('picks the nearest when several are in range', () => {
    expect(snapAxis(-300, FRAME, FRAME, 500).offset).toBeCloseTo(-320, 10);
  });

  it('is disabled by a negative tolerance (the defeat key)', () => {
    const snap = snapAxis(5, FRAME, FRAME, -1);
    expect(snap.offset).toBe(5);
    expect(snap.guide).toBeNull();
  });

  it('still snaps at zero tolerance for an exact hit', () => {
    expect(snapAxis(0, FRAME, FRAME, 0).kind).toBe('center');
  });

  it('has nothing to align to in a degenerate frame', () => {
    const snap = snapAxis(10, 100, 0, 50);
    expect(snap.offset).toBe(10);
    expect(snap.guide).toBeNull();
  });
});

describe('snapTransform', () => {
  it('snaps X and Y INDEPENDENTLY', () => {
    // The point of per-axis snapping: centred horizontally while flush to the
    // bottom edge is a real composition, and a single combined snap cannot express it.
    const result = snapTransform({ scale: 0.5, x: 8, y: 265 }, RESOLUTION, 40);
    expect(result.values.x).toBe(0);
    expect(result.guideX).toBe(0.5);
    // A half-size box is flush bottom at 1080/2 − 540/2 = 270.
    expect(result.values.y).toBe(270);
    expect(result.guideY).toBe(1);
  });

  it('never touches scale', () => {
    // There is no "correct" zoom the way there is a correct centre, and a magnet
    // on scale would fight the corner handles for no benefit.
    const result = snapTransform({ scale: 1.03, x: 0, y: 0 }, RESOLUTION, 40);
    expect(result.values.scale).toBe(1.03);
  });

  it('reports no guides when neither axis snapped', () => {
    const result = snapTransform({ scale: 1, x: 400, y: 300 }, RESOLUTION, 10);
    expect(result.values).toEqual({ scale: 1, x: 400, y: 300 });
    expect(result.guideX).toBeNull();
    expect(result.guideY).toBeNull();
  });

  it('can snap one axis and leave the other free', () => {
    const result = snapTransform({ scale: 1, x: 5, y: 400 }, RESOLUTION, 20);
    expect(result.values.x).toBe(0);
    expect(result.guideX).toBe(0.5);
    expect(result.values.y).toBe(400);
    expect(result.guideY).toBeNull();
  });
});

describe('snapRotation', () => {
  it('rounds to whole increments', () => {
    expect(snapRotation(7, 15)).toBe(0);
    expect(snapRotation(8, 15)).toBe(15);
    expect(snapRotation(-38, 15)).toBe(-45);
    expect(snapRotation(90, 15)).toBe(90);
  });

  it('passes through for a non-positive step', () => {
    expect(snapRotation(7.3, 0)).toBe(7.3);
    expect(snapRotation(7.3, -15)).toBe(7.3);
  });
});

describe('normalizeRotation', () => {
  it('wraps into (−180, 180] so a readout never shows 725°', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(181)).toBe(-179);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(725)).toBe(5);
    expect(normalizeRotation(-90)).toBe(-90);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(-725)).toBe(-5);
  });

  it('treats a non-finite angle as no rotation', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
