/**
 * The exact, deterministic mask rasteriser: the TypeScript twin of
 * `engine/python/framepilot_engine/render/mask_raster.py` (MK3.1, ADR 0178).
 *
 * WHY a port and not an approximation: a mask edge is judged at the pixel, and the export and
 * the preview have to agree on it byte for byte (plan 10, "Rasteriser"). The engine is the
 * export, so its quantised alpha is the truth; `mask-raster.test.ts` asserts this file
 * reproduces every byte of `tests/fixtures/mask-raster/*.json` at all three resolutions.
 *
 * DETERMINISM RULES (mirrors the engine docstring; do not "simplify" any expression):
 *
 * - float64 (JS numbers) everywhere; no Float32Array in the pipeline.
 * - Plain indexed loops. Floating-point work is elementwise (`+ - * /`, `Math.sqrt`,
 *   `Math.floor`, `Math.ceil`, min/max). Accumulations are integer-valued doubles (exact
 *   below 2^53, and Q16.16 areas at preview sizes stay far below it) or `max` (exact).
 * - No `Math.hypot`/`exp`/`pow` per pixel: `linear` and `smooth` are polynomials, `gaussian`
 *   reads the shipped 4096-entry table. `cos`/`sin` run once per shape; multiples of 90
 *   degrees are exact constants.
 * - Expressions keep the engine's evaluation order (`a + (b - a) * t`, never `a*(1-t)+b*t`).
 * - The one quantisation rounds half to even (`rint`).
 */
import falloffDocument from '../../../../../engine/python/framepilot_engine/render/mask_falloff_gaussian.json' with { type: 'json' };

/** Maximum distance, in SOURCE pixels, between a flattened chord and its control points. */
export const FLATTEN_TOLERANCE = 0.02;
/** Subdivision cap, as in the engine. */
export const MAX_FLATTEN_DEPTH = 16;
/** Q16.16: one pixel of area is this many integer units. */
export const Q16_ONE = 65536;
/** Entries in the shipped gaussian falloff table. */
export const FALLOFF_TABLE_SIZE = 4096;
/** 4 (sqrt(2) - 1) / 3: the cubic control distance that best approximates a quarter circle. */
export const KAPPA = 0.5522847498307936;

export type MaskFalloff = 'linear' | 'smooth' | 'gaussian';
export type MaskCombineMode =
  'add' | 'subtract' | 'intersect' | 'difference' | 'lighten' | 'darken';

/** A mask cannot be rasterised as given (malformed geometry or unknown mode). */
export class MaskRasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskRasterError';
  }
}

// --- Paths ---------------------------------------------------------------------------------

/** One vertex of a closed cubic path; tangents are OFFSETS from the vertex. */
export interface BezierVertex {
  readonly x: number;
  readonly y: number;
  readonly inX: number;
  readonly inY: number;
  readonly outX: number;
  readonly outY: number;
  readonly feather: number | null;
}

/** A closed cubic Bezier path. `firstVertex` is where flattening starts. */
export interface BezierPath {
  readonly vertices: readonly BezierVertex[];
  readonly firstVertex: number;
}

/** A closed flattened path (`xs[n-1] === xs[0]`); `feathers` is per point, or null. */
export interface Polyline {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly feathers: Float64Array | null;
}

function vertex(
  x: number,
  y: number,
  inX = 0,
  inY = 0,
  outX = 0,
  outY = 0,
  feather: number | null = null,
): BezierVertex {
  return { x, y, inX, inY, outX, outY, feather };
}

/** Python's `%` for a positive divisor. */
function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** `(cos, sin)` of a clockwise rotation; exact for multiples of 90 degrees. */
function cosSin(degrees: number): [number, number] {
  const turns = degrees / 90.0;
  if (turns === Math.floor(turns)) {
    const quarter = floorMod(turns, 4);
    if (quarter === 0) return [1.0, 0.0];
    if (quarter === 1) return [0.0, 1.0];
    if (quarter === 2) return [-1.0, 0.0];
    return [0.0, -1.0];
  }
  const radians = (degrees * Math.PI) / 180.0;
  return [Math.cos(radians), Math.sin(radians)];
}

type LocalVertex = readonly [number, number, number, number, number, number];

function placed(
  local: readonly LocalVertex[],
  cx: number,
  cy: number,
  rotation: number,
): BezierPath {
  const [cosR, sinR] = cosSin(rotation);
  const vertices: BezierVertex[] = [];
  for (let i = 0; i < local.length; i += 1) {
    const [lx, ly, ix, iy, ox, oy] = local[i]!;
    vertices.push(
      vertex(
        cx + (cosR * lx - sinR * ly),
        cy + (sinR * lx + cosR * ly),
        cosR * ix - sinR * iy,
        sinR * ix + cosR * iy,
        cosR * ox - sinR * oy,
        sinR * ox + cosR * oy,
      ),
    );
  }
  return { vertices, firstVertex: 0 };
}

/** An ellipse as four cubic arcs, clockwise on screen (y down), starting at +x. */
export function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation = 0.0,
): BezierPath {
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return placed(
    [
      [rx, 0.0, 0.0, -ky, 0.0, ky],
      [0.0, ry, kx, 0.0, -kx, 0.0],
      [-rx, 0.0, 0.0, ky, 0.0, -ky],
      [0.0, -ry, -kx, 0.0, kx, 0.0],
    ],
    cx,
    cy,
    rotation,
  );
}

