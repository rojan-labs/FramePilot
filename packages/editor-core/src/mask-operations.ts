/**
 * Mask stack operations (schema v22, plan 10, ADR 0178).
 *
 * Every mask edit — from the Inspector, the monitor tools or the agent — is one of these
 * typed operations, applied purely and inverted exactly. They address a mask stack by its
 * OWNER: a clip (`clipId`) or an effect layer (`layerId`).
 *
 * ## Invariants every apply keeps
 *
 * - Mask ids are unique within their owner's stack.
 * - A path mask has at least three vertices and the SAME vertex count on every path
 *   keyframe; vertex insertion and removal act on all keyframes at once, at the same
 *   parametric position, so the count can never drift.
 * - Scalar and path keyframes are sorted by `sourceTime`, and no two keyframes of one
 *   property (or two path keyframes) share an instant.
 * - A mask on an effect layer is `space: 'frame'` and targets alpha.
 * - An empty stack is stored as an ABSENT `masks` key, so removing the last mask and
 *   undoing an add both land on the exact prior document.
 *
 * ## Inverses
 *
 * Where a same-shape inverse is exact and small it is used (`add_mask` ↔ `remove_mask`,
 * `move_mask_keyframe`, `reorder_masks`, `set_mask_target`, `set_mask_space`,
 * `review_mask`, tracking). Everything whose undo would have to re-create lost detail —
 * tangents adjusted by a vertex insert, a merged partial update — inverts to the internal
 * {@link RestoreMasksOp} snapshot, the same trade `restore_clips` makes for clip edits.
 *
 * Error messages name ids and a remedy and never a varying magnitude: the agent's
 * repeated-failure guard keys on message text (see `validator.ts#overlapChecks`).
 */
import {
  MaskKeyframeSchema,
  MaskLayerSchema,
  MaskPathKeyframeSchema,
  MaskPresetSchema,
  MaskReviewSchema,
  MaskTrackingSchema,
  masksOf,
  type Clip,
  type EffectLayer,
  type MaskKeyframe,
  type MaskKeyframeInput,
  type MaskKind,
  type MaskLayer,
  type MaskLayerInput,
  type MaskPathKeyframe,
  type MaskPathKeyframeInput,
  type MaskPreset,
  type MaskPresetInput,
  type MaskReviewInput,
  type MaskScalarProperty,
  type MaskSpace,
  type MaskTarget,
  type MaskTrackingInput,
  type Timeline,
  type Track,
} from '@framepilot/timeline-schema';
import { MASK_PATH_STRIDE } from './mask-geometry.js';

// ---------------------------------------------------------------------------
// Operation shapes
// ---------------------------------------------------------------------------

/** The stack an operation edits: a clip's, or an effect layer's. Exactly one id is set. */
export type MaskOwnerRef =
  | { readonly clipId: string; readonly layerId?: undefined }
  | { readonly layerId: string; readonly clipId?: undefined };

/** Add one mask to a clip's stack (top = index 0; absent index appends at the bottom). */
export interface AddMaskOp {
  readonly type: 'add_mask';
  readonly clipId: string;
  readonly mask: MaskLayerInput;
  readonly index?: number;
}

/** Add one frame-space mask to an effect layer (adjustment lane). */
export interface AddEffectLayerMaskOp {
  readonly type: 'add_effect_layer_mask';
  readonly layerId: string;
  readonly mask: MaskLayerInput;
  readonly index?: number;
}

export type RemoveMaskOp = MaskOwnerRef & {
  readonly type: 'remove_mask';
  readonly maskId: string;
};

/**
 * Change a mask's scalar fields (name, colour, mode, opacity, feathers, geometry, a
 * matte's artifact/prompts/review, a key's ranges, …). Structural fields have their own
 * operations and are refused here: {@link MASK_UPDATE_FORBIDDEN_FIELDS}.
 */
export type UpdateMaskOp = MaskOwnerRef & {
  readonly type: 'update_mask';
  readonly maskId: string;
  readonly changes: Readonly<Record<string, unknown>>;
  /**
   * "Apply to all keyframes" (Premiere 26.0 clip edit mode, plan 12 §E): add this offset to
   * EVERY keyframe of each named property, so one edit changes a feather or a position across
   * the whole animation instead of keying the current instant. Values are clamped to the
   * property's range. Properties without keyframes are untouched by this field.
   */
  readonly keyframeOffsets?: Readonly<Partial<Record<MaskScalarProperty, number>>>;
};

/** Insert or replace (by id) one whole-path keyframe of a path mask. */
export type SetMaskPathOp = MaskOwnerRef & {
  readonly type: 'set_mask_path';
  readonly maskId: string;
  readonly keyframe: MaskPathKeyframeInput;
};

export type AddMaskKeyframeOp = MaskOwnerRef & {
  readonly type: 'add_mask_keyframe';
  readonly maskId: string;
  readonly keyframe: MaskKeyframeInput;
};

/** Remove a scalar or path keyframe by id. */
export type RemoveMaskKeyframeOp = MaskOwnerRef & {
  readonly type: 'remove_mask_keyframe';
  readonly maskId: string;
  readonly keyframeId: string;
};

/** Move a scalar or path keyframe to another source instant. */
export type MoveMaskKeyframeOp = MaskOwnerRef & {
  readonly type: 'move_mask_keyframe';
  readonly maskId: string;
  readonly keyframeId: string;
  readonly sourceTime: number;
};

/**
 * Split segment `segment` (vertex `segment` → the next vertex, wrapping) at parametric
 * position `t` on EVERY path keyframe, preserving each keyframe's curve exactly.
 */
export type InsertMaskVertexOp = MaskOwnerRef & {
  readonly type: 'insert_mask_vertex';
  readonly maskId: string;
  readonly segment: number;
  readonly t: number;
};

/** Remove vertex `vertex` from every path keyframe. */
export type RemoveMaskVertexOp = MaskOwnerRef & {
  readonly type: 'remove_mask_vertex';
  readonly maskId: string;
  readonly vertex: number;
};

/** Reorder a stack: `maskIds` must be a permutation of the current ids, top first. */
export type ReorderMasksOp = MaskOwnerRef & {
  readonly type: 'reorder_masks';
  readonly maskIds: readonly string[];
};

export type SetMaskTargetOp = MaskOwnerRef & {
  readonly type: 'set_mask_target';
  readonly maskId: string;
  readonly target: MaskTarget;
};

export type ApplyMaskTrackingOp = MaskOwnerRef & {
  readonly type: 'apply_mask_tracking';
  readonly maskId: string;
  readonly tracking: MaskTrackingInput;
};

export type ClearMaskTrackingOp = MaskOwnerRef & {
  readonly type: 'clear_mask_tracking';
  readonly maskId: string;
};

/**
 * Drive another mask with the transform track a mask already carries.
 *
 * Driving a TEXT or OVERLAY clip's transform from a track needs a place on the clip to
 * record it, which schema v22 does not add; that half lands with MK7.6.
 */
export interface UseTrackOp {
  readonly type: 'use_track';
  readonly fromClipId: string;
  readonly fromMaskId: string;
  readonly to: MaskOwnerRef & { readonly maskId: string };
}

export type SetMaskSpaceOp = MaskOwnerRef & {
  readonly type: 'set_mask_space';
  readonly maskId: string;
  readonly space: MaskSpace;
};

/** Replace the review state of a matte (`subject: 'matte'`) or of a mask's track. */
export type ReviewMaskOp = MaskOwnerRef & {
  readonly type: 'review_mask';
  readonly maskId: string;
  readonly subject: 'matte' | 'tracking';
  readonly review: MaskReviewInput;
};

/**
 * Paste masks copied from another clip.
 *
 * Source-space geometry is scaled from the source picture to this clip's by normalised
 * coordinates, and keyframe instants keep their offset from the clip's in-point. Sizes
 * are carried on the operation because a timeline does not know media sizes.
 */
export interface PasteMasksOp {
  readonly type: 'paste_masks';
  readonly clipId: string;
  readonly masks: readonly MaskLayerInput[];
  readonly from: {
    readonly assetId: string;
    readonly width: number;
    readonly height: number;
    readonly sourceStart: number;
  };
  readonly to: { readonly width: number; readonly height: number };
  /** Ids for the pasted masks, in order; absent entries derive a free id. */
  readonly ids?: readonly string[];
}

/**
 * Put text between a subject and its background: duplicate the clip onto a new (muted)
 * track in front, MOVE the clip's subject matte onto the copy, and place a text clip on a
 * new track between the two.
 */
