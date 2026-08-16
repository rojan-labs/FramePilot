/**
 * @framepilot/ai-sdk/providers/langchain-chat — the provider-agnostic half of the
 * LangChain adapters (plan/LANGCHAIN-MIGRATION.md M2).
 *
 * M1 built one adapter, for Anthropic. Reading it afterwards, almost none of it was
 * about Anthropic: response flattening, reasoning separation, streamed tool-call
 * reassembly and usage folding are the same for every chat model LangChain exposes.
 * Only two things genuinely differ per provider — **how the model is constructed**
 * and **how the messages are shaped** (Anthropic alone carries cache breakpoints).
 *
 * So this module owns the shared behaviour and {@link LangChainChatProvider} leaves
 * exactly those two as abstract. Copying the shared half per provider would mean
 * seven places for the token-accounting and tool-reassembly defects M1 found to
 * reappear independently.
 *
 * ## Two invariants every subclass inherits, and must not opt out of
 *
 * 1. **LangChain's own retry loop is off** (`maxRetries: 0`). `resilient-provider.ts`
 *    is the single retry authority (§5.1). Two retry layers means a tool invoked twice
 *    — risk 4, and the kind of bug that shows up as a duplicated edit, not an error.
 *    {@link assertSingleRetryAuthority} is applied to every constructed model rather
 *    than trusted per subclass.
 * 2. **Streamed usage is requested** (`streamUsage: true`). Without it LangChain drops
 *    usage from streamed turns entirely, and every turn of a real agent run is streamed
 *    — so cost and prompt-cache hit rate, the M0.1 acceptance metrics, would read zero.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@framepilot/shared-types';
import { classifyLangChainError } from './errors.js';
import { openAiContent } from './message-content.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ProviderConfig,
  ProviderName,
  ToolCall,
} from './types.js';
import type { Usage } from '../reliability/types.js';

const log = createLogger('ai-sdk:providers:langchain-chat');

/**
 * Options every LangChain chat model in FramePilot is constructed with.
 *
 * Named and exported so a test can assert the values directly instead of inferring
 * them from behaviour — "did the request get retried?" is a much weaker check than
 * "is the retry loop switched off?".
 */
export const SHARED_CHAT_OPTIONS = {
  /** §5.1 / risk 4: `resilient-provider.ts` is the only retry authority. */
  maxRetries: 0,
  /** M0.1: without this, streamed turns report no usage at all. */
  streamUsage: true,
} as const;

/**
 * Fail loudly if a subclass built a model that would retry on its own.
 *
 * A silent second retry layer has no error to notice — it looks like the model
 * calling a tool twice, which reads as a model problem rather than a config one.
 */
export function assertSingleRetryAuthority(options: { readonly maxRetries?: number }): void {
  if (options.maxRetries !== 0) {
    throw new Error(
      `LangChain provider misconfigured: maxRetries must be 0 so resilient-provider.ts stays the single retry authority (got ${String(options.maxRetries)}).`,
    );
  }
}

/** LangChain's normalized usage shape, as `usage_metadata` returns it. */
export interface LangChainUsageMetadata {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_token_details?: {
    readonly cache_read?: number;
    readonly cache_creation?: number;
  };
}

/**
 * Map LangChain's `usage_metadata` onto FramePilot's {@link Usage}.
 *
 * Returns `undefined` when the provider reported nothing — the SDK-wide rule is
 * that a count is never fabricated, and the cache fields specifically must stay
 * absent rather than zero so `run-metrics.ts` can tell "not reported" from a
 * measured zero (M0.1).
 */
