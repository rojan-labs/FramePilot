/**
 * Mask editing commands (MK4, plan 10 "Operations"): the one place a hand-made or agent-made
 * mask edit becomes a validated, reversible patch.
 *
 * The monitor tools, the Inspector mask panel, the timeline's mask keyframe lanes and the
 * agent's mask tools all describe WHAT they want ("this rectangle is now here at this source
 * instant", "apply this feather to every keyframe") and compile it here. The command decides
 * which typed mask operations express it: a static `update_mask` for an unanimated property,
 * a keyframe at the instant for an animated one, `set_mask_path` for a path. Nothing outside
 * this module builds a raw mask operation for an edit, so the UI and the agent cannot disagree
 * about what an edit does (memory: the UI used to bypass EditorCommand).
 *
 * Every compile validates the patch against the timeline and its assets, and computes the
 * inverse by replaying it, exactly like `compileMotionCommand`.
 */
import type { PatchId } from '@framepilot/shared-types';
import {
  masksOf,
  type Asset,
  type Clip,
  type EffectLayer,
  type MaskKeyframeInput,
  type MaskLayer,
  type MaskLayerInput,
  type MaskReviewInput,
  type MaskScalarProperty,
  type MaskSpace,
  type MaskTrackingInput,
  type MaskTarget,
  type PathMask,
  type Timeline,
  type Track,
} from '@framepilot/timeline-schema';
import { segmentProgress } from './keyframes.js';
import { MEASURE_MEDIA_FIRST, maskScalarAt, nextMaskId } from './mask-builders.js';
import {
  assetDisplaySize,
  decodeMaskPath,
  encodeMaskPath,
  type DisplaySize,
  type MaskPathVertex,
} from './mask-geometry.js';
import { withConstraint, type TrackStateAt } from './mask-track-review.js';
import { correctionSpan, untrackGeometry } from './mask-track-correction.js';
import {
  MASK_SHAPE_PRESET_NAMES,
  ShapePresetError,
  shapePresetPaths,
  type MaskShapePreset,
  type ShapePresetBox,
  type ShapePresetOptions,
} from './mask-shape-presets.js';
import {
  MASK_ANIMATABLE_PROPERTIES,
  MIN_MASK_PATH_VERTICES,
  clampMaskScalar,
  existingTextSandwich,
  type MaskOperation,
} from './mask-operations.js';
import { applyPatch, invertPatch, type Patch, type PatchAuthor } from './patch.js';
import { validatePatch } from './validator.js';

// ---------------------------------------------------------------------------
// Geometry vocabulary
// ---------------------------------------------------------------------------

/** A rectangle mask's geometry, source pixels; rotation in degrees clockwise. */
export interface RectangleMaskGeometry {
  readonly kind: 'rectangle';
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly roundness: number;
}

/** An ellipse mask's geometry, source pixels. */
export interface EllipseMaskGeometry {
  readonly kind: 'ellipse';
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotation: number;
}

/** A path mask's shape at one instant. */
export interface PathMaskGeometry {
  readonly kind: 'path';
  readonly vertices: readonly MaskPathVertex[];
}

export type MaskGeometry = RectangleMaskGeometry | EllipseMaskGeometry | PathMaskGeometry;

/**
 * A split (half-plane) mask's placement, source pixels (MK8.1). The line passes through the
 * origin at `angle` degrees clockwise (0 = left to right); the mask keeps the side on the LEFT
 * of that direction of travel, so angle 0 keeps the part above the line.
 */
export interface LinearMaskGeometry {
  readonly kind: 'linear';
  readonly originX: number;
  readonly originY: number;
  readonly angle: number;
  readonly softnessPx: number;
}

/** A band (mirror / filmstrip) mask: `widthPx` wide, centred on the line through the origin. */
export interface BandMaskGeometry {
  readonly kind: 'band';
  readonly originX: number;
  readonly originY: number;
  readonly angle: number;
  readonly widthPx: number;
  readonly softnessPx: number;
}

/** A gradient mask: opaque at the start, clear at the end (radial: at the distance to it). */
export interface GradientMaskGeometry {
  readonly kind: 'gradient';
  readonly shape: 'linear' | 'radial';
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  readonly curve: 'linear' | 'smooth' | 'gaussian';
}

/** The analytic kinds: drawn from a line or a centre, edited by their own handles (MK8.1). */
export type AnalyticMaskGeometry = LinearMaskGeometry | BandMaskGeometry | GradientMaskGeometry;

/** Whether a mask kind is one of the analytic kinds. */
export const isAnalyticMask = (
  mask: MaskLayer,
): mask is Extract<MaskLayer, { kind: AnalyticMaskGeometry['kind'] }> =>
  mask.kind === 'linear' || mask.kind === 'band' || mask.kind === 'gradient';

/** The shape kinds the hand tools draw and edit. */
export type EditableMaskKind = MaskGeometry['kind'];

const RECTANGLE_FIELDS = ['cx', 'cy', 'width', 'height', 'rotation', 'roundness'] as const;
const ELLIPSE_FIELDS = ['cx', 'cy', 'rx', 'ry', 'rotation'] as const;

/** Two instants closer than this are the same keyframe slot, seconds. */
export const MASK_KEYFRAME_SAME_INSTANT = 1e-6;

/** Overlay colours given to new masks in turn, so neighbouring masks are told apart. */
export const MASK_COLORS = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#eab308',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#ef4444',
] as const;

/** The first palette colour no mask on the clip uses, else the next one in turn. */
export function nextMaskColor(clip: Pick<Clip, 'masks'>): string {
  const used = new Set(masksOf(clip).map((mask) => mask.color.toLowerCase()));
  const free = MASK_COLORS.find((color) => !used.has(color));
  return free ?? MASK_COLORS[masksOf(clip).length % MASK_COLORS.length]!;
}

/** Whether a mask kind is one the hand tools edit. */
export const isEditableMask = (
  mask: MaskLayer,
): mask is Extract<MaskLayer, { kind: EditableMaskKind }> =>
  mask.kind === 'rectangle' || mask.kind === 'ellipse' || mask.kind === 'path';

/**
 * A path mask's vertices at a source instant: the keyframe itself at a keyframe instant, the
 * eased interpolation between two keyframes, and the nearest keyframe outside them. Vertex
 * types come from the earlier keyframe, as the rasteriser reads them.
 */
export function maskPathVerticesAt(mask: PathMask, sourceTime: number): MaskPathVertex[] {
  const frames = [...mask.pathKeyframes].sort((a, b) => a.sourceTime - b.sourceTime);
  const first = frames[0];
  if (first === undefined) return [];
  if (sourceTime <= first.sourceTime) return decodeMaskPath(first);
  const last = frames[frames.length - 1]!;
  if (sourceTime >= last.sourceTime) return decodeMaskPath(last);
  for (let index = 0; index + 1 < frames.length; index += 1) {
    const left = frames[index]!;
    const right = frames[index + 1]!;
    if (!(left.sourceTime <= sourceTime && sourceTime <= right.sourceTime)) continue;
    const local = (sourceTime - left.sourceTime) / (right.sourceTime - left.sourceTime);
    const progress = segmentProgress(
      { easing: left.easing, handles: left.handles },
      { easing: right.easing, handles: right.handles },
      local,
    );
    const a = decodeMaskPath(left);
    const b = decodeMaskPath(right);
    const mix = (x: number, y: number): number => x + (y - x) * progress;
    return a.map((vertex, position) => {
      const other = b[position] ?? vertex;
      const feather =
        vertex.featherPx === undefined && other.featherPx === undefined
          ? undefined
          : mix(vertex.featherPx ?? 0, other.featherPx ?? 0);
      return {
        x: mix(vertex.x, other.x),
        y: mix(vertex.y, other.y),
        inX: mix(vertex.inX, other.inX),
        inY: mix(vertex.inY, other.inY),
        outX: mix(vertex.outX, other.outX),
        outY: mix(vertex.outY, other.outY),
        type: vertex.type,
        ...(feather === undefined ? {} : { featherPx: feather }),
      };
    });
  }
  return decodeMaskPath(last);
}

/**
 * A rectangle, ellipse or path mask's geometry at a source instant, or `null` for kinds the
 * hand tools do not edit (and for `units: 'normalized'` masks, whose geometry is not pixels).
 */
export function maskGeometryAt(mask: MaskLayer, sourceTime: number): MaskGeometry | null {
  if (mask.units === 'normalized') return null;
  const value = (property: MaskScalarProperty): number =>
    maskScalarAt(mask, property, sourceTime) ?? 0;
  if (mask.kind === 'rectangle') {
    return {
      kind: 'rectangle',
      cx: value('cx'),
      cy: value('cy'),
      width: value('width'),
      height: value('height'),
      rotation: value('rotation'),
      roundness: value('roundness'),
    };
  }
  if (mask.kind === 'ellipse') {
    return {
      kind: 'ellipse',
      cx: value('cx'),
      cy: value('cy'),
      rx: value('rx'),
      ry: value('ry'),
      rotation: value('rotation'),
    };
  }
  if (mask.kind === 'path') return { kind: 'path', vertices: maskPathVerticesAt(mask, sourceTime) };
  return null;
}

