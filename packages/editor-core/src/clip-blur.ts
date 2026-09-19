/**
 * The clip `blur` picture effect: a Gaussian blur a clip mask can limit (plan 10, MK5).
 *
 * Mirrors `engine/python/framepilot_engine/render/clip_blur.py`; the preview compositor and the
 * export must read `params.amount` the same way, so both clamp here and there identically.
 *
 * WHY a clip effect and not an adjustment lane: a lane's masks are fixed to the frame and cannot
 * follow a track, and a face blur that slides off the face is a privacy failure. On the clip the
 * clip's own mask stack (tracked, keyframed, matte) limits it, like a grade.
 *
 * WHY a fraction, not pixels: the export decodes a clip at its native size or straight to its
 * placed size, and the preview mirrors whichever it was. `amount` is the radius as a fraction of
 * the smaller side of the picture the effect runs on, so the look is the same on both and at
 * every export resolution.
 */
import type { Effect } from '@framepilot/timeline-schema';

/** The effect type a clip stores. */
export const CLIP_BLUR_EFFECT_TYPE = 'blur';

/** The strongest blur a clip may carry: a quarter of the smaller side already erases a face. */
export const MAX_CLIP_BLUR_AMOUNT = 0.25;

/**
 * The amount a new blur starts at, and the one the AI's `blur_to_hide` uses: 4% of the smaller
 * side (about 43 px at 1080p), enough that a face or a plate no longer reads.
 */
export const DEFAULT_CLIP_BLUR_AMOUNT = 0.04;

/** The id the Inspector and the AI give a clip's blur, so both edit the same one. */
export function clipBlurEffectId(clipId: string): string {
  return `${clipId}__blur`;
}

/**
 * The effect's `amount`, clamped to `[0, MAX_CLIP_BLUR_AMOUNT]`; 0 when missing or malformed.
 *
 * @param params - The effect's params.
 * @returns The amount the renderers use.
 */
export function clipBlurAmount(params: Readonly<Record<string, unknown>>): number {
  const raw = params.amount;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(MAX_CLIP_BLUR_AMOUNT, Math.max(0, raw));
}

/**
 * The Gaussian radius in pixels for a picture of `width` x `height`.
 *
 * @param params - The effect's params.
 * @param width - Width of the picture the effect runs on.
 * @param height - Its height.
 * @returns Pillow's `GaussianBlur` radius.
 */
export function clipBlurRadius(
  params: Readonly<Record<string, unknown>>,
  width: number,
  height: number,
): number {
  return clipBlurAmount(params) * Math.min(width, height);
}

/** A new clip blur at `amount` (default {@link DEFAULT_CLIP_BLUR_AMOUNT}). */
export function clipBlurEffect(clipId: string, amount = DEFAULT_CLIP_BLUR_AMOUNT): Effect {
  return {
    id: clipBlurEffectId(clipId),
    type: CLIP_BLUR_EFFECT_TYPE,
    params: { amount },
    keyframes: [],
  };
}
