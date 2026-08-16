/** Strict host-produced color measurement consumed by the professional color controller. */
import { z } from 'zod/v4';

const finite = z.number().finite();
const unit = finite.min(0).max(1);

export const ColorMeasurementSampleSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    channel: z.enum([
      'luma',
      'red',
      'green',
      'blue',
      'saturation',
      'skin_red',
      'skin_green',
      'skin_blue',
    ]),
    min: finite,
    max: finite,
    // Optional from here down: a skin channel over a frame with no qualifying
    // pixels has nothing to report, and reporting zeros would read as a black,
    // desaturated shot rather than as the absence of a measurement.
    mean: finite.optional(),
    p10: finite.optional(),
    p50: finite.optional(),
    p90: finite.optional(),
    nearBlackRatio: unit.optional(),
    nearWhiteRatio: unit.optional(),
    /** How much of the frame this reading covers. Only the skin channels set it. */
    coverageRatio: unit.optional(),
  })
  .strict();

export const ColorMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectRevision: z.number().int().nonnegative(),
    clipId: z.string().trim().min(1),
    trackId: z.string().trim().min(1),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
    isolation: z.literal('timeline_composite'),
    occlusionFree: z.boolean(),
    samples: z.array(ColorMeasurementSampleSchema).min(1),
    renderSettingsIdentity: z.string().trim().min(1),
  })
  .strict()
  .refine((value) => value.endFrame > value.startFrame, {
    path: ['endFrame'],
    message: 'Color measurement requires endFrame > startFrame.',
  })
  // Completeness is per channel, not a sample count. A count floor stood in for
  // "five channels over three representative frames", and then rejected a clip too
  // short to yield three frames with "lacks complete color statistics" — which
  // names the wrong problem, since one frame of a one-frame shot is a complete
  // reading of it. What matching actually needs is every whole-frame channel
  // present with its distribution; the skin channels are optional because a shot
  // with no skin in it legitimately has none.
  .refine(
    (value) =>
      (['luma', 'red', 'green', 'blue', 'saturation'] as const).every((channel) =>
        value.samples.some(
          (sample) =>
            sample.channel === channel &&
            sample.mean !== undefined &&
            sample.p10 !== undefined &&
            sample.p50 !== undefined &&
            sample.p90 !== undefined,
        ),
      ),
    {
      path: ['samples'],
      message:
        'Color measurement needs luma, red, green, blue, and saturation, each with its ' +
        'mean and tonal percentiles.',
    },
  );

export type ColorMeasurement = z.infer<typeof ColorMeasurementSchema>;

export interface ColorEvidenceEntry {
  readonly source: string;
  readonly data: unknown;
}

export interface ColorEvidenceReader {
  byHandle(id: string): ColorEvidenceEntry | undefined;
}
