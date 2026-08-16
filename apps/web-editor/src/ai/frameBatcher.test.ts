/**
 * Tests for the frame-coalescing stream batcher (Phase 15 H1): items buffered
 * within one frame flush as a single ordered batch; `flush()` drains synchronously
 * and cancels the pending frame; an empty flush is a no-op.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFrameBatcher,
  createIntervalScheduler,
  type FrameScheduler,
} from './frameBatcher.js';

/** A manual scheduler: frames fire only when `fire()` is called. */
function manualScheduler(): FrameScheduler & { fire: () => void; cancelled: number[] } {
  let next = 0;
  const pending = new Map<number, () => void>();
  const cancelled: number[] = [];
  return {
    schedule(callback) {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    cancel(handle) {
      pending.delete(handle);
      cancelled.push(handle);
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((cb) => cb());
    },
    cancelled,
  };
}

describe('createFrameBatcher', () => {
  it('coalesces pushes within one frame into a single ordered batch', () => {
    const scheduler = manualScheduler();
    const batches: string[][] = [];
    const batcher = createFrameBatcher<string>((items) => batches.push([...items]), scheduler);
    batcher.push('a');
    batcher.push('b');
    batcher.push('c');
    expect(batches).toEqual([]);
    scheduler.fire();
    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('schedules a new frame for pushes after a flush', () => {
    const scheduler = manualScheduler();
    const batches: string[][] = [];
    const batcher = createFrameBatcher<string>((items) => batches.push([...items]), scheduler);
    batcher.push('a');
    scheduler.fire();
    batcher.push('b');
    scheduler.fire();
    expect(batches).toEqual([['a'], ['b']]);
  });

  it('flush() drains synchronously and cancels the pending frame', () => {
    const scheduler = manualScheduler();
    const batches: string[][] = [];
    const batcher = createFrameBatcher<string>((items) => batches.push([...items]), scheduler);
    batcher.push('a');
    batcher.flush();
    expect(batches).toEqual([['a']]);
    expect(scheduler.cancelled).toHaveLength(1);
    // The cancelled frame firing later must not double-deliver.
    scheduler.fire();
    expect(batches).toEqual([['a']]);
  });

  it('flush() with nothing pending is a no-op', () => {
    const scheduler = manualScheduler();
    const batches: string[][] = [];
    const batcher = createFrameBatcher<string>((items) => batches.push([...items]), scheduler);
    batcher.flush();
    expect(batches).toEqual([]);
  });

  it('uses requestAnimationFrame by default when available', async () => {
    const batches: number[][] = [];
    const batcher = createFrameBatcher<number>((items) => batches.push([...items]));
    batcher.push(1);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    // jsdom rAF is a timeout; give the flush frame a beat to run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toEqual([[1]]);
  });

  it('can cap expensive stream renders below display refresh without losing items', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = createFrameBatcher<string>(
      (items) => batches.push([...items]),
      createIntervalScheduler(50),
    );
    batcher.push('a');
    vi.advanceTimersByTime(25);
    batcher.push('b');
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(batches).toEqual([['a', 'b']]);
    vi.useRealTimers();
  });
});
