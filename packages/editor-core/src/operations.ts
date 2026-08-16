/**
 * @framepilot/editor-core/operations — typed, reversible timeline operations.
 *
 * Defines the discriminated-union `Operation` type (PRD §8.3 / PLAN §1.2). Each
 * operation is a pure transform: `applyOperation(timeline, op)` returns a new
 * immutable timeline, and `invertOperation(timelineBefore, op)` returns the
 * operation(s) that undo it.
 *
 * ## Reversibility design (see docs/adr/0001-reversible-operations.md)
 *
 * Most edits cannot be undone with a *forward* operation of the same vocabulary
 * (e.g. there is no `remove_clip` to invert `add_clip`, and `delete_range` is
 * lossy). Rather than bloat the op union with an inverse for every verb, every
 * operation is confined to the clips of a **single track**, so its inverse is a
 * lossless snapshot-restore of that track's clip list: the internal
 * {@link RestoreClipsOp}. Two ops keep a readable, same-shape inverse because it
 * is exact and small: `trim_clip` and `move_clip`. Everything else inverts to
 * `restore_clips`. The diff/undo UI uses before/after timelines, not the inverse
 * verbs, so coarse-but-correct inverses are the right trade-off.
 */
import type { Seconds } from '@framepilot/shared-types';
import type {
  BlendMode,
  CaptionCue,
  CaptionStyle,
  Clip,
  CropRect,
  Effect,
  EffectLayer,
  Keyframe,
  SpeedPoint,
  Timeline,
  Track,
} from '@framepilot/timeline-schema';
import type {
  AudioAutomationPoint,
  AudioAutomationProperty,
  AudioDynamicsSettings,
  AudioEqBand,
} from './edit-value-contracts.js';
import { transitionEligibility } from './edit-boundaries.js';
import {
  DEFAULT_TRANSITION_ALIGNMENT,
  TRANSITION_EFFECT_TYPE,
  TRANSITION_OUT_EFFECT_TYPE,
  transitionEffectId,
  transitionOutEffectId,
  transitionWindow,
  type TransitionAlignment,
} from './transitions.js';
import {
  BlendModeSchema,
  CaptionCueSchema,
  CaptionStyleSchema,
  CropRectSchema,
  EffectLayerSchema,
  SpeedPointSchema,
  effectLayersOf,
} from '@framepilot/timeline-schema';
import {
  clipTimelineDuration,
  hasSpeedRamp,
  integrateRate,
  rateAt,
  sourceTimeAt,
} from './speed-curve.js';

// ---------------------------------------------------------------------------
// Operation union (PLAN §1.2)
// ---------------------------------------------------------------------------

export interface TrimClipOp {
  readonly type: 'trim_clip';
  readonly clipId: string;
  readonly start: Seconds;
  readonly end: Seconds;
}

/**
 * Replace only the source-media range consumed by a clip, preserving its timeline
 * position, duration, effects, and keyframes. This is the minimal reversible
 * primitive required by a professional slip edit; callers must not emulate a slip
 * with two trims because that changes the clip's sequence boundaries.
 *
 * The source span must continue to imply the existing timeline duration at the
 * clip's speed. That invariant is enforced here as well as by patch validation so
 * direct engine callers cannot persist a speed/duration mismatch.
 */
export interface SetClipSourceRangeOp {
  readonly type: 'set_clip_source_range';
  readonly clipId: string;
  readonly sourceStart: Seconds;
  readonly sourceEnd: Seconds;
}

/**
 * Replace a clip's media reference and source range while preserving its sequence
 * position, id, effects, keyframes, crop, masks, and speed configuration. This is
 * the non-destructive primitive behind a professional replace edit.
 */
export interface SetClipMediaOp {
  readonly type: 'set_clip_media';
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceStart: Seconds;
  readonly sourceEnd: Seconds;
}

export interface SplitClipOp {
  readonly type: 'split_clip';
  readonly clipId: string;
  readonly at: Seconds;
}

export interface DeleteRangeOp {
  readonly type: 'delete_range';
  readonly trackId: string;
  readonly start: Seconds;
  readonly end: Seconds;
}

export interface MoveClipOp {
  readonly type: 'move_clip';
  readonly clipId: string;
  readonly toTrackId: string;
  readonly toStart: Seconds;
}

export interface RippleDeleteOp {
  readonly type: 'ripple_delete';
  readonly trackId: string;
  readonly start: Seconds;
  readonly end: Seconds;
}

export interface AddClipOp {
  readonly type: 'add_clip';
  readonly trackId: string;
  readonly assetId: string;
  readonly start: Seconds;
  readonly end: Seconds;
  readonly sourceStart: Seconds;
  readonly sourceEnd: Seconds;
  /** Optional explicit id; a deterministic id is derived when omitted. */
  readonly clipId?: string;
}

export interface AddTextOverlayOp {
  readonly type: 'add_text_overlay';
  readonly trackId: string;
  readonly text: string;
  readonly start: Seconds;
  readonly end: Seconds;
  readonly clipId?: string;
}

export interface AddCaptionLayerOp {
  readonly type: 'add_caption_layer';
  readonly trackId: string;
  readonly start: Seconds;
  readonly end: Seconds;
  readonly clipId?: string;
}

export interface AddKeyframesOp {
  readonly type: 'add_keyframes';
  readonly clipId: string;
  readonly keyframes: readonly Keyframe[];
  /**
   * When true, an existing keyframe with the SAME property at the SAME time
   * (±1ms) is replaced by the incoming one instead of stacking a duplicate —
   * the "set the transform" semantics interactive controls need (H4). Absent /
   * false keeps the historical append-only behavior.
   */
  readonly replace?: boolean;
}

/**
 * Remove keyframes from a clip (revamp Phase 5a).
 *
 * ## Why this op has to exist
 *
 * `add_keyframes` has a `replace` flag, but it only swaps a keyframe with the SAME
 * property at the SAME time (±1ms). It cannot delete one, and it cannot move one —
 * a move is a delete at the old time plus an add at the new. So without this op,
 * nothing in the product could remove a keyframe: not the inspector's diamond, not
 * a Delete press on a timeline keyframe, not "clear all keyframes".
 *
 * ## Selection semantics
 *
 * Keyframes are matched by **property + time (±1ms)**, not by `id`. Ids are
 * generated by whatever built the keyframe (`kf_<clip>_<prop>_<ms>`, `preview_base_*`,
 * the punch-in generator, a Python-side write) and are not a stable handle a UI can
 * rely on. Property-and-time is what a user is actually pointing at when they click a
 * diamond, and it is stable across every producer.
 *
 * Omitting `time` removes **every** keyframe for that property — "clear this
 * property's animation", which would otherwise need the caller to enumerate times it
 * may not know.
 *
 * ## Reversibility
 *
 * A removal is lossy, so like almost every op here it inverts to a `restore_clips`
 * snapshot of the clip's track (see the module note). That is exact and free: the
 * op does not need to carry the removed keyframes, because `invertOperation` reads
 * the pre-state.
 */
export interface RemoveKeyframesOp {
  readonly type: 'remove_keyframes';
  readonly clipId: string;
  /**
   * Which keyframes to remove. Each target names a property and, optionally, a
   * time; a target with no `time` clears that property entirely.
   */
  readonly targets: readonly {
    readonly property: string;
    readonly time?: Seconds;
  }[];
}

export interface ApplyColorGradeOp {
  readonly type: 'apply_color_grade';
  readonly clipId: string;
  readonly effect: Effect;
}

/**
 * Merge `params` into an existing effect's `params` in place (shallow), leaving its
 * id/type/keyframes untouched. Used to edit a text overlay's content and styling
 * (color, font, size, alignment, in/out animation, box width) — and, generically,
 * any effect's params — as one reversible edit, without a delete+re-add. A key set
 * to `undefined` clears it. The inverse restores the effect's prior params via the
 * standard track snapshot.
 */
