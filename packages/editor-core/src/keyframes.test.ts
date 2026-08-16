/**
 * Tests for the keyframe easing + interpolation engine (PRD §6.3, PLAN Phase 5).
 *
 * These mirror the Python `tests/test_keyframes.py`; the two engines must agree
 * on the easing curves and segment semantics.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@framepilot/timeline-schema';
import {
  type BezierHandle,
  type Easing,
  EASING_FUNCTIONS,
  applyEasing,
  evaluateKeyframes,
  interpolate,
  punchInKeyframes,
  segmentProgress,
  solveCubicBezier,
} from './keyframes.js';

const kf = (
  time: number,
  value: number,
  easing: Keyframe['easing'] = 'linear',
  property = 'scale',
): Keyframe => ({ id: `kf_${property}_${time}`, time, property, value, easing });

const EASINGS: Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier'];

describe('easing curves', () => {
  it('exposes exactly the canonical hyphenated curves', () => {
    expect(Object.keys(EASING_FUNCTIONS).sort()).toEqual(
      ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier'].sort(),
    );
  });

  it.each(EASINGS)('maps endpoints 0→0 and 1→1 for %s', (easing) => {
    expect(applyEasing(easing, 0)).toBe(0);
    expect(applyEasing(easing, 1)).toBe(1);
  });

  it('clamps out-of-range progress', () => {
    expect(applyEasing('linear', -5)).toBe(0);
    expect(applyEasing('linear', 5)).toBe(1);
  });

  it('has the expected midpoints', () => {
    expect(applyEasing('linear', 0.5)).toBeCloseTo(0.5);
    expect(applyEasing('ease-in', 0.5)).toBeCloseTo(0.25);
    expect(applyEasing('ease-out', 0.5)).toBeCloseTo(0.75);
    expect(applyEasing('ease-in-out', 0.5)).toBeCloseTo(0.5);
    expect(applyEasing('ease-in-out', 0.25)).toBeCloseTo(0.125);
    expect(applyEasing('ease-in-out', 0.75)).toBeCloseTo(0.875);
    expect(applyEasing('bezier', 0.5)).toBeCloseTo(0.5);
  });

  it('holds until the very end for hold', () => {
    expect(applyEasing('hold', 0)).toBe(0);
    expect(applyEasing('hold', 0.99)).toBe(0);
    expect(applyEasing('hold', 1)).toBe(1);
  });

  it('falls back to linear for unknown easing names', () => {
    expect(applyEasing('wobble', 0.5)).toBeCloseTo(0.5);
  });
});

describe('interpolate', () => {
  it('lerps linearly by default', () => {
    expect(interpolate(0, 10, 0.5)).toBeCloseTo(5);
  });

  it('applies easing', () => {
    expect(interpolate(0, 100, 0.5, 'ease-in')).toBeCloseTo(25);
  });

  it('holds then snaps at the end for hold', () => {
    expect(interpolate(2, 8, 0.5, 'hold')).toBeCloseTo(2);
    expect(interpolate(2, 8, 1, 'hold')).toBeCloseTo(8);
  });
});

describe('evaluateKeyframes', () => {
  it('returns undefined when the property is not animated', () => {
    expect(evaluateKeyframes([], 'scale', 1)).toBeUndefined();
    expect(evaluateKeyframes([kf(0, 1, 'linear', 'opacity')], 'scale', 1)).toBeUndefined();
  });

  it('holds before the first and after the last keyframe', () => {
    const frames = [kf(1, 1), kf(3, 2)];
    expect(evaluateKeyframes(frames, 'scale', 0)).toBeCloseTo(1);
    expect(evaluateKeyframes(frames, 'scale', 1)).toBeCloseTo(1);
    expect(evaluateKeyframes(frames, 'scale', 5)).toBeCloseTo(2);
  });

  it('interpolates between two keyframes', () => {
    expect(evaluateKeyframes([kf(0, 0), kf(2, 10)], 'scale', 1)).toBeCloseTo(5);
  });

  it('uses the earlier keyframe easing for the segment', () => {
    const frames = [kf(0, 0, 'ease-in'), kf(2, 100, 'linear')];
    expect(evaluateKeyframes(frames, 'scale', 1)).toBeCloseTo(25);
  });

  it('sorts unordered keyframes', () => {
    expect(evaluateKeyframes([kf(2, 10), kf(0, 0)], 'scale', 1)).toBeCloseTo(5);
  });

  it('evaluates a three-keyframe chain (covers the non-bracketing first pair)', () => {
    const frames = [kf(0, 0), kf(1, 10), kf(2, 0)];
    expect(evaluateKeyframes(frames, 'scale', 0.5)).toBeCloseTo(5);
    expect(evaluateKeyframes(frames, 'scale', 1)).toBeCloseTo(10);
    expect(evaluateKeyframes(frames, 'scale', 1.5)).toBeCloseTo(5);
  });

  it('does not divide by zero on equal-time keyframes', () => {
    const frames = [kf(1, 1), kf(1, 2), kf(3, 2)];
    expect(evaluateKeyframes(frames, 'scale', 2)).toBeCloseTo(2);
  });

  it('ignores keyframes for other properties', () => {
    const frames = [
      kf(0, 0, 'linear', 'x'),
      kf(2, 10, 'linear', 'x'),
      kf(0, 100, 'linear', 'opacity'),
    ];
    expect(evaluateKeyframes(frames, 'x', 1)).toBeCloseTo(5);
  });
});

describe('punchInKeyframes', () => {
  it('builds two scale keyframes with defaults', () => {
    const frames = punchInKeyframes({ idPrefix: 'clip1', startTime: 1, endTime: 3 });
    expect(frames.map((k) => k.property)).toEqual(['scale', 'scale']);
    expect(frames[0]!.value).toBeCloseTo(1);
    expect(frames[1]!.value).toBeCloseTo(1.2);
    expect(frames[0]!.time).toBe(1);
    expect(frames[1]!.time).toBe(3);
    expect(frames[0]!.easing).toBe('ease-in-out');
    expect(frames[0]!.id).not.toBe(frames[1]!.id);
  });

  it('respects custom scales, easing, and property', () => {
    const frames = punchInKeyframes({
      idPrefix: 'c',
      startTime: 0,
      endTime: 2,
      fromScale: 1.2,
      toScale: 1,
      easing: 'ease-out',
      property: 'zoom',
    });
    expect(frames[0]!.value).toBeCloseTo(1.2);
    expect(frames[1]!.value).toBeCloseTo(1);
    expect(frames.every((k) => k.property === 'zoom')).toBe(true);
    expect(frames[0]!.easing).toBe('ease-out');
  });

  it('evaluates to an eased ramp', () => {
    const frames = punchInKeyframes({ idPrefix: 'c', startTime: 0, endTime: 2 });
    const mid = evaluateKeyframes(frames, 'scale', 1);
    expect(mid).toBeDefined();
    expect(mid!).toBeGreaterThan(1);
    expect(mid!).toBeLessThan(1.2);
    expect(mid!).toBeCloseTo(1.1, 2);
  });

  it('rejects a non-positive span', () => {
    expect(() => punchInKeyframes({ idPrefix: 'c', startTime: 2, endTime: 2 })).toThrow(
      /endTime > startTime/,
    );
  });
});

// ---------------------------------------------------------------------------
// Custom bezier handles (schema v14, ADR 0089)
// ---------------------------------------------------------------------------

/** A keyframe carrying bezier handles. */
const bez = (
  time: number,
  value: number,
  handles?: { out: BezierHandle; in: BezierHandle },
  property = 'scale',
): Keyframe =>
  ({
    id: `kf_${property}_${time}`,
    time,
    property,
    value,
    easing: 'bezier',
    ...(handles ? { handles } : {}),
  }) as Keyframe;

