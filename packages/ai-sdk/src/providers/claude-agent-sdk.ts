/**
 * @framepilot/ai-sdk/providers/claude-agent-sdk — Claude via the user's existing
 * Claude Code login, with no API key.
 *
 * ## Why this provider exists
 *
 * Every other provider here authenticates with a key the user pastes into Settings. A
 * creator who already pays for a Claude subscription had no way to spend it on FramePilot
 * except `trial/auth2api`, a third-party OAuth→OpenAI proxy that had to be git-cloned,
 * built and kept running on port 8317. This provider replaces that proxy with the
 * first-party path: `@anthropic-ai/claude-agent-sdk` resolves the same credential the
 * `claude` CLI stores (macOS Keychain, `Claude Code-credentials`), so a logged-in user
 * selects "Claude (existing login)" and nothing else.
 *
 * Measured on 2026-09-03 against the installed SDK (0.3.259): a call with no
 * `ANTHROPIC_API_KEY` in the environment reports `apiKeySource: 'none'` and succeeds.
 *
 * ## Why it is NOT an agent, despite the package name
 *
 * The Agent SDK is a full agent runtime — its own loop, its own Read/Write/Bash tools,
 * its own prompt assembled from the user's `~/.claude`. Letting any of that through would
 * break AGENTS.md invariant 5 (the AI edits only through registered, schema-validated
 * FramePilot tools) and would hand the model filesystem access that bypasses
 * `electron/ipc/sandbox.ts` entirely.
 *
 * So this adapter runs it in a deliberately degenerate mode, and {@link SANDBOX_OPTIONS}
 * is that contract in one object — asserted by `claude-agent-sdk.test.ts` because these
 * four fields are a security boundary, not a preference:
 *
 * - `tools: []` — no built-in tools. Verified: the init frame reports `tools: []`.
 * - `settingSources: []` — SDK isolation mode. Without it the user's personal
 *   `~/.claude/CLAUDE.md` is folded into the system prompt, making FramePilot's prompt a
 *   function of the developer's machine — non-deterministic input to a system whose
 *   golden manifests track prompt text byte for byte.
 * - `systemPrompt: {type:'custom'}` — never the `claude_code` preset.
 * - `permissionMode: 'default'` — never `bypassPermissions`.
 *
 * ## How a tool call gets back out without being executed
 *
 * FramePilot's tools are declared to the model as an in-process MCP server built from the
 * registry's JSON Schema (see {@link buildToolServer}) — raw schema, no zod, which is why
 * the Agent SDK's zod-4 `tool()` helper is deliberately unused: this package is on zod 3.
 *
 * The model then emits `tool_use` blocks, and a `PreToolUse` hook returns
 * `permissionDecision: 'defer'`. Deferral makes the SDK stop the turn *before* executing
 * anything and finish with `terminal_reason: 'tool_deferred'`. The tool never runs — the
 * MCP server's call handler is unreachable by construction and throws if it is ever hit.
 *
 * Tool calls are read from the assistant messages' `tool_use` content blocks, NOT from
 * the result's `deferred_tool_use`. That field is singular and therefore lossy: a turn
 * that asks for three cuts in parallel reports only the last one. The content blocks
 * carry all of them, in order. (Measured: two parallel `Bash` calls → two blocks, one
 * `deferred_tool_use`.)
 *
 * ## What this provider cannot do, and why it is honest about it
 *
 * - **No `temperature`.** The SDK exposes none. Callers that pass `temperature: 0` for
 *   determinism (the tier proposers, the vision judge) get the model's default sampling.
 * - **No `maxTokens`.** The SDK owns the output budget. Harmless in practice — the models
 *   it serves default to a far larger ceiling than the 2,048 clamp that once truncated
 *   structured proposals — but it is not a promise this provider can keep.
 * - **No `cacheBoundary`.** The SDK manages its own prompt caching, so the run-stable
 *   prefix breakpoint is ignored.
 * - **No images.** A string prompt cannot carry image blocks, so `get_frame` frames would
 *   be silently dropped. {@link supportsVision} must therefore report `false` for this
 *   provider rather than inferring `true` from the `claude-*` model id.
 *
 * @see docs/adr/0171-the-login-you-already-have.md
 */