export interface SetEffectParamsOp {
  readonly type: 'set_effect_params';
  readonly clipId: string;
  readonly effectId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AdjustAudioOp {
  readonly type: 'adjust_audio';
  readonly clipId: string;
  readonly gainDb: number;
  /** Optional fade-in / fade-out lengths (seconds) applied as a render envelope. */
  readonly fadeInSeconds?: Seconds;
  readonly fadeOutSeconds?: Seconds;
  /**
   * The shape of those fades: `linear` (the default and the historical
   * behaviour), `equal-power`, or `smooth`.
   *
   * Worth having because two clips crossfading on LINEAR gain sum to a dip in
   * the middle — power goes as the square of amplitude, so half plus half is
   * only 0.707 of the power. A sine/cosine pair holds it constant, which is why
   * every mixer offers one and why a music crossfade sounds like a hole without
   * it.
   */
  readonly fadeCurve?: string;
  /** When true, the clip is silenced (gain forced to 0 at render). */
  readonly muted?: boolean;
  /** When true, the clip is peak-normalized before its gain is applied. */
  readonly normalize?: boolean;
  /** Duck this clip under another track's clips (e.g. music under voice). */
  readonly duckUnderTrackId?: string;
  readonly duckAmountDb?: number;
  /**
   * Corrective EQ for this clip. Absent leaves the clip's spectrum untouched;
   * present REPLACES the whole curve, because a partial merge of two band lists
   * has no honest answer — "the 200 Hz band" is not an identity a second edit can
   * address without inventing one.
   */
  readonly eq?: { readonly bands: readonly AudioEqBand[] };
  /** Compression for this clip. Absent leaves its dynamics untouched. */
  readonly dynamics?: AudioDynamicsSettings;
  /**
   * A gain automation lane, written as keyframes on the clip's canonical
   * `audio_gain` effect.
   *
   * Where it sits in the chain matters and is stated once here: the renderer runs
   * mute → normalize → EQ → compressor → **fader**, and gain is a fader move. So
   * the compressor sees the clip at its recorded level, and an automation lane
   * supersedes {@link gainDb} for as long as it runs rather than multiplying with
   * it — one parameter cannot have two authored answers at the same instant.
   *
   * An empty `points` array clears the lane and returns the clip to static gain.
   */
  readonly automation?: {
    readonly property: AudioAutomationProperty;
    readonly points: readonly AudioAutomationPoint[];
  };
}

export interface AddTransitionOp {
  readonly type: 'add_transition';
  readonly trackId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
  /**
   * A transition catalog id (`@framepilot/timeline-schema/transition-catalog`).
   *
   * Typed as `string` rather than a union of the catalog's 78 ids on purpose: the
   * catalog is data, and a union here would mean every added transition was also
   * a type change in editor-core, the AI tool layer and the MCP server. The value
   * is checked against the catalog at apply time instead, so an unknown kind is a
   * refused operation with a readable message rather than a silent no-op render.
   */
  readonly kind: string;
  readonly durationSeconds: Seconds;
  /**
   * Where the ramp sits relative to the cut. Absent ⇒ `start`, which is what this
   * engine did before alignment existed. See `transitions.ts`.
   */
  readonly alignment?: TransitionAlignment;
}

/** Mask shape kinds the engine composites. */
export type MaskShape = 'rectangle' | 'ellipse' | 'polygon';

/** Axis-aligned mask bounds, as fractions (0..1) of the clip frame. */
export interface MaskBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AddMaskOp {
  readonly type: 'add_mask';
  readonly clipId: string;
  readonly shape: MaskShape;
  /** Rect/ellipse bounds as frame fractions (defaults to the full frame). */
  readonly bounds?: MaskBounds;
  /** Polygon vertices as [x, y] frame fractions (used when shape='polygon'). */
  readonly points?: readonly (readonly [number, number])[];
  /** Edge feather as a fraction of the smaller frame dimension (0..1). */
  readonly feather?: number;
  /** Mask opacity (0..1) applied inside the shape. */
  readonly opacity?: number;
  /** Invert the mask (keep outside the shape instead of inside). */
  readonly invert?: boolean;
  /** Keyframes attached to the mask effect to animate its params over time. */
  readonly keyframes?: readonly Keyframe[];
}

/** What a tracker follows: a face, a generic bounding box, or any picked object. */
export type TrackTarget = 'face' | 'bounding_box' | 'object';

export interface TrackObjectOp {
  readonly type: 'track_object';
  readonly clipId: string;
  readonly target: TrackTarget;
  /** The region the user picked to track, as frame fractions (0..1). */
  readonly region?: MaskBounds;
  /** Tracking engine that produced/will produce the track (e.g. 'manual'). */
  readonly engine?: string;
  /** Per-frame bbox keyframes (x/y/width/height over clip time) for the track. */
  readonly keyframes?: readonly Keyframe[];
}

/**
 * Set or clear a caption clip's rich, persisted style (schema v5). `captionStyle:
 * null` clears any existing style back to unstyled; a value replaces it wholesale
 * (not merged) — mirrors `set_track_flags`'s "whole value, single axis" shape, so
 * the inverse is the same-shape op carrying the clip's prior style. Meaningful on
 * caption clips (`assetId === CAPTION_ASSET_ID`) but not restricted to them at the
 * op level, since the field lives on `Clip` generically (see schema v5 doc note).
 */
export interface SetCaptionStyleOp {
  readonly type: 'set_caption_style';
  readonly clipId: string;
  readonly captionStyle: CaptionStyle | null;
}

/**
 * Set or clear a caption clip's own text + word timings (schema v11, ADR 0071).
 *
 * This is what makes caption text editable at all. Through v10 a caption clip
 * carried only a range, and its words were re-derived from `Project.transcript`
 * by every consumer — so there was nowhere to record "this cue says something
 * different from what the transcript thinks". `captionCue: null` clears the cue
 * back to that transcript-derived fallback; a value replaces it wholesale (not
 * merged), mirroring `set_caption_style`/`set_clip_crop`'s "whole value, single
 * axis" shape, so the inverse is the same-shape op carrying the prior cue.
 *
 * Meaningful on caption clips (`assetId === CAPTION_ASSET_ID`) but, like
 * `captionStyle`, not restricted to them at the op level since the field lives on
 * `Clip` generically.
 */
export interface SetCaptionCueOp {
  readonly type: 'set_caption_cue';
  readonly clipId: string;
  readonly captionCue: CaptionCue | null;
}

/**
 * Set (or reset) a clip's constant playback rate (schema v6, speed/time-remap).
 * `speed: null` resets to 1x (the default). Must be a positive, finite number.
 * The clip's asset range (`sourceStart`/`sourceEnd`) is unchanged — only the
 * timeline `end` is recomputed to keep `end - start === (sourceEnd -
 * sourceStart) / speed` (see `docs/adr/0046-clip-speed-schema-v6.md`). Same-
 * shape inverse: `set_clip_speed` carrying the clip's prior speed (or `null`),
 * which deterministically restores the prior `end` from the (untouched) source
 * range — mirrors `set_track_flags`/`set_caption_style`.
 */
export interface SetClipSpeedOp {
  readonly type: 'set_clip_speed';
  readonly clipId: string;
  /**
   * `null` resets to 1x. Schema v15 (ADR 0090) widened the legal range: `0` is a
   * freeze frame and a negative value plays the source range backwards.
   */
  readonly speed: number | null;
}

/**
 * Replace a clip's **speed curve** (schema v15, ADR 0090).
 *
 * Separate from `set_clip_speed` rather than an extra field on it, because the two
 * answer different questions and a UI reaches for exactly one at a time: "how fast
 * is this clip" versus "how does its speed change over its length". Applying either
 * clears the other, so a clip is never storing two contradictory rates.
 *
 * `ramp: null` or `[]` clears the curve back to constant speed.
 */
export interface SetClipSpeedRampOp {
  readonly type: 'set_clip_speed_ramp';
  readonly clipId: string;
  readonly ramp: readonly SpeedPoint[] | null;
}

/**
 * Set or clear a clip's crop rect (schema v7). `crop: null` clears any existing
 * crop back to uncropped (the full source frame); a value replaces it wholesale
 * (not merged) — mirrors `set_caption_style`/`set_clip_speed`'s "whole value,
 * single axis" shape, so the inverse is the same-shape op carrying the clip's
 * prior crop. See `docs/adr/0047-clip-crop-schema-v7.md`.
 */
export interface SetClipCropOp {
  readonly type: 'set_clip_crop';
  readonly clipId: string;
  readonly crop: CropRect | null;
}

/**
 * Set or clear a clip's compositing blend mode (schema v8). `blendMode: null`
 * resets it to `'normal'` (today's default compositing — no visual change); a
 * value replaces it wholesale — mirrors `set_clip_crop`/`set_clip_speed`'s
 * "whole value, single axis" shape, so the inverse is the same-shape op
 * carrying the clip's prior blend mode. Meaningful only on clips composited
 * over something beneath them (e.g. an `overlay`-track clip), but not
 * restricted at the op level since the field lives on `Clip` generically —
 * see `docs/adr/0048-clip-blend-mode-schema-v8.md`.
 */
export interface SetClipBlendModeOp {
  readonly type: 'set_clip_blend_mode';
  readonly clipId: string;
  readonly blendMode: BlendMode | null;
}

/**
 * Set a track's editing/render flags (schema v4). Only the provided fields
 * change; omitted fields are left as-is. Operates on track metadata, not clips,
 * so its inverse is a same-shape `set_track_flags` carrying the prior values.
 */
export interface SetTrackFlagsOp {
  readonly type: 'set_track_flags';
  readonly trackId: string;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly muted?: boolean;
}

/**
 * Set or clear a caption track's style default — "the project's caption look"
 * (schema v11, ADR 0071).
 *
 * WHY a track-level op: in v10 style lived only on the clip, so restyling a
 * finished caption set meant one `set_caption_style` per cue — a 400-operation
 * patch to change a colour, with no way to express the set's shared look. This
 * makes a template switch one operation regardless of cue count. Per-clip
 * `captionStyle` still wins at resolution time, so hand-tuned cues survive a
 * track-wide restyle.
 *
 * `captionStyle: null` clears the default; a value replaces it wholesale. Operates
 * on track metadata, not clips, so its inverse is a same-shape op carrying the
 * prior default — mirroring `set_track_flags`.
 */
export interface SetTrackCaptionStyleOp {
  readonly type: 'set_track_caption_style';
  readonly trackId: string;
  readonly captionStyle: CaptionStyle | null;
}

/**
 * Insert a new layer (Phase 2 — type-agnostic layers). A layer is a `Track`; the
 * `layerType` is the **advisory role** (default icon/label + auto-layering kind),
 * not a content constraint. `atIndex` is the z-order slot — **index 0 is the
 * visual front** — clamped into range. `clips` seeds the layer (default empty).
 * Inverse: `remove_layer`. See `plan/PHASE2-type-agnostic-layers.md`.
 */
export interface AddLayerOp {
  readonly type: 'add_layer';
  readonly layerId: string;
  readonly layerType: Track['type'];
  readonly atIndex: number;
  readonly clips?: readonly Clip[];
}

/**
 * Remove a layer by id (Phase 2). Lossless: its inverse is an `add_layer` that
 * restores the layer's type, z-order index, and clips, so removing a non-empty
 * layer is fully reversible.
 */
export interface RemoveLayerOp {
  readonly type: 'remove_layer';
  readonly layerId: string;
}

/**
 * Reorder a layer to a new z-order slot (Phase 2 — type-agnostic layers). `toIndex`
 * is the destination array index after removal — **index 0 is the visual front**,
 * clamped into range. Reordering never touches clips. Inverse: a `move_layer` back
 * to the layer's prior index. See `plan/PHASE2-type-agnostic-layers.md`.
 */
export interface MoveLayerOp {
  readonly type: 'move_layer';
  readonly layerId: string;
  readonly toIndex: number;
}

/**
 * Internal inverse primitive: replace a single track's entire clip list with a
 * prior snapshot. Produced only by {@link invertOperation}; it is the lossless
 * undo for every operation that is not `trim_clip`/`move_clip`.
 */
export interface RestoreClipsOp {
  readonly type: 'restore_clips';
  readonly trackId: string;
  readonly clips: readonly Clip[];
}

// ---------------------------------------------------------------------------
// Effect-layer operations (schema v13, ADR 0088)
// ---------------------------------------------------------------------------
//
// Six primitives cover every effect action the product promises. Notably absent:
//
//   · "duplicate" is an `add_effect_layer` with a fresh id — a distinct op would
//     need its own inverse for no new behaviour.
//   · "stack" is just two layers whose ranges overlap; ordering is derived by
//     `activeEffectLayersAt`, never stored.
//   · "reorder" is the existing `move_layer` on the effect TRACK, which already
//     has a lossless inverse.
//
// Keeping the surface minimal is what makes AI and manual editing provably
// identical: both drive these same six ops, so there is no second code path that
// could behave differently.

/** Add one effect layer to an `effect` track. Inverse: `remove_effect_layer`. */
export interface AddEffectLayerOp {
  readonly type: 'add_effect_layer';
  readonly trackId: string;
  readonly layer: EffectLayer;
}

/**
 * Remove an effect layer by id. Lossless: its inverse is an `add_effect_layer`
 * carrying the whole layer back to its original track.
 */
export interface RemoveEffectLayerOp {
  readonly type: 'remove_effect_layer';
  readonly layerId: string;
}

/**
 * Reposition a layer in time, optionally onto a different effect track (which is
 * how a user drags a layer between stacked lanes). Duration is preserved — this
 * is a move, not a trim. Inverse: a `move_effect_layer` back.
 */
export interface MoveEffectLayerOp {
  readonly type: 'move_effect_layer';
  readonly layerId: string;
  readonly toStart: number;
  /** Absent ⇒ stay on the current track. */
  readonly toTrackId?: string;
}

/**
 * Change a layer's in/out points — trim, extend or shorten from either edge.
 * Inverse: a `trim_effect_layer` back to the prior range.
 */
export interface TrimEffectLayerOp {
  readonly type: 'trim_effect_layer';
  readonly layerId: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Retune a layer. `params` is a PARTIAL patch merged over the layer's current
 * values, so a single slider drag sends only the value it changed; `intensity` is
 * separate because it is not a kind param but the master mix every kind honours.
 * Inverse: the same op carrying the prior values.
 */
export interface SetEffectLayerParamsOp {
  readonly type: 'set_effect_layer_params';
  readonly layerId: string;
  readonly params?: Readonly<Record<string, number>>;
  /** `null` clears the override back to "full strength". */
  readonly intensity?: number | null;
}

/**
 * Bypass or re-enable a layer without removing it. Inverse: the same op with the
 * prior state.
 */
export interface SetEffectLayerEnabledOp {
  readonly type: 'set_effect_layer_enabled';
  readonly layerId: string;
  /** `true` bypasses the layer; `false` re-enables it. */
  readonly disabled: boolean;
}

/**
 * Internal inverse primitive: replace one effect layer with a prior snapshot.
 * Produced only by {@link invertOperation}, mirroring how {@link RestoreClipsOp}
 * serves the clip ops.
 *
 * WHY `set_effect_layer_params` cannot invert to itself: the forward op merges
 * PARTIALLY, so any key it introduces has no prior value to restore — a
 * same-shape inverse carrying the old bag would merge it back over the new one
 * and leave the new key in place. Replacing the layer wholesale is the only
 * lossless undo, and a dedicated primitive keeps that fact explicit instead of
 * hiding a "replace, don't merge" flag on the forward op.
 */
export interface RestoreEffectLayerOp {
  readonly type: 'restore_effect_layer';
  readonly trackId: string;
  readonly layer: EffectLayer;
}

export type Operation =
  | TrimClipOp
  | SetClipSourceRangeOp
  | SetClipMediaOp
  | SplitClipOp
  | DeleteRangeOp
  | MoveClipOp
  | RippleDeleteOp
  | AddClipOp
  | AddTextOverlayOp
  | AddCaptionLayerOp
  | AddKeyframesOp
  | RemoveKeyframesOp
  | ApplyColorGradeOp
  | SetEffectParamsOp
  | AdjustAudioOp
  | AddTransitionOp
  | AddMaskOp
  | TrackObjectOp
  | SetTrackFlagsOp
  | SetTrackCaptionStyleOp
  | SetCaptionStyleOp
  | SetCaptionCueOp
  | SetClipSpeedOp
  | SetClipSpeedRampOp
  | SetClipCropOp
  | SetClipBlendModeOp
  | AddLayerOp
  | RemoveLayerOp
  | MoveLayerOp
  | AddEffectLayerOp
  | RemoveEffectLayerOp
  | MoveEffectLayerOp
  | TrimEffectLayerOp
  | SetEffectLayerParamsOp
  | SetEffectLayerEnabledOp
  | RestoreEffectLayerOp
  | RestoreClipsOp;

export type OperationType = Operation['type'];

/** Effect types the color-grade operation is allowed to attach. */
export const SUPPORTED_COLOR_GRADE_EFFECTS = ['color_grade', 'lut', 'transform'] as const;

/** Synthetic asset ids used for clips that have no media source. */
export const TEXT_OVERLAY_ASSET_ID = '__text__';
export const CAPTION_ASSET_ID = '__caption__';

/** Runtime type guard for a given operation kind. */
export const isOperationOfType = <T extends OperationType>(
  op: Operation,
  type: T,
): op is Extract<Operation, { type: T }> => op.type === type;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const EPSILON = 1e-9;

/** Deep clone that never aliases the input (Node 18+ structuredClone). */
const clone = <T>(value: T): T => structuredClone(value);

interface ClipLocation {
  readonly track: Track;
  readonly trackIndex: number;
  readonly clip: Clip;
  readonly clipIndex: number;
}

const findTrack = (timeline: Timeline, trackId: string): { track: Track; index: number } => {
  const index = timeline.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) throw new OperationError('missing_track', `Track not found: ${trackId}`);
  return { track: timeline.tracks[index]!, index };
};

const findClip = (timeline: Timeline, clipId: string): ClipLocation => {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex += 1) {
    const track = timeline.tracks[trackIndex]!;
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex >= 0) {
      return { track, trackIndex, clip: track.clips[clipIndex]!, clipIndex };
    }
  }
  throw new OperationError('missing_clip', `Clip not found: ${clipId}`);
};

