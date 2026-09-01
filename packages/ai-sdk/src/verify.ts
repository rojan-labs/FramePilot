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
  type MappedRun,
  type MappedWord,
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
 * The word→cue ownership partition every caption check reads from.
 *
 * ## WHY this exists, and why a midpoint test was not enough
 *
 * A cue's boundaries are frame-quantised at the patch boundary; the words it was built
 * from are not. So a cue that begins on a word can end up starting up to a frame away
 * from it, and any ownership rule computed from raw times then disagrees with the
 * segmenter that produced the cue — always at a boundary, always by exactly one word.
 *
 * That disagreement is not a cosmetic mis-count. It made this verifier's findings
 * **unsatisfiable**, and a captured run proves the cost. `verify_captions` reported six
 * defects; the agent did the one thing the finding asked for and regenerated every cue
 * from the current mapped transcript; the generator produced cues with byte-identical
 * timings; the verifier reported the same six defects. 102 operations — 34 deletions and
 * 34 identical re-insertions — and the run's remaining turns were spent on a loop that
 * could not converge, because the generator and the verifier were partitioning the same
 * words two different ways.
 *
 * Two concrete cases from that run, both one frame wide at 30fps:
 *
 * - Cue `15.967s–17.567s` records "with one mission.", first word "with" at 15.98s. The
 *   word "school" runs 15.57–15.98 and therefore OVERLAPS the cue by 13ms, so an
 *   overlap-based "first audible word" test compared the cue against a word belonging to
 *   its predecessor and reported it 0.41s out of sync. It is not out of sync at all.
 * - Cue `35.8s–37.833s` records 6 words. The next cue begins on "The" at 37.820s,
 *   quantised up to 37.833s — so "The"'s MIDPOINT (37.825s) fell inside the previous cue
 *   and a midpoint test reported 7 words playing across a 6-word cue, stale.
 *
 * ## The rule
 *
 * A word belongs to the LAST cue that begins at or before it, allowing one frame of slack
 * for exactly the quantisation above, and only when the word is still inside that cue.
 * That reproduces the segmenter's partition — it walks words in order and opens a new cue
 * at a word boundary — and it partitions: every word has at most one owner, so the sync
 * check, the currency check and the coverage figure can no longer disagree with each
 * other about which words a cue is answerable for.
 */
interface CaptionOwnership {
  /** Words owned by each cue, keyed by clip id, in time order. */
  readonly byClip: ReadonlyMap<string, readonly MappedWord[]>;
  /** Retained words no cue covers — what `speechCoverage` counts. */
  readonly uncovered: readonly MappedWord[];
}

/**
 * One frame of slack at the project's own rate.
 *
 * A frame, not half of one: `secondsToFrame` rounds to nearest by default, but the
 * placement path may floor or ceil, and a rule that is right for one rounding and wrong
 * for another is the defect this replaces. A frame is far inside
 * {@link DEFAULT_CAPTION_TOLERANCE_SECONDS}, so nothing a viewer could see as drift is
 * absorbed by it.
 */
const frameSlack = (fps: number): number => (Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30);

