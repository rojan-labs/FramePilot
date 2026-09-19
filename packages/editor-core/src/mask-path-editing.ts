/**
 * Pure geometry for editing masks by hand (MK4.1, plan 10 "Editing tools").
 *
 * The monitor tools (`MaskCanvasTools`) and the Inspector's typed fields turn pointer and key
 * input into NEW geometry through these functions, then commit it as one typed mask command
 * (`mask-commands.ts`). Nothing here touches a timeline, so every rule a gesture follows (how a
 * smooth tangent mirrors, where a 45° constraint lands, which segment a click hits) is testable
 * without a DOM.
 *
 * ## Units
 *
 * Everything is display-corrected source pixels (ADR 0178), the space the schema stores. Nothing
 * rounds: a vertex dragged to 812.37 px stays at 812.37 px, because a mask edge that jumps to the
 * pixel grid visibly steps when it animates.
 *
 * ## Rotation convention
 *
 * Degrees, clockwise on screen (y grows downwards): the schema's rectangle/ellipse `rotation`
 * and the rasteriser's `x' = cos·x − sin·y, y' = sin·x + cos·y` agree, so a transform box rotated
 * here draws exactly where the export cuts.
 */
import type { MaskPathVertex, PixelPoint } from './mask-geometry.js';

/** A closed path's vertices in editable form. */
export type EditablePath = readonly MaskPathVertex[];

/** Degrees → radians. */
const RADIANS_PER_DEGREE = Math.PI / 180;

/** The constraint increment for Shift while drawing a pen segment (Premiere 26.0 parity). */
export const PEN_CONSTRAIN_DEGREES = 45;

/** Samples per cubic segment when locating the nearest point before refinement. */
const NEAREST_SAMPLES_PER_SEGMENT = 16;

/** Refinement iterations of the nearest-point search (each narrows the bracket to 2/3; 60 reaches ~1e-11 of a segment). */
const NEAREST_REFINE_ITERATIONS = 60;

/** Tangent length of an auto-smoothed vertex, as a fraction of the neighbour distance. */
const AUTO_TANGENT_FRACTION = 1 / 3;

const hypot = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Rotate an offset clockwise on screen by `degrees`. */
export function rotateOffset(x: number, y: number, degrees: number): PixelPoint {
  if (degrees === 0) return { x, y };
  const radians = degrees * RADIANS_PER_DEGREE;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: cos * x - sin * y, y: sin * x + cos * y };
}

// ---------------------------------------------------------------------------
// Bezier evaluation
// ---------------------------------------------------------------------------

/** The four control points of segment `index` (vertex `index` → the next vertex, wrapping). */
export function segmentControlPoints(
  path: EditablePath,
  index: number,
): readonly [PixelPoint, PixelPoint, PixelPoint, PixelPoint] {
  const a = path[index]!;
  const b = path[(index + 1) % path.length]!;
  return [
    { x: a.x, y: a.y },
    { x: a.x + a.outX, y: a.y + a.outY },
    { x: b.x + b.inX, y: b.y + b.inY },
    { x: b.x, y: b.y },
  ];
}

/** A point on a cubic at parameter `t`. */
export function cubicPoint(
  controls: readonly [PixelPoint, PixelPoint, PixelPoint, PixelPoint],
  t: number,
): PixelPoint {
  const [p0, p1, p2, p3] = controls;
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

/** Where a click lands on the path outline. */
export interface PathHit {
  /** Segment index (vertex `segment` → the next one). */
  readonly segment: number;
  /** Parameter on that segment, 0..1. */
  readonly t: number;
  /** The nearest point on the outline. */
  readonly point: PixelPoint;
  /** Distance from the query point, source pixels. */
  readonly distance: number;
}

function distanceAt(
  controls: readonly [PixelPoint, PixelPoint, PixelPoint, PixelPoint],
  t: number,
  target: PixelPoint,
): number {
  const p = cubicPoint(controls, t);
  return hypot(p.x - target.x, p.y - target.y);
}

/**
 * The nearest point on a closed path's outline to `target`.
 *
 * Coarse sampling finds the bracket, then a ternary refinement converges on the minimum. The
 * result is accurate to far below a source pixel, which is what "click a segment to add a
 * vertex exactly there" needs.
 *
 * @returns The hit, or `null` for a path with fewer than two vertices.
 */
export function nearestPointOnPath(path: EditablePath, target: PixelPoint): PathHit | null {
  if (path.length < 2) return null;
  let best: PathHit | null = null;
  for (let segment = 0; segment < path.length; segment += 1) {
    const controls = segmentControlPoints(path, segment);
    let bestT = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample <= NEAREST_SAMPLES_PER_SEGMENT; sample += 1) {
      const t = sample / NEAREST_SAMPLES_PER_SEGMENT;
      const distance = distanceAt(controls, t, target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestT = t;
      }
    }
    let low = Math.max(0, bestT - 1 / NEAREST_SAMPLES_PER_SEGMENT);
    let high = Math.min(1, bestT + 1 / NEAREST_SAMPLES_PER_SEGMENT);
    for (let iteration = 0; iteration < NEAREST_REFINE_ITERATIONS; iteration += 1) {
      const m1 = low + (high - low) / 3;
      const m2 = high - (high - low) / 3;
      if (distanceAt(controls, m1, target) < distanceAt(controls, m2, target)) high = m2;
      else low = m1;
    }
    const t = (low + high) / 2;
    const distance = distanceAt(controls, t, target);
    if (best === null || distance < best.distance) {
      best = { segment, t, point: cubicPoint(controls, t), distance };
    }
  }
  return best;
}