/** Replace a track's clip list, returning a new immutable timeline. */
const withTrackClips = (
  timeline: Timeline,
  trackIndex: number,
  clips: readonly Clip[],
): Timeline => {
  const tracks = timeline.tracks.slice();
  tracks[trackIndex] = { ...tracks[trackIndex]!, clips: clips.slice() };
  return { ...timeline, tracks };
};

/** Time-order clips on a track by their timeline start. */
const sortByStart = (clips: readonly Clip[]): Clip[] =>
  clips.slice().sort((a, b) => a.start - b.start);

/** Deterministic clip id for ops that create clips without an explicit id. */
const deriveClipId = (prefix: string, ...parts: (string | number)[]): string =>
  `${prefix}__${parts.map((p) => (typeof p === 'number' ? Math.round(p * 1000) : p)).join('_')}`;

/**
 * The id `split_clip` will give the right-hand piece when it splits `clipId` at
 * `at`.
 *
 * Exported because a caller that needs to follow a split with an op targeting
 * the new clip — splitting a caption cue, which must then set each half's own
 * text — would otherwise have to hard-code this formula and silently break when
 * it changes. Deriving it here keeps one definition.
 */
export function splitClipRightId(clipId: string, at: number): string {
  return deriveClipId(clipId, 'split', at);
}

/**
 * Error thrown by {@link applyOperation} when an operation cannot be applied to
 * the given timeline. The patch validator (PRD §8.5) is the gate that prevents
 * these from reaching `applyPatch`; this is the defensive last line.
 */
export class OperationError extends Error {
  constructor(
    readonly code:
      | 'missing_clip'
      | 'missing_track'
      | 'invalid_range'
      | 'invalid_split'
      | 'duplicate_clip'
      | 'duplicate_layer'
      | 'missing_effect'
      | 'invalid_style'
      | 'invalid_cue'
      | 'invalid_speed'
      | 'invalid_crop'
      | 'invalid_blend_mode'
      | 'invalid_transition'
      | 'invalid_track'
      | 'invalid_effect_layer'
      | 'duplicate_effect_layer',
    message: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/** Do these two clips occupy the same source and sequence time? */
const sameClipTiming = (a: Clip, b: Clip): boolean =>
  a.id === b.id &&
  a.assetId === b.assetId &&
  a.start === b.start &&
  a.end === b.end &&
  a.sourceStart === b.sourceStart &&
  a.sourceEnd === b.sourceEnd &&
  (a.speed ?? 1) === (b.speed ?? 1);

/**
 * Did this operation change the source↔sequence mapping — i.e. could anything
 * derived from it (captions above all) have gone stale?
 *
 * WHY this question rather than an allowlist of "structural" op types:
 * classifying ops gets it wrong in both directions, and one of those directions
 * is fatal. `delete_range` looks structural, but it is exactly what caption
 * *generation* uses to clear the old cues off the caption track — bumping there
 * would mark every caption stale the instant it was written. Meanwhile a future
 * op that shifts timing would silently never bump until somebody remembered to
 * add it to the list. Comparing the mapping itself cannot drift from the truth.
 *
 * Caption and overlay tracks are excluded for the same reason they are excluded
 * from `buildTimelineMap`: they carry no real source range, so writing to them
 * cannot invalidate anything.
 *
 * The comparison leans on immutability to stay cheap. Operations rebuild only
 * the track they touch, so every other track is reference-identical and can be
 * dismissed with a pointer compare; only a genuinely rebuilt track is walked
 * clip by clip. That keeps this O(clips on one track) rather than O(clips), and
 * allocates nothing — this runs on every apply, including the 10k-apply
 * complexity guard in performance.test.ts.
 */
function mappingChanged(before: Timeline, after: Timeline): boolean {
  const timed = (t: Track): boolean => t.type === 'video' || t.type === 'audio';
  const a = before.tracks.filter(timed);
  const b = after.tracks.filter(timed);
  // Track identity and order matter: reordering changes which clip is topmost at
  // a given instant, which changes what `mapSequenceTime` resolves to.
  if (a.length !== b.length) return true;

  for (let i = 0; i < a.length; i += 1) {
    const trackBefore = a[i] as Track;
    const trackAfter = b[i] as Track;
    if (trackBefore === trackAfter) continue;
    if (trackBefore.id !== trackAfter.id) return true;
    if (trackBefore.clips === trackAfter.clips) continue;
    if (trackBefore.clips.length !== trackAfter.clips.length) return true;
    for (let j = 0; j < trackBefore.clips.length; j += 1) {
      const clipBefore = trackBefore.clips[j] as Clip;
      const clipAfter = trackAfter.clips[j] as Clip;
      if (clipBefore === clipAfter) continue;
      if (!sameClipTiming(clipBefore, clipAfter)) return true;
    }
  }
  return false;
}

/**
 * Apply a single operation to a timeline, returning a new immutable timeline.
 * The input timeline is never mutated.
 *
 * Bumps {@link Timeline.revision} when — and only when — the operation actually
 * changed the source↔sequence mapping, so anything derived from that mapping
 * (captions above all) can detect that it needs remapping. See
 * {@link mappingChanged} and `docs/adr/0076-canonical-timeline-mapping.md`.
 *
 * @param timeline - The current timeline.
 * @param op - The operation to apply.
 * @returns The resulting timeline.
 * @throws {OperationError} when the operation references missing entities or
 *   would produce an invalid timeline.
 */
export function applyOperation(timeline: Timeline, op: Operation): Timeline {
  const next = applyOperationInner(timeline, op);
  if (!mappingChanged(timeline, next)) return next;
  return { ...next, revision: (timeline.revision ?? 0) + 1 };
}

/** The operation dispatch itself; {@link applyOperation} adds revision tracking. */
function applyOperationInner(timeline: Timeline, op: Operation): Timeline {
  switch (op.type) {
    case 'trim_clip':
      return applyTrim(timeline, op);
    case 'set_clip_source_range':
      return applySetClipSourceRange(timeline, op);
    case 'set_clip_media':
      return applySetClipMedia(timeline, op);
    case 'split_clip':
      return applySplit(timeline, op);
    case 'delete_range':
      return applyDeleteRange(timeline, op);
    case 'ripple_delete':
      return applyRippleDelete(timeline, op);
    case 'move_clip':
      return applyMove(timeline, op);
    case 'add_clip':
      return applyAddClip(timeline, op);
    case 'add_text_overlay':
      return applyAddTextOverlay(timeline, op);
    case 'add_caption_layer':
      return applyAddCaptionLayer(timeline, op);
    case 'add_keyframes':
      return applyAddKeyframes(timeline, op);
    case 'remove_keyframes':
      return applyRemoveKeyframes(timeline, op);
    case 'apply_color_grade':
      return applyColorGrade(timeline, op);
    case 'set_effect_params':
      return applySetEffectParams(timeline, op);
    case 'adjust_audio':
      return applyAdjustAudio(timeline, op);
    case 'add_transition':
      return applyAddTransition(timeline, op);
    case 'add_mask':
      return applyAddMask(timeline, op);
    case 'track_object':
      return applyTrackObject(timeline, op);
    case 'set_track_flags':
      return applySetTrackFlags(timeline, op);
    case 'set_track_caption_style':
      return applySetTrackCaptionStyle(timeline, op);
    case 'set_caption_style':
      return applySetCaptionStyle(timeline, op);
    case 'set_caption_cue':
      return applySetCaptionCue(timeline, op);
    case 'set_clip_speed':
      return applySetClipSpeed(timeline, op);
    case 'set_clip_speed_ramp':
      return applySetClipSpeedRamp(timeline, op);
    case 'set_clip_crop':
      return applySetClipCrop(timeline, op);
    case 'set_clip_blend_mode':
      return applySetClipBlendMode(timeline, op);
    case 'add_layer':
      return applyAddLayer(timeline, op);
    case 'remove_layer':
      return applyRemoveLayer(timeline, op);
    case 'move_layer':
      return applyMoveLayer(timeline, op);
    case 'add_effect_layer':
      return applyAddEffectLayer(timeline, op);
    case 'remove_effect_layer':
      return applyRemoveEffectLayer(timeline, op);
    case 'move_effect_layer':
      return applyMoveEffectLayer(timeline, op);
    case 'trim_effect_layer':
      return applyTrimEffectLayer(timeline, op);
    case 'set_effect_layer_params':
      return applySetEffectLayerParams(timeline, op);
    case 'set_effect_layer_enabled':
      return applySetEffectLayerEnabled(timeline, op);
    case 'restore_effect_layer':
      return applyRestoreEffectLayer(timeline, op);
    case 'restore_clips':
      return applyRestoreClips(timeline, op);
  }
}

function applyTrim(timeline: Timeline, op: TrimClipOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.end - op.start <= EPSILON) {
    throw new OperationError(
      'invalid_range',
      `trim_clip would give non-positive duration on ${op.clipId}`,
    );
  }
  const { clip } = loc;
  // Speed-aware since schema v15 (ADR 0090). This used to move source in/out by
  // the same delta as the timeline edges regardless of `speed` — ADR 0046's
  // documented known limitation, which meant an ordinary trim of a 2x clip was
  // rejected by `speed_duration_mismatch`. `truncateClip` owns the mapping for
  // every speed case, so trim, delete_range and ripple_delete cannot disagree.
  const next: Clip = truncateClip(clip, op.start, op.end, clip.id);
  if (next.sourceStart < -EPSILON || next.sourceEnd - next.sourceStart <= EPSILON) {
    throw new OperationError(
      'invalid_range',
      `trim_clip produces invalid source range on ${op.clipId}`,
    );
  }
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = next;
  return withTrackClips(timeline, loc.trackIndex, clips);
}

function applySetClipSourceRange(timeline: Timeline, op: SetClipSourceRangeOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.sourceStart < -EPSILON || op.sourceEnd - op.sourceStart <= EPSILON) {
    throw new OperationError(
      'invalid_range',
      `set_clip_source_range produces invalid source range on ${op.clipId}`,
    );
  }
  const next: Clip = {
    ...clone(loc.clip),
    sourceStart: op.sourceStart,
    sourceEnd: op.sourceEnd,
  };
  const impliedDuration = clipTimelineDuration(next);
  const timelineDuration = next.end - next.start;
  if (impliedDuration !== null && Math.abs(impliedDuration - timelineDuration) > 1e-6) {
    throw new OperationError(
      'invalid_range',
      `set_clip_source_range would change the duration implied by ${op.clipId}'s speed`,
    );
  }
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = next;
  return withTrackClips(timeline, loc.trackIndex, clips);
}

