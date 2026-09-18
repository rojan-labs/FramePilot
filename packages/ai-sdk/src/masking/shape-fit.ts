/**
 * Deterministic shape fitters for AI masks (AM1.3).
 *
 * The model picks WHICH candidate and WHAT purpose; this file produces the shape (plan 11
 * rule 1: "the model never invents geometry"). Every function here is pure arithmetic over a
 * measurement — a detection box or a segmentation bitmap — so the same measurement always
 * yields the same mask, and the geometry validator (`geometry-provenance.ts`) can name the
 * measurement each vertex came from.
 *
 * Units: inputs are frame fractions (boxes) or a row-major bitmap (mattes); outputs are
 * display-corrected source pixels, the space `draw_mask` stores (ADR 0178).
 */
import {
  fitClosedStroke,
  type DisplaySize,
  type EllipseMaskGeometry,
  type MaskPathVertex,
  type PathMaskGeometry,
  type PixelPoint,
  type RectangleMaskGeometry,
} from '@framepilot/editor-core';

/** A box in fractions of the picture, the vocabulary detections and tracks use. */
export interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A binary bitmap as the worker protocol carries it: row-major run lengths, zero run first. */
export interface BinaryMatte {
  readonly width: number;
  readonly height: number;
  readonly counts: readonly number[];
}

/** Most vertices a fitted path may carry unless the caller asks for fewer. */
export const DEFAULT_PATH_VERTEX_BUDGET = 48;
/** Fewest vertices a budget may ask for; below this a closed path is not a region. */
export const MIN_PATH_VERTEX_BUDGET = 4;
/** First curve-fit tolerance tried, source pixels; doubled until the budget holds. */
const INITIAL_FIT_TOLERANCE_PX = 1;
/** Doublings before the fit gives up: 1 px → 4096 px covers any picture the schema admits. */
const MAX_TOLERANCE_DOUBLINGS = 12;
/**
 * A uniform ellipse's semi-axis is twice the standard deviation along that axis, which is
 * how second moments recover the radii of the shape that produced them.
 */
const ELLIPSE_SEMI_AXIS_PER_SIGMA = 2;

export type ShapeFitFailure =
  | { readonly ok: false; readonly code: 'empty_measurement'; readonly message: string }
  | { readonly ok: false; readonly code: 'invalid_measurement'; readonly message: string };

export type ShapeFitResult<G> = { readonly ok: true; readonly geometry: G } | ShapeFitFailure;

const EMPTY: ShapeFitFailure = {
  ok: false,
  code: 'empty_measurement',
  message:
    'The measurement covers no pixels, so there is no shape to fit. Pick another candidate or another frame.',
};

function invalid(message: string): ShapeFitFailure {
  return { ok: false, code: 'invalid_measurement', message };
}

