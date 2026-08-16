/**
 * Tests for the main-process streaming core (Phase 11 M3): {@link runAiStream}
 * forwards orchestrator events per mode, {@link parseAiStreamRequest} validates
 * untrusted input, and {@link AiStreamHub} enforces the security gate — unguessable
 * ids, **sender-scoped** abort, destroy/timeout cleanup. No Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockProvider,
  Orchestrator,
  type AiCompletionRequest,
  type AiEvent,
  type AiProvider,
  type ProviderChunk,
} from '@framepilot/ai-sdk';
import type { AiStreamEventMessage, AiStreamMode, AiStreamRequest } from '../ipc/contract.js';
import {
  AiStreamHub,
  type StreamSender,
  parseAgentOptions,
  parseAiStreamAnswer,
  parseAiStreamRequest,
  parseHistory,
  parseInteraction,
  parseSelection,
  parseUserMemory,
  prepareAiEventForTransport,
  runAiStream,
  timeoutMessage,
} from './ai-stream.js';

const project = {
  id: 'proj_1',
  name: 'Demo',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          {
            id: 'clip_a',
            assetId: 'asset_1',
            trackId: 'video_1',
            start: 0,
            end: 6,
            sourceStart: 0,
            sourceEnd: 6,
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
};

const request = (mode: AiStreamMode): AiStreamRequest => ({
  mode,
  project,
  userPrompt: 'tighten the intro',
  conversationId: 'conv_1',
  turnId: 'turn_1',
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parseAiStreamRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseAiStreamRequest(request('chat')).mode).toBe('chat');
  });

  it('rejects non-objects, bad modes, and non-string fields', () => {
    expect(() => parseAiStreamRequest(null)).toThrow('Invalid AI stream request');
    expect(() => parseAiStreamRequest({ mode: 'evil' })).toThrow('Invalid AI stream mode');
    expect(() => parseAiStreamRequest({ ...request('chat'), userPrompt: 5 })).toThrow('userPrompt');
  });

  it('accepts a valid provider and rejects an unknown one', () => {
    expect(parseAiStreamRequest({ ...request('agent'), provider: 'anthropic' }).provider).toBe(
      'anthropic',
    );
    expect(parseAiStreamRequest(request('agent')).provider).toBeUndefined();
    expect(() => parseAiStreamRequest({ ...request('agent'), provider: 'evil' })).toThrow(
      'Invalid AI provider',
    );
  });

  it('rejects a request still carrying the removed recipe payload', () => {
    // A stale renderer (or a probe) can still send `recipeRequest`. Ignoring an
    // instruction we will not follow is how a caller ends up believing work was
    // requested that never was — so this is a hard error, not a silent drop.
    expect(() =>
      parseAiStreamRequest({
        ...request('chat'),
        recipeRequest: { recipe: 'punch_in' },
      }),
    ).toThrow('no longer supported');
    // And the mode itself is gone from the contract.
    expect(() => parseAiStreamRequest({ ...request('chat'), mode: 'recipe' })).toThrow(
      'Invalid AI stream mode',
    );
  });

  it('accepts every configurable provider (guards against the validator drifting)', () => {
    // Regression: `ollama` was rejected here ("Invalid AI provider: ollama") because this
    // validator kept its own provider list that lagged the real roster. Assert the full set.
    for (const provider of ['mock', 'anthropic', 'nvidia', 'groq', 'deepseek', 'ollama']) {
      expect(parseAiStreamRequest({ ...request('agent'), provider }).provider).toBe(provider);
    }
  });

  it('threads validated history, selection, and agentOptions through (cross-surface sync)', () => {
    const parsed = parseAiStreamRequest({
      ...request('agent'),
      history: [{ role: 'user', content: 'shorter please' }],
      selection: { start: 1, end: 4 },
      agentOptions: { planFirst: true, durationTargetSeconds: 45 },
    });
    expect(parsed.history).toEqual([{ role: 'user', content: 'shorter please' }]);
    expect(parsed.selection).toEqual({ start: 1, end: 4 });
    expect(parsed.agentOptions).toEqual({ planFirst: true, durationTargetSeconds: 45 });
  });
});

describe('parseAiStreamAnswer (P12 — untrusted, and it becomes an instruction)', () => {
  it('accepts a well-formed answer and a dismissal', () => {
    expect(
      parseAiStreamAnswer({ toolCallId: 'ask1', kind: 'answered', answer: 'Punch in' }),
    ).toEqual({ toolCallId: 'ask1', answer: { kind: 'answered', answer: 'Punch in' } });
    expect(parseAiStreamAnswer({ toolCallId: 'ask1', kind: 'cancelled' })).toEqual({
      toolCallId: 'ask1',
      answer: { kind: 'cancelled' },
    });
  });

  it('drops malformed input rather than throwing (the question just stays pending)', () => {
    for (const bad of [
      null,
      undefined,
      'nope',
      {},
      { kind: 'answered', answer: 'x' }, // no toolCallId to address
      { toolCallId: '', kind: 'answered', answer: 'x' },
      { toolCallId: 'a', kind: 'weird' },
      { toolCallId: 'a', kind: 'answered' }, // no answer
      { toolCallId: 'a', kind: 'answered', answer: '   ' }, // blank is not an answer
      { toolCallId: 'a', kind: 'answered', answer: 42 },
    ]) {
      expect(parseAiStreamAnswer(bad)).toBeUndefined();
    }
  });

  it('bounds an oversized answer instead of letting it become the prompt', () => {
    const parsed = parseAiStreamAnswer({
      toolCallId: 'a',
      kind: 'answered',
      answer: 'x'.repeat(10_000),
    });
    expect(parsed?.answer.kind === 'answered' && parsed.answer.answer.length).toBe(2_000);
  });
});

describe('parseHistory', () => {
  it('returns undefined when absent and throws on a non-array', () => {
    expect(parseHistory(undefined)).toBeUndefined();
    expect(() => parseHistory('nope')).toThrow('history');
  });

  it('keeps valid user/assistant turns and drops malformed entries', () => {
    const out = parseHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      null,
      { role: 'evil', content: 'c' },
      { role: 'user', content: 5 },
      'string',
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('caps the number of turns accepted over the bridge', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    expect(parseHistory(many)).toHaveLength(50);
  });
});

describe('parseSelection', () => {
  it('returns undefined when absent and validates the range', () => {
    expect(parseSelection(undefined)).toBeUndefined();
    expect(parseSelection({ start: 1, end: 4 })).toEqual({ start: 1, end: 4 });
    expect(() => parseSelection('x')).toThrow('selection');
    expect(() => parseSelection({ start: -1, end: 4 })).toThrow('selection');
    expect(() => parseSelection({ start: 4, end: 1 })).toThrow('selection');
    expect(() => parseSelection({ start: Number.NaN, end: 1 })).toThrow('selection');
  });
});

describe('parseInteraction', () => {
  const valid = {
    schemaVersion: 2,
    projectRevision: 7,
    timelineRevision: 3,
    sequenceId: 'proj_1',
    playhead: { seconds: 2, frame: 60 },
    selection: {
      primaryClipId: 'clip_a',
      clipIds: ['clip_a'],
      trackIds: ['video_1'],
      effectLayerIds: ['fx_1'],
      keyframes: [{ clipId: 'clip_a', property: 'x', time: 1 }],
      timeRange: { start: 0, end: 6 },
    },
    sourceMonitor: {
      assetId: 'asset_a',
      rate: { numerator: 30, denominator: 1 },
      playhead: { seconds: 2, frame: 60 },
      markedRange: { startFrame: 30, endFrame: 90 },
    },
  };

  it('accepts the versioned bounded shape', () => {
    expect(parseInteraction(valid)).toEqual(valid);
    expect(parseAiStreamRequest({ ...request('agent'), interaction: valid }).interaction).toEqual(
      valid,
    );
  });

  it('rejects unsupported versions, invalid frames, and a primary outside the selection', () => {
    expect(() => parseInteraction({ ...valid, schemaVersion: 1 })).toThrow('version');
    expect(() => parseInteraction({ ...valid, playhead: { seconds: 2, frame: 1.5 } })).toThrow(
      'playhead',
    );
    expect(() =>
      parseInteraction({
        ...valid,
        selection: { ...valid.selection, primaryClipId: 'missing' },
      }),
    ).toThrow('primaryClipId');
    expect(() =>
      parseInteraction({
        ...valid,
        sourceMonitor: { ...valid.sourceMonitor, rate: { numerator: 0, denominator: 1 } },
      }),
    ).toThrow('sourceMonitor');
    expect(() =>
      parseInteraction({
        ...valid,
        sourceMonitor: { ...valid.sourceMonitor, markedRange: { startFrame: 90, endFrame: 30 } },
      }),
    ).toThrow('sourceMonitor');
    expect(() =>
      parseInteraction({
        ...valid,
        selection: { ...valid.selection, keyframes: [{ clipId: 'clip_a', property: '', time: 1 }] },
      }),
    ).toThrow('keyframes');
  });
});

describe('parseUserMemory (K6.1)', () => {
  it('returns undefined when absent or empty', () => {
    expect(parseUserMemory(undefined)).toBeUndefined();
    expect(parseUserMemory({})).toBeUndefined();
    expect(parseUserMemory({ unknownField: 'x' })).toBeUndefined();
  });

  it('trims + length-caps free-text fields and drops non-strings', () => {
    expect(parseUserMemory({ captionStyle: '  karaoke  ', brandStyle: 42 })).toEqual({
      captionStyle: 'karaoke',
    });
    const long = 'x'.repeat(500);
    expect(
      (parseUserMemory({ targetAudience: long }) as { targetAudience: string }).targetAudience,
    ).toHaveLength(200);
  });

  it('sanitises + bounds favouriteExportPlatforms, dropping junk entries', () => {
    expect(parseUserMemory({ favoriteExportPlatforms: ['reels', '', 5, '  shorts '] })).toEqual({
      favoriteExportPlatforms: ['reels', 'shorts'],
    });
    const many = Array.from({ length: 40 }, (_, i) => `p${String(i)}`);
    expect(
      (parseUserMemory({ favoriteExportPlatforms: many }) as { favoriteExportPlatforms: string[] })
        .favoriteExportPlatforms,
    ).toHaveLength(20);
  });

  it('rejects a non-object userMemory', () => {
    expect(() => parseUserMemory('nope')).toThrow('userMemory');
  });

  it('flows through parseAiStreamRequest into the request', () => {
    const parsed = parseAiStreamRequest({
      ...request('agent'),
      userMemory: { captionStyle: 'karaoke', favoriteExportPlatforms: ['reels'] },
    });
    expect(parsed.userMemory).toEqual({
      captionStyle: 'karaoke',
      favoriteExportPlatforms: ['reels'],
    });
  });
});

describe('parseAgentOptions', () => {
  it('returns undefined when absent and throws on a non-object', () => {
    expect(parseAgentOptions(undefined)).toBeUndefined();
    expect(() => parseAgentOptions('x')).toThrow('agentOptions');
  });

  it('validates numeric caps, booleans, and the target platform allowlist', () => {
    expect(
      parseAgentOptions({
        maxSteps: 12,
        maxOpsPerTurn: 40,
        maxOpsPerRun: 200,
        durationTargetSeconds: 45,
        autoRepair: true,
        planFirst: false,
        targetPlatform: 'reels',
        unknownIgnored: 'x',
      }),
    ).toEqual({
      maxSteps: 12,
      maxOpsPerTurn: 40,
      maxOpsPerRun: 200,
      durationTargetSeconds: 45,
      autoRepair: true,
      planFirst: false,
      targetPlatform: 'reels',
    });
    expect(() => parseAgentOptions({ maxSteps: -1 })).toThrow('maxSteps');
    expect(() => parseAgentOptions({ autoRepair: 'yes' })).toThrow('autoRepair');
    expect(() => parseAgentOptions({ targetPlatform: 'myspace' })).toThrow('targetPlatform');
  });
});

describe('runAiStream', () => {
  async function collect(mode: AiStreamMode, signal?: AbortSignal): Promise<AiEvent[]> {
    const events: AiEvent[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      request(mode),
      (event) => events.push(event),
      signal ?? new AbortController().signal,
    );
    return events;
  }

  it.each(['chat', 'plan', 'edit', 'agent'] as const)(
    'forwards %s events ending in a completed status',
    async (mode) => {
      const events = await collect(mode);
      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    },
  );

  it('reads the visual-index status once per run and passes the project id', async () => {
    // The gap this closes: `ContextInput.visualStatus` existed in the SDK and no host
    // ever filled it, so every run started with no idea whether it could search this
    // footage by content — and answered questions about what is on screen from the
    // timeline summary, which cannot see.
    const seen: string[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      request('chat'),
      () => undefined,
      new AbortController().signal,
      {},
      async (projectId) => {
        seen.push(projectId);
        return 'Visual index: 3/3 assets, 900 vectors, local backend — use search_visual.';
      },
    );
    expect(seen).toEqual([project.id]);
  });

  it('reads the footage map alongside the status, and both fail soft', async () => {
    // The map is the structure of what is IN the footage. It reaches the model through
    // the same fail-soft channel, and — critically — through a CACHE-ONLY read, so a cold
    // project costs a run nothing rather than stalling it on a billed Pegasus fetch.
    const seen: string[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      request('chat'),
      () => undefined,
      new AbortController().signal,
      {},
      () => Promise.reject(new Error('sidecar is busy')),
      async (projectId) => {
        seen.push(projectId);
        return 'Footage map (0:14 total) — the structure of what is IN the footage.';
      },
    );
    expect(seen).toEqual([project.id]);
  });

  it('runs normally when the status read fails — context, never a dependency', async () => {
    // A busy or unreachable sidecar must cost the run its status BLOCK, not the run.
    const events: AiEvent[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      request('chat'),
      (event) => events.push(event),
      new AbortController().signal,
      {},
      () => Promise.reject(new Error('sidecar is busy')),
    );
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('produces a diff event for an edit run', async () => {
    expect((await collect('edit')).some((e) => e.type === 'diff')).toBe(true);
  });

  it('forwards editor lifecycle records on a separate main-process control', async () => {
    const events: AiEvent[] = [];
    const lifecycle: unknown[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      request('edit'),
      (event) => events.push(event),
      new AbortController().signal,
      { onLifecycleEvent: (event) => lifecycle.push(event) },
    );

    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(lifecycle[0]).toMatchObject({ stage: 'understand', state: 'entered' });
    expect(lifecycle.at(-1)).toMatchObject({ stage: 'finalize', state: 'completed' });
  });

  it('routes planned-edit through the shared editor lifecycle in main', async () => {
    for (const streamRequest of [request('planned-edit')]) {
      const lifecycle: unknown[] = [];
      await runAiStream(
        new Orchestrator(new MockProvider()),
        streamRequest,
        () => undefined,
        new AbortController().signal,
        { onLifecycleEvent: (event) => lifecycle.push(event) },
      );
      expect(lifecycle[0]).toMatchObject({ stage: 'understand', state: 'entered' });
      expect(lifecycle.at(-1)).toMatchObject({ stage: 'finalize' });
    }
  });

  it('forwards a cancelled terminal when pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await collect('chat', controller.signal)).at(-1)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('threads agentOptions.planFirst into the agent loop (desktop parity)', async () => {
    const events: AiEvent[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      { ...request('agent'), agentOptions: { planFirst: true } },
      (event) => events.push(event),
      new AbortController().signal,
    );
    // planFirst runs an up-front planning turn → a 'planning' status is emitted.
    expect(events.some((e) => e.type === 'status' && e.status === 'planning')).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('maps acceptance targets through agentOptions and fails when duration remains unmet', async () => {
    const events: AiEvent[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      { ...request('agent'), agentOptions: { durationTargetSeconds: 45, targetPlatform: 'reels' } },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('threads history + selection without error and completes', async () => {
    const events: AiEvent[] = [];
    await runAiStream(
      new Orchestrator(new MockProvider()),
      {
        ...request('chat'),
        history: [{ role: 'user', content: 'earlier' }],
        selection: { start: 0, end: 2 },
      },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });
});

/** A provider whose stream parks until aborted — keeps a run "active" for hub tests. */
class StallingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public async complete(): Promise<{ text: string }> {
    return { text: '' };
  }
  public async *stream(
    _request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield* []; // park until aborted, then end with no chunks
  }
}

