/** Executable outcome evals for the bounded clip mix capabilities. */
import { compileAudioCommand } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { AudioObjectiveSchema, resolveAudioObjective } from './controllers/audio-controller.js';
import { captureEditorInteractionContext } from './editor-context/interaction-context.js';
import {
  outcomeIssues,
  type ProfessionalEvalCase,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
} from './professional-eval-runner.js';

const BED_CLIP_ID = 'bed';
const BED_GAIN_EFFECT_ID = `${BED_CLIP_ID}__gain`;
const SIDECHAIN_TRACK_ID = 'dialogue';
const EVAL_FPS = 30;
/** The bed already carries a grade of mix decisions; omitted settings must survive every edit. */
const EXISTING_GAIN_DB = -3;

function audioEvalProject(): Project {
  return parseProject({
    id: 'professional_audio_eval',
    name: 'Professional audio eval',
    version: 1,
    fps: EVAL_FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'music_asset', path: 'music.wav', kind: 'audio', durationSeconds: 20 },
      { id: 'voice_asset', path: 'voice.wav', kind: 'audio', durationSeconds: 20 },
    ],
    timeline: {
      revision: 5,
      tracks: [
        {
          id: 'music',
          type: 'audio',
          clips: [
            {
              id: BED_CLIP_ID,
              assetId: 'music_asset',
              trackId: 'music',
              start: 0,
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
              effects: [
                {
                  id: BED_GAIN_EFFECT_ID,
                  type: 'audio_gain',
                  params: { gainDb: EXISTING_GAIN_DB },
                  keyframes: [],
                },
              ],
              keyframes: [],
            },
          ],
        },
        {
          id: SIDECHAIN_TRACK_ID,
          type: 'audio',
          clips: [
            {
              id: 'voice',
              assetId: 'voice_asset',
              trackId: SIDECHAIN_TRACK_ID,
              start: 2,
              end: 18,
              sourceStart: 0,
              sourceEnd: 16,
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

function audioFixture(selectedClipIds: readonly string[]): ProfessionalEvalFixture {
  const project = audioEvalProject();
  const interaction = captureEditorInteractionContext({
    project,
    projectRevision: 11,
    playheadSeconds: 5,
    selectedClipIds: [...selectedClipIds],
    primaryClipId: BED_CLIP_ID,
  });
  return { project, interaction };
}

interface AudioEvalSpec {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly selectedClipIds: readonly string[];
  readonly objective: Record<string, unknown>;
  readonly expectedParams: Readonly<Record<string, unknown>>;
  /** Only the automation lane writes keyframes; every other mix setting is a param. */
  readonly expectedKeyframes?: readonly Readonly<Record<string, unknown>>[];
}

const SPECS: readonly AudioEvalSpec[] = [
  {
    fixtureId: 'audio.gain.outcome',
    capabilityId: 'audio.clip.gain',
    selectedClipIds: [BED_CLIP_ID],
    objective: { intent: 'level', gainDb: -6 },
    expectedParams: { gainDb: -6 },
  },
  {
    fixtureId: 'audio.fade-in.outcome',
    capabilityId: 'audio.clip.fade_in',
    selectedClipIds: [BED_CLIP_ID],
    objective: { intent: 'level', fadeInFrames: 15 },
    // Frames convert through the sequence rate; the existing gain must be preserved.
    expectedParams: { fadeInSeconds: 0.5, gainDb: EXISTING_GAIN_DB },
  },
  {
    fixtureId: 'audio.fade-out.outcome',
    capabilityId: 'audio.clip.fade_out',
    selectedClipIds: [BED_CLIP_ID],
    objective: { intent: 'level', fadeOutFrames: 30 },
    expectedParams: { fadeOutSeconds: 1, gainDb: EXISTING_GAIN_DB },
  },
  {
    fixtureId: 'audio.normalize.outcome',
    capabilityId: 'audio.clip.normalize_peak',
    selectedClipIds: [BED_CLIP_ID],
    objective: { intent: 'level', normalize: true },
    expectedParams: { normalize: true, gainDb: EXISTING_GAIN_DB },
  },
  {
    fixtureId: 'audio.sidechain-duck.outcome',
    capabilityId: 'audio.clip.sidechain_duck',
    // Ducking derives both roles from selection: primary clip track is the bed, the one other
    // selected audio track is the sidechain. No track ids come from the model.
    selectedClipIds: ['voice', BED_CLIP_ID],
    objective: { intent: 'duck_selection', reductionDb: 12 },
    expectedParams: { duckUnderTrackId: SIDECHAIN_TRACK_ID, duckAmountDb: -12 },
  },
  {
    fixtureId: 'audio.eq.outcome',
    capabilityId: 'audio.clip.eq',
    selectedClipIds: [BED_CLIP_ID],
    objective: {
      intent: 'eq',
      eqBands: [
        { kind: 'high-pass', frequencyHz: 80 },
        { kind: 'peaking', frequencyHz: 3000, gainDb: -4, q: 1.5 },
      ],
    },
    expectedParams: {
      eq: {
        bands: [
          { kind: 'high-pass', frequencyHz: 80 },
          { kind: 'peaking', frequencyHz: 3000, gainDb: -4, q: 1.5 },
        ],
      },
      // Cleaning up the spectrum must not reset the level the editor already set.
      gainDb: EXISTING_GAIN_DB,
    },
  },
  {
    fixtureId: 'audio.compression.outcome',
    capabilityId: 'audio.clip.compression',
    selectedClipIds: [BED_CLIP_ID],
    objective: {
      intent: 'compress',
      dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupGainDb: 2 },
    },
    expectedParams: {
      dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupGainDb: 2 },
      gainDb: EXISTING_GAIN_DB,
    },
  },
  {
    fixtureId: 'audio.gain-automation.outcome',
    capabilityId: 'audio.clip.gain_automation',
    selectedClipIds: [BED_CLIP_ID],
    objective: {
      intent: 'automate_gain',
      // Authored in frames; the lane is stored in seconds through the sequence rate.
      automationPoints: [
        { frame: 0, gainDb: 0 },
        { frame: 150, gainDb: -12, easing: 'ease-in-out' },
        { frame: 300, gainDb: 0 },
      ],
    },
    expectedParams: { gainDb: EXISTING_GAIN_DB },
    expectedKeyframes: [
      { time: 0, property: 'gainDb', value: 0, easing: 'linear' },
      { time: 5, property: 'gainDb', value: -12, easing: 'ease-in-out' },
      { time: 10, property: 'gainDb', value: 0, easing: 'linear' },
    ],
  },
];

function resolveAndCompileAudio(
  spec: AudioEvalSpec,
  fixture: ProfessionalEvalFixture,
): ProfessionalEvalCompilation {
  const objective = AudioObjectiveSchema.parse(spec.objective);
  const resolved = resolveAudioObjective({
    project: fixture.project,
    interaction: fixture.interaction,
    objective,
  });
  if (resolved.status !== 'resolved') {
    return { status: 'failed', failures: [`audio controller rejected: ${resolved.code}`] };
  }
  const command = resolved.commands[0];
  if (resolved.commands.length !== 1 || !command) {
    return {
      status: 'failed',
      failures: [`expected one audio command, got ${resolved.commands.length}`],
    };
  }
  const compiled = compileAudioCommand({
    timeline: fixture.project.timeline,
    assets: fixture.project.assets,
    command,
  });
  if (compiled.status !== 'compiled') {
    return {
      status: 'failed',
      failures: [`audio compiler rejected: ${compiled.code} — ${compiled.detail}`],
    };
  }
  return {
    status: 'compiled',
    patch: compiled.patch,
    inversePatch: compiled.inversePatch,
    resolution: [`clip=${BED_CLIP_ID}`, `intent=${String(spec.objective.intent)}`],
  };
}

function expectAudioOutcome(spec: AudioEvalSpec, persisted: Project): readonly string[] {
  const bed = persisted.timeline.tracks[0]!.clips[0]!;
  const gains = bed.effects.filter((effect) => effect.id === BED_GAIN_EFFECT_ID);
  const params = (gains[0]?.params ?? {}) as Record<string, unknown>;
  return outcomeIssues([
    { label: 'canonical gain layers', actual: gains.length, expected: 1 },
    { label: 'gain type', actual: gains[0]?.type, expected: 'audio_gain' },
    ...Object.entries(spec.expectedParams).map(([name, expected]) => ({
      label: `${name}`,
      actual: params[name],
      expected,
    })),
    ...(spec.expectedKeyframes === undefined
      ? []
      : [
          {
            label: 'automation lane',
            actual: (gains[0]?.keyframes ?? []).map((keyframe) => ({
              time: keyframe.time,
              property: keyframe.property,
              value: keyframe.value,
              easing: keyframe.easing,
            })),
            expected: spec.expectedKeyframes,
          },
        ]),
  ]);
}

export const AUDIO_EVAL_CASES: readonly ProfessionalEvalCase[] = SPECS.map((spec) => ({
  fixtureId: spec.fixtureId,
  capabilityId: spec.capabilityId,
  setup: () => audioFixture(spec.selectedClipIds),
  resolveAndCompile: (fixture) => resolveAndCompileAudio(spec, fixture),
  expectOutcome: (persisted) => expectAudioOutcome(spec, persisted),
}));
