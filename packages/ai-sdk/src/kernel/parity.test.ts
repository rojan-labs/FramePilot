/**
 * Event-stream PARITY harness (plan/AI-ORCHESTRATION-REDESIGN.md §7, line 838).
 *
 * Drive BOTH `Orchestrator.streamAgent` AND the direct kernel seam (`runAgentGraph` +
 * the public `Orchestrator.agentConductorHandlers`) over the SAME inputs with a
 * deterministic provider, and assert the emitted `AiEvent[]` are **byte-for-byte
 * identical** — same types, same ids, same fields, in the same order.
 *
 * Post K1.3 cutover `streamAgent` IS the orchestration-graph path (it delegates to
 * `runAgentGraph` — `runConductor` was deleted at M12 — wrapped in a throw-settling
 * generator), so this now guards that the direct handlers
 * seam — the entry point K6.1's MCP / Electron-main surfaces will drive — stays
 * behavior-equivalent to the shipping `streamAgent` wrapper. The byte gate against the
 * pre-cutover output lives in `streamAgent-golden.test.ts`. If a scenario diverges, this
 * pins the exact failing assertion so the split can be corrected rather than worked around.
 *
 * The provider is stateful (scripted per `complete()`), and the cancel scenario shares
 * an `AbortController` with its provider, so each path is built from a FRESH `build()`
 * — a new provider + signal that neither path has advanced. The Conductor is wired to
 * the orchestrator's shared turn mechanics (`streamAssistant`/`executeToolCalls`/
 * `applyAgentTurn`/`attemptRepair`/`critique`/`assembleEdit`), so any divergence is a
 * control-flow bug, not a mechanics bug.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { HostToolExecutor } from '../tool-executor.js';
import type { AgentOptions } from '../agent.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import { makeProject } from '../__fixtures__/project.js';
import type { Command } from './commands.js';
import { runAgentGraph } from './agent-graph.js';
import { DIMINISHING_RETURNS_TURNS } from './conductor.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const baseOpts = (signal?: AbortSignal): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
  ...(signal ? { signal } : {}),
});

/** A complete()-only provider that replays a queued script (repeats the last). */
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

/** Aborts the shared controller during the model call (mid-turn user cancel). */
class AbortingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(
    private readonly controller: AbortController,
    private readonly response: AiResponse,
  ) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.controller.abort();
    return this.response;
  }
}

const del = (id: string, start: number, end: number) => ({
  id,
  name: 'delete_range',
  arguments: { trackId: 'video_1', start, end },
});

/** A model turn that emits the given tool calls (no narration). */
const turn = (...calls: ReturnType<typeof del>[]): AiResponse => ({ text: '', toolCalls: calls });
/** A terminal model turn that calls no tools (the agent is done). */
const done: AiResponse = { text: 'done', toolCalls: [] };

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** A fresh run's provider + signal (both un-advanced) plus the run bounds. */
interface Build {
  provider: AiProvider;
  signal?: AbortSignal;
  executor?: HostToolExecutor;
}
interface Scenario {
  build: () => Build;
  agentOptions?: AgentOptions;
  /** Override the run input (e.g. an empty prompt exercising the default reasons). */
  input?: ContextInput;
}

async function streamPath(s: Scenario): Promise<AiEvent[]> {
  const { provider, signal, executor } = s.build();
  return drain(
    new Orchestrator(provider, executor ? { executor } : {}).streamAgent(
      s.input ?? input,
      baseOpts(signal),
      s.agentOptions ?? {},
    ),
  );
}

async function kernelPath(s: Scenario): Promise<AiEvent[]> {
  const { provider, signal, executor } = s.build();
  const run = s.input ?? input;
  const opts = baseOpts(signal);
  const orch = new Orchestrator(provider, executor ? { executor } : {});
  const command: Command = {
    kind: 'submit_turn',
    mode: 'agent',
    input: run,
    stream: opts,
    ...(s.agentOptions ? { agentOptions: s.agentOptions } : {}),
  };
  const handlers = orch.agentConductorHandlers(run, opts, s.agentOptions ?? {});
  return drain(runAgentGraph(command, handlers, opts.signal));
}

/** Assert the two control paths emit identical event streams, and return them. */
async function assertParity(s: Scenario): Promise<AiEvent[]> {
  const [stream, kernel] = await Promise.all([streamPath(s), kernelPath(s)]);
  expect(kernel).toEqual(stream);
  return stream;
}

/** Ops from two applied deletes, used to seed the resume scenario realistically. */
async function seedResumeOps(): Promise<unknown[]> {
  const seed = await new Orchestrator(
    new ScriptedProvider([turn(del('c1', 0, 2)), turn(del('c2', 3, 4)), done]),
  ).agent(input, {});
  return seed.result.patch.operations as unknown[];
}

