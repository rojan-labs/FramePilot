/**
 * Stock placement — the preview/export parity constraint, as tests.
 *
 * The load-bearing property here is a refusal: a stock clip must never land
 * where it would overlap existing picture media, because the preview flattens
 * picture clips from every track into one sequence while the export composites
 * them. If this suite goes green while the refusal is gone, the panel is
 * shipping clips that render differently from how they preview.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  addStockClipPatch,
  picturePlacementConflict,
  placeAssetPatch,
  stockPlacementBlockedReason,
} from './patch-builders.js';
import { applyUserPatch, createEditorState, redoEdit, undoEdit } from './store.js';
import { demoAssetIds, demoTimeline } from './demo.js';

const STOCK_VIDEO: Asset = {
  id: 'stock_pexels_3129671',
  path: 'media/proj/city-skyline-3129671.mp4',
  kind: 'video',
  durationSeconds: 12,
  source: {
    provider: 'pexels',
    remoteId: '3129671',
    license: 'pexels',
    attributionRequired: false,
    attribution: 'Video by Ruvim on Pexels',
    creator: 'Ruvim',
    fetchedAt: '2026-08-24T12:00:00.000Z',
  },
};

const STOCK_PHOTO: Asset = {
  id: 'stock_pexels_2014422',
  path: 'media/proj/brown-rocks-2014422.jpg',
  kind: 'image',
  source: {
    provider: 'pexels',
    remoteId: '2014422',
    license: 'pexels',
    attributionRequired: false,
    fetchedAt: '2026-08-24T12:00:00.000Z',
  },
};

const EMPTY: Timeline = { tracks: [] };

/** The demo timeline: clip_intro [0,6] and clip_body [6,14] on a video layer. */
const assetById = new Map<string, Asset>(
  demoAssetIds.map((id) => [id, { id, path: `${id}.mp4`, kind: 'video' } as Asset]),
);

describe('picturePlacementConflict', () => {
  it('is false over empty time', () => {
    expect(picturePlacementConflict(demoTimeline, assetById, 20, 32)).toBe(false);
  });

  it('is true over an existing picture clip', () => {
    expect(picturePlacementConflict(demoTimeline, assetById, 2, 8)).toBe(true);
  });

  it('treats touching edges as no conflict', () => {
    // clip_body ends at 14. Butting a cutaway against it is exactly what an
    // editor does, and refusing that would make the feature unusable.
    expect(picturePlacementConflict(demoTimeline, assetById, 14, 20)).toBe(false);
  });

  it('ignores audio, which does not flow through the picture chain', () => {
    const audioOnly: Timeline = {
      tracks: [
        {
          id: 'audio_1',
          clips: [
            { id: 'vo', assetId: 'vo_asset', start: 0, end: 30, sourceStart: 0, sourceEnd: 30 },
          ],
        } as Timeline['tracks'][number],
      ],
    };
    const lookup = new Map<string, Asset>([
      ['vo_asset', { id: 'vo_asset', path: 'vo.wav', kind: 'audio' }],
    ]);
    expect(picturePlacementConflict(audioOnly, lookup, 0, 10)).toBe(false);
  });
});

