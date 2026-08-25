/**
 * Tests for the streaming orchestrator modes (Phase 11 M1): `streamChat`,
 * `streamPlan`, `streamEdit`, `streamAgent`. Asserts golden event sequences with
 * the deterministic mock, the `complete()`-drain fallback for providers without
 * `stream()`, the edit tool-boundary error path, and abort → `cancelled` + a valid
 * partial. 100% coverage of the streaming logic.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, agentCompletionReport, type StreamOptions } from './orchestrator.js';
import type { AnyOperation } from '@framepilot/editor-core';
import { MockProvider } from './providers/mock.js';
import { reduceEvents, type AiEvent } from './events.js';
import { createAskUserGate, createPlanApprovalGate, createSteeringQueue } from './run-controls.js';
import { DIMINISHING_RETURNS_TURNS, PLAN_APPROVAL_STEP_THRESHOLD } from './kernel/conductor.js';

/** A drafted-plan text with one more line than the approval gate's threshold. */
const overThresholdPlanText = Array.from(
  { length: PLAN_APPROVAL_STEP_THRESHOLD + 1 },
  (_, i) => `Step ${i + 1}`,
).join('\n');
import type {
  AiCompletionRequest,
  AiMessage,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ToolCall,
} from './providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import type { ContextInput } from './context-builder.js';
import { makeProject } from './__fixtures__/project.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const opts = (signal?: AbortSignal): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
  ...(signal ? { signal } : {}),
});

/** A non-streaming provider: exercises the `complete()`-drain fallback. */
class FakeProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(private readonly response: AiResponse) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    return this.response;
  }
}

/** Aborts mid-`complete()` so the abort trips inside a step, not at the loop top. */
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

/** Streams a scripted chunk sequence (reasoning + text) to exercise reasoning routing. */
class StreamingChunkProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(private readonly chunks: readonly ProviderChunk[]) {}
  public async complete(): Promise<AiResponse> {
    return { text: '' };
  }
  public async *stream(): AsyncIterable<ProviderChunk> {
    for (const chunk of this.chunks) yield chunk;
  }
}

/** Opens a reasoning line, then aborts mid-stream so the next iteration cancels. */
class AbortAfterReasoningProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(private readonly controller: AbortController) {}
  public async complete(): Promise<AiResponse> {
    return { text: '' };
  }
  public async *stream(): AsyncIterable<ProviderChunk> {
    yield { type: 'reasoning-delta', text: 'partial thought' };
    this.controller.abort();
    yield { type: 'text-delta', text: 'never reached' };
  }
}

const editCall = {
  id: 'c',
  name: 'delete_range',
  arguments: { trackId: 'video_1', start: 0, end: 3 },
};

/**
 * A provider that returns a queued sequence of responses across successive
 * `complete()` calls (repeating the last once exhausted). Lets a test script a
 * multi-turn agent run deterministically: turn 1, turn 2, then the repair pass.
 * No `stream()` → exercises the `complete()`-drain path.
 */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  /** Every request the loop sent, in order — lets a test assert what the model saw. */
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

/** Streams a DIFFERENT scripted chunk list per call, so a retried step can differ. */
class ScriptedStreamProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  /** How many times the loop opened a stream — the retry count under test. */
  public calls = 0;
  public constructor(private readonly scripts: readonly (readonly ProviderChunk[])[]) {}
  public async complete(): Promise<AiResponse> {
    return { text: '' };
  }
  public async *stream(): AsyncIterable<ProviderChunk> {
    this.calls += 1;
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)]!;
    this.index += 1;
    for (const chunk of script) yield chunk;
  }
}

/** An in-scope read-only call for the question route's tool loop. */
const getTimeline = (id: string) => ({ id, name: 'get_timeline', arguments: {} });

const deleteRange = (id: string, start: number, end: number) => ({
  id,
  name: 'delete_range',
  arguments: { trackId: 'video_1', start, end },
});

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const types = (events: AiEvent[]): string[] => events.map((e) => e.type);

const aborted = (): AbortSignal => {
  const c = new AbortController();
  c.abort();
  return c.signal;
};

describe('streamChat', () => {
  it('streams thinking → deltas → message → completed', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamChat(input, opts()));
    expect(events[0]).toMatchObject({ type: 'status', status: 'thinking' });
    expect(types(events)).toContain('assistant_delta');
    expect(events.at(-2)).toMatchObject({ type: 'assistant_message' });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('routes reasoning-delta chunks into a settled reasoning node, keeping text clean', async () => {
    const provider = new StreamingChunkProvider([
      { type: 'reasoning-delta', text: 'let me ' },
      { type: 'reasoning-delta', text: 'think' },
      { type: 'text-delta', text: 'Here is the answer.' },
      { type: 'done', text: 'Here is the answer.' },
    ]);
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    const view = reduceEvents(events);
    const reasoning = view.nodes.find((n) => n.kind === 'reasoning');
    expect(reasoning).toMatchObject({ kind: 'reasoning', summaries: ['let me think'], done: true });
    const assistant = view.nodes.find((n) => n.kind === 'assistant');
    // The rationale never leaks into the visible answer.
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'Here is the answer.' });
  });

  it('ASKS the provider for reasoning on a call whose thinking it will display', async () => {
    // The root cause of a whole run of unopenable "Thought for Ns" rows: reasoning is
    // opt-in on every wire format, and we never opted in — so the model reasoned
    // internally and returned nothing to show. The request must carry the ask.
    const provider = new ScriptedProvider([{ text: 'done' }]);
    await drain(new Orchestrator(provider).streamChat(input, opts()));
    expect(provider.requests[0]?.reasoningEffort).toBe('medium');
  });

  it('does NOT ask for reasoning on a call with nowhere to show it', async () => {
    // A plan turn streams into an assistant sink with `captureReasoning` off; paying a
    // reasoning surcharge for thinking no surface renders would be pure waste.
    const provider = new ScriptedProvider([{ text: '1. Trim the intro' }]);
    await drain(new Orchestrator(provider).streamPlan(input, opts()));
    expect(provider.requests[0]?.reasoningEffort).toBeUndefined();
  });

  it('shows no reasoning node when the model streams none', async () => {
    const provider = new StreamingChunkProvider([
      { type: 'text-delta', text: 'plain reply' },
      { type: 'done', text: 'plain reply' },
    ]);
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    expect(events.some((e) => e.type === 'reasoning')).toBe(false);
  });

  it("a non-streaming provider's `reasoning` field is still routed to the reasoning node", async () => {
    // Exercises providerChunks()'s complete()-drain fallback: a provider with no
    // `stream()` method whose single response carries `reasoning` alongside `text`.
    const provider = new FakeProvider({ text: 'the answer', reasoning: 'thinking it through' });
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    const reasoning = reduceEvents(events).nodes.find((n) => n.kind === 'reasoning');
    expect(reasoning).toMatchObject({ kind: 'reasoning', summaries: ['thinking it through'] });
  });

  it('settles an open reasoning node when the run is aborted mid-thought', async () => {
    const controller = new AbortController();
    const provider = new AbortAfterReasoningProvider(controller);
    const events = await drain(
      new Orchestrator(provider).streamChat(input, opts(controller.signal)),
    );
    // The reasoning row opened, then settled `done` on cancel (no stuck "Thinking…").
    const settled = events.filter((e) => e.type === 'reasoning');
    expect(settled.at(-1)).toMatchObject({ type: 'reasoning', done: true });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('emits an honest notification when context is trimmed to fit the budget (B2)', async () => {
    const tight: ContextInput = {
      project: makeProject({
        transcript: Array.from({ length: 400 }, (_, i) => ({
          word: `w${i}`,
          start: i,
          end: i + 1,
        })),
      }),
      userPrompt: 'summarize',
      budget: { contextWindow: 120, maxOutputTokens: 0, headroom: 0 },
    };
    const events = await drain(new Orchestrator(new MockProvider()).streamChat(tight, opts()));
    const notices = events.filter((e) => e.type === 'notification');
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toMatchObject({ text: expect.stringContaining('trimmed') });
  });

  it('emits no trim notification for a small project', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamChat(input, opts()));
    expect(events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('emits no text-delta for empty completion text (drain fallback)', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: '' })).streamChat(input, opts()),
    );
    expect(types(events)).not.toContain('assistant_delta');
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('drains a complete()-only provider’s real usage without erroring (drain fallback)', async () => {
    // The input count updates the call's initial estimated context event with an exact one.
    const events = await drain(
      new Orchestrator(
        new FakeProvider({ text: 'hi', usage: { inputTokens: 12, outputTokens: 8 } }),
      ).streamChat(input, opts()),
    );
    expect(events.filter((event) => event.type === 'context_usage').at(-1)).toMatchObject({
      usedTokens: 12,
      estimated: false,
    });
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('defaults a missing input/output token count to 0 in the drain fallback', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'hi', usage: {} })).streamChat(input, opts()),
    );
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('aborts to cancelled when the signal trips mid-stream', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'hi' })).streamChat(input, opts(aborted())),
    );
    expect(types(events)).toEqual(['status', 'context_usage', 'status']);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('completes normally with a present-but-untripped signal', async () => {
    const live = new AbortController().signal;
    const events = await drain(new Orchestrator(new MockProvider()).streamChat(input, opts(live)));
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });
});

describe('streamChat tool use (E5.5) — the question route can look up and ask', () => {
  const question = {
    question: 'What would you like to do next?',
    options: [
      { label: 'Review recent changes', description: 'Look at the latest edits.' },
      { label: 'Start a new task' },
    ],
  };
  const askResponse = (id = 'ask1'): AiResponse => ({
    text: 'Let me check with you first.',
    toolCalls: [{ id, name: 'ask_user', arguments: question }],
  });

  /** Answer the pending question as soon as the chat run blocks on it. */
  async function drainAnswering(
    stream: AsyncGenerator<AiEvent>,
    gate: ReturnType<typeof createAskUserGate>,
    answer: Parameters<typeof gate.resolve>[1],
  ): Promise<AiEvent[]> {
    let running = true;
    const resolver = (async () => {
      while (running) {
        gate.resolve('ask1', answer);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    })();
    const out: AiEvent[] = [];
    for await (const event of stream) out.push(event);
    running = false;
    await resolver;
    return out;
  }

  it('advertises the E5 question scope — read/analysis/ask, never a mutating tool', async () => {
    const provider = new ScriptedProvider([{ text: 'answer' }]);
    await drain(new Orchestrator(provider).streamChat(input, opts()));
    const advertised = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(advertised).toContain('ask_user');
    expect(advertised).toContain('get_timeline');
    expect(advertised).not.toContain('delete_range');
    expect(advertised).not.toContain('render_preview');
  });

  it('sends the route contract that makes ask_user the only question channel', async () => {
    // The regression this pins: with tools but no instruction, the model's chat prior
    // wins and it writes the question — options and all — as unclickable markdown.
    const provider = new ScriptedProvider([{ text: 'answer' }]);
    await drain(new Orchestrator(provider).streamChat(input, opts()));
    const instruction = provider.requests[0]?.messages.at(-1);
    expect(instruction?.role).toBe('user');
    expect(instruction?.content).toContain('ask_user');
    expect(instruction?.content).toContain('only ask_user can collect the decision');
    expect(instruction?.content).toContain('Never write selectable choices as reply text');
  });

  it('records what the editor answered as a durable note, not only in this run', async () => {
    // The captured session: the model asked how the picture should sit in the vertical
    // frame, the editor chose "Full-bleed vertical crop", and the very next run rebuilt the
    // montage with no crop at all — the answer had lived only in the action log of the run
    // that asked. The note goes to the project's decisions tier, which every later run reads
    // back through its session-context digest.
    const gate = createAskUserGate();
    const remembered: { title: string; body: string }[] = [];
    const provider = new ScriptedProvider([askResponse(), { text: 'Understood.' }]);
    await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), {
        controls: { askUser: gate, rememberDecision: (note) => remembered.push(note) },
      }),
      gate,
      { kind: 'answered', answer: 'Full-bleed vertical crop' },
    );
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!.title).toContain(question.question);
    expect(remembered[0]!.body).toContain('Full-bleed vertical crop');
  });

  it('records nothing when the editor dismisses the question', async () => {
    // A dismissal is not a preference, and writing one down would teach later runs something
    // the editor never said.
    const gate = createAskUserGate();
    const remembered: unknown[] = [];
    const provider = new ScriptedProvider([askResponse(), { text: 'Stopped.' }]);
    await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), {
        controls: { askUser: gate, rememberDecision: (note) => remembered.push(note) },
      }),
      gate,
      { kind: 'cancelled' },
    );
    expect(remembered).toEqual([]);
  });

  it('surfaces ask_user to the editor, pauses, and answers from what they picked', async () => {
    const gate = createAskUserGate();
    const provider = new ScriptedProvider([
      askResponse(),
      { text: 'Great — reviewing the recent changes.' },
    ]);
    const events = await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), { controls: { askUser: gate } }),
      gate,
      { kind: 'answered', answer: 'Review recent changes' },
    );
    // The question reaches the host verbatim, options included — that is what the UI renders.
    const ask = events.find((e) => e.type === 'ask');
    expect(ask).toMatchObject({ toolCallId: 'ask1', question: question.question });
    expect(ask?.type === 'ask' && ask.options?.[0]?.label).toBe('Review recent changes');
    // The run honestly says it is stopped on a person.
    expect(events.some((e) => e.type === 'status' && e.status === 'awaiting_answer')).toBe(true);
    // The answer reaches the model's next turn, and the run ends in a real reply.
    const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
    expect(secondTurn).toContain('Review recent changes');
    const final = events.filter((e) => e.type === 'assistant_message').at(-1);
    expect(final).toMatchObject({ text: 'Great — reviewing the recent changes.' });
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('surfaces a question with no options (free-text answer)', async () => {
    const gate = createAskUserGate();
    const provider = new ScriptedProvider([
      {
        text: 'Let me check with you first.',
        toolCalls: [{ id: 'ask1', name: 'ask_user', arguments: { question: 'What next?' } }],
      },
      { text: 'Got it.' },
    ]);
    const events = await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), { controls: { askUser: gate } }),
      gate,
      { kind: 'answered', answer: 'do the thing' },
    );
    const ask = events.find((e) => e.type === 'ask');
    expect(ask).toMatchObject({ toolCallId: 'ask1', question: 'What next?' });
    expect(ask?.type === 'ask' && ask.options).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('a dismissed question stops the chat run as cancelled, never as an answer', async () => {
    const gate = createAskUserGate();
    const provider = new ScriptedProvider([askResponse(), { text: 'never sent' }]);
    const events = await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), { controls: { askUser: gate } }),
      gate,
      { kind: 'cancelled' },
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(provider.requests).toHaveLength(1);
  });

  it('degrades honestly when no ask gate is wired — never inventing an answer', async () => {
    const provider = new ScriptedProvider([askResponse(), { text: 'done' }]);
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
    expect(secondTurn).toContain('no way to reach them');
    expect(secondTurn).not.toContain('they answered');
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('gives every tool-loop turn its OWN reasoning node, in transcript order', async () => {
    // The regression: every turn of the question route's tool loop streamed into ONE
    // reasoning node id, so the second block of thinking OVERWROTE the first in place —
    // the transcript lost the earlier rationale and showed the later one above the tool
    // cards it came after. Each model call owns its own node.
    const provider = new ScriptedProvider([
      { text: '', reasoning: 'first I check the timeline', toolCalls: [getTimeline('c1')] },
      { text: 'Here is what I found.', reasoning: 'now I can answer' },
    ]);
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    const view = reduceEvents(events);
    const reasoning = view.nodes.filter((n) => n.kind === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]).toMatchObject({ summaries: ['first I check the timeline'], done: true });
    expect(reasoning[1]).toMatchObject({ summaries: ['now I can answer'], done: true });
    expect(new Set(reasoning.map((n) => n.id)).size).toBe(2);
    // Order: think → tool card → think again.
    const kinds = view.nodes.map((n) => n.kind);
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.indexOf('tool'));
    expect(kinds.lastIndexOf('reasoning')).toBeGreaterThan(kinds.indexOf('tool'));
  });

  it('refuses an out-of-scope mutating call with an honest failed card', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [deleteRange('c1', 0, 3)] },
      { text: 'I cannot edit from here, but here is what I found.' },
    ]);
    const events = await drain(new Orchestrator(provider).streamChat(input, opts()));
    // The card fails — never a checkmark for an edit this route cannot apply…
    expect(
      events.some(
        (e) => e.type === 'tool_call' && e.toolName === 'delete_range' && e.status === 'failed',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    // …and the refusal reaches the model so it answers instead of retrying forever.
    const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
    expect(secondTurn).toContain('Refused "delete_range"');
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('aborts to cancelled even on the forced final (no-tools) turn', async () => {
    const gate = createAskUserGate();
    const controller = new AbortController();
    // Asks on every tool-bearing turn; the forced final turn (no tools) trips the abort.
    class AskThenAbortProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(request: AiCompletionRequest): Promise<AiResponse> {
        if (request.tools) return askResponse();
        controller.abort();
        return { text: 'too late' };
      }
    }
    const events = await drainAnswering(
      new Orchestrator(new AskThenAbortProvider()).streamChat(input, opts(controller.signal), {
        controls: { askUser: gate },
      }),
      gate,
      { kind: 'answered', answer: 'Start a new task' },
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('always terminates in a real answer — the final turn is issued without tools', async () => {
    const gate = createAskUserGate();
    // A model that would ask forever: the loop's last turn withholds tools, forcing text.
    const provider = new ScriptedProvider([askResponse()]);
    const events = await drainAnswering(
      new Orchestrator(provider).streamChat(input, opts(), { controls: { askUser: gate } }),
      gate,
      { kind: 'answered', answer: 'Start a new task' },
    );
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    const last = provider.requests.at(-1);
    expect(last?.tools).toBeUndefined();
    expect(provider.requests.length).toBeGreaterThan(1);
  });
});

describe('streamPlan', () => {
  it('brackets the plan with reasoning and finishes completed', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamPlan(input, opts()));
    expect(events[0]).toMatchObject({ type: 'status', status: 'planning' });
    expect(types(events).filter((t) => t === 'reasoning')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('aborts to cancelled', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'plan' })).streamPlan(input, opts(aborted())),
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it("forwards a complete()-only provider's inline reasoning as a delta", async () => {
    const events = await drain(
      new Orchestrator(
        new FakeProvider({ text: 'plan', reasoning: 'thinking it through' }),
      ).streamPlan(input, opts()),
    );
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it("forwards a complete()-only provider's real usage (no effectRuntime wired for this mode)", async () => {
    // streamPlan calls streamAssistant with NO effectRuntime, so a complete()-only
    // provider's response is drained through the `providerChunks` fallback — this is the
    // one path that turns `response.usage` into a `usage` chunk (and defaults an absent
    // token count to 0) rather than silently dropping real cost data (C1).
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'plan', usage: {} })).streamPlan(input, opts()),
    );
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('does not route model reasoning-deltas (plan owns its own reasoning node)', async () => {
    // A reasoning model streaming inline thought must not spawn a second reasoning
    // stream on a plan turn — plan mode brackets its own "Drafting an edit plan".
    const provider = new StreamingChunkProvider([
      { type: 'reasoning-delta', text: 'model thinking' },
      { type: 'text-delta', text: '1. Do a thing' },
      { type: 'done', text: '1. Do a thing' },
    ]);
    const events = await drain(new Orchestrator(provider).streamPlan(input, opts()));
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(false);
    expect(types(events).filter((t) => t === 'reasoning')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });
});

describe('streamEdit', () => {
  it('streams deltas → timeline action → diff → completed', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamEdit(input, opts()));
    expect(types(events)).toContain('timeline_action');
    const diff = events.find((e) => e.type === 'diff');
    expect(diff).toBeDefined();
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('falls back to "AI edit" reason for empty text and drains complete()', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [
        { id: 'c', name: 'delete_range', arguments: { trackId: 'video_1', start: 0, end: 3 } },
      ],
    });
    const events = await drain(new Orchestrator(provider).streamEdit(input, opts()));
    const message = events.find((e) => e.type === 'assistant_message');
    expect(message).toMatchObject({ text: 'AI edit' });
    expect(types(events)).toContain('diff');
  });

  it('emits an error + failed when a tool call is invalid', async () => {
    const provider = new FakeProvider({
      text: 'x',
      toolCalls: [{ id: 'c', name: 'no_such_tool', arguments: {} }],
    });
    const events = await drain(new Orchestrator(provider).streamEdit(input, opts()));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('aborts to cancelled before assembling', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'e' })).streamEdit(input, opts(aborted())),
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('recovers per call: one bad call becomes a warning, the valid edit survives', async () => {
    const provider = new FakeProvider({
      text: 'mixed',
      toolCalls: [
        { id: 'bad', name: 'no_such_tool', arguments: {} },
        { id: 'ok', name: 'delete_range', arguments: { trackId: 'video_1', start: 0, end: 3 } },
      ],
    });
    const events = await drain(new Orchestrator(provider).streamEdit(input, opts()));
    // The bad call is surfaced honestly…
    expect(events.some((e) => e.type === 'warning')).toBe(true);
    // …but it no longer discards the valid call: the diff carries its operation
    // and the run completes instead of failing wholesale.
    const diff = events.find((e) => e.type === 'diff');
    expect(diff).toBeDefined();
    expect(
      (diff as { edit: { patch: { operations: unknown[] } } }).edit.patch.operations,
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });
});

