/**
 * The shared stock placement builder — the one shape of "a fetched stock clip on
 * the timeline", used by both the Stock panel and the agent's `add_stock`.
 *
 * The cross-path deep-equal lives in `apps/web-editor` (the only package that can
 * import both callers). What is asserted here is the decision itself: where the
 * clip lands, when it refuses, and that a refusal and its sentence agree.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Project, Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_STOCK_STILL_SECONDS,
  STOCK_OVERLAY_SCALE,
  buildAddStockOps,
  buildAddStockOverlayOps,
  buildDropStockOps,
  buildStockBinOps,
  frontPictureLaneIndex,
  stockPlacementConflictReason,
} from './stock-placement.js';
import { applyProjectPatch, invertProjectPatch, type AnyOperation, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

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

  /**
   * Run 19e20922: told "call add_stock again with atSeconds 49.8" on a 49.77s single take,
   * the model appended stock at 49.8s, 57.3s and 103.3s and then spent eleven calls undoing
   * it. The editor had asked for cutaways during the talk.
   */
  it('leads with the bin route when the programme is covered end to end', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('cam', 0, 10)] }]);
    const reason = stockPlacementConflictReason(tl, [existingVideo], 2, 6)!;
    expect(reason).toContain('covered end to end');
    expect(reason).toContain('past the last frame');
    // The route that actually makes a cutaway comes before the one that appends.
    expect(reason.indexOf('add_clip')).toBeLessThan(reason.indexOf('Only pass atSeconds'));
  });

  it('still leads with a real interior gap, where atSeconds is a cutaway slot', () => {
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('cam', 0, 10), clip('cam', 20, 40)] },
    ]);
    const reason = stockPlacementConflictReason(tl, [existingVideo], 8, 6)!;
    expect(reason).toContain('Call add_stock again with atSeconds 10.0');
    expect(reason).not.toContain('covered end to end');
  });
});

// ---------------------------------------------------------------------------
// Manual placements from the Photos and Videos panel (plan/elements EL9, ADR 0193)
// ---------------------------------------------------------------------------

/** A project around `tracks`, so the patch can be applied and inverted at project scope. */
function projectOf(
  tracks: Timeline['tracks'],
  assets: readonly Asset[] = [existingVideo],
): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [...assets],
    folders: [],
    timeline: { tracks },
  } as unknown as Project;
}

function patchOf(operations: readonly AnyOperation[]): Patch {
  return {
    patchId: 'stock' as Patch['patchId'],
    createdBy: 'user',
    reason: 'Add stock',
    operations: [...operations],
  };
}

/**
 * The project's content. `revision` is left out: picture on a video lane moves the timeline's
 * mapping clock, and an undo is a new revision rather than a rewind of it (see
 * `operation-algebra.property.test.ts`).
 */
function contentOf(project: Project): Project {
  const { revision: _revision, ...timelineContent } = project.timeline;
  return { ...project, timeline: timelineContent };
}

/** Valid, and one undo leaves the project exactly as it was. */
function expectOneUndo(before: Project, operations: readonly AnyOperation[]): Project {
  const patch = patchOf(operations);
  const check = validatePatch(before.timeline, patch, {
    assetIds: before.assets.map((asset) => asset.id),
    folders: before.folders,
  });
  expect(check.valid, JSON.stringify(check.issues)).toBe(true);
  const after = applyProjectPatch(before, patch);
  const undone = applyProjectPatch(after, invertProjectPatch(before, patch));
  expect(contentOf(undone)).toEqual(contentOf(before));
  return after;
}

/** A clip as the schema stores it — with its effect and keyframe lists — so ops can apply. */
function laneClip(trackId: string, assetId: string, start: number, end: number) {
  return { ...clip(assetId, start, end), trackId, effects: [], keyframes: [] };
}

const footage = { id: 'video_1', type: 'video', clips: [laneClip('video_1', 'cam', 0, 30)] };
const graphics = { id: 'overlay_1', type: 'overlay', clips: [] };
const voice = { id: 'audio_1', type: 'audio', clips: [laneClip('audio_1', 'vo', 0, 30)] };

