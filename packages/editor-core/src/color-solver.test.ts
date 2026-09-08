/**
 * What these tests can and cannot claim.
 *
 * They pin the SOLVER: its algebra, its direction, its clamping, its skin cap and
 * the ordering of its look amounts. They deliberately assert **no fitted number**,
 * because no number here has been fitted — the coefficients in `color-solver.ts`
 * are derived from the renderer's source and awaiting
 * `packages/ai-sdk/scripts/fit-color-response.mjs`. A test that froze one of them
 * as an expected value would turn a provisional guess into a regression gate and
 * make the real fit look like a bug.
 *
 * So: signs, orderings, bounds, invariants. Never "temperature is 0.3189".
 */
import { describe, expect, it } from 'vitest';
import { COLOR_GRADE_PARAMETER_CONTRACTS } from './edit-value-contracts.js';
import {
  EXPOSURE_OUTLIER_STOPS,
  LOOK_AMOUNTS,
  LOOK_INTENTS,
  SKIN_MIN_COVERAGE_RATIO,
  solveColorMatch,
  solveExposureNormalize,
  solveLook,
  type ColorMeasurement,
  type ColorSolution,
  type LookAmount,
  type LookIntent,
  type SkinMeasurement,
} from './color-solver.js';

interface MeasurementInput {
  readonly mean: number;
  readonly p10: number;
  readonly p90: number;
  /** Raw 8-bit signalstats averages; 128 is neutral. */
  readonly uMean?: number;
  readonly vMean?: number;
  readonly satMean?: number;
}

/** Build a self-consistent measurement: warmth and contrastIdx follow from the rest. */
function measurement(input: MeasurementInput): ColorMeasurement {
  const uMean = input.uMean ?? 128;
  const vMean = input.vMean ?? 128;
  return {
    luma: { mean: input.mean, p10: input.p10, p90: input.p90 },
    chroma: { uMean, vMean, satMean: input.satMean ?? 0.2 },
    warmth: (vMean - uMean) / 128,
    contrastIdx: input.p90 - input.p10,
  };
}

/** A plain, mid-exposed, slightly warm shot. */
const NEUTRAL_SHOT = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 122, vMean: 138 });

/** A caucasian-range skin reading, well above the coverage floor. */
const SKIN: SkinMeasurement = { red: 0.72, green: 0.52, blue: 0.44, coverage: 0.3 };

const param = (solution: ColorSolution, name: string): number =>
  (solution.params as Record<string, number | undefined>)[name] ?? 0;

describe('solveColorMatch — identity', () => {
  it('matching a measurement to itself is a no-op grade', () => {
    const solution = solveColorMatch(NEUTRAL_SHOT, NEUTRAL_SHOT);
    expect(solution.params).toEqual({});
    expect(solution.clamped).toBe(false);
    expect(solution.clampedParameters).toEqual([]);
    expect(solution.skinCapped).toBe(false);
  });

  it('is a no-op on every shape of shot, not just the tidy one', () => {
    const shots = [
      measurement({ mean: 0.08, p10: 0.01, p90: 0.2, uMean: 150, vMean: 110, satMean: 0.05 }),
      measurement({ mean: 0.82, p10: 0.6, p90: 0.98, uMean: 100, vMean: 160, satMean: 0.7 }),
      measurement({ mean: 0.5, p10: 0.49, p90: 0.51, satMean: 0.001 }),
    ];
    for (const shot of shots) expect(solveColorMatch(shot, shot).params).toEqual({});
  });

  it('a skin reading does not perturb an identity match', () => {
    expect(solveColorMatch(NEUTRAL_SHOT, NEUTRAL_SHOT, { skin: SKIN }).params).toEqual({});
  });
});

