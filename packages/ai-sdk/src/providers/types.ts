/**
 * @framepilot/ai-sdk/providers/types — unified AI provider interface.
 *
 * All providers (Anthropic, NVIDIA, mock) implement {@link AiProvider} so the
 * orchestrator is provider-agnostic (PRD §8.1). See plan/PLAN.md Phase 4.1.
 *
 * ## Why providers return tool calls, never patches
 *
 * AGENTS.md invariant 5: the AI edits ONLY through registered, schema-validated
 * tools and never produces a raw timeline mutation. A provider therefore returns
 * {@link ToolCall}s (a tool name + opaque JSON args). The orchestrator is the
 * sole component that turns tool calls into a {@link Patch}: it validates each
 * call's args against the tool's schema and runs the tool handler. A provider can
 * never hand back a ready-made patch, so a misbehaving model cannot bypass the
 * tool boundary.
 */

import type { Usage } from '../reliability/types.js';

/**
 * Every provider the SDK can construct. A runtime tuple (not just a type) so config
 * resolvers can validate an untrusted env/settings string against the real roster —
 * {@link ProviderName} is derived from it, so the two can never drift.
 */
export const PROVIDER_NAMES = [
  'anthropic',
  'nvidia',
  'openrouter',
  'vercel-gateway',
  'groq',
  'google',
  'ollama',
  'deepseek',
  // Any server speaking OpenAI's `/chat/completions` contract: a self-hosted gateway
  // (vLLM, LM Studio, llama.cpp, LiteLLM) or a local proxy. It is the only provider with
  // NO default endpoint — the host's URL is the whole configuration — which is why it
  // cannot be folded into one of the named OpenAI-compatible providers above. Each of
  // those owns a single `baseUrl` slot pointed at its own service; borrowing one would
  // make that service unusable and label a localhost gateway "OpenRouter" in Settings.
  'openai-compatible',
  'mock',
] as const;

/** Identifier for the configured provider. */
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Narrow an untrusted string to a {@link ProviderName} (config/settings validation). */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export type AiRole = 'system' | 'user' | 'assistant' | 'tool';

/** Image media types every vision-capable provider in this SDK accepts. */
export type AiImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * A still image attached to a message, as raw bytes the SDK carries itself.
 *
 * Base64 rather than a URL on purpose: the images this SDK sends are frames rendered from
 * the user's own local media (see the `get_frame` tool). There is no public URL for them,
 * and inventing one would mean uploading a creator's footage somewhere to show the model
 * a single frame. The bytes go directly in the request and nowhere else.
 */
export interface AiImage {
  readonly mediaType: AiImageMediaType;
  /** The image bytes, base64-encoded, WITHOUT a `data:` prefix. */
  readonly base64: string;
  /**
   * What the image is of, in one line — e.g. "the timeline at 12.40s". Providers that
   * take a caption alongside the image do not exist here, so this is used to label the
   * image in the message's own text, which is what actually tells the model what it is
   * looking at when several frames arrive at once.
   */
  readonly label?: string;
}

export interface AiMessage {
  readonly role: AiRole;
  readonly content: string;
  /**
   * Images to send alongside `content`. A provider that cannot accept images ignores
   * them and sends the text alone — the text always describes what the images showed, so
   * a text-only model degrades to a worse answer, never a broken request.
   *
   * Never set on a `system` message: no provider here accepts image content in a system
   * prompt, and the SDK only ever attaches images to `user` messages.
   */
  readonly images?: readonly AiImage[];
  /**
   * Marks the end of the run-STABLE prompt prefix, so a provider that supports prompt
   * caching can put its breakpoint here (see `anthropic.ts#buildBody`).
   *
   * Set by `orchestrator.ts#agentMessages` on the message carrying the agent contract,
   * the committed plan and the pinned skill playbooks — content that is byte-identical
   * on every turn of a run. Everything after it (the project snapshot, the state
   * briefing, the action log) changes turn to turn and must stay outside the cached
   * prefix.
   *
   * Advisory: providers without prompt caching ignore it, and a wrong value costs cache
   * efficiency, never correctness.
   */
  readonly cacheBoundary?: boolean;
}

/** Provider configuration resolved from environment variables. */
export interface ProviderConfig {
  readonly name: ProviderName;
  readonly apiKey?: string;
  readonly model?: string;
  /** OpenAI-compatible base URL (used by NVIDIA NIM). */
  readonly baseUrl?: string;
}