/** Whether `property` has any keyframe on `mask`. */
export const isMaskPropertyAnimated = (mask: MaskLayer, property: MaskScalarProperty): boolean =>
  mask.keyframes.some((keyframe) => keyframe.property === property);

/** The instants a mask has keyframes at (scalar and path), ascending and de-duplicated. */
export function maskKeyframeTimes(
  mask: MaskLayer,
  property?: MaskScalarProperty | 'path',
): number[] {
  const times: number[] = [];
  if (property === undefined || property !== 'path') {
    for (const keyframe of mask.keyframes) {
      if (property === undefined || keyframe.property === property) times.push(keyframe.sourceTime);
    }
  }
  if (mask.kind === 'path' && (property === undefined || property === 'path')) {
    // A path with one keyframe is a static shape, not an animation.
    if (mask.pathKeyframes.length > 1 || property === 'path') {
      for (const keyframe of mask.pathKeyframes) times.push(keyframe.sourceTime);
    }
  }
  times.sort((a, b) => a - b);
  return times.filter(
    (time, index) => index === 0 || time - times[index - 1]! > MASK_KEYFRAME_SAME_INSTANT,
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface MaskCommandBase {
  /** The timeline revision the command was built against (refused when stale). */
  readonly timelineRevision: number;
  /** The owner of the mask stack: a clip, or an effect layer when `owner` says so. */
  readonly clipId: string;
  /**
   * Whose stack `clipId` names (MK9.1). Absent = a clip. `effect_layer` edits an adjustment
   * lane's frame-space stack with the SAME commands the clip panel and monitor use, so drawing,
   * reshaping and keyframing a lane's mask is not a second implementation. Keyframe instants are
   * then seconds from the layer's start and geometry is in output-frame pixels.
   */
  readonly owner?: 'clip' | 'effect_layer';
  /** Who is editing; the patch records it. Defaults to `user`. */
  readonly createdBy?: PatchAuthor;
}

/** Draw a new rectangle, ellipse or path mask. */
export interface DrawMaskCommand extends MaskCommandBase {
  readonly type: 'draw_mask';
  /** A hand-drawn shape, or a split, band or gradient placed with its tool (MK8.1). */
  readonly geometry: MaskGeometry | AnalyticMaskGeometry;
  /** Source instant a path's first keyframe sits at (the playhead's source time). */
  readonly sourceTime: number;
  readonly name?: string;
  /** Top of the stack (`0`) by default; absent index appends at the bottom when `false`. */
  readonly atTop?: boolean;
  /**
   * What the new mask limits (MK5.1). Absent = the clip's alpha, the ordinary cut-out.
   * `{ kind: 'effect', effectId }` makes it an effect-target mask in ONE operation, so the
   * "Add mask" button on an effect row is a single undo step rather than draw-then-retarget.
   */
  readonly target?: MaskTarget;
}

/**
 * Insert a shape preset (MK8.3): heart, star, polygon, speech bubble, arrow or rounded frame,
 * generated as ordinary `path` masks the editor then edits like any drawn path. One patch, one
 * undo, even for the rounded frame's two paths.
 */
export interface DrawShapePresetCommand extends MaskCommandBase {
  readonly type: 'draw_shape_preset';
  readonly preset: MaskShapePreset;
  /** Bounding box, display-corrected source pixels; rotation clockwise degrees. */
  readonly box: ShapePresetBox;
  readonly options?: ShapePresetOptions;
  /** Source instant each path's first keyframe sits at. */
  readonly sourceTime: number;
  readonly name?: string;
  readonly target?: MaskTarget;
}

/**
 * Use another clip or a whole track as this clip's mask (MK8.2): track matte, text as a mask.
 * The source is then rendered only as the matte (the frame plan marks it `matteOnly`).
 */
export interface AddTrackMatteCommand extends MaskCommandBase {
  readonly type: 'add_track_matte';
  readonly source:
    | { readonly kind: 'clip'; readonly clipId: string }
    | { readonly kind: 'track'; readonly trackId: string };
  /** `alpha` (default), `luma`, `inverted-alpha` or `inverted-luma`. */
  readonly channel?: 'alpha' | 'luma' | 'inverted-alpha' | 'inverted-luma';
  readonly name?: string;
  readonly target?: MaskTarget;
}

/** Change a mask's shape at a source instant (a monitor drag, a typed px field). */
export interface SetMaskGeometryCommand extends MaskCommandBase {
  readonly type: 'set_mask_geometry';
  readonly maskId: string;
  readonly sourceTime: number;
  readonly geometry: MaskGeometry;
}

/** Scalar and settings changes from the mask panel. */
/**
 * A value `set_mask_properties` can write.
 *
 * Numbers, strings and booleans are the scalars and settings; the structured values are the
 * fields a kind carries whole — a key's `ranges` and `samples3d`, a finesse group (MK6.1).
 * They are never keyframed, so they pass straight through to `update_mask`, where the schema
 * parse refuses anything malformed.
 */
export type MaskPropertyValue =
  number | string | boolean | readonly unknown[] | Readonly<Record<string, unknown>>;

export interface SetMaskPropertiesCommand extends MaskCommandBase {
  readonly type: 'set_mask_properties';
  readonly maskId: string;
  readonly sourceTime: number;
  readonly changes: Readonly<Record<string, MaskPropertyValue>>;
  /** "Apply to all keyframes": an animated property changes by the same amount everywhere. */
  readonly allKeyframes?: boolean;
}

/** Add a keyframe at the instant, or remove the one there (the panel's keyframe toggle). */
export interface ToggleMaskKeyframeCommand extends MaskCommandBase {
  readonly type: 'toggle_mask_keyframe';
  readonly maskId: string;
  readonly property: MaskScalarProperty | 'path';
  readonly sourceTime: number;
}

export interface InsertMaskVertexCommand extends MaskCommandBase {
  readonly type: 'insert_mask_vertex';
  readonly maskId: string;
  readonly segment: number;
  readonly t: number;
}

export interface RemoveMaskVerticesCommand extends MaskCommandBase {
  readonly type: 'remove_mask_vertices';
  readonly maskId: string;
  readonly vertices: readonly number[];
}

/** Shift a mask's keyframes in source time (the timeline lane drag). */
export interface MoveMaskKeyframesCommand extends MaskCommandBase {
  readonly type: 'move_mask_keyframes';
  readonly maskId: string;
  readonly keyframeIds: readonly string[];
  readonly deltaSeconds: number;
}

export interface RemoveMaskCommand extends MaskCommandBase {
  readonly type: 'remove_mask';
  readonly maskId: string;
}

/** Put the stack in this order (top first). */
export interface ReorderMasksCommand extends MaskCommandBase {
  readonly type: 'reorder_masks';
  readonly maskIds: readonly string[];
}

export interface SetMaskTargetCommand extends MaskCommandBase {
  readonly type: 'set_mask_target';
  readonly maskId: string;
  readonly target: MaskTarget;
}

/**
 * Fix a clip mask to the output frame or back to the picture (MK9.4). The geometry keeps its
 * numbers: in `frame` space they are output-frame pixels, in `source` space source pixels.
 */
export interface SetMaskSpaceCommand extends MaskCommandBase {
  readonly type: 'set_mask_space';
  readonly maskId: string;
  readonly space: MaskSpace;
}

export interface DuplicateMaskCommand extends MaskCommandBase {
  readonly type: 'duplicate_mask';
  readonly maskId: string;
}

/** Masks copied from a clip, with what pasting needs to rescale them. */
export interface MaskClipboard {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly sourceStart: number;
  readonly masks: readonly MaskLayer[];
}

export interface PasteMasksCommand extends MaskCommandBase {
  readonly type: 'paste_masks';
  readonly clipboard: MaskClipboard;
}

/** Save the chosen masks of a clip as a project preset (MK4.3). */
export interface SaveMaskPresetCommand extends MaskCommandBase {
  readonly type: 'save_mask_preset';
  readonly name: string;
  readonly maskIds: readonly string[];
}

/** Add a preset's masks to a clip, rescaled to its picture. */
export interface ApplyMaskPresetCommand extends MaskCommandBase {
  readonly type: 'apply_mask_preset';
  readonly presetId: string;
}

export interface RemoveMaskPresetCommand extends MaskCommandBase {
  readonly type: 'remove_mask_preset';
  readonly presetId: string;
}

/**
 * Attach (or replace) a mask's transform track after a track job finished (MK7.3).
 *
 * The host measures and writes the artifact; this is where that measurement becomes a
 * reversible edit, so undo takes the mask back to the track it had — never to "no track" when
 * it had one before.
 */
export interface SetMaskTrackCommand extends MaskCommandBase {
  readonly type: 'set_mask_track';
  readonly maskId: string;
  readonly tracking: MaskTrackingInput;
}

/** Detach a mask's track; the mask keeps its own animation. */
export interface ClearMaskTrackCommand extends MaskCommandBase {
  readonly type: 'clear_mask_track';
  readonly maskId: string;
}

/**
 * Mark the frame the editor just fixed as a hard constraint (MK7.3).
 *
 * The constraint is a source instant, the same clock the mask's keyframes use, so trimming or
 * re-speeding the clip cannot move the frame the editor confirmed. Re-measuring from it is a
 * separate job; this only records the promise the re-track has to keep.
 */
export interface AddTrackConstraintCommand extends MaskCommandBase {
  readonly type: 'add_track_constraint';
  readonly maskId: string;
  readonly sourceTime: number;
}

/**
 * Correct a tracked mask on one frame (MK7.7): what an editor does on a frame the tracker got
 * wrong, and what the agent does on their behalf.
 *
 * `geometry` is where the mask belongs ON THE SCREEN at `sourceTime` — the tracked picture the
 * editor is looking at — and `track` is the track's state at that instant, read from the same
 * artifact the renderers read (`trackStateAt`). The command stores the geometry relative to the
 * tracked motion (`T(c)⁻¹ · D`, `mask-track-correction.ts`), as hold keyframes over the stretch
 * a re-track re-measures from this frame, and makes the frame a constraint — one reversible
 * patch. "Re-track from constraints" then continues the track from here.
 */
export interface CorrectTrackedMaskCommand extends MaskCommandBase {
  readonly type: 'correct_tracked_mask';
  readonly maskId: string;
  readonly sourceTime: number;
  readonly geometry: MaskGeometry;
  readonly track: TrackStateAt;
}

/** Replace a track's review state — approving a range, locking an instant (MK7.3). */
export interface ReviewMaskTrackCommand extends MaskCommandBase {
  readonly type: 'review_mask_track';
  readonly maskId: string;
  readonly review: MaskReviewInput;
}

/**
 * A matte artifact exactly as the host reported it (BR6.1).
 *
 * Structurally typed rather than the schema's own type, because the host's answer is READ-ONLY and
 * its file names are strings it verified, not a compile-time union. The schema parse on apply is
 * what admits it into the project, so nothing here is trusted without validation.
 */
export interface MatteArtifactRef {
  readonly key: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  readonly width: number;
  readonly height: number;
  readonly coverage: { readonly sourceStart: number; readonly sourceEnd: number };
  readonly packId: string;
  readonly packVersion: string;
  readonly modelDigests: readonly string[];
}

/** A prompt reference as the host reported it, same reasoning as {@link MatteArtifactRef}. */
export type MattePromptRefInput =
  | {
      readonly kind: 'points';
      readonly sourceTime: number;
      readonly points: readonly {
        readonly x: number;
        readonly y: number;
        readonly label: 'include' | 'exclude';
      }[];
    }
  | {
      readonly kind: 'box';
      readonly sourceTime: number;
      readonly box: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }
  | { readonly kind: 'brush' | 'lock'; readonly sourceTime: number; readonly sha256: string }
  | { readonly kind: 'candidate'; readonly candidateId: string };

/**
 * Commit a finished background-removal run as a matte mask (BR6.1).
 *
 * The pack measured the alpha and main wrote and verified the artifact; this is where that
 * measurement becomes a reversible project edit. A re-run names the mask it replaces, so
 * "fix a moment and run again" stays ONE mask with a new artifact instead of a growing stack,
 * and undo puts the previous artifact back rather than deleting the mask.
 */
export interface AddMatteMaskCommand extends MaskCommandBase {
  readonly type: 'add_matte_mask';
  readonly artifact: MatteArtifactRef;
  readonly prompts?: readonly MattePromptRefInput[];
  readonly review?: MaskReviewInput;
  /** Edge quality the editor chose before running (RD0's Sharp/Smooth parity control). */
  readonly edgeMode?: 'sharp' | 'smooth';
  readonly name?: string;
  /** Replace this matte's artifact instead of adding a mask (a re-run after a fix). */
  readonly maskId?: string;
}

/** Approve, re-flag or lock moments of a matte's review (BR6.5). */
export interface ReviewMatteCommand extends MaskCommandBase {
  readonly type: 'review_matte';
  readonly maskId: string;
  readonly review: MaskReviewInput;
}

/**
 * Put text between a subject and its background (BR6.6).
 *
 * The same result the editor can build by hand — duplicate the clip, remove the background on
 * the top copy, put the text between — as one operation with one undo.
 */
export interface TextBehindSubjectCommand extends MaskCommandBase {
  readonly type: 'text_behind_subject';
  readonly text: string;
  /** The matte to move onto the front copy; absent ⇒ the clip's first alpha matte. */
  readonly maskId?: string;
  /** Extra `text` effect params (font, size, colour, position). */
  readonly style?: Readonly<Record<string, unknown>>;
  /** When the title is on screen, timeline seconds; each defaults to the clip's own edge. */
  readonly start?: number;
  readonly end?: number;
}

export type MaskCommand =
  | AddMatteMaskCommand
  | ReviewMatteCommand
  | TextBehindSubjectCommand
  | SetMaskTrackCommand
  | ClearMaskTrackCommand
  | AddTrackConstraintCommand
  | CorrectTrackedMaskCommand
  | ReviewMaskTrackCommand
  | SaveMaskPresetCommand
  | ApplyMaskPresetCommand
  | RemoveMaskPresetCommand
  | DrawMaskCommand
  | DrawShapePresetCommand
  | AddTrackMatteCommand
  | SetMaskGeometryCommand
  | SetMaskPropertiesCommand
  | ToggleMaskKeyframeCommand
  | InsertMaskVertexCommand
  | RemoveMaskVerticesCommand
  | MoveMaskKeyframesCommand
  | RemoveMaskCommand
  | ReorderMasksCommand
  | SetMaskTargetCommand
  | SetMaskSpaceCommand
  | DuplicateMaskCommand
  | PasteMasksCommand;

export type MaskCommandRejectionCode =
  | 'stale_timeline'
  | 'missing_clip'
  | 'missing_mask'
  | 'missing_track'
  | 'missing_effect'
  | 'needs_media_dimensions'
  | 'not_editable'
  | 'too_few_vertices'
  | 'nothing_to_change'
  | 'invalid_patch';

export type MaskCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: MaskCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
    }
  | {
      readonly status: 'rejected';
      readonly command: MaskCommand;
      readonly code: MaskCommandRejectionCode;
      readonly detail: string;
    };

export interface CompileMaskCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Pick<Asset, 'id' | 'media'>[];
  readonly command: MaskCommand;
}