describe('solveColorMatch — monotonicity', () => {
  const reference = measurement({ mean: 0.5, p10: 0.25, p90: 0.75 });
  const darkerBy = (mean: number): ColorMeasurement =>
    measurement({ mean, p10: mean / 2, p90: mean * 1.5 });

  it('a darker target gets a positive exposure move', () => {
    expect(param(solveColorMatch(darkerBy(0.25), reference), 'exposure')).toBeGreaterThan(0);
  });

  it('a brighter target gets a negative exposure move', () => {
    expect(param(solveColorMatch(darkerBy(0.8), reference), 'exposure')).toBeLessThan(0);
  });

  it('the darker the target, the larger the exposure move', () => {
    const moves = [0.4, 0.3, 0.2, 0.1].map((mean) =>
      param(solveColorMatch(darkerBy(mean), reference), 'exposure'),
    );
    for (let i = 1; i < moves.length; i += 1) {
      expect(moves[i]).toBeGreaterThan(moves[i - 1] as number);
    }
  });

  it('a cooler target than the reference gets a positive temperature move, and vice versa', () => {
    const cool = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 140, vMean: 120 });
    const warm = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 116, vMean: 144 });
    expect(param(solveColorMatch(cool, warm), 'temperature')).toBeGreaterThan(0);
    expect(param(solveColorMatch(warm, cool), 'temperature')).toBeLessThan(0);
  });

  it('a flatter target than the reference gets a positive contrast move, and vice versa', () => {
    const flat = measurement({ mean: 0.5, p10: 0.4, p90: 0.6 });
    const punchy = measurement({ mean: 0.5, p10: 0.15, p90: 0.85 });
    expect(param(solveColorMatch(flat, punchy), 'contrast')).toBeGreaterThan(0);
    expect(param(solveColorMatch(punchy, flat), 'contrast')).toBeLessThan(0);
  });

  it('a duller target than the reference gets a positive saturation move, and vice versa', () => {
    const dull = measurement({ mean: 0.5, p10: 0.25, p90: 0.75, satMean: 0.1 });
    const rich = measurement({ mean: 0.5, p10: 0.25, p90: 0.75, satMean: 0.4 });
    expect(param(solveColorMatch(dull, rich), 'saturation')).toBeGreaterThan(0);
    expect(param(solveColorMatch(rich, dull), 'saturation')).toBeLessThan(0);
  });
});

describe('solveColorMatch — clamping is reported, never silent', () => {
  const cases: readonly { name: string; target: ColorMeasurement; reference: ColorMeasurement }[] =
    [
      {
        name: 'exposure at the ceiling',
        target: measurement({ mean: 0.004, p10: 0.001, p90: 0.01, satMean: 0.01 }),
        reference: measurement({ mean: 0.6, p10: 0.3, p90: 0.85 }),
      },
      {
        name: 'exposure at the floor',
        target: measurement({ mean: 0.95, p10: 0.9, p90: 0.99 }),
        reference: measurement({ mean: 0.01, p10: 0.005, p90: 0.02 }),
      },
      {
        name: 'temperature at the ceiling',
        target: measurement({ mean: 0.45, p10: 0.2, p90: 0.7 }),
        reference: measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 60, vMean: 200 }),
      },
      {
        name: 'tint at a bound',
        target: measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 100, vMean: 100 }),
        reference: measurement({ mean: 0.45, p10: 0.2, p90: 0.7 }),
      },
      {
        name: 'contrast at the ceiling',
        target: measurement({ mean: 0.5, p10: 0.47, p90: 0.53 }),
        reference: measurement({ mean: 0.5, p10: 0.05, p90: 0.95 }),
      },
      {
        name: 'saturation at the ceiling',
        target: measurement({ mean: 0.5, p10: 0.25, p90: 0.75, satMean: 0.05 }),
        reference: measurement({ mean: 0.5, p10: 0.25, p90: 0.75, satMean: 0.9 }),
      },
    ];

  for (const { name, target, reference } of cases) {
    it(`reports ${name}`, () => {
      const solution = solveColorMatch(target, reference);
      const expected = name.split(' ')[0] as string;
      expect(solution.clamped).toBe(true);
      expect(solution.clampedParameters).toContain(expected);
      const contract = COLOR_GRADE_PARAMETER_CONTRACTS[expected];
      const value = param(solution, expected);
      expect(value === contract?.min || value === contract?.max).toBe(true);
    });
  }

  it('reports shadows and highlights when the zone move cannot reach the reference', () => {
    // A near-flat target against a full-range reference: contrast alone cannot
    // close it, so the zone solve asks for more lift than the contracts allow.
    const solution = solveColorMatch(
      measurement({ mean: 0.5, p10: 0.45, p90: 0.55 }),
      measurement({ mean: 0.5, p10: 0, p90: 1 }),
    );
    expect(solution.clampedParameters).toContain('shadows');
    expect(solution.clampedParameters).toContain('highlights');
    expect(param(solution, 'shadows')).toBe(COLOR_GRADE_PARAMETER_CONTRACTS.shadows?.min);
    expect(param(solution, 'highlights')).toBe(COLOR_GRADE_PARAMETER_CONTRACTS.highlights?.max);
  });

  it('says nothing was clamped when nothing was', () => {
    const solution = solveColorMatch(
      measurement({ mean: 0.4, p10: 0.2, p90: 0.62, uMean: 126, vMean: 132, satMean: 0.18 }),
      measurement({ mean: 0.46, p10: 0.24, p90: 0.7, uMean: 124, vMean: 134, satMean: 0.21 }),
    );
    expect(solution.clamped).toBe(false);
    expect(solution.clampedParameters).toEqual([]);
  });
});

