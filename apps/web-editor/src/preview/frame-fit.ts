/**
 * How the clip on screen actually meets the project frame (UX-14).
 *
 * The walkthrough put 4K landscape footage into a 9:16 sequence and the monitor
 * said nothing about it. The render FITS a clip into the frame —
 * `_place_video_clip` uses `min(target_w/w, target_h/h)`, which is *contain* — so
 * a landscape source in a portrait sequence ships with black bars unless the clip
 * carries a crop. That is a real, visible property of the export, decided the
 * moment the footage lands, and until now the only way to learn it was to export
 * and look.
 *
 * This says it in the monitor instead, in the two words an editor already uses:
 * **letterboxed** (bars top and bottom) or **pillarboxed** (bars at the sides).
 * It is an indication, not a correction: reframing is a crop the user or the
 * agent chooses, and silently covering the frame here would show pixels the
 * export drops — the same divergence `crop-fill.ts` exists to close.
 *
 * A crop counts. Cropping is exactly how a mismatched source is made to fill the
 * frame, so the aspect compared is the CROPPED region's, not the source file's —
 * otherwise a correctly reframed clip would still be accused of having bars.
 */
import type { CropRectLike } from './crop-fill.js';

/** Below this relative difference the two aspects are the same picture. */
const ASPECT_TOLERANCE = 0.01;

export type FrameFitKind = 'letterboxed' | 'pillarboxed';

export interface FrameFitNotice {
  readonly kind: FrameFitKind;
  /** Two words for the chip. */
  readonly label: string;
  /** The reason, for the tooltip: which shape is going into which. */
  readonly detail: string;
}

/** `16:9`, `9:16`, `1.85:1` — a ratio an editor reads, not a decimal. */
export function aspectLabel(width: number, height: number): string {
  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height));
  const w = Math.round(width) / divisor;
  const h = Math.round(height) / divisor;
  // Beyond this the reduced integers stop being recognisable (e.g. 4096:2160 →
  // 256:135); a decimal ratio reads better than two four-digit numbers.
  if (w > 40 || h > 40) return `${(width / height).toFixed(2)}:1`;
  return `${String(w)}:${String(h)}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.max(1, a) : greatestCommonDivisor(b, a % b);
}

/**
 * Describe how a source meets the frame, or `null` when it fills it exactly.
 *
 * @param source - The source's probed pixel dimensions (`asset.media`).
 * @param frame - The project resolution.
 * @param crop - The clip's crop rect in source fractions, when it has one.
 * @returns The notice to show, or `null` when there is nothing to say — an exact
 *   fit, or a source whose dimensions the engine has not probed (schema v21
 *   made them optional, and guessing at a shape would be worse than silence).
 */
export function describeFrameFit(
  source:
    | { readonly width?: number | null | undefined; readonly height?: number | null | undefined }
    | null
    | undefined,
  frame: { readonly width: number; readonly height: number },
  crop?: CropRectLike | null,
): FrameFitNotice | null {
  const sourceWidth = source?.width;
  const sourceHeight = source?.height;
  if (!sourceWidth || !sourceHeight || frame.width <= 0 || frame.height <= 0) return null;

  const croppedWidth = sourceWidth * (crop?.width ?? 1);
  const croppedHeight = sourceHeight * (crop?.height ?? 1);
  if (croppedWidth <= 0 || croppedHeight <= 0) return null;

  const sourceAspect = croppedWidth / croppedHeight;
  const frameAspect = frame.width / frame.height;
  if (Math.abs(sourceAspect - frameAspect) / frameAspect < ASPECT_TOLERANCE) return null;

  const sourceRatio = aspectLabel(croppedWidth, croppedHeight);
  const frameRatio = aspectLabel(frame.width, frame.height);
  const kind: FrameFitKind = sourceAspect > frameAspect ? 'letterboxed' : 'pillarboxed';
  return {
    kind,
    label: kind === 'letterboxed' ? 'Letterboxed' : 'Pillarboxed',
    detail:
      kind === 'letterboxed'
        ? `${sourceRatio} footage in a ${frameRatio} frame — the export has bars above and below. Crop the clip to fill it.`
        : `${sourceRatio} footage in a ${frameRatio} frame — the export has bars at the sides. Crop the clip to fill it.`,
  };
}
