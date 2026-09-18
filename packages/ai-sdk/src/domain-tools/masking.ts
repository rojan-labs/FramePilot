/**
 * The `masking` domain (plan 11, AM1.1): masks and cut-outs driven by plain requests.
 *
 * Two kinds of tool live here, split the way `transcribe` and `track_subject_automatically`
 * are. The HOST-MEASURED ones (`find_mask_targets`, `create_mask`, `remove_background`,
 * `track_mask`) carry no in-process body: the model states an objective, the desktop executor
 * measures the media in an isolated pack worker, and the orchestrator turns the validated
 * measurement into editor-core commands ({@link maskingOpsFromMeasurement}). The IN-PROCESS
 * ones (`refine_mask`, `put_text_behind_subject`, `get_masks`, `delete_mask`) only rearrange
 * what the project already holds.
 *
 * In both, the model picks WHICH candidate and WHAT purpose; it never supplies a coordinate.
 * The names of the host-measured tools are constants rather than inline literals because the
 * desktop executor routes on them, exactly as it does for `track_subject_automatically`.
 */
import { z } from 'zod/v4';
import { masksOf, type MaskLayer } from '@framepilot/timeline-schema';
import type { Operation } from '@framepilot/editor-core';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import {
  CREATE_MASK_TOOL_NAME,
  CREATE_SHAPE_MASK_TOOL_NAME,
  CreateMaskMeasurementSchema,
  CreateShapeMaskMeasurementSchema,
  FIND_MASK_TARGETS_TOOL_NAME,
  REMOVE_BACKGROUND_TOOL_NAME,
  TRACK_MASK_TOOL_NAME,
  TrackMaskMeasurementSchema,
  MaskCandidateIdSchema,
  type MaskReviewReport,
} from '../masking/contracts.js';
import { parseCandidateId } from '../masking/candidate-id.js';
import { attestMaskGeometry } from '../masking/geometry-provenance.js';
import { USER_NUMBERS_NOT_TYPED, numbersWereTyped } from '../masking/geometry-provenance.js';
import {
  MASK_EDGE_INTENTS,
  MASK_EFFECT_INTENTS,
  MASK_GROW_INTENTS,
  MASK_PURPOSES,
  growStepPx,
  matteEdgeFor,
  shapeEdgeFor,
} from '../masking/intent-tables.js';
import {
  MASK_SHAPES,
  MaskCommandChain,
  buildCreateMaskOps,
  buildTrackMaskOps,
  clipWithSize,
  maskOnClip,
  type BuiltMask,
  type CreateMaskIntent,
} from '../masking/mask-builders.js';
import {
  AI_SHAPE_PRESETS,
  SHAPE_DIRECTIONS,
  SHAPE_SIDES,
  buildShapePresetMaskOps,
  type CreateShapeMaskIntent,
} from '../masking/shape-presets.js';
import { boolean, numeric, seconds } from './tool-args.js';
import { jsonSchema, mutateTool, readTool } from './tool-factories.js';

const unit = numeric(z.number().min(0).max(1));

const UserShapeSchema = z
  .object({
    shape: z.enum(['rectangle', 'ellipse']),
    /** Fractions of the picture: left, top, width, height. */
    x: unit,
    y: unit,
    width: unit,
    height: unit,
  })
  .strict();

export const FindMaskTargetsArgsSchema = z
  .object({
    clipId: z.string().min(1),
    /** The editor's own words for the target: "the red car", "everyone's faces". */
    description: z.string().min(1).max(200),
    /** Timeline seconds to look in; omit for the whole clip. */
    range: z.object({ start: seconds, end: seconds }).strict().optional(),
  })
  .strict();

export const CreateMaskArgsSchema = z
  .object({
    clipId: z.string().min(1),
    candidateId: MaskCandidateIdSchema.optional(),
    userShape: UserShapeSchema.optional(),
    precision: z.enum(['cutout', 'shape']),
    shape: z.enum(MASK_SHAPES).optional(),
    purpose: z.enum(MASK_PURPOSES),
    effect: z.enum(MASK_EFFECT_INTENTS).optional(),
    edge: z.enum(MASK_EDGE_INTENTS).default('soft'),
    track: boolean().default(false),
  })
  .strict();

const UserBoxSchema = z
  .object({
    /** Fractions of the picture: left, top, width, height. */
    x: unit,
    y: unit,
    width: unit,
    height: unit,
  })
  .strict();