/** A rectangle; `roundness` 0..1 sets the corner radius to `roundness * min(w, h) / 2`. */
export function rectanglePath(
  cx: number,
  cy: number,
  width: number,
  height: number,
  rotation = 0.0,
  roundness = 0.0,
): BezierPath {
  const hw = width / 2.0;
  const hh = height / 2.0;
  const radius = (Math.min(Math.max(roundness, 0.0), 1.0) * Math.min(width, height)) / 2.0;
  if (radius <= 0.0) {
    return placed(
      [
        [-hw, -hh, 0.0, 0.0, 0.0, 0.0],
        [hw, -hh, 0.0, 0.0, 0.0, 0.0],
        [hw, hh, 0.0, 0.0, 0.0, 0.0],
        [-hw, hh, 0.0, 0.0, 0.0, 0.0],
      ],
      cx,
      cy,
      rotation,
    );
  }
  const k = KAPPA * radius;
  return placed(
    [
      [-hw + radius, -hh, -k, 0.0, 0.0, 0.0],
      [hw - radius, -hh, 0.0, 0.0, k, 0.0],
      [hw, -hh + radius, 0.0, -k, 0.0, 0.0],
      [hw, hh - radius, 0.0, 0.0, 0.0, k],
      [hw - radius, hh, k, 0.0, 0.0, 0.0],
      [-hw + radius, hh, 0.0, 0.0, -k, 0.0],
      [-hw, hh - radius, 0.0, k, 0.0, 0.0],
      [-hw, -hh + radius, 0.0, 0.0, 0.0, -k],
    ],
    cx,
    cy,
    rotation,
  );
}

/** A path from the schema's flat `[x, y, inX, inY, outX, outY, ...]` storage. */
export function pathFromPoints(
  points: readonly number[],
  feathers: readonly number[] | null = null,
  firstVertex = 0,
): BezierPath {
  if (points.length % 6 !== 0 || points.length < 18) {
    throw new MaskRasterError(
      'A mask path needs at least three vertices of six numbers each. Redraw the path.',
    );
  }
  const count = points.length / 6;
  if (feathers !== null && feathers.length !== count) {
    throw new MaskRasterError(
      'A mask path stores one per-vertex feather for every vertex. Redraw the path.',
    );
  }
  const vertices: BezierVertex[] = [];
  for (let i = 0; i < count; i += 1) {
    vertices.push(
      vertex(
        points[6 * i]!,
        points[6 * i + 1]!,
        points[6 * i + 2]!,
        points[6 * i + 3]!,
        points[6 * i + 4]!,
        points[6 * i + 5]!,
        feathers === null ? null : feathers[i]!,
      ),
    );
  }
  return { vertices, firstVertex: floorMod(firstVertex, count) };
}

// --- Flattening ----------------------------------------------------------------------------

function dist2ToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const qx = px - ax;
  const qy = py - ay;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0.0) return qx * qx + qy * qy;
  let t = (qx * dx + qy * dy) / length2;
  t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
  const ex = qx - t * dx;
  const ey = qy - t * dy;
  return ex * ex + ey * ey;
}

function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  t0: number,
  t1: number,
  depth: number,
  tolerance2: number,
  outX: number[],
  outY: number[],
  outT: number[],
): void {
  const flat =
    dist2ToSegment(x1, y1, x0, y0, x3, y3) <= tolerance2 &&
    dist2ToSegment(x2, y2, x0, y0, x3, y3) <= tolerance2;
  if (flat || depth >= MAX_FLATTEN_DEPTH) {
    outX.push(x3);
    outY.push(y3);
    outT.push(t1);
    return;
  }
  const ax = (x0 + x1) * 0.5;
  const ay = (y0 + y1) * 0.5;
  const bx = (x1 + x2) * 0.5;
  const by = (y1 + y2) * 0.5;
  const cx = (x2 + x3) * 0.5;
  const cy = (y2 + y3) * 0.5;
  const dx = (ax + bx) * 0.5;
  const dy = (ay + by) * 0.5;
  const ex = (bx + cx) * 0.5;
  const ey = (by + cy) * 0.5;
  const mx = (dx + ex) * 0.5;
  const my = (dy + ey) * 0.5;
  const tm = (t0 + t1) * 0.5;
  flattenCubic(x0, y0, ax, ay, dx, dy, mx, my, t0, tm, depth + 1, tolerance2, outX, outY, outT);
  flattenCubic(mx, my, ex, ey, cx, cy, x3, y3, tm, t1, depth + 1, tolerance2, outX, outY, outT);
}

/**
 * Flatten a closed path to a closed polyline (last point repeats the first).
 *
 * Per-vertex feather, when any vertex has one (null counts as 0), is interpolated by the
 * Bezier parameter: `fa + (fb - fa) * t`.
 */
export function flattenPath(path: BezierPath, tolerance = FLATTEN_TOLERANCE): Polyline {
  const vertices = path.vertices;
  const count = vertices.length;
  if (count < 2) {
    throw new MaskRasterError('A mask path needs at least three vertices. Redraw the path.');
  }
  const tolerance2 = tolerance * tolerance;
  const first = floorMod(path.firstVertex, count);
  const start = vertices[first]!;
  const xs: number[] = [start.x];
  const ys: number[] = [start.y];
  const hasFeather = vertices.some((v) => v.feather !== null);
  const feathers: number[] | null = hasFeather ? [start.feather || 0.0] : null;
  for (let step = 0; step < count; step += 1) {
    const a = vertices[(first + step) % count]!;
    const b = vertices[(first + step + 1) % count]!;
    const segX: number[] = [];
    const segY: number[] = [];
    const segT: number[] = [];
    flattenCubic(
      a.x,
      a.y,
      a.x + a.outX,
      a.y + a.outY,
      b.x + b.inX,
      b.y + b.inY,
      b.x,
      b.y,
      0.0,
      1.0,
      0,
      tolerance2,
      segX,
      segY,
      segT,
    );
    for (let i = 0; i < segX.length; i += 1) {
      xs.push(segX[i]!);
      ys.push(segY[i]!);
    }
    if (feathers !== null) {
      const fa = a.feather || 0.0;
      const fb = b.feather || 0.0;
      for (let i = 0; i < segT.length; i += 1) feathers.push(fa + (fb - fa) * segT[i]!);
    }
  }
  return {
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    feathers: feathers === null ? null : Float64Array.from(feathers),
  };
}

