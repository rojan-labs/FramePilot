/**
 * Speed curves — playback rate as a function of source time (schema v15, ADR 0090).
 *
 * The TS half of a parity pair; `engine/python/framepilot_engine/effects/speed_curve.py`
 * is the other. **These two must produce the same numbers**, not merely the same
 * shape, because the preview and the export both derive a clip's duration and its
 * timeline↔source mapping from here. `fixtures/speed-curve-parity.json` pins that
 * to 1e-9 in both suites, exactly as `bezier-parity.json` does for Phase 7's solver.
 *
 * ## The one idea
 *
 * A constant speed obeys ADR 0046's rule:
 *
 * ```
 * end - start === (sourceEnd - sourceStart) / speed
 * ```
 *
 * A ramp generalises it to that rule's integral form:
 *
 * ```
 * end - start === ∫ (1 / rate(s)) ds     over s ∈ [0, sourceEnd - sourceStart]
 * ```
 *
 * with the constant case falling out exactly when `rate(s)` is a constant. That is
 * the whole module: {@link integrateRate} going source → timeline, and
 * {@link sourceTimeAt} inverting it.
 *
 * ## Why the integration is fixed-step, not adaptive
 *
 * The same lesson Phase 7's bezier solver recorded, and it bites harder here. An
 * adaptive quadrature subdivides "until the error estimate is small enough", which
 * means it takes a *different number of steps* in the two languages the moment their
 * intermediate rounding differs by one ulp — and then the preview and the export
 * disagree about how long a clip is. A duration disagreement is not a cosmetic
 * drift like a slightly different ease: it desynchronises everything after the clip.
 * So: a fixed {@link SIMPSON_INTERVALS} per curve segment, in both languages,
 * forever.
 *
 * Integration is also **piecewise** — split at every control point before
 * integrating — because the rate curve has a kink at each one. Simpson's rule is
 * exact for cubics on a smooth piece and badly wrong across a corner, so the split
 * is what buys the accuracy, not the step count.
 */
import type { Clip, SpeedPoint } from '@framepilot/timeline-schema';
import { applyEasing } from './keyframes.js';

/**
 * Sub-intervals per curve segment for Simpson's rule. **Must be even** (Simpson
 * pairs its intervals) and must be identical in the Python mirror.
 *
 * 128 rather than a cheaper 64 to buy margin against {@link SPEED_EPSILON}. No fixed
 * quadrature is exactly additive across a split point, so splitting a ramped clip
 * moves each half's derived source range by the quadrature error; at 64 that error
 * is ~6e-8, uncomfortably close to the 1e-6 the validator enforces. Simpson is
 * O(h⁴), so doubling the intervals cuts it ~16x to ~4e-9 — three orders of margin,
 * for arithmetic nobody will notice.
 */
export const SIMPSON_INTERVALS = 128;

/**
 * Bisection steps when inverting the integral. Fixed, not convergence-tested, for
 * the reason in the module docstring. 60 halvings resolve a 10-minute source range
 * to well under a nanosecond, so this is precision-limited rather than step-limited.
 */
export const INVERSION_STEPS = 60;

/** Tolerance for "this duration matches the curve" — mirrors the validator's. */
export const SPEED_EPSILON = 1e-6;

/** True when the clip's rate varies, i.e. the curve is what governs its duration. */
export function hasSpeedRamp(clip: Pick<Clip, 'speedRamp'>): boolean {
  return (clip.speedRamp?.length ?? 0) > 0;
}

/**
 * The ramp's points in source-time order, with anything unusable dropped.
 *
 * Sorting here rather than trusting the stored order means a patch that appends a
 * point does not have to know where it belongs, and two points at the same source
 * time collapse to the first — a curve cannot have two rates at one instant, and
 * keeping both would make the integral depend on array order.
 */
export function normalizeRamp(points: readonly SpeedPoint[]): readonly SpeedPoint[] {
  const usable = points.filter((p) => Number.isFinite(p.sourceTime) && p.rate > 0);
  const ordered = usable.slice().sort((a, b) => a.sourceTime - b.sourceTime);
  const result: SpeedPoint[] = [];
  for (const point of ordered) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.sourceTime - point.sourceTime) < 1e-9) continue;
    result.push(point);
  }
  return result;
}

/**
 * The playback rate at clip-relative source time `s`.
 *
 * Outside the curve's own span the rate is **held** at the nearest end point rather
 * than extrapolated. Extrapolating a curve whose last two points are accelerating
 * would keep accelerating past the end of the footage and could cross zero, which
 * the schema forbids for good reason — a held rate cannot.
 */
export function rateAt(points: readonly SpeedPoint[], s: number): number {
  const ramp = normalizeRamp(points);
  if (ramp.length === 0) return 1;
  const first = ramp[0]!;
  const last = ramp[ramp.length - 1]!;
  if (s <= first.sourceTime) return first.rate;
  if (s >= last.sourceTime) return last.rate;
  // The two bounds checks above guarantee `first.sourceTime < s < last.sourceTime`,
  // so walking forward from the first pair is guaranteed to land on a `b` with
  // `s <= b.sourceTime` before `i` runs off the end of the array.
  let i = 0;
  while (ramp[i + 1]!.sourceTime < s) i += 1;
  const a = ramp[i]!;
  const b = ramp[i + 1]!;
  // `normalizeRamp` collapses any two points within 1e-9 of each other, so two
  // surviving adjacent points are always more than that apart — `span` is never
  // non-positive here.
  const span = b.sourceTime - a.sourceTime;
  const eased = applyEasing(a.easing, (s - a.sourceTime) / span);
  return a.rate + (b.rate - a.rate) * eased;
}

