/**
 * Resolve an automatic-tracking objective into a concrete pack request plan.
 *
 * Automatic tracking is two-phase by nature, and this controller owns the first
 * phase honestly: it turns "track this" into an exact, checkable request — which
 * clip, which mask, which capability, which normalized geometry, which frames —
 * without pretending the measurement has happened. The samples come back from an
 * isolated pack worker, and only then does
 * {@link @framepilot/editor-core#compileTrackingCommand} turn them into a typed
 * reversible patch.
 *
 * The model never supplies the region. Geometry comes from a mask the editor
 * actually drew, so a hallucinated box can never become a track.
 */
import { z } from 'zod/v4';
import { professionalMaskEffectId } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import { resolveEditorTarget, type TargetEvidence } from '../editor-context/target-resolver.js';

const log = createLogger('ai-sdk:controllers:automatic-tracking');

/** Frame budget for one request, matching the worker protocol's sample bound. */
const MAX_TRACKED_FRAMES = 18_000;

export const AutomaticTrackingObjectiveSchema = z
  .object({
    intent: z.literal('track_subject_automatically'),
    target: z.enum(['this', 'playhead']).default('this'),
    /**
     * What the tracker follows. `point` follows the mask centre, `region`
     * follows the whole box, `plane` fits the box's corners as a surface, and
     * `silhouette` segments the subject inside the mask (Subject Intelligence
     * pack) and steers this mask by the measured silhouette bounds per frame.
     */
    subject: z.enum(['point', 'region', 'plane', 'silhouette']).default('region'),
  })
  .strict();

export type AutomaticTrackingObjective = z.infer<typeof AutomaticTrackingObjectiveSchema>;

/** Objective for whole-frame subject detection on one selected video clip. */
export const SubjectDetectionObjectiveSchema = z
  .object({
    intent: z.literal('detect_subjects'),
    target: z.enum(['this', 'playhead']).default('this'),
    /** Which detector labels to run. Faces and people are the common ask. */
    labels: z.array(z.enum(['face', 'person', 'object'])).min(1).max(3).default(['face', 'person']),
    maxDetections: z.number().int().positive().max(100).optional(),
  })
  .strict();

export type SubjectDetectionObjective = z.infer<typeof SubjectDetectionObjectiveSchema>;

export type AutomaticTrackingRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'mask_unresolved'
  | 'mask_ambiguous'
  | 'unsupported_mask_shape'
  | 'missing_region'
  | 'unsupported_media'
  | 'range_too_long';

export interface AutomaticTrackingFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

/** Exactly what the host must ask the pack worker for. */
export interface TrackingRequestPlan {
  readonly clipId: string;
  readonly maskEffectId?: string;
  readonly assetId: string;
  readonly capability:
    | 'tracking.point'
    | 'tracking.region'
    | 'tracking.planar'
    | 'subject.detect'
    | 'subject.segment';
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  /** Clip-relative seconds of the first tracked frame, for keyframe placement. */
  readonly startSeconds: number;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type AutomaticTrackingControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: AutomaticTrackingObjective;
      readonly plan: TrackingRequestPlan;
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly AutomaticTrackingFact[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: AutomaticTrackingObjective;
      readonly code: AutomaticTrackingRejectionCode;
      readonly detail: string;
      readonly facts: readonly AutomaticTrackingFact[];
    };

export interface ResolveAutomaticTrackingInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: AutomaticTrackingObjective;
}

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rejected(
  objective: AutomaticTrackingObjective,
  code: AutomaticTrackingRejectionCode,
  detail: string,
): Extract<AutomaticTrackingControllerResult, { status: 'rejected' }> {
  log.warn('Automatic tracking objective rejected', { code });
  return { status: 'rejected', objective, code, detail, facts: [] };
}

function maskBounds(params: Record<string, unknown>): Bounds | undefined {
  const raw = params.bounds;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const values = ['x', 'y', 'width', 'height'].map((key) => record[key]);
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return undefined;
  }
  const bounds = {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  };
  const inside =
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= 1 &&
    bounds.y + bounds.height <= 1;
  return inside ? bounds : undefined;
}