/** A command refused before any patch was built. */
class Rejection extends Error {
  public constructor(
    public readonly code: MaskCommandRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findClip(timeline: Timeline, clipId: string): Clip {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return clip;
  }
  throw new Rejection('missing_clip', `Clip "${clipId}" does not exist.`);
}

function findMask(clip: Clip, maskId: string): MaskLayer {
  const mask = masksOf(clip).find((candidate) => candidate.id === maskId);
  if (mask === undefined) {
    throw new Rejection('missing_mask', `Mask "${maskId}" is not on clip "${clip.id}".`);
  }
  return mask;
}

/**
 * The target, refused up front when it names an effect the clip does not carry (MK5.1).
 *
 * The validator catches it too, but a command refused here says which effect is missing and
 * leaves no half-built patch behind.
 */
function assertTarget(clip: Clip, target: MaskTarget): MaskTarget {
  if (target.kind === 'effect' && !clip.effects.some((effect) => effect.id === target.effectId)) {
    throw new Rejection(
      'missing_effect',
      `Effect "${target.effectId}" is not on clip "${clip.id}". Add the effect first.`,
    );
  }
  return target;
}

function clipDisplaySize(clip: Clip, assets: readonly Pick<Asset, 'id' | 'media'>[]): DisplaySize {
  // An adjustment lane has no media: its masks are in frame pixels and need no measurement.
  if (clip.assetId === FRAME_OWNER_ASSET_ID) return { width: 0, height: 0 };
  const media = assets.find((asset) => asset.id === clip.assetId)?.media;
  const size = assetDisplaySize(media);
  if (size === null) throw new Rejection('needs_media_dimensions', MEASURE_MEDIA_FIRST);
  return size;
}

/** 32-bit FNV-1a, hex: a stable patch id from the operations it carries. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Keyframe ids are stable per property and instant (microseconds). */
function keyframeIdFor(mask: MaskLayer, property: string, sourceTime: number): string {
  const taken = new Set([
    ...mask.keyframes.map((keyframe) => keyframe.id),
    ...(mask.kind === 'path' ? mask.pathKeyframes.map((keyframe) => keyframe.id) : []),
  ]);
  const base = `${mask.id}__${property}__${String(Math.round(sourceTime * 1e6))}`;
  let id = base;
  for (let attempt = 2; taken.has(id); attempt += 1) id = `${base}_${String(attempt)}`;
  return id;
}

/**
 * Operations that give `property` the value `value` at `sourceTime`: keys the instant when the
 * property is animated (replacing a keyframe already there), else changes the static value.
 */
function scalarWrite(
  clipId: string,
  mask: MaskLayer,
  property: MaskScalarProperty,
  value: number,
  sourceTime: number,
  staticChanges: Record<string, unknown>,
): MaskOperation[] {
  const clamped = clampMaskScalar(property, value);
  if (!isMaskPropertyAnimated(mask, property)) {
    staticChanges[property] = clamped;
    return [];
  }
  const existing = mask.keyframes.find(
    (keyframe) =>
      keyframe.property === property &&
      Math.abs(keyframe.sourceTime - sourceTime) <= MASK_KEYFRAME_SAME_INSTANT,
  );
  if (existing !== undefined) {
    const replacement: MaskKeyframeInput = { ...existing, value: clamped };
    return [
      { type: 'remove_mask_keyframe', clipId, maskId: mask.id, keyframeId: existing.id },
      { type: 'add_mask_keyframe', clipId, maskId: mask.id, keyframe: replacement },
    ];
  }
  return [
    {
      type: 'add_mask_keyframe',
      clipId,
      maskId: mask.id,
      keyframe: {
        id: keyframeIdFor(mask, property, sourceTime),
        sourceTime,
        property,
        value: clamped,
        easing: 'linear',
      },
    },
  ];
}

function assertFiniteGeometry(geometry: MaskGeometry | AnalyticMaskGeometry): void {
  const numbers =
    geometry.kind === 'path'
      ? geometry.vertices.flatMap((vertex) => [
          vertex.x,
          vertex.y,
          vertex.inX,
          vertex.inY,
          vertex.outX,
          vertex.outY,
        ])
      : Object.values(geometry).filter((value): value is number => typeof value === 'number');
  if (!numbers.every(Number.isFinite)) {
    throw new Rejection('not_editable', 'Mask geometry must be finite numbers in source pixels.');
  }
  if (geometry.kind === 'path' && geometry.vertices.length < MIN_MASK_PATH_VERTICES) {
    throw new Rejection('too_few_vertices', 'A path mask needs at least three points.');
  }
}

function geometryFields(geometry: MaskGeometry): Record<string, number> {
  if (geometry.kind === 'rectangle') {
    return Object.fromEntries(RECTANGLE_FIELDS.map((field) => [field, geometry[field]]));
  }
  if (geometry.kind === 'ellipse') {
    return Object.fromEntries(ELLIPSE_FIELDS.map((field) => [field, geometry[field]]));
  }
  return {};
}

const KIND_NAMES: Readonly<Record<EditableMaskKind | AnalyticMaskGeometry['kind'], string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Path',
  linear: 'Split',
  band: 'Mirror',
  gradient: 'Gradient',
};