describe('streamEdit variations (H1.5/P13.1 — opt-in "A/B compare")', () => {
  it('is unaffected when variations is omitted (default single-proposal behavior)', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamEdit(input, opts()));
    const diff = events.find((e) => e.type === 'diff') as { variants?: unknown } | undefined;
    expect(diff).toBeDefined();
    expect(diff?.variants).toBeUndefined();
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('proposes EDIT_VARIATION_COUNT real candidates and carries all of them on the diff', async () => {
    const provider = new ScriptedProvider([
      { text: 'Take A: trim the intro', toolCalls: [deleteRange('a', 0, 3)] },
      { text: 'Take B: trim more aggressively', toolCalls: [deleteRange('b', 0, 5)] },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamEdit(input, opts(), { variations: true }),
    );
    const diff = events.find((e) => e.type === 'diff') as {
      edit: { text: string; patch: { operations: AnyOperation[] } };
      variants?: { text: string; patch: { operations: AnyOperation[] } }[];
    };
    expect(diff.variants).toHaveLength(2);
    expect(diff.edit.text).toBe('Take A: trim the intro');
    expect(diff.variants?.[0]?.text).toBe('Take A: trim the intro');
    expect(diff.variants?.[1]?.text).toBe('Take B: trim more aggressively');
    // Distinct candidates, not the same proposal twice.
    expect(diff.variants?.[0]?.patch.operations).not.toEqual(diff.variants?.[1]?.patch.operations);
    // The primary preview (rationale + timeline-action cards) reflects Take A only.
    expect(events.find((e) => e.type === 'assistant_message')).toMatchObject({
      text: 'Take A: trim the intro',
    });
    expect(types(events)).toContain('timeline_action');
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('surfaces the REAL combined cost of every candidate call via a usage event', async () => {
    class UsageProvider implements AiProvider {
      public readonly name = 'mock' as const;
      private index = 0;
      public async complete(): Promise<AiResponse> {
        this.index += 1;
        return {
          text: `take ${this.index}`,
          toolCalls: [deleteRange(`c${this.index}`, 0, this.index)],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
    }
    const events = await drain(
      new Orchestrator(new UsageProvider()).streamEdit(input, opts(), { variations: true }),
    );
    const usage = events.find((e) => e.type === 'usage') as
      | { tokens: number; usd: number }
      | undefined;
    expect(usage).toBeDefined();
    // Two candidates × (100 + 50) tokens = 300 — the SUM, not just one candidate's usage.
    expect(usage?.tokens).toBe(300);
    expect(usage?.usd).toBeGreaterThan(0);
  });

  it('defaults a candidate’s missing token count to 0 (partial usage on either side)', async () => {
    class PartialUsageProvider implements AiProvider {
      public readonly name = 'mock' as const;
      private index = 0;
      public async complete(): Promise<AiResponse> {
        this.index += 1;
        // Candidate 1 reports only input tokens, candidate 2 only output — each exercises
        // one side of the `?? 0` fallback in the per-candidate cost accounting.
        const usage = this.index === 1 ? { inputTokens: 40 } : { outputTokens: 12 };
        return {
          text: `take ${this.index}`,
          toolCalls: [deleteRange(`c${this.index}`, 0, this.index)],
          usage,
        };
      }
    }
    const events = await drain(
      new Orchestrator(new PartialUsageProvider()).streamEdit(input, opts(), { variations: true }),
    );
    const usage = events.find((e) => e.type === 'usage') as { tokens: number } | undefined;
    expect(usage?.tokens).toBe(52); // (40 + 0) + (0 + 12) — both `?? 0` fallbacks applied
  });

  it('falls back to an "AI edit" label when a candidate returns empty model text', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [deleteRange('a', 0, 1)] },
      { text: '', toolCalls: [deleteRange('b', 0, 2)] },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamEdit(input, opts(), { variations: true }),
    );
    const diff = events.find((e) => e.type === 'diff') as { edit: { text: string } };
    expect(diff.edit.text).toBe('AI edit');
  });

  it('never fabricates cost when no candidate reports real usage (mock/Ollama-style)', async () => {
    const events = await drain(
      new Orchestrator(new MockProvider()).streamEdit(input, opts(), { variations: true }),
    );
    const usage = events.find((e) => e.type === 'usage') as
      | { tokens: number; usd: number }
      | undefined;
    expect(usage).toEqual(expect.objectContaining({ type: 'usage', tokens: 0, usd: 0 }));
  });

  it('drops a candidate that calls no tool, keeping the other real candidate', async () => {
    const provider = new ScriptedProvider([
      { text: 'no edit here', toolCalls: [] },
      { text: 'a real take', toolCalls: [deleteRange('x', 0, 2)] },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamEdit(input, opts(), { variations: true }),
    );
    const diff = events.find((e) => e.type === 'diff') as {
      edit: { text: string };
      variants?: unknown[];
    };
    expect(diff.edit.text).toBe('a real take');
    // Only one real candidate survived — no multi-variant switcher for a single take.
    expect(diff.variants).toBeUndefined();
  });

  it('fails honestly when EVERY candidate produces nothing reviewable', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'no tools called' })).streamEdit(input, opts(), {
        variations: true,
      }),
    );
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('aborts to cancelled without assembling a diff', async () => {
    const events = await drain(
      new Orchestrator(
        new FakeProvider({ text: 'e', toolCalls: [deleteRange('a', 0, 1)] }),
      ).streamEdit(input, opts(aborted()), { variations: true }),
    );
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });
});

describe('editVariations (H1.5/P13.1 — non-streaming batch entry point)', () => {
  it('reuses assembleEdit per candidate: two distinct, independently-validated patches', async () => {
    const provider = new ScriptedProvider([
      { text: 'Take A', toolCalls: [deleteRange('a', 0, 3)] },
      { text: 'Take B', toolCalls: [deleteRange('b', 2, 6)] },
    ]);
    const { variants, cost } = await new Orchestrator(provider).editVariations(input);
    expect(variants).toHaveLength(2);
    expect(variants[0]?.validation.valid).toBe(true);
    expect(variants[1]?.validation.valid).toBe(true);
    expect(cost).toEqual({ tokens: 0, usd: 0 });
  });

  it('a malformed call drops only its own candidate, not the whole run', async () => {
    const provider = new ScriptedProvider([
      { text: 'bad', toolCalls: [{ id: 'bad', name: 'no_such_tool', arguments: {} }] },
      { text: 'good', toolCalls: [deleteRange('ok', 0, 2)] },
    ]);
    const { variants } = await new Orchestrator(provider).editVariations(input);
    expect(variants).toHaveLength(1);
    expect(variants[0]?.text).toBe('good');
  });
});

