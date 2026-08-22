import type { BillingCycle, PlanPrice, PricingPlan } from './pricing-types';
import { GENERATED_PRICING } from './pricing.generated';

export type { BillingCycle, PlanPrice, PricingPlan };

/**
 * Typed fallback pricing. FramePilot is a subscription — $25/month or $199/year
 * (billed annually). These defaults are OVERRIDDEN at build time by the live
 * Freemius price (see `pricing.generated.ts`) so production always shows the real
 * number. Edit here to change the offline/default value.
 */
const FALLBACK_PLANS: PricingPlan[] = [
  {
    id: 'pro',
    name: 'FramePilot',
    tagline: 'The whole editor, one subscription.',
    freemiusPlanIds: {
      monthly: process.env.NEXT_PUBLIC_FREEMIUS_PLAN_ID_MONTHLY,
      annual: process.env.NEXT_PUBLIC_FREEMIUS_PLAN_ID_ANNUAL,
    },
    price: { monthly: 25, annual: 199 },
    currency: 'USD',
    highlight: true,
    badge: 'Most popular',
    cta: { label: 'Start editing', kind: 'checkout' },
    features: [
      'A real multi-track timeline with trim, ripple, razor, and keyframes',
      'Agent edits arrive as typed patches you undo in one click',
      'Auto captions, silence removal, pacing fixes, hooks, and shorts',
      'A render engine that validates its own output before you see it',
      'Export presets for 9:16 Reels, 1:1, 16:9, and custom sizes',
      'An MCP server, so Cursor, Claude, and Codex can drive edits',
      'Local-first, so your media never leaves your machine',
      'New AI tools and updates for as long as you subscribe',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    tagline: 'For teams and agencies.',
    price: null,
    currency: 'USD',
    cta: {
      label: 'Contact sales',
      kind: 'link',
      href: 'mailto:hello@framepilot.app?subject=FramePilot%20Studio',
    },
    features: [
      'Everything in FramePilot',
      'Volume licensing and central seat management',
      'Priority support with an SLA',
      'Private onboarding and workflow setup',
      'Security and procurement review',
      'Invoicing and custom terms',
    ],
  },
];

/** Merge the live/generated prices over the typed fallback. */
export function getPlans(): PricingPlan[] {
  const gen = GENERATED_PRICING;
  if (!gen) return FALLBACK_PLANS;
  return FALLBACK_PLANS.map((plan) => {
    const override = gen.plans[plan.id];
    if (!override) return plan;
    return {
      ...plan,
      price: override.price ?? plan.price,
      freemiusPlanIds: override.freemiusPlanIds ?? plan.freemiusPlanIds,
    };
  });
}

/** The amount charged per billing cycle. */
export function priceFor(price: PlanPrice, cycle: BillingCycle): number {
  return cycle === 'monthly' ? price.monthly : price.annual;
}

/**
 * The effective per-month cost when paying annually, rounded to cents. Used to
 * show honest "$X/mo billed yearly" copy on the annual toggle.
 */
export function effectiveMonthly(price: PlanPrice): number {
  return Math.round((price.annual / 12) * 100) / 100;
}

/**
 * Whole-percent saving of the annual plan vs. paying monthly for a year.
 * Returns 0 when annual isn't actually cheaper (so we never fake a discount).
 */
export function annualSavingsPercent(price: PlanPrice): number {
  const yearlyIfMonthly = price.monthly * 12;
  if (yearlyIfMonthly <= 0 || price.annual >= yearlyIfMonthly) return 0;
  return Math.round((1 - price.annual / yearlyIfMonthly) * 100);
}

/** Format a USD amount, dropping trailing `.00` cents. */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}
