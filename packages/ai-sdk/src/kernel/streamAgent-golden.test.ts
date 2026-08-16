/**
 * FROZEN GOLDEN for `Orchestrator.streamAgent` (K1.3 cutover gate,
 * plan/AI-ORCHESTRATION-REDESIGN.md §7).
 *
 * Before `streamAgent`'s monolithic loop is replaced by the Conductor + handlers, this
 * records its CURRENT event stream — the shipping behavior contract — as file snapshots
 * (`__snapshots__/streamAgent-golden.test.ts.snap`). Every run pins a fixed clock
 * (`now: () => 1000`), so the entire `AiEvent[]` is deterministic *including* `ts` and
 * ids — no normalization needed. After the cutover the SAME live `streamAgent` must
 * reproduce these byte-for-byte, or a snapshot diff pins the exact divergence.
 *
 * Coverage spans every path the cutover deletes, especially the ones easy to miss: the
 * try/catch throw path (provider throws → `error` + partial diff), the abort-races-a-
 * non-streaming-call → `cancelled` branch, and the `finally` settle (`reasoning` done +
 * terminal `status`) on every exit — normal, cancelled, and failed.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { HostToolExecutor } from '../tool-executor.js';
import type { AgentOptions } from '../agent.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import { makeProject } from '../__fixtures__/project.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const baseOpts = (signal?: AbortSignal): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
  ...(signal ? { signal } : {}),
});

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const r = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return r as AiResponse;
  }
}

/** Aborts its own controller during the model call (mid-turn user cancel). */
class AbortingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(
    private readonly controller: AbortController,
    private readonly response: AiResponse,
  ) {}
  public async complete(): Promise<AiResponse> {
    this.controller.abort();
    return this.response;
  }
}

/** Throws on every completion — the provider/network error path. */
class ThrowingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(private readonly value: unknown = new Error('network exploded')) {}
  public async complete(): Promise<AiResponse> {
    throw this.value;
  }
}

const del = (id: string, start: number, end: number) => ({
  id,
  name: 'delete_range',
  arguments: { trackId: 'video_1', start, end },
});
const turn = (...calls: ReturnType<typeof del>[]): AiResponse => ({ text: '', toolCalls: calls });
const done: AiResponse = { text: 'done', toolCalls: [] };

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

interface Build {
  provider: AiProvider;
  signal?: AbortSignal;
  executor?: HostToolExecutor;
}
interface Golden {
  name: string;
  build: () => Build;
  agentOptions?: AgentOptions;
  input?: ContextInput;
}

async function seedResumeOps(count: 1 | 2): Promise<unknown[]> {
  const script =
    count === 1
      ? [turn(del('c1', 0, 3)), done]
      : [turn(del('c1', 0, 2)), turn(del('c2', 3, 4)), done];
  const seed = await new Orchestrator(new ScriptedProvider(script)).agent(input, {});
  return seed.result.patch.operations as unknown[];
}

