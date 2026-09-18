/**
 * What the export dialog has to say about background removal before it renders (BR6.6).
 *
 * Two different truths, read two different ways:
 *
 * - **Unchecked moments** come from the project itself. A matte's `review.flagged` is what the
 *   pipeline could not verify and the editor has not yet approved, so the count is exact and needs
 *   no IPC. Export is never blocked by it; the editor is told, and decides.
 * - **STALE and BROKEN** come from MAIN (`matteRecheckMedia`), because only main can hash the media
 *   and the artifact. Its `remedy` sentence is the engine's own (`render/mattes.py` `MATTE_REMEDIES`),
 *   carried over the wire verbatim, so the Inspector, the export dialog and the render refusal all
 *   say the same thing rather than three paraphrases.
 */
import { masksOf, type Timeline } from '@framepilot/timeline-schema';

/** One clip whose background removal still has moments nobody has looked at. */
export interface UncheckedMatte {
  readonly clipId: string;
  readonly maskId: string;
  readonly moments: number;
}

/** Every clip with flagged matte moments, and how many each has. */
export function uncheckedMattes(timeline: Timeline): UncheckedMatte[] {
  const out: UncheckedMatte[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      for (const mask of masksOf(clip)) {
        if (mask.kind !== 'matte' || !mask.enabled) continue;
        if (mask.review.flagged.length === 0) continue;
        out.push({ clipId: clip.id, maskId: mask.id, moments: mask.review.flagged.length });
      }
    }
  }
  return out;
}

/** Total flagged moments across the timeline. */
export const uncheckedMomentCount = (timeline: Timeline): number =>
  uncheckedMattes(timeline).reduce((sum, entry) => sum + entry.moments, 0);

/** The assets whose mattes are worth re-checking before an export. */
export function matteAssetIds(timeline: Timeline): string[] {
  const ids = new Set<string>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (masksOf(clip).some((mask) => mask.kind === 'matte')) ids.add(clip.assetId);
    }
  }
  return [...ids];
}

/**
 * Whether anything is on a track below `clipId`, which is what the removed area shows.
 *
 * With nothing behind it, a cut-out exports as black, and that surprise belongs in the Inspector
 * before the export rather than in the finished file.
 */
export function hasPictureBehind(timeline: Timeline, clipId: string): boolean {
  const index = timeline.tracks.findIndex((track) =>
    track.clips.some((clip) => clip.id === clipId),
  );
  if (index < 0) return false;
  const clip = timeline.tracks[index]!.clips.find((candidate) => candidate.id === clipId)!;
  // `tracks[0]` is the visual FRONT (`frame-plan.ts`), so "behind" is everything after it.
  return timeline.tracks
    .slice(index + 1)
    .some(
      (track) =>
        track.type !== 'audio' &&
        track.clips.some((other) => other.start < clip.end && other.end > clip.start),
    );
}
