/**
 * Tests for the Claude Agent SDK provider.
 *
 * The Agent SDK is a real subprocess-spawning agent runtime, so nothing here touches it:
 * `ConcreteClaudeAgentSdkProvider` takes injected loaders, and these tests supply a fake
 * `query` that replays recorded frame shapes. The shapes are not invented — they were
 * captured from the installed SDK (0.3.259) on 2026-09-03 against a real login.
 *
 * The sandbox assertions are the important ones. `SANDBOX_OPTIONS` is what stops the
 * model getting Read/Write/Bash against the user's disk and what stops the user's
 * personal `~/.claude/CLAUDE.md` leaking into FramePilot's prompt, so it is tested as a
 * security contract rather than as configuration.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConcreteClaudeAgentSdkProvider,
  SANDBOX_OPTIONS,
  buildToolServer,
  classifyAgentSdkError,
  renderMessages,
  stripToolPrefix,
  usageFromModelUsage,
  type AgentSdkModule,
  type McpModule,
} from './claude-agent-sdk.js';
import { ProviderError } from '../reliability/types.js';
import type { AiMessage, ProviderChunk, ToolDescriptor } from './types.js';

/** Build a fake Agent SDK whose `query` replays `frames` and records the options it got. */
function fakeSdk(frames: readonly unknown[]): {
  module: AgentSdkModule;
  calls: { prompt: string; options: Record<string, unknown> }[];
} {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const module = {
    query(params: { prompt: string; options: Record<string, unknown> }) {
      calls.push(params);
      return (async function* () {
        for (const frame of frames) yield frame as never;
      })();
    },
  } as unknown as AgentSdkModule;
  return { module, calls };
}

const textFrames = [
  { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Cut ' } } },
  { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'made.' } } },
  {
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    num_turns: 1,
    modelUsage: {
      'claude-opus-5': { inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 900 },
    },
  },
];

async function drain(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('SANDBOX_OPTIONS — the non-agentic security contract', () => {
  it('grants the model no built-in tools', () => {
    expect(SANDBOX_OPTIONS.tools).toEqual([]);
  });

  it('loads no settings from the user machine, so CLAUDE.md cannot leak into the prompt', () => {
    expect(SANDBOX_OPTIONS.settingSources).toEqual([]);
  });

  it('never bypasses permissions', () => {
    expect(SANDBOX_OPTIONS.permissionMode).toBe('default');
    expect(SANDBOX_OPTIONS.permissionMode).not.toBe('bypassPermissions');
  });

  it('runs one assistant turn, leaving the loop with the orchestrator', () => {
    expect(SANDBOX_OPTIONS.maxTurns).toBe(1);
  });

  it('accepts only FramePilot MCP servers, not ones discovered on the machine', () => {
    expect(SANDBOX_OPTIONS.strictMcpConfig).toBe(true);
  });

  it('is frozen, so a caller cannot loosen it in place', () => {
    expect(Object.isFrozen(SANDBOX_OPTIONS)).toBe(true);
  });
});

describe('the options actually sent to the SDK', () => {
  it('applies the whole sandbox and a custom system prompt on every call', async () => {
    const { module, calls } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await provider.complete({ messages: [{ role: 'user', content: 'cut it' }] });

    const options = calls[0]?.options ?? {};
    expect(options['tools']).toEqual([]);
    expect(options['settingSources']).toEqual([]);
    expect(options['permissionMode']).toBe('default');
    expect(options['strictMcpConfig']).toBe(true);
    // Never the `claude_code` preset — that is the prompt that makes it a coding agent.
    expect(options['systemPrompt']).toEqual({ type: 'custom', prompt: '' });
  });

  it('registers a PreToolUse hook that defers rather than executes', async () => {
    const { module, calls } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const hooks = calls[0]?.options['hooks'] as {
      PreToolUse: { hooks: (() => Promise<unknown>)[] }[];
    };
    const decision = (await hooks.PreToolUse[0]?.hooks[0]?.()) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe('defer');
  });

  it('sends a full catalog model id, never a bare SDK alias', () => {
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' });
    // An alias like `opus` matches no catalog key, which would pin the context meter to
    // "assumed" forever — see provider-defaults.ts.
    expect(provider.modelId).toBe('claude-opus-5');
    expect(provider.modelId).not.toBe('opus');
  });

  it('honours a host-configured model override', () => {
    const provider = new ConcreteClaudeAgentSdkProvider({
      name: 'claude-agent-sdk',
      model: 'claude-sonnet-5',
    });
    expect(provider.modelId).toBe('claude-sonnet-5');
  });
});

describe('renderMessages', () => {
  it('splits system messages out into the SDK system prompt', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'You are FramePilot.' },
      { role: 'user', content: 'trim the intro' },
    ];
    const { systemPrompt, prompt } = renderMessages(messages);
    expect(systemPrompt).toBe('You are FramePilot.');
    expect(prompt).toBe('[user]\ntrim the intro');
  });

  it('renders everything up to the cache boundary as system prompt, the rest as transcript', () => {
    // The SDK caches its system prompt and never the inside of the one user message this
    // adapter sends, so the run-stable prefix (skills manifest, request, agent contract)
    // was re-billed on every call — ~4k of the ~5.5k uncached tokens per call measured on
    // `s9-live-reorder-fix2`.
    const { systemPrompt, prompt } = renderMessages([
      { role: 'system', content: 'You are FramePilot.' },
      { role: 'user', content: 'Skills…\n\nUser request:\ntrim the intro' },
      { role: 'user', content: 'AGENT mode contract', cacheBoundary: true },
      { role: 'user', content: 'STATE … RUN STATE … Actions so far' },
    ]);
    expect(systemPrompt).toBe(
      'You are FramePilot.\n\nSkills…\n\nUser request:\ntrim the intro\n\nAGENT mode contract',
    );
    expect(prompt).toBe('[user]\nSTATE … RUN STATE … Actions so far');
  });

  it('labels assistant and tool turns so the model can tell them apart', () => {
    const { prompt } = renderMessages([
      { role: 'user', content: 'cut it' },
      { role: 'assistant', content: 'cutting' },
      { role: 'tool', content: 'ok' },
    ]);
    expect(prompt).toBe('[user]\ncut it\n\n[assistant]\ncutting\n\n[tool result]\nok');
  });
});

