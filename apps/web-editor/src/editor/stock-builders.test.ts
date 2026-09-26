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
  addImageOverlayPatch,
  addStockClipPatch,
  addStockOverlayPatch,
  dropStockClipPatch,
  imageOverlayAnnouncement,
  stockAddedAnnouncement,
  stockPlacementBlockedReason,
} from './patch-builders.js';
import { applyUserPatch, createEditorState, redoEdit, undoEdit } from './store.js';
import { StockAssetPayloadSchema, stockOpsFromPayload } from '@framepilot/ai-sdk';

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

/**
 * The media bin's **Add as overlay** on the user's own images (a logo, a screenshot, a cut-out):
 * the same builder as the Pexels tile's (ADR 0193, amendment "bin images"), a second entry point.
 */
describe('addImageOverlayPatch', () => {
  const LOGO: Asset = {
    id: 'asset_logo',
    path: 'media/p/logo.png',
    kind: 'image',
    durationSeconds: 5,
    media: { width: 400, height: 200 },
  };
  const inBin = { timeline: TALKING_HEAD, assets: [CAMERA, LOGO] };
  const binProject = (): Project => ({ ...projectOf(TALKING_HEAD), assets: [CAMERA, LOGO] });

  it('lays a bin image over the footage without adding it to the bin again', () => {
    const { patch, clipId, start } = addImageOverlayPatch(inBin, LOGO, 'logo.png', 4);
    expect(start).toBe(4);
    // The asset is already the project's: no asset operation, so undo cannot take it out.
    expect(patch.operations.map((op) => op.type)).toEqual([
      'add_layer',
      'add_clip',
      'add_keyframes',
    ]);
    const check = validatePatch(TALKING_HEAD, patch, {
      assetIds: [CAMERA.id, LOGO.id],
      assets: [CAMERA, LOGO],
      folders: [],
    });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(binProject(), patch);
    expect(after.timeline.tracks.map((track) => track.id)).toEqual([
      'graphics',
      expect.any(String),
      'video_1',
    ]);
    const clip = after.timeline.tracks[1]!.clips[0]!;
    expect(clip).toMatchObject({ id: clipId, assetId: LOGO.id, start: 4, end: 9 });
    expect(clip.keyframes.map((k) => [k.property, k.time, k.value])).toEqual([
      ['scale', 0, STOCK_OVERLAY_SCALE],
      ['x', 0, 0],
      ['y', 0, 0],
    ]);
    expect(after.assets).toEqual([CAMERA, LOGO]);
  });

  it('is the Pexels overlay’s placement, under its own name in History', () => {
    const own = addImageOverlayPatch(inBin, LOGO, 'logo.png', 4);
    const stock = addStockOverlayPatch(inBin, LOGO, 4);
    expect(own.patch.operations).toEqual(stock.patch.operations);
    expect(own.patch.patchId).not.toBe(stock.patch.patchId);
    expect(own.patch.reason).toBe('Add “logo.png” as an overlay');
    expect(own.patch.createdBy).toBe('user');
  });

  it('inverts to exactly the project it started from, and one undo leaves the bin as it was', () => {
    const before = binProject();
    const { patch } = addImageOverlayPatch(inBin, LOGO, 'logo.png', 12);
    const after = applyProjectPatch(before, patch);
    expect(contentOf(applyProjectPatch(after, invertProjectPatch(before, patch)))).toEqual(
      contentOf(before),
    );

    const added = applyUserPatch(
      createEditorState(TALKING_HEAD, { assets: [CAMERA, LOGO] }),
      patch,
    );
    expect(added.issues).toEqual([]);
    const undone = undoEdit(added);
    expect(undone.timeline.tracks.map((track) => track.id)).toEqual(['graphics', 'video_1']);
    expect(undone.assets.map((asset) => asset.id)).toEqual([CAMERA.id, LOGO.id]);
  });

  it('is announced by the file’s name and where it starts', () => {
    expect(imageOverlayAnnouncement('logo.png', 12.7)).toBe('Added logo.png as an overlay at 0:12');
  });
});

describe('stockAddedAnnouncement', () => {
  it('says what landed and where, for a screen reader (02 §3: "Added … at 0:12")', () => {
    const overlay = addStockOverlayPatch(target, STOCK_VIDEO, 12.7);
    expect(overlay.start).toBe(12.7);
    expect(stockAddedAnnouncement(STOCK_VIDEO, 'overlay', overlay.start)).toBe(
      'Added the video as an overlay at 0:12',
    );
    expect(stockAddedAnnouncement(STOCK_PHOTO, 'drop', 75)).toBe('Added the photo at 1:15');
    // Add (a cutaway) is said the way a drop is: it lands full frame.
    expect(stockAddedAnnouncement(STOCK_VIDEO, 'cutaway', 12)).toBe('Added the video at 0:12');
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

/**
 * MD-E5 is manual only: the agent's `add_stock` keeps its cutaway rule until picture-in-picture
 * from the agent is measured (plan/elements 11 §2). This is the one package that can import both
 * paths, so it is where "the agent is unchanged" is held.
 */
describe('Add as overlay does not reach the agent', () => {
  const agentOutcome = (timeline: Timeline, assets: readonly Asset[], asset: Asset, at: number) =>
    stockOpsFromPayload(
      { ...projectOf(timeline), assets: [...assets] } as unknown as Parameters<
        typeof stockOpsFromPayload
      >[0],
      StockAssetPayloadSchema.parse({ asset, atSeconds: at }),
    );

  it('still refuses over footage what it cannot show as a full-frame cutaway', () => {
    // Nothing measured the camera, so nothing can say the stock clip hides it: the agent says no,
    // over the same footage where the panel's overlay places without asking.
    const unmeasuredCamera: Asset = { id: 'cam', path: 'media/p/cam.mp4', kind: 'video' };
    const agent = agentOutcome(TALKING_HEAD, [unmeasuredCamera], STOCK_PHOTO, 4);
    expect(agent.ok).toBe(false);
    if (agent.ok) throw new Error('unreachable');
    expect(agent.refusalCause).toBe('picture_over_picture');
    expect(
      addStockOverlayPatch({ timeline: TALKING_HEAD, assets: [unmeasuredCamera] }, STOCK_PHOTO, 4)
        .patch.operations,
    ).toContainEqual(expect.objectContaining({ type: 'add_keyframes' }));
  });

  it('where it does place over footage, places a full-frame cutaway — never the overlay', () => {
    const measuredCamera: Asset = { ...CAMERA, media: { width: 1920, height: 1080 } };
    const agent = agentOutcome(TALKING_HEAD, [measuredCamera], STOCK_VIDEO, 4);
    expect(agent.ok).toBe(true);
    if (!agent.ok) throw new Error('unreachable');
    // No base transform: the clip fills the frame, which is what a cutaway is.
    expect(agent.operations.some((op) => op.type === 'add_keyframes')).toBe(false);
    const overlay = addStockOverlayPatch(
      { timeline: TALKING_HEAD, assets: [measuredCamera] },
      STOCK_VIDEO,
      4,
    );
    expect(agent.operations).not.toEqual(overlay.patch.operations);
  });
});
