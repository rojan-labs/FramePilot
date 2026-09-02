/**
 * @framepilot/ai-sdk/providers/langchain — an {@link AiProvider} over LangChain's
 * `ChatAnthropic` (plan/LANGCHAIN-MIGRATION.md M1.1).
 *
 * WHY this exists, and what it reverses: `providers/anthropic.ts` documents a
 * standing decision to call the Messages API with raw `fetch` — "a single JSON
 * POST, so calling it directly keeps the dependency surface (and license review
 * burden) minimal". This module deliberately reverses that at the provider seam
 * only, as the first step of the LangGraph migration. See ADR 0098.
 *
 * ## The one thing this module must not get wrong
 *
 * Anthropic prompt caching. `buildBody` in the native adapter places **two**
 * `cache_control` breakpoints: one on the system/tools prefix, one on the message
 * the caller flagged {@link AiMessage.cacheBoundary} (the agent contract, the
 * committed plan and the pinned skill playbooks — byte-identical every turn).
 * Before that second breakpoint existed, up to eight pinned playbooks were
 * re-billed on every turn of every run.
 *
 * A mis-placed breakpoint has **no functional symptom** — the run still works,
 * it just silently costs multiples more (risk 3, the highest-impact risk in the
 * migration plan). So this module does not re-derive the placement: it imports
 * {@link splitAnthropicMessages}, {@link resolveMaxTokens} and
 * {@link ANTHROPIC_CACHE_CONTROL} from the native adapter, and
 * `langchain-parity.test.ts` compares the two outgoing request bodies field by
 * field on every shape that matters.
 *
 * ## Deliberate non-goals
 *
 * - **No retry/timeout policy here.** `resilient-provider.ts` remains the single
 *   retry authority (§5.1 / risk 4 — two retry layers means duplicate tool
 *   invocations). `maxRetries: 0` is set explicitly so LangChain's own retry loop
 *   is off, not merely unconfigured.
 * - **Thinking is not requested**, matching the native adapter, which parses
 *   `thinking_delta` defensively but never asks for it. Requesting it here would
 *   add a `thinking` field the native body does not have, breaking parity and
 *   changing cost.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  LangChainChatProvider,
  SHARED_CHAT_OPTIONS,
  assertSingleRetryAuthority,
} from './langchain-chat.js';
import { ANTHROPIC_DEFAULT_MODEL } from './provider-defaults.js';
import { capabilitiesFor } from './model-capabilities.js';
import { anthropicContent } from './message-content.js';
import type { AiCompletionRequest, AiMessage, FetchLike, ProviderConfig } from './types.js';

// ---------------------------------------------------------------------------
// Anthropic protocol shaping
// ---------------------------------------------------------------------------
//
// Moved here from the deleted `providers/anthropic.ts` (ADR 0105). None of it was about
// *transport* — it is how Anthropic's API wants a request shaped, which is equally true
// whether the bytes are sent by raw `fetch` or by `ChatAnthropic`. It moved rather than
// died because this adapter is now its only caller.
/**
 * The reply room for a NON-STREAMED Anthropic call that named none.
 *
 * Not an editorial choice, a protocol one: the Anthropic SDK refuses a non-streaming
 * request whose `max_tokens` implies a reply that could take longer than ten minutes
 * ("Streaming is required for operations that may take longer than 10 minutes"). So the
 * model's real ceiling — 128,000 on `claude-sonnet-5` — cannot be sent here at all, and a
 * bounded default is the only legal answer.
 *
 * Every FramePilot caller on this path is a short structured reply: the command classifier
 * returns a few dozen tokens, `caption-emphasis` and `vision-judge` name their own smaller
 * figures. A streamed call has no such limit and gets the ceiling.
 */
const UNSTREAMED_MAX_TOKENS = 8_192;

