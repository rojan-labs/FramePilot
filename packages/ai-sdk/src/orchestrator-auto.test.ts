/**
 * Tests for the model-routed `streamAuto` entry point (ADR 0055). One classification call
 * decides the route; these assert each route delegates correctly and — critically — that a
 * chitchat/question turn never emits an editing signal (so it can never show the sidebar's
 * "nothing changed" notice), while an edit turn always does.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, diffProject, invertProjectPatch } from '@framepilot/editor-core';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import { MockProvider } from './providers/mock.js';
import type { AiEvent } from './events.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import type { ContextInput } from './context-builder.js';
import { makeProject } from './__fixtures__/project.js';
import { estimateUsd } from './kernel/cost/cost-meter.js';
import { createAskUserGate } from './run-controls.js';
import type { HostToolExecutor } from './tool-executor.js';
import { modelPlanObjectiveKey, modelPlanRecordsFromEvents } from './kernel/model-plan.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'do the thing' };
const opts: StreamOptions = { conversationId: 'c1', turnId: 't1', now: () => 1000 };

/** Returns queued responses in order (last repeats): first call = classification. */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(
    private readonly responses: readonly AiResponse[],
    private readonly onCall?: (call: number) => void,
  ) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const i = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    this.onCall?.(this.calls);
    return this.responses[i]!;
  }
}

const collect = async (gen: AsyncIterable<AiEvent>): Promise<AiEvent[]> => {
  const events: AiEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
};

const statuses = (events: AiEvent[]): string[] =>
  events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);

const assistantTexts = (events: AiEvent[]): string[] =>
  events.filter((e) => e.type === 'assistant_message').map((e) => (e as { text: string }).text);

