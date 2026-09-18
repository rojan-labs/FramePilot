/**
 * Shape presets (MK8.3, plan 10 "Shape presets"): heart, star, regular polygon, speech bubble,
 * arrow and rounded frame, as PATH GENERATORS — not mask kinds.
 *
 * WHY generators: a preset is a starting shape the editor then edits like anything they drew.
 * Choosing one inserts ordinary `path` masks (closed cubic Beziers in display-corrected source
 * pixels), so the rasteriser, the path tools, keyframes, tracking and paste all apply with no new
 * renderer and no new schema. The monitor's Shapes tool and the agent's `create_shape_mask` both
 * compile the same `draw_shape_preset` command, which calls these.
 *
 * A preset is laid out in a unit box (`u`, `v` in 0..1, y down), then scaled to the requested
 * box and rotated about its centre. Vertex order is clockwise on screen, like the rectangle and
 * ellipse the rasteriser generates, and the first vertex is the preset's natural "start" (the top
 * point of a star, the tip of a heart) so path keyframes made from it correspond sensibly.
 *
 * A rounded FRAME is two paths — the outer rounded rectangle and the inner one, subtracted —
 * because a single path with a hole would need a bridge, and the distance feather would draw a
 * seam along it.
 */
import type { MaskMode } from '@framepilot/timeline-schema';
import type { MaskPathVertex } from './mask-geometry.js';

/** Every shape preset, in the order the monitor lists them. */
export const MASK_SHAPE_PRESETS = [
  'heart',
  'star',
  'polygon',
  'speech-bubble',
  'arrow',
  'rounded-frame',
] as const;

export type MaskShapePreset = (typeof MASK_SHAPE_PRESETS)[number];

/** Display names, for the monitor's picker and the agent's receipts. */
export const MASK_SHAPE_PRESET_NAMES: Readonly<Record<MaskShapePreset, string>> = {
  heart: 'Heart',
  star: 'Star',
  polygon: 'Polygon',
  'speech-bubble': 'Speech bubble',
  arrow: 'Arrow',
  'rounded-frame': 'Rounded frame',
};

/** Where a preset is placed: its bounding box centre, size and clockwise rotation, source px. */
export interface ShapePresetBox {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
}

/** Per-preset settings; each has a default, so `{}` is always valid. */
export interface ShapePresetOptions {
  /** Star points or polygon sides (3–64). Default: 5 for a star, 6 for a polygon. */
  readonly points?: number;
  /** A star's inner radius as a fraction of its outer radius (0.1–0.95). Default 0.45. */
  readonly innerRatio?: number;
  /** A rounded frame's border as a fraction of the box's smaller side (0.02–0.45). Default 0.12. */
  readonly thickness?: number;
}

/** One generated path and how it joins the stack (`add`, or `subtract` for a frame's hole). */
export interface ShapePresetPath {
  readonly vertices: readonly MaskPathVertex[];
  readonly mode: MaskMode;
  /** A suffix for the mask's name when a preset makes more than one path. */
  readonly part?: string;
}

/** A preset request the generators cannot draw; the message names the remedy. */
export class ShapePresetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ShapePresetError';
  }
}

/** 4 (sqrt(2) - 1) / 3: the cubic control distance that best approximates a quarter circle. */
const KAPPA = 0.5522847498307936;
const MIN_SIDES = 3;
const MAX_SIDES = 64;

/** A vertex in UNIT-box coordinates, tangents as offsets, also in unit coordinates. */
interface UnitVertex {
  readonly u: number;
  readonly v: number;
  readonly inU?: number;
  readonly inV?: number;
  readonly outU?: number;
  readonly outV?: number;
  readonly smooth?: boolean;
}

