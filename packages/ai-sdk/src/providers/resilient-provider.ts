/**
 * @framepilot/ai-sdk/providers/resilient-provider — the one place resilience lives
 * (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1, ADR 0035).
 *
 * `ResilientProvider` decorates ANY {@link AiProvider} so the concrete providers stay
 * dumb and every surface (browser, desktop hub, MCP) inherits the same policy by
 * construction (invariant 6). It adds:
 *
 * - **retry + backoff** on retryable {@link ProviderError}s (`complete()` fully;
 *   `stream()` only *before the first chunk* — a half-streamed turn can't be safely
 *   replayed, so a mid-stream drop surfaces as a typed retryable error the loop re-runs);
 * - **connect + idle timeouts** independent of the desktop hub's max-run cap;
 * - **usage capture** (`usage` chunks are consumed here, reported, and not forwarded);
 * - **retry/usage reporting** to an injected callback for the `TurnTracer`.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  withConnectTimeout,
  timeoutError,
  IdleTimeout,
  DEFAULT_TIMEOUTS,
  type TimeoutConfig,
} from '../reliability/timeout.js';
import { withRetry } from '../reliability/retry.js';
import { combineSignals } from '../reliability/signals.js';
import {
  DEFAULT_RETRY_POLICY,
  ProviderError,
  type RetryPolicy,
  type Usage,
} from '../reliability/types.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ProviderName,
} from './types.js';

const log = createLogger('ai-sdk:providers:resilient-provider');

export interface ResilientProviderHooks {
  /** Called once per backoff wait, for tracing retry counts. */
  readonly onRetry?: (attempt: number) => void;
  /** Called when the provider reports token usage. */
  readonly onUsage?: (usage: Usage) => void;
  /** Called when a connect/idle timeout aborts the stream. */
  readonly onTimeout?: () => void;
}

export interface ResilientProviderOptions {
  readonly policy?: RetryPolicy;
  readonly timeouts?: TimeoutConfig;
  readonly hooks?: ResilientProviderHooks;
}

export class ResilientProvider implements AiProvider {
  public readonly name: ProviderName;

  private readonly policy: RetryPolicy;
  private readonly timeouts: TimeoutConfig;
  private readonly hooks: ResilientProviderHooks;

  /**
   * Delegated, not copied: the wrapper must report the model the inner provider will
   * actually send, or the context meter sizes against the wrong window. A getter (rather
   * than a constructor copy) also survives an inner provider that resolves its model
   * lazily.
   */
  public get modelId(): string | undefined {
    return this.inner.modelId;
  }

  public constructor(
    private readonly inner: AiProvider,
    options: ResilientProviderOptions = {},
  ) {
    this.name = inner.name;
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
    this.hooks = options.hooks ?? {};
  }

  /**
   * Non-streaming completion: fully retried with backoff + connect timeout. The
   * optional `signal` is forwarded to the inner provider (so an abort cancels the
   * upstream fetch, not just the caller's await) and to the retry loop (so a
   * cancelled run stops retrying instead of burning attempts in the background).
   *
   * The timeout ABORTS the request rather than only racing it. `withConnectTimeout`
   * alone is a `Promise.race`: the losing promise keeps running, so a timed-out
   * completion left its fetch in flight and `withRetry` started another — up to three
   * concurrent, separately billed calls to the same model for one logical request. That
   * was survivable only while `connectMs` was 0 and the race never fired; arming a real
   * budget made it live. Combining the caller's signal with a timeout-driven one is the
   * same shape `stream()` already uses for its idle watchdog just below.
   */
  public async complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiResponse> {
    return withRetry(
      async () => {
        const budget = this.timeouts.connectMs;
        if (budget <= 0) return await this.inner.complete(request, signal);
        const deadline = new AbortController();
        const combined = combineSignals(signal, deadline.signal);
        const handle = setTimeout(() => {
          deadline.abort(timeoutError('connect', budget));
        }, budget);
        try {
          // Still raced, so the rejection is the typed, RETRYABLE timeout error the
          // caller expects — an aborted fetch rejects with whatever the transport
          // chooses, which is not a contract this layer can rely on.
          return await withConnectTimeout(
            this.inner.complete(request, combined.signal),
            budget,
            'connect',
          );
        } finally {
          clearTimeout(handle);
          combined.dispose();
        }
      },
      {
        policy: this.policy,
        ...(signal ? { signal } : {}),
        onRetry: (attempt) => {
          log.warn('complete → retrying after failure', { provider: this.name, attempt });
          this.hooks.onRetry?.(attempt);
        },
      },
    );
  }

  /**
   * Streaming completion. Retries the *whole* stream only until the first chunk is
   * emitted; after that, a drop is surfaced as a retryable {@link ProviderError} so
   * the caller re-runs the turn (no duplicate deltas). An idle timeout, reset on each
   * chunk, guards against a silent stall.
   */
  public async *stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    // Already cancelled before we start: end cleanly so the orchestrator emits
    // `cancelled` (it inspects the aborted signal), matching the raw providers.
    if (signal?.aborted) return;
    if (!this.inner.stream) {
      // No native streaming: drain complete() as a single done chunk.
      const response = await this.complete(request, signal);
      for (const call of response.toolCalls ?? []) yield { type: 'tool-call', call };
      yield { type: 'done', text: response.text };
      return;
    }

