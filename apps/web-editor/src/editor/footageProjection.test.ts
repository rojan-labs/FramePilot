/**
 * Tests for source↔timeline projection (plan FI5.1a) — the glue that lets an
 * asset-native footage map act on the timeline only when the footage is placed.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { sourceToTimeline, timelineToSource } from './footageProjection.js';

/** One clip: source [10,40) of asset `a` placed at timeline [100,130) (1x, so linear). */
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 100,
          end: 130,
          sourceStart: 10,
          sourceEnd: 40,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

/** Same source window placed at 2× speed: 30s of source in 15s of timeline. */
const spedUp: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 15,
          sourceStart: 10,
          sourceEnd: 40,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

describe('sourceToTimeline', () => {
  it('maps a placed source moment to its timeline position', () => {
    expect(sourceToTimeline({ assetId: 'a', sourceSeconds: 10 }, timeline)).toBe(100);
    expect(sourceToTimeline({ assetId: 'a', sourceSeconds: 25 }, timeline)).toBe(115);
  });

  it('returns undefined when the asset is not on the timeline', () => {
    expect(sourceToTimeline({ assetId: 'other', sourceSeconds: 20 }, timeline)).toBeUndefined();
  });

  it('returns undefined for a source moment outside the placed range (trimmed out)', () => {
    expect(sourceToTimeline({ assetId: 'a', sourceSeconds: 5 }, timeline)).toBeUndefined();
    expect(sourceToTimeline({ assetId: 'a', sourceSeconds: 40 }, timeline)).toBeUndefined();
  });

  it('accounts for playback speed via the clip extents', () => {
    // Source 25 is halfway through [10,40); at 2× that lands at timeline 7.5.
    expect(sourceToTimeline({ assetId: 'a', sourceSeconds: 25 }, spedUp)).toBe(7.5);
  });
});

describe('timelineToSource', () => {
  it('maps the playhead to the source moment under it', () => {
    expect(timelineToSource(100, timeline)).toEqual({ assetId: 'a', sourceSeconds: 10 });
    expect(timelineToSource(115, timeline)).toEqual({ assetId: 'a', sourceSeconds: 25 });
  });

  it('returns undefined when no clip covers the playhead', () => {
    expect(timelineToSource(50, timeline)).toBeUndefined();
    expect(timelineToSource(130, timeline)).toBeUndefined();
  });

  it('inverts speed correctly', () => {
    expect(timelineToSource(7.5, spedUp)).toEqual({ assetId: 'a', sourceSeconds: 25 });
  });
});