function clampInteger(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** Map unit vertices into the box: scale, then rotate about the centre. */
function place(unit: readonly UnitVertex[], box: ShapePresetBox): MaskPathVertex[] {
  const radians = ((box.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotate = (x: number, y: number): readonly [number, number] => [
    cos * x - sin * y,
    sin * x + cos * y,
  ];
  return unit.map((vertex) => {
    const [x, y] = rotate((vertex.u - 0.5) * box.width, (vertex.v - 0.5) * box.height);
    const [inX, inY] = rotate((vertex.inU ?? 0) * box.width, (vertex.inV ?? 0) * box.height);
    const [outX, outY] = rotate((vertex.outU ?? 0) * box.width, (vertex.outV ?? 0) * box.height);
    return {
      x: box.cx + x,
      y: box.cy + y,
      inX,
      inY,
      outX,
      outY,
      type: vertex.smooth === true ? 'smooth' : 'corner',
    };
  });
}

/**
 * A heart: tip at the bottom, two round lobes, a dip at the top. Symmetric about `u = 0.5`.
 * The lobes are cubic arcs whose control points sit on the box's edges, so the heart fills its box.
 */
function heart(): UnitVertex[] {
  return [
    { u: 0.5, v: 1, inU: 0.25, inV: -0.22, outU: -0.25, outV: -0.22 },
    { u: 0, v: 0.33, inU: 0, inV: 0.3, outU: 0, outV: -0.31, smooth: true },
    { u: 0.5, v: 0.3, inU: -0.02, inV: -0.3, outU: 0.02, outV: -0.3 },
    { u: 1, v: 0.33, inU: 0, inV: -0.31, outU: 0, outV: 0.3, smooth: true },
  ];
}

/**
 * Stretch corner-only vertices so their bounds are exactly the unit box: a five-point star or a
 * pentagon inscribed in a circle does not reach the circle's box, and a preset is sized BY the box
 * the editor drags, so it has to touch every side of it.
 */
function fillUnitBox(vertices: readonly UnitVertex[]): UnitVertex[] {
  const us = vertices.map((vertex) => vertex.u);
  const vs = vertices.map((vertex) => vertex.v);
  const u0 = Math.min(...us);
  const v0 = Math.min(...vs);
  const du = Math.max(...us) - u0;
  const dv = Math.max(...vs) - v0;
  return vertices.map((vertex) => ({
    u: du > 0 ? (vertex.u - u0) / du : 0.5,
    v: dv > 0 ? (vertex.v - v0) / dv : 0.5,
  }));
}

/** A regular star of `points` points, the first at the top; inner vertices at `innerRatio`. */
function star(points: number, innerRatio: number): UnitVertex[] {
  const vertices: UnitVertex[] = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? 0.5 : 0.5 * innerRatio;
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    vertices.push({ u: 0.5 + radius * Math.cos(angle), v: 0.5 + radius * Math.sin(angle) });
  }
  return fillUnitBox(vertices);
}

/** A regular polygon of `sides` sides, the first vertex at the top, filling the box. */
function polygon(sides: number): UnitVertex[] {
  const vertices: UnitVertex[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
    vertices.push({ u: 0.5 + 0.5 * Math.cos(angle), v: 0.5 + 0.5 * Math.sin(angle) });
  }
  return fillUnitBox(vertices);
}

/**
 * A rounded rectangle spanning `[u0, u1] × [v0, v1]` with corner radii `ru`, `rv` (unit units),
 * clockwise from the top edge's left end. `tail` inserts three corners into the bottom edge.
 */
function roundedRect(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  ru: number,
  rv: number,
  tail?: readonly UnitVertex[],
): UnitVertex[] {
  const ku = KAPPA * ru;
  const kv = KAPPA * rv;
  return [
    { u: u0 + ru, v: v0, inU: -ku },
    { u: u1 - ru, v: v0, outU: ku },
    { u: u1, v: v0 + rv, inV: -kv },
    { u: u1, v: v1 - rv, outV: kv },
    { u: u1 - ru, v: v1, inU: ku },
    ...(tail ?? []),
    { u: u0 + ru, v: v1, outU: -ku },
    { u: u0, v: v1 - rv, inV: kv },
    { u: u0, v: v0 + rv, outV: -kv },
  ];
}

/** A speech bubble: a rounded body over the top 78 % of the box and a tail down to the bottom left. */
function speechBubble(): UnitVertex[] {
  const bottom = 0.78;
  return roundedRect(0, 0, 1, bottom, 0.12, 0.15, [
    { u: 0.42, v: bottom },
    { u: 0.18, v: 1 },
    { u: 0.26, v: bottom },
  ]);
}

/** An arrow pointing right: a shaft 40 % of the height, a head over the last 40 % of the width. */
function arrow(): UnitVertex[] {
  return [
    { u: 0, v: 0.3 },
    { u: 0.6, v: 0.3 },
    { u: 0.6, v: 0 },
    { u: 1, v: 0.5 },
    { u: 0.6, v: 1 },
    { u: 0.6, v: 0.7 },
    { u: 0, v: 0.7 },
  ];
}

function assertBox(box: ShapePresetBox): void {
  const numbers = [box.cx, box.cy, box.width, box.height, box.rotation ?? 0];
  if (!numbers.every(Number.isFinite)) {
    throw new ShapePresetError('A shape preset needs a finite position and size in source pixels.');
  }
  if (!(box.width >= 1) || !(box.height >= 1)) {
    throw new ShapePresetError('Drag a larger box for the shape: at least one pixel each way.');
  }
}

/**
 * The closed path(s) a preset makes in `box`.
 *
 * @param preset - Which preset.
 * @param box - Where it goes, display-corrected source pixels.
 * @param options - Star points, polygon sides, star inner ratio, frame thickness.
 * @returns One path (`add`), or two for a rounded frame (outer `add`, inner `subtract`).
 * @throws {ShapePresetError} For a non-finite or sub-pixel box.
 */
export function shapePresetPaths(
  preset: MaskShapePreset,
  box: ShapePresetBox,
  options: ShapePresetOptions = {},
): ShapePresetPath[] {
  assertBox(box);
  switch (preset) {
    case 'heart':
      return [{ vertices: place(heart(), box), mode: 'add' }];
    case 'star': {
      const points = clampInteger(options.points ?? 5, MIN_SIDES, MAX_SIDES);
      const inner = Math.min(0.95, Math.max(0.1, options.innerRatio ?? 0.45));
      return [{ vertices: place(star(points, inner), box), mode: 'add' }];
    }
    case 'polygon': {
      const sides = clampInteger(options.points ?? 6, MIN_SIDES, MAX_SIDES);
      return [{ vertices: place(polygon(sides), box), mode: 'add' }];
    }
    case 'speech-bubble':
      return [{ vertices: place(speechBubble(), box), mode: 'add' }];
    case 'arrow':
      return [{ vertices: place(arrow(), box), mode: 'add' }];
    case 'rounded-frame': {
      const smaller = Math.min(box.width, box.height);
      const border = Math.min(0.45, Math.max(0.02, options.thickness ?? 0.12)) * smaller;
      // Radii in pixels, the inner ones concentric with the outer so the border stays even.
      const outerRadius = smaller * 0.18;
      const innerRadius = Math.max(0, outerRadius - border);
      const bu = border / box.width;
      const bv = border / box.height;
      const outer = roundedRect(0, 0, 1, 1, outerRadius / box.width, outerRadius / box.height);
      const inner = roundedRect(
        bu,
        bv,
        1 - bu,
        1 - bv,
        innerRadius / box.width,
        innerRadius / box.height,
      );
      return [
        { vertices: place(outer, box), mode: 'add', part: 'outer' },
        { vertices: place(inner, box), mode: 'subtract', part: 'inner' },
      ];
    }
  }
}
