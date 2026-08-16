import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { snap, snapTargets, trackJunctions } from './selectors.js';

function denseTimeline(count: number): Timeline {
  return {
    tracks: [
      {
        id: 'track',
        type: 'video',
        clips: Array.from({ length: count }, (_, index) => ({
          id: `clip_${index}`,
          assetId: 'asset',
          trackId: 'track',
          start: index * 2,
          end: index * 2 + 1,
          sourceStart: 0,
          sourceEnd: 1,
          effects: [],
          keyframes: [],
        })),
      },
    ],
  };
}

describe('timeline snap hot path', () => {
  it('reuses the same target array for repeated pointer samples on unchanged state', () => {
    const timeline = denseTimeline(10_000);
    const first = snapTargets(timeline, [12.5, 99]);
    const second = snapTargets(timeline, [12.5, 99]);
    expect(second).toBe(first);
    // Contiguous clips share edges: 10k clips cover the integers 0..19_999
    // (20_000 distinct), and of the extras only 12.5 is new — 0 and 99 already
    // sit on a clip edge.
    expect(first.length).toBe(20_001);
  });

  it('invalidates merged extras without rebuilding semantic clip edges', () => {
    const timeline = denseTimeline(100);
    const first = snapTargets(timeline, [12.5]);
    const second = snapTargets(timeline, [12.75]);
    expect(second).not.toBe(first);
    expect(second).toContain(12.75);
    expect(second).not.toContain(12.5);
    expect(second[0]).toBe(0);
  });

  it('finds the nearest target by binary search semantics and preserves higher-target ties', () => {
    const targets = [0, 10, 20, 30];
    expect(snap(18, targets, 3)).toBe(20);
    expect(snap(15, targets, 5)).toBe(20);
    expect(snap(15, targets, 4.9)).toBe(15);
  });

  it('clamps negative time and handles empty/negative-threshold input', () => {
    expect(snap(-2, [0, 10], 1)).toBe(0);
    expect(snap(8, [], 1)).toBe(8);
    expect(snap(8, [10], -1)).toBe(8);
  });

  it('reuses one sorted junction table throughout a roll gesture', () => {
    const track = denseTimeline(10_000).tracks[0]!;
    const first = trackJunctions(track);
    const second = trackJunctions(track);
    expect(second).toBe(first);
    expect(first).toHaveLength(9_999);
  });

  it('invalidates junctions naturally when an immutable track changes', () => {
    const track = denseTimeline(3).tracks[0]!;
    const first = trackJunctions(track);
    const changed = { ...track, clips: track.clips.slice(0, 2) };
    const second = trackJunctions(changed);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(1);
  });
});
