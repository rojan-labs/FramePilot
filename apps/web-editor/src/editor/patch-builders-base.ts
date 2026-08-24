/**
 * Pure builders that turn a UI editing intent into a typed {@link Patch}
 * (plan/PLAN.md Phase 3.2 — trim / split / delete / move / ripple delete).
 *
 * Every manual edit in the UI is expressed as a patch built here, then routed
 * through the same `validate → apply → record` pipeline the AI layer uses
 * (AGENTS.md invariant 2: every edit is a typed timeline operation). There is no
 * code path that mutates the timeline directly.
 *
 * Patch ids are **deterministic** — derived from the operation and the clip's
 * position, never from a clock or RNG — so the same intent always produces the
 * same id (replayable, testable; consistent with the engine's id derivation).
 */
import {
  picturePlacementConflict as corePicturePlacementConflict,
  type AdjustAudioOp,
  type Easing,
  KEYFRAME_REPLACE_EPSILON,
  type Patch,
  TRANSITION_OUT_EFFECT_TYPE,
  type TransitionAlignment,
  transitionEligibility,
  punchInKeyframes,
  resolveCaptionCue,
  splitClipRightId,
} from '@framepilot/editor-core';
import type {
  Asset,
  BlendMode,
  CaptionStyle,
  CropRect,
  EffectLayer,
  Marker,
  SpeedPoint,
  Timeline,
  Track,
  TranscriptWord,
} from '@framepilot/timeline-schema';
import { effectLayersOf } from '@framepilot/timeline-schema';
import { findEffect, resolveParams } from '@framepilot/timeline-schema/effect-catalog';
import { clampParamsForKind } from '@framepilot/timeline-schema/effect-params';
import {
  assetKind,
  type ClipKind,
  clipKind,
  downstreamClips,
  findClip,
  findEffectLayer,
  isOverlayKind,
  layerKind,
  rollBounds,
} from './selectors.js';

/** Keyframe-animatable properties offered in the inspector UI. */
export const KEYFRAME_PROPERTIES = ['scale', 'opacity', 'x', 'y', 'rotation'] as const;
export type KeyframeProperty = (typeof KEYFRAME_PROPERTIES)[number];

/** Mask shapes offered in the inspector UI (mirrors `AddMaskOp.shape`). */
export const MASK_SHAPES = ['rectangle', 'ellipse', 'polygon'] as const;
export type MaskShapeName = (typeof MASK_SHAPES)[number];

/** Easing curves offered in the inspector UI (mirrors the schema enum). */
export const EASINGS: readonly Easing[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'hold',
  'bezier',
];

/**
 * A transition catalog id (mirrors `AddTransitionOp.kind`).
 *
 * A plain string, not a union of the catalog's 78 ids, for the reason the op
 * records: the catalog is data, and a union here would make every added
 * transition a type change in three packages. The op checks it against the
 * catalog at apply time, so a bad value is a refused patch with a sentence
 * attached rather than a transition that renders as nothing.
 */
export type TransitionKind = string;

/** Everything beyond kind and duration a transition can be added with. */
export interface TransitionOptions {
  /** Where the ramp sits relative to the cut. Absent ⇒ `start`. */
  readonly alignment?: TransitionAlignment;
  /**
   * Look params — direction, intensity, softness, easing and the render kind's
   * own numbers. Written alongside the three `add_transition` itself owns.
   */
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * The operations that add one transition with its full look.
 *
 * `add_transition` deliberately owns only kind, duration and alignment — the
 * things that decide whether the transition can exist at all. Everything else is
 * a `set_effect_params` behind it, so a look can be changed later without
 * re-issuing the op that validates the cut.
 */
function addTransitionOps(
  trackId: string,
  fromClipId: string,
  toClipId: string,
  kind: TransitionKind,
  durationSeconds: number,
  options?: TransitionOptions,
): Operation[] {
  const operations: Operation[] = [
    {
      type: 'add_transition',
      trackId,
      fromClipId,
      toClipId,
      kind,
      durationSeconds,
      ...(options?.alignment ? { alignment: options.alignment } : {}),
    },
  ];
  if (options?.params && Object.keys(options.params).length > 0) {
    operations.push({
      type: 'set_effect_params',
      clipId: toClipId,
      effectId: `${toClipId}__transition`,
      params: options.params,
    });
  }
  return operations;
}

/** Fallback clip length (seconds) for assets/overlays with no known duration. */
const DEFAULT_CLIP_SECONDS = 5;
/** Default transition length (seconds). */
/**
 * The duration a transition is added with by default.
 *
 * Exported because the timeline asks `transitionEligibility` whether a cut can take
 * a transition BEFORE offering the affordance, and that question is duration-
 * dependent (a clip shorter than the transition cannot hold it). Asking about a
 * different duration than the one the button would then apply is how an affordance
 * ends up offering an edit the validator rejects.
 */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** The end time of a track's last clip, or 0 when the track is empty. */
const trackEnd = (track: Track): number =>
  track.clips.reduce((max, clip) => Math.max(max, clip.end), 0);

/** Round a time to whole milliseconds so derived ids and ops stay stable. */
const ms = (seconds: number): number => Math.round(seconds * 1000);

/** PatchId is a branded string; cast at the construction boundary. */
const patchId = (raw: string): Patch['patchId'] => raw as Patch['patchId'];

/** Smallest edit that is worth recording, in seconds (sub-frame moves are no-ops). */
const MIN_EDIT_SECONDS = 1e-3;

/**
 * Trim a clip to a new `[start, end]` on the timeline. Returns `null` when the
 * clip is missing, the range is non-positive, or it is unchanged (a no-op edit
 * should never enter the undo history).
 */
export function trimClipPatch(
  timeline: Timeline,
  clipId: string,
  start: number,
  end: number,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found || end - start <= MIN_EDIT_SECONDS) {
    return null;
  }
  const { clip } = found;
  if (ms(clip.start) === ms(start) && ms(clip.end) === ms(end)) {
    return null;
  }
  return {
    patchId: patchId(`trim_${clipId}_${ms(start)}_${ms(end)}`),
    createdBy: 'user',
    reason: `Trim "${clipId}" to ${start}s–${end}s`,
    operations: [{ type: 'trim_clip', clipId, start, end }],
  };
}

/**
 * Roll the shared edit point between two adjacent (butt-joined) clips on the
 * same track: trim the outgoing clip's end and the incoming clip's start by
 * the same amount, so the pair's combined on-screen duration is unchanged.
 * `atCut` is the desired new edit time; it is clamped so neither clip shrinks
 * below {@link MIN_CLIP_SECONDS} and the incoming clip's source in-point never
 * goes negative. Returns `null` when the clips aren't adjacent on the same
 * track, either is missing, no valid cut time exists, or the result is a no-op.
 */
export function rollEditPatch(
  timeline: Timeline,
  outgoingClipId: string,
  incomingClipId: string,
  atCut: number,
): Patch | null {
  const a = findClip(timeline, outgoingClipId);
  const b = findClip(timeline, incomingClipId);
  if (!a || !b || a.track.id !== b.track.id) {
    return null;
  }
  if (ms(a.clip.end) !== ms(b.clip.start)) {
    return null; // only a real, butt-joined cut can be rolled
  }
  const bounds = rollBounds(a.clip, b.clip);
  if (!bounds) {
    return null; // both clips are already at the minimum length
  }
  const newCut = Math.min(bounds.max, Math.max(bounds.min, atCut));
  if (ms(newCut) === ms(a.clip.end)) {
    return null;
  }
  const outgoingTrim: Operation = {
    type: 'trim_clip',
    clipId: outgoingClipId,
    start: a.clip.start,
    end: newCut,
  };
  const incomingTrim: Operation = {
    type: 'trim_clip',
    clipId: incomingClipId,
    start: newCut,
    end: b.clip.end,
  };
  // Order matters: the validator checks each op as it applies, so growing one
  // side before shrinking the other would transiently overlap the pair. Shrink
  // first, grow second, whichever side that is for this direction of roll.
  const operations =
    newCut > a.clip.end ? [incomingTrim, outgoingTrim] : [outgoingTrim, incomingTrim];
  return {
    patchId: patchId(`roll_${outgoingClipId}_${incomingClipId}_${ms(newCut)}`),
    createdBy: 'user',
    reason: `Roll edit between "${outgoingClipId}" and "${incomingClipId}" to ${newCut}s`,
    operations,
  };
}

/**
 * Split a clip at timeline time `at`. Returns `null` unless `at` falls strictly
 * inside the clip (splitting at a boundary would create a zero-length clip).
 */
export function splitClipPatch(timeline: Timeline, clipId: string, at: number): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { clip } = found;
  if (at <= clip.start + MIN_EDIT_SECONDS || at >= clip.end - MIN_EDIT_SECONDS) {
    return null;
  }
  return {
    patchId: patchId(`split_${clipId}_${ms(at)}`),
    createdBy: 'user',
    reason: `Split "${clipId}" at ${at}s`,
    operations: [{ type: 'split_clip', clipId, at }],
  };
}

/**
 * Delete a clip, leaving a gap (lift). Implemented as a `delete_range` over the
 * clip's own span on its track. Returns `null` when the clip is missing.
 */
export function deleteClipPatch(timeline: Timeline, clipId: string): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { track, clip } = found;
  return {
    patchId: patchId(`delete_${clipId}`),
    createdBy: 'user',
    reason: `Delete "${clipId}"`,
    operations: [{ type: 'delete_range', trackId: track.id, start: clip.start, end: clip.end }],
  };
}

/**
 * Ripple-delete a clip: remove it and pull everything after it left to close
 * the gap. Returns `null` when the clip is missing.
 */
export function rippleDeleteClipPatch(timeline: Timeline, clipId: string): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { track, clip } = found;
  return {
    patchId: patchId(`ripple_${clipId}`),
    createdBy: 'user',
    reason: `Ripple-delete "${clipId}"`,
    operations: [{ type: 'ripple_delete', trackId: track.id, start: clip.start, end: clip.end }],
  };
}

/** One operation inside a {@link Patch} (the element type of `operations`). */
type Operation = Patch['operations'][number];

/**
 * Delete a set of clips as ONE reversible patch (M2a batch delete). Each clip is
 * removed over its own span — a lift (`delete_range`) by default, or a ripple
 * (`ripple_delete`) when `ripple` is set. Missing/duplicate ids are ignored.
 *
 * Ordering matters for ripple: deleting an earlier clip pulls later clips left,
 * which would invalidate a later op's stored span. So ripple ops are emitted
 * **back-to-front within each track** (descending start) — removing the latest
 * clip first leaves every earlier clip's span untouched. Lift ops leave neighbours
 * in place, so their order is irrelevant; we keep the same deterministic sort for
 * a stable patch id. Returns `null` when no listed clip exists.
 *
 * @param timeline - Current timeline.
 * @param clipIds - The clip ids to remove (the whole selection).
 * @param ripple - When true, close the gap (ripple) instead of leaving one (lift).
 */
export function deleteClipsPatch(
  timeline: Timeline,
  clipIds: readonly string[],
  ripple = false,
): Patch | null {
  // Resolve to located clips, de-duplicated, dropping ids that are not present.
  const located = [...new Set(clipIds)]
    .map((id) => findClip(timeline, id))
    .filter((loc): loc is NonNullable<typeof loc> => loc !== null);
  if (located.length === 0) {
    return null;
  }
  // Back-to-front by start (then track id, for a deterministic tie-break) so a
  // ripple never shifts a clip a later op still refers to.
  const ordered = [...located].sort(
    (a, b) => b.clip.start - a.clip.start || (a.track.id < b.track.id ? -1 : 1),
  );
  const type = ripple ? 'ripple_delete' : 'delete_range';
  const operations: Operation[] = ordered.map(({ track, clip }) => ({
    type,
    trackId: track.id,
    start: clip.start,
    end: clip.end,
  }));
  // Deterministic id from the (sorted) clip ids and the mode.
  const key = ordered.map((loc) => loc.clip.id).join('-');
  return {
    patchId: patchId(`${ripple ? 'rippleN' : 'deleteN'}_${key}`),
    createdBy: 'user',
    reason: `${ripple ? 'Ripple-delete' : 'Delete'} ${operations.length} clip(s)`,
    operations,
  };
}

/**
 * Move a set of clips by ONE reversible patch (M2a batch move) — every clip is
 * repositioned by its own resolved `{ toTrackId, toStart }`. The caller computes
 * the per-clip targets (e.g. apply the same delta to each, snapping the primary).
 * No-op moves (same track + same start) are dropped; missing clips are ignored.
 *
 * Unlike the single-clip {@link moveClipPatch}, a batch move does **not** spawn an
 * auto-layer on overlap — the moved clips may legitimately swap places among
 * themselves, and resolving that against an auto-layer heuristic is out of scope
 * for M2a. An overlap with a clip *outside* the selection is left for the
 * validator to reject (the whole gesture then fails atomically, as one patch).
 * Returns `null` when no move remains after dropping no-ops.
 *
 * @param timeline - Current timeline.
 * @param moves - Per-clip destinations (track + start in seconds).
 */
export function moveClipsPatch(
  timeline: Timeline,
  moves: readonly {
    readonly clipId: string;
    readonly toTrackId: string;
    readonly toStart: number;
  }[],
): Patch | null {
  const operations: Operation[] = [];
  const ids: string[] = [];
  for (const move of moves) {
    const found = findClip(timeline, move.clipId);
    if (!found) continue;
    const start = move.toStart < 0 ? 0 : move.toStart;
    if (move.toTrackId === found.track.id && ms(found.clip.start) === ms(start)) {
      continue; // no-op for this clip
    }
    operations.push({
      type: 'move_clip',
      clipId: move.clipId,
      toTrackId: move.toTrackId,
      toStart: start,
    });
    ids.push(move.clipId);
  }
  if (operations.length === 0) {
    return null;
  }
  return {
    patchId: patchId(`moveN_${ids.join('-')}_${ms(operations.length)}`),
    createdBy: 'user',
    reason: `Move ${operations.length} clip(s)`,
    operations,
  };
}

/**
 * Lift-delete every clip that references `assetId`, as a single undoable patch —
 * used when removing an asset from the media bin so no clip is left pointing at
 * deleted media. Each clip is removed by a `delete_range` over its own span;
 * since a lift leaves the surrounding clips in place, the remaining ops' spans
 * stay valid as the patch applies. Returns `null` when no clip uses the asset.
 */
export function removeAssetClipsPatch(timeline: Timeline, assetId: string): Patch | null {
  const operations: Patch['operations'][number][] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId === assetId) {
        operations.push({
          type: 'delete_range',
          trackId: track.id,
          start: clip.start,
          end: clip.end,
        });
      }
    }
  }
  if (operations.length === 0) {
    return null;
  }
  return {
    patchId: patchId(`rmasset_${assetId}`),
    createdBy: 'user',
    reason: `Remove clips of "${assetId}"`,
    operations,
  };
}