export function usageFromMetadata(meta: LangChainUsageMetadata | undefined): Usage | undefined {
  if (!meta) return undefined;
  const outputTokens = meta.output_tokens ?? 0;
  const cacheRead = meta.input_token_details?.cache_read;
  const cacheCreation = meta.input_token_details?.cache_creation;
  // LangChain reports a TOTAL input count: it computes
  // `input_tokens + cache_creation + cache_read` (see
  // @langchain/anthropic utils/message_outputs.js). Anthropic's own
  // `input_tokens` is the NON-cached portion only, and that is what the native
  // adapter, `cost-meter.ts` and the durable WAL already record.
  //
  // Subtracting the cache components back out is what keeps the two provider
  // paths reporting the SAME numbers for the same turn. Without it, an identical
  // run would show a different input-token count — and a different prompt-cache
  // hit rate — depending only on which adapter served it, which would quietly
  // invalidate the M0.1 budget comparison that gates every later phase.
  const reportedInput = meta.input_tokens ?? 0;
  const inputTokens = Math.max(0, reportedInput - (cacheRead ?? 0) - (cacheCreation ?? 0));
  if (reportedInput === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
}

/**
 * Fold a streamed usage report into what has been seen so far.
 *
 * WHY this is a merge and not a replace: Anthropic reports the input side ONCE
 * (on `message_start`, where the `cache_read` count also rides) and the output
 * side cumulatively (on `message_delta`). LangChain surfaces those as two
 * separate `usage_metadata` payloads, the last of which carries `input_tokens: 0`
 * and no cache details. Taking the last one — the obvious implementation —
 * silently discards the prompt-cache counts on every streamed turn, which is
 * every turn of a real agent run.
 *
 * `max` is correct for both halves: input is reported once and never grows,
 * output is cumulative.
 */
export function mergeUsage(previous: Usage | undefined, next: Usage): Usage {
  if (!previous) return next;
  const cacheRead = next.cacheReadInputTokens ?? previous.cacheReadInputTokens;
  const cacheCreation = next.cacheCreationInputTokens ?? previous.cacheCreationInputTokens;
  return {
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
}

/** One piece of streamed content, tagged as visible text or chain-of-thought. */
interface ContentPiece {
  readonly kind: 'text' | 'reasoning';
  readonly text: string;
}

/**
 * Split a streamed content chunk into visible text and reasoning.
 *
 * Extended-thinking blocks must never reach the visible answer — the orchestrator
 * routes them to the reasoning panel instead (matching the native adapter's
 * `thinking_delta` handling). `reasoning_content` is DeepSeek's spelling of the
 * same idea; both are recognized here so a reasoning model's chain of thought
 * cannot leak into the answer on any provider.
 */
export function textAndReasoning(content: unknown): readonly ContentPiece[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const pieces: ContentPiece[] = [];
  for (const block of content as readonly Record<string, unknown>[]) {
    if (typeof block.thinking === 'string') {
      pieces.push({ kind: 'reasoning', text: block.thinking });
    } else if (typeof block.reasoning_content === 'string') {
      pieces.push({ kind: 'reasoning', text: block.reasoning_content });
    } else if (typeof block.text === 'string') {
      pieces.push({ kind: 'text', text: block.text });
    }
  }
  return pieces;
}

/**
 * Reasoning that arrives **beside** the content rather than inside it.
 *
 * `textAndReasoning` only sees `message.content`. `ChatDeepSeek` puts its
 * chain-of-thought on `additional_kwargs.reasoning_content` and leaves `content`
 * empty for the whole thinking phase (`@langchain/deepseek`
 * `_streamResponseChunks` yields those chunks unchanged), so reading content alone
 * dropped every reasoning chunk on the floor.
 *
 * The first M0.1 capture is what surfaced it, and the damage was not subtle:
 * TTFT p50 went 1,499 ms on the native adapter to 11,650 ms on this one, and 19 of
 * 49 calls emitted nothing at all until the final burst of visible text. The
 * sidebar sat dead through the entire thinking phase where the native path streams
 * the model thinking. A metric regression and a product regression with one cause.
 *
 * Kept separate from `textAndReasoning` because it reads a different field of a
 * different object; folding them together would hide that this is a second source.
 */
export function reasoningFromKwargs(kwargs: unknown): string {
  if (typeof kwargs !== 'object' || kwargs === null) return '';
  const value = (kwargs as Record<string, unknown>)['reasoning_content'];
  return typeof value === 'string' ? value : '';
}

/**
 * Merge a streamed tool-argument fragment into what is accumulated so far.
 *
 * Fragments arrive as partial JSON strings; only the concatenation parses. A
 * fragment that does not yet parse leaves the accumulated object untouched
 * rather than throwing — an incomplete tool call is data, not an exception.
 */
export function mergeArgs(
  existing: Record<string, unknown> | undefined,
  fragment: string | undefined,
): Record<string, unknown> {
  if (fragment === undefined || fragment === '') return existing ?? {};
  const carried = (existing?.__partial as string | undefined) ?? '';
  const joined = carried + fragment;
  try {
    return JSON.parse(joined) as Record<string, unknown>;
  } catch {
    return { ...(existing ?? {}), __partial: joined };
  }
}

/**
 * Per-call options, omitting `signal` entirely when the caller passed none.
 * `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
 * `undefined`, and LangChain's option type accepts only the former.
 */
const callOptions = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
  signal ? { signal } : {};

/**
 * Re-throw whatever a chat model threw as a typed {@link ProviderError}.
 *
 * An abort passes through untouched: `resilient-provider.ts` and `retry.ts` both
 * identify a user cancel by `error.name === 'AbortError'`, and typing it would turn a
 * deliberate stop into a failed run that then gets retried.
 */
function rethrowClassified(provider: ProviderName, error: unknown): never {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  throw classifyLangChainError(provider, error);
}

/**
 * An {@link AiProvider} over any LangChain chat model.
 *
 * Subclasses supply the model and the message shaping; everything a request does
 * after that is here, once.
 */
export abstract class LangChainChatProvider implements AiProvider {
  public abstract readonly name: ProviderName;

  public constructor(protected readonly config: ProviderConfig) {}

  /** The model id this instance will actually send, before any call is made. */
  public abstract get modelId(): string;

  /**
   * Construct the chat model for ONE request.
   *
   * A fresh instance per call (rather than one cached on the provider) because
   * `max_tokens` is per-request: the caller's ask is clamped to the selected
   * model's real ceiling, and reusing a model built for an earlier request would
   * silently apply the wrong one.
   */
  protected abstract buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel;

  /** Shape the request's messages for this provider. */
  protected abstract buildMessages(request: AiCompletionRequest): BaseMessage[];

  /** Bind the registry's tool descriptors, which are already JSON Schema. */
  private withTools(model: BaseChatModel, request: AiCompletionRequest): BaseChatModel {
    if (!request.tools || request.tools.length === 0) return model;
    /* v8 ignore next -- every chat model FramePilot uses supports tool binding */
    if (typeof model.bindTools !== 'function') return model;
    return model.bindTools(
      request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // The registry derives these from Zod via `z.toJSONSchema`, so they are
        // already the exact schemas the native adapters put on the wire.
        schema: tool.parameters,
      })),
    ) as unknown as BaseChatModel;
  }

  public async complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiResponse> {
    const runnable = this.withTools(this.buildModel(request, false), request);
    log.action('complete → request', {
      provider: this.name,
      model: this.modelId,
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
    });
    const result = await runnable
      .invoke(this.buildMessages(request), callOptions(signal))
      .catch((error: unknown) => rethrowClassified(this.name, error));
    // One content-flattening path, shared with the streaming branch, so a block
    // shape handled in one place cannot be mishandled in the other. Reasoning never
    // joins the visible answer; it goes to `AiResponse.reasoning`, which is the
    // channel the native adapters use and which an earlier comment here wrongly
    // claimed did not exist — so a reasoning model's chain of thought was silently
    // discarded on this path while native returned it.
    const pieces = textAndReasoning(result.content);
    const text = pieces
      .filter((piece) => piece.kind === 'text')
      .map((piece) => piece.text)
      .join('');
    const reasoning =
      pieces
        .filter((piece) => piece.kind === 'reasoning')
        .map((piece) => piece.text)
        .join('') + reasoningFromKwargs(result.additional_kwargs);
    /* v8 ignore next 2 -- `tool_calls` and `id` are optional in LangChain's types but
       always present on a real response; asserting otherwise would test the dependency */
    const toolCalls: ToolCall[] = (result.tool_calls ?? []).map((call) => ({
      id: call.id ?? '',
      name: call.name,
      arguments: call.args as Record<string, unknown>,
    }));
    const usage = usageFromMetadata(result.usage_metadata as LangChainUsageMetadata | undefined);
    log.action('complete ← response', { textChars: text.length, toolCalls: toolCalls.length });
    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  public async *stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const runnable = this.withTools(this.buildModel(request, true), request);
    log.action('stream → request', {
      provider: this.name,
      model: this.modelId,
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
    });
    let full = '';
    let usage: Usage | undefined;
    const toolCalls = new Map<number, ToolCall>();

    try {
      for await (const chunk of await runnable.stream(
        this.buildMessages(request),
        callOptions(signal),
      )) {
        // Before the content blocks: on DeepSeek this is the *only* thing carrying the
        // thinking phase, and emitting it first is what makes TTFT a first-token latency
        // rather than a full-turn one.
        const sidecarReasoning = reasoningFromKwargs(chunk.additional_kwargs);
        if (sidecarReasoning) yield { type: 'reasoning-delta', text: sidecarReasoning };

        for (const piece of textAndReasoning(chunk.content)) {
          if (piece.kind === 'reasoning') {
            yield { type: 'reasoning-delta', text: piece.text };
          } else if (piece.text) {
            full += piece.text;
            yield { type: 'text-delta', text: piece.text };
          }
        }
        // Tool-call fragments arrive per index and are only complete at the end, so
        // they are accumulated and emitted once the stream settles — the native
        // adapters' `content_block_stop` behavior.
        /* v8 ignore next 2 -- same: optional in the types, always emitted in practice */
        for (const fragment of chunk.tool_call_chunks ?? []) {
          const index = fragment.index ?? 0;
          const existing = toolCalls.get(index);
          toolCalls.set(index, {
            id: fragment.id ?? existing?.id ?? '',
            name: fragment.name ?? existing?.name ?? '',
            arguments: mergeArgs(existing?.arguments, fragment.args),
          });
        }
        const chunkUsage = usageFromMetadata(
          chunk.usage_metadata as LangChainUsageMetadata | undefined,
        );
        if (chunkUsage) usage = mergeUsage(usage, chunkUsage);
      }
    } catch (error) {
      // Covers both opening the stream and failing part-way through it: a gateway that
      // 500s mid-answer is the same class of event as one that refuses the connection,
      // and `resilient-provider.ts` decides what is safe to retry from the typed kind.
      rethrowClassified(this.name, error);
    }

    for (const call of toolCalls.values()) {
      if (call.name) yield { type: 'tool-call', call };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', text: full };
  }
}

/**
 * Shape a request's messages the way every non-Anthropic provider wants them.
 *
 * Mirrors `buildOpenAiBody`'s message mapping rather than inventing a second one:
 * `system` becomes a `SystemMessage`, `assistant` an `AIMessage`, and everything
 * else — including `tool`, exactly as the native adapters do — a `HumanMessage`.
 * Content goes through the shared {@link openAiContent} serializer, so a message
 * carrying images produces the same content-part array the native path sends.
 *
 * Anthropic does NOT use this: it needs cache breakpoints, which are the one thing
 * the providers genuinely disagree about.
 */
export function toChatMessages(request: AiCompletionRequest): BaseMessage[] {
  return request.messages.map((message) => {
    // `openAiContent` returns a string, or OpenAI's content-part array for images.
    // LangChain accepts both under the same field, so this is a pass-through.
    const content = openAiContent(message) as unknown as string;
    if (message.role === 'system') return new SystemMessage(content);
    if (message.role === 'assistant') return new AIMessage(content);
    return new HumanMessage(content);
  });
}
