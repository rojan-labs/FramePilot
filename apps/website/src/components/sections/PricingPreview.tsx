'use client';

import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { Section } from '@/components/Section';
import { BillingToggle } from '@/components/BillingToggle';
import { BuyButton } from '@/components/BuyButton';
import type { BillingCycle, PricingPlan } from '@/lib/pricing-types';
import { annualSavingsPercent, effectiveMonthly, formatUsd } from '@/lib/pricing';

export function PricingPreview({ plan }: { plan: PricingPlan | null }) {
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  if (!plan || plan.price == null) return null;

  const savings = annualSavingsPercent(plan.price);
  const perMonth = cycle === 'annual' ? effectiveMonthly(plan.price) : plan.price.monthly;

  return (
    <Section id="pricing-preview" className="bg-white">
      <div className="grid gap-12 lg:grid-cols-[0.82fr_1.18fr] lg:gap-20">
        <div className="max-w-lg">
          <p className="eyebrow-tc mb-5">Pricing</p>
          <h2 className="text-[length:var(--text-h2)] leading-[var(--text-h2--line-height)] tracking-[var(--text-h2--letter-spacing)]">
            One editor. One subscription.
          </h2>
          <p className="mt-5 text-[15px] leading-7 text-fg-secondary">
            No per-export meter. The timeline and supported agent workflow are the product.
          </p>
        </div>

        <div className="border-t border-line">
          <div className="flex flex-col gap-5 border-b border-line py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[15px] font-semibold">FramePilot {plan.name}</p>
              <p className="mt-1 text-[12px] text-fg-tertiary">{plan.tagline}</p>
            </div>
            <BillingToggle cycle={cycle} onChange={setCycle} savingsPercent={savings} />
          </div>

          <div className="grid gap-8 py-7 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-10">
            <div>
              <div className="flex items-end gap-2">
                <span className="font-display text-[54px] font-semibold leading-none tracking-[-0.055em] tabular">
                  {formatUsd(perMonth)}
                </span>
                <span className="pb-1 text-[11px] text-fg-tertiary">/ month</span>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-fg-muted">
                {cycle === 'annual' ? `Billed ${formatUsd(plan.price.annual)} yearly` : 'Billed monthly'}
              </p>
              <BuyButton planId={plan.freemiusPlanIds?.[cycle]} billingCycle={cycle} className="mt-5" />
            </div>

            <div>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {plan.features.slice(0, 6).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 border-b border-line-subtle py-3 text-[12.5px] leading-5 text-fg-secondary">
                    <Check size={12} className="mt-1 shrink-0 text-accent" aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
              <a href="/pricing" className="mt-5 inline-flex items-center gap-2 text-[12.5px] font-semibold text-fg">
                Full pricing details
                <ArrowRight size={13} aria-hidden />
              </a>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