// ---------------------------------------------------------------------------
// Builders per command
// ---------------------------------------------------------------------------

interface Built {
  readonly operations: readonly MaskOperation[];
  readonly reason: string;
}

function buildDraw(input: CompileMaskCommandInput, command: DrawMaskCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  clipDisplaySize(clip, input.assets);
  assertFiniteGeometry(command.geometry);
  const id = nextMaskId(clip);
  const base = {
    id,
    name:
      command.name ??
      (isAnalyticGeometry(command.geometry)
        ? `${KIND_NAMES[command.geometry.kind]} ${String(masksOf(clip).length + 1)}`
        : `Mask ${String(masksOf(clip).length + 1)}`),
    color: nextMaskColor(clip),
    ...(command.target === undefined ? {} : { target: assertTarget(clip, command.target) }),
  };
  const { geometry } = command;
  let mask: MaskLayerInput;
  if (geometry.kind === 'band' && !(geometry.widthPx > 0)) {
    throw new Rejection('not_editable', 'A mirror band needs a width above zero.');
  }
  if (
    geometry.kind === 'gradient' &&
    geometry.startX === geometry.endX &&
    geometry.startY === geometry.endY
  ) {
    throw new Rejection('not_editable', 'Drag the gradient from where it starts to where it ends.');
  }
  if (geometry.kind === 'path') {
    mask = {
      ...base,
      kind: 'path',
      pathKeyframes: [
        {
          id: `${id}__path__0`,
          sourceTime: Math.max(0, command.sourceTime),
          ...encodeMaskPath(geometry.vertices),
        },
      ],
    };
  } else {
    mask = { ...base, ...geometry } as MaskLayerInput;
  }
  return {
    operations: [
      {
        type: 'add_mask',
        clipId: clip.id,
        mask,
        ...(command.atTop === false ? {} : { index: 0 }),
      },
    ],
    reason: `Draw ${KIND_NAMES[geometry.kind].toLowerCase()} mask on "${clip.id}"`,
  };
}

const isAnalyticGeometry = (
  geometry: MaskGeometry | AnalyticMaskGeometry,
): geometry is AnalyticMaskGeometry =>
  geometry.kind === 'linear' || geometry.kind === 'band' || geometry.kind === 'gradient';

function buildDrawShapePreset(
  input: CompileMaskCommandInput,
  command: DrawShapePresetCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  clipDisplaySize(clip, input.assets);
  let paths;
  try {
    paths = shapePresetPaths(command.preset, command.box, command.options ?? {});
  } catch (error) {
    if (error instanceof ShapePresetError) throw new Rejection('not_editable', error.message);
    throw error;
  }
  const target = command.target === undefined ? undefined : assertTarget(clip, command.target);
  const title = command.name ?? MASK_SHAPE_PRESET_NAMES[command.preset];
  const operations: MaskOperation[] = [];
  let masks = masksOf(clip);
  paths.forEach((path, index) => {
    const id = nextMaskId({ id: clip.id, masks: [...masks] });
    const mask: MaskLayerInput = {
      id,
      kind: 'path',
      name: path.part === undefined ? title : `${title} (${path.part})`,
      color: nextMaskColor({ masks: [...masks] }),
      mode: path.mode,
      ...(target === undefined ? {} : { target }),
      pathKeyframes: [
        {
          id: `${id}__path__0`,
          sourceTime: Math.max(0, command.sourceTime),
          ...encodeMaskPath(path.vertices),
        },
      ],
    };
    // Each path lands below the one before it, all at the top of the stack: a frame's hole
    // must be evaluated after the outer shape it subtracts from.
    operations.push({ type: 'add_mask', clipId: clip.id, mask, index });
    masks = [...masks.slice(0, index), mask as MaskLayer, ...masks.slice(index)];
  });
  return {
    operations,
    reason: `Add ${MASK_SHAPE_PRESET_NAMES[command.preset].toLowerCase()} mask on "${clip.id}"`,
  };
}

function buildAddTrackMatte(input: CompileMaskCommandInput, command: AddTrackMatteCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const { source } = command;
  if (source.kind === 'clip') {
    findClip(input.timeline, source.clipId);
    if (source.clipId === clip.id) {
      throw new Rejection(
        'not_editable',
        'A clip cannot be its own track matte. Pick another clip.',
      );
    }
  } else if (!input.timeline.tracks.some((track) => track.id === source.trackId)) {
    throw new Rejection('missing_track', `Track "${source.trackId}" does not exist.`);
  }
  const id = nextMaskId(clip);
  const mask: MaskLayerInput = {
    id,
    kind: 'layer',
    name: command.name ?? `Track matte ${String(masksOf(clip).length + 1)}`,
    color: nextMaskColor(clip),
    source:
      source.kind === 'clip'
        ? { kind: 'clip', clipId: source.clipId }
        : { kind: 'track', trackId: source.trackId },
    channel: command.channel ?? 'alpha',
    ...(command.target === undefined ? {} : { target: assertTarget(clip, command.target) }),
  };
  return {
    operations: [{ type: 'add_mask', clipId: clip.id, mask, index: 0 }],
    reason: `Use ${source.kind === 'clip' ? `clip "${source.clipId}"` : `track "${source.trackId}"`} as the mask of "${clip.id}"`,
  };
}