/** Map source-unit points to raster pixels: `X = x * scaleX + offsetX` (elementwise). */
export function toRaster(
  polyline: Polyline,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number,
): Polyline {
  const n = polyline.xs.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = polyline.xs[i]! * scaleX + offsetX;
    ys[i] = polyline.ys[i]! * scaleY + offsetY;
  }
  return { xs, ys, feathers: polyline.feathers };
}

/** Multiply per-point feathers by a raster distance scale (elementwise). */
export function scaleFeathers(polyline: Polyline, scale: number): Polyline {
  if (polyline.feathers === null) return polyline;
  const feathers = new Float64Array(polyline.feathers.length);
  for (let i = 0; i < feathers.length; i += 1) feathers[i] = polyline.feathers[i]! * scale;
  return { xs: polyline.xs, ys: polyline.ys, feathers };
}

// --- Rounding --------------------------------------------------------------------------------

/** numpy `rint`: round half to even. `value - floor(value)` is exact in float64. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// --- Coverage (Q16.16 signed area) --------------------------------------------------------------

interface SplitPoint {
  readonly t: number;
  readonly kind: number;
  readonly x: number;
  readonly y: number;
}

/** One kept segment's endpoints plus its integer crossings, ordered by `(t, kind)` (stable). */
function splitSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
): SplitPoint[] {
  const points: SplitPoint[] = [{ t: 0.0, kind: 0, x: x0, y: y0 }];
  const ymin = Math.min(y0, y1);
  const ymax = Math.max(y0, y1);
  let lo = Math.max(Math.floor(ymin) + 1.0, 0.0);
  let hi = Math.min(Math.ceil(ymax) - 1.0, height);
  let count = Math.max(hi - lo + 1.0, 0.0);
  for (let o = 0; o < count; o += 1) {
    const k = lo + o;
    const t = (k - y0) / (y1 - y0);
    points.push({ t, kind: 1, x: x0 + t * (x1 - x0), y: k });
  }
  if (x0 !== x1) {
    const xmin = Math.min(x0, x1);
    const xmax = Math.max(x0, x1);
    lo = Math.max(Math.floor(xmin) + 1.0, 0.0);
    hi = Math.min(Math.ceil(xmax) - 1.0, width);
    count = Math.max(hi - lo + 1.0, 0.0);
    for (let o = 0; o < count; o += 1) {
      const k = lo + o;
      const t = (k - x0) / (x1 - x0);
      points.push({ t, kind: 2, x: k, y: y0 + t * (y1 - y0) });
    }
  }
  points.push({ t: 1.0, kind: 3, x: x1, y: y1 });
  // Array.prototype.sort is stable (ES2019), matching numpy's lexsort tie order.
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.kind - b.kind));
  return points;
}

function segmentArrays(polyline: Polyline): {
  x0: Float64Array;
  y0: Float64Array;
  x1: Float64Array;
  y1: Float64Array;
} {
  const n = polyline.xs.length - 1;
  return {
    x0: polyline.xs.subarray(0, n),
    y0: polyline.ys.subarray(0, n),
    x1: polyline.xs.subarray(1, n + 1),
    y1: polyline.ys.subarray(1, n + 1),
  };
}

/**
 * Exact area coverage of a closed raster-px polyline, nonzero winding, clamped to 1.
 * Row-major float64 alpha. See the engine's `coverage_alpha` for the method.
 */
export function coverageAlpha(polyline: Polyline, width: number, height: number): Float64Array {
  const alpha = new Float64Array(Math.max(width, 0) * Math.max(height, 0));
  if (width <= 0 || height <= 0 || polyline.xs.length < 2) return alpha;
  const { x0, y0, x1, y1 } = segmentArrays(polyline);
  const segments = x0.length;

  const accumulated = new Float64Array(width * height);
  const present = new Uint8Array(width * height);
  const pieceKeys: number[] = [];
  const pieceOwners: number[] = [];
  let anyKept = false;
  let anyPiece = false;

  for (let s = 0; s < segments; s += 1) {
    const sy0 = y0[s]!;
    const sy1 = y1[s]!;
    if (!(sy0 !== sy1 && Math.max(sy0, sy1) > 0.0 && Math.min(sy0, sy1) < height)) continue;
    anyKept = true;
    const points = splitSegment(x0[s]!, sy0, x1[s]!, sy1, width, height);
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      // Complex-cell membership uses every piece, including zero-height ones.
      const pieceMidX = (a.x + b.x) * 0.5;
      const pieceMidY = (a.y + b.y) * 0.5;
      const cellRow = Math.floor(pieceMidY);
      const cellCol = Math.floor(Math.min(Math.max(pieceMidX, -1.0), width));
      if (cellRow >= 0.0 && cellRow < height && cellCol >= 0.0 && cellCol < width) {
        pieceKeys.push(cellRow * width + cellCol);
        pieceOwners.push(s);
      }

      const dY = roundHalfEven(b.y * Q16_ONE) - roundHalfEven(a.y * Q16_ONE);
      if (dY === 0) continue;
      const row = Math.floor((a.y + b.y) * 0.5);
      if (!(row >= 0.0 && row < height)) continue;
      const midX = (a.x + b.x) * 0.5;
      const col = Math.floor(Math.min(Math.max(midX, -1.0), width));
      if (col < width) anyPiece = true;
      if (col < 0.0) {
        accumulated[row * width] = accumulated[row * width]! + dY;
        present[row * width] = 1;
      } else if (col < width) {
        const frac = midX - col;
        const area = roundHalfEven(dY * (1.0 - frac));
        const key = row * width + col;
        accumulated[key] = accumulated[key]! + area;
        present[key] = 1;
        if (col + 1 < width) {
          accumulated[key + 1] = accumulated[key + 1]! + (dY - area);
          present[key + 1] = 1;
        }
      }
    }
  }
  // The engine returns before the complex-cell pass when no piece lands in the frame.
  if (!anyKept || !anyPiece) return alpha;

  for (let row = 0; row < height; row += 1) {
    let running = 0;
    let covered = 0.0;
    const base = row * width;
    for (let col = 0; col < width; col += 1) {
      const key = base + col;
      if (present[key] === 1) {
        running += accumulated[key]!;
        covered = Math.min(Math.abs(running), Q16_ONE) / Q16_ONE;
      }
      alpha[key] = covered;
    }
  }

  const complex = complexCells(x0, y0, x1, y1, pieceKeys, pieceOwners, width, height);
  for (let i = 0; i < complex.length; i += 1) {
    const key = complex[i]!;
    const row = Math.floor(key / width);
    alpha[key] = exactCellCoverage(x0, y0, x1, y1, row, key - row * width);
  }
  return alpha;
}