function applySetClipMedia(timeline: Timeline, op: SetClipMediaOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.assetId.length === 0 || op.sourceStart < -EPSILON || op.sourceEnd <= op.sourceStart) {
    throw new OperationError('invalid_range', `set_clip_media is invalid for ${op.clipId}`);
  }
  const next: Clip = {
    ...clone(loc.clip),
    assetId: op.assetId,
    sourceStart: op.sourceStart,
    sourceEnd: op.sourceEnd,
  };
  const impliedDuration = clipTimelineDuration(next);
  if (impliedDuration !== null && Math.abs(impliedDuration - (next.end - next.start)) > 1e-6) {
    throw new OperationError(
      'invalid_range',
      `set_clip_media would change the duration implied by ${op.clipId}'s speed`,
    );
  }
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = next;
  return withTrackClips(timeline, loc.trackIndex, clips);
}

function applySplit(timeline: Timeline, op: SplitClipOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const { clip } = loc;
  if (op.at <= clip.start + EPSILON || op.at >= clip.end - EPSILON) {
    throw new OperationError(
      'invalid_split',
      `split point ${op.at} is not strictly inside clip ${op.clipId}`,
    );
  }
  const offset = op.at - clip.start;

  // Keyframes are clip-relative: partition by the split offset, re-base the right side.
  const leftKeyframes = clip.keyframes.filter((k) => k.time <= offset + EPSILON).map(clone);
  const rightKeyframes = clip.keyframes
    .filter((k) => k.time > offset + EPSILON)
    .map((k) => ({ ...clone(k), time: k.time - offset }));

  // Speed-aware since schema v15 (ADR 0090). The old code took the *linear*
  // fraction of the source span, which is right for a constant rate and wrong for
  // a ramp: on a clip that starts slow and ends fast, the halfway point in TIME is
  // nowhere near the halfway point in FOOTAGE, so a split placed on a gesture
  // would cut somewhere else entirely. `truncateClip` also re-bases the right
  // half's ramp, without which both halves would carry the whole original curve.
  const left: Clip = {
    ...truncateClip(clip, clip.start, op.at, clip.id),
    keyframes: leftKeyframes,
  };
  const right: Clip = {
    ...truncateClip(clip, op.at, clip.end, deriveClipId(clip.id, 'split', op.at)),
    keyframes: rightKeyframes,
  };
  const clips = loc.track.clips.slice();
  clips.splice(loc.clipIndex, 1, left, right);
  return withTrackClips(timeline, loc.trackIndex, clips);
}

function applyDeleteRange(timeline: Timeline, op: DeleteRangeOp): Timeline {
  assertPositiveRange(op.start, op.end, 'delete_range');
  const { track, index } = findTrack(timeline, op.trackId);
  const next: Clip[] = [];
  for (const clip of track.clips) {
    next.push(...subtractRange(clip, op.start, op.end));
  }
  return withTrackClips(timeline, index, next);
}

function applyRippleDelete(timeline: Timeline, op: RippleDeleteOp): Timeline {
  assertPositiveRange(op.start, op.end, 'ripple_delete');
  const { track, index } = findTrack(timeline, op.trackId);
  const gap = op.end - op.start;
  const trimmed: Clip[] = [];
  for (const clip of track.clips) {
    trimmed.push(...subtractRange(clip, op.start, op.end));
  }
  // Close the gap: every clip that starts at/after the deletion shifts left.
  const shifted = trimmed.map((clip) => {
    if (clip.start >= op.end - EPSILON) {
      return { ...clip, start: clip.start - gap, end: clip.end - gap };
    }
    return clip;
  });
  return withTrackClips(timeline, index, sortByStart(shifted));
}

/** Remove the timeline range [start, end) from a clip, returning 0–2 clips. */
function subtractRange(clip: Clip, start: Seconds, end: Seconds): Clip[] {
  const overlaps = clip.start < end - EPSILON && clip.end > start + EPSILON;
  if (!overlaps) return [clip];

  const pieces: Clip[] = [];
  // Left remainder.
  if (clip.start < start - EPSILON) {
    pieces.push(truncateClip(clip, clip.start, start, `${clip.id}__l`));
  }
  // Right remainder.
  if (clip.end > end + EPSILON) {
    pieces.push(truncateClip(clip, end, clip.end, pieces.length > 0 ? `${clip.id}__r` : clip.id));
  }
  return pieces;
}

/**
 * Re-base a speed ramp after `consumed` source seconds have been trimmed off the
 * clip's head (schema v15, ADR 0090).
 *
 * A ramp's points are anchored in **clip-relative source time**, so trimming the
 * head without re-basing would slide the whole curve along the footage — the
 * slow-motion moment you placed on a specific gesture would drift off it.
 *
 * Points now before the new origin are replaced by **one synthetic point at 0
 * carrying the rate at the cut**, not simply dropped. Dropping them would leave
 * `rateAt` holding the first *surviving* point's rate across the head of the clip,
 * which is a different rate — the trim would silently change the speed of footage
 * it did not remove.
 */
function rebaseSpeedRamp(clip: Clip, consumed: Seconds): SpeedPoint[] | undefined {
  const ramp = clip.speedRamp;
  if (!ramp || ramp.length === 0) return clip.speedRamp;
  if (Math.abs(consumed) < EPSILON) return ramp.map(clone);
  const later = ramp
    .filter((p) => p.sourceTime > consumed + EPSILON)
    .map((p) => ({ ...clone(p), sourceTime: p.sourceTime - consumed }));
  const rateAtCut = rateAt(ramp, consumed);
  const head: SpeedPoint = {
    id: `${clip.id}__ramp_head`,
    sourceTime: 0,
    rate: rateAtCut,
    // The easing of whichever segment the cut fell inside, so the surviving part
    // of that segment keeps its shape rather than reverting to linear.
    easing: [...ramp].reverse().find((p) => p.sourceTime <= consumed + EPSILON)?.easing ?? 'linear',
  };
  return [head, ...later];
}

/**
 * The **signed** source offset reached after `timelineDelta` timeline seconds from
 * the clip's own origin (schema v15, ADR 0090).
 *
 * Signed, and deliberately unclamped, because trimming is not the only caller:
 * a trim can also **extend** an edge, which is a negative head delta or a tail
 * delta past the clip's own duration. `sourceSpanForDuration` floors at zero and
 * clamps at the end of the footage — right for "how much footage fills this
 * duration", wrong for "where does this edge land".
 *
 * Outside the clip's own span the rate is **held** at the nearest end of the curve,
 * matching `rateAt`'s extrapolation rule exactly. Anything else would mean an
 * extension used a rate the curve never states.
 */
function sourceOffsetForTimeline(clip: Clip, timelineDelta: Seconds): Seconds {
  if (!hasSpeedRamp(clip)) {
    // `truncateClip` (the only caller) already returns before this function for a
    // freeze frame (`!hasSpeedRamp && speed === 0`), so `speed` here is never 0.
    const speed = clip.speed ?? 1;
    return timelineDelta * Math.abs(speed);
  }
  const ramp = clip.speedRamp!;
  if (timelineDelta < 0) return timelineDelta * rateAt(ramp, 0);
  const span = clip.sourceEnd - clip.sourceStart;
  const whole = integrateRate(ramp, 0, span);
  if (timelineDelta <= whole) return sourceTimeAt(ramp, 0, timelineDelta, span);
  return span + (timelineDelta - whole) * rateAt(ramp, span);
}

/**
 * Produce a clip spanning `[newStart, newEnd)` with its source range re-mapped
 * **through the clip's speed** (schema v15, ADR 0090).
 *
 * This replaced a 1:1 re-map that ADR 0046 flagged as a **known limitation**:
 * trimming a 2x clip's edges without rescaling the source delta breaks the
 * duration invariant, so the validator rejected an ordinary trim of a sped-up
 * clip. A ramp would have made that worse, not better — hence this landing with
 * the ramp rather than after it.
 *
 * Three cases, all routed through `speed-curve.ts` so nothing here re-derives the
 * arithmetic:
 *
 * - **Freeze** (`speed === 0`): the source range is a held frame, so it is left
 *   **untouched**. Consuming source proportionally would shrink it to nothing and
 *   make a freeze impossible to trim.
 * - **Reverse** (`speed < 0`): the clip plays `sourceEnd → sourceStart`, so
 *   trimming the timeline *head* consumes footage from the source **end**. Getting
 *   this backwards is invisible in the duration check and obvious in the picture.
 * - **Forward, constant or ramped**: the integral mapping, with the ramp re-based.
 */
