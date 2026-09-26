/**
 * Manual placements from Elements → Photos and Videos (plan/elements EL9, ADR 0193): **Add as
 * overlay** lays a picture-in-picture over footage, and a tile dropped on the timeline lands
 * where it was dropped. Each is one validated patch that one undo takes back — asset, lane and
 * clip together — and neither goes near the cutaway Add's refusal, which stays as it was.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  invertProjectPatch,
  STOCK_OVERLAY_SCALE,
  validatePatch,
} from '@framepilot/editor-core';
import type { Asset, Project, Timeline } from '@framepilot/timeline-schema';
import {
  addStockClipPatch,
  addStockOverlayPatch,
  dropStockClipPatch,
  stockPlacementBlockedReason,
} from './patch-builders.js';
import { applyUserPatch, createEditorState, redoEdit, undoEdit } from './store.js';

const CAMERA: Asset = { id: 'cam', path: 'media/p/cam.mp4', kind: 'video', durationSeconds: 60 };

const STOCK_VIDEO: Asset = {
  id: 'stock_pexels_3129671',
  path: 'media/p/city-skyline-3129671.mp4',
  kind: 'video',
  durationSeconds: 6,
  media: { width: 1920, height: 1080 },
  source: {
    provider: 'pexels',
    remoteId: '3129671',
    license: 'pexels',
    attributionRequired: false,
    fetchedAt: '2026-09-26T12:00:00.000Z',
  },
};

const STOCK_PHOTO: Asset = {
  id: 'stock_pexels_2014422',
  path: 'media/p/rocks-2014422.jpg',
  kind: 'image',
  source: {
    provider: 'pexels',
    remoteId: '2014422',
    license: 'pexels',
    attributionRequired: false,
    fetchedAt: '2026-09-26T12:00:00.000Z',
  },
};

const talk = {
  id: 'talk',
  assetId: 'cam',
  trackId: 'video_1',
  start: 0,
  end: 30,
  sourceStart: 0,
  sourceEnd: 30,
  effects: [],
  keyframes: [],
};

/** A talking head covering 0–30s under a graphics lane: every moment is occupied picture. */
const TALKING_HEAD: Timeline = {
  tracks: [
    { id: 'graphics', type: 'overlay', clips: [] },
    { id: 'video_1', type: 'video', clips: [talk] },
  ],
} as unknown as Timeline;

function projectOf(timeline: Timeline): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [CAMERA],
    folders: [],
    timeline,
  } as unknown as Project;
}

/** Content without the timeline's revision clock, which an undo advances rather than rewinds. */
function contentOf(project: Project): Project {
  const { revision: _revision, ...timeline } = project.timeline;
  return { ...project, timeline };
}

const target = { timeline: TALKING_HEAD, assets: [CAMERA] };

describe('addStockOverlayPatch', () => {
  it('lays the media over footage where the cutaway Add is refused', () => {
    // Add keeps ADR 0140: over picture it is disabled with the reason, before the click.
    const assetById = new Map([[CAMERA.id, CAMERA]]);
    expect(addStockClipPatch(TALKING_HEAD, assetById, STOCK_VIDEO, 4)).toBeNull();
    expect(stockPlacementBlockedReason(TALKING_HEAD, assetById, 4, 6)).not.toBeNull();

    const { patch, clipId } = addStockOverlayPatch(target, STOCK_VIDEO, 4);
    const check = validatePatch(TALKING_HEAD, patch, { assetIds: [CAMERA.id], folders: [] });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(projectOf(TALKING_HEAD), patch);
    // In front of the footage, under the graphics lane.
    expect(after.timeline.tracks.map((track) => track.id)).toEqual([
      'graphics',
      expect.any(String),
      'video_1',
    ]);
    const clip = after.timeline.tracks[1]!.clips[0]!;
    expect(clip).toMatchObject({ id: clipId, assetId: STOCK_VIDEO.id, start: 4, end: 10 });
    expect(clip.keyframes.map((k) => [k.property, k.time, k.value])).toEqual([
      ['scale', 0, STOCK_OVERLAY_SCALE],
      ['x', 0, 0],
      ['y', 0, 0],
    ]);
    expect(after.assets.map((asset) => asset.id)).toContain(STOCK_VIDEO.id);
  });

  it('inverts to exactly the project it started from', () => {
    const before = projectOf(TALKING_HEAD);
    const { patch } = addStockOverlayPatch(target, STOCK_PHOTO, 12);
    const after = applyProjectPatch(before, patch);
    expect(contentOf(applyProjectPatch(after, invertProjectPatch(before, patch)))).toEqual(
      contentOf(before),
    );
  });

  it('comes off in one undo — asset, lane and clip — through the real store', () => {
    const { patch } = addStockOverlayPatch(target, STOCK_VIDEO, 4);
    const base = createEditorState(TALKING_HEAD, { assets: [CAMERA] });
    const added = applyUserPatch(base, patch);
    expect(added.issues).toEqual([]);
    expect(added.timeline.tracks).toHaveLength(3);
    expect(added.assets.map((asset) => asset.id)).toContain(STOCK_VIDEO.id);

    const undone = undoEdit(added);
    expect(undone.timeline.tracks.map((track) => track.id)).toEqual(['graphics', 'video_1']);
    expect(undone.assets.map((asset) => asset.id)).toEqual([CAMERA.id]);

    const redone = redoEdit(undone);
    expect(redone.timeline.tracks).toHaveLength(3);
  });

  it('names the edit for History and is the same patch for the same intent', () => {
    const first = addStockOverlayPatch(target, STOCK_PHOTO, 2);
    expect(first.patch.reason).toMatch(/overlay/);
    expect(first.patch.createdBy).toBe('user');
    expect(addStockOverlayPatch(target, STOCK_PHOTO, 2).patch).toEqual(first.patch);
  });
});

describe('dropStockClipPatch', () => {
  const gap: Timeline = {
    tracks: [{ id: 'video_1', type: 'video', clips: [{ ...talk, end: 5, sourceEnd: 5 }] }],
  } as unknown as Timeline;

  it('lands full frame on the picture lane it was dropped on when that lane has room', () => {
    const dropped = dropStockClipPatch(
      { timeline: gap, assets: [CAMERA] },
      STOCK_VIDEO,
      5,
      'video_1',
    );
    expect(dropped.onDroppedLane).toBe(true);
    const after = applyProjectPatch(projectOf(gap), dropped.patch);
    const clip = after.timeline.tracks[0]!.clips.find((c) => c.id === dropped.clipId);
    expect(clip).toMatchObject({ assetId: STOCK_VIDEO.id, start: 5, end: 11, keyframes: [] });
  });

  it('over footage, opens a lane in front of it — a drag is a stack the user chose', () => {
    const dropped = dropStockClipPatch(target, STOCK_VIDEO, 4, 'video_1');
    expect(dropped.onDroppedLane).toBe(false);
    const before = projectOf(TALKING_HEAD);
    const after = applyProjectPatch(before, dropped.patch);
    expect(after.timeline.tracks[1]!.clips[0]).toMatchObject({ id: dropped.clipId, start: 4 });
    expect(contentOf(applyProjectPatch(after, invertProjectPatch(before, dropped.patch)))).toEqual(
      contentOf(before),
    );
  });
});
