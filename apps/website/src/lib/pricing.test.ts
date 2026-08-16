import { describe, expect, it } from 'vitest';
import { getPlans, formatUsd, priceFor, effectiveMonthly, annualSavingsPercent } from './pricing';

describe('pricing', () => {
  it('exposes the FramePilot subscription and the Studio contact plan', () => {
    const plans = getPlans();
    expect(plans.map((p) => p.id)).toEqual(['pro', 'studio']);
    const pro = plans.find((p) => p.id === 'pro')!;
    expect(pro.highlight).toBe(true);
    expect(pro.cta.kind).toBe('checkout');
    expect(pro.price).toEqual({ monthly: 25, annual: 199 });
  });

  it('marks the Studio plan as contact (no price)', () => {
    const studio = getPlans().find((p) => p.id === 'studio')!;
    expect(studio.price).toBeNull();
    expect(studio.cta.kind).toBe('link');
  });

  it('selects the price for a billing cycle', () => {
    const price = { monthly: 25, annual: 199 };
    expect(priceFor(price, 'monthly')).toBe(25);
    expect(priceFor(price, 'annual')).toBe(199);
  });

  it('computes the effective monthly cost when billed yearly', () => {
    expect(effectiveMonthly({ monthly: 25, annual: 199 })).toBeCloseTo(16.58, 2);
  });

  it('computes an honest annual saving (0 when annual is not cheaper)', () => {
    expect(annualSavingsPercent({ monthly: 25, annual: 199 })).toBe(34);
    expect(annualSavingsPercent({ monthly: 25, annual: 300 })).toBe(0);
    expect(annualSavingsPercent({ monthly: 25, annual: 360 })).toBe(0);
  });

  it('formats USD, keeping cents only when present', () => {
    expect(formatUsd(199)).toBe('$199');
    expect(formatUsd(16.58)).toBe('$16.58');
    expect(formatUsd(25)).toBe('$25');
  });
});
