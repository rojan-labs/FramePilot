/**
 * AL29 — the colour-evidence lifecycle, end to end through the agent loop.
 *
 * Harness run 11 (a real Opus 5.5 edit on the desktop host path) measured ten clips with
 * `measure_color` at timeline revision 40, and one step later:
 *
 * - `normalize_exposure` and `apply_look` said "nothing has measured" all ten;
 * - `professional_color` answered `evidence_missing: No color evidence exists for handle
 *   "ev_12"` for handles the run itself had handed out;
 * - the `normalize_exposure` receipt read "Applied color grade passenger.mp4" three times
 *   for three different clips.
 *
 * Two host facts the older tests did not reproduce, and both are set here on purpose:
 *
 * 1. The desktop passes its HOST AUTHORITY revision as `projectRevision` (7 below), a
 *    different clock from `project.timeline.revision` (40), which is what `measure_color`
 *    stamps on its reading. The solved colour tools compared the reading against the first.
 * 2. A grade does not bump `timeline.revision` (only mapping changes do), so what retires a
 *    colour reading after a grade is the run's evidence store — and a reading it retired has
 *    to be named as retired, not as never having existed.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ColorMeasurement } from '../color-evidence.js';
import { resolveColorObjective, parseColorObjective } from '../controllers/color-controller.js';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import { Orchestrator, summarizeOperations } from '../orchestrator.js';
import { projectNames } from '../names.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from '../providers/types.js';
import type { HostToolExecutor } from '../tool-executor.js';

/** The revision `measure_color` reads off the working project — the timeline's own clock. */
const TIMELINE_REVISION = 40;
/** The desktop's host authority revision — a DIFFERENT counter (`projectCommands.revision`). */
const HOST_REVISION = 7;

function project(): Project {
  return parseProject({
    id: 'color_lifecycle',
    name: 'Colour evidence lifecycle fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a', path: 'driver.mp4', kind: 'video', durationSeconds: 10 },
      { id: 'b', path: 'window.mp4', kind: 'video', durationSeconds: 10 },
      { id: 'c', path: 'passenger.mp4', kind: 'video', durationSeconds: 20 },
    ],
    timeline: {
      revision: TIMELINE_REVISION,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            { id: 'shot_a', assetId: 'a', start: 0, end: 2 },
            { id: 'shot_b', assetId: 'b', start: 2, end: 4 },
            { id: 'shot_c', assetId: 'c', start: 4, end: 6, sourceStart: 0 },
            { id: 'shot_c2', assetId: 'c', start: 6, end: 8, sourceStart: 10 },
          ].map((clip) => ({
            trackId: 'v1',
            sourceStart: 0,
            sourceEnd: 2,
            effects: [],
            keyframes: [],
            ...clip,
            ...(clip.sourceStart === undefined ? {} : { sourceEnd: clip.sourceStart + 2 }),
          })),
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/** Luma per clip: `shot_c`/`shot_c2` are a stop and a bit under the other two. */
const LUMA: Readonly<Record<string, number>> = {
  shot_a: 0.5,
  shot_b: 0.5,
  shot_c: 0.2,
  shot_c2: 0.2,
};

/** A `measure_color` payload exactly as the sidecar executor stores it. */
function measurement(clipId: string): ColorMeasurement {
  const luma = LUMA[clipId] ?? 0.4;
  const channels = ['luma', 'red', 'green', 'blue', 'saturation'] as const;
  const index = Object.keys(LUMA).indexOf(clipId);
  return {
    schemaVersion: 1,
    projectRevision: TIMELINE_REVISION,
    clipId,
    trackId: 'v1',
    startFrame: index * 60,
    endFrame: index * 60 + 30,
    isolation: 'timeline_composite',
    occlusionFree: true,
    renderSettingsIdentity: 'temporal-scope:1920x1080@30:captions=false',
    samples: [0, 1, 2].flatMap((frame) =>
      channels.map((channel) => {
        const value = channel === 'saturation' ? 0.2 : luma;
        return {
          frame: index * 60 + frame,
          channel,
          min: 0,
          max: 1,
          mean: value,
          p10: value * 0.5,
          p50: value,
          p90: Math.min(1, value * 1.5),
          nearBlackRatio: 0,
          nearWhiteRatio: 0,
        };
      }),
    ),
  };
}

/** Replays one response per model turn. */
class Scripted implements AiProvider {
  public readonly name = 'mock' as const;
  private turn = 0;
  public constructor(private readonly turns: readonly AiResponse[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    return this.turns[Math.min(this.turn++, this.turns.length - 1)]!;
  }
}

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `call_${String(callSeq)}`, name, arguments: args };
}

