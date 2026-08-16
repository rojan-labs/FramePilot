import { describe, expect, it } from 'vitest';
import { planAutomaticReframe } from './track-reframe.js';
import type { TrackSample } from './track-samples.js';

const LANDSCAPE = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };
const RATE = { numerator: 30, denominator: 1 };

function sample(frame: number, centreX = 0.5, centreY = 0.5): TrackSample {
  return {
    frame,
    box: { x: centreX - 0.05, y: centreY - 0.05, width: 0.1, height: 0.1 },
    confidence: 0.9,
    occluded: false,
  };
}

function plan(samples: readonly TrackSample[], maxPanPixelsPerFrame = 10_000) {
  return planAutomaticReframe({
    samples,
    source: LANDSCAPE,
    target: VERTICAL,
    rate: RATE,
    firstClipFrame: 0,
    maxPanPixelsPerFrame,
  });
}

describe('planAutomaticReframe', () => {
  it('computes the cover scale the render compiler actually needs', () => {
    const result = plan([sample(0), sample(1)]);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    // fit = min(1080/1920, 1920/1080) = 0.5625; cover = 1.7778 / 0.5625.
    expect(result.coverScale).toBeCloseTo(3.1605, 3);
  });

  it('leaves a centred subject centred', () => {
    const result = plan([sample(0), sample(1)]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    expect(result.points.x[0]!.value).toBeCloseTo(0);
    expect(result.points.y[0]!.value).toBeCloseTo(0);
  });

  it('pans toward a subject that moves off centre', () => {
    const result = plan([sample(0, 0.5), sample(1, 0.6)]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    // A subject right of centre needs the picture pushed left.
    expect(result.points.x[1]!.value).toBeLessThan(0);
  });

  it('never pans past the edge of the picture', () => {
    const result = plan([sample(0, 0.5), sample(1, 0.0), sample(2, 1.0)]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    const renderedWidth = 1920 * 0.5625 * result.coverScale;
    const limit = (renderedWidth - VERTICAL.width) / 2;
    for (const point of result.points.x) {
      expect(Math.abs(point.value)).toBeLessThanOrEqual(limit + 1e-6);
    }
  });

  it('cannot pan vertically when the cover crop has no vertical slack', () => {
    const result = plan([sample(0, 0.5, 0.1), sample(1, 0.5, 0.9)]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    // Covering a 9:16 output from 16:9 leaves height exactly filled: no slack.
    expect(result.points.y.every((point) => point.value === 0)).toBe(true);
  });

  it('damps a jittery track into a steady camera move', () => {
    const jumpy = [sample(0, 0.5), sample(1, 0.0), sample(2, 1.0)];

    const undamped = plan(jumpy);
    const damped = plan(jumpy, 20);

    if (undamped.status !== 'planned' || damped.status !== 'planned') {
      throw new Error('expected plans');
    }
    const step = (result: typeof damped): number =>
      Math.max(
        ...result.points.x.slice(1).map((point, index) =>
          Math.abs(point.value - result.points.x[index]!.value),
        ),
      );
    expect(step(damped)).toBeLessThanOrEqual(20 + 1e-6);
    expect(step(damped)).toBeLessThan(step(undamped));
    expect(damped.facts).toContainEqual({ name: 'dampedFrameCount', value: 2 });
  });

  it('skips occluded frames rather than reframing on a held box', () => {
    const result = plan([
      sample(0),
      { ...sample(1, 0.9), occluded: true },
      sample(2, 0.6),
    ]);

    if (result.status !== 'planned') throw new Error('expected a plan');
    expect(result.points.x.map((point) => point.frame)).toEqual([0, 2]);
    expect(result.facts).toContainEqual({ name: 'skippedOccludedFrames', value: 1 });
  });

  it('is deterministic for identical samples', () => {
    const samples = [sample(0), sample(1, 0.55), sample(2, 0.6)];
    expect(plan(samples)).toEqual(plan(samples));
  });

  it('refuses to reframe when the aspect already matches', () => {
    expect(
      planAutomaticReframe({
        samples: [sample(0), sample(1)],
        source: LANDSCAPE,
        target: { width: 1280, height: 720 },
        rate: RATE,
        firstClipFrame: 0,
      }),
    ).toMatchObject({ status: 'rejected', code: 'no_reframe_needed' });
  });

  it.each([
    ['no samples', [], 'no_samples'],
    ['a fully occluded track', [{ ...sample(0), occluded: true }], 'unusable_samples'],
  ])('refuses %s', (_label, samples, code) => {
    expect(plan(samples as TrackSample[])).toMatchObject({ status: 'rejected', code });
  });

  it('refuses an impossible resolution', () => {
    expect(
      planAutomaticReframe({
        samples: [sample(0)],
        source: { width: 0, height: 1080 },
        target: VERTICAL,
        rate: RATE,
        firstClipFrame: 0,
      }),
    ).toMatchObject({ status: 'rejected', code: 'invalid_resolution' });
  });
});
