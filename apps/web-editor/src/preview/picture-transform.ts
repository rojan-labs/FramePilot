/**
 * The picture's composited transform at a moment in time (revamp Phase 3).
 *
 * ## Why this is a separate module
 *
 * The canvas compositor draws through `CanvasRenderingContext2D`, which jsdom does
 * not implement — so everything inside `drawSource` is verified in a real browser
 * (the Playwright pixel specs), not the unit suite. That is the right place to
 * check *pixels*, and the wrong place to discover that a sign is inverted.
 *
 * The arithmetic here is exactly the part that must agree with the Python export,
 * so it lives where it can be asserted against numbers:
 *
 *  - **Rotation sign.** MoviePy's `rotated()` turns ANTICLOCKWISE for a positive
 *    angle ("Rotates the specified clip by ``angle`` degrees ... anticlockwise" —
 *    `moviepy/video/fx/Rotate.py`). Canvas `rotate()` turns CLOCKWISE in a y-down
 *    space. Handing the degrees straight to the canvas would rotate the preview the
 *    opposite way from the render — a divergence that looks like a working feature,
 *    which is the worst kind.
 *  - **Alpha.** The export composes the clip's animated `opacity` and a fade
 *    transition's opacity into ONE alpha mask (`_attach_mask`); the preview has to
 *    compose the same product, clamped the same way (`_clamp01`).
 *  - **Offset units.** `x`/`y` keyframes are PROJECT-canvas pixels. The preview
 *    canvas is capped at `CANVAS_MAX_EDGE`, so an offset must be converted through
 *    the ratio or a reframe would preview at the wrong magnitude.
 *
 * @see engine/python/framepilot_engine/render/compiler.py `_place_video_clip`
 * @see engine/python/framepilot_engine/effects/transform.py `evaluate_clip_transform`
 */
import { evaluateKeyframes } from '@framepilot/editor-core';
import type { Keyframe } from '@framepilot/timeline-schema';

/** Pixel dimensions of a canvas or the project resolution. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/** A transition's geometric/opacity contribution, already evaluated. */
export interface TransitionContribution {
  /** Extra multiplicative scale (1 = none). */
  readonly scale: number;
  /** Extra offset in CANVAS pixels (the export applies it in target pixels). */
  readonly offsetPx: readonly [number, number];
  /** Extra opacity multiplier (1 = none). */
  readonly opacity: number;
}

/** No transition ramping — the steady-state contribution. */
export const NO_TRANSITION: TransitionContribution = {
  scale: 1,
  offsetPx: [0, 0],
  opacity: 1,
};

/** The composited picture transform, in the canvas's own units and conventions. */
export interface PictureTransform {
  readonly scale: number;
  /**
   * Rotation in RADIANS, in the canvas's clockwise-positive convention — i.e.
   * already negated from the project's anticlockwise-positive degrees. Pass
   * straight to `ctx.rotate`.
   */
  readonly rotationRad: number;
  /** Composited alpha in [0,1]: the clip's opacity times the transition's. */
  readonly alpha: number;
  /** Offset from the canvas centre, in canvas pixels. */
  readonly dxPx: number;
  readonly dyPx: number;
}

const clampUnit = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Degrees anticlockwise (the project/MoviePy convention) → radians clockwise
 * (the canvas convention). The negation IS the conversion. */
export function rotationToCanvasRadians(degreesAnticlockwise: number): number {
  return (-degreesAnticlockwise * Math.PI) / 180;
}

/**
 * Degrees anticlockwise (the project convention) → degrees for a CSS `rotate()`.
 *
 * CSS rotates CLOCKWISE for a positive angle, same as canvas, so this is the same
 * negation — and it lives here, next to the canvas conversion, so the sign
 * convention has exactly ONE home. The on-canvas handles draw their selection box
 * through this; if it and the compositor ever disagreed, the box would sit at a
 * different angle from the picture it is supposed to be framing.
 */
export function rotationToCssDegrees(degreesAnticlockwise: number): number {
  return -degreesAnticlockwise;
}

/** The four transform properties the on-canvas handles write at time 0. */
const BASE_TRANSFORM_PROPERTIES = ['scale', 'x', 'y', 'rotation'] as const;