describe('tool calls', () => {
  it('strips the MCP namespace the SDK adds, and leaves other names alone', () => {
    expect(stripToolPrefix('mcp__framepilot__trim_clip')).toBe('trim_clip');
    expect(stripToolPrefix('trim_clip')).toBe('trim_clip');
  });

  it('reports every parallel call, not just the last one the result names', async () => {
    // The regression this guards: `result.deferred_tool_use` is singular, so reading tool
    // calls from it drops all but the final call of a parallel turn. Measured against the
    // real SDK: two parallel calls produced two content blocks and one deferred entry.
    const { module } = fakeSdk([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'mcp__framepilot__trim_clip', input: { a: 1 } },
            { type: 'tool_use', id: 't2', name: 'mcp__framepilot__add_clip', input: { b: 2 } },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'tool_use',
        terminal_reason: 'tool_deferred',
        modelUsage: {},
        deferred_tool_use: { id: 't2', name: 'mcp__framepilot__add_clip', input: { b: 2 } },
      },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const response = await provider.complete({ messages: [{ role: 'user', content: 'go' }] });

    expect(response.toolCalls).toEqual([
      { id: 't1', name: 'trim_clip', arguments: { a: 1 } },
      { id: 't2', name: 'add_clip', arguments: { b: 2 } },
    ]);
  });

  it('keeps parallel tool calls when maxTurns is exhausted deferring them, instead of throwing them away', async () => {
    // The bug this guards: with SANDBOX_OPTIONS.maxTurns: 1, a message proposing more than
    // one parallel tool call can cost the SDK more of its own internal turns to finish
    // deferring all of them than the budget allows, so the trailing result reports
    // `subtype: 'error_max_turns'` even though every tool_use block already streamed
    // through as an `assistant` message and none of them executed (deferral guarantees
    // that regardless of how many internal turns it took). Measured on real media: this
    // discarded an already-correct, already-applied edit as a hard failure.
    const { module } = fakeSdk([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'mcp__framepilot__caption_the_edit', input: { preset: 'subtitle' } },
            { type: 'tool_use', id: 't2', name: 'mcp__framepilot__discover_caption_styles', input: {} },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        stop_reason: null,
        terminal_reason: 'max_turns',
        num_turns: 1,
        errors: ['Reached maximum number of turns (1)'],
        modelUsage: {},
      },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const response = await provider.complete({ messages: [{ role: 'user', content: 'go' }] });

    expect(response.toolCalls).toEqual([
      { id: 't1', name: 'caption_the_edit', arguments: { preset: 'subtitle' } },
      { id: 't2', name: 'discover_caption_styles', arguments: {} },
    ]);
  });

  it('keeps parallel tool calls when the SDK throws "reached maximum number of turns" mid-stream', async () => {
    // Measured against the real SDK (0.3.259) on real media: turn-budget exhaustion does
    // NOT reach the `message.type === 'result'` handling — the SDK's own query reader
    // catches the underlying process-exit error internally and re-throws a wrapped "Claude
    // Code returned an error result: Reached maximum number of turns (1)" out of the
    // `for await`, after the assistant message's tool_use blocks already streamed through
    // (and were deferred, never executed). The case this reproduced on: `caption_the_edit`
    // + `discover_caption_styles` requested together, run correctly, then the whole edit
    // was thrown away as a hard failure.
    const module = {
      query() {
        return (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 't1', name: 'mcp__framepilot__caption_the_edit', input: { preset: 'subtitle' } },
                { type: 'tool_use', id: 't2', name: 'mcp__framepilot__discover_caption_styles', input: {} },
              ],
            },
          };
          throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)');
        })();
      },
    } as unknown as AgentSdkModule;
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const response = await provider.complete({ messages: [{ role: 'user', content: 'go' }] });

    expect(response.toolCalls).toEqual([
      { id: 't1', name: 'caption_the_edit', arguments: { preset: 'subtitle' } },
      { id: 't2', name: 'discover_caption_styles', arguments: {} },
    ]);
  });

  it('still throws "reached maximum number of turns" when no tool call got out before it', async () => {
    const module = {
      query() {
        // The point of this case is a stream that dies before it yields anything,
        // so the missing yield is the fixture, not an oversight.
        // eslint-disable-next-line require-yield
        return (async function* () {
          throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)');
        })();
      },
    } as unknown as AgentSdkModule;
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await expect(provider.complete({ messages: [{ role: 'user', content: 'go' }] })).rejects.toThrow();
  });

  it('still throws for a result subtype with no usable output', async () => {
    const { module } = fakeSdk([
      { type: 'result', subtype: 'error_max_budget_usd', errors: ['Budget exceeded'] },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await expect(provider.complete({ messages: [{ role: 'user', content: 'go' }] })).rejects.toThrow();
  });
});

