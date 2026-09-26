/**
 * An element (a shape, a title) is not footage (plan/elements EL4a): even dragged onto a video
 * lane, it is never a span of the timeline map, so it is never offered as a cut and never feeds
 * caption derivation.
 */
import { describe, expect, it } from 'vitest';
import { presetShapeParams, type Clip, type Timeline } from '@framepilot/timeline-schema';
import { listEditBoundaries } from './edit-boundaries.js';
import { buildTimelineMap } from './timeline-map.js';
import { SHAPE_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from './synthetic-assets.js';

const footage = (id: string, start: number, end: number): Clip => ({
  id,
  assetId: 'a1',
  trackId: 'v1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const shape: Clip = {
  ...footage('s1', 4, 6),
  assetId: SHAPE_ASSET_ID,
  effects: [
    {
      id: 's1__shape',
      type: 'shape',
      params: presetShapeParams('ellipse/outline')!,
      keyframes: [],
    },
  ],
};
const title: Clip = { ...footage('t1', 6, 8), assetId: TEXT_OVERLAY_ASSET_ID };

const timeline: Timeline = {
  tracks: [{ id: 'v1', type: 'video', clips: [footage('c1', 0, 4), shape, title] }],
};

describe('element clips on a video lane', () => {
  it('are not spans of the timeline map', () => {
    expect(buildTimelineMap(timeline).spans.map((span) => span.clipId)).toEqual(['c1']);
  });

  it('are never offered as a cut', () => {
    expect(listEditBoundaries(timeline)).toEqual([]);
  });
});