const STRAIGHT = { out: [1 / 3, 1 / 3] as BezierHandle, in: [2 / 3, 2 / 3] as BezierHandle };

describe('solveCubicBezier', () => {
  it('is the identity for straight handles', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(solveCubicBezier(STRAIGHT.out, STRAIGHT.in, x)).toBeCloseTo(x, 10);
    }
  });

  it('pins both endpoints exactly', () => {
    // A curve that does not reach its own keyframes' values would make an animation
    // jump at every segment boundary.
    expect(solveCubicBezier([0.25, 0.1], [0.25, 1], 0)).toBe(0);
    expect(solveCubicBezier([0.25, 0.1], [0.25, 1], 1)).toBe(1);
  });

  it('allows overshoot above 1 — the reason custom curves exist', () => {
    // Clamping here would quietly flatten exactly the effect the user asked for.
    const peak = Math.max(
      ...[0.5, 0.6, 0.7, 0.8].map((x) => solveCubicBezier([0.34, 1.56], [0.64, 1], x)),
    );
    expect(peak).toBeGreaterThan(1);
  });

  it('allows anticipation below 0', () => {
    const dip = Math.min(
      ...[0.1, 0.2, 0.3].map((x) => solveCubicBezier([0.36, -0.4], [0.66, 1], x)),
    );
    expect(dip).toBeLessThan(0);
  });

  it('stays monotonic in x even on a near-vertical curve (the bisection path)', () => {
    // Newton stalls where the slope vanishes; without the bisection fallback the
    // solver would leave the domain and return nonsense.
    let previous = -Infinity;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = solveCubicBezier([0, 0], [0, 1], Math.min(x, 1));
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it('falls back to bisection when Newton overshoots the [0,1] domain', () => {
    // x-control points behind 0 make x(s) fold back on itself near s=0: Newton's
    // tangent step lands outside [0,1] on the very first iteration, which is
    // exactly the case the bisection rescue exists for. Without it, `s` would
    // stay out of domain and `bezierComponent` would extrapolate past the
    // curve's actual endpoints.
    let previous = -Infinity;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = solveCubicBezier([-1, 0], [-1, 1], Math.min(x, 1));
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
    expect(solveCubicBezier([-1, 0], [-1, 1], 0)).toBe(0);
    expect(solveCubicBezier([-1, 0], [-1, 1], 1)).toBe(1);
  });
});

