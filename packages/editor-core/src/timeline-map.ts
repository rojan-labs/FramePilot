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
   * Constant playback rate. Always a positive number here — an absent or
   * non-positive `Clip.speed` is normalised to `1` so consumers never divide by
   * zero or branch on `undefined`.
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
 * Normalise a clip's speed. Absent, zero, and negative all become `1`.
 *
 * Reverse playback is not representable in schema v12 (`speed` is
 * `z.number().positive()`), so a non-positive value can only arrive from
 * hand-edited or corrupted project JSON. Coercing to `1` keeps the map total —
 * every clip gets a span — rather than throwing during what is fundamentally a
 * read operation.
 */
const normalizeSpeed = (speed: number | undefined): number =>
  speed !== undefined && speed > 0 ? speed : 1;

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
 * `sourceStart + elapsed * speed`: at 2x, one second of sequence consumes two
 * seconds of source. The caller is responsible for the instant actually lying in
 * the span — see {@link mapSequenceTime} for the checked entry point.
 */
export function spanSequenceToSource(span: ClipSpan, sequenceTime: number): number {
  return span.sourceStart + (sequenceTime - span.start) * span.speed;
}

/**
 * Convert an asset instant inside `span` to its sequence time.
 *
 * The exact inverse of {@link spanSequenceToSource}: at 2x, two seconds of
 * source occupy one second of sequence.
 */
export function spanSourceToSequence(span: ClipSpan, sourceTime: number): number {
  return span.start + (sourceTime - span.sourceStart) / span.speed;
}

/** Does `span` read this asset instant? Half-open, epsilon-tolerant. */
export function spanCoversSource(span: ClipSpan, assetId: string, sourceTime: number): boolean {
  return (
    span.assetId === assetId &&
    sourceTime >= span.sourceStart - TIME_EPSILON &&
    sourceTime < span.sourceEnd - TIME_EPSILON
  );
}

/** Does `span` play at this sequence instant? Half-open, epsilon-tolerant. */
export function spanCoversSequence(span: ClipSpan, sequenceTime: number): boolean {
  return (
    sequenceTime >= span.start - TIME_EPSILON && sequenceTime < span.end - TIME_EPSILON
  );
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
export function retainedSourceRanges(
  map: TimelineMap,
  assetId?: string,
): readonly ClipSpan[] {
  return assetId === undefined
    ? map.spans
    : map.spans.filter((span) => span.assetId === assetId);
}
