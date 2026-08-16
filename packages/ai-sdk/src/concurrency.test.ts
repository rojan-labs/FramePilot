/**
 * Tests for the turn-level tool-call batching module (E1,
 * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md): partition semantics (kind mix,
 * throwing predicate, duplicate-key splitting), the bounded pool's ordering and
 * concurrency guarantees, and env resolution. 100% coverage — core deterministic
 * module.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TOOL_CONCURRENCY,
  mapBounded,
  partitionConcurrencyBatches,
  resolveToolConcurrency,
} from './concurrency.js';

interface Call {
  readonly name: string;
  readonly safe: boolean;
}

const call = (name: string, safe = true): Call => ({ name, safe });
const isSafe = (c: Call): boolean => c.safe;

describe('partitionConcurrencyBatches', () => {
  it('returns no batches for an empty turn', () => {
    expect(partitionConcurrencyBatches([], isSafe)).toEqual([]);
  });

  it('merges consecutive safe calls into one concurrent batch', () => {
    const calls = [call('a'), call('b'), call('c')];
    expect(partitionConcurrencyBatches(calls, isSafe)).toEqual([{ concurrent: true, calls }]);
  });

  it('isolates unsafe calls as serial singletons, splitting the safe runs around them', () => {
    const [a, b, m, c, n] = [
      call('a'),
      call('b'),
      call('mutate', false),
      call('c'),
      call('mutate2', false),
    ];
    expect(partitionConcurrencyBatches([a, b, m, c, n], isSafe)).toEqual([
      { concurrent: true, calls: [a, b] },
      { concurrent: false, calls: [m] },
      { concurrent: true, calls: [c] },
      { concurrent: false, calls: [n] },
    ]);
  });

  it('flattening the batches reproduces the input order exactly', () => {
    const calls = [call('a'), call('m', false), call('b'), call('c'), call('n', false)];
    const flattened = partitionConcurrencyBatches(calls, isSafe).flatMap((b) => [...b.calls]);
    expect(flattened).toEqual(calls);
  });

  it('a throwing predicate conservatively marks the call not safe', () => {
    const calls = [call('a'), call('boom'), call('b')];
    const throwing = (c: Call): boolean => {
      if (c.name === 'boom') throw new Error('predicate exploded');
      return c.safe;
    };
    expect(partitionConcurrencyBatches(calls, throwing)).toEqual([
      { concurrent: true, calls: [calls[0]] },
      { concurrent: false, calls: [calls[1]] },
      { concurrent: true, calls: [calls[2]] },
    ]);
  });

  it('splits duplicate keys into separate batches so a repeat call still hits the run memo', () => {
    const calls = [call('read_x'), call('read_y'), call('read_x'), call('read_x')];
    expect(partitionConcurrencyBatches(calls, isSafe, (c) => c.name)).toEqual([
      { concurrent: true, calls: [calls[0], calls[1]] },
      { concurrent: true, calls: [calls[2]] },
      { concurrent: true, calls: [calls[3]] },
    ]);
  });

  it('duplicate-key tracking resets across an unsafe singleton', () => {
    const calls = [call('read_x'), call('mutate', false), call('read_x')];
    expect(partitionConcurrencyBatches(calls, isSafe, (c) => c.name)).toEqual([
      { concurrent: true, calls: [calls[0]] },
      { concurrent: false, calls: [calls[1]] },
      { concurrent: true, calls: [calls[2]] },
    ]);
  });
});

describe('mapBounded', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 15, 1];
    const results = await mapBounded(delays, 4, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `item-${index}`;
    });
    expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
  });

  it('never exceeds the pool limit', async () => {
    let active = 0;
    let maxActive = 0;
    await mapBounded([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // it did actually overlap
  });

  it('clamps a sub-1 limit to serial execution', async () => {
    let active = 0;
    let maxActive = 0;
    await mapBounded([1, 2, 3], 0, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(maxActive).toBe(1);
  });

  it('propagates the first rejection after the in-flight pool settles', async () => {
    const completed: number[] = [];
    await expect(
      mapBounded([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error('call 2 failed');
        await new Promise((resolve) => setTimeout(resolve, 2));
        completed.push(n);
      }),
    ).rejects.toThrow('call 2 failed');
    // The other in-flight calls settled before the rejection surfaced.
    expect(completed.sort()).toEqual([1, 3]);
  });

  it('handles an empty input without spawning workers', async () => {
    expect(await mapBounded([], 4, async () => 'never')).toEqual([]);
  });
});

describe('resolveToolConcurrency', () => {
  it('defaults when unset or blank', () => {
    expect(resolveToolConcurrency(undefined)).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    expect(resolveToolConcurrency('')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    expect(resolveToolConcurrency('   ')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
  });

  it('defaults on non-numeric or sub-1 values', () => {
    expect(resolveToolConcurrency('lots')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    expect(resolveToolConcurrency('0')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    expect(resolveToolConcurrency('-3')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
    expect(resolveToolConcurrency('NaN')).toBe(DEFAULT_MAX_TOOL_CONCURRENCY);
  });

  it('parses valid values and floors fractions', () => {
    expect(resolveToolConcurrency('1')).toBe(1);
    expect(resolveToolConcurrency('8')).toBe(8);
    expect(resolveToolConcurrency('2.9')).toBe(2);
  });
});