function truncateClip(clip: Clip, newStart: Seconds, newEnd: Seconds, id: string): Clip {
  const base = { ...clone(clip), id, start: newStart, end: newEnd };
  const headSeconds = newStart - clip.start;
  const tailSeconds = clip.end - newEnd;
  const speed = clip.speed ?? 1;

  if (!hasSpeedRamp(clip) && speed === 0) return base;

  if (!hasSpeedRamp(clip) && speed < 0) {
    const magnitude = Math.abs(speed);
    return {
      ...base,
      sourceStart: clip.sourceStart + tailSeconds * magnitude,
      sourceEnd: clip.sourceEnd - headSeconds * magnitude,
    };
  }

  const headSource = sourceOffsetForTimeline(clip, headSeconds);
  const endSource = sourceOffsetForTimeline(clip, newEnd - clip.start);
  const next: Clip = {
    ...base,
    sourceStart: clip.sourceStart + headSource,
    sourceEnd: clip.sourceStart + endSource,
  };
  // Assigned rather than spread so an unramped clip does not grow an explicit
  // `speedRamp: undefined` key — which is deep-unequal to a clip that never had
  // one, and would make every trim of an ordinary clip fail an equality check.
  const rebased = rebaseSpeedRamp(clip, headSource);
  if (rebased !== undefined) next.speedRamp = rebased;
  return next;
}

function applyMove(timeline: Timeline, op: MoveClipOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  // Resolve the target track up front so a missing destination fails cleanly.
  const { index: destIndex } = findTrack(timeline, op.toTrackId);
  const duration = loc.clip.end - loc.clip.start;
  const moved: Clip = {
    ...clone(loc.clip),
    trackId: op.toTrackId,
    start: op.toStart,
    end: op.toStart + duration,
  };

  // Remove from the source track; track count/order is preserved so destIndex
  // stays valid (and points at the updated track for a same-track move).
  const afterRemoval = withTrackClips(
    timeline,
    loc.trackIndex,
    loc.track.clips.filter((c) => c.id !== op.clipId),
  );
  const destClips = afterRemoval.tracks[destIndex]!.clips;
  return withTrackClips(afterRemoval, destIndex, sortByStart([...destClips, moved]));
}

function applyAddClip(timeline: Timeline, op: AddClipOp): Timeline {
  assertPositiveRange(op.start, op.end, 'add_clip');
  assertPositiveRange(op.sourceStart, op.sourceEnd, 'add_clip source');
  const id = op.clipId ?? deriveClipId('clip', op.trackId, op.assetId, op.start);
  const clip: Clip = {
    id,
    assetId: op.assetId,
    trackId: op.trackId,
    start: op.start,
    end: op.end,
    sourceStart: op.sourceStart,
    sourceEnd: op.sourceEnd,
    effects: [],
    keyframes: [],
  };
  return insertClip(timeline, op.trackId, clip);
}

function applyAddTextOverlay(timeline: Timeline, op: AddTextOverlayOp): Timeline {
  assertPositiveRange(op.start, op.end, 'add_text_overlay');
  const id = op.clipId ?? deriveClipId('text', op.trackId, op.start);
  const clip: Clip = {
    id,
    assetId: TEXT_OVERLAY_ASSET_ID,
    trackId: op.trackId,
    start: op.start,
    end: op.end,
    sourceStart: 0,
    sourceEnd: op.end - op.start,
    effects: [{ id: `${id}__text`, type: 'text', params: { text: op.text }, keyframes: [] }],
    keyframes: [],
  };
  return insertClip(timeline, op.trackId, clip);
}

function applyAddCaptionLayer(timeline: Timeline, op: AddCaptionLayerOp): Timeline {
  assertPositiveRange(op.start, op.end, 'add_caption_layer');
  const id = op.clipId ?? deriveClipId('caption', op.trackId, op.start);
  const clip: Clip = {
    id,
    assetId: CAPTION_ASSET_ID,
    trackId: op.trackId,
    start: op.start,
    end: op.end,
    sourceStart: 0,
    sourceEnd: op.end - op.start,
    effects: [{ id: `${id}__caption`, type: 'caption', params: {}, keyframes: [] }],
    keyframes: [],
  };
  return insertClip(timeline, op.trackId, clip);
}

function insertClip(timeline: Timeline, trackId: string, clip: Clip): Timeline {
  const { track, index } = findTrack(timeline, trackId);
  if (track.clips.some((c) => c.id === clip.id)) {
    throw new OperationError(
      'duplicate_clip',
      `Clip id already exists on track ${trackId}: ${clip.id}`,
    );
  }
  return withTrackClips(timeline, index, sortByStart([...track.clips, clip]));
}

/**
 * Same-time tolerance for {@link AddKeyframesOp.replace} and
 * {@link RemoveKeyframesOp} target matching (seconds).
 *
 * **Exported because the UI has to agree with it.** An inspector diamond decides
 * "is there a keyframe at the playhead?" and the engine decides "does this write
 * replace one?" — if the two used different tolerances, the diamond would read empty
 * while `replace` swapped an existing keyframe, or read filled while a write stacked
 * a duplicate a fraction of a millisecond away. One constant, one answer.
 */
export const KEYFRAME_REPLACE_EPSILON = 0.001;

function applyAddKeyframes(timeline: Timeline, op: AddKeyframesOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const kept = op.replace
    ? loc.clip.keyframes.filter(
        (existing) =>
          !op.keyframes.some(
            (incoming) =>
              incoming.property === existing.property &&
              Math.abs(incoming.time - existing.time) <= KEYFRAME_REPLACE_EPSILON,
          ),
      )
    : loc.clip.keyframes;
  const next: Clip = {
    ...loc.clip,
    keyframes: [...kept, ...op.keyframes.map(clone)],
  };
  return replaceClipAt(timeline, loc, next);
}

/**
 * Drop every keyframe matching one of `op.targets` (property + optional time).
 *
 * Matching by property-and-time rather than by id — see {@link RemoveKeyframesOp}
 * for why ids are not a handle a UI can rely on. Reuses
 * `KEYFRAME_REPLACE_EPSILON` so "the keyframe at this time" means exactly the same
 * thing here as it does for `add_keyframes`' replace: the two must agree, or a
 * set-then-clear on one diamond would leave a stray keyframe a millisecond away.
 */
function applyRemoveKeyframes(timeline: Timeline, op: RemoveKeyframesOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const keyframes = loc.clip.keyframes.filter(
    (existing) =>
      !op.targets.some(
        (target) =>
          target.property === existing.property &&
          // No time on the target = clear the whole property.
          (target.time === undefined ||
            Math.abs(target.time - existing.time) <= KEYFRAME_REPLACE_EPSILON),
      ),
  );
  // Nothing matched: return the SAME timeline object, so a no-op removal cannot
  // masquerade as a change to anything comparing by reference.
  if (keyframes.length === loc.clip.keyframes.length) return timeline;
  return replaceClipAt(timeline, loc, { ...loc.clip, keyframes });
}

function applyColorGrade(timeline: Timeline, op: ApplyColorGradeOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  // Replace an existing effect with the same id rather than stacking: an
  // interactive grade panel (or re-applying a preset) updates in place, so
  // multiple color_grade effects never compound at render time. A distinct id
  // still appends, preserving additive use.
  const effects = loc.clip.effects.filter((e) => e.id !== op.effect.id);
  effects.push(clone(op.effect));
  return replaceClipAt(timeline, loc, { ...loc.clip, effects });
}

function applySetEffectParams(timeline: Timeline, op: SetEffectParamsOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const index = loc.clip.effects.findIndex((e) => e.id === op.effectId);
  if (index === -1) {
    throw new OperationError(
      'missing_effect',
      `set_effect_params references effect ${op.effectId} not on clip ${op.clipId}`,
    );
  }
  const existing = loc.clip.effects[index]!;
  // Shallow-merge the new params over the existing ones (a key set to `undefined`
  // clears it). id/type/keyframes are preserved — this edits params only.
  const mergedParams: Record<string, unknown> = { ...existing.params };
  for (const [key, value] of Object.entries(op.params)) {
    if (value === undefined) delete mergedParams[key];
    else mergedParams[key] = value;
  }
  const effects = loc.clip.effects.slice();
  effects[index] = { ...clone(existing), params: mergedParams };
  return replaceClipAt(timeline, loc, { ...loc.clip, effects });
}

function applyAdjustAudio(timeline: Timeline, op: AdjustAudioOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const prior = loc.clip.effects.find((e) => e.type === 'audio_gain');
  const effects = loc.clip.effects.filter((e) => e.type !== 'audio_gain');
  // Only persist params that were specified, so a gain-only adjust stays minimal.
  const params: Record<string, unknown> = { gainDb: op.gainDb };
  if (op.fadeInSeconds !== undefined) params.fadeInSeconds = op.fadeInSeconds;
  if (op.fadeOutSeconds !== undefined) params.fadeOutSeconds = op.fadeOutSeconds;
  if (op.fadeCurve !== undefined) params.fadeCurve = op.fadeCurve;
  if (op.muted !== undefined) params.muted = op.muted;
  if (op.normalize !== undefined) params.normalize = op.normalize;
  if (op.duckUnderTrackId !== undefined) params.duckUnderTrackId = op.duckUnderTrackId;
  if (op.duckAmountDb !== undefined) params.duckAmountDb = op.duckAmountDb;
  // EQ, compression, and the automation lane are CARRIED FORWARD when the op does
  // not mention them, unlike the fields above.
  //
  // The asymmetry is deliberate and it is the difference between a mix setting and
  // a processor. `adjust_audio` has always been the "set the level" verb, and the
  // gain-only tool emits exactly `{clipId, gainDb}` — so rebuilding the effect from
  // the op alone meant "lower this clip 3 dB" silently deleted an EQ, a compressor,
  // and a level ride authored moments earlier by `professional_audio`, with the
  // patch reporting success and the loss visible only on playback. An omitted
  // processor is not an instruction to remove one.
  //
  // Removal stays expressible, by saying so: an empty `eq.bands` or an empty
  // `automation.points` clears that processor.
  const priorParams = prior?.params ?? {};
  if (op.eq !== undefined) {
    if (op.eq.bands.length > 0) params.eq = { bands: op.eq.bands.map((band) => ({ ...band })) };
  } else if (priorParams.eq !== undefined) {
    params.eq = priorParams.eq;
  }
  if (op.dynamics !== undefined) params.dynamics = { ...op.dynamics };
  else if (priorParams.dynamics !== undefined) params.dynamics = priorParams.dynamics;
  // The automation lane is stored as keyframes on this same effect rather than as
  // another params array: `Effect.keyframes` is already the schema's lane shape,
  // with the easing vocabulary and the evaluator both runtimes share. A parallel
  // list of points would be a second curve format to keep in sync with it.
  const automation = op.automation;
  const keyframes: Keyframe[] =
    automation === undefined
      ? (prior?.keyframes.map((keyframe) => ({ ...keyframe })) ?? [])
      : automation.points.map((point) => ({
          id: `${op.clipId}__${automation.property}__${String(
            Math.round(point.timeSeconds * 1000),
          )}`,
          time: point.timeSeconds,
          property: automation.property,
          value: point.value,
          easing: (point.easing ?? 'linear') as Keyframe['easing'],
        }));
  effects.push({ id: `${op.clipId}__gain`, type: 'audio_gain', params, keyframes });
  return replaceClipAt(timeline, loc, { ...loc.clip, effects });
}