function assignWordsToCues(
  cues: readonly Clip[],
  words: readonly MappedWord[],
  fps: number,
): CaptionOwnership {
  const slack = frameSlack(fps);
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  const byClip = new Map<string, MappedWord[]>();
  for (const clip of ordered) byClip.set(clip.id, []);
  const uncovered: MappedWord[] = [];

  for (const word of words) {
    // The last cue that has begun by the time this word starts. Scanned from the end so
    // overlapping cues (a hand-authored track may have them) resolve to the latest, which
    // is the one a viewer reads.
    const owner = [...ordered]
      .reverse()
      .find((clip) => clip.start <= word.start + slack && word.start < clip.end + slack);
    if (owner === undefined) {
      uncovered.push(word);
      continue;
    }
    (byClip.get(owner.id) as MappedWord[]).push(word);
  }
  return { byClip, uncovered };
}

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
  owned: readonly MappedWord[],
  tolerance: number,
  issues: VerificationIssue[],
): void {
  const cue = clip.captionCue;
  if (cue === undefined || cue.words.length === 0) return;

  if (owned.length === 0) {
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
    // Compare the cue's first word against the first word this cue OWNS: if the cue was
    // built in source time, this gap is the whole accumulated edit offset.
    //
    // It used to compare against the first word that merely OVERLAPPED the cue, and a word
    // straddling the cue's start overlaps both neighbours — so the cue was measured against
    // its predecessor's last word and reported an offset that was really the length of that
    // word. See {@link assignWordsToCues} for the run this cost.
    const drift = Math.abs(first.start - (owned[0] as MappedWord).start);
    if (drift > tolerance) {
      issues.push({
        code: 'caption_out_of_sync',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption "${cue.text.slice(0, 40)}" starts ${at(drift)} away from the word it captions (cue says ${at(first.start)}, the audio is at ${at((owned[0] as MappedWord).start)}). Tolerance is ${at(tolerance)}.`,
      });
    }
  }

  const spoken = new Set(owned.map((w) => w.word.toLowerCase()));
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

/**
 * Does this cue bridge a break in the SPEECH — two stretches of audio that were never
 * spoken continuously?
 *
 * WHY runs and not clip spans: this test used to filter `map.spans`, which
 * `buildTimelineMap` fills from every video AND audio clip. So it flagged picture cuts.
 * On a montage — the shape of nearly every short — that makes it unsatisfiable: twenty
 * seconds of continuous narration under forty-six shots averaging 0.43s leaves nowhere to
 * put a cue, and single words fail too ("heart," runs 3.84–4.37s across a cut at 4.209s).
 * The rule's own message read "its words were never spoken together", which is true of a
 * speech break and false of a picture cut: it tested the second and justified itself with
 * the first.
 *
 * Worse, it contradicted the generator. `deriveCaptionCues` segments per {@link MappedRun}
 * and clamps every cue to its run, and that module calls runs "what guarantees no cue
 * crosses a cut". So the canonical generator's output was rejected by the canonical
 * verifier on every project whose picture is cut more finely than its audio — which is
 * every montage, every B-roll edit, every multicam. One pipeline cannot hold two
 * definitions of a cut, and a run handed an unsatisfiable acceptance test correctly
 * declines to edit at all.
 *
 * The definition that survives is the generator's, because it is the one grounded in what
 * a viewer can read: a cue may sit over as many shots as the editor likes, and may never
 * bridge audio the speaker did not say in one breath.
 */
function checkCueBoundaries(
  clip: Clip,
  runs: readonly MappedRun[],
  issues: VerificationIssue[],
): void {
  const bridged = runs.filter(
    (run) => run.start > clip.start + 1e-6 && run.start < clip.end - 1e-6,
  );
  const first = bridged[0];
  if (first === undefined) return;
  issues.push({
    code: 'caption_spans_speech_break',
    clipId: clip.id,
    at: first.start,
    detail: `Caption at ${at(clip.start)}–${at(clip.end)} bridges the speech break at ${at(first.start)}, where the edit joins two stretches of audio that were never spoken in one breath. Split the cue there. A picture cut is fine to caption across; this is an audio discontinuity.`,
  });
}

/**
 * Is this cue still true of the edit, word for word?
 *
 * WHY this replaced a revision comparison: `caption_stale` used to fire whenever
 * `derivedFromRevision !== map.revision`. That is not a staleness test, it is a
 * change-detector for the whole project. Sixty-five revisions of colour, effects and
 * picture cuts moved nothing on the audio track, yet all forty cues were reported stale
 * while {@link checkCueSync} — the test that actually measures whether a cue sits on its
 * word — passed on all forty. A verifier that reports forty defects where there are none
 * is not being careful; it is unusable, because the run cannot tell which finding to act
 * on and correctly acts on none.
 *
 * The honest question is whether the words this cue records are still the words that play
 * across it, at the times it records them. That is strictly stronger than the revision
 * comparison: it catches a cue whose words a later cut removed (which the revision test
 * also caught) AND a cue that drifted while the revision happened not to change (which it
 * did not). One issue per cue, because forty cues x three defects is a report nobody reads.
 */
function checkCueCurrency(
  clip: Clip,
  owned: readonly MappedWord[],
  tolerance: number,
  issues: VerificationIssue[],
): void {
  const cue = clip.captionCue;
  if (cue === undefined || cue.words.length === 0) return;
  // Owning no speech at all is `caption_over_no_speech`'s finding, already reported.
  if (owned.length === 0) return;
  const stale = (detail: string, atTime: number): void => {
    issues.push({ code: 'caption_stale', clipId: clip.id, at: atTime, detail });
  };
  if (owned.length !== cue.words.length) {
    stale(
      `Caption at ${at(clip.start)} shows ${cue.words.length} word${
        cue.words.length === 1 ? '' : 's'
      } but ${owned.length} now play across it (${owned
        .map((word) => word.word)
        .join(
          ' ',
        )}). A later edit changed what is spoken here — regenerate the cue from the current mapped transcript.`,
      clip.start,
    );
    return;
  }
  for (const [index, expected] of owned.entries()) {
    const shown = cue.words[index];
    /* v8 ignore next -- lengths were just proven equal, so the index is always in range */
    if (shown === undefined) return;
    if (shown.word.toLowerCase() !== expected.word.toLowerCase()) {
      stale(
        `Caption at ${at(clip.start)} shows "${shown.word}" where "${expected.word}" is now spoken — regenerate the cue from the current mapped transcript.`,
        shown.start,
      );
      return;
    }
    const drift = Math.abs(shown.start - expected.start);
    if (drift > tolerance) {
      stale(
        `Caption at ${at(clip.start)} times "${shown.word}" at ${at(shown.start)}, but the edit now plays it at ${at(expected.start)} — ${at(drift)} away, past the ${at(tolerance)} tolerance. Regenerate the cue from the current mapped transcript.`,
        shown.start,
      );
      return;
    }
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
  // ONE partition, computed once and read by every check below. Three checks each deriving
  // their own answer to "which words is this cue answerable for" is what let the verifier
  // contradict itself — and, worse, contradict the generator whose output it was judging.
  const ownership = assignWordsToCues(cues, mapped.words, project.fps);

  for (const clip of cues) {
    const owned = ownership.byClip.get(clip.id) ?? [];
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
    checkCueBoundaries(clip, mapped.runs, issues);
    checkCueSync(clip, owned, tolerance, issues);
    checkCueCurrency(clip, owned, tolerance, issues);

    const displayedWordCount = clip.captionCue?.words.length ?? owned.length;
    if (displayedWordCount > MAX_VERIFIABLE_CAPTION_WORDS) {
      issues.push({
        code: 'caption_too_dense',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)}–${at(clip.end)} contains ${displayedWordCount} words. It is one transcript block, not a readable timed cue; regenerate it through the caption segmenter.`,
      });
    }

    // No revision comparison here: `derivedFromRevision` records WHICH mapping produced
    // the cue, which is provenance worth keeping, but it cannot answer whether the cue is
    // still right — only re-measuring can, and `checkCueCurrency` above does. What
    // remains verifiable from provenance alone is its absence.
    if (clip.captionCue?.derivedFromRevision === undefined) {
      issues.push({
        code: 'caption_provenance_unknown',
        clipId: clip.id,
        at: clip.start,
        detail: `Caption at ${at(clip.start)} carries no cue derived from the current timeline revision, so its text and timing cannot be confirmed current. Regenerate it through the mapped caption pipeline.`,
      });
    }
  }

  // Retained speech with no caption over it. Reported as one issue rather than
  // hundreds, with the worst gap named, so it is actionable rather than noise. Read from
  // the same partition the per-cue checks used, so a word can never be both "owned by a
  // cue" and "uncaptioned".
  const uncovered = ownership.uncovered;
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
