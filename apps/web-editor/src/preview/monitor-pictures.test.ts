import { describe, expect, it } from 'vitest';
import { framePlanAt } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import { drawnPictureClips, selectedDrawnPicture } from './monitor-pictures.js';

const clip = (id: string, trackId: string) => ({
  id,
  assetId: 'a',
  trackId,
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
});

const timeline: Timeline = {
  tracks: [
    { id: 'top', type: 'video', clips: [clip('front', 'top')] },
    { id: 'bottom', type: 'video', clips: [clip('behind', 'bottom')] },
  ],
};

const layer = (clipId: string | null, role = 'clip', kind = 'picture') =>
  ({ kind, role, clipId }) as never;

describe('drawnPictureClips', () => {
  it('lists every drawn picture clip back to front, once, and skips under-layers and text', () => {
    const plan = {
      layers: [
        layer('behind'),
        layer('behind', 'underlay'),
        layer(null, 'clip', 'text'),
        layer('front'),
        layer('front'),
      ],
    };
    expect(drawnPictureClips(plan, timeline).map((c) => c.id)).toEqual(['behind', 'front']);
  });

  it('ignores a layer whose clip is not on the timeline', () => {
    expect(drawnPictureClips({ layers: [layer('gone')] }, timeline)).toEqual([]);
  });
});

describe('selectedDrawnPicture', () => {
  const drawn = timeline.tracks.flatMap((track) => track.clips).reverse();

  it('returns a selected clip even when another picture covers it', () => {
    expect(selectedDrawnPicture(drawn, ['behind'])?.id).toBe('behind');
  });

  it('prefers the front-most of several selected pictures', () => {
    expect(selectedDrawnPicture(drawn, ['behind', 'front'])?.id).toBe('front');
  });

  it('is null when nothing drawn is selected', () => {
    expect(selectedDrawnPicture(drawn, ['elsewhere'])).toBeNull();
    expect(selectedDrawnPicture([], ['front'])).toBeNull();
  });
});

describe('a sticker on the monitor (plan/elements EL6a)', () => {
  it('is a drawn picture over the footage, so selecting it gives it the transform box', () => {
    const footage = { ...clip('footage', 'video_1'), assetId: 'bg' };
    const sticker = {
      ...clip('sticker', 'overlay_1'),
      assetId: 'element_fluent3d_fire',
      keyframes: [{ id: 'kf_sticker_scale_base', time: 0, property: 'scale', value: 0.37 }],
    };
    const withSticker: Timeline = {
      tracks: [
        { id: 'overlay_1', type: 'overlay', clips: [sticker] },
        { id: 'video_1', type: 'video', clips: [footage] },
      ],
    } as unknown as Timeline;
    const assets = [
      { id: 'bg', path: 'media/bg.mp4', kind: 'video', media: { width: 1280, height: 720 } },
      {
        id: 'element_fluent3d_fire',
        path: 'media/p/elements/fluent3d/fire.webp',
        kind: 'image',
        media: { width: 318, height: 318 },
        source: { provider: 'fluent-emoji', remoteId: 'fire' },
      },
    ] as never;
    const drawn = drawnPictureClips(
      framePlanAt(withSticker, assets, 1, { width: 1280, height: 720 }),
      withSticker,
    );
    expect(drawn.map((c) => c.id)).toEqual(['footage', 'sticker']);
    expect(selectedDrawnPicture(drawn, ['sticker'])?.id).toBe('sticker');
  });
});
