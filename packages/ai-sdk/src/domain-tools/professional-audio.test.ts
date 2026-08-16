import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { AudioObjectiveSchema, resolveAudioObjective } from '../controllers/audio-controller.js';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { PROFESSIONAL_AUDIO_TOOL } from './professional-audio.js';

function project(): Project {
  return parseProject({
    id: 'audio_project',
    name: 'Audio controller fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'music_asset', path: 'music.wav', kind: 'audio', durationSeconds: 20 },
      { id: 'voice_asset', path: 'voice.wav', kind: 'audio', durationSeconds: 20 },
      { id: 'amb_asset', path: 'amb.wav', kind: 'audio', durationSeconds: 20 },
    ],
    timeline: {
      revision: 5,
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
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
              effects: [
                {
                  id: 'bed__gain',
                  type: 'audio_gain',
                  params: { gainDb: -3, normalize: true },
                  keyframes: [],
                },
              ],
              keyframes: [],
            },
          ],
        },
        {
          id: 'dialogue',
          type: 'audio',
          clips: [
            {
              id: 'voice',
              assetId: 'voice_asset',
              trackId: 'dialogue',
              start: 2,
              end: 18,
              sourceStart: 0,
              sourceEnd: 16,
              effects: [],
              keyframes: [],
            },
          ],
        },
        {
          id: 'ambience',
          type: 'audio',
          clips: [
            {
              id: 'amb',
              assetId: 'amb_asset',
              trackId: 'ambience',
              start: 0,
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
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

function context(
  base: Project,
  selectedClipIds: readonly string[],
  primaryClipId: string,
): ToolContext {
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 9,
      playheadSeconds: 5,
      selectedClipIds,
      primaryClipId,
    }),
  };
}

function dispatch(base: Project, ctx: ToolContext, args: Record<string, unknown>) {
  const operations = operationsForCall(
    { id: 'audio_call', name: 'professional_audio', arguments: args },
    ctx,
  );
  const patch: Patch = {
    patchId: 'audio_tool_test' as PatchId,
    createdBy: 'agent',
    reason: 'audio controller test',
    operations,
  };
  return applyPatch(base.timeline, patch);
}