export interface AddTextBehindSubjectOp {
  readonly type: 'add_text_behind_subject';
  readonly clipId: string;
  readonly text: string;
  /** Extra `text` effect params (font, size, colour, position). */
  readonly style?: Readonly<Record<string, unknown>>;
  /** The matte to move; absent ⇒ the first enabled alpha-target matte on the clip. */
  readonly maskId?: string;
  readonly subjectTrackId?: string;
  readonly textTrackId?: string;
  readonly subjectClipId?: string;
  readonly textClipId?: string;
  /**
   * When the title is on screen, in timeline seconds; each defaults to the clip's own edge.
   *
   * A title behind someone is a moment — the hook, a key line — not a watermark: the
   * captured 2026-09-23 run put "MOTION" behind the speaker for all 49.8 s and then had to
   * trim it in a second step.
   */
  readonly start?: number;
  readonly end?: number;
}

/** Save masks as a project preset (schema v23, MK4.3). Refuses an id already in use. */
export interface SaveMaskPresetOp {
  readonly type: 'save_mask_preset';
  readonly preset: MaskPresetInput;
}

/** Delete a project mask preset by id. */
export interface RemoveMaskPresetOp {
  readonly type: 'remove_mask_preset';
  readonly presetId: string;
}

/** Internal inverse primitive: replace the project's presets with a prior snapshot. */
export interface RestoreMaskPresetsOp {
  readonly type: 'restore_mask_presets';
  readonly presets: readonly MaskPreset[];
}

/**
 * Internal inverse primitive: replace a whole mask stack with a prior snapshot. Produced
 * only by {@link invertMaskOperation}, mirroring `restore_clips`.
 */
export type RestoreMasksOp = MaskOwnerRef & {
  readonly type: 'restore_masks';
  readonly masks: readonly MaskLayer[];
};

export type MaskOperation =
  | AddMaskOp
  | AddEffectLayerMaskOp
  | RemoveMaskOp
  | UpdateMaskOp
  | SetMaskPathOp
  | AddMaskKeyframeOp
  | RemoveMaskKeyframeOp
  | MoveMaskKeyframeOp
  | InsertMaskVertexOp
  | RemoveMaskVertexOp
  | ReorderMasksOp
  | SetMaskTargetOp
  | ApplyMaskTrackingOp
  | ClearMaskTrackingOp
  | UseTrackOp
  | SetMaskSpaceOp
  | ReviewMaskOp
  | PasteMasksOp
  | AddTextBehindSubjectOp
  | SaveMaskPresetOp
  | RemoveMaskPresetOp
  | RestoreMaskPresetsOp
  | RestoreMasksOp;

export type MaskOperationType = MaskOperation['type'];

/** Every mask operation type, for registries and exhaustive tests. */
export const MASK_OPERATION_TYPES = [
  'add_mask',
  'add_effect_layer_mask',
  'remove_mask',
  'update_mask',
  'set_mask_path',
  'add_mask_keyframe',
  'remove_mask_keyframe',
  'move_mask_keyframe',
  'insert_mask_vertex',
  'remove_mask_vertex',
  'reorder_masks',
  'set_mask_target',
  'apply_mask_tracking',
  'clear_mask_tracking',
  'use_track',
  'set_mask_space',
  'review_mask',
  'paste_masks',
  'add_text_behind_subject',
  'save_mask_preset',
  'remove_mask_preset',
  'restore_mask_presets',
  'restore_masks',
] as const satisfies readonly MaskOperationType[];

const MASK_OPERATION_TYPE_SET: ReadonlySet<string> = new Set(MASK_OPERATION_TYPES);

/** Runtime guard for {@link MaskOperation}. */
export const isMaskOperation = (op: { readonly type: string }): op is MaskOperation =>
  MASK_OPERATION_TYPE_SET.has(op.type);

// ---------------------------------------------------------------------------
// Contract data
// ---------------------------------------------------------------------------

const BASE_ANIMATABLE: readonly MaskScalarProperty[] = [
  'opacity',
  'expansionPx',
  'featherInnerPx',
  'featherOuterPx',
];

/** Which scalar properties a keyframe may animate on each mask kind. */
export const MASK_ANIMATABLE_PROPERTIES: Readonly<Record<MaskKind, readonly MaskScalarProperty[]>> =
  {
    rectangle: [...BASE_ANIMATABLE, 'cx', 'cy', 'width', 'height', 'rotation', 'roundness'],
    ellipse: [...BASE_ANIMATABLE, 'cx', 'cy', 'rx', 'ry', 'rotation'],
    path: BASE_ANIMATABLE,
    matte: [...BASE_ANIMATABLE, 'edgeShiftPx'],
    key: BASE_ANIMATABLE,
    linear: [...BASE_ANIMATABLE, 'originX', 'originY', 'angle', 'softnessPx'],
    band: [...BASE_ANIMATABLE, 'originX', 'originY', 'angle', 'widthPx', 'softnessPx'],
    // A gradient has no edge: expansion and feathers would be controls that do nothing.
    gradient: ['opacity', 'startX', 'startY', 'endX', 'endY'],
    // A track matte's edge is its source's: grow and soften it with finesse (MK8.2).
    layer: ['opacity'],
  };

/** Fields `update_mask` refuses, with the operation that owns each. */
export const MASK_UPDATE_FORBIDDEN_FIELDS: Readonly<Record<string, string>> = {
  id: 'remove_mask and add_mask',
  kind: 'remove_mask and add_mask',
  keyframes: 'add_mask_keyframe, move_mask_keyframe or remove_mask_keyframe',
  pathKeyframes: 'set_mask_path',
  firstVertex: 'set_mask_path',
  target: 'set_mask_target',
  space: 'set_mask_space',
  tracking: 'apply_mask_tracking or clear_mask_tracking',
};

/** Minimum vertices of a closed path. */
export const MIN_MASK_PATH_VERTICES = 3;

/** Two keyframe instants closer than this are the same instant. */
const SAME_INSTANT = 1e-9;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MaskOperationErrorCode =
  | 'missing_clip'
  | 'missing_effect_layer'
  | 'missing_mask'
  | 'missing_keyframe'
  | 'duplicate_mask'
  | 'duplicate_keyframe'
  | 'duplicate_layer'
  | 'invalid_mask'
  | 'invalid_mask_path'
  | 'invalid_mask_target';

/** Raised by mask applies; the validator maps `code` onto a typed validation issue. */
export class MaskOperationError extends Error {
  public constructor(
    public readonly code: MaskOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MaskOperationError';
  }
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

interface OwnerLocation {
  readonly kind: 'clip' | 'effect_layer';
  readonly id: string;
  readonly masks: readonly MaskLayer[];
  readonly clip?: Clip;
  readonly layer?: EffectLayer;
  readonly replace: (masks: readonly MaskLayer[]) => Timeline;
}

const clone = <T>(value: T): T => structuredClone(value);

/** `masks` absent when empty, so an emptied stack equals a never-masked owner. */
function withMasks<T extends { readonly masks?: readonly MaskLayer[] | undefined }>(
  owner: T,
  masks: readonly MaskLayer[],
): T {
  const { masks: _previous, ...rest } = owner;
  return (masks.length === 0 ? rest : { ...rest, masks: masks.slice() }) as T;
}

function locateClip(timeline: Timeline, clipId: string): OwnerLocation {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex += 1) {
    const track = timeline.tracks[trackIndex]!;
    const clipIndex = track.clips.findIndex((candidate) => candidate.id === clipId);
    if (clipIndex < 0) continue;
    const clip = track.clips[clipIndex]!;
    return {
      kind: 'clip',
      id: clipId,
      masks: masksOf(clip),
      clip,
      replace: (masks) => {
        const clips = track.clips.slice();
        clips[clipIndex] = withMasks(clip, masks);
        const tracks = timeline.tracks.slice();
        tracks[trackIndex] = { ...track, clips };
        return { ...timeline, tracks };
      },
    };
  }
  throw new MaskOperationError(
    'missing_clip',
    `Clip not found: ${clipId}. Read the timeline for clip ids.`,
  );
}

