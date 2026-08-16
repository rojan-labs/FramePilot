import { describe, expect, it } from 'vitest';
import {
  activeSegmentAt,
  driftUs,
  mediaTimeUsAt,
  mediaTimeUsFromAnchor,
  scheduleSegmentsBackToBack,
  scheduleSegmentsOnTimeline,
} from './audio-clock-math.js';

const SEGMENTS = [
  { mediaStartUs: 0, durationUs: 1_000_000 }, // clip A: media [0, 1s)
  { mediaStartUs: 5_000_000, durationUs: 2_000_000 }, // clip B: media [5s, 7s), placed right after A
];

describe('scheduleSegmentsBackToBack', () => {
  it('places segments back-to-back on the context clock with no gap', () => {
    const schedule = scheduleSegmentsBackToBack(SEGMENTS, 10);
    expect(schedule).toHaveLength(2);
    expect(schedule[0]?.ctxStartSec).toBe(10);
    expect(schedule[1]?.ctxStartSec).toBe(11); // 10 + segment A's 1s duration
  });

  it('returns an empty schedule for no segments', () => {
    expect(scheduleSegmentsBackToBack([], 0)).toEqual([]);
  });
});

describe('continuous timeline clock', () => {
  const anchor = { mediaStartUs: 2_000_000, ctxStartSec: 10 };

  it('holds during lead then advances monotonically through silent time', () => {
    expect(mediaTimeUsFromAnchor(anchor, 9.95)).toBe(2_000_000);
    expect(mediaTimeUsFromAnchor(anchor, 10)).toBe(2_000_000);
    expect(mediaTimeUsFromAnchor(anchor, 12.5)).toBe(4_500_000);
  });

  it('keeps real project gaps between audible segments', () => {
    const schedule = scheduleSegmentsOnTimeline(SEGMENTS, { mediaStartUs: 0, ctxStartSec: 10 });
    expect(schedule[0]?.ctxStartSec).toBe(10);
    expect(schedule[1]?.ctxStartSec).toBe(15);
  });

  it('supports a video-only timeline with no scheduled audio nodes', () => {
    expect(scheduleSegmentsOnTimeline([], anchor)).toEqual([]);
    expect(mediaTimeUsFromAnchor(anchor, 11)).toBe(3_000_000);
  });
});

describe('activeSegmentAt', () => {
  const schedule = scheduleSegmentsBackToBack(SEGMENTS, 10);

  it('returns undefined for an empty schedule', () => {
    expect(activeSegmentAt([], 5)).toBeUndefined();
  });

  it('clamps to the first segment before playback starts', () => {
    expect(activeSegmentAt(schedule, 0)).toBe(schedule[0]);
  });

  it('picks the segment whose start is at-or-before ctxNow', () => {
    expect(activeSegmentAt(schedule, 10.5)).toBe(schedule[0]);
    expect(activeSegmentAt(schedule, 11)).toBe(schedule[1]); // exact boundary
    expect(activeSegmentAt(schedule, 11.5)).toBe(schedule[1]);
  });

  it('clamps to the last segment after everything has finished', () => {
    expect(activeSegmentAt(schedule, 999)).toBe(schedule[1]);
  });
});

describe('mediaTimeUsAt', () => {
  const schedule = scheduleSegmentsBackToBack(SEGMENTS, 10);

  it('returns 0 for an empty schedule', () => {
    expect(mediaTimeUsAt([], 5)).toBe(0);
  });

  it('holds at the first segment media start during the scheduling lead', () => {
    // ctxNow 9.95 is 50ms BEFORE the first segment starts (the schedule lead).
    // The playhead must hold at media 0, never report a negative media time —
    // a negative would make the video side look up a frame before the
    // playback start position (a guaranteed missing frame every play()).
    expect(mediaTimeUsAt(schedule, 9.95)).toBe(0);
  });

  it('holds at a mid-timeline start position during the scheduling lead', () => {
    const midStart = scheduleSegmentsBackToBack(
      [{ mediaStartUs: 2_000_000, durationUs: 1_000_000 }],
      10,
    );
    expect(mediaTimeUsAt(midStart, 9.95)).toBe(2_000_000);
  });

  it('derives media time within the first segment', () => {
    expect(mediaTimeUsAt(schedule, 10)).toBe(0);
    expect(mediaTimeUsAt(schedule, 10.5)).toBe(500_000);
  });

  it('derives media time across the cut into the second segment', () => {
    // ctxStartSec for segment B is 11 (10 + A's 1s duration); B's media start is 5s.
    expect(mediaTimeUsAt(schedule, 11)).toBe(5_000_000);
    expect(mediaTimeUsAt(schedule, 11.25)).toBe(5_250_000);
  });
});

describe('driftUs', () => {
  it('is zero when the presented frame timestamp exactly matches the clock', () => {
    const schedule = scheduleSegmentsBackToBack(SEGMENTS, 10);
    expect(driftUs(schedule, 10.5, 500_000)).toBe(0);
  });

  it('is signed: positive when video is ahead, negative when behind', () => {
    const schedule = scheduleSegmentsBackToBack(SEGMENTS, 10);
    expect(driftUs(schedule, 10.5, 533_000)).toBe(33_000);
    expect(driftUs(schedule, 10.5, 467_000)).toBe(-33_000);
  });
});