export const CreateShapeMaskArgsSchema = z
  .object({
    clipId: z.string().min(1),
    preset: z.enum(AI_SHAPE_PRESETS),
    /** Place the preset on this measured subject (from find_mask_targets). */
    candidateId: MaskCandidateIdSchema.optional(),
    /** Place the preset in this box, ONLY with numbers the editor typed. */
    userBox: UserBoxSchema.optional(),
    /** split: the side kept; gradient: the side that stays opaque. */
    side: z.enum(SHAPE_SIDES).optional(),
    /** mirror: which way the band runs. */
    direction: z.enum(SHAPE_DIRECTIONS).optional(),
    /** star: points; polygon: sides (3–64). A count, never a coordinate. */
    points: numeric(z.number().int().min(3).max(64)).optional(),
    purpose: z.enum(MASK_PURPOSES).default('cutout'),
    effect: z.enum(MASK_EFFECT_INTENTS).optional(),
    edge: z.enum(MASK_EDGE_INTENTS).default('soft'),
  })
  .strict();

const LAYER_CHANNELS = ['alpha', 'luma', 'inverted-alpha', 'inverted-luma'] as const;

export const MaskWithLayerArgsSchema = z
  .object({
    clipId: z.string().min(1),
    /** The clip whose picture becomes the mask — a title for text-as-mask. */
    sourceClipId: z.string().min(1).optional(),
    /** Or a whole track. */
    sourceTrackId: z.string().min(1).optional(),
    channel: z.enum(LAYER_CHANNELS).default('alpha'),
  })
  .strict();

export const RemoveBackgroundArgsSchema = z
  .object({ clipId: z.string().min(1), candidateId: MaskCandidateIdSchema.optional() })
  .strict();

export const TrackMaskArgsSchema = z
  .object({
    clipId: z.string().min(1),
    maskId: z.string().min(1),
    method: z.enum(['position', 'position-scale-rotation', 'perspective']).optional(),
  })
  .strict();

const REFUSE_BOTH_SOURCES =
  'Pass either candidateId or userShape, not both: a mask has one source.';
const REFUSE_NO_SOURCE =
  'create_mask needs a candidateId from find_mask_targets, or a userShape the editor typed. ' +
  'Call find_mask_targets for the clip first.';
const REFUSE_USER_CUTOUT =
  'A cut-out follows a subject, so it needs a candidateId. Use precision "shape" with userShape.';

/**
 * The rules `create_mask` arguments obey beyond their types. Shared with the desktop executor,
 * so a call that would be refused is refused BEFORE a pack worker runs for minutes.
 *
 * @throws ToolRefusalError with the remedy.
 */
export function createMaskIntent(
  rawArgs: unknown,
  ctx: Pick<ToolContext, 'userNumbers' | 'userPickedCandidateIds'>,
): CreateMaskIntent {
  const intent = createMaskRequest(rawArgs);
  assertCandidateUsable(intent.candidateId, ctx);
  if (intent.userShape !== undefined) {
    const { x, y, width, height } = intent.userShape;
    if (!numbersWereTyped([x, y, width, height], ctx.userNumbers ?? [])) {
      throw new ToolRefusalError(USER_NUMBERS_NOT_TYPED);
    }
  }
  return intent;
}

/**
 * The structural half of {@link createMaskIntent}: everything that can be judged from the
 * arguments alone. The desktop executor uses it, because whether the editor typed a number is
 * a fact about the CONVERSATION, which only the orchestrator holds — and the orchestrator
 * checks it before anything is built.
 */
export function createMaskRequest(rawArgs: unknown): CreateMaskIntent {
  const args = CreateMaskArgsSchema.parse(rawArgs);
  if (args.candidateId !== undefined && args.userShape !== undefined) {
    throw new ToolRefusalError(REFUSE_BOTH_SOURCES);
  }
  if (args.candidateId === undefined && args.userShape === undefined) {
    throw new ToolRefusalError(REFUSE_NO_SOURCE);
  }
  if (args.userShape !== undefined && args.precision === 'cutout') {
    throw new ToolRefusalError(REFUSE_USER_CUTOUT);
  }
  return {
    clipId: args.clipId,
    ...(args.candidateId === undefined ? {} : { candidateId: args.candidateId }),
    ...(args.userShape === undefined ? {} : { userShape: args.userShape }),
    precision: args.precision,
    ...(args.shape === undefined ? {} : { shape: args.shape }),
    purpose: args.purpose,
    ...(args.effect === undefined ? {} : { effect: args.effect }),
    edge: args.edge,
    track: args.track,
  };
}

