import { describe, expect, it } from 'vitest';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
} from './providers/types.js';
import {
  Orchestrator,
  callMemoKey,
  emptyResponseDetail,
  outputRoomFor,
  truncationRetryHint,
  unusableTurnReason,
} from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';

/** A provider that records every request it is given and answers with plain text. */
function recordingProvider(name: 'openai-compatible' | 'anthropic', modelId?: string) {
  const requests: AiCompletionRequest[] = [];
  const provider: AiProvider & { requests: AiCompletionRequest[] } = {
    name,
    modelId,
    requests,
    async complete(request): Promise<AiResponse> {
      requests.push(request);
      return { text: 'Done.', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(request): AsyncGenerator<ProviderChunk> {
      requests.push(request);
      yield { type: 'text-delta', text: 'Done.' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return provider;
}

describe('outputRoomFor', () => {
  it('asks for the reserved output room, clamped to the model ceiling', () => {
    const p = recordingProvider('openai-compatible', 'claude-sonnet-5');
    expect(outputRoomFor(p, { reservedOutputTokens: 16_000 })).toBe(16_000);
    expect(outputRoomFor(p, { reservedOutputTokens: 10_000_000 })).toBe(128_000);
    expect(outputRoomFor(p, {})).toBe(128_000);
  });

  it('falls back to the provider default ceiling for an unknown model', () => {
    const p = recordingProvider('openai-compatible');
    expect(outputRoomFor(p, { reservedOutputTokens: 50_000 })).toBe(4_096);
  });
});

describe('agent requests carry maxTokens', () => {
  it('puts an explicit maxTokens on every streamed agent request', async () => {
    const provider = recordingProvider('openai-compatible', 'claude-sonnet-5');
    const orchestrator = new Orchestrator(provider);
    const events = [];
    for await (const event of orchestrator.streamAgent(
      { project: makeProject(), userPrompt: 'trim the first clip by one second' },
      { conversationId: 'c', turnId: 't' },
      {},
    ))
      events.push(event);
    const agentRequests = provider.requests.filter((r) => r.tools && r.tools.length > 0);
    expect(agentRequests.length).toBeGreaterThan(0);
    for (const r of agentRequests) {
      expect(r.maxTokens).toBeDefined();
      expect(r.maxTokens).toBeGreaterThan(8_192);
      expect(r.maxTokens).toBeLessThanOrEqual(128_000);
    }
  });
});

describe('callMemoKey (P1.1c)', () => {
  it('treats a smaller re-render of the same frame as the same call', () => {
    const a = callMemoKey({
      id: '1',
      name: 'get_frame',
      arguments: { timeSeconds: 15, maxDimension: 640 },
    });
    const b = callMemoKey({
      id: '2',
      name: 'get_frame',
      arguments: { timeSeconds: 15, maxDimension: 480 },
    });
    const c = callMemoKey({
      id: '3',
      name: 'get_frame',
      arguments: { timeSeconds: 16, maxDimension: 640 },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps every other tool keyed by its full arguments', () => {
    expect(
      callMemoKey({ id: '1', name: 'detect_scenes', arguments: { assetId: 'a', threshold: 0.3 } }),
    ).not.toBe(
      callMemoKey({ id: '2', name: 'detect_scenes', arguments: { assetId: 'a', threshold: 0.4 } }),
    );
  });
});

describe('truncated reply retry (P1.1e)', () => {
  it('retries a cut-off reply with a message that says so and asks for smaller steps', async () => {
    const requests: AiCompletionRequest[] = [];
    let streams = 0;
    const provider: AiProvider = {
      name: 'openai-compatible',
      modelId: 'claude-sonnet-5',
      async complete(request): Promise<AiResponse> {
        requests.push(request);
        return { text: 'Done.', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *stream(request): AsyncGenerator<ProviderChunk> {
        requests.push(request);
        streams += 1;
        if (streams === 1 && request.tools && request.tools.length > 0) {
          yield { type: 'text-delta', text: 'Rebuilding the 30 seconds as a 23-shot' };
          yield { type: 'done', text: 'Rebuilding the 30 seconds as a 23-shot', truncated: true };
          return;
        }
        yield { type: 'text-delta', text: 'Nothing more to do.' };
        yield { type: 'done', text: 'Nothing more to do.' };
      },
    };
    const orchestrator = new Orchestrator(provider);
    const events = [];
    for await (const event of orchestrator.streamAgent(
      { project: makeProject(), userPrompt: 'tighten the whole thing' },
      { conversationId: 'c', turnId: 't' },
      {},
    ))
      events.push(event);
    const agentRequests = requests.filter((r) => r.tools && r.tools.length > 0);
    expect(agentRequests.length).toBeGreaterThanOrEqual(2);
    const retry = agentRequests[1]!;
    const last = retry.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toBe(truncationRetryHint());
    expect(last.content).toContain('cut off');
    // The first request carried no such hint.
    expect(agentRequests[0]!.messages.at(-1)!.content).not.toContain('cut off');
  });
});

describe('tool calls lost in transit', () => {
  /** A provider whose first agent turn loses its tool call to a cut-off stream. */
  function droppingProvider(dropped: readonly string[]) {
    const requests: AiCompletionRequest[] = [];
    let streams = 0;
    const provider: AiProvider & { requests: AiCompletionRequest[] } = {
      name: 'openai-compatible',
      modelId: 'claude-sonnet-5',
      requests,
      async complete(request): Promise<AiResponse> {
        requests.push(request);
        return { text: 'Done.', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *stream(request): AsyncGenerator<ProviderChunk> {
        requests.push(request);
        const isAgentTurn = (request.tools?.length ?? 0) > 0;
        if (isAgentTurn) streams += 1;
        if (isAgentTurn && streams === 1) {
          yield { type: 'text-delta', text: 'Laying the talking head down and bedding the music.' };
          yield {
            type: 'done',
            text: 'Laying the talking head down and bedding the music.',
            truncated: true,
            droppedToolCalls: dropped,
          };
          return;
        }
        yield { type: 'text-delta', text: 'Nothing more to do.' };
        yield { type: 'done', text: 'Nothing more to do.' };
      },
    };
    return provider;
  }

  it('retries the step and names the tool whose arguments never arrived', async () => {
    // Without the names the retry is the same ask worded the same way, and it is cut at the
    // same place: the model has no way to know which of its calls was discarded in transit.
    const provider = droppingProvider(['add_clip']);
    const orchestrator = new Orchestrator(provider);
    for await (const _ of orchestrator.streamAgent(
      { project: makeProject(), userPrompt: 'lay the talking head down' },
      { conversationId: 'c', turnId: 't' },
      {},
    )); /* drain */
    const agentRequests = provider.requests.filter((r) => r.tools && r.tools.length > 0);
    expect(agentRequests.length).toBeGreaterThanOrEqual(2);
    const hint = agentRequests[1]!.messages.at(-1)!;
    expect(hint.role).toBe('user');
    expect(hint.content).toContain('add_clip');
    expect(hint.content).toBe(truncationRetryHint(['add_clip']));
  });
});

describe('truncationRetryHint', () => {
  it('says only that the reply was cut off when nothing identifiable was lost', () => {
    expect(truncationRetryHint()).toContain('cut off');
    expect(truncationRetryHint()).not.toContain('discarded');
  });

  it('names each lost tool once, however many of its calls were dropped', () => {
    const hint = truncationRetryHint(['add_clip', 'add_clip', 'transcribe']);
    expect(hint).toContain('add_clip, transcribe');
    expect(hint.match(/add_clip/g)).toHaveLength(1);
  });
});

describe('unusableTurnReason', () => {
  const spoke = { text: 'Now the motion accents on the key beats', calls: [] };

  it('reads a call-less turn with edits behind it as the model finishing', () => {
    expect(unusableTurnReason({ ...spoke, truncated: true }, 12, 'apply')).toBeUndefined();
  });

  it('does NOT read a turn whose calls were lost in transit as the model finishing', () => {
    // The captured run ended here: turn 1 closed as "completed" on a sentence that stopped
    // mid-word, and the motion work it had just promised was never attempted. A model whose
    // tool calls were discarded by our own reassembly declared nothing finished.
    expect(
      unusableTurnReason(
        { ...spoke, truncated: true, droppedToolCalls: ['add_text'] },
        12,
        'apply',
      ),
    ).toBe('truncated');
  });

  it('still says so at verify, where prose alone is otherwise a legal ending', () => {
    expect(
      unusableTurnReason({ ...spoke, droppedToolCalls: ['verify_captions'] }, 12, 'verify'),
    ).toBe('truncated');
  });

  it('calls a cut-off reply with nothing in it truncated, not empty', () => {
    // The two are retried differently: `empty` replays the turn verbatim, and a model that
    // has just spent its whole output budget returns the identical empty reply. Both of the
    // captured run's final attempts billed 8,192 output tokens and said nothing.
    expect(unusableTurnReason({ text: '', calls: [], truncated: true }, 0, 'apply')).toBe(
      'truncated',
    );
  });

  it('still calls a silent turn the provider said nothing about empty', () => {
    expect(unusableTurnReason({ text: '', calls: [] }, 0, 'apply')).toBe('empty');
  });

  it('leaves a turn that produced calls alone', () => {
    expect(
      unusableTurnReason({ ...spoke, calls: [{}], droppedToolCalls: ['add_clip'] }, 0, 'apply'),
    ).toBeUndefined();
  });
});

describe('emptyResponseDetail', () => {
  it('blames the provider when the turn was barely billed', () => {
    const detail = emptyResponseDetail({ inputTokens: 900, outputTokens: 3 }, 8_192);
    expect(detail).toContain('overloaded');
    expect(detail).not.toContain('output allowance');
  });

  it('names the output budget when the model spent all of it and said nothing', () => {
    // The captured run: 8,192 output tokens charged against an 8,192-token reservation,
    // reported to the creator as the provider being overloaded — the one cause they could
    // not have done anything about.
    const detail = emptyResponseDetail({ inputTokens: 722, outputTokens: 8_192 }, 8_192);
    expect(detail).toContain('entire output allowance');
    expect(detail).toContain('8192');
    expect(detail).toContain('smaller step');
    expect(detail).not.toContain('overloaded');
  });

  it('stays general when the provider reported no usage at all', () => {
    // A count is never fabricated, so an unreported turn cannot be diagnosed either.
    expect(emptyResponseDetail(undefined, 8_192)).toContain('overloaded');
  });
});
