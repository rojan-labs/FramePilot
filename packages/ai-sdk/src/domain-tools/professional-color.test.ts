import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  ColorObjectiveSchema,
  parseColorObjective,
  resolveColorObjective,
} from '../controllers/color-controller.js';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { PROFESSIONAL_COLOR_TOOL } from './professional-color.js';
import type { ColorMeasurement } from '../color-evidence.js';
import { Orchestrator } from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import type { HostToolExecutor } from '../tool-executor.js';

function project(): Project {
  return parseProject({
    id: 'color_project',
    name: 'Color controller fixture',
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
          clips: [
            {
              id: 'shot_a',
              assetId: 'a',
              trackId: 'v1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
            {
              id: 'shot_b',
              assetId: 'b',
              trackId: 'v1',
              start: 5,
              end: 10,
              sourceStart: 0,
              sourceEnd: 5,
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

function context(base: Project, selectedClipIds = ['shot_a']): ToolContext {
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 12,
      playheadSeconds: 2,
      selectedClipIds,
      primaryClipId: selectedClipIds.at(-1),
    }),
  };
}

function dispatch(base: Project, ctx: ToolContext, args: Record<string, unknown>) {
  const operations = operationsForCall(
    { id: 'color_call', name: 'professional_color', arguments: args },
    ctx,
  );
  const patch: Patch = {
    patchId: 'color_tool_test' as PatchId,
    createdBy: 'agent',
    reason: 'color controller test',
    operations,
  };
  return applyPatch(base.timeline, patch);
}

function measurement(
  clipId: string,
  values: Partial<Record<'luma' | 'red' | 'green' | 'blue' | 'saturation', number>>,
  options: {
    readonly revision?: number;
    readonly occlusionFree?: boolean;
    /** Median RGB of the qualified skin pixels, plus how much of the frame they cover. */
    readonly skin?: { readonly rgb: readonly [number, number, number]; readonly coverage: number };
  } = {},
): ColorMeasurement {
  const channels = ['luma', 'red', 'green', 'blue', 'saturation'] as const;
  return {
    schemaVersion: 1,
    projectRevision: options.revision ?? 6,
    clipId,
    trackId: 'v1',
    startFrame: 0,
    endFrame: 3,
    isolation: 'timeline_composite',
    occlusionFree: options.occlusionFree ?? true,
    renderSettingsIdentity: 'temporal-evidence:1920x1080@24:captions=true',
    samples: [0, 1, 2].flatMap((frame) => [
      ...(options.skin === undefined
        ? []
        : (['skin_red', 'skin_green', 'skin_blue'] as const).map((channel, index) => {
            const value = options.skin!.rgb[index]!;
            return {
              frame,
              channel,
              min: value,
              max: value,
              mean: value,
              p10: value,
              p50: value,
              p90: value,
              nearBlackRatio: 0,
              nearWhiteRatio: 0,
              coverageRatio: options.skin!.coverage,
            };
          })),
      ...channels.map((channel) => {
        const value = values[channel] ?? 0.25;
        return {
          frame,
          channel,
          min: value,
          max: value,
          mean: value,
          p10: value,
          p50: value,
          p90: value,
          nearBlackRatio: 0,
          nearWhiteRatio: 0,
        };
      }),
    ]),
  };
}

describe('professional_color domain tool', () => {
  it('corrects the primary selected shot through the canonical grade node', () => {
    const base = project();
    const edited = dispatch(base, context(base), {
      intent: 'correct',
      adjustments: { exposure: 0.2, temperature: -0.1 },
    });
    expect(edited.tracks[0]!.clips[0]!.effects).toEqual([
      {
        id: 'color__shot_a__primary',
        type: 'color_grade',
        params: { exposure: 0.2, temperature: -0.1 },
        keyframes: [],
      },
    ]);
  });

  it('applies the same explicit correction across all selected shots', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'correct',
      target: 'these',
      adjustments: { contrast: 0.1 },
    });
    const interaction = context(base, ['shot_a', 'shot_b']).interaction!;
    expect(resolveColorObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'resolved',
      commands: [{ clipId: 'shot_a' }, { clipId: 'shot_b' }],
      facts: [
        { name: 'clipCount', value: 2 },
        { name: 'adjustmentCount', value: 1 },
      ],
    });
    const edited = dispatch(base, context(base, ['shot_a', 'shot_b']), objective);
    expect(edited.tracks[0]!.clips.map((clip) => clip.effects[0]?.params)).toEqual([
      { contrast: 0.1 },
      { contrast: 0.1 },
    ]);
  });

  it('rejects an absent selection for a plural referent', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'correct',
      target: 'these',
      adjustments: { exposure: 0.1 },
    });
    expect(
      resolveColorObjective({
        project: base,
        interaction: context(base, []).interaction!,
        objective,
      }),
    ).toMatchObject({ status: 'rejected', code: 'target_unresolved' });
  });

  it('schema-rejects empty, unknown, and out-of-range corrections', () => {
    expect(() => ColorObjectiveSchema.parse({ intent: 'correct', adjustments: {} })).toThrow();
    expect(() =>
      ColorObjectiveSchema.parse({ intent: 'correct', adjustments: { vibrance: 1 } }),
    ).toThrow();
    expect(() =>
      ColorObjectiveSchema.parse({ intent: 'correct', adjustments: { contrast: 2 } }),
    ).toThrow();
    expect(() =>
      ColorObjectiveSchema.parse({
        intent: 'match_reference',
        target: 'these',
        targetEvidenceId: 'target',
        referenceEvidenceId: 'reference',
      }),
    ).toThrow();
    expect(() =>
      ColorObjectiveSchema.parse({
        intent: 'match_reference',
        adjustments: { exposure: 1 },
        targetEvidenceId: 'target',
        referenceEvidenceId: 'reference',
      }),
    ).toThrow();
  });

  it('derives a conservative reference match only from trusted evidence handles', () => {
    const base = project();
    const evidence = new Map([
      [
        'ev_target',
        {
          source: 'measure_color',
          data: measurement('shot_a', {
            luma: 0.25,
            red: 0.2,
            green: 0.25,
            blue: 0.3,
            saturation: 0.1,
          }),
        },
      ],
      [
        'ev_reference',
        {
          source: 'measure_color',
          data: measurement('shot_b', {
            luma: 0.5,
            red: 0.3,
            green: 0.3,
            blue: 0.3,
            saturation: 0.15,
          }),
        },
      ],
    ]);
    const objective = parseColorObjective({
      intent: 'match_reference',
      targetEvidenceId: 'ev_target',
      referenceEvidenceId: 'ev_reference',
    });
    const result = resolveColorObjective({
      project: base,
      interaction: context(base).interaction!,
      objective,
      evidence: { byHandle: (id) => evidence.get(id) },
    });
    expect(result).toMatchObject({
      status: 'resolved',
      commands: [
        {
          clipId: 'shot_a',
          adjustments: {
            exposure: 1,
            saturation: 0.5,
          },
        },
      ],
    });
  });

  it('adds measured match deltas to the existing primary correction', () => {
    const initial = project();
    const base = {
      ...initial,
      timeline: dispatch(initial, context(initial), {
        intent: 'correct',
        adjustments: { exposure: 0.2, saturation: 0.1 },
      }),
    };
    const revision = base.timeline.revision ?? 0;
    const objective = parseColorObjective({
      intent: 'match_reference',
      targetEvidenceId: 'target',
      referenceEvidenceId: 'reference',
    });
    const result = resolveColorObjective({
      project: base,
      interaction: context(base).interaction!,
      objective,
      evidence: {
        byHandle: (id) => ({
          source: 'measure_color',
          data:
            id === 'target'
              ? measurement('shot_a', { luma: 0.25, saturation: 0.1 }, { revision })
              : measurement('shot_b', { luma: 0.5, saturation: 0.15 }, { revision }),
        }),
      },
    });
    expect(result).toMatchObject({
      status: 'resolved',
      commands: [{ adjustments: { exposure: 1.2, saturation: 0.6 } }],
    });
  });

  it('grades every shot from the same recording when asked to group them', () => {
    const base = project();
    // A third clip cut from the same camera file as shot_a, plus shot_b from another.
    const grouped: Project = {
      ...base,
      timeline: {
        ...base.timeline,
        tracks: [
          {
            ...base.timeline.tracks[0]!,
            clips: [
              ...base.timeline.tracks[0]!.clips,
              {
                ...base.timeline.tracks[0]!.clips[0]!,
                id: 'shot_a2',
                start: 10,
                end: 15,
              },
            ],
          },
        ],
      },
    };
    const edited = dispatch(grouped, context(grouped), {
      intent: 'correct',
      adjustments: { exposure: 0.3 },
      groupShots: true,
    });
    const graded = edited.tracks[0]!.clips.filter((clip) => clip.effects.length > 0);
    expect(graded.map((clip) => clip.id)).toEqual(['shot_a', 'shot_a2']);
    // The other camera is untouched: grouping follows the footage, not the look.
    expect(edited.tracks[0]!.clips.find((clip) => clip.id === 'shot_b')!.effects).toEqual([]);
  });

  it('holds skin tones inside tolerance while the rest of the match lands', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'match_reference',
      targetEvidenceId: 'target',
      referenceEvidenceId: 'reference',
      preserveSkin: true,
    });
    const resolve = (skinCoverage: number) =>
      resolveColorObjective({
        project: base,
        interaction: context(base).interaction!,
        objective,
        evidence: {
          byHandle: (id) => ({
            source: 'measure_color',
            data:
              id === 'target'
                ? measurement(
                    'shot_a',
                    { luma: 0.25, red: 0.3, green: 0.22, blue: 0.2 },
                    { skin: { rgb: [0.77, 0.56, 0.46], coverage: skinCoverage } },
                  )
                : // A markedly cooler reference: matching it means a big blue push.
                  measurement('shot_b', { luma: 0.25, red: 0.2, green: 0.22, blue: 0.34 }),
          }),
        },
      });

    const held = resolve(0.3);
    expect(held.status).toBe('resolved');
    if (held.status !== 'resolved') return;
    const facts = Object.fromEntries(held.facts.map((fact) => [fact.name, fact.value]));
    expect(facts.skinWhiteBalanceScale).toBeLessThan(1);
    // Held back, not cancelled — and exposure, which moves skin with everything
    // else, is untouched by the clamp.
    expect(facts.skinWhiteBalanceScale).toBeGreaterThan(0);
    expect(held.commands[0]!.adjustments.exposure).toBe(0);

    // Too little skin to read is a refusal, never a silent "no drift".
    expect(resolve(0.001)).toMatchObject({ status: 'rejected', code: 'skin_absent' });
  });

  it('refuses to protect skin from a measurement that never looked for it', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'match_reference',
      targetEvidenceId: 'target',
      referenceEvidenceId: 'reference',
      preserveSkin: true,
    });
    expect(
      resolveColorObjective({
        project: base,
        interaction: context(base).interaction!,
        objective,
        evidence: {
          byHandle: (id) => ({
            source: 'measure_color',
            data: measurement(id === 'target' ? 'shot_a' : 'shot_b', { luma: 0.25 }),
          }),
        },
      }),
    ).toMatchObject({ status: 'rejected', code: 'skin_unmeasured' });
  });

  it('rejects stale, wrong-source, and occluded color evidence', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'match_reference',
      targetEvidenceId: 'target',
      referenceEvidenceId: 'reference',
    });
    const resolveWith = (target: { source: string; data: unknown }) =>
      resolveColorObjective({
        project: base,
        interaction: context(base).interaction!,
        objective,
        evidence: {
          byHandle: (id) =>
            id === 'target' ? target : { source: 'measure_color', data: measurement('shot_b', {}) },
        },
      });
    expect(resolveWith({ source: 'get_frame', data: measurement('shot_a', {}) })).toMatchObject({
      code: 'evidence_invalid',
    });
    expect(
      resolveWith({ source: 'measure_color', data: measurement('shot_a', {}, { revision: 5 }) }),
    ).toMatchObject({ code: 'evidence_stale' });
    expect(
      resolveWith({
        source: 'measure_color',
        data: measurement('shot_a', {}, { occlusionFree: false }),
      }),
    ).toMatchObject({ code: 'measurement_occluded' });
  });

  it('carries host measurement handles into a real agent match operation', async () => {
    class Provider implements AiProvider {
      public readonly name = 'mock' as const;
      private turn = 0;
      public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
        const responses: AiResponse[] = [
          {
            text: '',
            toolCalls: [
              { id: 'm1', name: 'measure_color', arguments: { clipId: 'shot_a' } },
              { id: 'm2', name: 'measure_color', arguments: { clipId: 'shot_b' } },
            ],
          },
          {
            text: '',
            toolCalls: [
              {
                id: 'c1',
                name: 'professional_color',
                arguments: {
                  intent: 'match_reference',
                  targetEvidenceId: 'ev_1',
                  referenceEvidenceId: 'ev_2',
                },
              },
            ],
          },
          { text: 'Matched from measured evidence.', toolCalls: [] },
        ];
        return responses[Math.min(this.turn++, responses.length - 1)]!;
      }
    }
    const executor: HostToolExecutor = {
      run: async (toolCall) => ({
        status: 'completed',
        summary: `Measured ${String(toolCall.arguments.clipId)}`,
        data:
          toolCall.arguments.clipId === 'shot_a'
            ? measurement('shot_a', { luma: 0.25, saturation: 0.1 })
            : measurement('shot_b', { luma: 0.5, saturation: 0.15 }),
      }),
    };
    const base = project();
    const interaction = context(base).interaction!;
    const run = await new Orchestrator(new Provider(), { executor }).agent(
      { project: base, userPrompt: 'Match this shot to shot B', interaction },
      { maxSteps: 4 },
    );
    expect(run.result.patch.operations).toEqual([
      expect.objectContaining({
        type: 'apply_color_grade',
        clipId: 'shot_a',
        effect: expect.objectContaining({
          id: 'color__shot_a__primary',
          params: expect.objectContaining({ exposure: 1, saturation: 0.5 }),
        }),
      }),
    ]);
  });

  it('requires authoritative interaction state', () => {
    const base = project();
    expect(() =>
      operationsForCall(
        {
          id: 'color_call',
          name: 'professional_color',
          arguments: { intent: 'correct', adjustments: { exposure: 0.1 } },
        },
        { project: base },
      ),
    ).toThrow(/live editor interaction snapshot/);
  });

  it('is a host-only professional mutation surface', () => {
    expect(PROFESSIONAL_COLOR_TOOL).toMatchObject({
      kind: 'mutate',
      mutates: true,
      hostUiOnly: true,
      permissions: ['write'],
      capabilities: ['color', 'professional-editing'],
    });
  });
});