const REFUSE_BOTH_PLACEMENTS =
  'Pass candidateId or userBox, not both: a shape mask has one placement. Omit both to place ' +
  'it on the frame.';

/**
 * The structural half of {@link createShapeMaskIntent}: what the arguments alone decide. The
 * desktop executor uses it; whether the editor typed the numbers is the orchestrator's check.
 */
export function createShapeMaskRequest(rawArgs: unknown): CreateShapeMaskIntent {
  const args = CreateShapeMaskArgsSchema.parse(rawArgs);
  if (args.candidateId !== undefined && args.userBox !== undefined) {
    throw new ToolRefusalError(REFUSE_BOTH_PLACEMENTS);
  }
  if (args.userBox !== undefined && (args.userBox.width <= 0 || args.userBox.height <= 0)) {
    throw new ToolRefusalError('userBox needs a width and a height above zero.');
  }
  return {
    clipId: args.clipId,
    preset: args.preset,
    ...(args.candidateId === undefined ? {} : { candidateId: args.candidateId }),
    ...(args.userBox === undefined ? {} : { userBox: args.userBox }),
    ...(args.side === undefined ? {} : { side: args.side }),
    ...(args.direction === undefined ? {} : { direction: args.direction }),
    ...(args.points === undefined ? {} : { points: args.points }),
    purpose: args.purpose,
    ...(args.effect === undefined ? {} : { effect: args.effect }),
    edge: args.edge,
  };
}

/**
 * The rules `create_shape_mask` arguments obey beyond their types, refused before the host runs.
 *
 * @throws ToolRefusalError with the remedy.
 */
export function createShapeMaskIntent(
  rawArgs: unknown,
  ctx: Pick<ToolContext, 'userNumbers' | 'userPickedCandidateIds'>,
): CreateShapeMaskIntent {
  const intent = createShapeMaskRequest(rawArgs);
  assertCandidateUsable(intent.candidateId, ctx);
  if (intent.userBox !== undefined) {
    const { x, y, width, height } = intent.userBox;
    if (!numbersWereTyped([x, y, width, height], ctx.userNumbers ?? [])) {
      throw new ToolRefusalError(USER_NUMBERS_NOT_TYPED);
    }
  }
  return intent;
}

/** The refusal for a candidate the editor was asked to choose and has not chosen. */
export const CANDIDATE_NEEDS_EDITOR_PICK =
  'That candidate is one the editor has to choose: find_mask_targets could not tell which ' +
  'thing they meant, and FramePilot has shown them the choices. Nothing was masked. Wait for ' +
  'their pick — it arrives as their next message — and do not choose for them.';

/**
 * A pick-required id is usable only once the editor has written it (the sidebar picker does).
 *
 * @throws ToolRefusalError when the editor has not picked it.
 */
export function assertCandidateUsable(
  candidateId: string | undefined,
  ctx: Pick<ToolContext, 'userPickedCandidateIds'>,
): void {
  if (candidateId === undefined) return;
  if (parseCandidateId(candidateId)?.pickRequired !== true) return;
  if ((ctx.userPickedCandidateIds ?? []).includes(candidateId)) return;
  throw new ToolRefusalError(CANDIDATE_NEEDS_EDITOR_PICK);
}

/** `remove_background` is `create_mask` with its answers filled in. */
export function removeBackgroundIntent(
  rawArgs: unknown,
  ctx: Pick<ToolContext, 'userPickedCandidateIds'>,
): CreateMaskIntent {
  const intent = removeBackgroundRequest(rawArgs);
  assertCandidateUsable(intent.candidateId, ctx);
  return intent;
}

/** The structural half of {@link removeBackgroundIntent}, for the desktop executor. */
export function removeBackgroundRequest(rawArgs: unknown): CreateMaskIntent {
  const args = RemoveBackgroundArgsSchema.parse(rawArgs);
  return {
    clipId: args.clipId,
    ...(args.candidateId === undefined ? {} : { candidateId: args.candidateId }),
    precision: 'cutout',
    purpose: 'cutout',
    edge: 'soft',
    track: false,
  };
}

