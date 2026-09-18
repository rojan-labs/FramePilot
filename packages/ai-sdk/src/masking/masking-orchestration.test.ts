/**
 * The masking tools through the real orchestrator: a host measurement becomes a validated,
 * reversible patch, the result reports what needs a look, and nothing the host or the model
 * sends can turn into a mask that was not measured.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import {
  Orchestrator,
  evidencePayload,
  type StreamOptions,
  type VisionRunReviewControls,
} from '../orchestrator.js';
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

  it('refuses a candidate the editor has not picked BEFORE any pack job runs, and admits it once they have', async () => {
    const pick = `pick.${FACE.candidateId}`;
    const args = { ...createArgs, candidateId: pick };
    let hostCalls = 0;
    const counting: HostToolExecutor = {
      run: async () => {
        hostCalls += 1;
        return {
          status: 'completed',
          summary: 'Fitted the face.',
          data: {
            kind: 'create_mask',
            precision: 'shape',
            clipId: 'shot',
            candidate: { ...FACE, candidateId: pick },
          },
        };
      },
    };
    const guessed = await run([call('create_mask', args), done], counting, 'hide the face');
    expect(statusOf(guessed)).toBe('failed');
    expect(results(guessed)[0]?.summary).toContain('the editor has to choose');
    expect(hostCalls).toBe(0);
    const picked = await run(
      [call('create_mask', args), done],
      counting,
      `Use ${pick} for "the face" on clip shot.`,
    );
    expect(statusOf(picked)).toBe('completed');
    expect(hostCalls).toBe(1);
  });

  it('remembers the editor’s pick from an earlier message of the conversation', async () => {
    const pick = `pick.${FACE.candidateId}`;
    const executor = host({
      status: 'completed',
      summary: 'Fitted.',
      data: {
        kind: 'create_mask',
        precision: 'shape',
        clipId: 'shot',
        candidate: { ...FACE, candidateId: pick },
      },
    });
    const events: AiEvent[] = [];
    const input: ContextInput = {
      project: project(),
      userPrompt: 'now make it softer too',
      history: [
        { role: 'user', content: `Use ${pick} on clip shot.` },
        { role: 'assistant', content: 'On it.' },
      ],
    };
    for await (const event of new Orchestrator(
      new ScriptedProvider([call('create_mask', { ...createArgs, candidateId: pick }), done]),
      { executor },
    ).streamAgent(input, opts(), {}))
      events.push(event);
    expect(statusOf(events)).toBe('completed');
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

describe('what the run can recall about its targets', () => {
  it('stores ids and scores for recall_evidence, and never a box', () => {
    const stored = evidencePayload('find_mask_targets', {
      kind: 'mask_targets',
      clipId: 'shot',
      description: 'her face',
      status: 'resolved',
      candidates: [FACE],
      chosenCandidateIds: [FACE.candidateId],
      reranker: 'none',
      engine: 'framepilot.subject-intelligence@1.0.0',
    });
    expect(JSON.stringify(stored)).toContain(FACE.candidateId);
    expect(JSON.stringify(stored)).not.toContain('box');
  });
});

describe('the visual spot check (AM3.2)', () => {
  const sha = (c: string): string => c.repeat(64);
  /** A face the detector was only fairly sure of: the numbers leave the question open. */
  const UNSURE_FACE = { ...FACE, score: 0.6 };
  const measured = (
    candidate: typeof FACE,
    needsReview: { start: number; end: number }[] = [],
  ): HostToolExecutor =>
    host({
      status: 'completed',
      summary: 'Cut out the face.',
      data: {
        kind: 'create_mask',
        precision: 'cutout',
        clipId: 'shot',
        candidate,
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
        needsReview,
        verifiedFrames: 90,
        flaggedFrames: needsReview.length,
      },
    });
  const args = {
    clipId: 'shot',
    candidateId: FACE.candidateId,
    precision: 'cutout',
    purpose: 'cutout',
  };

  function vision(
    verdict: 'pass' | 'fail' | 'cannot_tell',
  ): VisionRunReviewControls & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      acquire: async (_project, request) =>
        request.frames.map((frame) => ({
          frame,
          imageBase64: 'AAAA',
          mediaType: 'image/jpeg' as const,
        })),
      judge: async ({ objective }) => {
        asked.push(objective);
        return { verdict, reason: 'The kept region is the man on the right.' };
      },
      reviewer: {
        transport: 'local_pack',
        provider: 'framepilot',
        model: 'smolvlm2',
        promptVersion: 'v1',
        packVersion: '1.0.0',
      },
    };
  }

  async function runWith(
    executor: HostToolExecutor,
    review: VisionRunReviewControls | undefined,
    prompt = 'cut out her face',
  ): Promise<AiEvent[]> {
    const events: AiEvent[] = [];
    const provider = new ScriptedProvider([call('create_mask', args), done]);
    const stream = new Orchestrator(provider, { executor }).streamAgent(
      { project: project(), userPrompt: prompt },
      opts(),
      {},
      {},
      undefined,
      review === undefined ? {} : { visionReview: review },
    );
    for await (const event of stream) events.push(event);
    return events;
  }

  const diffOf = (events: readonly AiEvent[]) =>
    events.find((e): e is Extract<AiEvent, { type: 'diff' }> => e.type === 'diff');

  it('yes: the mask lands and the result records a second opinion, never a verification', async () => {
    const review = vision('pass');
    const events = await runWith(measured(UNSURE_FACE), review);
    expect(statusOf(events)).toBe('completed');
    expect(review.asked).toHaveLength(1);
    expect(review.asked[0]).toContain('Is the masked region the face?');
    expect(results(events)[0]?.result).toMatchObject({
      spotCheck: { verdict: 'yes' },
      flaggedCount: 0,
    });
    expect(JSON.stringify(results(events)[0]?.result)).not.toMatch(/"verified"\s*:\s*true/);
  });

  it('no: the mask is never applied, and the model is told to re-resolve or ask', async () => {
    const events = await runWith(measured(UNSURE_FACE), vision('fail'));
    expect(statusOf(events)).toBe('failed');
    expect(diffOf(events)).toBeUndefined();
    const summary = results(events)[0]?.summary ?? '';
    expect(summary).toContain('not the face');
    expect(summary).toContain('find_mask_targets again');
    expect(summary).toContain('ask the editor');
  });

  it('unsure: the mask lands and the frames looked at go on its review list', async () => {
    const events = await runWith(measured(UNSURE_FACE), vision('cannot_tell'));
    expect(statusOf(events)).toBe('completed');
    const operations = diffOf(events)?.edit.patch.operations ?? [];
    expect(operations.map((operation) => operation.type)).toContain('review_mask');
    const result = results(events)[0]?.result as {
      flaggedCount: number;
      spotCheck: { verdict: string };
    };
    expect(result.spotCheck.verdict).toBe('unsure');
    expect(result.flaggedCount).toBeGreaterThan(0);
  });

  it('does not look when the numbers already decided, or when the editor chose', async () => {
    const confident = vision('fail');
    expect(statusOf(await runWith(measured(FACE), confident))).toBe('completed');
    expect(confident.asked).toEqual([]);

    const pick = `pick.${FACE.candidateId}`;
    const chosen = vision('fail');
    const events: AiEvent[] = [];
    const provider = new ScriptedProvider([
      call('create_mask', { ...args, candidateId: pick }),
      done,
    ]);
    const stream = new Orchestrator(provider, {
      executor: measured({ ...UNSURE_FACE, candidateId: pick }),
    }).streamAgent(
      { project: project(), userPrompt: `Use ${pick} on clip shot.` },
      opts(),
      {},
      {},
      undefined,
      { visionReview: chosen },
    );
    for await (const event of stream) events.push(event);
    expect(statusOf(events)).toBe('completed');
    expect(chosen.asked).toEqual([]);
  });

  it('looks when the pack flagged something, however confident the detector was', async () => {
    const review = vision('pass');
    const events = await runWith(measured(FACE, [{ start: 1, end: 1.5 }]), review);
    expect(review.asked).toHaveLength(1);
    expect(results(events)[0]?.result).toMatchObject({
      flaggedCount: 1,
      frames: { passedChecks: 90, flagged: 1 },
    });
  });

  it('without a reviewer the deterministic report stands on its own', async () => {
    const events = await runWith(measured(UNSURE_FACE), undefined);
    expect(statusOf(events)).toBe('completed');
    expect(results(events)[0]?.result).toMatchObject({
      spotCheck: { verdict: 'not_run' },
      validator: { valid: true },
    });
  });
});
