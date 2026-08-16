'use client';

import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { openCheckout } from '@/lib/freemius';
import type { BillingCycle } from '@/lib/pricing-types';
import { Button } from './Button';

/** Subscription CTA — opens the Freemius checkout overlay for the given cadence. */
export function BuyButton({
  planId,
  billingCycle = 'annual',
  label = 'Start editing',
  size = 'lg',
  variant = 'primary',
  className = '',
}: {
  planId?: string;
  billingCycle?: BillingCycle;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className={className}>
      <Button
        size={size}
        variant={variant}
        className="w-full"
        onClick={async () => {
          setLoading(true);
          setError(false);
          try {
            await openCheckout({ planId, billingCycle });
          } catch (err) {
            // A misconfigured build (missing NEXT_PUBLIC_FREEMIUS_* at build time)
            // or a blocked/failed overlay script lands here. Surface it loudly
            // instead of a silent dead click, and leave a console breadcrumb.
            console.error('[framepilot] checkout failed to open:', err);
            setError(true);
          } finally {
            setLoading(false);
          }
        }}
        aria-busy={loading}
      >
        {loading ? (
          <Loader2 size={size === 'lg' ? 18 : 16} className="animate-spin" />
        ) : (
          <KeyRound size={size === 'lg' ? 18 : 16} />
        )}
        {label}
      </Button>
      {error && (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          Checkout is temporarily unavailable. Please try again, or email{' '}
          <a className="underline" href="mailto:hello@framepilot.app?subject=FramePilot%20checkout">
            hello@framepilot.app
          </a>
          .
        </p>
      )}
    </div>
  );
}
