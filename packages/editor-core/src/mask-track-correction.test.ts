/**
 * MK7.7: a correction on a tracked mask, and how it combines with the track.
 *
 * Both renderers draw a tracked mask as `T(t) · G(t)`. A correction is a keyframe of `G` stored
 * relative to the track, and a re-track from it continues from `T(c)`; these tests pin that the
 * editor's on-screen geometry is what renders on the corrected frame, that the rest of the
 * animation is untouched, and that every edit is one reversible patch.
 */
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type Timeline,
} from '@framepilot/timeline-schema';
import { compileMaskCommand, maskGeometryAt, type MaskCommand } from './mask-commands.js';
import { encodeMaskPath, type MaskPathVertex } from './mask-geometry.js';
import { trackWarpPoint, type TrackArtifact, type TrackMatrix } from './mask-track.js';
import { correctionSpan, trackGeometry, untrackGeometry } from './mask-track-correction.js';
import {
  anchorOnConstraint,
  mergeTrackSegments,
  trackStateAt,
  type TrackStateAt,
} from './mask-track-review.js';
import { applyPatch } from './patch.js';

const ASSETS: readonly Asset[] = [
  { id: 'a1', path: 'media/a1.mp4', type: 'video', media: { width: 1920, height: 1080 } } as Asset,
];
const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);
const FRAME = 1 / 30;

const corner = (x: number, y: number): MaskPathVertex => ({
  x,
  y,
  inX: 0,
  inY: 0,
  outX: 0,
  outY: 0,
  type: 'corner',
});
const SQUARE = [corner(100, 100), corner(300, 100), corner(300, 300), corner(100, 300)];

/** A perspective 3x3 of the kind a planar track stores. */
const PERSPECTIVE: TrackMatrix = [1.02, 0.03, 14.5, -0.02, 0.99, -6.25, 0.00004, -0.00002, 1];
const SIMILARITY = (() => {
  const angle = (7 * Math.PI) / 180;
  const scale = 1.1;
  return [
    scale * Math.cos(angle),
    -scale * Math.sin(angle),
    40,
    scale * Math.sin(angle),
    scale * Math.cos(angle),
    -12,
    0,
    0,
    1,
  ] as TrackMatrix;
})();

const tracking = (flagged: { start: number; end: number }[]) => ({
  artifact: { key: KEY, sha256: SHA },
  method: 'perspective',
  referenceSourceTime: 2,
  constraints: [],
  review: { flagged, approved: [], locked: [] },
});

