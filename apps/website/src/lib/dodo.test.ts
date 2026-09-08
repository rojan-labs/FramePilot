/**
 * Checkout-URL tests. These are the only payment logic on the site, so they pin
 * the host per environment, the product id per cadence, the post-payment
 * redirect, and the loud failure when a build has no product id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The module reads env at import time, so each case needs a fresh import. */
async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('./dodo');
}

const ENV_KEYS = [
  'NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY',
  'NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL',
  'NEXT_PUBLIC_DODO_ENVIRONMENT',
  'NEXT_PUBLIC_SITE_URL',
];

describe('checkoutUrl', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  it('builds a live hosted-checkout link for each cadence, with the thank-you redirect', async () => {
    const { checkoutUrl } = await loadWithEnv({
      NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY: 'pdt_month',
      NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL: 'pdt_year',
      NEXT_PUBLIC_DODO_ENVIRONMENT: undefined,
      NEXT_PUBLIC_SITE_URL: 'https://framepilot.app',
    });

    const annual = new URL(checkoutUrl({ billingCycle: 'annual' }));
    expect(annual.origin).toBe('https://checkout.dodopayments.com');
    expect(annual.pathname).toBe('/buy/pdt_year');
    expect(annual.searchParams.get('quantity')).toBe('1');
    expect(annual.searchParams.get('redirect_url')).toBe('https://framepilot.app/thank-you/');

    expect(new URL(checkoutUrl({ billingCycle: 'monthly' })).pathname).toBe('/buy/pdt_month');
  });

  it('uses the sandbox host in test mode and honours an explicit product id', async () => {
    const { checkoutUrl } = await loadWithEnv({
      NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY: 'pdt_month',
      NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL: 'pdt_year',
      NEXT_PUBLIC_DODO_ENVIRONMENT: 'test',
    });
    const url = new URL(checkoutUrl({ productId: 'pdt_explicit' }));
    expect(url.origin).toBe('https://test.checkout.dodopayments.com');
    expect(url.pathname).toBe('/buy/pdt_explicit');
  });

  it('throws (rather than dead-ending) when the cadence has no product id', async () => {
    const { checkoutUrl, isDodoConfigured } = await loadWithEnv({
      NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY: undefined,
      NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL: undefined,
    });
    expect(isDodoConfigured()).toBe(false);
    expect(() => checkoutUrl({ billingCycle: 'monthly' })).toThrow(
      /NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY/,
    );
  });
});
