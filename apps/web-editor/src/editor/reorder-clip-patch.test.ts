/**
 * A human can reorder shots too (GOLDEN-C.7, closing the asymmetry ADR 0173 left).
 *
 * `reorder_clips` shipped as an AI-only route: the agent could put the last shot first in
 * one atomic patch, and an editor doing it by hand had to drag every clip and hope the
 * gaps worked out — because a drag is a placement gesture that puts a clip at a TIME, and
 * "make this shot come first" is an ORDER.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import { reorderClipPatch } from './patch-builders.js';

function timeline(): Timeline {
  const clip = (id: string, start: number, end: number) => ({
    id,
    assetId: `asset_${id}`,
    trackId: 'v1',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  });
  return {
    tracks: [
      { id: 'v1', type: 'video', clips: [clip('a', 0, 2), clip('b', 2, 5), clip('c', 5, 6)] },
    ],
  } as unknown as Timeline;
}

const order = (t: Timeline) => t.tracks[0]!.clips.map((c) => c.id);

describe('reorderClipPatch', () => {
  it('moves a clip one place later and keeps every clip', () => {
    const before = timeline();
    const patch = reorderClipPatch(before, 'a', 1)!;
    expect(patch).not.toBeNull();
    const after = applyPatch(before, patch, { fps: 30 });
    expect(order(after)).toEqual(['b', 'a', 'c']);
    expect(after.tracks[0]!.clips).toHaveLength(3);
  });

  it('moves a clip one place earlier', () => {
    const after = applyPatch(timeline(), reorderClipPatch(timeline(), 'c', -1)!, { fps: 30 });
    expect(order(after)).toEqual(['a', 'c', 'b']);
  });

  it('lays the track out gaplessly, keeping each clip its own length', () => {
    const after = applyPatch(timeline(), reorderClipPatch(timeline(), 'c', -1)!, { fps: 30 });
    const spans = after.tracks[0]!.clips.map((c) => [c.start, c.end]);
    // c is 1s, b is 3s, a is 2s → a[0,2] c[2,3] b[3,6]
    expect(spans).toEqual([
      [0, 2],
      [2, 3],
      [3, 6],
    ]);
  });

  it('returns null at the ends, so the menu never offers a no-op', () => {
    expect(reorderClipPatch(timeline(), 'a', -1)).toBeNull();
    expect(reorderClipPatch(timeline(), 'c', 1)).toBeNull();
  });

  it('returns null for a clip that is not on the timeline', () => {
    expect(reorderClipPatch(timeline(), 'nope', 1)).toBeNull();
  });

  it('is authored by the user, so history attributes it correctly', () => {
    expect(reorderClipPatch(timeline(), 'a', 1)!.createdBy).toBe('user');
  });
});
