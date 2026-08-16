/**
 * Deriving caption cues from a source transcript and an *edited* timeline.
 *
 * ## WHY this module exists
 *
 * Captions used to be made by handing the raw project transcript to
 * {@link segmentCaptions} and writing the resulting cue times straight onto the
 * timeline. That is correct for exactly one timeline shape: a single untrimmed
 * clip starting at t=0. Every real edit — a ripple delete, a trim, a reorder, a
 * speed change — moves the footage without moving the transcript, and the cues
 * silently end up describing moments that are no longer there.
 *
 * The fix is a strict order of operations, enforced by this module's shape
 * rather than by anybody's discipline:
 *
 *   1. **Map** every transcript word through the canonical {@link TimelineMap}.
 *      Words in cut footage are dropped. Surviving words carry both their source
 *      timing and their new sequence timing.
 *   2. **Group** the survivors into runs of continuous sequence time. A run
 *      never spans a cut, a gap, or a change of clip.
 *   3. **Segment** each run independently, then clamp the result to the run.
 *      A cue therefore cannot begin before its footage or outlive it.
 *
 * Segmentation itself is untouched — {@link segmentCaptions} remains the single
 * authority on where a cue should break linguistically (ADR 0071). This module
 * only decides *which words exist and when they happen*, which is precisely the
 * decision that must never be made by offset arithmetic at a call site.
 *
 * @see docs/adr/0076-canonical-timeline-mapping.md
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';
import {
  TIME_EPSILON,
  spanSourceToSequence,
  type ClipSpan,
  type TimelineMap,
} from '../timeline-map.js';
import {
  captionSegmentConfig,
  segmentCaptions,
  type CaptionCueDraft,
  type CaptionSegmentConfig,
} from './segment.js';

/**
 * A transcript word that survived the edit, carrying both timings.
 *
 * WHY both: sequence timing is what renders; source timing is what lets the cue
 * be re-mapped after the *next* edit instead of regenerated, and what lets
 * verification prove a caption references retained footage. Losing the source
 * timing at this step is what made captions unrecoverable before.
 */
export interface MappedWord {
  readonly word: string;
  /** Sequence start, seconds — clamped to the owning clip. */
  readonly start: number;
  /** Sequence end, seconds — clamped to the owning clip. */
  readonly end: number;
  /** Asset start, seconds, as spoken. */
  readonly sourceStart: number;
  /** Asset end, seconds, as spoken. */
  readonly sourceEnd: number;
  readonly assetId: string;
  /** The clip that carries this word into the sequence. */
  readonly clipId: string;
  readonly confidence?: number;
  readonly speaker?: string;
}

/**
 * A maximal stretch of continuous sequence time from one clip, with the words
 * heard during it.
 *
 * Runs are the unit segmentation operates on, which is what guarantees no cue
 * crosses a cut. Two runs are separate whenever the clip changes — even when
 * their sequence times are adjacent, because after a ripple delete two
 * non-contiguous source ranges become visually continuous and a caption must
 * still break between them (the words either side were never spoken together).
 */
export interface MappedRun {
  readonly clipId: string;
  readonly assetId: string;
  /** Sequence start of the run's footage. */
  readonly start: number;
  /** Sequence end of the run's footage. */
  readonly end: number;
  readonly words: readonly MappedWord[];
}

/** The transcript, resolved against an edited timeline. */
export interface MappedTranscript {
  /** Surviving words in sequence order, flattened across runs. */
  readonly words: readonly MappedWord[];
  /** Continuous runs, in sequence order. Runs with no words are omitted. */
  readonly runs: readonly MappedRun[];
  /** Words that fell in cut footage and were dropped. */
  readonly droppedCount: number;
  /** The timeline revision this mapping was computed against. */
  readonly revision: number;
}

/**
 * How much of `word` (in source seconds) `span` retains, or 0 for no overlap.
 *
 * Overlap rather than containment, and *measured* rather than boolean, because a
 * word straddling a cut has to be attributed somewhere and the only defensible
 * answer is "wherever most of it was actually heard".
 */
function sourceOverlap(span: ClipSpan, word: TranscriptWord): number {
  const start = Math.max(span.sourceStart, word.start);
  const end = Math.min(span.sourceEnd, word.end);
  return end - start;
}