function boxIsUsable(box: NormalizedBox): boolean {
  return (
    [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0
  );
}

/** Clamp a measured box to the picture; a detector may report a sliver outside it. */
function clampBox(box: NormalizedBox): NormalizedBox {
  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  return {
    x,
    y,
    width: Math.min(box.width - (x - box.x), 1 - x),
    height: Math.min(box.height - (y - box.y), 1 - y),
  };
}

/**
 * A rectangle exactly covering a measured box.
 *
 * @param box - The measured box, fractions of the picture.
 * @param size - The clip media's display-corrected size, pixels.
 */
export function rectangleFromBox(
  box: NormalizedBox,
  size: DisplaySize,
): ShapeFitResult<RectangleMaskGeometry> {
  if (!boxIsUsable(box)) return invalid('The measured box has no area.');
  const clamped = clampBox(box);
  if (clamped.width <= 0 || clamped.height <= 0) return EMPTY;
  return {
    ok: true,
    geometry: {
      kind: 'rectangle',
      cx: (clamped.x + clamped.width / 2) * size.width,
      cy: (clamped.y + clamped.height / 2) * size.height,
      width: clamped.width * size.width,
      height: clamped.height * size.height,
      rotation: 0,
      roundness: 0,
    },
  };
}

/**
 * The ellipse inscribed in a measured box. Coverage beyond the box is an INTENT (`grow`,
 * the `hide` purpose's margin), applied as expansion by the intent tables, never baked in here.
 */
export function ellipseFromBox(
  box: NormalizedBox,
  size: DisplaySize,
): ShapeFitResult<EllipseMaskGeometry> {
  const rectangle = rectangleFromBox(box, size);
  if (!rectangle.ok) return rectangle;
  const { cx, cy, width, height } = rectangle.geometry;
  return {
    ok: true,
    geometry: { kind: 'ellipse', cx, cy, rx: width / 2, ry: height / 2, rotation: 0 },
  };
}

function matteIsUsable(matte: BinaryMatte): boolean {
  if (!Number.isInteger(matte.width) || !Number.isInteger(matte.height)) return false;
  if (matte.width <= 0 || matte.height <= 0) return false;
  let total = 0;
  for (const run of matte.counts) {
    if (!Number.isInteger(run) || run < 0) return false;
    total += run;
  }
  return total === matte.width * matte.height;
}

/** Visit every horizontal span of set pixels: `(row, firstColumn, lastColumnInclusive)`. */
function forEachSpan(
  matte: BinaryMatte,
  visit: (row: number, first: number, last: number) => void,
): void {
  let index = 0;
  let value = 0;
  for (const run of matte.counts) {
    if (value === 1 && run > 0) {
      let start = index;
      const end = index + run;
      // A run may wrap across rows; split it into one span per row.
      while (start < end) {
        const row = Math.floor(start / matte.width);
        const rowEnd = Math.min(end, (row + 1) * matte.width);
        visit(row, start - row * matte.width, rowEnd - 1 - row * matte.width);
        start = rowEnd;
      }
    }
    index += run;
    value = value === 0 ? 1 : 0;
  }
}

/** The tight bounding rectangle of a measured bitmap. */
export function rectangleFromMatte(
  matte: BinaryMatte,
  size: DisplaySize,
): ShapeFitResult<RectangleMaskGeometry> {
  if (!matteIsUsable(matte)) return invalid('The measured bitmap does not match its own size.');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  forEachSpan(matte, (row, first, last) => {
    minX = Math.min(minX, first);
    maxX = Math.max(maxX, last);
    minY = Math.min(minY, row);
    maxY = Math.max(maxY, row);
  });
  if (maxX < 0) return EMPTY;
  return rectangleFromBox(
    {
      x: minX / matte.width,
      y: minY / matte.height,
      width: (maxX - minX + 1) / matte.width,
      height: (maxY - minY + 1) / matte.height,
    },
    size,
  );
}

/**
 * The ellipse with the same centroid and second moments as a measured bitmap.
 *
 * Moments rather than the bounding box, because a leaning subject's box is much larger than
 * the subject: the moment ellipse follows the lean (its rotation) and hugs the mass.
 */
export function ellipseFromMatte(
  matte: BinaryMatte,
  size: DisplaySize,
): ShapeFitResult<EllipseMaskGeometry> {
  if (!matteIsUsable(matte)) return invalid('The measured bitmap does not match its own size.');
  const scaleX = size.width / matte.width;
  const scaleY = size.height / matte.height;
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  forEachSpan(matte, (row, first, last) => {
    const n = last - first + 1;
    // Pixel centres, so a one-pixel bitmap has its centroid in the middle of that pixel.
    const y = row + 0.5;
    const sx = ((first + last) / 2 + 0.5) * n;
    // Σ (c + 0.5)² over c = first..last, in closed form.
    const sxx = sumOfSquares(last + 0.5) - sumOfSquares(first - 0.5);
    area += n;
    sumX += sx;
    sumY += y * n;
    sumXX += sxx;
    sumYY += y * y * n;
    sumXY += y * sx;
  });
  if (area === 0) return EMPTY;
  const meanX = sumX / area;
  const meanY = sumY / area;
  const varX = Math.max(sumXX / area - meanX * meanX, 0) * scaleX * scaleX;
  const varY = Math.max(sumYY / area - meanY * meanY, 0) * scaleY * scaleY;
  const covXY = (sumXY / area - meanX * meanY) * scaleX * scaleY;
  const spread = Math.sqrt(((varX - varY) / 2) ** 2 + covXY ** 2);
  const major = (varX + varY) / 2 + spread;
  const minor = Math.max((varX + varY) / 2 - spread, 0);
  const halfPixel = Math.min(scaleX, scaleY) / 2;
  return {
    ok: true,
    geometry: {
      kind: 'ellipse',
      cx: meanX * scaleX,
      cy: meanY * scaleY,
      rx: Math.max(ELLIPSE_SEMI_AXIS_PER_SIGMA * Math.sqrt(major), halfPixel),
      ry: Math.max(ELLIPSE_SEMI_AXIS_PER_SIGMA * Math.sqrt(minor), halfPixel),
      rotation: spread === 0 ? 0 : (Math.atan2(2 * covXY, varX - varY) / 2) * (180 / Math.PI),
    },
  };
}

/** Σ k² for k = 0.5, 1.5, …, `upper` (half-integers), as a difference-friendly closed form. */
function sumOfSquares(upper: number): number {
  // Σ_{j=0}^{m-1} (j + 0.5)² with m = upper + 0.5 → m(4m² − 1) / 12.
  const m = upper + 0.5;
  return (m * (4 * m * m - 1)) / 12;
}

function expand(matte: BinaryMatte): Uint8Array {
  const grid = new Uint8Array(matte.width * matte.height);
  forEachSpan(matte, (row, first, last) =>
    grid.fill(1, row * matte.width + first, row * matte.width + last + 1),
  );
  return grid;
}

/** Label of the largest 4-connected region, and a label grid (0 = background). */
function largestRegion(
  grid: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; label: number } {
  const labels = new Int32Array(grid.length);
  const stack: number[] = [];
  let next = 0;
  let best = 0;
  let bestArea = 0;
  for (let seed = 0; seed < grid.length; seed += 1) {
    if (grid[seed] !== 1 || labels[seed] !== 0) continue;
    next += 1;
    let area = 0;
    labels[seed] = next;
    stack.push(seed);
    while (stack.length > 0) {
      const at = stack.pop()!;
      area += 1;
      const x = at % width;
      const y = (at - x) / width;
      const neighbours = [
        x > 0 ? at - 1 : -1,
        x < width - 1 ? at + 1 : -1,
        y > 0 ? at - width : -1,
        y < height - 1 ? at + width : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || grid[neighbour] !== 1 || labels[neighbour] !== 0) continue;
        labels[neighbour] = next;
        stack.push(neighbour);
      }
    }
    // Strictly greater: ties keep the first region in scan order, so the choice is stable.
    if (area > bestArea) {
      bestArea = area;
      best = next;
    }
  }
  return { labels, label: best };
}