describe('professional_audio domain tool', () => {
  it('levels the selected clip in frame units while preserving existing normalization', () => {
    const base = project();
    const edited = dispatch(base, context(base, ['bed'], 'bed'), {
      intent: 'level',
      gainDb: -8,
      fadeInFrames: 15,
      fadeCurve: 'equal-power',
    });
    expect(edited.tracks[0]!.clips[0]!.effects).toEqual([
      expect.objectContaining({
        id: 'bed__gain',
        params: expect.objectContaining({
          gainDb: -8,
          fadeInSeconds: 0.5,
          fadeCurve: 'equal-power',
          normalize: true,
        }),
      }),
    ]);
  });

  it('ducks the primary selected bed under the one other selected track', () => {
    const base = project();
    const edited = dispatch(base, context(base, ['voice', 'bed'], 'bed'), {
      intent: 'duck_selection',
      reductionDb: 14,
    });
    expect(edited.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({
      gainDb: -3,
      normalize: true,
      duckUnderTrackId: 'dialogue',
      duckAmountDb: -14,
    });
  });

  it('cleans up the selected clip with an EQ without touching its level', () => {
    const base = project();
    const edited = dispatch(base, context(base, ['bed'], 'bed'), {
      intent: 'eq',
      eqBands: [
        { kind: 'high-pass', frequencyHz: 90 },
        { kind: 'high-shelf', frequencyHz: 8000, gainDb: 2 },
      ],
    });
    expect(edited.tracks[0]!.clips[0]!.effects[0]!.params).toMatchObject({
      eq: {
        bands: [
          { kind: 'high-pass', frequencyHz: 90 },
          { kind: 'high-shelf', frequencyHz: 8000, gainDb: 2 },
        ],
      },
      gainDb: -3,
      normalize: true,
    });
  });

  it('compresses the selected clip with bounded settings', () => {
    const base = project();
    const edited = dispatch(base, context(base, ['bed'], 'bed'), {
      intent: 'compress',
      dynamics: { thresholdDb: -20, ratio: 4, attackMs: 8, releaseMs: 150 },
    });
    expect(edited.tracks[0]!.clips[0]!.effects[0]!.params.dynamics).toEqual({
      thresholdDb: -20,
      ratio: 4,
      attackMs: 8,
      releaseMs: 150,
    });
  });

  it('rides the level over time from frames the model authored', () => {
    const base = project();
    const edited = dispatch(base, context(base, ['bed'], 'bed'), {
      intent: 'automate_gain',
      automationPoints: [
        { frame: 0, gainDb: 0 },
        { frame: 60, gainDb: -18, easing: 'ease-out' },
      ],
    });
    expect(edited.tracks[0]!.clips[0]!.effects[0]!.keyframes).toEqual([
      expect.objectContaining({ time: 0, property: 'gainDb', value: 0 }),
      expect.objectContaining({ time: 2, property: 'gainDb', value: -18, easing: 'ease-out' }),
    ]);
  });

  it('refuses a lane and a static level in one instruction', () => {
    expect(() =>
      AudioObjectiveSchema.parse({
        intent: 'automate_gain',
        gainDb: -6,
        automationPoints: [
          { frame: 0, gainDb: 0 },
          { frame: 60, gainDb: -6 },
        ],
      }),
    ).toThrow(/gainDb belongs to the level intent, not automate_gain/);
  });

  it('advertises one variant per intent, so no illegal combination is representable', () => {
    const schema = PROFESSIONAL_AUDIO_TOOL.parameters as {
      oneOf: { properties: Record<string, unknown>; required: string[] }[];
    };
    expect(schema.oneOf).toHaveLength(6);
    const eq = schema.oneOf.find((variant) => 'eqBands' in variant.properties);
    expect(eq?.required).toContain('eqBands');
    // The whole point: the eq variant never offers the level fields the flat
    // schema used to advertise, so the model cannot author a mixed call.
    expect(Object.keys(eq?.properties ?? {})).toEqual(['intent', 'target', 'eqBands']);
  });

  it.each([
    [{ intent: 'eq' }, /requires eqBands/],
    [{ intent: 'compress' }, /requires dynamics/],
    [
      { intent: 'level', eqBands: [{ kind: 'high-pass', frequencyHz: 80 }] },
      /eqBands belongs to the eq intent, not level/,
    ],
    [
      { intent: 'eq', eqBands: [{ kind: 'peaking', frequencyHz: 1000 }] },
      /A peaking band requires gainDb/,
    ],
    [
      { intent: 'eq', eqBands: [{ kind: 'low-pass', frequencyHz: 8000, gainDb: 2 }] },
      /takes no gainDb/,
    ],
    [
      { intent: 'eq', eqBands: [{ kind: 'high-pass', frequencyHz: 80 }], gainDb: -3 },
      /gainDb belongs to the level intent, not eq/,
    ],
    [
      {
        intent: 'compress',
        dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 },
        fadeInFrames: 12,
      },
      /fadeInFrames belongs to the level intent, not compress/,
    ],
    [
      {
        intent: 'automate_gain',
        automationPoints: [
          { frame: 30, gainDb: 0 },
          { frame: 30, gainDb: -6 },
        ],
      },
      /strictly increase/,
    ],
  ])('refuses a chain instruction the renderer could not honour', (args, message) => {
    expect(() => AudioObjectiveSchema.parse(args)).toThrow(message);
  });

  it('rejects ambiguous sidechains instead of guessing a role', () => {
    const base = project();
    const objective = AudioObjectiveSchema.parse({ intent: 'duck_selection' });
    expect(
      resolveAudioObjective({
        project: base,
        interaction: context(base, ['voice', 'amb', 'bed'], 'bed').interaction!,
        objective,
      }),
    ).toMatchObject({ status: 'rejected', code: 'sidechain_ambiguous' });
  });

  it('requires live interaction and exposes a host-only schema', () => {
    expect(() =>
      PROFESSIONAL_AUDIO_TOOL.buildOps?.({ intent: 'level', gainDb: -6 }, { project: project() }),
    ).toThrow(/live editor interaction/);
    expect(PROFESSIONAL_AUDIO_TOOL).toMatchObject({
      name: 'professional_audio',
      hostUiOnly: true,
      mutates: true,
      available: true,
    });
  });

  it('names the intent that owns a misfiled setting, and says so for an invented one', () => {
    expect(() =>
      AudioObjectiveSchema.parse({ intent: 'level', gainDb: -6, reductionDb: 9 }),
    ).toThrow(/reductionDb belongs to the duck_selection\/duck_roles intent, not level/);
    expect(() => AudioObjectiveSchema.parse({ intent: 'level', gainDb: -6, wobble: 1 })).toThrow(
      /wobble is not an audio setting/,
    );
  });

  it('rejects empty level objectives and model-authored duck settings', () => {
    expect(() => AudioObjectiveSchema.parse({ intent: 'level' })).toThrow();
    expect(() => AudioObjectiveSchema.parse({ intent: 'duck_selection', gainDb: -8 })).toThrow();
  });
});