/** JSON-Schema shape advertised to the model for a single callable tool. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface AiCompletionRequest {
  readonly messages: readonly AiMessage[];
  /** Tools (from the tool registry) the model may call. */
  readonly tools?: readonly ToolDescriptor[];
  readonly temperature?: number;
  /**
   * Room this one call needs for its reply, in tokens. Omitted for conversational turns,
   * which are short by nature; set by a caller whose output length is a function of the
   * edit, not of taste.
   *
   * WHY: a structured proposal's size scales with the timeline. A 30-second montage cut on
   * every drum hit is ~60 `add_clip` calls with full-precision times — far past the 2,048
   * tokens the Anthropic adapter used to hardcode for every request, so the JSON ended
   * mid-object and came back as "model response was not valid JSON" with no hint that
   * truncation, not the model, was at fault. A provider clamps this to what its selected
   * model actually accepts; it is a request, never a promise.
   */
  readonly maxTokens?: number;
  /**
   * Ask the model to think before it answers, and to STREAM that thinking back.
   *
   * Reasoning is opt-in on every current wire format: an OpenAI-compatible endpoint
   * thinks only when the request carries `reasoning_effort`, and Anthropic only when it
   * carries a `thinking` block. Without it a reasoning model still reasons internally but
   * returns nothing to show, which is exactly how the editor ended up rendering a run of
   * "Thought for 6s" rows that could not be expanded — the rows were real, the thinking
   * behind them was never requested, so there was no text to put in them.
   *
   * Set by the orchestrator on the calls whose thinking the editor actually displays
   * (see `StreamSink.captureReasoning`), and left off everywhere else — a classifier or
   * repair call has nowhere to show thinking, so paying for it would be waste.
   *
   * Advisory, like {@link AiMessage.cacheBoundary}: a provider that cannot ask for
   * reasoning ignores it, and a model that rejects the parameter degrades to a plain
   * request rather than a failed run (see `openai-reasoning.ts`).
   */
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * How much thinking to ask for. Mirrors the `reasoning_effort` values every
 * OpenAI-compatible gateway accepts; Anthropic-style budgets are derived from it.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * A model's request to invoke one registered tool. `arguments` is untrusted JSON
 * — the orchestrator validates it against the tool's schema before use.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AiResponse {
  /** Free-text assistant content (chat/plan modes; rationale in edit mode). */
  readonly text: string;
  /** Tool calls the model requested, if any (edit/autocomplete modes). */
  readonly toolCalls?: readonly ToolCall[];
  /**
   * A reasoning model's chain-of-thought, separated from {@link AiResponse.text}
   * (a dedicated `reasoning_content`/`reasoning` field, or an inline `<think>` block
   * stripped out of `content`). Never part of the user-visible answer — the
   * orchestrator routes it to the reasoning panel. Absent for non-reasoning models.
   */
  readonly reasoning?: string;
  /**
   * Token usage the provider actually reported for this call (P7.1 cost wiring) —
   * present only when the response body carries real counts (e.g. Anthropic's
   * top-level `usage`, an OpenAI-compatible `usage.prompt_tokens`/`completion_tokens`,
   * Gemini's `usageMetadata`). Never fabricated: a provider that cannot read a real
   * count from its own response leaves this `undefined` rather than guessing.
   */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/**
 * One unit of a streamed provider response (Phase 11 M1, ADR 0033). A `stream()`
 * yields zero or more `text-delta`/`tool-call` chunks and a terminal `done` chunk
 * carrying the final canonical text. The orchestrator turns these into `AiEvent`s;
 * Anthropic and NVIDIA SSE both collapse onto this union, so the mock stays the
 * contract.
 */
export type ProviderChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  /**
   * A chunk of a reasoning model's chain-of-thought — its `reasoning_content`/
   * `reasoning` field or an inline `<think>` block peeled out of `content` (never
   * part of the visible answer). The orchestrator routes it to the reasoning panel;
   * the {@link ResilientProvider} forwards it unchanged like any content chunk.
   */
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  /**
   * Token usage reported mid/late stream (Anthropic `message_start`/`message_delta`,
   * OpenAI `usage`). The {@link ResilientProvider} consumes these for tracing and
   * does NOT forward them, so the orchestrator's chunk handling is unchanged (R1).
   */
  | { readonly type: 'usage'; readonly usage: Usage }
  /**
   * End of stream, carrying the final canonical text.
   *
   * `truncated` is the provider SAYING it stopped early — an OpenAI-compatible
   * `finish_reason: 'length'`, an Anthropic `stop_reason: 'max_tokens'`. It is the only
   * trustworthy signal that a reply is unfinished: prose alone cannot be judged (plenty of
   * complete answers are two words with no full stop), and a run that guesses either ends
   * on a fragment or retries a finished answer. Absent ⇒ the provider reported a normal
   * stop, or does not report one at all.
   */
  | { readonly type: 'done'; readonly text: string; readonly truncated?: boolean };

/**
 * The minimal subset of the global `fetch` the HTTP providers depend on. Kept as
 * a narrow injectable seam so request-building and response-parsing are unit-
 * testable without a network (and without `any`).
 *
 * `body` is an OPTIONAL Web-Streams readable (ADR 0033, Approval A3): `complete()`
 * uses `text()`; `stream()` reads `body` for incremental SSE. It is optional so the
 * existing non-streaming seam and every existing test stay valid unchanged.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** Request body; omitted for header-only requests (e.g. a GET token exchange). */
    body?: string;
    /**
     * Abort signal for streaming requests (ADR 0033 M3): passed into the underlying
     * `fetch` so an abort cancels the upstream call promptly, not only when the next
     * SSE byte arrives. Optional — `complete()` does not set it.
     */
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  readonly body?: ReadableStream<Uint8Array> | null;
  /**
   * Response headers, read for `Retry-After` on a 429 (R1 resilient transport).
   * Optional so existing test doubles that omit it stay valid; the real `fetch`
   * `Response` supplies it.
   */
  readonly headers?: { get(name: string): string | null };
}>;

/**
 * Provider contract. Depend on this abstraction, not on a concrete SDK.
 *
 * `stream()` is optional: a provider that implements it streams incrementally; the
 * orchestrator falls back to draining `complete()` for providers that do not
 * (ADR 0033). An `AbortSignal` cancels the upstream request mid-stream. `complete()`
 * takes the same optional signal so the orchestrator's non-streaming calls (agent
 * planning, the Critic repair pass) are cancellable too — without it those calls
 * kept running after the user pressed Stop.
 */
export interface AiProvider {
  readonly name: ProviderName;
  /**
   * The model id this instance will actually send, after the host's configuration and
   * the provider's own default have both been applied. Read by
   * `providers/model-capabilities.ts` so context occupancy is measured against the
   * selected model's real window instead of one global constant — switching model in
   * Settings must move the capacity shown in the composer.
   *
   * Optional so a test double or a future provider stays valid without it; an absent
   * value degrades to the provider's conservative floor, never to a wrong number.
   */
  readonly modelId?: string | undefined;
  complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiResponse>;
  stream?(request: AiCompletionRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
}