function applyAddTransition(timeline: Timeline, op: AddTransitionOp): Timeline {
  if (op.durationSeconds <= EPSILON) {
    throw new OperationError('invalid_range', `add_transition needs a positive duration`);
  }
  // A transition treats a CUT, not a clip. Until now this stamped its effect
  // onto whatever `toClipId` named, so a transition "at the narrative pivot" —
  // a moment in the middle of a continuous clip, with no edit point at all —
  // applied cleanly, reported success, and rendered nothing. Refusing here means
  // a transition that cannot exist can no longer be claimed as added.
  // Handle availability against real asset durations is checked at the layer
  // that has the asset list (the AI verify tools); here we enforce what the
  // timeline alone proves — that a cut exists between these two clips, in this
  // order, on this track.
  const eligibility = transitionEligibility(timeline, {
    fromClipId: op.fromClipId,
    toClipId: op.toClipId,
    durationSeconds: op.durationSeconds,
    kind: op.kind,
  });
  if (!eligibility.ok) {
    throw new OperationError('invalid_transition', `add_transition: ${eligibility.detail}`);
  }
  // Apply the duration the CUT can carry, not the one that was asked for.
  // `transitionEligibility` deliberately clamps rather than refuses (a half-second
  // dissolve requested at a 0.4s cut means "dissolve here", not "fail"), but until
  // now that clamp was computed and thrown away: the effect was written with the
  // requested duration and `transitionOverlapChecks` then rejected the whole patch.
  // The visible symptom was that short clips — silence-removal output, b-roll
  // stingers, anything under twice the default 0.5s transition — could not take a
  // transition at all, from the UI, the AI, or MCP alike. Honouring the clamp here
  // is what makes "a transition of any duration" true at every entry point.
  const durationSeconds = eligibility.durationSeconds;
  const alignment = op.alignment ?? DEFAULT_TRANSITION_ALIGNMENT;
  const { outSeconds } = transitionWindow(alignment, durationSeconds);
  const shared: Record<string, unknown> = {
    kind: op.kind,
    durationSeconds,
  };
  // `alignment` is only written when it is not the historical default, so a
  // start-aligned transition serializes to exactly the params it always did and a
  // project file does not change shape for a feature it does not use.
  if (alignment !== DEFAULT_TRANSITION_ALIGNMENT) shared.alignment = alignment;

  const inEffect: Effect = {
    id: transitionEffectId(op.toClipId),
    type: TRANSITION_EFFECT_TYPE,
    params: { ...shared, fromClipId: op.fromClipId },
    keyframes: [],
  };
  // Idempotent by transition id (one transition per incoming clip, id
  // `${toClipId}__transition`): re-adding — e.g. a UI duration-resize or kind
  // swap — replaces in place rather than stacking duplicate transition effects.
  // Mirrors apply_color_grade's replace-by-id precedent.
  const inLoc = findClip(timeline, op.toClipId);
  const withIn = replaceClipAt(timeline, inLoc, {
    ...inLoc.clip,
    effects: [...inLoc.clip.effects.filter((e) => e.id !== inEffect.id), inEffect],
  });

  // The outgoing half exists only when the alignment puts ramp before the cut.
  // Rewriting the same transition to `start` therefore has to REMOVE it, which is
  // why this branch clears unconditionally before deciding whether to add.
  const outLoc = findClip(withIn, op.fromClipId);
  const outId = transitionOutEffectId(op.fromClipId);
  const outEffects = outLoc.clip.effects.filter((e) => e.id !== outId);
  if (outSeconds > EPSILON) {
    outEffects.push({
      id: outId,
      type: TRANSITION_OUT_EFFECT_TYPE,
      params: { ...shared, toClipId: op.toClipId },
      keyframes: [],
    });
  }
  return replaceClipAt(withIn, outLoc, { ...outLoc.clip, effects: outEffects });
}

function applyAddMask(timeline: Timeline, op: AddMaskOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const params: Record<string, unknown> = { shape: op.shape };
  if (op.bounds) params.bounds = op.bounds;
  if (op.points) params.points = op.points;
  if (op.feather !== undefined) params.feather = op.feather;
  if (op.opacity !== undefined) params.opacity = op.opacity;
  if (op.invert !== undefined) params.invert = op.invert;
  const effect: Effect = {
    id: `${op.clipId}__mask`,
    type: 'mask',
    params,
    keyframes: op.keyframes ? op.keyframes.map(clone) : [],
  };
  return replaceClipAt(timeline, loc, {
    ...loc.clip,
    effects: [...loc.clip.effects.filter((candidate) => candidate.id !== effect.id), effect],
  });
}

function applyTrackObject(timeline: Timeline, op: TrackObjectOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const params: Record<string, unknown> = { target: op.target };
  if (op.region) params.region = op.region;
  if (op.engine) params.engine = op.engine;
  const effect: Effect = {
    id: `${op.clipId}__track`,
    type: 'object_track',
    params,
    keyframes: op.keyframes ? op.keyframes.map(clone) : [],
  };
  return replaceClipAt(timeline, loc, {
    ...loc.clip,
    effects: [...loc.clip.effects.filter((candidate) => candidate.id !== effect.id), effect],
  });
}

function applyRestoreClips(timeline: Timeline, op: RestoreClipsOp): Timeline {
  const { index } = findTrack(timeline, op.trackId);
  return withTrackClips(timeline, index, op.clips.map(clone));
}

function applyAddLayer(timeline: Timeline, op: AddLayerOp): Timeline {
  if (timeline.tracks.some((t) => t.id === op.layerId)) {
    throw new OperationError('duplicate_layer', `Layer id already exists: ${op.layerId}`);
  }
  // Clamp the insertion index into [0, length] so an out-of-range z-order slot
  // appends rather than throwing (index 0 = visual front).
  const at = Math.max(0, Math.min(timeline.tracks.length, op.atIndex));
  const layer: Track = { id: op.layerId, type: op.layerType, clips: (op.clips ?? []).map(clone) };
  const tracks = timeline.tracks.slice();
  tracks.splice(at, 0, layer);
  return { ...timeline, tracks };
}

function applyRemoveLayer(timeline: Timeline, op: RemoveLayerOp): Timeline {
  const { index } = findTrack(timeline, op.layerId);
  const tracks = timeline.tracks.slice();
  tracks.splice(index, 1);
  return { ...timeline, tracks };
}

function applyMoveLayer(timeline: Timeline, op: MoveLayerOp): Timeline {
  const { index: from } = findTrack(timeline, op.layerId);
  const tracks = timeline.tracks.slice();
  const [layer] = tracks.splice(from, 1);
  // Clamp into [0, length] after removal so an out-of-range slot lands at an edge.
  const to = Math.max(0, Math.min(tracks.length, op.toIndex));
  tracks.splice(to, 0, layer!);
  return { ...timeline, tracks };
}

// ---------------------------------------------------------------------------
// Effect-layer apply (schema v13, ADR 0088)
// ---------------------------------------------------------------------------

/** The track carrying `layerId`, plus the layer and its index on that track. */
interface EffectLayerLocation {
  readonly track: Track;
  readonly trackIndex: number;
  readonly layer: EffectLayer;
  readonly layerIndex: number;
}

const findEffectLayer = (timeline: Timeline, layerId: string): EffectLayerLocation => {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex += 1) {
    const track = timeline.tracks[trackIndex] as Track;
    const layers = effectLayersOf(track);
    const layerIndex = layers.findIndex((l) => l.id === layerId);
    if (layerIndex !== -1) {
      return { track, trackIndex, layer: layers[layerIndex] as EffectLayer, layerIndex };
    }
  }
  throw new OperationError('missing_effect', `Effect layer not found: ${layerId}`);
};

/**
 * Rebuild one track with a new effect-layer list, kept sorted by `start`.
 *
 * Sorting on write rather than on read is deliberate: `activeEffectLayersAt` also
 * sorts, but persisting in order means the serialized project reads in timeline
 * order for a human, and the timeline UI can render the lane without a sort per
 * frame.
 *
 * An empty result DELETES the key rather than storing `[]`, matching how
 * `set_track_flags` canonicalizes "off" as absent — so removing the last effect
 * from a track lands on a timeline deep-equal to the one before it was added,
 * which is the reversibility contract.
 */
const withEffectLayers = (
  timeline: Timeline,
  trackIndex: number,
  layers: readonly EffectLayer[],
): Timeline => {
  const track = timeline.tracks[trackIndex] as Track;
  const next: Track = { ...track };
  if (layers.length === 0) delete next.effectLayers;
  else next.effectLayers = [...layers].sort((a, b) => a.start - b.start);
  const tracks = timeline.tracks.slice();
  tracks[trackIndex] = next;
  return { ...timeline, tracks };
};

function applyAddEffectLayer(timeline: Timeline, op: AddEffectLayerOp): Timeline {
  const { track, index } = findTrack(timeline, op.trackId);
  if (track.type !== 'effect') {
    throw new OperationError(
      'invalid_track',
      `add_effect_layer targets track '${op.trackId}' of type '${track.type}'; effect layers ` +
        `live only on 'effect' tracks.`,
    );
  }
  // Parse rather than clone so schema defaults (`params`, `keyframes`) are filled
  // in — a layer authored without them must persist canonically, not with missing
  // keys, or it would not round-trip through the project file unchanged.
  const parsed = EffectLayerSchema.safeParse(op.layer);
  if (!parsed.success) {
    throw new OperationError(
      'invalid_effect_layer',
      `add_effect_layer received an invalid layer: ${parsed.error.message}`,
    );
  }
  const layers = effectLayersOf(track);
  if (layers.some((l) => l.id === parsed.data.id)) {
    throw new OperationError(
      'duplicate_effect_layer',
      `Effect layer id already exists on track '${op.trackId}': ${parsed.data.id}`,
    );
  }
  return withEffectLayers(timeline, index, [...layers, parsed.data]);
}

function applyRemoveEffectLayer(timeline: Timeline, op: RemoveEffectLayerOp): Timeline {
  const { trackIndex, layerIndex, track } = findEffectLayer(timeline, op.layerId);
  const layers = effectLayersOf(track).slice();
  layers.splice(layerIndex, 1);
  return withEffectLayers(timeline, trackIndex, layers);
}

