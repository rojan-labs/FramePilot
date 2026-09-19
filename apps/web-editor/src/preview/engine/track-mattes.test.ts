/**
 * MK8.2: a track matte's source is taken out of the composite and handed to the clip it masks.
 */
import { describe, expect, it } from 'vitest';
import type { FramePlanLayer } from '@framepilot/editor-core';
import { ClipSchema } from '@framepilot/timeline-schema';

import type { CompositeLayer } from './layer-compositor';
import type { PictureRasterStep } from './layer-raster';
import { clipMaskStack } from '../masks/mask-stack';
import { withTrackMattes } from './track-mattes';

const plan = (clipId: string, trackId: string, matteOnly = false): FramePlanLayer =>
  ({
    kind: 'picture',
    role: 'clip',
    trackId,
    clipId,
    forClipId: null,
    ...(matteOnly ? { matteOnly: true } : {}),
  }) as unknown as FramePlanLayer;

function picture(clipId: string, masks: unknown[] = []): CompositeLayer {
  const clip = ClipSchema.parse({
    id: clipId,
    assetId: 'a',
    trackId: 'v',
    start: 0,
    end: 1,
    sourceStart: 0,
    sourceEnd: 1,
    effects: [],
    keyframes: [],
    masks,
  });
  const stack = masks.length > 0 ? clipMaskStack(clip, { width: 64, height: 36 }) : null;
  return {
    kind: 'picture',
    step: { mask: stack === null ? null : { stack, clipTime: 0 } } as unknown as PictureRasterStep,
    source: { kind: 'image', key: clipId, image: {} as TexImageSource, width: 1, height: 1 },
  };
}

describe('withTrackMattes', () => {
  it('leaves a frame without track mattes untouched', () => {
    const layers = [picture('a'), picture('b')];
    expect(withTrackMattes([plan('a', 'v1'), plan('b', 'v2')], layers)).toEqual(layers);
  });

  it('draws the masked clip with its source and never the source itself', () => {
    const title = picture('title');
    const fill = picture('fill', [
      { id: 'tm', kind: 'layer', source: { kind: 'clip', clipId: 'title' } },
    ]);
    const base = picture('base');
    const drawn = withTrackMattes(
      [plan('base', 'v3'), plan('fill', 'v2'), plan('title', 'v1', true)],
      [base, fill, title],
    );
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toBe(base);
    const masked = drawn[1] as Extract<CompositeLayer, { kind: 'picture' }>;
    expect(masked.layerMattes?.get('tm')).toEqual([title]);
  });

  it('reads a whole track in order and follows a chain of mattes', () => {
    const shapeA = picture('shapeA');
    const shapeB = picture('shapeB', [
      { id: 'inner', kind: 'layer', source: { kind: 'clip', clipId: 'deep' } },
    ]);
    const deep = picture('deep');
    const fill = picture('fill', [
      { id: 'tm', kind: 'layer', source: { kind: 'track', trackId: 'shapes' } },
    ]);
    const drawn = withTrackMattes(
      [
        plan('deep', 'x', true),
        plan('shapeA', 'shapes', true),
        plan('shapeB', 'shapes', true),
        plan('fill', 'v'),
      ],
      [deep, shapeA, shapeB, fill],
    );
    expect(drawn).toHaveLength(1);
    const sources = (drawn[0] as Extract<CompositeLayer, { kind: 'picture' }>).layerMattes!.get(
      'tm',
    )!;
    expect(sources[0]).toBe(shapeA);
    const nested = sources[1] as Extract<CompositeLayer, { kind: 'picture' }>;
    expect(nested.layerMattes?.get('inner')).toEqual([deep]);
  });

  it('gives a source that is not on screen an empty list (it draws nothing)', () => {
    const fill = picture('fill', [
      { id: 'tm', kind: 'layer', source: { kind: 'clip', clipId: 'later' } },
    ]);
    const [drawn] = withTrackMattes([plan('fill', 'v')], [fill]);
    expect((drawn as Extract<CompositeLayer, { kind: 'picture' }>).layerMattes?.get('tm')).toEqual(
      [],
    );
  });
});
