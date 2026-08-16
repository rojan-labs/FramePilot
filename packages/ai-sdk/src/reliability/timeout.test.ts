import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS,
  IdleTimeout,
  timeoutError,
  withConnectTimeout,
  type TimerApi,
} from './timeout.js';

/** A controllable fake timer API: capture the handler and fire it on demand. */
function fakeTimers(): TimerApi & { fire(): void; readonly cleared: boolean } {
  let handler: (() => void) | undefined;
  let cleared = false;
  return {
    setTimeout: (h) => {
      handler = h;
      return 1;
    },
    clearTimeout: () => {
      cleared = true;
    },
    fire: () => handler?.(),
    get cleared() {
      return cleared;
    },
  };
}

describe('timeoutError', () => {
  it('is a retryable network ProviderError', () => {
    const err = timeoutError('idle', 500);
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('500');
  });
});

describe('IdleTimeout', () => {
  it('fires onTimeout and aborts the controller when not beaten', () => {
    const timers = fakeTimers();
    const onTimeout = vi.fn();
    const idle = new IdleTimeout(100, onTimeout, timers);
    idle.beat();
    timers.fire();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(idle.controller.signal.aborted).toBe(true);
  });

  it('does not fire after stop()', () => {
    const timers = fakeTimers();
    const onTimeout = vi.fn();
    const idle = new IdleTimeout(100, onTimeout, timers);
    idle.beat();
    idle.stop();
    timers.fire();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(idle.controller.signal.aborted).toBe(false);
  });

  it('ignores beat() after stop()', () => {
    const timers = fakeTimers();
    const idle = new IdleTimeout(100, vi.fn(), timers);
    idle.stop();
    idle.beat(); // no-op
    expect(idle.controller.signal.aborted).toBe(false);
  });

  it('clears the previous timer on each beat', () => {
    const timers = fakeTimers();
    const idle = new IdleTimeout(100, vi.fn(), timers);
    idle.beat();
    idle.beat();
    expect(timers.cleared).toBe(true);
  });
});

describe('withConnectTimeout', () => {
  it('resolves with the promise value when it settles first', async () => {
    await expect(withConnectTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('bypasses the timeout when ms is 0 or undefined', async () => {
    await expect(withConnectTimeout(Promise.resolve('a'), 0)).resolves.toBe('a');
    await expect(withConnectTimeout(Promise.resolve('b'), undefined)).resolves.toBe('b');
  });

  it('rejects with a timeout error when the timer fires first', async () => {
    const timers = fakeTimers();
    const never = new Promise<string>(() => {});
    const raced = withConnectTimeout(never, 100, 'connect', timers);
    timers.fire();
    await expect(raced).rejects.toThrow('connect timed out');
  });

  it('clears the timer once the promise settles', async () => {
    const timers = fakeTimers();
    await withConnectTimeout(Promise.resolve('x'), 100, 'connect', timers);
    expect(timers.cleared).toBe(true);
  });
});

describe('DEFAULT_TIMEOUTS', () => {
  it('disables both timeouts by default (no time threshold — bounded by Stop only)', () => {
    // Product decision: agent work against a slow/remote backend can run for over an
    // hour, so there is no default clock. Both are 0 (disabled).
    expect(DEFAULT_TIMEOUTS.connectMs).toBe(0);
    expect(DEFAULT_TIMEOUTS.idleMs).toBe(0);
  });
});

describe('IdleTimeout with a non-positive budget', () => {
  it('never arms the watchdog (beat is a no-op, so a slow stream is never aborted)', () => {
    const timers = fakeTimers();
    const onTimeout = vi.fn();
    const idle = new IdleTimeout(0, onTimeout, timers);
    idle.beat();
    // No timer was scheduled, so firing the (absent) handler does nothing.
    timers.fire();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(idle.controller.signal.aborted).toBe(false);
  });
});