/** Cells whose net winding area may differ from nonzero coverage, as row-major keys. */
function complexCells(
  x0: Float64Array,
  y0: Float64Array,
  x1: Float64Array,
  y1: Float64Array,
  pieceKeys: number[],
  pieceOwners: number[],
  width: number,
  height: number,
): number[] {
  const count = x0.length;
  const keys = pieceKeys.slice();
  const owners = pieceOwners.slice();
  for (let segment = 0; segment < count; segment += 1) {
    const y = y0[segment]!;
    if (!(y === y1[segment]! && y >= 0.0 && y <= height)) continue;
    const first = Math.max(Math.floor(Math.min(x0[segment]!, x1[segment]!)), 0);
    const last = Math.min(Math.floor(Math.max(x0[segment]!, x1[segment]!)), width - 1);
    if (last < first) continue;
    const floorY = Math.floor(y);
    const rows = y === floorY ? [floorY, floorY - 1] : [floorY];
    for (const row of rows) {
      if (row < 0 || row >= height) continue;
      for (let col = first; col <= last; col += 1) {
        keys.push(row * width + col);
        owners.push(segment);
      }
    }
  }
  if (keys.length === 0) return [];
  const order = new Array<number>(keys.length);
  for (let i = 0; i < order.length; i += 1) order[i] = i;
  order.sort((a, b) => keys[a]! - keys[b]! || owners[a]! - owners[b]!);

  const flagged: number[] = [];
  let index = 0;
  while (index < order.length) {
    const key = keys[order[index]!]!;
    const ids: number[] = [];
    while (index < order.length && keys[order[index]!] === key) {
      const owner = owners[order[index]!]!;
      if (ids.length === 0 || ids[ids.length - 1] !== owner) ids.push(owner);
      index += 1;
    }
    if (ids.length < 2) continue;
    let gaps = 0;
    for (let i = 0; i + 1 < ids.length; i += 1) if (ids[i + 1]! - ids[i]! !== 1) gaps += 1;
    const wraps = ids[0] === 0 && ids[ids.length - 1] === count - 1;
    const contiguous = gaps === 0 || (gaps === 1 && wraps);
    if (!contiguous || (ids.length >= 3 && runMeetsItself(x0, y0, x1, y1, ids, count)))
      flagged.push(key);
  }
  return flagged;
}

function runMeetsItself(
  x0: Float64Array,
  y0: Float64Array,
  x1: Float64Array,
  y1: Float64Array,
  ids: number[],
  count: number,
): boolean {
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const gap = ids[j]! - ids[i]!;
      if (gap === 1 || gap === count - 1) continue;
      if (segmentsMeet(x0, y0, x1, y1, ids[i]!, ids[j]!)) return true;
    }
  }
  return false;
}

function orient(ux: number, uy: number, vx: number, vy: number, wx: number, wy: number): number {
  return (vx - ux) * (wy - uy) - (vy - uy) * (wx - ux);
}

function within(ux: number, uy: number, vx: number, vy: number, wx: number, wy: number): boolean {
  return (
    Math.min(ux, vx) <= wx &&
    wx <= Math.max(ux, vx) &&
    Math.min(uy, vy) <= wy &&
    wy <= Math.max(uy, vy)
  );
}

/** Whether two segments share any point (orientation test; collinear overlap counts). */
function segmentsMeet(
  x0: Float64Array,
  y0: Float64Array,
  x1: Float64Array,
  y1: Float64Array,
  p: number,
  q: number,
): boolean {
  const ax = x0[p]!;
  const ay = y0[p]!;
  const bx = x1[p]!;
  const by = y1[p]!;
  const cx = x0[q]!;
  const cy = y0[q]!;
  const dx = x1[q]!;
  const dy = y1[q]!;
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (
    ((o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0)) &&
    ((o3 > 0.0 && o4 < 0.0) || (o3 < 0.0 && o4 > 0.0))
  ) {
    return true;
  }
  return (
    (o1 === 0.0 && within(ax, ay, bx, by, cx, cy)) ||
    (o2 === 0.0 && within(ax, ay, bx, by, dx, dy)) ||
    (o3 === 0.0 && within(cx, cy, dx, dy, ax, ay)) ||
    (o4 === 0.0 && within(cx, cy, dx, dy, bx, by))
  );
}

interface WalkEntry {
  readonly xm: number;
  readonly direction: number;
  readonly segment: number;
  readonly xa: number;
  readonly xb: number;
}

