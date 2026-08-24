import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StockQuotaStore } from './stock-quota.js';

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const RESET_EPOCH = Math.floor(new Date('2026-09-01T00:00:00.000Z').getTime() / 1000);
const NOW = new Date('2026-08-24T12:00:00.000Z').getTime();

function quotaHeaders(remaining = 18431): { get(name: string): string | null } {
  return headers({
    'x-ratelimit-limit': '20000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(RESET_EPOCH),
  });
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fp-stock-quota-'));
  file = join(dir, 'stock-quota.json');
});

function store(options: { keyed?: boolean; now?: () => number } = {}): StockQuotaStore {
  return new StockQuotaStore({
    filePath: file,
    isKeyConfigured: () => options.keyed ?? true,
    now: options.now ?? (() => NOW),
  });
}

describe('snapshot honesty', () => {
  it('reports no_key when no key is configured, whatever it has observed', () => {
    const keyed = store();
    keyed.observe(quotaHeaders());
    expect(store({ keyed: false }).snapshot()).toEqual({ kind: 'no_key' });
  });

  it('reports unmeasured before any observation — not a guessed maximum', () => {
    const snapshot = store().snapshot();
    expect(snapshot).toEqual({ kind: 'unmeasured' });
    // The specific failure this guards: rendering 20000/20000 for a key that has
    // never been used, which would be indistinguishable from a real reading.
    expect(JSON.stringify(snapshot)).not.toContain('20000');
  });

  it('reports a real observation with its observedAt', () => {
    const s = store();
    s.observe(quotaHeaders());
    expect(s.snapshot()).toEqual({
      kind: 'measured',
      monthly: {
        limit: 20000,
        remaining: 18431,
        resetAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-08-24T12:00:00.000Z',
      },
    });
  });
});

describe('observe', () => {
  it('ignores a response with no rate-limit headers', () => {
    const s = store();
    s.observe(quotaHeaders());
    // A CDN thumbnail response carries no quota headers. Treating that as
    // "quota unknown" would blank a good reading every time a tile loaded.
    s.observe(headers({ 'content-type': 'image/jpeg' }));
    expect(s.snapshot()).toMatchObject({ kind: 'measured' });
  });

  it('never moves backwards in observation time', () => {
    const s = store();
    s.observe(quotaHeaders(18000), new Date('2026-08-24T12:00:05.000Z'));
    // A slower request that started earlier lands later with staler numbers.
    s.observe(quotaHeaders(19000), new Date('2026-08-24T12:00:01.000Z'));
    expect(s.snapshot()).toMatchObject({ monthly: { remaining: 18000 } });
  });

  it('accepts an equal-timestamp observation, so a retry is not stuck out', () => {
    const s = store();
    const at = new Date(NOW);
    s.observe(quotaHeaders(18000), at);
    s.observe(quotaHeaders(17999), at);
    expect(s.snapshot()).toMatchObject({ monthly: { remaining: 17999 } });
  });

  it('has no path that decrements remaining locally', () => {
    const s = store();
    s.observe(quotaHeaders(500));
    // Anything that "spends" a request without a header must not move the number:
    // the same key may be in use elsewhere, and a local counter would drift.
    s.observe(headers({}));
    s.observe(headers({ 'x-ratelimit-remaining': '499' }));
    expect(s.snapshot()).toMatchObject({ monthly: { remaining: 500 } });
  });
});

describe('rate limiting', () => {
  it('preserves the monthly observation, because both facts are true at once', () => {
    const s = store();
    s.observe(quotaHeaders(19400));
    s.observeRateLimited(headers({ 'retry-after': '90' }));

    const snapshot = s.snapshot();
    expect(snapshot.kind).toBe('hourly_limited');
    // A healthy monthly bar alongside an hourly 429 is not a contradiction —
    // it is the actual state, and the UI needs both halves to say so.
    expect(snapshot).toMatchObject({
      monthly: { remaining: 19400 },
      retryAfterSeconds: 90,
      since: '2026-08-24T12:00:00.000Z',
    });
  });

  it('omits retryAfterSeconds rather than inventing one', () => {
    const s = store();
    s.observeRateLimited(headers({}));
    expect(s.snapshot()).not.toHaveProperty('retryAfterSeconds');
  });

  it('clears on the next successful header-bearing response', () => {
    const s = store();
    s.observeRateLimited();
    expect(s.snapshot().kind).toBe('hourly_limited');
    s.observe(quotaHeaders());
    expect(s.snapshot().kind).toBe('measured');
  });

  it('stops reporting an hourly limit once the window has plainly passed', () => {
    let clock = NOW;
    const s = store({ now: () => clock });
    s.observeRateLimited();
    expect(s.snapshot().kind).toBe('hourly_limited');
    clock = NOW + 61 * 60 * 1000;
    // A banner that outlives its window is a lie about the present.
    expect(s.snapshot().kind).toBe('unmeasured');
  });
});

describe('persistence', () => {
  it('survives a restart, so the number is there before the first search', () => {
    store().observe(quotaHeaders(17000));
    expect(store().snapshot()).toMatchObject({ monthly: { remaining: 17000 } });
  });

  it('writes atomically and leaves no temp file behind', () => {
    store().observe(quotaHeaders());
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('degrades to unmeasured on a corrupt file rather than throwing', () => {
    writeFileSync(file, '{ not json', 'utf8');
    expect(store().snapshot()).toEqual({ kind: 'unmeasured' });
  });

  it('ignores a persisted observation that is not shaped like one', () => {
    writeFileSync(file, JSON.stringify({ version: 1, monthly: { limit: 'lots' } }), 'utf8');
    expect(store().snapshot()).toEqual({ kind: 'unmeasured' });
  });

  it('reset deletes the file, because a quota for a deleted key is noise', () => {
    const s = store();
    s.observe(quotaHeaders());
    s.reset();
    expect(existsSync(file)).toBe(false);
    expect(s.snapshot()).toEqual({ kind: 'unmeasured' });
  });
});

describe('subscribers', () => {
  it('pushes on every mutation and stops after unsubscribe', () => {
    const s = store();
    const listener = vi.fn();
    const off = s.subscribe(listener);

    s.observe(quotaHeaders());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'measured' }));

    s.observeRateLimited();
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    s.observe(quotaHeaders(1));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not fire for a response with no quota headers', () => {
    const s = store();
    const listener = vi.fn();
    s.subscribe(listener);
    s.observe(headers({ 'content-type': 'image/jpeg' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports no_key to subscribers once the key is gone', () => {
    let keyed = true;
    const s = new StockQuotaStore({
      filePath: file,
      isKeyConfigured: () => keyed,
      now: () => NOW,
    });
    const listener = vi.fn();
    s.subscribe(listener);
    keyed = false;
    s.reset();
    expect(listener).toHaveBeenLastCalledWith({ kind: 'no_key' });
  });
});
