import { describe, expect, it, vi } from 'vitest';
import { LruCache } from './lruCache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('evicts the least-recently-used entry past the bound', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('a get() refreshes recency so the touched key survives eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now most-recent
    cache.set('c', 3); // evicts 'b', not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('re-setting an existing key updates value and recency without growing size', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // refresh 'a'
    cache.set('c', 3); // evicts 'b'
    expect(cache.get('a')).toBe(10);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('runs onEvict for evicted and cleared entries (release native resources)', () => {
    const onEvict = vi.fn();
    const cache = new LruCache<string, number>(1, onEvict);
    cache.set('a', 1);
    cache.set('b', 2); // evicts 'a'
    expect(onEvict).toHaveBeenCalledWith(1, 'a');
    cache.clear(); // evicts 'b'
    expect(onEvict).toHaveBeenCalledWith(2, 'b');
    expect(cache.size).toBe(0);
  });
});