function parametersFor(
  subject: AutomaticTrackingObjective['subject'],
  bounds: Bounds,
): {
  capability: TrackingRequestPlan['capability'];
  parameters: Record<string, unknown>;
} {
  if (subject === 'point') {
    return {
      capability: 'tracking.point',
      parameters: {
        point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      },
    };
  }
  if (subject === 'plane') {
    return {
      capability: 'tracking.planar',
      parameters: {
        corners: [
          { x: bounds.x, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
          { x: bounds.x, y: bounds.y + bounds.height },
        ],
      },
    };
  }
  if (subject === 'silhouette') {
    // The drawn mask IS the prompt: segmentation runs inside it, and the
    // measured silhouette bounds per frame steer the same mask afterwards.
    return { capability: 'subject.segment', parameters: { region: { ...bounds } } };
  }
  return { capability: 'tracking.region', parameters: { region: { ...bounds } } };
}

/**
 * Resolve exactly one video clip for a media job — the shared front half of
 * every objective: one selected clip, video asset, usable fps, and the clip's
 * own source range within the worker protocol's frame budget.
 */
function resolveClipForMediaJob(
  input: {
    readonly project: Project;
    readonly projectRevision?: number;
    readonly interaction: EditorInteractionContext;
  },
  referent: 'this' | 'playhead',
): { status: 'rejected'; code: AutomaticTrackingRejectionCode; detail: string } | {
  status: 'resolved';
  clipId: string;
  evidence: TargetEvidence;
  asset: { readonly id: string };
  fps: number;
  firstFrame: number;
  lastFrameExclusive: number;
} {
  const resolution = resolveEditorTarget(
    input.project,
    input.interaction,
    { kind: 'clips', referent },
    { projectRevision: input.projectRevision ?? input.interaction.projectRevision },
  );
  if (resolution.status !== 'resolved') {
    const detail =
      resolution.status === 'ambiguous'
        ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
        : `${resolution.reason}: ${resolution.detail}`;
    return {
      status: 'rejected',
      code: resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      detail,
    };
  }
  if (resolution.target.kind !== 'clips' || resolution.target.clipIds.length !== 1) {
    return { status: 'rejected', code: 'target_ambiguous', detail: 'This needs exactly one clip.' };
  }
  const clipId = resolution.target.clipIds[0]!;
  const clip = input.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) return { status: 'rejected', code: 'target_unresolved', detail: 'Resolved clip is missing.' };
  const asset = input.project.assets?.find((candidate) => candidate.id === clip.assetId);
  if (asset === undefined || asset.kind !== 'video') {
    return { status: 'rejected', code: 'unsupported_media', detail: 'Only video clips can be measured.' };
  }
  const fps = input.project.fps;
  if (!Number.isFinite(fps) || fps <= 0) {
    return { status: 'rejected', code: 'unsupported_media', detail: 'The project has no usable frame rate.' };
  }
  // Track the clip's own source range: measuring outside what the clip shows
  // would read frames the edit never displays.
  const firstFrame = Math.max(0, Math.round(clip.sourceStart * fps));
  const lastFrameExclusive = Math.max(firstFrame + 1, Math.round(clip.sourceEnd * fps));
  if (lastFrameExclusive - firstFrame > MAX_TRACKED_FRAMES) {
    return {
      status: 'rejected',
      code: 'range_too_long',
      detail: `This clip is ${lastFrameExclusive - firstFrame} frames long, past the ${MAX_TRACKED_FRAMES}-frame limit for one pass. Use a shorter range.`,
    };
  }
  return { status: 'resolved', clipId, evidence: resolution.evidence, asset, fps, firstFrame, lastFrameExclusive };
}

/**
 * Resolve whole-frame subject detection on one selected video clip into an
 * exact `subject.detect` request plan. No mask is involved: detection is
 * evidence about what is on screen, never geometry for an edit.
 */
export interface ResolveSubjectDetectionInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: SubjectDetectionObjective;
}

