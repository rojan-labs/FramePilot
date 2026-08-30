/**
 * Pure, framework-agnostic derived-data helpers over a {@link Timeline}
 * (plan/PLAN.md Phase 3.2 — timeline UI, snapping, zoom).
 *
 * These are the deterministic building blocks the React timeline/preview
 * components render from. Keeping them here (no React, no DOM) means the
 * geometry, snapping, and "what is playing now" logic is unit-tested in
 * isolation; the components stay thin.
 */
import type {
  Asset,
  AssetMedia,
  BlendMode,
  Clip,
  CropRect,
  Effect,
  EffectLayer,
  Keyframe,
  Timeline,
  Track,
} from '@framepilot/timeline-schema';
import { effectLayersOf } from '@framepilot/timeline-schema';
import { transitionFromClip, type TransitionEnvelope } from '../preview/transition-envelope.js';
import {
  resolveTransitionParamsFor,
  type ResolvedTransition,
} from '../preview/transitions/transition-engine.js';
import { LEGACY_TRANSITION_IDS } from '@framepilot/timeline-schema/transition-catalog';
import { TRANSITION_OUT_EFFECT_TYPE } from '@framepilot/editor-core';

/**
 * A clean, human display name for an asset: the basename of its file path
 * (e.g. `/media/intro.mp4` → `intro.mp4`). Presentation only — ids stay the
 * canonical handle for selection/drag/patch. Falls back to `fallback` (usually
 * the clip/asset id) when the path is empty or the asset is missing.
 */
export function assetDisplayName(asset: Asset | undefined, fallback: string): string {
  if (!asset) return fallback;
  const base = asset.path.split(/[/\\]/).pop() ?? '';
  return base.length > 0 ? base : fallback;
}

/** The signed color-grade parameters (0 = no change), shared with the engine. */
export interface ColorGradeParams {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  shadows: number;
  highlights: number;
}

/** Identity grade (every axis 0). */
export const IDENTITY_GRADE: ColorGradeParams = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  shadows: 0,
  highlights: 0,
};

/** A clip together with the track it lives on. */
export interface ClipLocation {
  readonly track: Track;
  readonly clip: Clip;
}

/** The time span (seconds) a set of selected clips covers on the timeline. */
export interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The bounding time range (seconds) of a clip selection — the earliest
 * `start` to the latest `end` across every selected id, so a multi-clip
 * selection reduces to the one range the AI orchestrator's
 * `ContextInput.selection` (and the composer's selection chip) needs. Ids not
 * present on the timeline (stale selection) are skipped; `null` when none of
 * the ids resolve (empty selection, or every id is stale).
 *
 * Pure — the single source of truth for "selection → range", reused by
 * both the AI sidebar's request builder and the composer's context chip so
 * the two never compute this differently (plan P8.4/P12.7).
 */
export function selectionRange(
  timeline: Timeline,
  selectedIds: readonly string[],
): SelectionRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of selectedIds) {
    const located = findClip(timeline, id);
    if (!located) continue;
    if (located.clip.start < start) start = located.clip.start;
    if (located.clip.end > end) end = located.clip.end;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * Total timeline duration, in seconds: the largest clip end across all tracks.
 * An empty timeline has zero duration.
 */
export function timelineDuration(timeline: Timeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.end > max) {
        max = clip.end;
      }
    }
  }
  return max;
}

/** Find a clip (and its track) by id, or `null` when it is not present. */
export function findClip(timeline: Timeline, clipId: string): ClipLocation | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return { track, clip };
    }
  }
  return null;
}

/**
 * Clips that are visible/audible at time `t` (inclusive start, exclusive end),
 * in track order. Used to drive the preview at the current playhead.
 */
export function clipsActiveAt(timeline: Timeline, t: number): readonly ClipLocation[] {
  const active: ClipLocation[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (t >= clip.start && t < clip.end) {
        active.push({ track, clip });
      }
    }
  }
  return active;
}

/**
 * The next `count` video clips the playhead will enter strictly after
 * `fromTime`, in playback order — the clips the preview will cut to. Each gets
 * its own pool slot pre-warmed before the cut so the swap lands on
 * already-fetched, already-decoded, pre-seeked media instead of stalling on a
 * cold load (the freeze felt at every cut). Only video-kind clips need a slot:
 * a still image paints from the image cache and audio has no picture — and
 * skipping them here means the videos *behind* them still get warmed. Hidden
 * tracks contribute nothing (mirrors the render); ties on `start` resolve to
 * the topmost track (stable sort preserves track order).
 */
export function upcomingVideoClips(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  fromTime: number,
  count: number,
): readonly ClipLocation[] {
  const upcoming: ClipLocation[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.start <= fromTime) continue;
      if (clipKind(clip, assetById) !== 'video') continue;
      upcoming.push({ track, clip });
    }
  }
  upcoming.sort((a, b) => a.clip.start - b.clip.start);
  return upcoming.slice(0, count);
}

// ---------------------------------------------------------------------------
// Playback index (H3/H8) — O(log n) playhead queries for the 60fps clock
//
// `clipsActiveAt` / `upcomingVideoClips` scan every clip on every call. The
// preview calls both PER FRAME while playing, so on a long project (an hour of
// footage, thousands of clips) each rendered frame pays an O(n) walk — the CPU
// "build work" felt during playback. The index is built ONCE per timeline
// identity (memoized by the caller) and answers both queries by binary search.
// ---------------------------------------------------------------------------

/** A per-track run of clips sorted by start (start-sorted, non-overlapping). */
interface TrackRun {
  readonly track: Track;
  readonly sorted: readonly Clip[];
  readonly starts: readonly number[];
}

/** Precomputed structures for O(log n) playhead lookups. See {@link createPlaybackIndex}. */
export interface PlaybackIndex {
  readonly runs: readonly TrackRun[];
  /** Visible video-kind clips across all tracks, sorted by start (track-stable ties). */
  readonly videoByStart: readonly ClipLocation[];
  readonly videoStarts: readonly number[];
}

/** First index in `starts` whose value is strictly greater than `t`. */
function upperBound(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] as number) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build the playback index for a timeline. O(n log n) once per timeline change;
 * every per-frame query is then O(tracks · log clips).
 */
export function createPlaybackIndex(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): PlaybackIndex {
  const runs: TrackRun[] = timeline.tracks.map((track) => {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    return { track, sorted, starts: sorted.map((c) => c.start) };
  });
  const video: ClipLocation[] = [];
  for (const run of runs) {
    if (run.track.hidden) continue;
    for (const clip of run.sorted) {
      if (clipKind(clip, assetById) === 'video') video.push({ track: run.track, clip });
    }
  }
  // Stable sort: ties on start resolve to the topmost track, matching
  // `upcomingVideoClips`' track-major build + stable sort.
  video.sort((a, b) => a.clip.start - b.clip.start);
  return { runs, videoByStart: video, videoStarts: video.map((l) => l.clip.start) };
}

/**
 * {@link clipsActiveAt} over the index: same results, O(tracks · log clips).
 * Relies on the schema invariant that clips within a track never overlap (the
 * validator refuses overlapping patches), so within a track at most the single
 * clip preceding the playhead can cover it.
 */
export function activeClipsAt(index: PlaybackIndex, t: number): readonly ClipLocation[] {
  const active: ClipLocation[] = [];
  for (const run of index.runs) {
    for (let i = upperBound(run.starts, t) - 1; i >= 0; i -= 1) {
      const clip = run.sorted[i] as Clip;
      if (clip.end > t) {
        if (t >= clip.start) active.push({ track: run.track, clip });
      } else {
        break; // sorted + (validated) non-overlapping: nothing earlier can cover t
      }
    }
  }
  return active;
}

/** {@link upcomingVideoClips} over the index: same results, O(log n + count). */
export function upcomingVideoFrom(
  index: PlaybackIndex,
  fromTime: number,
  count: number,
): readonly ClipLocation[] {
  const from = upperBound(index.videoStarts, fromTime);
  return index.videoByStart.slice(from, from + count);
}

/** {@link audibleAudioClipsAt} over the index: same results, O(tracks · log clips). */
export function audibleAudioAt(
  index: PlaybackIndex,
  assetById: ReadonlyMap<string, Asset>,
  t: number,
  /** Tracks currently soloed for preview monitoring (H0.4); see {@link effectiveMutedTrackIds}. */
  soloed: ReadonlySet<string> = EMPTY_TRACK_IDS,
): readonly AudibleClip[] {
  const tracks = index.runs.map((run) => run.track);
  const muted = effectiveMutedTrackIds(tracks, soloed, assetById);
  const audible: AudibleClip[] = [];
  for (const { track, clip } of activeClipsAt(index, t)) {
    if (muted.has(track.id)) continue;
    if (clipKind(clip, assetById) !== 'audio') continue;
    const audio = audioSettings(clip);
    audible.push({
      track,
      clip,
      sourceTime: clip.sourceStart + (t - clip.start),
      volume: previewClipVolume(clip, audio, t, tracks),
    });
  }
  return audible;
}

// ---------------------------------------------------------------------------
// Clip kind (Phase 2 — type-agnostic layers, ADR 0032)
//
// A clip's renderable kind is *derived* from its content, never from its layer's
// (advisory) `type`. This is the single source of truth the preview, the timeline
// UI, and auto-layering all read, so a clip behaves the same on any layer.
// ---------------------------------------------------------------------------

/** The renderable kind of a clip. Mirrors the engine's `clip_kind`. */
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'caption';

// Synthetic asset ids for clips that have no media source. Kept in sync with
// editor-core's `TEXT_OVERLAY_ASSET_ID` / `CAPTION_ASSET_ID` (inlined so this pure
// selector module stays free of an editor-core dependency).
const TEXT_OVERLAY_ASSET_ID = '__text__';
const CAPTION_ASSET_ID = '__caption__';

/**
 * Derive a clip's renderable {@link ClipKind} from its asset (or synthetic id).
 * Text overlays and captions are recognised by their synthetic asset id; media
 * clips take their asset's `kind`, defaulting to `video` when the asset is unknown.
 */
export function clipKind(clip: Clip, assetById: ReadonlyMap<string, Asset>): ClipKind {
  if (clip.assetId === TEXT_OVERLAY_ASSET_ID) return 'text';
  if (clip.assetId === CAPTION_ASSET_ID) return 'caption';
  const kind = assetById.get(clip.assetId)?.kind;
  if (kind === 'audio') return 'audio';
  if (kind === 'image') return 'image';
  return 'video';
}

