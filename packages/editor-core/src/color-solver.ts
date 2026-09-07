/**
 * The colour solver: grade parameters computed from measurements, not guessed
 * (`plan/visual-understanding/04-SOLVERS-COLOR-TRANSITIONS.md` §VU3.1).
 *
 * ## The problem
 *
 * `measure_color` returns real luma and chroma distributions and nothing has ever
 * consumed them (ADR 0175, "Nothing consumes measurements"). Across ten recorded
 * golden runs (`reports/golden/BASELINE.md`) every `apply_color_grade` the agent
 * issued carried numbers the model invented: guess rate 1.00. This module is the
 * missing consumer. It takes two measurements and returns the grade that moves
 * one toward the other, in the renderer's own parameters and inside the
 * renderer's own ranges.
 *
 * ## THE COEFFICIENTS ARE NOT FITTED YET — read this before trusting a number
 *
 * VU3.1 asks for per-parameter response curves **fitted by rendering a grid of
 * parameter values through `/render/frame` and measuring each one**. That needs a
 * running sidecar and real render time, so it has not been done. What is here
 * instead is an **explicit first-order model derived analytically from the
 * renderer's source** (`engine/python/framepilot_engine/render/color.py`) and the
 * measurement chain that produces the facts
 * (`engine/python/framepilot_engine/analysis/shot_stats.py`).
 *
 * ## FIRST MEASURED FIT — 2026-09-08, `mission-montage`, three clips
 *
 * `packages/ai-sdk/scripts/fit-color-response.mjs` has now been run against a live sidecar
 * (it could not be before: it took `--clip` and `--time` independently and never checked
 * the frame was on the graded clip, so it silently fitted every coefficient to 0.00000 and
 * told you to paste that in). What three clips of one fixture measure:
 *
 * | constant | derived, in use | clip_002 (luma .544) | clip_004 (luma .078) | clip_001 (luma .406) |
 * | --- | --- | --- | --- | --- |
 * | `EXPOSURE_RESPONSE` | 1.0 | 0.755 | 0.964 | 0.793 |
 * | `CONTRAST_RESPONSE` | 1.0 | 0.959 | −0.251 † | 0.788 |
 * | `SATURATION_RESPONSE` | 1.0 | 0.689 | 0.807 | 0.633 |
 * | `WARMTH_PER_TEMPERATURE` | 0.6936 | 0.567 | 0.633 | 0.576 |
 * | `GREEN_MAGENTA_PER_TEMPERATURE` | −0.0411 | −0.005 | +0.021 | −0.060 |
 * | `WARMTH_PER_TINT` | −0.0429 | −0.043 | −0.041 | −0.043 |
 * | `GREEN_MAGENTA_PER_TINT` | −0.5236 | −0.524 | −0.497 | −0.519 |
 *
 * † a near-black frame (contrastIdx 0.137) has no spread for a ratio to scale, and the fit
 * comes back with the wrong SIGN. The script warns on it now; it is not a measurement.
 *
 * What this says, and it is not "paste these in":
 *
 *  - **The tint coefficients are solid.** Three clips spanning 7× in luma agree to within
 *    5%, and they match the derived numbers almost exactly. The BT.709 derivation is right
 *    for tint.
 *  - **`WARMTH_PER_TEMPERATURE` is consistently LOWER than derived** — 0.567/0.633/0.576,
 *    mean ≈ 0.59 against 0.6936, so the solver currently under-shoots warmth by ~15%. That
 *    is a real, repeatable disagreement and the most interesting result here.
 *  - **It does not settle the range question.** The script reconstructs warmth from RGB
 *    through the SAME BT.709 matrix this module assumes, so it cannot tell a wrong matrix
 *    from a renderer whose temperature curve is simply shallower. Settling that needs a
 *    `signalstats` pass over a rendered file — the ledger's own chain — which is a second
 *    script that does not exist yet.
 *  - **The `*_RESPONSE` terms are material-dependent by construction.** They are the
 *    clipping efficiencies, and clipping depends on the shot: the darkest clip fits nearest
 *    to 1.0 because it has the most headroom, exactly as this docstring predicted. One
 *    number cannot be right for all footage, so 1.0 (no clipping) stays as the conservative
 *    choice until there is a per-shot model.
 *
 * So the coefficients below are UNCHANGED, and now for a stated reason rather than for want
 * of a measurement. TESTING_PLAN.md T16.4 carries the decision.
 *
 * That derivation is exact for the arithmetic it covers and silent about three
 * things it cannot know without a render:
 *
 * 1. **Clipping.** Every stage ends in a clamp to `[0, 1]`. A bright shot pushed
 *    up a stop loses its highlights to the ceiling, so the *measured* luma moves
 *    less than the model says. The `*_RESPONSE` constants below are the efficiency
 *    terms for exactly this, and they all sit at 1.0 — the no-clipping value.
 * 2. **The chroma matrix and range.** {@link WARMTH_PER_TEMPERATURE} is derived
 *    assuming full-range BT.709 chroma. If the render/measure path is limited
 *    range, or BT.601, the coefficient is wrong by a fixed factor.
 * 3. **White balance's effect on saturation.** Multiplying red up and blue down
 *    changes `satMean`; the saturation solve ignores that cross-term.
 *
 * So: a solved grade here is **directionally right and approximately scaled**. It
 * is a large improvement on a number the model made up, and it is not a
 * calibrated instrument. Do not quote its accuracy — nobody has measured it.
 *
 * **To fit it for real:** run `packages/ai-sdk/scripts/fit-color-response.mjs`
 * against a live sidecar. It renders the grid, measures each cell, prints the
 * fitted coefficients, and says which of the constants below to replace.
 *
 * ## The model, stage by stage
 *
 * The renderer's pipeline order is fixed and the inversion follows it exactly:
 * exposure → white balance → contrast → shadows/highlights → saturation.
 *
 * | Parameter    | Effect on the pixels                         | Effect on the facts                       |
 * | ------------ | -------------------------------------------- | ----------------------------------------- |
 * | `exposure`   | `rgb *= 2**e`                                | luma and chroma both scale by `2**e`      |
 * | `temperature`| `R *= 1+0.3t`, `B *= 1-0.3t`                 | warmth moves; scaled by the current luma  |
 * | `tint`       | `G *= 1+0.3t`                                | green/magenta moves; warmth barely        |
 * | `contrast`   | `(rgb-0.5)*(1+c)+0.5`                        | luma spread and chroma both scale by `1+c`|
 * | `shadows`    | `+0.5*s*(1-lum)**2`                          | lifts the low percentile                  |
 * | `highlights` | `+0.5*h*lum**2`                              | lifts the high percentile                 |
 * | `saturation` | `lum + (rgb-lum)*(1+s)`                      | `satMean` scales by `1+s`, luma unchanged |
 *
 * Two consequences that are easy to get wrong and that the solver handles:
 * exposure and contrast **both scale chroma**, so the warmth and saturation moves
 * are solved against the values that survive those stages, not against the raw
 * measurement; and shadows and highlights **both** touch **both** percentiles, so
 * they are solved as one 2x2 system rather than one at a time.
 *
 * ## What this module is not
 *
 * Pure and deterministic: same inputs, same output, no clock, no randomness, no
 * I/O. It emits parameters, never operations — the caller builds the
 * `apply_color_grade` effect that already exists, so validation, undo and render
 * are untouched. It does not import `@framepilot/ai-sdk`; the measurement shapes
 * below are structural restatements of that package's `MeasuredFacts` so a caller
 * holding one can pass it straight through.
 */