describe('Orchestrator.streamAuto', () => {
  it('answers a chitchat route directly with its reply and never signals editing', async () => {
    const provider = new ScriptedProvider([
      { text: '{"route":"chitchat","reply":"Hey! What do you want to edit?"}' },
    ]);
    const events = await collect(new Orchestrator(provider).streamAuto(input, opts));
    // Exactly one model call (the classification) — a greeting never triggers planning.
    expect(provider.calls).toBe(1);
    expect(assistantTexts(events)).toContain('Hey! What do you want to edit?');
    expect(statuses(events)).not.toContain('editing');
    expect(statuses(events)).not.toContain('planning');
    expect(statuses(events).at(-1)).toBe('completed');
  });

  it('routes a question to the chat sub-stream (answer, no editing signal)', async () => {
    const provider = new ScriptedProvider([
      { text: '{"route":"question"}' },
      { text: 'It is a 12-second clip.' },
    ]);
    const events = await collect(new Orchestrator(provider).streamAuto(input, opts));
    expect(assistantTexts(events)).toContain('It is a 12-second clip.');
    expect(statuses(events)).not.toContain('editing');
  });

  it('threads the run controls into the question route so ask_user reaches the editor (E5.2)', async () => {
    const gate = createAskUserGate();
    const provider = new ScriptedProvider([
      { text: '{"route":"question"}' },
      {
        text: 'Let me ask.',
        toolCalls: [
          {
            id: 'ask1',
            name: 'ask_user',
            arguments: {
              question: 'What next?',
              options: [{ label: 'Review changes' }, { label: 'New task' }],
            },
          },
        ],
      },
      { text: 'Reviewing the changes.' },
    ]);
    // Answer the question as soon as the run blocks on the gate.
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        gate.resolve('ask1', { kind: 'answered', answer: 'Review changes' });
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    })();
    const events = await collect(
      new Orchestrator(provider).streamAuto(input, opts, { controls: { askUser: gate } }),
    );
    pumping = false;
    await pump;
    const ask = events.find((e) => e.type === 'ask');
    expect(ask).toMatchObject({ toolCallId: 'ask1', question: 'What next?' });
    expect(statuses(events)).toContain('awaiting_answer');
    expect(assistantTexts(events)).toContain('Reviewing the changes.');
    expect(statuses(events).at(-1)).toBe('completed');
  });

  it('falls back to the agent when the model answers with the removed recipe route', async () => {
    // A model working from a stale/cached contract can still emit `{"route":"recipe"}`.
    // The parser rejects it, and the run must land on the agent — never dispatch a route
    // that no longer exists, and never end the request inert.
    const lifecycle: unknown[] = [];
    const provider = new ScriptedProvider([
      { text: '{"route":"recipe","recipe":"remove_silence"}' },
      { text: 'Nothing to change here. Done.' },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamAuto(input, opts, {
        onLifecycleEvent: (event) => lifecycle.push(event),
      }),
    );
    expect(statuses(events)).toContain('editing');
    expect(lifecycle[0]).toMatchObject({ route: 'agent', stage: 'understand' });
  });

  it('routes beat synchronization through analysis and places variable clips on exact detected beats', async () => {
    const beatProject = makeProject({
      assets: [
        { id: 'music', path: 'media/music.mp3', kind: 'audio', durationSeconds: 8 },
        { id: 'broll', path: 'media/broll.mp4', kind: 'video', durationSeconds: 8 },
      ],
      timeline: {
        tracks: [
          { id: 'video_1', type: 'video', clips: [] },
          {
            id: 'audio_1',
            type: 'audio',
            clips: [
              {
                id: 'music_clip',
                assetId: 'music',
                trackId: 'audio_1',
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
    });
    // ADR 0126: beat synchronisation used to select the `planned_edit` route and its
    // separate planner/graph runtime. It is now ordinary `edit` work — the agent acquires
    // the same beat/scene evidence through the same host tools and places the same clips,
    // which is precisely the parity this convergence was gated on. The OUTCOME assertions
    // below are unchanged from the planner-era test on purpose.
    //
    // What this test deliberately no longer covers: the planner-era version fed an
    // off-grid first proposal and asserted a beat-grid boundary rule REJECTED it and
    // spent one bounded repair turn. No such rule exists (ADR 0174: where a cut lands
    // against the music is the model's editorial call), so asserting it here would test
    // behavior that does not exist. The scripted clips below are on-grid because the
    // model placed them there, not because anything checked.
    const addClip = (start: number, end: number, sourceStart: number) => ({
      id: `add_${String(start)}`,
      name: 'add_clip',
      arguments: { trackId: 'video_1', assetId: 'broll', start, end, sourceStart },
    });
    const provider = new ScriptedProvider([
      { text: '{"route":"edit"}' },
      {
        text: '',
        toolCalls: [{ id: 'beats', name: 'detect_beats', arguments: { assetId: 'music' } }],
      },
      {
        text: '',
        toolCalls: [{ id: 'scenes', name: 'detect_scenes', arguments: { assetId: 'broll' } }],
      },
      {
        text: '',
        toolCalls: [addClip(0, 0.75, 0), addClip(0.75, 1.75, 2), addClip(1.75, 3, 4)],
      },
      { text: 'Cut to the four detected onsets.', toolCalls: [] },
    ]);
    const executor: HostToolExecutor = {
      async run(call: ToolCall) {
        if (call.name === 'detect_beats') {
          return {
            status: 'completed',
            summary: 'Found four non-uniform onsets',
            data: {
              assetId: 'music',
              beats: [0, 0.75, 1.75, 3].map((time) => ({ time, strength: 1 })),
              bpm: 96,
            },
          };
        }
        if (call.name === 'detect_scenes') {
          return {
            status: 'completed',
            summary: 'Found source shot changes',
            data: { assetId: 'broll', cuts: [{ time: 2 }, { time: 4 }, { time: 6 }] },
          };
        }
        return { status: 'failed', summary: `Unexpected tool ${call.name}` };
      },
    };

    const events = await collect(
      new Orchestrator(provider, { executor }).streamAuto(
        { project: beatProject, userPrompt: 'cut the b-roll to the music beats' },
        opts,
      ),
    );
    const diff = events.find((event) => event.type === 'diff') as
      | {
          edit: {
            patch: { operations: readonly Record<string, unknown>[] };
            validation: { valid: boolean };
          };
        }
      | undefined;
    expect(diff?.edit.validation.valid).toBe(true);
    const adds =
      diff?.edit.patch.operations.filter((operation) => operation.type === 'add_clip') ?? [];
    // The onsets are 0, 0.75, 1.75, 3 and the project is 30fps, so two of them fall
    // BETWEEN frames — 0.75s is frame 22.5. Every edit point is now quantized (GAP-005),
    // including `add_clip`'s, so each cut lands on the frame nearest its onset. Asserted
    // as the two properties that matter rather than as four constants: the cuts are on the
    // grid, and they are still where the music is.
    const frame = (seconds: unknown) => Number(seconds) * 30;
    for (const [start, end] of adds.map(({ start, end }) => [start, end])) {
      expect(frame(start)).toBeCloseTo(Math.round(frame(start)), 9);
      expect(frame(end)).toBeCloseTo(Math.round(frame(end)), 9);
    }
    for (const [i, onset] of [0, 0.75, 1.75].entries()) {
      // Within half a frame of the onset — the nearest frame that exists.
      expect(Number(adds[i]?.start)).toBeCloseTo(onset, 1);
    }
    // Still variable, which is the point of cutting to non-uniform onsets: the run must
    // not have flattened them onto a regular grid.
    const durations = adds.map(({ start, end }) => Number(end) - Number(start));
    expect(new Set(durations.map((d) => d.toFixed(2))).size).toBe(3);
    expect(adds).toHaveLength(3);
    // One classification call plus the agent's turns. Bounded rather than exact so a
    // harmless extra settle turn is not a failure, but a spin loop still is.
    // 9, not 7: the model's "done" answers to the request's own stated conditions — an
    // unmet one buys one bounded recovery turn — and a self-check finding that survives
    // the repair pass buys one findings-scoped fix turn plus its re-verify (P4.3).
    expect(provider.calls).toBeLessThanOrEqual(9);

    const after = applyProjectPatch(beatProject, diff!.edit.patch as never);
    const restored = applyProjectPatch(
      after,
      invertProjectPatch(beatProject, diff!.edit.patch as never),
    );
    expect(diffProject(beatProject, restored).summary).toEqual(['no changes']);
  });

  it('runs a long-video request through the agent with bounded context and exact cost', async () => {
    const longProject = makeProject({
      assets: [
        { id: 'long_asset', path: 'media/feature.mp4', kind: 'video', durationSeconds: 7_200 },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'feature',
                assetId: 'long_asset',
                trackId: 'video_1',
                start: 0,
                end: 7_200,
                sourceStart: 0,
                sourceEnd: 7_200,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
    const prompt = 'Build a 30-second cinematic montage from this two-hour source, cut to beats.';
    const provider = new ScriptedProvider([
      { text: '{"route":"edit"}', usage: { inputTokens: 10, outputTokens: 2 } },
      {
        text: 'I inspected the bounded context and stopped honestly.',
        usage: { inputTokens: 40, outputTokens: 5 },
      },
    ]);

    const events = await collect(
      new Orchestrator(provider).streamAuto({ project: longProject, userPrompt: prompt }, opts),
    );

    // A two-hour source must not put two hours of timeline in the prompt: the classifier
    // sees only the tiny project header, and the agent turn sees the request itself.
    expect(
      provider.requests[0]?.messages.some((message) => message.content.includes('7200.00s')),
    ).toBe(true);
    expect(provider.requests[1]?.messages.some((message) => message.content.includes(prompt))).toBe(
      true,
    );
    // ONE usage event for the whole turn, carrying the classifier's real spend folded into
    // the agent run's — the C1 cost-honesty contract, now with no second route to seed.
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toHaveLength(1);
    // 12 from the classifier (10 in + 2 out) plus 45 for each agent turn (40 in + 5 out):
    // the classifier's spend is folded in, not billed as a separate turn.
    expect(usage[0]?.tokens).toBe(12 + 45 * (provider.calls - 1));
    // The agent ended the run with a reply and nothing it tried failed or was refused: an
    // answer with an empty diff, which completes (ADR 0199 §5; the editor sees the reply and
    // the sidebar's "no edits" notice). A reply after a FAILED call is what fails.
    expect(provider.calls).toBe(2);
    expect(statuses(events).at(-1)).toBe('completed');
  });

  it('falls back to the edit (agent) route when classification is unparseable', async () => {
    // MockProvider never returns classification JSON, so parseClassification → null →
    // FALLBACK edit → the agent loop, which emits an editing signal.
    const events = await collect(new Orchestrator(new MockProvider()).streamAuto(input, opts));
    expect(statuses(events)).toContain('editing');
  });

  it("threads the classifier call's real usage into the delegated agent run's terminal usage event (C1)", async () => {
    // The classifier call (index 1) reports real usage; the agent loop's own single
    // turn (index 2) stops immediately with no edit and no usage of its own — so the
    // run's ONE terminal `usage` event must still carry the classifier's spend, not a
    // fabricated zero.
    class UsageProvider implements AiProvider {
      // Priced identity: an unpriced provider reports usd 0 by design (`runPricingFor`).
      public readonly name = 'anthropic' as const;
      public readonly modelId = 'claude-opus-5';
      private index = 0;
      public async complete(): Promise<AiResponse> {
        this.index += 1;
        if (this.index === 1) {
          return { text: '{"route":"edit"}', usage: { inputTokens: 20, outputTokens: 5 } };
        }
        return { text: 'done' };
      }
    }
    const events = await collect(new Orchestrator(new UsageProvider()).streamAuto(input, opts));
    const usageEvents = events.filter((e) => e.type === 'usage');
    // Emitted exactly once (at the delegated agent run's finalize), never per model call.
    expect(usageEvents).toHaveLength(1);
    const usage = usageEvents[0] as { tokens: number; usd: number };
    expect(usage.tokens).toBe(25);
    expect(usage.usd).toBeGreaterThan(0);
  });

  it("defaults a missing side of the classifier's partial usage to 0", async () => {
    // Only inputTokens reported — costFromUsage's own `?? 0` fallback (not
    // providerChunks', which normalizes first) must cover the missing side.
    const provider = new ScriptedProvider([
      { text: '{"route":"edit"}', usage: { inputTokens: 20 } },
      { text: 'done' },
    ]);
    const events = await collect(new Orchestrator(provider).streamAuto(input, opts));
    const usage = events.find((e) => e.type === 'usage') as { tokens: number } | undefined;
    expect(usage?.tokens).toBe(20);
  });

  it('falls back to the edit route when the classifier call itself throws', async () => {
    class ThrowingProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        throw new Error('network exploded');
      }
    }
    const events = await collect(new Orchestrator(new ThrowingProvider()).streamAuto(input, opts));
    expect(statuses(events)).toContain('editing');
  });

  it('falls back to the edit route when the classifier call throws a non-Error value', async () => {
    class ThrowingNonErrorProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        throw 'connection reset';
      }
    }
    const events = await collect(
      new Orchestrator(new ThrowingNonErrorProvider()).streamAuto(input, opts),
    );
    expect(statuses(events)).toContain('editing');
  });

  it("defaults the OTHER missing side (inputTokens) of the classifier's partial usage to 0", async () => {
    const provider = new ScriptedProvider([
      { text: '{"route":"edit"}', usage: { outputTokens: 7 } },
      { text: 'done' },
    ]);
    const events = await collect(new Orchestrator(provider).streamAuto(input, opts));
    const usage = events.find((e) => e.type === 'usage') as { tokens: number } | undefined;
    expect(usage?.tokens).toBe(7);
  });

  it("holds a continuation to the brief it continues, with the brief's own stated length", async () => {
    // Run 6cb12e30, end to end through the router: the brief states "58–62s" for the
    // master and "the best 2–4s of each" for shots; the follow-up names no work of its own.
    const brief =
      'Edit a vertical travel reel. MASTER: 1080×1920, 58–62s. Use only the best 2–4s of each clip.';
    const provider = new ScriptedProvider([
      {
        text: '{"route":"edit","continues":1,"length":{"min":58,"max":62,"quote":"58–62s"}}',
      },
      { text: 'done' },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamAuto(
        {
          ...input,
          userPrompt: 'load the tools and complete the task',
          history: [
            { role: 'user', content: brief },
            { role: 'assistant', content: 'Applied 83 edits' },
          ],
        },
        opts,
      ),
    );
    // The reader was shown the brief, numbered, above the message.
    expect(provider.requests[0]?.messages[1]?.content).toContain(`[1] ${brief}`);
    const working = events.find((event) => event.type === 'run_state') as
      | { working: { objective: { outcome: string; acceptance: { description: string }[] } } }
      | undefined;
    expect(working?.working.objective.outcome).toContain('Edit a vertical travel reel');
    const criteria = working?.working.objective.acceptance.map((entry) => entry.description);
    expect(criteria).toContain('The finished sequence runs 58–62s (the request says “58–62s”).');
    expect(criteria?.some((text) => text.includes('about 3s'))).toBe(false);
  });

  it('threads the selection into the classifier prompt when one is pinned', async () => {
    const withSelection: ContextInput = { ...input, selection: { start: 1, end: 2 } };
    const provider = new ScriptedProvider([{ text: '{"route":"chitchat","reply":"hi"}' }]);
    const events = await collect(new Orchestrator(provider).streamAuto(withSelection, opts));
    expect(assistantTexts(events)).toContain('hi');
  });

  it('uses the default chitchat reply when the classifier omits one', async () => {
    const provider = new ScriptedProvider([{ text: '{"route":"chitchat"}' }]);
    const events = await collect(new Orchestrator(provider).streamAuto(input, opts));
    expect(assistantTexts(events).some((t) => t.startsWith("Hi! I'm your editing copilot"))).toBe(
      true,
    );
  });

  it('cancels immediately when the signal is already aborted right after classification', async () => {
    const controller = new AbortController();
    class AbortingProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        controller.abort();
        return { text: '{"route":"edit"}' };
      }
    }
    const events = await collect(
      new Orchestrator(new AbortingProvider()).streamAuto(input, {
        ...opts,
        signal: controller.signal,
      }),
    );
    expect(statuses(events)).toContain('cancelled');
    expect(statuses(events).at(-1)).toBe('cancelled');
  });
});

describe('Orchestrator.streamAuto — tiered model routing (goal.md Workstream E)', () => {
  /** A chitchat classification ends the turn in one call; an edit route needs a second. */
  const classifyAsQuestion = { text: '{"route":"question"}' };

  it('sends only the classification to the small provider, the turn itself to the base', async () => {
    const base = new ScriptedProvider([{ text: 'It is a 12-second clip.' }]);
    const small = new ScriptedProvider([classifyAsQuestion]);

    const events = await collect(
      new Orchestrator(base, { tierProviders: { small } }).streamAuto(input, opts),
    );

    expect(small.calls).toBe(1);
    // The classifier prompt carries the user's command; the base provider got the turn.
    expect(JSON.stringify(small.requests[0])).toContain('do the thing');
    expect(base.calls).toBe(1);
    expect(assistantTexts(events)).toContain('It is a 12-second clip.');
  });

  it('reports the small model in the classifier context manifest, not the base model', async () => {
    class NamedProvider extends ScriptedProvider {
      public constructor(
        responses: readonly AiResponse[],
        public readonly modelId: string,
      ) {
        super(responses);
      }
    }
    const base = new NamedProvider([{ text: 'answer' }], 'big-model');
    const small = new NamedProvider([classifyAsQuestion], 'small-model');

    const events = await collect(
      new Orchestrator(base, { tierProviders: { small } }).streamAuto(input, opts),
    );

    const usage = events.find((e) => e.type === 'context_usage') as
      { manifest?: { model?: string } } | undefined;
    expect(usage?.manifest?.model).toBe('small-model');
  });

  it('routes both calls to the base provider when no tier providers are configured', async () => {
    const base = new ScriptedProvider([classifyAsQuestion, { text: 'It is a 12-second clip.' }]);

    const events = await collect(new Orchestrator(base).streamAuto(input, opts));

    expect(base.calls).toBe(2);
    expect(assistantTexts(events)).toContain('It is a 12-second clip.');
  });

  describe('each call is priced by the model that served it, not its tier label (TRACKING M5)', () => {
    class PricedProvider implements AiProvider {
      public readonly name = 'anthropic' as const;
      public calls = 0;
      public constructor(
        public readonly modelId: string,
        private readonly responses: readonly AiResponse[],
      ) {}
      public async complete(): Promise<AiResponse> {
        const response = this.responses[Math.min(this.calls, this.responses.length - 1)]!;
        this.calls += 1;
        return response;
      }
    }
    const classifierUsage = { inputTokens: 20, outputTokens: 5 };
    const usageOf = (events: readonly AiEvent[]) =>
      events.find((e) => e.type === 'usage') as { usd: number; priced?: boolean } | undefined;

    it('bills routing on an Opus run at Opus rates when no small provider is configured', async () => {
      // It used to be billed as `small` whatever served it — an Opus call at Haiku rates.
      const base = new PricedProvider('claude-opus-5', [
        { text: '{"route":"edit"}', usage: classifierUsage },
        { text: 'done' },
      ]);
      const usage = usageOf(await collect(new Orchestrator(base).streamAuto(input, opts)));
      expect(usage?.usd).toBeCloseTo(estimateUsd('large', { input: 20, output: 5 }), 10);
      expect(usage?.priced).toBe(true);
    });

    it('bills a configured Haiku classifier at its own small rate', async () => {
      const base = new PricedProvider('claude-opus-5', [{ text: 'done' }]);
      const small = new PricedProvider('claude-haiku-4-5', [
        { text: '{"route":"edit"}', usage: classifierUsage },
      ]);
      const usage = usageOf(
        await collect(new Orchestrator(base, { tierProviders: { small } }).streamAuto(input, opts)),
      );
      expect(usage?.usd).toBeCloseTo(estimateUsd('small', { input: 20, output: 5 }), 10);
    });

    it('marks the run unpriced when the classifier ran on a model this SDK cannot price', async () => {
      // The base is priced; the routing call is not. Its spend is unknown, so the run's dollar
      // figure is a placeholder — and the old code priced it from the BASE provider's table.
      const base = new PricedProvider('claude-opus-5', [{ text: 'done' }]);
      const small = new ScriptedProvider([{ text: '{"route":"edit"}', usage: classifierUsage }]);
      const usage = usageOf(
        await collect(new Orchestrator(base, { tierProviders: { small } }).streamAuto(input, opts)),
      );
      expect(usage?.priced).toBe(false);
    });
  });
});

/**
 * AL5 (#149): a follow-up that CONTINUES an earlier request picks up the plan the last run
 * on it ended with. The reader's grounded `continues` decides it — never the message's
 * words — and a new request starts with no plan.
 */
describe('Orchestrator.streamAuto — a continuation carries the plan forward (AL5)', () => {
  const brief = 'Edit a vertical travel reel: build the montage, warm grade, burn in captions.';
  const planCall = (items: readonly { task: string; status: string; note?: string }[]) => ({
    id: 'p1',
    name: 'update_plan',
    arguments: { items },
  });
  const openPlan = [
    { task: 'Build the montage', status: 'done', note: 'delete_range ×1' },
    { task: 'Warm grade', status: 'pending' },
    { task: 'Burn in captions', status: 'pending' },
  ];
  const planEvents = (events: AiEvent[]) =>
    events.filter((event): event is Extract<AiEvent, { type: 'plan' }> => event.type === 'plan');

  /** The first run on the brief: it writes its plan, then stops with two items open. */
  const firstRun = async () => {
    const provider = new ScriptedProvider([
      { text: '{"route":"edit"}' },
      { text: 'Planning.', toolCalls: [planCall(openPlan)] },
      { text: 'Stopping here.' },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamAuto({ ...input, userPrompt: brief }, opts),
    );
    return modelPlanRecordsFromEvents(events);
  };
  const followUp: ContextInput = {
    ...input,
    userPrompt: 'keep going',
    history: [
      { role: 'user', content: brief },
      { role: 'assistant', content: 'Built the montage.' },
    ],
  };

  it("files the run's plan under the request it works toward", async () => {
    const records = await firstRun();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ objectiveKey: modelPlanObjectiveKey(brief) });
    expect(records[0]?.items.map((item) => item.status)).toEqual(['done', 'pending', 'pending']);
  });

  it('starts the continuing run with the open items and keeps it going while they are open', async () => {
    const priorPlans = await firstRun();
    const provider = new ScriptedProvider([
      { text: '{"route":"edit","continues":1}' },
      { text: 'Nothing more from me.' },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamAuto(
        followUp,
        { ...opts, turnId: 't2' },
        {
          agentOptions: { priorPlans },
        },
      ),
    );
    // The checklist it left off with is drawn before the first turn, filed under the brief.
    expect(planEvents(events)[0]?.modelPlan).toEqual(priorPlans[0]);
    // The first turn is briefed with the carried plan, not asked to plan from scratch.
    const briefing = provider.requests[1]?.messages.at(-1)?.content ?? '';
    expect(briefing).toContain('YOUR PLAN');
    expect(briefing).toContain('[x] Build the montage');
    expect(briefing).toContain('[ ] Warm grade');
    // A reply with no tool call did not end it — two items were open.
    expect(provider.requests.length).toBeGreaterThan(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        text: expect.stringContaining('plan items still open — continuing with “Warm grade”'),
      }),
    );
  });

  it('starts a new request with no plan, whatever earlier runs planned', async () => {
    const priorPlans = await firstRun();
    const provider = new ScriptedProvider([{ text: '{"route":"edit"}' }, { text: 'Done.' }]);
    const events = await collect(
      new Orchestrator(provider).streamAuto(
        { ...followUp, userPrompt: 'add a title card that says Lisbon' },
        { ...opts, turnId: 't2' },
        { agentOptions: { priorPlans } },
      ),
    );
    expect(planEvents(events)).toEqual([]);
    expect(provider.requests[1]?.messages.at(-1)?.content).not.toContain('YOUR PLAN');
    expect(provider.requests).toHaveLength(2);
  });
});
