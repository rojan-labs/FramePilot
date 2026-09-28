/**
 * The on-canvas bounding box's geometry: pure math, no DOM, no React.
 *
 * Everything here is in PROJECT pixels (the export's own frame), never screen pixels. The one
 * place screen space enters is {@link toProjectPoint}, which maps a pointer through the frame
 * element's measured rect, so a drag of ten screen pixels moves a layer ten screen pixels at
 * any monitor size or zoom: at 50 % a screen pixel is two project pixels, and the math never
 * has to know.
 *
 * A box is its centre, its unrotated size and its rotation. Resizing happens in the box's own
 * rotated frame (the pointer is turned into it, the new extents computed there, the new centre
 * turned back out), so a handle on a turned layer pulls along the layer's own axes as it does
 * in Figma or Premiere, and a box can never be dragged inside out: an extent that would cross
 * its anchor stops at {@link BoxLimits.minSize} instead.
 *
 * Rotation follows the project's convention: degrees, ANTICLOCKWISE-positive (MoviePy's), while
 * the screen is y-down, so an on-screen clockwise sweep is a negative change.
 */
import { normalizeRotation, snapAxis, snapRotation } from '../snapping.js';

/** A layer's box in project pixels. */
export interface Box {
  /** Centre, from the frame's top-left. */
  readonly cx: number;
  readonly cy: number;
  /** Unrotated size. */
  readonly width: number;
  readonly height: number;
  /** Degrees, anticlockwise-positive. */
  readonly rotation: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The eight resize handles, by compass direction on the UNROTATED box. */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Which way a handle pulls along each local axis: -1 towards the left/top edge, +1 towards the
 * right/bottom, 0 when the handle does not move that axis (an edge handle's cross axis).
 */
export const HANDLE_DIRECTION: Readonly<Record<ResizeHandle, readonly [-1 | 0 | 1, -1 | 0 | 1]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** How far (screen px) a pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 3;

/** Rotation step while the constrain modifier is held. */
export const ROTATION_SNAP_DEGREES = 15;

export interface BoxLimits {
  /**
   * The smallest a box's width or height may become, in project pixels. The caller converts a
   * screen-space minimum (10 px) through the gesture's own scale, so the floor looks the same at
   * every zoom.
   */
  readonly minSize: number;
  /** The largest either extent may become, in project pixels. */
  readonly maxSize: number;
}

const DEG = Math.PI / 180;

/** `point` turned by `degrees` (anticlockwise-positive, in the y-down plane) about `centre`. */
function turn(point: Point, centre: Point, degrees: number): Point {
  // Anticlockwise on screen is a NEGATIVE angle in the y-down plane.
  const angle = -degrees * DEG;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

/** A pointer's client position in project pixels, through the frame element's measured rect. */
export function toProjectPoint(
  client: Point,
  frameRect: { readonly left: number; readonly top: number } & Size,
  resolution: Size,
): Point {
  const sx = frameRect.width > 0 ? resolution.width / frameRect.width : 1;
  const sy = frameRect.height > 0 ? resolution.height / frameRect.height : 1;
  return { x: (client.x - frameRect.left) * sx, y: (client.y - frameRect.top) * sy };
}

/** Project pixels per screen pixel for this frame rect (the monitor's zoom, inverted). */
export function projectPerScreenPixel(frameRect: Size, resolution: Size): number {
  return frameRect.width > 0 ? resolution.width / frameRect.width : 1;
}

/** Whether a pointer has travelled far enough from where it went down to count as a drag. */
export function passedDragThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_THRESHOLD_PX;
}

/** The box's four corners (nw, ne, se, sw) in project pixels, rotation applied. */
export function boxCorners(box: Box): readonly Point[] {
  const centre = { x: box.cx, y: box.cy };
  const hw = box.width / 2;
  const hh = box.height / 2;
  return [
    { x: box.cx - hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy + hh },
    { x: box.cx - hw, y: box.cy + hh },
  ].map((corner) => turn(corner, centre, box.rotation));
}

/** The axis-aligned extent the rotated box covers (what snapping aligns to frame edges). */
export function boxExtent(box: Box): Size {
  const corners = boxCorners(box);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export interface MoveOptions {
  /** Lock to the dominant axis of the screen-space movement (Shift). */
  readonly constrainAxis?: boolean;
  /**
   * Snap tolerance in project pixels (centre, thirds and edges of the frame), or `null` for no
   * snapping (the defeat modifier, or snapping switched off).
   */
  readonly snapTolerance?: number | null;
}

export interface MoveResult {
  readonly box: Box;
  /** Guides to draw as frame fractions, `null` per axis when nothing snapped. */
  readonly guides: { readonly x: number | null; readonly y: number | null };
}

/**
 * The box a MOVE produces: the start box shifted by the pointer's project-space travel,
 * optionally axis-locked and snapped (per axis, on the rotated box's covered extent).
 */
export function moveBox(
  start: Box,
  delta: Point,
  frame: Size,
  options: MoveOptions = {},
): MoveResult {
  let { x: dx, y: dy } = delta;
  if (options.constrainAxis === true) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  let cx = start.cx + dx;
  let cy = start.cy + dy;
  let guides: MoveResult['guides'] = { x: null, y: null };
  const tolerance = options.snapTolerance ?? null;
  if (tolerance !== null) {
    const extent = boxExtent(start);
    const sx = snapAxis(cx - frame.width / 2, extent.width, frame.width, tolerance);
    const sy = snapAxis(cy - frame.height / 2, extent.height, frame.height, tolerance);
    // An axis the lock pinned stays pinned: snapping must not move it back.
    if (options.constrainAxis !== true || dx !== 0) cx = sx.offset + frame.width / 2;
    if (options.constrainAxis !== true || dy !== 0) cy = sy.offset + frame.height / 2;
    guides = {
      x: options.constrainAxis === true && dx === 0 ? null : sx.guide,
      y: options.constrainAxis === true && dy === 0 ? null : sy.guide,
    };
  }
  return { box: { ...start, cx, cy }, guides };
}

export interface ResizeOptions {
  /** Keep the start box's aspect ratio (the default; Shift turns it off). */
  readonly uniform: boolean;
  /** Resize symmetrically about the centre instead of the opposite handle (Alt). */
  readonly fromCenter: boolean;
  readonly limits: BoxLimits;
}

/**
 * The box a RESIZE from `handle` produces with the pointer at `pointer` (project px).
 *
 * The pointer is turned into the start box's own frame; the anchor is the opposite handle (or
 * the centre); each moved axis gets the pointer's distance from the anchor along the handle's
 * pull, clamped to the limits, so crossing the anchor stops at the minimum rather than flipping
 * the layer inside out. A uniform resize takes the larger of the two axis ratios (a corner) or
 * the moved axis' ratio (an edge) and applies it to both, then re-clamps so neither extent leaves
 * the limits and the aspect still holds.
 */
export function resizeBox(
  start: Box,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions,
): Box {
  const [dirX, dirY] = HANDLE_DIRECTION[handle];
  const centre = { x: start.cx, y: start.cy };
  // The pointer in the box's unrotated frame, relative to its centre.
  const local = turn(pointer, centre, -start.rotation);
  const px = local.x - start.cx;
  const py = local.y - start.cy;
  const hw = start.width / 2;
  const hh = start.height / 2;
  const { minSize, maxSize } = options.limits;
  const clampSize = (value: number): number => Math.min(maxSize, Math.max(minSize, value));

  // The anchor, in local coordinates relative to the centre.
  const anchorX = options.fromCenter ? 0 : -dirX * hw;
  const anchorY = options.fromCenter ? 0 : -dirY * hh;
  // Along a moved axis: the pointer's reach from the anchor in the handle's direction.
  const reach = (p: number, anchor: number, dir: number): number =>
    options.fromCenter ? 2 * dir * p : dir * (p - anchor);
  let width = dirX === 0 ? start.width : clampSize(reach(px, anchorX, dirX));
  let height = dirY === 0 ? start.height : clampSize(reach(py, anchorY, dirY));

  if (options.uniform) {
    const rx = width / start.width;
    const ry = height / start.height;
    let ratio = dirX === 0 ? ry : dirY === 0 ? rx : Math.max(rx, ry);
    // Both extents inside the limits at one ratio: the aspect holds even at the floor/ceiling.
    const lowest = Math.max(minSize / start.width, minSize / start.height);
    const highest = Math.min(maxSize / start.width, maxSize / start.height);
    ratio = Math.min(highest, Math.max(lowest, ratio));
    width = start.width * ratio;
    height = start.height * ratio;
  }

  // The new centre: the anchor plus half the new extent in the handle's direction. An axis the
  // handle does not move keeps its centre when uniform scaling grows it (the edge's midpoint
  // stays put, as in every design tool).
  const localCx = options.fromCenter || dirX === 0 ? 0 : anchorX + (dirX * width) / 2;
  const localCy = options.fromCenter || dirY === 0 ? 0 : anchorY + (dirY * height) / 2;
  const moved = turn({ x: start.cx + localCx, y: start.cy + localCy }, centre, start.rotation);
  return { ...start, cx: moved.x, cy: moved.y, width, height };
}

/** The pointer's angle about the box centre, radians in the y-down screen plane. */
export function pointerAngle(box: Box, pointer: Point): number {
  return Math.atan2(pointer.y - box.cy, pointer.x - box.cx);
}

/**
 * The box a ROTATE produces: the start rotation minus the swept screen angle (screen clockwise
 * is project-negative), unwrapped so crossing ±180° never jumps, optionally in 15° steps.
 */
export function rotateBox(
  start: Box,
  startAngleRad: number,
  currentAngleRad: number,
  snap: boolean,
): Box {
  let swept = currentAngleRad - startAngleRad;
  // atan2 wraps at ±π; the shortest equivalent sweep is the one the hand made.
  while (swept > Math.PI) swept -= 2 * Math.PI;
  while (swept < -Math.PI) swept += 2 * Math.PI;
  const raw = start.rotation - swept / DEG;
  const stepped = snap ? snapRotation(raw, ROTATION_SNAP_DEGREES) : raw;
  return { ...start, rotation: normalizeRotation(stepped) };
}

/**
 * The resize cursor for a handle on a box turned by `rotation`: the handle's own direction plus
 * the box's angle, bucketed to the four CSS double-arrows. A corner of a box turned 45° pulls
 * straight sideways, and its cursor says so.
 */
export function resizeCursor(handle: ResizeHandle, rotation: number): string {
  const [dx, dy] = HANDLE_DIRECTION[handle];
  // The handle's screen angle in degrees, y-down, turned by the box (anticlockwise = negative).
  const angle = (Math.atan2(dy, dx) / DEG - rotation + 360) % 180;
  const bucket = Math.round(angle / 45) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][bucket]!;
}

/** Scale factors between two boxes, per axis (what a picture adapter writes as its scale). */
export function scaleRatio(from: Size, to: Size): { readonly x: number; readonly y: number } {
  return {
    x: from.width > 0 ? to.width / from.width : 1,
    y: from.height > 0 ? to.height / from.height : 1,
  };
}
