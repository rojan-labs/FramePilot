/** Professional tracking objectives resolved from live clip selection and existing mask geometry. */
import { z } from 'zod/v4';
import { professionalMaskEffectId, type TrackingCommand } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import { resolveEditorTarget, type TargetEvidence } from '../editor-context/target-resolver.js';

const log = createLogger('ai-sdk:controllers:tracking-mask');

export const TrackingMaskObjectiveSchema = z
  .object({
    intent: z.literal('track_existing_mask'),
    target: z.enum(['this', 'playhead']).default('this'),
    subject: z.enum(['object', 'bounding_box']).default('object'),
    engine: z.literal('manual').default('manual'),
  })
  .strict();

export type TrackingMaskObjective = z.infer<typeof TrackingMaskObjectiveSchema>;

export type TrackingMaskControllerRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'mask_unresolved'
  | 'mask_ambiguous';

export type TrackingMaskControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: TrackingMaskObjective;
      readonly commands: readonly TrackingCommand[];
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly {
        readonly name: string;
        readonly value: string | number | boolean;
      }[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: TrackingMaskObjective;
      readonly code: TrackingMaskControllerRejectionCode;
      readonly detail: string;
      readonly facts: readonly {
        readonly name: string;
        readonly value: string | number | boolean;
      }[];
    };

export interface ResolveTrackingMaskObjectiveInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: TrackingMaskObjective;
}

function rejected(
  objective: TrackingMaskObjective,
  code: TrackingMaskControllerRejectionCode,
  detail: string,
): Extract<TrackingMaskControllerResult, { status: 'rejected' }> {
  log.warn('Tracking/mask objective rejected', { intent: objective.intent, code });
  return { status: 'rejected', objective, code, detail, facts: [] };
}

/** Resolve “track this mask” without accepting a model-guessed region or automatic-CV claim. */
export function resolveTrackingMaskObjective(
  input: ResolveTrackingMaskObjectiveInput,
): TrackingMaskControllerResult {
  const resolution = resolveEditorTarget(
    input.project,
    input.interaction,
    { kind: 'clips', referent: input.objective.target },
    { projectRevision: input.projectRevision ?? input.interaction.projectRevision },
  );
  if (resolution.status !== 'resolved') {
    const detail =
      resolution.status === 'ambiguous'
        ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
        : `${resolution.reason}: ${resolution.detail}`;
    return rejected(
      input.objective,
      resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      detail,
    );
  }
  if (resolution.target.kind !== 'clips' || resolution.target.clipIds.length !== 1) {
    return rejected(
      input.objective,
      'target_ambiguous',
      'Manual mask tracking requires exactly one target clip.',
    );
  }
  const clipId = resolution.target.clipIds[0]!;
  const clip = input.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) return rejected(input.objective, 'target_unresolved', 'Resolved clip is missing.');
  const maskId = professionalMaskEffectId(clipId);
  const masks = clip.effects.filter((effect) => effect.id === maskId && effect.type === 'mask');
  if (masks.length === 0) {
    return rejected(
      input.objective,
      'mask_unresolved',
      `Draw a bounded rectangle or ellipse mask on "${clipId}" before tracking it.`,
    );
  }
  if (masks.length > 1) {
    return rejected(input.objective, 'mask_ambiguous', `Mask "${maskId}" is duplicated.`);
  }
  const command: TrackingCommand = {
    type: 'track_existing_mask',
    timelineRevision: input.project.timeline.revision ?? 0,
    clipId,
    maskEffectId: maskId,
    target: input.objective.subject,
    engine: input.objective.engine,
  };
  log.action('Tracking/mask objective resolved', {
    clipId,
    maskId,
    engine: input.objective.engine,
  });
  return {
    status: 'resolved',
    objective: input.objective,
    commands: [command],
    evidence: [resolution.evidence],
    facts: [
      { name: 'clipId', value: clipId },
      { name: 'maskEffectId', value: maskId },
      { name: 'engine', value: input.objective.engine },
    ],
  };
}