function buildSetGeometry(input: CompileMaskCommandInput, command: SetMaskGeometryCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  assertFiniteGeometry(command.geometry);
  if (!isEditableMask(mask) || mask.kind !== command.geometry.kind || mask.units === 'normalized') {
    throw new Rejection(
      'not_editable',
      `Mask "${mask.id}" is a ${mask.kind} mask; draw a new mask to change its kind.`,
    );
  }
  const reason = `Edit mask "${mask.name || mask.id}" on "${clip.id}"`;
  if (command.geometry.kind === 'path' && mask.kind === 'path') {
    const encoded = encodeMaskPath(command.geometry.vertices);
    const count = mask.pathKeyframes[0]?.vertexTypes.length ?? 0;
    if (mask.pathKeyframes.length > 1 && encoded.vertexTypes.length !== count) {
      throw new Rejection(
        'not_editable',
        `Every keyframe of path mask "${mask.id}" must keep the same number of points. Add or remove points instead.`,
      );
    }
    const atInstant = mask.pathKeyframes.find(
      (keyframe) =>
        Math.abs(keyframe.sourceTime - command.sourceTime) <= MASK_KEYFRAME_SAME_INSTANT,
    );
    const target =
      atInstant ?? (mask.pathKeyframes.length === 1 ? mask.pathKeyframes[0] : undefined);
    const keyframe =
      target !== undefined
        ? { ...target, ...encoded }
        : {
            id: keyframeIdFor(mask, 'path', command.sourceTime),
            sourceTime: command.sourceTime,
            easing: 'linear' as const,
            ...encoded,
          };
    if (target !== undefined && target.featherPx !== undefined && encoded.featherPx === undefined) {
      delete (keyframe as { featherPx?: unknown }).featherPx;
    }
    return {
      operations: [{ type: 'set_mask_path', clipId: clip.id, maskId: mask.id, keyframe }],
      reason,
    };
  }
  const staticChanges: Record<string, unknown> = {};
  const keyed: MaskOperation[] = [];
  const current = maskGeometryAt(mask, command.sourceTime);
  for (const [field, value] of Object.entries(geometryFields(command.geometry))) {
    const before =
      current === null ? undefined : (current as unknown as Record<string, number>)[field];
    if (before === value) continue;
    keyed.push(
      ...scalarWrite(
        clip.id,
        mask,
        field as MaskScalarProperty,
        value,
        command.sourceTime,
        staticChanges,
      ),
    );
  }
  const operations: MaskOperation[] = [];
  if (Object.keys(staticChanges).length > 0) {
    operations.push({
      type: 'update_mask',
      clipId: clip.id,
      maskId: mask.id,
      changes: staticChanges,
    });
  }
  operations.push(...keyed);
  return { operations, reason };
}

/** Remedies for a correction the track cannot carry, without varying magnitudes. */
const UNTRACK_REMEDIES = {
  perspective_shape:
    'A rectangle or an ellipse under a perspective track is no longer a rectangle on screen. Draw the mask as a path to correct it, or track it with position, scale and rotation.',
  degenerate:
    'The track has no usable transform on this frame. Track the mask again from a clearer frame.',
} as const;

function buildCorrectTrackedMask(
  input: CompileMaskCommandInput,
  command: CorrectTrackedMaskCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  const tracking = mask.tracking;
  if (tracking === undefined) {
    throw new Rejection(
      'missing_track',
      'This mask has no track to correct. Track the mask first, or edit it directly.',
    );
  }
  assertFiniteGeometry(command.geometry);
  if (!isEditableMask(mask) || mask.kind !== command.geometry.kind || mask.units === 'normalized') {
    throw new Rejection(
      'not_editable',
      `Mask "${mask.id}" is a ${mask.kind} mask; draw a new mask to change its kind.`,
    );
  }
  const own = untrackGeometry(command.geometry, command.track);
  if (typeof own === 'string') throw new Rejection('not_editable', UNTRACK_REMEDIES[own]);
  const span = correctionSpan(
    tracking.review?.flagged ?? [],
    command.sourceTime,
    command.track.frameSeconds,
  );
  const operations: MaskOperation[] =
    own.kind === 'path' && mask.kind === 'path'
      ? correctionPathOps(clip.id, mask, own.vertices, span)
      : correctionScalarOps(clip.id, mask, geometryFields(own), span);
  const constraints = withConstraint(tracking.constraints, command.sourceTime);
  operations.push({
    type: 'apply_mask_tracking',
    clipId: clip.id,
    maskId: mask.id,
    tracking: { ...tracking, constraints: [...constraints] },
  });
  return { operations, reason: `Correct the tracked mask "${mask.name || mask.id}" on this frame` };
}

/**
 * The instants a correction writes and what each holds: the old geometry just before the
 * stretch, the correction from its start, the old geometry again from its end.
 */
function correctionInstants(
  span: ReturnType<typeof correctionSpan>,
): readonly { readonly time: number; readonly corrected: boolean; readonly hold: boolean }[] {
  return [
    ...(span.before === null ? [] : [{ time: span.before, corrected: false, hold: true }]),
    { time: span.start, corrected: true, hold: true },
    { time: span.end, corrected: false, hold: false },
  ];
}

function sameInstant(left: number, right: number): boolean {
  return Math.abs(left - right) <= MASK_KEYFRAME_SAME_INSTANT;
}

/** Keyframes strictly inside the corrected stretch belong to the animation it replaces. */
function insideSpan(time: number, span: ReturnType<typeof correctionSpan>): boolean {
  const low = span.before ?? span.start;
  return time > low + MASK_KEYFRAME_SAME_INSTANT && time < span.end - MASK_KEYFRAME_SAME_INSTANT;
}

function correctionPathOps(
  clipId: string,
  mask: PathMask,
  corrected: readonly MaskPathVertex[],
  span: ReturnType<typeof correctionSpan>,
): MaskOperation[] {
  const count = mask.pathKeyframes[0]?.vertexTypes.length ?? 0;
  if (corrected.length !== count) {
    throw new Rejection(
      'not_editable',
      `Every keyframe of path mask "${mask.id}" must keep the same number of points. Add or remove points instead.`,
    );
  }
  const instants = correctionInstants(span);
  // The old animation is read BEFORE anything changes.
  const old = new Map(
    instants.map((instant) => [instant.time, maskGeometryAt(mask, instant.time)] as const),
  );
  const operations: MaskOperation[] = [];
  for (const keyframe of mask.pathKeyframes) {
    if (!insideSpan(keyframe.sourceTime, span)) continue;
    if (instants.some((instant) => sameInstant(instant.time, keyframe.sourceTime))) continue;
    operations.push({
      type: 'remove_mask_keyframe',
      clipId,
      maskId: mask.id,
      keyframeId: keyframe.id,
    });
  }
  for (const instant of instants) {
    const geometry = old.get(instant.time);
    const vertices = instant.corrected
      ? corrected
      : geometry !== null && geometry !== undefined && geometry.kind === 'path'
        ? geometry.vertices
        : corrected;
    const existing = mask.pathKeyframes.find((keyframe) =>
      sameInstant(keyframe.sourceTime, instant.time),
    );
    const encoded = encodeMaskPath(vertices);
    operations.push({
      type: 'set_mask_path',
      clipId,
      maskId: mask.id,
      keyframe: {
        id: existing?.id ?? keyframeIdFor(mask, 'path', instant.time),
        sourceTime: instant.time,
        easing: instant.hold ? 'hold' : (existing?.easing ?? 'linear'),
        ...(existing?.handles === undefined || instant.hold ? {} : { handles: existing.handles }),
        ...encoded,
      },
    });
  }
  return operations;
}

function correctionScalarOps(
  clipId: string,
  mask: MaskLayer,
  corrected: Readonly<Record<string, number>>,
  span: ReturnType<typeof correctionSpan>,
): MaskOperation[] {
  const instants = correctionInstants(span);
  const operations: MaskOperation[] = [];
  for (const [field, value] of Object.entries(corrected)) {
    const property = field as MaskScalarProperty;
    const keyframes = mask.keyframes.filter((keyframe) => keyframe.property === property);
    const old = new Map(
      instants.map(
        (instant) => [instant.time, maskScalarAt(mask, property, instant.time) ?? value] as const,
      ),
    );
    if (
      instants.every((instant) => (instant.corrected ? value : old.get(instant.time)) === value)
    ) {
      // Nothing changes for this property anywhere.
      continue;
    }
    for (const keyframe of keyframes) {
      if (!insideSpan(keyframe.sourceTime, span)) continue;
      if (instants.some((instant) => sameInstant(instant.time, keyframe.sourceTime))) continue;
      operations.push({
        type: 'remove_mask_keyframe',
        clipId,
        maskId: mask.id,
        keyframeId: keyframe.id,
      });
    }
    for (const instant of instants) {
      const existing = keyframes.find((keyframe) => sameInstant(keyframe.sourceTime, instant.time));
      if (existing !== undefined) {
        operations.push({
          type: 'remove_mask_keyframe',
          clipId,
          maskId: mask.id,
          keyframeId: existing.id,
        });
      }
      operations.push({
        type: 'add_mask_keyframe',
        clipId,
        maskId: mask.id,
        keyframe: {
          id: existing?.id ?? keyframeIdFor(mask, property, instant.time),
          sourceTime: instant.time,
          property,
          value: clampMaskScalar(property, instant.corrected ? value : old.get(instant.time)!),
          easing: instant.hold ? 'hold' : (existing?.easing ?? 'linear'),
        },
      });
    }
  }
  return operations;
}