describe('segmentProgress', () => {
  it('defers to applyEasing for every non-bezier curve', () => {
    for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as Easing[]) {
      expect(segmentProgress(kf(0, 0, easing), kf(1, 1), 0.3)).toBe(applyEasing(easing, 0.3));
    }
  });

  it('falls back to the hardcoded smoothstep when handles are ABSENT', () => {
    // THE compatibility rule (ADR 0089): absent must not mean linear and must not
    // mean some default curve, or the v14 migration would silently rewrite every
    // animation a v13 project already had.
    expect(segmentProgress(bez(0, 0), bez(1, 1), 0.3)).toBe(applyEasing('bezier', 0.3));
  });

  it('falls back when only ONE side carries a handle', () => {
    // A segment needs both control points; half a curve is not a curve.
    expect(segmentProgress(bez(0, 0, STRAIGHT), bez(1, 1), 0.3)).toBe(applyEasing('bezier', 0.3));
    expect(segmentProgress(bez(0, 0), bez(1, 1, STRAIGHT), 0.3)).toBe(applyEasing('bezier', 0.3));
  });

  it('uses left.out and right.in — the two-sided CSS convention', () => {
    // Proven by asymmetry: swapping which keyframe holds which handle changes the
    // curve, so the function cannot be reading only one side.
    const forward = segmentProgress(
      bez(0, 0, { out: [0.9, 0], in: [0.1, 1] }),
      bez(1, 1, { out: [0.1, 1], in: [0.9, 0] }),
      0.5,
    );
    const swapped = segmentProgress(
      bez(0, 0, { out: [0.1, 1], in: [0.9, 0] }),
      bez(1, 1, { out: [0.9, 0], in: [0.1, 1] }),
      0.5,
    );
    expect(forward).not.toBeCloseTo(swapped, 6);
  });

  it('clamps t into the segment', () => {
    expect(segmentProgress(bez(0, 0, STRAIGHT), bez(1, 1, STRAIGHT), -1)).toBe(0);
    expect(segmentProgress(bez(0, 0, STRAIGHT), bez(1, 1, STRAIGHT), 2)).toBe(1);
  });
});

describe('evaluateKeyframes with handles', () => {
  it('drives interpolation through the custom curve', () => {
    const points = [
      bez(0, 0, { out: [0.9, 0], in: [0.1, 1] }),
      bez(2, 100, { out: [0.1, 1], in: [0.9, 0] }),
    ];
    // A curve this flat at the start must be well under the linear midpoint.
    expect(evaluateKeyframes(points, 'scale', 1)!).toBeLessThan(50);
  });

  it('leaves a handle-free bezier animation evaluating exactly as it did in v13', () => {
    const v13 = [bez(0, 0), bez(2, 100)];
    expect(evaluateKeyframes(v13, 'scale', 0.5)).toBe(100 * applyEasing('bezier', 0.25));
  });
});

describe('cross-language bezier parity (ADR 0089)', () => {
  // The committed fixture is the contract: `tests/test_keyframes.py` asserts the
  // SAME numbers, so a change to the curve math on one side fails on the other.
  // Regenerating it is a deliberate act, never a way to make a test pass.
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/bezier-parity.json', import.meta.url)),
      'utf8',
    ),
  ) as {
    tolerance: number;
    cases: { curve: string; out: BezierHandle; in: BezierHandle; x: number; y: number }[];
  };

  it('reproduces every committed case', () => {
    expect(fixture.cases.length).toBeGreaterThan(50);
    for (const entry of fixture.cases) {
      expect(
        Math.abs(solveCubicBezier(entry.out, entry.in, entry.x) - entry.y),
        `${entry.curve} @ x=${entry.x}`,
      ).toBeLessThanOrEqual(fixture.tolerance);
    }
  });
});