/**
 * Move a clip to `toStart` (optionally onto another track). Returns `null` when
 * the clip is missing or the move is a no-op (same track and same start).
 *
 * Auto-layering (Phase 2, ADR 0032 — CapCut-style): if the drop would overlap a
 * clip already on the destination layer, the clip is **not** rejected. Instead a
 * **new layer is created at index 0 (the visual front)** and the clip is moved
 * onto it — the same "make room above" behaviour {@link placeAssetPatch} gives a
 * fresh asset drop. The `add_layer` + `move_clip` ops invert together on undo.
 */
export function moveClipPatch(
  timeline: Timeline,
  clipId: string,
  toStart: number,
  toTrackId?: string,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { track, clip } = found;
  const targetTrackId = toTrackId ?? track.id;
  const start = toStart < 0 ? 0 : toStart;
  if (targetTrackId === track.id && ms(clip.start) === ms(start)) {
    return null;
  }
  const end = start + (clip.end - clip.start);

  // Does the destination have room? The clip being moved is excluded — it is
  // removed from its source before re-insertion, so it can never collide with
  // its own former position (e.g. nudging a clip within its own track).
  const destTrack = timeline.tracks.find((t) => t.id === targetTrackId);
  const collides =
    destTrack !== undefined &&
    destTrack.clips.some(
      (c) =>
        c.id !== clipId && c.start < end - MIN_EDIT_SECONDS && c.end > start + MIN_EDIT_SECONDS,
    );

  if (!collides) {
    return {
      patchId: patchId(`move_${clipId}_${targetTrackId}_${ms(start)}`),
      createdBy: 'user',
      reason: `Move "${clipId}" to ${start}s on ${targetTrackId}`,
      operations: [{ type: 'move_clip', clipId, toTrackId: targetTrackId, toStart: start }],
    };
  }

  // Overlap → spawn a fresh layer at the front and move the clip onto it. The
  // new layer inherits the destination's role (or the source's when the drop is
  // off the known tracks), keeping like clips on like layers.
  const layerType = destTrack ? destTrack.type : track.type;
  const layerId = nextLayerId(timeline, layerType);
  return {
    patchId: patchId(`movelayer_${clipId}_${layerId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Move "${clipId}" to a new ${layerType} layer at ${start.toFixed(2)}s`,
    operations: [
      { type: 'add_layer', layerId, layerType, atIndex: 0 },
      { type: 'move_clip', clipId, toTrackId: layerId, toStart: start },
    ],
  };
}

/**
 * Place a clone of `source` (same asset + source in/out, same duration) on
 * `trackId` starting at `atStart`. The shared builder behind duplicate and paste.
 * Returns `null` when the target track is missing.
 */
function placeClonePatch(
  timeline: Timeline,
  trackId: string,
  source: {
    id: string;
    assetId: string;
    start: number;
    end: number;
    sourceStart: number;
    sourceEnd: number;
  },
  atStart: number,
): Patch | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) {
    return null;
  }
  const start = atStart < 0 ? 0 : atStart;
  const end = start + (source.end - source.start);
  return {
    patchId: patchId(`clone_${source.id}_${trackId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Place copy of "${source.id}" on ${trackId} at ${start.toFixed(2)}s`,
    operations: [
      {
        type: 'add_clip',
        trackId,
        assetId: source.assetId,
        start,
        end,
        sourceStart: source.sourceStart,
        sourceEnd: source.sourceEnd,
      },
    ],
  };
}

/**
 * Duplicate a clip onto its own track, appended right after it (or at `atStart`).
 * Returns `null` when the clip is missing.
 */
export function duplicateClipPatch(
  timeline: Timeline,
  clipId: string,
  atStart?: number,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  return placeClonePatch(timeline, found.track.id, found.clip, atStart ?? found.clip.end);
}

/**
 * Duplicate a set of clips as ONE reversible patch (M2a batch duplicate) — each
 * clip is cloned onto its own track, appended right after itself. Missing/duplicate
 * ids are ignored. Returns `null` when no listed clip exists.
 *
 * The clones use the source clips' *current* positions (`clip.end`), so two
 * selected clips on the same track each append after their own original — no
 * inter-clone overlap as long as the originals do not abut another clip; any
 * residual overlap is left for the validator to reject atomically.
 */
export function duplicateClipsPatch(timeline: Timeline, clipIds: readonly string[]): Patch | null {
  const located = [...new Set(clipIds)]
    .map((id) => findClip(timeline, id))
    .filter((loc): loc is NonNullable<typeof loc> => loc !== null);
  if (located.length === 0) {
    return null;
  }
  const operations: Operation[] = located.map(({ track, clip }) => ({
    type: 'add_clip',
    trackId: track.id,
    assetId: clip.assetId,
    start: clip.end,
    end: clip.end + (clip.end - clip.start),
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
  }));
  return {
    patchId: patchId(`dupN_${located.map((l) => l.clip.id).join('-')}`),
    createdBy: 'user',
    reason: `Duplicate ${operations.length} clip(s)`,
    operations,
  };
}

/**
 * Duplicate a clip onto an explicit track/position — the Cmd/Ctrl-drag-duplicate
 * counterpart to {@link moveClipPatch}. Unlike {@link duplicateClipPatch} (which
 * always appends after the source on its own track), this places the clone
 * wherever the drag gesture resolved, including a different compatible track.
 * Returns `null` when the clip is missing.
 */
export function duplicateClipAtPatch(
  timeline: Timeline,
  clipId: string,
  trackId: string,
  atStart: number,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  return placeClonePatch(timeline, trackId, found.clip, atStart);
}

/**
 * Duplicate a set of clips onto explicit target track/positions, as ONE
 * reversible patch — the Cmd/Ctrl-drag-duplicate counterpart to
 * {@link moveClipsPatch}. Missing ids are ignored; returns `null` when none
 * resolve.
 */
export function duplicateClipsAtPatch(
  timeline: Timeline,
  moves: readonly {
    readonly clipId: string;
    readonly toTrackId: string;
    readonly toStart: number;
  }[],
): Patch | null {
  const operations: Operation[] = [];
  const ids: string[] = [];
  for (const move of moves) {
    const found = findClip(timeline, move.clipId);
    if (!found) continue;
    const start = move.toStart < 0 ? 0 : move.toStart;
    operations.push({
      type: 'add_clip',
      trackId: move.toTrackId,
      assetId: found.clip.assetId,
      start,
      end: start + (found.clip.end - found.clip.start),
      sourceStart: found.clip.sourceStart,
      sourceEnd: found.clip.sourceEnd,
    });
    ids.push(move.clipId);
  }
  if (operations.length === 0) {
    return null;
  }
  return {
    patchId: patchId(`dupAtN_${ids.join('-')}_${ms(operations.length)}`),
    createdBy: 'user',
    reason: `Duplicate ${operations.length} clip(s)`,
    operations,
  };
}

/** A copied clip snapshot, enough to re-create it as a new `add_clip`. */
export interface ClipSnapshot {
  readonly id: string;
  readonly assetId: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

/**
 * Paste a copied clip snapshot onto `trackId` at `atStart`. Returns `null` when
 * the track is missing (an overlapping paste is left for the validator to reject).
 */
export function pasteClipPatch(
  timeline: Timeline,
  source: ClipSnapshot,
  trackId: string,
  atStart: number,
): Patch | null {
  return placeClonePatch(timeline, trackId, source, atStart);
}

/**
 * Adjust a clip's audio gain (dB). Returns `null` when the clip is missing or
 * the change is zero.
 */
export function adjustAudioPatch(timeline: Timeline, clipId: string, gainDb: number): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found || gainDb === 0) {
    return null;
  }
  return {
    patchId: patchId(`gain_${clipId}_${Math.round(gainDb * 100)}`),
    createdBy: 'user',
    reason: `Set "${clipId}" gain to ${gainDb}dB`,
    operations: [{ type: 'adjust_audio', clipId, gainDb }],
  };
}

/** Full per-clip audio settings the inspector's audio panel can set at once. */
export interface AudioSettingsInput {
  readonly gainDb: number;
  readonly fadeInSeconds?: number;
  readonly fadeOutSeconds?: number;
  readonly muted?: boolean;
  readonly normalize?: boolean;
  readonly duckUnderTrackId?: string | null;
  readonly duckAmountDb?: number;
}

/**
 * Set a clip's full audio settings (gain + fades + mute + normalize + duck) as one
 * reversible `adjust_audio` patch. Replaces the clip's prior `audio_gain` effect.
 * Returns `null` when the clip is missing.
 */
export function setAudioPatch(
  timeline: Timeline,
  clipId: string,
  settings: AudioSettingsInput,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const op: AdjustAudioOp = {
    type: 'adjust_audio',
    clipId,
    gainDb: settings.gainDb,
    ...(settings.fadeInSeconds ? { fadeInSeconds: settings.fadeInSeconds } : {}),
    ...(settings.fadeOutSeconds ? { fadeOutSeconds: settings.fadeOutSeconds } : {}),
    ...(settings.muted ? { muted: true } : {}),
    ...(settings.normalize ? { normalize: true } : {}),
    ...(settings.duckUnderTrackId
      ? { duckUnderTrackId: settings.duckUnderTrackId, duckAmountDb: settings.duckAmountDb ?? -12 }
      : {}),
  };
  return {
    patchId: patchId(`audio_${clipId}_${Math.round(settings.gainDb * 100)}`),
    createdBy: 'user',
    reason: `Set audio on "${clipId}"`,
    operations: [op],
  };
}

/**
 * Add a zoom/punch-in (animated `scale`) spanning the whole clip. Returns `null`
 * when the clip is missing. Builds the keyframes with the shared engine
 * generator, so the UI and the AI `punch_in` tool produce identical motion.
 */
export function punchInPatch(
  timeline: Timeline,
  clipId: string,
  fromScale = 1.0,
  toScale = 1.2,
  easing: Easing = 'ease-in-out',
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found || toScale === fromScale) {
    return null;
  }
  const { clip } = found;
  const keyframes = punchInKeyframes({
    idPrefix: `punch_${clipId}`,
    startTime: 0,
    endTime: clip.end - clip.start,
    fromScale,
    toScale,
    easing,
  });
  return {
    patchId: patchId(`punch_${clipId}_${ms(fromScale)}_${ms(toScale)}_${easing}`),
    createdBy: 'user',
    reason: `Punch-in "${clipId}" (${fromScale}→${toScale})`,
    operations: [{ type: 'add_keyframes', clipId, keyframes }],
  };
}

/**
 * Add a single keyframe to a clip property at clip-relative `time` (clamped to
 * the clip's span). Returns `null` when the clip is missing.
 */
export function addKeyframePatch(
  timeline: Timeline,
  clipId: string,
  property: KeyframeProperty,
  value: number,
  time: number,
  easing: Easing = 'linear',
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { clip } = found;
  const duration = clip.end - clip.start;
  const at = time < 0 ? 0 : time > duration ? duration : time;
  return {
    patchId: patchId(`kf_${clipId}_${property}_${ms(at)}_${ms(value)}`),
    createdBy: 'user',
    reason: `Add ${property} keyframe to "${clipId}" @ ${at.toFixed(2)}s`,
    operations: [
      {
        type: 'add_keyframes',
        clipId,
        keyframes: [
          { id: `kf_${clipId}_${property}_${ms(at)}`, time: at, property, value, easing },
        ],
      },
    ],
  };
}

/**
 * Clamp a clip-relative time into the clip's own span.
 *
 * A keyframe outside `[0, duration]` is not evaluated by anything (the engine holds
 * the first/last value beyond the ends) but it *is* stored, carried through splits,
 * and drawn on a Phase 6 lane — so it would show as a marker the user cannot reach.
 */
const clampToClip = (clip: { start: number; end: number }, time: number): number => {
  const duration = clip.end - clip.start;
  return time < 0 ? 0 : time > duration ? duration : time;
};

/**
 * Set (or replace) a keyframe for `property` at clip-relative `time`.
 *
 * The inspector diamond's "add a keyframe here" and the write behind editing an
 * already-animated property. `replace: true` means clicking the diamond twice, or
 * nudging a value at a time that already has a keyframe, updates in place instead of
 * stacking duplicates a fraction of a millisecond apart.
 *
 * Distinct from {@link setClipTransformPatch}, which always writes at time 0: that is
 * the *base* transform the canvas handles edit, whereas this writes wherever the
 * playhead is. The inspector picks between them on whether the property is animated
 * (see `inspector/keyframe-state.ts`) — editing a static property must not silently
 * start an animation.
 *
 * Returns `null` when the clip is missing.
 */
export function setKeyframeAtPlayheadPatch(
  timeline: Timeline,
  clipId: string,
  property: string,
  value: number,
  time: number,
  easing: Easing = 'linear',
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found || !Number.isFinite(value)) return null;
  const at = clampToClip(found.clip, time);
  return {
    patchId: patchId(`setkf_${clipId}_${property}_${ms(at)}_${ms(value)}`),
    createdBy: 'user',
    reason: `Set ${property} keyframe on "${clipId}" @ ${at.toFixed(2)}s`,
    operations: [
      {
        type: 'add_keyframes',
        clipId,
        keyframes: [
          { id: `kf_${clipId}_${property}_${ms(at)}`, time: at, property, value, easing },
        ],
        replace: true,
      },
    ],
  };
}

/**
 * Remove a keyframe — one at `time`, or the property's whole animation when `time` is
 * omitted.
 *
 * Omitting `time` is "clear this property's animation", which the inspector's
 * clear-property action and Phase 12's context menu both want; it does not require
 * the caller to enumerate times it may not know.
 *
 * Returns `null` when the clip is missing, or when nothing would be removed — a patch
 * that changes nothing would still cost the user an undo press.
 */
export function removeKeyframePatch(
  timeline: Timeline,
  clipId: string,
  property: string,
  time?: number,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const matches = found.clip.keyframes.filter(
    (keyframe) =>
      keyframe.property === property &&
      (time === undefined || Math.abs(keyframe.time - time) <= KEYFRAME_REPLACE_EPSILON),
  );
  if (matches.length === 0) return null;
  const where = time === undefined ? 'everywhere' : `@ ${time.toFixed(2)}s`;
  return {
    patchId: patchId(`rmkf_${clipId}_${property}_${time === undefined ? 'all' : ms(time)}`),
    createdBy: 'user',
    reason: `Remove ${property} keyframe${matches.length === 1 ? '' : 's'} from "${clipId}" ${where}`,
    operations: [
      {
        type: 'remove_keyframes',
        clipId,
        targets: [time === undefined ? { property } : { property, time }],
      },
    ],
  };
}

/**
 * Move a keyframe from `fromTime` to `toTime`, preserving its value and easing.
 *
 * **One patch, two operations** — a remove at the old time and an add at the new.
 * That is what makes dragging a keyframe (Phase 6) a single undo step: two patches
 * would leave a press of undo showing the keyframe deleted but not restored, which
 * looks like data loss.
 *
 * Returns `null` when the clip or the keyframe is missing, or when the move is a
 * no-op (the two times are the same keyframe slot by the engine's epsilon).
 */
