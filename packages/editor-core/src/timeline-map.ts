/**
 * The canonical source ↔ sequence time mapping — the one place that knows where
 * a moment of source footage ended up on the edited timeline, and vice versa.
 *
 * ## WHY this module exists
 *
 * A transcript is tied to the **source asset**: word 42 sounds at 19.2s *of the
 * camera file*. A timeline clip is tied to the **sequence**: it plays from 6.4s
 * to 19.0s *of the edit*, showing source 6.86s–19.5s. Before this module nothing
 * in the codebase held that distinction. `Project.transcript` was a flat word
 * list that every consumer read as if its timestamps were sequence timestamps —
 * true only for the degenerate case of one untrimmed clip starting at t=0, which
 * is exactly the state a project is in before anybody edits it. The instant a
 * ripple delete removed a range, every caption was placed at the wrong time, and
 * nothing detected it: the caption clips existed, covered plausible times, and
 * every operation reported success.
 *
 * The tempting fix — have the caller (or worse, a language model) compute
 * `sourceTime - clip.sourceStart + clip.start` — is wrong in a way that only
 * shows up later. It silently breaks on speed changes, on a source range reused
 * twice, on words straddling a cut, on reordered clips, and on any edit applied
 * *after* the offsets were computed. Offset arithmetic must live in exactly one
 * tested place, and this is it.
 *
 * ## The contract
 *
 * - Source time is **asset-relative**. Sequence time is **project-relative**.
 * - The forward direction is one-to-many: a source instant can appear zero times
 *   (it was cut) or several times (the range was used twice). So
 *   {@link mapSourceTime} returns a list, never a single number.
 * - The reverse direction is many-to-one *per track*: a sequence instant maps to
 *   at most one clip on any given track. {@link mapSequenceTime} returns the
 *   topmost hit.
 * - Nothing here mutates, reads global state, or knows about captions. It is a
 *   pure function of a {@link Timeline}, which is what makes it testable against
 *   every edit shape and what lets the AI layer treat its output as authoritative
 *   data rather than something to re-derive.
 *
 * @see docs/adr/0076-canonical-timeline-mapping.md
 */
import type { Timeline } from '@framepilot/timeline-schema';

/**
 * Comparison slack for time arithmetic, in seconds — well under a frame at any
 * sane rate (1µs vs 1/240s ≈ 4167µs).
 *
 * WHY it is needed: clip boundaries are produced by float arithmetic on
 * frame-quantised values, so a word ending at exactly a cut lands at
 * `19.499999999999996` rather than `19.5`. Without slack that word is judged to
 * overlap the *next* clip by 4e-15 seconds and gets attributed to it, which
 * shows up as a single stray word captioned one cut too late. Every overlap and
 * containment test in this module goes through it.
 */
export const TIME_EPSILON = 1e-6;

/**
 * Track types whose clips consume source media time, and therefore participate
 * in the mapping.
 *
 * Caption and overlay tracks are deliberately excluded: a caption clip's
 * `sourceStart`/`sourceEnd` are placeholders (it has no media to seek into), so
 * including it would invent spurious source ranges and — since captions are the
 * thing we are *deriving* — make the map depend on its own output.
 */
const TIMED_TRACK_TYPES: ReadonlySet<string> = new Set(['video', 'audio']);

/**
 * One clip's complete, self-contained timing relationship between its asset and
 * the sequence. Everything downstream — caption mapping, transition eligibility,
 * verification — reads these and nothing else.
 */
export interface ClipSpan {
  readonly clipId: string;
  readonly assetId: string;
  readonly trackId: string;
  /** Sequence in-point, seconds. */
  readonly start: number;
  /** Sequence out-point, seconds. */
  readonly end: number;
  /** Asset in-point, seconds. */
  readonly sourceStart: number;
  /** Asset out-point, seconds. */
  readonly sourceEnd: number;
  /**
   * Constant playback rate, **signed**, exactly as schema v15 defines it
   * (ADR 0090):
   *
   * - `> 0` — forward at that rate;
   * - `< 0` — the source range is consumed backwards at `|speed|`;
   * - `0` — a freeze: the frame at {@link sourceStart} is held for the span.
   *
   * Only an absent or non-finite `Clip.speed` is normalised, to `1`, so
   * consumers never branch on `undefined`. Do **not** do offset arithmetic with
   * this value directly — a division by a zero speed, or by a negative one, is
   * the bug this field's sign exists to prevent. Go through
   * {@link spanSequenceToSource} / {@link spanSourceToSequence}, which handle
   * all three cases.
   */
  readonly speed: number;
}

/**
 * The timeline's timing, resolved: every media clip's span, in sequence order,
 * plus the derived totals callers would otherwise recompute (inconsistently).
 */
export interface TimelineMap {
  /** Media clip spans, ordered by sequence start then track id (stable). */
  readonly spans: readonly ClipSpan[];
  /** Sequence duration: the latest span end, or 0 for an empty timeline. */
  readonly duration: number;
  /**
   * The timeline revision these spans were read from. Stamped onto anything
   * derived from the map so staleness is detectable rather than assumed.
   */
  readonly revision: number;
}

