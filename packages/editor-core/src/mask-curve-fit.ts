/**
 * Freehand strokes → a closed Bezier path (MK4.1 Freehand tool).
 *
 * Philip J. Schneider's algorithm, "An Algorithm for Automatically Fitting Digitized Curves"
 * (Graphics Gems, 1990), implemented here rather than taken as a dependency: it is ~150 lines,
 * deterministic, and potrace (the usual alternative) traces bitmaps, not pointer samples.
 *
 * 1. Parameterise the samples by chord length.
 * 2. Solve the least-squares cubic whose end tangents are fixed.
 * 3. If the worst sample is within tolerance, keep it; if it is close, re-parameterise by
 *    Newton-Raphson and try again; otherwise split at the worst sample, with a shared centre
 *    tangent so the join is smooth, and fit both halves.
 *
 * A closed stroke is fitted as an open run from its first sample back to itself, with the
 * tangent at that join computed from its neighbours on both sides, so the closing vertex is
 * smooth like every other.
 */
import type { MaskPathVertex, PixelPoint } from './mask-geometry.js';
import { MIN_MASK_PATH_VERTICES } from './mask-operations.js';

/** Default fitting tolerance: the worst sample may sit this far from the curve, source px. */
export const FREEHAND_FIT_TOLERANCE_PX = 2;

/** Samples closer than this to the previous kept sample are dropped (pointer jitter). */
const MIN_SAMPLE_SPACING_PX = 0.5;

/** Re-parameterisation rounds before a segment is split. */
const MAX_REPARAMETERIZE_ITERATIONS = 20;

/** A segment whose error is within this multiple of the tolerance is worth re-parameterising. */
const REPARAMETERIZE_ERROR_FACTOR = 4;

type Cubic = readonly [PixelPoint, PixelPoint, PixelPoint, PixelPoint];

