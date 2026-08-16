/**
 * Scrub-bar geometry (revamp Phase 2, F2: "there is no scrub bar in the
 * monitor"). Pure pointer↔time math, no DOM and no React — the component is the
 * thin shell that feeds it a `DOMRect` and a `clientX`.
 *
 * Splitting it out is what makes fine-scrub testable. The interesting behaviour
 * of a scrub bar is not "did the handle move" but the arithmetic: what time a
 * pixel means, how a damped drag accumulates, and whether a snap fires. All of
 * that is decided here, against numbers, with no pointer events involved.
 */

/** The scrub track's on-screen extent, as read from `getBoundingClientRect()`. */
export interface ScrubTrack {
  /** Viewport x of the track's left edge. */
  readonly left: number;
  /** Track width in CSS pixels. */
  readonly width: number;
}

/**
 * Damping applied while a fine scrub is held: the pointer travels the full
 * distance, the playhead moves a fifth of it. Chosen so that on a 600px-wide
 * bar over a 10-minute timeline one pixel is ~0.2s normally and ~0.04s fine —
 * around a frame at 24–30fps, which is the point of the gesture.
 */
export const FINE_SCRUB_DAMPING = 0.2;

/** Clamp `value` into `[0, max]`, tolerating a zero or negative `max`. */
const clampToDuration = (value: number, max: number): number => {
  if (!(max > 0)) return 0;
  return value < 0 ? 0 : value > max ? max : value;
};

/**
 * The time under a pointer at `clientX`.
 *
 * A zero-width track (not yet laid out, or a display:none ancestor) maps
 * everything to 0 rather than dividing by zero — a scrub on an unlaid-out bar is
 * meaningless, and `NaN` reaching `seek()` would corrupt the playhead.
 */
export function timeAtPointer(clientX: number, track: ScrubTrack, durationSec: number): number {
  if (track.width <= 0) return 0;
  const fraction = (clientX - track.left) / track.width;
  return clampToDuration(fraction * durationSec, durationSec);
}

/**
 * The time for a *fine* scrub: `originTime` displaced by the damped pointer
 * travel since the gesture's origin.
 *
 * Relative to the gesture origin rather than absolute under the pointer, because
 * that is what makes the gesture usable — the playhead must not jump to the
 * pointer the instant Shift goes down, it must keep going from where it was.
 */
export function fineScrubTime(
  originTime: number,
  originClientX: number,
  clientX: number,
  track: ScrubTrack,
  durationSec: number,
  damping: number = FINE_SCRUB_DAMPING,
): number {
  if (track.width <= 0) return clampToDuration(originTime, durationSec);
  const travelFraction = (clientX - originClientX) / track.width;
  return clampToDuration(originTime + travelFraction * durationSec * damping, durationSec);
}

/**
 * `time` as a 0..1 fraction of the timeline, for positioning the handle and the
 * cut ticks. An empty timeline is 0 throughout (not `NaN`), so the bar renders
 * as an inert full-width track instead of vanishing.
 */
export function fractionOfDuration(time: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return clampToDuration(time, durationSec) / durationSec;
}

/**
 * Pull `time` onto the nearest edit point within `toleranceSec`, else leave it
 * alone. Returns the input unchanged when nothing is in range, so a caller can
 * always use the result directly.
 *
 * The tolerance is expressed in seconds (not pixels) so the caller decides how
 * it converts: the scrub bar passes a few pixels' worth at the current scale, so
 * the snap feels the same whether the bar is 300px or 1200px wide.
 */
export function snapToEditPoint(
  time: number,
  editPoints: readonly number[],
  toleranceSec: number,
): number {
  let best: number | null = null;
  let bestDistance = toleranceSec;
  for (const point of editPoints) {
    const distance = Math.abs(point - time);
    // `<=` so an exact hit at zero tolerance still snaps to itself.
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best ?? time;
}

/** Round `time` down to a whole frame — the scrub bar never lands mid-frame. */
export function quantizeToFrame(time: number, fps: number): number {
  if (!(fps > 0)) return time;
  return Math.round(time * fps) / fps;
}