describe('buildToolServer', () => {
  const descriptors: ToolDescriptor[] = [
    {
      name: 'trim_clip',
      description: 'Trim a clip.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ];

  function fakeMcp(): { module: McpModule; handlers: Map<string, (r: never) => unknown> } {
    const handlers = new Map<string, (r: never) => unknown>();
    const module = {
      Server: class {
        public setRequestHandler(schema: unknown, handler: (r: never) => unknown): void {
          handlers.set(schema as string, handler);
        }
      },
      ListToolsRequestSchema: 'list',
      CallToolRequestSchema: 'call',
    } as unknown as McpModule;
    return { module, handlers };
  }

  it('advertises the registry schema verbatim, with no zod round trip', async () => {
    const { module, handlers } = fakeMcp();
    await buildToolServer(descriptors, async () => Promise.resolve(module));
    const listed = (await handlers.get('list')?.(undefined as never)) as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    expect(listed.tools).toEqual([
      {
        name: 'trim_clip',
        description: 'Trim a clip.',
        inputSchema: descriptors[0]?.parameters,
      },
    ]);
  });

  it('throws loudly if the SDK ever executes a tool, because deferral should prevent it', async () => {
    const { module, handlers } = fakeMcp();
    await buildToolServer(descriptors, async () => Promise.resolve(module));
    expect(() => handlers.get('call')?.({ params: { name: 'trim_clip' } } as never)).toThrow(
      /PreToolUse deferral/,
    );
  });
});

describe('usageFromModelUsage', () => {
  it('does not subtract cache tokens back out of the input count', () => {
    // The LangChain adapter must subtract because LangChain reports a total; the Agent
    // SDK already reports Anthropic's native shape. Subtracting twice clamps a cached
    // turn's input to zero, and the cost meter reads that fabricated zero as measured.
    const usage = usageFromModelUsage({
      'claude-opus-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 900 },
    });
    expect(usage.inputTokens).toBe(10);
    expect(usage.cacheReadInputTokens).toBe(900);
  });

  it('folds every model the turn touched, including the SDK internal calls', () => {
    const usage = usageFromModelUsage({
      'claude-opus-5': { inputTokens: 10, outputTokens: 5 },
      'claude-haiku-4-5': { inputTokens: 899, outputTokens: 14 },
    });
    expect(usage.inputTokens).toBe(909);
    expect(usage.outputTokens).toBe(19);
  });

  it('leaves cache fields absent rather than zero when nothing was cached', () => {
    const usage = usageFromModelUsage({ 'claude-opus-5': { inputTokens: 3, outputTokens: 1 } });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
    expect(usage).not.toHaveProperty('cacheCreationInputTokens');
  });
});

describe('classifyAgentSdkError', () => {
  it('calls a missing CLI an auth problem, not a retryable network blip', () => {
    // classifyLangChainError would call this `network` and retry three times, spawning a
    // subprocess each time, for a failure that can never succeed.
    const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const classified = classifyAgentSdkError(error);
    expect(classified.kind).toBe('auth');
    expect(classified.retryable).toBe(false);
  });

  it('tells a signed-out user to run claude login, never to check an API key', () => {
    const classified = classifyAgentSdkError(new Error('Not logged in. Please run /login'));
    expect(classified.kind).toBe('auth');
    // The generic `auth` copy says "check the API key in Settings" — meaningless here.
    expect(classified.editorMessage).toMatch(/claude login/);
    expect(classified.editorMessage).not.toMatch(/API key in Settings/);
  });

  it('treats a plan usage limit as a rate limit, so the run can back off', () => {
    const classified = classifyAgentSdkError(new Error('Claude usage limit reached'));
    expect(classified.kind).toBe('rate_limit');
    expect(classified.retryable).toBe(true);
  });

  it('passes an already-classified ProviderError through unchanged', () => {
    const original = new ProviderError('boom', 'bad_request');
    expect(classifyAgentSdkError(original)).toBe(original);
  });

  it('falls back to a retryable network error for anything unrecognised', () => {
    expect(classifyAgentSdkError(new Error('socket hang up')).kind).toBe('network');
  });
});

describe('streaming', () => {
  it('emits text deltas, then usage, then done', async () => {
    const { module } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const chunks = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(chunks.map((c) => c.type)).toEqual(['text-delta', 'text-delta', 'usage', 'done']);
    expect(chunks.at(-1)).toEqual({ type: 'done', text: 'Cut made.' });
  });

  it('routes thinking to reasoning-delta so it never reaches the visible answer', async () => {
    const { module } = fakeSdk([
      { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'done' } } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', modelUsage: {} },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const chunks = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(chunks[0]).toEqual({ type: 'reasoning-delta', text: 'hmm' });
    const done = chunks.at(-1) as { type: 'done'; text: string };
    expect(done.text).toBe('done');
  });

  it('reports truncation when the model ran out of output room', async () => {
    const { module } = fakeSdk([
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'half' } } },
      { type: 'result', subtype: 'success', stop_reason: 'max_tokens', modelUsage: {} },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const chunks = await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(chunks.at(-1)).toEqual({ type: 'done', text: 'half', truncated: true });
  });

  it('classifies an errored result instead of returning an empty success', async () => {
    // An upstream outage arriving as a successful, empty answer is the failure mode
    // `classifyStreamError` exists to prevent for the HTTP adapters.
    const { module } = fakeSdk([
      { type: 'result', subtype: 'error_during_execution', errors: ['Claude usage limit reached'] },
    ]);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('cancellation', () => {
  it('aborts the SDK controller so the subprocess dies with the run', async () => {
    // The SDK's own transport signal only fires after a stdin-EOF plus a grace window, so
    // cancelling through it leaves `claude` alive for seconds after Stop. Aborting the
    // controller we passed in is the immediate path.
    const { module, calls } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const controller = new AbortController();
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);

    const passed = calls[0]?.options['abortController'] as AbortController;
    // The generator's `finally` aborts unconditionally, so a consumer that stops early
    // still takes the subprocess down.
    expect(passed.signal.aborted).toBe(true);
  });

  it('forwards an already-aborted caller signal without starting a turn', async () => {
    const { module, calls } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    const controller = new AbortController();
    controller.abort();
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    expect((calls[0]?.options['abortController'] as AbortController).signal.aborted).toBe(true);
  });

  it('rethrows a genuine cancel unchanged rather than classifying it as a failure', async () => {
    const controller = new AbortController();
    const module = {
      query() {
        // Not a generator: it aborts and throws without ever yielding, which is what a
        // real cancel mid-flight looks like to the consumer.
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              controller.abort();
              return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            },
          }),
        };
      },
    } as unknown as AgentSdkModule;
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('tool declaration', () => {
  it('registers no MCP server at all for a plain chat turn', async () => {
    const { module, calls } = fakeSdk(textFrames);
    const provider = new ConcreteClaudeAgentSdkProvider({ name: 'claude-agent-sdk' }, async () =>
      Promise.resolve(module),
    );
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]?.options['mcpServers']).toBeUndefined();
  });

  it('publishes the registry tools under the framepilot server when tools are offered', async () => {
    const { module, calls } = fakeSdk(textFrames);
    const mcpLoader = vi.fn(async () =>
      Promise.resolve({
        Server: class {
          public setRequestHandler(): void {}
        },
        ListToolsRequestSchema: 'list',
        CallToolRequestSchema: 'call',
      } as unknown as McpModule),
    );
    const provider = new ConcreteClaudeAgentSdkProvider(
      { name: 'claude-agent-sdk' },
      async () => Promise.resolve(module),
      mcpLoader,
    );
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'trim_clip', description: 'Trim.', parameters: { type: 'object' } }],
    });

    const servers = calls[0]?.options['mcpServers'] as Record<string, { type: string }>;
    expect(servers['framepilot']?.type).toBe('sdk');
    expect(mcpLoader).toHaveBeenCalledOnce();
  });
});