const add = (a: PixelPoint, b: PixelPoint): PixelPoint => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: PixelPoint, b: PixelPoint): PixelPoint => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: PixelPoint, s: number): PixelPoint => ({ x: a.x * s, y: a.y * s });
const dot = (a: PixelPoint, b: PixelPoint): number => a.x * b.x + a.y * b.y;
const length = (a: PixelPoint): number => Math.sqrt(dot(a, a));
const normalize = (a: PixelPoint): PixelPoint => {
  const l = length(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

function bezierAt(curve: readonly PixelPoint[], t: number): PixelPoint {
  // De Casteljau on a copy: works for the cubic and its derivative curves alike.
  const points = curve.map((point) => ({ x: point.x, y: point.y }));
  for (let level = 1; level < points.length; level += 1) {
    for (let index = 0; index < points.length - level; index += 1) {
      points[index] = {
        x: (1 - t) * points[index]!.x + t * points[index + 1]!.x,
        y: (1 - t) * points[index]!.y + t * points[index + 1]!.y,
      };
    }
  }
  return points[0]!;
}

function chordLengthParameterize(
  samples: readonly PixelPoint[],
  first: number,
  last: number,
): number[] {
  const u = [0];
  for (let index = first + 1; index <= last; index += 1) {
    u.push(u[u.length - 1]! + length(sub(samples[index]!, samples[index - 1]!)));
  }
  const total = u[u.length - 1]!;
  return total === 0 ? u.map(() => 0) : u.map((value) => value / total);
}

function generateBezier(
  samples: readonly PixelPoint[],
  first: number,
  last: number,
  u: readonly number[],
  tangentStart: PixelPoint,
  tangentEnd: PixelPoint,
): Cubic {
  const p0 = samples[first]!;
  const p3 = samples[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let index = 0; index < u.length; index += 1) {
    const t = u[index]!;
    const s = 1 - t;
    const b0 = s * s * s;
    const b1 = 3 * t * s * s;
    const b2 = 3 * t * t * s;
    const b3 = t * t * t;
    const a0 = scale(tangentStart, b1);
    const a1 = scale(tangentEnd, b2);
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const residual = sub(samples[first + index]!, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a0, residual);
    x1 += dot(a1, residual);
  }
  const determinant = c00 * c11 - c01 * c01;
  const alphaStart = determinant === 0 ? 0 : (x0 * c11 - x1 * c01) / determinant;
  const alphaEnd = determinant === 0 ? 0 : (c00 * x1 - c01 * x0) / determinant;
  const segmentLength = length(sub(p3, p0));
  const epsilon = 1e-6 * segmentLength;
  if (alphaStart < epsilon || alphaEnd < epsilon) {
    // The least-squares solve degenerated (collinear or too few samples): fall back to the
    // Wu/Barsky heuristic of thirds along the fixed tangents.
    const third = segmentLength / 3;
    return [p0, add(p0, scale(tangentStart, third)), add(p3, scale(tangentEnd, third)), p3];
  }
  return [p0, add(p0, scale(tangentStart, alphaStart)), add(p3, scale(tangentEnd, alphaEnd)), p3];
}

function maxError(
  samples: readonly PixelPoint[],
  first: number,
  last: number,
  curve: Cubic,
  u: readonly number[],
): { error: number; split: number } {
  let error = 0;
  let split = Math.floor((last - first + 1) / 2) + first;
  for (let index = first + 1; index < last; index += 1) {
    const distance = dot(
      sub(bezierAt(curve, u[index - first]!), samples[index]!),
      sub(bezierAt(curve, u[index - first]!), samples[index]!),
    );
    if (distance >= error) {
      error = distance;
      split = index;
    }
  }
  return { error, split };
}

function newtonRaphsonRoot(curve: Cubic, point: PixelPoint, u: number): number {
  const d1 = [0, 1, 2].map((i) => scale(sub(curve[i + 1]!, curve[i]!), 3));
  const d2 = [0, 1].map((i) => scale(sub(d1[i + 1]!, d1[i]!), 2));
  const q = bezierAt(curve, u);
  const q1 = bezierAt(d1, u);
  const q2 = bezierAt(d2, u);
  const numerator = dot(sub(q, point), q1);
  const denominator = dot(q1, q1) + dot(sub(q, point), q2);
  if (denominator === 0) return u;
  const next = u - numerator / denominator;
  return Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : u;
}

function fitCubic(
  samples: readonly PixelPoint[],
  first: number,
  last: number,
  tangentStart: PixelPoint,
  tangentEnd: PixelPoint,
  toleranceSquared: number,
  out: Cubic[],
): void {
  if (last - first === 1) {
    const p0 = samples[first]!;
    const p3 = samples[last]!;
    const third = length(sub(p3, p0)) / 3;
    out.push([p0, add(p0, scale(tangentStart, third)), add(p3, scale(tangentEnd, third)), p3]);
    return;
  }
  let u = chordLengthParameterize(samples, first, last);
  let curve = generateBezier(samples, first, last, u, tangentStart, tangentEnd);
  let { error, split } = maxError(samples, first, last, curve, u);
  if (error < toleranceSquared) {
    out.push(curve);
    return;
  }
  if (error < toleranceSquared * REPARAMETERIZE_ERROR_FACTOR) {
    for (let iteration = 0; iteration < MAX_REPARAMETERIZE_ITERATIONS; iteration += 1) {
      const current = curve;
      u = u.map((value, index) => newtonRaphsonRoot(current, samples[first + index]!, value));
      curve = generateBezier(samples, first, last, u, tangentStart, tangentEnd);
      ({ error, split } = maxError(samples, first, last, curve, u));
      if (error < toleranceSquared) {
        out.push(curve);
        return;
      }
    }
  }
  const centre = normalize(sub(samples[split - 1]!, samples[split + 1]!));
  fitCubic(samples, first, split, tangentStart, centre, toleranceSquared, out);
  fitCubic(samples, split, last, scale(centre, -1), tangentEnd, toleranceSquared, out);
}

/** Drop jitter samples and a duplicated closing sample. */
function cleanSamples(samples: readonly PixelPoint[]): PixelPoint[] {
  const kept: PixelPoint[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const previous = kept[kept.length - 1];
    if (previous !== undefined && length(sub(sample, previous)) < MIN_SAMPLE_SPACING_PX) continue;
    kept.push({ x: sample.x, y: sample.y });
  }
  while (kept.length > 1 && length(sub(kept[kept.length - 1]!, kept[0]!)) < MIN_SAMPLE_SPACING_PX) {
    kept.pop();
  }
  return kept;
}

/** Split a cubic at `t` (de Casteljau), for paths that fit in fewer than three segments. */
function splitCubic(curve: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: PixelPoint, b: PixelPoint): PixelPoint => add(a, scale(sub(b, a), t));
  const [p0, p1, p2, p3] = curve;
  const q0 = lerp(p0, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const s = lerp(r0, r1);
  return [
    [p0, q0, r0, s],
    [s, r1, q2, p3],
  ];
}

/**
 * Fit a closed freehand stroke with cubic Beziers.
 *
 * @param samples - Pointer samples in source pixels, in drawing order (the stroke is closed
 *   from the last sample back to the first).
 * @param tolerance - Largest allowed distance between a sample and the curve, source pixels.
 * @returns Smooth vertices of a closed path (at least three), or `null` when the stroke has
 *   fewer than three distinct samples.
 */
export function fitClosedStroke(
  samples: readonly PixelPoint[],
  tolerance: number = FREEHAND_FIT_TOLERANCE_PX,
): MaskPathVertex[] | null {
  const cleaned = cleanSamples(samples);
  if (cleaned.length < MIN_MASK_PATH_VERTICES) return null;
  const closed = [...cleaned, cleaned[0]!];
  const last = closed.length - 1;
  const joinTangent = normalize(sub(cleaned[1]!, cleaned[cleaned.length - 1]!));
  const curves: Cubic[] = [];
  fitCubic(
    closed,
    0,
    last,
    joinTangent,
    scale(joinTangent, -1),
    Math.max(tolerance, Number.EPSILON) ** 2,
    curves,
  );
  while (curves.length < MIN_MASK_PATH_VERTICES) {
    // Split the longest segment in two; the curve is unchanged.
    let longest = 0;
    curves.forEach((curve, index) => {
      if (length(sub(curve[3], curve[0])) > length(sub(curves[longest]![3], curves[longest]![0]))) {
        longest = index;
      }
    });
    const [left, right] = splitCubic(curves[longest]!, 0.5);
    curves.splice(longest, 1, left, right);
  }
  return curves.map((curve, index) => {
    const previous = curves[(index - 1 + curves.length) % curves.length]!;
    return {
      x: curve[0].x,
      y: curve[0].y,
      inX: previous[2].x - curve[0].x,
      inY: previous[2].y - curve[0].y,
      outX: curve[1].x - curve[0].x,
      outY: curve[1].y - curve[0].y,
      type: 'smooth' as const,
    };
  });
}