function locateEffectLayer(timeline: Timeline, layerId: string): OwnerLocation {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex += 1) {
    const track = timeline.tracks[trackIndex]!;
    const layers = track.effectLayers ?? [];
    const layerIndex = layers.findIndex((candidate) => candidate.id === layerId);
    if (layerIndex < 0) continue;
    const layer = layers[layerIndex]!;
    return {
      kind: 'effect_layer',
      id: layerId,
      masks: masksOf(layer),
      layer,
      replace: (masks) => {
        const nextLayers = layers.slice();
        nextLayers[layerIndex] = withMasks(layer, masks);
        const tracks = timeline.tracks.slice();
        tracks[trackIndex] = { ...track, effectLayers: nextLayers };
        return { ...timeline, tracks };
      },
    };
  }
  throw new MaskOperationError(
    'missing_effect_layer',
    `Effect layer not found: ${layerId}. Read the timeline for effect layer ids.`,
  );
}

function locateOwner(timeline: Timeline, ref: MaskOwnerRef): OwnerLocation {
  if (typeof ref.clipId === 'string') return locateClip(timeline, ref.clipId);
  if (typeof ref.layerId === 'string') return locateEffectLayer(timeline, ref.layerId);
  throw new MaskOperationError('invalid_mask', 'A mask operation must name a clipId or a layerId.');
}

const ownerLabel = (owner: OwnerLocation): string =>
  owner.kind === 'clip' ? `clip '${owner.id}'` : `effect layer '${owner.id}'`;

function maskIndex(owner: OwnerLocation, maskId: string): number {
  const index = owner.masks.findIndex((mask) => mask.id === maskId);
  if (index < 0) {
    throw new MaskOperationError(
      'missing_mask',
      `Mask '${maskId}' is not on ${ownerLabel(owner)}. Read the clip's masks for their ids.`,
    );
  }
  return index;
}

const ownerRefOf = (owner: OwnerLocation): MaskOwnerRef =>
  owner.kind === 'clip' ? { clipId: owner.id } : { layerId: owner.id };

function replaceMask(owner: OwnerLocation, index: number, mask: MaskLayer): Timeline {
  const masks = owner.masks.slice();
  masks[index] = mask;
  return owner.replace(masks);
}

// ---------------------------------------------------------------------------
// Parsing and invariants
// ---------------------------------------------------------------------------

function issuePath(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string {
  const first = error.issues[0];
  return first && first.path.length > 0 ? first.path.map(String).join('.') : 'mask';
}

function parseMask(input: unknown, context: string): MaskLayer {
  const parsed = MaskLayerSchema.safeParse(input);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask',
      `${context}: field '${issuePath(parsed.error)}' is not a valid mask value. ` +
        'Check the mask kind and its required fields.',
    );
  }
  return parsed.data;
}

function assertOwnerAccepts(owner: OwnerLocation, mask: MaskLayer): void {
  if (owner.kind !== 'effect_layer') return;
  if (mask.space !== 'frame') {
    throw new MaskOperationError(
      'invalid_mask',
      `Masks on effect layer '${owner.id}' are fixed to the frame. Use space 'frame'.`,
    );
  }
  if (mask.target.kind !== 'alpha') {
    throw new MaskOperationError(
      'invalid_mask_target',
      `A mask on effect layer '${owner.id}' limits the whole adjustment. Use target 'alpha'.`,
    );
  }
}

function assertTargetExists(owner: OwnerLocation, mask: Pick<MaskLayer, 'id' | 'target'>): void {
  if (mask.target.kind !== 'effect') return;
  const effectId = mask.target.effectId;
  if (owner.kind !== 'clip' || !owner.clip!.effects.some((effect) => effect.id === effectId)) {
    throw new MaskOperationError(
      'invalid_mask_target',
      `Mask '${mask.id}' targets effect '${effectId}', which is not on ${ownerLabel(owner)}. ` +
        "Target an effect on the same clip, or 'alpha'.",
    );
  }
}

/** Throws unless a path's keyframes all describe the same number of whole vertices. */
function assertPathShape(mask: MaskLayer): void {
  if (mask.kind !== 'path') return;
  if (mask.pathKeyframes.length === 0) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Path mask '${mask.id}' needs at least one path keyframe. Add one with set_mask_path.`,
    );
  }
  const count = mask.pathKeyframes[0]!.vertexTypes.length;
  for (const keyframe of mask.pathKeyframes) {
    const vertices = keyframe.vertexTypes.length;
    if (
      keyframe.points.length !== vertices * MASK_PATH_STRIDE ||
      (keyframe.featherPx !== undefined && keyframe.featherPx.length !== vertices)
    ) {
      throw new MaskOperationError(
        'invalid_mask_path',
        `Path keyframe '${keyframe.id}' of mask '${mask.id}' must store six numbers and one ` +
          'vertex type per vertex. Rewrite it with set_mask_path.',
      );
    }
    if (vertices !== count) {
      throw new MaskOperationError(
        'invalid_mask_path',
        `Every keyframe of path mask '${mask.id}' must have the same number of vertices. ` +
          'Use insert_mask_vertex or remove_mask_vertex, which change all keyframes together.',
      );
    }
    if (!keyframe.points.every(Number.isFinite)) {
      throw new MaskOperationError(
        'invalid_mask_path',
        `Path keyframe '${keyframe.id}' of mask '${mask.id}' has a non-finite coordinate.`,
      );
    }
  }
  if (count < MIN_MASK_PATH_VERTICES) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Path mask '${mask.id}' needs at least three vertices. Add vertices before removing this one.`,
    );
  }
  if (mask.firstVertex >= count) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Path mask '${mask.id}' names a first vertex it does not have. Use a vertex index of the path.`,
    );
  }
  assertDistinctInstants(mask.pathKeyframes, mask.id, 'path');
}

function assertDistinctInstants(
  keyframes: readonly { readonly id: string; readonly sourceTime: number }[],
  maskId: string,
  label: string,
): void {
  const ids = new Set<string>();
  const sorted = keyframes.slice().sort((a, b) => a.sourceTime - b.sourceTime);
  for (let index = 0; index < sorted.length; index += 1) {
    const keyframe = sorted[index]!;
    if (ids.has(keyframe.id)) {
      throw new MaskOperationError(
        'duplicate_keyframe',
        `Keyframe id '${keyframe.id}' is used twice on mask '${maskId}'. Give each keyframe its own id.`,
      );
    }
    ids.add(keyframe.id);
    const previous = sorted[index - 1];
    if (previous && keyframe.sourceTime - previous.sourceTime < SAME_INSTANT) {
      throw new MaskOperationError(
        'duplicate_keyframe',
        `Mask '${maskId}' already has a ${label} keyframe at that instant. ` +
          'Move or remove the existing keyframe first.',
      );
    }
  }
}

function assertScalarKeyframes(mask: MaskLayer): void {
  const allowed = new Set<string>(MASK_ANIMATABLE_PROPERTIES[mask.kind]);
  const ids = new Set<string>();
  for (const keyframe of mask.keyframes) {
    if (!allowed.has(keyframe.property)) {
      throw new MaskOperationError(
        'invalid_mask',
        `A ${mask.kind} mask cannot animate '${keyframe.property}'. ` +
          `Animate one of: ${MASK_ANIMATABLE_PROPERTIES[mask.kind].join(', ')}.`,
      );
    }
    if (ids.has(keyframe.id)) {
      throw new MaskOperationError(
        'duplicate_keyframe',
        `Keyframe id '${keyframe.id}' is used twice on mask '${mask.id}'. Give each keyframe its own id.`,
      );
    }
    ids.add(keyframe.id);
  }
  const byProperty = new Map<string, MaskKeyframe[]>();
  for (const keyframe of mask.keyframes) {
    byProperty.set(keyframe.property, [...(byProperty.get(keyframe.property) ?? []), keyframe]);
  }
  for (const [property, keyframes] of byProperty) {
    assertDistinctInstants(keyframes, mask.id, `'${property}'`);
  }
}

const bySourceTime = <T extends { readonly sourceTime: number }>(items: readonly T[]): T[] =>
  items.slice().sort((a, b) => a.sourceTime - b.sourceTime);

/** Sort keyframes and check every structural invariant of one mask. */
function normalized(mask: MaskLayer): MaskLayer {
  const next = {
    ...mask,
    keyframes: bySourceTime(mask.keyframes),
    ...(mask.kind === 'path' ? { pathKeyframes: bySourceTime(mask.pathKeyframes) } : {}),
  } as MaskLayer;
  assertScalarKeyframes(next);
  assertPathShape(next);
  return next;
}

function insertAt<T>(items: readonly T[], item: T, index: number | undefined): T[] {
  const next = items.slice();
  if (index === undefined) {
    next.push(item);
    return next;
  }
  if (!Number.isInteger(index)) {
    throw new MaskOperationError('invalid_mask', 'A mask index must be a whole number.');
  }
  next.splice(Math.max(0, Math.min(items.length, index)), 0, item);
  return next;
}

function assertFreeId(owner: OwnerLocation, maskId: string): void {
  if (owner.masks.some((mask) => mask.id === maskId)) {
    throw new MaskOperationError(
      'duplicate_mask',
      `Mask id '${maskId}' already exists on ${ownerLabel(owner)}. Use update_mask to change it, or choose a new id.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyAdd(owner: OwnerLocation, input: MaskLayerInput, index?: number): Timeline {
  const mask = normalized(parseMask(input, 'add_mask'));
  assertFreeId(owner, mask.id);
  assertOwnerAccepts(owner, mask);
  assertTargetExists(owner, mask);
  return owner.replace(insertAt(owner.masks, mask, index));
}