/**
 * The outer boundary of a region as pixel-corner points, by following the crack between
 * inside and outside with the region on the right-hand side of travel (clockwise on screen).
 */
function traceBoundary(
  labels: Int32Array,
  label: number,
  width: number,
  height: number,
): PixelPoint[] {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === label;
  let startX = -1;
  let startY = -1;
  for (let at = 0; at < labels.length && startX < 0; at += 1) {
    if (labels[at] === label) {
      startX = at % width;
      startY = (at - startX) / width;
    }
  }
  if (startX < 0) return [];
  // Directions: 0 east, 1 south, 2 west, 3 north. Start on the top edge of the first pixel,
  // heading east, with the region below (to the right of travel).
  const dx = [1, 0, -1, 0];
  const dy = [0, 1, 0, -1];
  const points: PixelPoint[] = [];
  let x = startX;
  let y = startY;
  let direction = 0;
  const limit = 4 * (width + 1) * (height + 1);
  for (let step = 0; step < limit; step += 1) {
    points.push({ x, y });
    const [right, left] = pixelsAhead(x, y, direction);
    if (inside(left.x, left.y)) direction = (direction + 3) % 4;
    else if (!inside(right.x, right.y)) direction = (direction + 1) % 4;
    x += dx[direction]!;
    y += dy[direction]!;
    // The start corner has no region pixel above or to its left (it is the first pixel in
    // scan order), so the boundary passes through it exactly once per loop.
    if (x === startX && y === startY) break;
  }
  return points;
}

/**
 * The two pixels just ahead of corner `(x, y)` when heading `direction`: the one on the
 * region side (right of travel) and the one on the left.
 */
function pixelsAhead(x: number, y: number, direction: number): readonly [PixelPoint, PixelPoint] {
  switch (direction) {
    case 0:
      return [
        { x, y },
        { x, y: y - 1 },
      ];
    case 1:
      return [
        { x: x - 1, y },
        { x, y },
      ];
    case 2:
      return [
        { x: x - 1, y: y - 1 },
        { x: x - 1, y },
      ];
    default:
      return [
        { x, y: y - 1 },
        { x: x - 1, y: y - 1 },
      ];
  }
}

export interface PathFitOptions {
  /** Most vertices the path may carry. */
  readonly vertexBudget?: number;
}

/**
 * A closed Bezier path around the largest region of a measured bitmap, within a vertex budget.
 *
 * The contour is measured; the only freedom is how tightly the curve follows it, and that is
 * decided by the budget alone: the tolerance starts at one source pixel and doubles until the
 * fit is small enough, so a caller asking for fewer vertices gets a looser curve, never a
 * different region.
 */
export function pathFromMatte(
  matte: BinaryMatte,
  size: DisplaySize,
  options: PathFitOptions = {},
): ShapeFitResult<PathMaskGeometry> {
  if (!matteIsUsable(matte)) return invalid('The measured bitmap does not match its own size.');
  const budget = Math.max(
    MIN_PATH_VERTEX_BUDGET,
    Math.floor(options.vertexBudget ?? DEFAULT_PATH_VERTEX_BUDGET),
  );
  const grid = expand(matte);
  const { labels, label } = largestRegion(grid, matte.width, matte.height);
  if (label === 0) return EMPTY;
  const scaleX = size.width / matte.width;
  const scaleY = size.height / matte.height;
  const contour = traceBoundary(labels, label, matte.width, matte.height).map((point) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
  }));
  let tolerance = INITIAL_FIT_TOLERANCE_PX;
  let fitted: MaskPathVertex[] | null = null;
  for (let attempt = 0; attempt <= MAX_TOLERANCE_DOUBLINGS; attempt += 1) {
    fitted = fitClosedStroke(contour, tolerance);
    if (fitted === null || fitted.length <= budget) break;
    tolerance *= 2;
  }
  if (fitted === null) return EMPTY;
  if (fitted.length > budget) {
    return invalid(
      'The outline could not be fitted within the vertex budget. Use an ellipse or a cut-out instead.',
    );
  }
  return { ok: true, geometry: { kind: 'path', vertices: fitted } };
}
