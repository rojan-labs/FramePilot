/**
 * Whether the canvas engine's held frame is the shot a transition is coming FROM.
 *
 * ## Why a held frame exists at all
 *
 * A transition is stamped on butt-joined clips as an effect, not as an overlap: while the
 * incoming clip eases in, the outgoing clip has already ended. The canvas engine draws exactly
 * one source per frame, so the reveal composited against the cleared canvas — a "cross
 * dissolve" dissolved up from black and a whip pan whipped in over black, at every cut. The
 * export had the same defect for the same reason (see the render compiler's transition
 * under-layer), and a captured run's perceptual review reported it as unexpected black frames
 * at all seven of its cuts, which no edit the agent could propose would have fixed.
 *
 * The engine therefore keeps the last frame it painted for the previous segment and blits it
 * under the ramp. This module is the eligibility rule for doing so, extracted because it is
 * the part that can be wrong in a way tests can see: the drawing itself needs a real canvas,
 * but "is this the right picture to put under this cut" is arithmetic (the same split
 * `picture-transform.ts` exists for).
 */

/** The minimum a segment needs for this decision: where it starts. */
export interface HeldFrameSegment {
  readonly projectStart: number;
}

/**
 * Is `heldForSegmentStart` the segment immediately before the one starting at
 * `segmentStartSec`?
 *
 * The check matters after a seek. A held frame from an unrelated part of the timeline is not
 * the shot this cut is coming from, and painting it under the ramp would be a worse lie than
 * the black it replaces — the editor would watch one shot dissolve out of another it never
 * cut from.
 *
 * @param segments - The picture EDL, in project order.
 * @param segmentStartSec - Project start of the segment being drawn.
 * @param heldForSegmentStart - Project start of the segment the held frame came from, or
 *   `undefined` when nothing is held yet.
 * @returns True when the held frame is the immediate predecessor and may be drawn.
 */
export function heldFrameIsPreviousSegment(
  segments: readonly HeldFrameSegment[],
  segmentStartSec: number,
  heldForSegmentStart: number | undefined,
): boolean {
  if (heldForSegmentStart === undefined) return false;
  const index = segments.findIndex((segment) => segment.projectStart === segmentStartSec);
  if (index <= 0) return false;
  return segments[index - 1]!.projectStart === heldForSegmentStart;
}