describe('streamAgent', () => {
  it('streams per-step reasoning/tool/action events and a terminal diff + completed', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamAgent(input, opts()));
    const kinds = types(events);
    expect(events[0]).toMatchObject({ status: 'thinking' });
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('timeline_action');
    // An unplanned agent run emits NO pinned plan checklist — the per-step reasoning +
    // tool cards ARE the visible activity (a plan node appears only when one is drafted).
    expect(kinds).not.toContain('plan');
    // No progress events: an agent run has no measurable percentage (#5), so the
    // sidebar shows activity (reasoning/tools), never a fake bar.
    expect(kinds).not.toContain('progress');
    const view = reduceEvents(events);
    expect(view.status).toBe('completed');
    expect(view.nodes.some((n) => n.kind === 'diff')).toBe(true);
  });

  it('wires an injected effectObserver into the run’s model-effect lifecycle', async () => {
    const seen: string[] = [];
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'all done' }), {
        effectObserver: {
          onRequested: () => {
            seen.push('requested');
          },
          onSettled: () => {
            seen.push('settled');
          },
          onFailed: () => {
            seen.push('failed');
          },
        },
      }).streamAgent(input, opts()),
    );
    // The model called no tools and no edit landed — ADR 0081 ends the run `failed`;
    // the observer wiring under test here fires regardless of the terminal verdict.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(seen).toContain('requested');
    expect(seen).toContain('settled');
  });

  it('hands the run’s recorded effects to onRecording when recordEffects is on (P7.3)', async () => {
    let recording: unknown;
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'all done' }), {
        recordEffects: true,
        onRecording: (r) => {
          recording = r;
        },
      }).streamAgent(input, opts()),
    );
    // No edit landed — ADR 0081 ends the run `failed`; the recording under test here
    // still captures every effect regardless of the terminal verdict.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(recording).toMatchObject({ effects: expect.any(Array) });
    expect((recording as { effects: unknown[] }).effects.length).toBeGreaterThan(0);
  });

  it('finishes with an assistant summary when the model stops calling tools', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'all done' })).streamAgent(input, opts()),
    );
    expect(events.find((e) => e.type === 'assistant_message')).toMatchObject({ text: 'all done' });
    // The model's own summary is still shown, but no edit landed — ADR 0081 ends the
    // run `failed`, not `completed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('fails honestly when the model returns nothing at all (no text, no tool call)', async () => {
    // The regression this pins: a provider that drops the request after 200 headers used to
    // reach the creator as "Done — no further edits." on an untouched timeline.
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: '' })).streamAgent(input, opts()),
    );
    expect(events.some((e) => e.type === 'assistant_message')).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('empty response'),
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it("retries a dropped step in place, and uses the retry's answer", async () => {
    // The provider dropping ONE request must not end the run: `ResilientProvider` cannot
    // replay it (the failure lands after a 200), so the step retries here.
    const provider = new ScriptedStreamProvider([
      [{ type: 'done', text: '' }],
      [
        { type: 'tool-call', call: deleteRange('c1', 0, 3) },
        { type: 'done', text: 'trimmed the head' },
      ],
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(provider.calls).toBeGreaterThan(1);
    expect(events.some((e) => e.type === 'diff')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('gives up after the bounded retry when every attempt is empty', async () => {
    const provider = new ScriptedStreamProvider([[{ type: 'done', text: '' }]]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    // One attempt plus one retry, then an honest failure — never an unbounded loop.
    expect(provider.calls).toBe(2);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('empty response'),
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('never ends a run on a reply the provider says it cut off', async () => {
    // The captured run ended on the words "Rebuilding the 30 seconds as a 23-shot" with
    // nothing applied, and published that fragment as its final message.
    const provider = new ScriptedStreamProvider([
      [
        { type: 'text-delta', text: 'Rebuilding the 30 seconds as a 23-shot' },
        { type: 'done', text: 'Rebuilding the 30 seconds as a 23-shot', truncated: true },
      ],
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(provider.calls).toBe(2);
    expect(events.some((e) => e.type === 'warning' && /ran out of output room/.test(e.text))).toBe(
      true,
    );
    // The fragment is not the run's last word.
    expect(
      events.some(
        (e) => e.type === 'assistant_message' && /23-shot/.test((e as { text: string }).text),
      ),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('lets a truncated reply stand once work has landed', async () => {
    // A cut-off summary AFTER an edit is survivable: the edits are the deliverable, and
    // retrying would re-bill a turn that already did its job.
    const provider = new ScriptedStreamProvider([
      [
        { type: 'tool-call', call: deleteRange('c1', 0, 3) },
        { type: 'done', text: 'trimmed' },
      ],
      [
        { type: 'text-delta', text: 'and then I' },
        { type: 'done', text: 'and then I', truncated: true },
      ],
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(provider.calls).toBe(2);
    expect(events.some((e) => e.type === 'warning' && /ran out of output room/.test(e.text))).toBe(
      false,
    );
    expect(events.some((e) => e.type === 'diff')).toBe(true);
  });

  it('keeps applied edits when a LATER turn comes back empty', async () => {
    // The empty-response guard must not throw away work: an edit that already landed is
    // reviewable output, so the run warns and settles instead of failing wholesale.
    const events = await drain(
      new Orchestrator(
        new ScriptedProvider([
          { text: '', toolCalls: [deleteRange('c1', 0, 3)] },
          { text: '', toolCalls: [] },
        ]),
      ).streamAgent(input, opts()),
    );
    expect(events.some((e) => e.type === 'diff')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'warning' && /empty response/.test(e.text))).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('aborts to cancelled with no trailing diff — turns that never ran offer nothing', async () => {
    // ADR 0056: applyable output is the per-turn diffs, emitted as turns land. A run
    // aborted before any turn applied has emitted none — and the terminal path must
    // NOT add a combined diff (it would double-offer ops in runs that DID land turns).
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(input, opts(aborted())),
    );
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('emits one turn-scoped diff per applied turn, and no finalize diff (ADR 0056)', async () => {
    // Two editing turns → two live diffs (scope 'turn', 1-based turnIndex), each carrying
    // exactly that turn's ops so hosts can apply/review mid-run. The terminal boundary
    // adds NO combined diff — the per-turn diffs are the run's only applyable output.
    const provider = new ScriptedProvider([
      { text: 'first', toolCalls: [deleteRange('a', 0, 3)] },
      { text: 'second', toolCalls: [deleteRange('b', 8, 9)] },
      { text: 'done' },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    const diffs = events.filter((e) => e.type === 'diff');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ scope: 'turn', turnIndex: 1 });
    expect(diffs[1]).toMatchObject({ scope: 'turn', turnIndex: 2 });
    expect(diffs[0]?.type === 'diff' && diffs[0].edit.patch.operations).toHaveLength(1);
    expect(diffs[1]?.type === 'diff' && diffs[1].edit.patch.operations).toHaveLength(1);
    // Each turn's diff is valid against the working project its turn saw, so applying
    // them in order reproduces the full run.
    for (const d of diffs) expect(d.type === 'diff' && d.edit.validation.valid).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('advertises the bundled skills manifest in agent context and serves load_skill bodies (ADR 0057)', async () => {
    // A capturing provider proves the manifest tier reached the model, and the
    // scripted load_skill call proves the body round-trips as a read-tool result.
    const requests: AiCompletionRequest[] = [];
    const responses: AiResponse[] = [
      {
        text: 'reading the playbook',
        toolCalls: [{ id: 's1', name: 'load_skill', arguments: { name: 'keyframe-animation' } }],
      },
      { text: 'done' },
    ];
    let index = 0;
    const provider: AiProvider = {
      name: 'mock',
      complete: async (request: AiCompletionRequest) => {
        requests.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response as AiResponse;
      },
    };
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    // The manifest (name + description + load_skill instruction) is in the agent context.
    const contextText = (requests[0]?.messages ?? []).map((m) => m.content).join('\n');
    expect(contextText).toContain('call load_skill');
    expect(contextText).toContain('keyframe-animation');
    // The tool call ran as a read and returned the full body to the model.
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(
      toolResult?.type === 'tool_result' ? JSON.stringify(toolResult.result ?? '') : '',
    ).toContain('Keyframe animation');
    expect(
      events.some(
        (e) => e.type === 'tool_call' && e.toolName === 'load_skill' && e.status === 'completed',
      ),
    ).toBe(true);
    // `load_skill` is a read tool — no edit landed, so ADR 0081 ends the run `failed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  describe('ask_user — the model asks, the run waits (P12)', () => {
    const askCall = (args: Record<string, unknown>): AiResponse => ({
      text: 'I need to know something first',
      toolCalls: [{ id: 'ask1', name: 'ask_user', arguments: args }],
    });
    const question = {
      question: 'This footage has no faces to track. What would you like instead?',
      options: [
        { label: 'Punch in on the centre', description: 'A slow 110% push on each still.' },
        { label: 'Leave the framing alone' },
      ],
    };

    /** Answer the pending question as soon as the run blocks on it. */
    async function drainAnswering(
      stream: AsyncGenerator<AiEvent>,
      gate: ReturnType<typeof createAskUserGate>,
      answer: Parameters<typeof gate.resolve>[1],
    ): Promise<AiEvent[]> {
      let running = true;
      const resolver = (async () => {
        while (running) {
          gate.resolve('ask1', answer);
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      })();
      const out: AiEvent[] = [];
      for await (const event of stream) out.push(event);
      running = false;
      await resolver;
      return out;
    }

    it('surfaces the model’s own question and feeds the answer back into the run', async () => {
      const gate = createAskUserGate();
      const provider = new ScriptedProvider([askCall(question), { text: 'done' }]);
      const events = await drainAnswering(
        new Orchestrator(provider).streamAgent(input, opts(), {}, { askUser: gate }),
        gate,
        { kind: 'answered', answer: 'Punch in on the centre' },
      );

      // The question reaches the host verbatim — nothing about it is ours, which is what
      // lets a situation we never enumerated be asked about at all.
      const ask = events.find((e) => e.type === 'ask');
      expect(ask).toMatchObject({ toolCallId: 'ask1', question: question.question });
      expect(ask?.type === 'ask' && ask.options?.[0]?.label).toBe('Punch in on the centre');
      // The run honestly says it is stopped on a person, not "Reading…".
      expect(events.some((e) => e.type === 'status' && e.status === 'awaiting_answer')).toBe(true);
      // …and the ANSWER reaches the model's next turn.
      const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
      expect(secondTurn).toContain('Punch in on the centre');
      // Neither turn made an edit (`ask_user` then a plain "done") — ADR 0081 ends the
      // run `failed`, not `completed`.
      expect(events.at(-1)).toMatchObject({ status: 'failed' });
    });

    it('treats a dismissed question as a stop, never as an answer', async () => {
      const gate = createAskUserGate();
      const provider = new ScriptedProvider([askCall(question), { text: 'done' }]);
      const events = await drainAnswering(
        new Orchestrator(provider).streamAgent(input, opts(), {}, { askUser: gate }),
        gate,
        { kind: 'cancelled' },
      );
      expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
      // The model must not be told anything about what the editor "wanted".
      const secondTurn = JSON.stringify(provider.requests[1] ?? {});
      expect(secondTurn).not.toContain('answered');
    });

    it('degrades honestly — never inventing an answer — when nobody can be asked', async () => {
      // No askUser wired (a headless/parity run): the model is told plainly that it
      // cannot reach anyone and must disclose its assumption. Fabricating "the editor
      // said yes" is the worst possible outcome of asking.
      const provider = new ScriptedProvider([askCall(question), { text: 'done' }]);
      await drain(new Orchestrator(provider).streamAgent(input, opts()));
      const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
      expect(secondTurn).toContain('no way to reach them');
      expect(secondTurn).not.toContain('they answered');
    });

    it('fails the call — not the run — when the model malforms its question', async () => {
      const gate = createAskUserGate();
      const provider = new ScriptedProvider([
        askCall({ question: 'ok?', options: [{ label: 'only one' }] }), // min 2 options
        { text: 'done' },
      ]);
      const events = await drain(
        new Orchestrator(provider).streamAgent(input, opts(), {}, { askUser: gate }),
      );
      // No prompt is rendered from junk…
      expect(events.some((e) => e.type === 'ask')).toBe(false);
      // …the call fails its own card, and the run continues so the model can correct it.
      expect(
        events.some(
          (e) => e.type === 'tool_call' && e.toolName === 'ask_user' && e.status === 'failed',
        ),
      ).toBe(true);
      // The malformed `ask_user` call fails its own card and the run continues (that is
      // the point of this test), but neither turn ever lands an edit — ADR 0081 ends the
      // run `failed` overall, not `completed`.
      expect(events.at(-1)).toMatchObject({ status: 'failed' });
    });

    it('ignores an answer to a question that is no longer pending', async () => {
      // A stale answer must never satisfy the current question — the model would be
      // handed a reply to something it never asked.
      const gate = createAskUserGate();
      const seen: string[] = [];
      const pending = gate.requestAnswer('ask1', 'first?');
      void pending.then((a) => seen.push(a.kind === 'answered' ? a.answer : 'cancelled'));
      gate.resolve('some-other-call', { kind: 'answered', answer: 'wrong' });
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);
      gate.resolve('ask1', { kind: 'answered', answer: 'right' });
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(seen).toEqual(['right']);
    });
  });

  describe('visual grounding round-trip (MI6.3)', () => {
    // One evidence packet the mock engine returns for search_visual — the shape the
    // sidecar's unwrapVisualSearch settles ({ packets, backend }). The caption is what
    // the model must cite instead of guessing from the transcript.
    const productPacket = {
      assetId: 'asset_1',
      t0: 4,
      t1: 6,
      sceneId: 'scene_2',
      score: 0.91,
      caption: 'a hand holds up the product box to camera',
      transcriptOverlap: 'here is the product',
      sources: ['vector', 'caption'],
    };

    /** A host executor that answers ONLY search_visual, with one evidence packet. */
    class VisualSearchExecutor implements HostToolExecutor {
      public readonly calls: ToolCall[] = [];
      public async run(call: ToolCall): Promise<HostToolOutcome> {
        this.calls.push(call);
        if (call.name === 'search_visual') {
          return {
            status: 'completed',
            summary: 'Found 1 visual evidence packet',
            data: { packets: [productPacket], backend: 'clip' },
          };
        }
        throw new Error(`unexpected host tool ${call.name}`);
      }
    }

    it('search_visual → cite the evidence → edit → summary, with no re-search spin', async () => {
      // The whole retrieve-before-assume loop MI6.3 asks the contract to drive: the model
      // grounds a content-dependent request ("cut to the product shot") in search_visual,
      // the evidence is fed back into its next turn, it commits ONE edit citing it, and the
      // run ends — it never re-runs the search waiting for a better answer.
      const executor = new VisualSearchExecutor();
      const provider = new ScriptedProvider([
        {
          text: 'Finding the product shot',
          toolCalls: [{ id: 'v1', name: 'search_visual', arguments: { query: 'the product' } }],
        },
        {
          text: 'Cutting to the product box at 4–6s',
          toolCalls: [
            { id: 't1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 4 } },
          ],
        },
        { text: 'Done — cut to the product shot.' },
      ]);
      const events = await drain(
        new Orchestrator(provider, { executor }).streamAgent(input, opts(), { maxSteps: 3 }),
      );

      // 1) the visual search ran, and exactly once — no infinite re-search loop. (The
      // card streams running→completed, so the completed event is the settled one, and
      // the executor's own tally is the ground truth for how many searches actually ran.)
      const searchDone = events.filter(
        (e) => e.type === 'tool_call' && e.toolName === 'search_visual' && e.status === 'completed',
      );
      expect(searchDone).toHaveLength(1);
      expect(executor.calls.filter((c) => c.name === 'search_visual')).toHaveLength(1);

      // 2) the evidence packet reached the UI result card (full data, for the popup)…
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'v1');
      expect(JSON.stringify(result?.type === 'tool_result' ? (result.result ?? '') : '')).toContain(
        'the product box',
      );

      // 3) …and was fed back into the model's NEXT turn — the digest note carries the
      // caption, so the model cites real footage rather than inventing what is on screen.
      const secondTurn = (provider.requests[1]?.messages ?? []).map((m) => m.content).join('\n');
      expect(secondTurn).toContain('a hand holds up the product box');

      // 4) the run committed a real edit (the trim citing the packet's 4–6s window)…
      const diff = events.find((e) => e.type === 'diff');
      expect(diff?.type === 'diff' && diff.edit.patch.operations.length).toBeGreaterThan(0);
      // …the model's own terminal rationale was reached (it stopped calling tools)…
      const messages = events.filter((e) => e.type === 'assistant_message');
      expect(
        messages.some(
          (e) => e.type === 'assistant_message' && e.text === 'Done — cut to the product shot.',
        ),
      ).toBe(true);
      // …and the run terminated with a completion summary, not another search.
      const summary = messages.at(-1);
      expect(summary?.type === 'assistant_message' && summary.text).toMatch(/Applied 1 edit/);
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    });
  });

  it('pins a loaded playbook into every later turn, whole and exactly once (ADR 0057)', async () => {
    // Regression (the "agent loads skills forever, edits nothing" bug): load_skill's
    // result was fed to the model through the generic read-preview path, which
    // JSON-escaped a ~3 KB playbook and sliced it at 1200 chars — about a third,
    // mid-sentence. The model never received the craft instructions it asked for,
    // re-called load_skill every turn to try again, and the Conductor's no-progress
    // guard ended the run with zero edits. The pre-existing test above asserts only that
    // the body reached the UI popup (`tool_result.result`) — never the MODEL's messages —
    // which is exactly how this shipped. So assert on what the model actually reads.
    const { BUNDLED_SKILLS } = await import('./skills.js');
    const skill = BUNDLED_SKILLS.find((s) => s.name === 'keyframe-animation');
    const other = BUNDLED_SKILLS.find((s) => s.name === 'color-grading');
    if (!skill || !other) throw new Error('fixture skills missing');

    const requests: AiCompletionRequest[] = [];
    // Mirrors the real transcript: load a skill, then next turn load another one AND
    // re-load the first. (An exact whole-turn repeat is already stopped by the
    // Conductor's signature guard, so the realistic spin varies which skills each turn.)
    const responses: AiResponse[] = [
      {
        text: 'reading the playbook',
        toolCalls: [{ id: 's1', name: 'load_skill', arguments: { name: 'keyframe-animation' } }],
      },
      {
        text: 'reading more',
        toolCalls: [
          { id: 's2', name: 'load_skill', arguments: { name: 'color-grading' } },
          { id: 's3', name: 'load_skill', arguments: { name: 'keyframe-animation' } },
        ],
      },
      { text: 'done' },
    ];
    let index = 0;
    const provider: AiProvider = {
      name: 'mock',
      complete: async (request: AiCompletionRequest) => {
        requests.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response as AiResponse;
      },
    };
    await drain(new Orchestrator(provider).streamAgent(input, opts()));

    const textOf = (i: number): string =>
      (requests[i]?.messages ?? []).map((m) => m.content).join('\n');
    // Turn 1 asked for the skill; turn 2 must actually HAVE it — the whole body, not a
    // truncated fragment. This is the assertion the old preview path could never pass.
    expect(textOf(0)).not.toContain(skill.body);
    expect(textOf(1)).toContain(skill.body);
    // Both playbooks are pinned by turn 3, each exactly once: a body is never re-pasted
    // per load, so a run that loads several skills does not multiply KB of duplicated
    // prompt every turn.
    expect(textOf(2).split(skill.body).length - 1).toBe(1);
    expect(textOf(2).split(other.body).length - 1).toBe(1);
    // ...and the re-load is answered by pointing at the pinned copy, not re-fetching it.
    expect(textOf(2)).toContain('already loaded earlier this run');
  });

  it('bounds how many playbooks one run pins, refusing honestly (ADR 0057)', async () => {
    // A pinned body rides in every later turn, so the pin is bounded (MAX_PINNED_SKILLS)
    // like every other budget here — by whole records with an explicit refusal, never a
    // silent mid-body cut. Load 9 distinct skills across two turns; the 9th is refused.
    const { BUNDLED_SKILLS } = await import('./skills.js');
    const names = BUNDLED_SKILLS.slice(0, 9).map((s) => s.name);
    expect(names).toHaveLength(9);

    const requests: AiCompletionRequest[] = [];
    let index = 0;
    const provider: AiProvider = {
      name: 'mock',
      complete: async (request: AiCompletionRequest) => {
        requests.push(request);
        index += 1;
        if (index > 2) return { text: 'done' } as AiResponse;
        // Turn 1 loads 8 (the cap); turn 2 asks for a 9th.
        const batch = index === 1 ? names.slice(0, 8) : names.slice(8);
        return {
          text: 'loading',
          toolCalls: batch.map((name, i) => ({
            id: `s${index}_${i}`,
            name: 'load_skill',
            arguments: { name },
          })),
        } as AiResponse;
      },
    };
    await drain(new Orchestrator(provider).streamAgent(input, opts(), { autoRepair: false }));

    const third = (requests[2]?.messages ?? []).map((m) => m.content).join('\n');
    // The 9th was refused with an honest, actionable reason...
    expect(third).toContain('which is the limit');
    // ...the first 8 are all still pinned, whole...
    for (const name of names.slice(0, 8)) {
      const body = BUNDLED_SKILLS.find((s) => s.name === name)?.body ?? '';
      expect(third).toContain(body);
    }
    // ...and the refused 9th's body never entered the context.
    const ninth = BUNDLED_SKILLS.find((s) => s.name === names[8])?.body ?? '';
    expect(third).not.toContain(ninth);
  });

  it('keeps a pinned playbook past the action log window (ADR 0057)', async () => {
    // The action log feeds back only the last AGENT_LOG_RECENT (6) steps. A body left in
    // the log would age out mid-run — so a long run would lose the craft it paid a turn
    // for, and re-load it. Pinning is what makes load_skill a once-per-run cost.
    const { BUNDLED_SKILLS } = await import('./skills.js');
    const skill = BUNDLED_SKILLS.find((s) => s.name === 'keyframe-animation');
    if (!skill) throw new Error('fixture skill missing');

    const requests: AiCompletionRequest[] = [];
    let index = 0;
    const provider: AiProvider = {
      name: 'mock',
      complete: async (request: AiCompletionRequest) => {
        requests.push(request);
        index += 1;
        // Turn 1 loads the skill; every later turn lands a REAL edit (which resets the
        // no-progress streak, so the run keeps going) until the log window overflows.
        if (index === 1) {
          return {
            text: 'load',
            toolCalls: [
              { id: 's1', name: 'load_skill', arguments: { name: 'keyframe-animation' } },
            ],
          } as AiResponse;
        }
        return {
          text: 'trimming',
          toolCalls: [
            {
              id: `t${index}`,
              // A distinct, valid trim each turn: real ops, never a repeated signature.
              name: 'trim_clip',
              arguments: { clipId: 'clip_a', start: 0, end: 6 - index * 0.1 },
            },
          ],
        } as AiResponse;
      },
    };
    await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 9, autoRepair: false }),
    );

    const last = (requests.at(-1)?.messages ?? []).map((m) => m.content).join('\n');
    // The run really did outlive the log window: the log itself says it compacted
    // earlier steps away...
    expect(requests.length).toBeGreaterThan(7);
    expect(last).toContain('earlier step');
    // ...yet the turn-1 playbook is still there, whole, because it is pinned rather than
    // left in the rolling log.
    expect(last).toContain(skill.body);
  });

  it('honours a caller-supplied skills manifest instead of defaulting to the bundle', async () => {
    // ADR 0057: ContextInput.skills overrides the zero-wiring BUNDLED_SKILLS default —
    // a caller-supplied manifest reaches context as-is, never silently replaced.
    const requests: AiCompletionRequest[] = [];
    const provider: AiProvider = {
      name: 'mock',
      complete: async (request: AiCompletionRequest) => {
        requests.push(request);
        return { text: 'done' };
      },
    };
    const customSkills = [
      {
        name: 'custom-skill',
        description: 'A caller-supplied playbook.',
        tools: [],
        body: 'do it',
      },
    ];
    await drain(new Orchestrator(provider).streamAgent({ ...input, skills: customSkills }, opts()));
    const contextText = (requests[0]?.messages ?? []).map((m) => m.content).join('\n');
    expect(contextText).toContain('custom-skill');
    expect(contextText).not.toContain('keyframe-animation');
  });

  it('scopes reasoning per step (distinct ids, interleaved) and never duplicates tool intents into it', async () => {
    // Two steps: an edit turn, then a done turn. Each step gets its OWN reasoning node so
    // thinking blocks stay ordered and never overwrite one another (the reported bug).
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [editCall] },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const reasonings = events.filter((e) => e.type === 'reasoning');
    // Per-step ids, keyed by step index — NOT a single per-run node the later step clobbers.
    const ids = new Set(reasonings.map((e) => e.id));
    expect(ids.size).toBeGreaterThan(1);
    for (const id of ids) expect(id).toMatch(/:reasoning:\d+$/);
    // Reasoning is the model's thinking, never the tool intent — the intent lives on the
    // tool card, so the two never duplicate.
    expect(
      reasonings.every(
        (e) => e.type === 'reasoning' && !e.summaries.includes('Deleting a range on Video 1'),
      ),
    ).toBe(true);
    // An unplanned run emits no pinned checklist.
    expect(events.some((e) => e.type === 'plan')).toBe(false);
  });

  it('never fabricates an edit for a read-only step (no diff, no timeline_action)', async () => {
    // Inspection can gather useful context, but it is not evidence that a timeline edit
    // landed. A read-only turn must not emit a diff or an action card. (The plan-step
    // "stays running until a validated patch applies" rule is covered by the reducer
    // unit tests — an unplanned run emits no checklist at all.)
    const provider = new FakeProvider({
      text: '',
      toolCalls: [{ id: 'r', name: 'get_timeline', arguments: {} }],
    });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.some((e) => e.type === 'timeline_action')).toBe(false);
    expect(events.some((e) => e.type === 'plan')).toBe(false);
  });

  it('explains an empty run (no card) and emits no timeline_action for a rejected op', async () => {
    // A trim that overlaps its neighbour is rejected by the validator: the turn never
    // applies, so NO diff is emitted at all (ADR 0056). The run must then (a) NOT
    // claim "Trimmed clip" for an edit that did not land, and (b) explain why nothing
    // applied — the failure the user reported (activity everywhere, no card, no reason).
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: '1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 8 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(events.some((e) => e.type === 'timeline_action')).toBe(false);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.some((e) => e.type === 'warning' && /No edits were applied/.test(e.text))).toBe(
      true,
    );
  });

  it('pluralizes the empty-run explanation when a turn rejects more than one op', async () => {
    const provider = new ScriptedProvider([
      {
        text: '',
        toolCalls: [
          { id: '1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 8 } },
          { id: '2', name: 'trim_clip', arguments: { clipId: 'clip_b', start: 0, end: 8 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(
      events.some(
        (e) => e.type === 'warning' && /2 proposed changes couldn't be applied/.test(e.text),
      ),
    ).toBe(true);
  });

  it('marks a step failed with an error detail when its tool call is rejected', async () => {
    // A genuinely rejected mutating call (missing required arg) → cross + hover detail (#4).
    const provider = new FakeProvider({
      text: '',
      toolCalls: [{ id: 'x', name: 'add_transition', arguments: { trackId: 'video_1' } }],
    });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    // Unplanned run: the rejection is visible on the tool card itself (failed + detail),
    // not a pinned plan row. Nothing is fabricated — no diff, no checklist.
    const toolCalls = events.filter((e) => e.type === 'tool_call' && e.id === 'x');
    expect(toolCalls.some((e) => e.type === 'tool_call' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.some((e) => e.type === 'plan')).toBe(false);
  });

  it('names a hallucinated extra arg key on a mutating call instead of stripping it', async () => {
    // Junk keys used to be stripped so the edit would still apply. That also silently
    // discarded meaning-bearing arguments, so the model was told a call it never made
    // had succeeded. The run now reports the offending key and applies no edit, which
    // is the only feedback a model can actually correct from. See ADR 0107.
    const provider = new FakeProvider({
      text: '',
      toolCalls: [
        {
          id: 'e',
          name: 'delete_range',
          arguments: { trackId: 'video_1', start: 0, end: 3, action: 'delete', projectId: 'p1' },
        },
      ],
    });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const diff = events.find((e) => e.type === 'diff');
    expect(diff?.type === 'diff' && diff.edit.patch.operations.length).toBeFalsy();
    expect(JSON.stringify(events)).toMatch(/Unrecognized keys?: /);
  });

  it('ends in a terminal failed status (not stuck) when a provider throws mid-run', async () => {
    // A thrown provider/network error must settle the run: an error notice, reasoning
    // marked done (shimmer stops), and a terminal `failed` status (header spinner clears).
    class ThrowingProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        throw new Error('network exploded');
      }
    }
    const events = await drain(new Orchestrator(new ThrowingProvider()).streamAgent(input, opts()));
    expect(events.some((e) => e.type === 'error' && /network exploded/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'reasoning' && e.done)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('settles with a generic message when a non-Error value is thrown mid-run', async () => {
    class ThrowNonError implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        throw 'not-an-error-object';
      }
    }
    const events = await drain(new Orchestrator(new ThrowNonError()).streamAgent(input, opts()));
    expect(events.some((e) => e.type === 'error' && /failed unexpectedly/.test(e.message))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('streams mid-run text into its OWN assistant segment, not reasoning (U1)', async () => {
    // Between-tools narration interleaves with tool cards as a NEW assistant node
    // per turn (Cursor-style); the reasoning node never absorbs chat text.
    const provider = new FakeProvider({
      text: 'Splitting the intro to tighten the pacing',
      toolCalls: [editCall],
    });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const segment = events.find(
      (e) =>
        e.type === 'assistant_message' &&
        e.id.includes(':seg-') &&
        e.text === 'Splitting the intro to tighten the pacing',
    );
    expect(segment).toBeDefined();
    // The live deltas streamed into that same segment node id.
    expect(events.some((e) => e.type === 'assistant_delta' && e.parentId === segment?.id)).toBe(
      true,
    );
    // Reasoning keeps only actual thinking — the narration is NOT folded into it.
    const reasonings = events.filter((e) => e.type === 'reasoning');
    expect(
      reasonings.every(
        (e) => e.type === 'reasoning' && !e.summaries.some((s) => s.includes('Splitting')),
      ),
    ).toBe(true);
  });

  it('settles the "Thinking…" shimmer at first model output (Thought for Ns, U3)', async () => {
    const provider = new FakeProvider({ text: 'hello', toolCalls: [] });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    // The reasoning node settles (done) BEFORE the closing assistant message —
    // the shimmer never spins alongside settled output.
    const doneIdx = events.findIndex((e) => e.type === 'reasoning' && e.done);
    const messageIdx = events.findIndex((e) => e.type === 'assistant_message');
    expect(doneIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeLessThan(messageIdx);
  });

  it('carries a compact argsSummary on tool cards (U4)', async () => {
    const provider = new FakeProvider({ text: 'edit', toolCalls: [editCall] });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const running = events.find((e) => e.type === 'tool_call' && e.status === 'running');
    expect(running?.type === 'tool_call' && running.argsSummary).toBe(
      'trackId: "video_1", start: 0, end: 3',
    );
  });

  it('truncates a long argsSummary so the card line stays bounded (U4)', async () => {
    const longCall = {
      id: 'c',
      name: 'add_text_layer',
      arguments: {
        text: 'x'.repeat(200),
        style: 'bold-white-caption-extra-large',
        trackId: 'video_1',
        start: 0,
        end: 2,
      },
    };
    const provider = new FakeProvider({ text: 'edit', toolCalls: [longCall] });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const running = events.find((e) => e.type === 'tool_call' && e.status === 'running');
    const summary = running?.type === 'tool_call' ? (running.argsSummary ?? '') : '';
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(81);
  });

  it('caps the completion report at 10 lines and reports skipped work (U3)', () => {
    // Twelve DISTINCT edits — the cap is about how many different things a report will list.
    // (Identical edits collapse instead; that is the next test.)
    const ops = Array.from({ length: 12 }, (_, i) => ({
      type: 'delete_range',
      trackId: 'video_1',
      start: i,
      end: i + 0.5,
    })) as unknown as AnyOperation[];
    const report = agentCompletionReport({
      ops,
      steps: 3,
      rejectedOpCount: 2,
      rejectionReasons: ['overlaps a neighbour'],
    });
    expect(report).toMatch(/\*\*Applied 12 edits\*\* in 3 steps/);
    expect(report).toMatch(/…and 2 more/);
    expect(report).toMatch(
      /\*\*Skipped:\*\* 2 proposed changes did not validate \(overlaps a neighbour\)/,
    );
  });

  it('collapses edits that read identically instead of repeating the line', () => {
    // The captured caption run closed with eight rows of "Set track caption style:" — the
    // same sentence eight times, over a dangling colon. Eight restyles of one track are ONE
    // outcome to the editor reviewing it: the last one is what they see.
    const ops = Array.from({ length: 8 }, () => ({
      type: 'set_track_caption_style',
      trackId: 'caption_1',
    })) as unknown as AnyOperation[];
    const report = agentCompletionReport({
      ops,
      steps: 8,
      rejectedOpCount: 0,
      rejectionReasons: [],
    });
    expect(report).toMatch(/\*\*Applied 8 edits\*\* in 8 steps/);
    expect(report).toContain('(×8)');
    // One row, not eight — and no line ends in a colon over nothing.
    expect(report.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(report).not.toMatch(/:\s*$/m);
  });

  it('points at Export when the request asked for a file the panel cannot render', () => {
    const report = agentCompletionReport({
      ops: [{ type: 'delete_range', trackId: 'video_1' } as unknown as AnyOperation],
      steps: 1,
      rejectedOpCount: 0,
      rejectionReasons: [],
      deliverableFileRequested: true,
    });
    expect(report).toContain('cannot produce');
    expect(report).toContain('Export dialog');
    // Silent when nothing was asked for — no unsolicited advice on an ordinary edit.
    expect(
      agentCompletionReport({
        ops: [{ type: 'delete_range', trackId: 'video_1' } as unknown as AnyOperation],
        steps: 1,
        rejectedOpCount: 0,
        rejectionReasons: [],
      }),
    ).not.toContain('Export dialog');
  });

  it('says so when a montage was chosen with nothing read about the footage', () => {
    // The captured run picked nine source spans out of 575 seconds having read nothing about
    // the content, and told the editor the choices came from "the footage map" — which it had
    // never asked for. The edit still stands; the editor is told what it was based on.
    const addClips = Array.from({ length: 4 }, (_, i) => ({
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'a1',
      start: i * 3,
      end: i * 3 + 3,
      sourceStart: i * 30,
      sourceEnd: i * 30 + 3,
    })) as unknown as AnyOperation[];
    const blind = agentCompletionReport({
      ops: addClips,
      steps: 1,
      rejectedOpCount: 0,
      rejectionReasons: [],
      contentEvidence: false,
    });
    expect(blind).toContain('chosen from timings alone');
    expect(blind).toContain('footage map');

    // Evidence gathered ⇒ no caveat.
    expect(
      agentCompletionReport({
        ops: addClips,
        steps: 1,
        rejectedOpCount: 0,
        rejectionReasons: [],
        contentEvidence: true,
      }),
    ).not.toContain('chosen from timings alone');

    // A small trim is not a montage — no caveat for one or two clips.
    expect(
      agentCompletionReport({
        ops: addClips.slice(0, 2),
        steps: 1,
        rejectedOpCount: 0,
        rejectionReasons: [],
        contentEvidence: false,
      }),
    ).not.toContain('chosen from timings alone');

    // A caller that does not track evidence at all is unchanged.
    expect(
      agentCompletionReport({ ops: addClips, steps: 1, rejectedOpCount: 0, rejectionReasons: [] }),
    ).not.toContain('chosen from timings alone');
  });

  it('uses singular wording for exactly one skipped change', () => {
    const report = agentCompletionReport({
      ops: [{ type: 'delete_range', trackId: 'video_1' } as unknown as AnyOperation],
      steps: 1,
      rejectedOpCount: 1,
      rejectionReasons: ['overlaps a neighbour'],
    });
    expect(report).toMatch(/\*\*Skipped:\*\* 1 proposed change did not validate/);
  });

  it('closes an applying run with a markdown completion report (U3)', async () => {
    const provider = new ScriptedProvider([
      { text: 'cutting', toolCalls: [deleteRange('c1', 0, 3)] },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const report = events.filter((e) => e.type === 'assistant_message').at(-1);
    expect(report?.type === 'assistant_message' && report.text).toMatch(/\*\*Applied 1 edit\*\*/);
    expect(report?.type === 'assistant_message' && report.text).toMatch(/^- Deleted/m);
    // The report follows the reviewable diff so the two read as one closing unit.
    const diffIdx = events.findIndex((e) => e.type === 'diff');
    expect(events.indexOf(report as AiEvent)).toBeGreaterThan(diffIdx);
  });

  it('continues past a pure-inspection turn (read tools make no edit)', async () => {
    const provider = new FakeProvider({
      text: 'look',
      toolCalls: [{ id: 'r', name: 'get_timeline', arguments: {} }],
    });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 2 }),
    );
    // Two inspection steps run (no break), then the loop hits the step cap.
    expect(events.filter((e) => e.type === 'tool_call' && e.status === 'running')).toHaveLength(2);
    // Read-only inspection never lands an edit — ADR 0081 ends the run `failed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('does not halt on a single no-op turn, but stops when it spins (repeats it)', async () => {
    // A non-read turn that yields no ops (here an unknown tool) no longer aborts the
    // run after step 1 — that was the bug where a no-op "organize" killed the whole
    // edit. The model gets another turn; only when it repeats the same no-progress
    // call (spinning) does the loop stop.
    //
    // Two steps. It was three while the Conductor's `stageAdvanced` was an object
    // comparison that missed turn 1's real interpret → inspect advance: the run was
    // credited with no progress, tripped the meaningful-progress guard on turn 2, and
    // spent a deterministic recovery turn before giving up. Turn 1 genuinely advanced a
    // stage, so no-progress does not start accruing there, and turn 2 — the identical
    // call again — is caught by the exact-repeat guard instead. Same outcome (`failed`,
    // no edit), one fewer wasted turn. The recovery push itself is unchanged and still
    // fires for the run it exists for: one that keeps gathering without editing.
    const provider = new FakeProvider({
      text: 'try',
      toolCalls: [{ id: 'u', name: 'no_such_tool', arguments: {} }],
    });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 5 }),
    );
    expect(events.filter((e) => e.type === 'tool_call' && e.status === 'running')).toHaveLength(2);
    // An unknown no-op tool never lands an edit — ADR 0081 ends the run `failed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('defaults the clock when absent; a run that never edits emits no diff', async () => {
    const bare: ContextInput = { project: makeProject(), userPrompt: '' };
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'done' })).streamAgent(bare, {
        conversationId: 'conv_2',
        turnId: 'turn_2',
      }),
    );
    // Never edits — ADR 0081 ends the run `failed`, not `completed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(events.some((e) => e.type === 'diff')).toBe(false);
  });

  it('breaks when the signal trips during a step (not just at the loop top)', async () => {
    const controller = new AbortController();
    const provider = new AbortingProvider(controller, { text: 'x' });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, { ...opts(), signal: controller.signal }),
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });
});

/**
 * The wipe guard (agent-continuity backstop, see wipe-guard.ts) must actually
 * reject a full-track wipe when it reaches the agent loop, not just when called
 * directly in isolation — otherwise a "start over" call would sail straight
 * through `runAgentCall` uncaught.
 */
describe('streamAgent wipe guard (agent continuity)', () => {
  it('rejects a call that would ripple_delete every clip on a multi-clip track', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'starting over',
        toolCalls: [
          { id: 'w1', name: 'ripple_delete', arguments: { trackId: 'video_1', start: 0, end: 10 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 'w1').at(-1);
    expect(terminal).toMatchObject({ status: 'failed' });
    const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'w1');
    expect(result?.type === 'tool_result' ? result.summary : '').toMatch(
      /would wipe existing work/,
    );
    // No op from the rejected call reached the applied diff.
    const diff = events.find((e) => e.type === 'diff');
    expect(diff?.type === 'diff' ? diff.ops : []).toHaveLength(0);
  });

  it('lets the same wipe through when the user prompt itself asked for a reset', async () => {
    const resetInput: ContextInput = { ...input, userPrompt: 'delete everything and start over' };
    const provider = new ScriptedProvider([
      {
        text: 'clearing it',
        toolCalls: [
          { id: 'w2', name: 'ripple_delete', arguments: { trackId: 'video_1', start: 0, end: 10 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(resetInput, opts()));
    const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 'w2').at(-1);
    expect(terminal).toMatchObject({ status: 'completed' });
  });
});

/**
 * The streaming agent must match the non-streaming `agent()`: an up-front plan
 * (planFirst), blast-radius caps, a bounded Critic-driven repair pass, and a
 * surfaced self-check. These close the gap where the app (which uses streamAgent
 * exclusively) ran a weaker agent than `agent()`.
 */
describe('streamAgent robustness (parity with agent())', () => {
  it('planFirst drafts + surfaces an up-front plan and keeps running', async () => {
    // MockProvider's non-editing completion returns one line → a single plan step.
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(input, opts(), { planFirst: true }),
    );
    expect(events.some((e) => e.type === 'status' && e.status === 'planning')).toBe(true);
    // U2: the drafted plan is the live todo ledger — emitted as a plan node with
    // every step `pending` BEFORE any work starts, not a reasoning one-liner.
    const firstPlan = events.find((e) => e.type === 'plan');
    expect(firstPlan?.type === 'plan' && firstPlan.steps).toHaveLength(1);
    expect(firstPlan?.type === 'plan' && firstPlan.steps[0]?.status).toBe('pending');
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('planFirst seeds a pending ledger and flips steps to running with the turn intent (U2)', async () => {
    const provider = new ScriptedProvider([
      { text: 'Trim the intro\nAdd captions\nBalance the audio' }, // plan turn → 3 steps
      { text: 'working', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done' }, // loop ends
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { planFirst: true }),
    );
    const plans = events.filter((e) => e.type === 'plan');
    // Ledger appears first with all three steps pending, keeping the plan's own labels.
    expect(plans[0]?.type === 'plan' && plans[0].steps.map((s) => s.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(plans[0]?.type === 'plan' && plans[0].steps[0]?.label).toBe('Trim the intro');
    // Turn 1 maps onto ledger step 1: running, with the derived intent as detail —
    // the label stays the planned text (the intent supplements, never replaces).
    const running = plans.find((e) => e.type === 'plan' && e.steps[0]?.status === 'running');
    expect(running?.type === 'plan' && running.steps[0]).toMatchObject({
      label: 'Trim the intro',
      detail: 'Reading the timeline',
    });
    // Read-only work cannot check off a drafted edit; later steps stay pending.
    const lastPlan = plans.at(-1);
    expect(lastPlan?.type === 'plan' && lastPlan.steps[0]?.status).toBe('running');
    expect(lastPlan?.type === 'plan' && lastPlan.steps[2]?.status).toBe('pending');
  });

  it('continues an unfinished drafted plan when the model declares done too early', async () => {
    const provider = new ScriptedProvider([
      { text: 'Build the first half\nFinish the full montage' },
      { text: 'first batch', toolCalls: [deleteRange('first', 0, 1)] },
      { text: 'done' },
      { text: 'finishing the remaining deliverable', toolCalls: [deleteRange('second', 8, 9)] },
      { text: 'done' },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        planFirst: true,
        autoRepair: false,
      }),
    );

    expect(provider.requests).toHaveLength(5);
    expect(
      events.some(
        (event) => event.type === 'notification' && event.text.includes('unfinished work'),
      ),
    ).toBe(true);
    const recoveryRequest = provider.requests[3]!;
    expect(recoveryRequest.tools?.map((tool) => tool.name)).toContain('delete_range');
    expect(recoveryRequest.tools?.map((tool) => tool.name)).not.toContain('get_timeline');
    const lastPlan = events.filter((event) => event.type === 'plan').at(-1);
    expect(
      lastPlan?.type === 'plan' && lastPlan.steps.every((step) => step.status === 'completed'),
    ).toBe(true);
    expect(events.filter((event) => event.type === 'diff')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('routes plan-draft prose (intro + question) to chat, keeping the todo clean (U2)', async () => {
    const provider = new ScriptedProvider([
      {
        text: "Sure! Here's my plan:\n1. Trim the intro\n2. Add captions\nWould you like me to proceed?",
      },
      { text: 'done' }, // loop ends
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { planFirst: true }),
    );
    // The todo ledger holds ONLY the two actionable steps — no intro, no question row.
    const firstPlan = events.find((e) => e.type === 'plan');
    expect(firstPlan?.type === 'plan' && firstPlan.steps.map((s) => s.label)).toEqual([
      'Trim the intro',
      'Add captions',
    ]);
    expect(
      firstPlan?.type === 'plan' && firstPlan.steps.some((s) => s.label.includes('proceed')),
    ).toBe(false);
    // The intro + question are surfaced as a chat message, not a checklist row.
    const proseMsg = events.find(
      (e) => e.type === 'assistant_message' && e.text.includes('Would you like me to proceed?'),
    );
    expect(proseMsg?.type === 'assistant_message' && proseMsg.text).toContain(
      "Sure! Here's my plan",
    );
  });

  it('planFirst is skipped when the run is already aborted', async () => {
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(input, opts(aborted()), { planFirst: true }),
    );
    // Aborted before planning → no planning status, terminal cancelled.
    expect(events.some((e) => e.type === 'status' && e.status === 'planning')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('planFirst with an empty plan pauses for integrity review, never runs unplanned (RSI1)', async () => {
    // An empty drafted plan used to fall through to unplanned single-turn execution.
    // RSI1 treats it as a genuine integrity failure instead: `commitExecutionPlan`
    // refuses to commit zero decisions, so nothing is authorized to run — a plan the
    // run cannot execute is a promise the UI would otherwise break.
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: '' })).streamAgent(input, opts(), {
        planFirst: true,
      }),
    );
    expect(events.some((e) => e.type === 'status' && e.status === 'planning')).toBe(true);
    // No steps drafted → no pending-ledger plan node is emitted.
    expect(
      events.some((e) => e.type === 'plan' && e.steps.some((s) => s.status === 'pending')),
    ).toBe(false);
    expect(
      events.some((e) => e.type === 'warning' && e.text.includes('no executable decisions')),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('rejects a turn that exceeds the per-turn op cap (blast-radius, R3 C1)', async () => {
    const provider = new FakeProvider({ text: 'big', toolCalls: [editCall] });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxOpsPerTurn: 0 }),
    );
    expect(events.some((e) => e.type === 'warning' && e.text.includes('per-turn cap'))).toBe(true);
    // The rejected turn is not applied → it emits no diff (ADR 0056).
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    // The turn DID attempt an edit and lost it wholesale — ADR 0081: completion requires
    // a successful traceable operation, so a run that only ever produced a rejected,
    // wholesale-capped turn ends `failed`, not `completed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('stops once the per-run op cap is reached (blast-radius, R3 C1)', async () => {
    const provider = new FakeProvider({ text: 'edit', toolCalls: [editCall] });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxOpsPerRun: 1 }),
    );
    expect(events.some((e) => e.type === 'notification' && e.text.includes('per-run cap'))).toBe(
      true,
    );
  });

  it('surfaces the Critic self-check as a notice + per-failure warnings', async () => {
    // Apply a real edit first: a Critic verdict is intentionally not shown for an
    // empty run. A 1s duration target the edited fixture cannot meet then fails.
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [deleteRange('a', 0, 1)] },
      { text: 'done' },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        durationTargetSeconds: 1,
        autoRepair: false,
      }),
    );
    expect(
      events.some(
        (e) => e.type === 'notification' && e.text.startsWith('Deterministic self-check:'),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'warning' && e.text.includes('Duration'))).toBe(true);
    // autoRepair:false → no repair pass runs.
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith('Repair pass'))).toBe(
      false,
    );
  });

  it('runs one bounded repair pass that applies a fix, then re-checks (R3 C3)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] }, // turn 1 applies
      { text: 'done' }, // turn 2 ends the loop
      { text: 'fix', toolCalls: [deleteRange('b', 8, 9)] }, // repair applies a new op
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        durationTargetSeconds: 1,
        maxSteps: 3,
      }),
    );
    expect(provider.requests).toHaveLength(3);
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith('Repair pass'))).toBe(
      true,
    );
    // Both the loop edit and the repair edit surface as action cards.
    expect(events.filter((e) => e.type === 'timeline_action').length).toBeGreaterThanOrEqual(2);
    // ADR 0056: the loop turn AND the repair pass each emit their own turn-scoped diff.
    const diffs = events.filter((e) => e.type === 'diff');
    expect(diffs).toHaveLength(2);
    for (const d of diffs) expect(d).toMatchObject({ scope: 'turn' });
    const totalOps = diffs.reduce(
      (n, d) => n + (d.type === 'diff' ? d.edit.patch.operations.length : 0),
      0,
    );
    expect(totalOps).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('does not run a repair pass when the model cannot propose a fix', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] }, // turn 1 applies
      { text: 'done' }, // turn 2 ends the loop
      { text: 'cannot fix that' }, // repair pass proposes no tool → no repair
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        durationTargetSeconds: 1,
        maxSteps: 3,
      }),
    );
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith('Repair pass'))).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('settles as cancelled (not failed) when Stop aborts the up-front plan call', async () => {
    const controller = new AbortController();
    // A plan `complete()` that only settles when its signal aborts — proving the
    // run's signal is threaded through (before the fix this call was uncancellable).
    const provider: AiProvider = {
      name: 'mock',
      complete: (_request: AiCompletionRequest, signal?: AbortSignal) =>
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
          // Stop is pressed while the plan call is in flight.
          controller.abort();
        }),
    };
    const events = await drain(
      new Orchestrator(provider).streamAgent(
        input,
        { ...opts(), signal: controller.signal },
        { planFirst: true },
      ),
    );
    // The abort is a cancellation, not a failure: no error card, terminal cancelled.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('threads the run signal into every complete() call, including the repair pass', async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const responses: AiResponse[] = [
      { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] }, // turn 1 applies
      { text: 'done' }, // turn 2 ends the loop
      { text: 'fix', toolCalls: [deleteRange('b', 8, 9)] }, // repair pass
    ];
    let index = 0;
    const provider: AiProvider = {
      name: 'mock',
      complete: async (_request: AiCompletionRequest, signal?: AbortSignal) => {
        signals.push(signal);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response as AiResponse;
      },
    };
    const events = await drain(
      new Orchestrator(provider).streamAgent(
        input,
        { ...opts(), signal: controller.signal },
        { durationTargetSeconds: 1, maxSteps: 3 },
      ),
    );
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(signals.every((s) => s === controller.signal)).toBe(true);
  });

  it('emits no self-check when the run is cancelled (partial)', async () => {
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(input, opts(aborted()), {
        durationTargetSeconds: 1,
      }),
    );
    expect(
      events.some(
        (e) => e.type === 'notification' && e.text.startsWith('Deterministic self-check:'),
      ),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });
});

