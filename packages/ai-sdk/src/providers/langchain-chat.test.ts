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
import {
  mergeArgs,
  mergeUsage,
  openAiCacheBoundaryContent,
  reasoningFromKwargs,
  stopReasonFrom,
  textAndReasoning,
  toChatMessages,
  usageFromMetadata,
} from './langchain-chat.js';
import type { AiCompletionRequest } from './types.js';

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

describe('mergeArgs', () => {
  it('returns what it had when the fragment is absent or empty', () => {
    expect(mergeArgs({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeArgs({ a: 1 }, '')).toEqual({ a: 1 });
    expect(mergeArgs(undefined, undefined)).toEqual({});
  });

  it('parses a fragment that is already complete JSON', () => {
    expect(mergeArgs(undefined, '{"clipId":"clip_a"}')).toEqual({ clipId: 'clip_a' });
  });

  it('carries an unparseable fragment forward rather than throwing', () => {
    // Fragments arrive as partial JSON; only the concatenation parses. Throwing here
    // would abort a tool call that is merely incomplete.
    const partial = mergeArgs(undefined, '{"clipId":');
    expect(partial).toEqual({ __partial: '{"clipId":' });
  });

  it('joins fragments across calls until the whole parses', () => {
    const first = mergeArgs(undefined, '{"clipId":');
    const second = mergeArgs(first, '"clip_a"}');
    expect(second).toEqual({ clipId: 'clip_a' });
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
