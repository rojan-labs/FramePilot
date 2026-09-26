/**
 * The geometry of a shape's on-monitor handles (plan/elements EL4a): where the handles sit and
 * what a drag does to the shape's params. Pure, so every rule is unit-tested.
 *
 * Handles edit the shape's PARAMS — its box or its two ends — never its clip transform; the
 * Position & size section and the transform box own that. The handle layer is drawn inside the
 * clip's transform (translated, rotated and scaled about the shape's centre), so a pointer delta
 * on screen is first carried back into the shape's own space ({@link toShapeDelta}).
 *
 * Units follow `ShapeParams`: a box centre is a percent of each frame axis, a box size a percent
 * of the frame HEIGHT, segment ends a percent of each axis.
 */
import { SHAPE_LIMITS } from '@framepilot/timeline-schema';

type Params = Readonly<Record<string, unknown>>;

/** A rectangle in percent of the frame (left/top/width/height). */
export interface PercentRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Which box handle is dragged: the body, a side or a corner. */
export type BoxHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const BOX_HANDLES: readonly Exclude<BoxHandle, 'move'>[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

/** Which segment handle is dragged: one end, or the whole line. */
export type SegmentHandle = 'start' | 'end' | 'move';

const num = (params: Params, key: string): number => {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};
const clamp = (value: number, bounds: { readonly min: number; readonly max: number }): number =>
  Math.min(bounds.max, Math.max(bounds.min, value));
const round = (value: number): number => Math.round(value * 100) / 100;

/** A box shape's rectangle in percent of the frame, for a `frameAspect` (width ÷ height). */
export function boxRect(params: Params, frameAspect: number): PercentRect {
  const width = num(params, 'width') / frameAspect;
  const height = num(params, 'height');
  return {
    left: num(params, 'x') - width / 2,
    top: num(params, 'y') - height / 2,
    width,
    height,
  };
}

/** The point a shape turns and scales about, in percent of the frame. */
export function shapePivot(params: Params): { readonly x: number; readonly y: number } {
  if (params.x1 !== undefined && params.x1 !== null) {
    return {
      x: (num(params, 'x1') + num(params, 'x2')) / 2,
      y: (num(params, 'y1') + num(params, 'y2')) / 2,
    };
  }
  return { x: num(params, 'x'), y: num(params, 'y') };
}

/**
 * The param changes a box drag makes. `dx`/`dy` are the drag in percent of each frame axis, in
 * the shape's own (untransformed) space. The opposite side stays put; sizes never go below the
 * schema's minimum and positions stay in range.
 */
export function boxDragChanges(
  params: Params,
  handle: BoxHandle,
  dx: number,
  dy: number,
  frameAspect: number,
): Record<string, number> {
  const rect = boxRect(params, frameAspect);
  let { left, top } = rect;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;
  if (handle === 'move') {
    return {
      x: round(clamp(num(params, 'x') + dx, SHAPE_LIMITS.position)),
      y: round(clamp(num(params, 'y') + dy, SHAPE_LIMITS.position)),
    };
  }
  const minWidth = SHAPE_LIMITS.size.min / frameAspect;
  const minHeight = SHAPE_LIMITS.size.min;
  if (handle.includes('w')) left = Math.min(left + dx, right - minWidth);
  if (handle.includes('e')) right = Math.max(right + dx, left + minWidth);
  if (handle.includes('n')) top = Math.min(top + dy, bottom - minHeight);
  if (handle.includes('s')) bottom = Math.max(bottom + dy, top + minHeight);
  return {
    x: round(clamp((left + right) / 2, SHAPE_LIMITS.position)),
    y: round(clamp((top + bottom) / 2, SHAPE_LIMITS.position)),
    width: round(clamp((right - left) * frameAspect, SHAPE_LIMITS.size)),
    height: round(clamp(bottom - top, SHAPE_LIMITS.size)),
  };
}

/** The param changes a segment drag makes (`dx`/`dy` as for {@link boxDragChanges}). */
export function segmentDragChanges(
  params: Params,
  handle: SegmentHandle,
  dx: number,
  dy: number,
): Record<string, number> {
  const move = (key: string, delta: number): number =>
    round(clamp(num(params, key) + delta, SHAPE_LIMITS.endpoint));
  const changes: Record<string, number> = {};
  if (handle === 'start' || handle === 'move') {
    changes.x1 = move('x1', dx);
    changes.y1 = move('y1', dy);
  }
  if (handle === 'end' || handle === 'move') {
    changes.x2 = move('x2', dx);
    changes.y2 = move('y2', dy);
  }
  return changes;
}

/**
 * A pointer delta on screen, carried into the shape's own space in percent of each frame axis.
 *
 * The handle layer is drawn rotated by the clip's `rotation` (the export's counter-clockwise
 * degrees, so CSS `rotate(-θ)`) and scaled by its `scale`; this undoes both, in pixels, before
 * converting to percent, because the two axes have different pixel sizes.
 */
export function toShapeDelta(
  dxPx: number,
  dyPx: number,
  frameWidthPx: number,
  frameHeightPx: number,
  rotationDegrees: number,
  scale: number,
): { readonly dx: number; readonly dy: number } {
  const theta = (rotationDegrees * Math.PI) / 180;
  const s = scale === 0 ? 1 : scale;
  const localX = (dxPx * Math.cos(theta) - dyPx * Math.sin(theta)) / s;
  const localY = (dxPx * Math.sin(theta) + dyPx * Math.cos(theta)) / s;
  return { dx: (localX / frameWidthPx) * 100, dy: (localY / frameHeightPx) * 100 };
}

/** The step a keyboard nudge moves a shape, in percent: fine, and with Shift. */
export const NUDGE_PERCENT = { fine: 0.5, coarse: 5 } as const;

/**
 * Where a shape can be clicked, in percent of the frame: a box's own rectangle, or the box around
 * a segment's ends grown so a thin line is still easy to hit.
 */
export function shapeHitRect(params: Params, frameAspect: number): PercentRect {
  if (params.x1 === undefined || params.x1 === null) return boxRect(params, frameAspect);
  const reach = 1.5;
  const left = Math.min(num(params, 'x1'), num(params, 'x2')) - reach;
  const top = Math.min(num(params, 'y1'), num(params, 'y2')) - reach * frameAspect;
  const right = Math.max(num(params, 'x1'), num(params, 'x2')) + reach;
  const bottom = Math.max(num(params, 'y1'), num(params, 'y2')) + reach * frameAspect;
  return { left, top, width: right - left, height: bottom - top };
}
