/**
 * A sticker is not footage (plan/elements EL6a.6, G9): the same sticker twice is not a repeated
 * take, and a sticker on a picture lane neither blocks a cutaway nor fills the picture chain.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Clip, Project } from '@framepilot/timeline-schema';
import { lastPictureEnd, picturePlacementConflict } from './picture-occupancy.js';
import { repeatedSourcePairs } from './source-repeats.js';

const sticker: Asset = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  source: {
    provider: 'fluent-emoji',
    remoteId: 'fire',
    license: 'mit',
    attributionRequired: false,
    fetchedAt: '2026-09-26T00:00:00.000Z',
  },
} as Asset;
const photo: Asset = { id: 'photo', path: 'media/p/photo.jpg', kind: 'image' } as Asset;

const clip = (id: string, assetId: string, start: number, end: number): Clip => ({
  id,
  assetId,
  trackId: 'v1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const project = (clips: Clip[]): Project =>
  ({
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [sticker, photo],
    timeline: { tracks: [{ id: 'v1', type: 'video', clips }] },
  }) as unknown as Project;

describe('stickers are not footage', () => {
  it('never names the same sticker used twice a repeated take', () => {
    const twice = project([clip('a', sticker.id, 0, 2), clip('b', sticker.id, 5, 7)]);
    expect(repeatedSourcePairs(twice)).toEqual([]);
    const photoTwice = project([clip('a', 'photo', 0, 2), clip('b', 'photo', 5, 7)]);
    expect(repeatedSourcePairs(photoTwice)).toHaveLength(1);
  });

  it('does not occupy the picture chain, even on a picture lane', () => {
    const { timeline, assets } = project([clip('a', sticker.id, 0, 4)]);
    expect(picturePlacementConflict(timeline, assets, 1, 3)).toBe(false);
    expect(lastPictureEnd(timeline, assets)).toBe(0);
    const withPhoto = project([clip('a', 'photo', 0, 4)]);
    expect(picturePlacementConflict(withPhoto.timeline, withPhoto.assets, 1, 3)).toBe(true);
  });
});