import type { ProfessionalColorAdjustments, ProfessionalColorParameter } from './color-commands.js';
import { COLOR_GRADE_PARAMETER_CONTRACTS } from './edit-value-contracts.js';

// ---------------------------------------------------------------------------
// What a measurement looks like
// ---------------------------------------------------------------------------

/** Brightness distribution over a shot or a window, normalised 0..1 from the Y plane. */
export interface LumaMeasurement {
  readonly mean: number;
  /** Carried for the caller's reporting; no rule reads it. */
  readonly std?: number;
  /** signalstats `YLOW` — the 10th percentile, normalised. */
  readonly p10: number;
  /** signalstats `YHIGH` — the 90th percentile, normalised. */
  readonly p90: number;
}

/**
 * Chroma averages, in the units the tier-0 pass stores them in.
 *
 * `uMean`/`vMean` are RAW 8-bit signalstats averages (0..255, neutral at 128) —
 * the one pair of fields in `MeasuredFacts` that is not normalised, which is
 * exactly why the unit is restated here. `satMean` is 0..1.
 */
export interface ChromaMeasurement {
  readonly uMean: number;
  readonly vMean: number;
  readonly satMean: number;
}

/**
 * Everything the solver reads about one shot.
 *
 * Structurally a subset of `MeasuredFacts` (`@framepilot/ai-sdk/ledger`).
 * **Both sides of a match must come from the same measurement chain** — the
 * ledger's tier-0 pass measures the ungraded source, `/review/temporal-evidence`
 * measures the rendered composite, and matching one against the other solves for
 * a difference that is partly the grade already applied.
 */
export interface ColorMeasurement {
  readonly luma: LumaMeasurement;
  readonly chroma: ChromaMeasurement;
  /** `(V - U) / 128`, clamped to -1..1. Positive is warm. */
  readonly warmth: number;
  /** `p90 - p10` of luma. */
  readonly contrastIdx: number;
}

/**
 * Skin-coloured pixel readings, if the caller measured them.
 *
 * Supplied by a `scope` evidence request over the `skin_red`/`skin_green`/
 * `skin_blue` channels (`validation/temporal_evidence.py`), which qualify skin by
 * colour region rather than detecting faces. Channels are normalised 0..1;
 * `coverage` is that request's `coverage_ratio`.
 *
 * Low coverage means **no reading**, never "no drift" — the qualifier's own
 * contract. {@link SKIN_MIN_COVERAGE_RATIO} is where the solver stops believing it.
 */
export interface SkinMeasurement {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  /** Fraction of sampled pixels the qualifier selected. Absent means unknown. */
  readonly coverage?: number;
}

/** What the solver decided, and what it could not fit inside the contracts. */
export interface ColorSolution {
  /**
   * Only the axes that moved. An empty object is a no-op grade and the honest
   * answer when the two measurements already agree.
   */
  readonly params: ProfessionalColorAdjustments;
  /** True when any parameter hit a contract bound and the match is therefore partial. */
  readonly clamped: boolean;
  /** Which parameters hit a bound, in pipeline order. */
  readonly clampedParameters: readonly ProfessionalColorParameter[];
  /** True when {@link SKIN_MAX_HUE_SHIFT_DEGREES} shrank the white-balance move. */
  readonly skinCapped: boolean;
}

