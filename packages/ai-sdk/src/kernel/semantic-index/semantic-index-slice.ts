/**
 * @framepilot/ai-sdk/kernel/semantic-index/semantic-index-slice — structured slice
 * retrieval over the Semantic Timeline Index
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md P4.2).
 *
 * A proposer (Planner, EditProposer) should reason over "the dialogue between 12–18s" or
 * "the beat grid", not a whole-timeline dump — this module is the filter that turns a
 * {@link SemanticTimelineIndex} plus a small query (a time range, a layer/track id, and/or
 * which categories matter) into a {@link SemanticIndexSlice} carrying only the entries that
 * overlap. It is deliberately **just a filter, not a new data model**: every field in a
 * slice is the exact entry shape the index already defines, never re-derived or enriched.
 *
 * **Time-range filtering only applies where an entry carries its own time span.**
 * `dialogue`/`captions`/`shots`/`silences` have `start`/`end`; `layers` has a `span`;
 * `music` has `ranges`; `beats` has a flat `times` grid. `transitions` and `effects` carry
 * only a `clipId` — the index does not join them to a clip's timeline position — so a
 * `timeRange` query cannot honestly narrow them without fabricating a lookup this module
 * doesn't have; they are included or excluded whole by `kinds` only. Likewise `layerId`
 * only narrows the categories that actually carry a track id (`layers`, `music`,
 * `captions`); nothing here silently pretends a match it can't compute.
 */
import type {
  BeatGrid,
  CaptionEntry,
  DialogueSegment,
  MusicEntry,
  SemanticEffectEntry,
  SemanticLayer,
  SemanticTimelineIndex,
  ShotEntry,
  SilenceRange,
  TimeRange,
  TransitionEntry,
} from './semantic-index.js';

/** Which top-level categories of the index a slice query may restrict to. */
export type SemanticIndexEntryKind =
  | 'layers'
  | 'dialogue'
  | 'captions'
  | 'transitions'
  | 'effects'
  | 'music'
  | 'shots'
  | 'silences'
  | 'beats';

/** All categories — the default when a query omits `kinds`. */
const ALL_KINDS: readonly SemanticIndexEntryKind[] = [
  'layers',
  'dialogue',
  'captions',
  'transitions',
  'effects',
  'music',
  'shots',
  'silences',
  'beats',
];

/** A structured request for a subset of the index (P4.2 — "dialogue 12–18s", "beat grid"). */
export interface SemanticIndexSliceQuery {
  /** Half-open timeline range; entries outside it are dropped (where computable). */
  readonly timeRange?: TimeRange;
  /** A track id; narrows the categories that carry one (`layers`, `music`, `captions`). */
  readonly layerId?: string;
  /** Restrict to these categories; every category when omitted. */
  readonly kinds?: readonly SemanticIndexEntryKind[];
}

/**
 * The filtered projection {@link getSlice} returns — the same entry shapes as
 * {@link SemanticTimelineIndex}, narrowed by the query. A category not requested by
 * `kinds` comes back empty (`[]`/`null`), never omitted from the shape, so a caller can
 * always destructure every field.
 */
export interface SemanticIndexSlice {
  readonly layers: readonly SemanticLayer[];
  readonly dialogue: readonly DialogueSegment[];
  readonly captions: readonly CaptionEntry[];
  readonly transitions: readonly TransitionEntry[];
  readonly effects: readonly SemanticEffectEntry[];
  readonly music: readonly MusicEntry[];
  readonly shots: readonly ShotEntry[];
  readonly silences: readonly SilenceRange[];
  readonly beats: BeatGrid | null;
}

export interface SemanticSliceLimits {
  readonly entriesPerKind: number;
  readonly beatTimes: number;
  readonly musicRangesPerTrack: number;
}

/** Planner-safe defaults: broad temporal coverage without a whole-project prompt dump. */
export const DEFAULT_SEMANTIC_SLICE_LIMITS: SemanticSliceLimits = {
  entriesPerKind: 128,
  beatTimes: 512,
  musicRangesPerTrack: 128,
};

/** Deterministically retain the first, last, and evenly distributed interior entries. */
export function sampleEvenly<T>(entries: readonly T[], rawLimit: number): readonly T[] {
  const limit = Math.max(1, Math.floor(rawLimit));
  if (entries.length <= limit) return entries;
  if (limit === 1) return [entries[0]!];
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round((index * (entries.length - 1)) / (limit - 1));
    return entries[sourceIndex]!;
  });
}

/**
 * Bound a whole-project slice before placing it in a model request. Sampling is even
 * across source order, so long timelines retain beginning/middle/end coverage instead of
 * silently becoming "the first N entries". Exact, focused queries can keep using
 * {@link getSlice} directly.
 */
