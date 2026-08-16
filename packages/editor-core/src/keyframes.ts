/**
 * @framepilot/editor-core/keyframes — keyframe easing + interpolation engine.
 *
 * WHY: motion (zoom/punch-in, position, opacity, etc.) is driven by keyframes
 * with easing (PRD §6.3, PLAN Phase 5). This is the deterministic **evaluation
 * engine** that turns a clip's stored {@link Keyframe} list into a concrete
 * property value at any time — the foundation the render compiler and the editor
 * UI both consume. It is pure (no DOM, no I/O), so it is 100% unit-testable.
 *
 * It is the TS source mirrored by the Python
 * `framepilot_engine.effects.keyframes` module; the two MUST stay in sync (same
 * easing curves, same segment semantics).
 *
 * Segment semantics (matches the schema's `Keyframe.easing` doc and the Python
 * mirror): a keyframe's `easing` describes the curve **into the next keyframe**,
 * so segment `a → b` is eased by `a`'s curve. Before the first keyframe the value
 * holds at the first; after the last it holds at the last.
 */
import type { Seconds } from '@framepilot/shared-types';
import type { Keyframe } from '@framepilot/timeline-schema';

/** Easing curve names — the canonical hyphenated set shared with the schema. */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold' | 'bezier';

/**
 * Easing curves mapping normalized progress `t ∈ [0, 1]` → eased progress.
 *
 * `hold` keeps the start value across the whole segment and only snaps to the
 * end exactly at `t === 1` (so an interior keyframe still reads its own value).
 * `bezier` is the smoothstep cubic (`3t² − 2t³`); per-keyframe bezier handles are
 * a future schema addition (Keyframe has no control points today).
 */
export const EASING_FUNCTIONS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  hold: (t) => (t >= 1 ? 1 : 0),
  bezier: (t) => t * t * (3 - 2 * t),
};

/** Coerce a (possibly unknown) easing name to a known {@link Easing}. */
const resolveEasing = (easing: string): Easing =>
  Object.prototype.hasOwnProperty.call(EASING_FUNCTIONS, easing) ? (easing as Easing) : 'linear';

/**
 * Apply an easing curve to normalized progress `t` (clamped to `[0, 1]`).
 *
 * @param easing - Easing curve name; unknown names fall back to `linear`.
 * @param t - Normalized progress; values outside `[0, 1]` are clamped.
 * @returns Eased progress in `[0, 1]`.
 */
export function applyEasing(easing: string, t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return EASING_FUNCTIONS[resolveEasing(easing)](clamped);
}

// ---------------------------------------------------------------------------
// Custom bezier curves (schema v14, ADR 0089)
// ---------------------------------------------------------------------------

/** A normalized bezier control point: `[x, y]`, x along the segment. */
export type BezierHandle = readonly [number, number];

/**
 * Newton-Raphson iterations used to invert the curve's x(s).
 *
 * A **fixed** count, not "iterate until converged": the Python mirror must
 * produce bit-identical output, and a convergence test with any epsilon would
 * make the iteration count depend on rounding. Eight is comfortably enough for
 * the [0,1] domain — the residual is far below a pixel or an audio sample.
 */
const BEZIER_NEWTON_ITERATIONS = 8;

/** Below this slope Newton stalls, so the solver falls back to bisection. */
const BEZIER_MIN_SLOPE = 1e-6;

/** Bisection steps for the fallback. Fixed, for the same reason as above. */
const BEZIER_BISECTION_ITERATIONS = 20;

/** Cubic Bezier component with endpoints pinned at 0 and 1. */
function bezierComponent(a: number, b: number, s: number): number {
  const inv = 1 - s;
  return 3 * inv * inv * s * a + 3 * inv * s * s * b + s * s * s;
}

/** d/ds of {@link bezierComponent}. */
function bezierComponentSlope(a: number, b: number, s: number): number {
  const inv = 1 - s;
  return 3 * inv * inv * a + 6 * inv * s * (b - a) + 3 * s * s * (1 - b);
}

/**
 * Solve a cubic-bezier curve `y` at progress `x`, given two control points.
 *
 * The curve runs from `(0,0)` to `(1,1)`; `out` and `into` are the control points
 * (the same parametrisation as CSS `cubic-bezier(x1, y1, x2, y2)`). Because the
 * curve is parametric, `y` is not a direct function of `x` — the parameter `s`
 * satisfying `x(s) = x` has to be found first, which is what the Newton/bisection
 * pass does.
 *
 * `y` is intentionally **not clamped**: overshoot and anticipation are the whole
 * reason to draw a custom curve, and clamping them here would quietly flatten
 * exactly the effect the user asked for. Consumers that need a bounded value
 * (opacity, alpha) clamp at the point of use, as they already do.
 */
export function solveCubicBezier(out: BezierHandle, into: BezierHandle, x: number): number {
  const [x1, y1] = out;
  const [x2, y2] = into;
  // A curve whose x-control points are the identity is linear in x, so `s === x`
  // exactly — worth short-circuiting because it is the common "straight line"
  // handle configuration and the solver would only approximate it.
  if (x1 === 1 / 3 && x2 === 2 / 3) return bezierComponent(y1, y2, x);

  let s = x;
  for (let i = 0; i < BEZIER_NEWTON_ITERATIONS; i += 1) {
    const slope = bezierComponentSlope(x1, x2, s);
    if (Math.abs(slope) < BEZIER_MIN_SLOPE) break;
    s -= (bezierComponent(x1, x2, s) - x) / slope;
  }
  // Newton can leave the domain on a near-vertical curve; bisection is slower but
  // cannot, so it both rescues and bounds the answer.
  if (!(s >= 0 && s <= 1)) {
    let low = 0;
    let high = 1;
    s = x;
    for (let i = 0; i < BEZIER_BISECTION_ITERATIONS; i += 1) {
      s = (low + high) / 2;
      if (bezierComponent(x1, x2, s) < x) low = s;
      else high = s;
    }
  }
  return bezierComponent(y1, y2, s);
}