/** Where a source instant landed on the sequence, and via which clip. */
export interface SourceHit {
  readonly clipId: string;
  readonly trackId: string;
  readonly sequenceTime: number;
}

/** What is playing at a sequence instant, and where it reads from in the asset. */
export interface SequenceHit {
  readonly clipId: string;
  readonly assetId: string;
  readonly trackId: string;
  readonly sourceTime: number;
}

// ---------------------------------------------------------------------------
// Building the map
// ---------------------------------------------------------------------------

/**
 * Normalise a clip's speed to a finite number, preserving its SIGN.
 *
 * Schema v15 (`speed: z.number().finite().optional()`, ADR 0090) makes zero and
 * negative rates first-class: `0` is a freeze, `< 0` is reverse, and both are
 * reachable from the product — `set_clip_playback_mode` emits them, the
 * validator accepts them, and the Python compiler renders them (`TimeMirror` for
 * reverse, a held frame for a freeze). This module used to coerce every
 * non-positive speed to `1` on the since-falsified premise that schema v12's
 * `z.number().positive()` made them unreachable, which mapped a reversed clip
 * forwards and a freeze as a full 1x walk of its source range — wrong times for
 * captions, verification, the critic and the map tools alike.
 *
 * Only genuinely unusable values are coerced: an absent speed (the overwhelming
 * common case — 1x is stored as absent) and a non-finite one, which can arrive
 * only from hand-edited or corrupted project JSON. Coercing those keeps the map
 * total — every clip gets a span — rather than throwing during what is
 * fundamentally a read operation.
 */
const normalizeSpeed = (speed: number | undefined): number =>
  speed !== undefined && Number.isFinite(speed) ? speed : 1;

/**
 * Is this span a freeze — a single held frame rather than a consumed range?
 *
 * Exposed because a freeze is genuinely a different *kind* of span, not a slow
 * one: its source range names the held frame instead of a range that plays, it
 * carries no audio, and the source→sequence direction is not a function on it.
 * Consumers that walk source ranges (transcript mapping, above all) have to ask.
 */
export const spanIsFrozen = (span: ClipSpan): boolean => span.speed === 0;

/**
 * Read a timeline's clip timing into the canonical map.
 *
 * Pure and cheap (one pass plus a sort), so callers should build it fresh rather
 * than cache it — a cached map is precisely the stale-offset bug this module
 * exists to prevent.
 *
 * @param timeline - The timeline to read. Not mutated.
 * @returns Spans for every clip on a video or audio track, in sequence order.
 */
export function buildTimelineMap(timeline: Timeline): TimelineMap {
  const spans: ClipSpan[] = [];
  for (const track of timeline.tracks) {
    if (!TIMED_TRACK_TYPES.has(track.type)) continue;
    for (const clip of track.clips) {
      spans.push({
        clipId: clip.id,
        assetId: clip.assetId,
        trackId: track.id,
        start: clip.start,
        end: clip.end,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        speed: normalizeSpeed(clip.speed),
      });
    }
  }
  // Sort by sequence position, tie-broken by track then clip id so the order is
  // total and stable — callers index into `spans` in tests and goldens.
  spans.sort(
    (a, b) =>
      a.start - b.start || a.trackId.localeCompare(b.trackId) || a.clipId.localeCompare(b.clipId),
  );
  const duration = spans.reduce((max, span) => Math.max(max, span.end), 0);
  return { spans, duration, revision: timeline.revision ?? 0 };
}

// ---------------------------------------------------------------------------
// Per-span conversion — the only offset arithmetic in the product
// ---------------------------------------------------------------------------

/**
 * Convert a sequence instant inside `span` to its asset time.
 *
 * Forward (`speed > 0`): `sourceStart + elapsed * speed` — at 2x, one second of
 * sequence consumes two seconds of source.
 *
 * Reverse (`speed < 0`): the range is consumed from its OUT point backwards, so
 * the clip's first frame is `sourceEnd` and the arithmetic is
 * `sourceEnd + elapsed * speed` (the negative sign walks it down). This mirrors
 * the render engine exactly: it subclips `[sourceStart, sourceEnd)`, reverses
 * that with `TimeMirror`, then scales by `|speed|`.
 *
 * Freeze (`speed === 0`): every instant of the span shows the same frame, the
 * one at `sourceStart`.
 *
 * The caller is responsible for the instant actually lying in the span — see
 * {@link mapSequenceTime} for the checked entry point.
 */
export function spanSequenceToSource(span: ClipSpan, sequenceTime: number): number {
  if (spanIsFrozen(span)) return span.sourceStart;
  const elapsed = sequenceTime - span.start;
  return span.speed < 0
    ? span.sourceEnd + elapsed * span.speed
    : span.sourceStart + elapsed * span.speed;
}