/**
 * Whether the timeline's picture content (video/image clips) is plain enough
 * for the WebCodecs canvas compositor. As of **P3a** the canvas pass
 * composites per-clip transform (keyframed scale/x/y), crop, grade and blend
 * mode (see {@link clipCompositing}); **P3b** adds text/caption overlays
 * composited on top (see {@link overlayClips}), so those no longer disqualify
 * a timeline either. What still falls back to the DOM `PreviewPlayer`:
 * - **two picture clips overlapping** in time (the flat-EDL model draws one
 *   picture at a time — no z-order compositing yet);
 * - a clip with non-1× **speed** (P4).
 *
 * Requires at least one picture (video/image) clip: an overlay- or audio-only
 * timeline has no frame to composite over, so it stays on the DOM path.
 * Audio-only clips otherwise impose no constraint. `false` for an empty
 * timeline. Hidden tracks' clips are ignored, matching
 * {@link upcomingVideoClips}/{@link createPlaybackIndex}.
 */
export function canvasPreviewEligible(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): boolean {
  const pictureClips: Clip[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const kind = clipKind(clip, assetById);
      if (kind !== 'video' && kind !== 'image') continue; // overlays/audio: no constraint
      if (clipSpeed(clip) !== 1) return false;
      pictureClips.push(clip);
    }
  }
  if (pictureClips.length === 0) return false;
  pictureClips.sort((a, b) => a.start - b.start);
  for (let i = 1; i < pictureClips.length; i++) {
    const prev = pictureClips[i - 1];
    const cur = pictureClips[i];
    if (prev && cur && cur.start < prev.end) return false; // overlap
  }
  return true;
}

/**
 * Whether WebCodecs is the efficient program-monitor path for this project.
 *
 * The compositor currently demuxes a source into an in-memory sample table.
 * That is intentionally fast for the engine's bounded, low-resolution proxies,
 * but disastrous for an unproxied feature-length original: opening one would
 * fetch and parse the whole movie before an edit could settle. Chromium's native
 * media element streams/range-reads those originals, so unproxied video uses the
 * DOM preview while images and proxy-backed video keep the canvas compositor.
 */
export function webCodecsPreviewEligible(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): boolean {
  if (!canvasPreviewEligible(timeline, assetById)) return false;

  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clipKind(clip, assetById) !== 'video') continue;
      const proxyPath = assetById.get(clip.assetId)?.media?.proxyPath;
      if (typeof proxyPath !== 'string' || proxyPath.length === 0) return false;
    }
  }
  return true;
}

/** One span of the flattened "picture" timeline (P2): either a clip
 * (video or image) or a gap (nothing active — `clip: null`). Ordered,
 * contiguous from 0, covering exactly `[0, timelineDuration(timeline))`. Only
 * meaningful when {@link canvasPreviewEligible} is true (assumes no overlaps). */
export interface PictureSegment {
  readonly start: number;
  readonly end: number;
  readonly clip: Clip | null;
}

export function pictureSegments(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): readonly PictureSegment[] {
  const pictureClips = timeline.tracks
    .flatMap((track) => (track.hidden ? [] : track.clips))
    .filter((clip) => {
      const kind = clipKind(clip, assetById);
      return kind === 'video' || kind === 'image';
    })
    .sort((a, b) => a.start - b.start);

  const segments: PictureSegment[] = [];
  let cursor = 0;
  for (const clip of pictureClips) {
    if (clip.start > cursor) {
      segments.push({ start: cursor, end: clip.start, clip: null });
    }
    segments.push({ start: clip.start, end: clip.end, clip });
    cursor = Math.max(cursor, clip.end);
  }
  return segments;
}

/**
 * A picture clip's full compositing state for the canvas pass (P3a): the
 * transform keyframes (scale/x/y, evaluated per-frame by the engine against
 * clip-relative time — never pre-flattened here, so animation stays exact),
 * plus the static crop rect, colour grade and blend mode. This is the single
 * projection the WebCodecs compositor consumes so it applies exactly what the
 * DOM `PreviewPlayer` renders via CSS transform/`clip-path`/`filter`/
 * `mix-blend-mode` — the deterministic truth remains the Python render, which
 * the canvas only approximates (grade especially — see
 * {@link colorGradeCssFilter}).
 */
export interface ClipCompositing {
  readonly keyframes: readonly Keyframe[];
  readonly crop: CropRect;
  readonly grade: ColorGradeParams;
  readonly blendMode: BlendMode;
  /** The transition entering this clip (ramps over its first seconds of
   * clip-relative time), or `null` when the clip enters on a plain cut.
   * Time-varying, so deliberately NOT part of {@link isIdentityCompositing} —
   * the canvas engine checks its activity per frame instead. */
  readonly transition: TransitionEnvelope | null;
  /**
   * The catalog transitions touching this clip, and the clip's own length (which
   * anchors the outgoing half's window).
   *
   * `null` in the overwhelmingly common case — a clip with no transition, or one
   * of the seven kinds that predate the catalog. Those keep the cheap envelope
   * path above; only a catalog kind needs a shader, and only then does the engine
   * pay for one.
   */
  readonly catalogTransition: CatalogTransitionPair | null;
}

/** Project a clip's compositing state for the canvas pass. */
export function clipCompositing(clip: Clip): ClipCompositing {
  return {
    keyframes: clip.keyframes,
    crop: clipCropRect(clip),
    grade: colorGradeParams(clip),
    blendMode: clipBlendMode(clip),
    transition: transitionFromClip(clip),
    catalogTransition: catalogTransitionPair(clip),
  };
}

/** The two halves of a catalog transition that touch one clip. */
export interface CatalogTransitionPair {
  /** The transition this clip enters ON, if it is a catalog kind. */
  readonly incoming: ResolvedTransition | null;
  /** The transition this clip leaves ON (centre/end alignment only). */
  readonly outgoing: ResolvedTransition | null;
  /** The clip's timeline length, which anchors the outgoing half's window. */
  readonly clipDuration: number;
}

/**
 * Resolve the catalog transitions on a clip, or `null` when there are none.
 *
 * The seven legacy kinds are deliberately excluded: they render through the
 * envelope path in both the preview and the export, and routing them here would
 * change what every project made before the catalog looks like.
 */
export function catalogTransitionPair(clip: Clip): CatalogTransitionPair | null {
  const inEffect = clip.effects.find((e) => e.type === 'transition');
  const outEffect = clip.effects.find((e) => e.type === TRANSITION_OUT_EFFECT_TYPE);
  const legacy = (effect: Effect | undefined): boolean =>
    effect !== undefined && LEGACY_TRANSITION_IDS.includes(String(effect.params?.kind ?? ''));
  const incoming =
    inEffect === undefined || legacy(inEffect)
      ? null
      : resolveTransitionParamsFor(inEffect.params ?? {});
  const outgoing =
    outEffect === undefined ? null : resolveTransitionParamsFor(outEffect.params ?? {});
  if (incoming === null && outgoing === null) return null;
  return { incoming, outgoing, clipDuration: clip.end - clip.start };
}

/**
 * True when a clip's compositing is a no-op — no transform keyframes, full
 * frame crop, identity grade, normal blend — so the engine can take the cheap
 * plain-`drawImage` path instead of the save/transform/clip/filter path.
 */
export function isIdentityCompositing(compositing: ClipCompositing): boolean {
  return (
    compositing.keyframes.length === 0 &&
    isFullFrameCrop(compositing.crop) &&
    isIdentityGrade(compositing.grade) &&
    compositing.blendMode === 'normal'
  );
}

/** Derive the {@link ClipKind} a freshly placed media asset would have. */
export function assetKind(asset: Asset): ClipKind {
  if (asset.kind === 'audio') return 'audio';
  if (asset.kind === 'image') return 'image';
  return 'video';
}

/**
 * The dominant {@link ClipKind} of a layer, by clip count (ties resolved toward the
 * frontmost clip). Returns `null` for an empty layer. Used to label/colour a layer
 * and to decide auto-layering compatibility — a layer is "type-agnostic" but still
 * has a *prevailing* kind derived from its current contents.
 */
