/**
 * The project frame grid: which exported frame is on screen at a playback time (PX5.5).
 *
 * The export composites the timeline at `t = k / fps` for every project frame `k` and reads, per
 * layer, the source frame its clock names at that instant (`compiler._export_source_frames`:
 * `int(sourceFps * sourceTime + 1e-5)`). Frame `k` is what the exported video shows from
 * `k / fps` until `(k + 1) / fps`. So a source faster than the project (60 fps in a 30 fps
 * project) contributes every other frame to the export, and a monitor that evaluated the plan
 * at the audio clock's continuous time would show frames the export never renders, and
 * composite every project frame twice on a 60 Hz display (the plan's layer times differ between
 * the two ticks, so "unchanged" never matched).
 *
 * Playback therefore evaluates the plan at {@link projectFrameTime}: the frame the export shows
 * at that instant, computed as `k / fps` exactly as the export computes it. A paused seek keeps
 * its exact time (the frame grab and the PX4 oracle compare arbitrary instants).
 */

/** Slack when turning a clock time into a frame index (a tick a hair before a frame boundary). */
export const FRAME_INDEX_EPSILON = 1e-6;

/** The project frame index on screen at `timeSec` (`fps` clamped to at least 1). */
export function projectFrameIndex(timeSec: number, fps: number): number {
  return Math.floor(timeSec * Math.max(1, fps) + FRAME_INDEX_EPSILON);
}

/**
 * The instant the export composites the frame on screen at `timeSec`: `k / fps`, the same
 * division the export performs, so the plan's source frames are the export's to the bit.
 */
export function projectFrameTime(timeSec: number, fps: number): number {
  const rate = Math.max(1, fps);
  return Math.max(0, projectFrameIndex(timeSec, rate)) / rate;
}
