/**
 * @framepilot/ai-sdk/reliability/timeout — connect + idle timeouts for streaming
 * providers (plan `AGENT-ORCHESTRATION-RELIABILITY.md` R1, ADR 0035).
 *
 * The desktop hub's coarse max-run cap can't tell "the model is thinking" from "the
 * socket is dead", which is why it is disabled (`AI_STREAM_TIMEOUT_MS = 0`) and the
 * bound lives HERE instead. These two independent timeouts are the only thing standing
 * between a dead socket and a run that never ends:
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
    // A non-positive budget disables the watchdog entirely (never arm it). This stays a
    // supported explicit opt-out for a caller that truly wants no clock, but it is NOT
    // the default any more — see {@link DEFAULT_TIMEOUTS} for why an unarmed watchdog
    // means a dead socket hangs the run forever.
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
 * Default timeout budgets. **Both are armed.** They were previously `0/0` (disabled),
 * which — combined with the desktop hub's own cap also being `0` — left an AI run with
 * no time bound at ANY layer: a socket that dies without an error (a laptop that sleeps
 * mid-stream, a tunnel that black-holes, a provider that accepts the request and never
 * writes) hung the run forever, with a spinner and no way out but Stop.
 *
 * WHY these values, and why they do NOT re-break the slow-local-model case that motivated
 * removing them:
 *
 * - **`idleMs` (10 min) is heartbeat-reset, not a run cap.** {@link IdleTimeout.beat} is
 *   called on every chunk, so a healthy stream — however slow, however long — is never
 *   aborted: only TEN MINUTES OF TOTAL SILENCE is. A self-hosted Ollama over an ngrok
 *   tunnel that emits a token a minute for two hours is fine; only one that has stopped
 *   emitting anything at all is not. The same budget also covers time-to-first-chunk,
 *   which is the one genuinely slow moment on a local backend (a large model loading
 *   cold), so it is sized for that rather than for steady-state streaming.
 * - **`connectMs` (15 min) is much larger because it bounds a WHOLE call, not a gap.**
 *   {@link withConnectTimeout} wraps the non-streaming `complete()` used by the agent's
 *   plan and repair steps, which has no chunks and therefore no heartbeat — the only
 *   thing it can measure is the total round trip. 15 minutes is far past any healthy
 *   completion while still being finite.
 * - **A false positive costs a reconnect, not a run.** {@link timeoutError} is a
 *   `kind: 'network'` ProviderError, which is RETRYABLE, so an over-eager timeout is
 *   retried by `withRetry` rather than failing the user's work.
 *
 * `0` still disables each timeout individually (`withConnectTimeout` returns the promise
 * unbounded; {@link IdleTimeout.beat} never arms) for a caller that explicitly wants no
 * clock. Callers can override the whole budget via the {@link ../providers/resilient-provider}.
 */
export const DEFAULT_TIMEOUTS: TimeoutConfig = { connectMs: 900_000, idleMs: 600_000 };
