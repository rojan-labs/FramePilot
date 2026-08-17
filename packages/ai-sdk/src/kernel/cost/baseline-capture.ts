/**
 * @framepilot/ai-sdk/kernel/cost/baseline-capture — the M0.1 measuring rig
 * (plan/LANGCHAIN-MIGRATION.md M0.1).
 *
 * `run-metrics.ts` aggregates {@link TurnSample}s into the baseline. This module is what
 * *produces* them from a real run: an {@link AiProvider} decorator that times every model
 * call and records what it actually cost.
 *
 * ## Why a provider decorator, and not the event stream
 *
 * The run-level `usage` event fires once, at settle, with the run's total. M0.1 asks for
 * **per-turn** p50/p95 TTFT, wall time, tokens and cache-hit rate — which only exist at
 * the model-call boundary. Sitting at the provider seam also means the same rig measures
 * the native and the LangChain adapters identically, which is the whole point: a
 * comparison is only meaningful if both sides were measured the same way.
 *
 * ## What "TTFT" means here, precisely
 *
 * Milliseconds from `stream()` being called to the **first content chunk** —
 * `text-delta` or `reasoning-delta`. Not the first chunk of any kind: a `usage` chunk
 * arrives early on Anthropic (`message_start`) and counting it would report a TTFT that
 * no user ever experienced. A non-streaming `complete()` has no first-token moment at
 * all, so TTFT is recorded equal to wall time and the sample is marked, rather than
 * being silently mixed in with streamed turns.
 *
 * ## Honesty rules this rig keeps
 *
 * - A provider that reports no usage yields a sample with zero tokens and **no** `usd`,
 *   rather than a fabricated price.
 * - Cache counts stay `undefined` when unreported. `run-metrics.ts` excludes those from
 *   the hit-rate denominator, so a provider gap can never masquerade as a 0% hit rate a
 *   later phase then "matches".
 * - Pricing is optional and explicit. Without a price table the samples carry tokens and
 *   timings only.
 * - Provider capabilities are preserved exactly. Wrapping a completion-only provider
 *   must not manufacture a `stream()` capability and silently change orchestrator flow.
 */
import type { ModelTier } from '../proposers/types.js';
import { DEFAULT_TIER_PRICING, estimateUsd, type TierPrice } from './cost-meter.js';
import type { TurnSample } from './run-metrics.js';
import type { Usage } from '../../reliability/types.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ProviderName,
} from '../../providers/types.js';

/** One measured model call, with the context needed to interpret it. */
export interface CapturedTurn extends TurnSample {
  /** Which provider served it — so a mixed-provider run stays separable. */
  readonly provider: ProviderName;
  /** The model actually sent, after config and defaults resolved. */
  readonly modelId: string | undefined;
  /**
   * False when the call went through `complete()`, which has no first-token moment.
   * Those samples carry `ttftMs === wallMs`; averaging them with streamed turns without
   * knowing that would understate real time-to-first-token.
   */
  readonly streamed: boolean;
}

export interface BaselineCaptureOptions {
  /** Injected clock, so the rig is testable without real time passing. */
  readonly now?: () => number;
  /**
   * Price table for turning tokens into USD. Omit to record tokens only — an
   * unpriced baseline is honest; an invented one silently sets a false budget.
   */
  readonly prices?: Readonly<Record<ModelTier, TierPrice>>;
  /** Tier to price at. Defaults to `mid`, matching the agent loop's own calls. */
  readonly tier?: ModelTier;
}

type ProviderStream = NonNullable<AiProvider['stream']>;

/**
 * Wrap a provider so every model call it serves is measured.
 *
 * The decorator is transparent: provider capabilities, chunks, order, errors and aborts
 * are preserved. A cancelled turn still records the partial timing it actually produced.
 */
export class BaselineCaptureProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly stream?: ProviderStream;

  private readonly samples: CapturedTurn[] = [];
  private readonly now: () => number;

  public get modelId(): string | undefined {
    return this.inner.modelId;
  }

  public constructor(
    private readonly inner: AiProvider,
    private readonly options: BaselineCaptureOptions = {},
  ) {
    this.name = inner.name;
    this.now = options.now ?? (() => Date.now());

    // `AiProvider.stream` is intentionally optional. Exposing a stream function when the
    // wrapped provider has none makes the orchestrator select a different transport path,
    // which means the measuring rig changes the behavior it is supposed to observe.
    if (inner.stream !== undefined) {
      const innerStream = inner.stream.bind(inner);
      this.stream = (request, signal) => this.captureStream(innerStream, request, signal);
    }
  }

  /** Every call measured so far, in call order. */
  public captured(): readonly CapturedTurn[] {
    return [...this.samples];
  }

  public async complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiResponse> {
    const started = this.now();
    try {
      const response = await this.inner.complete(request, signal);
      const wallMs = this.now() - started;
      // No first-token moment on a non-streaming call: TTFT is wall time, and `streamed`
      // records that so the two are never conflated in analysis.
      this.record({ ttftMs: wallMs, wallMs, streamed: false, usage: response.usage });
      return response;
    } catch (error) {
      const ended = this.now();
      this.record({
        ttftMs: ended - started,
        wallMs: ended - started,
        streamed: false,
        usage: undefined,
      });
      throw error;
    }
  }

  private async *captureStream(
    innerStream: ProviderStream,
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const started = this.now();
    let firstContentAt: number | undefined;
    let usage: Usage | undefined;

    try {
      for await (const chunk of innerStream(request, signal)) {
        if (
          firstContentAt === undefined &&
          (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        ) {
          // Deliberately not the first chunk of ANY kind: Anthropic sends usage on
          // `message_start`, and counting that would report a TTFT nobody experienced.
          firstContentAt = this.now();
        }
        if (chunk.type === 'usage') usage = chunk.usage;
        yield chunk;
      }
    } finally {
      const ended = this.now();
      this.record({
        ttftMs: (firstContentAt ?? ended) - started,
        wallMs: ended - started,
        streamed: true,
        usage,
      });
    }
  }

  private record(input: {
    ttftMs: number;
    wallMs: number;
    streamed: boolean;
    // `complete()` reports only input/output; a stream additionally reports cache
    // counts. One widened shape rather than two record paths, so the honesty rules
    // below are written once.
    usage:
      | (Partial<Usage> & { readonly inputTokens?: number; readonly outputTokens?: number })
      | undefined;
  }): void {
    const inputTokens = input.usage?.inputTokens ?? 0;
    const outputTokens = input.usage?.outputTokens ?? 0;
    const prices = this.options.prices;
    // No price table means no dollar figure — not a zero. A fabricated $0 would set a
    // budget every later phase could "meet" by spending anything at all.
    const usd =
      prices === undefined
        ? undefined
        : estimateUsd(
            this.options.tier ?? 'mid',
            { input: inputTokens, output: outputTokens },
            prices,
          );

    this.samples.push({
      provider: this.name,
      modelId: this.inner.modelId,
      streamed: input.streamed,
      ttftMs: input.ttftMs,
      wallMs: input.wallMs,
      inputTokens,
      outputTokens,
      // Absent stays absent: `run-metrics.ts` excludes unreported cache counts from the
      // hit-rate denominator rather than counting them as misses.
      ...(input.usage?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: input.usage.cacheReadInputTokens }
        : {}),
      ...(input.usage?.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: input.usage.cacheCreationInputTokens }
        : {}),
      ...(usd !== undefined ? { usd } : {}),
    });
  }
}

/** The default price table, re-exported so a caller can price without a second import. */
export { DEFAULT_TIER_PRICING };