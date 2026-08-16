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
     * What the tracker follows. `point` follows the mask centre, `region` follows
     * the whole box, `plane` fits the box's corners as a surface.
     */
    subject: z.enum(['point', 'region', 'plane']).default('region'),
  })
  .strict();

export type AutomaticTrackingObjective = z.infer<typeof AutomaticTrackingObjectiveSchema>;

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
  readonly maskEffectId: string;
  readonly assetId: string;
  readonly capability: 'tracking.point' | 'tracking.region' | 'tracking.planar';
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
): { capability: TrackingRequestPlan['capability']; parameters: Record<string, unknown> } {
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
  return { capability: 'tracking.region', parameters: { region: { ...bounds } } };
}

/** Resolve “track this automatically” into an exact, checkable pack request. */
export function resolveAutomaticTrackingObjective(
  input: ResolveAutomaticTrackingInput,
): AutomaticTrackingControllerResult {
  const { objective } = input;
  const resolution = resolveEditorTarget(
    input.project,
    input.interaction,
    { kind: 'clips', referent: objective.target },
    { projectRevision: input.projectRevision ?? input.interaction.projectRevision },
  );
  if (resolution.status !== 'resolved') {
    const detail =
      resolution.status === 'ambiguous'
        ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
        : `${resolution.reason}: ${resolution.detail}`;
    return rejected(
      objective,
      resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      detail,
    );
  }
  if (resolution.target.kind !== 'clips' || resolution.target.clipIds.length !== 1) {
    return rejected(objective, 'target_ambiguous', 'Automatic tracking needs exactly one clip.');
  }
  const clipId = resolution.target.clipIds[0]!;
  const clip = input.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) return rejected(objective, 'target_unresolved', 'Resolved clip is missing.');

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

  const asset = input.project.assets?.find((candidate) => candidate.id === clip.assetId);
  if (asset === undefined || asset.kind !== 'video') {
    return rejected(objective, 'unsupported_media', 'Only video clips can be tracked.');
  }
  const fps = input.project.fps;
  if (!Number.isFinite(fps) || fps <= 0) {
    return rejected(objective, 'unsupported_media', 'The project has no usable frame rate.');
  }
  // Track the clip's own source range: tracking outside what the clip shows would
  // measure frames the edit never displays.
  const firstFrame = Math.max(0, Math.round(clip.sourceStart * fps));
  const lastFrameExclusive = Math.max(firstFrame + 1, Math.round(clip.sourceEnd * fps));
  if (lastFrameExclusive - firstFrame > MAX_TRACKED_FRAMES) {
    return rejected(
      objective,
      'range_too_long',
      `This clip is ${lastFrameExclusive - firstFrame} frames long, past the ${MAX_TRACKED_FRAMES}-frame limit for one tracking pass. Track a shorter range.`,
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
    evidence: [resolution.evidence],
    facts: [
      { name: 'clipId', value: clipId },
      { name: 'maskEffectId', value: maskEffectId },
      { name: 'capability', value: capability },
      { name: 'trackedFrameCount', value: lastFrameExclusive - firstFrame },
    ],
  };
}