/** A fake WebContents capturing pushes + the destroy listener. */
class FakeSender implements StreamSender {
  public readonly messages: AiStreamEventMessage[] = [];
  private destroyListeners: (() => void)[] = [];
  public destroyed = false;
  public failSend = false;
  public sendAttempts = 0;
  public constructor(public readonly id: number) {}
  public isDestroyed(): boolean {
    return this.destroyed;
  }
  public send(_channel: string, message: AiStreamEventMessage): void {
    this.sendAttempts += 1;
    if (this.failSend) throw new Error('Render frame was disposed');
    this.messages.push(message);
  }
  public once(_event: 'destroyed', listener: () => void): void {
    this.destroyListeners.push(listener);
  }
  public removeListener(_event: 'destroyed', listener: () => void): void {
    this.destroyListeners = this.destroyListeners.filter((l) => l !== listener);
  }
  public fireDestroyed(): void {
    this.destroyed = true;
    this.destroyListeners.forEach((l) => l());
  }
  public has(predicate: (m: AiStreamEventMessage) => boolean): boolean {
    return this.messages.some(predicate);
  }
}

describe('prepareAiEventForTransport', () => {
  it('keeps a tool lifecycle but omits project-sized expandable details', () => {
    const event: AiEvent = {
      id: 'result-1',
      conversationId: 'conversation',
      turnId: 'turn',
      ts: 1,
      type: 'tool_result',
      toolCallId: 'call-1',
      summary: 'Reading the project',
      result: { history: [{ inverse: 'x'.repeat(300_000) }] },
    };

    expect(prepareAiEventForTransport(event)).toEqual({
      id: 'result-1',
      conversationId: 'conversation',
      turnId: 'turn',
      ts: 1,
      type: 'tool_result',
      toolCallId: 'call-1',
      summary: 'Reading the project',
      result: {
        omitted: true,
        reason: 'Tool details exceeded the desktop transport limit; the summary is retained.',
      },
    });
  });

  it('preserves small tool details exactly', () => {
    const event: AiEvent = {
      id: 'result-1',
      conversationId: 'conversation',
      turnId: 'turn',
      ts: 1,
      type: 'tool_result',
      toolCallId: 'call-1',
      result: { clips: ['clip-1'] },
    };
    expect(prepareAiEventForTransport(event)).toBe(event);
  });
});