function buildSetProperties(
  input: CompileMaskCommandInput,
  command: SetMaskPropertiesCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  const animatable: readonly string[] = MASK_ANIMATABLE_PROPERTIES[mask.kind];
  const staticChanges: Record<string, unknown> = {};
  const offsets: Partial<Record<MaskScalarProperty, number>> = {};
  const keyed: MaskOperation[] = [];
  for (const [field, value] of Object.entries(command.changes)) {
    if (typeof value !== 'number' || !animatable.includes(field)) {
      staticChanges[field] = value;
      continue;
    }
    if (!Number.isFinite(value)) {
      throw new Rejection('not_editable', `Mask property "${field}" must be a finite number.`);
    }
    const property = field as MaskScalarProperty;
    if (command.allKeyframes === true && isMaskPropertyAnimated(mask, property)) {
      const offset = value - (maskScalarAt(mask, property, command.sourceTime) ?? 0);
      offsets[property] = offset;
      const stored = (mask as unknown as Record<string, unknown>)[property];
      staticChanges[property] = clampMaskScalar(
        property,
        (typeof stored === 'number' ? stored : 0) + offset,
      );
      continue;
    }
    keyed.push(...scalarWrite(clip.id, mask, property, value, command.sourceTime, staticChanges));
  }
  const operations: MaskOperation[] = [];
  if (Object.keys(staticChanges).length > 0 || Object.keys(offsets).length > 0) {
    operations.push({
      type: 'update_mask',
      clipId: clip.id,
      maskId: mask.id,
      changes: staticChanges,
      ...(Object.keys(offsets).length > 0 ? { keyframeOffsets: offsets } : {}),
    });
  }
  operations.push(...keyed);
  const scope = command.allKeyframes === true ? ' on every keyframe' : '';
  return { operations, reason: `Change mask "${mask.name || mask.id}"${scope} on "${clip.id}"` };
}

function buildToggleKeyframe(
  input: CompileMaskCommandInput,
  command: ToggleMaskKeyframeCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  const at = command.sourceTime;
  const same = (time: number): boolean => Math.abs(time - at) <= MASK_KEYFRAME_SAME_INSTANT;
  if (command.property === 'path') {
    if (mask.kind !== 'path') {
      throw new Rejection('not_editable', `Mask "${mask.id}" has no path to keyframe.`);
    }
    const existing = mask.pathKeyframes.find((keyframe) => same(keyframe.sourceTime));
    if (existing !== undefined) {
      if (mask.pathKeyframes.length === 1) {
        // Refused with words rather than silently: the editor clicked expecting something. With
        // one keyframe the path is static and a reshape anywhere edits that one shape
        // (`buildSetGeometry`), so the remedy is a second keyframe, not a reshape.
        throw new Rejection(
          'not_editable',
          'This is the path’s only shape. Move the playhead to where it should change and press Animate there, then reshape it.',
        );
      }
      return {
        operations: [
          {
            type: 'remove_mask_keyframe',
            clipId: clip.id,
            maskId: mask.id,
            keyframeId: existing.id,
          },
        ],
        reason: `Remove path keyframe from mask "${mask.name || mask.id}"`,
      };
    }
    return {
      operations: [
        {
          type: 'set_mask_path',
          clipId: clip.id,
          maskId: mask.id,
          keyframe: {
            id: keyframeIdFor(mask, 'path', at),
            sourceTime: at,
            easing: 'linear',
            ...encodeMaskPath(maskPathVerticesAt(mask, at)),
          },
        },
      ],
      reason: `Add path keyframe to mask "${mask.name || mask.id}"`,
    };
  }
  const property = command.property;
  if (!(MASK_ANIMATABLE_PROPERTIES[mask.kind] as readonly string[]).includes(property)) {
    throw new Rejection('not_editable', `A ${mask.kind} mask cannot animate "${property}".`);
  }
  const ofProperty = mask.keyframes.filter((keyframe) => keyframe.property === property);
  const existing = ofProperty.find((keyframe) => same(keyframe.sourceTime));
  if (existing !== undefined) {
    const operations: MaskOperation[] = [
      { type: 'remove_mask_keyframe', clipId: clip.id, maskId: mask.id, keyframeId: existing.id },
    ];
    // The last keyframe leaving must not make the value jump: the static value takes it.
    if (ofProperty.length === 1) {
      operations.push({
        type: 'update_mask',
        clipId: clip.id,
        maskId: mask.id,
        changes: { [property]: existing.value },
      });
    }
    return {
      operations,
      reason: `Remove ${property} keyframe from mask "${mask.name || mask.id}"`,
    };
  }
  return {
    operations: [
      {
        type: 'add_mask_keyframe',
        clipId: clip.id,
        maskId: mask.id,
        keyframe: {
          id: keyframeIdFor(mask, property, at),
          sourceTime: at,
          property,
          value: maskScalarAt(mask, property, at) ?? 0,
          easing: 'linear',
        },
      },
    ],
    reason: `Add ${property} keyframe to mask "${mask.name || mask.id}"`,
  };
}

function buildRemoveVertices(
  input: CompileMaskCommandInput,
  command: RemoveMaskVerticesCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  if (mask.kind !== 'path') throw new Rejection('not_editable', `Mask "${mask.id}" has no points.`);
  const count = mask.pathKeyframes[0]?.vertexTypes.length ?? 0;
  const unique = [...new Set(command.vertices)].filter(
    (vertex) => Number.isInteger(vertex) && vertex >= 0 && vertex < count,
  );
  if (unique.length === 0) throw new Rejection('nothing_to_change', 'Select points to delete.');
  if (count - unique.length < MIN_MASK_PATH_VERTICES) {
    throw new Rejection(
      'too_few_vertices',
      'A path mask needs at least three points. Delete the mask instead.',
    );
  }
  // Highest index first, so earlier removals do not shift later ones.
  unique.sort((a, b) => b - a);
  return {
    operations: unique.map((vertex) => ({
      type: 'remove_mask_vertex' as const,
      clipId: clip.id,
      maskId: mask.id,
      vertex,
    })),
    reason: `Delete ${String(unique.length)} point(s) from mask "${mask.name || mask.id}"`,
  };
}

function buildMoveKeyframes(
  input: CompileMaskCommandInput,
  command: MoveMaskKeyframesCommand,
): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  if (!Number.isFinite(command.deltaSeconds) || command.deltaSeconds === 0) {
    throw new Rejection('nothing_to_change', 'Drag the keyframes to a new time.');
  }
  const all = [...mask.keyframes, ...(mask.kind === 'path' ? mask.pathKeyframes : [])];
  const wanted = new Set(command.keyframeIds);
  const moving = all.filter((keyframe) => wanted.has(keyframe.id));
  if (moving.length === 0) throw new Rejection('nothing_to_change', 'Select keyframes to move.');
  // Walk in the direction of travel so a keyframe never lands on one that has yet to move.
  moving.sort((a, b) =>
    command.deltaSeconds > 0 ? b.sourceTime - a.sourceTime : a.sourceTime - b.sourceTime,
  );
  return {
    operations: moving.map((keyframe) => ({
      type: 'move_mask_keyframe' as const,
      clipId: clip.id,
      maskId: mask.id,
      keyframeId: keyframe.id,
      sourceTime: Math.max(0, keyframe.sourceTime + command.deltaSeconds),
    })),
    reason: `Move ${String(moving.length)} keyframe(s) of mask "${mask.name || mask.id}"`,
  };
}

/**
 * Mask kinds a CLIP mask can be fixed to the frame as: the ones drawn from geometry. A matte and
 * a key read the clip's own picture and a track matte is already a frame picture (the engine's
 * `_assert_frame_space_drawable`, the monitor's `FRAME_SPACE_KINDS`).
 */
const FRAME_SPACE_KINDS: ReadonlySet<MaskLayer['kind']> = new Set<MaskLayer['kind']>([
  'rectangle',
  'ellipse',
  'path',
  'linear',
  'band',
  'gradient',
]);

/**
 * Why a clip mask cannot be fixed to the output frame, or `null` when it can (MK9.4). The
 * sentences are the export's and the monitor's refusals, so the toggle, the agent and a render
 * explain the same limit the same way.
 *
 * @param mask - The clip mask to fix to the frame.
 * @returns The plain reason with its remedy, or `null`.
 */
export function frameSpaceRefusal(mask: MaskLayer): string | null {
  if (!FRAME_SPACE_KINDS.has(mask.kind)) {
    return 'Only shapes, splits, bands and gradients can be fixed to the frame. A background removal, a key or a track matte follows the picture.';
  }
  if (mask.tracking !== undefined) {
    return 'This mask is tracked, and a track follows the picture. Clear the track to fix the mask to the frame.';
  }
  if (mask.units === 'normalized' || mask.featherModel === 'gaussian-legacy') {
    return 'This mask was migrated from an older project and cannot be fixed to the frame. Redraw it first.';
  }
  return null;
}

function buildSetSpace(input: CompileMaskCommandInput, command: SetMaskSpaceCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  if (mask.space === command.space) {
    throw new Rejection('nothing_to_change', 'The mask is already in that space.');
  }
  if (command.space === 'frame') {
    const refusal = frameSpaceRefusal(mask);
    if (refusal !== null) throw new Rejection('not_editable', refusal);
  }
  return {
    operations: [
      { type: 'set_mask_space', clipId: clip.id, maskId: mask.id, space: command.space },
    ],
    reason:
      command.space === 'frame'
        ? `Fix mask "${mask.name || mask.id}" to the frame`
        : `Make mask "${mask.name || mask.id}" follow the picture`,
  };
}

