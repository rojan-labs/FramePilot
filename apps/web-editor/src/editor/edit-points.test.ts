/**
 * Edit-point navigation (revamp Phase 2, F3).
 *
 * The gap cases are the reason this module exists rather than reusing
 * `listEditBoundaries` — see the module note there. They are asserted here
 * explicitly so a future "simplification" back onto the boundary list fails
 * loudly instead of quietly making the transport skip visible edits.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { EDIT_POINT_EPSILON, listEditPoints, nextEditPoint, prevEditPoint } from './edit-points.js';

/** A clip with only the fields these projections read. */
const clip = (id: string, start: number, end: number, trackId = 'v') => ({
  id,
  assetId: 'a',
  trackId,
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const timelineOf = (
  clips: readonly ReturnType<typeof clip>[],
  extra: Partial<Timeline['tracks'][number]> = {},
): Timeline => ({ tracks: [{ id: 'v', type: 'video', clips: [...clips], ...extra }] });

describe('listEditPoints', () => {
  it('is 0 alone for an empty timeline', () => {
    // Always at least the head of the sequence, so navigation has something to
    // land on rather than refusing to move.
    expect(listEditPoints({ tracks: [] })).toEqual([0]);
    expect(listEditPoints(timelineOf([]))).toEqual([0]);
  });

  it('collects each clip start and end, sorted and deduped', () => {
    // Two abutting clips: the cut at 4 is contributed twice and must appear once.
    expect(listEditPoints(timelineOf([clip('a', 0, 4), clip('b', 4, 9)]))).toEqual([0, 4, 9]);
  });

  it('includes BOTH edges of a gap — the case listEditBoundaries omits', () => {
    // `listEditBoundaries` returns nothing here (the clips do not abut), so a
    // transport wired to it would skip straight past 4 and 6.
    expect(listEditPoints(timelineOf([clip('a', 0, 4), clip('b', 6, 9)]))).toEqual([0, 4, 6, 9]);
  });

  it('includes both edges of an overlap, which is also not a clean cut', () => {
    expect(listEditPoints(timelineOf([clip('a', 0, 5), clip('b', 3, 8)]))).toEqual([0, 3, 5, 8]);
  });

  it('merges points closer together than the navigation epsilon', () => {
    // Frame rounding can leave a cut split by a fraction of a microsecond; that
    // is one stop, not two, as far as a person pressing a button is concerned.
    const points = listEditPoints(
      timelineOf([clip('a', 0, 4), clip('b', 4 + EDIT_POINT_EPSILON / 2, 9)]),
    );
    expect(points).toEqual([0, 4, 9]);
  });

  it('excludes hidden tracks — they contribute no picture', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'v', type: 'video', clips: [clip('a', 0, 4)] },
        { id: 'h', type: 'video', clips: [clip('b', 10, 20, 'h')], hidden: true },
      ],
    };
    expect(listEditPoints(timeline)).toEqual([0, 4]);
  });

  it('merges edits that coincide across tracks', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'v', type: 'video', clips: [clip('a', 0, 4)] },
        { id: 'v2', type: 'video', clips: [clip('b', 0, 4, 'v2')] },
      ],
    };
    expect(listEditPoints(timeline)).toEqual([0, 4]);
  });
});

describe('prevEditPoint / nextEditPoint', () => {
  const points = [0, 4, 6, 9];

  it('walks to the neighbouring point', () => {
    expect(nextEditPoint(0, points)).toBe(4);
    expect(nextEditPoint(4, points)).toBe(6);
    expect(prevEditPoint(9, points)).toBe(6);
    expect(prevEditPoint(6, points)).toBe(4);
  });

  it('moves from a position between points', () => {
    expect(nextEditPoint(5, points)).toBe(6);
    expect(prevEditPoint(5, points)).toBe(4);
  });

  it('does not stick on the point it is already sitting on', () => {
    // "Strictly before/after" is what makes repeated presses keep walking. Sitting
    // exactly on the cut at 4, previous is 0 — not 4 again.
    expect(prevEditPoint(4, points)).toBe(0);
    expect(nextEditPoint(4, points)).toBe(6);
  });

  it('tolerates landing a hair off a point (float seek arithmetic)', () => {
    expect(prevEditPoint(4 + EDIT_POINT_EPSILON / 2, points)).toBe(0);
    expect(nextEditPoint(4 - EDIT_POINT_EPSILON / 2, points)).toBe(6);
  });

  it('returns null at the ends so the caller can decide the fallback', () => {
    expect(prevEditPoint(0, points)).toBeNull();
    expect(nextEditPoint(9, points)).toBeNull();
    expect(nextEditPoint(999, points)).toBeNull();
    expect(prevEditPoint(-5, points)).toBeNull();
  });

  it('returns null against an empty point list', () => {
    expect(prevEditPoint(5, [])).toBeNull();
    expect(nextEditPoint(5, [])).toBeNull();
  });
});
