/**
 * Where a review finding says it sits.
 *
 * `ReviewFinding.atSeconds` is documented as "where in the programme it sits, for a jump
 * affordance". It was filled with the start of the earliest clip the reviewed TURN touched,
 * stamped identically on every finding that turn produced — where the edit was, not where
 * the defect is.
 *
 * Run `25e06a6f` reported `Program ending is black (frame 1493)` — 49.767s of a 49.8s
 * programme — twice, at `0s` and at `0.067s`, because the turns that triggered those
 * reviews had touched a clip starting at zero. An editor following the jump lands at the
 * top of the timeline to look at a defect in its final frame.
 */
import { describe, expect, it } from 'vitest';
import { failingReviewSecond, requestFrame } from './orchestrator.js';
import type { TemporalEvidenceRequest } from './temporal-review.js';

const frameRequest = (requestId: string, atFrame: number): TemporalEvidenceRequest =>
  ({ requestId, kind: 'frame', atFrame }) as unknown as TemporalEvidenceRequest;

const rangeRequest = (requestId: string, startFrame: number): TemporalEvidenceRequest =>
  ({
    requestId,
    kind: 'range',
    startFrame,
    endFrame: startFrame + 30,
  }) as unknown as TemporalEvidenceRequest;

describe('requestFrame', () => {
  it('reads a frame request’s own frame', () => {
    expect(requestFrame(frameRequest('representative_2_1493', 1493))).toBe(1493);
  });

  it('reads a windowed request’s start', () => {
    expect(requestFrame(rangeRequest('edit_range_195', 195))).toBe(195);
  });

  it('is undefined for a request that names no frame', () => {
    expect(
      requestFrame({ requestId: 'x', kind: 'scope' } as unknown as TemporalEvidenceRequest),
    ).toBeUndefined();
  });
});

describe('failingReviewSecond', () => {
  const requests = [
    frameRequest('representative_0_0', 0),
    frameRequest('representative_1_746', 746),
    frameRequest('representative_2_1493', 1493),
    rangeRequest('edit_range_195', 195),
  ];

  it('places the finding at the frame that actually failed', () => {
    // The captured case: only the final frame failed, and it is at 49.767s — not at 0s,
    // which is where the turn that triggered the review happened to have touched a clip.
    expect(failingReviewSecond(requests, [{ requestId: 'representative_2_1493' }], 30)).toBeCloseTo(
      1493 / 30,
      6,
    );
  });

  it('takes the earliest when several failed, since that is where to look first', () => {
    expect(
      failingReviewSecond(
        requests,
        [{ requestId: 'representative_2_1493' }, { requestId: 'edit_range_195' }],
        30,
      ),
    ).toBeCloseTo(195 / 30, 6);
  });

  it('is undefined when nothing failing carries a frame, so the turn’s location stands', () => {
    expect(failingReviewSecond(requests, [{ requestId: 'unknown_check' }], 30)).toBeUndefined();
    expect(failingReviewSecond(requests, [], 30)).toBeUndefined();
  });

  it('refuses to divide by an implausible frame rate rather than returning Infinity', () => {
    expect(
      failingReviewSecond(requests, [{ requestId: 'representative_2_1493' }], 0),
    ).toBeUndefined();
  });
});