/**
 * P11.3 plan-approval gate + P11.4 mid-run steering
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md). Both are wired through the fourth,
 * execution-only `controls` parameter (`run-controls.ts`) — never through
 * `agentOptions`/`Command`, which stay plain serialisable data.
 */
describe('streamAgent plan-approval gate (P11.3)', () => {
  /**
   * Resolve the pending approval once the run actually reaches it. `gate.resolve` is a
   * no-op while no request is pending, so a background loop can safely retry every
   * macrotask tick — this avoids depending on exactly which microtask the generator's
   * internal `await controls.planApproval.requestApproval(...)` lands on.
   */
  async function drainWithApproval(
    stream: AsyncGenerator<AiEvent>,
    gate: ReturnType<typeof createPlanApprovalGate>,
    decision: 'approved' | 'cancelled',
  ): Promise<AiEvent[]> {
    let running = true;
    const resolver = (async () => {
      while (running) {
        gate.resolve(decision);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    })();
    const out: AiEvent[] = [];
    for await (const event of stream) out.push(event);
    running = false;
    await resolver;
    return out;
  }

  it('does not gate a small (<= threshold) plan even with requirePlanApproval set', async () => {
    const gate = createPlanApprovalGate();
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(
        input,
        opts(),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
    );
    // MockProvider's plan draft is a single line → 1 step, well under the threshold.
    expect(events.some((e) => e.type === 'status' && e.status === 'awaiting_approval')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('pauses at awaiting_approval for a high-blast-radius plan, then runs once approved', async () => {
    const gate = createPlanApprovalGate();
    const provider = new ScriptedProvider([
      { text: overThresholdPlanText }, // over threshold → gated
      { text: 'done' },
    ]);
    const events = await drainWithApproval(
      new Orchestrator(provider).streamAgent(
        input,
        opts(),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
      gate,
      'approved',
    );
    expect(events.some((e) => e.type === 'status' && e.status === 'awaiting_approval')).toBe(true);
    // The plan was surfaced before the pause; the turn ran only after approval.
    const awaitingIdx = events.findIndex(
      (e) => e.type === 'status' && e.status === 'awaiting_approval',
    );
    const assistantIdx = events.findIndex((e) => e.type === 'assistant_message');
    expect(assistantIdx).toBeGreaterThan(awaitingIdx);
    // The approved turn made no tool calls and landed no edit — ADR 0081: a run without
    // a successful traceable operation ends `failed`, not `completed`.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('cancelling the gate ends the run immediately — no turn ran, no ops applied', async () => {
    const gate = createPlanApprovalGate();
    const provider = new ScriptedProvider([
      { text: overThresholdPlanText },
      { text: 'done', toolCalls: [editCall] }, // would apply an edit if the run ever reached it
    ]);
    const events = await drainWithApproval(
      new Orchestrator(provider).streamAgent(
        input,
        opts(),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
      gate,
      'cancelled',
    );
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    // No turn ran → no per-turn diff, and no terminal combined diff either (ADR 0056).
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('tripping the run signal while an approval is pending cancels the run (never hangs)', async () => {
    const gate = createPlanApprovalGate();
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ text: overThresholdPlanText }, { text: 'done' }]);
    const eventsPromise = drain(
      new Orchestrator(provider).streamAgent(
        input,
        opts(controller.signal),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
    );
    // Give the run a tick to reach the pending approval wait, then abort without ever
    // resolving the gate — the wait must not hang forever.
    await new Promise<void>((r) => setTimeout(r, 0));
    controller.abort();
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('tripping the run signal with a string reason cancels the pending approval honestly', async () => {
    const gate = createPlanApprovalGate();
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ text: overThresholdPlanText }, { text: 'done' }]);
    const eventsPromise = drain(
      new Orchestrator(provider).streamAgent(
        input,
        opts(controller.signal),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    controller.abort('user stopped');
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('an already-tripped run signal ends a plan-approval wait immediately', async () => {
    const gate = createPlanApprovalGate();
    const controller = new AbortController();
    controller.abort(42); // a non-Error, non-string reason exercises the generic fallback
    const provider = new ScriptedProvider([{ text: overThresholdPlanText }, { text: 'done' }]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(
        input,
        opts(controller.signal),
        { planFirst: true, requirePlanApproval: true },
        { planApproval: gate },
      ),
    );
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('with requirePlanApproval set but no resolver wired, defaults to approved (never hangs) and says so', async () => {
    const provider = new ScriptedProvider([{ text: overThresholdPlanText }, { text: 'done' }]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        planFirst: true,
        requirePlanApproval: true,
      }),
    );
    expect(events.some((e) => e.type === 'status' && e.status === 'awaiting_approval')).toBe(true);
    expect(
      events.some((e) => e.type === 'warning' && e.text.includes('no approval handler was wired')),
    ).toBe(true);
    // The defaulted-approved turn made no tool calls and landed no edit — ADR 0081.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });
});

describe('streamAgent mid-run steering (P11.4)', () => {
  it('folds a queued steering message into the NEXT turn boundary, not mid-step', async () => {
    const provider = new ScriptedProvider([
      { text: 'working', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done' },
    ]);
    const queue = createSteeringQueue();
    queue.push('focus on the outro instead');
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {}, { steering: queue }),
    );
    expect(
      events.some(
        (e) => e.type === 'notification' && e.text.includes('focus on the outro instead'),
      ),
    ).toBe(true);
    // Both turns were read-only (a `get_timeline` inspection, then a no-tool-calls
    // finish) — no edit landed, so the run ends `failed` per ADR 0081.
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('is silent when nothing was queued (no steering notice)', async () => {
    const events = await drain(
      new Orchestrator(new MockProvider()).streamAgent(
        input,
        opts(),
        {},
        { steering: createSteeringQueue() },
      ),
    );
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith('Steering'))).toBe(
      false,
    );
  });

  it('a queued message applies once then the queue is empty for later turns', async () => {
    const provider = new ScriptedProvider([
      { text: 'turn 1', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'turn 2', toolCalls: [{ id: 'r2', name: 'get_timeline', arguments: {} }] },
      { text: 'done' },
    ]);
    const queue = createSteeringQueue();
    queue.push('one-time nudge');
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {}, { steering: queue }),
    );
    const steeringNotices = events.filter(
      (e) => e.type === 'notification' && e.text.includes('one-time nudge'),
    );
    expect(steeringNotices).toHaveLength(1);
  });
});

/**
 * Checkpoint + true Resume (R3 C2): an interrupted run emits a resumable checkpoint of
 * the ops applied so far; a Resume run replays those ops and continues from there,
 * ending in one combined diff covering both the resumed and the new edits.
 */
describe('streamAgent checkpoint + resume (R3 C2)', () => {
  /** Abort the run right after its first turn applies, so a checkpoint is produced. */
  class AbortAfterFirstProvider implements AiProvider {
    public readonly name = 'mock' as const;
    private calls = 0;
    public constructor(private readonly controller: AbortController) {}
    public async complete(): Promise<AiResponse> {
      this.calls += 1;
      // First turn edits; then the caller aborts before the second turn is processed.
      if (this.calls === 1) return { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] };
      this.controller.abort();
      return { text: '' };
    }
  }

  it('emits a checkpoint with the applied ops when interrupted mid-run', async () => {
    const controller = new AbortController();
    const provider = new AbortAfterFirstProvider(controller);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, { ...opts(), signal: controller.signal }),
    );
    const checkpoint = events.find((e) => e.type === 'checkpoint');
    expect(checkpoint).toBeDefined();
    expect(checkpoint && checkpoint.type === 'checkpoint' && checkpoint.ops.length).toBe(1);
    expect(checkpoint && checkpoint.type === 'checkpoint' && checkpoint.stepsCompleted).toBe(1);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('resumes from a checkpoint: replays applied ops and surfaces only the NEW turn as a diff', async () => {
    // Resume with one op already applied; the model then makes one more edit and stops.
    const provider = new ScriptedProvider([
      { text: 'more', toolCalls: [deleteRange('b', 8, 9)] }, // the resumed run's next turn
      { text: 'done' },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        resume: {
          ops: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 3 } as never],
          log: ['Step 1: trimmed'],
          stepsCompleted: 1,
        },
      }),
    );
    // A resume reasoning summary is surfaced.
    const reasonings = events.filter((e) => e.type === 'reasoning');
    expect(
      reasonings.some((e) => e.summaries.some((s) => s.startsWith('Resuming from step 1'))),
    ).toBe(true);
    // ADR 0056: each op is offered exactly once, at the turn where it landed. The
    // checkpoint ops were already surfaced as per-turn diffs by the interrupted run,
    // so the resumed run emits a diff only for its NEW turn.
    const diffs = events.filter((e) => e.type === 'diff');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ scope: 'turn' });
    expect(diffs[0]?.type === 'diff' && diffs[0].edit.patch.operations).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('resumes multiple kept edits with a default reason and pluralized summary', async () => {
    const bare: ContextInput = { project: makeProject(), userPrompt: '' };
    const provider = new ScriptedProvider([{ text: 'done' }]); // model stops immediately
    const events = await drain(
      new Orchestrator(provider).streamAgent(bare, opts(), {
        resume: {
          ops: [
            { type: 'delete_range', trackId: 'video_1', start: 0, end: 3 } as never,
            { type: 'delete_range', trackId: 'video_1', start: 8, end: 9 } as never,
          ],
          log: [],
          stepsCompleted: 2,
        },
      }),
    );
    const reasonings = events.filter((e) => e.type === 'reasoning');
    expect(reasonings.some((e) => e.summaries.some((s) => s.includes('kept 2 edits')))).toBe(true);
    // The kept edits were already offered by the interrupted run's per-turn diffs;
    // with no new edits this resumed run emits none (ADR 0056).
    expect(events.some((e) => e.type === 'diff')).toBe(false);
  });

  it('pauses for reconciliation — never silently restarts — when the checkpoint ops no longer validate (RSI1)', async () => {
    // An op referencing a non-existent track can't be replayed → honest warning, no
    // crash. RSI1: the run does NOT quietly start a fresh run from step 1 (that would
    // execute against a project state the interrupted run never saw) — it pauses as an
    // integrity failure and preserves the checkpoint's ops for the creator to review.
    // The `{ text: 'done' }` scripted turn is therefore never requested.
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        resume: {
          ops: [{ type: 'delete_range', trackId: 'no_such_track', start: 0, end: 1 } as never],
          log: [],
          stepsCompleted: 1,
        },
      }),
    );
    expect(events.some((e) => e.type === 'warning' && e.text.includes('Could not resume'))).toBe(
      true,
    );
    expect(provider.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('pauses the very next turn, without calling the model, when the resumed task ledger cannot be recovered', async () => {
    // A checkpoint's task-memory ledger (ADR 0075) can itself be corrupt/unrecoverable
    // (executing with no committed plan) even when its replayed ops are perfectly valid.
    // ADR 0080's pre-request invariant check must catch this BEFORE the model is ever
    // consulted — never silently proceeding on an amnesiac ledger.
    const corruptWorking = {
      schemaVersion: 2,
      runId: 'run_resumed',
      identity: { conversationId: 'conv_1', projectId: 'proj_1', attemptId: 'run_resumed' },
      version: 0,
      objective: { request: 'tighten the intro', outcome: 'tighten the intro', acceptance: [] },
      stage: 'apply',
      completedStages: ['interpret', 'inspect', 'analyze', 'plan'],
      stageEnteredAtTurn: 1,
      facts: [],
      decisions: [],
      plan: {
        status: 'none',
        id: null,
        committedAtTurn: null,
        basedOnProjectRevision: null,
        decisionIds: [],
      },
      execution: { authorized: false },
      evidence: [],
      objectives: [],
      operations: [],
      verifications: [],
      nextAction: null,
      blockedOn: null,
      integrity: { status: 'valid', diagnostics: [] },
      baseProjectRevision: 0,
      currentProjectRevision: 0,
    };
    const provider = new ScriptedProvider([{ text: 'must never be requested' }]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        resume: {
          ops: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 1 } as never],
          log: ['Step 1: trimmed'],
          stepsCompleted: 1,
          working: corruptWorking,
        },
      }),
    );
    expect(provider.requests).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'warning' && e.text.includes('RUN_STATE_INTEGRITY_FAILURE')),
    ).toBe(true);
  });
});