export type SubjectDetectionControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: SubjectDetectionObjective;
      readonly plan: TrackingRequestPlan;
      readonly facts: readonly AutomaticTrackingFact[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: SubjectDetectionObjective;
      readonly code: AutomaticTrackingRejectionCode;
      readonly detail: string;
      readonly facts: readonly AutomaticTrackingFact[];
    };

export function resolveSubjectDetectionObjective(
  input: ResolveSubjectDetectionInput,
): SubjectDetectionControllerResult {
  const { objective } = input;
  const clipResolution = resolveClipForMediaJob(input, objective.target);
  if (clipResolution.status === 'rejected') {
    return { status: 'rejected', objective, code: clipResolution.code, detail: clipResolution.detail, facts: [] };
  }
  const parameters: Record<string, unknown> = {
    labels: [...new Set(objective.labels)].sort(),
    maxDetections: objective.maxDetections ?? 20,
  };
  const plan: TrackingRequestPlan = {
    clipId: clipResolution.clipId,
    assetId: clipResolution.asset.id,
    capability: 'subject.detect',
    firstFrame: clipResolution.firstFrame,
    lastFrameExclusive: clipResolution.lastFrameExclusive,
    fps: clipResolution.fps,
    startSeconds: 0,
    parameters,
  };
  log.action('Subject detection objective resolved', {
    clipId: plan.clipId,
    labels: parameters.labels as readonly string[],
    frames: plan.lastFrameExclusive - plan.firstFrame,
  });
  return {
    status: 'resolved',
    objective,
    plan,
    facts: [
      { name: 'clipId', value: plan.clipId },
      { name: 'capability', value: plan.capability },
      { name: 'labels', value: (parameters.labels as readonly string[]).join(',') },
      { name: 'detectedFrameCount', value: plan.lastFrameExclusive - plan.firstFrame },
    ],
  };
}

/** Resolve “track this automatically” into an exact, checkable pack request. */
export function resolveAutomaticTrackingObjective(
  input: ResolveAutomaticTrackingInput,
): AutomaticTrackingControllerResult {
  const { objective } = input;
  const clipResolution = resolveClipForMediaJob(input, objective.target);
  if (clipResolution.status === 'rejected') {
    return rejected(objective, clipResolution.code, clipResolution.detail);
  }
  const { clipId, asset, fps, firstFrame, lastFrameExclusive } = clipResolution;
  const clip = input.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId)!;

  const maskEffectId = professionalMaskEffectId(clipId);
  const masks = clip.effects.filter(
    (effect) => effect.id === maskEffectId && effect.type === 'mask',
  );
  if (masks.length === 0) {
    return rejected(
      objective,
      'mask_unresolved',
      `Draw a rectangle or ellipse mask on "${clipId}" around the subject before tracking it.`,
    );
  }
  if (masks.length > 1) {
    return rejected(objective, 'mask_ambiguous', `Mask "${maskEffectId}" is duplicated.`);
  }
  const mask = masks[0]!;
  if (mask.params.shape !== 'rectangle' && mask.params.shape !== 'ellipse') {
    return rejected(
      objective,
      'unsupported_mask_shape',
      'Automatic tracking starts from a rectangle or ellipse mask.',
    );
  }
  const bounds = maskBounds(mask.params as Record<string, unknown>);
  if (bounds === undefined) {
    return rejected(
      objective,
      'missing_region',
      'The mask needs valid normalized bounds inside the frame.',
    );
  }

  const { capability, parameters } = parametersFor(objective.subject, bounds);
  const plan: TrackingRequestPlan = {
    clipId,
    maskEffectId,
    assetId: asset.id,
    capability,
    firstFrame,
    lastFrameExclusive,
    fps,
    startSeconds: 0,
    parameters,
  };
  log.action('Automatic tracking objective resolved', {
    clipId,
    capability,
    frames: lastFrameExclusive - firstFrame,
  });
  return {
    status: 'resolved',
    objective,
    plan,
    evidence: [clipResolution.evidence],
    facts: [
      { name: 'clipId', value: clipId },
      { name: 'maskEffectId', value: maskEffectId },
      { name: 'capability', value: capability },
      { name: 'trackedFrameCount', value: lastFrameExclusive - firstFrame },
    ],
  };
}
