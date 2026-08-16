/**
 * @framepilot/ai-sdk/kernel/cost-meter — token/$/op accounting for a run
 * (plan/AI-ORCHESTRATION-REDESIGN.md §19, Phase K4.3).
 *
 * This module is the budget meter's pricing brain: a **pure** ledger that prices each
 * model call by its {@link ModelTier} cost class and accumulates the run's spend (tokens,
 * USD, call count — overall and per class). Cost classes never select a provider.
 *
 * Separation of concerns (design tenet 5 — effects-as-data): this module only *prices and
 * tallies*; it never enforces. The {@link import('../scheduler.js').Scheduler} owns
 * enforcement — its {@link import('../scheduler.js').Budget} carries the `maxTokens`/`maxUsd`
 * caps and stops dispatching when a run reaches one. The driver bridges the two: it prices
 * a completed model call here, then folds the resulting spend into the scheduler via
 * `onTaskCompleted`. Keeping pricing pure means a run's cost is deterministic and replayable
 * (same recorded usage → same ledger), and the price table is kept separate from
 * execution policy.
 */
import { createLogger } from '@framepilot/shared-types';
import type { ModelTier } from '../proposers/types.js';

const log = createLogger('ai-sdk:kernel:cost:cost-meter');

/** The three tiers, in cost order (small → mid → large). */
const ALL_TIERS: readonly ModelTier[] = ['small', 'mid', 'large'];

/** Token usage of a single model call (prompt vs completion — they price differently). */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

/** USD price per **million** tokens, split input/output, for one tier. */
export interface TierPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * Default per-tier pricing (USD per million tokens). Conservative order-of-magnitude
 * list prices for the tiers' default models (haiku-class / sonnet-class / opus-class) —
 * the point is the *ratio* (large ≈ 15× small), which is what makes tier routing a real
 * cost lever. A deployment overrides this via the `prices` argument (e.g. sourced from
 * settings alongside the tier routing), so a price change is config, not code.
 */
export const DEFAULT_TIER_PRICING: Readonly<Record<ModelTier, TierPrice>> = {
  small: { inputPerMTok: 1, outputPerMTok: 5 },
  mid: { inputPerMTok: 3, outputPerMTok: 15 },
  large: { inputPerMTok: 15, outputPerMTok: 75 },
};

/**
 * Price a single model call in USD: `input × inputPerMTok + output × outputPerMTok`, per
 * million tokens. Pure — same usage + prices always yields the same dollar figure.
 */
export function estimateUsd(
  tier: ModelTier,
  usage: TokenUsage,
  prices: Readonly<Record<ModelTier, TierPrice>> = DEFAULT_TIER_PRICING,
): number {
  const price = prices[tier];
  const usd = (usage.input * price.inputPerMTok + usage.output * price.outputPerMTok) / 1_000_000;
  log.debug('estimateUsd → priced', { tier, input: usage.input, output: usage.output, usd });
  return usd;
}

/** Per-tier spend within a ledger. */
export interface TierSpend {
  readonly tokens: number;
  readonly usd: number;
  readonly calls: number;
}

/**
 * A running tally of a run's model spend — the cost meter's state. Immutable: each
 * {@link recordCost} returns a new ledger, so a run's cost history is a fold over its
 * recorded calls (replayable, tenet 6).
 */
export interface CostLedger {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  /** Number of model calls priced into this ledger. */
  readonly calls: number;
  /** Spend attributed to each tier (where the routing/cost win shows up). */
  readonly byTier: Readonly<Record<ModelTier, TierSpend>>;
}

const emptyTierSpend = (): TierSpend => ({ tokens: 0, usd: 0, calls: 0 });

/** A fresh, zeroed ledger (a run's starting cost state). */
export function emptyLedger(): CostLedger {
  return {
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
    calls: 0,
    byTier: { small: emptyTierSpend(), mid: emptyTierSpend(), large: emptyTierSpend() },
  };
}

/** Total tokens (input + output) recorded in a ledger — the scheduler's token budget axis. */
export function totalTokens(ledger: CostLedger): number {
  return ledger.inputTokens + ledger.outputTokens;
}

/**
 * Fold one model call's usage into the ledger: accrue tokens + USD overall and against the
 * call's {@link ModelTier}. Returns a new ledger (never mutates). Pass the same `prices`
 * used for enforcement so the tally and the budget agree.
 */
export function recordCost(
  ledger: CostLedger,
  tier: ModelTier,
  usage: TokenUsage,
  prices: Readonly<Record<ModelTier, TierPrice>> = DEFAULT_TIER_PRICING,
): CostLedger {
  const usd = estimateUsd(tier, usage, prices);
  const tokens = usage.input + usage.output;
  const prev = ledger.byTier[tier];
  log.debug('recordCost → folded into ledger', {
    tier,
    tokens,
    usd,
    runningTotalUsd: ledger.usd + usd,
  });
  return {
    inputTokens: ledger.inputTokens + usage.input,
    outputTokens: ledger.outputTokens + usage.output,
    usd: ledger.usd + usd,
    calls: ledger.calls + 1,
    byTier: {
      ...ledger.byTier,
      [tier]: { tokens: prev.tokens + tokens, usd: prev.usd + usd, calls: prev.calls + 1 },
    },
  };
}

/**
 * The share of a run's dollar spend that went to each tier (0–1, summing to 1 for a
 * non-empty ledger; all-zero for an empty one). This is the observable that tells you
 * whether tier routing is actually working — a healthy run spends most calls on `small`
 * and only occasionally reaches for `large` (§19.7).
 */
export function tierUsdShare(ledger: CostLedger): Readonly<Record<ModelTier, number>> {
  const total = ledger.usd;
  const share = {} as Record<ModelTier, number>;
  for (const tier of ALL_TIERS) {
    share[tier] = total > 0 ? ledger.byTier[tier].usd / total : 0;
  }
  return share;
}