function applyUpdate(owner: OwnerLocation, op: UpdateMaskOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  for (const key of Object.keys(op.changes)) {
    const owning = MASK_UPDATE_FORBIDDEN_FIELDS[key];
    if (owning !== undefined) {
      throw new MaskOperationError(
        'invalid_mask',
        `update_mask cannot change '${key}' of mask '${op.maskId}'. Use ${owning}.`,
      );
    }
  }
  const current = owner.masks[index]!;
  const keyframes =
    op.keyframeOffsets === undefined
      ? current.keyframes
      : offsetKeyframes(current, op.keyframeOffsets);
  const mask = normalized(parseMask({ ...current, ...op.changes, keyframes }, 'update_mask'));
  return replaceMask(owner, index, mask);
}

/** Properties that can never be negative, and those bounded to 0..1. */
const NON_NEGATIVE_PROPERTIES: ReadonlySet<string> = new Set([
  'featherInnerPx',
  'featherOuterPx',
  'width',
  'height',
  'rx',
  'ry',
  'softnessPx',
  'widthPx',
]);
const UNIT_INTERVAL_PROPERTIES: ReadonlySet<string> = new Set(['opacity', 'roundness']);

/**
 * Clamp a mask scalar to the range its schema field allows.
 *
 * @param property - The scalar property.
 * @param value - A candidate value.
 */
export function clampMaskScalar(property: MaskScalarProperty, value: number): number {
  if (UNIT_INTERVAL_PROPERTIES.has(property)) return Math.min(1, Math.max(0, value));
  if (NON_NEGATIVE_PROPERTIES.has(property)) return Math.max(0, value);
  return value;
}

function offsetKeyframes(
  mask: MaskLayer,
  offsets: Readonly<Partial<Record<MaskScalarProperty, number>>>,
): MaskKeyframe[] {
  for (const [property, offset] of Object.entries(offsets)) {
    if (typeof offset !== 'number' || !Number.isFinite(offset)) {
      throw new MaskOperationError(
        'invalid_mask',
        `update_mask.keyframeOffsets.${property} on mask '${mask.id}' must be a finite number.`,
      );
    }
  }
  return mask.keyframes.map((keyframe) => {
    const offset = offsets[keyframe.property];
    if (offset === undefined) return keyframe;
    return { ...keyframe, value: clampMaskScalar(keyframe.property, keyframe.value + offset) };
  });
}

function applySetPath(owner: OwnerLocation, op: SetMaskPathOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = owner.masks[index]!;
  if (mask.kind !== 'path') {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Mask '${mask.id}' is a ${mask.kind} mask. set_mask_path edits path masks only.`,
    );
  }
  const parsed = MaskPathKeyframeSchema.safeParse(op.keyframe);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `set_mask_path: field '${issuePath(parsed.error)}' is not a valid path keyframe value.`,
    );
  }
  const keyframe = parsed.data;
  const others = mask.pathKeyframes.filter((candidate) => candidate.id !== keyframe.id);
  // A new keyframe must match the path's current vertex count; replacing the only
  // keyframe is how a path's count is first set.
  if (others.length > 0 && others[0]!.vertexTypes.length !== keyframe.vertexTypes.length) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Every keyframe of path mask '${mask.id}' must have the same number of vertices. ` +
        'Use insert_mask_vertex or remove_mask_vertex, which change all keyframes together.',
    );
  }
  return replaceMask(owner, index, normalized({ ...mask, pathKeyframes: [...others, keyframe] }));
}

function applyAddKeyframe(owner: OwnerLocation, op: AddMaskKeyframeOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = owner.masks[index]!;
  const parsed = MaskKeyframeSchema.safeParse(op.keyframe);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask',
      `add_mask_keyframe: field '${issuePath(parsed.error)}' is not a valid keyframe value.`,
    );
  }
  const keyframe = parsed.data;
  if (
    mask.keyframes.some((existing) => existing.id === keyframe.id) ||
    (mask.kind === 'path' && mask.pathKeyframes.some((existing) => existing.id === keyframe.id))
  ) {
    throw new MaskOperationError(
      'duplicate_keyframe',
      `Keyframe id '${keyframe.id}' is already used on mask '${mask.id}'. Choose a new id.`,
    );
  }
  return replaceMask(
    owner,
    index,
    normalized({ ...mask, keyframes: [...mask.keyframes, keyframe] }),
  );
}

function applyRemoveKeyframe(owner: OwnerLocation, op: RemoveMaskKeyframeOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = owner.masks[index]!;
  if (mask.keyframes.some((keyframe) => keyframe.id === op.keyframeId)) {
    return replaceMask(owner, index, {
      ...mask,
      keyframes: mask.keyframes.filter((keyframe) => keyframe.id !== op.keyframeId),
    });
  }
  if (
    mask.kind === 'path' &&
    mask.pathKeyframes.some((keyframe) => keyframe.id === op.keyframeId)
  ) {
    if (mask.pathKeyframes.length === 1) {
      throw new MaskOperationError(
        'invalid_mask_path',
        `Keyframe '${op.keyframeId}' is the only shape of path mask '${mask.id}'. Remove the mask instead.`,
      );
    }
    return replaceMask(owner, index, {
      ...mask,
      pathKeyframes: mask.pathKeyframes.filter((keyframe) => keyframe.id !== op.keyframeId),
    });
  }
  throw new MaskOperationError(
    'missing_keyframe',
    `Keyframe '${op.keyframeId}' is not on mask '${mask.id}'. Read the mask's keyframes for their ids.`,
  );
}

function assertSourceTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MaskOperationError(
      'invalid_mask',
      `${label} must be a non-negative, finite source time in seconds.`,
    );
  }
}

