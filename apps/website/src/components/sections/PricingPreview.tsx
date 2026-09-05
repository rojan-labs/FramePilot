'use client';

import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { Section, SectionHeading } from '@/components/Section';
import { BillingToggle } from '@/components/BillingToggle';
import { BuyButton } from '@/components/BuyButton';
import { Ruler } from '@/components/timeline/Ruler';
import type { BillingCycle, PricingPlan } from '@/lib/pricing-types';
import { annualSavingsPercent, effectiveMonthly, formatUsd } from '@/lib/pricing';

/**
 * Pricing as a single clip filling the whole track: there is one thing to buy,
 * and it runs the length of the sequence. No tiers to compare, no meter.
 */
export function PricingPreview({ plan }: { plan: PricingPlan | null }) {
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  if (!plan || plan.price == null) return null;

  const savings = annualSavingsPercent(plan.price);
  const perMonth = cycle === 'annual' ? effectiveMonthly(plan.price) : plan.price.monthly;

  return (
    <Section id="pricing-preview">
      <SectionHeading
        tc="00:04"
        eyebrow="Pricing"
        title="One clip. One price."
        description="No per-export meter, no credits to top up. You pay for the editor."
      />

      <div className="mt-12 sm:mt-14">
        <div className="flex items-baseline gap-3">
          <span className="tc tabular text-fg-muted">P1</span>
          <span className="tc text-fg-tertiary">Runs the full length of the project</span>
        </div>

        <Ruler className="mt-3" />

        {/* The clip itself: full-width, one colour, priced on the right. */}
        <div className="lane mt-4 p-1.5">
          <div className="flex flex-col gap-4 rounded-[3px] bg-fg px-5 py-5 text-canvas sm:flex-row sm:items-center sm:justify-between sm:py-4">
            <div>
              <p className="font-display text-[19px] font-semibold tracking-[-0.03em]">
                FramePilot {plan.name}
              </p>
              <p className="mt-0.5 text-[12.5px] text-canvas/55">{plan.tagline}</p>
            </div>
            <div className="flex items-end gap-2">
              <span className="font-display text-[46px] font-semibold leading-none tracking-[-0.05em] tabular text-accent">
                {formatUsd(perMonth)}
              </span>
              <span className="pb-1 text-[11.5px] text-canvas/50">/ month</span>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-10 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-16">
          <div>
            <BillingToggle cycle={cycle} onChange={setCycle} savingsPercent={savings} />
            <p className="mt-3 text-[12px] text-fg-tertiary">
              {cycle === 'annual'
                ? `Billed ${formatUsd(plan.price.annual)} yearly`
                : 'Billed monthly. Cancel anytime.'}
            </p>
            <BuyButton planId={plan.freemiusPlanIds?.[cycle]} billingCycle={cycle} className="mt-5" />
          </div>

          <div>
            <ul className="grid gap-x-8 sm:grid-cols-2">
              {plan.features.slice(0, 6).map((feature) => (
                <li key={feature}>
                  <Ruler />
                  <span className="flex items-start gap-2.5 py-3 text-[12.5px] leading-5 text-fg-secondary">
                    <Check size={12} className="mt-1 shrink-0 text-accent" aria-hidden />
                    {feature}
                  </span>
                </li>
              ))}
            </ul>
            <a
              href="/pricing"
              className="mt-6 inline-flex items-center gap-2 text-[12.5px] font-semibold text-fg underline decoration-accent underline-offset-4"
            >
              Full pricing details
              <ArrowRight size={13} aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </Section>
  );
}
