import { describe, expect, it } from 'vitest';
import type { Timeline, Track } from '@framepilot/timeline-schema';
import {
  createLaneAllocator,
  laneWithRoomFor,
  nextLayerId,
  trackHasRoomFor,
} from './lane-placement.js';

const clip = (id: string, start: number, end: number, trackId = 't') =>
  ({
    id,
    assetId: 'a',
    trackId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  }) as never;

const track = (id: string, type: Track['type'], clips: unknown[] = []): Track =>
  ({ id, type, clips }) as unknown as Track;

describe('trackHasRoomFor', () => {
  it('is free on an empty lane', () => {
    expect(trackHasRoomFor(track('t', 'overlay'), 0, 5)).toBe(true);
  });

  it('is occupied when a clip covers any part of the span', () => {
    const t = track('t', 'overlay', [clip('a', 2, 8)]);
    expect(trackHasRoomFor(t, 0, 5)).toBe(false); // overlaps the head
    expect(trackHasRoomFor(t, 6, 12)).toBe(false); // overlaps the tail
    expect(trackHasRoomFor(t, 3, 4)).toBe(false); // wholly inside
    expect(trackHasRoomFor(t, 0, 12)).toBe(false); // wholly contains
  });

  it('treats a butt join as room, not as an overlap', () => {
    // The half-open convention: a clip ending exactly where the next begins
    // shares an instant by construction, and that is a cut, not a collision.
    const t = track('t', 'overlay', [clip('a', 0, 4)]);
    expect(trackHasRoomFor(t, 4, 8)).toBe(true);
    expect(trackHasRoomFor(t, 0, 4)).toBe(false);
  });
});

describe('laneWithRoomFor', () => {
  const accepts = (t: Track): boolean => t.type === 'overlay';

  it('keeps the preferred lane when it has room — the user aimed there', () => {
    const timeline: Timeline = {
      tracks: [track('o1', 'overlay'), track('o2', 'overlay')],
    };
    expect(laneWithRoomFor(timeline, 0, 5, accepts, 'o2')?.id).toBe('o2');
  });

  it('moves to another acceptable lane when the preferred one is occupied', () => {
    const timeline: Timeline = {
      tracks: [track('o1', 'overlay', [clip('x', 0, 10, 'o1')]), track('o2', 'overlay')],
    };
    expect(laneWithRoomFor(timeline, 2, 6, accepts, 'o1')?.id).toBe('o2');
  });

  it('returns null when every acceptable lane is occupied, so the caller creates one', () => {
    const timeline: Timeline = {
      tracks: [
        track('o1', 'overlay', [clip('x', 0, 10, 'o1')]),
        track('o2', 'overlay', [clip('y', 0, 10, 'o2')]),
      ],
    };
    expect(laneWithRoomFor(timeline, 2, 6, accepts, 'o1')).toBeNull();
  });

  it('never returns a lane the predicate rejects, even as the preferred one', () => {
    const timeline: Timeline = { tracks: [track('v1', 'video'), track('o1', 'overlay')] };
    expect(laneWithRoomFor(timeline, 0, 5, accepts, 'v1')?.id).toBe('o1');
  });

  it('tolerates a preferred id that does not exist', () => {
    const timeline: Timeline = { tracks: [track('o1', 'overlay')] };
    expect(laneWithRoomFor(timeline, 0, 5, accepts, 'ghost')?.id).toBe('o1');
  });

  it('returns null on an empty timeline', () => {
    expect(laneWithRoomFor({ tracks: [] }, 0, 5, accepts, 'o1')).toBeNull();
  });
});

describe('nextLayerId', () => {
  it('is deterministic and avoids collisions', () => {
    const timeline: Timeline = { tracks: [track('layer_overlay_2', 'overlay')] };
    // length + 1 = 2 collides, so it walks to the next free number.
    expect(nextLayerId(timeline, 'overlay')).toBe('layer_overlay_3');
    expect(nextLayerId(timeline, 'overlay')).toBe('layer_overlay_3');
  });
});

describe('createLaneAllocator', () => {
  const timeline: Timeline = {
    tracks: [track('v1', 'video', [clip('a', 0, 5, 'v1')]), track('a1', 'audio')],
  };

  it('reuses the named lane when it is free', () => {
    const alloc = createLaneAllocator(timeline);
    expect(alloc.allocate('v1', 6, 8)).toEqual({ trackId: 'v1', setupOps: [] });
  });

  it('opens a lane of the SAME role when the named one is busy', () => {
    const alloc = createLaneAllocator(timeline);
    const got = alloc.allocate('v1', 1, 3);
    expect(got.trackId).not.toBe('v1');
    // Not the free audio lane: a picture clip does not belong on the audio bed
    // just because that lane happened to have room.
    expect(got.trackId).not.toBe('a1');
    expect(got.setupOps).toEqual([
      { type: 'add_layer', layerId: got.trackId, layerType: 'video', atIndex: 0 },
    ]);
  });

  it('remembers what it already promised, so a batch cannot collide with itself', () => {
    // The reason this is an allocator and not a pure lookup: every entry in an
    // `add_clips` batch is planned against the SAME pre-call timeline, so without
    // booking, two overlapping entries would both be told `v1` was free and would
    // collide the moment the patch applied.
    const alloc = createLaneAllocator(timeline);
    const first = alloc.allocate('v1', 6, 9);
    const second = alloc.allocate('v1', 7, 10);
    expect(first.trackId).toBe('v1');
    expect(second.trackId).not.toBe('v1');
  });

  it('reuses a lane it opened earlier in the same call rather than opening another', () => {
    const alloc = createLaneAllocator(timeline);
    const first = alloc.allocate('v1', 1, 3); // opens a lane
    const second = alloc.allocate('v1', 3, 5); // busy on v1, free on the new lane
    expect(second.trackId).toBe(first.trackId);
    expect(second.setupOps).toEqual([]);
  });

  it('gives every lane it opens a distinct id', () => {
    const alloc = createLaneAllocator(timeline);
    const ids = [
      alloc.allocate('v1', 1, 3).trackId,
      alloc.allocate('v1', 1, 3).trackId,
      alloc.allocate('v1', 1, 3).trackId,
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('hands an unknown lane id straight back, so the mistake is still reported', () => {
    // The allocator rescues a placement that would COLLIDE, not one addressed to a
    // lane that does not exist. Inventing a lane for a typo would scatter clips
    // across lanes nobody asked for and hide the bad id that caused it; the
    // caller's validation still rejects it with the reason that teaches the fix.
    const alloc = createLaneAllocator({ tracks: [] });
    expect(alloc.allocate('ghost', 0, 2)).toEqual({ trackId: 'ghost', setupOps: [] });
  });

  it('never allocates a locked lane', () => {
    const locked: Timeline = {
      tracks: [{ ...track('v1', 'video'), locked: true } as Track],
    };
    const got = createLaneAllocator(locked).allocate('v1', 0, 2);
    expect(got.trackId).not.toBe('v1');
  });
});
