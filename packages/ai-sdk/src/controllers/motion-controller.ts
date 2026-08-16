/** Professional motion objectives resolved into deterministic editor-core commands. */
import { z } from 'zod/v4';
import {
  CLIP_KEYFRAME_PROPERTIES,
  evaluateKeyframes,
  type ClipKeyframeProperty,
  type Easing,
  type MotionCommand,
} from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { Clip, Keyframe, Project } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import { resolveEditorTarget, type TargetEvidence } from '../editor-context/target-resolver.js';
import { rationalFrameRate } from '../frame-time.js';

const log = createLogger('ai-sdk:controllers:motion');
const MAX_MOTION_DURATION_FRAMES = 18_000;
const KEYFRAME_TIME_EPSILON = 0.001;

export const MotionObjectiveSchema = z
  .object({
    intent: z.enum(['animate_to', 'continue']),
    property: z.enum(CLIP_KEYFRAME_PROPERTIES).optional(),
    value: z.number().finite().optional(),
    durationFrames: z.number().int().positive().max(MAX_MOTION_DURATION_FRAMES),
    easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier']).optional(),
    target: z.enum(['this', 'playhead']).default('this'),
    constraintPolicy: z.enum(['property_bounds', 'cover_canvas']).default('property_bounds'),
  })
  .strict()
  .superRefine((objective, refinement) => {
    if (objective.intent === 'animate_to' && objective.value === undefined) {
      refinement.addIssue({ code: 'custom', path: ['value'], message: 'value is required' });
    }
    if (objective.intent === 'continue' && objective.value !== undefined) {
      refinement.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'continue derives its endpoint from the existing trajectory',
      });
    }
  });

export type MotionObjective = z.infer<typeof MotionObjectiveSchema>;

export type MotionControllerRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'property_unresolved'
  | 'property_ambiguous'
  | 'playhead_outside_clip'
  | 'motion_window_outside_clip'
  | 'insufficient_motion_history'
  | 'canvas_coverage_violation';

export interface MotionControllerFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type MotionControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: MotionObjective;
      readonly commands: readonly MotionCommand[];
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly MotionControllerFact[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: MotionObjective;
      readonly code: MotionControllerRejectionCode;
      readonly detail: string;
      readonly facts: readonly MotionControllerFact[];
    };

export interface ResolveMotionObjectiveInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: MotionObjective;
}

type MotionControllerRejection = Extract<MotionControllerResult, { status: 'rejected' }>;

function rejected(
  objective: MotionObjective,
  code: MotionControllerRejectionCode,
  detail: string,
  facts: readonly MotionControllerFact[] = [],
): MotionControllerRejection {
  log.warn('Motion objective rejected', { intent: objective.intent, code });
  return { status: 'rejected', objective, code, detail, facts };
}

function clipById(project: Project, clipId: string): Clip | undefined {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

function resolveClip(
  input: ResolveMotionObjectiveInput,
): { readonly clip: Clip; readonly evidence: TargetEvidence } | MotionControllerRejection {
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
      'Motion requires exactly one resolved clip.',
    );
  }
  const clip = clipById(input.project, resolution.target.clipIds[0]!);
  return clip
    ? { clip, evidence: resolution.evidence }
    : rejected(input.objective, 'target_unresolved', 'The resolved clip no longer exists.');
}

function resolveProperty(
  input: ResolveMotionObjectiveInput,
  clip: Clip,
): ClipKeyframeProperty | MotionControllerRejection {
  if (input.objective.property !== undefined) return input.objective.property;
  const selected = [
    ...new Set(
      (input.interaction.selection.keyframes ?? [])
        .filter((keyframe) => keyframe.clipId === clip.id)
        .map((keyframe) => keyframe.property)
        .filter((property): property is ClipKeyframeProperty =>
          CLIP_KEYFRAME_PROPERTIES.includes(property as ClipKeyframeProperty),
        ),
    ),
  ];
  if (selected.length === 0) {
    return rejected(
      input.objective,
      'property_unresolved',
      'Select one transform property/keyframe or name the property explicitly.',
    );
  }
  if (selected.length > 1) {
    return rejected(
      input.objective,
      'property_ambiguous',
      `Selected keyframes span multiple properties: ${selected.join(', ')}.`,
    );
  }
  return selected[0]!;
}