function applyMoveKeyframe(owner: OwnerLocation, op: MoveMaskKeyframeOp): Timeline {
  assertSourceTime(op.sourceTime, 'move_mask_keyframe.sourceTime');
  const index = maskIndex(owner, op.maskId);
  const mask = owner.masks[index]!;
  const moved = <T extends { readonly id: string; readonly sourceTime: number }>(
    items: readonly T[],
  ): T[] =>
    items.map((item) =>
      item.id === op.keyframeId ? { ...item, sourceTime: op.sourceTime } : item,
    );
  if (mask.keyframes.some((keyframe) => keyframe.id === op.keyframeId)) {
    return replaceMask(owner, index, normalized({ ...mask, keyframes: moved(mask.keyframes) }));
  }
  if (
    mask.kind === 'path' &&
    mask.pathKeyframes.some((keyframe) => keyframe.id === op.keyframeId)
  ) {
    return replaceMask(
      owner,
      index,
      normalized({ ...mask, pathKeyframes: moved(mask.pathKeyframes) }),
    );
  }
  throw new MaskOperationError(
    'missing_keyframe',
    `Keyframe '${op.keyframeId}' is not on mask '${mask.id}'. Read the mask's keyframes for their ids.`,
  );
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** De Casteljau split of one path keyframe's segment; the curve is unchanged. */
function splitSegment(keyframe: MaskPathKeyframe, segment: number, t: number): MaskPathKeyframe {
  const count = keyframe.vertexTypes.length;
  const next = (segment + 1) % count;
  const p = keyframe.points;
  const a = segment * MASK_PATH_STRIDE;
  const b = next * MASK_PATH_STRIDE;
  const [p0x, p0y] = [p[a]!, p[a + 1]!];
  const [p1x, p1y] = [p0x + p[a + 4]!, p0y + p[a + 5]!];
  const [p3x, p3y] = [p[b]!, p[b + 1]!];
  const [p2x, p2y] = [p3x + p[b + 2]!, p3y + p[b + 3]!];
  const q0x = lerp(p0x, p1x, t);
  const q0y = lerp(p0y, p1y, t);
  const q1x = lerp(p1x, p2x, t);
  const q1y = lerp(p1y, p2y, t);
  const q2x = lerp(p2x, p3x, t);
  const q2y = lerp(p2y, p3y, t);
  const r0x = lerp(q0x, q1x, t);
  const r0y = lerp(q0y, q1y, t);
  const r1x = lerp(q1x, q2x, t);
  const r1y = lerp(q1y, q2y, t);
  const sx = lerp(r0x, r1x, t);
  const sy = lerp(r0y, r1y, t);

  const points = p.slice();
  points[a + 4] = q0x - p0x;
  points[a + 5] = q0y - p0y;
  points[b + 2] = q2x - p3x;
  points[b + 3] = q2y - p3y;
  const straight = p[a + 4] === 0 && p[a + 5] === 0 && p[b + 2] === 0 && p[b + 3] === 0;
  // On a straight (zero-tangent) segment the split point is still a corner of a polygon.
  const inserted = straight
    ? [sx, sy, 0, 0, 0, 0]
    : [sx, sy, r0x - sx, r0y - sy, r1x - sx, r1y - sy];
  if (straight) {
    points[a + 4] = 0;
    points[a + 5] = 0;
    points[b + 2] = 0;
    points[b + 3] = 0;
  }
  const at = (segment + 1) * MASK_PATH_STRIDE;
  points.splice(at, 0, ...inserted);
  const vertexTypes = keyframe.vertexTypes.slice();
  vertexTypes.splice(segment + 1, 0, straight ? 0 : 1);
  const featherPx = keyframe.featherPx?.slice();
  if (featherPx) {
    featherPx.splice(segment + 1, 0, lerp(featherPx[segment]!, featherPx[next]!, t));
  }
  return { ...keyframe, points, vertexTypes, ...(featherPx ? { featherPx } : {}) };
}

function pathMaskAt(
  owner: OwnerLocation,
  maskId: string,
  label: string,
): { index: number; mask: Extract<MaskLayer, { kind: 'path' }> } {
  const index = maskIndex(owner, maskId);
  const mask = owner.masks[index]!;
  if (mask.kind !== 'path') {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Mask '${mask.id}' is a ${mask.kind} mask. ${label} edits path masks only.`,
    );
  }
  return { index, mask };
}

function applyInsertVertex(owner: OwnerLocation, op: InsertMaskVertexOp): Timeline {
  const { index, mask } = pathMaskAt(owner, op.maskId, 'insert_mask_vertex');
  const count = mask.pathKeyframes[0]?.vertexTypes.length ?? 0;
  if (!Number.isInteger(op.segment) || op.segment < 0 || op.segment >= count) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `insert_mask_vertex needs a segment index of path mask '${mask.id}' (vertex to the next one).`,
    );
  }
  if (!(op.t > 0 && op.t < 1)) {
    throw new MaskOperationError(
      'invalid_mask_path',
      'insert_mask_vertex.t is a position strictly between the two vertices (0 < t < 1).',
    );
  }
  const firstVertex = mask.firstVertex > op.segment ? mask.firstVertex + 1 : mask.firstVertex;
  return replaceMask(
    owner,
    index,
    normalized({
      ...mask,
      firstVertex,
      pathKeyframes: mask.pathKeyframes.map((keyframe) => splitSegment(keyframe, op.segment, op.t)),
    }),
  );
}

function applyRemoveVertex(owner: OwnerLocation, op: RemoveMaskVertexOp): Timeline {
  const { index, mask } = pathMaskAt(owner, op.maskId, 'remove_mask_vertex');
  const count = mask.pathKeyframes[0]?.vertexTypes.length ?? 0;
  if (!Number.isInteger(op.vertex) || op.vertex < 0 || op.vertex >= count) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `remove_mask_vertex needs a vertex index of path mask '${mask.id}'.`,
    );
  }
  if (count - 1 < MIN_MASK_PATH_VERTICES) {
    throw new MaskOperationError(
      'invalid_mask_path',
      `Path mask '${mask.id}' needs at least three vertices. Add vertices before removing this one.`,
    );
  }
  const remaining = count - 1;
  const firstVertex =
    mask.firstVertex > op.vertex
      ? mask.firstVertex - 1
      : mask.firstVertex === op.vertex
        ? op.vertex % remaining
        : mask.firstVertex;
  const pathKeyframes = mask.pathKeyframes.map((keyframe) => {
    const points = keyframe.points.slice();
    points.splice(op.vertex * MASK_PATH_STRIDE, MASK_PATH_STRIDE);
    const vertexTypes = keyframe.vertexTypes.filter((_, vertex) => vertex !== op.vertex);
    const featherPx = keyframe.featherPx?.filter((_, vertex) => vertex !== op.vertex);
    return { ...keyframe, points, vertexTypes, ...(featherPx ? { featherPx } : {}) };
  });
  return replaceMask(owner, index, normalized({ ...mask, firstVertex, pathKeyframes }));
}

function applyReorder(owner: OwnerLocation, op: ReorderMasksOp): Timeline {
  const current = owner.masks.map((mask) => mask.id);
  const wanted = new Set(op.maskIds);
  if (
    op.maskIds.length !== current.length ||
    wanted.size !== current.length ||
    !current.every((id) => wanted.has(id))
  ) {
    throw new MaskOperationError(
      'invalid_mask',
      `reorder_masks must list every mask of ${ownerLabel(owner)} exactly once, top first.`,
    );
  }
  const byId = new Map(owner.masks.map((mask) => [mask.id, mask]));
  return owner.replace(op.maskIds.map((id) => byId.get(id)!));
}

function applySetTarget(owner: OwnerLocation, op: SetMaskTargetOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = { ...owner.masks[index]!, target: clone(op.target) } as MaskLayer;
  parseMask(mask, 'set_mask_target');
  assertOwnerAccepts(owner, mask);
  assertTargetExists(owner, mask);
  return replaceMask(owner, index, mask);
}

function applyTracking(owner: OwnerLocation, op: ApplyMaskTrackingOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const parsed = MaskTrackingSchema.safeParse(op.tracking);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask',
      `apply_mask_tracking: field '${issuePath(parsed.error)}' is not a valid tracking value.`,
    );
  }
  return replaceMask(owner, index, { ...owner.masks[index]!, tracking: parsed.data });
}

function withoutTracking(mask: MaskLayer): MaskLayer {
  const { tracking: _tracking, ...rest } = mask;
  return rest as MaskLayer;
}

function applyClearTracking(owner: OwnerLocation, op: ClearMaskTrackingOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  return replaceMask(owner, index, withoutTracking(owner.masks[index]!));
}

function applyUseTrack(timeline: Timeline, op: UseTrackOp): Timeline {
  const from = locateClip(timeline, op.fromClipId);
  const source = from.masks[maskIndex(from, op.fromMaskId)]!;
  if (source.tracking === undefined) {
    throw new MaskOperationError(
      'invalid_mask',
      `Mask '${source.id}' on clip '${from.id}' has no track to reuse. Track that mask first.`,
    );
  }
  const owner = locateOwner(timeline, op.to);
  const index = maskIndex(owner, op.to.maskId);
  return replaceMask(owner, index, { ...owner.masks[index]!, tracking: clone(source.tracking) });
}

function applySetSpace(owner: OwnerLocation, op: SetMaskSpaceOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = parseMask({ ...owner.masks[index]!, space: op.space }, 'set_mask_space');
  assertOwnerAccepts(owner, mask);
  return replaceMask(owner, index, mask);
}

function applyReview(owner: OwnerLocation, op: ReviewMaskOp): Timeline {
  const index = maskIndex(owner, op.maskId);
  const mask = owner.masks[index]!;
  const parsed = MaskReviewSchema.safeParse(op.review);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask',
      `review_mask: field '${issuePath(parsed.error)}' is not a valid review value.`,
    );
  }
  const review = parsed.data;
  if ([...review.flagged, ...review.approved].some((range) => range.end < range.start)) {
    throw new MaskOperationError(
      'invalid_mask',
      'review_mask ranges must end at or after they start, in source seconds.',
    );
  }
  if (op.subject === 'matte') {
    if (mask.kind !== 'matte') {
      throw new MaskOperationError(
        'invalid_mask',
        `Mask '${mask.id}' is a ${mask.kind} mask. Review a matte, or review its track with subject 'tracking'.`,
      );
    }
    return replaceMask(owner, index, { ...mask, review });
  }
  if (mask.tracking === undefined) {
    throw new MaskOperationError(
      'invalid_mask',
      `Mask '${mask.id}' has no track to review. Track it first.`,
    );
  }
  return replaceMask(owner, index, { ...mask, tracking: { ...mask.tracking, review } });
}

/** Scalar fields measured along the picture's x axis, y axis, or as a length. */
const X_FIELDS = new Set(['cx', 'originX', 'startX', 'endX', 'width', 'rx']);
const Y_FIELDS = new Set(['cy', 'originY', 'startY', 'endY', 'height', 'ry']);
const LENGTH_FIELDS = new Set([
  'expansionPx',
  'featherInnerPx',
  'featherOuterPx',
  'softnessPx',
  'widthPx',
  'edgeShiftPx',
]);

function scaleMask(
  mask: MaskLayer,
  sx: number,
  sy: number,
  length: number,
  shiftTime: (time: number) => number,
): MaskLayer {
  const geometric = mask.space === 'source' && mask.units === undefined;
  const scale = (field: string, value: number): number => {
    if (!geometric) return value;
    if (X_FIELDS.has(field)) return value * sx;
    if (Y_FIELDS.has(field)) return value * sy;
    if (LENGTH_FIELDS.has(field)) return value * length;
    return value;
  };
  const record = mask as unknown as Record<string, unknown>;
  const scaled: Record<string, unknown> = { ...record };
  for (const [field, value] of Object.entries(record)) {
    if (typeof value === 'number') scaled[field] = scale(field, value);
  }
  scaled.keyframes = mask.keyframes.map((keyframe) => ({
    ...keyframe,
    sourceTime: shiftTime(keyframe.sourceTime),
    value: scale(keyframe.property, keyframe.value),
  }));
  if (mask.kind === 'path') {
    scaled.pathKeyframes = mask.pathKeyframes.map((keyframe) => ({
      ...keyframe,
      sourceTime: shiftTime(keyframe.sourceTime),
      points: geometric
        ? keyframe.points.map((value, position) => value * (position % 2 === 0 ? sx : sy))
        : keyframe.points.slice(),
      ...(keyframe.featherPx && geometric
        ? { featherPx: keyframe.featherPx.map((value) => value * length) }
        : {}),
    }));
  }
  if (mask.tracking) {
    scaled.tracking = {
      ...mask.tracking,
      referenceSourceTime: shiftTime(mask.tracking.referenceSourceTime),
      constraints: mask.tracking.constraints.map((constraint) => ({
        sourceTime: shiftTime(constraint.sourceTime),
      })),
    };
  }
  return scaled as unknown as MaskLayer;
}

function applyPaste(timeline: Timeline, op: PasteMasksOp): Timeline {
  const owner = locateClip(timeline, op.clipId);
  const clip = owner.clip!;
  const sizes = [op.from.width, op.from.height, op.to.width, op.to.height];
  if (!sizes.every((value) => Number.isFinite(value) && value > 0)) {
    throw new MaskOperationError(
      'invalid_mask',
      'paste_masks needs the measured size of both pictures. Measure this media first.',
    );
  }
  const sx = op.to.width / op.from.width;
  const sy = op.to.height / op.from.height;
  const length = Math.min(op.to.width, op.to.height) / Math.min(op.from.width, op.from.height);
  const shiftTime = (time: number): number =>
    Math.max(0, time - op.from.sourceStart + clip.sourceStart);
  const taken = new Set(owner.masks.map((mask) => mask.id));
  const pasted: MaskLayer[] = op.masks.map((input, position) => {
    const mask = parseMask(input, 'paste_masks');
    if (mask.kind === 'matte' && op.from.assetId !== clip.assetId) {
      throw new MaskOperationError(
        'invalid_mask',
        `Mask '${mask.id}' is a background-removal matte of other media. Run background removal on clip '${clip.id}' instead.`,
      );
    }
    const requested = op.ids?.[position];
    let id = requested ?? mask.id;
    if (requested === undefined) {
      for (let attempt = 1; taken.has(id); attempt += 1)
        id = `${mask.id}__paste_${String(attempt)}`;
    }
    if (taken.has(id)) {
      throw new MaskOperationError(
        'duplicate_mask',
        `Mask id '${id}' already exists on clip '${clip.id}'. Choose a new id for the pasted mask.`,
      );
    }
    taken.add(id);
    const next = normalized(scaleMask({ ...mask, id }, sx, sy, length, shiftTime));
    assertTargetExists(owner, next);
    return next;
  });
  return owner.replace([...owner.masks, ...pasted]);
}

/** Effect types that belong to a cut, not to a picture, and cannot follow a copied clip. */
const CUT_EFFECT_TYPES = new Set(['transition', 'transition_out']);

/** The ids `add_text_behind_subject` creates when the operation does not name them. */
export function textBehindSubjectIds(
  op: Pick<
    AddTextBehindSubjectOp,
    'clipId' | 'subjectTrackId' | 'textTrackId' | 'subjectClipId' | 'textClipId'
  >,
): {
  readonly subjectTrackId: string;
  readonly textTrackId: string;
  readonly subjectClipId: string;
  readonly textClipId: string;
} {
  return {
    subjectTrackId: op.subjectTrackId ?? `${op.clipId}__subject_track`,
    textTrackId: op.textTrackId ?? `${op.clipId}__text_track`,
    subjectClipId: op.subjectClipId ?? `${op.clipId}__subject`,
    textClipId: op.textClipId ?? `${op.clipId}__behind_text`,
  };
}

/** Where an earlier `add_text_behind_subject` left its layers, for the clip it was made on. */
export interface TextSandwich {
  /** The clip the sandwich was first built on (its background copy keeps this id). */
  readonly baseClipId: string;
  readonly subjectTrackId: string;
  readonly textTrackId: string;
}

const SUBJECT_COPY_SUFFIX = '__subject';

/**
 * The sandwich `clipId` already belongs to — built on it, or on the clip it is the front
 * (subject) copy of — or `undefined` when there is none.
 *
 * WHY THIS EXISTS. The operation MOVES the matte onto a new front copy, so a second title on
 * the same shot found no matte on the original and was refused ("Remove the background on
 * this clip first"); the agent then called it on the front copy, which built a sandwich INSIDE
 * the sandwich — `…__subject__subject`, a third full copy of the talking head, and an orphaned
 * empty text track (captured run, 2026-09-23). One shot has one subject and one background:
 * every further title goes on the text track that is already between them.
 *
 * Only the ids this module derives are recognised; a caller that named its own track ids
 * owns its layout.
 */
export function existingTextSandwich(timeline: Timeline, clipId: string): TextSandwich | undefined {
  const trackIds = new Set(timeline.tracks.map((track) => track.id));
  const bases = clipId.endsWith(SUBJECT_COPY_SUFFIX)
    ? [clipId, clipId.slice(0, -SUBJECT_COPY_SUFFIX.length)]
    : [clipId];
  for (const baseClipId of bases) {
    const ids = textBehindSubjectIds({ clipId: baseClipId });
    if (trackIds.has(ids.subjectTrackId) && trackIds.has(ids.textTrackId)) {
      return { baseClipId, subjectTrackId: ids.subjectTrackId, textTrackId: ids.textTrackId };
    }
  }
  return undefined;
}

/** Whether the op leaves its layer ids to this module (and so may reuse a sandwich). */
function derivesItsIds(op: AddTextBehindSubjectOp): boolean {
  return (
    op.subjectTrackId === undefined &&
    op.textTrackId === undefined &&
    op.subjectClipId === undefined &&
    op.textClipId === undefined
  );
}

/** The title's on-screen range inside `clip`, refusing one that leaves nothing to show. */
function titleRange(clip: Clip, op: AddTextBehindSubjectOp): { start: number; end: number } {
  const start = Math.max(clip.start, op.start ?? clip.start);
  const end = Math.min(clip.end, op.end ?? clip.end);
  if (!(end > start)) {
    throw new MaskOperationError(
      'invalid_mask',
      `The title range ${String(op.start ?? clip.start)}–${String(op.end ?? clip.end)}s is ` +
        `outside clip '${clip.id}' (${String(clip.start)}–${String(clip.end)}s). Give a start ` +
        'and end inside the shot the subject is in.',
    );
  }
  return { start, end };
}

/** A text clip for a title behind a subject. */
function titleClip(
  id: string,
  trackId: string,
  range: { readonly start: number; readonly end: number },
  op: AddTextBehindSubjectOp,
): Clip {
  return {
    id,
    assetId: '__text__',
    trackId,
    start: range.start,
    end: range.end,
    sourceStart: 0,
    sourceEnd: range.end - range.start,
    effects: [
      {
        id: `${id}__text`,
        type: 'text',
        params: { ...(op.style ?? {}), text: op.text },
        keyframes: [],
      },
    ],
    keyframes: [],
  };
}

/** Add one more title onto a sandwich that already exists. */
function addTitleToSandwich(
  timeline: Timeline,
  op: AddTextBehindSubjectOp,
  sandwich: TextSandwich,
): Timeline {
  const clip = locateClip(timeline, op.clipId).clip!;
  const range = titleRange(clip, op);
  const trackIndex = timeline.tracks.findIndex((track) => track.id === sandwich.textTrackId);
  const track = timeline.tracks[trackIndex]!;
  const clash = track.clips.find((other) => other.start < range.end && other.end > range.start);
  if (clash !== undefined) {
    throw new MaskOperationError(
      'duplicate_layer',
      `A title is already behind the subject from ${String(clash.start)}s to ` +
        `${String(clash.end)}s ('${clash.id}'). Give this one a range that does not overlap it, ` +
        'or change that title instead.',
    );
  }
  const taken = new Set(timeline.tracks.flatMap((candidate) => candidate.clips.map((c) => c.id)));
  const base = textBehindSubjectIds({ clipId: sandwich.baseClipId }).textClipId;
  let id = taken.has(base) ? `${base}_${String(Math.round(range.start * 1000))}` : base;
  for (let n = 2; taken.has(id); n += 1)
    id = `${base}_${String(Math.round(range.start * 1000))}_${String(n)}`;
  const tracks = timeline.tracks.slice();
  tracks[trackIndex] = {
    ...track,
    clips: [...track.clips, titleClip(id, track.id, range, op)].sort((a, b) => a.start - b.start),
  };
  return { ...timeline, tracks };
}

function applyTextBehindSubject(timeline: Timeline, op: AddTextBehindSubjectOp): Timeline {
  if (op.text.trim().length === 0) {
    throw new MaskOperationError('invalid_mask', 'add_text_behind_subject needs non-empty text.');
  }
  const sandwich = derivesItsIds(op) ? existingTextSandwich(timeline, op.clipId) : undefined;
  if (sandwich !== undefined) return addTitleToSandwich(timeline, op, sandwich);
  const owner = locateClip(timeline, op.clipId);
  const clip = owner.clip!;
  const trackIndex = timeline.tracks.findIndex((track) => track.clips.includes(clip));
  const track = timeline.tracks[trackIndex]!;
  if (track.type !== 'video' && track.type !== 'overlay') {
    throw new MaskOperationError(
      'invalid_mask',
      `Clip '${clip.id}' is not a picture clip. Put text behind the subject of a video or image clip.`,
    );
  }
  const matte = op.maskId
    ? owner.masks[maskIndex(owner, op.maskId)]!
    : owner.masks.find(
        (mask) => mask.kind === 'matte' && mask.enabled && mask.target.kind === 'alpha',
      );
  if (!matte || matte.kind !== 'matte') {
    throw new MaskOperationError(
      'invalid_mask',
      `Clip '${clip.id}' has no subject matte. Remove the background on this clip first.`,
    );
  }
  const ids = textBehindSubjectIds(op);
  const existingTracks = new Set(timeline.tracks.map((candidate) => candidate.id));
  for (const id of [ids.subjectTrackId, ids.textTrackId]) {
    if (existingTracks.has(id)) {
      throw new MaskOperationError(
        'duplicate_layer',
        `Track id '${id}' already exists. Name new track ids for the subject and the text.`,
      );
    }
  }
  const allClipIds = new Set(
    timeline.tracks.flatMap((candidate) => candidate.clips.map((c) => c.id)),
  );
  for (const id of [ids.subjectClipId, ids.textClipId]) {
    if (allClipIds.has(id)) {
      throw new MaskOperationError(
        'duplicate_mask',
        `Clip id '${id}' already exists. Name new clip ids for the subject and the text.`,
      );
    }
  }

  const subjectMatte: MaskLayer = { ...clone(matte), target: { kind: 'alpha' }, enabled: true };
  const subjectClip: Clip = withMasks(
    {
      ...clone(clip),
      id: ids.subjectClipId,
      trackId: ids.subjectTrackId,
      effects: clip.effects.filter((effect) => !CUT_EFFECT_TYPES.has(effect.type)).map(clone),
    },
    [subjectMatte],
  );
  const textClip = titleClip(ids.textClipId, ids.textTrackId, titleRange(clip, op), op);
  const backgroundMasks = owner.masks.filter((mask) => mask.id !== matte.id);
  const tracks = timeline.tracks.slice();
  tracks[trackIndex] = {
    ...track,
    clips: track.clips.map((candidate) =>
      candidate.id === clip.id ? withMasks(clip, backgroundMasks) : candidate,
    ),
  };
  // tracks[0] is the visual front: subject copy, then the text, then the original.
  const subjectTrack: Track = {
    id: ids.subjectTrackId,
    type: track.type,
    clips: [subjectClip],
    muted: true,
  };
  const textTrack: Track = { id: ids.textTrackId, type: 'overlay', clips: [textClip] };
  tracks.splice(trackIndex, 0, subjectTrack, textTrack);
  return { ...timeline, tracks };
}

/**
 * Apply one mask operation, returning a new immutable timeline.
 *
 * @throws {MaskOperationError} When the operation cannot be applied; the message names
 *   the ids involved and the remedy.
 */
export function applyMaskOperation(timeline: Timeline, op: MaskOperation): Timeline {
  switch (op.type) {
    case 'add_mask':
      return applyAdd(locateClip(timeline, op.clipId), op.mask, op.index);
    case 'add_effect_layer_mask': {
      const owner = locateEffectLayer(timeline, op.layerId);
      const space = (op.mask as { space?: unknown }).space;
      return applyAdd(
        owner,
        { ...op.mask, space: space === undefined ? 'frame' : op.mask.space } as MaskLayerInput,
        op.index,
      );
    }
    case 'remove_mask': {
      const owner = locateOwner(timeline, op);
      const index = maskIndex(owner, op.maskId);
      return owner.replace(owner.masks.filter((_, position) => position !== index));
    }
    case 'update_mask':
      return applyUpdate(locateOwner(timeline, op), op);
    case 'set_mask_path':
      return applySetPath(locateOwner(timeline, op), op);
    case 'add_mask_keyframe':
      return applyAddKeyframe(locateOwner(timeline, op), op);
    case 'remove_mask_keyframe':
      return applyRemoveKeyframe(locateOwner(timeline, op), op);
    case 'move_mask_keyframe':
      return applyMoveKeyframe(locateOwner(timeline, op), op);
    case 'insert_mask_vertex':
      return applyInsertVertex(locateOwner(timeline, op), op);
    case 'remove_mask_vertex':
      return applyRemoveVertex(locateOwner(timeline, op), op);
    case 'reorder_masks':
      return applyReorder(locateOwner(timeline, op), op);
    case 'set_mask_target':
      return applySetTarget(locateOwner(timeline, op), op);
    case 'apply_mask_tracking':
      return applyTracking(locateOwner(timeline, op), op);
    case 'clear_mask_tracking':
      return applyClearTracking(locateOwner(timeline, op), op);
    case 'use_track':
      return applyUseTrack(timeline, op);
    case 'set_mask_space':
      return applySetSpace(locateOwner(timeline, op), op);
    case 'review_mask':
      return applyReview(locateOwner(timeline, op), op);
    case 'paste_masks':
      return applyPaste(timeline, op);
    case 'add_text_behind_subject':
      return applyTextBehindSubject(timeline, op);
    case 'save_mask_preset':
      return applySavePreset(timeline, op);
    case 'remove_mask_preset': {
      const presets = timeline.maskPresets ?? [];
      if (!presets.some((preset) => preset.id === op.presetId)) {
        throw new MaskOperationError(
          'missing_mask',
          `Mask preset '${op.presetId}' is not in this project. Read the project's presets for their ids.`,
        );
      }
      return withPresets(
        timeline,
        presets.filter((preset) => preset.id !== op.presetId),
      );
    }
    case 'restore_mask_presets':
      return withPresets(timeline, op.presets.map(clone));
    case 'restore_masks': {
      const owner = locateOwner(timeline, op);
      return owner.replace(op.masks.map(clone));
    }
  }
}