export function moveKeyframePatch(
  timeline: Timeline,
  clipId: string,
  property: string,
  fromTime: number,
  toTime: number,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const moving = found.clip.keyframes.find(
    (keyframe) =>
      keyframe.property === property &&
      Math.abs(keyframe.time - fromTime) <= KEYFRAME_REPLACE_EPSILON,
  );
  if (!moving) return null;
  const at = clampToClip(found.clip, toTime);
  if (Math.abs(at - moving.time) <= KEYFRAME_REPLACE_EPSILON) return null;
  return {
    patchId: patchId(`movekf_${clipId}_${property}_${ms(moving.time)}_${ms(at)}`),
    createdBy: 'user',
    reason: `Move ${property} keyframe on "${clipId}" to ${at.toFixed(2)}s`,
    operations: [
      { type: 'remove_keyframes', clipId, targets: [{ property, time: moving.time }] },
      {
        type: 'add_keyframes',
        clipId,
        // A move keeps the keyframe's own easing: the curve into the next keyframe is
        // a decision the user already made, and resetting it to linear on a drag
        // would quietly flatten their animation.
        keyframes: [
          {
            id: `kf_${clipId}_${property}_${ms(at)}`,
            time: at,
            property,
            value: moving.value,
            easing: moving.easing,
          },
        ],
        // The destination may already hold a keyframe for this property; land on it
        // rather than stacking a duplicate the user cannot see or select.
        replace: true,
      },
    ],
  };
}

/** One keyframe to move: where it is now, and where it should end up. */
export interface KeyframeMove {
  readonly clipId: string;
  readonly property: string;
  readonly fromTime: number;
  readonly toTime: number;
}

/**
 * Move several keyframes at once — a group drag on the timeline (Phase 6).
 *
 * **All removes are emitted before any add**, and that ordering is the whole point.
 * Applied pairwise, moving `[1s, 2s]` forward by 1s would first write 1s→2s, which
 * `replace` lands on top of the keyframe at 2s that is *also* moving — so the group
 * would arrive with one keyframe missing. Batching the removes first empties every
 * source slot before anything is written back.
 *
 * Still one patch, so a group drag is one undo press.
 *
 * Returns `null` when no move survives (missing clips, missing keyframes, or every
 * move a no-op).
 */
export function moveKeyframesPatch(
  timeline: Timeline,
  moves: readonly KeyframeMove[],
): Patch | null {
  const resolved = moves.flatMap((move) => {
    const found = findClip(timeline, move.clipId);
    if (!found) return [];
    const keyframe = found.clip.keyframes.find(
      (candidate) =>
        candidate.property === move.property &&
        Math.abs(candidate.time - move.fromTime) <= KEYFRAME_REPLACE_EPSILON,
    );
    if (!keyframe) return [];
    const at = clampToClip(found.clip, move.toTime);
    if (Math.abs(at - keyframe.time) <= KEYFRAME_REPLACE_EPSILON) return [];
    return [{ move, keyframe, at }];
  });
  if (resolved.length === 0) return null;

  const removals: Operation[] = resolved.map(({ move, keyframe }) => ({
    type: 'remove_keyframes',
    clipId: move.clipId,
    targets: [{ property: move.property, time: keyframe.time }],
  }));
  const additions: Operation[] = resolved.map(({ move, keyframe, at }) => ({
    type: 'add_keyframes',
    clipId: move.clipId,
    keyframes: [
      {
        id: `kf_${move.clipId}_${move.property}_${ms(at)}`,
        time: at,
        property: move.property,
        value: keyframe.value,
        easing: keyframe.easing,
      },
    ],
    replace: true,
  }));

  const count = resolved.length;
  return {
    patchId: patchId(`movekfs_${count}_${ms(resolved[0]!.at - resolved[0]!.keyframe.time)}`),
    createdBy: 'user',
    reason: `Move ${count} keyframe${count === 1 ? '' : 's'}`,
    operations: [...removals, ...additions],
  };
}

/** One keyframe to delete, identified the way the engine matches them. */
export interface KeyframeRef {
  readonly clipId: string;
  readonly property: string;
  readonly time: number;
}

/**
 * Delete several keyframes in one patch — pressing Delete with a lane selection.
 *
 * Grouped per clip so a selection spanning two clips is two operations, not two
 * patches: it was one keypress, so it is one undo step.
 *
 * Returns `null` when nothing matches.
 */
export function removeKeyframesPatch(
  timeline: Timeline,
  refs: readonly KeyframeRef[],
): Patch | null {
  const byClip = new Map<string, { property: string; time: number }[]>();
  for (const ref of refs) {
    const found = findClip(timeline, ref.clipId);
    if (!found) continue;
    const exists = found.clip.keyframes.some(
      (keyframe) =>
        keyframe.property === ref.property &&
        Math.abs(keyframe.time - ref.time) <= KEYFRAME_REPLACE_EPSILON,
    );
    if (!exists) continue;
    const bucket = byClip.get(ref.clipId);
    if (bucket) bucket.push({ property: ref.property, time: ref.time });
    else byClip.set(ref.clipId, [{ property: ref.property, time: ref.time }]);
  }
  if (byClip.size === 0) return null;
  const total = [...byClip.values()].reduce((sum, targets) => sum + targets.length, 0);
  return {
    patchId: patchId(`rmkfs_${[...byClip.keys()].join('_')}_${total}`),
    createdBy: 'user',
    reason: `Remove ${total} keyframe${total === 1 ? '' : 's'}`,
    operations: [...byClip].map(([clipId, targets]) => ({
      type: 'remove_keyframes' as const,
      clipId,
      targets,
    })),
  };
}

/**
 * Set (or clear) a keyframe's bezier handles — the graph editor's commit
 * (schema v14, ADR 0089).
 *
 * Passing `null` **removes** the handles, which restores the hardcoded smoothstep
 * that `bezier` means without them; that is the graph editor's "reset curve", and it
 * is a removal rather than a write of default control points so the project does not
 * accumulate handles that say nothing.
 *
 * Writing handles also forces `easing` to `'bezier'`: handles on a keyframe eased
 * `ease-in` are stored but ignored, which would be a control with no visible effect.
 *
 * Returns `null` when the clip or keyframe is missing, or nothing would change.
 */
export function setKeyframeHandlesPatch(
  timeline: Timeline,
  clipId: string,
  property: string,
  time: number,
  handles: { out: [number, number]; in: [number, number] } | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const target = found.clip.keyframes.find(
    (keyframe) =>
      keyframe.property === property && Math.abs(keyframe.time - time) <= KEYFRAME_REPLACE_EPSILON,
  );
  if (!target) return null;
  const same =
    handles === null
      ? target.handles === undefined && target.easing !== 'bezier'
      : target.easing === 'bezier' &&
        target.handles !== undefined &&
        target.handles.out[0] === handles.out[0] &&
        target.handles.out[1] === handles.out[1] &&
        target.handles.in[0] === handles.in[0] &&
        target.handles.in[1] === handles.in[1];
  if (same) return null;
  // Spread-then-delete rather than `handles: undefined`: an explicit undefined
  // survives into the stored object under `exactOptionalPropertyTypes` and would
  // serialise as a null field.
  const next = { ...target, easing: 'bezier' as const, handles: handles ?? undefined };
  if (handles === null) delete (next as { handles?: unknown }).handles;
  return {
    patchId: patchId(
      `kfhandles_${clipId}_${property}_${ms(target.time)}_${handles === null ? 'reset' : 'set'}`,
    ),
    createdBy: 'user',
    reason:
      handles === null
        ? `Reset ${property} keyframe curve on "${clipId}"`
        : `Shape ${property} keyframe curve on "${clipId}"`,
    operations: [{ type: 'add_keyframes', clipId, keyframes: [next], replace: true }],
  };
}

/**
 * Set the easing of the keyframe at `time` (the curve INTO the next keyframe).
 *
 * A rewrite in place: `add_keyframes` with `replace` swaps the same property at the
 * same time, so this is one operation, not a remove-then-add.
 *
 * Returns `null` when the clip or keyframe is missing, or the easing is unchanged.
 */
export function setKeyframeEasingPatch(
  timeline: Timeline,
  clipId: string,
  property: string,
  time: number,
  easing: Easing,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const target = found.clip.keyframes.find(
    (keyframe) =>
      keyframe.property === property && Math.abs(keyframe.time - time) <= KEYFRAME_REPLACE_EPSILON,
  );
  if (!target || target.easing === easing) return null;
  return {
    patchId: patchId(`kfease_${clipId}_${property}_${ms(target.time)}_${easing}`),
    createdBy: 'user',
    reason: `Set ${property} keyframe easing to ${easing} on "${clipId}"`,
    operations: [
      {
        type: 'add_keyframes',
        clipId,
        keyframes: [{ ...target, easing }],
        replace: true,
      },
    ],
  };
}

/**
 * The transform properties the on-canvas handles can write.
 *
 * `rotation` joined the set in revamp Phase 3, once the preview composited it
 * (`preview/picture-transform.ts`) — the export had rendered it since Phase 5, so a
 * rotation handle was only ever blocked on the monitor being able to show its
 * result, never on the engine. Degrees, ANTICLOCKWISE-positive (the project/MoviePy
 * convention; the canvas negates on the way in).
 *
 * `opacity` joined in revamp Phase 5, for the inspector's Transform rows. The canvas
 * handles never write it (there is no opacity handle), but the inspector's base-value
 * write goes through the same builder, and the render has composited animated opacity
 * since Phase 6 (`_attach_mask`) — so it is a property the export honours.
 *
 * Deliberately NOT here: an anchor/origin. `evaluate_clip_transform` has no such
 * property — rotation and scale are both about the clip's own centre — so writing
 * one would produce keyframes the render ignores. See the sub-plan's Phase 3 note.
 */
export type ClipTransformProperty = 'scale' | 'x' | 'y' | 'rotation' | 'opacity';

/**
 * Set a clip's BASE transform (H4 canvas handles): writes `scale`/`x`/`y`/`rotation`
 * keyframes at time 0 with `replace: true`, so dragging the on-canvas controls
 * repeatedly updates the transform in place instead of stacking duplicate
 * keyframes. Values omitted are left untouched. `x`/`y` are canvas-pixel
 * offsets from centered; `scale` 1.0 = native fit (engine convention).
 * Returns `null` when the clip is missing or nothing would change.
 */
export function setClipTransformPatch(
  timeline: Timeline,
  clipId: string,
  values: Partial<Record<ClipTransformProperty, number>>,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const entries = (Object.entries(values) as [ClipTransformProperty, number][]).filter(
    ([, value]) => Number.isFinite(value),
  );
  if (entries.length === 0) return null;
  const keyframes = entries.map(([property, value]) => ({
    id: `kf_${clipId}_${property}_base`,
    time: 0,
    property,
    value,
    easing: 'linear' as const,
  }));
  const summary = entries.map(([p, v]) => `${p}=${v.toFixed(2)}`).join(', ');
  return {
    patchId: patchId(`transform_${clipId}_${entries.map(([p, v]) => `${p}${ms(v)}`).join('_')}`),
    createdBy: 'user',
    reason: `Transform "${clipId}" (${summary})`,
    operations: [{ type: 'add_keyframes', clipId, keyframes, replace: true }],
  };
}

/**
 * Add a mask to a clip — a centered shape by default. Returns `null` when the
 * clip is missing. Geometry is in frame fractions; the engine rasterizes it.
 */
export function addMaskPatch(
  timeline: Timeline,
  clipId: string,
  shape: MaskShapeName,
  feather = 0,
  opacity = 1,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  // A centered shape covering the middle 60% of the frame — a sensible default
  // the user can refine; polygon falls back to that box until point editing lands.
  const bounds = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  return {
    patchId: patchId(`mask_${clipId}_${shape}_${ms(feather)}_${ms(opacity)}`),
    createdBy: 'user',
    reason: `Add ${shape} mask to "${clipId}"`,
    operations: [{ type: 'add_mask', clipId, shape, bounds, feather, opacity }],
  };
}

/**
 * Place an imported asset as a new clip on a track, appended after the track's
 * last clip (so it never overlaps) unless an explicit `atStart` is given.
 * Returns `null` when the target track is missing.
 */
