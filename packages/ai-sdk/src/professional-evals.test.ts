import { describe, expect, it } from 'vitest';
import { compileAudioCommand } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { EDITOR_CAPABILITIES, type EditorCapability } from './editor-capabilities.js';
import { PROFESSIONAL_EVAL_CASES } from './professional-eval-cases.js';
import {
  PROFESSIONAL_EVAL_MANIFEST,
  PROFESSIONAL_EVAL_STAGES,
  buildProfessionalEvalManifest,
  evaluateCompiledProfessionalOperation,
  professionalEvalDriftIssues,
} from './professional-evals.js';

function audioProject(): Project {
  return parseProject({
    id: 'professional_eval_audio',
    name: 'Professional audio eval',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'music_asset', path: 'music.wav', kind: 'audio', durationSeconds: 10 }],
    timeline: {
      revision: 7,
      tracks: [
        {
          id: 'music',
          type: 'audio',
          clips: [
            {
              id: 'bed',
              assetId: 'music_asset',
              trackId: 'music',
              start: 0,
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

describe('professional operation eval manifest', () => {
  it('gives every advertised editable capability a full-stage outcome row', () => {
    expect(professionalEvalDriftIssues(PROFESSIONAL_EVAL_MANIFEST)).toEqual([]);
    const advertised = EDITOR_CAPABILITIES.filter(
      (capability) => capability.availability.state === 'available' && capability.editable,
    );
    const registered = PROFESSIONAL_EVAL_MANIFEST.filter(
      (row) => row.availability === 'registered',
    );
    expect(registered).toHaveLength(advertised.length);
    expect(registered.every((row) => row.stages.length === PROFESSIONAL_EVAL_STAGES.length)).toBe(
      true,
    );
    expect(new Set(registered.map((row) => row.fixtureId)).size).toBe(registered.length);
  });

  it('publishes the pack-gated automatic tracking capability as registered with full stages', () => {
    const row = PROFESSIONAL_EVAL_MANIFEST.find(
      (candidate) => candidate.capabilityId === 'tracking_mask.automatic_subject_track',
    );
    // The capability is executable end to end (2026-08): its outcome case
    // compiles a measured sample set into the reversible tracked-mask patch,
    // so it registers like every other shipped capability rather than hiding
    // behind "unsupported".
    expect(row).toMatchObject({
      availability: 'registered',
      fixtureId: 'tracking-mask.automatic.outcome',
      stages: PROFESSIONAL_EVAL_STAGES,
    });
    // The on-demand pack boundary must still be visible somewhere honest.
    const capability = EDITOR_CAPABILITIES.find(
      (candidate) => candidate.id === 'tracking_mask.automatic_subject_track',
    );
    expect(capability?.availability.reason).toMatch(/Capability Pack/);
  });

  it('fails release drift when a new editable capability has no registered fixture', () => {
    const prototype = EDITOR_CAPABILITIES[0]!;
    const newCapability: EditorCapability = {
      ...prototype,
      id: 'audio.clip.future_bus',
      domain: 'audio',
      commandType: prototype.commandType,
    };
    const capabilities = [...EDITOR_CAPABILITIES, newCapability];
    const rows = buildProfessionalEvalManifest(capabilities);
    expect(professionalEvalDriftIssues(rows, capabilities)).toContainEqual({
      capabilityId: 'audio.clip.future_bus',
      message: 'Advertised editable capability lacks full-stage outcome coverage.',
    });
  });

  it('runs one executable case for every registered fixture', () => {
    const registered = PROFESSIONAL_EVAL_MANIFEST.filter(
      (row) => row.availability === 'registered',
    );
    expect(PROFESSIONAL_EVAL_CASES).toHaveLength(registered.length);
    expect(new Set(PROFESSIONAL_EVAL_CASES.map((evalCase) => evalCase.fixtureId))).toEqual(
      new Set(registered.map((row) => row.fixtureId)),
    );
  });

  it('fails release drift when a registered fixture has no executable case', () => {
    const withoutTrackingCase = PROFESSIONAL_EVAL_CASES.filter(
      (evalCase) => evalCase.capabilityId !== 'tracking_mask.manual_mask_track',
    );
    expect(
      professionalEvalDriftIssues(
        PROFESSIONAL_EVAL_MANIFEST,
        EDITOR_CAPABILITIES,
        withoutTrackingCase,
      ),
    ).toContainEqual({
      capabilityId: 'tracking_mask.manual_mask_track',
      message:
        'Registered fixture "tracking-mask.manual.outcome" has 0 executable cases; expected exactly one.',
    });
  });

  it('fails release drift when an executable case is not on the scorecard', () => {
    const strayCase = { ...PROFESSIONAL_EVAL_CASES[0]!, fixtureId: 'timeline.unlisted.outcome' };
    expect(
      professionalEvalDriftIssues(PROFESSIONAL_EVAL_MANIFEST, EDITOR_CAPABILITIES, [
        ...PROFESSIONAL_EVAL_CASES,
        strayCase,
      ]),
    ).toContainEqual({
      capabilityId: strayCase.capabilityId,
      message: 'Executable case "timeline.unlisted.outcome" has no registered scorecard row.',
    });
  });
});

describe('compiled professional operation evaluator', () => {
  it('proves validate/apply/invert/reload/transport/review planning on an audio outcome', () => {
    const project = audioProject();
    const compiled = compileAudioCommand({
      timeline: project.timeline,
      assets: project.assets,
      command: {
        type: 'mix_clip_audio',
        timelineRevision: 7,
        clipId: 'bed',
        rate: { numerator: 30, denominator: 1 },
        settings: { gainDb: -6, fadeInFrames: 15, normalize: true },
      },
    });
    expect(compiled.status).toBe('compiled');
    if (compiled.status !== 'compiled') return;

    const result = evaluateCompiledProfessionalOperation({
      capabilityId: 'audio.clip.gain',
      project,
      patch: compiled.patch,
      inversePatch: compiled.inversePatch,
    });

    expect(result.stages).toEqual(['validate', 'apply', 'invert', 'persist_reload', 'cross_host']);
    expect(result.persistedProject.timeline.tracks[0]!.clips[0]!.effects[0]).toMatchObject({
      id: 'bed__gain',
      params: { gainDb: -6, fadeInSeconds: 0.5, normalize: true },
    });
    expect(result.requests.filter((request) => request.kind === 'audio').length).toBeGreaterThan(0);
  });
});
