/**
 * Scrub-bar geometry (revamp Phase 2). Pure arithmetic, so this is where the
 * interesting behaviour of the scrub bar is actually pinned down — the component
 * test only has to prove the wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  FINE_SCRUB_DAMPING,
  fineScrubTime,
  fractionOfDuration,
  quantizeToFrame,
  snapToEditPoint,
  timeAtPointer,
  type ScrubTrack,
} from './scrub.js';

/** A 1000px-wide bar starting at viewport x=100 — one px is one thousandth. */
const TRACK: ScrubTrack = { left: 100, width: 1000 };

describe('timeAtPointer', () => {
  it('maps a pointer position to its fraction of the duration', () => {
    expect(timeAtPointer(100, TRACK, 60)).toBe(0);
    expect(timeAtPointer(600, TRACK, 60)).toBe(30);
    expect(timeAtPointer(1100, TRACK, 60)).toBe(60);
  });

  it('clamps outside the track rather than returning a time off the timeline', () => {
    expect(timeAtPointer(-500, TRACK, 60)).toBe(0);
    expect(timeAtPointer(99999, TRACK, 60)).toBe(60);
  });

  it('returns 0 for a zero-width track instead of dividing by zero', () => {
    // An unlaid-out bar (display:none ancestor, pre-layout). NaN reaching seek()
    // would corrupt the playhead, which is why this case is explicit.
    expect(timeAtPointer(500, { left: 0, width: 0 }, 60)).toBe(0);
    expect(timeAtPointer(500, { left: 0, width: -10 }, 60)).toBe(0);
  });

  it('treats an empty timeline as 0 everywhere', () => {
    expect(timeAtPointer(600, TRACK, 0)).toBe(0);
  });
});

describe('fineScrubTime', () => {
  it('displaces from the gesture origin by the DAMPED travel', () => {
    // 250px of travel on a 1000px bar over 60s is 15s coarse; damped it is 3s.
    expect(fineScrubTime(10, 100, 350, TRACK, 60)).toBeCloseTo(10 + 15 * FINE_SCRUB_DAMPING, 10);
  });

  it('does not jump to the pointer — zero travel keeps the origin time', () => {
    // This is the whole point of the gesture: pressing Shift mid-drag must not
    // teleport the playhead to wherever the pointer happens to be.
    expect(fineScrubTime(42, 900, 900, TRACK, 60)).toBe(42);
  });

  it('moves backwards for negative travel', () => {
    expect(fineScrubTime(30, 600, 350, TRACK, 60)).toBeCloseTo(30 - 15 * FINE_SCRUB_DAMPING, 10);
  });

  it('honours an explicit damping factor', () => {
    expect(fineScrubTime(0, 100, 1100, TRACK, 60, 1)).toBe(60);
    expect(fineScrubTime(0, 100, 1100, TRACK, 60, 0.5)).toBe(30);
  });

  it('clamps to the timeline', () => {
    expect(fineScrubTime(59, 100, 99999, TRACK, 60)).toBe(60);
    expect(fineScrubTime(1, 900, -99999, TRACK, 60)).toBe(0);
  });

  it('falls back to the clamped origin on a zero-width track', () => {
    expect(fineScrubTime(10, 0, 500, { left: 0, width: 0 }, 60)).toBe(10);
    expect(fineScrubTime(99, 0, 500, { left: 0, width: 0 }, 60)).toBe(60);
  });
});

describe('fractionOfDuration', () => {
  it('is the position as a 0..1 fraction', () => {
    expect(fractionOfDuration(15, 60)).toBe(0.25);
    expect(fractionOfDuration(60, 60)).toBe(1);
  });

  it('is 0 (never NaN) for an empty timeline, so the bar still renders', () => {
    expect(fractionOfDuration(5, 0)).toBe(0);
    expect(fractionOfDuration(5, -1)).toBe(0);
  });

  it('clamps out-of-range times', () => {
    expect(fractionOfDuration(-5, 60)).toBe(0);
    expect(fractionOfDuration(120, 60)).toBe(1);
  });
});

describe('snapToEditPoint', () => {
  const points = [0, 4, 10, 25];

  it('pulls onto the nearest point inside the tolerance', () => {
    expect(snapToEditPoint(4.3, points, 0.5)).toBe(4);
    expect(snapToEditPoint(9.6, points, 0.5)).toBe(10);
  });

  it('prefers the CLOSEST point when two are in range', () => {
    expect(snapToEditPoint(6, [4, 7], 5)).toBe(7);
    expect(snapToEditPoint(5, [4, 7], 5)).toBe(4);
  });

  it('returns the input untouched when nothing is in range', () => {
    expect(snapToEditPoint(15, points, 0.5)).toBe(15);
  });

  it('has no points to snap to on an empty sequence', () => {
    expect(snapToEditPoint(7, [], 1)).toBe(7);
  });

  it('still snaps an exact hit at zero tolerance', () => {
    expect(snapToEditPoint(10, points, 0)).toBe(10);
  });
});

describe('quantizeToFrame', () => {
  it('rounds to the nearest whole frame', () => {
    expect(quantizeToFrame(1.017, 30)).toBeCloseTo(31 / 30, 10);
    expect(quantizeToFrame(0.4, 25)).toBeCloseTo(0.4, 10);
  });

  it('passes the time through for an unusable frame rate', () => {
    // A zero/negative fps is a corrupt project, not a reason to return NaN.
    expect(quantizeToFrame(1.234, 0)).toBe(1.234);
    expect(quantizeToFrame(1.234, -30)).toBe(1.234);
  });
});