describe('streamAgent host tool execution (Phase T)', () => {
  const analyzeCall = { id: 'a1', name: 'analyze_silence', arguments: { assetId: 'asset_1' } };

  it('holds the tool card in `running` across the awaited executor, then completes with real data', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyzing', toolCalls: [analyzeCall] },
      { text: 'done', toolCalls: [] },
    ]);
    const order: string[] = [];
    const executor = {
      run: async () => {
        order.push('executor');
        // Yield a macrotask so the awaited boundary is real, not synchronous.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          status: 'completed' as const,
          summary: 'Found 2 silent ranges',
          data: { silences: [{ start: 1.5, end: 2.25 }] },
        };
      },
    };
    const events = await drain(new Orchestrator(provider, { executor }).streamAgent(input, opts()));
    const toolEvents = events.filter((e) => e.type === 'tool_call' && e.id === 'a1');
    // Exactly one running → one terminal transition, in order, around the await.
    expect(toolEvents.map((e) => (e.type === 'tool_call' ? e.status : ''))).toEqual([
      'running',
      'completed',
    ]);
    expect(order).toEqual(['executor']);
    // The card detail carries the FULL result for the details popup.
    const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'a1');
    expect(result).toMatchObject({ summary: 'Found 2 silent ranges' });
    // `analyze_silence` is read-only — no edit ever landed, so ADR 0081's causal
    // completion gate ends this run `failed`, not `completed`.
    expect(reduceEvents(events).status).toBe('failed');
  });

  it('attaches a get_frame result as image content on the NEXT request, not the log text', async () => {
    const frameCall = { id: 'f1', name: 'get_frame', arguments: { timeSeconds: 2 } };
    const provider = new ScriptedProvider([
      { text: 'looking', toolCalls: [frameCall] },
      { text: 'looks fine', toolCalls: [] },
    ]);
    const executor = {
      run: async () => ({
        status: 'completed' as const,
        summary: 'Looked at the timeline at 2.00s',
        data: { timeSeconds: 2, width: 288, height: 512 },
        images: [
          {
            mediaType: 'image/jpeg' as const,
            base64: 'ZmFrZS1qcGVn',
            label: 'the timeline at 2.00s',
          },
        ],
      }),
    };
    await drain(new Orchestrator(provider, { executor }).streamAgent(input, opts()));
    // Turn 1 asked for the frame, so it cannot have carried it.
    expect(provider.requests[0]?.messages.flatMap((m) => m.images ?? [])).toEqual([]);
    // Turn 2 is where the model actually sees it.
    expect(provider.requests[1]?.messages.flatMap((m) => m.images ?? [])).toEqual([
      { mediaType: 'image/jpeg', base64: 'ZmFrZS1qcGVn', label: 'the timeline at 2.00s' },
    ]);
  });

  describe('transcribe (host-backed mutation)', () => {
    const transcribeCall = { id: 't1', name: 'transcribe', arguments: { assetId: 'asset_1' } };

    it('turns the trusted host’s words into a reversible set_transcript patch', async () => {
      const provider = new ScriptedProvider([
        { text: 'transcribing', toolCalls: [transcribeCall] },
        { text: 'done', toolCalls: [] },
      ]);
      const executor = {
        run: async () => ({
          status: 'completed' as const,
          summary: 'Transcribed 2 words',
          data: { words: [{ word: 'hi', start: 0, end: 0.5 }] },
        }),
      };
      const events = await drain(
        new Orchestrator(provider, { executor }).streamAgent(input, opts()),
      );
      expect(events.some((e) => e.type === 'diff')).toBe(true);
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 't1');
      expect(result).toMatchObject({ summary: 'Transcribed 2 words' });
      expect(reduceEvents(events).status).toBe('completed');
    });

    it('rejects a host outcome with no data at all, preserving the existing transcript', async () => {
      const provider = new ScriptedProvider([
        { text: 'transcribing', toolCalls: [transcribeCall] },
        { text: 'done', toolCalls: [] },
      ]);
      const executor = {
        run: async () => ({ status: 'completed' as const, summary: 'no data' }),
      };
      const events = await drain(
        new Orchestrator(provider, { executor }).streamAgent(input, opts()),
      );
      const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 't1').at(-1);
      expect(terminal).toMatchObject({ status: 'failed' });
      expect(events.some((e) => e.type === 'diff')).toBe(false);
    });

    it('rejects an empty/malformed host payload, preserving the existing transcript', async () => {
      const provider = new ScriptedProvider([
        { text: 'transcribing', toolCalls: [transcribeCall] },
        { text: 'done', toolCalls: [] },
      ]);
      const executor = {
        run: async () => ({
          status: 'completed' as const,
          summary: 'no words',
          data: { words: [] },
        }),
      };
      const events = await drain(
        new Orchestrator(provider, { executor }).streamAgent(input, opts()),
      );
      const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 't1').at(-1);
      expect(terminal).toMatchObject({ status: 'failed' });
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 't1');
      expect(result?.type === 'tool_result' ? result.summary : '').toMatch(/no valid timed words/);
      expect(events.some((e) => e.type === 'diff')).toBe(false);
    });
  });

  describe('add_stock (host-backed mutation)', () => {
    // The fixture's picture runs 0–10s, so 12s is empty and 2s is occupied.
    const stockCall = {
      id: 's1',
      name: 'add_stock',
      arguments: { remoteId: 'px_1', kind: 'video' as const, atSeconds: 12 },
    };
    const stockAsset = {
      id: 'stock_pexels_px_1',
      path: 'media/stock/px_1.mp4',
      kind: 'video' as const,
      durationSeconds: 4,
      source: {
        provider: 'pexels',
        remoteId: 'px_1',
        license: 'Pexels License',
        attributionRequired: true,
        creator: 'Ada Photographer',
        fetchedAt: '2026-08-24T00:00:00.000Z',
      },
    };
    const hostRun = (data: unknown) => ({
      run: async (): Promise<HostToolOutcome> => ({
        status: 'completed' as const,
        summary: 'Downloaded "media/stock/px_1.mp4".',
        ...(data === undefined ? {} : { data }),
      }),
    });
    const stockProvider = () =>
      new ScriptedProvider([
        { text: 'sourcing b-roll', toolCalls: [stockCall] },
        { text: 'done', toolCalls: [] },
      ]);

    // THE regression this suite exists for: before the `add_stock` arm existed,
    // the host spent quota and disk, the call fell through to the generic settle
    // with `ops: []`, and the model was told the clip had been added to a
    // timeline that had not moved.
    it('turns the downloaded asset into a real, reversible placement patch', async () => {
      const provider = stockProvider();
      const events = await drain(
        new Orchestrator(provider, {
          executor: hostRun({ asset: stockAsset, atSeconds: 12 }),
        }).streamAgent(input, opts()),
      );
      const diff = events.find((e) => e.type === 'diff');
      expect(diff).toBeDefined();
      const ops =
        diff?.type === 'diff' ? diff.edit.patch.operations.map((op: AnyOperation) => op.type) : [];
      expect(ops).toContain('add_asset');
      expect(ops).toContain('add_clip');
      const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 's1').at(-1);
      expect(terminal).toMatchObject({ status: 'completed' });
      // The credit is surfaced to the model on its next turn, not left as a
      // publish-time surprise for the user.
      const fedBack = JSON.stringify(provider.requests[1]?.messages ?? []);
      expect(fedBack).toMatch(/Ada Photographer/);
      expect(fedBack).toMatch(/Placed at 12\.0s/);
    });

    it('fails closed when the host returns no usable asset — never "added" on an unchanged timeline', async () => {
      const events = await drain(
        new Orchestrator(stockProvider(), { executor: hostRun(undefined) }).streamAgent(
          input,
          opts(),
        ),
      );
      const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 's1').at(-1);
      expect(terminal).toMatchObject({ status: 'failed' });
      expect(events.some((e) => e.type === 'diff')).toBe(false);
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 's1');
      expect(result?.type === 'tool_result' ? result.summary : '').toMatch(/nothing was placed/);
    });

    it('answers a re-add plainly instead of leaking a duplicate_asset validator message', async () => {
      // Stock asset ids are deterministic, so adding the same clip twice hits
      // `duplicate_asset` — whose text ("Asset id already exists: stock_pexels_px_1")
      // reads to the model as a bug rather than as an answer.
      const withStock = makeProject({
        assets: [
          { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
          { ...stockAsset },
        ],
      });
      const events = await drain(
        new Orchestrator(stockProvider(), {
          executor: hostRun({ asset: stockAsset, atSeconds: 12 }),
        }).streamAgent({ project: withStock, userPrompt: 'add b-roll' }, opts()),
      );
      expect(events.some((e) => e.type === 'diff')).toBe(false);
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 's1');
      expect(result?.type === 'tool_result' ? result.summary : '').toMatch(
        /already in your media bin/,
      );
      expect(result?.type === 'tool_result' ? result.summary : '').not.toMatch(/Asset id already/);
    });

    it('fails closed when the span filled up between the host check and the placement', async () => {
      const events = await drain(
        new Orchestrator(stockProvider(), {
          // The host allowed 12s; the payload asks for 2s, which the fixture's
          // picture already occupies. The orchestrator is the second check.
          executor: hostRun({ asset: stockAsset, atSeconds: 2 }),
        }).streamAgent(input, opts()),
      );
      const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 's1').at(-1);
      expect(terminal).toMatchObject({ status: 'failed' });
      expect(events.some((e) => e.type === 'diff')).toBe(false);
      const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 's1');
      expect(result?.type === 'tool_result' ? result.summary : '').toMatch(
        /already picture on the timeline/,
      );
    });
  });

  it('settles an in-flight tool as `cancelled` on Stop — never a checkmark', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ text: 'analyzing', toolCalls: [analyzeCall] }]);
    const executor = {
      run: async (_call: unknown, _ctx: unknown, signal?: AbortSignal) => {
        // Simulate the user hitting Stop while the analysis runs.
        controller.abort();
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return { status: 'completed' as const, summary: 'never' };
      },
    };
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(input, opts(controller.signal)),
    );
    const toolEvents = events.filter((e) => e.type === 'tool_call' && e.id === 'a1');
    expect(toolEvents.map((e) => (e.type === 'tool_call' ? e.status : ''))).toEqual([
      'running',
      'cancelled',
    ]);
    // The cancelled tool card + terminal status carry the interruption; an unplanned run
    // emits no pinned checklist (the "Stopped by user" step status is a reducer concern).
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(reduceEvents(events).status).toBe('cancelled');
  });

  it('fails an analysis call honestly when no executor is configured', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyzing', toolCalls: [analyzeCall] },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const terminal = events.filter((e) => e.type === 'tool_call' && e.id === 'a1').at(-1);
    expect(terminal).toMatchObject({ status: 'failed' });
    const result = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'a1');
    expect(result?.type === 'tool_result' ? result.summary : '').toMatch(
      /no analysis engine is connected/,
    );
  });
});