describe('every emitted parameter is inside COLOR_GRADE_PARAMETER_CONTRACTS', () => {
  /** A spread of shots chosen to include the degenerate ones. */
  const SHOTS: readonly ColorMeasurement[] = [
    NEUTRAL_SHOT,
    measurement({ mean: 0.02, p10: 0, p90: 0.06, uMean: 130, vMean: 126, satMean: 0.01 }),
    measurement({ mean: 0.97, p10: 0.9, p90: 1, uMean: 118, vMean: 150, satMean: 0.85 }),
    measurement({ mean: 0.5, p10: 0.5, p90: 0.5, satMean: 0 }),
    measurement({ mean: 0.3, p10: 0.05, p90: 0.9, uMean: 90, vMean: 170, satMean: 0.6 }),
    measurement({ mean: 0.62, p10: 0.4, p90: 0.8, uMean: 160, vMean: 96, satMean: 0.33 }),
  ];

  const assertInsideContracts = (solution: ColorSolution): void => {
    for (const [name, value] of Object.entries(solution.params)) {
      const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
      expect(contract, `unknown parameter "${name}"`).toBeDefined();
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(contract?.min as number);
      expect(value).toBeLessThanOrEqual(contract?.max as number);
    }
  };

  it('holds for every ordered pair of shots, with and without skin', () => {
    for (const target of SHOTS) {
      for (const reference of SHOTS) {
        assertInsideContracts(solveColorMatch(target, reference));
        assertInsideContracts(solveColorMatch(target, reference, { skin: SKIN }));
      }
    }
  });

  it('holds for every look at every amount on every shot', () => {
    for (const shot of SHOTS) {
      for (const intent of LOOK_INTENTS) {
        for (const amount of LOOK_AMOUNTS) {
          assertInsideContracts(solveLook(intent, amount, shot));
        }
      }
    }
  });

  it('holds for exposure normalisation', () => {
    const result = solveExposureNormalize(
      SHOTS.map((shot, index) => ({ id: `c${String(index)}`, measurement: shot })),
    );
    for (const correction of result.corrections) {
      assertInsideContracts({ ...correction, skinCapped: false });
    }
  });
});

