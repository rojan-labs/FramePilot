/**
 * @framepilot/ai-sdk/kernel/semantic-index — the Semantic Timeline Index
 * (plan/AI-ORCHESTRATION-REDESIGN.md §8.3, Phase K2.1).
 *
 * A **derived semantic projection** of the {@link Project} document: the thing that
 * lets a proposer (Planner, EditProposer) reason like an editor — "the dialogue
 * between 12–18s", "the transitions", "the beat grid" — instead of re-reading raw
 * `project.fp.json` clip JSON. It is `f(ProjectDoc[, analysisResults])`; the Project
 * document stays the only writable truth (no schema change — tenet 8 of
 * AGENT-NATIVE-UX).
 *
 * **Incremental by construction (the RFC's "content-hash keyed" property).** The
 * editor's state is immutable: a patch replaces only the objects along the modified
 * path, so an untouched `Track` keeps its identity. This module builds on
 * {@link indexFor} (which memoizes per-`Track` and per-`Project` via WeakMaps) and
 * memoizes the whole semantic index per `Project` snapshot — so a trim to one clip
 * re-derives only what depends on the changed track, and an untouched project reuses
 * everything by reference. Immutable-snapshot identity is a stronger invalidation key
 * than a hash (there is no mutable cache to drift or invalidate); see
 * `project-index.ts` for the same argument.
 *
 * **Scope of K2.1 — honest gating; widened in P4.1.** The slices derivable from the
 * ProjectDoc alone are always populated (`layers`, `dialogue`, `captions`, `transitions`,
 * `effects`, `music`). The slices that require host-tool analysis (`shots` ←
 * `detect_scenes`, `silences` ← `analyze_silence`, `beats` ← `detect_beats`) are now
 * ingested from an optional `analysisResults` bag (plan/AGENT-NATIVE-COMPLETION-PLAN.md
 * P4.1; `loudness`/`black` join the bag from the brain's persisted rows in
 * ORCHESTRATION_ENHANCEMENT_PLAN.md B2.4) — real results, mapped from the asset's
 * source-media time into timeline time via
 * every clip that actually references the analyzed asset ({@link ProjectIndex.clipsOfAsset}),
 * so an asset that isn't (yet) placed on the timeline honestly contributes nothing. Slices
 * gated on a schema/op that does not exist yet (`speedRamps`, `markers`, CV `broll`) are
 * still typed for a stable contract but left empty — they have no analysis result to
 * ingest. Nothing here is ever faked: an omitted `analysisResults` field reproduces the
 * exact K2.1 empty-array/null behavior.
 */
import type { Clip, Effect, Project, Track } from '@framepilot/timeline-schema';
import { clipKindOf, indexFor, type ProjectIndex } from '../../project-index.js';

/**
 * Normalize raw beat timestamps into a clean grid: finite, non-negative, de-duplicated, and
 * sorted ascending. A total function so the beat slice can assume an ordered grid regardless
 * of how `detect_beats` ordered or repeated its onsets.
 */
function buildBeatGrid(beats: readonly number[]): readonly number[] {
  const clean = beats.filter((t) => Number.isFinite(t) && t >= 0);
  return [...new Set(clean)].sort((a, b) => a - b);
}

/** A half-open time span in timeline seconds. */
export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One z-ordered, kind-labeled layer (from the layer summarizer's logic). `z` is the
 * track index — 0 renders on top (front); compositing runs front→back.
 */
export interface SemanticLayer {
  readonly trackId: string;
  readonly z: number;
  readonly position: 'front' | 'mid' | 'back';
  /** Dominant clip kind by count (video/audio/image/text/caption), or 'empty'. */
  readonly kind: string;
  readonly clipCount: number;
  /** Time span the layer's clips cover, or `null` when the layer is empty. */
  readonly span: TimeRange | null;
}

/**
 * A contiguous run of spoken words from the transcript. `speaker` is omitted:
 * schema v4 transcript words carry no speaker (honestly gated — added when the
 * schema or diarization analysis provides it).
 */
export interface DialogueSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly speaker?: string;
}

