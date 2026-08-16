/**
 * Edit points — every place the sequence changes, for transport navigation
 * (revamp Phase 2, F3: "no previous/next edit point").
 *
 * ## Why this is not `listEditBoundaries`
 *
 * The revamp brief says to wire prev/next edit point "straight to
 * `listEditBoundaries`". That function is the right tool for a different
 * question. It answers **"can a transition live here?"**, so by design it
 * returns only *abutting* cuts on one track: a gap or an overlap "is not a clean
 * cut and is not offered as a transition point" (see its module note).
 *
 * Transport navigation asks a broader question — **"where does the picture
 * change?"** — and every clip start and end is such a place, whether or not a
 * transition could be applied there. Navigating with `listEditBoundaries` alone
 * would silently skip:
 *
 *  - the first clip's start and the last clip's end (no cut on the far side),
 *  - both edges of every gap (an abutting-only test rejects them),
 *  - both edges of an overlap (ditto),
 *
 * which on any timeline with a gap in it means the button visibly refuses to
 * stop at edits the user can see. So this module derives the navigation set from
 * the timeline directly. `listEditBoundaries` is still the right source for
 * *transition* affordances (Phase 8) — the two are not interchangeable.
 *
 * Pure and total: no clock, no DOM, no editor state. The transport calls
 * {@link prevEditPoint} / {@link nextEditPoint} with the live playhead.
 */
import type { Timeline } from '@framepilot/timeline-schema';

/**
 * Times closer together than this are the same edit point. Matches
 * `editor-core`'s `TIME_EPSILON` (1e-6) in spirit but is deliberately coarser:
 * this is a *navigation* tolerance, and two "cuts" a microsecond apart are one
 * stop as far as a person pressing a button is concerned. A frame at 30fps is
 * 33ms, so 1e-4 stays far below one frame and can never merge distinct edits.
 */
export const EDIT_POINT_EPSILON = 1e-4;

/**
 * Every distinct time at which the picture changes on a non-hidden track:
 * each clip's start and end, plus `0`, deduped and sorted ascending.
 *
 * Hidden tracks are excluded because they contribute nothing to the picture —
 * the same rule the monitor's own active-clip projection applies. `0` is always
 * included so navigating backwards from the first clip lands on the head of the
 * sequence rather than refusing to move.
 */
export function listEditPoints(timeline: Timeline): readonly number[] {
  const points: number[] = [0];
  for (const track of timeline.tracks) {
    if (track.hidden === true) continue;
    for (const clip of track.clips) {
      points.push(clip.start, clip.end);
    }
  }
  points.sort((a, b) => a - b);
  // Collapse duplicates (a cut contributes the outgoing end AND the incoming
  // start at the same time) and near-duplicates from frame rounding.
  const unique: number[] = [];
  for (const point of points) {
    const last = unique[unique.length - 1];
    if (last === undefined || point - last > EDIT_POINT_EPSILON) unique.push(point);
  }
  return unique;
}

/**
 * The nearest edit point strictly before `time`, or `null` when the playhead is
 * already at or before the first one.
 *
 * "Strictly before" is what makes repeated presses walk backwards instead of
 * sticking: sitting exactly on a cut, the previous edit point is the one before
 * it, not the cut itself.
 */
export function prevEditPoint(time: number, points: readonly number[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i] as number;
    if (point < time - EDIT_POINT_EPSILON) return point;
  }
  return null;
}

/**
 * The nearest edit point strictly after `time`, or `null` when the playhead is
 * already at or past the last one. Mirror of {@link prevEditPoint}.
 */
export function nextEditPoint(time: number, points: readonly number[]): number | null {
  for (const point of points) {
    if (point > time + EDIT_POINT_EPSILON) return point;
  }
  return null;
}