import { createLogger } from '@framepilot/shared-types';
import { ProviderError } from '../reliability/types.js';
import type { Usage } from '../reliability/types.js';
import { CLAUDE_AGENT_SDK_DEFAULT_MODEL } from './provider-defaults.js';
import type {
  AiCompletionRequest,
  AiMessage,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ProviderConfig,
  ToolCall,
  ToolDescriptor,
} from './types.js';

const log = createLogger('ai-sdk:providers:claude-agent-sdk');

/**
 * The MCP server name FramePilot's tools are published under.
 *
 * The Agent SDK namespaces every MCP tool as `mcp__<server>__<tool>`, so this string is
 * half of the round trip: {@link buildToolServer} publishes under it and
 * {@link stripToolPrefix} removes it before the orchestrator sees the name. Changing it
 * changes the names the model is shown, so it is a constant, not a parameter.
 */
const MCP_SERVER_NAME = 'framepilot';
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * The non-agentic sandbox, as one frozen object.
 *
 * This is a **security contract**, not configuration: each field closes a specific hole
 * described in the module header. `claude-agent-sdk.test.ts` asserts every field, so
 * loosening one here fails a test rather than quietly granting the model disk access.
 */
export const SANDBOX_OPTIONS = Object.freeze({
  /** No built-in tools — no Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch. */
  tools: Object.freeze([]) as readonly never[],
  /** No `~/.claude/settings.json`, no project settings, no CLAUDE.md. */
  settingSources: Object.freeze([]) as readonly never[],
  /** Never `bypassPermissions`; the deferral hook is what actually gates execution. */
  permissionMode: 'default' as const,
  /**
   * One assistant turn per call. FramePilot's orchestrator owns the loop: it executes the
   * tool, appends the result and calls again. A second SDK-side turn would be the SDK
   * continuing a conversation the orchestrator has not seen.
   */
  maxTurns: 1,
  /** Only FramePilot's own MCP server; never one discovered from the user's machine. */
  strictMcpConfig: true,
});

/** Strip the `mcp__framepilot__` namespace the Agent SDK adds to every MCP tool name. */
export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

/**
 * Render FramePilot's message array into the one prompt the SDK accepts.
 *
 * The Agent SDK is session-shaped: it owns conversation state and its `prompt` carries
 * only `user`-role content. FramePilot is the opposite — the orchestrator rebuilds the
 * whole context every turn (project snapshot, state briefing, action log) and resends it,
 * which is why `AiMessage[]` arrives complete on every call.
 *
 * Those two models cannot both own the history, so this adapter keeps FramePilot's:
 * system messages become the SDK's system prompt, and the remaining turns are rendered
 * into a single labelled transcript. The model sees the same content in the same order;
 * what is lost is native role separation, which the SDK gives no way to supply.
 *
 * @returns The system prompt (joined system messages) and the transcript to send.
 */
export function renderMessages(messages: readonly AiMessage[]): {
  systemPrompt: string;
  prompt: string;
} {
  const system: string[] = [];
  const turns: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    // A label per turn, so the model can tell its own prior replies and tool results
    // apart from what the user said. Without them the transcript reads as one long user
    // message and the model re-answers turns it already answered.
    const label =
      message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool result' : 'user';
    turns.push(`[${label}]\n${message.content}`);
  }
  return { systemPrompt: system.join('\n\n'), prompt: turns.join('\n\n') };
}

/**
 * Build the in-process MCP server that advertises FramePilot's tools to the model.
 *
 * Raw JSON Schema, straight from the tool registry's {@link ToolDescriptor}s. The Agent
 * SDK ships a `tool()` helper that would do this from zod schemas, but it declares a
 * `zod@^4` peer and this package is on zod 3 — and the registry's schemas are JSON
 * Schema already, so converting to zod and back would only add a lossy hop.
 *
 * The call handler is unreachable: the `PreToolUse` deferral stops the turn before any
 * tool executes. It throws rather than returning an error result so that a regression
 * which re-enables execution fails loudly here instead of silently running a tool the
 * orchestrator never validated.
 *
 * @param tools - Tool descriptors from the registry, or none for a plain chat turn.
 * @param loadMcp - Injected module loader (the MCP SDK), so tests need no subprocess.
 * @returns An MCP server instance ready to hand to the Agent SDK as an `sdk` server.
 */