/**
 * Everything about a host-measured masking call that can be refused BEFORE the host is asked,
 * so a call that cannot land never spends a pack job — minutes of one, for a track or a matte.
 *
 * @throws ToolRefusalError with the remedy.
 */
export function preflightMaskingCall(toolName: string, rawArgs: unknown, ctx: ToolContext): void {
  if (toolName === CREATE_MASK_TOOL_NAME) createMaskIntent(rawArgs, ctx);
  else if (toolName === REMOVE_BACKGROUND_TOOL_NAME) removeBackgroundIntent(rawArgs, ctx);
  else if (toolName === CREATE_SHAPE_MASK_TOOL_NAME) createShapeMaskIntent(rawArgs, ctx);
}

/** A host-measured masking result, ready for the orchestrator to assemble. */
export interface MaskingMeasuredEdit {
  readonly operations: Operation[];
  readonly clipId: string;
  readonly maskId: string;
  readonly needsReview: MaskReviewReport['needsReview'];
  readonly trackConfidence?: MaskReviewReport['trackConfidence'];
  /** Frames that passed the pack's checks and frames it flagged, for a cut-out. */
  readonly frames?: MaskReviewReport['frames'];
  /**
   * What a visual spot check would ask, when this edit put a mask ON something. Absent for a
   * track of an existing mask: there is no "is it the right thing?" left to ask.
   */
  readonly target?: {
    readonly label: string;
    readonly purpose: 'cutout' | 'hide' | 'effect';
    readonly candidateScore?: number;
    /** The editor picked the candidate or typed the shape: never second-guessed. */
    readonly editorChose: boolean;
  };
}

/** Thrown when a host payload does not survive its schema. */
export class UnusableMaskingPayloadError extends Error {
  public constructor() {
    super('The masking host returned a measurement FramePilot could not read.');
    this.name = 'UnusableMaskingPayloadError';
  }
}

/**
 * Turn the host's measurement for a masking call into validated editor-core operations.
 *
 * @param toolName - One of the host-measured mutation tools.
 * @param rawArgs - The call's arguments, as the model sent them.
 * @param payload - `HostToolOutcome.data`, untrusted until parsed here.
 * @throws UnusableMaskingPayloadError for a malformed payload; ToolRefusalError for a refusal.
 */
export function maskingOpsFromMeasurement(
  toolName: string,
  rawArgs: unknown,
  payload: unknown,
  ctx: ToolContext,
): MaskingMeasuredEdit {
  if (toolName === TRACK_MASK_TOOL_NAME) {
    const args = TrackMaskArgsSchema.parse(rawArgs);
    const parsed = TrackMaskMeasurementSchema.safeParse(payload);
    if (!parsed.success) throw new UnusableMaskingPayloadError();
    if (parsed.data.clipId !== args.clipId || parsed.data.maskId !== args.maskId) {
      throw new ToolRefusalError(
        'The measurement is for a different mask, so nothing was applied.',
      );
    }
    const built = buildTrackMaskOps(ctx.project, args.clipId, args.maskId, parsed.data.track);
    return {
      ...measuredEdit(args.clipId, built, parsed.data.track.flagged, parsed.data.track),
    };
  }
  if (toolName === CREATE_SHAPE_MASK_TOOL_NAME) {
    const shape = createShapeMaskIntent(rawArgs, ctx);
    const parsed = CreateShapeMaskMeasurementSchema.safeParse(payload);
    if (!parsed.success) throw new UnusableMaskingPayloadError();
    if (parsed.data.clipId !== shape.clipId) {
      throw new ToolRefusalError(
        'The measurement is for a different clip, so nothing was applied.',
      );
    }
    const measured = parsed.data.candidate;
    if (shape.candidateId !== undefined && measured?.candidateId !== shape.candidateId) {
      throw new ToolRefusalError(
        'The measurement is for a different candidate, so nothing was applied.',
      );
    }
    const built = buildShapePresetMaskOps(ctx.project, shape, measured);
    return {
      ...measuredEdit(shape.clipId, built, []),
      // A preset put ON a subject can be spot-checked like any mask on a subject; one placed
      // on the frame or from the editor's numbers has no "is it the right thing?" to ask.
      ...(measured === undefined
        ? {}
        : {
            target: {
              label: measured.label,
              purpose: shape.purpose,
              candidateScore: measured.score,
              editorChose: parseCandidateId(measured.candidateId)?.pickRequired === true,
            },
          }),
    };
  }
  const intent =
    toolName === REMOVE_BACKGROUND_TOOL_NAME
      ? removeBackgroundIntent(rawArgs, ctx)
      : createMaskIntent(rawArgs, ctx);
  const parsed = CreateMaskMeasurementSchema.safeParse(payload);
  if (!parsed.success) throw new UnusableMaskingPayloadError();
  const built = buildCreateMaskOps(ctx.project, intent, parsed.data);
  const candidate = parsed.data.candidate;
  const target: NonNullable<MaskingMeasuredEdit['target']> = {
    label:
      candidate?.label ??
      (intent.userShape === undefined ? 'main subject' : 'area the editor described'),
    purpose: intent.purpose,
    ...(candidate === undefined ? {} : { candidateScore: candidate.score }),
    editorChose:
      intent.userShape !== undefined ||
      (intent.candidateId !== undefined &&
        parseCandidateId(intent.candidateId)?.pickRequired === true),
  };
  if (parsed.data.precision === 'cutout') {
    return {
      ...measuredEdit(intent.clipId, built, parsed.data.needsReview),
      frames: { passedChecks: parsed.data.verifiedFrames, flagged: parsed.data.flaggedFrames },
      target,
    };
  }
  return {
    ...measuredEdit(intent.clipId, built, parsed.data.track?.flagged ?? [], parsed.data.track),
    target,
  };
}