describe('skin protection', () => {
  /** A fluorescent-green cast: the correction is almost pure tint, which is what swings hue. */
  const GREEN_CAST = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 118, vMean: 118 });
  const NEUTRAL_REFERENCE = measurement({ mean: 0.45, p10: 0.2, p90: 0.7 });

  it('engages on a green/magenta correction and shrinks the white-balance move', () => {
    const free = solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE);
    const capped = solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE, { skin: SKIN });
    expect(free.skinCapped).toBe(false);
    expect(capped.skinCapped).toBe(true);
    expect(Math.abs(param(capped, 'tint'))).toBeLessThan(Math.abs(param(free, 'tint')));
  });

  it('shrinks temperature and tint together, so the direction of the correction survives', () => {
    const free = solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE);
    const capped = solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE, { skin: SKIN });
    expect(Math.sign(param(capped, 'tint'))).toBe(Math.sign(param(free, 'tint')));
    expect(Math.sign(param(capped, 'temperature'))).toBe(Math.sign(param(free, 'temperature')));
    const tintScale = param(capped, 'tint') / param(free, 'tint');
    const temperatureScale = param(capped, 'temperature') / param(free, 'temperature');
    expect(temperatureScale).toBeCloseTo(tintScale, 2);
  });

  it('does not engage on a warm/cool move, because that follows the skin line', () => {
    // The renderer's white balance pushes red up and blue down together, which
    // moves skin along its own hue rather than off it. This is a property of the
    // MODEL, not a measured fact about faces, and the cap correctly stays out.
    const warmReference = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 108, vMean: 148 });
    const solution = solveColorMatch(NEUTRAL_REFERENCE, warmReference, { skin: SKIN });
    expect(param(solution, 'temperature')).toBeGreaterThan(0);
    expect(solution.skinCapped).toBe(false);
  });

  it('does not engage when the skin reading is below the coverage floor', () => {
    const solution = solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE, {
      skin: { ...SKIN, coverage: SKIN_MIN_COVERAGE_RATIO / 2 },
    });
    expect(solution.skinCapped).toBe(false);
    expect(solution.params).toEqual(solveColorMatch(GREEN_CAST, NEUTRAL_REFERENCE).params);
  });

  it('caps a look the same way it caps a match', () => {
    const solution = solveLook('cinematic', 'strong', GREEN_CAST, { skin: SKIN });
    const free = solveLook('cinematic', 'strong', GREEN_CAST);
    expect(free.skinCapped).toBe(false);
    expect(solution.skinCapped).toBe(false);
    // Cinematic moves warmth, not green/magenta, so nothing should be capped —
    // the assertion that matters is that the cap does not fire spuriously.
    expect(solution.params).toEqual(free.params);
  });
});

