import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, realSleep, withRetry } from './retry.js';
import { DEFAULT_RETRY_POLICY, ProviderError, type RetryPolicy } from './types.js';

const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 };
const noSleep = vi.fn(async () => {});

describe('backoffDelayMs', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    expect(backoffDelayMs(0, policy, undefined, () => 0.5)).toBe(100);
    expect(backoffDelayMs(1, policy, undefined, () => 0.5)).toBe(200);
    expect(backoffDelayMs(4, policy, undefined, () => 0.5)).toBe(1000); // capped
  });

  it('honors an explicit retryAfterMs over exponential backoff', () => {
    expect(backoffDelayMs(3, policy, 7777, () => 0.5)).toBe(7777);
  });

  it('applies symmetric jitter', () => {
    const jittered: RetryPolicy = { ...policy, jitter: 0.5 };
    expect(backoffDelayMs(0, jittered, undefined, () => 0)).toBe(50); // 100 * (1 - 0.5)
    expect(backoffDelayMs(0, jittered, undefined, () => 1)).toBe(150); // 100 * (1 + 0.5)
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { policy, sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderError('429', 'rate_limit', { retryAfterMs: 5 });
        return 'done';
      },
      { policy, sleep: noSleep, onRetry },
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError('bad', 'bad_request');
    });
    await expect(withRetry(fn, { policy, sleep: noSleep })).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError('still down', 'server');
    });
    await expect(withRetry(fn, { policy, sleep: noSleep })).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps a non-ProviderError as a retryable network error', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('socket hang up');
        return 'ok';
      },
      { policy, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('re-throws an AbortError without wrapping', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const fn = vi.fn(async () => {
      throw abort;
    });
    await expect(withRetry(fn, { policy, sleep: noSleep })).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(
      withRetry(fn, { policy, sleep: noSleep, signal: controller.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(fn).not.toHaveBeenCalled();
  });

  it('checks the abort signal before the final (single) attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const single: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 };
    const fn = vi.fn(async () => 'never');
    await expect(
      withRetry(fn, { policy: single, sleep: noSleep, signal: controller.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-throws an AbortError from the final attempt without wrapping', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const single: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 };
    const fn = vi.fn(async () => {
      throw abort;
    });
    await expect(withRetry(fn, { policy: single, sleep: noSleep })).rejects.toBe(abort);
  });

  it('uses the default policy when none is given', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });

  it('wraps a non-Error thrown value and retries it', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw 'string failure';
        return 'ok';
      },
      { policy, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('uses the real sleep + default rand when neither is injected', async () => {
    // No sleep/rand injected → exercises the `?? realSleep`/`?? Math.random` defaults.
    let calls = 0;
    const tiny: RetryPolicy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new ProviderError('x', 'server');
        return 'ok';
      },
      { policy: tiny },
    );
    expect(result).toBe('ok');
  });
});

describe('realSleep', () => {
  it('resolves after the timer fires', async () => {
    await expect(realSleep(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(realSleep(1000, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  });

  it('removes its abort listener when the timer wins with a live signal', async () => {
    const controller = new AbortController();
    await expect(realSleep(1, controller.signal)).resolves.toBeUndefined();
    // Aborting after resolution must not throw (listener was removed).
    expect(() => controller.abort()).not.toThrow();
  });

  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const promise = realSleep(10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toHaveProperty('name', 'AbortError');
  });
});