function measuredEdit(
  clipId: string,
  built: BuiltMask,
  needsReview: MaskReviewReport['needsReview'],
  track?: {
    readonly frames: number;
    readonly worstResidualPx: number;
    readonly flagged: readonly unknown[];
  },
): MaskingMeasuredEdit {
  return {
    operations: built.operations,
    clipId,
    maskId: built.maskId,
    needsReview: needsReview.map((range) => ({ start: range.start, end: range.end })),
    ...(track === undefined
      ? {}
      : {
          trackConfidence: {
            frames: track.frames,
            worstResidualPx: track.worstResidualPx,
            flaggedCount: track.flagged.length,
          },
        }),
  };
}

/**
 * Put ranges nobody could vouch for on the mask's own review list (AM3.2 `unsure`).
 *
 * A matte and a tracked shape each carry a review list the Inspector shows; an untracked shape
 * has none, and gets no operation — the ranges are still reported in the result.
 *
 * @param project - The project WITH the new mask applied.
 */
export function flagMaskForReviewOps(
  project: ToolContext['project'],
  clipId: string,
  maskId: string,
  ranges: readonly { readonly start: number; readonly end: number }[],
): Operation[] {
  if (ranges.length === 0) return [];
  const mask = maskOnClip(clipWithSize(project, clipId).clip, maskId);
  const review = mask.kind === 'matte' ? mask.review : mask.tracking?.review;
  if (review === undefined) return [];
  const next = {
    flagged: [
      ...review.flagged,
      ...ranges.map((range) => ({ start: range.start, end: range.end })),
    ],
    approved: review.approved.map((range) => ({ ...range })),
    locked: [...review.locked],
  };
  const chain = new MaskCommandChain(project);
  chain.run(
    mask.kind === 'matte'
      ? { type: 'review_matte', clipId, maskId, review: next }
      : { type: 'review_mask_track', clipId, maskId, review: next },
  );
  return chain.operations;
}

const HOST_MEASURED = {
  version: '1',
  // Not `vision`: that capability withholds a tool from a model that cannot SEE, because its
  // output is a picture. These return measurements and ids, which any model can act on.
  capabilities: ['masking'],
  cost: 'high',
  latency: 'slow',
  hostUiOnly: true,
  mutates: false,
  available: true,
  kind: 'analysis',
} as const;

const hostMeasured = (
  name: string,
  description: string,
  schema: z.ZodType,
  permissions: NonNullable<ToolSpec['permissions']>,
): ToolSpec => ({
  ...HOST_MEASURED,
  name,
  description,
  permissions,
  parameters: jsonSchema(schema),
  parse: (rawArgs) => schema.parse(rawArgs),
});