describe('addStockClipPatch', () => {
  it('refuses to stack over existing footage', () => {
    // The whole point. Stacking here would preview as one thing and export as
    // another, which is the divergence SUC-P1 exists to close.
    expect(addStockClipPatch(demoTimeline, assetById, STOCK_VIDEO, 2)).toBeNull();
  });

  it('places into empty time after the last clip', () => {
    const patch = addStockClipPatch(demoTimeline, assetById, STOCK_VIDEO, 14);
    expect(patch).not.toBeNull();
    expect(patch!.operations.map((op) => op.type)).toContain('add_asset');
    expect(patch!.operations.map((op) => op.type)).toContain('add_clip');
  });

  it('places the first clip on an empty timeline', () => {
    // A clip that overlaps nothing composites identically either way. Refusing
    // it would mean the first photo added to a new project is rejected for
    // conflicting with nothing.
    const patch = addStockClipPatch(EMPTY, new Map(), STOCK_PHOTO, 0);
    expect(patch).not.toBeNull();
    expect(patch!.operations.map((op) => op.type)).toEqual(['add_asset', 'add_layer', 'add_clip']);
  });

  it('gives a photo the default clip length rather than a fake duration', () => {
    const patch = addStockClipPatch(EMPTY, new Map(), STOCK_PHOTO, 0)!;
    const clip = patch.operations.find((op) => op.type === 'add_clip') as {
      start: number;
      end: number;
    };
    expect(clip.end).toBeGreaterThan(clip.start);
    expect(STOCK_PHOTO.durationSeconds).toBeUndefined();
  });

  it('uses the video duration for a clip', () => {
    const patch = addStockClipPatch(demoTimeline, assetById, STOCK_VIDEO, 20)!;
    const clip = patch.operations.find((op) => op.type === 'add_clip') as {
      start: number;
      end: number;
      sourceEnd: number;
    };
    expect(clip.start).toBe(20);
    expect(clip.end).toBe(32);
    expect(clip.sourceEnd).toBe(12);
  });

  it('clamps a negative start to zero', () => {
    const patch = addStockClipPatch(EMPTY, new Map(), STOCK_VIDEO, -5)!;
    const clip = patch.operations.find((op) => op.type === 'add_clip') as { start: number };
    expect(clip.start).toBe(0);
  });

  it('is deterministic — the same intent yields the same patch id', () => {
    const a = addStockClipPatch(EMPTY, new Map(), STOCK_VIDEO, 3);
    const b = addStockClipPatch(EMPTY, new Map(), STOCK_VIDEO, 3);
    expect(a!.patchId).toBe(b!.patchId);
  });

  it('carries the provenance into the bin', () => {
    const patch = addStockClipPatch(EMPTY, new Map(), STOCK_VIDEO, 0)!;
    const add = patch.operations.find((op) => op.type === 'add_asset') as { asset: Asset };
    // If this field is not written here, the Credits view is empty and the
    // photographer is uncreditable.
    expect(add.asset.source).toMatchObject({
      provider: 'pexels',
      remoteId: '3129671',
      attributionRequired: false,
      attribution: 'Video by Ruvim on Pexels',
    });
  });

  it('diverges from placeAssetPatch exactly where it should', () => {
    // placeAssetPatch stacks, because a dragged-in file is a deliberate choice
    // the user can see. A one-click Add in a search panel is not.
    expect(placeAssetPatch(demoTimeline, assetById, STOCK_VIDEO, 2)).not.toBeNull();
    expect(addStockClipPatch(demoTimeline, assetById, STOCK_VIDEO, 2)).toBeNull();
  });
});

describe('one undo removes everything', () => {
  it('applies, undoes and redoes through the real store', () => {
    const patch = addStockClipPatch(EMPTY, new Map(), STOCK_VIDEO, 0)!;
    const base = createEditorState(EMPTY, { assetIds: [] });

    const added = applyUserPatch(base, patch);
    expect(added.issues).toEqual([]);
    expect(added.timeline.tracks).toHaveLength(1);
    expect(added.timeline.tracks[0]!.clips).toHaveLength(1);

    // One press, not three: the user did one thing.
    const undone = undoEdit(added);
    expect(undone.timeline.tracks).toHaveLength(0);

    const redone = redoEdit(undone);
    expect(redone.timeline.tracks[0]!.clips).toHaveLength(1);
  });
});

describe('stockPlacementBlockedReason', () => {
  it('names the problem and the fix, not just the problem', () => {
    const reason = stockPlacementBlockedReason(demoTimeline, assetById, 2, 5);
    expect(reason).toMatch(/already footage/i);
    expect(reason).toMatch(/move the playhead|make a gap/i);
  });

  it('is null where placement would succeed', () => {
    expect(stockPlacementBlockedReason(demoTimeline, assetById, 20, 5)).toBeNull();
    expect(stockPlacementBlockedReason(EMPTY, new Map(), 0, 5)).toBeNull();
  });

  it('agrees with the builder, so the button never lies', () => {
    for (const at of [0, 2, 6, 13.9, 14, 20]) {
      const blocked = stockPlacementBlockedReason(demoTimeline, assetById, at, 12) !== null;
      const refused = addStockClipPatch(demoTimeline, assetById, STOCK_VIDEO, at) === null;
      expect(blocked).toBe(refused);
    }
  });
});
