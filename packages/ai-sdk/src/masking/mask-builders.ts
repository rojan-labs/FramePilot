/**
 * Measurement → editor-core commands for the masking tools (AM1.1).
 *
 * Every function here compiles through `compileMaskCommand` — the SAME commands the monitor
 * tools and the Inspector dispatch — so an AI mask and a hand-made one get the same id, name,
 * colour, validation and undo (plan 11: "the same operations, the same pack jobs and the same
 * review list"). A tool call is one patch, so a chain of commands is compiled against a working
 * timeline that advances after each one, exactly as the editor's would.
 *
 * The desktop executor calls {@link buildShapeMaskOps} too: tracking a mask that does not exist
 * in the project yet needs the mask, and building it twice with one deterministic function is
 * what keeps the host's view and the orchestrator's identical.
 */
import {
  applyPatch,
  assetDisplaySize,
  compileMaskCommand,
  MEASURE_MEDIA_FIRST,
  nextMaskId,
  type DisplaySize,
  type MaskCommand,
  type MaskGeometry,
  type Operation,
} from '@framepilot/editor-core';
import {
  masksOf,
  type Clip,
  type MaskLayer,
  type Project,
  type Timeline,
} from '@framepilot/timeline-schema';
import { ToolRefusalError } from '../tool-refusal.js';
import type { CreateMaskMeasurement, MaskCandidate, TrackMeasurement } from './contracts.js';
import { attestMaskGeometry, type MaskGeometrySource } from './geometry-provenance.js';
import {
  hideMarginPx,
  matteEdgeFor,
  purposeShape,
  resolveEffectIntent,
  shapeEdgeFor,
  type MaskEdgeIntent,
  type MaskEffectIntent,
  type MaskPurpose,
} from './intent-tables.js';
import {
  ellipseFromBox,
  ellipseFromMatte,
  pathFromMatte,
  rectangleFromBox,
  rectangleFromMatte,
  type BinaryMatte,
  type NormalizedBox,
  type ShapeFitResult,
} from './shape-fit.js';

export const MASK_SHAPES = ['ellipse', 'rectangle', 'path'] as const;
export type MaskShapeChoice = (typeof MASK_SHAPES)[number];

/** A shape the editor described in numbers, fractions of the picture. */
export interface UserShape {
  readonly shape: 'rectangle' | 'ellipse';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What `create_mask` was asked for, after argument validation. */
export interface CreateMaskIntent {
  readonly clipId: string;
  readonly candidateId?: string;
  readonly userShape?: UserShape;
  readonly precision: 'cutout' | 'shape';
  readonly shape?: MaskShapeChoice;
  readonly purpose: MaskPurpose;
  readonly effect?: MaskEffectIntent;
  readonly edge: MaskEdgeIntent;
  readonly track: boolean;
}

export interface BuiltMask {
  readonly operations: Operation[];
  readonly maskId: string;
}

/** The clip and its measured picture size, or a refusal that says what to do. */
export function clipWithSize(project: Project, clipId: string): { clip: Clip; size: DisplaySize } {
  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) {
    throw new ToolRefusalError(`Unknown clip "${clipId}". Use get_clips to list real clip ids.`);
  }
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const size = assetDisplaySize(asset?.media);
  if (size === null) throw new ToolRefusalError(MEASURE_MEDIA_FIRST);
  return { clip, size };
}

/** The mask on a clip, or a refusal naming the read that lists real ids. */
export function maskOnClip(clip: Clip, maskId: string): MaskLayer {
  const mask = masksOf(clip).find((candidate) => candidate.id === maskId);
  if (mask === undefined) {
    throw new ToolRefusalError(
      `Clip "${clip.id}" has no mask "${maskId}". Call get_masks for the clip to list its mask ids.`,
    );
  }
  return mask;
}

type CommandBody = MaskCommand extends infer C
  ? C extends MaskCommand
    ? Omit<C, 'timelineRevision' | 'createdBy'>
    : never
  : never;

/**
 * Compiles editor-core mask commands in sequence against a timeline that advances after each,
 * collecting one operation list. A rejection becomes a refusal carrying editor-core's own
 * sentence, which already names the remedy.
 */
export class MaskCommandChain {
  private timeline: Timeline;
  private readonly collected: Operation[] = [];

  public constructor(private readonly project: Project) {
    this.timeline = project.timeline;
  }

  public get operations(): Operation[] {
    return [...this.collected];
  }

  /** The clip as the chain has edited it so far. */
  public clip(clipId: string): Clip | undefined {
    return this.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
  }

  /** Append raw operations (a non-mask edit such as a grade) and advance the timeline. */
  public append(operations: readonly Operation[], reason: string): void {
    this.timeline = applyPatch(this.timeline, {
      patchId: `masking_chain_${this.collected.length}` as never,
      createdBy: 'agent',
      reason,
      operations,
    });
    this.collected.push(...operations);
  }