/** How one mask reads in `get_masks`: what it is, what it limits, and what still needs a look. */
function maskRow(mask: MaskLayer): Record<string, unknown> {
  const review = mask.kind === 'matte' ? mask.review : mask.tracking?.review;
  return {
    maskId: mask.id,
    name: mask.name,
    kind: mask.kind,
    target: mask.target.kind === 'effect' ? `effect:${mask.target.effectId}` : 'clip',
    mode: mask.mode,
    inverted: mask.invert,
    enabled: mask.enabled,
    tracked: mask.tracking !== undefined,
    // Never "verified": the Inspector's review list is the only place that word is earned.
    review:
      review === undefined
        ? 'none'
        : review.flagged.length === 0
          ? 'nothing flagged'
          : 'needs a look',
    flaggedCount: review?.flagged.length ?? 0,
  };
}

const RefineMaskArgsSchema = z
  .object({
    clipId: z.string().min(1),
    maskId: z.string().min(1),
    edge: z.enum(MASK_EDGE_INTENTS).optional(),
    grow: z.enum(MASK_GROW_INTENTS).optional(),
    mode: z.enum(['add', 'subtract', 'intersect']).optional(),
    invert: boolean().optional(),
  })
  .strict();

function refineMaskOps(args: z.infer<typeof RefineMaskArgsSchema>, ctx: ToolContext): Operation[] {
  const { clip, size } = clipWithSize(ctx.project, args.clipId);
  const mask = maskOnClip(clip, args.maskId);
  const changes: Record<string, number | string | boolean | Record<string, number>> = {};
  if (args.edge !== undefined) {
    if (mask.kind === 'matte') {
      const edge = matteEdgeFor(args.edge, size);
      changes.edgeMode = edge.edgeMode;
      changes.finesse = { ...mask.finesse, blurPx: edge.blurPx };
    } else {
      Object.assign(changes, shapeEdgeFor(args.edge, size));
    }
  }
  if (args.grow !== undefined) {
    const step = growStepPx(args.grow, size);
    if (mask.kind === 'matte') changes.edgeShiftPx = mask.edgeShiftPx + step;
    else changes.expansionPx = mask.expansionPx + step;
  }
  if (args.mode !== undefined) changes.mode = args.mode;
  if (args.invert !== undefined) changes.invert = args.invert;
  if (Object.keys(changes).length === 0) {
    throw new ToolRefusalError(
      'refine_mask was given nothing to change. Pass edge, grow, mode or invert.',
    );
  }
  const chain = new MaskCommandChain(ctx.project);
  chain.run({
    type: 'set_mask_properties',
    clipId: clip.id,
    maskId: mask.id,
    sourceTime: clip.sourceStart,
    changes,
  });
  return chain.operations;
}

const TextStyleSchema = z
  .object({
    sizePercent: numeric(z.number().positive().max(100)).optional(),
    color: z.string().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    xPercent: numeric(z.number().min(0).max(100)).optional(),
    yPercent: numeric(z.number().min(0).max(100)).optional(),
  })
  .strict();

/** The `text` effect's own parameter names for a style the model states in tool vocabulary. */
function textStyleParams(style: z.infer<typeof TextStyleSchema>): Record<string, unknown> {
  const { sizePercent, ...rest } = style;
  return {
    ...(sizePercent === undefined ? {} : { fontSizePercent: sizePercent }),
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
  };
}

const FollowSubjectArgsSchema = z
  .object({
    /** The clip whose tracked mask is followed. */
    clipId: z.string().min(1),
    maskId: z.string().min(1),
    /** The clip that should follow it. */
    targetClipId: z.string().min(1),
    /** A mask on the target clip. Omit to make the target CLIP itself follow (a title). */
    targetMaskId: z.string().min(1).optional(),
  })
  .strict();

/** MO-14: a clip transform that follows a track needs a schema field nobody has approved. */
const REFUSE_FOLLOW_CLIP =
  'A title or overlay cannot follow a tracked subject yet, so nothing was changed: FramePilot ' +
  'can make a MASK follow a track, not a clip. Tell the editor this is not available yet. To ' +
  'make a mask on that clip follow the subject instead, pass its targetMaskId.';

/**
 * `follow_subject`, the half that exists: a mask reuses another mask's measured track
 * (`use_track`). The clip half waits on MO-14 and is refused rather than approximated.
 */
