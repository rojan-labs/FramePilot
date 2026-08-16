'use client';

import type { BillingCycle } from '@/lib/pricing-types';

export function BillingToggle({
  cycle,
  onChange,
  savingsPercent,
}: {
  cycle: BillingCycle;
  onChange: (cycle: BillingCycle) => void;
  savingsPercent: number;
}) {
  return (
    <div className="inline-flex items-center gap-4 text-[12px]">
      <div role="tablist" aria-label="Billing cycle" className="inline-flex items-center gap-4">
        <button
          type="button"
          role="tab"
          aria-selected={cycle === 'monthly'}
          onClick={() => onChange('monthly')}
          className={`border-b pb-1 transition-colors ${cycle === 'monthly' ? 'border-fg text-fg' : 'border-transparent text-fg-tertiary hover:text-fg'}`}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={cycle === 'annual'}
          onClick={() => onChange('annual')}
          className={`border-b pb-1 transition-colors ${cycle === 'annual' ? 'border-fg text-fg' : 'border-transparent text-fg-tertiary hover:text-fg'}`}
        >
          Annual
        </button>
      </div>
      {savingsPercent > 0 && <span className="text-[10px] text-accent">Save {savingsPercent}%</span>}
    </div>
  );
}
