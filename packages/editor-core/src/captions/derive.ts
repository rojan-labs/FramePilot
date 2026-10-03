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
import type { Asset, TranscriptWord } from '@framepilot/timeline-schema';
import { frameToSeconds, secondsToFrame, snapSecondsToFrame } from '../frame-grid.js';
import {
  TIME_EPSILON,
  spanIsFrozen,
  spanSourceToSequence,
  type ClipSpan,
  type TimelineMap,
} from '../timeline-map.js';
import {
  MIN_CAPTION_CUE_SECONDS,
  captionSegmentConfig,
  clearsCaptionFloor,
  layoutLines,
  readableUntil,
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
 * The span groups an UNATTRIBUTED word may be matched against.
 *
 * The named speech assets when at least one of them is actually placed on the timeline;
 * every group otherwise. The "at least one placed" condition is what makes this safe to
 * turn on: a caller naming an asset that no clip uses would otherwise leave a word with
 * nowhere to land, and a dropped word is a missing caption.
 */
function unattributedGroups(
  index: SourceSpanIndex,
  speechAssetIds: ReadonlySet<string> | undefined,
): Iterable<SourceSpanGroup> {
  if (speechAssetIds === undefined || speechAssetIds.size === 0) return index.byAsset.values();
  const named: SourceSpanGroup[] = [];
  for (const assetId of speechAssetIds) {
    const group = index.byAsset.get(assetId);
    if (group !== undefined) named.push(group);
  }
  return named.length > 0 ? named : index.byAsset.values();
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
  index: SourceSpanIndex,
  word: TranscriptWord,
  assetId: string | undefined,
  speechAssetIds: ReadonlySet<string> | undefined,
): ClipSpan | undefined {
  let best: ClipSpan | undefined;
  let bestOverlap = 0;
  const consider = (span: ClipSpan): void => {
    const overlap = sourceOverlap(span, word);
    if (overlap <= overlapThreshold(span, word)) return;
    if (overlap > bestOverlap) {
      best = span;
      bestOverlap = overlap;
      return;
    }
    // The tie-break the doc comment above promises, actually applied. `candidatesIn`
    // walks its group backwards from a binary search, so "whichever arrived first"
    // is ordered by *source* in-point and by array position — neither of which is the
    // earliest appearance on the timeline. Two clips reusing one source range then
    // attributed their words by accident of iteration, and a later word could tip the
    // other way and split one sentence across two runs.
    if (overlap === bestOverlap && best !== undefined) {
      if (span.start < best.start || (span.start === best.start && span.clipId < best.clipId)) {
        best = span;
      }
    }
  };
  // An attributed word is confined to its own footage. An unattributed one (a pre-v12
  // transcript, which is every mission fixture) matched ANY asset — the v11 behavior —
  // and on a project that has since gained b-roll or a music bed that means a caption cue
  // can be attributed to, and timed through, a clip that was never speaking.
  //
  // The same fabrication was fixed twice in one week elsewhere: in the Critic (`5d0dbab`,
  // where `word_severed` judged b-roll against the narration) and in the golden rubric
  // (`a255687`). This is the third copy, and it takes the same rule those two took: a
  // transcript with no attribution can only have come from an asset long enough to
  // contain it, so when the caller can say which assets those are, an unattributed word
  // is confined to them.
  //
  // The caller says so only when it CAN — the agent path holds the whole project, the
  // web-editor's `generateCaptionsPatch` holds a bare timeline. Absent, and whenever no
  // named speech asset is actually on the timeline, the v11 reading stands unchanged, so
  // no project loses captions it had. Captions are the most incident-heavy area in this
  // repo; a narrowing that can empty a caption track is not worth a correct attribution.
  const groups =
    assetId === undefined
      ? unattributedGroups(index, speechAssetIds)
      : [index.byAsset.get(assetId) ?? EMPTY_GROUP];
  for (const group of groups) {
    for (const span of candidatesIn(group, word)) consider(span);
  }
  return best;
}

/**
 * Spans grouped by asset and sorted by source in-point, so mapping a word is a search
 * rather than a scan.
 *
 * WHY: `mapTranscript` called `bestSpanFor` once per word and `bestSpanFor` walked EVERY
 * span, which is O(words x clips). On an hour of footage — nine thousand words over
 * eighteen hundred clips — that is sixteen million overlap tests, paid by every caption
 * derivation and every review. The result is unchanged: the same majority rule over the
 * same candidates, reached by binary search.
 */
interface SourceSpanGroup {
  /** Spans for one asset, ascending by `sourceStart`. */
  readonly spans: readonly ClipSpan[];
  /** The longest source range any of them covers — the bound on the backward walk. */
  readonly longestSource: number;
}

interface SourceSpanIndex {
  readonly byAsset: ReadonlyMap<string, SourceSpanGroup>;
}

const EMPTY_GROUP: SourceSpanGroup = { spans: [], longestSource: 0 };

function indexSpansBySource(spans: readonly ClipSpan[]): SourceSpanIndex {
  const grouped = new Map<string, ClipSpan[]>();
  for (const span of spans) {
    // A freeze holds ONE frame and the render engine drops its audio, so no word is
    // spoken over it however long it is held. Indexing its source range would caption
    // the whole range onto the held frame — every one of those words at the same
    // instant, none of them audible.
    if (spanIsFrozen(span)) continue;
    // A word on a muted clip is not heard either, so it is not captioned or mapped there
    // (`timeline-map.ts#clipIsAudible`). When every clip of the asset that carries the
    // transcript is silent, nothing maps — which is the truth about what the viewer hears.
    if (span.audible === false) continue;
    const list = grouped.get(span.assetId);
    if (list === undefined) grouped.set(span.assetId, [span]);
    else list.push(span);
  }
  const byAsset = new Map<string, SourceSpanGroup>();
  for (const [assetId, list] of grouped) {
    const sorted = [...list].sort((a, b) => a.sourceStart - b.sourceStart);
    const longestSource = sorted.reduce(
      (max, span) => Math.max(max, span.sourceEnd - span.sourceStart),
      0,
    );
    byAsset.set(assetId, { spans: sorted, longestSource });
  }
  return { byAsset };
}

/**
 * The spans in `group` that could overlap `word` in source time.
 *
 * Binary search to the first span starting at or after the word's end, then walk back
 * while a span could still reach the word. The walk is bounded by the group's longest
 * source range — a real quantity, not an assumption that spans do not overlap, which they
 * do whenever footage is reused.
 */
function candidatesIn(group: SourceSpanGroup, word: TranscriptWord): ClipSpan[] {
  const { spans, longestSource } = group;
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid]!.sourceStart < word.end) low = mid + 1;
    else high = mid;
  }
  const found: ClipSpan[] = [];
  const floor = word.start - longestSource;
  for (let i = Math.min(low, spans.length) - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    if (span.sourceStart <= floor) break;
    if (span.sourceEnd > word.start) found.push(span);
  }
  return found;
}