describe('AiStreamHub', () => {
  let idSeq = 0;
  const stallingHub = () =>
    new AiStreamHub(() => new Orchestrator(new StallingProvider()), {
      eventChannel: 'evt',
      newId: () => `id_${(idSeq += 1)}`,
    });

  beforeEach(() => {
    idSeq = 0;
  });

  it('passes the requested provider to the orchestrator factory', async () => {
    const seen: (string | undefined)[] = [];
    const hub = new AiStreamHub(
      (provider) => {
        seen.push(provider);
        return new Orchestrator(new MockProvider());
      },
      { eventChannel: 'evt' },
    );
    hub.start(new FakeSender(1), { ...request('agent'), provider: 'anthropic' });
    await flush();
    expect(seen).toEqual(['anthropic']);
  });

  it('detaches a disposed renderer after the first send race without cancelling durable work', async () => {
    const sender = new FakeSender(1);
    sender.failSend = true;
    let settlement: string | undefined;
    const hub = new AiStreamHub(() => new Orchestrator(new MockProvider()), {
      eventChannel: 'evt',
      newId: () => 'durable-request',
    });

    hub.start(sender, request('chat'), {
      durableRunId: 'durable-run',
      onSettled: (value) => {
        settlement = value.status;
      },
    });
    await flush();

    expect(sender.sendAttempts).toBe(1);
    expect(settlement).toBe('completed');
  });

  it('mints a requestId, scopes events to the sender, and completes', async () => {
    const sender = new FakeSender(1);
    const hub = new AiStreamHub(() => new Orchestrator(new MockProvider()), {
      eventChannel: 'evt',
    });
    const requestId = hub.start(sender, request('chat'));
    expect(requestId).toMatch(/[0-9a-f-]{36}/); // randomUUID by default
    await flush();
    expect(sender.messages.every((m) => m.requestId === requestId)).toBe(true);
    expect(sender.has((m) => m.done === true)).toBe(true);
  });

  it('pushes an error (not a throw) for an invalid request', async () => {
    const sender = new FakeSender(1);
    const hub = new AiStreamHub(() => new Orchestrator(new MockProvider()), {
      eventChannel: 'evt',
    });
    hub.start(sender, { mode: 'evil' });
    await flush();
    expect(sender.has((m) => typeof m.error === 'string')).toBe(true);
  });

  it('stringifies a non-Error thrown while starting a run', async () => {
    const sender = new FakeSender(1);
    const hub = new AiStreamHub(
      () => {
        throw 'boom'; // a non-Error rejection → String(error) path
      },
      { eventChannel: 'evt' },
    );
    hub.start(sender, request('chat'));
    await flush();
    expect(sender.has((m) => m.error === 'boom')).toBe(true);
  });

  it('ignores an abort from a different sender, honors the owning sender', async () => {
    const owner = new FakeSender(1);
    const intruder = new FakeSender(2);
    const hub = stallingHub();
    const requestId = hub.start(owner, request('chat'));
    await flush();
    expect(owner.has((m) => m.done === true)).toBe(false); // parked

    hub.abort(intruder, requestId); // wrong sender → ignored
    await flush();
    expect(owner.has((m) => m.done === true)).toBe(false);

    hub.abort(owner, requestId); // owner → aborts → completes
    await flush();
    expect(owner.has((m) => m.done === true)).toBe(true);
  });

  it('ignores an answer from a different sender (an answer is an instruction)', async () => {
    // Same trust boundary as abort: another window must not be able to answer this
    // run's question, because the model acts on whatever comes back.
    const owner = new FakeSender(1);
    const intruder = new FakeSender(2);
    const hub = stallingHub();
    const requestId = hub.start(owner, request('chat'));
    await flush();
    // Neither of these throws, and neither resolves anything — the run is untouched.
    expect(() =>
      hub.answer(intruder, requestId, { toolCallId: 'ask1', kind: 'answered', answer: 'x' }),
    ).not.toThrow();
    expect(() =>
      hub.answer(owner, 'no-such-run', { toolCallId: 'ask1', kind: 'answered', answer: 'x' }),
    ).not.toThrow();
    expect(() => hub.answer(owner, requestId, { nonsense: true })).not.toThrow();
    await flush();
    expect(owner.has((m) => m.done === true)).toBe(false);
    hub.abort(owner, requestId);
    await flush();
  });

  it('aborts and cleans up the run when the sender is destroyed', async () => {
    const sender = new FakeSender(1);
    const hub = stallingHub();
    hub.start(sender, request('chat'));
    await flush();
    expect(hub.activeCount()).toBe(1);
    sender.fireDestroyed();
    await flush();
    // The run is aborted + removed; nothing is written to the destroyed sender.
    expect(hub.activeCount()).toBe(0);
    expect(sender.messages.filter((m) => m.done === true)).toHaveLength(0);
  });

  it('keeps a durable run alive when its renderer is destroyed', async () => {
    const sender = new FakeSender(1);
    const hub = stallingHub();
    hub.start(sender, request('chat'), { durableRunId: 'run_1' });
    await flush();
    expect(hub.activeCount()).toBe(1);

    sender.fireDestroyed();
    await flush();

    // Renderer lifecycle is only projection lifecycle; main still owns the run.
    expect(hub.activeCount()).toBe(1);
    hub.abortAll();
    await flush();
    expect(hub.activeCount()).toBe(0);
  });

  it('requires the durable command path to stop a durable run', async () => {
    const sender = new FakeSender(1);
    const hub = stallingHub();
    const requestId = hub.start(sender, request('chat'), { durableRunId: 'run_1' });
    await flush();

    hub.abort(sender, requestId);
    await flush();

    expect(hub.activeCount()).toBe(1);
    hub.abortDurable('run_1');
    await flush();
    expect(hub.activeCount()).toBe(0);
  });

  it('aborts a run that exceeds the timeout with an explanatory error (not a silent cancel)', async () => {
    const sender = new FakeSender(1);
    const settlements: unknown[] = [];
    const hub = new AiStreamHub(() => new Orchestrator(new StallingProvider()), {
      eventChannel: 'evt',
      timeoutMs: 5,
    });
    hub.start(sender, request('chat'), {
      onSettled: (settlement) => {
        settlements.push(settlement);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The cap fired: the run must end with a human-readable reason, so the user can
    // tell a timed-out run from one they stopped themselves.
    expect(sender.has((m) => m.error === timeoutMessage(5))).toBe(true);
    expect(sender.has((m) => m.done === true)).toBe(false);
    expect(hub.activeCount()).toBe(0);
    expect(settlements).toEqual([
      expect.objectContaining({ status: 'failed', kind: 'timed_out', source: 'timeout' }),
    ]);
  });

  it('formats the timeout limit in whole minutes', () => {
    expect(timeoutMessage(30 * 60 * 1000)).toContain('30-minute limit');
  });

  it('abortAll cancels every in-flight run', async () => {
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    const hub = stallingHub();
    hub.start(a, request('chat'));
    hub.start(b, request('chat'));
    await flush();
    hub.abortAll();
    await flush();
    expect(a.has((m) => m.done === true) && b.has((m) => m.done === true)).toBe(true);
  });

  it('does not write to a destroyed sender', async () => {
    const sender = new FakeSender(1);
    sender.destroyed = true;
    const hub = new AiStreamHub(() => new Orchestrator(new MockProvider()), {
      eventChannel: 'evt',
    });
    hub.start(sender, request('chat'));
    await flush();
    expect(sender.messages).toHaveLength(0);
  });
});

afterEach(() => vi.restoreAllMocks());