const measureAll = (clipIds: readonly string[]): AiResponse => ({
  text: 'Measuring the shots first.',
  toolCalls: clipIds.map((clipId) => call('measure_color', { clipId })),
});

const executor: HostToolExecutor = {
  run: async (toolCall) => ({
    status: 'completed',
    summary: `Measured color on ${String(toolCall.arguments.clipId)}`,
    data: measurement(String(toolCall.arguments.clipId)),
  }),
};

/** Run the script the way the desktop does: host revision ≠ timeline revision. */
async function runOnDesktopClocks(turns: readonly AiResponse[]) {
  const base = project();
  return new Orchestrator(new Scripted([...turns, { text: 'Done.', toolCalls: [] }]), {
    executor,
  }).agent(
    {
      project: base,
      projectRevision: HOST_REVISION,
      userPrompt: 'Grade the road shots so they sit together',
      interaction: captureEditorInteractionContext({
        project: base,
        projectRevision: HOST_REVISION,
        playheadSeconds: 1,
        selectedClipIds: ['shot_a'],
        primaryClipId: 'shot_a',
      }),
    },
    { maxSteps: turns.length + 2 },
  );
}

const gradedClipIds = (operations: readonly unknown[]): string[] =>
  operations
    .filter((op) => (op as { type: string }).type === 'apply_color_grade')
    .map((op) => (op as { clipId: string }).clipId);

describe('a measure_color reading on the desktop clocks', () => {
  it('is what apply_look solves from one step later', async () => {
    const run = await runOnDesktopClocks([
      measureAll(['shot_a', 'shot_b', 'shot_c']),
      {
        text: 'Warming them.',
        toolCalls: [
          call('apply_look', {
            clipIds: ['shot_a', 'shot_b', 'shot_c'],
            look: 'warmer',
            amount: 'subtle',
          }),
        ],
      },
    ]);
    const lookStep = run.steps[1]!;
    expect(lookStep.note).not.toContain('nothing has measured');
    expect(gradedClipIds(run.result.patch.operations).sort()).toEqual([
      'shot_a',
      'shot_b',
      'shot_c',
    ]);
  });

  it('is what normalize_exposure anchors on, and match_color solves from', async () => {
    const run = await runOnDesktopClocks([
      measureAll(['shot_a', 'shot_b', 'shot_c']),
      {
        text: 'Evening out exposure.',
        toolCalls: [call('normalize_exposure', { trackId: 'v1' })],
      },
    ]);
    const note = run.steps[1]!.note;
    // shot_c2 was never measured and is the only clip that may be called unmeasured.
    expect(note).toContain('nothing has measured "shot_c2"');
    expect(note).not.toMatch(/nothing has measured "shot_[abc]"/);
    // shot_c sits a stop and a bit under the median of the three it measured.
    expect(gradedClipIds(run.result.patch.operations)).toEqual(['shot_c']);
  });
});

