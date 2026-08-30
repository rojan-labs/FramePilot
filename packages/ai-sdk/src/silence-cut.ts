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

/**
 * What `/analyze-silence` (and the unified `/analyze` silence entry) returns.
 *
 * `ranges` is post-filter — the engine only lists gaps at or over the requested
 * threshold. The measurement fields say what was found BELOW it, and they are what
 * make an empty `ranges` readable: without them "0 ranges" is indistinguishable from
 * "this recording has no dead air", which is how a 49.8s take holding 10.65s of it
 * across 56 gaps was reported as clean. Optional, because an older engine build (or a
 * cached v1 analysis row) does not carry them — see `noCutsNote` for that fallback.
 */
export const SilenceRangesPayloadSchema = z.object({
  assetId: z.string().min(1),
  ranges: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() })),
  reason: z.string().nullish(),
  /** Every silence the probe saw, including gaps under the requested threshold. */
  measuredCount: z.number().int().nonnegative().nullish(),
  /** The longest measured silence — the highest threshold that could ever hit. */
  longestSeconds: z.number().nonnegative().nullish(),
  /** Seconds of dead air sitting in gaps too short to report at this threshold. */
  belowThresholdSeconds: z.number().nonnegative().nullish(),
  /** The shortest gap the measurement could see at all. */
  probeFloorSeconds: z.number().nonnegative().nullish(),
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

/**
 * WHY 0.5: it is `DEFAULT_MIN_SILENCE_SECONDS` in
 * `engine/python/.../analysis/silence.py`, which is what the engine measures at when the
 * model omits the argument. At 0.8 the two disagreed — ffmpeg reported every gap over
 * 0.5s and this module then discarded everything under 0.8s, so an omitted argument
 * silently threw away measured dead air. One default, both sides.
 */
export const DEFAULT_SILENCE_CUT: SilenceCutOptions = { minSilenceSeconds: 0.5, keepSeconds: 0.15 };

export interface SilenceCut {
  readonly trackId: string;
  readonly clipId: string;
  /** Timeline seconds. */
  readonly start: number;
  readonly end: number;
}

const EPS = 1e-6;

/**
 * Shortest surviving span still worth a ripple delete (seconds, ~1.5 frames at 30fps).
 *
 * A measured silence can be clipped down to a sliver by the clip's source window or by
 * the word-safety correction. Deleting that sliver changes nothing a viewer can hear and
 * only risks micro-clips, so it is dropped — the SILENCE still qualified, the surviving
 * CUT does not.
 */
const MIN_CUT_SECONDS = 0.05;

/**
 * Pull a cut's edges out of any word they land inside (plan/system-mission P4.1).
 *
 * `silencedetect` measures energy, not speech. A trailing sibilant, a soft plosive or a
 * breath inside a sentence reads as silence, so a cut trimmed only by `keepSeconds` can
 * still open inside a word — which is exactly the rubric check `no-mid-word-cuts`, and the
 * one finding the measured dead-air run could not clear (it landed 54 edits and still
 * scored 0.75).
 *
 * The correction can only ever SHRINK the cut: a start inside a word moves to that word's
 * end, an end inside a word moves to that word's start. It never extends into speech, so
 * the worst case is that less dead air is removed — never that a word is.
 *
 * Times are the asset's own source seconds, which is the domain `project.transcript`
 * carries and the domain the rubric checks against. Returns `null` when nothing of the
 * range survives.
 */
export function wordSafeRange(
  start: number,
  end: number,
  words: readonly { readonly start: number; readonly end: number }[],
): { readonly start: number; readonly end: number } | null {
  let s = start;
  let e = end;
  for (const word of words) {
    // Strictly inside — a cut that begins exactly at a word boundary is already clean.
    if (s > word.start + EPS && s < word.end - EPS) s = word.end;
    if (e > word.start + EPS && e < word.end - EPS) e = word.start;
  }
  return e - s > EPS ? { start: s, end: e } : null;
}

