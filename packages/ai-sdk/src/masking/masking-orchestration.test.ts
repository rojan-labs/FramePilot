/**
 * The masking tools through the real orchestrator: a host measurement becomes a validated,
 * reversible patch, the result reports what needs a look, and nothing the host or the model
 * sends can turn into a mask that was not measured.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from '../tool-executor.js';

const project = (): Project =>
  parseProject({
    id: 'masking_run',
    name: 'Masking run',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'shot.mp4',
        kind: 'video',
        durationSeconds: 60,
        media: { width: 1920, height: 1080 },
      },
    ],
    timeline: {
      revision: 2,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
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

const FACE = {
  candidateId: 'f24_ab12cd34',
  label: 'face',
  score: 0.9,
  box: { x: 0.4, y: 0.2, width: 0.1, height: 0.2 },
  sourceTime: 1,
  persistence: 1,
} as const;

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private index = 0;
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)]!;
    this.index += 1;
    return response;
  }
}

const opts = (): StreamOptions => ({ conversationId: 'c', turnId: 't', now: () => 1000 });
const done: AiResponse = { text: 'done', toolCalls: [] };
const call = (name: string, args: Record<string, unknown>): AiResponse => ({
  text: '',
  toolCalls: [{ id: `${name}_1`, name, arguments: args }],
});
const host = (outcome: HostToolOutcome): HostToolExecutor => ({ run: async () => outcome });

async function run(
  responses: AiResponse[],
  executor: HostToolExecutor,
  userPrompt = 'hide her face',
): Promise<AiEvent[]> {
  const input: ContextInput = { project: project(), userPrompt };
  const events: AiEvent[] = [];
  for await (const event of new Orchestrator(new ScriptedProvider(responses), {
    executor,
  }).streamAgent(input, opts(), {})) {
    events.push(event);
  }
  return events;
}

const results = (events: readonly AiEvent[]): Extract<AiEvent, { type: 'tool_result' }>[] =>
  events.filter((e): e is Extract<AiEvent, { type: 'tool_result' }> => e.type === 'tool_result');

/** The settled status of the run's (single) tool call. */
const statusOf = (events: readonly AiEvent[]): string | undefined =>
  events.filter((e): e is Extract<AiEvent, { type: 'tool_call' }> => e.type === 'tool_call').at(-1)
    ?.status;

const createArgs = {
  clipId: 'shot',
  candidateId: FACE.candidateId,
  precision: 'shape',
  purpose: 'hide',
  edge: 'soft',
  track: false,
};

describe('create_mask through the orchestrator', () => {
  it('lands a measured mask as a patch and reports the review state without claiming verified', async () => {
    const events = await run(
      [call('create_mask', createArgs), done],
      host({
        status: 'completed',
        summary: 'Fitted the face.',
        data: { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      }),
    );
    const [result] = results(events);
    expect(statusOf(events)).toBe('completed');
    expect(result?.result).toMatchObject({
      kind: 'mask_review',
      flaggedCount: 0,
      validator: { valid: true, issues: [] },
    });
    const diff = events.find((e): e is Extract<AiEvent, { type: 'diff' }> => e.type === 'diff');
    expect(diff?.edit.patch.operations.map((operation) => operation.type)).toEqual([
      'add_mask',
      'update_mask',
    ]);
    expect(diff?.edit.patch.createdBy).toBe('agent');
    expect(diff?.edit.validation.valid).toBe(true);
  });

  it('tells the model how many moments need a look, in words that forbid "verified"', async () => {
    const provider = new ScriptedProvider([call('remove_background', { clipId: 'shot' }), done]);
    const sha = (c: string): string => c.repeat(64);
    const executor = host({
      status: 'completed',
      summary: 'Removed the background.',
      data: {
        kind: 'create_mask',
        precision: 'cutout',
        clipId: 'shot',
        artifact: {
          key: sha('a'),
          files: [{ name: 'matte.mkv', sha256: sha('b') }],
          width: 1920,
          height: 1080,
          coverage: { sourceStart: 0, sourceEnd: 5 },
          packId: 'framepilot.smart-mask',
          packVersion: '1.0.0',
          modelDigests: [],
        },
        needsReview: [
          { start: 1, end: 1.5 },
          { start: 3, end: 3.2 },
        ],
        verifiedFrames: 80,
        flaggedFrames: 16,
      },
    });
    for await (const _ of new Orchestrator(provider, { executor }).streamAgent(
      { project: project(), userPrompt: 'remove the background' },
      opts(),
      {},
    ))
      void _;
    const seen = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
    expect(seen).toContain('2 moments need a look in the Inspector review list');
    expect(seen).toContain('do not call the mask verified');
  });

  it('refuses a payload it cannot read, without an edit', async () => {
    const events = await run(
      [call('create_mask', createArgs), done],
      host({
        status: 'completed',
        summary: 'ok',
        data: {
          kind: 'create_mask',
          precision: 'shape',
          clipId: 'shot',
          candidate: { ...FACE, box: 'everywhere' },
        },
      }),
    );
    const [result] = results(events);
    expect(statusOf(events)).toBe('failed');
    expect(result?.summary).toContain('could not read');
    expect(events.some((e) => e.type === 'diff')).toBe(false);
  });

  it('refuses typed numbers the editor never typed, and admits the ones they did', async () => {
    const userShape = { shape: 'rectangle', x: 0.2, y: 0.1, width: 0.5, height: 0.25 };
    const args = { clipId: 'shot', userShape, precision: 'shape', purpose: 'cutout' };
    const measured = host({
      status: 'completed',
      summary: 'Drew the shape.',
      data: { kind: 'create_mask', precision: 'shape', clipId: 'shot' },
    });
    const invented = await run([call('create_mask', args), done], measured, 'mask the sign');
    expect(statusOf(invented)).toBe('failed');
    expect(results(invented)[0]?.summary).toContain('only for numbers the editor typed');
    const typed = await run(
      [call('create_mask', args), done],
      measured,
      'mask a box 20% from the left, 10% down, 50% wide and 25% tall',
    );
    expect(statusOf(typed)).toBe('completed');
  });

  it('keeps a pack_missing failure a failure, carrying the proposal for the install card', async () => {
    const proposal = { ok: true, proposal: { proposalId: 'p1', displayName: 'Smart Mask' } };
    const events = await run(
      [call('remove_background', { clipId: 'shot' }), done],
      host({
        status: 'failed',
        summary: '"remove_background" needs a Capability Pack that is not installed.',
        data: { code: 'pack_missing', proposal },
      }),
    );
    const [result] = results(events);
    expect(statusOf(events)).toBe('failed');
    expect(result?.result).toEqual({ code: 'pack_missing', proposal });
    expect(events.some((e) => e.type === 'diff')).toBe(false);
  });
});