export interface ColorSolverOptions {
  /** The TARGET's skin reading — the footage the grade will be applied to. */
  readonly skin?: SkinMeasurement;
}

// ---------------------------------------------------------------------------
// Constants mirroring the renderer. Change these only when render/color.py changes.
// ---------------------------------------------------------------------------

/** `_TEMP_GAIN` in `render/color.py`: red/blue push per unit temperature. */
const RENDER_TEMPERATURE_GAIN = 0.3;

/** `_TINT_GAIN` in `render/color.py`: green push per unit tint. */
const RENDER_TINT_GAIN = 0.3;

/** `_ZONE_GAIN` in `render/color.py`: lift per unit shadows/highlights at full zone weight. */
const RENDER_ZONE_GAIN = 0.5;

/** `_LUMA` in `render/color.py` — Rec.709 weights. They sum to 1, which the solve relies on. */
const REC709_RED = 0.2126;
const REC709_GREEN = 0.7152;
const REC709_BLUE = 0.0722;

/** The renderer's contrast pivot: mid-grey in normalised light. */
const CONTRAST_PIVOT = 0.5;

/** `_WARMTH_FULL` in `analysis/shot_stats.py`: half the 8-bit chroma range. */
const CHROMA_HALF_RANGE = 128;

/** Neutral 8-bit chroma. `uMean == vMean == 128` is a grey frame. */
const CHROMA_NEUTRAL = 128;

/** BT.709 Cb/Cr divisors, and the 8-bit scale signalstats reports U/V on. */
const BT709_CB_DIVISOR = 1.8556;
const BT709_CR_DIVISOR = 1.5748;
const CHROMA_8BIT_SCALE = 255;

// ---------------------------------------------------------------------------
// PROVISIONAL COEFFICIENTS — every one of these is what the fit replaces
// ---------------------------------------------------------------------------

/**
 * Measured `log2(luma.mean)` moved per unit of `exposure`. **Provisional: 1.0.**
 *
 * Exactly 1.0 in the renderer's arithmetic — `rgb *= 2**e` scales every sample,
 * so the mean scales with it — and below 1.0 in practice because the final clamp
 * eats the highlights first. The fit measures the real figure, which will be
 * slightly under 1 and will fall further on bright material.
 */
const EXPOSURE_RESPONSE = 1.0;

/**
 * Measured `contrastIdx` ratio per unit of `1 + contrast`. **Provisional: 1.0.**
 *
 * 1.0 by construction: `(rgb - 0.5) * (1 + c) + 0.5` scales every distance from
 * the pivot, so `p90 - p10` scales with it. Clipping at both ends reduces it, and
 * the fit measures by how much.
 */
const CONTRAST_RESPONSE = 1.0;

/**
 * Measured `satMean` ratio per unit of `1 + saturation`. **Provisional: 1.0.**
 *
 * 1.0 because the renderer scales the distance from each pixel's own luma, which
 * is what `satMean` averages. Clipping in saturated highlights reduces it.
 */
const SATURATION_RESPONSE = 1.0;

/**
 * What one unit of a white-balance parameter does to the two chroma facts, on a
 * neutral patch of unit luma.
 *
 * DERIVED, NOT FITTED. This is the renderer's own channel arithmetic
 * (`R *= 1 + 0.3t`, `G *= 1 + 0.3·tint`, `B *= 1 - 0.3t`) pushed through
 * full-range BT.709 into signalstats' 8-bit U/V, written as code rather than as
 * four magic numbers so the assumption is inspectable and the fit has something
 * to disagree with. Two assumptions are baked in and neither can be checked
 * without a render: that the measured chain is full-range BT.709, and that a real
 * frame behaves like a neutral patch.
 *
 * @param deltaRed - Fractional change in the red channel per unit of the parameter.
 * @param deltaGreen - Fractional change in green.
 * @param deltaBlue - Fractional change in blue.
 * @returns `[warmth, greenMagenta]` moved per unit, at mean luma 1.0.
 */
function neutralPatchResponse(
  deltaRed: number,
  deltaGreen: number,
  deltaBlue: number,
): readonly [number, number] {
  const deltaLuma = REC709_RED * deltaRed + REC709_GREEN * deltaGreen + REC709_BLUE * deltaBlue;
  const deltaCr = (deltaRed - deltaLuma) / BT709_CR_DIVISOR;
  const deltaCb = (deltaBlue - deltaLuma) / BT709_CB_DIVISOR;
  const scale = CHROMA_8BIT_SCALE / CHROMA_HALF_RANGE;
  return [scale * (deltaCr - deltaCb), scale * (deltaCr + deltaCb)];
}

/**
 * Warmth and green/magenta moved per unit `temperature`, at mean luma 1.0.
 * **Provisional: derived, ~0.6936 and ~-0.0411.**
 *
 * The response **scales with the frame's mean luma** — white balance is
 * multiplicative, so a dark shot's chroma moves less in absolute terms — and the
 * solver evaluates it at the post-exposure luma rather than treating it as a
 * constant. That is what makes "warmer by 0.1" cost more temperature on dark
 * footage than on bright, which is the honest answer and the reason the clamp
 * report matters.
 */
