import { describe, expect, it } from 'vitest';
import type { AiCompletionRequest, AiProvider, AiResponse, ProviderChunk } from './providers/types.js';
import { Orchestrator, callMemoKey, outputRoomFor } from './orchestrator.js';
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
    )) events.push(event);
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
    const a = callMemoKey({ id: '1', name: 'get_frame', arguments: { timeSeconds: 15, maxDimension: 640 } });
    const b = callMemoKey({ id: '2', name: 'get_frame', arguments: { timeSeconds: 15, maxDimension: 480 } });
    const c = callMemoKey({ id: '3', name: 'get_frame', arguments: { timeSeconds: 16, maxDimension: 640 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps every other tool keyed by its full arguments', () => {
    expect(callMemoKey({ id: '1', name: 'detect_scenes', arguments: { assetId: 'a', threshold: 0.3 } })).not.toBe(
      callMemoKey({ id: '2', name: 'detect_scenes', arguments: { assetId: 'a', threshold: 0.4 } }),
    );
  });
});