/** The scenario matrix — a superset of the parity harness plus the throw/abort paths. */
async function goldenScenarios(): Promise<Golden[]> {
  const twoOps = await seedResumeOps(2);
  const oneOp = await seedResumeOps(1);
  return [
    {
      name: 'multi-turn-applied',
      build: () => ({ provider: new ScriptedProvider([turn(del('c1', 0, 3)), done]) }),
    },
    {
      name: 'done-no-op',
      build: () => ({ provider: new ScriptedProvider([{ text: 'all done', toolCalls: [] }]) }),
    },
    {
      name: 'done-empty-text',
      build: () => ({ provider: new ScriptedProvider([{ text: '', toolCalls: [] }]) }),
    },
    {
      name: 'narrate-and-edit',
      build: () => ({
        provider: new ScriptedProvider([
          { text: 'Splitting the intro to tighten pacing', toolCalls: [del('c1', 0, 3)] },
          done,
        ]),
      }),
    },
    {
      name: 'per-turn-cap',
      build: () => ({
        provider: new ScriptedProvider([turn(del('a', 0, 2), del('b', 4, 5)), done]),
      }),
      agentOptions: { maxOpsPerTurn: 1 },
    },
    {
      name: 'per-run-cap',
      build: () => ({
        provider: new ScriptedProvider([turn(del('c1', 0, 3)), turn(del('c2', 4, 5))]),
      }),
      agentOptions: { maxOpsPerRun: 1 },
    },
    {
      name: 'spin-guard',
      build: () => ({
        provider: new ScriptedProvider([
          turn({ id: 'r', name: 'get_timeline', arguments: {} } as never),
        ]),
      }),
    },
    {
      name: 'cancel-pre-aborted',
      build: () => {
        const c = new AbortController();
        c.abort();
        return { provider: new ScriptedProvider([turn(del('c1', 0, 3))]), signal: c.signal };
      },
    },
    {
      name: 'cancel-mid-model-call',
      build: () => {
        const controller = new AbortController();
        return {
          provider: new AbortingProvider(controller, { text: 'partial', toolCalls: [] }),
          signal: controller.signal,
        };
      },
    },
    {
      name: 'cancel-mid-host-tool',
      build: () => {
        const controller = new AbortController();
        const executor: HostToolExecutor = {
          async run() {
            controller.abort();
            throw new Error('stopped');
          },
        };
        return {
          provider: new ScriptedProvider([
            { text: '', toolCalls: [{ id: 's', name: 'analyze_silence', arguments: {} }] },
          ]),
          signal: controller.signal,
          executor,
        };
      },
    },
    {
      name: 'planFirst',
      build: () => ({
        provider: new ScriptedProvider([
          { text: '1. Trim the intro\n2. Wrap up' },
          turn(del('c1', 0, 3)),
          done,
        ]),
      }),
      agentOptions: { planFirst: true },
    },
    {
      name: 'planFirst-empty-plan',
      build: () => ({
        provider: new ScriptedProvider([{ text: '' }, turn(del('c1', 0, 3)), done]),
      }),
      agentOptions: { planFirst: true },
    },
    {
      name: 'resume-two-edits',
      input: { project: makeProject(), userPrompt: '' },
      build: () => ({ provider: new ScriptedProvider([done]) }),
      agentOptions: {
        resume: {
          ops: twoOps as never,
          log: ['Step 1: Deleted', 'Step 2: Deleted'],
          stepsCompleted: 2,
        },
      },
    },
    {
      name: 'resume-one-edit',
      build: () => ({ provider: new ScriptedProvider([done]) }),
      agentOptions: {
        resume: { ops: oneOp as never, log: ['Step 1: Deleted'], stepsCompleted: 1 },
      },
    },
    {
      name: 'resume-stale-checkpoint',
      build: () => ({ provider: new ScriptedProvider([turn(del('c1', 0, 3)), done]) }),
      agentOptions: {
        resume: {
          ops: [{ type: 'delete_range', trackId: 'ghost', start: 0, end: 3 } as never],
          log: ['Step 1: stale'],
          stepsCompleted: 1,
        },
      },
    },
    {
      name: 'auto-repair',
      build: () => ({
        provider: new ScriptedProvider([turn(del('c1', 0, 3)), done, turn(del('c2', 0, 1))]),
      }),
      agentOptions: { durationTargetSeconds: 1 },
    },
    {
      name: 'empty-run',
      build: () => ({
        provider: new ScriptedProvider([
          {
            text: '',
            toolCalls: [
              { id: '1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 8 } },
            ],
          },
          done,
        ]),
      }),
    },
    {
      // B2.3: a turn that routes "find where I said X" through the search_media
      // host tool — pins the id-preserving hit digest fed back to the model.
      name: 'search-then-edit',
      build: () => {
        const executor: HostToolExecutor = {
          async run(call) {
            if (call.name !== 'search_media') {
              return { status: 'failed', summary: 'unexpected tool' };
            }
            return {
              status: 'completed',
              summary: 'Found 1 match',
              data: {
                hits: [
                  {
                    type: 'transcript',
                    start: 5,
                    end: 5.9,
                    snippet: '[budget] review',
                    score: 1.2,
                  },
                ],
              },
            };
          },
        };
        return {
          provider: new ScriptedProvider([
            {
              text: '',
              toolCalls: [{ id: 'q', name: 'search_media', arguments: { query: 'budget' } }],
            },
            turn(del('c1', 0, 3)),
            done,
          ]),
          executor,
        };
      },
    },
    // --- the try/catch/finally paths the cutover must reproduce ---
    {
      name: 'throw-provider-error',
      build: () => ({ provider: new ThrowingProvider(new Error('network exploded')) }),
    },
    {
      name: 'throw-non-error-value',
      build: () => ({ provider: new ThrowingProvider('not-an-error-object') }),
    },
    {
      name: 'abort-races-plan-call',
      build: () => {
        const controller = new AbortController();
        // The up-front plan `complete()` rejects because Stop aborts it mid-flight.
        const provider: AiProvider = {
          name: 'mock',
          complete: (_r: AiCompletionRequest, signal?: AbortSignal) =>
            new Promise<AiResponse>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  const err = new Error('The operation was aborted');
                  err.name = 'AbortError';
                  reject(err);
                },
                { once: true },
              );
              controller.abort();
            }),
        };
        return { provider, signal: controller.signal };
      },
      agentOptions: { planFirst: true },
    },
  ];
}

async function runStreamAgent(g: Golden): Promise<AiEvent[]> {
  const { provider, signal, executor } = g.build();
  return drain(
    new Orchestrator(provider, executor ? { executor } : {}).streamAgent(
      g.input ?? input,
      baseOpts(signal),
      g.agentOptions ?? {},
    ),
  );
}

describe('streamAgent frozen golden (K1.3 cutover gate)', () => {
  it('records the current streamAgent event stream for every scenario', async () => {
    const scenarios = await goldenScenarios();
    const golden: Record<string, AiEvent[]> = {};
    for (const s of scenarios) golden[s.name] = await runStreamAgent(s);
    expect(golden).toMatchSnapshot();
  });

  it('stamps every per-turn diff of one run with a single shared runId (B5.3)', async () => {
    const scenarios = await goldenScenarios();
    for (const s of scenarios) {
      const events = await runStreamAgent(s);
      const turnDiffRunIds = events
        .filter((e): e is Extract<AiEvent, { type: 'diff' }> => e.type === 'diff')
        .filter((e) => e.scope === 'turn')
        .map((e) => e.runId);
      // Every turn-scoped diff carries a runId, and all of a run's turns share ONE —
      // that shared id is what lets a host collapse the burst into a single undo step.
      if (turnDiffRunIds.length > 0) {
        expect(turnDiffRunIds.every((id) => id !== undefined)).toBe(true);
        expect(new Set(turnDiffRunIds).size).toBe(1);
      }
    }
  });
});
