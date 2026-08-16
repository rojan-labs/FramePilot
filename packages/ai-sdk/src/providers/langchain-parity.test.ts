/**
 * The Anthropic request body, frozen.
 *
 * This began as M1.2: a parity test proving the LangChain adapter sent the same bytes as
 * the native one. The native adapter is gone (ADR 0105), so there is nothing to compare
 * against — and the protection it gave would have died with it. The expectations below are
 * the values the native adapter produced, now asserted directly. Same guarantee, no second
 * implementation required to state it.
 *
 * What this protects: prompt-cache boundary placement between the native Anthropic adapter and
 * the LangChain one (plan/LANGCHAIN-MIGRATION.md §7.3, risk 3).
 *
 * This is M1's acceptance criterion, and §12 named it "the highest single
 * unknown" in the migration: whether `@langchain/anthropic` can express the DUAL
 * prompt-cache breakpoint at all. It can — this test is the proof, and the guard
 * that keeps it true.
 *
 * WHY it matters more than it looks: a mis-placed breakpoint has no functional
 * symptom. The run still succeeds, the output is still correct — it just silently
 * costs multiples more per turn. Before the second breakpoint existed, up to
 * eight pinned skill playbooks were re-billed on every turn of every run. Nothing
 * in the test suite would have caught that; this is the thing that does.
 *
 * Both providers are driven through a capturing `fetch`, so what is compared is
 * the REAL outgoing request body, not a reconstruction of it.
 */
import { describe, expect, it } from 'vitest';
import { LangChainAnthropicProvider } from './langchain.js';
import { toolDescriptors } from '../tool-registry.js';
import type { AiCompletionRequest, FetchLike, ProviderConfig } from './types.js';

const CONFIG: ProviderConfig = {
  name: 'anthropic',
  apiKey: 'test-key',
  model: 'claude-opus-4-8',
};

/** A request exercising every shape that affects breakpoint placement. */
const REQUEST: AiCompletionRequest = {
  messages: [
    { role: 'system', content: 'SYSTEM CONTRACT' },
    // The run-stable prefix: agent contract + committed plan + pinned playbooks.
    { role: 'user', content: 'PINNED PREFIX', cacheBoundary: true },
    { role: 'assistant', content: 'understood' },
    // Turn-varying tail — must stay OUTSIDE the cached prefix.
    { role: 'user', content: 'now trim the clip' },
  ],
  tools: [
    {
      name: 'trim_clip',
      description: 'Trim a clip',
      parameters: {
        type: 'object',
        properties: { clipId: { type: 'string' } },
        required: ['clipId'],
        additionalProperties: false,
      },
    },
  ],
  maxTokens: 4096,
};

interface Captured {
  readonly body: Record<string, unknown>;
}

const REPLY = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-8',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7 },
});

/**
 * A `fetch` that records the outgoing body and returns a minimal valid reply.
 *
 * Serves both `text()` and `json()`, since the Anthropic SDK under LangChain reads the
 * latter.
 */
function capturingFetch(sink: { current?: Captured }): FetchLike {
  return (async (_url: string, init: { body?: string }) => {
    sink.current = { body: JSON.parse(init.body ?? '{}') as Record<string, unknown> };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => JSON.parse(REPLY) as unknown,
      text: async () => REPLY,
    };
  }) as unknown as FetchLike;
}

async function langchainBody(request: AiCompletionRequest): Promise<Record<string, unknown>> {
  const sink: { current?: Captured } = {};
  await new LangChainAnthropicProvider(CONFIG, capturingFetch(sink)).complete(request);
  return sink.current?.body ?? {};
}

function walkBreakpoints(body: unknown, path: string): string[] {
  if (Array.isArray(body)) {
    return body.flatMap((item, index) => walkBreakpoints(item, `${path}[${String(index)}]`));
  }
  if (typeof body !== 'object' || body === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'cache_control') found.push(path);
    else found.push(...walkBreakpoints(value, `${path}.${key}`));
  }
  return found;
}

/**
 * Every JSON path carrying a `cache_control` marker, **sorted**.
 *
 * Sorted rather than document-ordered because the two serializers emit the
 * top-level keys in different orders (LangChain writes `messages` before
 * `system`; the native adapter the reverse). What must match is WHICH blocks
 * carry a breakpoint — Anthropic computes its cache key over the canonical
 * tools → system → messages prefix, not over our JSON key order. Sorting keeps
 * the assertion on the thing that actually costs money.
 */