function followSubjectOps(
  args: z.infer<typeof FollowSubjectArgsSchema>,
  ctx: ToolContext,
): Operation[] {
  const source = maskOnClip(clipWithSize(ctx.project, args.clipId).clip, args.maskId);
  if (source.tracking === undefined) {
    throw new ToolRefusalError(
      'That mask is not tracked, so there is nothing to follow. Call track_mask for it first, ' +
        'then call follow_subject again.',
    );
  }
  if (args.targetMaskId === undefined) throw new ToolRefusalError(REFUSE_FOLLOW_CLIP);
  const target = clipWithSize(ctx.project, args.targetClipId).clip;
  const targetMask = maskOnClip(target, args.targetMaskId);
  if (target.id === args.clipId && targetMask.id === source.id) {
    throw new ToolRefusalError('A mask cannot follow itself. Pass a different targetMaskId.');
  }
  // The track was MEASURED for the source mask; reusing it authors nothing new.
  return attestMaskGeometry(
    [
      {
        type: 'use_track',
        fromClipId: args.clipId,
        fromMaskId: source.id,
        to: { clipId: target.id, maskId: targetMask.id },
      } as Operation,
    ],
    { kind: 'measurement', engine: `track:${source.tracking.artifact.key}` },
  );
}

const REFUSE_LAYER_SOURCE =
  'mask_with_layer needs exactly one source: sourceClipId (a clip, such as a title) or ' +
  'sourceTrackId (a whole track). Call get_clips for real ids.';

/** `mask_with_layer`: one `add_track_matte`, the command the Mask tab's Track matte row runs. */
function maskWithLayerOps(
  args: z.infer<typeof MaskWithLayerArgsSchema>,
  ctx: ToolContext,
): Operation[] {
  if ((args.sourceClipId === undefined) === (args.sourceTrackId === undefined)) {
    throw new ToolRefusalError(REFUSE_LAYER_SOURCE);
  }
  const { clip } = clipWithSize(ctx.project, args.clipId);
  const chain = new MaskCommandChain(ctx.project);
  chain.run({
    type: 'add_track_matte',
    clipId: clip.id,
    source:
      args.sourceClipId !== undefined
        ? { kind: 'clip', clipId: args.sourceClipId }
        : { kind: 'track', trackId: args.sourceTrackId! },
    channel: args.channel,
  });
  return chain.operations;
}