function timeline(mask: MaskLayerInput): Timeline {
  return {
    revision: 3,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            trackId: 'v1',
            start: 0,
            end: 4,
            sourceStart: 2,
            sourceEnd: 6,
            effects: [],
            keyframes: [],
            masks: [MaskLayerSchema.parse(mask)],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

function correct(tl: Timeline, command: Record<string, unknown>): Timeline {
  const result = compileMaskCommand({
    timeline: tl,
    assets: ASSETS,
    command: {
      timelineRevision: 3,
      clipId: 'c1',
      type: 'correct_tracked_mask',
      maskId: 'm1',
      ...command,
    } as unknown as MaskCommand,
  });
  if (result.status !== 'compiled') throw new Error(`${result.code}: ${result.detail}`);
  const after = applyPatch(tl, result.patch);
  expect(applyPatch(after, result.inversePatch)).toEqual(tl);
  return after;
}

const maskOf = (tl: Timeline): MaskLayer => masksOf(tl.tracks[0]!.clips[0]!)[0]!;

/** `warp_path`: what both renderers do to a path's control points. */
function onScreen(vertices: readonly MaskPathVertex[], matrix: TrackMatrix): number[] {
  return vertices.flatMap((vertex) => {
    const [x, y] = trackWarpPoint(matrix, vertex.x, vertex.y);
    const [inX, inY] = trackWarpPoint(matrix, vertex.x + vertex.inX, vertex.y + vertex.inY);
    const [outX, outY] = trackWarpPoint(matrix, vertex.x + vertex.outX, vertex.y + vertex.outY);
    return [x, y, inX - x, inY - y, outX - x, outY - y];
  });
}

const pathMask = (): MaskLayerInput => ({
  kind: 'path',
  id: 'm1',
  pathKeyframes: [{ id: 'k0', sourceTime: 2, ...encodeMaskPath(SQUARE) }],
  tracking: tracking([{ start: 3, end: 3.5 }]),
});

const state = (matrix: TrackMatrix): TrackStateAt => ({ matrix, frameSeconds: FRAME });

describe('correct_tracked_mask', () => {
  const fixed = SQUARE.map((vertex) => ({ ...vertex, x: vertex.x + 9, y: vertex.y - 4 }));

  it('renders exactly the geometry the editor put on the screen, through the track', () => {
    const after = correct(timeline(pathMask()), {
      sourceTime: 3.2,
      geometry: { kind: 'path', vertices: fixed },
      track: state(PERSPECTIVE),
    });
    const own = maskGeometryAt(maskOf(after), 3.2);
    expect(own?.kind).toBe('path');
    const drawn = onScreen((own as { vertices: MaskPathVertex[] }).vertices, PERSPECTIVE);
    const wanted = fixed.flatMap((v) => [v.x, v.y, v.inX, v.inY, v.outX, v.outY]);
    drawn.forEach((value, index) => expect(value).toBeCloseTo(wanted[index]!, 9));
  });

  it('holds the correction over the flagged range and leaves the rest of the animation', () => {
    const before = timeline(pathMask());
    const after = correct(before, {
      sourceTime: 3.2,
      geometry: { kind: 'path', vertices: fixed },
      track: state(PERSPECTIVE),
    });
    const at = (tl: Timeline, time: number) => maskGeometryAt(maskOf(tl), time);
    // The whole stretch the re-track re-measures carries the one corrected keyframe.
    expect(at(after, 3)).toEqual(at(after, 3.2));
    expect(at(after, 3.49)).toEqual(at(after, 3.2));
    // Outside it, the mask is exactly what it was.
    for (const time of [2, 2.5, 3 - FRAME, 3.5, 4, 5.9]) {
      expect(at(after, time)).toEqual(at(before, time));
    }
    expect(maskOf(after).tracking?.constraints).toEqual([{ sourceTime: 3.2 }]);
  });

  it('corrects a rectangle exactly under a similarity track', () => {
    const rect: MaskLayerInput = {
      kind: 'rectangle',
      id: 'm1',
      cx: 500,
      cy: 400,
      width: 300,
      height: 200,
      rotation: 10,
      tracking: { ...tracking([]), method: 'position-scale-rotation' },
    } as MaskLayerInput;
    const after = correct(timeline(rect), {
      sourceTime: 3,
      geometry: {
        kind: 'rectangle',
        cx: 620,
        cy: 380,
        width: 330,
        height: 220,
        rotation: 20,
        roundness: 0,
      },
      track: state(SIMILARITY),
    });
    const own = maskGeometryAt(maskOf(after), 3) as {
      cx: number;
      cy: number;
      width: number;
      rotation: number;
    };
    const [x, y] = trackWarpPoint(SIMILARITY, own.cx, own.cy);
    expect(x).toBeCloseTo(620, 9);
    expect(y).toBeCloseTo(380, 9);
    expect(own.width * 1.1).toBeCloseTo(330, 9);
    expect(own.rotation + 7).toBeCloseTo(20, 9);
    // One frame on either side, the rectangle is untouched.
    expect(maskGeometryAt(maskOf(after), 3 - FRAME)).toMatchObject({ cx: 500, rotation: 10 });
    expect(maskGeometryAt(maskOf(after), 3 + FRAME)).toMatchObject({ cx: 500, rotation: 10 });
  });

  it('refuses a rectangle under perspective, naming the remedy', () => {
    const rect = {
      kind: 'rectangle',
      id: 'm1',
      cx: 500,
      cy: 400,
      width: 300,
      height: 200,
      tracking: tracking([]),
    } as MaskLayerInput;
    const result = compileMaskCommand({
      timeline: timeline(rect),
      assets: ASSETS,
      command: {
        timelineRevision: 3,
        clipId: 'c1',
        type: 'correct_tracked_mask',
        maskId: 'm1',
        sourceTime: 3,
        geometry: {
          kind: 'rectangle',
          cx: 510,
          cy: 400,
          width: 300,
          height: 200,
          rotation: 0,
          roundness: 0,
        },
        track: state(PERSPECTIVE),
      } as unknown as MaskCommand,
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'not_editable' });
    if (result.status === 'rejected') expect(result.detail).toMatch(/as a path/);
  });

  it('refuses an untracked mask', () => {
    const plain = { ...pathMask() } as Record<string, unknown>;
    delete plain['tracking'];
    const result = compileMaskCommand({
      timeline: timeline(plain as MaskLayerInput),
      assets: ASSETS,
      command: {
        timelineRevision: 3,
        clipId: 'c1',
        type: 'correct_tracked_mask',
        maskId: 'm1',
        sourceTime: 3,
        geometry: { kind: 'path', vertices: SQUARE },
        track: state(PERSPECTIVE),
      } as unknown as MaskCommand,
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'missing_track' });
  });
});

describe('untrackGeometry', () => {
  it('subtracts a shape track’s own per-vertex displacement', () => {
    const own = untrackGeometry(
      { kind: 'path', vertices: [corner(10, 20), corner(30, 40)] },
      { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], pointDeltas: [1, 2, -3, 4], frameSeconds: FRAME },
    );
    expect(own).toMatchObject({
      vertices: [
        { x: 9, y: 18 },
        { x: 33, y: 36 },
      ],
    });
  });
});

describe('trackGeometry', () => {
  it('is the inverse of untrackGeometry, so the monitor’s handles sit on the drawn mask', () => {
    const path = {
      kind: 'path' as const,
      vertices: SQUARE.map((v) => ({ ...v, inX: 4, outY: -3 })),
    };
    const back = untrackGeometry(trackGeometry(path, state(PERSPECTIVE))!, state(PERSPECTIVE));
    const flat = (g: unknown) =>
      (g as { vertices: MaskPathVertex[] }).vertices.flatMap((v) => [
        v.x,
        v.y,
        v.inX,
        v.inY,
        v.outX,
        v.outY,
      ]);
    flat(back).forEach((value, index) => expect(value).toBeCloseTo(flat(path)[index]!, 9));
    const ellipse = { kind: 'ellipse' as const, cx: 50, cy: 60, rx: 20, ry: 10, rotation: 5 };
    expect(trackGeometry(ellipse, state(SIMILARITY))).toMatchObject({ rotation: 12 });
    expect(trackGeometry(ellipse, state(PERSPECTIVE))).toBeNull();
  });
});

describe('correctionSpan', () => {
  it('is the flagged range the instant falls in, with the frame before it', () => {
    expect(correctionSpan([{ start: 3, end: 3.5 }], 3.2, 0.1)).toEqual({
      before: 2.9,
      start: 3,
      end: 3.5,
    });
  });

  it('is the one frame when the instant is not flagged', () => {
    expect(correctionSpan([{ start: 3, end: 3.5 }], 4, 0.25)).toEqual({
      before: 3.75,
      start: 4,
      end: 4.25,
    });
  });
});

const track = (over: Partial<TrackArtifact>): TrackArtifact => ({
  version: 1,
  method: 'perspective',
  timeBase: [1, 1_000_000],
  originPts: 0,
  firstFrame: 0,
  pts: [0, 33_333, 66_667, 100_000],
  transforms: [
    ...[1, 0, 0, 0, 1, 0, 0, 0, 1],
    ...[1, 0, 2, 0, 1, 0, 0, 0, 1],
    ...[1, 0, 4, 0, 1, 1, 0, 0, 1],
    ...[1, 0, 6, 0, 1, 2, 0, 0, 1],
  ],
  confidence: [1, 1, 0.2, 1],
  ...over,
});

describe('anchorOnConstraint', () => {
  it('continues a re-measured stretch from the transform the track had on the constraint', () => {
    const previous = track({});
    const segment = track({
      firstFrame: 2,
      pts: [66_667, 100_000],
      transforms: [...[1, 0, 0, 0, 1, 0, 0, 0, 1], ...[1, 0, 3, 0, 1, 0, 0, 0, 1]],
      confidence: [1, 1],
    });
    const anchored = anchorOnConstraint(segment, previous, 2);
    // On the constraint: exactly the previous transform, so `T · G` is what the editor drew.
    expect(anchored.transforms.slice(0, 9)).toEqual([1, 0, 4, 0, 1, 1, 0, 0, 1]);
    // After it: the motion measured from the constraint, on top.
    expect(anchored.transforms.slice(9, 18)).toEqual([1, 0, 7, 0, 1, 1, 0, 0, 1]);
  });

  it('carries a shape track’s vertices from their displacement on the constraint', () => {
    const points = (reference: number[], frames: number[]) => ({ count: 1, reference, frames });
    const previous = track({
      method: 'point-cloud',
      points: points([10, 10], [10, 10, 11, 10, 15, 12, 16, 12]),
    });
    const segment = track({
      method: 'point-cloud',
      firstFrame: 2,
      pts: [66_667, 100_000],
      transforms: [...[1, 0, 0, 0, 1, 0, 0, 0, 1], ...[1, 0, 0, 0, 1, 0, 0, 0, 1]],
      confidence: [1, 1],
      points: points([40, 40], [40, 40, 42, 41]),
    });
    const anchored = anchorOnConstraint(segment, previous, 2);
    expect(anchored.points).toEqual({ count: 1, reference: [10, 10], frames: [15, 12, 17, 13] });
  });

  it('refuses measurements of a different track', () => {
    expect(() => anchorOnConstraint(track({ method: 'position' }), track({}), 1)).toThrow();
  });
});

describe('mergeTrackSegments with the track being replaced', () => {
  it('never takes a re-measured frame back from the old track', () => {
    const previous = track({});
    const segment = track({
      firstFrame: 2,
      pts: [66_667],
      transforms: [9, 0, 0, 0, 9, 0, 0, 0, 1],
      confidence: [0.9],
    });
    // The old track's reference (frame 2) is nearer to frame 2 than the segment's (frame 3).
    const merged = mergeTrackSegments([
      { artifact: segment, referenceFrame: 3 },
      { artifact: previous, referenceFrame: 2, fallback: true },
    ]);
    expect(merged.transforms.slice(18, 27)).toEqual([9, 0, 0, 0, 9, 0, 0, 0, 1]);
    expect(merged.confidence).toEqual([1, 1, 0.9, 1]);
  });
});

describe('trackStateAt', () => {
  it('reads the frame’s transform and the track’s frame duration', () => {
    const state = trackStateAt(track({}), 0.07);
    expect(state.matrix).toEqual([1, 0, 4, 0, 1, 1, 0, 0, 1]);
    expect(state.frameSeconds).toBeCloseTo(0.033333, 6);
    expect(state.pointDeltas).toBeUndefined();
  });
});