export function layerKind(track: Track, assetById: ReadonlyMap<string, Asset>): ClipKind | null {
  if (track.clips.length === 0) return null;
  const counts = new Map<ClipKind, number>();
  for (const clip of track.clips) {
    const kind = clipKind(clip, assetById);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: ClipKind | null = null;
  let bestCount = 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** A picture kind draws a frame in the program monitor (video or still image). */
export const isPictureKind = (kind: ClipKind): boolean => kind === 'video' || kind === 'image';

/** An overlay kind draws text on top of the picture (text overlay or caption). */
export const isOverlayKind = (kind: ClipKind): boolean => kind === 'text' || kind === 'caption';

/**
 * Sorted, de-duplicated set of times edits should snap to: every clip start and
 * end across the timeline, plus the origin. Markers are added by the caller
 * (the store owns markers, the timeline does not).
 */
export function snapTargets(timeline: Timeline, extra: readonly number[] = []): readonly number[] {
  const targets = new Set<number>([0, ...extra]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      targets.add(clip.start);
      targets.add(clip.end);
    }
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * Snap `time` to the nearest target within `threshold` seconds; if none is
 * close enough, `time` is returned unchanged. Negative times clamp to zero.
 *
 * @param time - The raw time (e.g. from a drag in pixels converted to seconds).
 * @param targets - Candidate snap times (see {@link snapTargets}).
 * @param threshold - Maximum distance, in seconds, at which snapping engages.
 */
export function snap(time: number, targets: readonly number[], threshold: number): number {
  const clamped = time < 0 ? 0 : time;
  let best = clamped;
  let bestDistance = threshold;
  for (const target of targets) {
    const distance = Math.abs(target - clamped);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/** Frame rate used when a project reports an unusable (≤ 0 / non-finite) fps. */
export const FALLBACK_FPS = 30;

/** Zero-pad a non-negative integer to at least two digits (timecode fields). */
const pad2 = (value: number): string => (value < 10 ? `0${value}` : `${value}`);

/**
 * Format a timeline position as a frame-accurate SMPTE-style timecode
 * `HH:MM:SS:FF` (hours, minutes, seconds, frames).
 *
 * The frame field counts whole frames within the current second, so it ranges
 * `00`..`fps-1`. The input is quantised to the nearest frame first, so a value
 * that is a hair under a second boundary (e.g. `5.9999`) renders as the next
 * whole second rather than drifting — premium UIs must never show a jittering
 * last digit. Negative or non-finite inputs clamp to `00:00:00:00`, and a
 * non-positive `fps` falls back to {@link FALLBACK_FPS}.
 *
 * @param seconds - Timeline position in seconds.
 * @param fps - Project frame rate (frames per second).
 * @returns A `HH:MM:SS:FF` string with tabular, zero-padded fields.
 */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalFrames = Math.round(safeSeconds * rate);
  const wholeRate = Math.round(rate);
  const frame = totalFrames % wholeRate;
  const totalSeconds = Math.floor(totalFrames / wholeRate);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(frame)}`;
}

/** How time readouts are rendered — frame-accurate timecode, or plain seconds. */
export type TimeDisplay = 'timecode' | 'seconds';

/**
 * Format a timeline position as plain seconds (`12.34s`), tabular and stable.
 * Negative / non-finite inputs clamp to `0.00s`.
 *
 * @param seconds - Timeline position in seconds.
 * @returns A `N.NNs` string with two fixed decimals.
 */
export function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${safe.toFixed(2)}s`;
}

/**
 * Format a timeline position for display, honouring the user's preferred
 * {@link TimeDisplay} mode (Settings → Display). `timecode` is frame-accurate
 * SMPTE; `seconds` is plain decimal seconds. This is the single switch every time
 * readout (monitor, ruler) routes through, so the whole UI stays consistent.
 *
 * @param seconds - Timeline position in seconds.
 * @param fps - Project frame rate (used only for timecode).
 * @param mode - The active display mode (defaults to `timecode`).
 */
export function formatTime(seconds: number, fps: number, mode: TimeDisplay = 'timecode'): string {
  return mode === 'seconds' ? formatSeconds(seconds) : formatTimecode(seconds, fps);
}

/**
 * Clips on `trackId` that start at or after `atStart` — the "downstream" clips an
 * Insert placement must push right to make room (plan/TIMELINE-REVAMP.md §4). A
 * clip is downstream when its start is at/after the insertion point (within
 * {@link MIN_CLIP_SECONDS} tolerance), so a clip already abutting `atStart` is
 * shifted rather than overlapped. Returned **back-to-front** (descending start)
 * so a caller can shift each clip right without a later clip transiently colliding
 * with one it has not moved yet. Empty when the track is missing or nothing is
 * downstream.
 *
 * Pure (no DOM) and unit-tested in isolation.
 *
 * @param timeline - Current timeline.
 * @param trackId - The lane the insert targets.
 * @param atStart - The insertion point, in seconds.
 */
export function downstreamClips(
  timeline: Timeline,
  trackId: string,
  atStart: number,
): readonly Clip[] {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  return track.clips
    .filter((c) => c.start >= atStart - MIN_CLIP_SECONDS)
    .sort((a, b) => b.start - a.start);
}

/**
 * A transition placed on a cut (M3b). The engine stores a `transition` effect on
 * the *incoming* clip referencing the immediately-earlier clip via
 * `params.fromClipId`; this resolves that effect into the geometry the on-cut
 * pill UI needs (which junction, how wide, how far it can be dragged).
 */
export interface TransitionPlacement {
  /** The lane both clips live on. */
  readonly trackId: string;
  /** The earlier (outgoing) clip the transition ramps against. */
  readonly fromClipId: string;
  /** The incoming clip that carries the transition effect. */
  readonly toClipId: string;
  /** Effect id (`${toClipId}__transition`) — stable handle for the pill. */
  readonly effectId: string;
  readonly kind: string;
  readonly durationSeconds: number;
  /** Timeline time of the cut the pill straddles (the incoming clip's start). */
  readonly cutTime: number;
  /** True when the transition is being held off (the compare toggle). */
  readonly disabled: boolean;
  /**
   * The longest legal duration here — `min(incoming, outgoing)` clip length,
   * mirroring the engine's `transition_overlap` rule. The resize gesture clamps
   * to this so a drag never produces a patch the validator would reject.
   */
  readonly maxDurationSeconds: number;
}

/** The `transition` effect entering `clip`, if any (lives on the incoming clip). */
export function clipTransition(clip: Clip): Effect | undefined {
  return clip.effects.find((e) => e.type === 'transition');
}

/** A cut between two adjacent clips on one lane — a candidate transition site. */
export interface Junction {
  readonly trackId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
  /** Timeline time of the cut (the incoming clip's start). */
  readonly cutTime: number;
  /** True when the two clips touch (no visible gap) — a real, butt-joined cut. */
  readonly touching: boolean;
}

/** Largest gap (seconds) between two clips still treated as a butt-joined cut. */
const JUNCTION_TOUCH_SECONDS = 1e-2;

/**
 * Cuts on a lane where a transition can sit: each consecutive pair of clips in
 * start order. `touching` marks the butt-joined cuts (no gap) the empty
 * double-click / drop affordance is offered on. Pure. Mirrors the adjacency the
 * `transition_overlap` validator enforces (immediately-earlier clip = fromClip).
 */
export function trackJunctions(track: Track): readonly Junction[] {
  const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
  const junctions: Junction[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    junctions.push({
      trackId: track.id,
      fromClipId: prev.id,
      toClipId: next.id,
      cutTime: next.start,
      touching: Math.abs(next.start - prev.end) <= JUNCTION_TOUCH_SECONDS,
    });
  }
  return junctions;
}

/**
 * Every on-cut transition across the timeline, resolved to pill geometry. A
 * transition is only included when its `fromClipId` matches the immediately
 * earlier clip on the same track (the same adjacency the validator enforces); a
 * dangling reference is skipped rather than drawn at the wrong cut. Pure.
 */
export function timelineTransitions(timeline: Timeline): readonly TransitionPlacement[] {
  const placements: TransitionPlacement[] = [];
  for (const track of timeline.tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    ordered.forEach((toClip, i) => {
      const effect = clipTransition(toClip);
      if (!effect) return;
      const prev = i > 0 ? ordered[i - 1] : undefined;
      const fromClipId = effect.params?.fromClipId;
      if (!prev || prev.id !== fromClipId) return;
      const durationSeconds = Number(effect.params?.durationSeconds ?? 0);
      placements.push({
        trackId: track.id,
        fromClipId: prev.id,
        toClipId: toClip.id,
        effectId: effect.id,
        kind: String(effect.params?.kind ?? 'transition'),
        durationSeconds,
        disabled: effect.params?.disabled === true,
        cutTime: toClip.start,
        maxDurationSeconds: Math.min(toClip.end - toClip.start, prev.end - prev.start),
      });
    });
  }
  return placements;
}

/**
 * The longest legal transition duration at the cut entering `toClipId` —
 * `min(incoming, outgoing)` clip length — or `null` when the clip has no
 * adjacent earlier clip to ramp against. Used to clamp a resize drag. Pure.
 */
export function transitionMaxDuration(timeline: Timeline, toClipId: string): number | null {
  for (const track of timeline.tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    const i = ordered.findIndex((c) => c.id === toClipId);
    if (i <= 0) {
      if (i === 0) return null; // first clip on the lane → no earlier neighbour
      continue;
    }
    const toClip = ordered[i]!;
    const prev = ordered[i - 1]!;
    return Math.min(toClip.end - toClip.start, prev.end - prev.start);
  }
  return null;
}

/**
 * All clips across the timeline in playback order — by start time, then by the
 * order their track appears. Drives Tab / Shift+Tab clip navigation.
 */
export function orderedClips(timeline: Timeline): readonly ClipLocation[] {
  const located: ClipLocation[] = [];
  timeline.tracks.forEach((track) => {
    track.clips.forEach((clip) => located.push({ track, clip }));
  });
  return located.sort((a, b) => a.clip.start - b.clip.start);
}

/**
 * The next (`dir = 1`) or previous (`dir = -1`) clip id in playback order,
 * wrapping at the ends. `null` when there are no clips. With no current
 * selection, returns the first/last clip so Tab can start a selection.
 */
export function adjacentClipId(
  timeline: Timeline,
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  const order = orderedClips(timeline);
  if (order.length === 0) return null;
  const index = currentId ? order.findIndex((l) => l.clip.id === currentId) : -1;
  if (index === -1) {
    return (dir === 1 ? order[0]! : order[order.length - 1]!).clip.id;
  }
  const next = (index + dir + order.length) % order.length;
  return order[next]!.clip.id;
}

/**
 * The clip on the track `dir` steps above (`-1`) or below (`+1`) the selected
 * clip's track that best overlaps the selected clip's start — for ↑/↓ selection.
 * `null` when there is no selection or no such clip on the neighbouring track.
 */
export function clipOnAdjacentTrack(
  timeline: Timeline,
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  if (!currentId) return null;
  const trackIndex = timeline.tracks.findIndex((t) => t.clips.some((c) => c.id === currentId));
  if (trackIndex === -1) return null;
  const current = timeline.tracks[trackIndex]!.clips.find((c) => c.id === currentId)!;
  const target = timeline.tracks[trackIndex + dir];
  if (!target || target.clips.length === 0) return null;
  // Prefer a clip that spans the current clip's start; else the nearest by start.
  const spanning = target.clips.find((c) => current.start >= c.start && current.start < c.end);
  if (spanning) return spanning.id;
  let best = target.clips[0]!;
  let bestDistance = Math.abs(best.start - current.start);
  for (const clip of target.clips) {
    const distance = Math.abs(clip.start - current.start);
    if (distance < bestDistance) {
      best = clip;
      bestDistance = distance;
    }
  }
  return best.id;
}

/**
 * The nearest marker strictly after (`dir = 1`) or before (`dir = -1`) `time`,
 * or `null` when there is none in that direction. Drives marker-to-marker jumps.
 */
export function adjacentMarker(
  markers: readonly number[],
  time: number,
  dir: 1 | -1,
): number | null {
  const EPSILON = 1e-4;
  if (dir === 1) {
    const next = markers.filter((m) => m > time + EPSILON).sort((a, b) => a - b)[0];
    return next ?? null;
  }
  const prev = markers.filter((m) => m < time - EPSILON).sort((a, b) => b - a)[0];
  return prev ?? null;
}

/** Convert a duration in seconds to a pixel width at the given zoom. */
export const secondsToPx = (seconds: number, pxPerSecond: number): number => seconds * pxPerSecond;

/** Convert a pixel offset to seconds at the given zoom (clamped to ≥ 0). */
export const pxToSeconds = (px: number, pxPerSecond: number): number =>
  pxPerSecond <= 0 ? 0 : Math.max(0, px / pxPerSecond);

/** Shortest clip a UI trim/drag may produce, in seconds (keeps clips grabbable). */
export const MIN_CLIP_SECONDS = 0.05;

/** A pixel-space rectangle within the lanes container (origin = lanes top-left). */
export interface PixelRect {
  /** Left edge, in px from the lanes' left. */
  readonly x: number;
  /** Top edge, in px from the lanes' top. */
  readonly y: number;
  /** Width, in px (always ≥ 0; callers normalise a drag's direction). */
  readonly width: number;
  /** Height, in px (always ≥ 0). */
  readonly height: number;
}

/**
 * One rendered lane row's vertical band, in px from the lane container's top.
 *
 * Rows are NOT uniform: an effect lane is 20px where a video lane is 56, a
 * collapsed lane is shorter still, and an expanded keyframe strip makes its row
 * taller. The marquee used to divide the container height by the row count,
 * which silently mapped a band drawn over one lane onto a different lane as soon
 * as any row differed from the average — so a drag either missed the clips under
 * it or swept in clips from a lane the user never touched. The component now
 * passes the real bands it laid the rows out with.
 */
export interface LaneRowBand {
  /** The track this row renders. */
  readonly trackId: string;
  /** Row top, in px from the lane container's top. */
  readonly top: number;
  /** Row height, in px (lane height plus the inter-row gap, so rows tile). */
  readonly height: number;
}

/** Whether a marquee rect vertically overlaps a lane row band (half-open). */
const rectCoversRow = (rect: PixelRect, row: LaneRowBand): boolean =>
  rect.y < row.top + row.height && rect.y + rect.height > row.top;

/**
 * The ids of every clip a marquee (rubber-band) rectangle covers — used by M2a
 * multi-select. A clip is covered when its **time span overlaps** the rect's
 * time range (x→seconds via {@link pxToSeconds}) **and** its lane row band
 * overlaps the rect's vertical span.
 *
 * Pure (no DOM): the component supplies the lane geometry, so this is unit-tested
 * in isolation. Returns ids in timeline order (row order, then clip order).
 *
 * @param timeline - Current timeline.
 * @param rect - The marquee rectangle, in lanes-relative px.
 * @param rows - The rendered lane rows, top→bottom (see {@link LaneRowBand}).
 * @param pxPerSecond - Current zoom, to map px↔seconds.
 */
export function clipsIntersectingRect(
  timeline: Timeline,
  rect: PixelRect,
  rows: readonly LaneRowBand[],
  pxPerSecond: number,
): readonly string[] {
  if (rect.width <= 0 || rect.height <= 0) {
    return [];
  }
  const fromSeconds = pxToSeconds(rect.x, pxPerSecond);
  const toSeconds = pxToSeconds(rect.x + rect.width, pxPerSecond);
  const ids: string[] = [];
  for (const row of rows) {
    if (!rectCoversRow(rect, row)) continue;
    const track = timeline.tracks.find((t) => t.id === row.trackId);
    if (!track) continue;
    for (const clip of track.clips) {
      // Half-open span overlap: the clip is covered if it starts before the rect
      // ends and ends after the rect starts.
      if (clip.start < toSeconds && clip.end > fromSeconds) {
        ids.push(clip.id);
      }
    }
  }
  return ids;
}

/**
 * The effect-layer ids a marquee rectangle covers, by the same rule
 * {@link clipsIntersectingRect} uses for clips.
 *
 * Effect layers (schema v13) live on their own lanes and are selectable in their
 * own right, so a band drawn across an effect lane has to catch them — otherwise
 * a marquee over a mixed stack silently drops everything on those lanes, and
 * "select all" (which does include them) and the marquee disagree about what the
 * timeline's contents are.
 *
 * @param timeline - Current timeline.
 * @param rect - The marquee rectangle, in lanes-relative px.
 * @param rows - The rendered lane rows, top→bottom.
 * @param pxPerSecond - Current zoom, to map px↔seconds.
 */
export function effectLayersIntersectingRect(
  timeline: Timeline,
  rect: PixelRect,
  rows: readonly LaneRowBand[],
  pxPerSecond: number,
): readonly string[] {
  if (rect.width <= 0 || rect.height <= 0) {
    return [];
  }
  const fromSeconds = pxToSeconds(rect.x, pxPerSecond);
  const toSeconds = pxToSeconds(rect.x + rect.width, pxPerSecond);
  const ids: string[] = [];
  for (const row of rows) {
    if (!rectCoversRow(rect, row)) continue;
    const track = timeline.tracks.find((t) => t.id === row.trackId);
    if (!track) continue;
    for (const layer of track.effectLayers ?? []) {
      if (layer.start < toSeconds && layer.end > fromSeconds) {
        ids.push(layer.id);
      }
    }
  }
  return ids;
}

/** Clamp `value` into the inclusive range `[lo, hi]` (no-op when `lo > hi`). */
const clampRange = (value: number, lo: number, hi: number): number =>
  hi < lo ? lo : Math.min(hi, Math.max(lo, value));

/**
 * Two tracks accept the same clips only when they share a type — a video clip
 * cannot move onto an audio/caption/overlay lane. Used to gate a cross-track
 * drag before a `move_clip` patch is built.
 */
export const tracksCompatible = (a: Track['type'], b: Track['type']): boolean => a === b;

/**
 * Clamp a proposed left-edge trim time. `trim_clip` shifts the source in-point by
 * the same delta as the start, so the start cannot move earlier than the point
 * where `sourceStart` would hit zero, nor later than {@link MIN_CLIP_SECONDS}
 * before the (fixed) right edge.
 */
export function clampTrimStart(clip: Clip, desiredStart: number): number {
  const earliest = clip.start - clip.sourceStart; // sourceStart → 0 here
  const latest = clip.end - MIN_CLIP_SECONDS;
  return clampRange(desiredStart, earliest, latest);
}

/**
 * Clamp a proposed right-edge trim time. The right edge cannot cross
 * {@link MIN_CLIP_SECONDS} past the (fixed) left edge. There is no known source
 * out-point in the timeline, so extension is left to render-time validation.
 */
export function clampTrimEnd(clip: Clip, desiredEnd: number): number {
  return Math.max(clip.start + MIN_CLIP_SECONDS, desiredEnd);
}

/**
 * Valid range for the shared edit point between two adjacent clips (a roll
 * edit): neither clip may shrink below {@link MIN_CLIP_SECONDS}, and the
 * incoming clip's source in-point may never go negative. `null` when the pair
 * is already at the minimum on both sides (no valid cut exists). Shared by the
 * live drag-ghost clamp and `rollEditPatch` so both agree on the same bound.
 */
export function rollBounds(
  outgoing: Clip,
  incoming: Clip,
): { readonly min: number; readonly max: number } | null {
  const min = Math.max(outgoing.start + MIN_CLIP_SECONDS, incoming.start - incoming.sourceStart);
  const max = incoming.end - MIN_CLIP_SECONDS;
  return min > max ? null : { min, max };
}

/** A labelled major tick plus the minor ticks the ruler draws between majors. */
export interface RulerTicks {
  /** Major tick times (seconds) that carry a timecode label. */
  readonly major: readonly number[];
  /** Minor tick times (seconds), unlabelled. */
  readonly minor: readonly number[];
  /** The chosen major interval, in seconds (frames → seconds → minutes). */
  readonly stepSeconds: number;
}

/** Minimum on-screen gap between labelled major ticks, in pixels. */
const MIN_MAJOR_PX = 72;
/** Minimum on-screen gap below which minor ticks are suppressed, in pixels. */
const MIN_MINOR_PX = 9;

/**
 * Adaptive ruler ticks: pick a "nice" major interval (whole frames when zoomed
 * in, then seconds, then minutes) so labels stay ~{@link MIN_MAJOR_PX}px apart at
 * the current zoom, and subdivide into minor ticks only while they stay legible.
 *
 * Pure so the geometry is unit-tested without the DOM; the component only maps
 * the returned times to positions and {@link formatTimecode} labels.
 *
 * @param laneSeconds - Visible timeline length, in seconds.
 * @param pxPerSecond - Current zoom.
 * @param fps - Project frame rate, for the frame-granularity candidates.
 */
export function rulerTicks(laneSeconds: number, pxPerSecond: number, fps: number): RulerTicks {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS;
  const frame = 1 / rate;
  // Candidate major intervals, ascending: frames → sub-second → seconds → minutes.
  const candidates = [
    frame,
    2 * frame,
    5 * frame,
    10 * frame,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60,
    120,
    300,
    600,
    900,
    1800,
    3600,
  ];
  const desired = pxPerSecond > 0 ? MIN_MAJOR_PX / pxPerSecond : Number.POSITIVE_INFINITY;
  const stepSeconds = candidates.find((c) => c >= desired) ?? candidates[candidates.length - 1]!;

  const major: number[] = [];
  // Quantise to whole frames so labels land on real frame boundaries.
  const stepFrames = Math.max(1, Math.round(stepSeconds * rate));
  const totalFrames = Math.ceil(laneSeconds * rate);
  for (let f = 0; f <= totalFrames; f += stepFrames) {
    major.push(f / rate);
  }

  // Subdivide each major span by the finest division that both evenly divides the
  // frame-step and keeps minor ticks at least MIN_MINOR_PX apart. None qualifies at
  // frame-level zoom (step = 1 frame), so minors vanish cleanly when densest.
  const majorPx = stepSeconds * pxPerSecond;
  const minor: number[] = [];
  let minorStepFrames = 0;
  for (const divisions of [10, 5, 4, 2]) {
    if (stepFrames % divisions === 0 && majorPx / divisions >= MIN_MINOR_PX) {
      minorStepFrames = stepFrames / divisions;
      break;
    }
  }
  if (minorStepFrames > 0) {
    for (let f = 0; f <= totalFrames; f += minorStepFrames) {
      if (f % stepFrames !== 0) minor.push(f / rate);
    }
  }
  return { major, minor, stepSeconds };
}

/** A target zoom plus the time to keep centred after a fit/zoom command. */
export interface ZoomTarget {
  /** Desired zoom in pixels per second (the store still clamps to its range). */
  readonly pxPerSecond: number;
  /** Time (seconds) the view should centre/scroll to. */
  readonly centerSeconds: number;
}

/** Fraction of the viewport a fit/zoom-to leaves as breathing room. */
const FIT_PADDING = 0.92;

/**
 * Zoom so the whole timeline fits the viewport width, centred on its midpoint.
 * Falls back to a sane zoom for an empty timeline.
 */
export function zoomToFit(laneSeconds: number, viewportPx: number): ZoomTarget {
  const span = Math.max(laneSeconds, MIN_CLIP_SECONDS);
  const pxPerSecond = viewportPx > 0 ? (viewportPx * FIT_PADDING) / span : 0;
  return { pxPerSecond, centerSeconds: span / 2 };
}

/**
 * Zoom so a single clip fills most of the viewport, centred on the clip. Returns
 * `null` when the clip has no positive duration.
 */
export function zoomToClip(clip: Clip, viewportPx: number): ZoomTarget | null {
  const span = clip.end - clip.start;
  if (span <= 0) return null;
  const pxPerSecond = viewportPx > 0 ? (viewportPx * FIT_PADDING) / span : 0;
  return { pxPerSecond, centerSeconds: clip.start + span / 2 };
}

// --- Audio settings ---------------------------------------------------------

/** Per-clip audio settings stored on the `audio_gain` effect. */
export interface AudioSettings {
  gainDb: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  muted: boolean;
  normalize: boolean;
  duckUnderTrackId: string | null;
  duckAmountDb: number;
  /** Shape of the fade ramps — the engine's `fadeCurve` param. */
  fadeCurve: FadeCurve;
}

/** The fade shapes the engine's `fade_gain_at` understands. */
export type FadeCurve = 'linear' | 'equal-power' | 'smooth';

/** Identity audio (unity gain, no fades/mute/normalize/duck). */
export const DEFAULT_AUDIO: AudioSettings = {
  gainDb: 0,
  fadeInSeconds: 0,
  fadeOutSeconds: 0,
  muted: false,
  normalize: false,
  duckUnderTrackId: null,
  duckAmountDb: -12,
  fadeCurve: 'linear',
};

/** Read a clip's current audio settings (defaults when no `audio_gain` effect). */
export function audioSettings(clip: Clip): AudioSettings {
  const effect = clip.effects.find((e) => e.type === 'audio_gain');
  if (!effect) return { ...DEFAULT_AUDIO };
  const p = effect.params as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const value = Number(p[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const duck = p.duckUnderTrackId;
  return {
    gainDb: num('gainDb', 0),
    fadeInSeconds: num('fadeInSeconds', 0),
    fadeOutSeconds: num('fadeOutSeconds', 0),
    muted: Boolean(p.muted),
    normalize: Boolean(p.normalize),
    duckUnderTrackId: typeof duck === 'string' && duck ? duck : null,
    duckAmountDb: num('duckAmountDb', -12),
    fadeCurve: p.fadeCurve === 'equal-power' || p.fadeCurve === 'smooth' ? p.fadeCurve : 'linear',
  };
}

// --- Preview mix envelope ----------------------------------------------------
//
// The monitor must play the mix the render will produce. Gain alone is not that
// mix: a bed laid under narration is authored with a DUCK, and playing it flat
// meant the monitor was loudest exactly where the render is quietest. In a
// captured run the editor watched that monitor, reported the music drowning
// their voice, and the agent "fixed" a problem the render did not have by
// cutting the bed's clip gain — a real, destructive edit stacked on top of a
// duck that was already working. A monitor that lies about the mix does not
// just mislead the person; it teaches the agent to damage the edit.
//
// So preview mirrors the engine's own envelope — `fade_gain_at` × `duck_gain_at`
// in `audio/mixing.py` — evaluated at one instant instead of over a sample
// array. This stays inside the render-vs-preview invariant (AGENTS.md §4): it
// sets an element's `volume`, it does not process samples. Automation lanes
// (keyframed `audio_gain`) remain engine-truth and are not sampled here.

/** The engine's duck attack/release ramp, in seconds (`duck_gain_at`'s `ramp`). */
const DUCK_RAMP_SECONDS = 0.15;

const clamp01Gain = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Fade multiplier at clip-relative `elapsed`. Mirrors the engine's `fade_gain_at`. */
function fadeGainAt(
  elapsed: number,
  duration: number,
  { fadeInSeconds, fadeOutSeconds, fadeCurve }: AudioSettings,
): number {
  let gain = 1;
  if (fadeInSeconds > 0) gain = Math.min(gain, clamp01Gain(elapsed / fadeInSeconds));
  if (fadeOutSeconds > 0) gain = Math.min(gain, clamp01Gain((duration - elapsed) / fadeOutSeconds));
  if (fadeCurve === 'equal-power') return Math.sin(gain * (Math.PI / 2));
  if (fadeCurve === 'smooth') return gain * gain * (3 - 2 * gain);
  return gain;
}

/**
 * Duck multiplier at absolute time `t`, given the sidechain track's clip spans.
 * Mirrors the engine's `duck_gain_at`, including its 0.15s ramp on each side, so
 * the bed dips in the monitor exactly where and as far as it dips in the render.
 */
function duckGainAt(
  t: number,
  sidechain: Timeline['tracks'][number] | undefined,
  amountDb: number,
): number {
  if (sidechain === undefined || sidechain.clips.length === 0) return 1;
  const reduced = dbToGain(amountDb);
  let gain = 1;
  for (const { start, end } of sidechain.clips) {
    const attack = clamp01Gain((t - (start - DUCK_RAMP_SECONDS)) / DUCK_RAMP_SECONDS);
    const release = clamp01Gain((end + DUCK_RAMP_SECONDS - t) / DUCK_RAMP_SECONDS);
    const presence = clamp01Gain(Math.min(attack, release));
    gain = Math.min(gain, 1 - presence * (1 - reduced));
  }
  return gain;
}

/**
 * The linear monitor volume for one audio clip at absolute time `t`: the clip's
 * static gain, shaped by its fades and by any duck it is authored under.
 * `tracks` supplies the duck sidechain; pass the timeline's tracks.
 */
export function previewClipVolume(
  clip: Clip,
  audio: AudioSettings,
  t: number,
  tracks: readonly Timeline['tracks'][number][],
): number {
  if (audio.muted) return 0;
  const level = dbToGain(audio.gainDb);
  const fade = fadeGainAt(t - clip.start, clip.end - clip.start, audio);
  const duck =
    audio.duckUnderTrackId === null
      ? 1
      : duckGainAt(
          t,
          tracks.find((track) => track.id === audio.duckUnderTrackId),
          audio.duckAmountDb,
        );
  return level * fade * duck;
}

/** Tracks (other than the clip's own) that carry audio, as duck sidechain options. */
export function duckTrackOptions(timeline: Timeline, ownTrackId: string): readonly Track[] {
  return timeline.tracks.filter(
    (t) => t.id !== ownTrackId && (t.type === 'audio' || t.type === 'video'),
  );
}

// --- Preview audio mix ------------------------------------------------------
//
// The program monitor rides ONE <video> element, so its footage audio plays for
// free — but audio-only clips (music, VO, SFX) on their own layers have no
// element and would be silent. `audibleAudioClipsAt` is the pure projection the
// preview audio mixer renders from: which audio-only clips should sound now,
// where in their source they sit, and at what linear volume. Mirrors the engine
// mix (gain/mute + track flags, fades and ducking — see `previewClipVolume`);
// keyframed automation lanes stay engine-truth (preview is approximate —
// invariant 4). Video-clip footage audio is intentionally excluded
// here: it rides the monitor's own <video>, not this mixer.

/** Linear amplitude for a decibel gain — mirrors the engine's `db_to_gain`. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** An audio-only clip that should sound at a given playhead time. */
export interface AudibleClip {
  readonly track: Track;
  readonly clip: Clip;
  /** Source-media time under the playhead (`sourceStart` + offset into the clip). */
  readonly sourceTime: number;
  /** Linear monitor volume after gain, mute, fades and any duck (0 when muted). */
  readonly volume: number;
}

/**
 * The audio-only clips that should sound at time `t`, each with its source-media
 * offset and computed linear volume. A `muted` track (schema v4) or a clip whose
 * `audio_gain` effect is muted contributes nothing. Pure — the preview audio
 * mixer is the thin DOM shell over this.
 */
export function audibleAudioClipsAt(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  t: number,
  /** Tracks currently soloed for preview monitoring (H0.4); see {@link effectiveMutedTrackIds}. */
  soloed: ReadonlySet<string> = EMPTY_TRACK_IDS,
): readonly AudibleClip[] {
  const muted = effectiveMutedTrackIds(timeline.tracks, soloed, assetById);
  const audible: AudibleClip[] = [];
  for (const track of timeline.tracks) {
    if (muted.has(track.id)) continue;
    for (const clip of track.clips) {
      if (t < clip.start || t >= clip.end) continue;
      if (clipKind(clip, assetById) !== 'audio') continue;
      const audio = audioSettings(clip);
      audible.push({
        track,
        clip,
        sourceTime: clip.sourceStart + (t - clip.start),
        volume: previewClipVolume(clip, audio, t, timeline.tracks),
      });
    }
  }
  return audible;
}

// --- Track solo (H0.4 J2) ----------------------------------------------------
//
// Solo is a session-local MONITORING convenience (PROMPT invariant 5): it is
// never persisted to the project, never a `set_track_flags` patch, never part
// of undo/redo, and the render always uses the real `Track.muted` flag alone.
// These helpers compute the *effective* mute for the live preview only.

const EMPTY_TRACK_IDS: ReadonlySet<string> = new Set();

/** Tracks with at least one video/audio clip — the only kinds that contribute
 *  to the audio mix (a caption/text-only track carries no sound to solo). */
export function audioBearingTracks(
  tracks: readonly Track[],
  assetById: ReadonlyMap<string, Asset>,
): readonly Track[] {
  return tracks.filter((track) =>
    track.clips.some((clip) => {
      const kind = clipKind(clip, assetById);
      return kind === 'audio' || kind === 'video';
    }),
  );
}

/**
 * The set of track ids effectively muted for PREVIEW playback, folding solo
 * over the persisted `muted` flags:
 * - No audio-bearing track is soloed: effective mute is exactly each track's
 *   persisted `muted` flag.
 * - At least one audio-bearing track is soloed: every soloed track plays
 *   regardless of its persisted `muted` (that is the point of solo) and every
 *   other audio-bearing track is silenced regardless of its own persisted
 *   flag. Non-audio-bearing tracks (captions/overlays) are unaffected either
 *   way — solo is purely an audio-monitoring concern.
 *
 * Pure; feeds both the live preview mixer/monitor and the timeline header's
 * "muted by solo" indicator ({@link resolveSoloMutedTrackIds} in
 * `useTrackLayout.ts`). Never touches `Track.muted` itself.
 */
export function effectiveMutedTrackIds(
  tracks: readonly Track[],
  soloed: ReadonlySet<string>,
  assetById: ReadonlyMap<string, Asset>,
): ReadonlySet<string> {
  const audioTracks = audioBearingTracks(tracks, assetById);
  const soloedAudioIds = new Set(audioTracks.filter((t) => soloed.has(t.id)).map((t) => t.id));
  const muted = new Set(tracks.filter((t) => t.muted).map((t) => t.id));
  if (soloedAudioIds.size === 0) return muted;
  for (const t of audioTracks) {
    if (soloedAudioIds.has(t.id)) muted.delete(t.id);
    else muted.add(t.id);
  }
  return muted;
}

// --- Preview picture pool -----------------------------------------------------
//
// A fast montage cuts between many video clips. Mounting a fresh <video> at each
// cut — or re-seeking a single element to the next clip's in-point — stalls on
// fetch + keyframe decode: the 100-200ms freeze felt at every cut. The monitor
// instead keeps a small POOL of persistent <video> elements: the FRONT slot
// plays the active clip; every other slot pre-loads and pre-seeks one UPCOMING
// clip (including a same-asset trim, which the old 2-slot front/back design
// deliberately skipped and therefore stalled on) so each cut is an instant swap
// to an already-decoded element. `nextPool` is the pure reducer deciding, each
// time the active/upcoming clips change, which slot is front and what each slot
// must hold. State-in → state-out so it is unit-tested without a DOM; the
// component applies the assignments to real elements (untestable in jsdom →
// v8-ignored there).

/**
 * How many persistent preview <video> elements the pool keeps (the active clip
 * plus warm upcoming ones). Every buffering element pins a hardware decoder
 * session, so this stays modest — but a fast montage (e.g. a 500ms-per-clip cut)
 * spends so little time on each clip that only two lookahead slots could not warm
 * the next clips before the playhead arrived, causing the brief cut flicker (#3).
 * Four lookahead slots give ~4× the warm-up runway while remaining well within a
 * desktop GPU's decoder budget.
 */
export const PREVIEW_POOL_SIZE = 5;

/** The clip id each pool slot holds (`null` = empty) + which slot is front. */
export interface PoolState {
  readonly front: number;
  readonly loaded: readonly (string | null)[];
}

/** The empty starting pool (slot 0 front, nothing loaded). */
export const EMPTY_POOL: PoolState = {
  front: 0,
  loaded: Array.from({ length: PREVIEW_POOL_SIZE }, () => null),
};

/**
 * Assign the active + upcoming clips to pool slots.
 *
 * - A slot already holding a still-wanted clip keeps it — its element stays
 *   fetched/decoded/pre-seeked, which is the whole point of the pool.
 * - Newly wanted clips fill slots whose clip is no longer wanted (or empty),
 *   in slot order.
 * - The front is whichever slot holds the active clip; with no active video
 *   clip (a gap or a still image) the previous front slot is held and never
 *   evicted, so the element under the (invisible) monitor is not disturbed.
 * - `protectSlot` (the slot the monitor is still SHOWING) is never recycled for
 *   a warm upcoming clip: right after a cut the monitor keeps the departed
 *   clip's last frame on screen until the new front has a decoded frame, and
 *   reloading that element mid-bridge would flash black. Loading the ACTIVE
 *   clip overrides the protection — refusing it could deadlock the bridge
 *   (front never becomes ready, so the visible slot never advances).
 *
 * Pure: no DOM, no side effects, deterministic — feeding its output back with
 * the same inputs is a fixed point (the component relies on this to avoid a
 * render loop).
 */
export function nextPool(
  prev: PoolState,
  activeClipId: string | null,
  upcomingIds: readonly string[],
  protectSlot = -1,
): PoolState {
  const size = prev.loaded.length;
  // Wanted clips in priority order (active first), deduped, capped to the pool.
  const wanted: string[] = [];
  for (const id of [activeClipId, ...upcomingIds]) {
    if (id !== null && !wanted.includes(id) && wanted.length < size) wanted.push(id);
  }
  const loaded: (string | null)[] = [...prev.loaded];
  const isWanted = (id: string | null): boolean => id !== null && wanted.includes(id);
  const missing = wanted.filter((id) => !loaded.includes(id));
  for (const id of missing) {
    const isActive = id === activeClipId;
    const free = loaded.findIndex(
      (held, slot) =>
        !isWanted(held) &&
        !(activeClipId === null && slot === prev.front) &&
        (isActive || slot !== protectSlot),
    );
    if (free === -1) continue;
    loaded[free] = id;
  }
  const frontSlot = activeClipId === null ? prev.front : loaded.indexOf(activeClipId);
  return { front: frontSlot === -1 ? prev.front : frontSlot, loaded };
}

// --- Preview pre-roll ---------------------------------------------------------
//
// The pool removes the cold *load* at a cut, but the incoming warm slot is still
// PAUSED at its in-point: the moment it becomes front we call `play()`, and for
// the ~1-3 frames that `play()` takes to spin up its decoder the element paints a
// STATIC frame while the playhead moves on — the micro-stutter felt at every cut,
// even when clips are far apart (it is a play()-startup cost, not a warm-up one).
//
// Pre-roll closes it: shortly BEFORE the cut we start the on-deck slot playing
// (muted, off-screen), seeked back so it plays *up to* its in-point and arrives
// exactly at the cut already progressing. An already-running element paints live
// frames through the swap — no static hold, no content skipped, no playhead jump.
// The lead is the runway for the back-seek + play() to complete before the cut.
//
// A clip whose source starts at 0 (untrimmed) has nothing to seek back into, so
// its lead is 0 and it is not pre-rolled — that residual is what a future
// decode-ahead (WebCodecs) compositor would close. See PreviewPlayer's clock.

/** Default pre-roll lead (seconds): a few frames of runway at common frame rates. */
export const PREVIEW_PREROLL_LEAD_SECONDS = 0.15;

/**
 * The usable pre-roll lead for a clip: the requested lead, clamped so the
 * back-seek target never falls before the source media's start (an untrimmed
 * clip yields 0 → no pre-roll).
 */
export function prerollLead(clip: Clip, lead = PREVIEW_PREROLL_LEAD_SECONDS): number {
  return Math.min(Math.max(0, lead), Math.max(0, clip.sourceStart));
}

/**
 * Where to seek the on-deck element before starting its pre-roll: back from the
 * clip's in-point by the usable lead, so it plays forward and reaches the
 * in-point at the cut.
 */
export function prerollSeekTarget(clip: Clip, lead = PREVIEW_PREROLL_LEAD_SECONDS): number {
  return clip.sourceStart - prerollLead(clip, lead);
}

/**
 * Whether the on-deck slot should begin pre-rolling now: a real lead exists and
 * the cut is within one lead ahead (but not already past). `timeToCut` is the
 * on-deck clip's start minus the live playhead.
 */
export function shouldPreroll(timeToCut: number, lead: number): boolean {
  return lead > 0 && timeToCut > 0 && timeToCut <= lead;
}

// --- Color grade ------------------------------------------------------------

const GRADE_AXES = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'shadows',
  'highlights',
] as const;

/** Read a clip's current `color_grade` effect params (identity when none). */
export function colorGradeParams(clip: Clip): ColorGradeParams {
  const effect = clip.effects.find((e) => e.type === 'color_grade');
  if (!effect) return { ...IDENTITY_GRADE };
  const params = effect.params as Record<string, unknown>;
  const read = (key: string): number => {
    const value = Number(params[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    exposure: read('exposure'),
    contrast: read('contrast'),
    saturation: read('saturation'),
    temperature: read('temperature'),
    tint: read('tint'),
    shadows: read('shadows'),
    highlights: read('highlights'),
  };
}

/** True when a grade leaves the image unchanged. */
export function isIdentityGrade(grade: ColorGradeParams): boolean {
  return GRADE_AXES.every((axis) => grade[axis] === 0);
}

// Warm temperature rotates hue this many degrees per unit toward red/orange.
const TEMP_HUE_DEGREES = 18;
// Shadow/highlight lift folded approximately into preview brightness.
const ZONE_BRIGHTNESS = 0.15;

/**
 * An **approximate** CSS `filter` string for a grade, for the live program
 * monitor only. CSS filters cannot reproduce the engine's per-channel math
 * exactly (the deterministic truth is the Python render); this maps the axes CSS
 * supports well — exposure→brightness, contrast→contrast, saturation→saturate —
 * and approximates temperature as a hue rotation and shadows/highlights as a
 * small brightness nudge. Returns `'none'` for an identity grade.
 */
export function colorGradeCssFilter(grade: ColorGradeParams): string {
  if (isIdentityGrade(grade)) return 'none';
  const brightness = Math.max(
    0,
    2 ** grade.exposure * (1 + ZONE_BRIGHTNESS * (grade.shadows + grade.highlights)),
  );
  const contrast = Math.max(0, 1 + grade.contrast);
  const saturate = Math.max(0, 1 + grade.saturation);
  const hue = -grade.temperature * TEMP_HUE_DEGREES + grade.tint * (TEMP_HUE_DEGREES / 2);
  return (
    `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) ` +
    `saturate(${saturate.toFixed(3)}) hue-rotate(${hue.toFixed(1)}deg)`
  );
}

// ---------------------------------------------------------------------------
// Speed / crop / blend mode (H1.2h — inspector controls for the engine's
// existing set_clip_speed / set_clip_crop / set_clip_blend_mode ops)
// ---------------------------------------------------------------------------

/** Default (unmodified) crop: the whole source frame. */
export const FULL_FRAME_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** The 12 blend modes the engine composites (schema `BlendModeSchema`). */
export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
];

/** A clip's effective playback speed (1x when unset). */
export function clipSpeed(clip: Clip): number {
  return clip.speed ?? 1;
}

/** A clip's effective crop rect (the whole frame when unset). */
export function clipCropRect(clip: Clip): CropRect {
  return clip.crop ?? FULL_FRAME_CROP;
}

/** A clip's effective blend mode (`'normal'` when unset). */
export function clipBlendMode(clip: Clip): BlendMode {
  return clip.blendMode ?? 'normal';
}

/** True when a crop rect covers the whole frame (no-op — nothing to preview). */
export function isFullFrameCrop(crop: CropRect): boolean {
  return (
    Math.abs(crop.x) < 1e-6 &&
    Math.abs(crop.y) < 1e-6 &&
    Math.abs(crop.width - 1) < 1e-6 &&
    Math.abs(crop.height - 1) < 1e-6
  );
}

// ---------------------------------------------------------------------------
// Waveform rendering (Phase 8 — real waveforms from engine-derived Asset.media)
// ---------------------------------------------------------------------------

/**
 * The slice of an asset's waveform peaks covering a clip's source window
 * `[sourceStart, sourceEnd)`. Peaks are sampled at `media.peaksPerSecond`. Returns
 * an empty array when the asset has no peaks (the timeline then draws a skeleton).
 * Read-only consumption of engine-produced data — no media is computed here
 * (render-vs-preview rule).
 */
export function clipPeaks(
  media: AssetMedia | undefined,
  sourceStart: number,
  sourceEnd: number,
): number[] {
  if (!media?.peaks || media.peaks.length === 0 || !media.peaksPerSecond) return [];
  const pps = media.peaksPerSecond;
  const from = Math.max(0, Math.floor(sourceStart * pps));
  const to = Math.min(media.peaks.length, Math.ceil(sourceEnd * pps));
  return from < to ? media.peaks.slice(from, to) : [];
}

/**
 * The thumbnail frames to draw across a video/image clip's body, derived from the
 * asset's `media.thumbnailPaths`. Thumbnails are treated as evenly sampled across
 * the asset's whole `durationSeconds`, so the clip's source window
 * `[sourceStart, sourceEnd)` maps to a contiguous slice of that strip; from that
 * slice up to `maxFrames` frames are picked at even intervals (so a wide clip shows
 * the first..last frame of its window without flooding the DOM).
 *
 * Read-only consumption of engine-produced data — no media is decoded here
 * (render-vs-preview rule). Returns `[]` (the timeline then draws a skeleton) when
 * the asset is missing, has no thumbnails, has no positive duration, or `maxFrames`
 * is non-positive.
 *
 * @param asset - The clip's source asset (or `undefined` when unknown).
 * @param sourceStart - Source in-point of the clip, in seconds.
 * @param sourceEnd - Source out-point of the clip, in seconds.
 * @param maxFrames - Upper bound on frames returned (keeps the DOM light).
 * @returns Up to `maxFrames` thumbnail paths, in source order.
 */
export function clipFilmstripFrames(
  asset: Asset | undefined,
  sourceStart: number,
  sourceEnd: number,
  maxFrames: number,
): readonly string[] {
  // A still image has no per-time filmstrip — it is ONE frame for its whole
  // duration. Return no engine frames so the caller tiles the image's own source
  // across the clip (via useAssetThumbnail), which also ignores any stale derived
  // `thumbs/thumb_*.png` paths left by an older import that mislabelled the photo
  // as video (those frames were never generated → fp-media ENOENT).
  if (asset?.kind === 'image') return [];
  const paths = asset?.media?.thumbnailPaths;
  const duration = asset?.durationSeconds;
  if (!paths || paths.length === 0 || !duration || duration <= 0 || maxFrames <= 0) {
    return [];
  }
  // Map the source window onto evenly-sampled thumbnail indices across [0, duration).
  const perSecond = paths.length / duration;
  const from = Math.max(0, Math.floor(Math.max(0, sourceStart) * perSecond));
  const to = Math.min(paths.length, Math.ceil(Math.max(0, sourceEnd) * perSecond));
  const window = from < to ? paths.slice(from, to) : paths.slice(0, 1);
  if (window.length <= maxFrames) return window;
  // Pick `maxFrames` frames at even intervals across the window (first..last).
  const picked: string[] = [];
  const step = (window.length - 1) / (maxFrames - 1);
  for (let i = 0; i < maxFrames; i += 1) {
    picked.push(window[Math.round(i * step)]!);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Horizontal lane render window (film-scale timelines)
//
// Vertical windowing (the lane virtualizer) bounds how many TRACKS mount, but
// every clip on a mounted lane still rendered regardless of horizontal scroll —
// on a film-style timeline (hours of footage, thousands of clips) that is
// thousands of clip buttons, filmstrips and waveform canvases, and a zoom
// gesture rebuilt all of them every frame. The render window is the horizontal
// slice worth mounting: the viewport plus one viewport of overscan each side,
// QUANTIZED to whole viewport-width buckets so its identity (and therefore the
// memoised lanes) changes only when scrolling crosses a bucket boundary, never
// per scrolled pixel.
// ---------------------------------------------------------------------------

/** Minimum quantization bucket (px) so a tiny viewport still windows coarsely. */
const MIN_RENDER_WINDOW_BUCKET_PX = 256;

/** A quantized horizontal slice of the lanes, in px from t=0. */
export interface LaneRenderWindow {
  readonly startPx: number;
  readonly endPx: number;
}

/**
 * The horizontal slice of the lanes worth mounting for a viewport at
 * `scrollLeft` of width `clientWidth`: at least one full viewport of overscan
 * on each side, snapped to whole buckets (see section comment). Returns `null`
 * when the viewport width is unknown (pre-layout / jsdom) — callers must then
 * render everything, mirroring the vertical virtualizer's height fallback.
 *
 * @param scrollLeft - The lane viewport's horizontal scroll offset (px).
 * @param clientWidth - The lane viewport's visible width (px); `<= 0` = unknown.
 * @returns The quantized window, or `null` when the viewport is unmeasured.
 */
export function laneRenderWindow(scrollLeft: number, clientWidth: number): LaneRenderWindow | null {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return null;
  const bucket = Math.max(MIN_RENDER_WINDOW_BUCKET_PX, clientWidth);
  const index = Math.floor(Math.max(0, scrollLeft) / bucket);
  // One bucket behind and two ahead of the viewport's bucket: at any offset
  // within the bucket, both visible edges keep ≥ one full bucket of mounted
  // overscan, so content never blanks before the crossing-triggered rebuild.
  return { startPx: Math.max(0, (index - 1) * bucket), endPx: (index + 3) * bucket };
}

/**
 * Whether a time span `[start, end]` (seconds) intersects a render window.
 * A `null` window (unknown viewport) keeps everything mounted.
 *
 * @param start - Span start, in seconds.
 * @param end - Span end, in seconds.
 * @param window - The quantized window, or `null` for "render everything".
 * @param pxPerSecond - The active zoom (time → px projection).
 * @returns `true` when the span should mount.
 */
export function spanInRenderWindow(
  start: number,
  end: number,
  window: LaneRenderWindow | null,
  pxPerSecond: number,
): boolean {
  if (!window) return true;
  return (
    secondsToPx(end, pxPerSecond) >= window.startPx &&
    secondsToPx(start, pxPerSecond) <= window.endPx
  );
}

// ---------------------------------------------------------------------------
// Auto-scroll / playhead-follow (M2b-2)
//
// During playback the lane viewport scrolls to keep the playhead in view. The
// *decision* (whether to follow this frame) and the *geometry* (the new
// scrollLeft) are pure so they are unit-tested without the DOM; the component
// reads the playhead through a ref and applies the result imperatively in rAF
// (never re-rendering the memoised lanes each tick).
// ---------------------------------------------------------------------------

/** Inputs to the per-frame "should the viewport follow the playhead?" decision. */
export interface AutoFollowInputs {
  /** The follow-on-playback preference is enabled. */
  readonly enabled: boolean;
  /** The transport is currently playing. */
  readonly playing: boolean;
  /** The user is scrubbing the playhead (dragging the ruler/head) right now. */
  readonly scrubbing: boolean;
  /** The user manually scrolled/panned within the recent suspend window. */
  readonly userScrolling: boolean;
}

/**
 * Whether the viewport should auto-follow the playhead this frame. Following is
 * on only while *playing* with the preference enabled, and is **suspended** the
 * moment the user takes manual control — scrubbing the playhead or scrolling the
 * lanes — so auto-scroll never fights a manual gesture (it resumes once playback
 * continues and the manual interaction lapses). Pure.
 */
export function shouldAutoFollow(inputs: AutoFollowInputs): boolean {
  if (!inputs.enabled || !inputs.playing) return false;
  return !inputs.scrubbing && !inputs.userScrolling;
}

/** What a wheel event over the timeline should do (UX-06). */
export type WheelIntent = 'zoom' | 'scroll-horizontal' | 'browser';

export interface WheelInputs {
  readonly deltaX: number;
  readonly deltaY: number;
  /** Cmd (macOS) or Ctrl — also what a trackpad pinch reports. */
  readonly zoomModifier: boolean;
  readonly shiftKey: boolean;
  /** Whether the lane container actually has somewhere to scroll vertically. */
  readonly canScrollVertically: boolean;
}

/**
 * Decide what a wheel over the timeline means (UX-06).
 *
 * The timeline scrolls horizontally, so a plain vertical wheel — the only gesture a
 * mouse has — used to reach the browser, find no vertical overflow, and do nothing at
 * all. Eight wheel steps left the viewport byte-identical, which reads as a dead
 * surface. Every NLE maps the bare wheel onto the axis the timeline actually has.
 *
 * - Cmd/Ctrl (or a trackpad pinch) → zoom around the cursor.
 * - Shift → the browser's own horizontal mapping; nothing to improve on.
 * - A horizontal-dominant gesture (trackpad two-finger swipe) → the browser already
 *   scrolls the right axis.
 * - Otherwise a vertical wheel scrolls the timeline horizontally, UNLESS the lanes
 *   are tall enough to scroll vertically — where scrolling the track stack is what
 *   the gesture obviously means, and stealing it would be worse than the bug.
 */
export function wheelIntent(inputs: WheelInputs): WheelIntent {
  if (inputs.zoomModifier) return 'zoom';
  if (inputs.shiftKey) return 'browser';
  if (Math.abs(inputs.deltaX) > Math.abs(inputs.deltaY)) return 'browser';
  if (inputs.canScrollVertically) return 'browser';
  return inputs.deltaY === 0 ? 'browser' : 'scroll-horizontal';
}

/**
 * The fraction of the viewport width kept ahead of the playhead before the view
 * re-centres on it — a dead-band so the timeline does not jitter every frame.
 */
const AUTO_FOLLOW_MARGIN = 0.15;

/**
 * The new `scrollLeft` (px) that keeps the playhead inside the viewport, or
 * `null` when no scroll is needed (the playhead is already comfortably in view).
 *
 * The playhead is kept within a centred dead-band `[margin, 1 − margin]` of the
 * viewport: while it sits inside that band nothing moves (returns `null`); once
 * it crosses either edge the view scrolls so the playhead sits back at that edge,
 * clamped to the scrollable range `[0, contentWidth − clientWidth]`. Returning
 * `null` for an in-band playhead lets the caller skip the DOM write entirely.
 *
 * @param playheadPx - Playhead position in content px (`secondsToPx(playhead)`).
 * @param scrollLeft - Current viewport scroll offset, px.
 * @param clientWidth - Viewport width, px.
 * @param contentWidth - Total scrollable lane width, px.
 */
export function nextAutoScrollLeft(
  playheadPx: number,
  scrollLeft: number,
  clientWidth: number,
  contentWidth: number,
): number | null {
  if (clientWidth <= 0) return null;
  const maxScroll = Math.max(0, contentWidth - clientWidth);
  const leftEdge = scrollLeft + clientWidth * AUTO_FOLLOW_MARGIN;
  const rightEdge = scrollLeft + clientWidth * (1 - AUTO_FOLLOW_MARGIN);
  let target = scrollLeft;
  if (playheadPx < leftEdge) {
    target = playheadPx - clientWidth * AUTO_FOLLOW_MARGIN;
  } else if (playheadPx > rightEdge) {
    target = playheadPx - clientWidth * (1 - AUTO_FOLLOW_MARGIN);
  } else {
    return null; // already in the comfortable band — no scroll, no DOM write
  }
  const clamped = Math.max(0, Math.min(maxScroll, target));
  return Math.abs(clamped - scrollLeft) < 0.5 ? null : clamped;
}

// ---------------------------------------------------------------------------
// Minimap / overview strip (M2b-2)
//
// A compressed full-sequence strip under the timeline. Every clip becomes a tiny
// block and the current viewport is a draggable window. The geometry is pure: the
// component supplies the minimap width and the live scroll metrics, and renders
// the returned rects (and writes back a new scrollLeft when the window is dragged).
// ---------------------------------------------------------------------------

/** A horizontal block on the minimap: a clip, in minimap-px, with its row. */
export interface MinimapBlock {
  readonly clipId: string;
  /** Left edge in minimap px. */
  readonly x: number;
  /** Width in minimap px (always ≥ {@link MINIMAP_MIN_BLOCK_PX}). */
  readonly width: number;
  /** Zero-based row index (visible track order), for vertical placement/colour. */
  readonly row: number;
}

/** The minimap's viewport window: where the lane viewport currently sits. */
export interface MinimapViewport {
  /** Left edge in minimap px. */
  readonly x: number;
  /** Width in minimap px (the visible fraction of the sequence). */
  readonly width: number;
}

/** The full minimap model: every clip block plus the draggable viewport window. */
export interface MinimapGeometry {
  readonly blocks: readonly MinimapBlock[];
  readonly viewport: MinimapViewport;
  /** Number of rows (visible tracks), so the strip can size its row band. */
  readonly rows: number;
}

/** Smallest a clip block may shrink to on the minimap so it stays visible. */
export const MINIMAP_MIN_BLOCK_PX = 2;

/**
 * Compress the whole sequence to a `minimapWidth`-px overview: each clip maps to a
 * tiny block (scaled by `minimapWidth / contentWidth`) on its track's row, and the
 * lane viewport maps to a window rect. All px values are minimap-relative and
 * clamped into `[0, minimapWidth]`. Pure (no DOM): the component supplies the
 * width and the live scroll metrics, so this is unit-tested in isolation.
 *
 * @param timeline - Current timeline.
 * @param trackOrder - Visible track ids, top→bottom (matches the rendered rows).
 * @param pxPerSecond - Current zoom, mapping clip times → content px.
 * @param contentWidth - Total lane width in px at the current zoom.
 * @param scrollLeft - Current viewport scroll offset, px.
 * @param clientWidth - Viewport width, px.
 * @param minimapWidth - The minimap strip's width, px.
 */
export function minimapGeometry(
  timeline: Timeline,
  trackOrder: readonly string[],
  pxPerSecond: number,
  contentWidth: number,
  scrollLeft: number,
  clientWidth: number,
  minimapWidth: number,
): MinimapGeometry {
  const rows = trackOrder.length;
  if (contentWidth <= 0 || minimapWidth <= 0) {
    return { blocks: [], viewport: { x: 0, width: minimapWidth }, rows };
  }
  // One scale folds the two hops together: a clip *time* (s) → content px
  // (× pxPerSecond) → minimap px (× minimapWidth / contentWidth).
  const timeToMinimap = (pxPerSecond * minimapWidth) / contentWidth;
  const scrollScale = minimapWidth / contentWidth; // content px → minimap px
  const clampX = (value: number): number => Math.max(0, Math.min(minimapWidth, value));
  const blocks: MinimapBlock[] = [];
  trackOrder.forEach((trackId, row) => {
    const track = timeline.tracks.find((t) => t.id === trackId);
    if (!track) return;
    for (const clip of track.clips) {
      const blockLeft = clampX(clip.start * timeToMinimap);
      const blockRight = clampX(clip.end * timeToMinimap);
      blocks.push({
        clipId: clip.id,
        x: blockLeft,
        width: Math.max(MINIMAP_MIN_BLOCK_PX, blockRight - blockLeft),
        row,
      });
    }
  });
  const viewportX = clampX(scrollLeft * scrollScale);
  const viewportWidth = Math.min(minimapWidth - viewportX, Math.max(0, clientWidth) * scrollScale);
  return { blocks, viewport: { x: viewportX, width: viewportWidth }, rows };
}

/**
 * The lane `scrollLeft` (px) that centres the viewport window on a minimap click/
 * drag at `minimapX`. Maps the minimap-px point back to content px, centres the
 * viewport on it, and clamps to the scrollable range. Pure.
 *
 * @param minimapX - Pointer x within the minimap, px.
 * @param contentWidth - Total lane width, px.
 * @param clientWidth - Viewport width, px.
 * @param minimapWidth - Minimap strip width, px.
 */
export function minimapScrollLeft(
  minimapX: number,
  contentWidth: number,
  clientWidth: number,
  minimapWidth: number,
): number {
  if (minimapWidth <= 0) return 0;
  const scale = contentWidth / minimapWidth;
  const centerContentPx = minimapX * scale;
  const maxScroll = Math.max(0, contentWidth - clientWidth);
  return Math.max(0, Math.min(maxScroll, centerContentPx - clientWidth / 2));
}

/**
 * Build an SVG polyline `points` string drawing `peaks` (each normalized 0..1) as
 * a mirrored waveform across a `width`×`height` box. Returns `''` for no peaks.
 */
export function waveformPoints(peaks: readonly number[], width: number, height: number): string {
  if (peaks.length === 0 || width <= 0 || height <= 0) return '';
  const mid = height / 2;
  const step = peaks.length > 1 ? width / (peaks.length - 1) : 0;
  // Top edge left→right, then bottom edge right→left, mirrored about the midline.
  const top = peaks.map((p, i) => {
    const amp = Math.max(0, Math.min(1, p)) * mid;
    return `${(i * step).toFixed(1)},${(mid - amp).toFixed(1)}`;
  });
  const bottom = peaks
    .map((p, i) => {
      const amp = Math.max(0, Math.min(1, p)) * mid;
      return `${(i * step).toFixed(1)},${(mid + amp).toFixed(1)}`;
    })
    .reverse();
  return [...top, ...bottom].join(' ');
}

// ---------------------------------------------------------------------------
// Effect layers (schema v13, ADR 0088)
// ---------------------------------------------------------------------------

/** An effect layer with the lane that owns it. */
export interface EffectLayerLocation {
  readonly track: Track;
  readonly layer: EffectLayer;
}

/** Find an effect layer by id, anywhere on the timeline. */
export function findEffectLayer(
  timeline: Timeline,
  layerId: string,
): EffectLayerLocation | undefined {
  for (const track of timeline.tracks) {
    const layer = effectLayersOf(track).find((l) => l.id === layerId);
    if (layer !== undefined) return { track, layer };
  }
  return undefined;
}

/** Every effect lane, in track order (index 0 = visual front). */
export function effectTracks(timeline: Timeline): readonly Track[] {
  return timeline.tracks.filter((t) => t.type === 'effect');
}

/** Whether the timeline has any effect layer at all — the preview's fast bail. */
export function hasEffectLayers(timeline: Timeline): boolean {
  return timeline.tracks.some((t) => effectLayersOf(t).length > 0);
}

/**
 * Every effect layer in APPLY order, flattened for the preview.
 *
 * Order is the shared contract with the render engine (tracks bottom-up, then by
 * `start`), so this defers to `activeEffectLayersAt`'s rule rather than
 * re-deriving it — but returns ALL layers, not just those live at one instant,
 * because the preview engine does its own per-frame time filtering and must not
 * be re-fed on every frame.
 */
export function effectLayersInApplyOrder(timeline: Timeline): readonly EffectLayer[] {
  const out: EffectLayer[] = [];
  // Back-to-front: tracks[0] is the visual front, so it applies LAST.
  for (let i = timeline.tracks.length - 1; i >= 0; i -= 1) {
    const track = timeline.tracks[i];
    if (track === undefined || track.hidden === true) continue;
    out.push(...[...effectLayersOf(track)].sort((a, b) => a.start - b.start));
  }
  return out;
}