/** A base transform, as the on-canvas handles express it. */
export interface BaseTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly rotation?: number;
}

/**
 * `keyframes` with the base (time-0) transform replaced by `values` — the live
 * preview of an in-flight canvas drag.
 *
 * This exists so the picture the user sees *during* a drag is the same picture they
 * get *after* it. The canvas compositor draws from keyframes, not from a CSS
 * transform the way the retired DOM player did, so a drag override has to be
 * expressed as keyframes; and it has to be expressed the SAME way
 * `setClipTransformPatch` will commit it (time 0, one keyframe per property,
 * replacing any existing time-0 entry) or the picture would jump on release.
 *
 * Keyframes at other times are preserved, so dragging the base transform of an
 * animated clip previews the animation from its new starting point instead of
 * flattening it.
 */
export function withBaseTransform(
  keyframes: readonly Keyframe[],
  values: BaseTransform,
): readonly Keyframe[] {
  const kept = keyframes.filter(
    (keyframe) =>
      keyframe.time !== 0 ||
      !(BASE_TRANSFORM_PROPERTIES as readonly string[]).includes(keyframe.property),
  );
  const base: Keyframe[] = [
    { id: 'preview_base_scale', time: 0, property: 'scale', value: values.scale, easing: 'linear' },
    { id: 'preview_base_x', time: 0, property: 'x', value: values.x, easing: 'linear' },
    { id: 'preview_base_y', time: 0, property: 'y', value: values.y, easing: 'linear' },
    {
      id: 'preview_base_rotation',
      time: 0,
      property: 'rotation',
      value: values.rotation ?? 0,
      easing: 'linear',
    },
  ];
  return [...base, ...kept];
}

/**
 * A clip's base transform — every handle-writable property evaluated at time 0.
 *
 * Time 0 (not the playhead) because that is what the handles edit and what
 * `setClipTransformPatch` writes; reading it at the playhead would make a drag on an
 * animated clip silently rewrite its start value to whatever the mid-animation value
 * happened to be.
 */
export function baseTransformOf(keyframes: readonly Keyframe[]): Required<BaseTransform> {
  return {
    scale: evaluateKeyframes(keyframes, 'scale', 0) ?? 1,
    x: evaluateKeyframes(keyframes, 'x', 0) ?? 0,
    y: evaluateKeyframes(keyframes, 'y', 0) ?? 0,
    rotation: evaluateKeyframes(keyframes, 'rotation', 0) ?? 0,
  };
}

/**
 * Resolve the picture transform to apply at `clipTime`.
 *
 * Every property falls back to its identity when the clip has no keyframes for it,
 * matching `evaluate_clip_transform`: a clip animating only `scale` leaves
 * position, rotation and opacity alone.
 */
export function pictureTransformAt(
  keyframes: readonly Keyframe[],
  clipTime: number,
  canvas: Dimensions,
  resolution: Dimensions,
  transition: TransitionContribution = NO_TRANSITION,
): PictureTransform {
  const scale = (evaluateKeyframes(keyframes, 'scale', clipTime) ?? 1) * transition.scale;
  const x = evaluateKeyframes(keyframes, 'x', clipTime) ?? 0;
  const y = evaluateKeyframes(keyframes, 'y', clipTime) ?? 0;
  const rotationDeg = evaluateKeyframes(keyframes, 'rotation', clipTime) ?? 0;
  const opacity = evaluateKeyframes(keyframes, 'opacity', clipTime) ?? 1;
  // Project-canvas pixels → this canvas's pixels. A degenerate resolution would
  // otherwise divide by zero and put NaN into the context matrix, which silently
  // blanks the whole frame rather than failing visibly.
  const scaleX = resolution.width > 0 ? canvas.width / resolution.width : 0;
  const scaleY = resolution.height > 0 ? canvas.height / resolution.height : 0;
  return {
    scale,
    rotationRad: rotationToCanvasRadians(rotationDeg),
    alpha: clampUnit(opacity) * clampUnit(transition.opacity),
    dxPx: x * scaleX + transition.offsetPx[0],
    dyPx: y * scaleY + transition.offsetPx[1],
  };
}