/** Presets stored with an empty list as an ABSENT key, so undo lands on the prior document. */
function withPresets(timeline: Timeline, presets: readonly MaskPreset[]): Timeline {
  if (presets.length > 0) return { ...timeline, maskPresets: [...presets] };
  const { maskPresets: _removed, ...rest } = timeline;
  return rest;
}

function applySavePreset(timeline: Timeline, op: SaveMaskPresetOp): Timeline {
  const parsed = MaskPresetSchema.safeParse(op.preset);
  if (!parsed.success) {
    throw new MaskOperationError(
      'invalid_mask',
      `save_mask_preset: field '${issuePath(parsed.error)}' is not a valid preset value. A preset needs a name, a picture size and at least one mask.`,
    );
  }
  const presets = timeline.maskPresets ?? [];
  if (presets.some((preset) => preset.id === parsed.data.id)) {
    throw new MaskOperationError(
      'duplicate_mask',
      `Mask preset id '${parsed.data.id}' is already used. Choose a new id.`,
    );
  }
  return withPresets(timeline, [...presets, parsed.data]);
}

// ---------------------------------------------------------------------------
// Invert
// ---------------------------------------------------------------------------

/** An inverse step: a mask operation, or the clip/layer primitives a composite needs. */
export type MaskInverseOperation =
  | MaskOperation
  | { readonly type: 'remove_layer'; readonly layerId: string }
  | { readonly type: 'restore_clips'; readonly trackId: string; readonly clips: readonly Clip[] };