export function boundSemanticIndexSlice(
  slice: SemanticIndexSlice,
  limits: SemanticSliceLimits = DEFAULT_SEMANTIC_SLICE_LIMITS,
): SemanticIndexSlice {
  const music = sampleEvenly(slice.music, limits.entriesPerKind).map((entry) => ({
    ...entry,
    ranges: sampleEvenly(entry.ranges, limits.musicRangesPerTrack),
  }));
  const beatTimes = slice.beats ? sampleEvenly(slice.beats.times, limits.beatTimes) : undefined;
  const beats = slice.beats
    ? slice.beats.bpm === undefined
      ? { times: beatTimes! }
      : { times: beatTimes!, bpm: slice.beats.bpm }
    : null;
  return {
    layers: sampleEvenly(slice.layers, limits.entriesPerKind),
    dialogue: sampleEvenly(slice.dialogue, limits.entriesPerKind),
    captions: sampleEvenly(slice.captions, limits.entriesPerKind),
    transitions: sampleEvenly(slice.transitions, limits.entriesPerKind),
    effects: sampleEvenly(slice.effects, limits.entriesPerKind),
    music,
    shots: sampleEvenly(slice.shots, limits.entriesPerKind),
    silences: sampleEvenly(slice.silences, limits.entriesPerKind),
    beats,
  };
}

/** True when half-open ranges `a` and `b` overlap at all (a zero-length query matches nothing). */
function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && a.end > b.start;
}

/** Filter entries with their own `start`/`end` to those overlapping `range` (or all, when absent). */
function byTimeRange<T extends { readonly start: number; readonly end: number }>(
  entries: readonly T[],
  range: TimeRange | undefined,
): readonly T[] {
  if (!range) return entries;
  return entries.filter((e) => overlaps(range, { start: e.start, end: e.end }));
}

function sliceLayers(
  layers: readonly SemanticLayer[],
  layerId: string | undefined,
  range: TimeRange | undefined,
): readonly SemanticLayer[] {
  const byLayer = layerId ? layers.filter((l) => l.trackId === layerId) : layers;
  if (!range) return byLayer;
  return byLayer.filter((l) => l.span !== null && overlaps(range, l.span));
}

function sliceCaptions(
  captions: readonly CaptionEntry[],
  layerId: string | undefined,
  range: TimeRange | undefined,
): readonly CaptionEntry[] {
  const byLayer = layerId ? captions.filter((c) => c.trackId === layerId) : captions;
  return byTimeRange(byLayer, range);
}

function sliceMusic(
  music: readonly MusicEntry[],
  layerId: string | undefined,
  range: TimeRange | undefined,
): readonly MusicEntry[] {
  const byLayer = layerId ? music.filter((m) => m.trackId === layerId) : music;
  if (!range) return byLayer;
  return byLayer
    .map((m) => ({ ...m, ranges: m.ranges.filter((r) => overlaps(range, r)) }))
    .filter((m) => m.ranges.length > 0);
}

function sliceBeats(beats: BeatGrid | null, range: TimeRange | undefined): BeatGrid | null {
  if (!beats) return null;
  if (!range) return beats;
  const times = beats.times.filter((t) => t >= range.start && t < range.end);
  if (times.length === 0) return null;
  return beats.bpm !== undefined ? { times, bpm: beats.bpm } : { times };
}

/** Whether `kind` was requested (every kind is included when the query omits `kinds`). */
function wants(kinds: readonly SemanticIndexEntryKind[], kind: SemanticIndexEntryKind): boolean {
  return kinds.includes(kind);
}

/**
 * Filter a {@link SemanticTimelineIndex} down to the entries a query's `timeRange`/
 * `layerId`/`kinds` select (P4.2). Pure — never mutates `index` and performs no I/O.
 * An empty index or a query that matches nothing yields the all-empty slice shape, never
 * a thrown error.
 */
export function getSlice(
  index: SemanticTimelineIndex,
  query: SemanticIndexSliceQuery = {},
): SemanticIndexSlice {
  const kinds = query.kinds ?? ALL_KINDS;
  const { timeRange, layerId } = query;
  return {
    layers: wants(kinds, 'layers') ? sliceLayers(index.layers, layerId, timeRange) : [],
    dialogue: wants(kinds, 'dialogue') ? byTimeRange(index.dialogue, timeRange) : [],
    captions: wants(kinds, 'captions') ? sliceCaptions(index.captions, layerId, timeRange) : [],
    // No timeline position on a TransitionEntry/SemanticEffectEntry (see module doc) — a
    // `timeRange`/`layerId` query can't narrow these honestly, so `kinds` is the only gate.
    transitions: wants(kinds, 'transitions') ? index.transitions : [],
    effects: wants(kinds, 'effects') ? index.effects : [],
    music: wants(kinds, 'music') ? sliceMusic(index.music, layerId, timeRange) : [],
    shots: wants(kinds, 'shots') ? byTimeRange(index.shots, timeRange) : [],
    silences: wants(kinds, 'silences') ? byTimeRange(index.silences, timeRange) : [],
    beats: wants(kinds, 'beats') ? sliceBeats(index.beats, timeRange) : null,
  };
}