function buildDuplicate(input: CompileMaskCommandInput, command: DuplicateMaskCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const mask = findMask(clip, command.maskId);
  const id = nextMaskId(clip);
  const index = masksOf(clip).findIndex((candidate) => candidate.id === mask.id);
  const renameKeyframe = <T extends { readonly id: string }>(keyframe: T): T => ({
    ...keyframe,
    id: keyframe.id.startsWith(mask.id)
      ? `${id}${keyframe.id.slice(mask.id.length)}`
      : `${id}__${keyframe.id}`,
  });
  const copy = {
    ...mask,
    id,
    name: `${mask.name || 'Mask'} copy`,
    color: nextMaskColor(clip),
    locked: false,
    keyframes: mask.keyframes.map(renameKeyframe),
    ...(mask.kind === 'path' ? { pathKeyframes: mask.pathKeyframes.map(renameKeyframe) } : {}),
  } as MaskLayerInput;
  return {
    operations: [{ type: 'add_mask', clipId: clip.id, mask: copy, index }],
    reason: `Duplicate mask "${mask.name || mask.id}"`,
  };
}

function buildPaste(input: CompileMaskCommandInput, command: PasteMasksCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const size = clipDisplaySize(clip, input.assets);
  if (command.clipboard.masks.length === 0) {
    throw new Rejection('nothing_to_change', 'Copy a mask first.');
  }
  return {
    operations: [
      {
        type: 'paste_masks',
        clipId: clip.id,
        masks: command.clipboard.masks,
        from: {
          assetId: command.clipboard.assetId,
          width: command.clipboard.width,
          height: command.clipboard.height,
          sourceStart: command.clipboard.sourceStart,
        },
        to: size,
      },
    ],
    reason: `Paste ${String(command.clipboard.masks.length)} mask(s) onto "${clip.id}"`,
  };
}

/** Commit a finished background-removal run: a new matte, or a re-run of the one named. */
function buildAddMatte(input: CompileMaskCommandInput, command: AddMatteMaskCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const review = command.review ?? { flagged: [], approved: [], locked: [] };
  if (command.maskId !== undefined) {
    const mask = findMask(clip, command.maskId);
    if (mask.kind !== 'matte') {
      throw new Rejection(
        'not_editable',
        `Mask "${mask.id}" is not a background removal, so a matte cannot replace it.`,
      );
    }
    return {
      operations: [
        {
          type: 'update_mask',
          clipId: clip.id,
          maskId: mask.id,
          changes: {
            artifact: command.artifact,
            ...(command.prompts === undefined ? {} : { prompts: command.prompts }),
            ...(command.edgeMode === undefined ? {} : { edgeMode: command.edgeMode }),
            review,
          },
        },
      ],
      reason: `Update the background removal on "${clip.id}"`,
    };
  }
  const id = nextMaskId(clip);
  const mask = {
    id,
    name: command.name ?? 'Background removal',
    color: nextMaskColor(clip),
    kind: 'matte',
    artifact: command.artifact,
    prompts: command.prompts ?? [],
    ...(command.edgeMode === undefined ? {} : { edgeMode: command.edgeMode }),
    review,
  } as MaskLayerInput;
  return {
    operations: [{ type: 'add_mask', clipId: clip.id, mask, index: 0 }],
    reason: `Remove the background on "${clip.id}"`,
  };
}

function build(input: CompileMaskCommandInput): Built {
  const { command } = input;
  switch (command.type) {
    case 'add_matte_mask':
      return buildAddMatte(input, command);
    case 'review_matte': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      if (mask.kind !== 'matte') {
        throw new Rejection(
          'not_editable',
          `Mask "${mask.id}" is not a background removal, so it has nothing to review.`,
        );
      }
      return {
        operations: [
          {
            type: 'review_mask',
            clipId: clip.id,
            maskId: mask.id,
            subject: 'matte',
            review: command.review,
          },
        ],
        reason: `Review the background removal on "${clip.id}"`,
      };
    }
    case 'text_behind_subject': {
      const clip = findClip(input.timeline, command.clipId);
      if (command.text.trim() === '') {
        throw new Rejection('nothing_to_change', 'Type the text to put behind the subject.');
      }
      const range = {
        ...(command.start === undefined ? {} : { start: command.start }),
        ...(command.end === undefined ? {} : { end: command.end }),
      };
      // A shot that already has its subject in front and a text layer behind takes another
      // title on that layer: the matte has MOVED to the front copy, so requiring it on this
      // clip refused every second title and pushed callers into nesting a copy of a copy.
      if (existingTextSandwich(input.timeline, clip.id) !== undefined) {
        return {
          operations: [
            {
              type: 'add_text_behind_subject',
              clipId: clip.id,
              text: command.text,
              ...(command.style === undefined ? {} : { style: command.style }),
              ...range,
            },
          ],
          reason: `Put text behind the subject on "${clip.id}"`,
        };
      }
      const matte =
        command.maskId === undefined
          ? masksOf(clip).find(
              (candidate) =>
                candidate.kind === 'matte' &&
                candidate.enabled &&
                candidate.target.kind === 'alpha',
            )
          : findMask(clip, command.maskId);
      if (matte === undefined || matte.kind !== 'matte') {
        throw new Rejection(
          'missing_mask',
          'Remove the background on this clip first, then put text behind the subject.',
        );
      }
      return {
        operations: [
          {
            type: 'add_text_behind_subject',
            clipId: clip.id,
            text: command.text,
            maskId: matte.id,
            ...(command.style === undefined ? {} : { style: command.style }),
            ...range,
          },
        ],
        reason: `Put text behind the subject on "${clip.id}"`,
      };
    }
    case 'set_mask_track': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      return {
        operations: [
          {
            type: 'apply_mask_tracking',
            clipId: clip.id,
            maskId: mask.id,
            tracking: command.tracking,
          },
        ],
        reason: `Track mask "${mask.name || mask.id}"`,
      };
    }
    case 'clear_mask_track': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      if (mask.tracking === undefined) {
        throw new Rejection('nothing_to_change', 'This mask is not tracked.');
      }
      return {
        operations: [{ type: 'clear_mask_tracking', clipId: clip.id, maskId: mask.id }],
        reason: `Remove the track from mask "${mask.name || mask.id}"`,
      };
    }
    case 'add_track_constraint': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      const tracking = mask.tracking;
      if (tracking === undefined) {
        throw new Rejection(
          'missing_track',
          'This mask has no track to constrain. Track the mask first.',
        );
      }
      const constraints = withConstraint(tracking.constraints, command.sourceTime);
      if (constraints === tracking.constraints) {
        throw new Rejection('nothing_to_change', 'This frame is already a constraint.');
      }
      return {
        operations: [
          {
            type: 'apply_mask_tracking',
            clipId: clip.id,
            maskId: mask.id,
            tracking: { ...tracking, constraints: [...constraints] },
          },
        ],
        reason: `Lock the mask on this frame`,
      };
    }
    case 'correct_tracked_mask':
      return buildCorrectTrackedMask(input, command);
    case 'review_mask_track': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      if (mask.tracking === undefined) {
        throw new Rejection(
          'missing_track',
          'This mask has no track to review. Track the mask first.',
        );
      }
      return {
        operations: [
          {
            type: 'review_mask',
            clipId: clip.id,
            maskId: mask.id,
            subject: 'tracking',
            review: command.review,
          },
        ],
        reason: `Review the track on mask "${mask.name || mask.id}"`,
      };
    }
    case 'draw_mask':
      return buildDraw(input, command);
    case 'draw_shape_preset':
      return buildDrawShapePreset(input, command);
    case 'add_track_matte':
      return buildAddTrackMatte(input, command);
    case 'set_mask_geometry':
      return buildSetGeometry(input, command);
    case 'set_mask_properties':
      return buildSetProperties(input, command);
    case 'toggle_mask_keyframe':
      return buildToggleKeyframe(input, command);
    case 'insert_mask_vertex': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      if (mask.kind !== 'path')
        throw new Rejection('not_editable', `Mask "${mask.id}" has no points.`);
      return {
        operations: [
          {
            type: 'insert_mask_vertex',
            clipId: clip.id,
            maskId: mask.id,
            segment: command.segment,
            t: command.t,
          },
        ],
        reason: `Add a point to mask "${mask.name || mask.id}"`,
      };
    }
    case 'remove_mask_vertices':
      return buildRemoveVertices(input, command);
    case 'move_mask_keyframes':
      return buildMoveKeyframes(input, command);
    case 'remove_mask': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      return {
        operations: [{ type: 'remove_mask', clipId: clip.id, maskId: mask.id }],
        reason: `Delete mask "${mask.name || mask.id}"`,
      };
    }
    case 'reorder_masks': {
      const clip = findClip(input.timeline, command.clipId);
      const current = masksOf(clip).map((mask) => mask.id);
      if (current.join('\u0000') === command.maskIds.join('\u0000')) {
        throw new Rejection('nothing_to_change', 'The masks are already in this order.');
      }
      return {
        operations: [{ type: 'reorder_masks', clipId: clip.id, maskIds: command.maskIds }],
        reason: `Reorder masks on "${clip.id}"`,
      };
    }
    case 'set_mask_target': {
      const clip = findClip(input.timeline, command.clipId);
      const mask = findMask(clip, command.maskId);
      return {
        operations: [
          {
            type: 'set_mask_target',
            clipId: clip.id,
            maskId: mask.id,
            target: assertTarget(clip, command.target),
          },
        ],
        reason: `Change what mask "${mask.name || mask.id}" limits`,
      };
    }
    case 'set_mask_space':
      return buildSetSpace(input, command);
    case 'duplicate_mask':
      return buildDuplicate(input, command);
    case 'paste_masks':
      return buildPaste(input, command);
    case 'save_mask_preset':
      return buildSavePreset(input, command);
    case 'apply_mask_preset': {
      const preset = (input.timeline.maskPresets ?? []).find(
        (candidate) => candidate.id === command.presetId,
      );
      if (preset === undefined)
        throw new Rejection('missing_mask', 'That preset is no longer in this project.');
      const built = buildPaste(input, {
        ...command,
        type: 'paste_masks',
        clipboard: {
          // A preset is not tied to media, so it never carries a matte across (paste refuses it).
          assetId: '',
          width: preset.width,
          height: preset.height,
          sourceStart: preset.sourceStart,
          masks: preset.masks,
        },
      });
      return { ...built, reason: `Apply mask preset "${preset.name}"` };
    }
    case 'remove_mask_preset': {
      const preset = (input.timeline.maskPresets ?? []).find(
        (candidate) => candidate.id === command.presetId,
      );
      if (preset === undefined)
        throw new Rejection('missing_mask', 'That preset is no longer in this project.');
      return {
        operations: [{ type: 'remove_mask_preset', presetId: preset.id }],
        reason: `Delete mask preset "${preset.name}"`,
      };
    }
  }
}