describe('solveExposureNormalize', () => {
  const shot = (id: string, mean: number) => ({
    id,
    measurement: measurement({ mean, p10: mean * 0.45, p90: mean * 1.5 }),
  });

  it('touches only the outliers', () => {
    const result = solveExposureNormalize([
      shot('a', 0.44),
      shot('b', 0.45),
      shot('c', 0.46),
      shot('dark', 0.15),
      shot('blown', 0.85),
    ]);
    expect(result.corrections.map((c) => c.id)).toEqual(['dark', 'blown']);
    expect(result.untouchedIds).toEqual(['a', 'b', 'c']);
  });

  it('leaves everything alone when every shot already agrees', () => {
    const result = solveExposureNormalize([shot('a', 0.45), shot('b', 0.46), shot('c', 0.44)]);
    expect(result.corrections).toEqual([]);
    expect(result.untouchedIds).toEqual(['a', 'b', 'c']);
  });

  it('moves outliers toward the anchor, in the right direction', () => {
    const result = solveExposureNormalize([
      shot('a', 0.45),
      shot('b', 0.45),
      shot('dark', 0.15),
      shot('blown', 0.9),
    ]);
    const byId = new Map(result.corrections.map((c) => [c.id, c]));
    expect(byId.get('dark')?.params.exposure).toBeGreaterThan(0);
    expect(byId.get('blown')?.params.exposure).toBeLessThan(0);
    expect(byId.get('dark')?.deviationStops).toBeLessThan(0);
    expect(byId.get('blown')?.deviationStops).toBeGreaterThan(0);
  });

  it('emits exposure and nothing else', () => {
    const result = solveExposureNormalize([shot('a', 0.45), shot('b', 0.45), shot('dark', 0.12)]);
    for (const correction of result.corrections) {
      expect(Object.keys(correction.params)).toEqual(['exposure']);
    }
  });

  it('uses the median when no anchor is named', () => {
    const result = solveExposureNormalize([shot('a', 0.2), shot('b', 0.4), shot('c', 0.6)]);
    expect(result.anchorLumaMean).toBeCloseTo(0.4, 10);
    expect(result.anchorId).toBeUndefined();
  });

  it('uses a named anchor and says which it used', () => {
    const result = solveExposureNormalize([shot('a', 0.2), shot('b', 0.4), shot('c', 0.6)], {
      clipId: 'a',
    });
    expect(result.anchorId).toBe('a');
    expect(result.anchorLumaMean).toBeCloseTo(0.2, 10);
    expect(result.corrections.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('falls back to the median rather than refusing an unknown anchor id', () => {
    const result = solveExposureNormalize([shot('a', 0.2), shot('b', 0.4), shot('c', 0.6)], {
      clipId: 'not-here',
    });
    expect(result.anchorId).toBeUndefined();
    expect(result.anchorLumaMean).toBeCloseTo(0.4, 10);
  });

  it('respects the stated tolerance exactly at its edge', () => {
    const anchorMean = 0.4;
    const justInside = anchorMean * 2 ** (EXPOSURE_OUTLIER_STOPS * 0.99);
    const justOutside = anchorMean * 2 ** (EXPOSURE_OUTLIER_STOPS * 1.01);
    // Three at the anchor so the median IS the anchor: the tolerance is what is
    // under test here, not the median.
    const result = solveExposureNormalize([
      shot('anchor-a', anchorMean),
      shot('anchor-b', anchorMean),
      shot('anchor-c', anchorMean),
      shot('inside', justInside),
      shot('outside', justOutside),
    ]);
    expect(result.untouchedIds).toContain('inside');
    expect(result.corrections.map((c) => c.id)).toEqual(['outside']);
  });

  it('leaves un-measurable shots alone instead of grading them blind', () => {
    const result = solveExposureNormalize([
      shot('a', 0.45),
      shot('b', 0.45),
      { id: 'black', measurement: measurement({ mean: 0, p10: 0, p90: 0 }) },
    ]);
    expect(result.untouchedIds).toContain('black');
    expect(result.corrections).toEqual([]);
  });

  it('reports a correction the exposure contract could not reach', () => {
    const result = solveExposureNormalize([
      shot('a', 0.9),
      shot('b', 0.9),
      { id: 'crushed', measurement: measurement({ mean: 0.001, p10: 0, p90: 0.004 }) },
    ]);
    const crushed = result.corrections.find((c) => c.id === 'crushed');
    expect(crushed?.clamped).toBe(true);
    expect(crushed?.clampedParameters).toEqual(['exposure']);
    expect(crushed?.params.exposure).toBe(COLOR_GRADE_PARAMETER_CONTRACTS.exposure?.max);
  });

  it('returns an empty result for an empty list', () => {
    expect(solveExposureNormalize([])).toEqual({
      anchorLumaMean: 0,
      corrections: [],
      untouchedIds: [],
    });
  });
});

describe('solveLook', () => {
  /** The parameter each look is required to move, and which way. */
  const AXIS: Readonly<Record<LookIntent, { readonly name: string; readonly sign: 1 | -1 }>> = {
    warmer: { name: 'temperature', sign: 1 },
    cooler: { name: 'temperature', sign: -1 },
    punchier: { name: 'contrast', sign: 1 },
    flatter: { name: 'contrast', sign: -1 },
    brighter: { name: 'exposure', sign: 1 },
    darker: { name: 'exposure', sign: -1 },
    cinematic: { name: 'temperature', sign: -1 },
    // A warm baseline neutralised gets cooled; the sign is the baseline's, inverted.
    clean: { name: 'temperature', sign: -1 },
  };

  for (const intent of LOOK_INTENTS) {
    it(`"${intent}" moves ${AXIS[intent].name} the right way at every amount`, () => {
      for (const amount of LOOK_AMOUNTS) {
        const value = param(solveLook(intent, amount, NEUTRAL_SHOT), AXIS[intent].name);
        expect(Math.sign(value), `${intent}/${amount}`).toBe(AXIS[intent].sign);
      }
    });

    it(`"${intent}" is ordered subtle < medium < strong`, () => {
      const magnitude = (amount: LookAmount): number =>
        Math.abs(param(solveLook(intent, amount, NEUTRAL_SHOT), AXIS[intent].name));
      expect(magnitude('subtle')).toBeLessThan(magnitude('medium'));
      expect(magnitude('medium')).toBeLessThan(magnitude('strong'));
    });
  }

  it('"punchier" raises saturation as well as contrast, and "flatter" lowers both', () => {
    const punchier = solveLook('punchier', 'medium', NEUTRAL_SHOT);
    const flatter = solveLook('flatter', 'medium', NEUTRAL_SHOT);
    expect(param(punchier, 'saturation')).toBeGreaterThan(0);
    expect(param(flatter, 'saturation')).toBeLessThan(0);
  });

  it('"cinematic" cools, desaturates and lifts the shadows', () => {
    const solution = solveLook('cinematic', 'medium', NEUTRAL_SHOT);
    expect(param(solution, 'temperature')).toBeLessThan(0);
    expect(param(solution, 'saturation')).toBeLessThan(0);
    expect(param(solution, 'shadows')).toBeGreaterThan(0);
    expect(param(solution, 'contrast')).toBeGreaterThan(0);
  });

  it('"clean" pulls a cast toward neutral, whichever way the cast runs', () => {
    const warm = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 112, vMean: 144 });
    const cool = measurement({ mean: 0.45, p10: 0.2, p90: 0.7, uMean: 144, vMean: 112 });
    expect(param(solveLook('clean', 'medium', warm), 'temperature')).toBeLessThan(0);
    expect(param(solveLook('clean', 'medium', cool), 'temperature')).toBeGreaterThan(0);
  });

  it('"clean" on already-neutral footage is a no-op', () => {
    const neutral = measurement({ mean: 0.45, p10: 0.2, p90: 0.7 });
    expect(solveLook('clean', 'strong', neutral).params).toEqual({});
  });

  it('"brighter" and "darker" move exposure and leave the rest alone', () => {
    for (const amount of LOOK_AMOUNTS) {
      expect(Object.keys(solveLook('brighter', amount, NEUTRAL_SHOT).params)).toEqual(['exposure']);
      expect(Object.keys(solveLook('darker', amount, NEUTRAL_SHOT).params)).toEqual(['exposure']);
    }
  });

  it('"warmer" is the same amount of warmer on dark footage as on bright, and costs more', () => {
    // The whole reason looks are stated in fact units: the measured move is the
    // constant, and the parameter is whatever that costs on this material.
    const dark = measurement({ mean: 0.15, p10: 0.05, p90: 0.3 });
    const bright = measurement({ mean: 0.7, p10: 0.5, p90: 0.9 });
    const onDark = param(solveLook('warmer', 'medium', dark), 'temperature');
    const onBright = param(solveLook('warmer', 'medium', bright), 'temperature');
    expect(onDark).toBeGreaterThan(onBright);
    expect(onBright).toBeGreaterThan(0);
  });
});
