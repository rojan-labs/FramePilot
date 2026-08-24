import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { picturePlacementConflict } from './picture-occupancy.js';

const video: Asset = { id: 'a_video', path: 'a.mp4', kind: 'video' };
const image: Asset = { id: 'a_image', path: 'a.jpg', kind: 'image' };
const audio: Asset = { id: 'a_audio', path: 'a.wav', kind: 'audio' };

function clip(assetId: string, start: number, end: number) {
  return { id: `${assetId}_${start}`, assetId, start, end, sourceStart: 0, sourceEnd: end - start };
}

function timeline(
  tracks: readonly { id: string; type?: string; clips: ReturnType<typeof clip>[] }[],
): Timeline {
  return { tracks } as unknown as Timeline;
}

describe('picturePlacementConflict', () => {
  const assets = [video, image, audio];

  it('is false over empty time', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 10, 20)).toBe(false);
  });

  it('is true over an overlapping picture clip', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 5, 15)).toBe(true);
    expect(picturePlacementConflict(tl, assets, 0, 1)).toBe(true);
    expect(picturePlacementConflict(tl, assets, 9.9, 12)).toBe(true);
  });

  it('treats touching edges as no conflict', () => {
    // Butting a cutaway against the clip before it is exactly what an editor
    // does; refusing that would make the feature unusable.
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 10, 20)).toBe(false);
    expect(picturePlacementConflict(tl, assets, -5, 0)).toBe(false);
  });

  it('sees a conflict on a track OTHER than the first, because the preview flattens them', () => {
    // The load-bearing ADR 0140 property, and the one a per-track refactor would
    // silently break: the occupied span is on `video_2` while `video_1` is empty
    // over it, so an implementation that only consulted "the" picture track
    // would report no conflict and ship an export that does not match the
    // preview. Overlap is measured in TIME, never by layer.
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('a_video', 0, 2)] },
      { id: 'video_2', type: 'video', clips: [clip('a_image', 6, 12)] },
    ]);
    expect(picturePlacementConflict(tl, assets, 7, 9)).toBe(true);
    // And the gap BETWEEN the two tracks' clips is genuinely free.
    expect(picturePlacementConflict(tl, assets, 2, 6)).toBe(false);
  });

  it('sees a conflict from two tracks whose clips together leave no gap', () => {
    // Neither track alone covers 3–7s; together they do. An implementation that
    // answered per track would let a clip through into the seam.
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('a_video', 0, 5)] },
      { id: 'video_2', type: 'video', clips: [clip('a_image', 5, 10)] },
    ]);
    expect(picturePlacementConflict(tl, assets, 3, 7)).toBe(true);
  });

  it('counts images as picture', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_image', 0, 5)] }]);
    expect(picturePlacementConflict(tl, assets, 1, 2)).toBe(true);
  });

  it('ignores audio, overlay, effect and caption layers', () => {
    const tl = timeline([
      { id: 'audio_1', type: 'audio', clips: [clip('a_audio', 0, 30)] },
      { id: 'overlay_1', type: 'overlay', clips: [clip('a_video', 0, 30)] },
      { id: 'caption_1', type: 'caption', clips: [clip('a_video', 0, 30)] },
    ]);
    // A title above a cutaway is not a conflict; those layers composite
    // separately from the picture chain.
    expect(picturePlacementConflict(tl, assets, 0, 10)).toBe(false);
  });

  it('treats an unknown asset as picture, because the failure modes are asymmetric', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('ghost', 0, 10)] }]);
    // Wrongly refusing costs one repositioning; wrongly allowing ships an export
    // that does not match the preview.
    expect(picturePlacementConflict(tl, [], 1, 2)).toBe(true);
  });

  it('is false for an empty or inverted span', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 5, 5)).toBe(false);
    expect(picturePlacementConflict(tl, assets, 8, 2)).toBe(false);
  });

  it('handles an empty timeline', () => {
    expect(picturePlacementConflict(timeline([]), assets, 0, 10)).toBe(false);
  });
});
