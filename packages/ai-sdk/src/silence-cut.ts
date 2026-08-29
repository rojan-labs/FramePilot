/**
 * @framepilot/ai-sdk/silence-cut — turn measured silences into timeline cuts
 * (plan/system-mission P4.1, the `remove_silences` semantic operation).
 *
 * WHY: every "remove the dead air" run in the baseline died the same way — `analyze_silence`
 * found ~110 ranges and the model then tried to echo 110 `delete_range` calls back through
 * an 8k output window. The ranges are already known to the runtime; mapping them onto the
 * clips that play that asset and issuing the ripple deletes is arithmetic, not judgement.
 * The model decides *that* dead air goes and how much breath to keep; this module does the
 * rest. Pure.
 */
import { z } from 'zod/v4';
import type { Clip, Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';

export const SilenceRangesPayloadSchema = z.object({
  assetId: z.string().min(1),
  ranges: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() })),
  reason: z.string().nullish(),
});
export type SilenceRangesPayload = z.infer<typeof SilenceRangesPayloadSchema>;

export interface SilenceCutOptions {
  /** Only silences at least this long are cut (seconds). */
  readonly minSilenceSeconds: number;
  /** Breath kept on each side of a cut (seconds), so words never touch. */
  readonly keepSeconds: number;
  /** Restrict to one track; default: every picture/audio track that plays the asset. */
  readonly trackId?: string;
}

export const DEFAULT_SILENCE_CUT: SilenceCutOptions = { minSilenceSeconds: 0.8, keepSeconds: 0.15 };

export interface SilenceCut {
  readonly trackId: string;
  readonly clipId: string;
  /** Timeline seconds. */
  readonly start: number;
  readonly end: number;
}

const EPS = 1e-6;

function frameSnap(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

/**
 * Map source-domain silences onto the clips that play `assetId`, as timeline ranges.
 * A silence is trimmed by `keepSeconds` on both sides, clipped to the clip's source
 * window, dropped when shorter than `minSilenceSeconds` after trimming, and snapped to
 * the project's frame grid. Speed-changed clips are skipped (their source↔timeline map is
 * not linear here).
 */
export function silenceCuts(
  project: Project,
  payload: SilenceRangesPayload,
  options: SilenceCutOptions = DEFAULT_SILENCE_CUT,
): SilenceCut[] {
  const cuts: SilenceCut[] = [];
  for (const track of project.timeline.tracks) {
    if (options.trackId && track.id !== options.trackId) continue;
    for (const clip of track.clips as readonly Clip[]) {
      if (clip.assetId !== payload.assetId) continue;
      const speed = (clip as { speed?: number }).speed ?? 1;
      if (speed !== 1) continue;
      for (const range of payload.ranges) {
        const s = Math.max(range.start + options.keepSeconds, clip.sourceStart);
        const e = Math.min(range.end - options.keepSeconds, clip.sourceEnd);
        if (e - s < options.minSilenceSeconds - EPS) continue;
        const start = frameSnap(clip.start + (s - clip.sourceStart), project.fps);
        const end = frameSnap(clip.start + (e - clip.sourceStart), project.fps);
        if (end - start <= EPS) continue;
        cuts.push({ trackId: track.id, clipId: clip.id, start, end });
      }
    }
  }
  return cuts;
}

/**
 * Ripple deletes for the cuts, ordered **last to first** so each delete leaves every
 * earlier timeline position untouched. Returns the ops and the seconds removed.
 */
export function silenceCutOps(
  project: Project,
  payload: SilenceRangesPayload,
  options: SilenceCutOptions = DEFAULT_SILENCE_CUT,
): { ops: AnyOperation[]; cuts: SilenceCut[]; removedSeconds: number } {
  const cuts = silenceCuts(project, payload, options).sort((a, b) => b.start - a.start);
  const ops: AnyOperation[] = cuts.map((cut) => ({
    type: 'ripple_delete',
    trackId: cut.trackId,
    start: cut.start,
    end: cut.end,
  }));
  const removedSeconds = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
  return { ops, cuts, removedSeconds };
}