/**
 * C1 (plan/ORCHESTRATOR-GAP-CLOSURE.md) — the agent loop's terminal `usage` event.
 * Before this, `streamAgent` never emitted `usage` at all, so the sidebar's cost chip
 * and running session total were silently incomplete for the dominant run type.
 */
describe('streamAgent usage (C1)', () => {
  const usageOf = (events: AiEvent[]): { tokens: number; usd: number } | undefined =>
    events.find((e) => e.type === 'usage') as { tokens: number; usd: number } | undefined;

  it('emits exactly one terminal usage event with a zero cost when no call reports usage', async () => {
    const events = await drain(new Orchestrator(new MockProvider()).streamAgent(input, opts()));
    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ tokens: 0, usd: 0 });
    // Alongside the terminal diff: after it, and still before the terminal status.
    const diffIdx = events.findIndex((e) => e.type === 'diff');
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    expect(usageIdx).toBeGreaterThan(diffIdx);
    expect(usageIdx).toBeLessThan(events.length - 1);
  });

  it("sums every turn's real reported usage into the terminal usage event", async () => {
    const provider = new ScriptedProvider([
      {
        text: 'edit',
        toolCalls: [deleteRange('a', 0, 3)],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { text: 'done', usage: { inputTokens: 30, outputTokens: 10 } },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(160); // (100 + 20) + (30 + 10)
    expect(usage?.usd).toBeGreaterThan(0);
  });

  it("folds the Critic repair pass's real usage into the terminal usage event (R3 C3)", async () => {
    const provider = new ScriptedProvider([
      {
        text: 'edit',
        toolCalls: [deleteRange('a', 0, 3)],
        usage: { inputTokens: 10, outputTokens: 2 },
      }, // turn 1 applies
      { text: 'done' }, // turn 2 ends the loop — reports no usage
      {
        text: 'fix',
        toolCalls: [deleteRange('b', 8, 9)],
        usage: { inputTokens: 40, outputTokens: 8 },
      }, // repair pass applies
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        durationTargetSeconds: 1,
        maxSteps: 3,
      }),
    );
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith('Repair pass'))).toBe(
      true,
    );
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(60); // turn 1 (12) + the repair pass (48)
  });

  it("defaults a missing side of a turn's partial usage to 0 (complete()-drain fallback)", async () => {
    // FakeProvider has no stream() → exercises providerChunks()'s complete()-drain
    // fallback, which must now forward `response.usage` as a chunk too (C1).
    const provider = new FakeProvider({ text: 'done', usage: { inputTokens: 40 } });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(40);
  });

  it('defaults the OTHER missing side (outputTokens only) of a partial usage to 0', async () => {
    const provider = new FakeProvider({ text: 'done', usage: { outputTokens: 9 } });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(9);
  });

  it('carries usage already reported before an abort mid-stream into the settled turn', async () => {
    const controller = new AbortController();
    class AbortAfterUsageProvider implements AiProvider {
      public readonly name = 'mock' as const;
      public async complete(): Promise<AiResponse> {
        return { text: '' };
      }
      public async *stream(): AsyncIterable<ProviderChunk> {
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } };
        controller.abort();
        yield { type: 'text-delta', text: 'never reached' };
      }
    }
    const events = await drain(
      new Orchestrator(new AbortAfterUsageProvider()).streamAgent(input, {
        ...opts(),
        signal: controller.signal,
      }),
    );
    // The run settles (aborted) without throwing; the usage seen before the abort
    // still folds into the terminal usage event rather than vanishing.
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(6);
  });

  it('settles with the usage accrued before a mid-run throw', async () => {
    class UsageThenThrowProvider implements AiProvider {
      public readonly name = 'mock' as const;
      private index = 0;
      public async complete(): Promise<AiResponse> {
        this.index += 1;
        if (this.index === 1) {
          return {
            text: 'edit',
            toolCalls: [deleteRange('a', 0, 3)],
            usage: { inputTokens: 50, outputTokens: 5 },
          };
        }
        throw new Error('network exploded');
      }
    }
    const events = await drain(
      new Orchestrator(new UsageThenThrowProvider()).streamAgent(input, opts()),
    );
    const usage = usageOf(events);
    expect(usage?.tokens).toBe(55);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });
});

