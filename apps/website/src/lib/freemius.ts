/**
 * Freemius Checkout overlay loader (client-side). Opening the overlay is the
 * entire "Get license key" flow: the user pays and Freemius shows + emails the
 * license key, which they paste into the desktop app. No accounts, no server.
 *
 * Public config (safe in the client bundle — product id + public key are
 * designed to be public; the secret key is NEVER used here):
 *   NEXT_PUBLIC_FREEMIUS_PRODUCT_ID
 *   NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY
 *   NEXT_PUBLIC_FREEMIUS_PLAN_ID_MONTHLY / _ANNUAL (fallback; plan cards
 *   normally pass their own cadence-specific id from live/generated pricing)
 */
import type { BillingCycle } from './pricing-types';

const CHECKOUT_SRC = 'https://checkout.freemius.com/checkout.min.js';

interface FreemiusCheckoutHandler {
  open: (options: Record<string, unknown>) => void;
  close: () => void;
}
interface FreemiusCheckoutCtor {
  new (config: Record<string, unknown>): FreemiusCheckoutHandler;
}
declare global {
  interface Window {
    FS?: { Checkout: FreemiusCheckoutCtor };
  }
}

export const FREEMIUS_PRODUCT_ID = process.env.NEXT_PUBLIC_FREEMIUS_PRODUCT_ID ?? '';
export const FREEMIUS_PUBLIC_KEY = process.env.NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY ?? '';
const FREEMIUS_PLAN_ID_BY_CYCLE: Record<BillingCycle, string> = {
  monthly: process.env.NEXT_PUBLIC_FREEMIUS_PLAN_ID_MONTHLY ?? '',
  annual: process.env.NEXT_PUBLIC_FREEMIUS_PLAN_ID_ANNUAL ?? '',
};

export function isFreemiusConfigured(): boolean {
  return Boolean(FREEMIUS_PRODUCT_ID && FREEMIUS_PUBLIC_KEY);
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.FS?.Checkout) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = CHECKOUT_SRC;
    el.async = true;
    el.onload = () => res();
    el.onerror = () => {
      scriptPromise = null;
      rej(new Error('Failed to load Freemius checkout'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export interface OpenCheckoutOptions {
  planId?: string;
  /** Which subscription cadence to pre-select in the overlay. */
  billingCycle?: BillingCycle;
  onComplete?: () => void;
}

/**
 * Build the URL of Freemius' **hosted** (full-page) checkout for a given plan —
 * the fallback when the in-page overlay can't run (script blocked by an ad/
 * privacy blocker, CDN failure, or `window.FS.Checkout` missing). Verified route
 * shape: `/product/{productId}/plan/{planId}/`; the page fills product + pricing
 * client-side. Without a plan id we drop to the product page (Freemius shows the
 * plan picker). `billing_cycle` pre-selects the cadence.
 */
export function hostedCheckoutUrl({
  planId,
  billingCycle = 'annual',
}: Pick<OpenCheckoutOptions, 'planId' | 'billingCycle'> = {}): string {
  const plan = planId || FREEMIUS_PLAN_ID_BY_CYCLE[billingCycle];
  const path = plan
    ? `/product/${FREEMIUS_PRODUCT_ID}/plan/${plan}/`
    : `/product/${FREEMIUS_PRODUCT_ID}/`;
  const params = new URLSearchParams({ billing_cycle: billingCycle });
  return `https://checkout.freemius.com${path}?${params.toString()}`;
}

/**
 * Open the Freemius checkout overlay for a FramePilot subscription. The
 * `billing_cycle` selects monthly vs. annual; Freemius issues the license key on
 * success.
 *
 * Failure handling:
 *  - **Not configured** (missing `NEXT_PUBLIC_FREEMIUS_*` — nothing to check out
 *    against): throw so the caller ({@link BuyButton}) surfaces a visible error
 *    instead of a silent dead click. (Previously it silently reloaded `/pricing`.)
 *  - **Overlay can't run** (script blocked/failed, or `FS.Checkout` missing):
 *    redirect to the {@link hostedCheckoutUrl hosted full-page checkout} so the
 *    CTA always reaches a real payment page rather than dead-ending.
 */
export async function openCheckout({
  planId,
  billingCycle = 'annual',
  onComplete,
}: OpenCheckoutOptions = {}) {
  if (!isFreemiusConfigured()) {
    throw new Error(
      'Freemius checkout is not configured (missing NEXT_PUBLIC_FREEMIUS_PRODUCT_ID / NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY at build time).',
    );
  }

  try {
    await loadScript();
    if (!window.FS?.Checkout) throw new Error('Freemius overlay unavailable');

    const handler = new window.FS.Checkout({
      product_id: FREEMIUS_PRODUCT_ID,
      public_key: FREEMIUS_PUBLIC_KEY,
      plan_id: planId || FREEMIUS_PLAN_ID_BY_CYCLE[billingCycle] || undefined,
    });

    handler.open({
      name: 'FramePilot',
      licenses: 1,
      // Subscription: 'monthly' | 'annual'. Freemius fires purchaseCompleted/success.
      billing_cycle: billingCycle,
      purchaseCompleted: () => onComplete?.(),
      success: () => {
        window.location.href = '/thank-you/';
      },
    });
    return;
  } catch (error) {
    // The overlay couldn't open (blocked/failed). Don't dead-end — send the user
    // to Freemius' hosted checkout page for the same plan/cadence.
    console.warn(
      '[framepilot] overlay checkout unavailable; redirecting to hosted checkout:',
      error,
    );
    window.location.href = hostedCheckoutUrl({ planId, billingCycle });
    return;
  }
}