/**
 * Map one word into sequence time through `span`, clamped to the span.
 *
 * Clamping is what keeps a straddling word from painting a caption over footage
 * that was deleted: the word is kept (it *was* partly spoken here) but it cannot
 * extend past the cut.
 */
function mapWord(span: ClipSpan, word: TranscriptWord): MappedWord {
  const a = spanSourceToSequence(span, Math.max(word.start, span.sourceStart));
  const b = spanSourceToSequence(span, Math.min(word.end, span.sourceEnd));
  // On a REVERSED clip (schema v15) source time runs backwards as the sequence runs
  // forwards, so the word's source in-point maps to the LATER sequence instant. A cue
  // is an interval, not a direction, so order the pair rather than emitting end < start
  // — which would read as a zero- or negative-length cue everywhere downstream.
  const rawStart = Math.min(a, b);
  const rawEnd = Math.max(a, b);
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
 * @param speechAssetIds - Assets an UNATTRIBUTED word may belong to; see
 *   {@link speechAssetIdsFor}. Omit when the caller cannot tell, and the pre-v12
 *   any-asset reading stands.
 * @returns Surviving words with both timings, grouped into continuous runs.
 */
export function mapTranscript(
  map: TimelineMap,
  transcript: readonly TranscriptWord[],
  speechAssetIds?: ReadonlySet<string>,
): MappedTranscript {
  const mapped: MappedWord[] = [];
  let droppedCount = 0;
  const index = indexSpansBySource(map.spans);

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
    const span = bestSpanFor(index, word, word.assetId ?? undefined, speechAssetIds);
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
 * The segmenter is told where its run ends, so it gives the run's LAST cue the readable
 * floor too ({@link MIN_CAPTION_CUE_SECONDS}). Only a run too short to hold any readable
 * cue is left, and {@link holdShortCues} resolves it across the cut — the one exception to
 * "no cue crosses a cut", and a bounded one.
 *
 * @param map - Canonical timing, from `buildTimelineMap`.
 * @param transcript - Source-relative words (schema v12).
 * @param config - Segmentation limits; see `captionSegmentConfig`.
 * @param fps - Project frame rate. Pass it whenever these cues will become
 *   operations: sequence times are quantised to a frame at the patch boundary,
 *   and a cue narrower than that grid is rejected as zero-length. See
 *   `coalesceSubFrameCues`.
 * @param speechAssetIds - Assets an UNATTRIBUTED word may belong to; see
 *   {@link speechAssetIdsFor}. Omit when the caller holds no assets.
 * @returns Cues in sequence order, each stamped with its source provenance.
 */
export function deriveCaptionCues(
  map: TimelineMap,
  transcript: readonly TranscriptWord[],
  config: CaptionSegmentConfig = captionSegmentConfig(),
  fps?: number,
  speechAssetIds?: ReadonlySet<string>,
): readonly DerivedCue[] {
  const { runs, revision } = mapTranscript(map, transcript, speechAssetIds);

  const admitted = resolveCueOverlaps(
    runs.flatMap((run) => {
      // The segmenter works in whatever timebase its input uses; feed it sequence
      // time so its pause/reading-speed reasoning matches what the viewer sees.
      // At a speed != 1 that is deliberately the *played back* pacing, not the
      // originally spoken pacing — a 2x clip really does need faster cues.
      // Segment on the same grid the patch boundary will quantise to; without it
      // a cue can be legal here and zero-length by the time it is validated.
      const cues = segmentCaptions(
        run.words.map(({ word, start, end }) => ({ word, start, end })),
        config,
        fps,
        run.end,
      );

      let consumed = 0;
      const derived: DerivedCue[] = [];
      for (const cue of cues) {
        const start = Math.max(cue.start, run.start);
        const end = Math.min(cue.end, run.end);
        // Recover the source range from the words the segmenter grouped. Counting
        // forward through the run is safe: the segmenter preserves word order and
        // partitions its input, so cue N's words follow cue N-1's exactly.
        const sourceWords = run.words.slice(consumed, consumed + cue.words.length);
        consumed += cue.words.length;
        const first = sourceWords[0];
        const last = sourceWords[sourceWords.length - 1];
        const entry: DerivedCue = {
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

        // The clamp above is the LAST place a cue can be squeezed out of existence, and
        // segmentation cannot see it coming: `segmentCaptions` works inside the run and is
        // allowed to extend its final cue past the last word, so a cue sitting within a
        // frame of `run.end` comes back with nothing left after clamping to it. Only a cut
        // exposes this — on a single untrimmed clip the run ends where the footage does and
        // there is always room, which is why it survived a fix and a property test that
        // both only ever saw one clip.
        //
        // Absorbed into the previous cue of the SAME run rather than dropped: the words
        // were really spoken, and the run is the unit that guarantees no cue crosses a cut,
        // so merging inside it cannot bridge one. With no predecessor there is nowhere to
        // put them and the cue is dropped — its footage is under a frame, so there is
        // genuinely no picture to caption.
        const previous = derived[derived.length - 1];
        if (fps !== undefined && secondsToFrame(end, fps) <= secondsToFrame(start, fps)) {
          if (previous === undefined) continue;
          derived[derived.length - 1] = {
            ...previous,
            text: `${previous.text} ${cue.text}`,
            words: [...previous.words, ...entry.words],
            end: Math.max(previous.end, end),
            sourceEnd: entry.sourceEnd,
          };
          continue;
        }
        derived.push(entry);
      }
      return derived;
    }),
    fps,
  );
  return holdShortCues(admitted, config, fps, map.duration);
}

/**
 * Give every cue the readable floor ({@link MIN_CAPTION_CUE_SECONDS}), crossing a cut only
 * for a run that cannot hold one by itself.
 *
 * `segmentCaptions` holds every cue of a run to the floor before the run ends, merging
 * within the run when it must. What it cannot fix is a run whose ONLY cue is short — a
 * word or two on a sliver of a clip — or a cue `resolveCueOverlaps` trimmed under another.
 * `verify_captions` reports such a cue as `caption_too_short`, and the builder made it, so
 * re-running the builder (what the remedy said) made it again (desktop run `001be135`).
 *
 * In order of preference:
 *
 *  1. extend it into the free time that follows, up to the floor, when no cue occupies that
 *     time and the sequence lasts that long — the words stay where they are, held a few
 *     frames into the next shot;
 *  2. otherwise merge it into the cue that follows (the one in the way), across the cut;
 *  3. at the very end of the sequence, take the rest from the free time before it, and
 *     merge into the cue before it only when that time is taken too.
 *
 * Either way the cue's crossing is shorter than the floor, which is what `verify_captions`'
 * speech-break check accepts: a stretch too short to be its own cue riding on its
 * neighbour. A sole cue on a timeline too short to hold one stays as it is.
 */
function holdShortCues(
  cues: readonly DerivedCue[],
  config: CaptionSegmentConfig,
  fps: number | undefined,
  sequenceEnd: number,
): readonly DerivedCue[] {
  const result = [...cues];
  let index = 0;
  // Every pass either advances `index` or removes a cue, so this terminates.
  while (index < result.length) {
    const cue = result[index]!;
    if (clearsCaptionFloor(cue.start, cue.end, fps)) {
      index += 1;
      continue;
    }
    const next = result[index + 1];
    const previous = result[index - 1];
    const held = readableUntil(cue.start, fps);
    const room = Math.min(next?.start ?? Infinity, sequenceEnd);
    if (held <= room + TIME_EPSILON) {
      result[index] = { ...cue, end: Math.max(cue.end, held) };
      index += 1;
      continue;
    }
    if (next !== undefined) {
      // Re-examined at the same index: the cue it absorbed may have been short too.
      result.splice(index, 2, mergeCues(cue, next, config));
      continue;
    }
    // The last cue, with the sequence ending under it: hold it from earlier instead.
    const end = Math.max(cue.end, Math.min(held, sequenceEnd));
    const start = Math.min(cue.start, readableFrom(end, fps));
    if (start >= (previous?.end ?? 0) - TIME_EPSILON) {
      result[index] = { ...cue, start, end };
      index += 1;
      continue;
    }
    if (previous === undefined) {
      // A sequence shorter than the floor: nothing can make this cue readable.
      index += 1;
      continue;
    }
    result.splice(index - 1, 2, mergeCues(previous, cue, config));
    index -= 1;
  }
  return result;
}

/**
 * The latest start from which a cue ending at `end` is on screen for the floor, measured on
 * the frame grid the patch boundary snaps to — {@link readableUntil} run backwards.
 */
function readableFrom(end: number, fps: number | undefined): number {
  if (fps === undefined) return end - MIN_CAPTION_CUE_SECONDS;
  const from = snapSecondsToFrame(end, fps) - MIN_CAPTION_CUE_SECONDS + TIME_EPSILON;
  return frameToSeconds(secondsToFrame(from, fps, 'floor'), fps);
}

/**
 * Two neighbouring cues as one: their words in order, laid out again on the cue's lines,
 * spanning both. The provenance (clip, asset, source range) is the LONGER cue's — the cue
 * that is mostly what the viewer reads, and a real range of one clip rather than a span
 * stitched across two source ranges that were never contiguous.
 */
function mergeCues(
  first: DerivedCue,
  second: DerivedCue,
  config: CaptionSegmentConfig,
): DerivedCue {
  const words = [...first.words, ...second.words];
  const keeper = second.end - second.start > first.end - first.start ? second : first;
  return {
    text: layoutLines(words, config),
    words,
    start: first.start,
    end: Math.max(first.end, second.end),
    clipId: keeper.clipId,
    assetId: keeper.assetId,
    sourceStart: keeper.sourceStart,
    sourceEnd: keeper.sourceEnd,
    revision: keeper.revision,
  };
}

/**
 * Collapse the cue lists of overlapping runs into one non-overlapping cue timeline.
 *
 * WHY: runs are per-clip and clips stack. A b-roll cutaway, a second video track, a
 * multicam angle — any of these puts two clips over the *same sequence instant*, and
 * because each clip carries its own source range, each contributes its own words. Run
 * segmentation is deliberately independent (that is what keeps a cue from crossing a
 * cut), so nothing downstream had noticed that two runs could describe the same moment.
 *
 * Two things then went wrong at once, and the second one is fatal. A caption track can
 * only ever show one cue at a time, so stacked cues are already wrong on screen. And
 * `caption_the_edit` derives each cue's clip id from its start time — so two cues
 * starting on the same frame collide, `add_caption_layer` rejects the duplicate id, and
 * the *entire* captioning patch is thrown away. Observed in run `137d8fd0`: nine
 * consecutive `caption_the_edit` calls rejected at the same op, ~3,100 proposed changes
 * discarded, the run's whole caption budget spent on a retry loop that could not
 * succeed, because one clip's footage had been stacked under another's.
 *
 * The rule is the one the renderer already enforces: **at any instant there is exactly
 * one cue.** Cues are taken in sequence order and each is admitted only for the part of
 * the timeline no earlier cue already occupies. Ties resolve by end then clip id so the
 * result is total and stable. On a timeline with no stacked footage every cue is
 * admitted whole and the output is unchanged — the ordering this imposes is the order
 * the runs already produced.
 */
function resolveCueOverlaps(cues: readonly DerivedCue[], fps?: number): readonly DerivedCue[] {
  const ordered = [...cues].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.clipId.localeCompare(b.clipId),
  );
  const kept: DerivedCue[] = [];
  let occupiedUntil = -Infinity;
  for (const cue of ordered) {
    const start = Math.max(cue.start, occupiedUntil);
    // Nothing left of this cue once the earlier one has its share. Dropped rather
    // than shortened to zero: a zero-length cue is rejected at the patch boundary.
    if (cue.end - start <= TIME_EPSILON) continue;
    if (fps !== undefined && secondsToFrame(cue.end, fps) <= secondsToFrame(start, fps)) continue;
    if (start === cue.start) {
      kept.push(cue);
    } else {
      kept.push({
        ...cue,
        start,
        words: cue.words.map((word) => ({
          ...word,
          start: Math.max(word.start, start),
          end: Math.max(word.end, start),
        })),
      });
    }
    occupiedUntil = cue.end;
  }
  return kept;
}

/**
 * Which assets an UNATTRIBUTED transcript could actually have come from.
 *
 * Every mission fixture's transcript is schema <= v11 and carries no `assetId`, and the
 * v11 rule for such a word is "it applies to any clip". On a single-asset project that is
 * right. On one that has since gained b-roll, stock, or a music bed it is a fabrication:
 * a caption cue gets attributed to — and timed through — footage that was never speaking.
 *
 * The rule is the one the Critic (`5d0dbab`) and the golden rubric (`a255687`) already
 * apply, stated once here so the three cannot drift: a transcript can only have come from
 * an asset long enough to contain it. Images are excluded outright; an asset with no
 * declared duration cannot be ruled out, so it is kept.
 *
 * Returns `undefined` — meaning "no constraint, keep the v11 reading" — when nothing
 * qualifies. That is deliberate: no project may lose captions it had to a heuristic.
 *
 * @param assets - The project's assets.
 * @param transcript - The source-relative words about to be mapped.
 */
export function speechAssetIdsFor(
  assets: readonly Asset[] | undefined,
  transcript: readonly TranscriptWord[],
): ReadonlySet<string> | undefined {
  if (assets === undefined || assets.length === 0 || transcript.length === 0) return undefined;
  const spokenUntil = transcript.reduce((max, word) => Math.max(max, word.end), 0);
  if (spokenUntil <= 0) return undefined;
  const ids = new Set(
    assets
      .filter(
        (asset) =>
          asset.kind !== 'image' &&
          (asset.durationSeconds === undefined || asset.durationSeconds >= spokenUntil - 0.5),
      )
      .map((asset) => asset.id),
  );
  // Everything qualified, so the set says nothing the v11 reading did not. Returning
  // `undefined` keeps the fast path and makes the "narrowed" case visible in a debugger.
  if (ids.size === 0 || ids.size === assets.length) return undefined;
  return ids;
}
