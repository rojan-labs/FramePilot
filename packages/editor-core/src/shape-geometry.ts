/**
 * Where a shape's raster sits (schema v25, plan/elements EL4a, ADR 0190).
 *
 * The engine is the only shape rasteriser (`render/shape_raster.py`); this module computes only
 * the frame-pixel rectangle that raster covers, so the frame plan can place it and the monitor can
 * hit-test it and draw its handles. It mirrors `render/shape_geometry.py#shape_bounds` operation
 * for operation, pinned by the frame-plan vectors.
 */
import {
  SHAPE_EFFECT_TYPE,
  shapeDescriptor,
  shapeParamsProblem,
  type ShapeDescriptor,
} from '@framepilot/timeline-schema';
import type { Clip } from '@framepilot/timeline-schema';
import { syntheticClipKind } from './synthetic-assets.js';

/** Anti-aliasing margin around a shape's outline, in output pixels. */
export const SHAPE_BOUNDS_MARGIN = 1;
/** An arrow head's half-width as a fraction of its length. */
export const ARROW_HALF_WIDTH = 0.5;
/** A bar cap's half-length as a multiple of the stroke width. */
export const BAR_HALF_LENGTH = 2;
/** A dot cap's radius as a multiple of the stroke width. */
export const DOT_RADIUS = 1;

/** The integer frame-pixel rectangle a shape's raster covers, before the clip's transform. */
export interface ShapeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Params = Readonly<Record<string, unknown>>;

const num = (params: Params, key: string): number => Number(params[key]);

function knobValue(descriptor: ShapeDescriptor, params: Params, name: string): number {
  const knob = descriptor.knobs.find((candidate) => candidate.name === name);
  const value = params[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return knob?.default ?? 0;
}

function capReach(
  descriptor: ShapeDescriptor,
  params: Params,
  cap: unknown,
  strokeWidth: number,
): number {
  if (cap === 'arrow') return arrowHeadLength(descriptor, params, strokeWidth) * ARROW_HALF_WIDTH;
  if (cap === 'dot') return DOT_RADIUS * strokeWidth;
  if (cap === 'bar') return BAR_HALF_LENGTH * strokeWidth;
  return strokeWidth / 2;
}

/**
 * A curved segment's control point (quadratic) in frame pixels, or `null` for a straight one: the
 * mid-point pushed along the normal by `curvature` percent of half the length. Mirrors the
 * engine's `segment_control`.
 */
export function segmentControl(
  descriptor: ShapeDescriptor,
  params: Params,
  ends: readonly [number, number, number, number],
): readonly [number, number] | null {
  if (!descriptor.knobs.some((knob) => knob.name === 'curvature')) return null;
  const [x1, y1, x2, y2] = ends;
  const bend = knobValue(descriptor, params, 'curvature') / 100;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0 || bend === 0) return null;
  const [nx, ny] = [-(y2 - y1) / length, (x2 - x1) / length];
  return [(x1 + x2) / 2 + (nx * bend * length) / 2, (y1 + y2) / 2 + (ny * bend * length) / 2];
}

/** How long an arrow cap is, in frame pixels (`headSize` × the stroke width). */
export function arrowHeadLength(
  descriptor: ShapeDescriptor,
  params: Params,
  strokeWidth: number,
): number {
  const hasKnob = descriptor.knobs.some((knob) => knob.name === 'headSize');
  return (hasKnob ? knobValue(descriptor, params, 'headSize') : 4) * strokeWidth;
}

/**
 * The integer rectangle a shape's raster covers for a `width` × `height` frame: its outline,
 * stroke, caps and a margin. `rotates` (the clip animates `rotation`) makes it a square as wide
 * as the diagonal, centred on the same point, because the export rotates inside the layer's box.
 *
 * @returns `null` when `params` is not a shape this build can draw.
 */
export function shapeBounds(
  params: Params,
  width: number,
  height: number,
  rotates = false,
): ShapeBounds | null {
  const descriptor = typeof params.shape === 'string' ? shapeDescriptor(params.shape) : undefined;
  if (descriptor === undefined) return null;
  const strokeWidth =
    params.stroke !== null && params.stroke !== undefined
      ? (height * num(params, 'strokeWidth')) / 100
      : 0;
  let left: number;
  let top: number;
  let right: number;
  let bottom: number;
  let pad: number;
  if (descriptor.frame === 'box') {
    const cx = (width * num(params, 'x')) / 100;
    const cy = (height * num(params, 'y')) / 100;
    const halfW = (height * num(params, 'width')) / 100 / 2;
    const halfH = (height * num(params, 'height')) / 100 / 2;
    [left, top, right, bottom] = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
    pad = strokeWidth / 2 + SHAPE_BOUNDS_MARGIN;
  } else {
    const x1 = (width * num(params, 'x1')) / 100;
    const y1 = (height * num(params, 'y1')) / 100;
    const x2 = (width * num(params, 'x2')) / 100;
    const y2 = (height * num(params, 'y2')) / 100;
    [left, top, right, bottom] = [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ];
    // A curved segment stays inside the triangle of its ends and control point.
    const control = segmentControl(descriptor, params, [x1, y1, x2, y2]);
    if (control !== null) {
      [left, top] = [Math.min(left, control[0]), Math.min(top, control[1])];
      [right, bottom] = [Math.max(right, control[0]), Math.max(bottom, control[1])];
    }
    const reach = Math.max(
      strokeWidth / 2,
      capReach(descriptor, params, params.startCap ?? 'none', strokeWidth),
      capReach(descriptor, params, params.endCap ?? 'none', strokeWidth),
    );
    pad = reach + SHAPE_BOUNDS_MARGIN;
  }
  [left, top, right, bottom] = [left - pad, top - pad, right + pad, bottom + pad];
  if (rotates) {
    const half = Math.hypot(right - left, bottom - top) / 2;
    const [centreX, centreY] = [(left + right) / 2, (top + bottom) / 2];
    [left, top, right, bottom] = [centreX - half, centreY - half, centreX + half, centreY + half];
  }
  const x0 = Math.floor(left);
  const y0 = Math.floor(top);
  return {
    x: x0,
    y: y0,
    width: Math.max(1, Math.ceil(right) - x0),
    height: Math.max(1, Math.ceil(bottom) - y0),
  };
}

/**
 * A shape clip's params when it can be drawn, else `null` — the same rule as the engine's
 * `shape_clip_params`, so the plan and the export skip exactly the same clips.
 */
export function shapeClipParams(clip: Clip): Params | null {
  if (syntheticClipKind(clip.assetId) !== 'shape') return null;
  const effect = clip.effects.find((candidate) => candidate.type === SHAPE_EFFECT_TYPE);
  if (effect === undefined) return null;
  return shapeParamsProblem(effect.params) === null ? effect.params : null;
}