/** The exact nonzero-winding area of the closed path inside pixel `(row, col)` (slab sweep). */
export function exactCellCoverage(
  x0: Float64Array,
  y0: Float64Array,
  x1: Float64Array,
  y1: Float64Array,
  row: number,
  col: number,
): number {
  const top = row;
  const bottom = top + 1.0;
  const left = col;
  const right = left + 1.0;
  const candidates: number[] = [];
  for (let s = 0; s < x0.length; s += 1) {
    if (y0[s]! !== y1[s]! && Math.min(y0[s]!, y1[s]!) < bottom && Math.max(y0[s]!, y1[s]!) > top)
      candidates.push(s);
  }
  const splits: number[] = [top, bottom];
  const reaching: number[] = [];
  for (const segment of candidates) {
    const ax = x0[segment]!;
    const ay = y0[segment]!;
    const bx = x1[segment]!;
    const by = y1[segment]!;
    if (top < ay && ay < bottom) splits.push(ay);
    if (top < by && by < bottom) splits.push(by);
    if (ax !== bx) {
      for (const k of [left, right]) {
        const t = (k - ax) / (bx - ax);
        if (0.0 < t && t < 1.0) {
          const y = ay + t * (by - ay);
          if (top < y && y < bottom) splits.push(y);
        }
      }
    }
    if (Math.min(ax, bx) <= right && Math.max(ax, bx) >= left) reaching.push(segment);
  }
  for (let i = 0; i < reaching.length; i += 1) {
    const p = reaching[i]!;
    for (let j = i + 1; j < reaching.length; j += 1) {
      const q = reaching[j]!;
      const rx = x1[p]! - x0[p]!;
      const ry = y1[p]! - y0[p]!;
      const sx = x1[q]! - x0[q]!;
      const sy = y1[q]! - y0[q]!;
      const denominator = rx * sy - ry * sx;
      if (denominator === 0.0) continue;
      const qpx = x0[q]! - x0[p]!;
      const qpy = y0[q]! - y0[p]!;
      const t = (qpx * sy - qpy * sx) / denominator;
      const u = (qpx * ry - qpy * rx) / denominator;
      if (0.0 <= t && t <= 1.0 && 0.0 <= u && u <= 1.0) {
        const x = x0[p]! + t * rx;
        const y = y0[p]! + t * ry;
        if (left <= x && x <= right && top < y && y < bottom) splits.push(y);
      }
    }
  }
  splits.sort((a, b) => a - b);
  const bounds: number[] = [];
  for (let i = 0; i < splits.length; i += 1) {
    if (i === 0 || splits[i] !== splits[i - 1]) bounds.push(splits[i]!);
  }

  let area = 0.0;
  for (let b = 0; b + 1 < bounds.length; b += 1) {
    const ya = bounds[b]!;
    const yb = bounds[b + 1]!;
    const ym = (ya + yb) * 0.5;
    let winding = 0;
    const walk: WalkEntry[] = [];
    for (const segment of candidates) {
      const ax = x0[segment]!;
      const ay = y0[segment]!;
      const bx = x1[segment]!;
      const by = y1[segment]!;
      if (!(Math.min(ay, by) <= ym && ym < Math.max(ay, by))) continue;
      const direction = by > ay ? 1 : -1;
      const xm = ax + ((ym - ay) * (bx - ax)) / (by - ay);
      if (xm < left) {
        winding += direction;
      } else if (xm <= right) {
        const xa = ax + ((ya - ay) * (bx - ax)) / (by - ay);
        const xb = ax + ((yb - ay) * (bx - ax)) / (by - ay);
        walk.push({ xm, direction, segment, xa, xb });
      }
    }
    walk.sort((p, q) =>
      p.xm < q.xm ? -1 : p.xm > q.xm ? 1 : p.direction - q.direction || p.segment - q.segment,
    );
    let lengthA = 0.0;
    let lengthB = 0.0;
    let previousA = left;
    let previousB = left;
    for (const entry of walk) {
      const currentA = Math.min(Math.max(entry.xa, left), right);
      const currentB = Math.min(Math.max(entry.xb, left), right);
      if (winding !== 0) {
        lengthA += Math.max(0.0, currentA - previousA);
        lengthB += Math.max(0.0, currentB - previousB);
      }
      previousA = currentA;
      previousB = currentB;
      winding += entry.direction;
    }
    if (winding !== 0) {
      lengthA += Math.max(0.0, right - previousA);
      lengthB += Math.max(0.0, right - previousB);
    }
    area += (lengthA + lengthB) * 0.5 * (yb - ya);
  }
  return area <= 0.0 ? 0.0 : area >= 1.0 ? 1.0 : area;
}

// --- Pixel-centre winding ----------------------------------------------------------------------

/** Whether each pixel centre is inside the closed polyline (nonzero winding), row-major. */
export function centreInside(polyline: Polyline, width: number, height: number): Uint8Array {
  const inside = new Uint8Array(width * height);
  if (polyline.xs.length < 2) return inside;
  const { x0, y0, x1, y1 } = segmentArrays(polyline);
  const rows: number[] = [];
  const crossings: number[] = [];
  const directions: number[] = [];
  for (let s = 0; s < x0.length; s += 1) {
    const ay = y0[s]!;
    const by = y1[s]!;
    if (ay === by) continue;
    const first = Math.max(Math.ceil(Math.min(ay, by) - 0.5), 0.0);
    const last = Math.min(Math.ceil(Math.max(ay, by) - 0.5) - 1.0, height - 1);
    for (let row = first; row <= last; row += 1.0) {
      const centreY = row + 0.5;
      rows.push(row);
      crossings.push(x0[s]! + ((centreY - ay) * (x1[s]! - x0[s]!)) / (by - ay));
      directions.push(by > ay ? 1 : -1);
    }
  }
  const total = rows.length;
  if (total === 0) return inside;
  const order = new Array<number>(total);
  for (let i = 0; i < total; i += 1) order[i] = i;
  order.sort((a, b) => {
    if (rows[a] !== rows[b]) return rows[a]! - rows[b]!;
    if (crossings[a]! < crossings[b]!) return -1;
    if (crossings[a]! > crossings[b]!) return 1;
    return directions[a]! - directions[b]!;
  });
  let winding = 0;
  for (let index = 0; index < total; index += 1) {
    const current = order[index]!;
    if (index === 0 || rows[current] !== rows[order[index - 1]!]) winding = 0;
    winding += directions[current]!;
    const lastInRow = index + 1 === total || rows[order[index + 1]!] !== rows[current];
    if (winding === 0 || lastInRow) continue;
    const next = order[index + 1]!;
    const start = Math.max(Math.floor(crossings[current]! - 0.5) + 1, 0);
    const stop = Math.min(Math.floor(crossings[next]! - 0.5), width - 1);
    const base = rows[current]! * width;
    for (let col = start; col <= stop; col += 1) inside[base + col] = 1;
  }
  return inside;
}