function frameSnap(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

/**
 * Map source-domain silences onto the clips that play `assetId`, as timeline ranges.
 * A silence qualifies on its MEASURED length (`>= minSilenceSeconds`), is then trimmed by
 * `keepSeconds` on both sides, clipped to the clip's source window, pulled out of any word
 * it lands in, dropped if less than {@link MIN_CUT_SECONDS} survives, and snapped to the
 * project's frame grid. Speed-changed clips are skipped (their source↔timeline map is not
 * linear here).
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
        // Qualify on the MEASURED span, not the trimmed one. Testing the trimmed span
        // applied the threshold a second time — ffmpeg had already enforced it — making
        // the real floor `minSilenceSeconds + 2 * keepSeconds`: a run asking for 0.55s
        // was quietly cutting nothing under 0.85s. `keepSeconds` shrinks a cut; it must
        // never disqualify the silence.
        if (range.end - range.start < options.minSilenceSeconds - EPS) continue;
        const trimmedStart = Math.max(range.start + options.keepSeconds, clip.sourceStart);
        const trimmedEnd = Math.min(range.end - options.keepSeconds, clip.sourceEnd);
        // Never open a cut inside a spoken word, whatever the energy said.
        const safe = wordSafeRange(trimmedStart, trimmedEnd, project.transcript);
        if (safe === null) continue;
        const { start: s, end: e } = safe;
        if (e - s < MIN_CUT_SECONDS) continue;
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

/**
 * The lowest `minSilenceSeconds` the tool's schema accepts (`domain-tools/audio.ts`).
 * Suggesting anything under it would be advice the model cannot follow.
 */
const MIN_SUGGESTABLE_THRESHOLD = 0.2;

/** Seconds as the model should echo them back: `0.25`, `0.5`, never `0.25000000004`. */
function seconds(value: number, decimals = 2): string {
  return String(Number(value.toFixed(decimals)));
}

/**
 * A threshold that would actually reach the measured gaps, or `null` when none can.
 *
 * Aims comfortably UNDER the longest gap rather than at it, so the retry cannot come
 * back empty for the same reason, and rounds to a clean 0.05 step.
 */
export function suggestedThreshold(longestSeconds: number): number | null {
  const target = Math.floor((longestSeconds * 0.6) / 0.05) * 0.05;
  return target >= MIN_SUGGESTABLE_THRESHOLD ? Number(target.toFixed(2)) : null;
}

/**
 * What to tell the model when a measurement produced no cut.
 *
 * WHY: the old note read "No dead air to cut: 0 silence(s) measured, none longer than
 * 0.55s where the asset plays." `ranges.length` is a POST-FILTER count — the threshold
 * is applied inside ffmpeg's `silencedetect`, so it is 0 by construction whenever the
 * threshold overshoots. The sentence turned "none that long" into "this recording has no
 * dead air", the model raised its threshold 0.55 → 0.65 (exactly the wrong direction) and
 * abandoned dead-air removal on a 49.8s take holding 10.65s of it across 56 gaps — and
 * the sentence was then distilled into run memory as a durable footage fact.
 *
 * Every branch here reports what WAS measured and points at something reachable. None of
 * them asserts the recording is tight unless the probe floor itself came back empty.
 */
export function noCutsNote(
  payload: SilenceRangesPayload,
  options: SilenceCutOptions = DEFAULT_SILENCE_CUT,
): string {
  // The engine already said WHY it has nothing — a video-only asset has no audio to
  // measure. Its reason beats any inference drawn from an empty list. (`analyze_silence`
  // and `detect_beats` already guard this in `summarizeAnalysis`; this branch did not.)
  const reason = payload.reason?.trim();
  if (reason !== undefined && reason !== '') return reason;

  const threshold = seconds(options.minSilenceSeconds);
  if (payload.ranges.length > 0) {
    // Silences DID clear the threshold, so the threshold is not what stopped the cut:
    // they fall outside where this asset is placed, on a speed-changed clip, or every
    // candidate edge sat inside a spoken word and was pulled back.
    return (
      `Nothing cut at ${threshold}s: ${String(payload.ranges.length)} silence(s) that long were ` +
      `measured in ${payload.assetId}, but none of them survive as a cut where that asset plays — ` +
      `the covering clip is speed-changed, the silences sit outside its trimmed source window, or ` +
      `every candidate edge fell inside a spoken word. Check where ${payload.assetId} is on the ` +
      `timeline before concluding the recording is tight.`
    );
  }

  const measuredCount = payload.measuredCount ?? undefined;
  const probeFloor = payload.probeFloorSeconds ?? undefined;
  if (measuredCount === undefined) {
    // An engine build (or cached analysis row) from before the measurement fields. Say
    // what is unknown rather than inventing the confident negative back.
    return (
      `Nothing to cut at ${threshold}s in ${payload.assetId}: no gap that long was reported. That ` +
      `is NOT a finding that the recording has no dead air — gaps shorter than ${threshold}s are ` +
      `not reported at this threshold at all. Call remove_silences again with a lower ` +
      `minSilenceSeconds (0.25 is a normal short-form floor) to see what is there, or tighten ` +
      `pacing with speed ramps instead.`
    );
  }
  if (measuredCount === 0) {
    const floor = probeFloor === undefined ? '' : ` down to ${seconds(probeFloor)}s gaps`;
    return (
      `Nothing to cut in ${payload.assetId}: it was measured${floor} and has no silence at all — ` +
      `this is continuous speech. Lowering minSilenceSeconds will not find anything; tighten ` +
      `pacing with speed ramps, or cut filler words and false starts from the transcript instead.`
    );
  }

  const longest = payload.longestSeconds ?? 0;
  const below = payload.belowThresholdSeconds ?? 0;
  const suggestion = suggestedThreshold(longest);
  const measured =
    `Nothing to cut at ${threshold}s: ${String(measuredCount)} silence(s) were measured but the ` +
    `longest is ${seconds(longest, 3)}s — this speaker never pauses that long.`;
  if (suggestion === null) {
    return (
      `${measured} Every gap is under the ${seconds(MIN_SUGGESTABLE_THRESHOLD)}s minimum this tool ` +
      `accepts, so dead-air cutting cannot reach them: tighten pacing with speed ramps, or cut ` +
      `filler words and false starts from the transcript instead.`
    );
  }
  return (
    `${measured} ${seconds(below, 1)}s of dead air sits in shorter gaps; call remove_silences ` +
    `again with minSilenceSeconds: ${seconds(suggestion)} to reach it, or tighten pacing with ` +
    `speed ramps instead.`
  );
}
