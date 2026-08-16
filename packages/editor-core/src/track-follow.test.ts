import { describe, expect, it } from 'vitest';
import { planTrackFollow } from './track-follow.js';
import type { TrackSample } from './track-samples.js';

const RESOLUTION = { width: 1920, height: 1080 };
const RATE = { numerator: 30, denominator: 1 };
const BASE = { x: 100, y: -50, scale: 1 };

function sample(frame: number, overrides: Partial<TrackSample> = {}): TrackSample {
  return {
    frame,
    box: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
    confidence: 0.9,
    occluded: false,
    ...overrides,
  };
}

function plan(samples: readonly TrackSample[], followScale = false) {
  return planTrackFollow({
    samples,
    resolution: RESOLUTION,
    rate: RATE,
    firstClipFrame: 0,
    base: BASE,
    followScale,
  });
}

describe('planTrackFollow', () => {
  it('preserves the editor’s placement and adds the subject’s motion', () => {
    const result = plan([
      sample(0),
      sample(1, { box: { x: 0.5, y: 0.4, width: 0.1, height: 0.1 } }),
    ]);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    // Frame one keeps the clip exactly where the editor put it.
    expect(result.points.x[0]).toMatchObject({ frame: 0, value: BASE.x });
    expect(result.points.y[0]).toMatchObject({ frame: 0, value: BASE.y });
    // A tenth of the frame to the right is 192 px at 1920 wide.
    expect(result.points.x[1]!.value).toBeCloseTo(BASE.x + 192);
    expect(result.points.y[1]!.value).toBeCloseTo(BASE.y);
  });

  it('converts vertical motion with the frame height, not the width', () => {
    const result = plan([
      sample(0),
      sample(1, { box: { x: 0.4, y: 0.5, width: 0.1, height: 0.1 } }),
    ]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    expect(result.points.y[1]!.value).toBeCloseTo(BASE.y + 108);
  });

  it('places points in clip time from the first tracked frame', () => {
    const result = planTrackFollow({
      samples: [sample(90), sample(91), sample(92)],
      resolution: RESOLUTION,
      rate: RATE,
      firstClipFrame: 10,
      base: BASE,
    });

    if (result.status !== 'planned') throw new Error('expected a plan');
    expect(result.points.x.map((point) => point.frame)).toEqual([10, 11, 12]);
  });

  it('follows the subject size only when asked', () => {
    const grown = [
      sample(0),
      sample(1, { box: { x: 0.35, y: 0.4, width: 0.2, height: 0.1 } }),
    ];

    expect(plan(grown, false).status === 'planned' && plan(grown, false).points.scale).toEqual([]);
    const scaled = plan(grown, true);
    if (scaled.status !== 'planned') throw new Error('expected a plan');
    expect(scaled.points.scale[1]!.value).toBeCloseTo(2);
  });

  it('skips occluded frames instead of animating a held box', () => {
    const result = plan([
      sample(0),
      sample(1, { occluded: true, box: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } }),
      sample(2, { box: { x: 0.6, y: 0.4, width: 0.1, height: 0.1 } }),
    ]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    expect(result.points.x.map((point) => point.frame)).toEqual([0, 2]);
    expect(result.facts).toContainEqual({ name: 'skippedOccludedFrames', value: 1 });
  });

  it('is deterministic for identical samples', () => {
    const samples = [sample(0), sample(1), sample(2)];
    expect(plan(samples)).toEqual(plan(samples));
  });

  it.each([
    ['no samples', [], 'no_samples'],
    ['a single visible frame', [sample(0)], 'unusable_samples'],
    [
      'a fully occluded track',
      [sample(0, { occluded: true }), sample(1, { occluded: true })],
      'unusable_samples',
    ],
  ])('refuses to follow %s', (_label, samples, code) => {
    expect(plan(samples as TrackSample[])).toMatchObject({ status: 'rejected', code });
  });

  it('refuses an impossible output resolution', () => {
    expect(
      planTrackFollow({
        samples: [sample(0), sample(1)],
        resolution: { width: 0, height: 1080 },
        rate: RATE,
        firstClipFrame: 0,
        base: BASE,
      }),
    ).toMatchObject({ status: 'rejected', code: 'invalid_resolution' });
  });
});
