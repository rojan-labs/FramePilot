/**
 * Verification of enhancement work against committed timeline state.
 *
 * ## WHY this module exists
 *
 * The agent used to report captions and transitions as complete on the strength
 * of the tool results alone: `add_caption_layer` returned `applied`, so captions
 * were "in place"; `add_transition` returned `applied`, so the transition was
 * "added". Both claims were false in the same run — the captions carried source
 * timestamps and the transition sat where there was no cut — and nothing in the
 * system could contradict them, because nothing ever looked.
 *
 * An operation returning "applied" says the patch was accepted. It says nothing
 * about whether the resulting object is in the right place, at the right time,
 * against the current revision, or visible at all. These functions look.
 *
 * Every issue carries enough detail to act on rather than a bare failure: which
 * cue, at which time, off by how much, and against what. A verification that
 * only says "something is wrong" produces another guess.
 *
 * @see docs/adr/0076-canonical-timeline-mapping.md
 */
import {
  buildTimelineMap,
  listEditBoundaries,
  mapTranscript,
  readTransitionAt,
  transitionEligibility,
  type MappedWord,
  type TimelineMap,
} from '@framepilot/editor-core';
import type { Clip, Project, Track } from '@framepilot/timeline-schema';

/**
 * How far a caption may sit from the word it captions before it counts as out of
 * sync, in seconds.
 *
 * Two frames at 24fps (~83ms). Tighter than that and ordinary frame rounding
 * reads as an error; looser and a genuinely late caption passes. Broadcast
 * subtitle practice tolerates more, but short-form captions are read
 * word-by-word, where drift is obvious.
 */
export const DEFAULT_CAPTION_TOLERANCE_SECONDS = 0.084;

/** One concrete, actionable problem found during verification. */
export interface VerificationIssue {
  /** Stable machine code, for callers that branch on the kind of problem. */
  readonly code: string;
  /** Plain-language description naming the object, the time, and the amount. */
  readonly detail: string;
  /** The clip the problem is on, when it is about one clip. */
  readonly clipId?: string;
  /** Sequence time the problem occurs at, when it has one. */
  readonly at?: number;
}

/** The outcome of a verification pass. `ok` means nothing was found. */
export interface VerificationReport {
  readonly ok: boolean;
  readonly issues: readonly VerificationIssue[];
}

/** Caption-specific report: how much was checked, and what was wrong with it. */
export interface CaptionVerificationReport extends VerificationReport {
  readonly cueCount: number;
  /** Fraction of retained speech time covered by a caption, 0..1. */
  readonly speechCoverage: number;
  /** The timeline revision the check ran against. */
  readonly revision: number;
}

/** Transition-specific report. */
export interface TransitionVerificationReport extends VerificationReport {
  readonly transitionCount: number;
  /** Cuts in the sequence, for context on what was and was not treated. */
  readonly boundaryCount: number;
}

const captionTracks = (project: Project): readonly Track[] =>
  project.timeline.tracks.filter((t) => t.type === 'caption' || t.type === 'overlay');

/**
 * Caption tracks may legitimately be overlay tracks, but overlay tracks also carry
 * titles and lower thirds. Counting every clip on them made a title card look like a
 * second lyric cue in verification. The synthetic asset/effect identity is the stable
 * cross-version discriminator used by preview and export.
 */
const isCaptionClip = (clip: Clip): boolean =>
  clip.assetId === '__caption__' || clip.effects.some((effect) => effect.type === 'caption');

/** A readable cue should never be a paragraph (the shared segmenter stays well below this). */
const MAX_VERIFIABLE_CAPTION_WORDS = 12;

/** Round for display so messages read as seconds, not float noise. */
const at = (n: number): string => `${+n.toFixed(3)}s`;

/**
 * Check a caption clip against the words that are actually audible during it.
 *
 * The core sync test: take the cue's own word timings, and compare them to where
 * the mapped transcript says those words play. A caption generated from source
 * timestamps fails this immediately and by a large margin, which is exactly the
 * failure that shipped silently before.
 */
