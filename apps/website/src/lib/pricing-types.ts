/** Shared pricing types (kept separate so the generated file and the script can
 *  both import them without a cycle). */

/** The two billing cadences FramePilot subscriptions support. */
export type BillingCycle = 'monthly' | 'annual';

/** Subscription prices for a plan, in whole USD. */
export interface PlanPrice {
  /** Amount billed each month on the monthly plan. */
  monthly: number;
  /** Amount billed once per year on the annual plan. */
  annual: number;
}

export interface PricingPlan {
  /** Stable internal id. */
  id: string;
  name: string;
  tagline: string;
  /**
   * Freemius plan id used to open checkout, per billing cycle (resolved from
   * env/generated pricing at build). FramePilot's Pro plan is two separate
   * Freemius plans — "Pro Monthly" and "Pro Yearly" — so checkout needs the
   * id for whichever cadence the user picked, not one shared id.
   */
  freemiusPlanIds?: Partial<Record<BillingCycle, string>>;
  /** Subscription pricing (monthly + annual). `null` ⇒ contact/custom plan. */
  price: PlanPrice | null;
  currency: string;
  highlight?: boolean;
  badge?: string;
  cta: {
    label: string;
    /** `checkout` opens the Freemius overlay; `link` navigates. */
    kind: 'checkout' | 'link';
    href?: string;
  };
  features: string[];
}

/** Shape written by the build-time fetch (a price override per plan id). */
export interface GeneratedPricing {
  /** ISO timestamp the prices were fetched. */
  fetchedAt: string;
  currency: string;
  plans: Record<
    string,
    { price: PlanPrice | null; freemiusPlanIds?: Partial<Record<BillingCycle, string>> }
  >;
}
