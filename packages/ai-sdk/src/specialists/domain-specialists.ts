/**
 * The existing domain controllers, declared as specialists (P5.1).
 *
 * Nothing here re-implements a controller. Each entry is the controller's own
 * `resolve*Objective` function plus the two things it never carried: the **slice** of host
 * state it is allowed to read, and the mapping from its bespoke result union onto the one
 * {@link SpecialistOutput} shape. `resolve*Objective` stays exported and pure — the eval
 * cases and the controller tests still call it directly — but every production call site
 * inside this package now goes through {@link runSpecialist}, which validates both ends.
 *
 * Why the slices differ, and why that is the whole value: `professional_color` is the only
 * tool that may read run-scoped host measurements (`evidence`), and before this file the
 * only thing saying so was the shape of one object literal in `professional-color.ts`.
 * Now the colour specialist declares `evidence` and the other four do not, so a future
 * change that threads a `ColorEvidenceReader` into the motion controller fails a
 * validation with a named specialist instead of quietly widening what a tool can see.
 */
import type { EditorCommand } from '@framepilot/editor-core';
import {
  type AudioControllerResult,
  type AudioObjective,
  resolveAudioObjective,
} from '../controllers/audio-controller.js';
import {
  type AutomaticTrackingObjective,
  type SubjectDetectionObjective,
  type TrackingRequestPlan,
  resolveAutomaticTrackingObjective,
  resolveSubjectDetectionObjective,
} from '../controllers/automatic-tracking-controller.js';
import {
  type ColorControllerResult,
  type ColorObjective,
  resolveColorObjective,
} from '../controllers/color-controller.js';
import {
  type MotionControllerResult,
  type MotionObjective,
  resolveMotionObjective,
} from '../controllers/motion-controller.js';
import {
  type TimelineControllerResult,
  type TimelineEditObjective,
  resolveTimelineObjective,
} from '../controllers/timeline-controller.js';
import {
  type TrackingMaskControllerResult,
  type TrackingMaskObjective,
  resolveTrackingMaskObjective,
} from '../controllers/tracking-mask-controller.js';
import {
  type Specialist,
  type SpecialistArtifact,
  type SpecialistContext,
  type SpecialistOutput,
  defineSpecialist,
} from './contract.js';

/** The shape every controller result already has, named once. */
interface ControllerResult<Command> {
  readonly status: 'resolved' | 'rejected';
  readonly commands?: readonly Command[];
  readonly evidence?: readonly string[];
  readonly facts?: readonly { readonly name: string; readonly value: string | number | boolean }[];
  readonly code?: string;
  readonly detail?: string;
}

/** What a controller specialist returns: the compiler-ready commands, nothing else. */
export interface ControllerOutputs<Command> {
  readonly commands: readonly Command[];
}

function artifactsOf(
  result: Pick<ControllerResult<never>, 'evidence' | 'facts'>,
): SpecialistArtifact[] {
  return [
    ...(result.evidence ?? []).map(
      (value): SpecialistArtifact => ({ kind: 'evidence', name: 'target', value }),
    ),
    ...(result.facts ?? []).map(
      (fact): SpecialistArtifact => ({ kind: 'fact', name: fact.name, value: fact.value }),
    ),
  ];
}

/**
 * Map one controller result onto the shared output.
 *
 * `confidence` is 1 or 0 and that is the honest number: a controller resolves its target
 * from authoritative editor state or it refuses — there is no middle verdict to report,
 * and inventing a spread would make the field lie in the one place a reader would trust it.
 */
function outputOf<Command>(
  result: ControllerResult<Command>,
): SpecialistOutput<ControllerOutputs<Command>> {
  const resolved = result.status === 'resolved';
  return {
    outputs: { commands: resolved ? (result.commands ?? []) : [] },
    artifacts: artifactsOf(result),
    confidence: resolved ? 1 : 0,
    errors: resolved
      ? []
      : [{ code: result.code ?? 'rejected', detail: result.detail ?? 'no detail given' }],
  };
}

/** Build a controller specialist from its slice and its `resolve*Objective` function. */
function controllerSpecialist<Objective, Command>(
  name: string,
  slice: Specialist<never, never>['slice'],
  resolve: (
    input: SpecialistContext & { readonly objective: Objective },
  ) => ControllerResult<Command>,
): Specialist<Objective, ControllerOutputs<Command>> {
  return defineSpecialist<Objective, ControllerOutputs<Command>>({
    name,
    slice,
    run: (input) => outputOf(resolve({ ...input.context, objective: input.inputs })),
  });
}

