/**
 * Dodo Payments checkout links (client-side).
 *
 * WHY a link and not an embedded overlay: this site is a **static export**
 * (`output: 'export'`, no server runtime). Dodo's overlay/inline checkout needs a
 * server route to mint a Checkout Session, and its Session API must never be
 * called from the browser with a merchant API key. Dodo's *static payment links*
 * need neither — the product id is public by design — so the CTA is a plain,
 * always-working navigation to Dodo's hosted checkout. Nothing to load, nothing
 * an ad blocker can break, and the buy button can never dead-end.
 *
 * The whole purchase flow: pay on Dodo → Dodo issues + emails the license key →
 * the user pastes it into the desktop app. No accounts, no server.
 *
 * Public config (safe in the client bundle — product ids are public):
 *   NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY
 *   NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL
 *   NEXT_PUBLIC_DODO_ENVIRONMENT   'live' (default) | 'test'
 */
import type { BillingCycle } from './pricing-types';

/** Hosted checkout hosts. `test` is the sandbox used with test-mode products. */
const CHECKOUT_HOST: Record<'live' | 'test', string> = {
  live: 'https://checkout.dodopayments.com',
  test: 'https://test.checkout.dodopayments.com',
};

export const DODO_ENVIRONMENT: 'live' | 'test' =
  process.env.NEXT_PUBLIC_DODO_ENVIRONMENT === 'test' ? 'test' : 'live';

export const DODO_PRODUCT_ID_BY_CYCLE: Record<BillingCycle, string> = {
  monthly: process.env.NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY ?? '',
  annual: process.env.NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL ?? '',
};

/** True when at least one cadence has a product id to check out against. */
export function isDodoConfigured(): boolean {
  return Boolean(DODO_PRODUCT_ID_BY_CYCLE.monthly || DODO_PRODUCT_ID_BY_CYCLE.annual);
}

export interface CheckoutOptions {
  /** Dodo product id; falls back to the configured id for `billingCycle`. */
  productId?: string;
  /** Which subscription cadence to buy. */
  billingCycle?: BillingCycle;
  /** Where Dodo returns the customer after paying. Defaults to `/thank-you/`. */
  redirectUrl?: string;
}

/**
 * The site origin used to build the post-payment redirect. Read from the build
 * env (not `window.location`) so the URL is identical during static export and
 * after hydration — a differing href would be a hydration mismatch.
 */
const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://framepilot.app';

/**
 * Build the Dodo hosted-checkout URL for a subscription product.
 * Throws when the build has no product id for that cadence, so the caller
 * ({@link BuyButton}) can surface a visible error instead of a dead click.
 */
export function checkoutUrl({
  productId,
  billingCycle = 'annual',
  redirectUrl,
}: CheckoutOptions = {}): string {
  const id = productId || DODO_PRODUCT_ID_BY_CYCLE[billingCycle];
  if (!id) {
    throw new Error(
      `Dodo checkout is not configured for the ${billingCycle} plan (missing NEXT_PUBLIC_DODO_PRODUCT_ID_${billingCycle === 'monthly' ? 'MONTHLY' : 'ANNUAL'} at build time).`,
    );
  }
  const params = new URLSearchParams({
    quantity: '1',
    redirect_url: redirectUrl ?? `${SITE_ORIGIN}/thank-you/`,
  });
  return `${CHECKOUT_HOST[DODO_ENVIRONMENT]}/buy/${encodeURIComponent(id)}?${params.toString()}`;
}

/** Send the browser to Dodo's hosted checkout for the given plan/cadence. */
export function openCheckout(options: CheckoutOptions = {}): void {
  window.location.href = checkoutUrl(options);
}
