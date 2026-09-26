/**
 * "Enlarged beyond its sharp size" (plan/elements 03 §2.2, 05 §3): how far a sticker is drawn
 * beyond its own pixels at the export resolution, read from the frame plan, at its largest over
 * the clip. The default insert (1.27×) stays under the 1.5× line at 1080p and crosses it in 4K.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch } from '@framepilot/editor-core';
import type { ElementAssetWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { addStickerPatch } from './sticker-builders.js';
import { STICKER_SOFT_ENLARGEMENT, stickerEnlargement } from './sticker-sharpness.js';

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

/** A project at `width`×`height` with the fire sticker added as the Stickers tab adds it. */
function withSticker(width: number, height: number): { project: Project; clipId: string } {
  const project = {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width, height },
    assets: [],
    folders: [],
    timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
  } as unknown as Project;
  const added = addStickerPatch(project, wire, 'Fire', 0, 3)!;
  return { project: applyProjectPatch(project, added.patch), clipId: added.clipId };
}

describe('stickerEnlargement', () => {
  it('keeps the default insert under the line at 1080p (30% of the frame high: 1.27×)', () => {
    const { project, clipId } = withSticker(1920, 1080);
    const enlargement = stickerEnlargement(project, clipId)!;
    // 03 §2.2: 324 px of art from 256 px.
    expect(enlargement).toBeCloseTo(324 / 256, 2);
    expect(enlargement).toBeLessThan(STICKER_SOFT_ENLARGEMENT);
  });

  it('crosses it when the same insert goes to a 4K export', () => {
    const { project, clipId } = withSticker(3840, 2160);
    expect(stickerEnlargement(project, clipId)!).toBeGreaterThan(STICKER_SOFT_ENLARGEMENT);
  });

  it('reads the largest the clip gets, so a zoom that ends big counts', () => {
    const { project, clipId } = withSticker(1920, 1080);
    const zooming: Project = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id !== clipId
              ? clip
              : {
                  ...clip,
                  keyframes: [
                    { id: 'k1', property: 'scale', time: 0, value: 1, easing: 'linear' },
                    { id: 'k2', property: 'scale', time: 2, value: 2, easing: 'linear' },
                  ],
                },
          ),
        })),
      },
    } as Project;
    expect(stickerEnlargement(zooming, clipId)!).toBeGreaterThan(2.5);
  });

  it('has nothing to say about a clip that is not a sized still', () => {
    const { project } = withSticker(1920, 1080);
    expect(stickerEnlargement(project, 'missing')).toBeNull();
  });
});
