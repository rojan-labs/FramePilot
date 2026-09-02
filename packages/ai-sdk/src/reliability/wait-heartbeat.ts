/**
 * @framepilot/ai-sdk/reliability/wait-heartbeat — "this run is waiting, and here is
 * how long for".
 *
 * WHY. Run `369e8c82` logged the context manifest for its twentieth model call at
 * 15:16:45 and emitted nothing else. The next thing that happened was at 15:55:33, when
 * the user force-quit the app: **thirty-nine minutes of an unmoving spinner**.
 * {@link ./deadline.ts} now bounds that — the run stops at the budget the editor set —
 * but a bound is not an explanation. With a 37-minute budget the user still watches 37
 * minutes of nothing before anything happens, and the reason they quit is that they had
 * no way to tell a thinking model from a dead socket.
 *
 * This is the missing signal, and it is deliberately the SMALLEST one that helps: while a
 * model call is in flight and no chunk has arrived for a while, say so, and keep saying it
 * with a growing number until the call answers or the run stops. It claims nothing about
 * what the run will do next and it is not an error — a slow model is not a failure.
 *
 * WHY A CHUNK RESETS IT. A streaming provider's deltas ARE progress: text is already
 * reaching the editor, so announcing a wait on top of it would be a lie. This is the same
 * heartbeat rule {@link ./timeout.ts IdleTimeout} applies one layer down — `beat()` on
 * every chunk — read here as "only true silence counts", so a call that streams steadily
 * for an hour announces nothing at all.
 *
 * Timers are injectable for the same reason the deadline's are: a stall cannot be tested
 * by waiting for one.
 */
import { realTimers, type TimerApi } from './timeout.js';

/**
 * How long a model call may stay silent before the run says it is waiting.
 *
 * Measured, not guessed. Every one of the twenty model calls in run `369e8c82` is
 * timestamped from its context manifest to its first assistant text, and the healthy ones
 * span 23s to 193s — the slowest legitimate call in the whole run took three minutes and
 * thirteen seconds. The twenty-first never answered.
 *
 * Four minutes sits above every healthy call in that run and far below the failure: no
 * call the run actually completed would have tripped this, and the one that hung would
 * have said "no reply for 4 minutes" at 15:20:45 — thirty-five minutes before the user
 * gave up on it. The headroom over 193s is deliberately modest rather than generous
 * because the cost of being early is one quiet line that disappears when the call lands,
 * while the cost of being late is what the captured run already shows.
 */
export const MODEL_WAIT_HEARTBEAT_MS = 240_000;

/** One step of a heartbeat-wrapped stream: something arrived, or nothing has for a while. */
export type WaitStep<T> =
  | { readonly kind: 'chunk'; readonly chunk: T }
  | {
      readonly kind: 'waiting';
      /**
       * How long the stream has been silent, as whole heartbeat intervals.
       *
       * Derived from the number of intervals that fired rather than from a clock, so the
       * number the user reads is exactly the timer that produced it — and so a test with a
       * hand-fired timer asserts the real wording rather than a wall-clock artifact.
       */
      readonly waitedMs: number;
    };

export interface WaitHeartbeatOptions {
  /** Silence budget between beats. **Non-positive arms nothing** (the explicit opt-out). */
  readonly intervalMs: number;
  /** Injectable timers (tests fire the beat by hand). Absent ⇒ real timers. */
  readonly timers?: TimerApi;
  /** The run's signal. Once it aborts, the run is unwinding and a beat would be noise. */
  readonly signal?: AbortSignal;
}

/** Resolved by the interval timer, distinguishable from any real iterator result. */
const TICK = Symbol('wait-heartbeat-tick');

/**
 * Race one outstanding `next()` against the silence budget, clearing the timer on every
 * exit — the pending result wins, the beat wins, or the source throws. At most one timer
 * is ever armed, so an abandoned wait can never leave a watchdog behind it.
 */
async function raceBeat<T>(
  pending: Promise<IteratorResult<T>>,
  intervalMs: number,
  timers: TimerApi,
): Promise<IteratorResult<T> | typeof TICK> {
  let handle: unknown;
  const beat = new Promise<typeof TICK>((resolve) => {
    handle = timers.setTimeout(() => {
      resolve(TICK);
    }, intervalMs);
  });
  try {
    return await Promise.race([pending, beat]);
  } finally {
    timers.clearTimeout(handle);
  }
}

/**
 * Wrap a provider chunk stream so long silences become visible steps.
 *
 * Yields `{ kind: 'chunk' }` for everything the source produces, in order and unchanged,
 * plus a `{ kind: 'waiting' }` step for every `intervalMs` that passes with the source
 * producing nothing. The silence counter resets on every chunk.
 *
 * @param source - The provider's chunk stream (or an effect runtime's model stream).
 * @param options - Silence budget, timers, and the run's signal.
 */
export async function* withWaitHeartbeat<T>(
  source: AsyncIterable<T>,
  { intervalMs, timers = realTimers, signal }: WaitHeartbeatOptions,
): AsyncGenerator<WaitStep<T>> {
  // The opt-out is a plain pass-through, so a caller that wants no heartbeat (chat, edit,
  // plan — none of which is the multi-call loop that hung) drains the source exactly as
  // `for await` did before this existed, with no timer and no extra promise in the path.
  if (intervalMs <= 0) {
    for await (const chunk of source) yield { kind: 'chunk', chunk };
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  /** The outstanding `next()`. Held across beats — a beat must never drop a chunk. */
  let pending: Promise<IteratorResult<T>> | undefined;
  let silentBeats = 0;
  try {
    for (;;) {
      pending ??= iterator.next();
      if (signal?.aborted) {
        // Stop or the deadline already fired: the run is on its way to reporting what it
        // applied, and "still waiting" during that would be noise about work nobody is
        // waiting for any more. Drop the clock entirely rather than beat in silence.
        const settled = await pending;
        pending = undefined;
        if (settled.done === true) return;
        silentBeats = 0;
        yield { kind: 'chunk', chunk: settled.value };
        continue;
      }
      const raced = await raceBeat(pending, intervalMs, timers);
      if (raced === TICK) {
        silentBeats += 1;
        yield { kind: 'waiting', waitedMs: silentBeats * intervalMs };
        continue;
      }
      pending = undefined;
      if (raced.done === true) return;
      // A chunk is progress: the wait starts over, and a steadily streaming call therefore
      // never reaches its first beat however long it runs.
      silentBeats = 0;
      yield { kind: 'chunk', chunk: raced.value };
    }
  } finally {
    // Mirror what `for await` did here: close the source when we stop draining it early.
    // NEVER await that close while a `next()` is still outstanding — an async iterator
    // queues `return()` behind the pending `next()`, so awaiting it on the very provider
    // that never answers would hang the unwind the deadline exists to guarantee. Run
    // `369e8c82`'s failure mode must not be reachable through its own fix.
    if (pending === undefined) await iterator.return?.();
    else void pending.catch(() => undefined);
  }
}

/** `4 minutes` / `1 minute` / `45 seconds` — whole units, never a decimal. */
function formatWaited(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.round(ms / 1000);
  return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}

/**
 * What the editor reads while a call is silent.
 *
 * Plain, and deliberately empty of promises: it says the AI has not answered and how long
 * that has been, and nothing about what happens next — because at this point the run does
 * not know either. It is not phrased as a failure, because a slow model is not one; the
 * only thing that escalates is the number.
 */
export function modelWaitLabel(waitedMs: number): string {
  return `Waiting on the AI — no reply for ${formatWaited(waitedMs)}`;
}