/**
 * The vertex nearest `target` within `tolerance`, or `-1`.
 *
 * @param tolerance - Source pixels; the caller converts its constant screen-pixel hit radius.
 */
export function hitVertex(path: EditablePath, target: PixelPoint, tolerance: number): number {
  let found = -1;
  let bestDistance = tolerance;
  for (let index = 0; index < path.length; index += 1) {
    const vertex = path[index]!;
    const distance = hypot(vertex.x - target.x, vertex.y - target.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      found = index;
    }
  }
  return found;
}

/** Which tangent handle of which vertex a point hits. */
export interface TangentHit {
  readonly vertex: number;
  readonly side: 'in' | 'out';
}

/**
 * The tangent handle nearest `target` within `tolerance`, among the `candidates` vertices whose
 * handles are shown (the selected ones). Zero-length tangents have no handle.
 */
export function hitTangent(
  path: EditablePath,
  candidates: Iterable<number>,
  target: PixelPoint,
  tolerance: number,
): TangentHit | null {
  let found: TangentHit | null = null;
  let bestDistance = tolerance;
  for (const index of candidates) {
    const vertex = path[index];
    if (vertex === undefined) continue;
    for (const side of ['in', 'out'] as const) {
      const ox = side === 'in' ? vertex.inX : vertex.outX;
      const oy = side === 'in' ? vertex.inY : vertex.outY;
      if (ox === 0 && oy === 0) continue;
      const distance = hypot(vertex.x + ox - target.x, vertex.y + oy - target.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        found = { vertex: index, side };
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Move the chosen vertices (their tangents ride along, as offsets).
 *
 * @param indices - Vertices to move; others are returned unchanged (same object).
 */
export function moveVertices(
  path: EditablePath,
  indices: ReadonlySet<number>,
  dx: number,
  dy: number,
): MaskPathVertex[] {
  return path.map((vertex, index) =>
    indices.has(index) ? { ...vertex, x: vertex.x + dx, y: vertex.y + dy } : vertex,
  );
}

/** An affine edit of a selection about an anchor: scale, then rotate, then translate. */
export interface AnchorTransform {
  readonly anchor: PixelPoint;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Degrees, clockwise on screen. */
  readonly rotation: number;
  readonly translateX: number;
  readonly translateY: number;
}

/** The identity {@link AnchorTransform} about `anchor`. */
export const identityTransform = (anchor: PixelPoint): AnchorTransform => ({
  anchor,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  translateX: 0,
  translateY: 0,
});

/** Apply an {@link AnchorTransform} to a point. */
export function transformPoint(point: PixelPoint, transform: AnchorTransform): PixelPoint {
  const local = rotateOffset(
    (point.x - transform.anchor.x) * transform.scaleX,
    (point.y - transform.anchor.y) * transform.scaleY,
    transform.rotation,
  );
  return {
    x: transform.anchor.x + local.x + transform.translateX,
    y: transform.anchor.y + local.y + transform.translateY,
  };
}

/**
 * Transform the chosen vertices about an anchor. Tangent offsets are scaled and rotated but
 * never translated, so the curve keeps its shape under a move.
 *
 * @param indices - Vertices to transform, or `null` for the whole path.
 */
export function transformVertices(
  path: EditablePath,
  indices: ReadonlySet<number> | null,
  transform: AnchorTransform,
): MaskPathVertex[] {
  const offset = (x: number, y: number): PixelPoint =>
    rotateOffset(x * transform.scaleX, y * transform.scaleY, transform.rotation);
  return path.map((vertex, index) => {
    if (indices !== null && !indices.has(index)) return vertex;
    const moved = transformPoint(vertex, transform);
    const tangentIn = offset(vertex.inX, vertex.inY);
    const tangentOut = offset(vertex.outX, vertex.outY);
    return {
      ...vertex,
      x: moved.x,
      y: moved.y,
      inX: tangentIn.x,
      inY: tangentIn.y,
      outX: tangentOut.x,
      outY: tangentOut.y,
    };
  });
}

/**
 * Drag one tangent handle to `offset` (relative to its vertex).
 *
 * - A **smooth** vertex keeps its two tangents collinear: the opposite tangent turns to point
 *   the other way and keeps its own length (After Effects / Premiere behaviour).
 * - **Alt** (`breakTangents`) drags this tangent alone and marks the vertex `broken`.
 * - A **corner** or **broken** vertex always drags the tangent alone.
 */
export function dragTangent(
  path: EditablePath,
  index: number,
  side: 'in' | 'out',
  offset: PixelPoint,
  breakTangents: boolean,
): MaskPathVertex[] {
  return path.map((vertex, position) => {
    if (position !== index) return vertex;
    const own =
      side === 'in' ? { inX: offset.x, inY: offset.y } : { outX: offset.x, outY: offset.y };
    if (vertex.type !== 'smooth' || breakTangents) {
      return {
        ...vertex,
        ...own,
        type: vertex.type === 'smooth' ? ('broken' as const) : vertex.type,
      };
    }
    const oppositeX = side === 'in' ? vertex.outX : vertex.inX;
    const oppositeY = side === 'in' ? vertex.outY : vertex.inY;
    const length = hypot(offset.x, offset.y);
    const oppositeLength = hypot(oppositeX, oppositeY) || length;
    const scale = length === 0 ? 0 : -oppositeLength / length;
    const mirrored = { x: offset.x * scale, y: offset.y * scale };
    const opposite =
      side === 'in' ? { outX: mirrored.x, outY: mirrored.y } : { inX: mirrored.x, inY: mirrored.y };
    return { ...vertex, ...own, ...opposite };
  });
}

/**
 * Convert a vertex between corner and smooth (the Cmd/Ctrl click).
 *
 * A vertex with any tangent becomes a sharp corner (tangents removed). A corner becomes smooth
 * with tangents parallel to the line between its neighbours, each a third of the distance to
 * that neighbour, which is the Catmull-Rom tangent every editor uses for "make smooth".
 */
export function toggleVertexSmooth(path: EditablePath, index: number): MaskPathVertex[] {
  const vertex = path[index];
  if (vertex === undefined) return [...path];
  const hasTangents =
    vertex.inX !== 0 || vertex.inY !== 0 || vertex.outX !== 0 || vertex.outY !== 0;
  if (hasTangents) {
    return path.map((candidate, position) =>
      position === index
        ? { ...candidate, inX: 0, inY: 0, outX: 0, outY: 0, type: 'corner' as const }
        : candidate,
    );
  }
  const previous = path[(index - 1 + path.length) % path.length]!;
  const next = path[(index + 1) % path.length]!;
  const dirX = next.x - previous.x;
  const dirY = next.y - previous.y;
  const dirLength = hypot(dirX, dirY);
  if (dirLength === 0) return [...path];
  const ux = dirX / dirLength;
  const uy = dirY / dirLength;
  const inLength = hypot(vertex.x - previous.x, vertex.y - previous.y) * AUTO_TANGENT_FRACTION;
  const outLength = hypot(next.x - vertex.x, next.y - vertex.y) * AUTO_TANGENT_FRACTION;
  return path.map((candidate, position) =>
    position === index
      ? {
          ...candidate,
          inX: -ux * inLength,
          inY: -uy * inLength,
          outX: ux * outLength,
          outY: uy * outLength,
          type: 'smooth' as const,
        }
      : candidate,
  );
}

/**
 * Constrain `point` so the segment from `anchor` runs at a multiple of 45° (Shift while drawing
 * with the pen). The distance along the constrained direction is the projection of the pointer,
 * so the new vertex stays under the hand rather than jumping.
 */
export function constrainToAngle(
  anchor: PixelPoint,
  point: PixelPoint,
  stepDegrees: number = PEN_CONSTRAIN_DEGREES,
): PixelPoint {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (dx === 0 && dy === 0) return { x: point.x, y: point.y };
  const step = stepDegrees * RADIANS_PER_DEGREE;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = dx * ux + dy * uy;
  // Exact zeros on the axes, so a horizontal line is not 1e-14 px off horizontal.
  const cleanX = Math.abs(ux) < 1e-12 ? 0 : ux;
  const cleanY = Math.abs(uy) < 1e-12 ? 0 : uy;
  return { x: anchor.x + cleanX * along, y: anchor.y + cleanY * along };
}

/** An axis-aligned rectangle in source pixels. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle from two corners (either order). */
export function rectFromCorners(a: PixelPoint, b: PixelPoint): PixelRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Indices of the vertices inside a marquee rectangle. */
export function verticesInRect(path: EditablePath, rect: PixelRect): Set<number> {
  const inside = new Set<number>();
  path.forEach((vertex, index) => {
    if (
      vertex.x >= rect.x &&
      vertex.x <= rect.x + rect.width &&
      vertex.y >= rect.y &&
      vertex.y <= rect.y + rect.height
    ) {
      inside.add(index);
    }
  });
  return inside;
}

/** The bounding box of the chosen vertices (anchor points only), or `null` when none. */
export function verticesBounds(
  path: EditablePath,
  indices: ReadonlySet<number> | null,
): PixelRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  path.forEach((vertex, index) => {
    if (indices !== null && !indices.has(index)) return;
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  });
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A shape drawn by dragging, as the Rectangle and Ellipse tools read it. */
export interface DragBox {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The box a Rectangle/Ellipse drag describes.
 *
 * - `square` (Shift) makes width and height equal, the larger of the two, keeping the drag's
 *   direction.
 * - `fromCentre` (Alt) treats the press point as the centre instead of a corner.
 */
export function dragBox(
  start: PixelPoint,
  current: PixelPoint,
  options: { readonly square?: boolean; readonly fromCentre?: boolean } = {},
): DragBox {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (options.square === true) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (options.fromCentre === true) {
    return { cx: start.x, cy: start.y, width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return {
    cx: start.x + dx / 2,
    cy: start.y + dy / 2,
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/** What a point can snap to: whole vertical/horizontal lines and individual points. */
export interface SnapTargets {
  /** x of vertical lines (frame edges, centre). */
  readonly xs: readonly number[];
  /** y of horizontal lines. */
  readonly ys: readonly number[];
  /** Points (other masks' vertices). */
  readonly points: readonly PixelPoint[];
}

/** A snapped point and the guides that explain it. */
export interface SnapResult {
  readonly point: PixelPoint;
  /** The vertical guide the x snapped to, or `null`. */
  readonly guideX: number | null;
  readonly guideY: number | null;
  /** The point it snapped to, or `null`. */
  readonly target: PixelPoint | null;
}

/**
 * Snap a point: a vertex target within `tolerance` wins outright (both axes); otherwise each
 * axis snaps independently to the nearest line within `tolerance`.
 *
 * @param tolerance - Source pixels (the caller converts a constant screen distance).
 */
export function snapPoint(point: PixelPoint, targets: SnapTargets, tolerance: number): SnapResult {
  let bestPoint: PixelPoint | null = null;
  let bestPointDistance = tolerance;
  for (const candidate of targets.points) {
    const distance = hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance <= bestPointDistance) {
      bestPointDistance = distance;
      bestPoint = candidate;
    }
  }
  if (bestPoint !== null) {
    return {
      point: { x: bestPoint.x, y: bestPoint.y },
      guideX: null,
      guideY: null,
      target: bestPoint,
    };
  }
  const nearest = (value: number, lines: readonly number[]): number | null => {
    let found: number | null = null;
    let bestDistance = tolerance;
    for (const line of lines) {
      const distance = Math.abs(line - value);
      if (distance <= bestDistance) {
        bestDistance = distance;
        found = line;
      }
    }
    return found;
  };
  const guideX = nearest(point.x, targets.xs);
  const guideY = nearest(point.y, targets.ys);
  return {
    point: { x: guideX ?? point.x, y: guideY ?? point.y },
    guideX,
    guideY,
    target: null,
  };
}

/**
 * Frame-edge and centre lines of a picture of `size` (the Snapping targets that do not depend
 * on other masks).
 */
export function frameSnapLines(size: {
  readonly width: number;
  readonly height: number;
}): Pick<SnapTargets, 'xs' | 'ys'> {
  return { xs: [0, size.width / 2, size.width], ys: [0, size.height / 2, size.height] };
}