// --- Falloff -------------------------------------------------------------------------------------

let falloffTableCache: Float64Array | null = null;

/** The shipped gaussian falloff table (`mask_falloff_gaussian.json`), decoded once. */
export function gaussianFalloffTable(): Float64Array {
  if (falloffTableCache !== null) return falloffTableCache;
  const binary = atob(falloffDocument.values);
  if (binary.length !== FALLOFF_TABLE_SIZE * 8) {
    throw new MaskRasterError('The mask falloff table is damaged. Reinstall FramePilot.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const table = new Float64Array(FALLOFF_TABLE_SIZE);
  for (let i = 0; i < FALLOFF_TABLE_SIZE; i += 1) table[i] = view.getFloat64(i * 8, true);
  falloffTableCache = table;
  return table;
}

/** Falloff of `x` in `[0, 1]` (0 = outer band edge, 1 = fully inside). */
export function applyFalloff(x: number, falloff: MaskFalloff, table: Float64Array): number {
  if (falloff === 'linear') return x;
  if (falloff === 'smooth') return x * x * (3.0 - 2.0 * x);
  const position = x * (FALLOFF_TABLE_SIZE - 1);
  const index = Math.min(Math.floor(position), FALLOFF_TABLE_SIZE - 2);
  const frac = position - index;
  const low = table[index]!;
  const high = table[index + 1]!;
  return low + (high - low) * frac;
}

// --- Distance feather ------------------------------------------------------------------------

export interface DistanceParams {
  readonly expansion: number;
  readonly featherInner: number;
  readonly featherOuter: number;
  readonly falloff: MaskFalloff;
}

/** Alpha from the signed distance to the edge, for a feathered or expanded shape (raster px). */
export function distanceAlpha(
  polyline: Polyline,
  width: number,
  height: number,
  params: DistanceParams,
): Float64Array {
  const inside = centreInside(polyline, width, height);
  const alpha = new Float64Array(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = inside[i]!;
  if (polyline.xs.length < 2) return alpha;
  const { expansion, featherInner, featherOuter, falloff } = params;
  let maxOuter = featherOuter;
  if (polyline.feathers !== null) {
    maxOuter = polyline.feathers[0]!;
    for (let i = 1; i < polyline.feathers.length; i += 1)
      maxOuter = Math.max(maxOuter, polyline.feathers[i]!);
  }
  const widest = Math.max(maxOuter + expansion, featherInner - expansion, 0.0);
  const radius = widest + 1.5;
  const { x0: ax, y0: ay, x1: bx, y1: by } = segmentArrays(polyline);
  const table = falloff === 'gaussian' ? gaussianFalloffTable() : new Float64Array(0);
  const best = new Float64Array(width * height).fill(-Infinity);

  for (let s = 0; s < ax.length; s += 1) {
    const sax = ax[s]!;
    const say = ay[s]!;
    const sbx = bx[s]!;
    const sby = by[s]!;
    const fa = polyline.feathers === null ? featherOuter : polyline.feathers[s]!;
    const fb = polyline.feathers === null ? featherOuter : polyline.feathers[s + 1]!;
    const firstRow = Math.max(Math.ceil(Math.min(say, sby) - radius - 0.5), 0.0);
    const lastRow = Math.min(Math.floor(Math.max(say, sby) + radius - 0.5), height - 1);
    const dx = sbx - sax;
    const dy = sby - say;
    const flat = dy === 0.0;
    const length2 = dx * dx + dy * dy;
    const degenerate = length2 === 0.0;
    for (let row = firstRow; row <= lastRow; row += 1) {
      const centreY = row + 0.5;
      const tA = flat ? 0.0 : (centreY - radius - say) / dy;
      const tB = flat ? 1.0 : (centreY + radius - say) / dy;
      const tLo = Math.max(Math.min(tA, tB), 0.0);
      const tHi = Math.min(Math.max(tA, tB), 1.0);
      if (tLo > tHi) continue;
      const xLo = sax + tLo * dx;
      const xHi = sax + tHi * dx;
      const firstCol = Math.max(Math.ceil(Math.min(xLo, xHi) - radius - 0.5), 0.0);
      const lastCol = Math.min(Math.floor(Math.max(xLo, xHi) + radius - 0.5), width - 1);
      const qy = centreY - say;
      for (let col = firstCol; col <= lastCol; col += 1) {
        const pixel = row * width + col;
        const qx = col + 0.5 - sax;
        let t = degenerate ? 0.0 : (qx * dx + qy * dy) / length2;
        t = Math.min(Math.max(t, 0.0), 1.0);
        const ex = qx - t * dx;
        const ey = qy - t * dy;
        const distance = Math.sqrt(ex * ex + ey * ey);
        const isInside = inside[pixel] === 1;
        const signed = (isInside ? -distance : distance) - expansion;
        const outer = fa + (fb - fa) * t;
        const denominator = featherInner + outer;
        const hard = denominator === 0.0;
        let x = hard ? 0.5 - signed : (outer - signed) / denominator;
        x = Math.min(Math.max(x, 0.0), 1.0);
        const value = hard ? x : applyFalloff(x, falloff, table);
        const signedValue = isInside ? -value : value;
        if (signedValue > best[pixel]!) best[pixel] = signedValue;
      }
    }
  }

  for (let pixel = 0; pixel < best.length; pixel += 1) {
    const value = best[pixel]!;
    if (value === -Infinity) continue;
    alpha[pixel] = inside[pixel] === 1 ? -value : value;
  }
  return alpha;
}

// --- One shape, the stack, quantisation ----------------------------------------------------------

/** One mask shape ready to rasterise: a raster-px polyline and raster-px edge params. */
export interface ShapeRaster {
  readonly polyline: Polyline;
  readonly expansion: number;
  readonly featherInner: number;
  readonly featherOuter: number;
  readonly falloff: MaskFalloff;
}

/** A shape's alpha before invert/opacity: coverage when hard, distance feather otherwise. */
export function shapeAlpha(shape: ShapeRaster, width: number, height: number): Float64Array {
  const perVertex = shape.polyline.feathers;
  let noOuter = shape.featherOuter === 0.0;
  if (perVertex !== null) {
    noOuter = true;
    for (let i = 0; i < perVertex.length; i += 1) {
      if (perVertex[i] !== 0) {
        noOuter = false;
        break;
      }
    }
  }
  if (shape.expansion === 0.0 && shape.featherInner === 0.0 && noOuter) {
    return coverageAlpha(shape.polyline, width, height);
  }
  return distanceAlpha(shape.polyline, width, height, shape);
}

/** Invert (`1 - a`) then scale by opacity clamped to `[0, 1]`, in place. */
export function applyLayerAlpha(
  alpha: Float64Array,
  invert: boolean,
  opacity: number,
): Float64Array {
  const clamped = opacity <= 0.0 ? 0.0 : opacity >= 1.0 ? 1.0 : opacity;
  for (let i = 0; i < alpha.length; i += 1) {
    const base = invert ? 1.0 - alpha[i]! : alpha[i]!;
    alpha[i] = base * clamped;
  }
  return alpha;
}

/** Combine a mask into the stack result above it, in place on `accumulated`. */
export function combineInto(
  accumulated: Float64Array,
  mask: Float64Array,
  mode: MaskCombineMode,
): void {
  const n = accumulated.length;
  switch (mode) {
    case 'add':
      for (let i = 0; i < n; i += 1) accumulated[i] = Math.min(accumulated[i]! + mask[i]!, 1.0);
      return;
    case 'subtract':
      for (let i = 0; i < n; i += 1) accumulated[i] = Math.max(accumulated[i]! - mask[i]!, 0.0);
      return;
    case 'intersect':
      for (let i = 0; i < n; i += 1) accumulated[i] = accumulated[i]! * mask[i]!;
      return;
    case 'difference':
      for (let i = 0; i < n; i += 1) accumulated[i] = Math.abs(accumulated[i]! - mask[i]!);
      return;
    case 'lighten':
      for (let i = 0; i < n; i += 1) accumulated[i] = Math.max(accumulated[i]!, mask[i]!);
      return;
    case 'darken':
      for (let i = 0; i < n; i += 1) accumulated[i] = Math.min(accumulated[i]!, mask[i]!);
      return;
    default:
      throw new MaskRasterError(
        'A mask uses a combine mode this renderer does not know. Update FramePilot.',
      );
  }
}

/** The one quantisation: `rint(clamp(a, 0, 1) * 255)`, ties to even. */
export function quantizeAlpha(alpha: Float64Array): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i += 1) {
    const clamped = Math.min(Math.max(alpha[i]!, 0.0), 1.0);
    out[i] = roundHalfEven(clamped * 255.0);
  }
  return out;
}

/** A stack layer in raster px, ready to evaluate. */
export interface RasterStackLayer {
  readonly shape: ShapeRaster;
  readonly mode: MaskCombineMode;
  readonly opacity: number;
  readonly invert: boolean;
}

/** The unquantised combined alpha of a stack (starts all-zero; top layer first). */
export function stackAlpha(
  layers: readonly RasterStackLayer[],
  width: number,
  height: number,
): Float64Array {
  const accumulated = new Float64Array(width * height);
  for (const layer of layers) {
    const alpha = applyLayerAlpha(
      shapeAlpha(layer.shape, width, height),
      layer.invert,
      layer.opacity,
    );
    combineInto(accumulated, alpha, layer.mode);
  }
  return accumulated;
}

// --- Analytic kinds: split, band, gradient (MK8.1) --------------------------------------------
//
// The twin of the engine's analytic section (`mask_raster.py`): a split, a mirror band and a
// gradient are a distance to a line or a centre, evaluated per pixel centre with the same
// expressions in the same order. A hard edge is the EXACT covered area of the pixel square on the
// kept side of a straight line (`footprintCdf`); a soft one reuses the shapes' distance feather.

/** `_footprint_cdf`: fraction of a unit pixel whose projection onto a unit normal is below `x`. */
function footprintCdf(x: number, u: number, v: number): number {
  const half = (u + v) * 0.5;
  if (x <= -half) return 0.0;
  if (x >= half) return 1.0;
  const middle = 0.5 + x / v;
  if (u === 0.0) return middle;
  const lo = (v - u) * 0.5;
  const twoUV = 2.0 * u * v;
  if (x < -lo) {
    const below = x + half;
    return (below * below) / twoUV;
  }
  if (x > lo) {
    const above = half - x;
    return 1.0 - (above * above) / twoUV;
  }
  return middle;
}

/** `raster_line_normal`: the unit normal in raster px of a line at `angle` degrees (clockwise). */
export function rasterLineNormal(
  angle: number,
  scaleX: number,
  scaleY: number,
): readonly [number, number] {
  const [cosA, sinA] = cosSin(angle);
  const nx = -sinA * scaleY;
  const ny = cosA * scaleX;
  const length = Math.sqrt(nx * nx + ny * ny);
  if (length === 0.0) return [0.0, 0.0];
  return [nx / length, ny / length];
}

/** `AnalyticEdge`: a straight edge's expansion and feathers in raster px. */
interface AnalyticEdge {
  readonly expansion: number;
  readonly featherInner: number;
  readonly featherOuter: number;
  readonly falloff: MaskFalloff;
}

/** `analytic_edge`: softness / 2 joins each feather side; widths clamp at zero. */
function analyticEdge(
  distanceScale: number,
  expansion: number,
  featherInner: number,
  featherOuter: number,
  softness: number,
  falloff: MaskFalloff,
): AnalyticEdge {
  const halfSoft = Math.max(softness, 0.0) * 0.5;
  return {
    expansion: expansion * distanceScale,
    featherInner: (Math.max(featherInner, 0.0) + halfSoft) * distanceScale,
    featherOuter: (Math.max(featherOuter, 0.0) + halfSoft) * distanceScale,
    falloff,
  };
}

/** `_soft_edge_alpha` for one signed distance. */
function softEdge(signed: number, edge: AnalyticEdge, table: Float64Array): number {
  const denominator = edge.featherInner + edge.featherOuter;
  let x = (edge.featherOuter - signed) / denominator;
  x = Math.min(Math.max(x, 0.0), 1.0);
  return applyFalloff(x, edge.falloff, table);
}

/** One analytic mask in SOURCE units (`AnalyticShape`). */
export type AnalyticShape =
  | {
      readonly kind: 'linear' | 'band';
      readonly originX: number;
      readonly originY: number;
      readonly angle: number;
      /** Band only (`widthPx`); ignored by a split. */
      readonly bandWidth: number;
      readonly softness: number;
      readonly expansion: number;
      readonly featherInner: number;
      readonly featherOuter: number;
      readonly falloff: MaskFalloff;
    }
  | {
      readonly kind: 'gradient';
      readonly shape: 'linear' | 'radial';
      readonly startX: number;
      readonly startY: number;
      readonly endX: number;
      readonly endY: number;
      readonly curve: MaskFalloff;
    };

/** Source → raster mapping for an analytic mask (`RasterFrame`). */
export interface AnalyticMapping {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly distanceScale: number;
}

function gradientAlpha(
  shape: Extract<AnalyticShape, { kind: 'gradient' }>,
  width: number,
  height: number,
  map: AnalyticMapping,
): Float64Array {
  const alpha = new Float64Array(width * height);
  const table = shape.curve === 'gaussian' ? gaussianFalloffTable() : new Float64Array(0);
  const sx = shape.startX * map.scaleX + map.offsetX;
  const sy = shape.startY * map.scaleY + map.offsetY;
  if (shape.shape === 'radial') {
    const ddx = shape.endX - shape.startX;
    const ddy = shape.endY - shape.startY;
    const radius = Math.sqrt(ddx * ddx + ddy * ddy);
    const radiusX = radius * map.scaleX;
    const radiusY = radius * map.scaleY;
    if (radiusX <= 0.0 || radiusY <= 0.0) return alpha;
    for (let row = 0; row < height; row += 1) {
      const qy = (row + 0.5 - sy) / radiusY;
      for (let col = 0; col < width; col += 1) {
        const qx = (col + 0.5 - sx) / radiusX;
        const p = Math.sqrt(qx * qx + qy * qy);
        const x = Math.min(Math.max(1.0 - p, 0.0), 1.0);
        alpha[row * width + col] = applyFalloff(x, shape.curve, table);
      }
    }
    return alpha;
  }
  const ex = shape.endX * map.scaleX + map.offsetX;
  const ey = shape.endY * map.scaleY + map.offsetY;
  const dx = ex - sx;
  const dy = ey - sy;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0.0) return alpha;
  for (let row = 0; row < height; row += 1) {
    const along = (row + 0.5 - sy) * dy;
    for (let col = 0; col < width; col += 1) {
      const p = ((col + 0.5 - sx) * dx + along) / length2;
      const x = Math.min(Math.max(1.0 - p, 0.0), 1.0);
      alpha[row * width + col] = applyFalloff(x, shape.curve, table);
    }
  }
  return alpha;
}

