import { describe, expect, it } from 'vitest';
import type { Clip, EffectLayer, Timeline } from '@framepilot/timeline-schema';
import { clipCompositing, effectLayersInApplyOrder } from '../editor/selectors.js';
import { overlayClips } from '../editor/patch-builders.js';
import { previewIdentity, withPreviewIdentity } from './semantic-signature.js';

const clip = (id: string, keyframes = 0): Clip => ({
  id,
  assetId: 'asset',
  trackId: 'track',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: Array.from({ length: keyframes }, (_, index) => ({
    id: `kf_${index}`,
    property: 'scale',
    time: index / 30,
    value: 1 + index / 1000,
    easing: 'linear',
  })),
});

describe('compact WebCodecs semantic signatures', () => {
  it('assigns stable tokens to an immutable source and a new token to a replacement', () => {
    const source = {};
    expect(previewIdentity(source)).toBe(previewIdentity(source));
    expect(previewIdentity({})).not.toBe(previewIdentity(source));
  });

  it('does not expose the synthetic toJSON hook to normal property iteration', () => {
    const value = withPreviewIdentity({ id: 'x', payload: 1 }, {});
    expect(Object.keys(value)).toEqual(['id', 'payload']);
    expect(JSON.stringify(value)).toMatch(/^"p\d+"$/);
  });

  it('keeps a 10k-keyframe compositing signature tiny while preserving full engine data', () => {
    const source = clip('clip_1', 10_000);
    const compositing = clipCompositing(source);
    expect(compositing.keyframes).toHaveLength(10_000);
    expect(JSON.stringify(compositing).length).toBeLessThan(16);
    expect(JSON.stringify(clipCompositing(source))).toBe(JSON.stringify(compositing));
    expect(JSON.stringify(clipCompositing({ ...source }))).not.toBe(JSON.stringify(compositing));
  });

  it('keeps effect-layer signatures proportional to layer count, not keyframe payload size', () => {
    const layer: EffectLayer = {
      id: 'fx',
      effectId: 'soft-veil',
      kind: 'blur-gaussian',
      start: 0,
      end: 100,
      params: { radius: 10 },
      keyframes: Array.from({ length: 5_000 }, (_, index) => ({
        id: `fx_kf_${index}`,
        property: 'radius',
        time: index / 30,
        value: index % 20,
        easing: 'linear',
      })),
    };
    const timeline: Timeline = {
      tracks: [{ id: 'effects', type: 'effect', clips: [], effectLayers: [layer] }],
    };
    const projected = effectLayersInApplyOrder(timeline);
    expect(projected[0]?.keyframes).toHaveLength(5_000);
    expect(JSON.stringify(projected).length).toBeLessThan(20);
  });

  it('gives overlay signature guards compact source-clip identities', () => {
    const textClip: Clip = {
      id: 'text_1',
      assetId: '__text__',
      trackId: 'overlay',
      start: 0,
      end: 5,
      sourceStart: 0,
      sourceEnd: 5,
      effects: [
        {
          id: 'text_fx',
          type: 'text',
          params: { text: 'x'.repeat(20_000), fontSize: 60 },
          keyframes: [],
        },
      ],
      keyframes: [],
    };
    const timeline: Timeline = { tracks: [{ id: 'overlay', type: 'overlay', clips: [textClip] }] };
    const projected = overlayClips(timeline, new Map());
    expect(projected[0]?.params.text).toHaveLength(20_000);
    expect(JSON.stringify(projected).length).toBeLessThan(20);
  });
});
