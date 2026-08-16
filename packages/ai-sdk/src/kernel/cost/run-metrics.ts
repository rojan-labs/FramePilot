/**
 * @framepilot/ai-sdk/kernel/cost/run-metrics — the M0.1 performance baseline.
 *
 * WHY: `plan/LANGCHAIN-MIGRATION.md` makes p50/p95 time-to-first-token, cost per
 * agent turn and prompt-cache hit rate the **acceptance budget for every phase**
 * of the migration ("no worse than baseline"). §12 records that no such baseline
 * exists in the repo — so every performance claim in that plan is a budget to be
 * measured, not a measurement. This module is the measuring instrument.
 *
 * It is deliberately **pure**: samples go in, statistics come out. No clock, no
 * I/O, no provider. The caller stamps timings (it owns the clock); this module
 * only aggregates. That keeps it table-testable with no mocks and keeps it
 * inside the 100%-coverage core that survives the migration (§5.2).
 *
 * Honest-degradation rule, carried from the provider layer: a sample whose
 * provider never reported cache counts is **excluded** from the cache-hit-rate
 * denominator rather than counted as a miss. A provider that cannot report is
 * not the same as a cache that did not hit, and conflating them would understate
 * the hit rate exactly when it matters (risk 3).
 */

/** One measured agent turn. Every field is observed, never estimated. */
export interface TurnSample {
  /** Milliseconds from request start to the first content chunk. */
  readonly ttftMs: number;
  /** Milliseconds from request start to the turn settling. */
  readonly wallMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Input tokens served from the prompt cache, when the provider reported it.
   * `undefined` means "not reported" and is excluded from cache statistics —
   * NOT treated as zero.
   */
  readonly cacheReadInputTokens?: number;
  /** Input tokens written to the cache this turn, when reported. */
  readonly cacheCreationInputTokens?: number;
  /** Observed USD cost for the turn, when the caller can price it. */
  readonly usd?: number;
}

/** Percentile summary of one measured dimension. */
export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

/** The aggregate M0.1 baseline over a set of turns. */
export interface RunMetricsSummary {
  readonly turnCount: number;
  readonly ttftMs: Percentiles;
  readonly wallMs: Percentiles;
  readonly inputTokensPerTurn: Percentiles;
  readonly outputTokensPerTurn: Percentiles;
  /** Present only when at least one sample carried a USD figure. */
  readonly usdPerTurn?: Percentiles;
  /**
   * Cached input tokens / total input tokens, over the samples whose provider
   * reported cache counts. `undefined` when no sample reported any — the honest
   * "we cannot tell" answer, which is what a baseline must record rather than
   * inventing a 0% that a later phase would then "match".
   */
  readonly cacheHitRate?: number;
  /** How many samples contributed to {@link cacheHitRate}. */
  readonly cacheReportingTurns: number;
}

/**
 * Nearest-rank percentile over an ascending-sorted list.
 *
 * Nearest-rank (rather than interpolation) is chosen so every reported value is
 * a real observed measurement — a p95 TTFT that no turn actually exhibited is a
 * poor gate to hold eleven phases of migration against.
 *
 * @param sorted - Ascending values; must be non-empty.
 * @param fraction - Percentile in 0..1.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] as number;
}

function summarize(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

/** Raised when asked to summarize nothing — an empty baseline is never valid. */
export class EmptyBaselineError extends Error {
  constructor() {
    super(
      'Cannot summarize an empty sample set. M0.1 requires >= 20 real desktop ' +
        'agent runs against desktop-scale media; an empty summary would read as ' +
        'a passing budget that nothing was ever measured against.',
    );
    this.name = 'EmptyBaselineError';
  }
}

/**
 * Aggregate measured turns into the M0.1 baseline.
 *
 * @param samples - Observed turns; must be non-empty.
 * @returns The percentile summary plus cache-hit rate.
 * @throws {EmptyBaselineError} when `samples` is empty.
 */
