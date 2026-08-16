import { describe, expect, it } from 'vitest';
import type { MaskBounds } from './operations.js';
import {
  DEFAULT_TRACK_POLICY,
  convertTrackSamples,
  type TrackSample,
} from './track-samples.js';

const BASE: MaskBounds = { x: 0.2, y: 0.2, width: 0.1, height: 0.1 };

function sample(frame: number, overrides: Partial<TrackSample> = {}): TrackSample {
  return {
    frame,
    box: { ...BASE, x: 0.2 + frame * 0.01 },
    confidence: 1,
    occluded: false,
    ...overrides,
  };
}

function convert(samples: readonly TrackSample[], policy?: Partial<typeof DEFAULT_TRACK_POLICY>) {
  return convertTrackSamples({
    samples,
    fps: 30,
    startSeconds: 0,
    durationSeconds: 10,
    keyframePrefix: 'track__clip-1',
    ...(policy === undefined ? {} : { policy }),
  });
}

function valuesOf(
  result: ReturnType<typeof convert>,
  property: 'x' | 'y' | 'width' | 'height',
): number[] {
  if (result.status !== 'converted') throw new Error(`expected conversion, got ${result.code}`);
  return result.keyframes
    .filter((keyframe) => keyframe.property === property)
    .map((keyframe) => keyframe.value);
}

describe('convertTrackSamples', () => {
  it('produces one keyframe per box property per tracked frame', () => {
    const result = convert([sample(0), sample(1), sample(2)]);

    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.keyframes).toHaveLength(3 * 4);
    expect(result.keyframes.map((keyframe) => keyframe.time).every((time) => time >= 0)).toBe(true);
    expect(new Set(result.keyframes.map((keyframe) => keyframe.id)).size).toBe(
      result.keyframes.length,
    );
  });

  it('places keyframes in clip time from the media fps', () => {
    const result = convertTrackSamples({
      samples: [sample(10), sample(11), sample(12)],
      fps: 30,
      startSeconds: 2,
      durationSeconds: 10,
      keyframePrefix: 'track__clip-1',
    });

    if (result.status !== 'converted') throw new Error('expected conversion');
    const times = [...new Set(result.keyframes.map((keyframe) => keyframe.time))];
    expect(times[0]).toBeCloseTo(2);
    expect(times[1]).toBeCloseTo(2 + 1 / 30);
  });

  it('ignores occluded and low-confidence measurements', () => {
    const noisy = [
      sample(0),
      sample(1, { occluded: true, box: { ...BASE, x: 0.9 } }),
      sample(2, { confidence: 0.1, box: { ...BASE, x: 0.85 } }),
      sample(3),
    ];

    const result = convert(noisy, { smoothingWindowFrames: 1 });

    // The 0.9/0.85 spikes never steer the track; frames 1-2 are bridged instead.
    expect(Math.max(...valuesOf(result, 'x'))).toBeLessThan(0.3);
  });

  it('bridges a bounded gap with straight-line interpolation', () => {
    const result = convert(
      [sample(0, { box: { ...BASE, x: 0.2 } }), sample(4, { box: { ...BASE, x: 0.6 } })],
      { smoothingWindowFrames: 1, maximumCorrectionPerFrame: 1 },
    );

    const xs = valuesOf(result, 'x');
    expect(xs).toHaveLength(5);
    expect(xs[2]).toBeCloseTo(0.4, 5);
  });

  it('refuses to invent motion across a long occlusion', () => {
    const result = convert([sample(0), sample(40)]);

    expect(result).toMatchObject({ status: 'rejected', code: 'gap_too_long' });
    if (result.status !== 'rejected') return;
    expect(result.detail).toContain('39 consecutive frames');
  });

  it('rejects a track where nothing was measured confidently', () => {
    const result = convert([sample(0, { occluded: true }), sample(1, { confidence: 0.01 })]);

    expect(result).toMatchObject({ status: 'rejected', code: 'no_confident_samples' });
  });

  it('smooths tracker jitter', () => {
    const jittery = [
      sample(0, { box: { ...BASE, x: 0.2 } }),
      sample(1, { box: { ...BASE, x: 0.24 } }),
      sample(2, { box: { ...BASE, x: 0.2 } }),
      sample(3, { box: { ...BASE, x: 0.24 } }),
      sample(4, { box: { ...BASE, x: 0.2 } }),
    ];

    const raw = convert(jittery, { smoothingWindowFrames: 1 });
    const smooth = convert(jittery, { smoothingWindowFrames: 5 });

    const swing = (values: number[]): number => Math.max(...values) - Math.min(...values);
    expect(swing(valuesOf(smooth, 'x'))).toBeLessThan(swing(valuesOf(raw, 'x')));
  });

  it('clamps a single wild correction instead of yanking the mask', () => {
    const result = convert(
      [
        sample(0, { box: { ...BASE, x: 0.1 } }),
        sample(1, { box: { ...BASE, x: 0.8 } }),
        sample(2, { box: { ...BASE, x: 0.8 } }),
      ],
      { smoothingWindowFrames: 1, maximumCorrectionPerFrame: 0.05 },
    );

    const xs = valuesOf(result, 'x');
    expect(xs[1]! - xs[0]!).toBeCloseTo(0.05, 5);
    if (result.status !== 'converted') return;
    expect(result.facts).toContainEqual({ name: 'clampedFrameCount', value: 2 });
  });

  it('keeps every keyframe inside the normalized frame', () => {
    const result = convert([
      sample(0, { box: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 } }),
      sample(1, { box: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 } }),
    ]);

    if (result.status !== 'converted') throw new Error('expected conversion');
    for (let index = 0; index < result.keyframes.length; index += 4) {
      const [x, y, width, height] = result.keyframes
        .slice(index, index + 4)
        .map((keyframe) => keyframe.value) as [number, number, number, number];
      expect(x + width).toBeLessThanOrEqual(1 + 1e-9);
      expect(y + height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('is deterministic for identical input', () => {
    const samples = [sample(0), sample(1), sample(2), sample(3)];
    expect(convert(samples)).toEqual(convert(samples));
  });

  it.each([
    ['no samples at all', [], 'no_samples'],
    ['unordered frames', [sample(2), sample(1)], 'unordered_samples'],
    [
      'geometry outside the frame',
      [sample(0, { box: { x: 0.95, y: 0.1, width: 0.2, height: 0.1 } })],
      'invalid_geometry',
    ],
  ])('rejects %s', (_label, samples, code) => {
    expect(convert(samples as TrackSample[])).toMatchObject({ status: 'rejected', code });
  });

  it('rejects a policy that cannot be applied', () => {
    expect(convert([sample(0)], { smoothingWindowFrames: 4 })).toMatchObject({
      status: 'rejected',
      code: 'invalid_policy',
    });
  });

  it('refuses keyframes that would fall outside the clip', () => {
    const result = convertTrackSamples({
      samples: [sample(0), sample(1)],
      fps: 30,
      startSeconds: 9.99,
      durationSeconds: 10,
      keyframePrefix: 'track__clip-1',
    });

    expect(result).toMatchObject({ status: 'rejected', code: 'invalid_geometry' });
  });
});
