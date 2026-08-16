/**
 * Speed curves (schema v15, ADR 0090).
 *
 * Two obligations, and they are different in kind:
 *
 *  1. **The maths is right** — the integral generalises ADR 0046's division, the
 *     inversion is its actual inverse, and a freeze is not judged by a rule that
 *     cannot apply to it.
 *  2. **The two languages agree on the NUMBERS.** `test_schema_parity.py` proves the
 *     two schemas have the same shape; it cannot prove two numerical integrators
 *     produce the same duration, and the duration is what desynchronises a timeline
 *     when it drifts. `fixtures/speed-curve-parity.json` is asserted here and in
 *     `test_speed_curve.py`, to 1e-9.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clip, SpeedPoint } from '@framepilot/timeline-schema';
import {
  clipTimelineDuration,
  hasSpeedRamp,
  integrateRate,
  normalizeRamp,
  rateAt,
  sourceSpanForDuration,
  sourceTimeAt,
} from './speed-curve.js';

const point = (id: string, sourceTime: number, rate: number, easing = 'linear'): SpeedPoint =>
  ({ id, sourceTime, rate, easing }) as SpeedPoint;

const clip = (overrides: Partial<Clip>): Clip => ({
  id: 'c',
  assetId: 'a',
  trackId: 'v',
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
  ...overrides,
});

describe('the integral generalises ADR 0046', () => {
  it('reduces to (source span / speed) exactly for a constant rate', () => {
    // The whole design rests on the constant case falling out of the integral, so
    // this is asserted, not assumed.
    for (const rate of [0.25, 0.5, 1, 2, 4]) {
      const ramp = [point('a', 0, rate), point('b', 10, rate)];
      expect(integrateRate(ramp, 0, 10)).toBeCloseTo(10 / rate, 9);
    }
  });

  it('is zero for an empty or reversed range', () => {
    const ramp = [point('a', 0, 2)];
    expect(integrateRate(ramp, 3, 3)).toBe(0);
    expect(integrateRate(ramp, 5, 1)).toBe(0);
  });

  it('treats no ramp as 1x', () => {
    expect(integrateRate([], 0, 7)).toBe(7);
    expect(rateAt([], 3)).toBe(1);
  });

  it('is additive across a split point to well within the enforced tolerance', () => {
    // If it were not, splitting a ramped clip would change the total duration.
    //
    // Asserted against SPEED_EPSILON's scale rather than to 1e-9, because NO fixed
    // quadrature is exactly additive: splitting changes the sampling grid, so the
    // two sides carry slightly different error. At 128 intervals the gap is ~4e-9,
    // three orders inside the 1e-6 the validator enforces — which is the number
    // that actually decides whether a split of a ramped clip is accepted.
    const ramp = [point('a', 0, 1), point('b', 4, 3, 'ease-in-out')];
    const whole = integrateRate(ramp, 0, 4);
    const halves = integrateRate(ramp, 0, 1.7) + integrateRate(ramp, 1.7, 4);
    expect(Math.abs(halves - whole)).toBeLessThan(1e-7);
  });
});

describe('rateAt', () => {
  it('HOLDS the rate outside the curve rather than extrapolating', () => {
    // Extrapolating a curve whose last two points accelerate would keep
    // accelerating past the end of the footage and could cross zero, which the
    // schema forbids for good reason. A held rate cannot.
    const ramp = [point('a', 2, 0.5), point('b', 4, 4)];
    expect(rateAt(ramp, 0)).toBe(0.5);
    expect(rateAt(ramp, 100)).toBe(4);
  });

  it('interpolates on the point\'s own easing', () => {
    const linear = [point('a', 0, 1), point('b', 2, 3)];
    expect(rateAt(linear, 1)).toBeCloseTo(2, 9);
    // ease-in is t², so the midpoint is a quarter of the way up.
    const easeIn = [point('a', 0, 1, 'ease-in'), point('b', 2, 3)];
    expect(rateAt(easeIn, 1)).toBeCloseTo(1.5, 9);
  });
});

describe('normalizeRamp', () => {
  it('sorts, so a patch appending a point need not know where it belongs', () => {
    const ramp = normalizeRamp([point('c', 4, 1), point('a', 0, 2), point('b', 2, 3)]);
    expect(ramp.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('collapses two points at the same source time', () => {
    // A curve cannot have two rates at one instant, and keeping both would make the
    // integral depend on array order.
    const ramp = normalizeRamp([point('a', 2, 1), point('dup', 2, 99)]);
    expect(ramp).toHaveLength(1);
    expect(ramp[0]!.id).toBe('a');
  });

  it('drops a non-positive rate rather than integrating to infinity', () => {
    expect(normalizeRamp([point('a', 0, 0), point('b', 1, 2)]).map((p) => p.id)).toEqual(['b']);
  });
});

describe('sourceTimeAt inverts the integral', () => {
  it('round-trips: integrating to s and inverting that duration returns s', () => {
    const ramp = [point('a', 0, 1), point('b', 3, 0.25, 'ease-in-out'), point('c', 6, 2)];
    for (const s of [0.4, 1.5, 3, 4.2, 5.9]) {
      const timeline = integrateRate(ramp, 0, s);
      expect(sourceTimeAt(ramp, 0, timeline, 6)).toBeCloseTo(s, 6);
    }
  });

  it('clamps at the end of the footage instead of reading past it', () => {
    const ramp = [point('a', 0, 1)];
    expect(sourceTimeAt(ramp, 0, 1e6, 6)).toBe(6);
  });

  it('returns the start for a non-positive offset', () => {
    expect(sourceTimeAt([point('a', 0, 2)], 1.5, 0, 6)).toBe(1.5);
    expect(sourceTimeAt([point('a', 0, 2)], 1.5, -3, 6)).toBe(1.5);
  });

  it('falls back to 1:1 (clamped) when there is no ramp at all', () => {
    // An empty ramp is the same "no curve" case `rateAt`/`integrateRate` treat as
    // a constant 1x — `sourceTimeAt` has to agree, or a clip with no ramp would
    // invert its own (trivial) integral inconsistently with the other two.
    expect(sourceTimeAt([], 1, 2, 6)).toBe(3);
    expect(sourceTimeAt([], 1, 10, 6)).toBe(6); // clamped at maxSource
  });
});

describe('clipTimelineDuration', () => {
  it('divides by the MAGNITUDE, so reverse takes positive timeline time', () => {
    expect(clipTimelineDuration(clip({ sourceEnd: 8, speed: 2 }))).toBe(4);
    expect(clipTimelineDuration(clip({ sourceEnd: 8, speed: -2 }))).toBe(4);
  });

  it('is null for a freeze frame, because no duration is derivable', () => {
    // A held frame's length is SET, not derived. Inventing an expectation would
    // make every freeze frame fail the validator.
    expect(clipTimelineDuration(clip({ speed: 0 }))).toBeNull();
  });

  it('lets the ramp win over a stale constant speed', () => {
    const ramped = clip({
      sourceEnd: 4,
      speed: 8,
      speedRamp: [point('a', 0, 2), point('b', 4, 2)],
    });
    expect(hasSpeedRamp(ramped)).toBe(true);
    expect(clipTimelineDuration(ramped)).toBeCloseTo(2, 9);
  });
});

describe('sourceSpanForDuration', () => {
  it('is the inverse of clipTimelineDuration for every speed case', () => {
    for (const speed of [0.5, 1, 2, -2]) {
      const c = clip({ sourceEnd: 8, speed });
      const duration = clipTimelineDuration(c)!;
      expect(sourceSpanForDuration(c, 0, duration)).toBeCloseTo(8, 6);
    }
  });

  it('consumes NO footage for a freeze, however long it is held', () => {
    // Which is exactly what makes trimming a freeze frame safe.
    expect(sourceSpanForDuration(clip({ speed: 0 }), 0, 30)).toBe(0);
  });

  it('consumes no footage for a non-positive duration', () => {
    expect(sourceSpanForDuration(clip({}), 0, 0)).toBe(0);
    expect(sourceSpanForDuration(clip({}), 0, -1)).toBe(0);
  });

  it('defaults an absent speed to 1x', () => {
    const c = clip({ sourceEnd: 8 });
    expect(c.speed).toBeUndefined();
    expect(sourceSpanForDuration(c, 0, 4)).toBe(4);
  });

  it('is the inverse of the integral for a RAMPED clip too', () => {
    // Constant speed goes through `Math.abs(speed) * duration`; a ramp has to go
    // through `sourceTimeAt` instead, since there is no single rate to multiply by.
    const c = clip({
      sourceEnd: 10,
      speedRamp: [point('p1', 0, 2, 'linear'), point('p2', 10, 2, 'linear')],
    });
    const duration = clipTimelineDuration(c)!;
    expect(sourceSpanForDuration(c, 0, duration)).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// Cross-language numeric parity
// ---------------------------------------------------------------------------

interface ParityFixture {
  readonly curves: Record<string, SpeedPoint[]>;
  readonly cases: readonly {
    readonly curve: string;
    readonly fn: 'rateAt' | 'integrateRate' | 'sourceTimeAt';
    readonly args: readonly number[];
    readonly expected: number;
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/speed-curve-parity.json', import.meta.url)),
    'utf8',
  ),
) as ParityFixture;

describe('numeric parity fixture (shared with test_speed_curve.py)', () => {
  it('covers every curve and every function', () => {
    // A fixture that silently lost its cases would pass vacuously in both suites.
    expect(fixture.cases.length).toBeGreaterThan(200);
    expect(new Set(fixture.cases.map((c) => c.fn)).size).toBe(3);
  });

  it.each(['rateAt', 'integrateRate', 'sourceTimeAt'] as const)('matches for %s', (fn) => {
    for (const testCase of fixture.cases.filter((c) => c.fn === fn)) {
      const points = fixture.curves[testCase.curve]!;
      const [a, b, c] = testCase.args;
      const actual =
        fn === 'rateAt'
          ? rateAt(points, a!)
          : fn === 'integrateRate'
            ? integrateRate(points, a!, b!)
            : sourceTimeAt(points, a!, b!, c!);
      expect(actual).toBeCloseTo(testCase.expected, 9);
    }
  });
});