describe('Conductor ↔ streamAgent event parity (K1.2)', () => {
  it('multi-turn applied run (turn applies an edit, then the model is done)', async () => {
    const events = await assertParity({
      build: () => ({ provider: new ScriptedProvider([turn(del('c1', 0, 3)), done]) }),
    });
    expect(events.some((e) => e.type === 'diff')).toBe(true);
    expect(events.some((e) => e.type === 'timeline_action')).toBe(true);
  });

  it('done / no-op run (the model calls no tools on the first turn)', async () => {
    const events = await assertParity({
      build: () => ({ provider: new ScriptedProvider([{ text: 'all done', toolCalls: [] }]) }),
    });
    // No edit landed — ADR 0081 ends the run `failed`, not `completed`; the parity
    // assertion above is what actually matters here (both paths agree).
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('empty terminal text (no prose, no tool call) fails the run instead of closing it', async () => {
    // Parity here is on the THROW, not the event tail: the raw kernel seam has no
    // throw-settling wrapper (that is `streamAgent`'s job), so it surfaces the typed
    // provider error while `streamAgent` converts the same error into an error card +
    // terminal `failed`. Both paths must agree that this is a failure, never a "done" run.
    const scenario = {
      build: () => ({ provider: new ScriptedProvider([{ text: '', toolCalls: [] }]) }),
    };
    await expect(kernelPath(scenario)).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('empty response'),
    });
    const events = await streamPath(scenario);
    // No fabricated "Done — no further edits." closing message.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(false);
    expect(events.some((e) => e.type === 'error' && /empty response/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('a turn that narrates AND edits (mid-run text streams into its own segment)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          { text: 'Splitting the intro to tighten pacing', toolCalls: [del('c1', 0, 3)] },
          done,
        ]),
      }),
    });
    expect(
      events.some(
        (e) =>
          e.type === 'assistant_message' &&
          e.id.includes(':seg-') &&
          e.text === 'Splitting the intro to tighten pacing',
      ),
    ).toBe(true);
  });

  it('per-turn op cap (a turn exceeding maxOpsPerTurn is rejected wholesale)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          { text: '', toolCalls: [del('a', 0, 2), del('b', 4, 5)] },
          { text: 'done', toolCalls: [] },
        ]),
      }),
      agentOptions: { maxOpsPerTurn: 1 },
    });
    expect(events.some((e) => e.type === 'warning' && /per-turn cap/.test(e.text))).toBe(true);
  });

  it('per-run op cap (the run stops once the cumulative op budget is spent)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([turn(del('c1', 0, 3)), turn(del('c2', 4, 5))]),
      }),
      agentOptions: { maxOpsPerRun: 1 },
    });
    expect(events.some((e) => e.type === 'notification' && /per-run cap/.test(e.text))).toBe(true);
  });

  it('no-progress spin guard (a repeated zero-op turn stops the run)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          { text: '', toolCalls: [{ id: 'r', name: 'get_timeline', arguments: {} }] },
        ]),
      }),
    });
    // A repeated read-only call never lands an edit — ADR 0081 ends the run `failed`.
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('user cancel — pre-aborted signal (turn-boundary abort, no plan event)', async () => {
    const events = await assertParity({
      build: () => {
        const c = new AbortController();
        c.abort();
        return { provider: new ScriptedProvider([turn(del('c1', 0, 3))]), signal: c.signal };
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('user cancel — abort mid model call (mid-stream turn.aborted)', async () => {
    const events = await assertParity({
      build: () => {
        const controller = new AbortController();
        return {
          provider: new AbortingProvider(controller, { text: 'partial', toolCalls: [] }),
          signal: controller.signal,
        };
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('user cancel — a host tool is cancelled mid-turn (failed "Stopped by user" step)', async () => {
    const events = await assertParity({
      build: () => {
        const controller = new AbortController();
        // The analysis engine aborts the run while its tool is in flight, then throws:
        // runAgentCall settles the call `cancelled`, so the turn is a user cancellation.
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
    });
    // Unplanned run: no pinned plan checklist is emitted (the cancelled step's status
    // lives in reducer state, not the event stream) — the cancelled tool card + terminal
    // status carry the outcome. Parity itself is asserted by `assertParity` above.
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('planFirst (drafts an up-front ledger, then follows it)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          { text: '1. Trim the intro\n2. Wrap up' },
          turn(del('c1', 0, 3)),
          done,
        ]),
      }),
      agentOptions: { planFirst: true },
    });
    const plan = events.find((e) => e.type === 'plan');
    expect(plan?.type === 'plan' && plan.steps.length).toBe(2);
  });

  it('planFirst with an empty drafted plan (planning statuses, no ledger)', async () => {
    await assertParity({
      build: () => ({
        provider: new ScriptedProvider([{ text: '' }, turn(del('c1', 0, 3)), done]),
      }),
      agentOptions: { planFirst: true },
    });
  });

  it('resume (rebuilds from a 2-edit checkpoint and continues; empty prompt uses defaults)', async () => {
    const ops = await seedResumeOps();
    const scenario: Scenario = {
      // An empty prompt exercises the `|| 'Resume'` / `|| 'Agent edit'` reason fallbacks;
      // a 2-op checkpoint exercises the plural "kept 2 edits" reasoning summary.
      input: { project: makeProject(), userPrompt: '' },
      build: () => ({ provider: new ScriptedProvider([done]) }),
      agentOptions: {
        resume: {
          ops: ops as never,
          log: ['Step 1: Deleted', 'Step 2: Deleted'],
          stepsCompleted: 2,
        },
      },
    };
    const events = await assertParity(scenario);
    expect(
      events.some((e) => e.type === 'reasoning' && e.summaries.some((s) => /kept 2 edits/.test(s))),
    ).toBe(true);
  });

  it('resume — a single-edit checkpoint uses the singular "kept 1 edit" summary', async () => {
    const ops = (await seedResumeOps()).slice(0, 1);
    const events = await assertParity({
      build: () => ({ provider: new ScriptedProvider([done]) }),
      agentOptions: { resume: { ops: ops as never, log: ['Step 1: Deleted'], stepsCompleted: 1 } },
    });
    expect(
      events.some(
        (e) => e.type === 'reasoning' && e.summaries.some((s) => /kept 1 edit\b/.test(s)),
      ),
    ).toBe(true);
  });

  it('resume — stale checkpoint (ops no longer validate → honest notice, starts over)', async () => {
    const scenario: Scenario = {
      build: () => ({ provider: new ScriptedProvider([turn(del('c1', 0, 3)), done]) }),
      agentOptions: {
        resume: {
          // A delete against a track that does not exist — the replay fails validation.
          ops: [{ type: 'delete_range', trackId: 'ghost', start: 0, end: 3 } as never],
          log: ['Step 1: stale'],
          stepsCompleted: 1,
        },
      },
    };
    const events = await assertParity(scenario);
    expect(events.some((e) => e.type === 'warning' && /Could not resume/.test(e.text))).toBe(true);
  });

  it('autoRepair (a fixable self-check finding drives one bounded repair pass)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([turn(del('c1', 0, 3)), done, turn(del('c2', 0, 1))]),
      }),
      agentOptions: { durationTargetSeconds: 1 },
    });
    expect(events.some((e) => e.type === 'notification' && /Self-check/.test(e.text))).toBe(true);
  });

  it('autoRepair threads a live run signal into the repair pass', async () => {
    await assertParity({
      // A present (un-tripped) signal makes the repair `complete()` cancellable too.
      build: () => ({
        provider: new ScriptedProvider([turn(del('c1', 0, 3)), done, turn(del('c2', 0, 1))]),
        signal: new AbortController().signal,
      }),
      agentOptions: { durationTargetSeconds: 1 },
    });
  });

  it('empty run (all proposed edits rejected → honest no-edits notice)', async () => {
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          {
            text: '',
            toolCalls: [
              { id: '1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 8 } },
            ],
          },
          { text: 'done', toolCalls: [] },
        ]),
      }),
    });
    expect(events.some((e) => e.type === 'warning' && /No edits were applied/.test(e.text))).toBe(
      true,
    );
  });

  it('diminishing-returns stop (E4): both paths converge at the same turn with the tagged notice', async () => {
    const tinyRead = (id: string, name: string): AiResponse => ({
      text: '',
      toolCalls: [{ id, name, arguments: {} }],
      usage: { inputTokens: 500, outputTokens: 20 },
    });
    // Distinct zero-arg read tools, one per turn, so each turn is novel (dodges the
    // stall guard) while contributing nothing new (zero edits) — the token-delta streak.
    const READ_TOOL_NAMES = [
      'get_timeline',
      'get_selected_range',
      'get_project_state',
      'list_assets',
      'get_timeline_summary',
      'get_transcript',
    ];
    const events = await assertParity({
      build: () => ({
        provider: new ScriptedProvider([
          ...Array.from({ length: DIMINISHING_RETURNS_TURNS }, (_, i) =>
            tinyRead(`r${i + 1}`, READ_TOOL_NAMES[i % READ_TOOL_NAMES.length]!),
          ),
          { text: 'never reached', toolCalls: [] },
        ]),
      }),
    });
    expect(
      events.some((e) => e.type === 'notification' && e.reason === 'diminishing_returns'),
    ).toBe(true);
    // Every turn was a distinct read-only call — no edit landed, so ADR 0081 ends this
    // run `failed` even though it converged honestly rather than hitting a resource rail.
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  // The parity scenarios all pin a fixed clock (byte-identical `ts`); this standalone
  // run exercises the default-clock fallback the handlers use when a run omits `now`.
  it('defaults the event clock to Date.now when the run opts omit one', async () => {
    const orch = new Orchestrator(new ScriptedProvider([done]));
    const opts = { conversationId: 'conv_1', turnId: 'turn_1' };
    const handlers = orch.agentConductorHandlers(input, opts);
    const events = await drain(
      runAgentGraph({ kind: 'submit_turn', mode: 'agent', input, stream: opts }, handlers),
    );
    // `done` makes no tool calls — no edit landed, so ADR 0081 ends the run `failed`.
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });
});