const [WARMTH_PER_TEMPERATURE, GREEN_MAGENTA_PER_TEMPERATURE] = neutralPatchResponse(
  RENDER_TEMPERATURE_GAIN,
  0,
  -RENDER_TEMPERATURE_GAIN,
);

/**
 * The same for `tint`. **Provisional: derived, ~-0.0411 and ~-0.5018.**
 *
 * Tint barely touches warmth and temperature barely touches green/magenta, which
 * is why the two can be solved together at all: the 2x2 is strongly diagonal.
 */
const [WARMTH_PER_TINT, GREEN_MAGENTA_PER_TINT] = neutralPatchResponse(0, RENDER_TINT_GAIN, 0);

// ---------------------------------------------------------------------------
// Editorial thresholds
// ---------------------------------------------------------------------------

/**
 * How far a shot's exposure may sit from the anchor before
 * {@link solveExposureNormalize} touches it, in stops.
 *
 * A third of a stop. Below it the difference between two adjacent shots is
 * inside the noise of the measurement and of the eye, and a grade on every clip
 * when three were wrong is not the edit anybody asked for.
 */
export const EXPOSURE_OUTLIER_STOPS = 1 / 3;

/**
 * The most a white-balance move may swing skin hue, in degrees.
 *
 * Skin of every tone occupies a narrow hue band; a few degrees is where a face
 * stops reading as lit differently and starts reading as sunburnt or jaundiced.
 * Four degrees is a colourist's rule of thumb, not a measured threshold, and it
 * caps only the temperature/tint stage — the one move that swings hue outright.
 */
export const SKIN_MAX_HUE_SHIFT_DEGREES = 4;

/**
 * Below this coverage the skin reading is discarded rather than believed.
 *
 * Two percent of the frame. The qualifier selects skin-*coloured* pixels, so a
 * wooden desk in an empty room can produce a reading; under this fraction there
 * is not enough of anything to constrain a grade, and a cap derived from noise
 * would quietly refuse a correct move.
 */
export const SKIN_MIN_COVERAGE_RATIO = 0.02;

/**
 * Below this a parameter is dropped instead of emitted.
 *
 * An 8-bit code value is 1/255 of the range. A parameter this small moves no
 * pixel by a whole code value, so emitting it would put a number in the project
 * file that the render cannot reproduce and the user cannot see.
 */
const NEGLIGIBLE_PARAMETER = 5e-4;

/** Parameters are reported to four decimals: finer than the renderer resolves. */
const PARAMETER_ROUNDING = 1e4;

/** Guard for every ratio: a measurement this close to zero cannot be divided by. */
const MEASUREMENT_EPSILON = 1e-6;

/** Guard for the 2x2 solves: below this the system is degenerate and the axis is skipped. */
const DETERMINANT_EPSILON = 1e-9;

/** Bisection steps for the skin cap. Fixed so the result is reproducible to ~1e-7. */
const SKIN_CAP_BISECTION_STEPS = 24;

/** Pipeline order — the order parameters are applied, reported and clamped in. */
const PARAMETER_ORDER: readonly ProfessionalColorParameter[] = [
  'exposure',
  'temperature',
  'tint',
  'contrast',
  'shadows',
  'highlights',
  'saturation',
];

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const finite = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);

/** Divide, or return `fallback` when the denominator cannot carry a ratio. */
function ratio(numerator: number, denominator: number, fallback = 1): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return fallback;
  if (Math.abs(denominator) < MEASUREMENT_EPSILON) return fallback;
  return numerator / denominator;
}

/** Solve `[[a, b], [c, d]] x = [e, f]`, or `null` when the system is degenerate. */
function solve2x2(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): readonly [number, number] | null {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < DETERMINANT_EPSILON) return null;
  return [(e * d - b * f) / determinant, (a * f - e * c) / determinant];
}

/**
 * The chroma axis `warmth` discards: `(uMean + vMean - 256) / 128`, positive magenta.
 *
 * Warmth is the difference of the two chroma means; this is their sum. Together
 * they span the plane, which is what makes temperature and tint separable at all.
 */
function greenMagenta(measurement: ColorMeasurement): number {
  const { uMean, vMean } = measurement.chroma;
  return (
    (finite(uMean, CHROMA_NEUTRAL) + finite(vMean, CHROMA_NEUTRAL) - 2 * CHROMA_NEUTRAL) /
    CHROMA_HALF_RANGE
  );
}

