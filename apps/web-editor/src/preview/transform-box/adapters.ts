/**
 * What a bounding-box gesture means for each kind of layer's data model.
 *
 * The box speaks only in {@link Box}es; these translate a gesture's start and end boxes into the
 * change the model stores, and nothing else. Every translation is RELATIVE (a scale ratio, a
 * centre delta, a rotation delta applied to the layer's stored values), so it holds whether the
 * box was read from a clip mid-animation, mid-transition or at rest: the handles edit the base
 * values, and the animation plays on top of them.
 */
import { normalizeRotation } from '../snapping.js';
import type { Box, TransformGesture } from './geometry.js';

/** A picture's stored base transform (time 0): uniform scale, stretch, offset, rotation. */
export interface PictureBaseTransform {
  readonly scale: number;
  /** Stretch multipliers on top of `scale` (identity 1). */
  readonly scaleX: number;
  readonly scaleY: number;
  /** Offset of the centre from the frame's centre, project pixels. */
  readonly x: number;
  readonly y: number;
  /** Degrees, anticlockwise-positive. */
  readonly rotation: number;
}

/** The frame plan's geometry of a placed layer (`FramePlanGeometry`), as the box needs it. */
export interface PlacedGeometry {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

/** The box a placed layer occupies: its centre, its unrotated size and its angle. */
export function boxOfPlacement(geometry: PlacedGeometry): Box {
  return {
    cx: geometry.anchorX,
    cy: geometry.anchorY,
    width: geometry.width,
    height: geometry.height,
    rotation: geometry.rotation,
  };
}

/** The scale the uniform `scale` may take (the engine's sane range). */
export const PICTURE_SCALE_BOUNDS = { min: 0.02, max: 50 } as const;

const clampScale = (value: number): number =>
  Math.min(PICTURE_SCALE_BOUNDS.max, Math.max(PICTURE_SCALE_BOUNDS.min, value));

/**
 * A picture's new base transform after a gesture took its box from `from` to `to`.
 *
 * - The centre's travel is added to `x`/`y` (a resize anchored on the opposite handle moves the
 *   centre too).
 * - A uniform resize multiplies `scale`; a free one multiplies `scaleX`/`scaleY` each by its own
 *   axis ratio and leaves `scale` alone, so a later uniform zoom (a punch-in) still scales the
 *   stretched picture as a whole.
 * - A rotation adds the box's turn.
 */
export function pictureTransformAfter(
  base: PictureBaseTransform,
  from: Box,
  to: Box,
  gesture: TransformGesture,
): PictureBaseTransform {
  const moved = { ...base, x: base.x + (to.cx - from.cx), y: base.y + (to.cy - from.cy) };
  if (gesture.kind === 'rotate') {
    return { ...base, rotation: normalizeRotation(base.rotation + (to.rotation - from.rotation)) };
  }
  if (gesture.kind === 'move') return moved;
  const rx = from.width > 0 ? to.width / from.width : 1;
  const ry = from.height > 0 ? to.height / from.height : 1;
  if (gesture.uniform) return { ...moved, scale: clampScale(base.scale * rx) };
  return { ...moved, scaleX: base.scaleX * rx, scaleY: base.scaleY * ry };
}

/** A text overlay's box-editable params (a subset of `TextOverlayParams`). */
export interface TextOverlayBoxParams {
  /** Centre, percent of each frame axis. */
  readonly xPercent: number;
  readonly yPercent: number;
  /** Glyph size, percent of the frame height. */
  readonly fontSizePercent: number;
  /** Wrap width, percent of the frame width. */
  readonly boxWidthPercent: number;
}

/** The text overlay size and wrap-width ranges the Inspector offers. */
export const TEXT_OVERLAY_BOX_BOUNDS = {
  fontSizePercent: { min: 1, max: 60 },
  boxWidthPercent: { min: 5, max: 100 },
} as const;

const clamp = (value: number, bounds: { readonly min: number; readonly max: number }): number =>
  Math.min(bounds.max, Math.max(bounds.min, value));
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * A text overlay's new params after a move or resize took its box from `from` to `to`
 * (`frame` = the project frame, pixels). Rotation and stretch are the clip transform's
 * ({@link pictureTransformAfter}), not the params'.
 *
 * - A move shifts the centre (`xPercent`/`yPercent`).
 * - A uniform resize scales the words: the font size and the wrap width by the same ratio, so the
 *   lines break where they did.
 * - A free resize of a side (the left or right edge) is a new wrap width: the words reflow and
 *   keep their size, as a text box behaves in Figma or Canva.
 */
export function textOverlayParamsAfter(
  params: TextOverlayBoxParams,
  from: Box,
  to: Box,
  gesture: TransformGesture,
  frame: { readonly width: number; readonly height: number },
): TextOverlayBoxParams {
  const moved = {
    ...params,
    xPercent: round(clamp(params.xPercent + ((to.cx - from.cx) / frame.width) * 100, ANY)),
    yPercent: round(clamp(params.yPercent + ((to.cy - from.cy) / frame.height) * 100, ANY)),
  };
  if (gesture.kind !== 'resize') return gesture.kind === 'move' ? moved : params;
  if (gesture.uniform) {
    const ratio = from.width > 0 ? to.width / from.width : 1;
    return {
      ...moved,
      fontSizePercent: round(
        clamp(params.fontSizePercent * ratio, TEXT_OVERLAY_BOX_BOUNDS.fontSizePercent),
      ),
      boxWidthPercent: round(
        clamp(params.boxWidthPercent * ratio, TEXT_OVERLAY_BOX_BOUNDS.boxWidthPercent),
      ),
    };
  }
  const widthDelta = ((to.width - from.width) / frame.width) * 100;
  return {
    ...moved,
    boxWidthPercent: round(
      clamp(params.boxWidthPercent + widthDelta, TEXT_OVERLAY_BOX_BOUNDS.boxWidthPercent),
    ),
  };
}

/** Where a text overlay's centre may go: anywhere on the frame, and a little past its edge. */
const ANY = { min: -50, max: 150 } as const;
