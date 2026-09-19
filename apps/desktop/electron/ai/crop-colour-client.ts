/**
 * The engine's colour measurement of detection crops, for the colour re-ranker (AM2.7).
 *
 * `POST /masking/crop-colour` decodes each candidate's frame exactly as the export does and
 * reports, per box, the centre-weighted share of neutral pixels and their dominant CIELAB
 * lightness (`engine/python/framepilot_engine/masking/crop_colour.py`). The re-ranker combines
 * that with SigLIP (`colourRerankScores` in `@framepilot/ai-sdk`); this file only asks.
 *
 * It throws on anything but a well-formed answer of the right length — an unreachable engine, a
 * busy one (503), media outside the projects folder (400), a decode failure (422) — and the
 * re-ranker then scores with SigLIP alone, as before AM2.7. A wrong-length or malformed answer is
 * never partially used: a measurement matched to the wrong crop would be worse than none.
 */
import type { CropColourMeasurement, MaskCandidate } from '@framepilot/ai-sdk';

/** One crop to measure: the candidate's box on the frame shown at `timeSeconds`. */
export interface CropColourCrop {
  readonly timeSeconds: number;
  readonly box: MaskCandidate['box'];
}

export interface CropColourQuery {
  /** The asset's absolute media path; the engine refuses one outside the projects folder. */
  readonly absolutePath: string;
  readonly fps: number;
  readonly crops: readonly CropColourCrop[];
  readonly signal?: AbortSignal;
}

/** One measurement per crop, in order; `undefined` where a box was too small to measure. */
export type CropColourSource = (
  query: CropColourQuery,
) => Promise<readonly (CropColourMeasurement | undefined)[]>;

export interface EngineCropColourOptions {
  /** The render sidecar, e.g. `http://127.0.0.1:8799`. */
  readonly baseUrl: string;
  readonly fetchFn: typeof fetch;
  readonly timeoutMs?: number;
}

/** The engine decodes up to 64 frames under a 60 s deadline of its own; this is the host's. */
export const CROP_COLOUR_TIMEOUT_MS = 75_000;

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isLightness = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

function parseMeasurement(value: unknown): CropColourMeasurement | undefined {
  if (value === null) return undefined;
  const entry = value as { neutral_share?: unknown; neutral_lightness?: unknown } | undefined;
  if (typeof entry !== 'object' || entry === undefined) {
    throw new Error('The engine returned a malformed crop colour.');
  }
  if (!isUnit(entry.neutral_share) || !isLightness(entry.neutral_lightness)) {
    throw new Error('The engine returned a malformed crop colour.');
  }
  return { neutralShare: entry.neutral_share, neutralLightness: entry.neutral_lightness };
}

/**
 * A {@link CropColourSource} backed by the engine sidecar.
 *
 * @param options - Where the sidecar is and how to reach it.
 */
export function createEngineCropColourSource(options: EngineCropColourOptions): CropColourSource {
  return async (query) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? CROP_COLOUR_TIMEOUT_MS);
    const signal = query.signal === undefined ? timeout : AbortSignal.any([query.signal, timeout]);
    const response = await options.fetchFn(new URL('/masking/crop-colour', options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input_path: query.absolutePath,
        fps: query.fps,
        crops: query.crops.map((crop) => ({
          time_seconds: crop.timeSeconds,
          x: crop.box.x,
          y: crop.box.y,
          width: crop.box.width,
          height: crop.box.height,
        })),
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `The engine could not measure crop colours (HTTP ${String(response.status)}).`,
      );
    }
    const crops = ((await response.json()) as { crops?: unknown }).crops;
    if (!Array.isArray(crops) || crops.length !== query.crops.length) {
      throw new Error('The engine answered a different number of crop colours.');
    }
    return crops.map(parseMeasurement);
  };
}
