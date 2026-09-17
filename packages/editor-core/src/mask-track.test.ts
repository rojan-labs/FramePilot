import { describe, expect, it } from 'vitest';

import {
  TRACK_ARTIFACT_VERSION,
  TrackArtifactError,
  parseTrackArtifact,
  serializeTrackArtifact,
  trackConfidenceAt,
  trackFrameIndexAt,
  trackSourceSeconds,
  trackTransformAt,
  trackWarpAt,
  trackWarpPoint,
  type TrackArtifact,
} from './mask-track.js';
import {
  TRACK_FLAG_RESIDUAL_PX,
  buildTrackArtifact,
  codedToDisplayMatrix,
  constrainTransform,
  flaggedTrackRanges,
  invert3x3,
  modelQuad,
  modelResidualPixels,
  multiply3x3,
  normalizedToDisplayMatrix,
  translation3x3,
  TrackSolveError,
  type MeasuredTrackFrame,
} from './mask-track-solve.js';

const TIME_BASE: readonly [number, number] = [1, 30];

function artifact(overrides: Partial<TrackArtifact> = {}): TrackArtifact {
  return {
    version: TRACK_ARTIFACT_VERSION,
    method: 'position',
    timeBase: TIME_BASE,
    originPts: 0,
    firstFrame: 10,
    pts: [10, 11, 12],
    transforms: [...translation3x3(0, 0), ...translation3x3(4, 2), ...translation3x3(8, 4)],
    confidence: [1, 0.9, 0.2],
    ...overrides,
  };
}

describe('track artifact document', () => {
  it('round-trips through the bytes that are hashed', () => {
    const parsed = parseTrackArtifact(JSON.parse(serializeTrackArtifact(artifact())));
    expect(parsed).toEqual(artifact());
  });

  it('serialises the same track to the same bytes every time', () => {
    expect(serializeTrackArtifact(artifact())).toBe(serializeTrackArtifact(artifact()));
  });

  it.each([
    ['a different version', { version: 2 }],
    ['an unknown method', { method: 'magic' }],
    ['a non-increasing pts list', { pts: [10, 10, 12] }],
    ['a transform list of the wrong length', { transforms: [1, 0, 0] }],
    ['a confidence list of the wrong length', { confidence: [1] }],
    ['a confidence outside 0..1', { confidence: [1, 2, 0] }],
    ['a non-finite transform', { transforms: new Array(27).fill(Number.NaN) }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => parseTrackArtifact({ ...artifact(), ...overrides })).toThrow(TrackArtifactError);
  });

  it('refuses a shape track with no tracked points', () => {
    expect(() => parseTrackArtifact({ ...artifact(), method: 'point-cloud' })).toThrow(
      /tracked points/,
    );
  });

  it('refuses a points block that does not cover every frame', () => {
    expect(() =>
      parseTrackArtifact({
        ...artifact(),
        method: 'point-cloud',
        points: { count: 2, reference: [0, 0, 1, 1], frames: [0, 0, 1, 1] },
      }),
    ).toThrow(/every tracked frame/);
  });
});

describe('reading a transform', () => {
  it('holds the nearest end outside the tracked range', () => {
    const track = artifact();
    expect(trackFrameIndexAt(track, -5)).toBe(0);
    expect(trackFrameIndexAt(track, 100)).toBe(2);
  });

  it('picks the nearest frame, ties to the earlier one', () => {
    const track = artifact();
    // pts 10..12 at 1/30 s per tick: frame 11 is 11/30 s.
    expect(trackFrameIndexAt(track, 11 / 30)).toBe(1);
    expect(trackFrameIndexAt(track, 10.5 / 30)).toBe(0);
    expect(trackFrameIndexAt(track, 11.6 / 30)).toBe(2);
  });

  it('reports the source seconds and confidence of a tracked frame', () => {
    const track = artifact();
    expect(trackSourceSeconds(track, 1)).toBeCloseTo(11 / 30, 12);
    expect(trackConfidenceAt(track, 12 / 30)).toBe(0.2);
  });

  it('moves a point by the frame transform', () => {
    expect(trackWarpAt(artifact(), 12 / 30)(100, 50, -1)).toEqual([108, 54]);
  });

  it('leaves a point alone when the transform is degenerate', () => {
    expect(trackWarpPoint([1, 0, 0, 0, 1, 0, 0, 0, 0], 3, 4)).toEqual([3, 4]);
  });

  it('moves each vertex on its own path for a shape track', () => {
    const track = parseTrackArtifact({
      ...artifact(),
      method: 'point-cloud',
      points: {
        count: 2,
        reference: [0, 0, 10, 0],
        frames: [0, 0, 10, 0, 1, 1, 12, 0, 2, 2, 14, 0],
      },
    });
    const warp = trackWarpAt(track, 12 / 30);
    expect(warp(0, 0, 0)).toEqual([2, 2]);
    expect(warp(10, 0, 1)).toEqual([14, 0]);
    // A vertex the track never followed keeps the mask's own animation.
    expect(warp(5, 5, 7)).toEqual([5, 5]);
  });
});