/**
 * `analytic_alpha`: a split, band or gradient's alpha (before invert and opacity) on a
 * `width`×`height` raster. The engine evaluates `(xs - ox) * nx + (ys - oy) * ny` per pixel; the
 * row term is hoisted here, which is the same two products and one sum in the same order.
 */
export function analyticAlpha(
  shape: AnalyticShape,
  width: number,
  height: number,
  map: AnalyticMapping,
): Float64Array {
  if (width <= 0 || height <= 0) return new Float64Array(0);
  if (shape.kind === 'gradient') return gradientAlpha(shape, width, height, map);
  const alpha = new Float64Array(width * height);
  const edge = analyticEdge(
    map.distanceScale,
    shape.expansion,
    shape.featherInner,
    shape.featherOuter,
    shape.softness,
    shape.falloff,
  );
  const ox = shape.originX * map.scaleX + map.offsetX;
  const oy = shape.originY * map.scaleY + map.offsetY;
  const [nx, ny] = rasterLineNormal(shape.angle, map.scaleX, map.scaleY);
  if (nx === 0.0 && ny === 0.0) return alpha;
  const hard = edge.featherInner + edge.featherOuter === 0.0;
  const u = Math.min(Math.abs(nx), Math.abs(ny));
  const v = Math.max(Math.abs(nx), Math.abs(ny));
  const table = !hard && edge.falloff === 'gaussian' ? gaussianFalloffTable() : new Float64Array(0);
  const band = shape.kind === 'band';
  const halfWidth = Math.max(shape.bandWidth, 0.0) * map.distanceScale * 0.5;
  const reach = halfWidth + edge.expansion;
  if (band && hard && reach <= 0.0) return alpha;
  for (let row = 0; row < height; row += 1) {
    const rowTerm = (row + 0.5 - oy) * ny;
    for (let col = 0; col < width; col += 1) {
      const t = (col + 0.5 - ox) * nx + rowTerm;
      let value: number;
      if (!band) {
        value = hard
          ? footprintCdf(edge.expansion - t, u, v)
          : softEdge(t - edge.expansion, edge, table);
      } else if (hard) {
        value = footprintCdf(reach - t, u, v) - footprintCdf(-reach - t, u, v);
      } else {
        value = softEdge(Math.abs(t) - halfWidth - edge.expansion, edge, table);
      }
      alpha[row * width + col] = value;
    }
  }
  return alpha;
}