export const MASKING_TOOLS: readonly ToolSpec[] = [
  hostMeasured(
    FIND_MASK_TARGETS_TOOL_NAME,
    'Find what a mask request means on ONE clip: "the presenter", "everyone\'s faces", "the ' +
      'car". Returns ranked candidates (candidateId, label, score, how long each stays on ' +
      'screen) measured by the installed detection pack. status "resolved" names the ' +
      'candidate(s) to pass to create_mask. "ambiguous_target", "needs_click" and ' +
      '"needs_face_selection" mean the EDITOR must choose — FramePilot has already shown them ' +
      'the picker, so wait for their answer and never pick for them. A candidateId stays ' +
      'valid for the whole run.',
    FindMaskTargetsArgsSchema,
    ['analysis'],
  ),
  hostMeasured(
    CREATE_MASK_TOOL_NAME,
    'Mask one candidate from find_mask_targets. precision "cutout" is an exact AI matte; ' +
      '"shape" fits an ellipse, rectangle or path to the measurement. purpose: "cutout" keeps ' +
      'only the subject, "hide" removes it, "effect" limits an effect (brighten, darken, ' +
      'desaturate) to it. edge is exact, soft or very_soft. track:true makes a shape follow ' +
      'the subject. You never give coordinates; userShape is ONLY for numbers the editor ' +
      'typed. The result lists moments that need a look — report that count, and never say ' +
      'the mask is verified.',
    CreateMaskArgsSchema,
    ['analysis', 'write'],
  ),
  hostMeasured(
    REMOVE_BACKGROUND_TOOL_NAME,
    'Remove the background of ONE clip: an exact AI cut-out of the main subject, or of the ' +
      'candidateId you pass. The result lists moments that need a look — report that count, ' +
      'and never say it is verified.',
    RemoveBackgroundArgsSchema,
    ['analysis', 'write'],
  ),
  hostMeasured(
    TRACK_MASK_TOOL_NAME,
    'Make an existing rectangle, ellipse or path mask follow its subject through the clip, ' +
      'measured by the installed tracking pack. Returns the ranges that need a look.',
    TrackMaskArgsSchema,
    ['analysis', 'write'],
  ),
  mutateTool(
    {
      name: 'refine_mask',
      description:
        'Adjust an existing mask by intent: edge (exact, soft, very_soft), grow (tighter, ' +
        'looser — one step per call), mode (add, subtract, intersect) or invert. FramePilot ' +
        'picks the numbers.',
      capabilities: ['masking'],
      hostUiOnly: true,
    },
    RefineMaskArgsSchema,
    refineMaskOps,
  ),
  mutateTool(
    {
      name: 'put_text_behind_subject',
      description:
        'Put a title between the subject and the background of ONE clip. The clip needs its ' +
        'background removed first (remove_background).',
      capabilities: ['masking', 'text'],
      hostUiOnly: true,
    },
    z
      .object({
        clipId: z.string().min(1),
        text: z.string().min(1),
        style: TextStyleSchema.optional(),
      })
      .strict(),
    (args, ctx) => {
      const chain = new MaskCommandChain(ctx.project);
      chain.run({
        type: 'text_behind_subject',
        clipId: args.clipId,
        text: args.text,
        ...(args.style === undefined ? {} : { style: textStyleParams(args.style) }),
      });
      return chain.operations;
    },
  ),
  readTool(
    {
      name: 'get_masks',
      description:
        'List the masks on ONE clip: id, kind, what each limits, whether it is tracked, and ' +
        'how many moments still need a look.',
      capabilities: ['masking'],
      hostUiOnly: true,
    },
    z.object({ clipId: z.string().min(1) }).strict(),
    (args, ctx) => {
      const { clip } = clipWithSize(ctx.project, args.clipId);
      return { clipId: clip.id, masks: masksOf(clip).map(maskRow) };
    },
  ),
  mutateTool(
    {
      name: 'delete_mask',
      description: 'Remove one mask from a clip. Undo restores it.',
      capabilities: ['masking'],
      hostUiOnly: true,
    },
    z.object({ clipId: z.string().min(1), maskId: z.string().min(1) }).strict(),
    (args, ctx) => {
      const { clip } = clipWithSize(ctx.project, args.clipId);
      const chain = new MaskCommandChain(ctx.project);
      chain.run({ type: 'remove_mask', clipId: clip.id, maskId: maskOnClip(clip, args.maskId).id });
      return chain.operations;
    },
  ),
  mutateTool(
    {
      name: 'follow_subject',
      description:
        'Make a mask follow a subject that is ALREADY tracked: the target mask reuses the ' +
        'measured track of another mask (on the same clip or another one over the same ' +
        'picture). The source mask must be tracked first (track_mask, or create_mask with ' +
        'track:true). A title or overlay cannot follow a track yet.',
      capabilities: ['masking', 'tracking'],
      hostUiOnly: true,
    },
    FollowSubjectArgsSchema,
    followSubjectOps,
  ),
  // MK8: the split, mirror, gradient and shape-preset masks render in the export and the monitor,
  // so the tool is live. Host-measured (like create_mask) because a preset placed ON a subject
  // re-resolves the candidate where the detector runs.
  hostMeasured(
    CREATE_SHAPE_MASK_TOOL_NAME,
    'Split screen, mirror band, gradient and shape-preset masks (heart, star, polygon, speech ' +
      'bubble, arrow, rounded frame). Placed on a candidateId from find_mask_targets, on the ' +
      'frame (pass neither), or in a userBox ONLY with numbers the editor typed. side: which ' +
      'half a split keeps, or where a gradient is opaque; direction: a mirror band runs ' +
      'horizontal or vertical; points: star points or polygon sides. purpose, effect and edge ' +
      'as in create_mask. You never give coordinates.',
    CreateShapeMaskArgsSchema,
    ['analysis', 'write'],
  ),
  mutateTool(
    {
      name: 'mask_with_layer',
      description:
        'Track matte and text-as-mask: use another clip (sourceClipId, e.g. a title for video ' +
        'inside text) or a whole track (sourceTrackId) as this clip’s mask. channel: alpha (its ' +
        'shape), luma (its brightness) or either inverted. The source is then no longer drawn ' +
        'on its own. Undo removes it.',
      capabilities: ['masking'],
      hostUiOnly: true,
    },
    MaskWithLayerArgsSchema,
    maskWithLayerOps,
  ),
];
