import { describe, expect, it } from 'vitest';
import {
  MODEL_WAIT_HEARTBEAT_MS,
  modelWaitLabel,
  withWaitHeartbeat,
  type WaitStep,
} from './wait-heartbeat.js';
import type { TimerApi } from './timeout.js';

/**
 * A hand-fired timer that also remembers the delays it was asked for, so a test can fire
 * the heartbeat without waiting for one — the same pattern `reliability/deadline.test.ts`
 * uses, for the same reason: a stall is not testable by stalling.
 */
function handFiredTimers(): {
  api: TimerApi;
  fire: () => void;
  pending: () => number;
  /** How many timers were EVER armed — a re-arm per chunk is what proves the reset. */
  arms: () => number;
  delays: () => readonly number[];
} {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    api: {
      setTimeout: (handler, ms) => {
        const id = next++;
        scheduled.set(id, handler);
        delays.push(ms);
        return id;
      },
      clearTimeout: (handle) => {
        scheduled.delete(handle as number);
      },
    },
    fire: () => {
      for (const [id, handler] of [...scheduled]) {
        scheduled.delete(id);
        handler();
      }
    },
    pending: () => scheduled.size,
    arms: () => delays.length,
    delays: () => delays,
  };
}

/** A source that never produces anything — run `369e8c82`'s twentieth model call. */
function silentForever(signal?: AbortSignal): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<string>>((_resolve, reject) => {
          const stop = (): void => {
            reject(new Error('aborted'));
          };
          if (signal?.aborted === true) stop();
          else signal?.addEventListener('abort', stop, { once: true });
        }),
    }),
  };
}

/** Drain `count` steps, firing the timer whenever the heartbeat has armed one. */
async function beats(
  source: AsyncIterable<string>,
  timers: ReturnType<typeof handFiredTimers>,
  count: number,
  signal?: AbortSignal,
): Promise<WaitStep<string>[]> {
  const steps: WaitStep<string>[] = [];
  const iterator = withWaitHeartbeat(source, {
    intervalMs: MODEL_WAIT_HEARTBEAT_MS,
    timers: timers.api,
    ...(signal ? { signal } : {}),
  });
  for (let i = 0; i < count; i += 1) {
    const pull = iterator.next();
    // The arm happens synchronously inside the pull; firing it releases exactly one step.
    await Promise.resolve();
    timers.fire();
    const step = await pull;
    if (step.done === true) break;
    steps.push(step.value);
  }
  await iterator.return(undefined as never);
  return steps;
}