/**
 * How much overlap a word needs with `span` to be captioned there — half of
 * whichever of the two is shorter.
 *
 * WHY a majority and not any overlap at all: a cut lands mid-word constantly, and
 * "any overlap keeps the word" means a word 5% of which survived still gets
 * captioned in full. That is deleted speech appearing on screen — the exact
 * failure this pipeline exists to prevent — and it reads as a stray fragment at
 * every cut.
 *
 * WHY half the *shorter* of the two rather than always half the word: a clip can
 * be shorter than the word being spoken over it — a 0.1s stinger, a
 * silence-removal sliver, a rapid-fire b-roll cut. Judged against the word, such
 * a clip can never retain half of anything and is captioned as silent, so short
 * clips came out with no captions at all however much speech played over them.
 * Judged against the clip, the question becomes the one that actually matters
 * on screen: *is this word what the viewer hears for most of this shot?* The two
 * readings coincide everywhere the clip is the longer of the pair, so a normal
 * cut keeps exactly the behaviour ADR 0076 specified — the scaled rule only
 * engages where the old one had no useful answer.
 *
 * The half is slackened by a frame-rounding tolerance so a word cut exactly at
 * the midpoint is kept rather than lost to float error.
 */
function overlapThreshold(span: ClipSpan, word: TranscriptWord): number {
  const wordSeconds = word.end - word.start;
  const spanSeconds = span.sourceEnd - span.sourceStart;
  return Math.min(wordSeconds, spanSeconds) / 2 - TIME_EPSILON;
}

/**
 * The span that carries `word`, or `undefined` when the word did not survive the
 * edit — the **majority rule**: a word belongs to the clip that retained most of
 * it, among the clips that clear {@link overlapThreshold}.
 *
 * A word can now clear the threshold in two places at once (two sub-word clips
 * both covered by one long word), which is exactly why the winner is the largest
 * overlap rather than the first qualifier: the word is still captioned once, on
 * the clip that carries most of it.
 *
 * Ties (the same word retained twice, from a reused source range) resolve to the
 * earliest sequence position, so a duplicated range captions its first
 * appearance. Emitting the word once per appearance was the alternative and is
 * worse: it produces stuttering, duplicated captions at every reuse.
 */
