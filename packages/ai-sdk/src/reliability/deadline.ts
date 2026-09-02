/**
 * @framepilot/ai-sdk/reliability/deadline — the wall-clock bound on ONE agent run,
 * armed on the step that is in flight.
 *
 * The third and outermost layer of the run's time bounds, and the only one that knows
 * what the user asked for:
 *
 * 1. {@link ./timeout.ts DEFAULT_TIMEOUTS} bounds a single provider call (connect + idle).
 * 2. {@link ../providers/resilient-provider} retries a bounded call up to
 *    {@link ./types.ts DEFAULT_RETRY_POLICY}`.maxAttempts` times.
 * 3. **This** bounds the whole run, at the number the editor typed into
 *    Settings → AI → Run budget.
 *
 * WHY the run needs its own clock even though (1) and (2) exist. Run `369e8c82` was given
 * 37 minutes. Its twentieth model call was logged at 15:16:45 and nothing was heard again
 * until 15:55:33, when the app closed and the run reported `failed` — 39 minutes of
 * silence, nine committed patches never mentioned, and a 37-minute limit that expired at
 * 15:24:11 without firing. The Conductor's budget check is read only on a TURN RESULT
 * (`kernel/conductor.ts`'s `advance`), so it bounds the gaps BETWEEN model calls and never
 * a call itself: three attempts at a fifteen-minute connect timeout is a 45-minute ceiling
 * that no run budget can see under.
 *
 * WHY this is not the coarse max-run cap that `apps/desktop/electron/ai/ai-stream.ts`
 * deliberately switched off. That objection — "a cap can't tell 'the model is thinking'
 * from 'the socket is dead'" — is about a cap GUESSING at socket health. This one guesses
 * nothing: it is the number the user chose, and stopping at their 37 minutes is the right
 * answer whichever of the two it was. What the hub cap could not do, and this does, is stop
 * *gracefully* — the run still verifies and still reports the edits it applied.
 *
 * Timers are injectable so a run that stops on time is testable without waiting for one.
 */
import { combineSignals } from './signals.js';
import { realTimers, type TimerApi } from './timeout.js';

/** The reason a run's signal carries when the deadline — not the user — stopped it. */
export class RunDeadlineError extends Error {
  public constructor(maxWallMs: number) {
    super(`The run reached its ${String(Math.round(maxWallMs / 60_000))}-minute limit.`);
    this.name = 'RunDeadlineError';
  }
}

/** A run's wall-clock deadline: one signal to thread, one flag to read, one timer to clear. */
export interface RunDeadline {
  /**
   * The signal to thread through the run's in-flight step work. Aborts when the user
   * cancels OR when the deadline fires, so a hung model call, a hung host tool and a
   * hung retry loop are all cut off by it.
   */
  readonly signal: AbortSignal;
  /** True once the deadline fired — the run stopped on ITS OWN clock, not the user's Stop. */
  expired(): boolean;
  /** Clear the timer and detach the listeners. Idempotent; call on EVERY exit path. */
  dispose(): void;
}

/**
 * Arm a run deadline `maxWallMs` from now, combined with the caller's cancel signal.
 *
 * A non-positive `maxWallMs` arms no timer at all (the signal then tracks `userSignal`
 * alone) — the same explicit opt-out `IdleTimeout` honours for a caller that wants no clock.
 *
 * @param maxWallMs - The run's wall-clock bound, from `kernel/conductor.ts`'s `maxWallMsFor`.
 * @param userSignal - The editor's Stop signal, if the host wired one.
 * @param timers - Injectable timer API (tests fire the deadline by hand).
 */
export function createRunDeadline(
  maxWallMs: number,
  userSignal?: AbortSignal,
  timers: TimerApi = realTimers,
): RunDeadline {
  const controller = new AbortController();
  let fired = false;
  let handle: unknown =
    maxWallMs > 0
      ? timers.setTimeout(() => {
          fired = true;
          controller.abort(new RunDeadlineError(maxWallMs));
        }, maxWallMs)
      : undefined;
  const combined = combineSignals(userSignal, controller.signal);
  return {
    signal: combined.signal,
    expired: () => fired,
    dispose: () => {
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      combined.dispose();
    },
  };
}