function applyMoveEffectLayer(timeline: Timeline, op: MoveEffectLayerOp): Timeline {
  const loc = findEffectLayer(timeline, op.layerId);
  if (op.toStart < 0) {
    throw new OperationError(
      'invalid_range',
      `move_effect_layer would put '${op.layerId}' at a negative start (${op.toStart}).`,
    );
  }
  // Duration is preserved — this is a move, not a trim.
  const duration = loc.layer.end - loc.layer.start;
  const moved: EffectLayer = { ...clone(loc.layer), start: op.toStart, end: op.toStart + duration };

  const targetTrackId = op.toTrackId ?? loc.track.id;
  if (targetTrackId === loc.track.id) {
    const layers = effectLayersOf(loc.track).slice();
    layers[loc.layerIndex] = moved;
    return withEffectLayers(timeline, loc.trackIndex, layers);
  }

  const { track: target, index: targetIndex } = findTrack(timeline, targetTrackId);
  if (target.type !== 'effect') {
    throw new OperationError(
      'invalid_track',
      `move_effect_layer targets track '${targetTrackId}' of type '${target.type}'; effect ` +
        `layers live only on 'effect' tracks.`,
    );
  }
  // Two-step across tracks: drop from the source, then add to the destination.
  // Sequencing matters — the destination lookup must happen against the timeline
  // that still contains the source layer, or a same-id guard could misfire.
  const withoutSource = applyRemoveEffectLayer(timeline, {
    type: 'remove_effect_layer',
    layerId: op.layerId,
  });
  const destinationLayers = effectLayersOf(withoutSource.tracks[targetIndex] as Track);
  return withEffectLayers(withoutSource, targetIndex, [...destinationLayers, moved]);
}

function applyTrimEffectLayer(timeline: Timeline, op: TrimEffectLayerOp): Timeline {
  const loc = findEffectLayer(timeline, op.layerId);
  if (op.end - op.start <= EPSILON) {
    throw new OperationError(
      'invalid_range',
      `trim_effect_layer would give non-positive duration on ${op.layerId}`,
    );
  }
  if (op.start < 0) {
    throw new OperationError(
      'invalid_range',
      `trim_effect_layer would put '${op.layerId}' at a negative start (${op.start}).`,
    );
  }
  const next: EffectLayer = { ...clone(loc.layer), start: op.start, end: op.end };
  const layers = effectLayersOf(loc.track).slice();
  layers[loc.layerIndex] = next;
  return withEffectLayers(timeline, loc.trackIndex, layers);
}

function applySetEffectLayerParams(timeline: Timeline, op: SetEffectLayerParamsOp): Timeline {
  const loc = findEffectLayer(timeline, op.layerId);
  const next: EffectLayer = { ...clone(loc.layer) };

  // PARTIAL merge: a slider drag sends only the value it changed, so the rest of
  // the bag must survive. Range clamping is the validator's job (it owns the
  // catalog), not this op's — apply stays a pure structural transform.
  if (op.params !== undefined) next.params = { ...next.params, ...op.params };

  if (op.intensity !== undefined) {
    // `null` clears back to "full strength", canonicalized as absent so undo
    // lands deep-equal (same rule as `set_track_flags`).
    if (op.intensity === null) delete next.intensity;
    else next.intensity = op.intensity;
  }

  const layers = effectLayersOf(loc.track).slice();
  layers[loc.layerIndex] = next;
  return withEffectLayers(timeline, loc.trackIndex, layers);
}

function applySetEffectLayerEnabled(timeline: Timeline, op: SetEffectLayerEnabledOp): Timeline {
  const loc = findEffectLayer(timeline, op.layerId);
  const next: EffectLayer = { ...clone(loc.layer) };
  // Enabled is the default, so canonicalize it as absent.
  if (op.disabled) next.disabled = true;
  else delete next.disabled;
  const layers = effectLayersOf(loc.track).slice();
  layers[loc.layerIndex] = next;
  return withEffectLayers(timeline, loc.trackIndex, layers);
}

function applyRestoreEffectLayer(timeline: Timeline, op: RestoreEffectLayerOp): Timeline {
  const { trackIndex, layerIndex, track } = findEffectLayer(timeline, op.layer.id);
  if (track.id !== op.trackId) {
    throw new OperationError(
      'invalid_track',
      `restore_effect_layer expected layer '${op.layer.id}' on track '${op.trackId}' but found ` +
        `it on '${track.id}'.`,
    );
  }
  const layers = effectLayersOf(track).slice();
  layers[layerIndex] = clone(op.layer);
  return withEffectLayers(timeline, trackIndex, layers);
}

function applySetTrackFlags(timeline: Timeline, op: SetTrackFlagsOp): Timeline {
  const { track, index } = findTrack(timeline, op.trackId);
  const next: Track = { ...track };
  // Canonicalize "off" as *absent* (delete the key) rather than `false`. Absent
  // and `false` are equivalent to every reader, but keeping a single canonical
  // form means undo lands on a deep-equal timeline (the reversibility contract)
  // and unset flags never bloat the serialized project file. Only flags this op
  // actually targets (value !== undefined) are touched; clips are never touched.
  const setFlag = (flag: 'locked' | 'hidden' | 'muted', value: boolean | undefined): void => {
    if (value === undefined) return;
    if (value) next[flag] = true;
    else delete next[flag];
  };
  setFlag('locked', op.locked);
  setFlag('hidden', op.hidden);
  setFlag('muted', op.muted);
  const tracks = timeline.tracks.slice();
  tracks[index] = next;
  return { ...timeline, tracks };
}