/**
 * C2 (plan/ORCHESTRATOR-GAP-CLOSURE.md) — the specific `RunStatus` values the sidebar
 * already renders labels for (`generating`/`running_tool`/`reading`/`searching`) but
 * the orchestrator never emitted.
 */
describe('streamAgent status richness (C2)', () => {
  const statusesOf = (events: AiEvent[]): string[] =>
    events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);

  it('emits "generating" while a turn\'s assistant text streams, before its tool calls are known', async () => {
    const provider = new FakeProvider({ text: 'edit', toolCalls: [editCall] });
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(statusesOf(events)).toContain('generating');
    const generatingIdx = events.findIndex((e) => e.type === 'status' && e.status === 'generating');
    // `generating` precedes the turn's first tool_call — the assistant text streams before
    // its tool calls are known (an unplanned run has no plan event to order against).
    const toolIdx = events.findIndex((e) => e.type === 'tool_call');
    expect(generatingIdx).toBeGreaterThanOrEqual(0);
    expect(generatingIdx).toBeLessThan(toolIdx);
  });

  it('emits "running_tool" right before executing a turn with a mutating tool call', async () => {
    const provider = new FakeProvider({ text: 'edit', toolCalls: [editCall] });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 1 }),
    );
    expect(statusesOf(events)).toContain('running_tool');
    const runningToolIdx = events.findIndex(
      (e) => e.type === 'status' && e.status === 'running_tool',
    );
    const toolCallIdx = events.findIndex((e) => e.type === 'tool_call');
    expect(runningToolIdx).toBeLessThan(toolCallIdx);
  });

  it('emits "reading" for a turn whose tool calls are all plain reads', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [{ id: 'r', name: 'get_timeline', arguments: {} }],
    });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 1 }),
    );
    const statuses = statusesOf(events);
    expect(statuses).toContain('reading');
    expect(statuses).not.toContain('searching');
    expect(statuses).not.toContain('running_tool');
  });

  it('emits "searching" for a turn whose tool calls are ffmpeg-backed analysis', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [{ id: 'a1', name: 'analyze_silence', arguments: { assetId: 'asset_1' } }],
    });
    const executor = { run: async () => ({ status: 'completed' as const, summary: 'ok' }) };
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(input, opts(), { maxSteps: 1 }),
    );
    const statuses = statusesOf(events);
    expect(statuses).toContain('searching');
    expect(statuses).not.toContain('reading');
    expect(statuses).not.toContain('running_tool');
  });

  it('falls back to "running_tool" for an unknown tool name (never guesses reading/searching)', async () => {
    const provider = new FakeProvider({
      text: '',
      toolCalls: [{ id: 'u', name: 'no_such_tool', arguments: {} }],
    });
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 1 }),
    );
    expect(statusesOf(events)).toContain('running_tool');
  });

  it('emits no run-status transitions for a turn the model ends with no tool calls', async () => {
    const events = await drain(
      new Orchestrator(new FakeProvider({ text: 'all done' })).streamAgent(input, opts()),
    );
    // Still generating (the text streamed), but never a tool-execution status — there
    // was nothing to execute.
    const statuses = statusesOf(events);
    expect(statuses).toContain('generating');
    expect(statuses).not.toContain('running_tool');
    expect(statuses).not.toContain('reading');
    expect(statuses).not.toContain('searching');
  });
});

/**
 * E1 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — concurrent read/analysis batches.
 * The invariant under test: concurrency changes WALL CLOCK only. The observable event
 * stream, notes, and stop-on-cancel point of a concurrent batch are byte-identical to
 * serial execution of the same calls with the same outcomes.
 */
describe('streamAgent concurrent read batches (E1)', () => {
  const silence = (id: string, assetId: string) => ({
    id,
    name: 'analyze_silence',
    arguments: { assetId },
  });
  /** Compact per-call event trace: running/settled transitions + results, in order. */
  const trace = (events: AiEvent[]): string[] =>
    events
      .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
      .map((e) => (e.type === 'tool_call' ? `${e.id}:${e.status}` : `result:${e.toolCallId}`));

  it('a concurrent batch yields the same event sequence as serial execution (golden order)', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'reading',
        toolCalls: [
          { id: 'r1', name: 'get_timeline', arguments: {} },
          { id: 'r2', name: 'get_selected_range', arguments: {} },
          silence('a1', 'asset_1'),
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const executor = {
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 'completed' as const, summary: 'Found 1 silent range', data: {} };
      },
    };
    const events = await drain(new Orchestrator(provider, { executor }).streamAgent(input, opts()));
    // Exactly today's serial order: each call's full lifecycle, in original call order.
    expect(trace(events)).toEqual([
      'r1:running',
      'r1:completed',
      'result:r1',
      'r2:running',
      'r2:completed',
      'result:r2',
      'a1:running',
      'a1:completed',
      'result:a1',
    ]);
    // Every call in the batch is read/analysis-only — no edit landed, so ADR 0081 ends
    // this run `failed`, not `completed`.
    expect(reduceEvents(events).status).toBe('failed');
  });

  it('actually overlaps sidecar round-trips inside a safe batch (bounded pool)', async () => {
    const provider = new ScriptedProvider([
      { text: 'analyzing', toolCalls: [silence('a1', 'asset_1'), silence('a2', 'asset_2')] },
      { text: 'done', toolCalls: [] },
    ]);
    let active = 0;
    let maxActive = 0;
    const executor = {
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { status: 'completed' as const, summary: 'ok', data: {} };
      },
    };
    const events = await drain(new Orchestrator(provider, { executor }).streamAgent(input, opts()));
    // Both engine round-trips were in flight at once — the latency win exists…
    expect(maxActive).toBe(2);
    // …while the observable order stayed serial.
    expect(trace(events)).toEqual([
      'a1:running',
      'a1:completed',
      'result:a1',
      'a2:running',
      'a2:completed',
      'result:a2',
    ]);
  });

  it('a mutation splits the batch: reads run together, the mutation stays strictly serial after them', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'read then edit',
        toolCalls: [
          { id: 'r1', name: 'get_timeline', arguments: {} },
          { id: 'r2', name: 'get_selected_range', arguments: {} },
          { id: 'm1', name: 'delete_range', arguments: { trackId: 'video_1', start: 0, end: 3 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(trace(events)).toEqual([
      'r1:running',
      'r1:completed',
      'result:r1',
      'r2:running',
      'r2:completed',
      'result:r2',
      'm1:running',
      'm1:completed',
      'result:m1',
    ]);
    // The mutation still landed as a validated per-turn diff.
    expect(events.some((e) => e.type === 'diff')).toBe(true);
    expect(reduceEvents(events).status).toBe('completed');
  });

  it('duplicate reads split into successive batches so the repeat is memo-served, not re-run', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'double read',
        toolCalls: [
          { id: 'r1', name: 'get_timeline', arguments: {} },
          { id: 'r2', name: 'get_timeline', arguments: {} },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const second = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'r2');
    // The memo answered the repeat — same summary contract as the serial loop.
    expect(trace(events)).toEqual([
      'r1:running',
      'r1:completed',
      'result:r1',
      'r2:running',
      'r2:completed',
      'result:r2',
    ]);
    expect(second).toBeDefined();
  });

  it('a re-read at a NEW window returns that window’s real data, not the memo’s', async () => {
    // The memo/novelty split (R1): novelty keys drop window args so a window-hopping
    // re-read earns no progress credit, but the MEMO must stay keyed on exact arguments.
    // Sharing one coarse key would answer {start:0.5} with the words from {start:0} —
    // silently wrong data, which is never an acceptable price for loop protection.
    const provider = new ScriptedProvider([
      {
        text: 'read two windows',
        toolCalls: [
          { id: 'w1', name: 'get_transcript', arguments: { start: 0, end: 0.5 } },
          { id: 'w2', name: 'get_transcript', arguments: { start: 0.5, end: 1 } },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const words = (id: string) => {
      const e = events.find((ev) => ev.type === 'tool_result' && ev.toolCallId === id);
      return JSON.stringify(e?.type === 'tool_result' ? e.result : undefined);
    };
    expect(words('w1')).toContain('hello');
    expect(words('w1')).not.toContain('world');
    // The second window is genuinely different data — proof it was not memo-served.
    expect(words('w2')).toContain('world');
    expect(words('w2')).not.toContain('hello');
  });

  it('mid-batch Stop settles the first cancelled call and skips the rest — never a checkmark', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      { text: 'analyzing', toolCalls: [silence('a1', 'asset_1'), silence('a2', 'asset_2')] },
    ]);
    const executor = {
      run: async (_call: unknown, _ctx: unknown, signal?: AbortSignal) => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return { status: 'completed' as const, summary: 'never' };
      },
    };
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(input, opts(controller.signal)),
    );
    // First call folds as cancelled; every later call in the batch is skipped entirely
    // (exactly what serial execution does after a cancelled call).
    expect(trace(events)).toEqual(['a1:running', 'a1:cancelled', 'result:a1']);
    expect(reduceEvents(events).status).toBe('cancelled');
  });
});

