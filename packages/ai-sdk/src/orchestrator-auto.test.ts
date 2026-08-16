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
import { createAskUserGate } from './run-controls.js';
import type { HostToolExecutor } from './tool-executor.js';

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
    const plan = JSON.stringify({
      steps: [
        {
          id: 'beats',
          label: 'detect exact music onsets',
          effect: { kind: 'host_tool', name: 'detect_beats', args: { assetId: 'music' } },
          resource: 'ffmpeg',
          priority: 'analysis',
        },
        {
          id: 'scenes',
          label: 'detect source shot changes',
          effect: { kind: 'host_tool', name: 'detect_scenes', args: { assetId: 'broll' } },
          resource: 'ffmpeg',
          priority: 'analysis',
        },
        {
          id: 'place',
          label: 'place selected source moments on supported beat boundaries',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
          deps: ['beats', 'scenes'],
        },
        {
          id: 'patch',
          label: 'assemble the beat edit',
          effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'place' } },
          deps: ['place'],
        },
        {
          id: 'verify',
          label: 'verify the assembled sequence',
          effect: { kind: 'verify', name: 'verify', args: { goal: 'beat-synced montage' } },
          deps: ['patch'],
        },
      ],
    });
    const provider = new ScriptedProvider([
      { text: '{"route":"planned_edit"}' },
      {
        text: JSON.stringify({
          goal: 'assemble b-roll to detected music events',
          targets: ['video_1', 'music', 'broll'],
          constraints: ['use detected beat evidence'],
        }),
      },
      { text: plan },
      {
        // First proposal is deliberately off-grid. The deterministic planned-edit
        // boundary must reject it and spend its one bounded repair attempt.
        text: JSON.stringify({
          toolCalls: [
            {
              name: 'add_clip',
              arguments: {
                trackId: 'video_1',
                assetId: 'broll',
                start: 0.1,
                end: 0.75,
                sourceStart: 0,
              },
            },
          ],
        }),
      },
      {
        text: JSON.stringify({
          toolCalls: [
            {
              name: 'add_clip',
              arguments: {
                trackId: 'video_1',
                assetId: 'broll',
                start: 0,
                end: 0.75,
                sourceStart: 0,
              },
            },
            {
              name: 'add_clip',
              arguments: {
                trackId: 'video_1',
                assetId: 'broll',
                start: 0.75,
                end: 1.75,
                sourceStart: 2,
              },
            },
            {
              name: 'add_clip',
              arguments: {
                trackId: 'video_1',
                assetId: 'broll',
                start: 1.75,
                end: 3,
                sourceStart: 4,
              },
            },
          ],
        }),
      },
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
    expect(adds.map(({ start, end }) => [start, end])).toEqual([
      [0, 0.75],
      [0.75, 1.75],
      [1.75, 3],
    ]);
    expect(adds.map(({ start, end }) => Number(end) - Number(start))).toEqual([0.75, 1, 1.25]);
    expect(provider.calls).toBe(5);

    const after = applyProjectPatch(beatProject, diff!.edit.patch as never);
    const restored = applyProjectPatch(
      after,
      invertProjectPatch(beatProject, diff!.edit.patch as never),
    );
    expect(diffProject(beatProject, restored).summary).toEqual(['no changes']);
  });

  it('continues an unsupported planned edit in the general agent with long-video context and exact cost', async () => {
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
      { text: '{"route":"planned_edit"}', usage: { inputTokens: 10, outputTokens: 2 } },
      {
        text: JSON.stringify({
          goal: 'build a beat-driven montage',
          targets: ['long_asset'],
          constraints: ['30 seconds', 'ground shot choices in evidence'],
        }),
        usage: { inputTokens: 20, outputTokens: 3 },
      },
      {
        text: JSON.stringify({
          steps: [
            {
              label: 'invent an unsupported edit primitive',
              effect: { kind: 'model', name: 'magic_montage', args: {} },
            },
          ],
        }),
        usage: { inputTokens: 30, outputTokens: 4 },
      },
      {
        text: 'I inspected the bounded context and stopped honestly.',
        usage: { inputTokens: 40, outputTokens: 5 },
      },
    ]);

    const events = await collect(
      new Orchestrator(provider).streamAuto({ project: longProject, userPrompt: prompt }, opts),
    );

    // The fallback agent declared itself done with its committed objective still pending,
    // so the conductor issued one bounded mutation-only continuation before failing closed.
    expect(provider.calls).toBe(5);
    expect(
      provider.requests[1]?.messages.some((message) => message.content.includes('7200.00s')),
    ).toBe(true);
    expect(provider.requests[3]?.messages.some((message) => message.content.includes(prompt))).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'notification' &&
          event.text === 'This request needs the general planner path, which is not live yet.',
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === 'notification' && event.text.includes('general agent is continuing'),
      ),
    ).toBe(true);
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ tokens: 159 });
    // The general agent honestly recognized the requested primitive is unsupported and
    // stopped without landing an edit — ADR 0081's causal completion gate means that is
    // `failed`, not `completed`: the timeline is untouched, whatever the reason.
    expect(statuses(events).at(-1)).toBe('failed');
  });

  it('does not start the general-agent fallback after cancellation settles the planner call', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider(
      [
        { text: '{"route":"planned_edit"}', usage: { inputTokens: 10, outputTokens: 1 } },
        {
          text: '{"goal":"montage","targets":[],"constraints":[]}',
          usage: { inputTokens: 20, outputTokens: 2 },
        },
        {
          text: '{"steps":[{"label":"unsupported","effect":{"kind":"model","name":"magic","args":{}}}]}',
          usage: { inputTokens: 30, outputTokens: 3 },
        },
        { text: 'must never be requested' },
      ],
      (call) => {
        if (call === 3) controller.abort('user stopped');
      },
    );

    const events = await collect(
      new Orchestrator(provider).streamAuto(input, { ...opts, signal: controller.signal }),
    );

    expect(provider.calls).toBe(3);
    expect(statuses(events).at(-1)).toBe('cancelled');
    expect(
      events.some(
        (event) =>
          event.type === 'notification' && event.text.includes('general agent is continuing'),
      ),
    ).toBe(false);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
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
      public readonly name = 'mock' as const;
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