describe('professional_audio role-authored ducking', () => {
  /** Same fixture, but with the roles an editor would have authored on the tracks. */
  function roledProject(overrides: { readonly dialogueRole?: string } = {}): Project {
    const base = project();
    return parseProject({
      ...base,
      timeline: {
        ...base.timeline,
        tracks: base.timeline.tracks.map((track) =>
          track.id === 'music'
            ? { ...track, role: 'music' }
            : track.id === 'dialogue'
              ? { ...track, role: overrides.dialogueRole ?? 'dialogue' }
              : track,
        ),
      },
    });
  }

  it('ducks every clip of the bed role under the trigger role', () => {
    const base = roledProject();
    const edited = dispatch(base, context(base), {
      intent: 'duck_roles',
      bedRole: 'music',
      sidechainRole: 'dialogue',
      reductionDb: 9,
    });
    const bed = edited.tracks[0]!.clips[0]!;
    expect(bed.effects[0]).toMatchObject({
      id: 'bed__gain',
      type: 'audio_gain',
      // Positive reduction becomes the renderer's negative dB, under the dialogue track.
      params: { duckUnderTrackId: 'dialogue', duckAmountDb: -9 },
    });
  });

  it('does not need a selection, because the roles are authored on the tracks', () => {
    const base = roledProject();
    const resolution = resolveAudioObjective({
      project: base,
      interaction: captureEditorInteractionContext({
        project: base,
        projectRevision: 3,
        playheadSeconds: 5,
        selectedClipIds: [],
      }),
      objective: AudioObjectiveSchema.parse({
        intent: 'duck_roles',
        bedRole: 'music',
        sidechainRole: 'dialogue',
      }),
    });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.evidence).toEqual(['track_role']);
  });

  it('asks for a label instead of guessing which lane holds the dialogue', () => {
    const base = project(); // no roles authored anywhere
    const resolution = resolveAudioObjective({
      project: base,
      interaction: captureEditorInteractionContext({
        project: base,
        projectRevision: 3,
        playheadSeconds: 5,
        selectedClipIds: ['bed'],
        primaryClipId: 'bed',
      }),
      objective: AudioObjectiveSchema.parse({
        intent: 'duck_roles',
        bedRole: 'music',
        sidechainRole: 'dialogue',
      }),
    });
    expect(resolution).toMatchObject({
      status: 'rejected',
      code: 'bed_role_unlabelled',
      detail: expect.stringContaining('never inferred from track names'),
    });
  });

  it('refuses when two tracks claim the trigger role rather than picking one', () => {
    const base = roledProject();
    const withTwoDialogue = parseProject({
      ...base,
      timeline: {
        ...base.timeline,
        tracks: base.timeline.tracks.map((track) =>
          track.id === 'ambience' ? { ...track, role: 'dialogue' } : track,
        ),
      },
    });
    const resolution = resolveAudioObjective({
      project: withTwoDialogue,
      interaction: captureEditorInteractionContext({
        project: withTwoDialogue,
        projectRevision: 3,
        playheadSeconds: 5,
        selectedClipIds: [],
      }),
      objective: AudioObjectiveSchema.parse({
        intent: 'duck_roles',
        bedRole: 'music',
        sidechainRole: 'dialogue',
      }),
    });
    expect(resolution).toMatchObject({ status: 'rejected', code: 'sidechain_ambiguous' });
  });

  it('rejects ducking a role under itself', () => {
    expect(() =>
      AudioObjectiveSchema.parse({
        intent: 'duck_roles',
        bedRole: 'music',
        sidechainRole: 'music',
      }),
    ).toThrow();
  });

  it('keeps roles out of the selection-authored and level intents', () => {
    expect(() =>
      AudioObjectiveSchema.parse({ intent: 'duck_selection', bedRole: 'music' }),
    ).toThrow();
    expect(() =>
      AudioObjectiveSchema.parse({ intent: 'level', gainDb: -6, sidechainRole: 'dialogue' }),
    ).toThrow();
  });
});