function checkCueSync(
  clip: Clip,
  words: readonly MappedWord[],
  tolerance: number,
  issues: VerificationIssue[],
): void {
  const cue = clip.captionCue;
  if (cue === undefined || cue.words.length === 0) return;

  const audible = words.filter((w) => w.start < clip.end && w.end > clip.start);
  if (audible.length === 0) {
    issues.push({
      code: 'caption_over_no_speech',
      clipId: clip.id,
      at: clip.start,
      detail: `Caption "${cue.text.slice(0, 40)}" at ${at(clip.start)} covers no retained speech — it is captioning footage that was cut, or silence.`,
    });
    return;
  }

  const first = cue.words[0];
  if (first !== undefined) {
    // Compare the cue's first word against the first audible word: if the cue
    // was built in source time, this gap is the whole accumulated edit offset.
    const drift = Math.abs(first.start - (audible[0] as MappedWord).start);
    if (drift > tolerance) {
      issues.push({
        code: 'caption_out_of_sync',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption "${cue.text.slice(0, 40)}" starts ${at(drift)} away from the word it captions (cue says ${at(first.start)}, the audio is at ${at((audible[0] as MappedWord).start)}). Tolerance is ${at(tolerance)}.`,
      });
    }
  }

  const spoken = new Set(audible.map((w) => w.word.toLowerCase()));
  const shown = cue.words.filter((w) => !spoken.has(w.word.toLowerCase()));
  if (shown.length > 0 && shown.length === cue.words.length) {
    issues.push({
      code: 'caption_text_mismatch',
      clipId: clip.id,
      at: clip.start,
      detail: `Caption "${cue.text.slice(0, 40)}" at ${at(clip.start)} shows none of the words audible there — it is describing different footage.`,
    });
  }
}

/** Does this cue straddle a cut, i.e. cover two different clips' footage? */
function checkCueBoundaries(clip: Clip, map: TimelineMap, issues: VerificationIssue[]): void {
  const crossed = map.spans.filter((s) => s.start > clip.start + 1e-6 && s.start < clip.end - 1e-6);
  if (crossed.length > 0) {
    issues.push({
      code: 'caption_spans_cut',
      clipId: clip.id,
      at: (crossed[0] as { start: number }).start,
      detail: `Caption at ${at(clip.start)}–${at(clip.end)} runs across the cut at ${at((crossed[0] as { start: number }).start)}. A cue must end before the next shot begins — its words were never spoken together.`,
    });
  }
}

/**
 * Verify the caption track against the current edit.
 *
 * @param project - The live project document.
 * @param tolerance - Allowed sync drift in seconds.
 */
export function verifyCaptions(
  project: Project,
  tolerance: number = DEFAULT_CAPTION_TOLERANCE_SECONDS,
): CaptionVerificationReport {
  const map = buildTimelineMap(project.timeline);
  const mapped = mapTranscript(map, project.transcript);
  const issues: VerificationIssue[] = [];

  const cues = captionTracks(project).flatMap((track) => track.clips.filter(isCaptionClip));

  for (const clip of cues) {
    if (clip.end > map.duration + 1e-6) {
      issues.push({
        code: 'caption_past_end',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption ends at ${at(clip.end)}, past the ${at(map.duration)} sequence duration — it would never be seen.`,
      });
    }
    // A caption over a gap is over black: nothing is playing there.
    if (!map.spans.some((s) => s.start < clip.end - 1e-6 && s.end > clip.start + 1e-6)) {
      issues.push({
        code: 'caption_over_gap',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)}–${at(clip.end)} sits over a gap in the sequence, where no footage plays.`,
      });
    }
    checkCueBoundaries(clip, map, issues);
    checkCueSync(clip, mapped.words, tolerance, issues);

    const audibleWords = mapped.words.filter(
      (word) => word.start < clip.end - 1e-6 && word.end > clip.start + 1e-6,
    );
    const displayedWordCount = clip.captionCue?.words.length ?? audibleWords.length;
    if (displayedWordCount > MAX_VERIFIABLE_CAPTION_WORDS) {
      issues.push({
        code: 'caption_too_dense',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)}–${at(clip.end)} contains ${displayedWordCount} words. It is one transcript block, not a readable timed cue; regenerate it through the caption segmenter.`,
      });
    }

    const derived = clip.captionCue?.derivedFromRevision;
    if (derived !== undefined && derived !== map.revision) {
      issues.push({
        code: 'caption_stale',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)} was derived against timeline revision ${derived}, but the timeline is now at revision ${map.revision}. Its timing must be remapped or regenerated before it can be called correct.`,
      });
    } else if (derived === undefined) {
      issues.push({
        code: 'caption_provenance_unknown',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)} carries no cue derived from the current timeline revision, so its text and timing cannot be confirmed current. Regenerate it through the mapped caption pipeline.`,
      });
    }
  }

  // Retained speech with no caption over it. Reported as one issue rather than
  // hundreds, with the worst gap named, so it is actionable rather than noise.
  const covered = (t: number): boolean =>
    cues.some((c) => c.start <= t + 1e-6 && c.end >= t - 1e-6);
  const uncovered = mapped.words.filter((w) => !covered((w.start + w.end) / 2));
  const speechCoverage = mapped.words.length === 0 ? 1 : 1 - uncovered.length / mapped.words.length;
  if (uncovered.length > 0) {
    issues.push({
      code: 'speech_uncaptioned',
      at: (uncovered[0] as MappedWord).start,
      detail: `${uncovered.length} of ${mapped.words.length} retained words have no caption over them, starting at ${at((uncovered[0] as MappedWord).start)} ("${(uncovered[0] as MappedWord).word}").`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    cueCount: cues.length,
    speechCoverage: +speechCoverage.toFixed(4),
    revision: map.revision,
  };
}

/**
 * Verify every transition actually present in timeline state.
 *
 * Reads the committed effects rather than trusting what was requested, so a
 * transition that was asked for but never landed shows up as absent rather than
 * as done.
 */
export function verifyTransitions(project: Project): TransitionVerificationReport {
  const boundaries = listEditBoundaries(project.timeline, project.assets);
  const issues: VerificationIssue[] = [];
  let transitionCount = 0;

  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      const applied = readTransitionAt(project.timeline, {
        trackId: track.id,
        toClipId: clip.id,
      });
      if (applied === null) continue;
      transitionCount += 1;

      const boundary = boundaries.find((b) => b.toClipId === clip.id);
      if (boundary === undefined) {
        issues.push({
          code: 'transition_without_cut',
          clipId: clip.id,
          at: clip.start,
          detail: `A ${applied.kind} transition is attached to "${clip.id}" at ${at(clip.start)}, but there is no cut there — nothing precedes it on ${track.id}. It will not be visible.`,
        });
        continue;
      }
      if (applied.fromClipId !== boundary.fromClipId) {
        issues.push({
          code: 'transition_wrong_clips',
          clipId: clip.id,
          at: boundary.at,
          detail: `The transition entering "${clip.id}" names "${applied.fromClipId}" as the outgoing clip, but the clip actually preceding it at ${at(boundary.at)} is "${boundary.fromClipId}".`,
        });
      }
      const verdict = transitionEligibility(
        project.timeline,
        {
          fromClipId: boundary.fromClipId,
          toClipId: clip.id,
          durationSeconds: applied.durationSeconds,
          kind: applied.kind,
        },
        project.assets,
      );
      if (verdict.ok && verdict.clampedFrom !== undefined) {
        issues.push({
          code: 'transition_too_long',
          clipId: clip.id,
          at: boundary.at,
          detail: `The ${applied.kind} at ${at(boundary.at)} is ${at(applied.durationSeconds)} long but the cut can only carry ${at(verdict.durationSeconds)} — it overruns the shot it introduces.`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    transitionCount,
    boundaryCount: boundaries.length,
  };
}
