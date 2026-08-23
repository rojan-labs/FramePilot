/** Executable outcome evals for mask tracking: manual, and pack-measured automatic. */
import { compileTrackingCommand, type TrackSample } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  resolveTrackingMaskObjective,
  TrackingMaskObjectiveSchema,
} from './controllers/tracking-mask-controller.js';
import {
  resolveAutomaticTrackingObjective,
  AutomaticTrackingObjectiveSchema,
} from './controllers/automatic-tracking-controller.js';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const CLIP_ID = 'shot';
const TRACK_EFFECT_ID = `${CLIP_ID}__track`;

/** The fixture must already contain an editor-authored mask; the agent never invents a region. */
function trackingEvalProject(): Project {
  return parseProject({
    id: 'professional_tracking_eval',
    name: 'Professional tracking eval',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 4 }],
    timeline: {
      revision: 2,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: CLIP_ID,
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [
                {
                  id: `${CLIP_ID}__mask`,
                  type: 'mask',
                  params: {
                    shape: 'ellipse',
                    bounds: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
                  },
                  keyframes: [
                    { id: 'mx0', time: 0, property: 'x', value: 0.2 },
                    { id: 'mx1', time: 4, property: 'x', value: 0.5 },
                  ],
                },
              ],
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

function trackingFixture(): ProfessionalEvalFixture {
  const project = trackingEvalProject();
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 9,
    playheadSeconds: 2,
    selectedClipIds: [CLIP_ID],
    primaryClipId: CLIP_ID,
  });
  return { project, interaction };
}

function resolveAndCompileTracking(fixture: ProfessionalEvalFixture): ProfessionalEvalCompilation {
  const objective = TrackingMaskObjectiveSchema.parse({ intent: 'track_existing_mask' });
  const resolved = resolveTrackingMaskObjective({
    project: fixture.project,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return { status: 'failed', failures: [`tracking controller rejected: ${resolved.code}`] };
  }
  const command = resolved.commands[0];
  if (resolved.commands.length !== 1 || !command) {
    return {
      status: 'failed',
      failures: [`expected one tracking command, got ${resolved.commands.length}`],
    };
  }
  const compiled = compileTrackingCommand({
    timeline: fixture.project.timeline,
    assets: fixture.project.assets,
    command,
  });
  if (compiled.status !== 'compiled') {
    return {
      status: 'failed',
      failures: [`tracking compiler rejected: ${compiled.code} — ${compiled.detail}`],
    };
  }
  return {
    status: 'compiled',
    patch: compiled.patch,
    inversePatch: compiled.inversePatch,
    resolution: [`clip=${CLIP_ID}`, 'engine=manual'],
  };
}

/**
 * The editorial result is a canonical tracker whose interpolated region stays inside the frame for
 * the whole clip — the objective a real tracker would be judged on.
 */
function expectTrackingOutcome(persisted: Project): readonly string[] {
  const clip = persisted.timeline.tracks[0]!.clips[0]!;
  const trackers = clip.effects.filter((effect) => effect.id === TRACK_EFFECT_ID);
  const tracker = trackers[0];
  const region = ((tracker?.params ?? {}) as { readonly region?: Record<string, number> }).region;
  const issues = [
    ...outcomeIssues([
      { label: 'tracker layers', actual: trackers.length, expected: 1 },
      { label: 'tracker type', actual: tracker?.type, expected: 'object_track' },
      {
        label: 'tracker engine',
        actual: (tracker?.params as Record<string, unknown>)?.engine,
        expected: 'manual',
      },
      {
        label: 'authored mask preserved',
        actual: clip.effects.some((effect) => effect.type === 'mask'),
        expected: true,
      },
      // The tracker seeds itself from the mask's authored geometry, never a guessed region.
      {
        label: 'seed region',
        actual: region,
        expected: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
      },
    ]),
  ];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? (region?.width ?? Number.NaN) : (region?.height ?? Number.NaN);
    const values = (tracker?.keyframes ?? [])
      .filter((keyframe) => keyframe.property === axis)
      .map((keyframe) => keyframe.value);
    if (values.length === 0) issues.push(`tracker has no ${axis} keyframes`);
    for (const value of values) {
      if (!(value >= 0 && value + size <= 1)) {
        issues.push(`tracked ${axis} region leaves the frame: ${String(value)} + ${String(size)}`);
      }
    }
  }
  return issues;
}

