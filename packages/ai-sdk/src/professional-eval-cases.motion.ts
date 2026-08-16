/** Executable outcome evals for every animatable clip motion property. */
import { compileMotionCommand, type ClipKeyframeProperty } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { resolveMotionObjective, MotionObjectiveSchema } from './controllers/motion-controller.js';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const CLIP_START_SECONDS = 0;
const PLAYHEAD_SECONDS = 2;
const MOTION_DURATION_FRAMES = 15;

function motionEvalProject(): Project {
  return parseProject({
    id: 'professional_motion_eval',
    name: 'Professional motion eval',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'hero_asset', path: 'hero.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      revision: 2,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'hero',
              assetId: 'hero_asset',
              trackId: 'v1',
              start: CLIP_START_SECONDS,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function motionFixture(): ProfessionalEvalFixture {
  const project = motionEvalProject();
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 7,
    playheadSeconds: PLAYHEAD_SECONDS,
    selectedClipIds: ['hero'],
    primaryClipId: 'hero',
  });
  return { project, interaction };
}

interface MotionEvalSpec {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly property: ClipKeyframeProperty;
  /** A legal in-contract endpoint for this property. */
  readonly value: number;
}

const SPECS: readonly MotionEvalSpec[] = [
  {
    fixtureId: 'motion.scale.outcome',
    capabilityId: 'motion.clip.scale',
    property: 'scale',
    value: 1.2,
  },
  { fixtureId: 'motion.x.outcome', capabilityId: 'motion.clip.x', property: 'x', value: 120 },
  { fixtureId: 'motion.y.outcome', capabilityId: 'motion.clip.y', property: 'y', value: -80 },
  {
    fixtureId: 'motion.rotation.outcome',
    capabilityId: 'motion.clip.rotation',
    property: 'rotation',
    value: 15,
  },
  {
    fixtureId: 'motion.opacity.outcome',
    capabilityId: 'motion.clip.opacity',
    property: 'opacity',
    value: 0.5,
  },
];

function resolveAndCompileMotion(
  spec: MotionEvalSpec,
  fixture: ProfessionalEvalFixture,
): ProfessionalEvalCompilation {
  const objective = MotionObjectiveSchema.parse({
    intent: 'animate_to',
    property: spec.property,
    value: spec.value,
    durationFrames: MOTION_DURATION_FRAMES,
  });
  const resolved = resolveMotionObjective({
    project: fixture.project,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return { status: 'failed', failures: [`motion controller rejected: ${resolved.code}`] };
  }
  const command = resolved.commands[0];
  if (resolved.commands.length !== 1 || !command) {
    return {
      status: 'failed',
      failures: [`expected one motion command, got ${resolved.commands.length}`],
    };
  }
  const compiled = compileMotionCommand({
    timeline: fixture.project.timeline,
    assets: fixture.project.assets,
    command,
  });
  if (compiled.status !== 'compiled') {
    return {
      status: 'failed',
      failures: [`motion compiler rejected: ${compiled.code} — ${compiled.detail}`],
    };
  }
  return {
    status: 'compiled',
    patch: compiled.patch,
    inversePatch: compiled.inversePatch,
    resolution: [`property=${spec.property}`, `points=${String(command.points.length)}`],
  };
}

/**
 * The editorial result of an animation is a trajectory that ends on the requested value at the
 * requested time, starting from where the clip already was at the playhead.
 */
function expectMotionOutcome(spec: MotionEvalSpec, persisted: Project): readonly string[] {
  const clip = persisted.timeline.tracks[0]!.clips[0]!;
  const keyframes = clip.keyframes
    .filter((keyframe) => keyframe.property === spec.property)
    .slice()
    .sort((left, right) => left.time - right.time);
  const last = keyframes.at(-1);
  const expectedEndTime =
    PLAYHEAD_SECONDS - CLIP_START_SECONDS + MOTION_DURATION_FRAMES / persisted.fps;
  return outcomeIssues([
    { label: `${spec.property} keyframe count`, actual: keyframes.length, expected: 2 },
    { label: `${spec.property} endpoint value`, actual: last?.value, expected: spec.value },
    { label: `${spec.property} endpoint time`, actual: last?.time, expected: expectedEndTime },
    {
      label: `${spec.property} starts at the playhead`,
      actual: keyframes[0]?.time,
      expected: PLAYHEAD_SECONDS - CLIP_START_SECONDS,
    },
  ]);
}

export const MOTION_EVAL_CASES: readonly ProfessionalEvalCase[] = SPECS.map((spec) => ({
  fixtureId: spec.fixtureId,
  capabilityId: spec.capabilityId,
  setup: motionFixture,
  resolveAndCompile: (fixture) => resolveAndCompileMotion(spec, fixture),
  expectOutcome: (persisted) => expectMotionOutcome(spec, persisted),
}));
