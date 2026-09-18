import { describe, expect, it } from 'vitest';

import { TRACK_ARTIFACT_VERSION, trackTransformAt, type TrackArtifact } from './mask-track.js';
import { translation3x3 } from './mask-track-solve.js';
import {
  TrackMergeError,
  mergeTrackSegments,
  retrackPlan,
  trackIsVerified,
  trackReviewFor,
  withConstraint,
} from './mask-track-review.js';

const TIME_BASE: readonly [number, number] = [1, 10];

/** A track over frames `firstFrame..` with one confidence per frame and a per-frame shift. */
function artifact(confidence: readonly number[], firstFrame = 0): TrackArtifact {
  const transforms: number[] = [];
  for (let index = 0; index < confidence.length; index += 1) {
    transforms.push(...translation3x3(index, 0));
  }
  return {
    version: TRACK_ARTIFACT_VERSION,
    method: 'position',
    timeBase: TIME_BASE,
    originPts: 0,
    firstFrame,
    pts: confidence.map((_value, index) => firstFrame + index),
    transforms,
    confidence: [...confidence],
  };
}

describe('the review list', () => {
  it('flags every contiguous stretch under the floor, merged', () => {
    const review = trackReviewFor(artifact([1, 1, 0.1, 0.2, 1, 0.3]));
    expect(review.flagged).toEqual([
      { start: 0.2, end: 0.4 },
      { start: 0.5, end: 0.5 },
    ]);
    expect(trackIsVerified(review)).toBe(false);
  });

  it('is verified when nothing is under the floor', () => {
    expect(trackIsVerified(trackReviewFor(artifact([1, 0.9, 0.8])))).toBe(true);
  });

  it('keeps approvals that no longer touch anything flagged, and drops the rest', () => {
    const previous = {
      flagged: [],
      approved: [
        { start: 0, end: 0.1 },
        { start: 0.2, end: 0.4 },
      ],
      locked: [0.3, 0.1],
    };
    const review = trackReviewFor(artifact([1, 1, 0.1, 0.2, 1]), previous);
    expect(review.approved).toEqual([{ start: 0, end: 0.1 }]);
    // Locked instants are the editor's own promises; a re-measure never drops one.
    expect(review.locked).toEqual([0.1, 0.3]);
  });
});

describe('constraints', () => {
  it('stays sorted and refuses a duplicate instant', () => {
    const once = withConstraint([{ sourceTime: 1 }], 0.5);
    expect(once).toEqual([{ sourceTime: 0.5 }, { sourceTime: 1 }]);
    expect(withConstraint(once, 0.5)).toBe(once);
  });
});

describe('the re-track plan', () => {
  const clip = { firstFrame: 0, lastFrameExclusive: 10 };

  it('measures outwards from a constraint in both directions', () => {
    const plan = retrackPlan({
      artifact: artifact([1, 1, 0.1, 0.1, 0.1, 0.1, 1, 1, 1, 1]),
      constraints: [{ sourceTime: 0.4 }],
      ...clip,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ referenceFrame: 4, firstFrame: 4, reverse: false });
    expect(plan[1]).toMatchObject({ referenceFrame: 4, lastFrameExclusive: 5, reverse: true });
  });

  it('gives every frame to its nearest constraint', () => {
    const plan = retrackPlan({
      artifact: artifact(new Array(10).fill(0.1)),
      constraints: [{ sourceTime: 0.2 }, { sourceTime: 0.8 }],
      ...clip,
    });
    const forward = plan.filter((segment) => !segment.reverse);
    // The midpoint between frames 2 and 8 is 5: frames 2..4 belong to the first constraint.
    expect(forward[0]).toMatchObject({ referenceFrame: 2, lastFrameExclusive: 5 });
    expect(forward[1]).toMatchObject({ referenceFrame: 8, lastFrameExclusive: 10 });
  });

  it('measures nothing when the neighbourhood already clears the floor', () => {
    expect(
      retrackPlan({
        artifact: artifact(new Array(10).fill(1)),
        constraints: [{ sourceTime: 0.4 }],
        ...clip,
      }),
    ).toEqual([]);
  });

  it('ignores a constraint outside the clip', () => {
    expect(
      retrackPlan({
        artifact: artifact(new Array(10).fill(0.1)),
        constraints: [{ sourceTime: 0.4 }],
        firstFrame: 6,
        lastFrameExclusive: 10,
      }),
    ).toEqual([]);
  });
});

describe('merging measured segments', () => {
  /** A segment anchored on `reference`, identity there, shifting by 1 px per frame away. */
  function segment(firstFrame: number, frames: number, reference: number) {
    const transforms: number[] = [];
    const pts: number[] = [];
    for (let index = 0; index < frames; index += 1) {
      const frame = firstFrame + index;
      transforms.push(...translation3x3(frame - reference, 0));
      pts.push(frame);
    }
    return {
      referenceFrame: reference,
      artifact: {
        version: TRACK_ARTIFACT_VERSION,
        method: 'position' as const,
        timeBase: TIME_BASE,
        originPts: 0,
        firstFrame,
        pts,
        transforms,
        confidence: new Array<number>(frames).fill(1),
      },
    };
  }

  it('keeps every constraint frame exactly the identity', () => {
    const merged = mergeTrackSegments([segment(0, 6, 0), segment(4, 6, 8)]);
    expect(trackTransformAt(merged, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(trackTransformAt(merged, 0.8)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('gives an overlapping frame to the nearer constraint', () => {
    const merged = mergeTrackSegments([segment(0, 6, 0), segment(4, 6, 8)]);
    // Frame 5 is in both; it is 3 from the second constraint and 5 from the first.
    expect(trackTransformAt(merged, 0.5)[2]).toBe(5 - 8);
    // Frame 4 is 4 from each; the earlier reference wins, so both sides are reproducible.
    expect(trackTransformAt(merged, 0.4)[2]).toBe(4 - 0);
  });

  it('covers the union of the segments in one sorted frame grid', () => {
    const merged = mergeTrackSegments([segment(4, 6, 8), segment(0, 6, 0)]);
    expect(merged.firstFrame).toBe(0);
    expect(merged.pts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(merged.transforms).toHaveLength(90);
  });

  it('refuses measurements that do not describe one track', () => {
    const other = segment(0, 3, 0);
    const mismatched = {
      ...other,
      artifact: { ...other.artifact, method: 'perspective' as const },
    };
    expect(() => mergeTrackSegments([segment(0, 3, 0), mismatched])).toThrow(TrackMergeError);
    expect(() => mergeTrackSegments([])).toThrow(TrackMergeError);
  });
});