export const TRACKING_MASK_EVAL_CASES: readonly ProfessionalEvalCase[] = [
  {
    fixtureId: 'tracking-mask.manual.outcome',
    capabilityId: 'tracking_mask.manual_mask_track',
    setup: trackingFixture,
    resolveAndCompile: resolveAndCompileTracking,
    expectOutcome: (persisted) => expectTrackingOutcome(persisted),
  },
  {
    fixtureId: 'tracking-mask.automatic.outcome',
    capabilityId: 'tracking_mask.automatic_subject_track',
    setup: automaticFixture,
    resolveAndCompile: resolveAndCompileAutomatic,
    expectOutcome: (persisted) => expectAutomaticOutcome(persisted),
  },
];

// --- automatic (pack-measured) path -----------------------------------------

/** Deterministic stand-in for the worker's honest output: a slow rightward drift. */
function measuredSamples(): TrackSample[] {
  return Array.from({ length: 12 }, (_, index) => ({
    frame: index * 8,
    box: { x: 0.2 + index * 0.01, y: 0.1, width: 0.25, height: 0.4 },
    confidence: 0.9,
    occluded: false,
  }));
}

function automaticFixture(): ProfessionalEvalFixture {
  const project = trackingEvalProject();
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 9,
    playheadSeconds: 2,
    selectedClipIds: [CLIP_ID],
    primaryClipId: CLIP_ID,
  });
  return { project, interaction };
}

function resolveAndCompileAutomatic(fixture: ProfessionalEvalFixture): ProfessionalEvalCompilation {
  const objective = AutomaticTrackingObjectiveSchema.parse({
    intent: 'track_subject_automatically',
    subject: 'silhouette',
  });
  const resolved = resolveAutomaticTrackingObjective({
    project: fixture.project,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return { status: 'failed', failures: [`automatic controller rejected: ${resolved.code}`] };
  }
  const compiled = compileTrackingCommand({
    timeline: fixture.project.timeline,
    assets: fixture.project.assets,
    command: {
      type: 'apply_tracked_mask',
      timelineRevision: fixture.project.timeline.revision ?? 0,
      clipId: resolved.plan.clipId,
      maskEffectId: professionalMaskId(resolved.plan.clipId),
      target: 'bounding_box',
      engine: 'framepilot.tracking-lite@1.0.0',
      fps: resolved.plan.fps,
      startSeconds: resolved.plan.startSeconds,
      samples: measuredSamples(),
    },
  });
  if (compiled.status !== 'compiled') {
    return {
      status: 'failed',
      failures: [`automatic compiler rejected: ${compiled.code} — ${compiled.detail}`],
    };
  }
  return {
    status: 'compiled',
    patch: compiled.patch,
    inversePatch: compiled.inversePatch,
    resolution: [
      `clip=${resolved.plan.clipId}`,
      `capability=${resolved.plan.capability}`,
      'engine=framepilot.tracking-lite@1.0.0',
    ],
  };
}

function professionalMaskId(clipId: string): string {
  return `${clipId}__mask`;
}

/**
 * The editorial result of the measured path: the SAME tracker effect shape as
 * manual, but its keyframes come from measurements and carry the pack identity
 * as provenance, and every measured position stays inside the frame.
 */
function expectAutomaticOutcome(persisted: Project): readonly string[] {
  const clip = persisted.timeline.tracks[0]!.clips[0]!;
  const trackers = clip.effects.filter((effect) => effect.id === TRACK_EFFECT_ID);
  const tracker = trackers[0];
  const engine = (tracker?.params as Record<string, unknown>)?.engine;
  const issues = [
    ...outcomeIssues([
      { label: 'tracker layers', actual: trackers.length, expected: 1 },
      { label: 'tracker type', actual: tracker?.type, expected: 'object_track' },
      {
        label: 'measuring pack recorded as provenance',
        actual: engine,
        expected: 'framepilot.tracking-lite@1.0.0',
      },
      {
        label: 'authored mask preserved',
        actual: clip.effects.some((effect) => effect.type === 'mask'),
        expected: true,
      },
    ]),
  ];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 0.25 : 0.4;
    const values = (tracker?.keyframes ?? [])
      .filter((keyframe) => keyframe.property === axis)
      .map((keyframe) => keyframe.value);
    if (values.length === 0) issues.push(`tracker has no ${axis} keyframes`);
    for (const value of values) {
      if (!(value >= 0 && value + size <= 1)) {
        issues.push(`tracked ${axis} region leaves the frame: ${String(value)} + ${String(size)}`);
      }
    }
  }
  return issues;
}