describe('frontPictureLaneIndex', () => {
  it('opens in front of the front-most picture lane, under the graphics lanes', () => {
    // Stickers, shapes and titles stay on top of a picture the user adds (ADR 0191).
    expect(frontPictureLaneIndex(timeline([graphics, footage, voice]))).toBe(1);
    expect(frontPictureLaneIndex(timeline([footage, voice]))).toBe(0);
  });

  it('with no picture lane at all, still opens under the graphics and above the sound', () => {
    expect(frontPictureLaneIndex(timeline([graphics, voice]))).toBe(1);
    expect(frontPictureLaneIndex(timeline([graphics]))).toBe(1);
    expect(frontPictureLaneIndex(EMPTY)).toBe(0);
  });
});

describe('buildAddStockOverlayOps', () => {
  it('lays a picture-in-picture over footage — never refused for covering picture', () => {
    const before = projectOf([graphics, footage, voice] as unknown as Timeline['tracks']);
    // The same moment the cutaway Add refuses (ADR 0140) is the point of an overlay.
    expect(buildAddStockOps(before.timeline, before.assets, stockVideo, 4)).toBeNull();
    const placed = buildAddStockOverlayOps(before.timeline, before.assets, stockVideo, 4);
    expect(placed.createdLayer).toBe(true);
    expect(placed.operations.map((op) => op.type)).toEqual([
      'add_asset',
      'add_layer',
      'add_clip',
      'add_keyframes',
    ]);
    // In front of the footage, under the graphics lane.
    expect(placed.operations[1]).toMatchObject({ layerType: 'video', atIndex: 1 });
    const after = expectOneUndo(before, placed.operations);
    expect(after.timeline.tracks.map((track) => track.id)).toEqual([
      'overlay_1',
      placed.trackId,
      'video_1',
      'audio_1',
    ]);
    const added = after.timeline.tracks[1]!.clips[0]!;
    expect(added).toMatchObject({ id: placed.clipId, assetId: stockVideo.id, start: 4, end: 10 });
  });

  it('is 40% of its contain-fit size and centred: the base keyframes the handles write', () => {
    const before = projectOf([footage] as unknown as Timeline['tracks']);
    const placed = buildAddStockOverlayOps(before.timeline, before.assets, stockPhoto, 2);
    const keyframes = placed.operations.find((op) => op.type === 'add_keyframes');
    expect(STOCK_OVERLAY_SCALE).toBe(0.4);
    expect(keyframes).toEqual({
      type: 'add_keyframes',
      clipId: placed.clipId,
      replace: true,
      keyframes: [
        {
          id: `kf_${placed.clipId}_scale_base`,
          time: 0,
          property: 'scale',
          value: 0.4,
          easing: 'linear',
        },
        { id: `kf_${placed.clipId}_x_base`, time: 0, property: 'x', value: 0, easing: 'linear' },
        { id: `kf_${placed.clipId}_y_base`, time: 0, property: 'y', value: 0, easing: 'linear' },
      ],
    });
    // A photo has no length of its own; it gets the one every placed still gets.
    expect(placed.durationSeconds).toBe(DEFAULT_STOCK_STILL_SECONDS);
    expectOneUndo(before, placed.operations);
  });

  it('joins the picture-in-picture lane in front when it has room, rather than stacking lanes', () => {
    const first = projectOf([footage] as unknown as Timeline['tracks']);
    const one = buildAddStockOverlayOps(first.timeline, first.assets, stockVideo, 0);
    const withOne = expectOneUndo(first, one.operations);

    const later = buildAddStockOverlayOps(withOne.timeline, withOne.assets, stockPhoto, 12);
    expect(later.trackId).toBe(one.trackId);
    expect(later.createdLayer).toBe(false);
    expectOneUndo(withOne, later.operations);

    // Over the first one, a second lane opens in front of it: both stay visible.
    const over = buildAddStockOverlayOps(withOne.timeline, withOne.assets, stockPhoto, 2);
    expect(over.trackId).not.toBe(one.trackId);
    expect(over.operations.find((op) => op.type === 'add_layer')).toMatchObject({ atIndex: 0 });
    expectOneUndo(withOne, over.operations);
  });

  it('never puts the overlay on the footage lane, even over a gap in it', () => {
    const gappy = projectOf([
      {
        id: 'video_1',
        type: 'video',
        clips: [laneClip('video_1', 'cam', 0, 5), laneClip('video_1', 'cam', 20, 30)],
      },
    ] as unknown as Timeline['tracks']);
    const placed = buildAddStockOverlayOps(gappy.timeline, gappy.assets, stockVideo, 8);
    expect(placed.trackId).not.toBe('video_1');
    expectOneUndo(gappy, placed.operations);
  });

  it('skips a locked or hidden lane in front', () => {
    const lockedPip = projectOf([
      { id: 'pip', type: 'video', locked: true, clips: [] },
      footage,
    ] as unknown as Timeline['tracks']);
    expect(
      buildAddStockOverlayOps(lockedPip.timeline, lockedPip.assets, stockVideo, 0).trackId,
    ).not.toBe('pip');
  });

  it('does not add the asset twice when it is already in the bin', () => {
    const before = projectOf([footage] as unknown as Timeline['tracks'], [
      existingVideo,
      stockVideo,
    ]);
    const placed = buildAddStockOverlayOps(before.timeline, before.assets, stockVideo, 1);
    expect(placed.operations.some((op) => op.type === 'add_asset')).toBe(false);
    expectOneUndo(before, placed.operations);
  });

  it('is deterministic and clamps a negative start', () => {
    const tl = timeline([footage]);
    const a = buildAddStockOverlayOps(tl, [existingVideo], stockVideo, -3);
    const b = buildAddStockOverlayOps(tl, [existingVideo], stockVideo, 0);
    expect(a.start).toBe(0);
    expect(a.operations).toEqual(b.operations);
  });
});