/** Hue angle in degrees of a normalised RGB triple. Achromatic returns 0. */
function hueDegrees(red: number, green: number, blue: number): number {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const spread = max - min;
  if (spread < MEASUREMENT_EPSILON) return 0;
  let hue: number;
  if (max === red) hue = ((green - blue) / spread) % 6;
  else if (max === green) hue = (blue - red) / spread + 2;
  else hue = (red - green) / spread + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Signed shortest angular distance between two hues, in degrees. */
function hueDistance(from: number, to: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return Math.abs(delta);
}

// ---------------------------------------------------------------------------
// Clamping and assembly
// ---------------------------------------------------------------------------

interface RawGrade {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  shadows: number;
  highlights: number;
  saturation: number;
}

const zeroGrade = (): RawGrade => ({
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
});

interface ClampResult {
  readonly value: number;
  readonly hitBound: boolean;
}

/** Clamp one parameter to its contract, saying whether the contract bit. */
function clampToContract(name: ProfessionalColorParameter, value: number): ClampResult {
  const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
  const safe = finite(value);
  if (contract === undefined) return { value: safe, hitBound: false };
  if (safe < contract.min) return { value: contract.min, hitBound: true };
  if (safe > contract.max) return { value: contract.max, hitBound: true };
  return { value: safe, hitBound: false };
}

const round = (value: number): number =>
  Math.round(value * PARAMETER_ROUNDING) / PARAMETER_ROUNDING;

/**
 * Drop the axes that did not move and report the ones the contracts refused.
 *
 * Rounding happens last so that clamping is judged on the solved value: a
 * parameter is reported clamped because the contract refused it, never because
 * four decimals happened to land on a bound.
 */
function assemble(
  grade: RawGrade,
  clampedParameters: readonly ProfessionalColorParameter[],
  skinCapped: boolean,
): ColorSolution {
  const params: Record<string, number> = {};
  for (const name of PARAMETER_ORDER) {
    const value = round(grade[name]);
    if (Math.abs(value) >= NEGLIGIBLE_PARAMETER) params[name] = value;
  }
  return {
    params: params as ProfessionalColorAdjustments,
    clamped: clampedParameters.length > 0,
    clampedParameters,
    skinCapped,
  };
}

// ---------------------------------------------------------------------------
// The skin cap
// ---------------------------------------------------------------------------

/** Skin hue after a white-balance move, in the renderer's own arithmetic. */
function skinHueAfter(skin: SkinMeasurement, temperature: number, tint: number): number {
  return hueDegrees(
    skin.red * (1 + RENDER_TEMPERATURE_GAIN * temperature),
    skin.green * (1 + RENDER_TINT_GAIN * tint),
    skin.blue * (1 - RENDER_TEMPERATURE_GAIN * temperature),
  );
}

/**
 * How much of the solved white-balance move survives skin protection: 1 for all
 * of it, 0 for none.
 *
 * The cap scales temperature and tint **together**, so the direction of the
 * correction is preserved and only its magnitude gives way — a cap that moved
 * one axis and not the other would introduce a colour cast of its own while
 * claiming to protect against one.
 *
 * Found by bisection rather than inverted analytically because hue is a
 * piecewise function of which channel is largest, and the largest channel can
 * change mid-move. Fixed iteration count, so it is deterministic.
 */
function skinCapScale(
  skin: SkinMeasurement | undefined,
  temperature: number,
  tint: number,
): number {
  if (skin === undefined) return 1;
  if (skin.coverage !== undefined && skin.coverage < SKIN_MIN_COVERAGE_RATIO) return 1;
  const baseHue = hueDegrees(skin.red, skin.green, skin.blue);
  const shiftAt = (scale: number): number =>
    hueDistance(baseHue, skinHueAfter(skin, temperature * scale, tint * scale));
  if (shiftAt(1) <= SKIN_MAX_HUE_SHIFT_DEGREES) return 1;

  let low = 0;
  let high = 1;
  for (let step = 0; step < SKIN_CAP_BISECTION_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (shiftAt(mid) <= SKIN_MAX_HUE_SHIFT_DEGREES) low = mid;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------
// The match
// ---------------------------------------------------------------------------

/**
 * The grade that moves `target`'s measurements toward `reference`'s.
 *
 * Solved in the renderer's pipeline order, each stage against what the previous
 * stages left behind:
 *
 * 1. **exposure** from `log2(ref.mean / target.mean)`;
 * 2. **temperature/tint** as a 2x2 solve against the warmth and green/magenta
 *    residuals, evaluated at the post-exposure luma and net of the chroma scaling
 *    that exposure and contrast apply;
 * 3. **contrast** from the `contrastIdx` ratio after exposure;
 * 4. **shadows/highlights** as a 2x2 solve against the p10/p90 residuals after
 *    exposure and contrast, because each parameter touches both percentiles;
 * 5. **saturation** from the `satMean` ratio net of the exposure and contrast
 *    scaling.
 *
 * Every stage is clamped to {@link COLOR_GRADE_PARAMETER_CONTRACTS} *before* the
 * next stage predicts from it, so a match the contracts cannot reach degrades
 * into the closest one they can rather than into an incoherent one.
 *
 * @param target - Measurements of the footage the grade will be applied to.
 * @param reference - Measurements of the look to move toward.
 * @param options - Optional skin reading for {@link SKIN_MAX_HUE_SHIFT_DEGREES}.
 * @returns The parameters, plus whether the contracts or the skin cap made the
 *   match partial. Identical measurements return an empty parameter set.
 */
export function solveColorMatch(
  target: ColorMeasurement,
  reference: ColorMeasurement,
  options: ColorSolverOptions = {},
): ColorSolution {
  const grade = zeroGrade();
  const clampedParameters: ProfessionalColorParameter[] = [];
  const note = (name: ProfessionalColorParameter, result: ClampResult): number => {
    if (result.hitBound) clampedParameters.push(name);
    return result.value;
  };

  // 1) Exposure — the luma-mean ratio in stops, through the response.
  const targetMean = finite(target.luma.mean);
  const referenceMean = finite(reference.luma.mean);
  const meanRatio = ratio(referenceMean, targetMean);
  const exposureStops = meanRatio > MEASUREMENT_EPSILON ? Math.log2(meanRatio) : 0;
  grade.exposure = note(
    'exposure',
    clampToContract('exposure', ratio(exposureStops, EXPOSURE_RESPONSE, 0)),
  );
  /** What the render will really multiply by, given the clamp. */
  const exposureGain = 2 ** (grade.exposure * EXPOSURE_RESPONSE);

  // 3) Contrast, solved before white balance is *scaled* because the chroma the
  //    white balance produces is itself scaled by contrast further down the pipe.
  const targetContrastIdx = finite(target.contrastIdx);
  const referenceContrastIdx = finite(reference.contrastIdx);
  const contrastAfterExposure = targetContrastIdx * exposureGain;
  const contrastFactor = ratio(referenceContrastIdx, contrastAfterExposure);
  grade.contrast = note(
    'contrast',
    clampToContract('contrast', ratio(contrastFactor - 1, CONTRAST_RESPONSE, 0)),
  );
  const contrastGain = 1 + grade.contrast * CONTRAST_RESPONSE;

  // 2) White balance. Chroma reaches the measurement having been scaled by
  //    exposure and then by contrast, so the warmth the WB stage must produce is
  //    the reference's divided by the contrast gain, less what the source carries
  //    through exposure.
  const chromaCarry = contrastGain === 0 ? 0 : 1 / contrastGain;
  const warmthResidual =
    finite(reference.warmth) * chromaCarry - finite(target.warmth) * exposureGain;
  const greenMagentaResidual =
    greenMagenta(reference) * chromaCarry - greenMagenta(target) * exposureGain;
  // The white-balance response is proportional to the light it multiplies, which
  // after stage 1 is the exposed mean. Zero luma means zero response, and no
  // temperature value would produce the residual — the clamp then says so.
  const whiteBalanceLuma = clamp01(targetMean * exposureGain);
  const whiteBalance =
    whiteBalanceLuma < MEASUREMENT_EPSILON
      ? null
      : solve2x2(
          WARMTH_PER_TEMPERATURE * whiteBalanceLuma,
          WARMTH_PER_TINT * whiteBalanceLuma,
          GREEN_MAGENTA_PER_TEMPERATURE * whiteBalanceLuma,
          GREEN_MAGENTA_PER_TINT * whiteBalanceLuma,
          warmthResidual,
          greenMagentaResidual,
        );
  if (whiteBalance !== null) {
    grade.temperature = note('temperature', clampToContract('temperature', whiteBalance[0]));
    grade.tint = note('tint', clampToContract('tint', whiteBalance[1]));
  }
  const capScale = skinCapScale(options.skin, grade.temperature, grade.tint);
  grade.temperature *= capScale;
  grade.tint *= capScale;

  // 4) Shadows and highlights, from the percentile residual that survives 1 and 3.
  //    Both parameters move both percentiles, so this is one system, not two.
  const lowAfter = clamp01(
    (finite(target.luma.p10) * exposureGain - CONTRAST_PIVOT) * contrastGain + CONTRAST_PIVOT,
  );
  const highAfter = clamp01(
    (finite(target.luma.p90) * exposureGain - CONTRAST_PIVOT) * contrastGain + CONTRAST_PIVOT,
  );
  const zones = solve2x2(
    RENDER_ZONE_GAIN * (1 - lowAfter) ** 2,
    RENDER_ZONE_GAIN * lowAfter ** 2,
    RENDER_ZONE_GAIN * (1 - highAfter) ** 2,
    RENDER_ZONE_GAIN * highAfter ** 2,
    // The reference percentiles are clamped as well: a target above white or below
    // black is unreachable, and solving for it spends a parameter that the render
    // then throws away. This only ever bites on a synthetic look target — a real
    // measurement is already inside the range.
    clamp01(finite(reference.luma.p10)) - lowAfter,
    clamp01(finite(reference.luma.p90)) - highAfter,
  );
  if (zones !== null) {
    grade.shadows = note('shadows', clampToContract('shadows', zones[0]));
    grade.highlights = note('highlights', clampToContract('highlights', zones[1]));
  }

  // 5) Saturation. Shadows and highlights add the same offset to all three
  //    channels, which leaves absolute chroma alone, so only exposure and
  //    contrast have to be discounted here.
  const satAfter = finite(target.chroma.satMean) * exposureGain * contrastGain;
  const satFactor = ratio(finite(reference.chroma.satMean), satAfter);
  grade.saturation = note(
    'saturation',
    clampToContract('saturation', ratio(satFactor - 1, SATURATION_RESPONSE, 0)),
  );

  return assemble(grade, clampedParameters, capScale < 1);
}

// ---------------------------------------------------------------------------
// Exposure normalisation
// ---------------------------------------------------------------------------

/** One shot to consider for normalisation. */
export interface MeasuredShot {
  /** Whatever the caller keys grades by — a clip id, usually. */
  readonly id: string;
  readonly measurement: ColorMeasurement;
}

/**
 * What to normalise toward: the run's own median, or one named shot.
 *
 * Median by default because it is the choice that does not require the caller to
 * have already decided which shot is right.
 */
export type ExposureAnchor = 'median' | { readonly clipId: string };

/** A grade for one shot that sat outside the tolerance. */
export interface ExposureCorrection {
  readonly id: string;
  readonly params: ProfessionalColorAdjustments;
  readonly clamped: boolean;
  readonly clampedParameters: readonly ProfessionalColorParameter[];
  /** How far this shot sat from the anchor, in stops. Signed: negative is darker. */
  readonly deviationStops: number;
}

export interface ExposureNormalizeResult {
  /** The luma mean everything was measured against. */
  readonly anchorLumaMean: number;
  /** The shot the anchor came from, when it came from one. */
  readonly anchorId?: string;
  readonly corrections: readonly ExposureCorrection[];
  /** Shots left alone, and the whole point of the tolerance. */
  readonly untouchedIds: readonly string[];
}

/** The median of a list of numbers; even lengths take the mean of the middle pair. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Exposure-only grades for the shots that sit outside {@link EXPOSURE_OUTLIER_STOPS}
 * of the anchor, and nothing at all for the rest.
 *
 * Exposure only, deliberately: "normalize exposure" is a request to make the
 * brightness agree, and a full colour match on every outlier would change looks
 * the user did not ask about. A shot that needs more than exposure is a
 * `match_color` job.
 *
 * @param shots - The shots to consider. Order is preserved in the result.
 * @param anchor - The brightness to converge on. An unknown `clipId` falls back
 *   to the median rather than refusing, and the returned `anchorId` says which
 *   was used.
 * @returns The corrections and, explicitly, the ids left untouched.
 */
export function solveExposureNormalize(
  shots: readonly MeasuredShot[],
  anchor: ExposureAnchor = 'median',
): ExposureNormalizeResult {
  const usable = shots.filter((shot) => finite(shot.measurement.luma.mean) > MEASUREMENT_EPSILON);
  if (usable.length === 0) {
    return { anchorLumaMean: 0, corrections: [], untouchedIds: shots.map((shot) => shot.id) };
  }

  const named = anchor === 'median' ? undefined : usable.find((shot) => shot.id === anchor.clipId);
  const anchorLumaMean =
    named === undefined
      ? median(usable.map((shot) => finite(shot.measurement.luma.mean)))
      : finite(named.measurement.luma.mean);

  const corrections: ExposureCorrection[] = [];
  const untouchedIds: string[] = [];
  for (const shot of shots) {
    const mean = finite(shot.measurement.luma.mean);
    const meanRatio = ratio(anchorLumaMean, mean, Number.NaN);
    if (!Number.isFinite(meanRatio) || meanRatio <= MEASUREMENT_EPSILON) {
      untouchedIds.push(shot.id);
      continue;
    }
    const deviationStops = -Math.log2(meanRatio);
    if (Math.abs(deviationStops) <= EXPOSURE_OUTLIER_STOPS) {
      untouchedIds.push(shot.id);
      continue;
    }
    const clamp = clampToContract('exposure', ratio(Math.log2(meanRatio), EXPOSURE_RESPONSE, 0));
    const value = round(clamp.value);
    if (Math.abs(value) < NEGLIGIBLE_PARAMETER) {
      untouchedIds.push(shot.id);
      continue;
    }
    corrections.push({
      id: shot.id,
      params: { exposure: value },
      clamped: clamp.hitBound,
      clampedParameters: clamp.hitBound ? ['exposure'] : [],
      deviationStops: round(deviationStops),
    });
  }
  return {
    anchorLumaMean,
    ...(named === undefined ? {} : { anchorId: named.id }),
    corrections,
    untouchedIds,
  };
}

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export const LOOK_INTENTS = [
  'warmer',
  'cooler',
  'punchier',
  'flatter',
  'brighter',
  'darker',
  'cinematic',
  'clean',
] as const;
export type LookIntent = (typeof LOOK_INTENTS)[number];

export const LOOK_AMOUNTS = ['subtle', 'medium', 'strong'] as const;
export type LookAmount = (typeof LOOK_AMOUNTS)[number];

/**
 * How far each amount goes, as a multiplier on the medium step.
 *
 * One scalar rather than three tables so that `subtle < medium < strong` holds by
 * construction on every axis of every look, and cannot be broken by editing one
 * row. Additive deltas are multiplied by it; ratios are raised to it.
 */
const LOOK_AMOUNT_SCALE: Readonly<Record<LookAmount, number>> = {
  subtle: 0.5,
  medium: 1,
  strong: 1.75,
};

/**
 * A look, stated in FACT units before any parameter is involved.
 *
 * This is the whole point of the indirection: "warmer" is `+0.10` of measured
 * warmth, and the solver works out what temperature that costs on *this* footage.
 * Stating looks as parameter values instead would make "warmer" mean a different
 * amount of warmer on every clip, which is the behaviour VU3 exists to remove.
 */
interface LookDelta {
  /** Added to the measured luma mean, in stops. */
  readonly exposureStops?: number;
  /** Added to measured warmth, on the -1..1 scale. */
  readonly warmthDelta?: number;
  /** Multiplies the measured spread around the mean, and so `contrastIdx`. */
  readonly contrastRatio?: number;
  /** Multiplies measured `satMean`. */
  readonly satRatio?: number;
  /** Added to the measured p10 — a shadow lift the contrast ratio does not give. */
  readonly shadowLift?: number;
  /** Fraction of the existing colour cast removed. 1 is fully neutral. */
  readonly neutralize?: number;
}

/**
 * The medium step of each look.
 *
 * Two rules held throughout. Looks that touch both contrast and saturation move
 * saturation *further* than contrast, because contrast already scales chroma —
 * a punchier look whose satRatio merely matched its contrastRatio would come back
 * with a negative saturation, which is arithmetically true and editorially
 * absurd. And every number is a taste judgement about the fact scale, not a
 * measurement: they are the one part of this module the fit does not touch.
 */
const LOOK_DELTAS: Readonly<Record<LookIntent, LookDelta>> = {
  /** A visible push toward tungsten without moving the exposure. */
  warmer: { warmthDelta: 0.1 },
  cooler: { warmthDelta: -0.1 },
  /** More separation and more colour, with colour leading so the grade reads richer. */
  punchier: { contrastRatio: 1.15, satRatio: 1.25 },
  flatter: { contrastRatio: 1 / 1.15, satRatio: 1 / 1.25 },
  /** A third of a stop — the smallest step that reliably reads as a change. */
  brighter: { exposureStops: 0.35 },
  darker: { exposureStops: -0.35 },
  /**
   * Cool, lifted, restrained: the film convention is a slightly cool cast, blacks
   * that sit off the floor, and less saturation than the camera gave you.
   */
  cinematic: { warmthDelta: -0.05, satRatio: 0.9, contrastRatio: 1.1, shadowLift: 0.03 },
  /** Take the cast out and leave everything else where it is. */
  clean: { neutralize: 0.6 },
};

/**
 * Build the measurement the look asks for, so the same solver can hit it.
 *
 * The delta names one or two axes; every other fact is carried forward through
 * the transform the named axes *imply*, not held still. Exposure and contrast
 * both scale chroma in the renderer, so a "brighter" whose target warmth stayed
 * at the baseline number would be asking the solver to cool the shot back down —
 * a white-balance move nobody requested, inside a brightness look.
 */
function lookTarget(baseline: ColorMeasurement, delta: LookDelta, scale: number): ColorMeasurement {
  const gain = 2 ** ((delta.exposureStops ?? 0) * scale);
  const spread = (delta.contrastRatio ?? 1) ** scale;
  /** What exposure and contrast between them do to every chroma reading. */
  const chromaCarry = gain * spread;
  const neutralize = Math.min(1, (delta.neutralize ?? 0) * scale);
  const keep = 1 - neutralize;

  // Deliberately unclamped. A strong brighten asks for a p90 above 1.0, which no
  // frame can hold; clamping the TARGET here would hand the solver a contrast and
  // white-balance residual that is an artefact of the clamp rather than of the
  // look, and it would come back as a temperature move inside a brightness
  // request. The renderer clips on its own, and the clamp report is where that
  // gets said.
  const baseMean = finite(baseline.luma.mean);
  const mean = baseMean * gain;
  const p10 =
    mean + (finite(baseline.luma.p10) - baseMean) * gain * spread + (delta.shadowLift ?? 0) * scale;
  const p90 = mean + (finite(baseline.luma.p90) - baseMean) * gain * spread;

  const warmth = Math.max(
    -1,
    Math.min(1, finite(baseline.warmth) * chromaCarry * keep + (delta.warmthDelta ?? 0) * scale),
  );
  const gm = greenMagenta(baseline) * chromaCarry * keep;
  return {
    luma: { mean, p10, p90 },
    chroma: {
      // Invert `warmth = (v - u) / 128` and `gm = (u + v - 256) / 128` together.
      uMean: CHROMA_NEUTRAL + ((gm - warmth) * CHROMA_HALF_RANGE) / 2,
      vMean: CHROMA_NEUTRAL + ((gm + warmth) * CHROMA_HALF_RANGE) / 2,
      satMean: Math.max(
        0,
        finite(baseline.chroma.satMean) * chromaCarry * (delta.satRatio ?? 1) ** scale,
      ),
    },
    warmth,
    contrastIdx: p90 - p10,
  };
}

/**
 * The grade that gives `baseline` the named look, at the named strength.
 *
 * The look is expressed as a delta in fact units, converted into a synthetic
 * reference measurement, and then solved by {@link solveColorMatch} — so a look
 * and a match go through one inversion and cannot disagree about what a
 * parameter does. The consequence that matters: "warmer, medium" is the same
 * *measured* amount of warmer on dark footage and bright footage, and costs a
 * different `temperature` on each.
 *
 * @param intent - Which axis to move.
 * @param amount - How far, ordered `subtle < medium < strong` on every axis.
 * @param baseline - What the footage measures now.
 * @param options - Optional skin reading for the white-balance cap.
 * @returns The parameters, with the same clamping and skin-cap reporting as a match.
 */
export function solveLook(
  intent: LookIntent,
  amount: LookAmount,
  baseline: ColorMeasurement,
  options: ColorSolverOptions = {},
): ColorSolution {
  const scale = LOOK_AMOUNT_SCALE[amount];
  return solveColorMatch(baseline, lookTarget(baseline, LOOK_DELTAS[intent], scale), options);
}
