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
  AiMessage,
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
 * One tool call being reassembled from a stream, before its arguments are parsed.
 *
 * The raw argument TEXT is what is accumulated, never a partially-parsed object. The
 * previous implementation parsed after every fragment and kept the object when the
 * concatenation happened to parse — which threw the raw text away, so the next fragment
 * restarted from an empty buffer and the call's arguments silently became whichever
 * suffix happened to parse on its own. Text in, one parse at the end, is the only shape
 * that cannot lose a fragment.
 */
export interface StreamingToolCall {
  readonly id: string;
  readonly name: string;
  /** Every `args` fragment seen for this call, concatenated in arrival order. */
  readonly argsText: string;
  /**
   * Arguments the provider handed over ALREADY PARSED (LangChain's `tool_calls`, which a
   * chunk carries instead of `tool_call_chunks` when the gateway did not stream the call
   * in fragments). Authoritative when present — there is no text to parse.
   */
  readonly parsedArgs?: Record<string, unknown>;
}

/**
 * Accumulate streamed tool-call fragments without ever letting two calls collide.
 *
 * ## Why this is not a `Map<number, …>`
 *
 * Fragments carry `index`, and the obvious implementation keys on `index ?? 0`. Two
 * different gateways break that:
 *
 * - one omits `index` entirely, so every fragment of every call lands on key `0` and
 *   three tool calls arrive as one, with their argument strings concatenated into
 *   unparseable garbage;
 * - one restarts `index` at `0` for each call it emits, with the same result.
 *
 * Both were visible in a captured OpenRouter run: a turn that asked for `transcribe` plus
 * two `add_clip`s reached the executor as a single `transcribe` whose arguments were the
 * one character `{`.
 *
 * So a fragment carrying an `id` or a `name` that DISAGREES with what is open at its index
 * starts a new call rather than overwriting the open one. Order is preserved because
 * finished calls are pushed to a list in the order they were closed.
 */
export class ToolCallAccumulator {
  /**
   * Every call seen, in the order its first fragment arrived — which is the order the model
   * asked for them and therefore the order the turn must run them in. A mutating call
   * advances the working copy the next one is validated against, so reordering a batch can
   * change what it produces.
   */
  private readonly calls: StreamingToolCall[] = [];

  /** Where in {@link calls} the call currently open at each stream index lives. */
  private readonly openAt = new Map<number, number>();

  /** Take one `tool_call_chunk`. */
  public push(fragment: {
    readonly index?: number;
    readonly id?: string;
    readonly name?: string;
    readonly args?: string;
  }): void {
    const index = fragment.index ?? 0;
    const position = this.openAt.get(index);
    const current = position === undefined ? undefined : this.calls[position];
    if (current !== undefined && !startsNewCall(current, fragment)) {
      this.calls[position as number] = {
        id: fragment.id ?? current.id,
        name: fragment.name ?? current.name,
        argsText: current.argsText + (fragment.args ?? ''),
        ...(current.parsedArgs !== undefined ? { parsedArgs: current.parsedArgs } : {}),
      };
      return;
    }
    this.openAt.set(index, this.calls.length);
    this.calls.push({
      id: fragment.id ?? '',
      name: fragment.name ?? '',
      argsText: fragment.args ?? '',
    });
  }

  /**
   * Take a COMPLETE tool call the provider already parsed.
   *
   * `AIMessageChunk`'s constructor fills `tool_calls` and leaves `tool_call_chunks` empty
   * whenever the gateway delivered the call in one piece, so a reader that looks only at
   * the fragments drops those calls on the floor — silently, which is the worst way to
   * lose a tool call. Matched to an accumulation by id so a provider that sends both shapes
   * for the same call does not produce it twice.
   */
  public pushComplete(call: {
    readonly id?: string;
    readonly name?: string;
    readonly args?: unknown;
  }): void {
    const args = isArgsObject(call.args) ? call.args : undefined;
    const id = call.id ?? '';
    const name = call.name ?? '';
    const existing = id === '' ? -1 : this.calls.findIndex((seen) => seen.id === id);
    if (existing !== -1) {
      const seen = this.calls[existing] as StreamingToolCall;
      this.calls[existing] = {
        ...seen,
        name: seen.name !== '' ? seen.name : name,
        ...(args !== undefined ? { parsedArgs: args } : {}),
      };
      return;
    }
    this.calls.push({
      id,
      name,
      argsText: '',
      ...(args !== undefined ? { parsedArgs: args } : {}),
    });
  }

