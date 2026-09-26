/**
 * Placing a sticker (plan/elements EL6a.4): one validated, reversible patch that brings the asset
 * and the Elements folder when the project lacks them, puts the clip on an overlay lane (never the
 * footage cutaway path), and writes the base transform the on-canvas handles would, so the art is
 * 30% of the frame height in any orientation.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Project } from '@framepilot/timeline-schema';
import {
  ELEMENTS_FOLDER_ID,
  buildAddStickerOps,
  elementAssetId,
  isElementAsset,
  stickerBaseScale,
} from './element-placement.js';
import { applyProjectPatch, invertProjectPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

const ART = 256 / 318;

const sticker = (itemId: string): Asset => ({
  id: elementAssetId('fluent3d', itemId),
  path: `media/elements/fluent3d/${itemId}.webp`,
  kind: 'image',
  media: { width: 318, height: 318 },
  source: {
    provider: 'fluent-emoji',
    remoteId: itemId,
    license: 'mit',
    licenseUrl: 'https://github.com/microsoft/fluentui-emoji/blob/x/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl:
      'https://raw.githubusercontent.com/microsoft/fluentui-emoji/x/assets/Fire/3D/fire_3d.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'talk', path: 'media/talk.mp4', kind: 'video', durationSeconds: 60 }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'talk',
              trackId: 'video_1',
              start: 0,
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    ...overrides,
  } as Project;
}

function patchOf(ops: ReturnType<typeof buildAddStickerOps>['operations']): Patch {
  return {
    patchId: 'sticker' as Patch['patchId'],
    createdBy: 'user',
    reason: 'Add sticker',
    operations: [...ops],
  };
}

describe('isElementAsset and elementAssetId', () => {
  it('knows a sticker by its provenance, never by a stored flag', () => {
    expect(isElementAsset(sticker('fire'))).toBe(true);
    expect(isElementAsset({ source: { provider: 'pexels' } as Asset['source'] })).toBe(false);
    expect(isElementAsset({})).toBe(false);
    expect(isElementAsset(undefined)).toBe(false);
    expect(elementAssetId('fluent3d', 'thumbs_up')).toBe('element_fluent3d_thumbs_up');
  });
});

describe('stickerBaseScale', () => {
  it('makes the art 30% of the frame height after the contain fit, in either orientation', () => {
    const landscape = stickerBaseScale(
      { width: 1920, height: 1080 },
      { width: 318, height: 318 },
      ART,
    );
    expect(318 * (1080 / 318) * ART * landscape).toBeCloseTo(0.3 * 1080, 0);
    const portrait = stickerBaseScale(
      { width: 1080, height: 1920 },
      { width: 318, height: 318 },
      ART,
    );
    expect(318 * (1080 / 318) * ART * portrait).toBeCloseTo(0.3 * 1920, 0);
  });
});

describe('buildAddStickerOps', () => {
  it('brings the folder and the asset, opens an overlay lane, and undoes to the same project', () => {
    const before = project();
    const placed = buildAddStickerOps(before, sticker('fire'), 2, 5, { artFraction: ART });
    const types = placed.operations.map((op) => op.type);
    expect(types).toEqual(['create_folder', 'add_asset', 'add_layer', 'add_clip', 'add_keyframes']);
    const patch = patchOf(placed.operations);
    const check = validatePatch(before.timeline, patch, {
      assetIds: before.assets.map((a) => a.id),
      folders: before.folders ?? [],
    });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(before, patch);
    const clip = after.timeline.tracks
      .find((track) => track.id === placed.trackId)!
      .clips.find((c) => c.id === placed.clipId)!;
    expect(clip).toMatchObject({ start: 2, end: 5, sourceStart: 0, sourceEnd: 3 });
    expect(after.timeline.tracks.find((t) => t.id === placed.trackId)?.type).toBe('overlay');
    expect(after.assets.find((a) => a.id === 'element_fluent3d_fire')?.folderId).toBe(
      ELEMENTS_FOLDER_ID,
    );
    expect(clip.keyframes.map((k) => [k.property, k.time])).toEqual([
      ['scale', 0],
      ['x', 0],
      ['y', 0],
    ]);
    expect(applyProjectPatch(after, invertProjectPatch(before, patch))).toEqual(before);
  });

  it('reuses the asset and the folder the second time, on the sticker lane when it has room', () => {
    const first = project();
    const once = applyProjectPatch(
      first,
      patchOf(buildAddStickerOps(first, sticker('fire'), 0, 2).operations),
    );
    const again = buildAddStickerOps(once, sticker('fire'), 4, 6);
    expect(again.operations.map((op) => op.type)).toEqual(['add_clip', 'add_keyframes']);
    const other = buildAddStickerOps(once, sticker('rocket'), 1, 3);
    // The sticker lane is busy from 0 to 2, so an overlapping one opens a lane of its own.
    expect(other.operations.map((op) => op.type)).toEqual([
      'add_asset',
      'add_layer',
      'add_clip',
      'add_keyframes',
    ]);
  });

  it('never places a sticker on a picture lane, even when named', () => {
    const placed = buildAddStickerOps(project(), sticker('fire'), 0, 2, { trackId: 'video_1' });
    expect(placed.trackId).not.toBe('video_1');
  });

  it('places the centre where it is dropped, in the handles’ canvas pixels', () => {
    const placed = buildAddStickerOps(project(), sticker('fire'), 0, 2, {
      offset: { x: -300, y: 120 },
    });
    const keyframes = placed.operations.at(-1) as {
      keyframes: { property: string; value: number }[];
    };
    expect(keyframes.keyframes.find((k) => k.property === 'x')?.value).toBe(-300);
    expect(keyframes.keyframes.find((k) => k.property === 'y')?.value).toBe(120);
  });
});