/** A caption clip (kind 'caption') with its rendered text. */
export interface CaptionEntry {
  readonly clipId: string;
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A transition effect and the clip it is attached to. */
export interface TransitionEntry {
  readonly clipId: string;
  readonly effectId: string;
  /** Transition kind from the effect params (cut/fade/cross-dissolve/…), if present. */
  readonly kind?: string;
  readonly durationSeconds?: number;
  /** The clip the transition dissolves from, when the op recorded it. */
  readonly fromClipId?: string;
}

/** Coarse category for a non-transition clip effect (drives retrieval grouping). */
export type SemanticEffectCategory = 'color' | 'audio' | 'mask' | 'text' | 'other';

/** A clip effect other than a transition, tagged with its semantic category. */
export interface SemanticEffectEntry {
  readonly clipId: string;
  readonly effectId: string;
  readonly type: string;
  readonly category: SemanticEffectCategory;
}

/** An audio layer and the time ranges it fills (music/VO — indistinguishable
 *  without analysis; refined once detect_beats/classification lands). */
export interface MusicEntry {
  readonly trackId: string;
  readonly ranges: readonly TimeRange[];
}

/** A detected shot (analysis-fed — from `detect_scenes`; empty unless an `analysisResults`
 *  bag is supplied, P4.1). `motion`/`brightness` are not produced by the engine yet. */
export interface ShotEntry {
  readonly start: number;
  readonly end: number;
  readonly sourceClipId: string;
  readonly motion?: number;
  readonly brightness?: number;
}

/** A silent range (analysis-fed — from `analyze_silence`; empty unless an `analysisResults`
 *  bag is supplied, P4.1). `dB` is not produced by the engine yet. */
export interface SilenceRange {
  readonly start: number;
  readonly end: number;
  readonly dB?: number;
}

/** The music beat grid (analysis-fed — from `detect_beats`; `null` unless an
 *  `analysisResults` bag is supplied, P4.1). */
export interface BeatGrid {
  readonly times: readonly number[];
  readonly bpm?: number;
}

/** A speed/time-remap ramp. Empty until a speed op exists (punch-in is scale/zoom,
 *  represented as keyframes, not a playback-speed change). */
export interface SpeedRamp {
  readonly clipId: string;
  readonly effectId: string;
}

/** Programme loudness of a placed asset (analysis-fed — from the brain's `loudness`
 *  rows via the bag, plan B2.4; `null` unless supplied AND the asset is placed). */
export interface LoudnessInfo {
  readonly assetId: string;
  readonly integratedLufs: number;
  readonly loudnessRangeLu?: number;
  readonly truePeakDbfs?: number;
}

/**
 * The completed host-tool analysis results to ingest into the index (P4.1). Each field is
 * the **raw** payload the tool returned (e.g. `{ assetId, cuts: [{ time }] }` for
 * `detect_scenes` — see `engine/python/framepilot_engine/service.py`'s response models and
 * `sidecar-executor.ts`) — deliberately `unknown`, not a strict interface: the ingestion
 * below reads it as defensively as every other analysis consumer in this codebase
 * (`recipe-leaves.ts#readSpans`), so a malformed or
 * partial payload degrades to "nothing ingested for this slice", never a thrown error or a
 * fabricated entry. Absent/undefined fields reproduce the honest K2.1 empty behavior.
 */
export interface AnalysisResultsBag {
  /** `detect_scenes` result: `{ assetId, cuts: [{ time }] }`. */
  readonly shots?: unknown;
  /** `analyze_silence` result: `{ assetId, ranges: [{ start, end, duration }] }`. */
  readonly silences?: unknown;
  /** `detect_beats` result: `{ assetId, beats: [{ time, strength }], bpm }`. */
  readonly beats?: unknown;
  /** Brain `loudness` row (B2.4): `{ assetId, integratedLufs, loudnessRangeLu?, truePeakDbfs? }`. */
  readonly loudness?: unknown;
  /** Brain `black` row (B2.4): `{ assetId, ranges: [{ start, end }] }`. */
  readonly black?: unknown;
}

/**
 * The derived semantic projection of one immutable {@link Project} snapshot. Pure —
 * building it never mutates the project. Prefer {@link semanticIndexFor} (memoized).
 */
export interface SemanticTimelineIndex {
  readonly layers: readonly SemanticLayer[];
  readonly dialogue: readonly DialogueSegment[];
  readonly captions: readonly CaptionEntry[];
  readonly transitions: readonly TransitionEntry[];
  readonly effects: readonly SemanticEffectEntry[];
  readonly music: readonly MusicEntry[];
  // --- analysis-fed (P4.1 ingestion) / schema-gated: see the module doc ---
  readonly shots: readonly ShotEntry[];
  readonly silences: readonly SilenceRange[];
  readonly beats: BeatGrid | null;
  readonly loudness: LoudnessInfo | null;
  readonly black: readonly TimeRange[];
  readonly speedRamps: readonly SpeedRamp[];
  readonly markers: readonly TimeRange[];
  readonly broll: readonly string[];
}

/**
 * Max gap (seconds) between one transcript word ending and the next beginning that
 * still counts as the same utterance. A larger gap starts a new {@link DialogueSegment}
 * — a deterministic, dependency-free segmentation (no diarization model in K2.1).
 */
const DIALOGUE_GAP_SECONDS = 0.6;

/** Effect `type` strings, by semantic category. Mirrors editor-core's canonical
 *  effect types (`operations.ts`: SUPPORTED_COLOR_GRADE_EFFECTS, audio_gain, mask,
 *  text/caption/transition). Unlisted types fall through to 'other'. */
const COLOR_EFFECT_TYPES: ReadonlySet<string> = new Set(['color_grade', 'lut', 'transform']);
const AUDIO_EFFECT_TYPES: ReadonlySet<string> = new Set(['audio', 'audio_gain']);
const TEXT_EFFECT_TYPES: ReadonlySet<string> = new Set(['text', 'caption']);
const TRANSITION_EFFECT_TYPE = 'transition';
const MASK_EFFECT_TYPE = 'mask';

/** Categorize a non-transition effect for retrieval grouping. */
function effectCategory(type: string): SemanticEffectCategory {
  if (COLOR_EFFECT_TYPES.has(type)) return 'color';
  if (AUDIO_EFFECT_TYPES.has(type)) return 'audio';
  if (type === MASK_EFFECT_TYPE) return 'mask';
  if (TEXT_EFFECT_TYPES.has(type)) return 'text';
  return 'other';
}

/** The z-order position label for a track index in a stack of `count` tracks. */
function positionLabel(z: number, count: number): SemanticLayer['position'] {
  if (z === 0) return 'front';
  if (z === count - 1) return 'back';
  return 'mid';
}

/** Dominant clip kind of a layer (by count), or 'empty'. Mirrors the layer summarizer. */
function dominantKind(clips: readonly Clip[], assetById: ProjectIndex['assetById']): string {
  if (clips.length === 0) return 'empty';
  const counts = new Map<string, number>();
  for (const clip of clips) {
    const kind = clipKindOf(clip, assetById);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // Highest count wins; ties resolve to the first kind encountered (stable).
  let best = '';
  let bestCount = -1;
  for (const [kind, n] of counts) {
    if (n > bestCount) {
      best = kind;
      bestCount = n;
    }
  }
  return best;
}

/** The time span covering `clips`, or `null` when there are none. */
function spanOf(clips: readonly Clip[]): TimeRange | null {
  if (clips.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const clip of clips) {
    if (clip.start < start) start = clip.start;
    if (clip.end > end) end = clip.end;
  }
  return { start, end };
}

/** Derive the z-ordered, kind-labeled layer projection from the tracks. */
function deriveLayers(tracks: readonly Track[], index: ProjectIndex): SemanticLayer[] {
  return tracks.map((track, z) => {
    const clips = track.clips ?? [];
    return {
      trackId: track.id,
      z,
      position: positionLabel(z, tracks.length),
      kind: dominantKind(clips, index.assetById),
      clipCount: clips.length,
      span: spanOf(clips),
    };
  });
}

/**
 * Group the transcript's flat word list into contiguous utterances. Words are
 * assumed time-ordered (the engine emits them so); a gap larger than
 * {@link DIALOGUE_GAP_SECONDS} between adjacent words starts a new segment.
 */
function deriveDialogue(project: Project): DialogueSegment[] {
  const words = project.transcript;
  const segments: DialogueSegment[] = [];
  let current: { start: number; end: number; words: string[] } | null = null;
  for (const w of words) {
    if (current && w.start - current.end > DIALOGUE_GAP_SECONDS) {
      segments.push({ start: current.start, end: current.end, text: current.words.join(' ') });
      current = null;
    }
    if (!current) {
      current = { start: w.start, end: w.end, words: [w.word] };
    } else {
      current.words.push(w.word);
      if (w.end > current.end) current.end = w.end;
    }
  }
  if (current) {
    segments.push({ start: current.start, end: current.end, text: current.words.join(' ') });
  }
  return segments;
}

/** Read a string param off an effect, or `undefined`. */
function stringParam(effect: Effect, key: string): string | undefined {
  const value = (effect.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a number param off an effect, or `undefined`. */
function numberParam(effect: Effect, key: string): number | undefined {
  const value = (effect.params as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Walk every clip once, classifying its effects into transitions vs. categorized
 * effects and collecting caption clips. Single pass keeps the derivation O(clips+effects).
 */
function deriveClipDerived(index: ProjectIndex): {
  captions: CaptionEntry[];
  transitions: TransitionEntry[];
  effects: SemanticEffectEntry[];
} {
  const captions: CaptionEntry[] = [];
  const transitions: TransitionEntry[] = [];
  const effects: SemanticEffectEntry[] = [];
  for (const { clip, track } of index.clipById.values()) {
    if (clipKindOf(clip, index.assetById) === 'caption') {
      captions.push({
        clipId: clip.id,
        trackId: track.id,
        start: clip.start,
        end: clip.end,
        text: captionText(clip),
      });
    }
    for (const effect of clip.effects ?? []) {
      if (effect.type === TRANSITION_EFFECT_TYPE) {
        // Only include params that are actually present (exactOptionalPropertyTypes:
        // an optional field must be absent, not `undefined`).
        const entry: { -readonly [K in keyof TransitionEntry]: TransitionEntry[K] } = {
          clipId: clip.id,
          effectId: effect.id,
        };
        const kind = stringParam(effect, 'kind');
        const durationSeconds = numberParam(effect, 'durationSeconds');
        const fromClipId = stringParam(effect, 'fromClipId');
        if (kind !== undefined) entry.kind = kind;
        if (durationSeconds !== undefined) entry.durationSeconds = durationSeconds;
        if (fromClipId !== undefined) entry.fromClipId = fromClipId;
        transitions.push(entry);
      } else {
        effects.push({
          clipId: clip.id,
          effectId: effect.id,
          type: effect.type,
          category: effectCategory(effect.type),
        });
      }
    }
  }
  return { captions, transitions, effects };
}

/** The rendered text of a caption clip (from its `caption`/`text` effect), or ''. */
function captionText(clip: Clip): string {
  for (const effect of clip.effects ?? []) {
    if (effect.type === 'caption' || effect.type === 'text') {
      const text = stringParam(effect, 'text');
      if (text) return text;
    }
  }
  return '';
}

/** Derive audio-layer ranges. Every audio-kind clip contributes a range on its track. */
function deriveMusic(tracks: readonly Track[], index: ProjectIndex): MusicEntry[] {
  const music: MusicEntry[] = [];
  for (const track of tracks) {
    const ranges: TimeRange[] = [];
    for (const clip of track.clips ?? []) {
      if (clipKindOf(clip, index.assetById) === 'audio') {
        ranges.push({ start: clip.start, end: clip.end });
      }
    }
    if (ranges.length > 0) music.push({ trackId: track.id, ranges });
  }
  return music;
}

// ---------------------------------------------------------------------------
// P4.1 — analysis-result ingestion (source-media time -> timeline time)
// ---------------------------------------------------------------------------

/**
 * Clip a source-media-time span [sourceStart, sourceEnd) to `clip`'s trimmed window
 * ([clip.sourceStart, clip.sourceEnd)) and translate the overlap into timeline time.
 * `null` when the span does not overlap this clip's source window at all - the honest
 * "this shot/silence isn't part of what's actually placed on the timeline" case. Assumes
 * 1:1 playback speed (no `speedRamps` op exists yet - see the module doc), matching every
 * other timeline<->source mapping in this codebase.
 */
function translateSourceRange(
  clip: Clip,
  sourceStart: number,
  sourceEnd: number,
): TimeRange | null {
  const start = Math.max(sourceStart, clip.sourceStart);
  const end = Math.min(sourceEnd, clip.sourceEnd);
  if (end <= start) return null;
  const offset = clip.start - clip.sourceStart;
  return { start: start + offset, end: end + offset };
}

/** Translate one source-media-time point through `clip`, or `null` when it falls outside
 *  the clip's trimmed source window (see {@link translateSourceRange}). */
function translateSourceTime(clip: Clip, sourceTime: number): number | null {
  if (sourceTime < clip.sourceStart || sourceTime > clip.sourceEnd) return null;
  return clip.start + (sourceTime - clip.sourceStart);
}

/** Read `record.assetId`, or `undefined` when the payload doesn't carry one honestly. */
function readAssetId(record: Record<string, unknown>): string | undefined {
  return typeof record.assetId === 'string' ? record.assetId : undefined;
}

/** A finite, non-negative time reduced from a raw analysis-result row, or `undefined`. */
function readTime(row: unknown, key: string): number | undefined {
  const value = (row as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reduce a raw `detect_scenes` payload (`{ assetId, cuts: [{ time }] }`) to its asset id and
 * a clean, deduped, ascending list of cut times. `undefined` when the payload doesn't even
 * honestly carry an asset id - nothing to attribute the cuts to.
 */
function readSceneCuts(data: unknown): { assetId: string; times: readonly number[] } | undefined {
  const record = (data ?? {}) as Record<string, unknown>;
  const assetId = readAssetId(record);
  if (!assetId) return undefined;
  const rows = Array.isArray(record.cuts) ? record.cuts : [];
  const times = rows
    .map((row) => readTime(row, 'time'))
    .filter((t): t is number => t !== undefined);
  return { assetId, times: [...new Set(times)].sort((a, b) => a - b) };
}

/**
 * Derive {@link ShotEntry} entries from a `detect_scenes` result: consecutive cut times
 * bound one shot each (n cuts -> n-1 shots - a trailing tail past the last cut isn't
 * reported, since we don't know the asset's total duration), translated into timeline time
 * through every clip that actually places the analyzed asset ({@link ProjectIndex.clipsOfAsset}).
 * An asset with fewer than two cuts, or one not placed on the timeline at all, yields no shots.
 */
function deriveShots(index: ProjectIndex, shots: unknown): ShotEntry[] {
  const cuts = readSceneCuts(shots);
  if (!cuts || cuts.times.length < 2) return [];
  const entries: ShotEntry[] = [];
  for (const { clip } of index.clipsOfAsset(cuts.assetId)) {
    for (let i = 0; i < cuts.times.length - 1; i += 1) {
      const range = translateSourceRange(
        clip,
        cuts.times[i] as number,
        cuts.times[i + 1] as number,
      );
      if (range) entries.push({ start: range.start, end: range.end, sourceClipId: clip.id });
    }
  }
  return entries.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Derive {@link SilenceRange} entries from an `analyze_silence` result
 * (`{ assetId, ranges: [{ start, end, duration }] }`), translated into timeline time through
 * every clip that places the analyzed asset. A malformed row (non-positive length) is
 * dropped, mirroring `recipe-leaves.ts#readSpans`.
 */
function deriveSilences(index: ProjectIndex, silences: unknown): SilenceRange[] {
  return deriveTranslatedRanges(index, silences);
}

/**
 * Shared reduction for the `{ assetId, ranges: [{ start, end }] }` payload family
 * (`analyze_silence`, brain `black` rows — B2.4): each source-time range is translated
 * into timeline time through every clip that places the analyzed asset. A malformed
 * row (non-positive length) is dropped, mirroring `recipe-leaves.ts#readSpans`.
 */
function deriveTranslatedRanges(index: ProjectIndex, payload: unknown): TimeRange[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const assetId = readAssetId(record);
  if (!assetId) return [];
  const rows = Array.isArray(record.ranges) ? record.ranges : [];
  const entries: TimeRange[] = [];
  for (const { clip } of index.clipsOfAsset(assetId)) {
    for (const row of rows) {
      const start = readTime(row, 'start');
      const end = readTime(row, 'end');
      if (start === undefined || end === undefined || end <= start) continue;
      const range = translateSourceRange(clip, start, end);
      if (range) entries.push(range);
    }
  }
  return entries.sort((a, b) => a.start - b.start);
}

/**
 * Derive the {@link LoudnessInfo} from a brain `loudness` row (B2.4). Loudness is a
 * per-asset scalar, not a time span, so the only honest gating is placement: an asset
 * with no clip on the timeline contributes `null` (same rule as every other slice —
 * unplaced media never populates the timeline projection). Optional ebur128 fields
 * survive only when they are real finite numbers.
 */
function deriveLoudness(index: ProjectIndex, loudness: unknown): LoudnessInfo | null {
  const record = (loudness ?? {}) as Record<string, unknown>;
  const assetId = readAssetId(record);
  if (!assetId || index.clipsOfAsset(assetId).length === 0) return null;
  const integrated = record.integratedLufs;
  if (typeof integrated !== 'number' || !Number.isFinite(integrated)) return null;
  const entry: { -readonly [K in keyof LoudnessInfo]: LoudnessInfo[K] } = {
    assetId,
    integratedLufs: integrated,
  };
  if (typeof record.loudnessRangeLu === 'number' && Number.isFinite(record.loudnessRangeLu))
    entry.loudnessRangeLu = record.loudnessRangeLu;
  if (typeof record.truePeakDbfs === 'number' && Number.isFinite(record.truePeakDbfs))
    entry.truePeakDbfs = record.truePeakDbfs;
  return entry;
}

/**
 * Derive the {@link BeatGrid} from a `detect_beats` result
 * (`{ assetId, beats: [{ time, strength }], bpm }`), translating every beat that falls
 * inside a clip's trimmed source window into timeline time. `null` when the asset isn't
 * placed on the timeline or no beat survives translation - an untethered beat grid is not
 * honestly reportable in timeline time.
 */
function deriveBeats(index: ProjectIndex, beats: unknown): BeatGrid | null {
  const record = (beats ?? {}) as Record<string, unknown>;
  const assetId = readAssetId(record);
  if (!assetId) return null;
  const rows = Array.isArray(record.beats) ? record.beats : [];
  const times: number[] = [];
  for (const { clip } of index.clipsOfAsset(assetId)) {
    for (const row of rows) {
      const time = readTime(row, 'time');
      if (time === undefined) continue;
      const translated = translateSourceTime(clip, time);
      if (translated !== null) times.push(translated);
    }
  }
  if (times.length === 0) return null;
  const grid = buildBeatGrid(times);
  const bpm =
    typeof record.bpm === 'number' && Number.isFinite(record.bpm) ? record.bpm : undefined;
  return bpm !== undefined ? { times: grid, bpm } : { times: grid };
}

/**
 * The beat grid alone, in timeline time, for a project + raw `detect_beats` payload.
 *
 * Exposes {@link deriveBeats} for the one caller that needs the grid and nothing else: the
 * beat-boundary rule the agent runtime applies per turn
 * (`kernel/beat-grid/beat-alignment.ts`). Building the whole {@link SemanticTimelineIndex}
 * there would compute scenes, silences, music, transitions, loudness and chapters on every
 * turn of a beat-backed run to read one array off the end of it.
 *
 * The underlying {@link indexFor} memoizes per project, so repeated calls against an
 * unchanged timeline re-walk nothing.
 */
export function beatGridFor(project: Project, rawBeats: unknown): BeatGrid | null {
  return deriveBeats(indexFor(project), rawBeats);
}

/** Build the semantic index for a project snapshot (prefer {@link semanticIndexFor}). */
export function buildSemanticIndex(
  project: Project,
  analysisResults?: AnalysisResultsBag,
): SemanticTimelineIndex {
  const index = indexFor(project);
  const tracks = project.timeline.tracks;
  const { captions, transitions, effects } = deriveClipDerived(index);
  return {
    layers: deriveLayers(tracks, index),
    dialogue: deriveDialogue(project),
    captions,
    transitions,
    effects,
    music: deriveMusic(tracks, index),
    // Analysis-fed - ingested from `analysisResults` when supplied (P4.1); honestly empty
    // otherwise (never faked). See the module doc for the source-time -> timeline-time mapping.
    shots: deriveShots(index, analysisResults?.shots),
    silences: deriveSilences(index, analysisResults?.silences),
    beats: deriveBeats(index, analysisResults?.beats),
    loudness: deriveLoudness(index, analysisResults?.loudness),
    black: deriveTranslatedRanges(index, analysisResults?.black),
    // Schema-gated - no op exists yet to feed these; honestly empty (see module doc).
    speedRamps: [],
    markers: [],
    broll: [],
  };
}

/**
 * Canonicalize an {@link AnalysisResultsBag} into a stable cache key, independent of field
 * insertion order or `undefined` vs. an absent field - both `semanticIndexFor(p)` and
 * `semanticIndexFor(p, {})` hit the same cache entry as today's bag-less behavior.
 */
function analysisBagKey(bag: AnalysisResultsBag | undefined): string {
  return JSON.stringify({
    shots: bag?.shots ?? null,
    silences: bag?.silences ?? null,
    beats: bag?.beats ?? null,
    loudness: bag?.loudness ?? null,
    black: bag?.black ?? null,
  });
}

/**
 * Two-level index cache (P4.1): the immutable `Project` snapshot, then a content-hash of
 * the analysis bag. This is what keeps `semanticIndexFor` memoized per (project, bag) pair
 * instead of rebuilding on every call - a naive "always rebuild when a bag is passed" would
 * be a real perf regression for a Planner that re-queries the same completed analyses
 * across several proposer calls in one run.
 */
const semanticIndexCache = new WeakMap<Project, Map<string, SemanticTimelineIndex>>();

/**
 * The semantic index for `project` (+ `analysisResults`, if supplied), derived at most once
 * per (project snapshot, analysis-bag) pair. After an edit, only the changed tracks are
 * re-walked by the underlying {@link indexFor}; an untouched project + bag reuses this whole
 * structure by reference.
 */
export function semanticIndexFor(
  project: Project,
  analysisResults?: AnalysisResultsBag,
): SemanticTimelineIndex {
  const key = analysisBagKey(analysisResults);
  let byBag = semanticIndexCache.get(project);
  if (!byBag) {
    byBag = new Map();
    semanticIndexCache.set(project, byBag);
  }
  const cached = byBag.get(key);
  if (cached) return cached;
  const built = buildSemanticIndex(project, analysisResults);
  byBag.set(key, built);
  return built;
}
