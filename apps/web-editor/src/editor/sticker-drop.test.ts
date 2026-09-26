/**
 * A sticker dropped on the timeline (plan/elements EL6b): main copies it in by id, as a click
 * does, and one patch places it at the drop time — on the lane it was dropped on when that lane
 * has room — or the drop says why it could not.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyProjectPatch, invertProjectPatch, validatePatch } from '@framepilot/editor-core';
import { stickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import type { ElementAssetWire, ElementMaterializeResult } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { placeDroppedSticker } from './sticker-drop.js';

const fire: StickerItem = {
  id: 'fire',
  name: 'Fire',
  glyph: '🔥',
  unicode: null,
  group: 'Travel & Places',
  collections: [],
  keywords: [],
  availability: 'bundled',
  source: 'assets/Fire/3D/fire_3d.png',
};

const catalog = stickerCatalog({
  spec: 'test',
  library: 'fluent3d',
  provider: 'fluent-emoji',
  commit: 'abc',
  license: 'mit',
  licenseUrl: 'https://example.test/LICENSE',
  attribution: 'Fluent Emoji by Microsoft (MIT)',
  creator: 'Microsoft',
  attributionRequired: false,
  sourceBase: 'https://example.test/',
  collections: [],
  items: [fire],
});

const wire: ElementAssetWire = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
  sharpSize: 256,
  source: {
    provider: 'fluent-emoji',
    remoteId: 'fire',
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/fire.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
  deduped: false,
};

const project: Project = {
  id: 'p',
  name: 'p',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  folders: [],
  timeline: {
    tracks: [
      { id: 'graphics', type: 'overlay', clips: [] },
      { id: 'v', type: 'video', clips: [] },
    ],
  },
} as unknown as Project;

/** Read when main has answered: the project may have changed during the copy. */
const target = () => project;

function deps(answer: ElementMaterializeResult) {
  return {
    materialize: vi.fn(async () => answer),
    loadCatalog: async () => catalog,
  };
}

describe('placeDroppedSticker', () => {
  it('copies the sticker in by id and places it at the drop time on the lane it landed on', async () => {
    const d = deps({ ok: true, asset: wire });
    const placed = await placeDroppedSticker(d, {
      projectId: 'p',
      elementId: 'fire',
      atSeconds: 2.5,
      durationSeconds: 3,
      trackId: 'graphics',
      target,
    });
    expect(d.materialize).toHaveBeenCalledWith({ projectId: 'p', elementId: 'fire' });
    if (!placed.ok) throw new Error(placed.message);
    const { patch, clipId } = placed.added;
    expect(patch.reason).toBe('Add sticker “Fire”');
    const check = validatePatch(project.timeline, patch, { assetIds: [], folders: [] });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(project, patch);
    const clip = after.timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
    expect(clip).toMatchObject({
      assetId: 'element_fluent3d_fire',
      trackId: 'graphics',
      start: 2.5,
      end: 5.5,
    });
    // One undo step takes it all back.
    expect(applyProjectPatch(after, invertProjectPatch(project, patch))).toEqual(project);
  });

  it('says why, in the panel’s words, when main could not copy it', async () => {
    const placed = await placeDroppedSticker(deps({ ok: false, error: 'disk_full' }), {
      projectId: 'p',
      elementId: 'fire',
      atSeconds: 0,
      durationSeconds: 3,
      target,
    });
    expect(placed).toEqual({
      ok: false,
      message: "Couldn't add this sticker: there isn't enough disk space.",
    });
  });

  it('refuses a sticker this build does not list, before asking main for anything', async () => {
    const d = deps({ ok: true, asset: wire });
    const placed = await placeDroppedSticker(d, {
      projectId: 'p',
      elementId: 'unicorn',
      atSeconds: 0,
      durationSeconds: 3,
      target,
    });
    expect(placed).toEqual({
      ok: false,
      message: 'That sticker is not in this version of FramePilot. Pick another.',
    });
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it('says the copy failed, rather than throwing, when main does not answer', async () => {
    const placed = await placeDroppedSticker(
      {
        materialize: async () => {
          throw new Error('the licence lapsed');
        },
        loadCatalog: async () => catalog,
      },
      { projectId: 'p', elementId: 'fire', atSeconds: 0, durationSeconds: 3, target },
    );
    expect(placed).toEqual({
      ok: false,
      message:
        "Couldn't copy this sticker into the project. Check the project folder can be written to, then try again.",
    });
  });
});