  /** Every call seen, in the order it was opened. */
  public settle(): readonly StreamingToolCall[] {
    return this.calls;
  }
}

/**
 * Does this fragment belong to a DIFFERENT call than the one open at its index?
 *
 * Only a disagreeing non-empty id or name says so. A fragment that merely repeats the open
 * call's id/name, or carries neither (the ordinary argument-fragment shape), is a
 * continuation.
 */
function startsNewCall(
  open: StreamingToolCall,
  fragment: { readonly id?: string; readonly name?: string },
): boolean {
  if (fragment.id !== undefined && fragment.id !== '' && open.id !== '') {
    return fragment.id !== open.id;
  }
  if (fragment.name !== undefined && fragment.name !== '' && open.name !== '') {
    return fragment.name !== open.name;
  }
  return false;
}

/** Is this what a provider handed over as already-parsed tool arguments? */
function isArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The arguments of a reassembled tool call, or `undefined` when they cannot be trusted.
 *
 * ## WHY a truncated argument string is never repaired
 *
 * The tempting fix for `{"trackId":"v_main","start":12` is to close the brace and dispatch
 * what parsed. That is a wrong edit dressed as a recovery: the stream stopped mid-token,
 * so `12` may be the head of `12.5`, and an `add_clip` at the wrong second is worse than
 * an `add_clip` that never happened. Anything that does not parse as COMPLETE JSON is
 * therefore refused, and the turn is reported as truncated so the model is asked again.
 *
 * An empty argument string is `{}` — legitimately what a no-argument tool sends, and for a
 * tool with required parameters the registry's own schema error is the clearer message.
 */
