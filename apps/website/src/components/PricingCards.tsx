'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import type { BillingCycle, PricingPlan } from '@/lib/pricing-types';
import { annualSavingsPercent, effectiveMonthly, formatUsd } from '@/lib/pricing';
import { BillingToggle } from './BillingToggle';
import { BuyButton } from './BuyButton';
import { Button } from './Button';

export function PricingCards({ plans }: { plans: PricingPlan[] }) {
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const priced = plans.find((plan) => plan.price != null)?.price ?? null;
  const savings = priced ? annualSavingsPercent(priced) : 0;

  return (
    <div>
      <div className="mb-8">
        <BillingToggle cycle={cycle} onChange={setCycle} savingsPercent={savings} />
      </div>

      <div className="grid border-t border-line md:grid-cols-2">
        {plans.map((plan, index) => (
          <Plan key={plan.id} plan={plan} cycle={cycle} separated={index > 0} />
        ))}
      </div>

      <p className="mt-6 text-[11px] leading-5 text-fg-muted">
        Prices in USD. Secure checkout and licensing by Freemius. 14-day money-back guarantee.
      </p>
    </div>
  );
}

function Plan({ plan, cycle, separated }: { plan: PricingPlan; cycle: BillingCycle; separated: boolean }) {
  const isContact = plan.price == null;

  return (
    <article className={`border-b border-line py-8 md:px-8 md:py-10 ${separated ? 'md:border-l' : 'md:pl-0'} ${!separated ? 'md:pr-12' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-[30px] font-semibold tracking-[-0.04em]">{plan.name}</h2>
          <p className="mt-1 text-[12.5px] text-fg-secondary">{plan.tagline}</p>
        </div>
        {plan.badge && <span className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-accent">{plan.badge}</span>}
      </div>

      <div className="mt-8 min-h-[82px]">
        {isContact || !plan.price ? (
          <>
            <p className="font-display text-[48px] font-semibold leading-none tracking-[-0.05em]">Custom</p>
            <p className="mt-2 text-[11px] text-fg-muted">Volume licensing</p>
          </>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <span className="font-display text-[56px] font-semibold leading-none tracking-[-0.055em] tabular">
                {formatUsd(cycle === 'annual' ? effectiveMonthly(plan.price) : plan.price.monthly)}
              </span>
              <span className="pb-1 text-[11px] text-fg-tertiary">/ month</span>
            </div>
            <p className="mt-2 text-[11px] text-fg-muted">
              {cycle === 'annual' ? `Billed ${formatUsd(plan.price.annual)} yearly` : 'Billed monthly. Cancel anytime.'}
            </p>
          </>
        )}
      </div>

      <div className="mt-6">
        {plan.cta.kind === 'checkout' ? (
          <BuyButton
            planId={plan.freemiusPlanIds?.[cycle]}
            billingCycle={cycle}
            label={plan.cta.label}
            variant={plan.highlight ? 'primary' : 'secondary'}
          />
        ) : (
          <Button href={plan.cta.href ?? '#'} variant={plan.highlight ? 'primary' : 'secondary'}>
            {plan.cta.label}
          </Button>
        )}
      </div>

      <ul className="mt-8 border-t border-line-subtle">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 border-b border-line-subtle py-3 text-[12.5px] leading-5 text-fg-secondary">
            <Check size={12} className="mt-1 shrink-0 text-accent" aria-hidden />
            {feature}
          </li>
        ))}
      </ul>
    </article>
  );
}