export function summarizeRunMetrics(samples: readonly TurnSample[]): RunMetricsSummary {
  if (samples.length === 0) throw new EmptyBaselineError();

  const priced = samples.filter((s) => s.usd !== undefined);
  // Only samples whose provider actually reported cache counts (see module note).
  // A type predicate, so the narrowing survives the filter and no unreachable
  // `?? 0` fallback is needed for a value this list cannot contain.
  const cacheReporting = samples.filter(
    (s): s is TurnSample & { readonly cacheReadInputTokens: number } =>
      s.cacheReadInputTokens !== undefined,
  );
  const cachedInput = cacheReporting.reduce((sum, s) => sum + s.cacheReadInputTokens, 0);
  // The denominator is `inputTokens + cacheReadInputTokens`, NOT `inputTokens`.
  // Anthropic's `input_tokens` counts only the NON-cached portion of the prompt,
  // so a well-cached turn reports a small `inputTokens` and a large
  // `cacheReadInputTokens`. Dividing by `inputTokens` alone would compute a rate
  // above 1.0 on exactly the runs caching hardest — reporting the metric as
  // healthiest precisely where it was most wrong.
  const totalInput = cacheReporting.reduce(
    (sum, s) => sum + s.inputTokens + s.cacheReadInputTokens,
    0,
  );

  return {
    turnCount: samples.length,
    ttftMs: summarize(samples.map((s) => s.ttftMs)),
    wallMs: summarize(samples.map((s) => s.wallMs)),
    inputTokensPerTurn: summarize(samples.map((s) => s.inputTokens)),
    outputTokensPerTurn: summarize(samples.map((s) => s.outputTokens)),
    ...(priced.length > 0 ? { usdPerTurn: summarize(priced.map((s) => s.usd as number)) } : {}),
    // A zero denominator means every reporting turn had zero input tokens —
    // degenerate, so report "cannot tell" rather than dividing by zero.
    ...(cacheReporting.length > 0 && totalInput > 0
      ? { cacheHitRate: cachedInput / totalInput }
      : {}),
    cacheReportingTurns: cacheReporting.length,
  };
}

/** The verdict of comparing a candidate against a recorded baseline. */
export interface BudgetVerdict {
  readonly withinBudget: boolean;
  /** Human-readable reasons a candidate regressed; empty when within budget. */
  readonly regressions: readonly string[];
}

/**
 * Check a candidate summary against the M0.1 budget: p50/p95 TTFT and cost per
 * turn no worse than baseline, and cache-hit rate no lower.
 *
 * `tolerance` allows for measurement noise (e.g. 0.05 = 5% worse is still a
 * pass). It exists because a strict comparison on real timings would flag noise
 * as regression every run; it is NOT a licence to drift, so it is an explicit
 * argument the caller must choose rather than a hidden default.
 *
 * A candidate that cannot report cache hits is NOT failed for it — the check
 * only fires when both sides measured it, so a provider gap never masquerades as
 * a cost regression.
 */
export function checkAgainstBudget(
  baseline: RunMetricsSummary,
  candidate: RunMetricsSummary,
  tolerance = 0,
): BudgetVerdict {
  const regressions: string[] = [];
  const worse = (a: number, b: number): boolean => a > b * (1 + tolerance);

  if (worse(candidate.ttftMs.p50, baseline.ttftMs.p50)) {
    regressions.push(
      `p50 TTFT ${String(candidate.ttftMs.p50)}ms exceeds baseline ${String(baseline.ttftMs.p50)}ms`,
    );
  }
  if (worse(candidate.ttftMs.p95, baseline.ttftMs.p95)) {
    regressions.push(
      `p95 TTFT ${String(candidate.ttftMs.p95)}ms exceeds baseline ${String(baseline.ttftMs.p95)}ms`,
    );
  }
  if (
    baseline.usdPerTurn !== undefined &&
    candidate.usdPerTurn !== undefined &&
    worse(candidate.usdPerTurn.p50, baseline.usdPerTurn.p50)
  ) {
    regressions.push(
      `p50 cost/turn $${candidate.usdPerTurn.p50.toFixed(4)} exceeds baseline ` +
        `$${baseline.usdPerTurn.p50.toFixed(4)}`,
    );
  }
  if (
    baseline.cacheHitRate !== undefined &&
    candidate.cacheHitRate !== undefined &&
    candidate.cacheHitRate < baseline.cacheHitRate * (1 - tolerance)
  ) {
    regressions.push(
      `prompt-cache hit rate ${(candidate.cacheHitRate * 100).toFixed(1)}% is below baseline ` +
        `${(baseline.cacheHitRate * 100).toFixed(1)}% — the risk-3 failure mode`,
    );
  }

  return { withinBudget: regressions.length === 0, regressions };
}
