/**
 * Tests for the persisted usage ledger.
 *
 * The billing-classification tests are the load-bearing ones. Everything else here is
 * arithmetic; those are the rules that stop the screen inventing a bill.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  classifyBilling,
  emptyUsageLedger,
  localDay,
  pruneLedger,
  recordRun,
  usdPerMeteredRun,
  type UsageLedger,
  type UsageRunEntry,
} from './usage-ledger.js';

const NOW = new Date('2026-09-03T12:00:00');

const run = (over: Partial<UsageRunEntry> = {}): UsageRunEntry => ({
  at: NOW,
  provider: 'anthropic',
  model: 'claude-opus-5',
  projectId: 'p1',
  projectName: 'Launch video',
  tokens: 1_000,
  usd: 0.5,
  modelCalls: 2,
  ...over,
});

const ledgerOf = (...entries: UsageRunEntry[]): UsageLedger =>
  entries.reduce(recordRun, emptyUsageLedger());

describe('classifyBilling — the rule that stops a fabricated bill', () => {
  it('calls a per-request provider metered', () => {
    expect(classifyBilling('anthropic', 1000, 2)).toBe('metered');
  });

  it('calls a subscription provider subscription, however real its tokens are', () => {
    // The cost meter prices every run from a per-tier table regardless of who served it,
    // so this run arrives carrying dollars that were never billed. ADR 0171 left the gap
    // open rather than filling it with a fabricated zero; this is where it closes.
    expect(classifyBilling('claude-agent-sdk', 5000, 3)).toBe('subscription');
  });

  it('calls a run with model calls but no tokens unreported, not free', () => {
    expect(classifyBilling('anthropic', 0, 4)).toBe('unreported');
  });

  it('does not call a genuinely model-free run unreported', () => {
    // Zero calls is a deterministic recipe, not a provider that stayed silent.
    expect(classifyBilling('anthropic', 0, 0)).toBe('metered');
  });
});

describe('recordRun', () => {
  it('keeps subscription dollars out of the metered total', () => {
    const ledger = ledgerOf(
      run({ provider: 'anthropic', usd: 0.5 }),
      run({ provider: 'claude-agent-sdk', model: 'claude-opus-5', usd: 2.0 }),
    );
    const { totals } = aggregateUsage(ledger, 'all', NOW);
    expect(totals.meteredUsd).toBe(0.5);
    expect(totals.subscriptionUsd).toBe(2.0);
    expect(totals.meteredRuns).toBe(1);
    expect(totals.subscriptionRuns).toBe(1);
  });

  it('folds repeat runs of the same day/model/project into one bucket', () => {
    const ledger = ledgerOf(run(), run(), run());
    expect(Object.keys(ledger.buckets)).toHaveLength(1);
    expect(aggregateUsage(ledger, 'all', NOW).totals.runs).toBe(3);
  });

  it('separates two projects that would collide on a naive key', () => {
    // A project literally named with the separator must not merge with another project's
    // spend — this is why the key is not a simple string concatenation of user text.
    const ledger = ledgerOf(
      run({ projectId: 'a b', projectName: 'A B' }),
      run({ projectId: 'a', projectName: 'A' }),
    );
    expect(Object.keys(ledger.buckets)).toHaveLength(2);
  });

  it('adopts the newest name a project was seen under', () => {
    const ledger = ledgerOf(
      run({ projectName: 'Untitled' }),
      run({ projectName: 'Launch video v2' }),
    );
    const row = aggregateUsage(ledger, 'all', NOW).byProject[0];
    expect(row?.label).toBe('Launch video v2');
  });

  it('names a run with no project open instead of dropping its spend', () => {
    const ledger = ledgerOf(run({ projectId: '', projectName: '' }));
    const report = aggregateUsage(ledger, 'all', NOW);
    expect(report.byProject[0]?.label).toBe('No project open');
    expect(report.totals.meteredUsd).toBe(0.5);
  });

  it('counts budget stops', () => {
    const ledger = ledgerOf(run({ hitBudget: true }), run());
    expect(aggregateUsage(ledger, 'all', NOW).totals.budgetStops).toBe(1);
  });

  it('never mutates the ledger it is given', () => {
    const first = ledgerOf(run());
    const second = recordRun(first, run({ model: 'claude-sonnet-5' }));
    expect(Object.keys(first.buckets)).toHaveLength(1);
    expect(Object.keys(second.buckets)).toHaveLength(2);
  });
});

describe('aggregateUsage', () => {
  const daysAgo = (n: number): Date => {
    const date = new Date(NOW);
    date.setDate(date.getDate() - n);
    return date;
  };

  it('excludes buckets outside the range', () => {
    const ledger = ledgerOf(run({ at: daysAgo(0) }), run({ at: daysAgo(40) }));
    expect(aggregateUsage(ledger, '7d', NOW).totals.runs).toBe(1);
    expect(aggregateUsage(ledger, '90d', NOW).totals.runs).toBe(2);
    expect(aggregateUsage(ledger, 'all', NOW).totals.runs).toBe(2);
  });

  it('includes a run on the range boundary', () => {
    // 7d means today plus the six before it; a run six days ago is inside.
    const ledger = ledgerOf(run({ at: daysAgo(6) }));
    expect(aggregateUsage(ledger, '7d', NOW).totals.runs).toBe(1);
  });

  it('ranks models by spend', () => {
    const ledger = ledgerOf(
      run({ model: 'claude-sonnet-5', usd: 0.1 }),
      run({ model: 'claude-opus-5', usd: 9 }),
    );
    expect(aggregateUsage(ledger, 'all', NOW).byModel.map((r) => r.label)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  it('keeps the same model id from two providers apart', () => {
    // Otherwise a subscription run and a metered run of the same model merge, and the row
    // shows a dollar figure that is part real spend and part list-price equivalent.
    const ledger = ledgerOf(
      run({ provider: 'anthropic', model: 'claude-opus-5' }),
      run({ provider: 'claude-agent-sdk', model: 'claude-opus-5' }),
    );
    expect(aggregateUsage(ledger, 'all', NOW).byModel).toHaveLength(2);
  });

  it('names every provider a project was edited with', () => {
    const ledger = ledgerOf(
      run({ provider: 'anthropic' }),
      run({ provider: 'claude-agent-sdk' }),
      run({ provider: 'anthropic' }),
    );
    expect(aggregateUsage(ledger, 'all', NOW).byProject[0]?.sublabel).toBe(
      'anthropic, claude-agent-sdk',
    );
  });

  it('returns a gap-free day series so quiet days are visible', () => {
    // Three scattered runs must not render as a three-day streak.
    const ledger = ledgerOf(run({ at: daysAgo(0) }), run({ at: daysAgo(6) }));
    const { byDay } = aggregateUsage(ledger, '7d', NOW);
    expect(byDay).toHaveLength(7);
    expect(byDay.filter((d) => d.runs > 0)).toHaveLength(2);
    expect(byDay.at(-1)?.day).toBe(localDay(NOW));
  });

  it('counts active days rather than calendar days', () => {
    const ledger = ledgerOf(
      run({ at: daysAgo(0) }),
      run({ at: daysAgo(0) }),
      run({ at: daysAgo(3) }),
    );
    expect(aggregateUsage(ledger, '30d', NOW).totals.activeDays).toBe(2);
  });

  it('reports an empty ledger without inventing a first day', () => {
    const report = aggregateUsage(emptyUsageLedger(), '30d', NOW);
    expect(report.totals.runs).toBe(0);
    expect(report.firstDay).toBeUndefined();
    expect(report.byDay).toHaveLength(30);
  });

  it('caps the all-time day series so a long history stays drawable', () => {
    const ledger = ledgerOf(run({ at: daysAgo(900) }), run({ at: daysAgo(0) }));
    expect(aggregateUsage(ledger, 'all', NOW).byDay.length).toBeLessThanOrEqual(366);
  });
});

describe('pruneLedger', () => {
  it('drops buckets past the retention window', () => {
    const old = new Date(NOW);
    old.setDate(old.getDate() - 200);
    const ledger = ledgerOf(run({ at: old }), run({ at: NOW }));
    expect(Object.keys(pruneLedger(ledger, 90, NOW).buckets)).toHaveLength(1);
  });

  it('returns the same object when nothing was dropped, so no needless write happens', () => {
    const ledger = ledgerOf(run());
    expect(pruneLedger(ledger, 90, NOW)).toBe(ledger);
  });
});

describe('usdPerMeteredRun', () => {
  it('divides by metered runs only, so a subscription does not look like a discount', () => {
    // Two runs, one metered at $1 and one free on a plan. The metered run cost $1 — saying
    // "$0.50 per edit" would credit the subscription with halving a price it did not pay.
    const ledger = ledgerOf(
      run({ provider: 'anthropic', usd: 1 }),
      run({ provider: 'claude-agent-sdk', usd: 1 }),
    );
    const { totals } = aggregateUsage(ledger, 'all', NOW);
    expect(usdPerMeteredRun(totals)).toBe(1);
  });

  it('is undefined rather than zero when nothing priced has run', () => {
    const ledger = ledgerOf(run({ provider: 'claude-agent-sdk' }));
    expect(usdPerMeteredRun(aggregateUsage(ledger, 'all', NOW).totals)).toBeUndefined();
  });
});
