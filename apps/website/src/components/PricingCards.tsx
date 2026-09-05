'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import type { BillingCycle, PricingPlan } from '@/lib/pricing-types';
import { annualSavingsPercent, effectiveMonthly, formatUsd } from '@/lib/pricing';
import { Ruler } from './timeline/Ruler';
import { BillingToggle } from './BillingToggle';
import { BuyButton } from './BuyButton';
import { Button } from './Button';

/**
 * The plans as clips on a track rather than a pair of cards: the paid plan runs
 * the length of the sequence and everything else is measured against it.
 */
export function PricingCards({ plans }: { plans: PricingPlan[] }) {
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const priced = plans.find((plan) => plan.price != null)?.price ?? null;
  const savings = priced ? annualSavingsPercent(priced) : 0;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <span className="tc text-fg-tertiary">P1 · Plans</span>
        <BillingToggle cycle={cycle} onChange={setCycle} savingsPercent={savings} />
      </div>

      <div className="mt-4 space-y-8">
        {plans.map((plan, index) => (
          <Plan key={plan.id} plan={plan} cycle={cycle} slot={`0${index + 1}`} />
        ))}
      </div>

      <Ruler className="mt-10" />
      <p className="pt-4 text-[12px] leading-5 text-fg-muted">
        Prices in USD. Secure checkout and licensing by Freemius. 14-day money-back guarantee.
      </p>
    </div>
  );
}

function Plan({ plan, cycle, slot }: { plan: PricingPlan; cycle: BillingCycle; slot: string }) {
  const isContact = plan.price == null;

  return (
    <article>
      <Ruler />
      <div className="lane mt-3 p-1.5">
        <div
          className={`flex flex-col gap-5 rounded-[3px] px-5 py-5 sm:flex-row sm:items-center sm:justify-between ${
            isContact
              ? 'border border-line-strong bg-elevated text-fg'
              : 'bg-fg text-canvas'
          }`}
          /* The paid plan runs the whole track; volume licensing is a shorter clip. */
          style={{ width: isContact ? '62%' : '100%', minWidth: 280 }}
        >
          <div>
            <div className="flex items-center gap-3">
              <span className={`tc ${isContact ? 'text-fg-muted' : 'text-canvas/45'}`}>{slot}</span>
              <h2 className="font-display text-[22px] font-semibold tracking-[-0.035em]">
                {plan.name}
              </h2>
              {plan.badge && <span className="tc text-accent">{plan.badge}</span>}
            </div>
            <p className={`mt-1 text-[12.5px] ${isContact ? 'text-fg-secondary' : 'text-canvas/55'}`}>
              {plan.tagline}
            </p>
          </div>

          {isContact || !plan.price ? (
            <div className="sm:text-right">
              <p className="font-display text-[34px] font-semibold leading-none tracking-[-0.045em]">
                Custom
              </p>
              <p className="mt-1.5 text-[11.5px] text-fg-tertiary">Volume licensing</p>
            </div>
          ) : (
            <div className="sm:text-right">
              <div className="flex items-end gap-2 sm:justify-end">
                <span className="font-display text-[46px] font-semibold leading-none tracking-[-0.05em] tabular text-accent">
                  {formatUsd(cycle === 'annual' ? effectiveMonthly(plan.price) : plan.price.monthly)}
                </span>
                <span className="pb-1 text-[11.5px] text-canvas/50">/ month</span>
              </div>
              <p className="mt-1.5 text-[11.5px] text-canvas/45">
                {cycle === 'annual'
                  ? `Billed ${formatUsd(plan.price.annual)} yearly`
                  : 'Billed monthly. Cancel anytime.'}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-14">
        <div>
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

        <ul className="grid gap-x-10 sm:grid-cols-2">
          {plan.features.map((feature) => (
            <li key={feature}>
              <Ruler />
              <span className="flex items-start gap-2.5 py-3 text-[12.5px] leading-5 text-fg-secondary">
                <Check size={12} className="mt-1 shrink-0 text-accent" aria-hidden />
                {feature}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