export async function buildToolServer(
  tools: readonly ToolDescriptor[],
  loadMcp: () => Promise<McpModule>,
): Promise<unknown> {
  const { Server, ListToolsRequestSchema, CallToolRequestSchema } = await loadMcp();
  const server = new Server(
    { name: MCP_SERVER_NAME, version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request: McpCallRequest) => {
    // Unreachable by construction — see the docblock. Loud on purpose.
    throw new Error(
      `FramePilot tool "${request.params.name}" was executed by the Claude Agent SDK. ` +
        'The PreToolUse deferral is the only thing that keeps tool execution with the ' +
        'orchestrator; this means it is no longer in force.',
    );
  });
  return server;
}

/** The slice of `@modelcontextprotocol/sdk` this adapter uses, loaded dynamically. */
export interface McpModule {
  Server: new (
    info: { name: string; version: string },
    options: { capabilities: { tools: Record<string, never> } },
  ) => {
    setRequestHandler(schema: unknown, handler: (request: never) => unknown): void;
  };
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
}

interface McpCallRequest {
  params: { name: string };
}

/**
 * Turn an Agent SDK failure into a {@link ProviderError} the run can act on.
 *
 * `classifyLangChainError` is deliberately NOT reused. It reads an HTTP status off the
 * thrown error and, finding none, calls everything `network` — which is retryable. A
 * subprocess provider has no status on anything, so every permanent failure (no `claude`
 * binary, not logged in) would be retried three times with backoff before the user saw a
 * word. The classification below is by message shape because that is the only signal the
 * SDK gives.
 *
 * `editorMessage` matters more here than for any other provider: the generic `auth` copy
 * is "check the API key in Settings → AI", and this provider has no API key. The sentence
 * has to name `claude login` or it sends the user somewhere that cannot help them.
 */
export function classifyAgentSdkError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;

  if (code === 'ENOENT' || /not found|no such file|spawn .* enoent/i.test(message)) {
    return new ProviderError(`Claude Agent SDK could not start: ${message}`, 'auth', {
      editorMessage:
        'FramePilot could not start Claude Code. Install the Claude CLI, then pick this ' +
        'provider again in Settings → AI.',
    });
  }
  if (/not logged in|please run .*login|no active session|unauthor|invalid api key/i.test(message)) {
    return new ProviderError(`Claude Agent SDK is not authenticated: ${message}`, 'auth', {
      editorMessage:
        'FramePilot is not signed in to Claude. Run `claude login` in a terminal, then ' +
        'start the run again — this provider uses your Claude subscription, not an API key.',
    });
  }
  if (/usage limit|rate limit|too many requests|quota/i.test(message)) {
    return new ProviderError(`Claude Agent SDK hit a usage limit: ${message}`, 'rate_limit', {
      editorMessage:
        'Your Claude plan has hit its usage limit. Wait for it to reset, or switch to a ' +
        'provider with an API key in Settings → AI.',
    });
  }
  if (/overloaded|capacity/i.test(message)) {
    return new ProviderError(`Claude Agent SDK reported overload: ${message}`, 'overloaded');
  }
  return new ProviderError(`Claude Agent SDK request failed: ${message}`, 'network');
}

/**
 * Fold the SDK's per-model usage record into one {@link Usage}.
 *
 * Two traps, both of which produce plausible-looking wrong numbers rather than errors:
 *
 * 1. **Do not subtract cache tokens.** `usageFromMetadata` in `langchain-chat.ts` does,
 *    because LangChain reports a *total* input count. The Agent SDK reports Anthropic's
 *    native shape, where `inputTokens` already excludes cache. Subtracting again clamps
 *    every cached turn's input to zero and the cost meter reads that fabricated zero as
 *    measured.
 * 2. **Do not sum across results.** The SDK's own type docs say each result carries the
 *    running total, so summing double-counts. This folds one `modelUsage` record — the
 *    field the SDK names as the accounting one — across its model keys.
 *
 * Cache fields stay *absent* rather than zero when nothing was cached, matching the rest
 * of the SDK: absent means "not reported", zero means "measured as none".
 */
