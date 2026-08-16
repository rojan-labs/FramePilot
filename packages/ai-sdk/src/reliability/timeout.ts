/**
 * @framepilot/ai-sdk/reliability/timeout — connect + idle timeouts for streaming
 * providers (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1, ADR 0035).
 *
 * The desktop hub's coarse max-run cap (30 minutes) can't tell "the model is thinking" from
 * "the socket is dead". These two independent timeouts fix that at the SDK core:
 *
 * - **connect timeout** — no response headers within N ms → abort as a timeout.
 * - **idle timeout** — no SSE chunk within N ms, reset on every chunk (a heartbeat)
 *   → abort as a timeout. This is why {@link ../providers/sse} calls `beat()` per chunk.
 *
 * Timers are injectable so the behavior is unit-testable without real waits.
 */
import { ProviderError } from './types.js';

/** The subset of timer functions we depend on (injectable for deterministic tests). */
export interface TimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TimerApi = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The error thrown/aborted-with when a timeout fires. `kind: 'network'`, retryable. */
export function timeoutError(label: string, ms: number): ProviderError {
  return new ProviderError(`${label} timed out after ${ms}ms`, 'network');
}

/**
 * A resettable idle watchdog backed by an {@link AbortController}. Fires `onTimeout`
 * and aborts the controller if `beat()` is not called within `ms`. Call `beat()` on
 * every stream chunk; call `stop()` when the stream ends.
 */
export class IdleTimeout {
  private handle: unknown = undefined;
  private stopped = false;
  public readonly controller = new AbortController();

  public constructor(
    private readonly ms: number,
    private readonly onTimeout: () => void,
    private readonly timers: TimerApi = realTimers,
  ) {}

  /** Start (or restart) the watchdog. Safe to call before the first chunk. */
  public beat(): void {
    if (this.stopped) return;
    // A non-positive budget disables the watchdog entirely (never arm it) — used to
    // remove the idle timeout so a long-running or slow-remote stream is never aborted
    // on time (only a user Stop or a real socket error ends it).
    if (this.ms <= 0) return;
    if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      if (this.stopped) return;
      this.stopped = true;
      this.onTimeout();
      this.controller.abort();
    }, this.ms);
  }

  /** Stop the watchdog for good (stream ended cleanly or errored elsewhere). */
  public stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}

/**
 * Race a promise against a connect timeout. Resolves with the promise's value if it
 * settles first; rejects with a {@link timeoutError} if `ms` elapses first. Used to
 * bound the wait for response *headers* (distinct from the idle chunk timeout).
 *
 * @param promise - The in-flight fetch.
 * @param ms - Connect budget in milliseconds (0/undefined disables the timeout).
 * @param label - Human label for the timeout message.
 * @param timers - Injectable timer API for tests.
 */
export async function withConnectTimeout<T>(
  promise: Promise<T>,
  ms: number | undefined,
  label = 'connect',
  timers: TimerApi = realTimers,
): Promise<T> {
  if (!ms || ms <= 0) return promise;
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = timers.setTimeout(() => reject(timeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) timers.clearTimeout(handle);
  }
}

/** Timeout budgets for {@link ../providers/resilient-provider}. Zero disables. */
export interface TimeoutConfig {
  readonly connectMs: number;
  readonly idleMs: number;
}

/**
 * Default: **no time thresholds** (both disabled). A run is bounded by the model,
 * the transport, and the user's Stop button — never by a clock. This was a
 * deliberate product decision: agent work against a slow or remote backend (e.g. a
 * self-hosted Ollama reached over an ngrok tunnel, or a large local model that loads
 * cold) can legitimately take many minutes to first byte and run for over an hour, so
 * any fixed connect/idle budget aborts healthy work. `0` disables each timeout
 * (`withConnectTimeout` returns the promise unbounded; {@link IdleTimeout.beat} never
 * arms). A genuinely dead socket surfaces as a transport error, and Stop always cancels.
 *
 * Callers that DO want a bound can still pass an explicit {@link TimeoutConfig} to the
 * {@link ../providers/resilient-provider}.
 */
export const DEFAULT_TIMEOUTS: TimeoutConfig = { connectMs: 0, idleMs: 0 };
