'use client';

import { KeyRound } from 'lucide-react';
import { checkoutUrl } from '@/lib/dodo';
import type { BillingCycle } from '@/lib/pricing-types';
import { Button } from './Button';

/**
 * Subscription CTA — a real link to Dodo Payments' hosted checkout for the given
 * cadence.
 *
 * WHY a link and not a scripted overlay: the site is a static export, so the
 * checkout URL is fully known at build time. A link works with middle-click and
 * "open in new tab", needs no third-party script (nothing for a blocker to
 * break), and cannot dead-end. A misconfigured build (no product id for this
 * cadence) is the one failure left, and it is shown here rather than swallowed.
 */
export function BuyButton({
  productId,
  billingCycle = 'annual',
  label = 'Start editing',
  size = 'lg',
  variant = 'primary',
  className = '',
}: {
  productId?: string;
  billingCycle?: BillingCycle;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  let href: string | null = null;
  try {
    href = checkoutUrl({ productId, billingCycle });
  } catch (error) {
    console.error('[framepilot] checkout is not configured:', error);
  }

  if (!href) {
    return (
      <div className={className}>
        <Button size={size} variant={variant} className="w-full" disabled>
          <KeyRound size={size === 'lg' ? 18 : 16} />
          {label}
        </Button>
        <p className="mt-2 text-[13px] text-danger" role="alert">
          Checkout is temporarily unavailable. Please email{' '}
          <a className="underline" href="mailto:hello@framepilot.app?subject=FramePilot%20checkout">
            hello@framepilot.app
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <Button size={size} variant={variant} className="w-full" href={href} external={false}>
        <KeyRound size={size === 'lg' ? 18 : 16} />
        {label}
      </Button>
    </div>
  );
}
