import { describe, expect, it } from 'vitest';
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