/**
 * The eased progress for the segment `left → right`.
 *
 * For every easing but `bezier` this is just {@link applyEasing}. For `bezier` it
 * is the two-sided curve the schema describes: **`left.handles.out` and
 * `right.handles.in`**, matching CSS and every animation tool.
 *
 * **When either handle is missing the result is the hardcoded smoothstep**
 * (`3t² − 2t³`) that `bezier` has always meant, so a v13 project evaluates
 * identically after the v14 migration. Falling back to linear, or to some default
 * curve, would silently rewrite every existing animation.
 */
export function segmentProgress(left: Keyframe, right: Keyframe, t: number): number {
  if (resolveEasing(left.easing) !== 'bezier') return applyEasing(left.easing, t);
  const out = left.handles?.out;
  const into = right.handles?.in;
  if (out === undefined || into === undefined) return applyEasing('bezier', t);
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return solveCubicBezier(out, into, clamped);
}

/**
 * Interpolate between `start` and `end` using `easing`.
 *
 * @param start - Value at `t === 0`.
 * @param end - Value at `t === 1`.
 * @param t - Normalized progress; values outside `[0, 1]` are clamped.
 * @param easing - Easing curve name (defaults to `linear`).
 * @returns The eased interpolated value.
 */
export function interpolate(
  start: number,
  end: number,
  t: number,
  easing: string = 'linear',
): number {
  return start + (end - start) * applyEasing(easing, t);
}

/**
 * Evaluate the animated value of `property` at `time`.
 *
 * Considers only keyframes for `property` (sorted by time). Returns `undefined`
 * when the property has no keyframes — callers treat that as "use the static
 * value". Before the first keyframe the value holds at the first; after the last
 * it holds at the last; between two keyframes it is eased by the **earlier**
 * keyframe's curve (easing is "into the next keyframe").
 *
 * @param keyframes - A clip's (or effect's) keyframe list.
 * @param property - The property to evaluate (e.g. `"scale"`).
 * @param time - Clip-relative time in seconds.
 * @returns The interpolated value, or `undefined` if the property is not animated.
 */
export function evaluateKeyframes(
  keyframes: readonly Keyframe[],
  property: string,
  time: Seconds,
): number | undefined {
  const points = keyframes.filter((k) => k.property === property).sort((a, b) => a.time - b.time);
  if (points.length === 0) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;

  // `time` is strictly within (first.time, last.time): a bracketing pair exists.
  let left = first;
  let right = last;
  for (let i = 0; i < points.length - 1; i += 1) {
    if (points[i]!.time <= time && time <= points[i + 1]!.time) {
      left = points[i]!;
      right = points[i + 1]!;
      break;
    }
  }
  // The earliest bracketing pair always has left.time < right.time here: a
  // zero-span pair would require left.time === right.time === time, but that time
  // equals an earlier keyframe's, which would have been bracketed first (or be
  // the first keyframe, returned above). So the divisor is strictly positive.
  const localT = (time - left.time) / (right.time - left.time);
  // Through `segmentProgress`, not `interpolate`, because a custom bezier needs
  // BOTH keyframes' handles — `interpolate` only ever sees the earlier one's easing
  // name and cannot express the two-sided curve.
  return left.value + (right.value - left.value) * segmentProgress(left, right, localT);
}

/** Options for {@link punchInKeyframes}. */
export interface PunchInOptions {
  /** Prefix for the derived, deterministic keyframe ids. */
  readonly idPrefix: string;
  readonly startTime: Seconds;
  readonly endTime: Seconds;
  /** Scale at `startTime` (default `1.0`). */
  readonly fromScale?: number | undefined;
  /** Scale at `endTime` (default `1.2`). */
  readonly toScale?: number | undefined;
  /** Easing curve for the ramp (default `ease-in-out`). */
  readonly easing?: Easing | undefined;
  /** Animated property name (default `"scale"`). */
  readonly property?: string | undefined;
}

/**
 * Build a two-keyframe zoom/punch-in animation (pure).
 *
 * A punch-in is the canonical "subtle zoom to add energy" move (PRD §5.3): ramp
 * `property` from `fromScale` at `startTime` to `toScale` at `endTime` with the
 * given easing. Deterministic ids are derived from `idPrefix` so the same request
 * always yields the same keyframes. The result is fed to an `add_keyframes`
 * operation by the UI/AI layer.
 *
 * @throws {RangeError} If `endTime` is not strictly after `startTime`.
 */
export function punchInKeyframes(options: PunchInOptions): Keyframe[] {
  const {
    idPrefix,
    startTime,
    endTime,
    fromScale = 1.0,
    toScale = 1.2,
    easing = 'ease-in-out',
    property = 'scale',
  } = options;
  if (endTime <= startTime) {
    throw new RangeError(`punchInKeyframes needs endTime > startTime (${startTime} → ${endTime})`);
  }
  const idFor = (time: Seconds): string => `${idPrefix}__${property}__${Math.round(time * 1000)}`;
  return [
    { id: idFor(startTime), time: startTime, property, value: fromScale, easing },
    { id: idFor(endTime), time: endTime, property, value: toScale, easing },
  ];
}