describe('buildDropStockOps', () => {
  it('lands on the picture lane it was dropped on when that lane has room there', () => {
    const before = projectOf([
      { id: 'video_1', type: 'video', clips: [laneClip('video_1', 'cam', 0, 5)] },
    ] as unknown as Timeline['tracks']);
    const placed = buildDropStockOps(before.timeline, before.assets, stockVideo, 5, 'video_1');
    expect(placed).toMatchObject({ trackId: 'video_1', onDroppedLane: true, createdLayer: false });
    expect(placed.operations.map((op) => op.type)).toEqual(['add_asset', 'add_clip']);
    const after = expectOneUndo(before, placed.operations);
    expect(after.timeline.tracks[0]!.clips.map((c) => c.id)).toContain(placed.clipId);
  });

  it('over footage, opens a lane in front of the footage — a drag is an explicit stack', () => {
    const before = projectOf([graphics, footage] as unknown as Timeline['tracks']);
    const placed = buildDropStockOps(before.timeline, before.assets, stockVideo, 4, 'video_1');
    expect(placed.onDroppedLane).toBe(false);
    expect(placed.operations.find((op) => op.type === 'add_layer')).toMatchObject({
      layerType: 'video',
      atIndex: 1,
    });
    // Full frame: a drop is a cutaway the user placed by hand, not a picture-in-picture.
    expect(placed.operations.some((op) => op.type === 'add_keyframes')).toBe(false);
    expectOneUndo(before, placed.operations);
  });

  it('treats a drop on a graphics, sound or locked lane as a drop in front of the picture', () => {
    const before = projectOf([
      graphics,
      { id: 'video_1', type: 'video', locked: true, clips: [] },
      voice,
    ] as unknown as Timeline['tracks']);
    for (const lane of ['overlay_1', 'audio_1', 'video_1', 'gone']) {
      const placed = buildDropStockOps(before.timeline, before.assets, stockPhoto, 1, lane);
      expect(placed.onDroppedLane).toBe(false);
      expect(placed.createdLayer).toBe(true);
      expectOneUndo(before, placed.operations);
    }
  });
});