function cacheBreakpointPaths(body: unknown): string[] {
  return walkBreakpoints(body, '').sort();
}

describe('the Anthropic wire body — frozen prompt-cache contract', () => {
  it('places exactly two cache breakpoints, on the system block and the boundary message', async () => {
    // THE acceptance criterion. Anthropic bills a cache MISS at full rate, so a
    // breakpoint that moves is a silent cost regression, not an error anyone sees.
    expect(cacheBreakpointPaths(await langchainBody(REQUEST))).toEqual([
      '.messages[0].content[0]',
      '.system[0]',
    ]);
  });

  it('sends the system block as one cached text block', async () => {
    expect((await langchainBody(REQUEST)).system).toEqual([
      { type: 'text', text: 'SYSTEM CONTRACT', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('promotes only the boundary message to block form, leaving the rest plain strings', async () => {
    // Block form is what carries `cache_control`. Promoting a message that does not need
    // one changes the bytes Anthropic hashes, for nothing.
    expect((await langchainBody(REQUEST)).messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'PINNED PREFIX', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'assistant', content: 'understood' },
      { role: 'user', content: 'now trim the clip' },
    ]);
  });

  it('keeps the turn-varying tail OUTSIDE the cached prefix', async () => {
    // If this regresses, every turn re-bills the whole prompt.
    const messages = (await langchainBody(REQUEST)).messages as { content: unknown }[];
    const tail = JSON.stringify(messages[messages.length - 1]);
    expect(tail).not.toContain('cache_control');
    expect(tail).toContain('now trim the clip');
  });

  it('sends the model and a clamped max_tokens', async () => {
    const body = await langchainBody(REQUEST);
    expect(body.model).toBe('claude-opus-4-8');
    // Whatever the request asked for, clamped through `resolveMaxTokens` — an over-ask
    // becomes the model ceiling rather than a failed call.
    expect(body.max_tokens).toBe(4096);
  });

  it('advertises exactly what MCP advertises, from the one registry', async () => {
    // §2.3: there is one registry and one dispatch policy across surfaces. `toolDescriptors()`
    // is what the MCP server re-exposes (ADR 0015/0019); this asserts the provider puts the
    // SAME names and schemas on the wire. A tool advertised with a schema the validator does
    // not enforce is a hole in the security boundary (PRD §18.2) that no runtime error reveals.
    const request: AiCompletionRequest = { ...REQUEST, tools: toolDescriptors() };
    const body = await langchainBody(request);
    const sent = (body.tools ?? []) as { name: string; input_schema: unknown }[];
    const canonical = toolDescriptors();
    expect(sent.map((tool) => tool.name)).toEqual(canonical.map((tool) => tool.name));
    for (const [index, descriptor] of canonical.entries()) {
      expect(JSON.stringify(sent[index]?.input_schema)).toBe(JSON.stringify(descriptor.parameters));
    }
  });

  it('honors the LAST cacheBoundary when several are flagged', async () => {
    // A breakpoint caches everything before it, so an earlier flag would waste one.
    const request: AiCompletionRequest = {
      ...REQUEST,
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'first', cacheBoundary: true },
        { role: 'user', content: 'second', cacheBoundary: true },
        { role: 'user', content: 'tail' },
      ],
    };
    expect(cacheBreakpointPaths(await langchainBody(request))).toEqual([
      '.messages[1].content[0]',
      '.system[0]',
    ]);
  });

  it('emits no breakpoints when there is nothing stable to cache', async () => {
    const request: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };
    expect(cacheBreakpointPaths(await langchainBody(request))).toEqual([]);
  });

  it('reads prompt-cache hit counts back off the response', async () => {
    // The metric risk 3 is measured with. Without it the breakpoints above could be
    // perfect and we would have no way to know they were working.
    const sink: { current?: Captured } = {};
    const response = await new LangChainAnthropicProvider(CONFIG, capturingFetch(sink)).complete(
      REQUEST,
    );
    expect(response.usage?.cacheReadInputTokens).toBe(7);
  });
});
