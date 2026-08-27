/**
 * The shared stock placement builder — the one shape of "a fetched stock clip on
 * the timeline", used by both the Stock panel and the agent's `add_stock`.
 *
 * The cross-path deep-equal lives in `apps/web-editor` (the only package that can
 * import both callers). What is asserted here is the decision itself: where the
 * clip lands, when it refuses, and that a refusal and its sentence agree.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_STOCK_STILL_SECONDS,
  buildAddStockOps,
  buildStockBinOps,
  stockPlacementConflictReason,
} from './stock-placement.js';

const stockVideo: Asset = {
  id: 'stock_pexels_1',
  path: 'media/p/city.mp4',
  kind: 'video',
  durationSeconds: 6,
};
const stockPhoto: Asset = { id: 'stock_pexels_2', path: 'media/p/rocks.jpg', kind: 'image' };
const existingVideo: Asset = { id: 'cam', path: 'media/p/cam.mp4', kind: 'video' };
const existingAudio: Asset = { id: 'vo', path: 'media/p/vo.wav', kind: 'audio' };

function clip(assetId: string, start: number, end: number) {
  return { id: `${assetId}_${start}`, assetId, start, end, sourceStart: 0, sourceEnd: end - start };
}

function timeline(
  tracks: readonly { id: string; type?: string; clips: ReturnType<typeof clip>[] }[],
): Timeline {
  return { tracks } as unknown as Timeline;
}

const EMPTY = timeline([]);

describe('buildAddStockOps', () => {
  it('creates a layer for the first clip on an empty timeline', () => {
    const placement = buildAddStockOps(EMPTY, [], stockVideo, 0)!;
    expect(placement).not.toBeNull();
    expect(placement.createdLayer).toBe(true);
    expect(placement.operations.map((op) => op.type)).toEqual([
      'add_asset',
      'add_layer',
      'add_clip',
    ]);
    // One patch's worth of operations: the bin entry, the layer and the clip
    // invert together, so a single undo leaves no orphan asset or empty layer.
    expect(placement.operations[2]).toMatchObject({
      trackId: placement.trackId,
      assetId: stockVideo.id,
      start: 0,
      end: 6,
    });
  });

  it('reuses an existing picture layer that has room, rather than stacking layers', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('cam', 0, 5)] }]);
    const placement = buildAddStockOps(tl, [existingVideo], stockVideo, 5)!;
    expect(placement.createdLayer).toBe(false);
    expect(placement.trackId).toBe('video_1');
    expect(placement.operations.map((op) => op.type)).toEqual(['add_asset', 'add_clip']);
  });

  it('gives a still the default length, because a photo has no duration of its own', () => {
    const placement = buildAddStockOps(EMPTY, [], stockPhoto, 0)!;
    expect(placement.durationSeconds).toBe(DEFAULT_STOCK_STILL_SECONDS);
    expect(placement.kind).toBe('image');
  });

  it('refuses to overlap existing picture, whichever track it sits on', () => {
    // The refusal IS the feature: the preview flattens picture from every track
    // into one sequence while the export composites them, so an overlap would
    // render differently from how it previews.
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [] },
      { id: 'video_2', type: 'video', clips: [clip('cam', 4, 12)] },
    ]);
    expect(buildAddStockOps(tl, [existingVideo], stockVideo, 6)).toBeNull();
    // Butting up against it is fine — that is what an editor does.
    expect(buildAddStockOps(tl, [existingVideo], stockVideo, 12)).not.toBeNull();
  });

  it('does not treat an audio layer as an occupied span', () => {
    const tl = timeline([{ id: 'audio_1', type: 'audio', clips: [clip('vo', 0, 30)] }]);
    const placement = buildAddStockOps(tl, [existingAudio], stockVideo, 2);
    expect(placement).not.toBeNull();
    // Nor does it drop picture onto the voiceover layer.
    expect(placement!.trackId).not.toBe('audio_1');
  });

  it('clamps a negative start rather than producing an invalid clip', () => {
    expect(buildAddStockOps(EMPTY, [], stockVideo, -10)!.start).toBe(0);
  });

  it('is deterministic — the same intent twice produces the same operations', () => {
    // An agent-placed clip and a hand-placed one must be indistinguishable,
    // including to a later operation that names the clip by id.
    const a = buildAddStockOps(EMPTY, [], stockVideo, 3)!;
    const b = buildAddStockOps(EMPTY, [], stockVideo, 3)!;
    expect(a.operations).toEqual(b.operations);
  });
});

describe('buildStockBinOps', () => {
  // `add_stock` used to be download-AND-place with no other mode, so gathering candidates
  // was impossible: the second download of a comparison always hit the occupancy refusal
  // raised by the first. A captured run said twice it was "locking the media into the bin
  // first", found no tool for it, and invented an asset path.
  it('registers the asset and touches the timeline not at all', () => {
    expect(buildStockBinOps(stockVideo)).toEqual([{ type: 'add_asset', asset: stockVideo }]);
  });

  it('never conflicts, so several candidates can be gathered before any order is chosen', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('cam', 0, 10)] }]);
    // The same moment that refuses a placement accepts any number of bin arrivals.
    expect(buildAddStockOps(tl, [existingVideo], stockVideo, 2)).toBeNull();
    expect(buildStockBinOps(stockVideo)).toHaveLength(1);
  });
});

describe('stockPlacementConflictReason', () => {
  it('agrees with the builder, so a button and a tool cannot disagree', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('cam', 0, 10)] }]);
    for (const at of [0, 2, 9.9, 10, 20]) {
      const refused = buildAddStockOps(tl, [existingVideo], stockVideo, at) === null;
      const blocked = stockPlacementConflictReason(tl, [existingVideo], at, 6) !== null;
      expect(blocked).toBe(refused);
    }
  });

  it('names the span, so the user knows where to move to', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('cam', 0, 10)] }]);
    const reason = stockPlacementConflictReason(tl, [existingVideo], 2, 6)!;
    expect(reason).toContain('2.0s');
    expect(reason).toContain('8.0s');
    // The refusal has to end somewhere actionable. 10s is the end of the clip
    // in the way, and nothing follows it.
    expect(reason).toMatch(/starts at 10.0s/);
  });
});
