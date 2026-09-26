/**
 * Where an element is on the frame (plan/elements EL8.1, 07 §4): the rectangle a sticker's art or
 * a shape covers at a time, read from the frame plan both renderers draw from, and the checks the
 * agent is held to built on it — on the frame at all, how far a sticker is enlarged.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Clip, Project } from '@framepilot/timeline-schema';
import { presetShapeParams } from '@framepilot/timeline-schema';
import { applyProjectPatch, type Patch } from './patch.js';
import { buildAddShapeOps, buildAddStickerOps } from './element-placement.js';
import {
  STICKER_SOFT_ENLARGEMENT,
  elementClips,
  elementEverOnFrame,
  elementRectAt,
  stickerEnlargement,
} from './element-frame.js';

const fire: Asset = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
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
} as Asset;

const patchOf = (operations: Patch['operations']): Patch => ({
  patchId: `t_${String(operations.length)}` as Patch['patchId'],
  createdBy: 'user',
  reason: 't',
  operations,
});

function project(width = 1920, height = 1080): Project {
  const empty = {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width, height },
    assets: [{ id: 'land', path: 'media/land.mp4', kind: 'video', durationSeconds: 10 }],
    folders: [],
    timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
  } as unknown as Project;
  const sticker = buildAddStickerOps(empty, fire, 0, 4, {
    artFraction: 256 / 318,
    offset: { x: 400, y: -200 },
  });
  const withSticker = applyProjectPatch(empty, patchOf([...sticker.operations]));
  const shape = buildAddShapeOps(
    withSticker.timeline,
    presetShapeParams('rounded-rect/highlight')!,
    1,
    3,
  );
  return applyProjectPatch(withSticker, patchOf([...shape.operations]));
}

const idOf = (p: Project, test: (clip: Clip) => boolean): string =>
  p.timeline.tracks.flatMap((t) => t.clips).find(test)!.id;

describe('elementRectAt', () => {
  it('measures a sticker’s art, not its padded file, where it was placed', () => {
    const p = project();
    const id = idOf(p, (c) => c.assetId === fire.id);
    const rect = elementRectAt(p, id, 1)!;
    // A third of the frame high by default (30%), offset right and up from the centre.
    expect(rect.height).toBeCloseTo(0.3, 2);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5 + 400 / 1920, 3);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.5 - 200 / 1080, 3);
  });

  it('measures a shape by the box it draws, and nothing outside its span', () => {
    const p = project();
    const id = idOf(p, (c) => c.assetId === '__shape__');
    const rect = elementRectAt(p, id, 2)!;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 2);
    expect(elementRectAt(p, id, 0.5)).toBeNull();
    expect(elementRectAt(p, id, 3.5)).toBeNull();
  });

  it('lists the element clips: stickers and shapes, not footage', () => {
    const p = project();
    expect(
      elementClips(p)
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['shape', 'sticker']);
  });
});

describe('elementEverOnFrame', () => {
  it('is false only when the element is off the frame at every moment it is on the timeline', () => {
    const p = project();
    const id = idOf(p, (c) => c.assetId === fire.id);
    expect(elementEverOnFrame(p, id)).toBe(true);
    const gone: Project = {
      ...p,
      timeline: {
        ...p.timeline,
        tracks: p.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id !== id
              ? clip
              : {
                  ...clip,
                  keyframes: clip.keyframes.map((k) =>
                    k.property === 'x' ? { ...k, value: 5000 } : k,
                  ),
                },
          ),
        })),
      },
    };
    expect(elementEverOnFrame(gone, id)).toBe(false);
  });
});

describe('stickerEnlargement', () => {
  it('reads 1.27× for the default insert at 1080p and crosses the line in 4K', () => {
    const hd = project();
    const uhd = project(3840, 2160);
    const id = (p: Project) => idOf(p, (c) => c.assetId === fire.id);
    expect(stickerEnlargement(hd, id(hd))).toBeCloseTo(324 / 256, 2);
    expect(stickerEnlargement(uhd, id(uhd))!).toBeGreaterThan(STICKER_SOFT_ENLARGEMENT);
  });

  it('reads the largest the sticker gets, so a zoom that ends big counts', () => {
    const hd = project();
    const id = idOf(hd, (c) => c.assetId === fire.id);
    const zooming: Project = {
      ...hd,
      timeline: {
        ...hd.timeline,
        tracks: hd.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id !== id
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
    expect(stickerEnlargement(zooming, id)!).toBeGreaterThan(2.5);
    expect(stickerEnlargement(hd, 'missing')).toBeNull();
  });
});