/**
 * E3 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — prompt-prefix cache stability.
 * The invariant: within one run, everything before the turn-varying suffix (steering +
 * action log) is byte-identical turn to turn, and the repair pass reproduces the same
 * prefix — so a provider's prompt cache keeps hitting instead of silently missing.
 */
describe('streamAgent prompt-prefix stability (E3)', () => {
  /**
   * The run-stable head is now its OWN message — the contract + committed plan + pinned
   * skills — sitting between the system/history prefix and the turn-varying tail, and
   * flagged `cacheBoundary` so the Anthropic provider can put a cache breakpoint at its
   * end. It used to be a string prefix of the trailing message, which placed it AFTER
   * `buildContext`'s project block; that block re-renders from the mutating working copy,
   * so every applied patch invalidated the prefix ahead of the head and re-billed all of
   * it, pinned playbooks included.
   *
   * Asserting on a whole message rather than a substring is also why this helper no
   * longer needs to guess where the head ends by scanning for the first varying block.
   */
  const headMessageOf = (messages: readonly AiMessage[]): AiMessage => {
    const head = messages.at(-2)!;
    expect(head.cacheBoundary, 'the head message must carry the cache breakpoint').toBe(true);
    return head;
  };

  it('two consecutive read-only turns produce byte-identical prefixes up to the action log', async () => {
    const provider = new ScriptedProvider([
      { text: 'read', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const [turn1, turn2] = provider.requests;
    expect(turn2!.messages.length).toBe(turn1!.messages.length);
    // Every message before the trailing (turn-varying) one is byte-identical — which now
    // includes the whole cached head, not just the system/history prefix.
    for (let i = 0; i < turn1!.messages.length - 1; i += 1) {
      expect(turn2!.messages[i]).toEqual(turn1!.messages[i]);
    }
    expect(headMessageOf(turn2!.messages)).toEqual(headMessageOf(turn1!.messages));
    // The serialized tool block is byte-identical across turns (E3.3).
    expect(JSON.stringify(turn2!.tools)).toBe(JSON.stringify(turn1!.tools));
  });

  it('a steered turn keeps the stable head intact — steering lands after it, never inside', async () => {
    const steering = createSteeringQueue();
    const provider = new ScriptedProvider([
      { text: 'read', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator(provider);
    const stream = orchestrator.streamAgent(input, opts(), {}, { steering });
    // Queued before draining → folded into the FIRST turn boundary (turn 1).
    steering.push('keep the intro');
    await drain(stream);
    const [turn1, turn2] = provider.requests;
    // Turn 2 is un-steered. The steered turn must carry the byte-identical head message —
    // the guidance rides in the varying tail, never inside the cached prefix.
    expect(headMessageOf(turn1!.messages)).toEqual(headMessageOf(turn2!.messages));
    expect(headMessageOf(turn1!.messages).content).not.toContain('keep the intro');
    expect(turn1!.messages.at(-1)!.content).toContain('keep the intro');
  });

  it('the repair pass reproduces the same run-stable prefix as the turns (shared helper)', async () => {
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] }, // turn 1 applies
      { text: 'done' }, // turn 2 ends the loop
      { text: 'fix', toolCalls: [deleteRange('b', 8, 9)] }, // repair pass
    ]);
    await drain(
      new Orchestrator(provider).streamAgent(input, opts(), {
        durationTargetSeconds: 1,
        maxSteps: 3,
      }),
    );
    expect(provider.requests.length).toBe(3);
    const turn2 = provider.requests[1]!;
    const repair = provider.requests[2]!;
    // Repair = the same agentMessages + one extra instruction message on the end.
    expect(repair.messages.length).toBe(turn2.messages.length + 1);
    // Same post-edit working copy → the base context is byte-identical…
    for (let i = 0; i < turn2.messages.length - 1; i += 1) {
      expect(repair.messages[i]).toEqual(turn2.messages[i]);
    }
    // …and the repair pass reproduces the identical cached head message. The repair adds
    // one extra instruction message on the end, so its head sits one further back.
    expect(headMessageOf(repair.messages.slice(0, -1))).toEqual(headMessageOf(turn2.messages));
    expect(JSON.stringify(repair.tools)).toBe(JSON.stringify(turn2.tools));
  });

  it('pinning a skill re-derives the head once, then it is stable again (memo revalidation)', async () => {
    const withSkills: ContextInput = {
      ...input,
      skills: [
        {
          name: 'captions',
          description: 'caption craft',
          tools: [],
          body: 'Caption playbook body.',
        },
      ],
    };
    const provider = new ScriptedProvider([
      {
        text: 'load',
        toolCalls: [{ id: 's1', name: 'load_skill', arguments: { name: 'captions' } }],
      },
      { text: 'read', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    await drain(new Orchestrator(provider).streamAgent(withSkills, opts()));
    const [, turn2, turn3] = provider.requests;
    // After the pin, the skill body is in the cached head…
    const head2 = headMessageOf(turn2!.messages);
    expect(head2.content).toContain('Caption playbook body.');
    // …and turns 2→3 share that new head byte-for-byte, so the playbook is billed once.
    expect(headMessageOf(turn3!.messages)).toEqual(head2);
  });

  it('keeps the mutating project snapshot out of the cached head', async () => {
    // The regression that made the head worthless: an applied patch re-renders the
    // timeline summary, and that block used to sit BEFORE the head in the prompt.
    const provider = new ScriptedProvider([
      { text: 'edit', toolCalls: [deleteRange('a', 0, 3)] },
      { text: 'read', toolCalls: [{ id: 'r1', name: 'get_timeline', arguments: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
    await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const [turn1, turn2] = provider.requests;
    // The timeline changed between the turns…
    expect(turn2!.messages.at(-1)!.content).not.toBe(turn1!.messages.at(-1)!.content);
    // …and the cached head did not.
    expect(headMessageOf(turn2!.messages)).toEqual(headMessageOf(turn1!.messages));
    expect(headMessageOf(turn1!.messages).content).not.toContain('Timeline (layers');
  });
});

/**
 * E2 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — micro-compaction integration.
 * A long, read-heavy run crosses the log-size threshold: old analysis payloads are
 * cleared in place in the fed-back action log (the call-history prefixes survive), a
 * repeat call is still served from the run memo, and the run converges normally.
 */
describe('streamAgent micro-compaction of old tool results (E2)', () => {
  it('clears old payloads from the fed-back log, keeps memo-served repeats, and converges', async () => {
    const silence = (id: string, assetId: string) => ({
      id,
      name: 'analyze_silence',
      arguments: { assetId },
    });
    // Big enough that each analysis note carries a ~1200-char preview (~300 tokens):
    // four of them push the log past AGENT_LOG_CLEAR_THRESHOLD_TOKENS.
    const bulk = {
      silences: Array.from({ length: 60 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5 })),
    };
    const provider = new ScriptedProvider([
      { text: 't1', toolCalls: [silence('a1', 'asset_1')] },
      { text: 't2', toolCalls: [silence('a2', 'asset_2')] },
      { text: 't3', toolCalls: [silence('a3', 'asset_3')] },
      { text: 't4', toolCalls: [silence('a4', 'asset_4')] },
      { text: 't5-repeat', toolCalls: [silence('a5', 'asset_1')] }, // repeat of turn 1
      { text: 'done', toolCalls: [] },
    ]);
    const executor = {
      run: async () => ({ status: 'completed' as const, summary: 'Found silences', data: bulk }),
    };
    const events = await drain(
      new Orchestrator(provider, { executor }).streamAgent(input, opts(), { maxSteps: 8 }),
    );
    // The run converged normally under compaction — honestly `failed`, not `completed`:
    // every call in the run was read-only `analyze_silence`, so no edit ever landed
    // (ADR 0081's causal completion gate).
    expect(reduceEvents(events).status).toBe('failed');
    // By turn 5 the log crossed the threshold: old entries carry the cleared marker,
    // their "what was called" prefixes intact, while the freshest keep real payloads.
    const turn5Log = provider.requests[4]!.messages.at(-1)!.content;
    expect(turn5Log).toContain('[old result cleared — re-read if needed]');
    expect(turn5Log).toContain('Found silences');
    // The repeat call was answered from the run memo — no fresh engine work claimed
    // (its cleared predecessor did not break memoization), and the reducer then
    // recognizes the confirmed stall and ends the run on its own.
    const repeat = events.find((e) => e.type === 'tool_result' && e.toolCallId === 'a5');
    expect(repeat?.type === 'tool_result' ? repeat.summary : '').toContain('(cached)');
  });
});

describe('streamAgent cached-read action recovery', () => {
  it('withholds redundant reads on the recovery turn and lands the pending edit', async () => {
    const reads = (suffix: string) => [
      { id: `timeline-${suffix}`, name: 'get_timeline', arguments: {} },
      { id: `assets-${suffix}`, name: 'list_assets', arguments: {} },
    ];
    const provider = new ScriptedProvider([
      { text: 'gathering context', toolCalls: reads('1') },
      { text: 'fresh reads', toolCalls: reads('2') },
      {
        text: 'placing the shot now',
        toolCalls: [
          {
            id: 'place-1',
            name: 'add_clip',
            arguments: {
              trackId: 'video_1',
              assetId: 'asset_1',
              start: 10,
              end: 11,
              sourceStart: 0,
            },
          },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(
        { ...input, userPrompt: 'build the montage on the timeline' },
        opts(),
        { maxSteps: 6 },
      ),
    );

    const recovery = provider.requests[2]!;
    const recoveryNames = recovery.tools?.map((tool) => tool.name) ?? [];
    expect(recoveryNames).toContain('add_clip');
    expect(recoveryNames).toContain('ask_user');
    expect(recoveryNames).not.toContain('get_timeline');
    expect(recoveryNames).not.toContain('list_assets');
    expect(recovery.messages.at(-1)!.content).toContain('ACTION RECOVERY');
    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'notification' && event.text.includes('stopped making progress'),
      ),
    ).toBe(false);
  });

  it('host-refuses a read hallucinated outside the recovery tool surface', async () => {
    const read = (id: string) => ({ id, name: 'get_timeline', arguments: {} });
    const provider = new ScriptedProvider([
      { text: 'read', toolCalls: [read('r1')] },
      { text: 'read again', toolCalls: [read('r2')] },
      // Deliberately violates the advertised mutation/ask-only recovery surface.
      { text: 'read despite scope', toolCalls: [read('r3')] },
      { text: 'must not run', toolCalls: [] },
    ]);
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 6 }),
    );

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.tools?.some((tool) => tool.name === 'get_timeline')).toBe(false);
    const refused = events.find(
      (event) => event.type === 'tool_result' && event.toolCallId === 'r3',
    );
    expect(refused?.type === 'tool_result' ? refused.summary : '').toContain(
      'Skipped redundant get_timeline',
    );
    expect(
      events.some(
        (event) => event.type === 'tool_call' && event.id === 'r3' && event.status === 'completed',
      ),
    ).toBe(false);
  });
});

/**
 * E4 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — diminishing-returns stop.
 * Turns that stay novel (fresh reads each time, so the stall guard never fires) but
 * produce almost no output and no edits must end the run with the honest "converged"
 * notice, tagged for the sidebar.
 */
describe('streamAgent diminishing-returns stop (E4)', () => {
  const read = (id: string, name: string) => ({ id, name, arguments: {} });
  const tinyTurn = (call: ReturnType<typeof read>): AiResponse => ({
    text: '',
    toolCalls: [call],
    usage: { inputTokens: 500, outputTokens: 20 },
  });

  // Distinct zero-arg read tools, one per turn, so each turn is novel (dodges the stall
  // guard) while contributing nothing new (zero edits) — exercises the token-delta streak.
  const READ_TOOL_NAMES = [
    'get_timeline',
    'get_selected_range',
    'get_project_state',
    'list_assets',
    'get_timeline_summary',
    'get_transcript',
  ];

  it('stops a novel-but-tiny run with the tagged converged notice', async () => {
    const provider = new ScriptedProvider([
      ...Array.from({ length: DIMINISHING_RETURNS_TURNS }, (_, i) =>
        tinyTurn(read(`r${i + 1}`, READ_TOOL_NAMES[i % READ_TOOL_NAMES.length]!)),
      ),
      // Never reached: the reducer stops after the last low-delta turn.
      { text: 'should not run', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    const notice = events.find(
      (e) => e.type === 'notification' && e.reason === 'diminishing_returns',
    );
    expect(notice).toBeDefined();
    expect(notice?.type === 'notification' ? notice.text : '').toContain('converged');
    const expectedDeltas = Array.from({ length: DIMINISHING_RETURNS_TURNS }, () => '20').join(', ');
    expect(notice?.type === 'notification' ? (notice.detail ?? '') : '').toContain(expectedDeltas);
    // N turns ran, the trailing response was never requested.
    expect(provider.requests).toHaveLength(DIMINISHING_RETURNS_TURNS);
    // Every turn was a distinct read-only call — no edit ever landed, so ADR 0081's
    // causal completion gate ends this run `failed`, not `completed`, even though it
    // converged honestly rather than hitting a resource rail.
    expect(reduceEvents(events).status).toBe('failed');
  });

  it('does not fire when the provider reports no usage (no delta, no proof)', async () => {
    const provider = new ScriptedProvider([
      { text: '', toolCalls: [read('r1', 'get_timeline')] },
      { text: '', toolCalls: [read('r2', 'get_selected_range')] },
      { text: '', toolCalls: [read('r3', 'get_project_state')] },
      { text: 'done', toolCalls: [] },
    ]);
    const events = await drain(new Orchestrator(provider).streamAgent(input, opts()));
    expect(
      events.some((e) => e.type === 'notification' && e.reason === 'diminishing_returns'),
    ).toBe(false);
    expect(provider.requests).toHaveLength(4);
  });
});