export function usageFromModelUsage(modelUsage: Record<string, ModelUsageEntry>): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const entry of Object.values(modelUsage)) {
    inputTokens += entry.inputTokens ?? 0;
    outputTokens += entry.outputTokens ?? 0;
    cacheRead += entry.cacheReadInputTokens ?? 0;
    cacheCreation += entry.cacheCreationInputTokens ?? 0;
  }
  const usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } = { inputTokens, outputTokens };
  if (cacheRead > 0) usage.cacheReadInputTokens = cacheRead;
  if (cacheCreation > 0) usage.cacheCreationInputTokens = cacheCreation;
  return usage;
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Claude through the user's Claude Code login.
 *
 * Node-only: the Agent SDK spawns the bundled `claude` binary. The module is reached
 * exclusively through a dynamic import so the renderer never pulls it into the Vite
 * graph, and the SDK specifiers below are loaded through injectable loaders that default
 * to a non-analyzable specifier for the same reason.
 */
export class ConcreteClaudeAgentSdkProvider implements AiProvider {
  public readonly name = 'claude-agent-sdk' as const;

  public constructor(
    private readonly config: ProviderConfig,
    private readonly loadAgentSdk: () => Promise<AgentSdkModule> = defaultAgentSdkLoader,
    private readonly loadMcp: () => Promise<McpModule> = defaultMcpLoader,
  ) {}

  /**
   * Answered synchronously from config, never by asking the CLI.
   *
   * Context occupancy is sized from this before the first call, and the SDK's short
   * aliases (`sonnet`, `opus`) are not catalog keys — an alias would leave the context
   * meter permanently in "assumed" mode. The default is a full catalog id for that
   * reason.
   */
  public get modelId(): string {
    return this.config.model ?? CLAUDE_AGENT_SDK_DEFAULT_MODEL;
  }

  public async complete(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): Promise<AiResponse> {
    const text: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;

    for await (const chunk of this.run(request, signal)) {
      if (chunk.type === 'text-delta') text.push(chunk.text);
      else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text);
      else if (chunk.type === 'tool-call') toolCalls.push(chunk.call);
      else if (chunk.type === 'usage') usage = chunk.usage;
    }

    const response: {
      text: string;
      toolCalls?: readonly ToolCall[];
      reasoning?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    } = { text: text.join('') };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (reasoning.length > 0) response.reasoning = reasoning.join('');
    if (usage !== undefined)
      response.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    return response;
  }

  public stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    return this.run(request, signal);
  }

  /**
   * One turn: build the sandboxed query, translate its frames into {@link ProviderChunk}s.
   *
   * The caller's `AbortSignal` is bridged to an `AbortController` the SDK owns. That
   * indirection is required, not stylistic: the SDK's own transport signal fires only
   * after a stdin-EOF plus a grace window, so cancelling through it leaves a `claude`
   * process alive for seconds after the user pressed Stop. Aborting the controller we
   * passed in is the immediate path. The `finally` aborts unconditionally so a consumer
   * that stops iterating early — which `ResilientProvider` does on its idle timeout —
   * still takes the subprocess down with it.
   */
  private async *run(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const controller = new AbortController();
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (signal?.aborted === true) forwardAbort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    const { systemPrompt, prompt } = renderMessages(request.messages);
    const tools = request.tools ?? [];
    const text: string[] = [];
    let truncated = false;

    try {
      const { query } = await this.loadAgentSdk();
      const options: Record<string, unknown> = {
        ...SANDBOX_OPTIONS,
        tools: [],
        settingSources: [],
        model: this.modelId,
        abortController: controller,
        includePartialMessages: true,
        systemPrompt: { type: 'custom', prompt: systemPrompt },
        hooks: { PreToolUse: [{ hooks: [deferToolExecution] }] },
      };
      if (request.reasoningEffort !== undefined) options['effort'] = request.reasoningEffort;
      if (tools.length > 0) {
        options['mcpServers'] = {
          [MCP_SERVER_NAME]: {
            type: 'sdk',
            name: MCP_SERVER_NAME,
            instance: await buildToolServer(tools, this.loadMcp),
          },
        };
      }

      for await (const message of query({ prompt, options })) {
        // Incremental deltas, so the editor renders as the model writes rather than in
        // one lump at the end.
        if (message.type === 'stream_event') {
          const delta = message.event?.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            text.push(delta.text);
            yield { type: 'text-delta', text: delta.text };
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            // Reasoning is routed to the reasoning panel and must never reach `text`.
            yield { type: 'reasoning-delta', text: delta.thinking };
          }
          continue;
        }
        if (message.type === 'assistant') {
          // Tool calls come from the content blocks, not the result's singular
          // `deferred_tool_use` — see the module header on parallel calls.
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              yield {
                type: 'tool-call',
                call: {
                  id: block.id,
                  name: stripToolPrefix(block.name),
                  arguments: block.input,
                },
              };
            }
          }
          continue;
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            throw classifyAgentSdkError(
              new Error(message.errors?.join('; ') ?? `Claude Code ended: ${message.subtype}`),
            );
          }
          truncated = message.stop_reason === 'max_tokens';
          yield { type: 'usage', usage: usageFromModelUsage(message.modelUsage ?? {}) };
          log.debug('claude agent sdk turn finished', {
            terminalReason: message.terminal_reason,
            turns: message.num_turns,
          });
        }
      }
      yield { type: 'done', text: text.join(''), ...(truncated ? { truncated } : {}) };
    } catch (error) {
      // A genuine user cancel must stay an AbortError so the retry loop and the
      // orchestrator report "cancelled" rather than retrying a stopped run.
      if (signal?.aborted === true) throw error;
      throw classifyAgentSdkError(error);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      controller.abort();
    }
  }
}