/**
 * Honor a caller's requested reply room, clamped to what the selected model actually
 * accepts — Anthropic rejects a `max_tokens` above the model's ceiling, so an over-ask must
 * become the ceiling rather than a failed request.
 *
 * ## Why "no request" is answered differently on the two paths
 *
 * Anthropic's API REQUIRES `max_tokens`, so unlike the OpenAI-compatible path there is no
 * option to send nothing and let the model decide: whatever this returns is a hard cut-off.
 *
 * It used to return a hardcoded 2,048 on both paths. That is an invented limit with no
 * relation to the model selected — `claude-sonnet-5` accepts 128,000 — so a streamed agent
 * turn that did not name a figure was cut at 2,048, which is the same defect `outputRoomFor`
 * was fixed for one layer down. A streamed call now gets the model's own ceiling.
 *
 * A non-streamed one cannot: see {@link UNSTREAMED_MAX_TOKENS}. The asymmetry is the SDK's,
 * not ours, and it is why this takes `streaming` rather than deciding from the model alone.
 */
export function resolveMaxTokens(
  model: string,
  requested: number | undefined,
  streaming = true,
): number {
  // Two ceilings, and the SDK's applies to an explicit over-ask exactly as it applies to a
  // default: a non-streamed request carrying a large `max_tokens` is REFUSED, so honouring
  // it as asked would turn a truncated reply into no reply at all. Clamping is the same
  // trade this function already makes for a figure above the model's own ceiling.
  const ceiling = Math.min(
    capabilitiesFor('anthropic', model).maxOutputTokens,
    streaming ? Number.POSITIVE_INFINITY : UNSTREAMED_MAX_TOKENS,
  );
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}

/** The Anthropic prompt-cache breakpoint marker, shared by every adapter. */
export const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;

/** How a request's messages divide into Anthropic's system field and message list. */
export interface AnthropicMessageSplit {
  /** The joined system text (Anthropic takes it top-level, not as a message). */
  readonly system: string;
  readonly nonSystem: readonly AiMessage[];
  /**
   * Index into {@link nonSystem} of the message carrying the second cache
   * breakpoint, or `-1` when the caller flagged none.
   */
  readonly boundaryIndex: number;
}

/**
 * Split a request's messages the way the Messages API needs them, and locate the
 * prompt-cache boundary.
 *
 * Exported so `providers/langchain.ts` derives the SAME split rather than
 * reimplementing it. Cache-breakpoint placement is the highest-cost thing to get
 * subtly wrong (risk 3 in plan/LANGCHAIN-MIGRATION.md — a mis-placed breakpoint
 * multiplies cost per turn with no functional symptom), so the two adapters share
 * one implementation instead of two that merely look alike.
 *
 * The LAST message flagged `cacheBoundary` wins: a breakpoint caches everything
 * before it, so marking an earlier one too would spend a breakpoint on a shorter
 * prefix.
 */
export function splitAnthropicMessages(messages: readonly AiMessage[]): AnthropicMessageSplit {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const boundaryIndex = nonSystem.reduce(
    (last, message, index) => (message.cacheBoundary ? index : last),
    -1,
  );
  return { system, nonSystem, boundaryIndex };
}

// The response-handling half of this adapter now lives in `langchain-chat.ts`, shared
// with every other LangChain provider (M2). Re-exported here because the M1 parity
// test and its callers already import them from this module, and moving a proven
// helper should not also move its import path.
export {
  mergeUsage,
  textAndReasoning,
  usageFromMetadata,
  type LangChainUsageMetadata,
} from './langchain-chat.js';

/**
 * Convert one FramePilot message to a LangChain message, block-shaping it when it
 * carries the cache breakpoint.
 *
 * The breakpoint has to sit on a *block*, so the boundary message is always
 * block-shaped — exactly as the native adapter does it. Everything else goes
 * through the shared {@link anthropicContent} serializer, which returns a plain
 * string unless the message carries images.
 */
function toLangChainMessage(message: AiMessage, isBoundary: boolean): BaseMessage {
  const content = isBoundary
    ? [{ type: 'text' as const, text: message.content, cache_control: ANTHROPIC_CACHE_CONTROL }]
    : anthropicContent(message);
  // `anthropicContent` returns our own block type; LangChain accepts the same
  // Anthropic block shape, so this is a structural pass-through, not a re-encode.
  const payload = content as unknown as string;
  return message.role === 'assistant' ? new AIMessage(payload) : new HumanMessage(payload);
}

