/**
 * `providers/langchain.ts` behavior tests (M1.1).
 *
 * Driven through an injected `fetch` returning real Anthropic wire payloads —
 * SSE frames for the streaming path, a Messages JSON body for `complete()` — so
 * what is exercised is the adapter's own mapping, not a stubbed LangChain.
 */
import { describe, expect, it } from 'vitest';
import {
  LangChainAnthropicProvider,
  chatOptions,
  mergeUsage,
  textAndReasoning,
  toLangChainMessages,
  usageFromMetadata,
} from './langchain.js';
import type { AiCompletionRequest, FetchLike, ProviderChunk, ProviderConfig } from './types.js';
import { ProviderError } from '../reliability/types.js';

const CONFIG: ProviderConfig = { name: 'anthropic', apiKey: 'k', model: 'claude-opus-4-8' };
const ASK: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

/** A `fetch` returning a non-streamed Messages response. */
function jsonFetch(payload: unknown): FetchLike {
  const body = JSON.stringify(payload);
  return (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  })) as unknown as FetchLike;
}

/** A `fetch` returning real SSE frames, as the Messages streaming API does. */
function sseFetch(frames: readonly unknown[]): FetchLike {
  const text = frames
    .map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`)
    .join('');
  return (async () =>
    new Response(text, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as FetchLike;
}

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const START = (usage: Record<string, number>) => ({
  type: 'message_start',
  message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage },
});

describe('usageFromMetadata', () => {
  it('returns undefined when nothing was reported', () => {
    expect(usageFromMetadata(undefined)).toBeUndefined();
    expect(usageFromMetadata({})).toBeUndefined();
  });

  it('omits cache keys when the provider did not report them', () => {
    expect(usageFromMetadata({ input_tokens: 3, output_tokens: 1 })).toEqual({
      inputTokens: 3,
      outputTokens: 1,
    });
  });

  it('preserves a measured zero rather than dropping it', () => {
    // run-metrics.ts must tell "not reported" from a real 0% hit.
    expect(
      usageFromMetadata({
        input_tokens: 3,
        output_tokens: 1,
        input_token_details: { cache_read: 0, cache_creation: 0 },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('defaults a missing half of the pair to zero when the other is present', () => {
    expect(usageFromMetadata({ input_tokens: 5 })).toEqual({ inputTokens: 5, outputTokens: 0 });
    expect(usageFromMetadata({ output_tokens: 5 })).toEqual({ inputTokens: 0, outputTokens: 5 });
  });
});

describe('mergeUsage', () => {
  it('adopts the first report wholesale', () => {
    const first = { inputTokens: 9, outputTokens: 0, cacheReadInputTokens: 6 };
    expect(mergeUsage(undefined, first)).toEqual(first);
  });

  it('keeps cache counts when a later chunk reports none', () => {
    // The regression this function exists for: Anthropic sends the input side
    // (with the cache counts) once, then an output-only tail. "Last wins" would
    // drop the cache counts on every streamed turn.
    const merged = mergeUsage(
      { inputTokens: 9, outputTokens: 0, cacheReadInputTokens: 6, cacheCreationInputTokens: 1 },
      { inputTokens: 0, outputTokens: 4 },
    );
    expect(merged).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: 1,
    });
  });

  it('takes the later cumulative output count', () => {
    const merged = mergeUsage(
      { inputTokens: 5, outputTokens: 2 },
      { inputTokens: 0, outputTokens: 7 },
    );
    expect(merged.outputTokens).toBe(7);
    expect(merged.inputTokens).toBe(5);
  });

  it('lets a later chunk supply cache counts the first lacked', () => {
    const merged = mergeUsage(
      { inputTokens: 5, outputTokens: 1 },
      { inputTokens: 0, outputTokens: 2, cacheReadInputTokens: 3 },
    );
    expect(merged.cacheReadInputTokens).toBe(3);
  });
});

describe('chatOptions', () => {
  it('disables LangChain retries so there is one retry authority', () => {
    // Two retry layers means duplicate tool invocations (risk 4).
    expect(chatOptions(CONFIG, ASK, false).maxRetries).toBe(0);
  });

  it('always enables streamUsage', () => {
    // Otherwise cost and cache-hit rate are unmeasurable on streamed turns —
    // i.e. on every turn of a real agent run.
    expect(chatOptions(CONFIG, ASK, true).streamUsage).toBe(true);
  });

  it('clamps maxTokens through the shared resolver', () => {
    const huge = chatOptions(CONFIG, { ...ASK, maxTokens: 10_000_000 }, false);
    expect(huge.maxTokens).toBeLessThan(10_000_000);
    // No explicit ask falls back to the shared conversational default.
    expect(chatOptions(CONFIG, ASK, false).maxTokens).toBe(2048);
  });

  it('omits optional fields entirely when unset', () => {
    const options = chatOptions({ name: 'anthropic' }, ASK, false);
    expect(options).not.toHaveProperty('apiKey');
    expect(options).not.toHaveProperty('temperature');
    expect(options).not.toHaveProperty('anthropicApiUrl');
    // No injected fetch → the real one is used, so no clientOptions override.
    expect(options).not.toHaveProperty('clientOptions');
    expect(options.model).toBe('claude-opus-4-8');
  });

  it('forwards temperature, base URL and an injected fetch when present', () => {
    const fetchImpl = (async () => new Response('')) as unknown as FetchLike;
    const options = chatOptions(
      { name: 'anthropic', apiKey: 'k', baseUrl: 'https://proxy.example' },
      { ...ASK, temperature: 0.3 },
      false,
      fetchImpl,
    );
    expect(options.temperature).toBe(0.3);
    expect(options.anthropicApiUrl).toBe('https://proxy.example');
    expect(options.clientOptions?.fetch).toBe(fetchImpl);
  });
});

describe('textAndReasoning', () => {
  it('treats a plain string chunk as visible text', () => {
    expect(textAndReasoning('hi')).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('ignores content that is neither string nor block array', () => {
    expect(textAndReasoning(undefined)).toEqual([]);
    expect(textAndReasoning(42)).toEqual([]);
  });

  it('splits block content into reasoning and text, dropping unknown blocks', () => {
    expect(
      textAndReasoning([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't1' },
      ]),
    ).toEqual([
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'text', text: 'answer' },
    ]);
  });
});

describe('toLangChainMessages', () => {
  it('omits the system message entirely when there is no system content', () => {
    expect(toLangChainMessages(ASK)).toHaveLength(1);
  });

  it('sends a bare string system block when there are no tools to cache', () => {
    const messages = toLangChainMessages({
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u' },
      ],
    });
    expect(messages[0]?.content).toBe('S');
  });

  it('joins several system messages the way the Messages API needs', () => {
    const messages = toLangChainMessages({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'u' },
      ],
    });
    expect(messages[0]?.content).toBe('A\n\nB');
  });

  it('maps an assistant turn to an AI message', () => {
    const messages = toLangChainMessages({
      messages: [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ],
    });
    expect(messages[1]?.getType()).toBe('ai');
  });
});

describe('LangChainAnthropicProvider', () => {
  it('falls back to the shared default model when the host configured none', () => {
    const provider = new LangChainAnthropicProvider({ name: 'anthropic', apiKey: 'k' });
    expect(provider.modelId).toBe('claude-opus-4-8');
  });

  it('reports the configured model', () => {
    expect(new LangChainAnthropicProvider(CONFIG).modelId).toBe('claude-opus-4-8');
  });

  it('extracts text and usage from a completion', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      jsonFetch({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 3 },
      }),
    );
    const result = await provider.complete(ASK);
    expect(result.text).toBe('hello');
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 0,
    });
    expect(result.toolCalls).toBeUndefined();
  });

  it('extracts tool calls from a completion', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      jsonFetch({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [
          { type: 'text', text: 'doing it' },
          { type: 'tool_use', id: 't1', name: 'trim_clip', input: { clipId: 'c1' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const result = await provider.complete({
      ...ASK,
      tools: [{ name: 'trim_clip', description: 'd', parameters: { type: 'object' } }],
    });
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'trim_clip', arguments: { clipId: 'c1' } },
    ]);
    expect(result.text).toBe('doing it');
  });

  it('omits usage when the response reported none', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      jsonFetch({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect((await provider.complete(ASK)).usage).toBeUndefined();
  });

  it('streams text deltas and a terminal done chunk', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 5, output_tokens: 0 }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]),
    );
    const chunks = await collect(provider.stream(ASK));
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'He' },
      { type: 'text-delta', text: 'llo' },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', text: 'Hello' });
  });

  it('routes extended thinking to reasoning-delta, never the visible answer', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 1, output_tokens: 0 }),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'pondering' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const chunks = await collect(provider.stream(ASK));
    expect(chunks).toContainEqual({ type: 'reasoning-delta', text: 'pondering' });
    // The thinking must NOT leak into the user-visible answer.
    expect(chunks.at(-1)).toEqual({ type: 'done', text: 'answer' });
  });

  it('accumulates a streamed tool call and emits it once complete', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 1, output_tokens: 0 }),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'trim_clip', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"clipId"' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ':"c1"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const chunks = await collect(
      provider.stream({
        ...ASK,
        tools: [{ name: 'trim_clip', description: 'd', parameters: { type: 'object' } }],
      }),
    );
    const call = chunks.find((c) => c.type === 'tool-call');
    expect(call).toEqual({
      type: 'tool-call',
      call: { id: 't1', name: 'trim_clip', arguments: { clipId: 'c1' } },
    });
  });

  it('emits a usage chunk carrying the cache counts', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 6 }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const usage = (await collect(provider.stream(ASK))).find((c) => c.type === 'usage');
    expect(usage).toBeDefined();
    expect((usage as { usage: { cacheReadInputTokens?: number } }).usage.cacheReadInputTokens).toBe(
      6,
    );
  });

  it('drops a nameless tool fragment rather than emitting a call it cannot route', async () => {
    // A stream that begins mid-tool-call (no `content_block_start`, so no id or
    // name ever arrives). Emitting `{ name: '' }` would reach the dispatcher as
    // an unregistered tool; dropping it is the honest degradation.
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 1, output_tokens: 0 }),
        {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const chunks = await collect(provider.stream(ASK));
    expect(chunks.some((c) => c.type === 'tool-call')).toBe(false);
  });

  it('keeps accumulated arguments when a later fragment carries nothing', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 1, output_tokens: 0 }),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't9', name: 'trim_clip', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"clipId":"c9"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const call = (await collect(provider.stream(ASK))).find((c) => c.type === 'tool-call');
    expect(call).toEqual({
      type: 'tool-call',
      call: { id: 't9', name: 'trim_clip', arguments: { clipId: 'c9' } },
    });
  });

  it('accumulates tool arguments split across more than two fragments', async () => {
    // Real Anthropic splits a long argument object across many `input_json_delta`
    // frames; the middle ones parse as nothing on their own.
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      sseFetch([
        START({ input_tokens: 1, output_tokens: 0 }),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'trim_clip', input: {} },
        },
        ...['{"clipId"', ':"c1",', '"start":0}'].map((partial_json) => ({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json },
        })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    const call = (await collect(provider.stream(ASK))).find((c) => c.type === 'tool-call');
    expect(call).toEqual({
      type: 'tool-call',
      call: { id: 't1', name: 'trim_clip', arguments: { clipId: 'c1', start: 0 } },
    });
  });

  it('tolerates a completed tool call that arrived without an id', async () => {
    const provider = new LangChainAnthropicProvider(
      CONFIG,
      jsonFetch({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [{ type: 'tool_use', name: 'trim_clip', input: { clipId: 'c1' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const result = await provider.complete(ASK);
    expect(result.toolCalls?.[0]?.name).toBe('trim_clip');
    expect(result.toolCalls?.[0]?.id).toBe('');
  });

  it('forwards an AbortSignal so a mid-flight turn can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new LangChainAnthropicProvider(CONFIG, jsonFetch({}));
    await expect(provider.complete(ASK, controller.signal)).rejects.toThrow();
  });
});

describe('provider errors reaching the orchestrator', () => {
  /** A `fetch` answering like a server that does not serve the route at all. */
  const htmlNotFound: FetchLike = (async () =>
    new Response(
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /v1/messages</pre>\n</body>\n</html>\n',
      { status: 404, headers: { 'content-type': 'text/html' } },
    )) as unknown as FetchLike;

  it('fails fast with a readable message when the endpoint is wrong (complete)', async () => {
    const provider = new LangChainAnthropicProvider(CONFIG, htmlNotFound);
    const error = await provider.complete(ASK).then(
      () => undefined,
      (thrown: unknown) => thrown as ProviderError,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error?.retryable).toBe(false);
    expect(error?.status).toBe(404);
    expect(error?.message).not.toContain('<!DOCTYPE');
  });

  it('fails fast with a readable message when the endpoint is wrong (stream)', async () => {
    const provider = new LangChainAnthropicProvider(CONFIG, htmlNotFound);
    const error = await collect(provider.stream(ASK)).then(
      () => undefined,
      (thrown: unknown) => thrown as ProviderError,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error?.retryable).toBe(false);
    expect(error?.message).not.toContain('<!DOCTYPE');
  });

  it('lets a caller abort stay an abort rather than becoming a provider failure', async () => {
    // `resilient-provider.ts` and `retry.ts` both identify a user cancel by
    // `error.name === 'AbortError'`; classifying it would turn a deliberate stop into a
    // failed run that is then retried.
    const controller = new AbortController();
    const hangs: FetchLike = ((_url: unknown, init: { signal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as FetchLike;
    const provider = new LangChainAnthropicProvider(CONFIG, hangs);
    const pending = provider.complete(ASK, controller.signal).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    controller.abort();
    const error = await pending;
    expect(error?.name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(ProviderError);
  });
});