    // Retry the *connection* until the first forwardable chunk: withRetry can't wrap
    // a generator, so we open the stream and pull chunks until the first non-usage
    // one (or done). Usage seen while priming is buffered, so a failed connection never
    // leaks telemetry from an attempt that will be retried. A failure before the first
    // content chunk is safely retryable; once we
    // emit a chunk, a later drop surfaces as a typed retryable error (no replay).
    let iterator: AsyncIterator<ProviderChunk> | undefined;
    try {
      const primed = await withRetry(async () => this.openAndPrime(request, signal), {
        policy: this.policy,
        ...(signal ? { signal } : {}),
        onRetry: (attempt) => {
          log.warn('stream → retrying before first chunk', { provider: this.name, attempt });
          this.hooks.onRetry?.(attempt);
        },
      });
      iterator = primed.iterator;
      for (const usage of primed.earlyUsage) {
        this.hooks.onUsage?.(usage);
        yield { type: 'usage', usage };
      }
      if (!primed.first.done) yield primed.first.value;
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;
        if (value.type === 'usage') {
          log.action('stream → usage reported', { provider: this.name, usage: value.usage });
          this.hooks.onUsage?.(value.usage);
          yield value;
          continue;
        }
        yield value;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // A caller-abort ends the stream cleanly — the orchestrator detects the
        // aborted signal and emits `cancelled` (matching the raw providers). Any
        // other AbortError propagates unwrapped.
        if (signal?.aborted) {
          log.action('stream → cancelled by caller abort', { provider: this.name });
          return;
        }
        throw error;
      }
      log.error('stream → failed after retries', { provider: this.name, error: String(error) });
      throw error instanceof ProviderError
        ? error
        : new ProviderError(error instanceof Error ? error.message : String(error), 'network');
    } finally {
      await iterator?.return?.(undefined);
    }
  }

  /**
   * Open the underlying stream and pull chunks until the first *forwardable* chunk
   * (non-usage) or a clean end. Usage chunks arriving before content are reported
   * here (Anthropic's `message_start` carries input usage early). Any throw during
   * priming is retryable because nothing has been emitted downstream yet.
   */
  private async openAndPrime(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): Promise<{
    iterator: AsyncIterator<ProviderChunk>;
    first: IteratorResult<ProviderChunk>;
    earlyUsage: readonly Usage[];
  }> {
    const iterator = await this.openStream(request, signal);
    const earlyUsage: Usage[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) return { iterator, first: result, earlyUsage };
      if (result.value.type === 'usage') {
        log.action('stream → early usage reported', {
          provider: this.name,
          usage: result.value.usage,
        });
        earlyUsage.push(result.value.usage);
        continue;
      }
      return { iterator, first: result, earlyUsage };
    }
  }

  /**
   * Open the underlying stream and return an iterator wrapped with an idle-timeout
   * heartbeat. The `.next()` here awaits each chunk under the idle timeout.
   */
  private async openStream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): Promise<AsyncIterator<ProviderChunk>> {
    const idle = new IdleTimeout(this.timeouts.idleMs, () => {
      log.warn('stream → idle timeout fired', {
        provider: this.name,
        idleMs: this.timeouts.idleMs,
      });
      this.hooks.onTimeout?.();
    });
    const combined = combineSignals(signal, idle.controller.signal);
    const source = this.inner.stream!(request, combined.signal)[Symbol.asyncIterator]();

    const wrapped: AsyncIterator<ProviderChunk> = {
      next: async () => {
        idle.beat();
        try {
          const result = await withConnectTimeout(source.next(), this.timeouts.idleMs, 'idle');
          if (result.done) {
            idle.stop();
            combined.dispose();
          }
          return result;
        } catch (error) {
          idle.stop();
          combined.dispose();
          // The idle watchdog aborts its own controller, which rejects the in-flight
          // SSE read with a RAW AbortError ("The operation was aborted"). That is a
          // timeout, not a cancellation: convert it to the same typed retryable
          // ProviderError the `withConnectTimeout` race above produces, so whichever
          // of the two fires first the caller sees one consistent, retryable idle
          // timeout — never the bare DOMException message. A CALLER abort (Stop
          // button / window closed) is left untouched so it still ends the stream
          // cleanly as a cancellation.
          if (
            error instanceof Error &&
            error.name === 'AbortError' &&
            idle.controller.signal.aborted &&
            !signal?.aborted
          ) {
            throw timeoutError('idle', this.timeouts.idleMs);
          }
          throw error;
        }
      },
      return: async (value) => {
        idle.stop();
        combined.dispose();
        return source.return ? source.return(value) : { done: true, value };
      },
    };
    return wrapped;
  }
}

/** Wrap a provider so it inherits the shared reliability policy. Idempotent-ish. */
export function withResilience(
  inner: AiProvider,
  options?: ResilientProviderOptions,
): ResilientProvider {
  return new ResilientProvider(inner, options);
}