describe('withWaitHeartbeat', () => {
  it('beats while the source is silent, and keeps beating with a growing number', async () => {
    const timers = handFiredTimers();
    const steps = await beats(silentForever(), timers, 3);
    expect(steps).toEqual([
      { kind: 'waiting', waitedMs: MODEL_WAIT_HEARTBEAT_MS },
      { kind: 'waiting', waitedMs: MODEL_WAIT_HEARTBEAT_MS * 2 },
      { kind: 'waiting', waitedMs: MODEL_WAIT_HEARTBEAT_MS * 3 },
    ]);
    // One timer at a time, always the same budget, and none left armed after the unwind.
    expect(timers.delays()).toEqual([
      MODEL_WAIT_HEARTBEAT_MS,
      MODEL_WAIT_HEARTBEAT_MS,
      MODEL_WAIT_HEARTBEAT_MS,
    ]);
    expect(timers.pending()).toBe(0);
  });

  it('says nothing at all when the source answers before the interval', async () => {
    const timers = handFiredTimers();
    const source = (async function* () {
      yield 'hello';
      yield 'world';
    })();
    const steps: WaitStep<string>[] = [];
    for await (const step of withWaitHeartbeat(source, {
      intervalMs: MODEL_WAIT_HEARTBEAT_MS,
      timers: timers.api,
    })) {
      steps.push(step);
    }
    expect(steps).toEqual([
      { kind: 'chunk', chunk: 'hello' },
      { kind: 'chunk', chunk: 'world' },
    ]);
    expect(timers.pending()).toBe(0);
  });

  it('a chunk resets the silence — a steadily streaming call never reaches a beat', async () => {
    // THE PROPERTY THAT KEEPS THIS FROM BECOMING NOISE. Every chunk clears the armed timer
    // and starts a fresh one, so the only thing that can ever fire is a gap longer than the
    // interval. Here the timer is fired ONLY between the chunks that never come.
    const timers = handFiredTimers();
    const source = (async function* () {
      for (let i = 0; i < 50; i += 1) yield `delta-${String(i)}`;
    })();
    const steps: WaitStep<string>[] = [];
    for await (const step of withWaitHeartbeat(source, {
      intervalMs: MODEL_WAIT_HEARTBEAT_MS,
      timers: timers.api,
    })) {
      steps.push(step);
      // Between every chunk the previous timer must already be gone: nothing is left armed
      // for a later, unrelated gap to inherit.
      expect(timers.pending()).toBe(0);
    }
    expect(steps.filter((s) => s.kind === 'waiting')).toHaveLength(0);
    // One arm per pull (50 chunks + the terminal `done`), every one of them cleared.
    expect(timers.arms()).toBe(51);
    expect(timers.pending()).toBe(0);
  });

  it('arms nothing at all when the interval is non-positive (the explicit opt-out)', async () => {
    const timers = handFiredTimers();
    const source = (async function* () {
      yield 'only';
    })();
    const steps: WaitStep<string>[] = [];
    for await (const step of withWaitHeartbeat(source, { intervalMs: 0, timers: timers.api })) {
      steps.push(step);
    }
    expect(steps).toEqual([{ kind: 'chunk', chunk: 'only' }]);
    expect(timers.arms()).toBe(0);
  });

  it('stops beating once the run is aborted — a stopped run is not still waiting', async () => {
    const timers = handFiredTimers();
    const controller = new AbortController();
    controller.abort();
    const iterator = withWaitHeartbeat(silentForever(controller.signal), {
      intervalMs: MODEL_WAIT_HEARTBEAT_MS,
      timers: timers.api,
      signal: controller.signal,
    });
    await expect(iterator.next()).rejects.toThrow('aborted');
    // Not one timer was armed after the stop, and none is left behind.
    expect(timers.arms()).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  it('leaves no timer armed when the consumer walks away mid-wait', async () => {
    const timers = handFiredTimers();
    const iterator = withWaitHeartbeat(silentForever(), {
      intervalMs: MODEL_WAIT_HEARTBEAT_MS,
      timers: timers.api,
    });
    const pull = iterator.next();
    await Promise.resolve();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await pull;
    // The editor closed the panel / the run threw: the generator is returned mid-wait.
    await iterator.return(undefined as never);
    expect(timers.pending()).toBe(0);
  });
});

describe('modelWaitLabel', () => {
  it('says what is true and nothing more, in whole units', () => {
    expect(modelWaitLabel(MODEL_WAIT_HEARTBEAT_MS)).toBe(
      'Waiting on the AI — no reply for 4 minutes',
    );
    expect(modelWaitLabel(MODEL_WAIT_HEARTBEAT_MS * 3)).toBe(
      'Waiting on the AI — no reply for 12 minutes',
    );
    expect(modelWaitLabel(60_000)).toBe('Waiting on the AI — no reply for 1 minute');
    expect(modelWaitLabel(45_000)).toBe('Waiting on the AI — no reply for 45 seconds');
    expect(modelWaitLabel(1_000)).toBe('Waiting on the AI — no reply for 1 second');
  });

  it('is not worded as a failure and promises nothing about what happens next', () => {
    const label = modelWaitLabel(MODEL_WAIT_HEARTBEAT_MS * 2);
    for (const forbidden of ['fail', 'error', 'wrong', 'retry', 'will ', 'stopping']) {
      expect(label.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('MODEL_WAIT_HEARTBEAT_MS', () => {
  it('sits above every healthy model call in run 369e8c82 and far below its hang', () => {
    // The measured spread, manifest-to-first-text, for that run's twenty calls.
    const healthySeconds = [
      23.4, 32.1, 49.1, 54.5, 55.7, 56.4, 65.9, 68.1, 95.1, 101.6, 104.5, 105.2, 114.9, 115.4,
      120.7, 124.0, 127.1, 131.9, 193.4,
    ];
    const hangSeconds = 2328;
    expect(Math.max(...healthySeconds) * 1000).toBeLessThan(MODEL_WAIT_HEARTBEAT_MS);
    expect(MODEL_WAIT_HEARTBEAT_MS).toBeLessThan((hangSeconds * 1000) / 8);
  });
});
