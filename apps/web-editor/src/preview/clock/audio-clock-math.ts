/**
 * Pure scheduling math for the audio-master clock (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md P0 gate #4 — A/V sync).
 *
 * The audio-master-clock design point: video frame selection is slaved to
 * `AudioContext.currentTime`, never to `requestAnimationFrame`. This module
 * is the part of that design that's pure enough to unit-test without a real
 * `AudioContext` (jsdom has none) — segment placement and "what media time is
 * `ctx.currentTime` right now" are both plain arithmetic over a schedule.
 * The impure half (actually creating `AudioBufferSourceNode`s and reading
 * `ctx.currentTime`) lives in `audio-clock.ts` and is exercised by the
 * Playwright spike harness in a real browser instead.
 */

export interface ScheduledSegment {
  /** This segment's start position on the timeline's media clock, in microseconds. */
  mediaStartUs: number;
  /** Segment duration, in microseconds. */
  durationUs: number;
  /** The `AudioContext.currentTime` (seconds) at which this segment starts playing. */
  ctxStartSec: number;
}

/** A continuous project-timeline clock anchored to AudioContext time. Unlike an
 * audio-segment schedule, this keeps advancing through silent clips, images,
 * and gaps — those spans are part of the edit even when no AudioBuffer exists. */
export interface TimelineClockAnchor {
  readonly mediaStartUs: number;
  readonly ctxStartSec: number;
}

/** Place audible segments at their real project-time offsets from playback
 * start. Silent spans remain empty on the audio graph without being deleted
 * from timeline time. */
export function scheduleSegmentsOnTimeline(
  segments: readonly { mediaStartUs: number; durationUs: number }[],
  anchor: TimelineClockAnchor,
): ScheduledSegment[] {
  return segments.map((segment) => ({
    ...segment,
    ctxStartSec: anchor.ctxStartSec + (segment.mediaStartUs - anchor.mediaStartUs) / 1_000_000,
  }));
}

/** Continuous media time derived from one AudioContext anchor. Holds during the
 * small scheduling lead, then advances monotonically regardless of whether the
 * active timeline span has an audio buffer. */
export function mediaTimeUsFromAnchor(anchor: TimelineClockAnchor, ctxNowSec: number): number {
  return anchor.mediaStartUs + Math.max(0, ctxNowSec - anchor.ctxStartSec) * 1_000_000;
}

/**
 * Places segments back-to-back on the context clock starting at
 * `firstCtxStartSec`, so consecutive `AudioBufferSourceNode.start()` calls
 * are sample-accurate and gapless by construction — each segment's context
 * start is the exact sum of every prior segment's duration.
 *
 * @param segments Each segment's `{ mediaStartUs, durationUs }` (no `ctxStartSec` yet).
 * @param firstCtxStartSec The context time the first segment should start at
 *   (typically `ctx.currentTime + a small lead`, computed by the caller).
 */
export function scheduleSegmentsBackToBack(
  segments: readonly { mediaStartUs: number; durationUs: number }[],
  firstCtxStartSec: number,
): ScheduledSegment[] {
  const scheduled: ScheduledSegment[] = [];
  let ctxCursorSec = firstCtxStartSec;
  for (const seg of segments) {
    scheduled.push({ ...seg, ctxStartSec: ctxCursorSec });
    ctxCursorSec += seg.durationUs / 1_000_000;
  }
  return scheduled;
}

/** The segment active at `ctxNowSec`, or undefined if the schedule is empty. */
export function activeSegmentAt(
  schedule: readonly ScheduledSegment[],
  ctxNowSec: number,
): ScheduledSegment | undefined {
  if (schedule.length === 0) return undefined;
  // Segments are contiguous and in order (by construction); find the last
  // segment whose start is at-or-before ctxNowSec, clamping to the first/last
  // segment outside the schedule's span so the clock never goes undefined
  // mid-playback (only before the very first start or after everything ends).
  let candidate = schedule[0];
  for (const seg of schedule) {
    if (seg.ctxStartSec <= ctxNowSec) {
      candidate = seg;
    } else {
      break;
    }
  }
  return candidate;
}

/**
 * The media-clock time (microseconds) corresponding to `ctxNowSec`, derived
 * entirely from the schedule — this is what video frame selection reads
 * every presentation tick instead of keeping its own clock.
 */
export function mediaTimeUsAt(schedule: readonly ScheduledSegment[], ctxNowSec: number): number {
  const active = activeSegmentAt(schedule, ctxNowSec);
  if (!active) return 0;
  // During the scheduling lead (ctxNowSec still before the first segment's
  // ctxStartSec) the playhead HOLDS at the first segment's media start. A
  // negative elapsed would report media time before the playback start
  // position — the video side would then look up a frame that can never
  // exist (frames are decoded from the start position forward), presenting
  // nothing for the first tick(s) of every playback.
  const elapsedSec = Math.max(0, ctxNowSec - active.ctxStartSec);
  return active.mediaStartUs + elapsedSec * 1_000_000;
}

/**
 * Drift (microseconds, signed) between the video frame actually presented at
 * `ctxNowSec` and where the audio-master clock says the playhead should be —
 * the raw sample the A/V-sync gate asserts `abs(drift) <= frameDurationUs` on.
 */
export function driftUs(
  schedule: readonly ScheduledSegment[],
  ctxNowSec: number,
  presentedFrameTimestampUs: number,
): number {
  return presentedFrameTimestampUs - mediaTimeUsAt(schedule, ctxNowSec);
}