function applySetTrackCaptionStyle(timeline: Timeline, op: SetTrackCaptionStyleOp): Timeline {
  const { track, index } = findTrack(timeline, op.trackId);
  if (op.captionStyle !== null) {
    // Same defensive re-validation as `set_caption_style` (PRD §8.5 "validate
    // before apply"): the patch validator is the primary gate, but apply never
    // trusts an unvalidated shape reaching it directly.
    const parsed = CaptionStyleSchema.safeParse(op.captionStyle);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_style',
        `set_track_caption_style received an invalid captionStyle for track '${op.trackId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Track = { ...track };
  // Canonicalize "cleared" as *absent* (delete the key), like `set_track_flags`
  // does for its flags: absent and "no default" are equivalent to every reader,
  // and a single canonical form means undo lands on a deep-equal timeline.
  if (op.captionStyle === null) delete next.captionStyle;
  else next.captionStyle = clone(op.captionStyle);
  const tracks = timeline.tracks.slice();
  tracks[index] = next;
  return { ...timeline, tracks };
}

function applySetCaptionCue(timeline: Timeline, op: SetCaptionCueOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.captionCue !== null) {
    const parsed = CaptionCueSchema.safeParse(op.captionCue);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_cue',
        `set_caption_cue received an invalid captionCue for clip '${op.clipId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Clip = { ...clone(loc.clip) };
  // Clearing restores the transcript-derived fallback (the v10 behavior), which
  // is what *absent* means — so clear by deleting, not by storing an empty cue.
  if (op.captionCue === null) {
    delete next.captionCue;
  } else {
    // Parse rather than clone so `words` picks up its schema default: a cue
    // authored without timings persists as `words: []`, not a missing key, and
    // therefore round-trips through the project file unchanged.
    next.captionCue = CaptionCueSchema.parse(clone(op.captionCue));
  }
  return replaceClipAt(timeline, loc, next);
}

function applySetCaptionStyle(timeline: Timeline, op: SetCaptionStyleOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.captionStyle !== null) {
    // Defensive re-validation (PRD §8.5 "validate before apply"): the patch
    // validator is the primary gate, but apply never trusts an unvalidated shape
    // reaching it directly (e.g. a hand-built op in a test or a future caller).
    const parsed = CaptionStyleSchema.safeParse(op.captionStyle);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_style',
        `set_caption_style received an invalid captionStyle for clip '${op.clipId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Clip = { ...clone(loc.clip) };
  if (op.captionStyle === null) {
    delete next.captionStyle;
  } else {
    next.captionStyle = clone(op.captionStyle);
  }
  return replaceClipAt(timeline, loc, next);
}

function applySetClipSpeed(timeline: Timeline, op: SetClipSpeedOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const speed = op.speed ?? 1;
  if (!Number.isFinite(speed)) {
    throw new OperationError(
      'invalid_speed',
      `set_clip_speed requires a finite speed for clip '${op.clipId}' (got ${op.speed}).`,
    );
  }
  const { clip } = loc;
  const sourceDuration = clip.sourceEnd - clip.sourceStart;
  const next: Clip = { ...clone(clip) };
  // Setting a constant speed clears any ramp: the two express the same thing and
  // a ramp would silently override the rate the user just chose. This is what
  // makes "back to normal speed" actually mean normal.
  delete next.speedRamp;
  // Schema v15 (ADR 0090): 0 is a freeze frame, and there is no duration to
  // derive from a division by zero. The clip keeps the timeline span it had —
  // holding a frame for the length it already occupied is the only answer that
  // does not invent a number, and the UI sets the span explicitly afterwards.
  if (speed !== 0) next.end = clip.start + sourceDuration / Math.abs(speed);
  // Canonicalize 1x as *absent* (like set_track_flags canonicalizes "off"): a
  // reset lands on a deep-equal timeline to a clip that never had a speed set.
  if (Math.abs(speed - 1) <= EPSILON) delete next.speed;
  else next.speed = speed;
  return replaceClipAt(timeline, loc, next);
}

/**
 * Replace a clip's speed **curve** and re-derive its timeline duration from the
 * integral of the reciprocal rate (schema v15, ADR 0090).
 *
 * Same shape and same inverse strategy as `set_clip_speed` — the op carries the
 * whole ramp, so `invertOperation` returns a `set_clip_speed_ramp` holding the
 * prior one. Nothing here needs a `restore_clips` snapshot because the clip's
 * *source* range is untouched: re-applying the prior ramp deterministically
 * recomputes the prior `end` too.
 *
 * `ramp: null` (or an empty array) clears the curve back to constant speed.
 */
/**
 * The exact inverse of any speed change — constant or curve (ADR 0090).
 *
 * Shared by `set_clip_speed` and `set_clip_speed_ramp` because the two are one
 * axis: each clears the other, so undoing either has to restore whichever of the
 * two the clip actually had. Two separate inverses would each restore only their
 * own half, and a ramp undone through `set_clip_speed` would come back as a
 * constant rate — a silent loss of the whole curve.
 *
 * **A prior FREEZE inverts through `restore_clips`, not through the same-shape
 * op.** ADR 0046's same-shape inverse works because re-applying the prior speed
 * recomputes the prior `end` deterministically. At `speed === 0` there is no
 * duration to recompute — a held frame's length is set, not derived — so
 * `set_clip_speed(0)` would leave whatever `end` the *undone* speed produced.
 * The track snapshot is the established answer for a lossy op here
 * (`delete_range`, `ripple_delete`, `remove_keyframes` all use it).
 */
function invertSpeedChange(timelineBefore: Timeline, clipId: string): Operation[] {
  const { clip, track } = findClip(timelineBefore, clipId);
  if (clip.speed === 0) {
    return [{ type: 'restore_clips', trackId: track.id, clips: track.clips.map(clone) }];
  }
  if (hasSpeedRamp(clip)) {
    // `hasSpeedRamp` above already guarantees a non-empty array.
    return [{ type: 'set_clip_speed_ramp', clipId, ramp: clip.speedRamp!.map(clone) }];
  }
  return [
    { type: 'set_clip_speed_ramp', clipId, ramp: null },
    { type: 'set_clip_speed', clipId, speed: clip.speed ?? null },
  ];
}

function applySetClipSpeedRamp(timeline: Timeline, op: SetClipSpeedRampOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  const { clip } = loc;
  const points = op.ramp ?? [];
  for (const point of points) {
    // Defensive re-validation, matching `set_clip_crop`'s precedent: the patch
    // validator is the primary gate, but apply never trusts an unvalidated shape
    // reaching it directly. A non-positive rate is the one that matters — it makes
    // the integral divergent or the mapping non-invertible, so it must never reach
    // the render.
    const parsed = SpeedPointSchema.safeParse(point);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_speed',
        `set_clip_speed_ramp received an invalid point for clip '${op.clipId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Clip = { ...clone(clip) };
  if (points.length === 0) {
    delete next.speedRamp;
  } else {
    next.speedRamp = points.map(clone);
    // A ramp overrides the constant rate entirely; leaving a stale `speed` behind
    // would make the clip's stored data claim two different rates.
    delete next.speed;
  }
  const duration = clipTimelineDuration(next);
  if (duration !== null) next.end = clip.start + duration;
  return replaceClipAt(timeline, loc, next);
}

function applySetClipCrop(timeline: Timeline, op: SetClipCropOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.crop !== null) {
    // Defensive re-validation (PRD §8.5 "validate before apply"): the patch
    // validator is the primary gate, but apply never trusts an unvalidated shape
    // reaching it directly (e.g. a hand-built op in a test or a future caller).
    // This also catches out-of-bounds/zero/negative rects via `CropRectSchema`'s
    // own `.refine()`s (right/bottom edge <= 1, positive width/height).
    const parsed = CropRectSchema.safeParse(op.crop);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_crop',
        `set_clip_crop received an invalid crop rect for clip '${op.clipId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Clip = { ...clone(loc.clip) };
  if (op.crop === null) {
    delete next.crop;
  } else {
    next.crop = clone(op.crop);
  }
  return replaceClipAt(timeline, loc, next);
}

function applySetClipBlendMode(timeline: Timeline, op: SetClipBlendModeOp): Timeline {
  const loc = findClip(timeline, op.clipId);
  if (op.blendMode !== null) {
    // Defensive re-validation (PRD §8.5 "validate before apply"): the patch
    // validator is the primary gate, but apply never trusts an unvalidated shape
    // reaching it directly (e.g. a hand-built op in a test or a future caller).
    const parsed = BlendModeSchema.safeParse(op.blendMode);
    if (!parsed.success) {
      throw new OperationError(
        'invalid_blend_mode',
        `set_clip_blend_mode received an invalid blend mode for clip '${op.clipId}': ${parsed.error.message}`,
      );
    }
  }
  const next: Clip = { ...clone(loc.clip) };
  // Canonicalize 'normal' (and null) as *absent* (like set_clip_speed
  // canonicalizes 1x): a reset lands on a deep-equal timeline to a clip that
  // never had a blend mode set.
  if (op.blendMode === null || op.blendMode === 'normal') delete next.blendMode;
  else next.blendMode = op.blendMode;
  return replaceClipAt(timeline, loc, next);
}

function replaceClipAt(timeline: Timeline, loc: ClipLocation, next: Clip): Timeline {
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = next;
  return withTrackClips(timeline, loc.trackIndex, clips);
}

function assertPositiveRange(start: Seconds, end: Seconds, label: string): void {
  if (end - start <= EPSILON) {
    throw new OperationError(
      'invalid_range',
      `${label}: end must be greater than start (${start} → ${end})`,
    );
  }
}

// ---------------------------------------------------------------------------
// invert
// ---------------------------------------------------------------------------

/**
 * Compute the operation(s) that undo `op` against `timelineBefore` (the state
 * the operation was/will be applied to). See the module header for the design.
 *
 * @param timelineBefore - The timeline state before `op` is applied.
 * @param op - The operation to invert.
 * @returns Operations that, applied in order, restore `timelineBefore`.
 * @throws {OperationError} when `op` references entities missing from `timelineBefore`.
 */
export function invertOperation(timelineBefore: Timeline, op: Operation): Operation[] {
  switch (op.type) {
    case 'trim_clip': {
      const { clip } = findClip(timelineBefore, op.clipId);
      return [{ type: 'trim_clip', clipId: op.clipId, start: clip.start, end: clip.end }];
    }
    case 'set_clip_source_range': {
      const { clip } = findClip(timelineBefore, op.clipId);
      return [
        {
          type: 'set_clip_source_range',
          clipId: op.clipId,
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
        },
      ];
    }
    case 'set_clip_media': {
      const { clip } = findClip(timelineBefore, op.clipId);
      return [
        {
          type: 'set_clip_media',
          clipId: clip.id,
          assetId: clip.assetId,
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
        },
      ];
    }
    case 'move_clip': {
      const { clip } = findClip(timelineBefore, op.clipId);
      return [
        { type: 'move_clip', clipId: op.clipId, toTrackId: clip.trackId, toStart: clip.start },
      ];
    }
    case 'set_track_flags': {
      // Same-shape inverse: restore the prior value of exactly the flags this op
      // touched (treating an absent flag as its `false` default).
      const { track } = findTrack(timelineBefore, op.trackId);
      return [
        {
          type: 'set_track_flags',
          trackId: op.trackId,
          ...(op.locked !== undefined ? { locked: track.locked ?? false } : {}),
          ...(op.hidden !== undefined ? { hidden: track.hidden ?? false } : {}),
          ...(op.muted !== undefined ? { muted: track.muted ?? false } : {}),
        },
      ];
    }
    // Single-track ops → restore that track's prior clip snapshot.
    case 'split_clip':
    case 'add_keyframes':
    case 'remove_keyframes':
    case 'apply_color_grade':
    case 'set_effect_params':
    case 'adjust_audio':
    case 'add_mask':
    case 'track_object':
      return [restoreFor(findClip(timelineBefore, op.clipId).track)];
    case 'add_transition':
      return [restoreFor(findClip(timelineBefore, op.toClipId).track)];
    case 'add_layer':
      // Undo an insert by removing the layer it created.
      return [{ type: 'remove_layer', layerId: op.layerId }];
    case 'remove_layer': {
      // Lossless: re-insert the removed layer at its prior z-order with its clips
      // AND its effect layers.
      //
      // `add_layer` cannot carry effect layers (it predates them and adding a
      // field would change its shape for every caller), so the effects are
      // restored by replaying an `add_effect_layer` per layer after the track
      // exists again. Without this, deleting an effect lane and undoing it
      // silently dropped every effect on it — the track came back empty.
      const { track, index } = findTrack(timelineBefore, op.layerId);
      return [
        {
          type: 'add_layer',
          layerId: track.id,
          layerType: track.type,
          atIndex: index,
          clips: track.clips.map(clone),
        },
        ...effectLayersOf(track).map(
          (layer): AddEffectLayerOp => ({
            type: 'add_effect_layer',
            trackId: track.id,
            layer: clone(layer),
          }),
        ),
      ];
    }
    case 'add_effect_layer':
      // Undo an add by removing exactly the layer it created.
      return [{ type: 'remove_effect_layer', layerId: op.layer.id }];
    case 'remove_effect_layer': {
      // Lossless: put the whole layer back on the track it came from.
      const { track, layer } = findEffectLayer(timelineBefore, op.layerId);
      return [{ type: 'add_effect_layer', trackId: track.id, layer: clone(layer) }];
    }
    case 'move_effect_layer': {
      // Same-shape inverse: move back to the prior start, naming the prior track
      // explicitly so a cross-track move returns to the lane it left.
      const { track, layer } = findEffectLayer(timelineBefore, op.layerId);
      return [
        {
          type: 'move_effect_layer',
          layerId: op.layerId,
          toStart: layer.start,
          toTrackId: track.id,
        },
      ];
    }
    case 'trim_effect_layer': {
      const { layer } = findEffectLayer(timelineBefore, op.layerId);
      return [
        { type: 'trim_effect_layer', layerId: op.layerId, start: layer.start, end: layer.end },
      ];
    }
    case 'set_effect_layer_params': {
      // Wholesale restore, NOT a same-shape inverse: the forward op merges
      // partially, so a params bag carrying the old values would merge back over
      // the new ones and leave any newly-introduced key in place. See
      // `RestoreEffectLayerOp`.
      const { track, layer } = findEffectLayer(timelineBefore, op.layerId);
      return [{ type: 'restore_effect_layer', trackId: track.id, layer: clone(layer) }];
    }
    case 'set_effect_layer_enabled': {
      const { layer } = findEffectLayer(timelineBefore, op.layerId);
      return [
        {
          type: 'set_effect_layer_enabled',
          layerId: op.layerId,
          disabled: layer.disabled ?? false,
        },
      ];
    }
    case 'move_layer': {
      // Same-shape inverse: move the layer back to the index it occupied before.
      const { index } = findTrack(timelineBefore, op.layerId);
      return [{ type: 'move_layer', layerId: op.layerId, toIndex: index }];
    }
    case 'set_caption_style': {
      // Same-shape inverse: restore the clip's prior style wholesale (`null` when
      // it had none), exactly like `set_track_flags` restores its prior flags.
      const { clip } = findClip(timelineBefore, op.clipId);
      return [
        { type: 'set_caption_style', clipId: op.clipId, captionStyle: clip.captionStyle ?? null },
      ];
    }
    case 'set_track_caption_style': {
      // Same-shape inverse: restore the track's prior caption default (`null` when
      // it had none). This is what makes a track-wide restyle — one operation
      // affecting every cue — a single undo.
      const { track } = findTrack(timelineBefore, op.trackId);
      return [
        {
          type: 'set_track_caption_style',
          trackId: op.trackId,
          captionStyle: track.captionStyle ?? null,
        },
      ];
    }
    case 'set_caption_cue': {
      // Same-shape inverse: restore the clip's prior cue (`null` when it had
      // none, which restores the transcript-derived fallback). An edited caption
      // is therefore undoable like any other manual edit.
      const { clip } = findClip(timelineBefore, op.clipId);
      return [{ type: 'set_caption_cue', clipId: op.clipId, captionCue: clip.captionCue ?? null }];
    }
    case 'set_clip_speed':
    case 'set_clip_speed_ramp':
      return invertSpeedChange(timelineBefore, op.clipId);
    case 'set_clip_crop': {
      // Same-shape inverse: restore the clip's prior crop wholesale (`null`
      // when it had none), exactly like `set_caption_style`/`set_clip_speed`.
      const { clip } = findClip(timelineBefore, op.clipId);
      return [{ type: 'set_clip_crop', clipId: op.clipId, crop: clip.crop ?? null }];
    }
    case 'set_clip_blend_mode': {
      // Same-shape inverse: restore the clip's prior blend mode wholesale
      // (`null` when it had none/'normal'), exactly like `set_clip_crop`/
      // `set_clip_speed`.
      const { clip } = findClip(timelineBefore, op.clipId);
      return [
        { type: 'set_clip_blend_mode', clipId: op.clipId, blendMode: clip.blendMode ?? null },
      ];
    }
    case 'delete_range':
    case 'ripple_delete':
    case 'add_clip':
    case 'add_text_overlay':
    case 'add_caption_layer':
    case 'restore_clips':
      return [restoreFor(findTrack(timelineBefore, op.trackId).track)];
    case 'restore_effect_layer': {
      // Self-inverse in shape: snapshot the layer as it stands now, so redoing a
      // restore is itself undoable (history replays both directions).
      const { track, layer } = findEffectLayer(timelineBefore, op.layer.id);
      return [{ type: 'restore_effect_layer', trackId: track.id, layer: clone(layer) }];
    }
  }
}

const restoreFor = (track: Track): RestoreClipsOp => ({
  type: 'restore_clips',
  trackId: track.id,
  clips: track.clips.map(clone),
});