function defaultValue(property: ClipKeyframeProperty): number {
  return property === 'scale' || property === 'opacity' ? 1 : 0;
}

function clipFrame(time: number, rate: ReturnType<typeof rationalFrameRate>): number {
  return Math.round((time * rate.numerator) / rate.denominator);
}

/** Avoid persisting binary floating-point residue from trajectory extrapolation. */
function stableMotionValue(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function selectedAnchorTime(
  input: ResolveMotionObjectiveInput,
  clip: Clip,
  property: ClipKeyframeProperty,
): number | undefined {
  const selectedTimes = (input.interaction.selection.keyframes ?? [])
    .filter((keyframe) => keyframe.clipId === clip.id && keyframe.property === property)
    .map((keyframe) => keyframe.time)
    .sort((left, right) => right - left);
  return selectedTimes[0];
}

function continuationPoints(
  input: ResolveMotionObjectiveInput,
  clip: Clip,
  property: ClipKeyframeProperty,
  rate: ReturnType<typeof rationalFrameRate>,
): readonly MotionCommand['points'][number][] | MotionControllerRejection {
  const points = clip.keyframes
    .filter((keyframe) => keyframe.property === property)
    .sort((left, right) => left.time - right.time);
  const selectedTime = selectedAnchorTime(input, clip, property);
  const playheadTime = input.interaction.playhead.seconds - clip.start;
  const anchorTime = selectedTime ?? playheadTime;
  let anchorIndex = -1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index]!.time <= anchorTime + KEYFRAME_TIME_EPSILON) {
      anchorIndex = index;
      break;
    }
  }
  const anchor = points[anchorIndex];
  const previous = points[anchorIndex - 1];
  if (!anchor || !previous || anchor.time - previous.time <= KEYFRAME_TIME_EPSILON) {
    return rejected(
      input.objective,
      'insufficient_motion_history',
      `Continue requires two earlier ${property} keyframes ending at the selected keyframe/playhead.`,
    );
  }
  const startFrame = clipFrame(anchor.time, rate);
  const endFrame = startFrame + input.objective.durationFrames;
  const durationSeconds = (input.objective.durationFrames * rate.denominator) / rate.numerator;
  const velocity = (anchor.value - previous.value) / (anchor.time - previous.time);
  const easing: Easing = input.objective.easing ?? 'linear';
  return [
    { domain: 'clip', frame: startFrame, value: anchor.value, easing },
    {
      domain: 'clip',
      frame: endFrame,
      value: stableMotionValue(anchor.value + velocity * durationSeconds),
      easing,
    },
  ];
}

function animatePoints(
  input: ResolveMotionObjectiveInput,
  clip: Clip,
  property: ClipKeyframeProperty,
  rate: ReturnType<typeof rationalFrameRate>,
): readonly MotionCommand['points'][number][] | MotionControllerRejection {
  const relativeTime = input.interaction.playhead.seconds - clip.start;
  if (relativeTime < 0 || relativeTime > clip.end - clip.start) {
    return rejected(
      input.objective,
      'playhead_outside_clip',
      `The playhead is outside clip "${clip.id}".`,
    );
  }
  const startFrame = clipFrame(relativeTime, rate);
  const currentValue =
    evaluateKeyframes(clip.keyframes, property, relativeTime) ?? defaultValue(property);
  const easing: Easing = input.objective.easing ?? 'ease-in-out';
  return [
    { domain: 'clip', frame: startFrame, value: currentValue, easing },
    {
      domain: 'clip',
      frame: startFrame + input.objective.durationFrames,
      value: input.objective.value!,
      easing,
    },
  ];
}

