/**
 * The provider-agnostic half of the LangChain adapters (M2).
 *
 * These cover the shapes a real provider emits that the happy path never reaches:
 * reasoning blocks in either spelling, tool arguments that only parse once joined, and
 * defensive fallbacks LangChain's own types mark optional. Every one of them is a place
 * where the wrong answer is silent — reasoning leaking into the visible answer, a tool
 * call assembled from half its arguments, a message routed to the wrong role.
 */
import { describe, expect, it } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import {
  LangChainChatProvider,
  ToolCallAccumulator,
  toolCallArguments,
  mergeUsage,
  openAiCacheBoundaryContent,
  reasoningFromKwargs,
  stopReasonFrom,
  textAndReasoning,
  toChatMessages,
  usageFromMetadata,
} from './langchain-chat.js';
import type { AiCompletionRequest, ProviderChunk } from './types.js';

describe('textAndReasoning', () => {
  it('passes a plain string through as visible text', () => {
    expect(textAndReasoning('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('returns nothing for a shape that is neither string nor array', () => {
    expect(textAndReasoning(undefined)).toEqual([]);
    expect(textAndReasoning(null)).toEqual([]);
    expect(textAndReasoning(42)).toEqual([]);
  });

  it('routes Anthropic `thinking` to the reasoning channel, never the answer', () => {
    expect(textAndReasoning([{ type: 'thinking', thinking: 'chain of thought' }])).toEqual([
      { kind: 'reasoning', text: 'chain of thought' },
    ]);
  });

  it('routes DeepSeek `reasoning_content` the same way', () => {
    // A different provider's spelling of the same idea. Missing it would put the model's
    // private reasoning into the user's answer — visible, and not recoverable after.
    expect(textAndReasoning([{ reasoning_content: 'deepseek thinking' }])).toEqual([
      { kind: 'reasoning', text: 'deepseek thinking' },
    ]);
  });

  it('separates reasoning from text when a chunk carries both', () => {
    expect(
      textAndReasoning([{ thinking: 'first I consider' }, { type: 'text', text: 'the answer' }]),
    ).toEqual([
      { kind: 'reasoning', text: 'first I consider' },
      { kind: 'text', text: 'the answer' },
    ]);
  });

  it('ignores a block carrying neither text nor reasoning', () => {
    expect(textAndReasoning([{ type: 'image', source: {} }])).toEqual([]);
  });
});

/**
 * The regression the first M0.1 capture found.
 *
 * `ChatDeepSeek` streams its chain of thought on `additional_kwargs.reasoning_content`
 * with `content` empty, so reading content alone dropped the entire thinking phase:
 * TTFT p50 1,499 ms (native) against 11,650 ms here, and 19 of 49 calls emitting
 * nothing until the last burst. The suite was at 100% coverage throughout — every line
 * of `textAndReasoning` ran, on Anthropic-shaped input where reasoning *is* a content
 * block. Coverage counts lines executed, not provider shapes exercised.
 */
describe('reasoningFromKwargs', () => {
  it('reads DeepSeek reasoning from the sidecar field', () => {
    expect(reasoningFromKwargs({ reasoning_content: 'thinking out loud' })).toBe(
      'thinking out loud',
    );
  });

  it('returns empty for a chunk that carries no reasoning', () => {
    expect(reasoningFromKwargs({})).toBe('');
    expect(reasoningFromKwargs({ reasoning_content: 42 })).toBe('');
  });

  it('survives a missing or non-object `additional_kwargs`', () => {
    // Streamed chunks are not guaranteed to carry it, and a throw here would take
    // down the whole turn.
    expect(reasoningFromKwargs(undefined)).toBe('');
    expect(reasoningFromKwargs(null)).toBe('');
    expect(reasoningFromKwargs('reasoning_content')).toBe('');
  });
});

describe('ToolCallAccumulator', () => {
  const settle = (
    fragments: readonly { index?: number; id?: string; name?: string; args?: string }[],
  ): readonly { name: string; args: Record<string, unknown> | undefined }[] => {
    const accumulator = new ToolCallAccumulator();
    for (const fragment of fragments) accumulator.push(fragment);
    return accumulator.settle().map((call) => ({
      name: call.name,
      args: toolCallArguments(call),
    }));
  };

  it('joins fragments until the whole argument string parses', () => {
    expect(
      settle([
        { index: 0, id: 'a', name: 'trim_clip', args: '' },
        { index: 0, args: '{"clipId":' },
        { index: 0, args: '"clip_a"}' },
      ]),
    ).toEqual([{ name: 'trim_clip', args: { clipId: 'clip_a' } }]);
  });

  it('keeps the raw text after a prefix happens to parse on its own', () => {
    // The previous implementation parsed after every fragment and kept the OBJECT when the
    // concatenation parsed, throwing the text away — so the next fragment restarted from
    // an empty buffer and the call silently lost everything before it.
    expect(
      settle([
        { index: 0, id: 'a', name: 'add_clip', args: '{"start":1' },
        { index: 0, args: '2,"end":20}' },
      ]),
    ).toEqual([{ name: 'add_clip', args: { start: 12, end: 20 } }]);
  });

  it('refuses arguments that were cut off mid-JSON rather than repairing them', () => {
    // `{"start":1` could be `1`, `12` or `1.5`. Closing the brace would dispatch an edit at
    // an invented time; `undefined` makes the caller drop the call and retry the step.
    expect(settle([{ index: 0, id: 'a', name: 'add_clip', args: '{"start":1' }])).toEqual([
      { name: 'add_clip', args: undefined },
    ]);
  });

  it('reads an empty argument string as no arguments', () => {
    expect(settle([{ index: 0, id: 'a', name: 'list_assets', args: '' }])).toEqual([
      { name: 'list_assets', args: {} },
    ]);
  });

  it('keeps calls apart when the gateway omits `index` entirely', () => {
    // Captured OpenRouter defect: with `index ?? 0` all three calls collapsed onto key 0,
    // their argument strings were concatenated into garbage, and the turn reached the
    // executor as ONE call whose arguments were the single character `{`.
    expect(
      settle([
        { id: 'a', name: 'transcribe', args: '{"assetId":"asset_1"}' },
        { id: 'b', name: 'add_clip', args: '{"trackId":"v_main"}' },
        { id: 'c', name: 'add_clip', args: '{"trackId":"music_1"}' },
      ]),
    ).toEqual([
      { name: 'transcribe', args: { assetId: 'asset_1' } },
      { name: 'add_clip', args: { trackId: 'v_main' } },
      { name: 'add_clip', args: { trackId: 'music_1' } },
    ]);
  });

  it('keeps calls apart when the gateway restarts `index` at 0 for each call', () => {
    expect(
      settle([
        { index: 0, id: 'a', name: 'get_timeline', args: '{}' },
        { index: 0, id: 'b', name: 'list_assets', args: '{}' },
      ]),
    ).toEqual([
      { name: 'get_timeline', args: {} },
      { name: 'list_assets', args: {} },
    ]);
  });

  it('takes a complete tool call the provider already parsed', () => {
    // `AIMessageChunk` leaves `tool_call_chunks` empty and fills `tool_calls` when the
    // gateway sent the call in one piece; a reader that only looks at fragments loses it.
    const accumulator = new ToolCallAccumulator();
    accumulator.pushComplete({ id: 'a', name: 'get_timeline', args: { verbose: true } });
    expect(accumulator.settle().map((call) => toolCallArguments(call))).toEqual([
      { verbose: true },
    ]);
  });

  it('does not produce a call twice when both shapes arrive for it', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push({ index: 0, id: 'a', name: 'get_timeline', args: '{"verbose":true}' });
    accumulator.pushComplete({ id: 'a', name: 'get_timeline', args: { verbose: true } });
    expect(accumulator.settle()).toHaveLength(1);
  });
});

describe('usageFromMetadata', () => {
  it('returns undefined when the provider reported nothing', () => {
    expect(usageFromMetadata(undefined)).toBeUndefined();
    expect(usageFromMetadata({})).toBeUndefined();
  });

  it('subtracts the cache components out of LangChain’s total input count', () => {
    // LangChain reports input + cache_creation + cache_read as one number; Anthropic's
    // own input_tokens is the non-cached portion, and that is what cost-meter.ts and the
    // WAL record. Without this an identical run reports different numbers depending only
    // on which adapter served it.
    expect(
      usageFromMetadata({
        input_tokens: 150,
        output_tokens: 20,
        input_token_details: { cache_read: 40, cache_creation: 10 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    });
  });

  it('omits the cache fields when they were not reported, rather than sending zero', () => {
    // run-metrics.ts distinguishes "not reported" from a measured zero: a provider gap
    // must not masquerade as a 0% cache-hit rate that a later phase then "matches".
    const usage = usageFromMetadata({ input_tokens: 10, output_tokens: 2 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
  });

  it('never reports a negative input count', () => {
    expect(
      usageFromMetadata({
        input_tokens: 10,
        output_tokens: 1,
        input_token_details: { cache_read: 40 },
      })?.inputTokens,
    ).toBe(0);
  });
});

describe('mergeUsage', () => {
  it('takes the first report when there is nothing to merge with', () => {
    expect(mergeUsage(undefined, { inputTokens: 5, outputTokens: 1 })).toEqual({
      inputTokens: 5,
      outputTokens: 1,
    });
  });

  it('keeps cache counts from the FIRST report when the second omits them', () => {
    // Anthropic reports input once (with the cache counts) and output cumulatively.
    // "Last one wins" would discard the cache counts on every streamed turn — which is
    // every turn of a real agent run.
    expect(
      mergeUsage(
        { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 40 },
        { inputTokens: 0, outputTokens: 20 },
      ),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40 });
  });

  it('takes the max on both axes, so a cumulative output count grows', () => {
    expect(
      mergeUsage({ inputTokens: 10, outputTokens: 30 }, { inputTokens: 10, outputTokens: 12 }),
    ).toEqual({ inputTokens: 10, outputTokens: 30 });
  });

  it('accepts cache counts that only arrive on the later report', () => {
    expect(
      mergeUsage(
        { inputTokens: 10, outputTokens: 1 },
        { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 7 },
      ),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 7 });
  });
});

describe('toChatMessages', () => {
  const request = (messages: AiCompletionRequest['messages']): AiCompletionRequest => ({
    messages,
  });

  it('maps each role to the LangChain message type the providers expect', () => {
    const messages = toChatMessages(
      request([
        { role: 'system', content: 'contract' },
        { role: 'assistant', content: 'understood' },
        { role: 'user', content: 'tighten it' },
      ]),
    );
    expect(messages.map((message) => message.getType())).toEqual(['system', 'ai', 'human']);
  });

  it('sends a `tool` message as human, matching what the native adapters do', () => {
    // buildOpenAiBody maps tool → user. Diverging here would change the conversation
    // shape the model sees on one path only.
    expect(toChatMessages(request([{ role: 'tool', content: 'result' }]))[0]?.getType()).toBe(
      'human',
    );
  });

  it('preserves content verbatim', () => {
    expect(toChatMessages(request([{ role: 'user', content: 'exact text' }]))[0]?.content).toBe(
      'exact text',
    );
  });
});

describe('stopReasonFrom', () => {
  // A reply the provider cut off for want of output room is the one case the orchestrator
  // must retry rather than publish: judging the prose instead retries finished two-word
  // answers and still misses a fragment that ends on a period.
  it('reads a truncation from every spelling a gateway uses', () => {
    expect(stopReasonFrom({ finish_reason: 'length' })).toBe(true);
    expect(stopReasonFrom({ stop_reason: 'max_tokens' })).toBe(true);
    expect(stopReasonFrom({ finishReason: 'length' })).toBe(true);
    expect(stopReasonFrom({ finish_reason: 'MAX_TOKENS' })).toBe(true);
  });

  it('reads a normal stop as not truncated', () => {
    expect(stopReasonFrom({ finish_reason: 'stop' })).toBe(false);
    expect(stopReasonFrom({ stop_reason: 'end_turn' })).toBe(false);
    expect(stopReasonFrom({ finish_reason: 'tool_calls' })).toBe(false);
  });

  it('says NOTHING when the chunk does not mention why it stopped', () => {
    // `undefined`, not `false`: only the last chunk carries a reason, so an earlier silent
    // chunk must not overwrite a verdict a later one gives.
    expect(stopReasonFrom(undefined)).toBeUndefined();
    expect(stopReasonFrom({})).toBeUndefined();
    expect(stopReasonFrom({ finish_reason: '' })).toBeUndefined();
    expect(stopReasonFrom({ finish_reason: 7 })).toBeUndefined();
    expect(stopReasonFrom('length')).toBeUndefined();
    expect(stopReasonFrom(null)).toBeUndefined();
  });
});

describe('cache breakpoints ride an OpenAI-shaped body too', () => {
  const boundary = (): AiCompletionRequest => ({
    messages: [
      { role: 'system', content: 'contract' },
      { role: 'user', content: 'stable head', cacheBoundary: true },
      { role: 'user', content: 'this turn' },
    ],
  });

  const partsOf = (message: { content: unknown }): Record<string, unknown>[] =>
    Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];

  it('marks the message the agent loop flagged', () => {
    // The marker used to be dropped on every non-Anthropic path. Captured run e36235cc ran
    // on openrouter/auto-beta and re-sent 736,595 tokens of tool definitions across 52
    // calls; whether any of it was cached was unknowable, because the breakpoint the agent
    // loop places was silently discarded here.
    const messages = toChatMessages(boundary());
    expect(partsOf(messages[1]!)).toEqual([
      { type: 'text', text: 'stable head', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves every other message a plain string', () => {
    // Marking more than the boundary would spend a breakpoint on a shorter prefix and
    // change the bytes of messages that were fine as they were.
    const messages = toChatMessages(boundary());
    expect(messages[0]!.content).toBe('contract');
    expect(messages[2]!.content).toBe('this turn');
  });

  it('marks the LAST boundary when a request carries more than one', () => {
    const messages = toChatMessages({
      messages: [
        { role: 'user', content: 'first', cacheBoundary: true },
        { role: 'user', content: 'second', cacheBoundary: true },
      ],
    });
    expect(messages[0]!.content).toBe('first');
    expect(partsOf(messages[1]!)[0]).toMatchObject({ text: 'second' });
  });

  it('changes nothing for a request with no boundary', () => {
    const messages = toChatMessages({
      messages: [
        { role: 'system', content: 'contract' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(messages.map((message) => message.content)).toEqual(['contract', 'hello']);
  });

  it("keeps a boundary message's images and marks its text", () => {
    const content = openAiCacheBoundaryContent({
      role: 'user',
      content: 'look at this',
      images: [{ mediaType: 'image/png', base64: 'aGk=' }],
    }) as Record<string, unknown>[];
    expect(content.some((part) => part.type === 'image_url')).toBe(true);
    expect(content.at(-1)).toEqual({
      type: 'text',
      text: 'look at this',
      cache_control: { type: 'ephemeral' },
    });
  });
});

/**
 * The streaming half, driven by a chat model that yields exactly the chunk shapes a real
 * gateway produces. These are end-to-end over `stream()` rather than over the accumulator
 * alone, because the defect they cover lived in what `stream()` did with the accumulation
 * at the end, not in the accumulation itself.
 */
describe('LangChainChatProvider.stream', () => {
  class StubProvider extends LangChainChatProvider {
    public readonly name = 'openrouter' as const;

    public constructor(private readonly chunks: readonly unknown[]) {
      super({ name: 'openrouter', model: 'openrouter/auto' });
    }

    public get modelId(): string {
      return 'openrouter/auto';
    }

    protected buildModel(): BaseChatModel {
      const chunks = this.chunks;
      const model = {
        bindTools: () => model,
        // `stream()` is awaited by the caller, so a plain generator is as good as a promise.
        stream: () =>
          (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
      };
      return model as unknown as BaseChatModel;
    }

    protected buildMessages(): BaseMessage[] {
      return [];
    }
  }

  const ASK: AiCompletionRequest = { messages: [{ role: 'user', content: 'edit it' }] };

  const collect = async (chunks: readonly unknown[]): Promise<ProviderChunk[]> => {
    const out: ProviderChunk[] = [];
    for await (const chunk of new StubProvider(chunks).stream(ASK)) out.push(chunk);
    return out;
  };

  it('never dispatches a tool call whose streamed arguments were cut off', async () => {
    // The captured failure: `transcribe` reached the executor with `{ __partial: '{' }`,
    // was rejected as an unrecognized key, and the repeated-failure guard then refused
    // every later `transcribe` in the run. Nothing about that was the model's mistake.
    const chunks = await collect([
      { content: '', tool_call_chunks: [{ index: 0, id: 'a', name: 'transcribe', args: '{' }] },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toEqual([]);
    expect(chunks.at(-1)).toEqual({
      type: 'done',
      text: '',
      truncated: true,
      droppedToolCalls: ['transcribe'],
    });
  });

  it('keeps the calls that did survive when only one was cut off', async () => {
    const chunks = await collect([
      {
        content: '',
        tool_call_chunks: [
          { index: 0, id: 'a', name: 'get_timeline', args: '{}' },
          { index: 1, id: 'b', name: 'add_clip', args: '{"trackId":' },
        ],
      },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'a', name: 'get_timeline', arguments: {} } },
    ]);
    expect(chunks.at(-1)).toMatchObject({ truncated: true, droppedToolCalls: ['add_clip'] });
  });

  it('emits every call when a gateway sends them without an index', async () => {
    const chunks = await collect([
      { content: '', tool_call_chunks: [{ id: 'a', name: 'transcribe', args: '{"assetId":"x"}' }] },
      { content: '', tool_call_chunks: [{ id: 'b', name: 'get_timeline', args: '{}' }] },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'a', name: 'transcribe', arguments: { assetId: 'x' } } },
      { type: 'tool-call', call: { id: 'b', name: 'get_timeline', arguments: {} } },
    ]);
  });

  it('reads a tool call the gateway delivered whole, with no fragments', async () => {
    const chunks = await collect([
      {
        content: '',
        tool_call_chunks: [],
        tool_calls: [{ id: 'a', name: 'get_timeline', args: { verbose: true } }],
      },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'a', name: 'get_timeline', arguments: { verbose: true } } },
    ]);
  });

  it('leaves a clean turn untouched', async () => {
    const chunks = await collect([
      { content: 'Trimming the head.' },
      {
        content: '',
        tool_call_chunks: [{ index: 0, id: 'a', name: 'trim_clip', args: '{"c":1}' }],
      },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', text: 'Trimming the head.' });
  });
});