describe('3x3 algebra', () => {
  it('inverts and multiplies back to the identity', () => {
    const matrix = [2, 0.5, 10, -0.25, 1.5, -4, 0.0001, 0.0002, 1];
    const product = multiply3x3(matrix, invert3x3(matrix)!);
    for (let index = 0; index < 9; index += 1) {
      expect(product[index]!).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][index]!, 10);
    }
  });

  it('refuses to invert a singular matrix', () => {
    expect(invert3x3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeUndefined();
  });

  it('maps coded pixels to display pixels for a rotated anamorphic source', () => {
    const geometry = {
      codedWidth: 1920,
      codedHeight: 1080,
      pixelAspectRatio: 2,
      rotationDegrees: 90,
    };
    const matrix = codedToDisplayMatrix(geometry);
    // A 90 degree clockwise turn sends (0, 0) to (height, 0) of the stretched picture.
    expect(trackWarpPoint(matrix, 0, 0)).toEqual([1080, 0]);
    expect(trackWarpPoint(matrix, 10, 20)).toEqual([1060, 20]);
  });

  it('keeps a normalized translation a translation in display pixels', () => {
    const geometry = { codedWidth: 200, codedHeight: 100 };
    const display = normalizedToDisplayMatrix(translation3x3(0.5, 0.25), geometry)!;
    expect(trackWarpPoint(display, 0, 0)).toEqual([100, 25]);
    expect(trackWarpPoint(display, 20, 20)).toEqual([120, 45]);
  });
});

describe('constraining a measurement', () => {
  const quad = modelQuad({ x: 100, y: 100, width: 100, height: 100 });

  it('keeps only the mean displacement for position', () => {
    const measured = multiply3x3(translation3x3(10, -6), [1.5, 0, 0, 0, 1.5, 0, 0, 0, 1]);
    const model = constrainTransform(measured, 'position', quad);
    expect(model[0]).toBe(1);
    expect(model[4]).toBe(1);
    const centre = trackWarpPoint(model, 150, 150);
    expect(centre[0]).toBeCloseTo(trackWarpPoint(measured, 150, 150)[0], 9);
    expect(centre[1]).toBeCloseTo(trackWarpPoint(measured, 150, 150)[1], 9);
  });

  it('recovers a rotation and uniform scale exactly', () => {
    const angle = 0.3;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const scale = 1.25;
    const measured = [scale * cos, -scale * sin, 7, scale * sin, scale * cos, -3, 0, 0, 1];
    const model = constrainTransform(measured, 'position-scale-rotation', quad);
    expect(modelResidualPixels(measured, model, quad)).toBeLessThan(1e-9);
  });

  it('reports the price of a model that cannot express the motion', () => {
    const measured = [1.4, 0, 0, 0, 1, 0, 0, 0, 1];
    const model = constrainTransform(measured, 'position', quad);
    expect(modelResidualPixels(measured, model, quad)).toBeGreaterThan(TRACK_FLAG_RESIDUAL_PX);
  });

  it('keeps a homography untouched for perspective', () => {
    const measured = [1, 0.1, 5, 0, 1, 0, 0.0005, 0, 1];
    expect(constrainTransform(measured, 'perspective', quad)).toEqual(measured);
  });
});

describe('building an artifact', () => {
  const quad = modelQuad({ x: 0, y: 0, width: 100, height: 100 });

  function measured(frame: number, dx: number, confidence = 1): MeasuredTrackFrame {
    return { frame, pts: frame, homography: translation3x3(dx, 0), confidence };
  }

  it('anchors the identity at the reference frame wherever the worker started', () => {
    const { artifact: built } = buildTrackArtifact({
      method: 'position',
      timeBase: TIME_BASE,
      originPts: 0,
      frames: [measured(0, 0), measured(1, 5), measured(2, 10)],
      referenceFrame: 2,
      quad,
    });
    expect(trackTransformAt(built, 2 / 30)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(trackWarpPoint(trackTransformAt(built, 0), 0, 0)).toEqual([-10, 0]);
  });

  it('penalises confidence by the model residual and flags the range', () => {
    const { artifact: built, residualPx } = buildTrackArtifact({
      method: 'position',
      timeBase: TIME_BASE,
      originPts: 0,
      frames: [
        measured(0, 0),
        { frame: 1, pts: 1, homography: [2, 0, 0, 0, 2, 0, 0, 0, 1], confidence: 1 },
        measured(2, 4),
      ],
      referenceFrame: 0,
      quad,
    });
    expect(residualPx[1]!).toBeGreaterThan(TRACK_FLAG_RESIDUAL_PX);
    expect(built.confidence[1]!).toBeLessThan(built.confidence[0]!);
    const flagged = flaggedTrackRanges(built);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.start).toBeCloseTo(1 / 30, 12);
  });

  it('refuses a range that does not include the reference frame', () => {
    expect(() =>
      buildTrackArtifact({
        method: 'position',
        timeBase: TIME_BASE,
        originPts: 0,
        frames: [measured(0, 0)],
        referenceFrame: 9,
        quad,
      }),
    ).toThrow(TrackSolveError);
  });

  it('refuses a shape track whose point count changed mid-run', () => {
    expect(() =>
      buildTrackArtifact({
        method: 'point-cloud',
        timeBase: TIME_BASE,
        originPts: 0,
        frames: [
          { ...measured(0, 0), points: [{ x: 0, y: 0 }] },
          { ...measured(1, 1), points: [] },
        ],
        referenceFrame: 0,
        quad,
        referencePoints: [{ x: 0, y: 0 }],
      }),
    ).toThrow(/number of points/);
  });

  it('produces a parseable shape track', () => {
    const { artifact: built } = buildTrackArtifact({
      method: 'point-cloud',
      timeBase: TIME_BASE,
      originPts: 0,
      frames: [
        {
          ...measured(0, 0),
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        },
        {
          ...measured(1, 1),
          points: [
            { x: 1, y: 1 },
            { x: 12, y: 0 },
          ],
        },
      ],
      referenceFrame: 0,
      quad,
      referencePoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    expect(parseTrackArtifact(JSON.parse(serializeTrackArtifact(built)))).toEqual(built);
  });
});