/** Mixing, EQ, dynamics, gain automation and ducking. Reads the project and the selection. */
export const AUDIO_SPECIALIST = controllerSpecialist<
  AudioObjective,
  NonNullable<Extract<AudioControllerResult, { status: 'resolved' }>['commands']>[number]
>('audio', ['project', 'projectRevision', 'interaction'], (input) =>
  resolveAudioObjective(input as never),
);

/**
 * Primary colour correction and shot matching. The ONE specialist that declares
 * `evidence`: matching derives its correction from revision-bound host measurements.
 */
export const COLOR_SPECIALIST = controllerSpecialist<
  ColorObjective,
  NonNullable<Extract<ColorControllerResult, { status: 'resolved' }>['commands']>[number]
>('color', ['project', 'projectRevision', 'interaction', 'evidence'], (input) =>
  resolveColorObjective(input as never),
);

/** Keyframed motion on the selected clip/property. */
export const MOTION_SPECIALIST = controllerSpecialist<
  MotionObjective,
  NonNullable<Extract<MotionControllerResult, { status: 'resolved' }>['commands']>[number]
>('motion', ['project', 'projectRevision', 'interaction'], (input) =>
  resolveMotionObjective(input as never),
);

/** Roll, slip, slide, ripple trim, J/L cuts, multicam switches. */
export const TIMELINE_SPECIALIST = controllerSpecialist<TimelineEditObjective, EditorCommand>(
  'timeline',
  ['project', 'projectRevision', 'interaction'],
  (input) => resolveTimelineObjective(input as never) as TimelineControllerResult,
);

/** Deterministic tracking of an existing authored mask. */
export const TRACKING_MASK_SPECIALIST = controllerSpecialist<
  TrackingMaskObjective,
  NonNullable<Extract<TrackingMaskControllerResult, { status: 'resolved' }>['commands']>[number]
>('tracking_mask', ['project', 'projectRevision', 'interaction'], (input) =>
  resolveTrackingMaskObjective(input as never),
);

/**
 * Automatic CV tracking and subject detection.
 *
 * Its outputs are a `TrackingRequestPlan` — a job for the host CV worker — not editor
 * commands, which is exactly why the shared shape has an open `outputs` field rather than
 * a `commands` field: two specialists in the same family produce different products and
 * still report evidence, confidence and refusals identically.
 *
 * Declared here with the rest so the slice is stated in one place, but its only production
 * caller lives in `apps/desktop/electron/ai/automatic-tracking-executor.ts`, which is
 * outside this change. Adopting `runSpecialist` there is the residual on P5.1.
 */
interface PlanResult {
  readonly status: 'resolved' | 'rejected';
  readonly plan?: TrackingRequestPlan;
  readonly evidence?: readonly string[];
  readonly facts?: readonly { readonly name: string; readonly value: string | number | boolean }[];
  readonly code?: string;
  readonly detail?: string;
}

/** What a tracking specialist returns: the host job to run, when it resolved one. */
export interface TrackingPlanOutputs {
  readonly plan?: TrackingRequestPlan;
}

function planSpecialist<Objective>(
  name: string,
  resolve: (input: SpecialistContext & { readonly objective: Objective }) => PlanResult,
): Specialist<Objective, TrackingPlanOutputs> {
  return defineSpecialist<Objective, TrackingPlanOutputs>({
    name,
    slice: ['project', 'projectRevision', 'interaction'],
    run: (input) => {
      const result = resolve({ ...input.context, objective: input.inputs });
      const resolved = result.status === 'resolved';
      return {
        outputs: resolved && result.plan ? { plan: result.plan } : {},
        artifacts: artifactsOf(result),
        confidence: resolved ? 1 : 0,
        errors: resolved
          ? []
          : [{ code: result.code ?? 'rejected', detail: result.detail ?? 'no detail given' }],
      };
    },
  });
}

export const AUTOMATIC_TRACKING_SPECIALIST = planSpecialist<AutomaticTrackingObjective>(
  'automatic_tracking',
  (input) => resolveAutomaticTrackingObjective(input as never) as PlanResult,
);

/** Subject detection — the read half of the automatic-tracking controller. */
export const SUBJECT_DETECTION_SPECIALIST = planSpecialist<SubjectDetectionObjective>(
  'subject_detection',
  (input) => resolveSubjectDetectionObjective(input as never) as PlanResult,
);

/** Every declared specialist, for the contract tests and for `debug:` surfaces. */
export const DOMAIN_SPECIALISTS = [
  AUDIO_SPECIALIST,
  COLOR_SPECIALIST,
  MOTION_SPECIALIST,
  TIMELINE_SPECIALIST,
  TRACKING_MASK_SPECIALIST,
  AUTOMATIC_TRACKING_SPECIALIST,
  SUBJECT_DETECTION_SPECIALIST,
] as const;