  public run(command: CommandBody): Operation[] {
    const compiled = compileMaskCommand({
      timeline: this.timeline,
      assets: this.project.assets,
      command: {
        ...command,
        timelineRevision: this.timeline.revision ?? 0,
        createdBy: 'agent',
      } as MaskCommand,
    });
    if (compiled.status === 'rejected') throw new ToolRefusalError(compiled.detail);
    const operations = [...compiled.patch.operations] as Operation[];
    this.timeline = applyPatch(this.timeline, compiled.patch);
    this.collected.push(...operations);
    return operations;
  }
}

function unwrap(fit: ShapeFitResult<MaskGeometry>): MaskGeometry {
  if (!fit.ok) throw new ToolRefusalError(fit.message);
  return fit.geometry;
}

function boxOf(shape: UserShape): NormalizedBox {
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}

/** The deterministic geometry for a shape request, and where it came from. */
function fittedGeometry(
  intent: CreateMaskIntent,
  size: DisplaySize,
  candidate: MaskCandidate | undefined,
  matte: BinaryMatte | undefined,
): { geometry: MaskGeometry; source: MaskGeometrySource } {
  if (intent.userShape !== undefined) {
    const box = boxOf(intent.userShape);
    return {
      geometry: unwrap(
        intent.userShape.shape === 'ellipse'
          ? ellipseFromBox(box, size)
          : rectangleFromBox(box, size),
      ),
      source: { kind: 'user_numbers' },
    };
  }
  if (candidate === undefined) {
    throw new ToolRefusalError(
      'create_mask needs a candidateId from find_mask_targets, or a userShape the editor typed.',
    );
  }
  const source: MaskGeometrySource = { kind: 'candidate', candidateId: candidate.candidateId };
  const shape = intent.shape ?? (candidate.label === 'face' ? 'ellipse' : 'rectangle');
  if (shape === 'path') {
    if (matte === undefined) {
      throw new ToolRefusalError(
        'A path needs a measured outline, and none was produced for this candidate. Use shape ' +
          '"ellipse" or "rectangle", or precision "cutout" for an exact edge.',
      );
    }
    return { geometry: unwrap(pathFromMatte(matte, size)), source };
  }
  if (matte !== undefined) {
    return {
      geometry: unwrap(
        shape === 'ellipse' ? ellipseFromMatte(matte, size) : rectangleFromMatte(matte, size),
      ),
      source,
    };
  }
  return {
    geometry: unwrap(
      shape === 'ellipse'
        ? ellipseFromBox(candidate.box, size)
        : rectangleFromBox(candidate.box, size),
    ),
    source,
  };
}

/**
 * The id the Inspector gives a clip's grade (`setColorGradePatch` in the web editor).
 *
 * The preview and the export both render only the FIRST `color_grade` on a clip, and the
 * Inspector reads that one and writes back under this id. A masked grade added under any
 * other id would be the one rendered while the Inspector's edits landed on a second, ignored
 * effect — so the AI's grade takes the Inspector's id and stays editable by hand.
 */
export function inspectorGradeId(clipId: string): string {
  return `${clipId}__grade`;
}

/** Add the clip effect an `effect` mask limits; returns its id. */
function addLimitedEffect(chain: MaskCommandChain, clip: Clip, intent: CreateMaskIntent): string {
  if (intent.effect === undefined) {
    throw new ToolRefusalError('purpose "effect" needs an effect: brighten, darken or desaturate.');
  }
  const resolved = resolveEffectIntent(intent.effect);
  if (!resolved.ok) throw new ToolRefusalError(resolved.message);
  if (clip.effects.some((effect) => effect.type === resolved.effect.type)) {
    throw new ToolRefusalError(
      'This clip already has a grade, and only one grade per clip is rendered, so a second one ' +
        'limited to a mask would not show. Limit the existing grade instead: tell the editor to ' +
        'add the mask to that grade in the Inspector.',
    );
  }
  const effectId = inspectorGradeId(clip.id);
  chain.append(
    [
      {
        type: 'apply_color_grade',
        clipId: clip.id,
        effect: {
          id: effectId,
          type: resolved.effect.type,
          params: { ...resolved.effect.params },
          keyframes: [],
        },
      },
    ],
    'Add the effect the mask limits',
  );
  return effectId;
}

/**
 * A fitted rectangle, ellipse or path mask: `draw_mask`, then the edge and purpose.
 *
 * @param project - The working project.
 * @param intent - What was asked for.
 * @param measured - The candidate and, when the pack produced one, its single-frame outline.
 */
export function buildShapeMaskOps(
  project: Project,
  intent: CreateMaskIntent,
  measured: {
    readonly candidate?: MaskCandidate | undefined;
    readonly matte?: BinaryMatte | undefined;
  },
): BuiltMask {
  const { clip, size } = clipWithSize(project, intent.clipId);
  const { geometry, source } = fittedGeometry(intent, size, measured.candidate, measured.matte);
  const chain = new MaskCommandChain(project);
  const maskId = nextMaskId(clip);
  const target =
    intent.purpose === 'effect'
      ? ({ kind: 'effect', effectId: addLimitedEffect(chain, clip, intent) } as const)
      : undefined;
  const drawn = chain.run({
    type: 'draw_mask',
    clipId: clip.id,
    sourceTime: measured.candidate?.sourceTime ?? clip.sourceStart,
    geometry,
    ...(target === undefined ? {} : { target }),
  });
  attestMaskGeometry(drawn, source);
  const changes: Record<string, number | boolean> = {
    ...shapeEdgeFor(intent.edge, size),
    ...(intent.purpose === 'hide'
      ? { expansionPx: hideMarginPx(size), ...purposeShape('hide') }
      : {}),
  };
  const meaningful = Object.entries(changes).filter(([, value]) => value !== 0 && value !== false);
  if (meaningful.length > 0) {
    chain.run({
      type: 'set_mask_properties',
      clipId: clip.id,
      maskId,
      sourceTime: clip.sourceStart,
      changes: Object.fromEntries(meaningful),
    });
  }
  return { operations: chain.operations, maskId };
}

