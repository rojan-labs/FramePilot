/**
 * @framepilot/ai-sdk/reliability/retry — pure bounded retry with exponential
 * backoff + jitter (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1, ADR 0035).
 *
 * Applied at the provider core (see {@link ../providers/resilient-provider}) so all
 * three surfaces (browser, desktop hub, MCP) inherit one retry policy. Never retries
 * a non-retryable {@link ProviderError} (auth/bad_request) and aborts immediately on
 * the supplied signal.
 */
import { DEFAULT_RETRY_POLICY, ProviderError, isProviderError, type RetryPolicy } from './types.js';

/** Injectable sleep so tests are deterministic and abort-aware. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Real timer sleep that rejects promptly if the signal aborts mid-wait. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/** True for a genuine user/host abort (never wrapped into a retry). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Compute the backoff delay for a given attempt (0-indexed retry number). Honors an
 * explicit `retryAfterMs` from the server (429/`Retry-After`); otherwise exponential
 * `base * 2^attempt`, capped at `maxDelayMs`, then ±jitter.
 *
 * @param attempt - Zero-indexed retry attempt (0 = first backoff).
 * @param policy - The retry policy.
 * @param retryAfterMs - Server-specified minimum wait, if any.
 * @param rand - Injectable RNG in [0,1) for deterministic tests.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  rand: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs;
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Symmetric jitter: delay * (1 + jitter*(2*rand-1)), clamped to >= 0.
  const jittered = capped * (1 + policy.jitter * (2 * rand() - 1));
  return Math.max(0, Math.round(jittered));
}

export interface WithRetryOptions {
  readonly policy?: RetryPolicy;
  readonly signal?: AbortSignal;
  readonly sleep?: Sleep;
  readonly rand?: () => number;
  /** Called before each backoff wait (for tracing retry counts). */
  readonly onRetry?: (attempt: number, error: ProviderError, delayMs: number) => void;
}

/**
 * Run `fn`, retrying on retryable {@link ProviderError}s with backoff. Resolves with
 * `fn`'s value on first success; rejects with the last `ProviderError` once attempts
 * are exhausted, immediately for a non-retryable error, and immediately (with the
 * abort error) if the signal fires.
 *
 * @param fn - The attempt; receives the 1-indexed attempt number.
 * @param options - Policy, abort signal, and injectable sleep/rand for tests.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? realSleep;
  const rand = options.rand ?? Math.random;

  const toProviderError = (error: unknown): ProviderError =>
    isProviderError(error)
      ? error
      : new ProviderError(error instanceof Error ? error.message : String(error), 'network');

  // Attempts 1..N-1 may fail and retry; the final attempt (N) runs outside the loop
  // so its result/throw is the function's own return/throw — no unreachable branch.
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (error) {
      if (isAbort(error)) throw error;
      const providerError = toProviderError(error);
      if (!providerError.retryable) throw providerError;
      const delay = backoffDelayMs(attempt - 1, policy, providerError.retryAfterMs, rand);
      options.onRetry?.(attempt, providerError, delay);
      await sleep(delay, options.signal);
    }
  }

  // Final attempt: no retry follows, so its outcome is final.
  if (options.signal?.aborted) throw abortError();
  try {
    return await fn(policy.maxAttempts);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw toProviderError(error);
  }
}