describe('a reading an edit has since retired', () => {
  it('is named as out of date by the solved colour tools, with the edit that retired it', async () => {
    const run = await runOnDesktopClocks([
      measureAll(['shot_a', 'shot_b', 'shot_c']),
      {
        text: 'Evening out exposure, then a warmer look on the two good shots.',
        toolCalls: [
          call('normalize_exposure', { trackId: 'v1' }),
          call('apply_look', { clipIds: ['shot_a', 'shot_b'], look: 'warmer', amount: 'subtle' }),
          call('match_color', { referenceClipId: 'shot_a', targetClipIds: ['shot_b'] }),
        ],
      },
    ]);
    const note = run.steps[1]!.note;
    // The grade normalize_exposure landed retires every colour reading of the run.
    expect(gradedClipIds(run.result.patch.operations)).toEqual(['shot_c']);
    // …and the tools that ran after it in the same step say THAT, not "never measured".
    expect(note).toMatch(
      /"shot_a", "shot_b" were measured before normalize_exposure changed the picture/,
    );
    expect(note).toContain('match_color: "shot_a" was measured before normalize_exposure');
    expect(note).not.toMatch(/nothing has measured "shot_[ab]"/);
  });

  it('is refused by professional_color as stale, naming the edit and the remedy', async () => {
    const run = await runOnDesktopClocks([
      measureAll(['shot_a', 'shot_b']),
      {
        text: 'A hand grade on the passenger shot.',
        toolCalls: [call('apply_color_grade', { clipId: 'shot_c', params: { exposure: 0.3 } })],
      },
      {
        text: 'Match the driver shot to the window shot.',
        toolCalls: [
          call('professional_color', {
            intent: 'match_reference',
            targetEvidenceId: 'ev_1',
            referenceEvidenceId: 'ev_2',
          }),
        ],
      },
    ]);
    const note = run.steps[2]!.note;
    expect(note).not.toContain('No color evidence exists');
    expect(note).toContain('evidence_stale');
    expect(note).toContain('apply_color_grade changed the timeline after it was measured');
    expect(note).toContain('call measure_color on "shot_a" again');
  });

  it('resolves once it is measured again', async () => {
    const run = await runOnDesktopClocks([
      measureAll(['shot_a', 'shot_b']),
      {
        text: 'A hand grade on the passenger shot.',
        toolCalls: [call('apply_color_grade', { clipId: 'shot_c', params: { exposure: 0.3 } })],
      },
      measureAll(['shot_a', 'shot_b']),
      {
        text: 'Match the driver shot to the window shot.',
        toolCalls: [call('match_color', { referenceClipId: 'shot_b', targetClipIds: ['shot_a'] })],
      },
    ]);
    const note = run.steps[3]!.note;
    expect(note).not.toMatch(/measured before|nothing has measured/);
    // Both shots read the same, so the fresh readings answer "already matches".
    expect(note).toContain('shot_a: it already measures the same as the reference');
  });
});

describe('the colour controller, given a handle the run retired', () => {
  it('answers evidence_stale with the reason, and evidence_missing only for an unknown id', () => {
    const base = project();
    const objective = parseColorObjective({
      intent: 'match_reference',
      clipIds: ['shot_a'],
      targetEvidenceId: 'ev_1',
      referenceEvidenceId: 'ev_2',
    });
    const interaction = captureEditorInteractionContext({
      project: base,
      projectRevision: HOST_REVISION,
      playheadSeconds: 1,
      selectedClipIds: ['shot_a'],
      primaryClipId: 'shot_a',
    });
    const reader = {
      byHandle: () => undefined,
      expiredHandle: (id: string) =>
        id === 'ev_1'
          ? {
              id,
              source: 'measure_color',
              descriptor: 'Measure color driver.mp4',
              clipId: 'shot_a',
              staledBy: 'normalize_exposure',
            }
          : undefined,
    };
    const stale = resolveColorObjective({
      project: base,
      projectRevision: HOST_REVISION,
      interaction,
      objective,
      evidence: reader,
    });
    expect(stale).toMatchObject({ status: 'rejected', code: 'evidence_stale' });
    expect(stale.status === 'rejected' ? stale.detail : '').toContain(
      'normalize_exposure changed the timeline after it was measured',
    );

    const invented = resolveColorObjective({
      project: base,
      projectRevision: HOST_REVISION,
      interaction,
      objective: parseColorObjective({
        intent: 'match_reference',
        clipIds: ['shot_a'],
        targetEvidenceId: 'ev_99',
        referenceEvidenceId: 'ev_2',
      }),
      evidence: reader,
    });
    expect(invented).toMatchObject({ status: 'rejected', code: 'evidence_missing' });
  });
});

describe('the receipt of a grade across clips cut from one file', () => {
  it('says how many clips it graded instead of repeating one file name', () => {
    const names = projectNames(project());
    const grade = (clipId: string) => ({
      type: 'apply_color_grade' as const,
      clipId,
      effect: {
        id: `color__${clipId}__primary`,
        type: 'color_grade' as const,
        params: { exposure: 0.5 },
        keyframes: [],
      },
    });
    const receipt = summarizeOperations(
      [grade('shot_c'), grade('shot_c2'), grade('shot_a')],
      names,
    );
    expect(receipt).toBe(
      'Applied color grade passenger.mp4 (2 clips); Applied color grade driver.mp4',
    );
  });

  it('still lists two edits to ONE clip as two lines', () => {
    const names = projectNames(project());
    const grade = {
      type: 'apply_color_grade' as const,
      clipId: 'shot_c',
      effect: { id: 'g', type: 'color_grade' as const, params: {}, keyframes: [] },
    };
    expect(summarizeOperations([grade, grade], names)).toBe(
      'Applied color grade passenger.mp4; Applied color grade passenger.mp4',
    );
  });
});