/**
 * Build the LangChain message list for a request, including both cache
 * breakpoints. Exported for the parity test, which needs the same inputs the
 * provider will actually send.
 */
export function toLangChainMessages(request: AiCompletionRequest): BaseMessage[] {
  const { system, nonSystem, boundaryIndex } = splitAnthropicMessages(request.messages);
  const messages: BaseMessage[] = [];
  if (system) {
    const hasTools = !!(request.tools && request.tools.length > 0);
    // Breakpoint #1. A breakpoint caches the whole prefix before it in Anthropic's
    // canonical order (tools -> system -> messages), so one on `system` also caches
    // the tools. Without tools there is no prefix worth a breakpoint, and the native
    // adapter sends a bare string there — matched here so the bodies agree.
    messages.push(
      new SystemMessage(
        hasTools
          ? ([
              { type: 'text', text: system, cache_control: ANTHROPIC_CACHE_CONTROL },
            ] as unknown as string)
          : system,
      ),
    );
  }
  for (const [index, message] of nonSystem.entries()) {
    // Breakpoint #2 — the run-stable agent prefix.
    messages.push(toLangChainMessage(message, index === boundaryIndex));
  }
  return messages;
}

/** The `ChatAnthropic` constructor options for one request. */
export interface ChatAnthropicOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens: number;
  readonly streaming: boolean;
  readonly streamUsage: boolean;
  readonly maxRetries: number;
  readonly temperature?: number;
  readonly anthropicApiUrl?: string;
  readonly clientOptions?: { readonly fetch: typeof fetch };
}

/**
 * Map FramePilot's provider config + request onto `ChatAnthropic` options.
 *
 * Extracted and exported because these few fields ARE the contract with
 * LangChain, and two of them are load-bearing in ways that are invisible at the
 * call site: `maxRetries: 0` keeps `resilient-provider.ts` the single retry
 * authority (two retry layers means duplicate tool invocations — risk 4), and
 * `streamUsage: true` is what makes cost and prompt-cache hit rate measurable on
 * streamed turns, which is every turn of a real agent run. A pure function lets
 * both be asserted directly rather than inferred from behavior.
 */
export function chatOptions(
  config: ProviderConfig,
  request: AiCompletionRequest,
  streaming: boolean,
  fetchImpl?: FetchLike,
): ChatAnthropicOptions {
  const model = config.model ?? ANTHROPIC_DEFAULT_MODEL;
  return {
    model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    maxTokens: resolveMaxTokens(model, request.maxTokens, streaming),
    streaming,
    ...SHARED_CHAT_OPTIONS,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(config.baseUrl !== undefined ? { anthropicApiUrl: config.baseUrl } : {}),
    ...(fetchImpl !== undefined
      ? { clientOptions: { fetch: fetchImpl as unknown as typeof fetch } }
      : {}),
  };
}

/**
 * An {@link AiProvider} backed by LangChain's `ChatAnthropic`.
 *
 * Everything about handling the response is inherited from
 * {@link LangChainChatProvider}. What stays here is the part no other provider has:
 * the two `cache_control` breakpoints, and the `max_tokens` clamp they are budgeted
 * against.
 */
export class LangChainAnthropicProvider extends LangChainChatProvider {
  public readonly name = 'anthropic' as const;

  public get modelId(): string {
    return this.config.model ?? ANTHROPIC_DEFAULT_MODEL;
  }

  public constructor(
    config: ProviderConfig,
    /**
     * Injectable `fetch`, forwarded into the Anthropic client. Present for the
     * same reason the native adapter takes one: request building and response
     * parsing stay unit-testable with no network, and the parity test can capture
     * the real outgoing body rather than a reconstruction of it.
     */
    private readonly fetchImpl?: FetchLike,
  ) {
    super(config);
  }

  protected buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel {
    const options = chatOptions(this.config, request, streaming, this.fetchImpl);
    assertSingleRetryAuthority(options);
    return new ChatAnthropic(options) as unknown as BaseChatModel;
  }

  protected buildMessages(request: AiCompletionRequest): BaseMessage[] {
    return toLangChainMessages(request);
  }
}