/**
 * The `PreToolUse` hook that keeps tool execution with FramePilot's orchestrator.
 *
 * `defer` is the SDK's own mechanism for handing a tool call back to the host: it stops
 * the turn before execution and finishes with `terminal_reason: 'tool_deferred'`. Denying
 * instead would let the model see a refusal and try something else, which is a different
 * conversation from the one the orchestrator is running.
 */
async function deferToolExecution(): Promise<HookOutput> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'defer',
      permissionDecisionReason: 'FramePilot executes its own tools.',
    },
  };
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'defer';
    permissionDecisionReason: string;
  };
}

/** The slice of `@anthropic-ai/claude-agent-sdk` this adapter uses. */
export interface AgentSdkModule {
  query(params: {
    prompt: string;
    options: Record<string, unknown>;
  }): AsyncIterable<AgentSdkMessage>;
}

interface AgentSdkMessage {
  type: string;
  subtype?: string;
  event?: { delta?: { type?: string; text?: string; thinking?: string } };
  message: { content: { type: string; id: string; name: string; input: Record<string, unknown> }[] };
  errors?: string[];
  stop_reason?: string | null;
  terminal_reason?: string;
  num_turns?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * Module specifiers held as variables so the bundler cannot follow them.
 *
 * This is what keeps a Node-only package out of the web-editor's Rollup graph. Writing the
 * package name as a literal inside the dynamic import would be statically analyzable, and
 * Vite would pull a 1.5 MB module that spawns subprocesses into the browser build — the same
 * class of failure that already needed a bespoke `resolveId` plugin for
 * `@anthropic-ai/sdk`'s subpaths. `renderer-bundle-boundary.test.ts` asserts this file
 * carries no static import of either package.
 */
const AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk';
const MCP_SDK_SPECIFIER = '@modelcontextprotocol/sdk/server/index.js';
const MCP_TYPES_SPECIFIER = '@modelcontextprotocol/sdk/types.js';

const defaultAgentSdkLoader = async (): Promise<AgentSdkModule> =>
  (await import(/* @vite-ignore */ AGENT_SDK_SPECIFIER)) as unknown as AgentSdkModule;

const defaultMcpLoader = async (): Promise<McpModule> => {
  const [server, types] = await Promise.all([
    import(/* @vite-ignore */ MCP_SDK_SPECIFIER),
    import(/* @vite-ignore */ MCP_TYPES_SPECIFIER),
  ]);
  return {
    Server: (server as { Server: McpModule['Server'] }).Server,
    ListToolsRequestSchema: (types as { ListToolsRequestSchema: unknown }).ListToolsRequestSchema,
    CallToolRequestSchema: (types as { CallToolRequestSchema: unknown }).CallToolRequestSchema,
  };
};
