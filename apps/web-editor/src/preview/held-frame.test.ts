/**
 * Tests for the canvas engine's held-frame eligibility rule.
 *
 * The drawing needs a real canvas; the decision does not, and the decision is the part that
 * can put the wrong shot under a cut.
 */
import { describe, expect, it } from 'vitest';
import { heldFrameIsPreviousSegment } from './held-frame.js';

const segments = [{ projectStart: 0 }, { projectStart: 4 }, { projectStart: 9 }];

describe('heldFrameIsPreviousSegment', () => {
  it('accepts the frame held from the shot immediately before this cut', () => {
    expect(heldFrameIsPreviousSegment(segments, 4, 0)).toBe(true);
    expect(heldFrameIsPreviousSegment(segments, 9, 4)).toBe(true);
  });

  it('refuses a frame from anywhere else in the timeline', () => {
    // After a seek the held frame can belong to a shot this cut never came from. Painting it
    // under the ramp would dissolve out of a shot the editor never cut from — a worse lie than
    // the black it replaces.
    expect(heldFrameIsPreviousSegment(segments, 9, 0)).toBe(false);
    expect(heldFrameIsPreviousSegment(segments, 4, 9)).toBe(false);
  });

  it('refuses when nothing is held, or at the very first segment', () => {
    expect(heldFrameIsPreviousSegment(segments, 4, undefined)).toBe(false);
    // The programme's opening has no shot before it; a transition there legitimately reveals
    // from the ground.
    expect(heldFrameIsPreviousSegment(segments, 0, 0)).toBe(false);
  });

  it('refuses a segment start that is not in the EDL at all', () => {
    // A stale draw after the timeline changed under it: no segment, no predecessor, no paint.
    expect(heldFrameIsPreviousSegment(segments, 7, 4)).toBe(false);
  });
});