const restore = (owner: OwnerLocation): RestoreMasksOp =>
  ({
    type: 'restore_masks',
    ...ownerRefOf(owner),
    masks: owner.masks.map(clone),
  }) as RestoreMasksOp;

/**
 * The operations that undo `op`, computed against the timeline BEFORE it was applied.
 *
 * @param timelineBefore - The timeline `op` will be (or was) applied to.
 * @param op - The mask operation.
 * @returns Operations that, applied in order to the result, restore `timelineBefore`.
 */
export function invertMaskOperation(
  timelineBefore: Timeline,
  op: MaskOperation,
): MaskInverseOperation[] {
  switch (op.type) {
    case 'add_mask': {
      const id = parseMask(op.mask, 'add_mask').id;
      return [{ type: 'remove_mask', clipId: op.clipId, maskId: id }];
    }
    case 'add_effect_layer_mask': {
      const id = parseMask({ ...op.mask, space: 'frame' }, 'add_effect_layer_mask').id;
      return [{ type: 'remove_mask', layerId: op.layerId, maskId: id }];
    }
    case 'remove_mask': {
      const owner = locateOwner(timelineBefore, op);
      const index = maskIndex(owner, op.maskId);
      const mask = clone(owner.masks[index]!);
      return owner.kind === 'clip'
        ? [{ type: 'add_mask', clipId: owner.id, mask, index }]
        : [{ type: 'add_effect_layer_mask', layerId: owner.id, mask, index }];
    }
    case 'move_mask_keyframe': {
      const owner = locateOwner(timelineBefore, op);
      const mask = owner.masks[maskIndex(owner, op.maskId)]!;
      const existing = [
        ...mask.keyframes,
        ...(mask.kind === 'path' ? mask.pathKeyframes : []),
      ].find((keyframe) => keyframe.id === op.keyframeId);
      if (!existing) return [restore(owner)];
      return [{ ...op, sourceTime: existing.sourceTime }];
    }
    case 'add_mask_keyframe': {
      const parsed = MaskKeyframeSchema.safeParse(op.keyframe);
      const owner = locateOwner(timelineBefore, op);
      if (!parsed.success) return [restore(owner)];
      return [
        {
          type: 'remove_mask_keyframe',
          ...ownerRefOf(owner),
          maskId: op.maskId,
          keyframeId: parsed.data.id,
        } as RemoveMaskKeyframeOp,
      ];
    }
    case 'reorder_masks': {
      const owner = locateOwner(timelineBefore, op);
      return [
        {
          type: 'reorder_masks',
          ...ownerRefOf(owner),
          maskIds: owner.masks.map((mask) => mask.id),
        } as ReorderMasksOp,
      ];
    }
    case 'set_mask_target': {
      const owner = locateOwner(timelineBefore, op);
      const mask = owner.masks[maskIndex(owner, op.maskId)]!;
      return [{ ...op, target: clone(mask.target) }];
    }
    case 'set_mask_space': {
      const owner = locateOwner(timelineBefore, op);
      const mask = owner.masks[maskIndex(owner, op.maskId)]!;
      return [{ ...op, space: mask.space }];
    }
    case 'apply_mask_tracking':
    case 'clear_mask_tracking': {
      const owner = locateOwner(timelineBefore, op);
      const mask = owner.masks[maskIndex(owner, op.maskId)]!;
      const ref = ownerRefOf(owner);
      return mask.tracking
        ? [
            {
              type: 'apply_mask_tracking',
              ...ref,
              maskId: op.maskId,
              tracking: clone(mask.tracking),
            } as ApplyMaskTrackingOp,
          ]
        : [{ type: 'clear_mask_tracking', ...ref, maskId: op.maskId } as ClearMaskTrackingOp];
    }
    case 'review_mask': {
      const owner = locateOwner(timelineBefore, op);
      const mask = owner.masks[maskIndex(owner, op.maskId)]!;
      const prior =
        op.subject === 'matte'
          ? mask.kind === 'matte'
            ? mask.review
            : undefined
          : mask.tracking?.review;
      return prior ? [{ ...op, review: clone(prior) }] : [restore(owner)];
    }
    case 'use_track':
      return [restore(locateOwner(timelineBefore, op.to))];
    case 'paste_masks':
      return [restore(locateClip(timelineBefore, op.clipId))];
    case 'add_text_behind_subject': {
      const sandwich = derivesItsIds(op)
        ? existingTextSandwich(timelineBefore, op.clipId)
        : undefined;
      if (sandwich !== undefined) {
        // Only a title was added: put the text track's clips back as they were.
        const textTrack = timelineBefore.tracks.find(
          (candidate) => candidate.id === sandwich.textTrackId,
        )!;
        return [
          { type: 'restore_clips', trackId: textTrack.id, clips: textTrack.clips.map(clone) },
        ];
      }
      const owner = locateClip(timelineBefore, op.clipId);
      const track = timelineBefore.tracks.find((candidate) =>
        candidate.clips.includes(owner.clip!),
      )!;
      const ids = textBehindSubjectIds(op);
      return [
        { type: 'remove_layer', layerId: ids.subjectTrackId },
        { type: 'remove_layer', layerId: ids.textTrackId },
        { type: 'restore_clips', trackId: track.id, clips: track.clips.map(clone) },
      ];
    }
    case 'save_mask_preset': {
      const parsed = MaskPresetSchema.safeParse(op.preset);
      return parsed.success
        ? [{ type: 'remove_mask_preset', presetId: parsed.data.id }]
        : [
            {
              type: 'restore_mask_presets',
              presets: (timelineBefore.maskPresets ?? []).map(clone),
            },
          ];
    }
    case 'remove_mask_preset':
    case 'restore_mask_presets':
      return [
        { type: 'restore_mask_presets', presets: (timelineBefore.maskPresets ?? []).map(clone) },
      ];
    case 'update_mask':
    case 'set_mask_path':
    case 'remove_mask_keyframe':
    case 'insert_mask_vertex':
    case 'remove_mask_vertex':
    case 'restore_masks':
      return [restore(locateOwner(timelineBefore, op))];
  }
}

/** The clip whose track a mask operation touches, when it has one (for scoping/locks). */
export function maskOperationClipIds(op: MaskOperation): readonly string[] {
  switch (op.type) {
    case 'add_mask':
    case 'paste_masks':
    case 'add_text_behind_subject':
      return [op.clipId];
    case 'add_effect_layer_mask':
    case 'save_mask_preset':
    case 'remove_mask_preset':
    case 'restore_mask_presets':
      return [];
    case 'use_track':
      return op.to.clipId === undefined ? [] : [op.to.clipId];
    default:
      return op.clipId === undefined ? [] : [op.clipId];
  }
}

/** The effect layer a mask operation touches, when it has one. */
export function maskOperationLayerId(op: MaskOperation): string | undefined {
  switch (op.type) {
    case 'add_effect_layer_mask':
      return op.layerId;
    case 'add_mask':
    case 'paste_masks':
    case 'add_text_behind_subject':
    case 'save_mask_preset':
    case 'remove_mask_preset':
    case 'restore_mask_presets':
      return undefined;
    case 'use_track':
      return op.to.layerId;
    default:
      return op.layerId;
  }
}