export function toolCallArguments(call: StreamingToolCall): Record<string, unknown> | undefined {
  if (call.parsedArgs !== undefined) return call.parsedArgs;
  const text = call.argsText.trim();
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isArgsObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-call options, omitting `signal` entirely when the caller passed none.
 * `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
 * `undefined`, and LangChain's option type accepts only the former.
 */
/**
 * Whether a chunk's `response_metadata` says the model stopped because it ran out of room.
 *
 * Every wire format spells it differently — OpenAI-compatible gateways use
 * `finish_reason: 'length'`, Anthropic uses `stop_reason: 'max_tokens'`, some proxies pass
 * both through — so all the spellings are checked and anything else (a normal `stop`, a
 * `tool_calls` stop, no metadata at all) reads as "not truncated". Returns `undefined` when
 * the chunk says nothing about it, so a later chunk's verdict is not overwritten by an
 * earlier silent one.
 */
export function stopReasonFrom(metadata: unknown): boolean | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const record = metadata as Record<string, unknown>;
  const reason = record.finish_reason ?? record.stop_reason ?? record.finishReason;
  if (typeof reason !== 'string' || reason === '') return undefined;
  return reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS';
}

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
    let truncated = false;
    const accumulator = new ToolCallAccumulator();

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
        const fragments = chunk.tool_call_chunks ?? [];
        for (const fragment of fragments) accumulator.push(fragment);
        // A chunk carries `tool_calls` INSTEAD of `tool_call_chunks` when the gateway did
        // not stream the call in pieces (`AIMessageChunk`'s constructor: no fragments ⇒
        // `tool_call_chunks: []` and `tool_calls` passed straight through). Reading only
        // the fragments dropped every such call without a trace.
        if (fragments.length === 0) {
          for (const complete of chunk.tool_calls ?? []) accumulator.pushComplete(complete);
        }
        const chunkUsage = usageFromMetadata(
          chunk.usage_metadata as LangChainUsageMetadata | undefined,
        );
        if (chunkUsage) usage = mergeUsage(usage, chunkUsage);
        // The provider's own account of WHY it stopped. Only the last chunk carries it, so
        // the latest non-empty value wins.
        const reason = stopReasonFrom(chunk.response_metadata);
        if (reason !== undefined) truncated = reason;
      }
    } catch (error) {
      // Covers both opening the stream and failing part-way through it: a gateway that
      // 500s mid-answer is the same class of event as one that refuses the connection,
      // and `resilient-provider.ts` decides what is safe to retry from the typed kind.
      rethrowClassified(this.name, error);
    }

    // ONE parse per call, at the end — and a call whose arguments did not survive the
    // stream is REPORTED, never dispatched. Dispatching it was the defect this replaced:
    // the half-parsed fragment reached the executor as `{ __partial: '{' }`, the tool
    // rejected it as an unrecognized key, and the run's repeated-failure guard then banked
    // that rejection and refused every later attempt at the same tool.
    const dropped: string[] = [];
    for (const settled of accumulator.settle()) {
      if (settled.name === '') {
        // No name, nothing to call. Named as `(unnamed)` rather than skipped silently so a
        // gateway that loses the function name shows up as a dropped call, not as a turn
        // where the model asked for less than it did.
        dropped.push('(unnamed)');
        continue;
      }
      const args = toolCallArguments(settled);
      if (args === undefined) {
        log.warn('dropped a tool call whose streamed arguments never parsed', {
          provider: this.name,
          tool: settled.name,
          argsChars: settled.argsText.length,
        });
        dropped.push(settled.name);
        continue;
      }
      yield { type: 'tool-call', call: { id: settled.id, name: settled.name, arguments: args } };
    }
    if (usage) yield { type: 'usage', usage };
    yield {
      type: 'done',
      text: full,
      // A dropped call IS a truncated reply, whatever the provider's own `finish_reason`
      // said: the model asked for work that did not arrive intact. Saying so is what lets
      // the agent loop retry the step instead of reading the turn as a finished answer.
      ...(truncated || dropped.length > 0 ? { truncated: true } : {}),
      ...(dropped.length > 0 ? { droppedToolCalls: dropped } : {}),
    };
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
 * ## Cache breakpoints on an OpenAI-shaped body
 *
 * `cacheBoundary` used to be Anthropic's alone, and that was a real cost rather than a
 * tidy separation of concerns. Captured run `e36235cc` ran on `openrouter/auto-beta` and
 * assembled 1,223,811 tokens across 52 calls, **736,595 of them (60.2%) tool definitions
 * re-sent whole every call**. Whether any of that was cached was unknowable from the code:
 * the marker the agent loop carefully places was simply dropped on this path.
 *
 * So it is carried here too. A gateway that understands the marker — OpenRouter passes
 * `cache_control` through to Anthropic models — uses it; a gateway that does not ignores
 * an unknown key on a content part, which is the ordinary shape of an OpenAI content
 * array. Providers doing AUTOMATIC prefix caching (OpenAI, most local servers) are
 * unaffected either way: their caching keys on the byte prefix, which this does not move.
 *
 * That asymmetry is why this is worth doing blind. Sending it costs nothing when it is not
 * understood and saves the largest line item in the product when it is.
 */
export function toChatMessages(request: AiCompletionRequest): BaseMessage[] {
  const boundaryIndex = request.messages.reduce(
    (last, message, index) => (message.cacheBoundary === true ? index : last),
    -1,
  );
  return request.messages.map((message, index) => {
    // `openAiContent` returns a string, or OpenAI's content-part array for images.
    // LangChain accepts both under the same field, so this is a pass-through.
    const content =
      index === boundaryIndex
        ? (openAiCacheBoundaryContent(message) as unknown as string)
        : (openAiContent(message) as unknown as string);
    if (message.role === 'system') return new SystemMessage(content);
    if (message.role === 'assistant') return new AIMessage(content);
    return new HumanMessage(content);
  });
}

/**
 * The boundary message as an OpenAI content array carrying a `cache_control` marker.
 *
 * Block-shaped for the same reason Anthropic's is: the marker has to sit on a part, not on
 * the message. A message that already carries images keeps its parts and the marker rides
 * on the last one, so the whole message is inside the cached prefix.
 */
export function openAiCacheBoundaryContent(message: AiMessage): unknown {
  const marked = { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } };
  const base = openAiContent(message);
  if (!Array.isArray(base)) return [marked];
  // Images already produced parts; append the marked text rather than discarding them.
  return [...(base as unknown[]).filter((part) => !isPlainTextPart(part)), marked];
}

/** Is this content part the plain-text half that {@link openAiCacheBoundaryContent} replaces? */
function isPlainTextPart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { readonly type?: unknown }).type === 'text'
  );
}