function buildSavePreset(input: CompileMaskCommandInput, command: SaveMaskPresetCommand): Built {
  const clip = findClip(input.timeline, command.clipId);
  const size = clipDisplaySize(clip, input.assets);
  const name = command.name.trim();
  if (name === '') throw new Rejection('not_editable', 'Name the preset.');
  const wanted = new Set(command.maskIds);
  const masks = masksOf(clip).filter((mask) => wanted.has(mask.id) && mask.kind !== 'matte');
  if (masks.length === 0) {
    throw new Rejection(
      'nothing_to_change',
      'Select a shape mask to save. Background-removal mattes belong to their media and are not saved as presets.',
    );
  }
  const taken = new Set((input.timeline.maskPresets ?? []).map((preset) => preset.id));
  const base = `preset__${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'mask'
  }`;
  let id = base;
  for (let attempt = 2; taken.has(id); attempt += 1) id = `${base}_${String(attempt)}`;
  return {
    operations: [
      {
        type: 'save_mask_preset',
        preset: {
          id,
          name,
          width: size.width,
          height: size.height,
          sourceStart: clip.sourceStart,
          masks: masks.map((mask) => structuredClone(mask)),
        },
      },
    ],
    reason: `Save mask preset "${name}"`,
  };
}

// ---------------------------------------------------------------------------
// Adjustment-lane (effect layer) stacks (MK9.1)
// ---------------------------------------------------------------------------

/** The asset id of an effect layer's stand-in clip; never a real asset. */
export const FRAME_OWNER_ASSET_ID = '__framepilot_frame__';

/**
 * The commands an adjustment lane's stack takes: drawing and editing geometry-based masks.
 * Everything tied to a clip's picture (mattes, keys, track mattes, tracking, clipboard and
 * presets rescaled to a source, text behind a subject) has no meaning on a lane.
 */
const EFFECT_LAYER_COMMANDS: ReadonlySet<MaskCommand['type']> = new Set<MaskCommand['type']>([
  'draw_mask',
  'draw_shape_preset',
  'set_mask_geometry',
  'set_mask_properties',
  'toggle_mask_keyframe',
  'insert_mask_vertex',
  'remove_mask_vertices',
  'move_mask_keyframes',
  'remove_mask',
  'reorder_masks',
  'duplicate_mask',
]);

/**
 * An effect layer seen as a mask owner (MK9.1): a clip-shaped stand-in whose clock is seconds
 * from the layer's start (`sourceStart` 0, no speed) and whose picture is the frame. The UI hands
 * it to the same mask panel and monitor tools a clip gets; commands then carry
 * `owner: 'effect_layer'` so they compile onto the lane.
 *
 * @param layer - The adjustment lane.
 * @returns A clip-shaped view of the lane's stack; never saved or applied.
 */
export function effectLayerMaskOwner(layer: EffectLayer): Clip {
  const owner = {
    id: layer.id,
    assetId: FRAME_OWNER_ASSET_ID,
    trackId: '',
    start: layer.start,
    end: layer.end,
    sourceStart: 0,
    sourceEnd: Math.max(0, layer.end - layer.start),
    effects: [],
    keyframes: [],
    ...(layer.masks === undefined ? {} : { masks: layer.masks }),
  };
  // A view, not a clip the project holds: casting avoids spelling out every optional clip field.
  return owner as unknown as Clip;
}

function findEffectLayer(timeline: Timeline, layerId: string): EffectLayer {
  for (const track of timeline.tracks) {
    const layer = track.effectLayers?.find((candidate) => candidate.id === layerId);
    if (layer !== undefined) return layer;
  }
  throw new Rejection('missing_clip', `Effect layer "${layerId}" does not exist.`);
}

/** An operation the clip builders addressed to the stand-in, readdressed to the lane. */
function toLayerOperation(op: MaskOperation, layerId: string): MaskOperation {
  if (!('clipId' in op) || op.clipId !== layerId) return op;
  if (op.type === 'add_mask') {
    return {
      type: 'add_effect_layer_mask',
      layerId,
      mask: { ...op.mask, space: 'frame' },
      ...(op.index === undefined ? {} : { index: op.index }),
    };
  }
  const { clipId: _owner, ...rest } = op as MaskOperation & { clipId: string };
  return { ...rest, layerId } as MaskOperation;
}

/**
 * Build an adjustment lane's command by running the CLIP builder on the lane's stand-in and
 * readdressing its operations, so a lane's mask edit is exactly the clip edit of the same intent
 * (the same ids, keyframe rules and refusals) and cannot drift from it.
 */
function buildForEffectLayer(input: CompileMaskCommandInput): Built {
  const { command } = input;
  const layer = findEffectLayer(input.timeline, command.clipId);
  if (!EFFECT_LAYER_COMMANDS.has(command.type)) {
    throw new Rejection(
      'not_editable',
      "An effect layer's masks are shapes, splits, bands and gradients drawn on the frame. Use this on a clip's masks.",
    );
  }
  const owner = effectLayerMaskOwner(layer);
  const standIn = {
    id: '__framepilot_frame_owner__',
    type: 'video',
    clips: [owner],
  } as unknown as Track;
  const built = build({
    ...input,
    timeline: { ...input.timeline, tracks: [standIn, ...input.timeline.tracks] },
    command: { ...command, owner: 'clip' } as MaskCommand,
  });
  return {
    operations: built.operations.map((op) => toLayerOperation(op, layer.id)),
    reason: built.reason,
  };
}

/**
 * Compile a mask command into one validated, reversible patch.
 *
 * @param input - The timeline and assets the command applies to, and the command.
 * @returns The patch and its inverse, or a typed rejection with a plain remedy.
 */
export function compileMaskCommand(input: CompileMaskCommandInput): MaskCommandCompileResult {
  const { command } = input;
  const revision = input.timeline.revision ?? 0;
  if (command.timelineRevision !== revision) {
    return {
      status: 'rejected',
      command,
      code: 'stale_timeline',
      detail: 'The timeline changed while you were editing. Try the edit again.',
    };
  }
  let built: Built;
  try {
    built = command.owner === 'effect_layer' ? buildForEffectLayer(input) : build(input);
  } catch (error) {
    if (error instanceof Rejection) {
      return { status: 'rejected', command, code: error.code, detail: error.message };
    }
    throw error;
  }
  if (built.operations.length === 0) {
    return { status: 'rejected', command, code: 'nothing_to_change', detail: 'Nothing changed.' };
  }
  const patch: Patch = {
    patchId: `mask__${command.type}__${fnv1a(JSON.stringify(built.operations))}` as PatchId,
    createdBy: command.createdBy ?? 'user',
    reason: built.reason,
    operations: built.operations,
  };
  const validation = validatePatch(input.timeline, patch, {
    assetIds: input.assets.map((asset) => asset.id),
    assets: input.assets,
  });
  if (!validation.valid) {
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      return {
        status: 'rejected',
        command,
        code: 'invalid_patch',
        detail: errors.map((issue) => issue.message).join('; '),
      };
    }
  }
  try {
    const inversePatch = invertPatch(input.timeline, patch);
    // Replay once so a patch whose inverse cannot restore the document is refused here.
    applyPatch(applyPatch(input.timeline, patch), inversePatch);
    return { status: 'compiled', command, patch, inversePatch };
  } catch (error) {
    return {
      status: 'rejected',
      command,
      code: 'invalid_patch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
