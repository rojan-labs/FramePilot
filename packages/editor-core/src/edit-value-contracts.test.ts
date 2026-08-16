/**
 * The renderer-backed value domains, tested at the helper boundary.
 *
 * These predicates are the single place TS states what the Python renderer will actually
 * honor. They are mirrored by `contract_overrides.py`, so each accepted/rejected value
 * here is also the value the sidecar must agree about — a divergence is a call the model
 * can make in-app and have 4xx'd at the engine.
 */
import { describe, expect, it } from 'vitest';
import type { Effect, Keyframe } from '@framepilot/timeline-schema';
import {
  audioFadeCurveSupported,
  audioGainContractIssue,
  clipKeyframeContractIssue,
  colorGradeContractIssues,
  duckAmountContractIssue,
} from './edit-value-contracts.js';

const keyframe = (over: Partial<Keyframe>): Keyframe =>
  ({ id: 'kf', time: 1, property: 'scale', value: 1, easing: 'linear', ...over }) as Keyframe;

const grade = (params: Record<string, unknown>, type = 'color_grade'): Effect =>
  ({ id: 'grade', type, params, keyframes: [] }) as unknown as Effect;

describe('clip keyframe contract', () => {
  it('accepts every property the renderer composites', () => {
    for (const property of ['scale', 'x', 'y', 'rotation', 'opacity'] as const) {
      const value = property === 'opacity' ? 0.5 : 1;
      expect(clipKeyframeContractIssue(keyframe({ property, value }))).toBeUndefined();
    }
  });

  it('rejects a non-finite time or value before the range checks', () => {
    expect(clipKeyframeContractIssue(keyframe({ time: Number.NaN }))?.field).toBe('time');
    expect(clipKeyframeContractIssue(keyframe({ value: Number.POSITIVE_INFINITY }))?.field).toBe(
      'value',
    );
  });

  it('rejects a negative keyframe time', () => {
    expect(clipKeyframeContractIssue(keyframe({ time: -1 }))?.message).toMatch(/non-negative/i);
  });
});

describe('color grade contract', () => {
  it('accepts a LUT with a usable path and rejects a blank or missing one', () => {
    expect(colorGradeContractIssues(grade({ path: 'looks/teal.cube' }, 'lut'))).toEqual([]);
    expect(colorGradeContractIssues(grade({ path: '   ' }, 'lut'))[0]?.field).toBe('params.path');
    // A LUT named but not located renders as a no-op, which is the silent failure the
    // contract exists to convert into an actionable rejection.
    expect(colorGradeContractIssues(grade({ name: 'teal' }, 'lut'))[0]?.field).toBe('params.path');
  });

  it('accepts an in-range parametric grade', () => {
    expect(colorGradeContractIssues(grade({ exposure: -5, contrast: 1, saturation: 3 }))).toEqual(
      [],
    );
  });

  it('rejects a non-numeric or non-finite parameter value', () => {
    expect(colorGradeContractIssues(grade({ exposure: 'bright' }))[0]?.message).toMatch(
      /finite number/i,
    );
    expect(colorGradeContractIssues(grade({ contrast: Number.NaN }))[0]?.message).toMatch(
      /finite number/i,
    );
  });

  it('reports every offending parameter rather than only the first', () => {
    const issues = colorGradeContractIssues(grade({ vibrance: 1, exposure: 99 }));
    expect(issues.map((issue) => issue.field)).toEqual(['params.vibrance', 'params.exposure']);
  });
});

describe('audio contracts', () => {
  it('accepts gain inside the renderer range and rejects the edges beyond it', () => {
    expect(audioGainContractIssue(-120)).toBeUndefined();
    expect(audioGainContractIssue(24)).toBeUndefined();
    expect(audioGainContractIssue(-121)?.field).toBe('gainDb');
    expect(audioGainContractIssue(Number.NaN)?.message).toMatch(/finite/i);
  });

  it('requires ducking to be a reduction', () => {
    expect(duckAmountContractIssue(-6)).toBeUndefined();
    expect(duckAmountContractIssue(0)).toBeUndefined();
    // A positive "duck" would raise the bed under the voice — the opposite of the intent.
    expect(duckAmountContractIssue(3)?.message).toMatch(/reduction/i);
    expect(duckAmountContractIssue(-61)?.field).toBe('duckAmountDb');
    expect(duckAmountContractIssue(Number.NaN)?.message).toMatch(/finite/i);
  });

  it('knows exactly which fade curves the renderer implements', () => {
    for (const curve of ['linear', 'equal-power', 'smooth']) {
      expect(audioFadeCurveSupported(curve)).toBe(true);
    }
    expect(audioFadeCurveSupported('logarithmic')).toBe(false);
  });
});
