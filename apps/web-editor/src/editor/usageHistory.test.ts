/**
 * Tests for the local usage-history store.
 *
 * The guarded-storage tests matter most: `localStorage` does not merely return null in
 * some contexts, it throws, and a settings screen must never be the thing that takes the
 * app down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearUsageHistory,
  onUsageHistoryChange,
  readUsageReport,
  recordUsageRun,
} from './usageHistory.js';
import type { UsageRunEntry } from '@framepilot/ai-sdk';

const entry = (over: Partial<UsageRunEntry> = {}): UsageRunEntry => ({
  at: new Date(),
  provider: 'anthropic',
  model: 'claude-opus-5',
  projectId: 'p1',
  projectName: 'Launch video',
  tokens: 1_000,
  usd: 0.25,
  modelCalls: 2,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('recordUsageRun', () => {
  it('records a run and reads it back', () => {
    recordUsageRun(entry(), true);
    const report = readUsageReport('30d');
    expect(report.totals.runs).toBe(1);
    expect(report.totals.meteredUsd).toBe(0.25);
  });

  it('records nothing when the user has history turned off', () => {
    recordUsageRun(entry(), false);
    expect(readUsageReport('30d').totals.runs).toBe(0);
  });

  it('accumulates across runs', () => {
    recordUsageRun(entry(), true);
    recordUsageRun(entry({ projectId: 'p2', projectName: 'Teaser' }), true);
    const report = readUsageReport('30d');
    expect(report.totals.runs).toBe(2);
    expect(report.byProject).toHaveLength(2);
  });

  it('drops buckets past the retention window on write', () => {
    // Pruning happens on write, not read, so the numbers do not depend on whether anyone
    // opened the screen.
    const old = new Date();
    old.setDate(old.getDate() - 200);
    recordUsageRun(entry({ at: old }), true);
    recordUsageRun(entry(), true);
    expect(readUsageReport('all').totals.runs).toBe(1);
  });
});

describe('guarded storage', () => {
  it('reports empty history when reading throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: site data blocked');
    });
    expect(readUsageReport('30d').totals.runs).toBe(0);
  });

  it('does not throw when writing is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // The app keeps working; history simply stops growing.
    expect(() => recordUsageRun(entry(), true)).not.toThrow();
  });

  it('discards a stored shape it does not understand rather than half-reading it', () => {
    // A partially-understood ledger would render as confidently wrong numbers.
    localStorage.setItem('framepilot.usage.v1', JSON.stringify({ version: 99, buckets: { a: 1 } }));
    expect(readUsageReport('all').totals.runs).toBe(0);
  });

  it('survives corrupt JSON', () => {
    localStorage.setItem('framepilot.usage.v1', '{not json');
    expect(readUsageReport('all').totals.runs).toBe(0);
  });
});

describe('clearUsageHistory', () => {
  it('forgets everything', () => {
    recordUsageRun(entry(), true);
    clearUsageHistory();
    expect(readUsageReport('all').totals.runs).toBe(0);
  });
});

describe('onUsageHistoryChange', () => {
  it('notifies a listener when a run is recorded, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = onUsageHistoryChange(listener);
    recordUsageRun(entry(), true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    recordUsageRun(entry(), true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
