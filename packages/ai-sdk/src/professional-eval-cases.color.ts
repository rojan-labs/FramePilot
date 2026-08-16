/** Executable outcome evals for every bounded primary color correction property. */
import { compileColorCommand } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { parseColorObjective, resolveColorObjective } from './controllers/color-controller.js';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const TARGET_CLIP_ID = 'shot_a';
/** Canonical technical grade layer; repeated corrections merge here instead of stacking. */
const PRIMARY_EFFECT_ID = `color__${TARGET_CLIP_ID}__primary`;

function colorEvalProject(): Project {
  const clip = (id: string, assetId: string, start: number, end: number) => ({
    id,
    assetId,
    trackId: 'v1',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  });
  return parseProject({
    id: 'professional_color_eval',
    name: 'Professional color eval',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 5 },
      { id: 'b', path: 'b.mp4', kind: 'video', durationSeconds: 5 },
    ],
    timeline: {
      revision: 6,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [clip(TARGET_CLIP_ID, 'a', 0, 5), clip('shot_b', 'b', 5, 10)],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function colorFixture(): ProfessionalEvalFixture {
  const project = colorEvalProject();
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 12,
    playheadSeconds: 2,
    selectedClipIds: [TARGET_CLIP_ID],
    primaryClipId: TARGET_CLIP_ID,
  });
  return { project, interaction };
}

interface ColorEvalSpec {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly property: string;
  /** A legal in-contract adjustment for this axis. */
  readonly value: number;
}

const SPECS: readonly ColorEvalSpec[] = [
  {
    fixtureId: 'color.exposure.outcome',
    capabilityId: 'color.clip.exposure',
    property: 'exposure',
    value: 0.4,
  },
  {
    fixtureId: 'color.contrast.outcome',
    capabilityId: 'color.clip.contrast',
    property: 'contrast',
    value: 0.2,
  },
  {
    fixtureId: 'color.saturation.outcome',
    capabilityId: 'color.clip.saturation',
    property: 'saturation',
    value: 0.15,
  },
  {
    fixtureId: 'color.temperature.outcome',
    capabilityId: 'color.clip.temperature',
    property: 'temperature',
    value: -0.1,
  },
  {
    fixtureId: 'color.tint.outcome',
    capabilityId: 'color.clip.tint',
    property: 'tint',
    value: 0.05,
  },
  {
    fixtureId: 'color.shadows.outcome',
    capabilityId: 'color.clip.shadows',
    property: 'shadows',
    value: -0.2,
  },
  {
    fixtureId: 'color.highlights.outcome',
    capabilityId: 'color.clip.highlights',
    property: 'highlights',
    value: -0.3,
  },
];

function resolveAndCompileColor(
  spec: ColorEvalSpec,
  fixture: ProfessionalEvalFixture,
): ProfessionalEvalCompilation {
  const objective = parseColorObjective({
    intent: 'correct',
    target: 'this',
    adjustments: { [spec.property]: spec.value },
  });
  const resolved = resolveColorObjective({
    project: fixture.project,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return { status: 'failed', failures: [`color controller rejected: ${resolved.code}`] };
  }
  const command = resolved.commands[0];
  if (resolved.commands.length !== 1 || !command) {
    return {
      status: 'failed',
      failures: [`expected one color command, got ${resolved.commands.length}`],
    };
  }
  const compiled = compileColorCommand({
    timeline: fixture.project.timeline,
    assets: fixture.project.assets,
    command,
  });
  if (compiled.status !== 'compiled') {
    return {
      status: 'failed',
      failures: [`color compiler rejected: ${compiled.code} — ${compiled.detail}`],
    };
  }
  return {
    status: 'compiled',
    patch: compiled.patch,
    inversePatch: compiled.inversePatch,
    resolution: [`axis=${spec.property}`, `clip=${TARGET_CLIP_ID}`],
  };
}

/** The grade must land on the canonical primary layer of the resolved shot, and only that shot. */
function expectColorOutcome(spec: ColorEvalSpec, persisted: Project): readonly string[] {
  const clips = persisted.timeline.tracks[0]!.clips;
  const graded = clips[0]!.effects.filter((effect) => effect.id === PRIMARY_EFFECT_ID);
  const params = (graded[0]?.params ?? {}) as Record<string, unknown>;
  return outcomeIssues([
    { label: 'primary grade layers', actual: graded.length, expected: 1 },
    { label: 'grade type', actual: graded[0]?.type, expected: 'color_grade' },
    { label: `${spec.property} value`, actual: params[spec.property], expected: spec.value },
    { label: 'unselected shot untouched', actual: clips[1]!.effects.length, expected: 0 },
  ]);
}

export const COLOR_EVAL_CASES: readonly ProfessionalEvalCase[] = SPECS.map((spec) => ({
  fixtureId: spec.fixtureId,
  capabilityId: spec.capabilityId,
  setup: colorFixture,
  resolveAndCompile: (fixture) => resolveAndCompileColor(spec, fixture),
  expectOutcome: (persisted) => expectColorOutcome(spec, persisted),
}));
