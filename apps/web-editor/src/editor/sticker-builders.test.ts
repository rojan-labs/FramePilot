/**
 * Sticker patches (plan/elements EL6a): adding one is one validated, reversible patch named for
 * History; replacing one swaps only the asset, keeping timing and transform; every failure code has
 * the panel's sentence.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, invertProjectPatch, validatePatch } from '@framepilot/editor-core';
import type { ElementAssetWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import {
  addStickerPatch,
  placeElementAssetPatch,
  replaceStickerPatch,
  stickerArtFraction,
  stickerErrorSentence,
} from './sticker-builders.js';

const wire = (id: string): ElementAssetWire => ({
  id: `element_fluent3d_${id}`,
  path: `media/p/elements/fluent3d/${id}.webp`,
  kind: 'image',
  media: { width: 318, height: 318 },
  sharpSize: 256,
  source: {
    provider: 'fluent-emoji',
    remoteId: id,
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attributionRequired: false,
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    sourceUrl: 'https://example.test/x.png',
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
  deduped: false,
});

const project: Project = {
  id: 'p',
  name: 'p',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  folders: [],
  timeline: { tracks: [{ id: 'v1', type: 'video', clips: [] }] },
} as unknown as Project;

describe('addStickerPatch', () => {
  it('adds a sticker at the playhead as one reversible patch named for History', () => {
    const added = addStickerPatch(project, wire('fire'), 'Fire', 2, 3)!;
    expect(added.patch.reason).toBe('Add sticker “Fire”');
    const check = validatePatch(project.timeline, added.patch, { assetIds: [], folders: [] });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const after = applyProjectPatch(project, added.patch);
    expect(after.assets.map((asset) => asset.id)).toEqual(['element_fluent3d_fire']);
    expect(applyProjectPatch(after, invertProjectPatch(project, added.patch))).toEqual(project);
    expect(addStickerPatch(project, wire('fire'), 'Fire', 2, 0)).toBeNull();
  });

  it('uses the art, not its transparent margin, for the size', () => {
    expect(stickerArtFraction(wire('fire'))).toBeCloseTo(256 / 318, 6);
    expect(stickerArtFraction({ ...wire('fire'), sharpSize: null })).toBe(1);
  });
});

describe('replaceStickerPatch', () => {
  const added = addStickerPatch(project, wire('fire'), 'Fire', 2, 3)!;
  const withFire = applyProjectPatch(project, added.patch);

  it('swaps only the asset, keeping timing and transform, and brings the new asset', () => {
    const patch = replaceStickerPatch(withFire, added.clipId, wire('rocket'), 'Rocket')!;
    expect(patch.reason).toBe('Replace sticker with “Rocket”');
    expect(patch.operations.map((op) => op.type)).toEqual(['add_asset', 'set_clip_media']);
    const after = applyProjectPatch(withFire, patch);
    const before = withFire.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === added.clipId)!;
    const swapped = after.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === added.clipId)!;
    expect(swapped).toEqual({ ...before, assetId: 'element_fluent3d_rocket' });
    expect(applyProjectPatch(after, invertProjectPatch(withFire, patch))).toEqual(withFire);
  });

  it('refuses a clip that is gone', () => {
    expect(replaceStickerPatch(withFire, 'nope', wire('rocket'), 'Rocket')).toBeNull();
  });
});

describe('placeElementAssetPatch', () => {
  it('places a sticker already in the bin like the Stickers tab would, never as footage', () => {
    const added = addStickerPatch(project, wire('fire'), 'Fire', 0, 2)!;
    const withFire = applyProjectPatch(project, added.patch);
    const asset = withFire.assets[0]!;
    const again = placeElementAssetPatch(withFire, asset, 5, 3, 'v1')!;
    expect(again.patch.reason).toBe('Add sticker “Fire”');
    expect(again.patch.operations.map((op) => op.type)).toEqual(['add_clip', 'add_keyframes']);
    const after = applyProjectPatch(withFire, again.patch);
    const lane = after.timeline.tracks.find((t) => t.clips.some((c) => c.id === again.clipId))!;
    expect(lane.type).toBe('overlay');
    const scale = (
      again.patch.operations[1] as unknown as { keyframes: { property: string; value: number }[] }
    ).keyframes.find((k) => k.property === 'scale')!.value;
    const first = (
      added.patch.operations.at(-1) as unknown as {
        keyframes: { property: string; value: number }[];
      }
    ).keyframes.find((k) => k.property === 'scale')!.value;
    expect(scale).toBeCloseTo(first, 3);
  });
});

describe('stickerErrorSentence', () => {
  it('says each failure in the panel’s words, never a code', () => {
    expect(stickerErrorSentence('disk_full')).toBe(
      "Couldn't add this sticker: there isn't enough disk space.",
    );
    expect(stickerErrorSentence('library_missing')).toBe(
      "This sticker's file is missing from this install of FramePilot. Reinstalling fixes it.",
    );
    expect(
      stickerErrorSentence('library_missing', 'Stickers are only available in the desktop app.'),
    ).toBe('Stickers are only available in the desktop app.');
    for (const code of ['integrity_failed', 'unknown_element', 'io_failed'] as const) {
      expect(stickerErrorSentence(code)).not.toMatch(/_/);
    }
  });
});