/** Simpson's rule for `1 / rate(s)` over one smooth piece `[from, to]`. */
function integratePiece(points: readonly SpeedPoint[], from: number, to: number): number {
  const width = to - from;
  // Unreachable: `integrateRate` (the only caller) builds `cuts` as a strictly
  // increasing sequence — `from < to` on every piece it hands here.
  /* v8 ignore next */
  if (width <= 0) return 0;
  const h = width / SIMPSON_INTERVALS;
  let total = 1 / rateAt(points, from) + 1 / rateAt(points, to);
  for (let i = 1; i < SIMPSON_INTERVALS; i += 1) {
    const weight = i % 2 === 0 ? 2 : 4;
    total += weight * (1 / rateAt(points, from + i * h));
  }
  return (total * h) / 3;
}

/**
 * Timeline seconds consumed by source seconds `[from, to]` — the integral form of
 * ADR 0046's duration rule.
 *
 * @param points - The clip's ramp (any order; normalised internally).
 * @param from - Clip-relative source seconds, inclusive.
 * @param to - Clip-relative source seconds, exclusive.
 * @returns Timeline duration, always ≥ 0 (rates are positive by schema).
 */
export function integrateRate(
  points: readonly SpeedPoint[],
  from: number,
  to: number,
): number {
  if (to <= from) return 0;
  const ramp = normalizeRamp(points);
  if (ramp.length === 0) return to - from;
  // Split at every control point inside the range: the curve has a kink at each,
  // and Simpson is exact on a smooth piece but badly wrong across a corner.
  const cuts = [from, ...ramp.map((p) => p.sourceTime).filter((t) => t > from && t < to), to];
  let total = 0;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    total += integratePiece(ramp, cuts[i]!, cuts[i + 1]!);
  }
  return total;
}

/**
 * Invert {@link integrateRate}: the source time reached after `timelineOffset`
 * timeline seconds, starting from source time `from`.
 *
 * This is the mapping the render needs — MoviePy's `time_transform` asks "which
 * source frame belongs at this output time?" — and it is why rates must be
 * positive: the integral is then strictly increasing and therefore invertible.
 *
 * @param maxSource - Clip-relative source seconds available. The result is clamped
 *   to it, so asking past the end of the footage holds the last frame rather than
 *   reading off the end of the asset.
 */
export function sourceTimeAt(
  points: readonly SpeedPoint[],
  from: number,
  timelineOffset: number,
  maxSource: number,
): number {
  if (timelineOffset <= 0) return from;
  const ramp = normalizeRamp(points);
  if (ramp.length === 0) return Math.min(maxSource, from + timelineOffset);
  if (integrateRate(ramp, from, maxSource) <= timelineOffset) return maxSource;
  let lo = from;
  let hi = maxSource;
  for (let i = 0; i < INVERSION_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (integrateRate(ramp, from, mid) < timelineOffset) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The timeline duration a clip's source range and speed settings imply, or `null`
 * when the clip is a **freeze frame** (`speed === 0`), where the source range names
 * a held frame and any timeline duration is legitimate.
 *
 * One function, used by the validator, by every edge-changing operation, and by the
 * UI's duration readout — so the four cannot disagree about what a clip's length
 * should be, which is precisely how ADR 0046's known limitation arose.
 */
export function clipTimelineDuration(clip: Clip): number | null {
  const sourceSpan = clip.sourceEnd - clip.sourceStart;
  if (hasSpeedRamp(clip)) return integrateRate(clip.speedRamp!, 0, sourceSpan);
  const speed = clip.speed ?? 1;
  if (speed === 0) return null; // freeze: no duration is derivable, none is wrong
  // Magnitude: reverse consumes the same footage backwards, which still takes
  // positive timeline time.
  return sourceSpan / Math.abs(speed);
}

/**
 * The source span that fills `timelineDuration` timeline seconds, starting from
 * clip-relative source `from` — the inverse of {@link clipTimelineDuration}, and
 * what every edge-changing operation needs to stay speed-aware.
 *
 * Returns `0` for a freeze frame: a held frame consumes no additional footage
 * however long it is held, which is what makes trimming a freeze safe.
 */
export function sourceSpanForDuration(
  clip: Clip,
  from: number,
  timelineDuration: number,
): number {
  if (timelineDuration <= 0) return 0;
  if (hasSpeedRamp(clip)) {
    const available = clip.sourceEnd - clip.sourceStart;
    return sourceTimeAt(clip.speedRamp!, from, timelineDuration, available) - from;
  }
  const speed = clip.speed ?? 1;
  if (speed === 0) return 0;
  return timelineDuration * Math.abs(speed);
}
