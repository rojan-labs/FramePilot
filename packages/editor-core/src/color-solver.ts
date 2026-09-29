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
 * ## What is derived, what is measured, and what is still open
 *
 * VU3.1 asks for per-parameter response curves fitted by rendering a grid of parameter
 * values and measuring each one. The model here is **derived analytically from the
 * renderer's source** (`engine/python/framepilot_engine/render/color.py`) and the
 * measurement chain that produces the facts
 * (`engine/python/framepilot_engine/analysis/shot_stats.py`), and two render-backed
 * measurements have now been taken against it.
 *
 * ### 2026-09-08 — `fit-color-response.mjs`, float RGB, `mission-montage`, three clips
 *
 * Tint agreed with the derivation to within 5%; `WARMTH_PER_TEMPERATURE` (then a
 * grey-patch constant, 0.6936 per unit `luma.mean`) measured 0.567/0.633/0.576, a
 * repeatable ~15% under-shoot. That script reconstructs warmth from RGB through the
 * matrix under test, so it could not say whether the matrix or the renderer was wrong.
 * The `*_RESPONSE` fits from it (exposure 0.76-0.96, contrast 0.79-0.96, saturation
 * 0.63-0.81) are in that script's own units and are superseded below.
 *
 * ### 2026-09-29 — settled (#107): the ledger's own chain, through the real export
 *
 * `engine/python/tests/color_response_measure.py` exports each grid cell through
 * `export_video` and measures the FILE with tier-0's own `signalstats` graph. Five
 * real clips (`bay-aerial`, `beach-sunset`, `driver-beanie`, `camp-coffee`,
 * `raw_skating`; luma.mean 0.30-0.45), 2 s each, 25 exports per clip:
 *
 * | per unit temperature, per unit luma.mean | bay | beach | driver | camp | skate |
 * | --- | --- | --- | --- | --- | --- |
 * | measured, ledger units | 0.566 | 0.577 | 0.503 | 0.567 | 0.611 |
 * | this module's channel-mean model | 0.569 | 0.587 | 0.512 | 0.569 | 0.610 |
 * | the old grey-patch constant | 0.694 | 0.694 | 0.694 | 0.694 | 0.694 |
 * | renderer curve efficiency (measured ÷ derived) | 0.994 | 0.983 | 0.983 | 0.997 | 1.002 |
 *
 * What that says:
 *
 *  - **The renderer's curve is not shallower.** Measured against the zero-parameter
 *    prediction in the export's own chain, temperature lands at 0.983-1.002 of the
 *    derivation and tint at 0.991-1.001; the shortfall is clipping, and small.
 *  - **The constant had the wrong shape, not just the wrong value.** Three things,
 *    none of them the renderer: the ledger is LIMITED-range BT.709 (a chroma unit is
 *    224 codes, not 255: ×0.878); `luma.mean` carries the 16-code floor, so it is not
 *    the light the white balance multiplies; and temperature multiplies red and blue,
 *    so a frame with little blue warms less per unit (driver-beanie, 0.503). Modelling
 *    those — {@link whiteBalanceResponse} — predicts every clip to within 2% with no
 *    fitted parameter, so the solver now uses the model and there is no constant left
 *    to paste a fit into. The old one over-stated the response by ~23% and so
 *    under-corrected warmth by ~18%.
 *  - **A pure white-balance move now lands.** `apply_look warmer` (+0.10 warmth) on the
 *    five clips, rendered and measured: the old solver delivered 0.070-0.083, this one
 *    0.094-0.097.
 *  - **Saturation had to move ahead of white balance.** Saturation scales every
 *    pixel's chroma, warmth included; solved after the white balance, a match that raised
 *    saturation by 0.37 overshot the reference warmth by 0.043. Matches toward
 *    `beach-sunset` (warmth 0.167) now land within 0.010-0.020 of it (old: 0.004-0.049,
 *    the 0.004 being two errors cancelling). What is left is clipping in the contrast
 *    and saturation carry.
 *
 * Still open, with the numbers the same run measured (tracked in a follow-up to #107):
 *
 * 1. **Luma is read as code/255, not light.** `EXPOSURE_RESPONSE` measures 0.73-0.82
 *    through `luma.mean` but 0.90-0.97 through light: most of the "clipping" the first
 *    fit saw is the 16-code floor. The exposure, contrast-pivot and zone solves still
 *    read `luma.mean` as light.
 * 2. **Clipping is material-dependent.** `CONTRAST_RESPONSE` measures 0.64-0.99 and
 *    `SATURATION_RESPONSE` 1.03-1.16; all three stay at 1.0 until there is a per-shot
 *    model.
 * 3. **White balance's effect on `satMean`.** The saturation solve ignores it, and it is
 *    large: ±0.5 temperature moves `satMean` by up to 3.8× on a near-neutral frame, and
 *    the three renders above over-shoot the reference `satMean` by 19-38%. It is a
 *    mean of magnitudes, so the means the ledger keeps cannot predict it exactly.
 * 4. **The export chain.** Exports encode BT.709 limited range and carry the tags
 *    (#154); the pure-red probe reads Y/U/V 61.9/103.0/238.8 against 63/102/240, the
 *    ~1 code left being the bundled ffmpeg's decode. Before #154 they were BT.601 and
 *    untagged (81/90/239), so tier-0 facts of an EXPORTED file sat in another chain
 *    from those of its sources. The solve never read exports — it reads sources and the
 *    float composite — so no figure above changed.
 *
 * So: a solved white balance is now **calibrated against the render**; the tonal stages
 * are still directionally right and approximately scaled. Quote only what the table
 * above measured.
 *
 * ## The model, stage by stage
 *
 * The renderer's pipeline order is fixed:
 * exposure → white balance → contrast → shadows/highlights → saturation.
 *
 * | Parameter    | Effect on the pixels                         | Effect on the facts                          |
 * | ------------ | -------------------------------------------- | -------------------------------------------- |
 * | `exposure`   | `rgb *= 2**e`                                | luma and chroma both scale by `2**e`         |
 * | `temperature`| `R *= 1+0.3t`, `B *= 1-0.3t`                 | warmth moves by the red and blue it scales   |
 * | `tint`       | `G *= 1+0.3t`                                | green/magenta moves; warmth barely           |
 * | `contrast`   | `(rgb-0.5)*(1+c)+0.5`                        | luma spread and chroma both scale by `1+c`   |
 * | `shadows`    | `+0.5*s*(1-lum)**2`                          | lifts the low percentile                     |
 * | `highlights` | `+0.5*h*lum**2`                              | lifts the high percentile                    |
 * | `saturation` | `lum + (rgb-lum)*(1+s)`                      | `satMean` AND warmth scale by `1+s`          |
 *
 * Consequences that are easy to get wrong and that the solver handles: exposure,
 * contrast and saturation **all scale chroma**, so contrast and saturation are solved
 * first and the white-balance move is solved against what survives all three; and
 * shadows and highlights **both** touch **both** percentiles, so they are solved as one
 * 2x2 system rather than one at a time.
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

/** BT.709 Cb/Cr divisors: `2 * (1 - Kb)` and `2 * (1 - Kr)`. */
const BT709_CB_DIVISOR = 1.8556;
const BT709_CR_DIVISOR = 1.5748;

/**
 * The ledger's encoding: BT.709, LIMITED range (#107).
 *
 * Tier-0 reads the raw planes of the source file, and camera footage is tagged
 * `tv`/`bt709`: luma codes run 16..235 and chroma codes 128 ± 112. So `luma.mean` is
 * `(16 + 219 * light) / 255`, not `light`, and one unit of chroma difference is 224
 * codes, not 255. `picture-facts.ts` writes a rendered (float RGB) reading into these
 * same units through {@link ledgerMeasurementFromLight}, so the two provenances agree.
 *
 * The derivation this module shipped with assumed FULL range, and that — not the
 * renderer — is most of the "~15% under-shoot" #107 tracked; see the module docstring.
 */
const LEDGER_LUMA_FLOOR = 16;
const LEDGER_LUMA_SPAN = 219;
const LEDGER_CHROMA_SPAN = 224;
/** Tier-0 normalises luma codes by 255 (`_LUMA_FULL` in `shot_stats.py`). */
const LEDGER_CODE_SCALE = 255;

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
 * What a change in the three channel MEANS does to the two chroma facts, in the
 * ledger's units (#107).
 *
 * DERIVED, and since 2026-09-29 MEASURED: the renderer's channel arithmetic
 * (`R *= 1 + 0.3t`, `G *= 1 + 0.3·tint`, `B *= 1 - 0.3t`) is linear in each channel,
 * so its effect on a frame's mean chroma is exactly its effect on the frame's mean
 * R/G/B, pushed through limited-range BT.709 into signalstats' U/V codes.
 * `engine/python/tests/color_response_measure.py` renders that through the real export
 * and measures it with tier-0's own filter graph; see the module docstring for the
 * numbers.
 *
 * @param deltaRed - Change in the mean red channel, in normalised light.
 * @param deltaGreen - Change in mean green.
 * @param deltaBlue - Change in mean blue.
 * @returns `[warmth, greenMagenta]` moved, in the ledger's -1..1 fact units.
 */
function chromaResponse(
  deltaRed: number,
  deltaGreen: number,
  deltaBlue: number,
): readonly [number, number] {
  const deltaLuma = REC709_RED * deltaRed + REC709_GREEN * deltaGreen + REC709_BLUE * deltaBlue;
  const deltaCr = (deltaRed - deltaLuma) / BT709_CR_DIVISOR;
  const deltaCb = (deltaBlue - deltaLuma) / BT709_CB_DIVISOR;
  const scale = LEDGER_CHROMA_SPAN / CHROMA_HALF_RANGE;
  return [scale * (deltaCr - deltaCb), scale * (deltaCr + deltaCb)];
}

/**
 * Normalised light behind a ledger luma fact: `(Y - 16) / 219`, clamped to 0..1.
 *
 * Clamped rather than trusted below the floor: a full-range still can read under 16,
 * and a negative light would flip the sign of every multiplicative response.
 */
function lightFromLedgerLuma(lumaFact: number): number {
  return clamp01((finite(lumaFact) * LEDGER_CODE_SCALE - LEDGER_LUMA_FLOOR) / LEDGER_LUMA_SPAN);
}

/** The ledger luma fact normalised light writes: the inverse of {@link lightFromLedgerLuma}. */
function ledgerLumaFromLight(light: number): number {
  return (LEDGER_LUMA_FLOOR + LEDGER_LUMA_SPAN * light) / LEDGER_CODE_SCALE;
}

/**
 * The mean R'G'B' (normalised light) behind a measurement.
 *
 * Exact for means: the BT.709 transform is linear, so the mean of the planes is the
 * transform of the mean channels. Each is clamped to 0..1 because out-of-gamut
 * averages cannot be multiplied back by a renderer that clamps.
 */
function channelMeans(measurement: ColorMeasurement): readonly [number, number, number] {
  const light = lightFromLedgerLuma(measurement.luma.mean);
  const cb =
    (finite(measurement.chroma.uMean, CHROMA_NEUTRAL) - CHROMA_NEUTRAL) / LEDGER_CHROMA_SPAN;
  const cr =
    (finite(measurement.chroma.vMean, CHROMA_NEUTRAL) - CHROMA_NEUTRAL) / LEDGER_CHROMA_SPAN;
  const red = light + BT709_CR_DIVISOR * cr;
  const blue = light + BT709_CB_DIVISOR * cb;
  const green = (light - REC709_RED * red - REC709_BLUE * blue) / REC709_GREEN;
  return [clamp01(red), clamp01(green), clamp01(blue)];
}

/**
 * The white-balance 2x2 for one frame: what one unit of `temperature` and of `tint`
 * move warmth and green/magenta, given the channel means they will multiply.
 *
 * This replaces the old `WARMTH_PER_TEMPERATURE × luma` model. That model treated the
 * frame as a grey patch whose light equalled `luma.mean`; both halves were wrong for the
 * ledger's facts. Temperature multiplies RED and BLUE, so a frame with little blue has
 * little blue to take away and warms less per unit — the material dependence the first fit
 * saw as scatter — and `luma.mean` carries the limited-range floor, so it is not the light.
 * On a neutral grey of light `L` this reduces to `0.6092·L` warmth and `-0.0361·L`
 * green/magenta per unit temperature, and `-0.0361·L` / `-0.4408·L` per unit tint: the
 * old full-range derivation's 0.6936 / -0.0411 / -0.0411 / -0.5018 times 224/255.
 *
 * @returns `[[warmthPerTemperature, warmthPerTint], [gmPerTemperature, gmPerTint]]`,
 *   or `null` when the frame is black and no white balance moves it.
 */
function whiteBalanceResponse(
  channels: readonly [number, number, number],
): readonly [readonly [number, number], readonly [number, number]] | null {
  const [red, green, blue] = channels;
  if (Math.max(red, green, blue) < MEASUREMENT_EPSILON) return null;
  const [warmthPerTemperature, gmPerTemperature] = chromaResponse(
    RENDER_TEMPERATURE_GAIN * red,
    0,
    -RENDER_TEMPERATURE_GAIN * blue,
  );
  const [warmthPerTint, gmPerTint] = chromaResponse(0, RENDER_TINT_GAIN * green, 0);
  return [
    [warmthPerTemperature, warmthPerTint],
    [gmPerTemperature, gmPerTint],
  ];
}

/** A rendered (float RGB) reading, as `measure_color`'s evidence route reports it. */
export interface LightReading {
  /** Rec.709 luma of the float frame, 0..1: mean and 10th/90th percentiles. */
  readonly lumaMean: number;
  readonly lumaP10: number;
  readonly lumaP90: number;
  /** Channel means, 0..1. */
  readonly red: number;
  readonly blue: number;
  readonly satMean: number;
}

/**
 * Write a float-RGB reading into the ledger's units, so a rendered measurement and a
 * tier-0 one can sit on the two sides of one match.
 *
 * Before #107 the rendered side was written in FULL-range units and the ledger side is
 * limited-range, so a mixed match compared warmth on scales 255/224 apart and luma with
 * and without the 16-code floor. `satMean` is carried unchanged: it is only ever read as
 * a ratio against the same provenance.
 */
export function ledgerMeasurementFromLight(reading: LightReading): ColorMeasurement {
  const light = finite(reading.lumaMean);
  const uMean =
    CHROMA_NEUTRAL + (LEDGER_CHROMA_SPAN * (finite(reading.blue) - light)) / BT709_CB_DIVISOR;
  const vMean =
    CHROMA_NEUTRAL + (LEDGER_CHROMA_SPAN * (finite(reading.red) - light)) / BT709_CR_DIVISOR;
  const p10 = ledgerLumaFromLight(finite(reading.lumaP10));
  const p90 = ledgerLumaFromLight(finite(reading.lumaP90));
  return {
    luma: { mean: ledgerLumaFromLight(light), p10, p90 },
    chroma: { uMean, vMean, satMean: finite(reading.satMean) },
    warmth: Math.max(-1, Math.min(1, (vMean - uMean) / CHROMA_HALF_RANGE)),
    contrastIdx: p90 - p10,
  };
}

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
 * Each stage is solved against what the stages before it in the RENDERER leave
 * behind; the chroma-scaling stages are solved first so the white balance can be
 * solved net of them (numbers are the renderer's stage order):
 *
 * 1. **exposure** from `log2(ref.mean / target.mean)`;
 * 3. **contrast** from the `contrastIdx` ratio after exposure;
 * 5. **saturation** from the `satMean` ratio net of the exposure and contrast
 *    scaling;
 * 2. **temperature/tint** as a 2x2 solve against the warmth and green/magenta
 *    residuals, evaluated at the post-exposure channel means and net of the chroma
 *    scaling that exposure, contrast and saturation apply;
 * 4. **shadows/highlights** as a 2x2 solve against the p10/p90 residuals after
 *    exposure and contrast, because each parameter touches both percentiles.
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

  // 5) Saturation, solved before white balance for the same reason as contrast:
  //    `lum + (rgb - lum) * (1 + s)` scales every pixel's chroma, so it scales warmth
  //    too. Solved after, as it was until #107, a match that raised saturation by a
  //    third raised the cast the white balance had just set by a third as well —
  //    render-measured on `bay-aerial` → `beach-sunset`, +0.043 warmth past the
  //    reference. Shadows and highlights add the same offset to all three channels,
  //    which leaves absolute chroma alone, so only exposure and contrast are
  //    discounted here. What this still ignores is the reverse coupling, white
  //    balance's effect on `satMean` (see the module docstring).
  const satAfter = finite(target.chroma.satMean) * exposureGain * contrastGain;
  const satFactor = ratio(finite(reference.chroma.satMean), satAfter);
  grade.saturation = note(
    'saturation',
    clampToContract('saturation', ratio(satFactor - 1, SATURATION_RESPONSE, 0)),
  );
  const saturationGain = 1 + grade.saturation * SATURATION_RESPONSE;

  // 2) White balance. Chroma reaches the measurement having been scaled by
  //    exposure, then by contrast, then by saturation, so the warmth the WB stage
  //    must produce is the reference's divided by both gains, less what the source
  //    carries through exposure.
  // `ratio`, not a bare `=== 0` guard: every other divisor in this module goes through
  // MEASUREMENT_EPSILON, and this one guarded only EXACT zero. A contrast solve landing a
  // hair above zero produced a vast carry that drove the 2x2 white-balance solve to absurd
  // temperature and tint before the contract clamp caught it. Reachable depends on
  // CONTRAST_RESPONSE, which is no longer certain to be 1.0 now that it is measurable.
  const chromaCarry = ratio(1, contrastGain * saturationGain, 0);
  const warmthResidual =
    finite(reference.warmth) * chromaCarry - finite(target.warmth) * exposureGain;
  const greenMagentaResidual =
    greenMagenta(reference) * chromaCarry - greenMagenta(target) * exposureGain;
  // The white-balance response is proportional to the channels it multiplies, which
  // after stage 1 are the exposed channel means. A black frame has no response, and no
  // temperature value would produce the residual — the clamp then says so.
  const [red, green, blue] = channelMeans(target);
  const response = whiteBalanceResponse([
    clamp01(red * exposureGain),
    clamp01(green * exposureGain),
    clamp01(blue * exposureGain),
  ]);
  const whiteBalance =
    response === null
      ? null
      : solve2x2(
          response[0][0],
          response[0][1],
          response[1][0],
          response[1][1],
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
  const satRatio = (delta.satRatio ?? 1) ** scale;
  /** What exposure and contrast between them do to every chroma reading. */
  const chromaCarry = gain * spread;
  /**
   * What the cast carries: saturation scales every pixel's chroma, so a punchier look
   * deepens the cast with it. Leaving it out asked the solver — which now discounts
   * saturation from the white-balance residual (#107) — to take a fifth of the cast
   * out of a "punchier", a white-balance move nobody requested.
   */
  const castCarry = chromaCarry * satRatio;
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
    Math.min(1, finite(baseline.warmth) * castCarry * keep + (delta.warmthDelta ?? 0) * scale),
  );
  const gm = greenMagenta(baseline) * castCarry * keep;
  return {
    luma: { mean, p10, p90 },
    chroma: {
      // Invert `warmth = (v - u) / 128` and `gm = (u + v - 256) / 128` together.
      uMean: CHROMA_NEUTRAL + ((gm - warmth) * CHROMA_HALF_RANGE) / 2,
      vMean: CHROMA_NEUTRAL + ((gm + warmth) * CHROMA_HALF_RANGE) / 2,
      satMean: Math.max(0, finite(baseline.chroma.satMean) * chromaCarry * satRatio),
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