/** Attach a measured track to a mask the chain (or the project) already holds. */
export function trackingCommandFor(
  clipId: string,
  maskId: string,
  track: TrackMeasurement,
): CommandBody {
  return {
    type: 'set_mask_track',
    clipId,
    maskId,
    tracking: {
      artifact: track.artifact,
      method: track.method,
      referenceSourceTime: track.referenceSourceTime,
      constraints: [],
      review: { flagged: track.flagged.map((range) => ({ ...range })), approved: [], locked: [] },
    },
  } as CommandBody;
}

/** A cut-out: the pack's matte committed through `add_matte_mask`, then the purpose. */
function buildMatteMaskOps(
  project: Project,
  intent: CreateMaskIntent,
  measurement: Extract<CreateMaskMeasurement, { precision: 'cutout' }>,
): BuiltMask {
  const { clip, size } = clipWithSize(project, intent.clipId);
  const chain = new MaskCommandChain(project);
  const maskId = nextMaskId(clip);
  const edge = matteEdgeFor(intent.edge, size);
  const committed = chain.run({
    type: 'add_matte_mask',
    clipId: clip.id,
    artifact: measurement.artifact,
    prompts:
      measurement.candidate === undefined
        ? []
        : [{ kind: 'candidate', candidateId: measurement.candidate.candidateId }],
    review: {
      flagged: measurement.needsReview.map((range) => ({ ...range })),
      approved: [],
      locked: [],
    },
    edgeMode: edge.edgeMode,
  });
  attestMaskGeometry(committed, {
    kind: 'measurement',
    engine: `${measurement.artifact.packId}@${measurement.artifact.packVersion}`,
  });
  if (intent.purpose === 'effect') {
    const effectId = addLimitedEffect(chain, clip, intent);
    chain.run({
      type: 'set_mask_target',
      clipId: clip.id,
      maskId,
      target: { kind: 'effect', effectId },
    });
  }
  const changes: Record<string, boolean | Record<string, number>> = {
    ...(intent.purpose === 'hide' ? purposeShape('hide') : {}),
    ...(edge.blurPx > 0 ? { finesse: { blurPx: edge.blurPx } } : {}),
  };
  if (Object.keys(changes).length > 0) {
    chain.run({
      type: 'set_mask_properties',
      clipId: clip.id,
      maskId,
      sourceTime: clip.sourceStart,
      changes,
    });
  }
  return { operations: chain.operations, maskId };
}

/**
 * The whole `create_mask` / `remove_background` patch from the host's measurement.
 *
 * @throws ToolRefusalError when the measurement does not answer the request it is paired with —
 *   a different clip or candidate is never silently substituted.
 */
export function buildCreateMaskOps(
  project: Project,
  intent: CreateMaskIntent,
  measurement: CreateMaskMeasurement,
): BuiltMask {
  if (measurement.clipId !== intent.clipId || measurement.precision !== intent.precision) {
    throw new ToolRefusalError(
      'The measurement does not answer this request, so nothing was applied.',
    );
  }
  if (
    intent.candidateId !== undefined &&
    measurement.candidate?.candidateId !== intent.candidateId
  ) {
    throw new ToolRefusalError(
      'The measurement is for a different candidate, so nothing was applied.',
    );
  }
  if (measurement.precision === 'cutout') return buildMatteMaskOps(project, intent, measurement);
  const built = buildShapeMaskOps(project, intent, measurement);
  if (measurement.track === undefined) return built;
  // The shape exists only in the patch so far; replay it, then attach the measured track.
  const chain = new MaskCommandChain(project);
  chain.append(built.operations, 'Draw the fitted mask');
  const tracked = chain.run(trackingCommandFor(intent.clipId, built.maskId, measurement.track));
  attestMaskGeometry(tracked, { kind: 'measurement', engine: measurement.track.engine });
  return { operations: chain.operations, maskId: built.maskId };
}

/** `track_mask`: a measured track onto an existing mask. */
export function buildTrackMaskOps(
  project: Project,
  clipId: string,
  maskId: string,
  track: TrackMeasurement,
): BuiltMask {
  const { clip } = clipWithSize(project, clipId);
  maskOnClip(clip, maskId);
  const chain = new MaskCommandChain(project);
  attestMaskGeometry(chain.run(trackingCommandFor(clipId, maskId, track)), {
    kind: 'measurement',
    engine: track.engine,
  });
  return { operations: chain.operations, maskId };
}