function candidateKeyframes(clip: Clip, command: MotionCommand): readonly Keyframe[] {
  const incomingTimes = new Set(
    command.points.map(
      (point) => (point.frame * command.rate.denominator) / command.rate.numerator,
    ),
  );
  const kept = clip.keyframes.filter(
    (keyframe) =>
      keyframe.property !== command.property ||
      ![...incomingTimes].some((time) => Math.abs(time - keyframe.time) <= KEYFRAME_TIME_EPSILON),
  );
  return [
    ...kept,
    ...command.points.map((point) => ({
      id: `candidate__${command.property}__${point.frame}`,
      time: (point.frame * command.rate.denominator) / command.rate.numerator,
      property: command.property,
      value: point.value,
      easing: point.easing,
    })),
  ];
}

function canvasCoverageIssue(
  input: ResolveMotionObjectiveInput,
  clip: Clip,
  command: MotionCommand,
): string | undefined {
  if (input.objective.constraintPolicy !== 'cover_canvas') return undefined;
  const keyframes = candidateKeyframes(clip, command);
  const start = command.points[0]!.frame;
  const end = command.points.at(-1)!.frame;
  for (let frame = start; frame <= end; frame += 1) {
    const time = (frame * command.rate.denominator) / command.rate.numerator;
    const scale = evaluateKeyframes(keyframes, 'scale', time) ?? 1;
    const x = evaluateKeyframes(keyframes, 'x', time) ?? 0;
    const y = evaluateKeyframes(keyframes, 'y', time) ?? 0;
    const rotation = evaluateKeyframes(keyframes, 'rotation', time) ?? 0;
    if (Math.abs(rotation) > 1e-6) {
      return `cover_canvas cannot prove coverage with rotation ${rotation}° at clip frame ${frame}.`;
    }
    const xLimit = (input.project.resolution.width * (scale - 1)) / 2;
    const yLimit = (input.project.resolution.height * (scale - 1)) / 2;
    if (scale < 1 || Math.abs(x) > xLimit + 1e-6 || Math.abs(y) > yLimit + 1e-6) {
      return `Transform exposes the canvas at clip frame ${frame} (scale=${scale}, x=${x}, y=${y}).`;
    }
  }
  return undefined;
}

/** Resolve selected-property animation or trajectory continuation without emitting operations. */
export function resolveMotionObjective(input: ResolveMotionObjectiveInput): MotionControllerResult {
  const resolvedClip = resolveClip(input);
  if ('status' in resolvedClip) return resolvedClip;
  const property = resolveProperty(input, resolvedClip.clip);
  if (typeof property !== 'string') return property;
  const rate = rationalFrameRate(input.project.fps);
  const points =
    input.objective.intent === 'animate_to'
      ? animatePoints(input, resolvedClip.clip, property, rate)
      : continuationPoints(input, resolvedClip.clip, property, rate);
  if ('status' in points) return points;
  const durationFrames = clipFrame(resolvedClip.clip.end - resolvedClip.clip.start, rate);
  if (points.at(-1)!.frame > durationFrames) {
    return rejected(
      input.objective,
      'motion_window_outside_clip',
      `Motion ends at clip frame ${points.at(-1)!.frame}, after the clip's final frame ${durationFrames}.`,
    );
  }
  const command: MotionCommand = {
    type: 'animate_clip_property',
    timelineRevision: input.interaction.timelineRevision,
    clipId: resolvedClip.clip.id,
    property,
    rate,
    points,
  };
  const coverageIssue = canvasCoverageIssue(input, resolvedClip.clip, command);
  if (coverageIssue) {
    return rejected(input.objective, 'canvas_coverage_violation', coverageIssue, [
      { name: 'constraintPolicy', value: input.objective.constraintPolicy },
    ]);
  }
  const result: MotionControllerResult = {
    status: 'resolved',
    objective: input.objective,
    commands: [command],
    evidence: [resolvedClip.evidence],
    facts: [
      { name: 'property', value: property },
      { name: 'startClipFrame', value: points[0]!.frame },
      { name: 'endClipFrame', value: points.at(-1)!.frame },
      { name: 'constraintPolicy', value: input.objective.constraintPolicy },
    ],
  };
  log.action('Motion objective resolved', {
    intent: input.objective.intent,
    property,
    clipId: resolvedClip.clip.id,
  });
  return result;
}
