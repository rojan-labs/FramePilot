/**
 * Intent → number tables for AI masks (AM1.3).
 *
 * The model states an intent ("soft edge", "a bit looser", "darken it"); these tables pick the
 * numbers (plan 11: "the model states intent; the solver picks numbers"). They are data, not
 * judgement: one row per intent, scaled by the picture so a 4K clip and a 720p clip get the
 * same LOOK rather than the same pixel count.
 *
 * What is deliberately NOT here: `blur_to_hide` and `grade_match_to` resolve to a typed
 * refusal, because the engine has no renderer for them on a clip mask yet. A clip's picture
 * effects are `color_grade` and `lut` (`render/frame_plan.py#picture_effects`); blur exists only
 * as an adjustment-lane effect, whose masks are frame-space and cannot follow a track. A face
 * blur that slides off the face is a privacy failure, so the honest answer is a refusal with
 * the remedy, not an approximate edit (PRD §23: no AI capability ahead of its engine).
 */
import type { DisplaySize } from '@framepilot/editor-core';

/** How soft the mask edge is. The model never supplies pixels. */
export const MASK_EDGE_INTENTS = ['exact', 'soft', 'very_soft'] as const;
export type MaskEdgeIntent = (typeof MASK_EDGE_INTENTS)[number];

/** A relative size adjustment. */
export const MASK_GROW_INTENTS = ['tighter', 'looser'] as const;
export type MaskGrowIntent = (typeof MASK_GROW_INTENTS)[number];

/** What the mask is for; decides what it targets and whether it is inverted. */
export const MASK_PURPOSES = ['cutout', 'hide', 'effect'] as const;
export type MaskPurpose = (typeof MASK_PURPOSES)[number];

/** Effects a mask can limit, by what the editor wants to happen inside it. */
export const MASK_EFFECT_INTENTS = [
  'brighten',
  'darken',
  'desaturate',
  'blur_to_hide',
  'grade_match_to',
] as const;
export type MaskEffectIntent = (typeof MASK_EFFECT_INTENTS)[number];

/** Outer feather as a fraction of the picture's smaller side, per edge intent. */
const EDGE_FEATHER_FRACTION: Readonly<Record<MaskEdgeIntent, number>> = {
  exact: 0,
  soft: 0.01,
  very_soft: 0.03,
};

/** One `tighter`/`looser` step, as a fraction of the picture's smaller side. */
const GROW_STEP_FRACTION = 0.01;

/**
 * Margin a `hide` shape mask grows by, fraction of the smaller side: a detector's box ends at
 * the hairline and the jaw, and "hide the face" means nothing of it shows.
 */
const HIDE_MARGIN_FRACTION = 0.015;

const smallerSide = (size: DisplaySize): number => Math.min(size.width, size.height);

/** Shape-mask edge numbers for an intent on a picture of `size`. */
export function shapeEdgeFor(
  edge: MaskEdgeIntent,
  size: DisplaySize,
): { readonly featherOuterPx: number } {
  return { featherOuterPx: EDGE_FEATHER_FRACTION[edge] * smallerSide(size) };
}

/**
 * Matte edge numbers for an intent. The delivered matte is already the precise one, so `exact`
 * is the pack's sharp edge and softness is added as finesse blur, never by re-running.
 */
export function matteEdgeFor(
  edge: MaskEdgeIntent,
  size: DisplaySize,
): { readonly edgeMode: 'sharp' | 'smooth'; readonly blurPx: number } {
  if (edge === 'exact') return { edgeMode: 'sharp', blurPx: 0 };
  return {
    edgeMode: 'smooth',
    blurPx: edge === 'very_soft' ? EDGE_FEATHER_FRACTION.very_soft * smallerSide(size) : 0,
  };
}

/** Signed pixels one grow step moves the edge on a picture of `size`. */
export function growStepPx(grow: MaskGrowIntent, size: DisplaySize): number {
  const step = GROW_STEP_FRACTION * smallerSide(size);
  return grow === 'looser' ? step : -step;
}

/** Extra expansion a `hide` shape mask starts with. */
export function hideMarginPx(size: DisplaySize): number {
  return HIDE_MARGIN_FRACTION * smallerSide(size);
}

/** What a purpose does to the mask itself. `effect` targets are resolved by the caller. */
export function purposeShape(purpose: MaskPurpose): { readonly invert: boolean } {
  // `hide` keeps everything EXCEPT the region: the same alpha cut, inverted.
  return { invert: purpose === 'hide' };
}

export type EffectIntentResolution =
  | {
      readonly ok: true;
      /** The clip picture effect the mask limits. */
      readonly effect: {
        readonly type: 'color_grade';
        readonly params: Readonly<Record<string, number>>;
      };
    }
  | { readonly ok: false; readonly code: 'effect_intent_unsupported'; readonly message: string };

/** `color_grade` offsets per intent. 0 changes nothing; bounds are the grade contract's. */
const GRADE_INTENT_PARAMS: Readonly<
  Record<
    Extract<MaskEffectIntent, 'brighten' | 'darken' | 'desaturate'>,
    Readonly<Record<string, number>>
  >
> = {
  brighten: { exposure: 0.5, shadows: 0.1 },
  darken: { exposure: -0.6, highlights: -0.1 },
  desaturate: { saturation: -1 },
};

const UNSUPPORTED_EFFECT_INTENT: Readonly<
  Record<Extract<MaskEffectIntent, 'blur_to_hide' | 'grade_match_to'>, string>
> = {
  blur_to_hide:
    'A blur limited to a clip mask is not something FramePilot can render yet, so nothing was ' +
    'changed. To hide the region now, use purpose "hide" (it cuts the region out of the clip), ' +
    'or tell the editor a masked blur is not available yet.',
  grade_match_to:
    'Matching a masked region to another shot is not available yet, so nothing was changed. ' +
    'Use "brighten", "darken" or "desaturate" inside the mask, or match the whole clip with match_color.',
};

/** The catalog effect and deterministic parameters for an effect intent. */
export function resolveEffectIntent(intent: MaskEffectIntent): EffectIntentResolution {
  if (intent === 'blur_to_hide' || intent === 'grade_match_to') {
    return {
      ok: false,
      code: 'effect_intent_unsupported',
      message: UNSUPPORTED_EFFECT_INTENT[intent],
    };
  }
  return { ok: true, effect: { type: 'color_grade', params: GRADE_INTENT_PARAMS[intent] } };
}
