/**
 * The measured colour of a detection crop, as a class (AM2.7; plan 11 target resolution).
 *
 * SigLIP cannot tell white, grey, silver and black apart reliably (AM2.6: on real weights every
 * flat silver crop read as white or grey, and only 15 of 43 neutral-colour targets resolved).
 * A measurement can: the engine (`engine/python/framepilot_engine/masking/crop_colour.py`,
 * `POST /masking/crop-colour`) decodes the frame exactly as the export does, weights the box
 * towards its centre so the background in its corners does not count, and reports in CIELAB
 * how much of the object is neutral (`neutralShare`, pixels with C* < 16) and the object's
 * dominant neutral lightness (`neutralLightness`, L*). This module turns those two numbers into
 * a class with explicit, frozen thresholds; `colour-rerank.ts` combines the class with SigLIP.
 *
 * **Dead bands, not boundaries.** Between two classes there is a band where the crop is neither:
 * a crop in it blocks both colours — "the white car" never picks a car that might be silver, and
 * never picks a white car while a might-be-white one is on screen. A crop that is partly neutral
 * (`mixed`) or was not measured blocks every neutral colour.
 *
 * **Fitted, then frozen.** Each pair of neighbouring classes was fitted on calibration crops
 * (generated seeds 20260919 and 7, plus three real crops from a fixture clip): the band is the
 * middle half of the gap between the darker class's highest value and the lighter class's lowest.
 * The numbers were then frozen and checked once on a held-out set generated with a new seed
 * (424242). `workers/visual-embed/tools/colour_rerank_eval.py fit` recomputes the fit from the
 * committed measurements, and `colour-measure.test.ts` fails if these constants drift from it.
 *
 * **What silver means here.** The test crops are flat renderings with no metallic sheen, so the
 * only thing that separates a silver object from a grey one in them is lightness, and "silver" is
 * the lighter grey (as the named colours define it: CSS silver is L* 78, grey L* 54). A real
 * silver car in shadow can measure grey; that crop then asks or is refused by SigLIP's check, but
 * no real silver object was available to measure, so real-footage silver is unmeasured.
 */

/** One crop's colour as the engine measured it; `null` lightness means no neutral pixel. */
export interface CropColourMeasurement {
  /** Centre-weighted share of the crop's pixels with CIELAB chroma below 16, in 0..1. */
  readonly neutralShare: number;
  /** The dominant L* (0..100) of those neutral pixels, or `null` when there are none. */
  readonly neutralLightness: number | null;
}

/** The neutral colour words, darkest first: the scale lightness classes lie on. */
export const NEUTRAL_SCALE = ['black', 'grey', 'silver', 'white'] as const;
export type NeutralColour = (typeof NEUTRAL_SCALE)[number];

/** A band between two neighbouring neutral classes: the crop could be either. */
export type NeutralBand = 'black|grey' | 'grey|silver' | 'silver|white';

/** What a measurement says a crop is. */
export type MeasuredColour = 'chromatic' | 'mixed' | 'unmeasured' | NeutralColour | NeutralBand;

/** Frozen thresholds (AM2.7): fitted on the calibration crops, see the module notes. */
export const COLOUR_MEASURE_THRESHOLDS = {
  /** At or below this neutral share the crop is a chromatic colour. */
  chromaticMaxShare: 0.5,
  /** At or above this neutral share the crop is a neutral colour; between the two, `mixed`. */
  neutralMinShare: 0.72,
  /**
   * Neighbouring neutral classes: at or below `darkMax` the crop is `dark`; at or above
   * `lightMin` it is the next class (or, above the last, white); between, the band.
   */
  lightness: [
    { dark: 'black', darkMax: 21.6, lightMin: 39.3 },
    { dark: 'grey', darkMax: 55.1, lightMin: 65.4 },
    { dark: 'silver', darkMax: 77.7, lightMin: 83.8 },
  ],
} as const satisfies {
  readonly chromaticMaxShare: number;
  readonly neutralMinShare: number;
  readonly lightness: readonly {
    readonly dark: Exclude<NeutralColour, 'white'>;
    readonly darkMax: number;
    readonly lightMin: number;
  }[];
};

const isFiniteIn = (value: number, low: number, high: number): boolean =>
  Number.isFinite(value) && value >= low && value <= high;

/**
 * Classify one measurement with the frozen thresholds.
 *
 * @param measurement - The engine's measurement, or `undefined` when the crop was not measured.
 * @returns The crop's measured colour class.
 */
export function measuredColour(measurement: CropColourMeasurement | undefined): MeasuredColour {
  if (measurement === undefined || !isFiniteIn(measurement.neutralShare, 0, 1)) {
    return 'unmeasured';
  }
  const { chromaticMaxShare, neutralMinShare, lightness } = COLOUR_MEASURE_THRESHOLDS;
  if (measurement.neutralShare <= chromaticMaxShare) return 'chromatic';
  const tone = measurement.neutralLightness;
  if (measurement.neutralShare < neutralMinShare || tone === null) return 'mixed';
  if (!isFiniteIn(tone, 0, 100)) return 'unmeasured';
  for (const [index, band] of lightness.entries()) {
    if (tone <= band.darkMax) return band.dark;
    if (tone < band.lightMin) {
      return `${band.dark}|${NEUTRAL_SCALE[index + 1]!}` as NeutralBand;
    }
  }
  return 'white';
}

/** Whether a crop of this class might be `colour`, so another crop cannot be picked as it. */
function mightBe(measured: MeasuredColour, colour: NeutralColour): boolean {
  if (measured === 'mixed' || measured === 'unmeasured') return true;
  return measured.includes('|') && measured.split('|').includes(colour);
}

/**
 * The one crop the measurement says is `colour`, or `undefined` when it cannot say: none or
 * several are that colour, or some crop might be (a band touching it, `mixed`, `unmeasured`).
 *
 * @param colour - A neutral colour word.
 * @param classes - Each candidate's {@link measuredColour}, in candidate order.
 */
export function measuredNeutralPick(
  colour: NeutralColour,
  classes: readonly MeasuredColour[],
): number | undefined {
  if (classes.some((measured) => mightBe(measured, colour))) return undefined;
  const matches = classes.flatMap((measured, index) => (measured === colour ? [index] : []));
  return matches.length === 1 ? matches[0] : undefined;
}
