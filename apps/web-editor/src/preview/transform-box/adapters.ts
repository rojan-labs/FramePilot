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

/** A text overlay edit: its box params and its clip transform, as one gesture left them. */
export interface TextOverlayEdit {
  readonly params: TextOverlayBoxParams;
  readonly transform: PictureBaseTransform;
}

/** The side handles that reflow a text overlay (a new wrap width) instead of stretching it. */
const REFLOW_HANDLES = new Set(['e', 'w']);

/**
 * What a gesture does to a text overlay, which has two places to store it: its words' own
 * params (position, size, wrap width) and its clip transform (turn, stretch).
 *
 * - Move: the params' centre. A uniform resize: the word size and wrap together. A free drag of
 *   the left or right edge: the wrap width (the words reflow).
 * - A free (Shift) drag of a corner or the top or bottom edge STRETCHES the letters: the clip's
 *   scaleX/scaleY, with the centre's travel still going to the params.
 * - A turn: the clip's rotation.
 */
export function textOverlayEditAfter(
  params: TextOverlayBoxParams,
  transform: PictureBaseTransform,
  from: Box,
  to: Box,
  gesture: TransformGesture,
  frame: { readonly width: number; readonly height: number },
): TextOverlayEdit {
  if (gesture.kind === 'rotate') {
    return { params, transform: pictureTransformAfter(transform, from, to, gesture) };
  }
  const stretching =
    gesture.kind === 'resize' && !gesture.uniform && !REFLOW_HANDLES.has(gesture.handle);
  if (!stretching) {
    return { params: textOverlayParamsAfter(params, from, to, gesture, frame), transform };
  }
  const travelled = { ...from, cx: to.cx, cy: to.cy };
  const stretched = pictureTransformAfter(transform, from, to, gesture);
  return {
    params: textOverlayParamsAfter(params, from, travelled, { kind: 'move' }, frame),
    // The centre's travel is the params'; the clip keeps its own offset.
    transform: { ...stretched, x: transform.x, y: transform.y },
  };
}

/** Where a text overlay's centre may go: anywhere on the frame, and a little past its edge. */
const ANY = { min: -50, max: 150 } as const;

/** A box shape's placement params: centre in percent of each axis, size in percent of the height. */
export interface ShapeBoxParams {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The limits a shape's params keep (`SHAPE_LIMITS`): position and size. */
export interface ShapeBoxLimits {
  readonly position: { readonly min: number; readonly max: number };
  readonly size: { readonly min: number; readonly max: number };
}

/** A box shape's box: its params placed by the clip transform (which turns it about its centre). */
export function shapeBoxOf(
  params: ShapeBoxParams,
  transform: PictureBaseTransform,
  frame: { readonly width: number; readonly height: number },
): Box {
  const unit = frame.height / 100;
  return {
    cx: (params.x / 100) * frame.width + transform.x,
    cy: (params.y / 100) * frame.height + transform.y,
    width: params.width * unit * transform.scale * transform.scaleX,
    height: params.height * unit * transform.scale * transform.scaleY,
    rotation: transform.rotation,
  };
}

/**
 * What a gesture does to a box shape: a move or a resize is the shape's own params (a free resize
 * is just a new width and height: a shape stretches natively, with no clip stretch), a turn is
 * the clip's rotation.
 */
export function shapeEditAfter(
  params: ShapeBoxParams,
  transform: PictureBaseTransform,
  from: Box,
  to: Box,
  gesture: TransformGesture,
  frame: { readonly width: number; readonly height: number },
  limits: ShapeBoxLimits,
): { readonly params: ShapeBoxParams; readonly transform: PictureBaseTransform } {
  if (gesture.kind === 'rotate') {
    return { params, transform: pictureTransformAfter(transform, from, to, gesture) };
  }
  const rx = from.width > 0 ? to.width / from.width : 1;
  const ry = from.height > 0 ? to.height / from.height : 1;
  const size = (value: number, ratio: number): number => round(clamp(value * ratio, limits.size));
  return {
    params: {
      x: round(clamp(params.x + ((to.cx - from.cx) / frame.width) * 100, limits.position)),
      y: round(clamp(params.y + ((to.cy - from.cy) / frame.height) * 100, limits.position)),
      width: gesture.kind === 'resize' ? size(params.width, rx) : params.width,
      height: gesture.kind === 'resize' ? size(params.height, ry) : params.height,
    },
    transform,
  };
}
