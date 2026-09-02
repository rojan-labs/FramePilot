/**
 * Tests for the run deadline (`./deadline.ts`) — the wall-clock bound armed on the step
 * that is in flight, motivated by run `369e8c82`.
 *
 * The end-to-end behaviour ("a run that runs out of time stops on time and reports what it
 * applied") is asserted in `../orchestrator-stream.test.ts`. What lives here is the
 * contract the orchestrator leans on and cannot reach from there: which of the two signals
 * fired, that a disposed deadline stays disposed, and the no-clock opt-out.
 */
import { describe, expect, it } from 'vitest';
import { createRunDeadline, RunDeadlineError } from './deadline.js';
import type { TimerApi } from './timeout.js';

/** A hand-fired timer API that also records what was scheduled and cleared. */
function fakeTimers(): TimerApi & {
  fire(): void;
  readonly scheduled: number;
  readonly cleared: unknown[];
} {
  const handlers = new Map<number, () => void>();
  const cleared: unknown[] = [];
  let scheduled = 0;
  let next = 1;
  return {
    setTimeout: (handler) => {
      scheduled += 1;
      const id = next++;
      handlers.set(id, handler);
      return id;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
      handlers.delete(handle as number);
    },
    fire: () => {
      for (const [id, handler] of [...handlers]) {
        handlers.delete(id);
        handler();
      }
    },
    get scheduled() {
      return scheduled;
    },
    get cleared() {
      return cleared;
    },
  };
}

describe('createRunDeadline', () => {
  it('aborts its signal when the deadline fires, with a reason that names the limit', () => {
    const timers = fakeTimers();
    const deadline = createRunDeadline(37 * 60_000, undefined, timers);
    expect(deadline.expired()).toBe(false);
    expect(deadline.signal.aborted).toBe(false);
    timers.fire();
    expect(deadline.expired()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(RunDeadlineError);
    expect((deadline.signal.reason as Error).message).toContain('37-minute');
  });

  it('works with no user signal at all — a host that wired no Stop still gets a bound', () => {
    const timers = fakeTimers();
    const deadline = createRunDeadline(60_000, undefined, timers);
    expect(timers.scheduled).toBe(1);
    timers.fire();
    expect(deadline.signal.aborted).toBe(true);
  });

  it("expired() stays false when it is the USER'S signal that aborted", () => {
    // The discriminator the whole slice rests on: a run stopped by Stop must settle as a
    // cancellation, and a run stopped by its own clock must settle by reporting.
    const timers = fakeTimers();
    const user = new AbortController();
    const deadline = createRunDeadline(60_000, user.signal, timers);
    user.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(false);
  });

  it('aborts immediately when the user signal is ALREADY aborted', () => {
    const timers = fakeTimers();
    const user = new AbortController();
    user.abort();
    const deadline = createRunDeadline(60_000, user.signal, timers);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(false);
  });

  it('arms no timer for a non-positive budget, and then tracks the user signal alone', () => {
    // The same explicit opt-out `IdleTimeout` honours: zero means "no clock", not "stop now".
    const timers = fakeTimers();
    const user = new AbortController();
    const deadline = createRunDeadline(0, user.signal, timers);
    expect(timers.scheduled).toBe(0);
    expect(deadline.signal.aborted).toBe(false);
    user.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(false);
    // Nothing to clear, and disposing is still safe.
    deadline.dispose();
    expect(timers.cleared).toEqual([]);
  });

  it('dispose() clears the timer, is idempotent, and never clears a later deadline', () => {
    const timers = fakeTimers();
    const first = createRunDeadline(60_000, undefined, timers);
    first.dispose();
    expect(timers.cleared).toEqual([1]);
    // Twice is a no-op — `finalize`, `settle` and `streamAgent`'s `finally` can all fire.
    first.dispose();
    expect(timers.cleared).toEqual([1]);
    // And a disposed deadline must not take the NEXT run's timer down with it.
    const second = createRunDeadline(60_000, undefined, timers);
    first.dispose();
    expect(timers.cleared).toEqual([1]);
    timers.fire();
    expect(second.expired()).toBe(true);
  });

  it('a disposed deadline stops listening to the user signal', () => {
    const timers = fakeTimers();
    const user = new AbortController();
    const deadline = createRunDeadline(60_000, user.signal, timers);
    deadline.dispose();
    user.abort();
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired()).toBe(false);
  });
});