/**
 * Convert an asset instant inside `span` to its sequence time.
 *
 * The exact inverse of {@link spanSequenceToSource} wherever one exists: at 2x,
 * two seconds of source occupy one second of sequence; reversed, source time
 * runs backwards as sequence time runs forwards, so a LATER source instant maps
 * EARLIER on the sequence.
 *
 * A freeze has no inverse — the whole span shows one frame, so the mapping is
 * many-to-one and only `sourceStart` is present at all. It answers `span.start`,
 * the one sequence instant the held frame can honestly be pinned to. Callers
 * that must not treat a range as retained should test {@link spanIsFrozen};
 * {@link spanCoversSource} already refuses everything but the held frame.
 */
export function spanSourceToSequence(span: ClipSpan, sourceTime: number): number {
  if (spanIsFrozen(span)) return span.start;
  return span.speed < 0
    ? span.start + (sourceTime - span.sourceEnd) / span.speed
    : span.start + (sourceTime - span.sourceStart) / span.speed;
}

/**
 * Does `span` read this asset instant? Half-open, epsilon-tolerant.
 *
 * The half-open end is the one that maps to the span's EXCLUSIVE sequence end,
 * which is a different end depending on direction: forward, the source out-point
 * plays last and the range is `[sourceStart, sourceEnd)`; reversed, the clip
 * *opens* on `sourceEnd` and runs down to `sourceStart`, so the range is
 * `(sourceStart, sourceEnd]`. Getting this backwards makes the round trip
 * partial at exactly one boundary — the reversed clip's own first frame reported
 * as cut.
 *
 * A freeze reads exactly ONE instant however long it is held: claiming its whole
 * source range would report footage as retained that the render never plays, and
 * would place words the viewer never hears (the engine drops a frozen clip's
 * audio) all over the held frame.
 */
export function spanCoversSource(span: ClipSpan, assetId: string, sourceTime: number): boolean {
  if (span.assetId !== assetId) return false;
  if (spanIsFrozen(span)) return Math.abs(sourceTime - span.sourceStart) < TIME_EPSILON;
  if (span.speed < 0) {
    return (
      sourceTime > span.sourceStart + TIME_EPSILON && sourceTime <= span.sourceEnd + TIME_EPSILON
    );
  }
  return (
    sourceTime >= span.sourceStart - TIME_EPSILON && sourceTime < span.sourceEnd - TIME_EPSILON
  );
}

/** Does `span` play at this sequence instant? Half-open, epsilon-tolerant. */
export function spanCoversSequence(span: ClipSpan, sequenceTime: number): boolean {
  return sequenceTime >= span.start - TIME_EPSILON && sequenceTime < span.end - TIME_EPSILON;
}

// ---------------------------------------------------------------------------
// Map queries
// ---------------------------------------------------------------------------

/**
 * Every sequence position at which `sourceTime` of `assetId` is heard.
 *
 * Returns a list, not a number, because the relationship is genuinely
 * one-to-many: an empty list means the moment was cut, and more than one entry
 * means the range was used more than once (a callback, a B-roll reuse, the same
 * take on two tracks). Callers that assume a single answer are the bug this
 * shape prevents.
 *
 * @returns Hits in sequence order.
 */
export function mapSourceTime(
  map: TimelineMap,
  assetId: string,
  sourceTime: number,
): readonly SourceHit[] {
  return map.spans
    .filter((span) => spanCoversSource(span, assetId, sourceTime))
    .map((span) => ({
      clipId: span.clipId,
      trackId: span.trackId,
      sequenceTime: spanSourceToSequence(span, sourceTime),
    }))
    .sort((a, b) => a.sequenceTime - b.sequenceTime);
}

/**
 * What is playing at `sequenceTime`, reading the topmost media track.
 *
 * "Topmost" is the last span in track order at that instant, matching the
 * compositing rule elsewhere in the engine (later tracks draw over earlier
 * ones). Returns `null` in a gap or past the end — an honest absence rather than
 * a clamped guess at a neighbouring clip.
 */
export function mapSequenceTime(map: TimelineMap, sequenceTime: number): SequenceHit | null {
  let hit: ClipSpan | undefined;
  for (const span of map.spans) {
    if (spanCoversSequence(span, sequenceTime)) hit = span;
  }
  if (hit === undefined) return null;
  return {
    clipId: hit.clipId,
    assetId: hit.assetId,
    trackId: hit.trackId,
    sourceTime: spanSequenceToSource(hit, sequenceTime),
  };
}

/**
 * The asset ranges the sequence actually retains, per clip — the applied edit
 * decision list, read back from the timeline rather than from what was planned.
 *
 * This is what verification compares a proposed EDL against: the committed
 * timeline is the source of truth, because snapping, merge behaviour, transition
 * overlap and rounding all mean the applied result may differ from the plan.
 */
export function retainedSourceRanges(map: TimelineMap, assetId?: string): readonly ClipSpan[] {
  return assetId === undefined ? map.spans : map.spans.filter((span) => span.assetId === assetId);
}