function bestSpanFor(
  spans: readonly ClipSpan[],
  word: TranscriptWord,
  assetId: string | undefined,
): ClipSpan | undefined {
  let best: ClipSpan | undefined;
  let bestOverlap = 0;
  for (const span of spans) {
    // An unattributed word (pre-v12 transcript) matches any asset — the v11
    // behavior — while an attributed one is confined to its own footage.
    if (assetId !== undefined && span.assetId !== assetId) continue;
    const overlap = sourceOverlap(span, word);
    if (overlap <= overlapThreshold(span, word)) continue;
    if (overlap > bestOverlap) {
      best = span;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Map one word into sequence time through `span`, clamped to the span.
 *
 * Clamping is what keeps a straddling word from painting a caption over footage
 * that was deleted: the word is kept (it *was* partly spoken here) but it cannot
 * extend past the cut.
 */
function mapWord(span: ClipSpan, word: TranscriptWord): MappedWord {
  const rawStart = spanSourceToSequence(span, Math.max(word.start, span.sourceStart));
  const rawEnd = spanSourceToSequence(span, Math.min(word.end, span.sourceEnd));
  return {
    word: word.word,
    start: Math.min(Math.max(rawStart, span.start), span.end),
    end: Math.min(Math.max(rawEnd, span.start), span.end),
    sourceStart: word.start,
    sourceEnd: word.end,
    assetId: span.assetId,
    clipId: span.clipId,
    ...(word.confidence == null ? {} : { confidence: word.confidence }),
    ...(word.speaker == null ? {} : { speaker: word.speaker }),
  };
}

/**
 * Resolve a source transcript against an edited timeline.
 *
 * The one way to ask "where are these words now?". Nothing else in the product
 * may compute a sequence time for a transcript word.
 *
 * @param map - Canonical timing, from `buildTimelineMap`.
 * @param transcript - Source-relative words (schema v12), in any order.
 * @returns Surviving words with both timings, grouped into continuous runs.
 */
export function mapTranscript(
  map: TimelineMap,
  transcript: readonly TranscriptWord[],
): MappedTranscript {
  const mapped: MappedWord[] = [];
  let droppedCount = 0;

  for (const word of transcript) {
    // Zero/negative-duration entries carry no readable time and would skew every
    // pause calculation downstream; the segmenter drops them too.
    if (word.end <= word.start) {
      droppedCount += 1;
      continue;
    }
    // `?? undefined` because the attribution is nullish across the language
    // boundary (the Python engine serializes "no asset" as null), and null must
    // read as "unattributed", not as an asset literally named null.
    const span = bestSpanFor(map.spans, word, word.assetId ?? undefined);
    if (span === undefined) {
      droppedCount += 1;
      continue;
    }
    mapped.push(mapWord(span, word));
  }

  mapped.sort((a, b) => a.start - b.start || a.sourceStart - b.sourceStart);

  // Group into runs. A change of clip always starts a new run, even when the two
  // clips abut in sequence time — that adjacency is the *edit's* doing, not the
  // speech's, and a cue must not bridge it.
  const runs: (Omit<MappedRun, 'words'> & { words: MappedWord[] })[] = [];
  const spanById = new Map(map.spans.map((span) => [span.clipId, span]));
  for (const word of mapped) {
    const open = runs[runs.length - 1];
    if (open !== undefined && open.clipId === word.clipId) {
      open.words.push(word);
      continue;
    }
    const span = spanById.get(word.clipId);
    runs.push({
      clipId: word.clipId,
      assetId: word.assetId,
      start: span?.start ?? word.start,
      end: span?.end ?? word.end,
      words: [word],
    });
  }

  return { words: mapped, runs, droppedCount, revision: map.revision };
}

/** A caption cue derived from the edited timeline, with its source provenance. */
export interface DerivedCue extends CaptionCueDraft {
  /** The clip whose footage this cue captions. */
  readonly clipId: string;
  readonly assetId: string;
  /** The asset range this cue's words were spoken in. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** The timeline revision the cue was derived against. */
  readonly revision: number;
}

/**
 * Segment an edited timeline's retained speech into caption cues.
 *
 * Runs are segmented **independently** and each cue is clamped to its run. The
 * clamp matters more than it looks: `segmentCaptions` legitimately extends a cue
 * past its last word to enforce a minimum on-screen duration and to bridge
 * flicker-gaps, and without a clamp that extension would spill a caption across
 * the very cut this pipeline exists to respect.
 *
 * @param map - Canonical timing, from `buildTimelineMap`.
 * @param transcript - Source-relative words (schema v12).
 * @param config - Segmentation limits; see `captionSegmentConfig`.
 * @returns Cues in sequence order, each stamped with its source provenance.
 */
export function deriveCaptionCues(
  map: TimelineMap,
  transcript: readonly TranscriptWord[],
  config: CaptionSegmentConfig = captionSegmentConfig(),
): readonly DerivedCue[] {
  const { runs, revision } = mapTranscript(map, transcript);

  return runs.flatMap((run) => {
    // The segmenter works in whatever timebase its input uses; feed it sequence
    // time so its pause/reading-speed reasoning matches what the viewer sees.
    // At a speed != 1 that is deliberately the *played back* pacing, not the
    // originally spoken pacing — a 2x clip really does need faster cues.
    const cues = segmentCaptions(
      run.words.map(({ word, start, end }) => ({ word, start, end })),
      config,
    );

    let consumed = 0;
    return cues.map((cue): DerivedCue => {
      const start = Math.max(cue.start, run.start);
      const end = Math.min(cue.end, run.end);
      // Recover the source range from the words the segmenter grouped. Counting
      // forward through the run is safe: the segmenter preserves word order and
      // partitions its input, so cue N's words follow cue N-1's exactly.
      const sourceWords = run.words.slice(consumed, consumed + cue.words.length);
      consumed += cue.words.length;
      const first = sourceWords[0];
      const last = sourceWords[sourceWords.length - 1];
      return {
        text: cue.text,
        words: cue.words.map((word) => ({
          ...word,
          start: Math.min(Math.max(word.start, start), end),
          end: Math.min(Math.max(word.end, start), end),
        })),
        start,
        end,
        clipId: run.clipId,
        assetId: run.assetId,
        sourceStart: first?.sourceStart ?? 0,
        sourceEnd: last?.sourceEnd ?? 0,
        revision,
      };
    });
  });
}
