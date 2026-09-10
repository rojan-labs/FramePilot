/** Tests for the cost meter (kernel/cost/cost-meter.ts, Phase K4.3, §19). */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER_PRICING,
  emptyLedger,
  estimateUsd,
  recordCost,
  tierUsdShare,
  totalTokens,
  type TierPrice,
} from './cost-meter.js';
import type { ModelTier } from '../proposers/types.js';

describe('estimateUsd', () => {
  it('prices input and output tokens per million by tier', () => {
    // small: $1/Mtok in, $5/Mtok out → 1M in + 1M out = $1 + $5 = $6.
    expect(estimateUsd('small', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(6, 10);
    // large is ~15× costlier per input token than small (the routing lever).
    expect(estimateUsd('large', { input: 1_000_000, output: 0 })).toBeCloseTo(15, 10);
  });

  it('scales linearly with usage', () => {
    expect(estimateUsd('mid', { input: 0, output: 0 })).toBe(0);
    expect(estimateUsd('mid', { input: 500_000, output: 100_000 })).toBeCloseTo(
      (500_000 * 3 + 100_000 * 15) / 1_000_000,
      10,
    );
  });

  it('honours a caller-supplied price table (the settings seam)', () => {
    const cheap: Record<ModelTier, TierPrice> = {
      small: { inputPerMTok: 0, outputPerMTok: 0 },
      mid: { inputPerMTok: 0, outputPerMTok: 0 },
      large: { inputPerMTok: 2, outputPerMTok: 2 },
    };
    expect(estimateUsd('small', { input: 9, output: 9 }, cheap)).toBe(0);
    expect(estimateUsd('large', { input: 1_000_000, output: 0 }, cheap)).toBeCloseTo(2, 10);
  });

  it('keeps the default tiers in ascending cost order', () => {
    const per = (t: ModelTier): number => DEFAULT_TIER_PRICING[t].inputPerMTok;
    expect(per('small')).toBeLessThan(per('mid'));
    expect(per('mid')).toBeLessThan(per('large'));
  });
});

describe('CostLedger', () => {
  it('starts empty and zeroed', () => {
    const ledger = emptyLedger();
    expect(ledger).toMatchObject({ inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 });
    expect(totalTokens(ledger)).toBe(0);
    expect(ledger.byTier.small).toEqual({ tokens: 0, usd: 0, calls: 0 });
  });

  it('accrues tokens, USD, and calls overall and per tier', () => {
    let ledger = emptyLedger();
    ledger = recordCost(ledger, 'small', { input: 100, output: 20 });
    ledger = recordCost(ledger, 'large', { input: 100, output: 20 });
    expect(ledger.calls).toBe(2);
    expect(totalTokens(ledger)).toBe(240);
    expect(ledger.inputTokens).toBe(200);
    expect(ledger.outputTokens).toBe(40);
    expect(ledger.byTier.small.calls).toBe(1);
    expect(ledger.byTier.large.calls).toBe(1);
    // The large call costs 15× the small on input — the meter attributes it correctly.
    expect(ledger.byTier.large.usd).toBeGreaterThan(ledger.byTier.small.usd);
    expect(ledger.usd).toBeCloseTo(ledger.byTier.small.usd + ledger.byTier.large.usd, 12);
  });

  it('is immutable — recordCost returns a new ledger', () => {
    const base = emptyLedger();
    const next = recordCost(base, 'mid', { input: 10, output: 10 });
    expect(base.calls).toBe(0);
    expect(next.calls).toBe(1);
    expect(next).not.toBe(base);
  });

  it('accumulates repeated calls to the same tier', () => {
    let ledger = emptyLedger();
    ledger = recordCost(ledger, 'small', { input: 50, output: 50 });
    ledger = recordCost(ledger, 'small', { input: 50, output: 50 });
    expect(ledger.byTier.small).toMatchObject({ tokens: 200, calls: 2 });
  });
});

describe('tierUsdShare', () => {
  it('reports the fraction of spend per tier (routing is working when small dominates)', () => {
    let ledger = emptyLedger();
    // Many cheap small calls, one big-but-rare large call.
    for (let i = 0; i < 10; i++) ledger = recordCost(ledger, 'small', { input: 1000, output: 200 });
    ledger = recordCost(ledger, 'large', { input: 2000, output: 500 });
    const share = tierUsdShare(ledger);
    expect(share.small + share.mid + share.large).toBeCloseTo(1, 10);
    expect(share.mid).toBe(0);
  });

  it('is all-zero for an empty ledger (no divide-by-zero)', () => {
    expect(tierUsdShare(emptyLedger())).toEqual({ small: 0, mid: 0, large: 0 });
  });
});

describe('cached prompt tokens are counted and priced', () => {
  // Run `df81d58e`: 32 calls, ~24,700 cached input tokens each, metered as 14,642 total.
  it('adds cache reads and writes to the totals, at the tier’s cache rates', async () => {
    const { emptyLedger, recordCost, totalTokens, estimateUsd, DEFAULT_TIER_PRICING } = await import(
      './cost-meter.js'
    );
    const usage = { input: 3, output: 450, cacheRead: 24_700, cacheCreation: 0 };
    const ledger = recordCost(emptyLedger(), 'mid', usage);
    expect(ledger.cachedInputTokens).toBe(24_700);
    expect(totalTokens(ledger)).toBe(3 + 450 + 24_700);
    const price = DEFAULT_TIER_PRICING.mid;
    const expected =
      (3 * price.inputPerMTok + 450 * price.outputPerMTok + 24_700 * price.inputPerMTok * 0.1) /
      1_000_000;
    expect(ledger.usd).toBeCloseTo(expected, 9);
    expect(estimateUsd('mid', { input: 3, output: 450 })).toBeLessThan(ledger.usd);
  });

  it('honours an explicit cache price and leaves an uncached call unchanged', async () => {
    const { estimateUsd, DEFAULT_TIER_PRICING } = await import('./cost-meter.js');
    const prices = { ...DEFAULT_TIER_PRICING, mid: { ...DEFAULT_TIER_PRICING.mid, cacheReadPerMTok: 1 } };
    expect(estimateUsd('mid', { input: 0, output: 0, cacheRead: 1_000_000 }, prices)).toBeCloseTo(1, 9);
    expect(estimateUsd('mid', { input: 10, output: 10 })).toBe(
      (10 * DEFAULT_TIER_PRICING.mid.inputPerMTok + 10 * DEFAULT_TIER_PRICING.mid.outputPerMTok) / 1_000_000,
    );
  });
});