export function addClipPatch(
  timeline: Timeline,
  trackId: string,
  asset: Asset,
  atStart?: number,
): Patch | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) {
    return null;
  }
  const duration = asset.durationSeconds ?? DEFAULT_CLIP_SECONDS;
  const start = atStart !== undefined && atStart >= 0 ? atStart : trackEnd(track);
  const end = start + duration;
  return {
    patchId: patchId(`addclip_${asset.id}_${trackId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Add "${asset.id}" to ${trackId} at ${start.toFixed(2)}s`,
    operations: [
      {
        type: 'add_clip',
        trackId,
        assetId: asset.id,
        start,
        end,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

/**
 * Insert-mode placement (plan/TIMELINE-REVAMP.md §4 "Edit modes"). Place `asset`
 * on `trackId` at `atStart` and **push the downstream same-lane clips right** by
 * the clip's duration — a CapCut/Premiere "insert" edit — as ONE reversible patch
 * built from EXISTING operations (`move_clip` shifts + one `add_clip`); no new
 * operation type and no auto-layering. Returns `null` when the target track is
 * missing.
 *
 * **Op ordering is load-bearing.** The validator replays operations one at a time
 * and rejects any *transient* overlap after each step. So the downstream clips are
 * shifted **back-to-front** (furthest start first — see {@link downstreamClips}):
 * the furthest clip moves right into free space, then the next moves into the slot
 * the furthest just vacated, and so on, so no `move_clip` ever lands on a clip that
 * has not moved yet. Only once `[atStart, atStart+duration)` is clear does the final
 * `add_clip` fill it. All ops invert together, so one undo reverts the whole insert.
 *
 * @param timeline - Current timeline.
 * @param trackId - The lane to insert onto.
 * @param asset - The media asset being placed.
 * @param atStart - Insertion point (seconds); clamped to ≥ 0.
 */
export function insertClipPatch(
  timeline: Timeline,
  trackId: string,
  asset: Asset,
  atStart: number,
): Patch | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) {
    return null;
  }
  const start = atStart < 0 ? 0 : atStart;
  const duration = asset.durationSeconds ?? DEFAULT_CLIP_SECONDS;
  const end = start + duration;

  // Back-to-front so each shift lands in space the previous shift (or the timeline
  // tail) already cleared — never on a clip that has not moved yet.
  const shiftOps: Operation[] = downstreamClips(timeline, trackId, start).map((clip) => ({
    type: 'move_clip',
    clipId: clip.id,
    toTrackId: trackId,
    toStart: clip.start + duration,
  }));

  return {
    patchId: patchId(`insert_${asset.id}_${trackId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Insert "${asset.id}" on ${trackId} at ${start.toFixed(2)}s`,
    operations: [
      ...shiftOps,
      {
        type: 'add_clip',
        trackId,
        assetId: asset.id,
        start,
        end,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

/** Which track flag a toggle targets (schema v4). */
export type TrackFlag = 'locked' | 'hidden' | 'muted';

/**
 * Toggle (or set) a track's `locked`/`hidden`/`muted` flag as one reversible
 * `set_track_flags` patch. Returns `null` when the track is missing. The flag's
 * absence reads as `false`, so the toggle flips `undefined`→`true`.
 */
export function setTrackFlagsPatch(
  timeline: Timeline,
  trackId: string,
  flag: TrackFlag,
  value: boolean,
): Patch | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) {
    return null;
  }
  return {
    patchId: patchId(`trackflag_${trackId}_${flag}_${value ? 1 : 0}`),
    createdBy: 'user',
    reason: `${value ? 'Enable' : 'Disable'} ${flag} on ${trackId}`,
    operations: [{ type: 'set_track_flags', trackId, [flag]: value }],
  };
}

// ---------------------------------------------------------------------------
// Layer builders (Phase 2 — type-agnostic layers). A layer is a `Track`; `index 0`
// is the visual front. See `plan/PHASE2-type-agnostic-layers.md`.
// ---------------------------------------------------------------------------

/** A non-colliding, deterministic id for a new layer of the given role. */
function nextLayerId(timeline: Timeline, layerType: Track['type']): string {
  let n = timeline.tracks.length + 1;
  let id = `layer_${layerType}_${n}`;
  while (timeline.tracks.some((t) => t.id === id)) {
    n += 1;
    id = `layer_${layerType}_${n}`;
  }
  return id;
}

/**
 * Insert a new (empty) layer at `atIndex` (default 0 = visual front). The
 * `layerType` is the layer's advisory role only; any clip kind may live on it.
 */
export function addLayerPatch(
  timeline: Timeline,
  layerType: Track['type'] = 'video',
  atIndex = 0,
): Patch {
  const layerId = nextLayerId(timeline, layerType);
  return {
    patchId: patchId(`addlayer_${layerId}_${atIndex}`),
    createdBy: 'user',
    reason: `Add ${layerType} layer at index ${atIndex}`,
    operations: [{ type: 'add_layer', layerId, layerType, atIndex }],
  };
}

/** Remove a layer (and its clips, reversibly). Returns `null` when it is missing. */
export function removeLayerPatch(timeline: Timeline, layerId: string): Patch | null {
  if (!timeline.tracks.some((t) => t.id === layerId)) {
    return null;
  }
  return {
    patchId: patchId(`rmlayer_${layerId}`),
    createdBy: 'user',
    reason: `Remove layer ${layerId}`,
    operations: [{ type: 'remove_layer', layerId }],
  };
}

/**
 * Reorder a layer to a new z-order slot (index 0 = visual front). Returns `null`
 * when the layer is missing or the move is a no-op (already at `toIndex`).
 */
export function moveLayerPatch(timeline: Timeline, layerId: string, toIndex: number): Patch | null {
  const from = timeline.tracks.findIndex((t) => t.id === layerId);
  if (from < 0) {
    return null;
  }
  const clamped = Math.max(0, Math.min(timeline.tracks.length - 1, toIndex));
  if (clamped === from) {
    return null;
  }
  return {
    patchId: patchId(`mvlayer_${layerId}_${clamped}`),
    createdBy: 'user',
    reason: `Move layer ${layerId} to index ${clamped}`,
    operations: [{ type: 'move_layer', layerId, toIndex: clamped }],
  };
}

/** Map a {@link ClipKind} to the advisory `track.type` of a layer that hosts it. */
function layerTypeForKind(kind: ClipKind): Track['type'] {
  if (kind === 'audio') return 'audio';
  if (kind === 'caption') return 'caption';
  if (kind === 'text') return 'overlay';
  return 'video'; // video + image are picture layers
}

/** True when no clip on `track` overlaps the half-open span `[start, end)`. */
function hasRoomFor(track: Track, start: number, end: number): boolean {
  return !track.clips.some(
    (c) => c.start < end - MIN_EDIT_SECONDS && c.end > start + MIN_EDIT_SECONDS,
  );
}

/**
 * Auto-layering placement (Phase 2, ADR 0032 — CapCut-style). Place `asset` at
 * `atStart`, choosing the layer the way CapCut does:
 *
 * - If a layer already holds the **same kind** and has **room** at the drop point,
 *   the clip lands there.
 * - Otherwise — a different kind, or an overlap with same-kind clips — a **new layer
 *   is created at index 0 (the visual front)** and the clip is placed on it.
 *
 * Layers are type-agnostic: any kind may live on any layer, so this only decides
 * *where* a drop lands; nothing forbids the user from moving it elsewhere later.
 * Returns `null` when the asset has no usable id.
 *
 * @param timeline - Current timeline.
 * @param assetById - Asset lookup, for deriving existing clips' kinds.
 * @param asset - The media asset being placed.
 * @param atStart - Desired timeline start (seconds); clamped to ≥ 0.
 */
export function placeAssetPatch(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  asset: Asset,
  atStart: number,
): Patch | null {
  const start = atStart < 0 ? 0 : atStart;
  const duration = asset.durationSeconds ?? DEFAULT_CLIP_SECONDS;
  const end = start + duration;
  const kind = assetKind(asset);

  // Prefer the frontmost existing layer of the same kind that has room at the drop.
  const target = timeline.tracks.find(
    (t) => layerKind(t, assetById) === kind && hasRoomFor(t, start, end),
  );
  if (target) {
    return addClipPatch(timeline, target.id, asset, start);
  }

  // No compatible layer → create a new one at the front and seed the clip onto it
  // as a two-op patch (add_layer then add_clip). Both ops invert together on undo.
  const layerType = layerTypeForKind(kind);
  const layerId = nextLayerId(timeline, layerType);
  return {
    patchId: patchId(`place_${asset.id}_${layerId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Place "${asset.id}" on new ${kind} layer at ${start.toFixed(2)}s`,
    operations: [
      { type: 'add_layer', layerId, layerType, atIndex: 0 },
      {
        type: 'add_clip',
        trackId: layerId,
        assetId: asset.id,
        start,
        end,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

/**
 * Does anything already occupy the picture chain over `[start, end)`?
 *
 * Delegates to `@framepilot/editor-core` so the renderer and the Electron main
 * process (which refuses an agent's `add_stock` before spending a download)
 * cannot drift apart on the answer. The map-to-array adapter is here because
 * this file already holds the lookup in map form.
 */
export function picturePlacementConflict(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  start: number,
  end: number,
): boolean {
  return corePicturePlacementConflict(timeline, [...assetById.values()], start, end);
}

/**
 * Add a fetched stock photo/video to the bin AND place it, as **one** patch —
 * or refuse, when placing it would make the preview disagree with the export.
 *
 * ## Why this can return `null`, and why that is the feature
 *
 * The preview is a single-picture-layer engine and the export is not, so a stock
 * clip laid over existing footage would show one thing on screen and render
 * another — the divergence documented as blocker #1 in
 * `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2, which `SUC-P1` exists to
 * close.
 *
 * {@link placeAssetPatch} resolves that case by creating a new front layer, and
 * that is right for a file the user dragged in themselves: they chose to stack,
 * and they can see what they did. It is wrong for a one-click **Add** in a search
 * panel, where the user asked for "put this here" and has no reason to suspect
 * the result is unpreviewable.
 *
 * Note what this does **not** refuse: placing into empty time. A clip that
 * overlaps nothing composites identically either way, so a fresh layer is
 * created exactly as `placeAssetPatch` would — otherwise the first photo added
 * to an empty timeline would be rejected for conflicting with nothing.
 *
 * One patch, not two, because the user did one thing: its inverse removes the
 * clip and the asset together, so a single undo leaves the project exactly as it
 * was. The file stays on disk — non-destructive invariant 1 — and can be
 * re-placed from the bin.
 *
 * @param timeline - Current timeline.
 * @param assetById - Asset lookup, for deriving existing clips' kinds.
 * @param asset - The downloaded stock asset.
 * @param atStart - Desired timeline start (seconds); clamped to >= 0.
 * @returns One patch, or `null` when the span is already occupied by picture media.
 */
export function addStockClipPatch(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  asset: Asset,
  atStart: number,
): Patch | null {
  const start = atStart < 0 ? 0 : atStart;
  // A photo has no duration of its own, so it takes the same default length a
  // dragged-in still gets. The user trims it afterwards; there is no separate
  // "still duration" setting to keep in sync.
  const duration = asset.durationSeconds ?? DEFAULT_CLIP_SECONDS;
  const end = start + duration;

  if (picturePlacementConflict(timeline, assetById, start, end)) return null;

  const kind = assetKind(asset);
  const target = timeline.tracks.find(
    (t) => layerKind(t, assetById) === kind && hasRoomFor(t, start, end),
  );

  if (target) {
    return {
      patchId: patchId(`addstock_${asset.id}_${target.id}_${ms(start)}`),
      createdBy: 'user',
      reason: `Add stock ${kind} "${asset.id}" at ${start.toFixed(2)}s`,
      operations: [
        { type: 'add_asset', asset },
        {
          type: 'add_clip',
          trackId: target.id,
          assetId: asset.id,
          // Deterministic, so an agent-placed clip and a hand-placed one are
          // indistinguishable — including to a later op that names the clip.
          clipId: `${target.id}_${asset.id}_clip`,
          start,
          end,
          sourceStart: 0,
          sourceEnd: duration,
        },
      ],
    };
  }

  const layerType = layerTypeForKind(kind);
  const layerId = nextLayerId(timeline, layerType);
  return {
    patchId: patchId(`addstock_${asset.id}_${layerId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Add stock ${kind} "${asset.id}" on a new layer at ${start.toFixed(2)}s`,
    operations: [
      { type: 'add_asset', asset },
      { type: 'add_layer', layerId, layerType, atIndex: 0 },
      {
        type: 'add_clip',
        trackId: layerId,
        assetId: asset.id,
        clipId: `${layerId}_clip`,
        start,
        end,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

/**
 * Why {@link addStockClipPatch} would refuse, in a form the UI can render.
 *
 * Split out so the panel can disable **Add** with a reason *before* the user
 * clicks, rather than letting them click and then explaining. Shares the
 * predicate with the builder, so the two cannot disagree.
 */
export function stockPlacementBlockedReason(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  atStart: number,
  durationSeconds: number,
): string | null {
  const start = atStart < 0 ? 0 : atStart;
  if (!picturePlacementConflict(timeline, assetById, start, start + durationSeconds)) return null;
  return "There's already footage at the playhead — move the playhead, or make a gap.";
}

// ---------------------------------------------------------------------------
// Media-bin (project-scoped) builders — assets & folders (schema v3, ADR 0026)
//
// These produce patches whose operations mutate the project's asset/folder bin
// rather than the timeline. They flow through the same validate→apply→record
// pipeline (the store applies them at project scope), so foldering is undoable.
// ---------------------------------------------------------------------------

/** Add a media asset to the bin (e.g. an imported file). */
export function addAssetPatch(asset: Asset): Patch {
  return {
    patchId: patchId(`addasset_${asset.id}${asset.folderId ? `_${asset.folderId}` : ''}`),
    createdBy: 'user',
    reason: `Add asset "${asset.id}"`,
    operations: [{ type: 'add_asset', asset }],
  };
}

/**
 * Add a fetched music track to the bin AND place it on a `music`-role layer, as
 * **one** patch.
 *
 * One patch, not three, because the user did one thing. Its inverse removes the
 * clip, the layer and the asset together, so a single undo leaves the project
 * exactly as it was — rather than the three-press cleanup a three-patch version
 * would demand, with two intermediate states that make no sense on their own
 * (an asset in the bin whose clip is gone; a layer with nothing on it).
 *
 * The file itself stays on disk. That is non-destructive invariant 1: undoing a
 * placement is not a reason to delete bytes the user paid a request for, and
 * the asset can be re-placed from the bin.
 *
 * The layer is labelled `role: 'music'` at creation so `adjust_audio`'s
 * `duckUnderTrackId` and the role-based ducking controller can see the bed. The
 * role is only ever set here because this caller *knows* — it is never inferred
 * from a track name (ADR 0112).
 *
 * Reuses `add_asset` + `add_layer` + `add_clip`. No new timeline operation:
 * those three already express "music bed on its own track" completely.
 */
export function addMusicTrackPatch(timeline: Timeline, asset: Asset, atStart = 0): Patch {
  const start = atStart < 0 ? 0 : atStart;
  const duration = asset.durationSeconds ?? DEFAULT_CLIP_SECONDS;
  const layerId = nextLayerId(timeline, 'audio');
  return {
    patchId: patchId(`addmusic_${asset.id}_${layerId}_${ms(start)}`),
    createdBy: 'user',
    reason: `Add music "${asset.id}" on a new music layer at ${start.toFixed(2)}s`,
    operations: [
      { type: 'add_asset', asset },
      { type: 'add_layer', layerId, layerType: 'audio', atIndex: 0, role: 'music' },
      {
        type: 'add_clip',
        trackId: layerId,
        assetId: asset.id,
        // Same deterministic id the agent path uses (`music-placement.ts`), so an
        // agent-placed bed and a hand-placed one stay indistinguishable — including
        // by a later adjust_audio that names the clip.
        clipId: `${layerId}_clip`,
        start,
        end: start + duration,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

/** Remove a media asset from the bin (clips referencing it must be gone first). */
export function removeAssetPatch(assetId: string): Patch {
  return {
    patchId: patchId(`rmassetbin_${assetId}`),
    createdBy: 'user',
    reason: `Remove asset "${assetId}" from bin`,
    operations: [{ type: 'remove_asset', assetId }],
  };
}

/** Create a media-bin folder (optionally nested under `parentId`). */
export function createFolderPatch(
  folderId: string,
  name: string,
  parentId: string | null = null,
): Patch {
  return {
    patchId: patchId(`mkfolder_${folderId}`),
    createdBy: 'user',
    reason: `Create folder "${name}"`,
    operations: [{ type: 'create_folder', folderId, name, parentId }],
  };
}

/** Rename a media-bin folder. */
export function renameFolderPatch(folderId: string, name: string): Patch {
  return {
    patchId: patchId(`renfolder_${folderId}_${ms(name.length)}`),
    createdBy: 'user',
    reason: `Rename folder to "${name}"`,
    operations: [{ type: 'rename_folder', folderId, name }],
  };
}

/** Move a folder under a new parent (`null` = top level). Cycles are rejected by the validator. */
export function moveFolderPatch(folderId: string, parentId: string | null): Patch {
  return {
    patchId: patchId(`mvfolder_${folderId}_${parentId ?? 'root'}`),
    createdBy: 'user',
    reason: `Move folder "${folderId}"`,
    operations: [{ type: 'move_folder', folderId, parentId }],
  };
}

/** Delete a folder; its children and assets re-parent to its parent. */
export function deleteFolderPatch(folderId: string): Patch {
  return {
    patchId: patchId(`delfolder_${folderId}`),
    createdBy: 'user',
    reason: `Delete folder "${folderId}"`,
    operations: [{ type: 'delete_folder', folderId }],
  };
}

/** Move an asset into a folder (`null` = bin root). */
export function moveAssetToFolderPatch(assetId: string, folderId: string | null): Patch {
  return {
    patchId: patchId(`mvasset_${assetId}_${folderId ?? 'root'}`),
    createdBy: 'user',
    reason: `Move asset "${assetId}"`,
    operations: [{ type: 'move_asset', assetId, folderId }],
  };
}

/** Replace the project transcript through one reversible project-scoped patch. */
export function setTranscriptPatch(assetId: string, words: readonly TranscriptWord[]): Patch {
  const content = JSON.stringify(words);
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return {
    patchId: patchId(`transcript_${assetId}_${(hash >>> 0).toString(16)}`),
    createdBy: 'user',
    reason: `Transcribe asset "${assetId}"`,
    operations: [{ type: 'set_transcript', words: [...words] }],
  };
}

/**
 * Add a text overlay spanning `[start, end]` on an overlay track. Returns `null`
 * when the track is missing, the text is blank, or the span is non-positive.
 */
export function addTextOverlayPatch(
  timeline: Timeline,
  trackId: string,
  text: string,
  start: number,
  end: number,
): Patch | null {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track || text.trim() === '' || end - start <= MIN_EDIT_SECONDS) {
    return null;
  }
  return {
    patchId: patchId(`overlay_${trackId}_${ms(start)}_${ms(end)}`),
    createdBy: 'user',
    reason: `Add text overlay "${text}" at ${start.toFixed(2)}s`,
    operations: [{ type: 'add_text_overlay', trackId, text, start, end }],
  };
}

// --- Text overlay styling (#5) ---------------------------------------------

/** In/out animation kinds a text overlay can use (preview-time; render TBD). */
export const TEXT_ANIMATIONS = ['none', 'fade', 'slide-up', 'slide-down', 'pop'] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

/** Horizontal alignment of a text overlay's content. */
export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const;
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];

/**
 * The styling params a text overlay carries in its `text` effect's open param bag
 * (no schema migration — {@link EffectSchema} params is an open record). Positions
 * and sizes are stored resolution-independently (percent of frame) so they hold
 * across orientation changes. `fontSizePercent` is a fraction of frame HEIGHT;
 * `boxWidthPercent`/`xPercent`/`yPercent` are fractions of the respective axis.
 */
export interface TextOverlayParams {
  readonly text: string;
  readonly color: string;
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fontSizePercent: number;
  readonly align: TextAlignment;
  /** Text-box width as a % of frame width; the text wraps within it. */
  readonly boxWidthPercent: number;
  /** Box centre as a % of each axis (0–100), origin top-left. */
  readonly xPercent: number;
  readonly yPercent: number;
  readonly background: string | null;
  readonly inAnimation: TextAnimation;
  readonly outAnimation: TextAnimation;
  readonly animDurationSeconds: number;
}

/** Defaults applied to a freshly created text overlay (a legible centred caption). */
export const DEFAULT_TEXT_PARAMS: TextOverlayParams = {
  text: 'Text',
  color: '#ffffff',
  fontFamily: 'Inter',
  fontWeight: 700,
  fontSizePercent: 8,
  align: 'center',
  boxWidthPercent: 80,
  xPercent: 50,
  yPercent: 50,
  background: null,
  inAnimation: 'none',
  outAnimation: 'none',
  animDurationSeconds: 0.4,
};

/** The `text`-type effect on a clip (a text overlay carries exactly one), or undefined. */
export function textEffectOf(clip: {
  effects: readonly { id: string; type: string; params: Record<string, unknown> }[];
}): { id: string; params: Record<string, unknown> } | undefined {
  return clip.effects.find((e) => e.type === 'text');
}

/** Read a text overlay clip's styling params, falling back to the defaults. */
export function readTextParams(clip: {
  effects: readonly { id: string; type: string; params: Record<string, unknown> }[];
}): TextOverlayParams {
  const effect = textEffectOf(clip);
  const p = effect?.params ?? {};
  const num = (key: keyof TextOverlayParams, fallback: number): number =>
    typeof p[key] === 'number' && Number.isFinite(p[key]) ? (p[key] as number) : fallback;
  const str = <T extends string>(key: keyof TextOverlayParams, fallback: T): T =>
    typeof p[key] === 'string' ? (p[key] as T) : fallback;
  return {
    text: str('text', DEFAULT_TEXT_PARAMS.text),
    color: str('color', DEFAULT_TEXT_PARAMS.color),
    fontFamily: str('fontFamily', DEFAULT_TEXT_PARAMS.fontFamily),
    fontWeight: num('fontWeight', DEFAULT_TEXT_PARAMS.fontWeight),
    fontSizePercent: num('fontSizePercent', DEFAULT_TEXT_PARAMS.fontSizePercent),
    align: str('align', DEFAULT_TEXT_PARAMS.align),
    boxWidthPercent: num('boxWidthPercent', DEFAULT_TEXT_PARAMS.boxWidthPercent),
    xPercent: num('xPercent', DEFAULT_TEXT_PARAMS.xPercent),
    yPercent: num('yPercent', DEFAULT_TEXT_PARAMS.yPercent),
    background: typeof p.background === 'string' ? (p.background as string) : null,
    inAnimation: str('inAnimation', DEFAULT_TEXT_PARAMS.inAnimation),
    outAnimation: str('outAnimation', DEFAULT_TEXT_PARAMS.outAnimation),
    animDurationSeconds: num('animDurationSeconds', DEFAULT_TEXT_PARAMS.animDurationSeconds),
  };
}

/** A text/caption overlay clip flattened for compositing: its timeline span
 * plus the resolved styling params (`params.text` already carries the display
 * text — the styled `text` param, falling back to the first non-empty
 * text/caption effect). Consumed by both the DOM `PreviewPlayer` overlay layer
 * and the WebCodecs canvas overlay painter (P3b). */
export interface OverlayClip {
  /** Timeline identity retained for preview hit-testing and selection chrome. */
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly params: TextOverlayParams;
}

/**
 * Every visible text/caption overlay on the timeline, in track order (pure).
 * Mirrors the DOM `PreviewPlayer`'s overlay resolution exactly so the canvas
 * compositor draws the same overlays: hidden tracks excluded, empty-text
 * overlays dropped, `params.text` resolved to the styled text or the first
 * non-empty text/caption effect.
 */
export function overlayClips(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): readonly OverlayClip[] {
  const result: OverlayClip[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const kind = clipKind(clip, assetById);
      if (!isOverlayKind(kind)) continue;
      // Caption clips render via the DOM `CaptionOverlay` (template-based
      // captions, schema v10), never the canvas text-overlay compositor.
      if (kind === 'caption') continue;
      const params = readTextParams(clip);
      const fallback =
        clip.effects
          .filter((e) => e.type === 'text' || e.type === 'caption')
          .map((e) => String((e.params as { text?: unknown }).text ?? ''))
          .find((t) => t.length > 0) ?? '';
      const text = params.text || fallback;
      if (text.length === 0) continue;
      result.push({ id: clip.id, start: clip.start, end: clip.end, params: { ...params, text } });
    }
  }
  return result;
}

/**
 * Merge styling params into a text overlay clip's `text` effect as one reversible
 * `set_effect_params` edit. Returns `null` when the clip is missing or is not a
 * text overlay (no `text` effect).
 */
export function setTextParamsPatch(
  timeline: Timeline,
  clipId: string,
  params: Partial<TextOverlayParams>,
): Patch | null {
  const loc = findClip(timeline, clipId);
  if (!loc) return null;
  const effect = textEffectOf(loc.clip);
  if (!effect) return null;
  return {
    patchId: patchId(`textparams_${clipId}_${Object.keys(params).sort().join('-')}`),
    createdBy: 'user',
    reason: `Edit text overlay ${clipId}`,
    operations: [{ type: 'set_effect_params', clipId, effectId: effect.id, params: { ...params } }],
  };
}

/**
 * Attach a color grade (a `color_grade` effect) to a clip. Returns `null` when
 * the clip is missing.
 */
export function applyColorGradePatch(
  timeline: Timeline,
  clipId: string,
  params: Record<string, number>,
  label = 'color grade',
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const paramKey = Object.entries(params)
    .map(([k, v]) => `${k}${Math.round(v * 100)}`)
    .join('_');
  return {
    patchId: patchId(`grade_${clipId}_${paramKey}`),
    createdBy: 'user',
    reason: `Apply ${label} to "${clipId}"`,
    operations: [
      {
        type: 'apply_color_grade',
        clipId,
        effect: { id: `${clipId}__grade`, type: 'color_grade', params, keyframes: [] },
      },
    ],
  };
}

/**
 * Set a clip's full color grade from the inspector. Unlike a one-click preset
 * (which patches partial params), this writes every axis under a stable effect
 * id so the grade updates in place rather than stacking — the engine's
 * `apply_color_grade` replaces an effect with the same id. Returns `null` when
 * the clip is missing.
 */
export function setColorGradePatch(
  timeline: Timeline,
  clipId: string,
  params: Record<string, number>,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const paramKey = Object.entries(params)
    .map(([k, v]) => `${k}${Math.round(v * 100)}`)
    .join('_');
  return {
    patchId: patchId(`gradeset_${clipId}_${paramKey}`),
    createdBy: 'user',
    reason: `Set color grade on "${clipId}"`,
    operations: [
      {
        type: 'apply_color_grade',
        clipId,
        effect: { id: `${clipId}__grade`, type: 'color_grade', params, keyframes: [] },
      },
    ],
  };
}

/**
 * Add a transition between a clip and the next clip on the same track. Returns
 * `null` when the clip is missing or there is no following clip to transition
 * into.
 */
export function addTransitionPatch(
  timeline: Timeline,
  clipId: string,
  kind: TransitionKind,
  durationSeconds = DEFAULT_TRANSITION_SECONDS,
  options?: TransitionOptions,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) {
    return null;
  }
  const { track, clip } = found;
  const next = track.clips
    .filter((c) => c.id !== clip.id && c.start >= clip.end - MIN_EDIT_SECONDS)
    .sort((a, b) => a.start - b.start)[0];
  if (!next) {
    return null;
  }
  return {
    patchId: patchId(`transition_${clipId}_${next.id}_${kind}`),
    createdBy: 'user',
    reason: `Add ${kind} transition from "${clip.id}" to "${next.id}"`,
    operations: addTransitionOps(track.id, clip.id, next.id, kind, durationSeconds, options),
  };
}

/**
 * Add `kind` to a CHOSEN set of cuts, in one patch (bulk apply).
 *
 * Each cut is named by its incoming clip, which is where the transition lives and
 * how every other transition builder identifies one. Cuts that cannot take the
 * transition are dropped rather than failing the whole patch: a multi-select that
 * happens to include one two-frame clip should apply everywhere else, not refuse
 * outright and leave the user to find the offender.
 *
 * `replaceExisting` is the caller's decision because both answers are reasonable
 * and neither is safe to assume — overwriting a hand-tuned dissolve is exactly as
 * annoying as silently skipping the cut the user was looking at.
 *
 * @returns One patch (so the sweep is one undo press), or `null` when no cut
 *   qualifies — plus the ids that were skipped, so the caller can say so.
 */
export function applyTransitionToCutsPatch(
  timeline: Timeline,
  toClipIds: readonly string[],
  kind: TransitionKind,
  durationSeconds = DEFAULT_TRANSITION_SECONDS,
  options?: TransitionOptions & { readonly replaceExisting?: boolean },
): { readonly patch: Patch | null; readonly skipped: readonly string[] } {
  const operations: Operation[] = [];
  const skipped: string[] = [];
  for (const toClipId of toClipIds) {
    const found = findClip(timeline, toClipId);
    if (!found) {
      skipped.push(toClipId);
      continue;
    }
    const { track, clip } = found;
    if (options?.replaceExisting !== true && clip.effects.some((e) => e.type === 'transition')) {
      skipped.push(toClipId);
      continue;
    }
    // The outgoing clip is whichever ends where this one begins — the same rule
    // `timelineTransitions` uses to read a cut back.
    const previous = track.clips
      .filter((c) => c.id !== clip.id && c.end <= clip.start + MIN_EDIT_SECONDS)
      .sort((a, b) => b.end - a.end)[0];
    if (!previous) {
      skipped.push(toClipId);
      continue;
    }
    const eligibility = transitionEligibility(timeline, {
      fromClipId: previous.id,
      toClipId: clip.id,
      durationSeconds,
      kind,
    });
    if (!eligibility.ok) {
      skipped.push(toClipId);
      continue;
    }
    operations.push(
      ...addTransitionOps(
        track.id,
        previous.id,
        clip.id,
        kind,
        // The engine clamps a too-long transition to what the cut can carry, and
        // the eligibility check already computed that number. Using it means the
        // patch asks for exactly what will happen.
        eligibility.durationSeconds,
        options,
      ),
    );
  }
  if (operations.length === 0) return { patch: null, skipped };
  const cuts = toClipIds.length - skipped.length;
  return {
    patch: {
      patchId: patchId(`transition_cuts_${kind}_${cuts}`),
      createdBy: 'user',
      reason: `Add ${kind} to ${cuts} cut${cuts === 1 ? '' : 's'}`,
      operations,
    },
    skipped,
  };
}

/**
 * How the sound is treated across a cut that carries a transition.
 *
 * `none` is the default, and it is the honest one: most cuts in an edit are
 * hard-cut audio, and silently crossfading every one of them would change the
 * sound of every project made before this existed.
 */
export type TransitionAudioMode = 'none' | 'crossfade' | 'fade-out-in' | 'equal-power';

/** The audio fade curve each mode uses, as the engine's `fadeCurve` param. */
const AUDIO_CURVE: Readonly<Record<TransitionAudioMode, string>> = {
  none: 'linear',
  crossfade: 'linear',
  'fade-out-in': 'smooth',
  'equal-power': 'equal-power',
};

/**
 * Pair a transition with an audio treatment across the same cut.
 *
 * Written as ordinary `adjust_audio` fades on the two clips rather than as a new
 * kind of thing, because that is what an audio transition IS — a fade out on the
 * outgoing clip and a fade in on the incoming one — and the render engine already
 * knows how to do it. The MODE is also stored on the transition so the inspector
 * can show what was chosen and so "match the video duration" has something to
 * match against.
 *
 * `fade-out-in` is not the same as `crossfade` even though both write two fades:
 * on butt-joined clips the sound genuinely does dip between them, and the smooth
 * curve is what stops that dip sounding like a fault. `equal-power` holds the
 * summed power constant, which is the one that matters for music.
 *
 * @param seconds - Fade length. Absent means the video transition's own duration,
 *   which is what "match video" means.
 */
export function setTransitionAudioPatch(
  timeline: Timeline,
  toClipId: string,
  mode: TransitionAudioMode,
  seconds?: number,
): Patch | null {
  const found = findTransition(timeline, toClipId);
  if (!found) return null;
  const length = Math.max(0, seconds ?? found.durationSeconds);
  const incoming = findClip(timeline, toClipId);
  const outgoing = findClip(timeline, found.fromClipId);
  if (!incoming || !outgoing) return null;

  const gainParams = (clipId: string): Record<string, unknown> => {
    const clip = clipId === toClipId ? incoming.clip : outgoing.clip;
    return { ...(clip.effects.find((e) => e.type === 'audio_gain')?.params ?? {}) };
  };
  const gainDb = (params: Record<string, unknown>): number => {
    const raw = Number(params.gainDb);
    return Number.isFinite(raw) ? raw : 0;
  };
  const outParams = gainParams(found.fromClipId);
  const inParams = gainParams(toClipId);
  const off = mode === 'none';

  return {
    patchId: patchId(`transition_audio_${toClipId}_${mode}`),
    createdBy: 'user',
    reason:
      mode === 'none'
        ? `Remove the audio transition at the cut entering "${toClipId}"`
        : `Set a ${mode} audio transition at the cut entering "${toClipId}"`,
    operations: [
      {
        type: 'adjust_audio',
        clipId: found.fromClipId,
        gainDb: gainDb(outParams),
        fadeOutSeconds: off ? 0 : length,
        // The incoming edge of the OUTGOING clip is none of this action's
        // business, so whatever was there is carried through untouched.
        fadeInSeconds: Number(outParams.fadeInSeconds ?? 0) || 0,
        fadeCurve: AUDIO_CURVE[mode],
      },
      {
        type: 'adjust_audio',
        clipId: toClipId,
        gainDb: gainDb(inParams),
        fadeInSeconds: off ? 0 : length,
        fadeOutSeconds: Number(inParams.fadeOutSeconds ?? 0) || 0,
        fadeCurve: AUDIO_CURVE[mode],
      },
      {
        type: 'set_effect_params',
        clipId: toClipId,
        effectId: found.effectId,
        params: {
          audio: off ? undefined : mode,
          // Only stored when it differs from the video length, so "match video"
          // stays the absence of a value rather than a copy that goes stale the
          // moment the transition is resized.
          audioSeconds: off || Math.abs(length - found.durationSeconds) < 1e-6 ? undefined : length,
        },
      },
    ],
  };
}

/**
 * Hold a transition off — or put it back — without removing it.
 *
 * The "compare with and without" gesture, and the timeline's disabled state. It is
 * NOT a removal: the kind, the duration and every tuned parameter stay exactly
 * where they are, so turning it back on is not a decision anyone has to make
 * again. It is also one undo step, so a comparison does not litter the history.
 *
 * Both halves are written, because a centred transition whose incoming half was
 * held off and whose outgoing half was not would fade the old shot away into
 * nothing.
 */
export function setTransitionDisabledPatch(
  timeline: Timeline,
  toClipId: string,
  disabled: boolean,
): Patch | null {
  const found = findTransition(timeline, toClipId);
  if (!found) return null;
  const operations: Operation[] = [
    {
      type: 'set_effect_params',
      clipId: toClipId,
      effectId: found.effectId,
      params: { disabled: disabled ? true : undefined },
    },
  ];
  const outgoing = findClip(timeline, found.fromClipId);
  const outEffect = outgoing?.clip.effects.find((e) => e.type === TRANSITION_OUT_EFFECT_TYPE);
  if (outEffect) {
    operations.push({
      type: 'set_effect_params',
      clipId: found.fromClipId,
      effectId: outEffect.id,
      params: { disabled: disabled ? true : undefined },
    });
  }
  return {
    patchId: patchId(`transition_disabled_${toClipId}_${String(disabled)}`),
    createdBy: 'user',
    reason: `${disabled ? 'Hold off' : 'Restore'} the ${found.kind} transition entering "${toClipId}"`,
    operations,
  };
}

/** True when the transition entering `toClipId` is being held off. */
export function isTransitionDisabled(timeline: Timeline, toClipId: string): boolean {
  return findTransition(timeline, toClipId)?.extras.disabled === true;
}

/** The audio treatment stored on the transition entering `toClipId`. */
export function transitionAudioMode(timeline: Timeline, toClipId: string): TransitionAudioMode {
  const found = findTransition(timeline, toClipId);
  const raw = found?.extras.audio;
  return raw === 'crossfade' || raw === 'fade-out-in' || raw === 'equal-power' ? raw : 'none';
}

/**
 * Move the transition entering `toClipId` to a different alignment.
 *
 * Re-issues `add_transition`, which is what writes and clears the outgoing half —
 * a `set_effect_params` would change the stored word without moving the ramp, and
 * the two halves would disagree about where the transition is.
 */
export function setTransitionAlignmentPatch(
  timeline: Timeline,
  toClipId: string,
  alignment: TransitionAlignment,
): Patch | null {
  const found = findTransition(timeline, toClipId);
  if (!found) return null;
  return {
    patchId: patchId(`transition_align_${toClipId}_${alignment}`),
    createdBy: 'user',
    reason: `Align the ${found.kind} transition entering "${toClipId}" to the ${alignment} of the cut`,
    operations: [
      {
        type: 'add_transition',
        trackId: found.track.id,
        fromClipId: found.fromClipId,
        toClipId,
        kind: found.kind,
        durationSeconds: found.durationSeconds,
        ...(alignment === 'start' ? {} : { alignment }),
      },
    ],
  };
}

/**
 * Add `kind` to **every abutting cut in the project** that can take one, in one patch
 * (revamp Phase 8).
 *
 * "Compatible" is decided by the engine's own `transitionEligibility`, not by a
 * second opinion invented here — that function already knows about gaps, different
 * tracks, non-media clips and clips too short to hold the duration, and it is the
 * same check the validator will apply. Asking it means the button cannot offer a cut
 * the patch would then be rejected for.
 *
 * Cuts that already carry a transition are **skipped, not overwritten**: "add
 * transitions everywhere" should not silently replace the dissolve the user hand-tuned
 * on one cut. Replacing is a per-cut action.
 *
 * One patch, so the whole sweep is one undo press. Returns `null` when no cut
 * qualifies.
 */
export function addTransitionToAllCutsPatch(
  timeline: Timeline,
  kind: TransitionKind,
  durationSeconds = DEFAULT_TRANSITION_SECONDS,
): Patch | null {
  const operations: Operation[] = [];
  for (const track of timeline.tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const from = ordered[i]!;
      const to = ordered[i + 1]!;
      if (to.effects.some((effect) => effect.type === 'transition')) continue;
      const eligibility = transitionEligibility(timeline, {
        fromClipId: from.id,
        toClipId: to.id,
        durationSeconds,
        kind,
      });
      if (!eligibility.ok) continue;
      operations.push({
        type: 'add_transition',
        trackId: track.id,
        fromClipId: from.id,
        toClipId: to.id,
        kind,
        durationSeconds,
      });
    }
  }
  if (operations.length === 0) return null;
  return {
    patchId: patchId(`transition_all_${kind}_${operations.length}`),
    createdBy: 'user',
    reason: `Add ${kind} to ${operations.length} cut${operations.length === 1 ? '' : 's'}`,
    operations,
  };
}

/**
 * Locate the transition entering `toClipId`: the clip, its track, the effect, and
 * its referenced `fromClipId`. Returns `null` when the clip or transition effect
 * is missing — the on-cut pill operations (resize / swap / remove) are all no-ops
 * without an existing transition to act on.
 */
function findTransition(
  timeline: Timeline,
  toClipId: string,
): {
  track: Track;
  effectId: string;
  fromClipId: string;
  kind: TransitionKind;
  durationSeconds: number;
  /** Params beyond the three `add_transition` rebuilds — see {@link extraTransitionParams}. */
  extras: Record<string, unknown>;
} | null {
  const found = findClip(timeline, toClipId);
  if (!found) return null;
  const effect = found.clip.effects.find((e) => e.type === 'transition');
  const fromClipId = effect?.params?.fromClipId;
  if (!effect || typeof fromClipId !== 'string') return null;
  return {
    track: found.track,
    effectId: effect.id,
    fromClipId,
    kind: (effect.params?.kind as TransitionKind) ?? 'cross-dissolve',
    durationSeconds: Number(effect.params?.durationSeconds ?? DEFAULT_TRANSITION_SECONDS),
    extras: extraTransitionParams(effect.params ?? {}),
  };
}

/**
 * The three params `add_transition` writes. Everything else on a transition effect
 * is a revamp Phase 9 parameter riding the free-form `Effect.params` (§4.3).
 */
const REBUILT_TRANSITION_PARAMS = new Set(['kind', 'durationSeconds', 'fromClipId']);

/**
 * The params `add_transition` would **lose**.
 *
 * `applyAddTransition` builds `params` from scratch — `{ kind, durationSeconds,
 * fromClipId }` — and replaces the effect by id. That is correct for the op (it is
 * the *definition* of a transition) but it means any builder that routes a change
 * through `add_transition` silently discards the direction, intensity, softness and
 * easing the user tuned. A resize is not a request to reset the look, so the
 * builders below carry these across in the same patch.
 */
function extraTransitionParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!REBUILT_TRANSITION_PARAMS.has(key)) extras[key] = value;
  }
  return extras;
}

/**
 * Set the look parameters of the transition entering `toClipId` — direction,
 * intensity, softness, easing (revamp Phase 9, §4.3).
 *
 * These ride the free-form `Effect.params`, so there is **no schema change and no
 * migration**, and `set_effect_params` already shallow-merges (a key set to
 * `undefined` clears it), which is exactly the reset semantics the inspector needs:
 * removing a param restores the render's default rather than storing a value that
 * happens to equal it.
 *
 * The op is not `add_transition`, deliberately: that op rebuilds the whole params
 * bag and would drop every other parameter on the way past.
 *
 * @returns `null` when the clip carries no transition.
 */
export function setTransitionParamsPatch(
  timeline: Timeline,
  toClipId: string,
  params: Readonly<Record<string, unknown>>,
): Patch | null {
  const t = findTransition(timeline, toClipId);
  if (!t) return null;
  const names = Object.keys(params);
  if (names.length === 0) return null;
  return {
    patchId: patchId(`transition_params_${toClipId}_${names.join('_')}`),
    createdBy: 'user',
    reason: `Set ${names.join(', ')} on the ${t.kind} transition entering "${toClipId}"`,
    operations: [{ type: 'set_effect_params', clipId: toClipId, effectId: t.effectId, params }],
  };
}

/**
 * Copy the transition entering `sourceToClipId` — kind, duration **and** every look
 * parameter — onto every cut entering one of `targetToClipIds` (revamp Phase 9).
 *
 * "Apply to selected cuts" is the answer to the most common transition complaint:
 * you tune one dissolve for a minute and then have eleven more to match by hand.
 * Targets are asked of `transitionEligibility` first, so a selection containing a
 * clip that cannot take this duration produces a smaller patch rather than a
 * rejected one — the alternative is an action that fails wholesale because of one
 * clip the user may not even remember selecting.
 *
 * One patch, so the whole sweep is one undo press. The source is skipped (it already
 * has these settings) and `null` comes back when nothing is left to change.
 */
export function applyTransitionToClipsPatch(
  timeline: Timeline,
  sourceToClipId: string,
  targetToClipIds: readonly string[],
): Patch | null {
  const source = findTransition(timeline, sourceToClipId);
  if (!source) return null;
  const operations: Operation[] = [];
  for (const toClipId of targetToClipIds) {
    if (toClipId === sourceToClipId) continue;
    const found = findClip(timeline, toClipId);
    if (!found) continue;
    // The incoming clip identifies the cut; the outgoing one is whichever clip ends
    // where it starts. Derived rather than taken from the selection, because a user
    // selects clips, not cuts.
    const from = found.track.clips.find(
      (c) => c.id !== toClipId && Math.abs(c.start + (c.end - c.start) - found.clip.start) <= 1e-6,
    );
    if (!from) continue;
    const eligibility = transitionEligibility(timeline, {
      fromClipId: from.id,
      toClipId,
      durationSeconds: source.durationSeconds,
      kind: source.kind,
    });
    if (!eligibility.ok) continue;
    operations.push({
      type: 'add_transition',
      trackId: found.track.id,
      fromClipId: from.id,
      toClipId,
      kind: source.kind,
      durationSeconds: source.durationSeconds,
    });
    if (Object.keys(source.extras).length > 0) {
      operations.push({
        type: 'set_effect_params',
        clipId: toClipId,
        effectId: `${toClipId}__transition`,
        params: source.extras,
      });
    }
  }
  if (operations.length === 0) return null;
  const cuts = operations.filter((op) => op.type === 'add_transition').length;
  return {
    patchId: patchId(`transition_apply_${sourceToClipId}_${cuts}`),
    createdBy: 'user',
    reason: `Apply the ${source.kind} transition to ${cuts} selected cut${cuts === 1 ? '' : 's'}`,
    operations,
  };
}

/**
 * Clear every Phase 9 look parameter, returning the transition to the render's
 * defaults (`null` when there is nothing to reset).
 *
 * Clearing rather than writing the default values is what makes "reset" mean the
 * same thing as "never touched": a stored `intensity: 1` and an absent one render
 * identically today, but only the absent one keeps rendering identically if a
 * default ever changes.
 */
export function resetTransitionParamsPatch(timeline: Timeline, toClipId: string): Patch | null {
  const t = findTransition(timeline, toClipId);
  if (!t) return null;
  const names = Object.keys(t.extras);
  if (names.length === 0) return null;
  const cleared: Record<string, unknown> = {};
  for (const name of names) cleared[name] = undefined;
  return {
    patchId: patchId(`transition_params_reset_${toClipId}`),
    createdBy: 'user',
    reason: `Reset the ${t.kind} transition entering "${toClipId}" to its defaults`,
    operations: [
      { type: 'set_effect_params', clipId: toClipId, effectId: t.effectId, params: cleared },
    ],
  };
}

/**
 * Re-issue the transition entering `toClipId` with a new duration (the on-cut
 * pill resize). `add_transition` is idempotent-by-id, so this replaces the effect
 * in place rather than stacking; the validator's `transition_overlap` check keeps
 * an over-long duration out. Returns `null` when there is no transition there.
 */
export function setTransitionDurationPatch(
  timeline: Timeline,
  toClipId: string,
  durationSeconds: number,
): Patch | null {
  const t = findTransition(timeline, toClipId);
  if (!t) return null;
  const operations: Operation[] = [
    {
      type: 'add_transition',
      trackId: t.track.id,
      fromClipId: t.fromClipId,
      toClipId,
      kind: t.kind,
      durationSeconds,
    },
  ];
  // `add_transition` rebuilds the params bag, so the look parameters are restored
  // in the SAME patch — a resize is not a request to reset direction and easing,
  // and two patches would make undo show the transition resized but reset.
  if (Object.keys(t.extras).length > 0) {
    operations.push({
      type: 'set_effect_params',
      clipId: toClipId,
      effectId: t.effectId,
      params: t.extras,
    });
  }
  return {
    patchId: patchId(`transition_resize_${toClipId}_${ms(durationSeconds)}`),
    createdBy: 'user',
    reason: `Resize ${t.kind} transition on "${toClipId}" to ${durationSeconds}s`,
    operations,
  };
}

/**
 * Swap the *kind* of the transition entering `toClipId`, preserving its duration
 * and its look parameters (the inspector's kind dropdown). `null` when there is no
 * transition there.
 *
 * This is `set_effect_params`, not `add_transition`. The duration is unchanged, so
 * the eligibility `add_transition` re-checks cannot have become false — and routing
 * through it would rebuild the params bag and discard the direction, intensity,
 * softness and easing the user set. A param the new kind does not use (a zoom's
 * `in` on a push) is simply not read: the envelope resolves an inapplicable
 * direction to the kind's default, so swapping away and back restores the tuning
 * instead of losing it.
 */
export function swapTransitionKindPatch(
  timeline: Timeline,
  toClipId: string,
  kind: TransitionKind,
): Patch | null {
  const t = findTransition(timeline, toClipId);
  if (!t) return null;
  return {
    patchId: patchId(`transition_swap_${toClipId}_${kind}`),
    createdBy: 'user',
    reason: `Swap transition on "${toClipId}" to ${kind}`,
    operations: [
      { type: 'set_effect_params', clipId: toClipId, effectId: t.effectId, params: { kind } },
    ],
  };
}

/**
 * Remove the transition entering `toClipId`. There is no dedicated remove-effect
 * op, so this restores the clip's track with the `transition` effect filtered out
 * via the reversible `restore_clips` primitive (its inverse is a `restore_clips`
 * of the prior state, so one undo brings the transition back). `null` when there
 * is no transition there.
 */
export function removeTransitionPatch(timeline: Timeline, toClipId: string): Patch | null {
  const found = findClip(timeline, toClipId);
  if (!found) return null;
  const transition = found.clip.effects.find((e) => e.type === 'transition');
  if (!transition) return null;
  // A centre- or end-aligned transition also stores its pre-cut half on the
  // OUTGOING clip. Removing only the incoming half would leave that behind, and
  // the outgoing clip would go on ramping out at what is now a hard cut with
  // nothing selectable to explain it (the validator refuses that state outright).
  const fromClipId = transition.params?.fromClipId;
  const clips = found.track.clips.map((c) => {
    if (c.id === toClipId) {
      return { ...c, effects: c.effects.filter((e) => e.type !== 'transition') };
    }
    if (c.id === fromClipId) {
      return { ...c, effects: c.effects.filter((e) => e.type !== TRANSITION_OUT_EFFECT_TYPE) };
    }
    return c;
  });
  return {
    patchId: patchId(`transition_remove_${toClipId}`),
    createdBy: 'user',
    reason: `Remove transition on "${toClipId}"`,
    operations: [{ type: 'restore_clips', trackId: found.track.id, clips }],
  };
}

/**
 * Set (or clear, with `captionStyle: null`) a caption clip's rich, persisted
 * style (schema v5 `Clip.captionStyle`) — font, scale, color, outline,
 * position, keyword-highlight animation, and preset id. The value replaces
 * the clip's style wholesale (mirrors `set_caption_style`'s own semantics),
 * so callers should pass the clip's full desired style, not a partial patch.
 * Returns `null` when the clip is missing.
 */
export function setCaptionStylePatch(
  timeline: Timeline,
  clipId: string,
  captionStyle: CaptionStyle | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const styleKey = captionStyle
    ? Object.entries(captionStyle)
        .map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('_')
    : 'none';
  return {
    patchId: patchId(`captionstyle_${clipId}_${styleKey}`),
    createdBy: 'user',
    reason: captionStyle ? `Style caption "${clipId}"` : `Clear caption style on "${clipId}"`,
    operations: [{ type: 'set_caption_style', clipId, captionStyle }],
  };
}

/**
 * Set (or clear, with `captionStyle: null`) a caption TRACK's style default —
 * the look every cue on it adopts (schema v11, ADR 0071). One operation
 * restyles the whole set; per-clip overrides still win. Returns `null` when the
 * track is missing.
 */
export function setTrackCaptionStylePatch(
  timeline: Timeline,
  trackId: string,
  captionStyle: CaptionStyle | null,
): Patch | null {
  if (!timeline.tracks.some((track) => track.id === trackId)) return null;
  return {
    patchId: patchId(`trackcaptionstyle_${trackId}_${captionStyle?.templateId ?? 'none'}`),
    createdBy: 'user',
    reason: captionStyle
      ? `Style every caption on "${trackId}"`
      : `Clear the caption style on "${trackId}"`,
    operations: [{ type: 'set_track_caption_style', trackId, captionStyle }],
  };
}

/**
 * Floating-point slack for "is the split point strictly inside the cue?".
 * Mirrors `editor-core`'s own split guard, so this builder rejects exactly the
 * splits `split_clip` would throw on rather than producing a doomed patch.
 */
const SPLIT_EPSILON = 1e-6;

/**
 * Re-time a cue's word timings to a new text, positionally.
 *
 * Keeps each surviving word's original beat so karaoke emphasis survives an
 * edit (fixing a typo must not cost the word its timing). Words added beyond
 * the original count are spread evenly across whatever time is left, so a cue
 * the editor lengthened still animates instead of freezing on its last timing.
 */
function retimeCueWords(
  text: string,
  previous: readonly TranscriptWord[],
  range: { readonly start: number; readonly end: number },
): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const surplusStart =
    previous[tokens.length - 1]?.end ?? previous[previous.length - 1]?.end ?? range.start;
  const surplusCount = Math.max(0, tokens.length - previous.length);
  const surplusSpan = Math.max(0, range.end - surplusStart);
  return tokens.map((token, index) => {
    const original = previous[index];
    if (original !== undefined) return { word: token, start: original.start, end: original.end };
    const slot = index - previous.length;
    const width = surplusCount > 0 ? surplusSpan / surplusCount : 0;
    return {
      word: token,
      start: surplusStart + width * slot,
      end: surplusStart + width * (slot + 1),
    };
  });
}

/**
 * Replace a caption cue's text (schema v11, ADR 0071).
 *
 * The cue keeps its clip range; only what it says changes. Word timings are
 * re-aligned positionally by {@link retimeCueWords}, so emphasis survives the
 * edit. A clip that had no cue of its own gets one seeded from the transcript,
 * which is the moment it stops being transcript-derived and becomes authored.
 *
 * Returns `null` when the clip is missing or the text is unchanged — a no-op
 * must not push an empty entry onto the undo stack.
 */
export function setCaptionCuePatch(
  timeline: Timeline,
  clipId: string,
  text: string,
  transcript: readonly TranscriptWord[],
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const { clip } = found;
  const current = resolveCaptionCue(clip, transcript);
  if (current.text === text) return null;
  return {
    patchId: patchId(`captioncue_${clipId}_${text.length}`),
    createdBy: 'user',
    reason: `Edit caption "${clipId}"`,
    operations: [
      {
        type: 'set_caption_cue',
        clipId,
        captionCue: { text, words: retimeCueWords(text, current.words, clip) },
      },
    ],
  };
}

/**
 * Split a caption cue in two at `at` seconds (schema v11, ADR 0071).
 *
 * Both halves keep their own share of the text and timings, so the split is a
 * real caption edit rather than a bare clip cut: `split_clip` alone would leave
 * both halves claiming the whole cue's text. Words are divided by where they
 * are spoken, so each half says what is audible during it.
 *
 * Returns `null` when the clip is missing, `at` is not strictly inside it, or
 * the split would leave a half with no words to show.
 */
export function splitCaptionCuePatch(
  timeline: Timeline,
  clipId: string,
  at: number,
  transcript: readonly TranscriptWord[],
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const { clip } = found;
  if (at <= clip.start + SPLIT_EPSILON || at >= clip.end - SPLIT_EPSILON) return null;

  const cue = resolveCaptionCue(clip, transcript);
  const tokens = cue.lines.flat();
  // A word belongs to the first half when it STARTS before the cut.
  const firstWords = tokens.filter((word) => word.start < at);
  const secondWords = tokens.slice(firstWords.length);
  if (firstWords.length === 0 || secondWords.length === 0) return null;

  const toText = (words: readonly TranscriptWord[]): string =>
    words.map((word) => word.word).join(' ');
  // `split_clip` names the right-hand piece deterministically; ask editor-core
  // for that id rather than re-deriving it, so the follow-up `set_caption_cue`
  // cannot target a stale name if the formula ever changes.
  const secondId = splitClipRightId(clipId, at);
  return {
    patchId: patchId(`captionsplit_${clipId}_${Math.round(at * 1000)}`),
    createdBy: 'user',
    reason: `Split caption "${clipId}"`,
    operations: [
      { type: 'split_clip', clipId, at },
      {
        type: 'set_caption_cue',
        clipId,
        captionCue: { text: toText(firstWords), words: [...firstWords] },
      },
      {
        type: 'set_caption_cue',
        clipId: secondId,
        captionCue: { text: toText(secondWords), words: [...secondWords] },
      },
    ],
  };
}

/**
 * Merge two adjacent caption cues into one (schema v11, ADR 0071).
 *
 * The first cue absorbs the second: it extends to the second's end and its text
 * becomes both, joined. The second clip is removed. Text is joined with a space
 * rather than a line break — a merge is "these are one sentence", and an author
 * who wants two lines can add the break themselves.
 *
 * Returns `null` when either clip is missing or they are not on the same track.
 */
export function mergeCaptionCuesPatch(
  timeline: Timeline,
  firstId: string,
  secondId: string,
  transcript: readonly TranscriptWord[],
): Patch | null {
  const first = findClip(timeline, firstId);
  const second = findClip(timeline, secondId);
  if (!first || !second || first.track.id !== second.track.id) return null;

  const firstCue = resolveCaptionCue(first.clip, transcript);
  const secondCue = resolveCaptionCue(second.clip, transcript);
  const words = [...firstCue.lines.flat(), ...secondCue.lines.flat()];
  const text = [firstCue.text, secondCue.text]
    .map((part) => part.replace(/\n/g, ' ').trim())
    .filter((part) => part.length > 0)
    .join(' ');

  return {
    patchId: patchId(`captionmerge_${firstId}_${secondId}`),
    createdBy: 'user',
    reason: `Merge captions "${firstId}" and "${secondId}"`,
    operations: [
      // Remove the absorbed cue first, so extending the first cue cannot
      // momentarily overlap it (which the validator would reject).
      {
        type: 'delete_range',
        trackId: second.track.id,
        start: second.clip.start,
        end: second.clip.end,
      },
      { type: 'trim_clip', clipId: firstId, start: first.clip.start, end: second.clip.end },
      { type: 'set_caption_cue', clipId: firstId, captionCue: { text, words } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Speed / crop / blend mode (H1.2h — inspector UI for engine ops that already
// render for real: set_clip_speed, set_clip_crop, set_clip_blend_mode)
// ---------------------------------------------------------------------------

/**
 * Set (or clear, with `speed: null`) a clip's constant playback rate. Returns
 * `null` when the clip is missing or `speed` is not a finite positive number.
 * Mirrors `set_clip_speed`'s own semantics (null resets to 1x).
 */
export function setClipSpeedPatch(
  timeline: Timeline,
  clipId: string,
  speed: number | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  // Schema v15 (ADR 0090) widened the legal range: 0 is a freeze frame and a
  // negative value plays the range backwards. Only a value that is not a number
  // at all is refused — there is no render that could mean.
  if (speed !== null && !Number.isFinite(speed)) return null;
  return {
    patchId: patchId(`speed_${clipId}_${speed === null ? 'reset' : ms(speed)}`),
    createdBy: 'user',
    reason:
      speed === null
        ? `Reset speed on "${clipId}"`
        : speed === 0
          ? `Freeze "${clipId}" on a single frame`
          : speed < 0
            ? `Reverse "${clipId}" at ${Math.abs(speed)}x`
            : `Set speed on "${clipId}" to ${speed}x`,
    operations: [{ type: 'set_clip_speed', clipId, speed }],
  };
}

/**
 * Replace a clip's speed **curve** (schema v15, ADR 0090). `ramp: null` or an empty
 * array clears it back to constant speed.
 *
 * Refuses a non-positive rate here rather than letting the op throw: the builder is
 * what a UI control calls, and a rejected patch surfaced as an error toast is a
 * worse answer than a control that simply cannot produce the value. The op keeps its
 * own defensive check for callers that are not this one.
 */
export function setClipSpeedRampPatch(
  timeline: Timeline,
  clipId: string,
  ramp: readonly SpeedPoint[] | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const points = ramp ?? [];
  if (points.some((p) => !Number.isFinite(p.rate) || p.rate <= 0)) return null;
  if (points.some((p) => !Number.isFinite(p.sourceTime) || p.sourceTime < 0)) return null;
  return {
    patchId: patchId(`speed_ramp_${clipId}_${points.length}`),
    createdBy: 'user',
    reason:
      points.length === 0
        ? `Clear the speed ramp on "${clipId}"`
        : `Set a ${points.length}-point speed ramp on "${clipId}"`,
    operations: [
      { type: 'set_clip_speed_ramp', clipId, ramp: points.length === 0 ? null : points },
    ],
  };
}

/**
 * Set (or clear, with `crop: null`) a clip's crop rect (fractions of the source
 * frame). Returns `null` when the clip is missing, or when a non-null crop has
 * a non-finite field. Mirrors `set_clip_crop`'s own semantics (null clears to
 * uncropped).
 */
export function setClipCropPatch(
  timeline: Timeline,
  clipId: string,
  crop: CropRect | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  if (crop && !Object.values(crop).every(Number.isFinite)) return null;
  const cropKey = crop
    ? `${ms(crop.x)}_${ms(crop.y)}_${ms(crop.width)}_${ms(crop.height)}`
    : 'reset';
  return {
    patchId: patchId(`crop_${clipId}_${cropKey}`),
    createdBy: 'user',
    reason: crop ? `Crop "${clipId}"` : `Clear crop on "${clipId}"`,
    operations: [{ type: 'set_clip_crop', clipId, crop }],
  };
}

/**
 * Set (or clear, with `blendMode: null`) a clip's compositing blend mode.
 * Returns `null` when the clip is missing. Mirrors `set_clip_blend_mode`'s own
 * semantics (null resets to `'normal'`).
 */
export function setClipBlendModePatch(
  timeline: Timeline,
  clipId: string,
  blendMode: BlendMode | null,
): Patch | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  return {
    patchId: patchId(`blend_${clipId}_${blendMode ?? 'reset'}`),
    createdBy: 'user',
    reason: blendMode
      ? `Set blend mode on "${clipId}" to ${blendMode}`
      : `Reset blend mode on "${clipId}"`,
    operations: [{ type: 'set_clip_blend_mode', clipId, blendMode }],
  };
}

// ---------------------------------------------------------------------------
// Markers / chapters (schema v9, H1.2 follow-up — persist the "M" toggle)
// ---------------------------------------------------------------------------

/** Markers within this many seconds of each other are treated as the same one
 *  (mirrors the pre-persistence store-level toggle epsilon). */
export const MARKER_EPSILON = 1e-3;

/** A monotonic id source for user-created markers (unique within a session),
 *  mirroring `MediaBin.tsx`'s `nextFolderId` convention (`Date.now` + a counter,
 *  not a UUID — consistent with `createFolderPatch`'s caller-supplied-id shape). */
let markerCounter = 0;
export const nextMarkerId = (): string =>
  `marker_${Date.now().toString(36)}_${(markerCounter += 1)}`;

/** The marker within {@link MARKER_EPSILON} of `time`, if any. */
export function findNearbyMarker(markers: readonly Marker[], time: number): Marker | null {
  return markers.find((m) => Math.abs(m.time - time) <= MARKER_EPSILON) ?? null;
}

/**
 * Add a project-level marker/chapter (schema v9) at `time`, optionally titled
 * (promoting it to a "chapter") and colored. `id` is minted by the caller (see
 * {@link nextMarkerId}), mirroring `createFolderPatch`'s caller-supplied-id shape.
 */
export function addMarkerPatch(id: string, time: number, label?: string, color?: string): Patch {
  return {
    patchId: patchId(`addmarker_${id}`),
    createdBy: 'user',
    reason: label ? `Add marker "${label}"` : `Add marker at ${time.toFixed(2)}s`,
    operations: [
      {
        type: 'add_marker',
        id,
        time,
        ...(label !== undefined ? { label } : {}),
        ...(color !== undefined ? { color } : {}),
      },
    ],
  };
}

/** Remove a marker/chapter by id. */
export function removeMarkerPatch(markerId: string): Patch {
  return {
    patchId: patchId(`rmmarker_${markerId}`),
    createdBy: 'user',
    reason: `Remove marker "${markerId}"`,
    operations: [{ type: 'remove_marker', id: markerId }],
  };
}

/**
 * Toggle a marker at `time`: add a new one (via `idFactory`) if none is within
 * {@link MARKER_EPSILON}, otherwise remove the nearby one. `null` for a
 * negative time (no-op) — preserves the exact "M" toggle UX that predates
 * persistence, just now expressed as a reversible patch.
 */
export function toggleMarkerPatch(
  markers: readonly Marker[],
  time: number,
  idFactory: () => string = nextMarkerId,
): Patch | null {
  if (time < 0) return null;
  const existing = findNearbyMarker(markers, time);
  return existing ? removeMarkerPatch(existing.id) : addMarkerPatch(idFactory(), time);
}

// ---------------------------------------------------------------------------
// Effect layers (schema v13, ADR 0088)
// ---------------------------------------------------------------------------
//
// One builder per user action, each producing exactly one reversible patch so a
// drag, a slider nudge, or a delete is one undo step. These are the SAME six
// editor-core operations the AI tools emit — that shared surface is what makes
// manual and AI edits land identically, so nothing here may take a shortcut the
// AI path cannot.

/** The lane a new effect should land on: the named one, else the first that exists. */
export function findEffectTrack(timeline: Timeline, preferred?: string): Track | undefined {
  if (preferred !== undefined) {
    const named = timeline.tracks.find((t) => t.id === preferred);
    if (named?.type === 'effect') return named;
  }
  return timeline.tracks.find((t) => t.type === 'effect');
}

/** Do two half-open ranges overlap? Touching endpoints do not. */
const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd - 1e-9 && bStart < aEnd - 1e-9;

/**
 * The lowest effect lane where `[start, end)` is free, or `undefined` when every
 * existing lane is occupied over that span.
 *
 * WHY this exists: two effects covering the same moment must BOTH apply, and two
 * layers on one lane that overlap in time are ambiguous to read even though the
 * engine orders them deterministically. Auto-stacking onto the next free lane is
 * what makes "apply a second effect over the same clip" do the obvious thing
 * instead of dropping a chip on top of another one.
 *
 * Searched from the BOTTOM lane upward (tracks are front-to-back, so the last
 * effect track is the lowest) because a lower lane applies first, and a newly
 * added effect should sit as close to the picture as it can.
 */
export function freeEffectTrack(
  timeline: Timeline,
  start: number,
  end: number,
  preferred?: string,
): Track | undefined {
  const lanes = timeline.tracks.filter((t) => t.type === 'effect');
  const isFree = (track: Track): boolean =>
    !effectLayersOf(track).some((l) => rangesOverlap(start, end, l.start, l.end));

  if (preferred !== undefined) {
    const named = lanes.find((t) => t.id === preferred);
    // An explicitly targeted lane is honoured even when occupied: a deliberate
    // drop onto a specific lane is the user saying where they want it.
    if (named !== undefined) return named;
  }
  for (let i = lanes.length - 1; i >= 0; i -= 1) {
    const lane = lanes[i];
    if (lane !== undefined && isFree(lane)) return lane;
  }
  return undefined;
}

/**
 * Apply a catalog effect as a new layer.
 *
 * Creates an effect lane at the front when the project has none — two operations
 * in ONE patch, so the lane and the layer appear and disappear together rather
 * than leaving an orphan empty track behind after undo.
 */
export function addEffectLayerPatch(
  timeline: Timeline,
  effectId: string,
  start: number,
  options: {
    readonly end?: number;
    readonly trackId?: string;
    readonly layerId?: string;
    readonly params?: Readonly<Record<string, number>>;
  } = {},
): Patch | null {
  const entry = findEffect(effectId);
  if (entry === undefined || start < 0) return null;
  const end = options.end ?? start + entry.defaultDuration;
  if (end <= start) return null;

  const layerId = options.layerId ?? `fx_${effectId}_${Math.round(start * 1000)}`;
  const layer: EffectLayer = {
    id: layerId,
    effectId: entry.id,
    kind: entry.kind,
    start,
    end,
    // The COMPLETE bag, not just overrides: a layer carrying only overrides would
    // change appearance if a kind's defaults were ever retuned, silently altering
    // already-saved projects.
    params: clampParamsForKind(entry.kind, { ...resolveParams(entry), ...(options.params ?? {}) }),
    keyframes: [],
  };

  // A lane where this span is free. When every lane is busy over the range the
  // effect stacks onto a NEW lane above rather than overlapping an existing chip.
  const existing = freeEffectTrack(timeline, start, end, options.trackId);
  if (existing !== undefined) {
    return {
      patchId: patchId(`fx_add_${layerId}`),
      createdBy: 'user',
      reason: `Add ${entry.label}`,
      operations: [{ type: 'add_effect_layer', trackId: existing.id, layer }],
    };
  }

  const trackId = `fx_track_${timeline.tracks.length}`;
  return {
    patchId: patchId(`fx_add_${layerId}`),
    createdBy: 'user',
    reason: `Add ${entry.label}`,
    operations: [
      // Index 0 = visual front, so the new lane sits ABOVE the ones already there
      // and its effect applies last — which is what "stacked on top" means.
      { type: 'add_layer', layerId: trackId, layerType: 'effect', atIndex: 0 },
      { type: 'add_effect_layer', trackId, layer },
    ],
  };
}

/** Duplicate a layer, placed immediately after itself. */
export function duplicateEffectLayerPatch(timeline: Timeline, layerId: string): Patch | null {
  const found = findEffectLayer(timeline, layerId);
  if (!found) return null;
  const { track, layer } = found;
  const duration = layer.end - layer.start;
  const copy: EffectLayer = {
    ...structuredClone(layer),
    id: `${layer.id}_copy_${Math.round(layer.end * 1000)}`,
    start: layer.end,
    end: layer.end + duration,
  };
  return {
    patchId: patchId(`fx_dup_${layer.id}`),
    createdBy: 'user',
    reason: `Duplicate ${findEffect(layer.effectId)?.label ?? 'effect'}`,
    operations: [{ type: 'add_effect_layer', trackId: track.id, layer: copy }],
  };
}

/**
 * Where a layer must end up so `[start, end)` does not collide with a sibling.
 *
 * Returns the id of a lane with room, `'new'` when one has to be created, or
 * `null` when the layer can stay where it is.
 *
 * WHY a manual drag relocates rather than being blocked: two effects covering the
 * same moment must BOTH apply, so refusing the drag would be wrong. Two chips
 * overlapping on one lane is unreadable, so leaving it would be wrong too. Moving
 * to a lane with room is the only outcome that keeps both the edit and the
 * timeline legible — and it mirrors what applying a conflicting effect already
 * does.
 */
function laneForRange(
  timeline: Timeline,
  layerId: string,
  currentTrackId: string,
  start: number,
  end: number,
): string | 'new' | null {
  const collides = (track: Track): boolean =>
    effectLayersOf(track).some(
      // Never against itself: a layer always "overlaps" its own old range.
      (l) => l.id !== layerId && rangesOverlap(start, end, l.start, l.end),
    );

  const current = timeline.tracks.find((t) => t.id === currentTrackId);
  if (current !== undefined && !collides(current)) return null;

  const lanes = timeline.tracks.filter((t) => t.type === 'effect');
  // Bottom-up, so a displaced layer settles as close to the picture as it can.
  for (let i = lanes.length - 1; i >= 0; i -= 1) {
    const lane = lanes[i];
    if (lane !== undefined && lane.id !== currentTrackId && !collides(lane)) return lane.id;
  }
  return 'new';
}

export function moveEffectLayerPatch(
  timeline: Timeline,
  layerId: string,
  toStart: number,
  toTrackId?: string,
): Patch | null {
  const found = findEffectLayer(timeline, layerId);
  if (!found || toStart < 0) return null;

  const duration = found.layer.end - found.layer.start;
  const destination = toTrackId ?? found.track.id;
  const lane = laneForRange(timeline, layerId, destination, toStart, toStart + duration);

  const id = patchId(`fx_move_${layerId}_${Math.round(toStart * 1000)}`);
  // Dropped somewhere that already has a layer over this span: land on a lane
  // with room instead of stacking two chips on top of each other.
  if (lane === 'new') {
    const trackId = `fx_track_${timeline.tracks.length}`;
    return {
      patchId: id,
      createdBy: 'user',
      reason: 'Move effect to a new lane',
      operations: [
        { type: 'add_layer', layerId: trackId, layerType: 'effect', atIndex: 0 },
        { type: 'move_effect_layer', layerId, toStart, toTrackId: trackId },
      ],
    };
  }
  const target = lane ?? toTrackId;
  return {
    patchId: id,
    createdBy: 'user',
    reason: lane === null ? 'Move effect' : 'Move effect to a free lane',
    operations: [
      {
        type: 'move_effect_layer',
        layerId,
        toStart,
        ...(target !== undefined ? { toTrackId: target } : {}),
      },
    ],
  };
}

export function trimEffectLayerPatch(
  timeline: Timeline,
  layerId: string,
  start: number,
  end: number,
): Patch | null {
  // Guarded here as well as in the operation: a drag that would invert the layer
  // should produce NO patch, so history is not polluted with rejected edits.
  const found = findEffectLayer(timeline, layerId);
  if (!found || start < 0 || end <= start) return null;

  const id = patchId(`fx_trim_${layerId}_${Math.round(start * 1000)}_${Math.round(end * 1000)}`);
  const trim = { type: 'trim_effect_layer', layerId, start, end } as const;
  // Extending an edge can run a layer into its neighbour just as a drag can, so
  // a trim relocates on collision too. Trim FIRST, then move: the move preserves
  // duration, so it has to act on the already-resized layer.
  const lane = laneForRange(timeline, layerId, found.track.id, start, end);
  if (lane === null) {
    return { patchId: id, createdBy: 'user', reason: 'Trim effect', operations: [trim] };
  }
  if (lane === 'new') {
    const trackId = `fx_track_${timeline.tracks.length}`;
    return {
      patchId: id,
      createdBy: 'user',
      reason: 'Trim effect onto a new lane',
      operations: [
        trim,
        { type: 'add_layer', layerId: trackId, layerType: 'effect', atIndex: 0 },
        { type: 'move_effect_layer', layerId, toStart: start, toTrackId: trackId },
      ],
    };
  }
  return {
    patchId: id,
    createdBy: 'user',
    reason: 'Trim effect onto a free lane',
    operations: [trim, { type: 'move_effect_layer', layerId, toStart: start, toTrackId: lane }],
  };
}

/**
 * Retune a layer. `params` is a partial patch, so a single slider drag sends only
 * the value it changed.
 */
export function setEffectLayerParamsPatch(
  timeline: Timeline,
  layerId: string,
  params?: Readonly<Record<string, number>>,
  intensity?: number | null,
): Patch | null {
  const found = findEffectLayer(timeline, layerId);
  if (!found) return null;
  if (params === undefined && intensity === undefined) return null;
  // Clamped against the layer's OWN kind, so a control that somehow reports an
  // out-of-range value cannot reach a shader.
  const clamped =
    params === undefined
      ? undefined
      : clampParamsForKind(found.layer.kind, { ...found.layer.params, ...params });
  return {
    patchId: patchId(`fx_params_${layerId}_${Math.round(Date.now())}`),
    createdBy: 'user',
    reason: 'Adjust effect',
    operations: [
      {
        type: 'set_effect_layer_params',
        layerId,
        ...(clamped !== undefined ? { params: clamped } : {}),
        ...(intensity !== undefined ? { intensity } : {}),
      },
    ],
  };
}

export function setEffectLayerEnabledPatch(
  timeline: Timeline,
  layerId: string,
  enabled: boolean,
): Patch | null {
  if (!findEffectLayer(timeline, layerId)) return null;
  return {
    patchId: patchId(`fx_enabled_${layerId}_${enabled ? 'on' : 'off'}`),
    createdBy: 'user',
    reason: enabled ? 'Enable effect' : 'Disable effect',
    operations: [{ type: 'set_effect_layer_enabled', layerId, disabled: !enabled }],
  };
}

export function removeEffectLayerPatch(timeline: Timeline, layerId: string): Patch | null {
  const found = findEffectLayer(timeline, layerId);
  if (!found) return null;
  return {
    patchId: patchId(`fx_remove_${layerId}`),
    createdBy: 'user',
    reason: `Remove ${findEffect(found.layer.effectId)?.label ?? 'effect'}`,
    operations: [{ type: 'remove_effect_layer', layerId }],
  };
}

/**
 * Remove several effect layers in ONE patch.
 *
 * A multi-select delete has to be a single undo step: deleting four layers and
 * pressing undo four times to get them back is not what "undo that" means. The
 * per-layer {@link removeEffectLayerPatch} stays for the single case, which is
 * every other caller.
 */
export function removeEffectLayersPatch(
  timeline: Timeline,
  layerIds: readonly string[],
): Patch | null {
  // Filter to layers that actually exist: a stale id in the selection (a layer
  // removed by an AI edit, say) must not make the whole delete fail validation.
  const present = layerIds.filter((id) => findEffectLayer(timeline, id) !== undefined);
  if (present.length === 0) return null;
  return {
    patchId: patchId(`fx_remove_${present.join('_')}`),
    createdBy: 'user',
    reason: present.length === 1 ? 'Remove effect' : `Remove ${present.length} effects`,
    operations: present.map((layerId) => ({ type: 'remove_effect_layer', layerId }) as const),
  };
}
