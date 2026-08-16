import { describe, expect, it } from 'vitest';
import {
  EmptyBaselineError,
  checkAgainstBudget,
  summarizeRunMetrics,
  type RunMetricsSummary,
  type TurnSample,
} from './run-metrics.js';

const sample = (over: Partial<TurnSample> = {}): TurnSample => ({
  ttftMs: 100,
  wallMs: 1000,
  inputTokens: 1000,
  outputTokens: 100,
  ...over,
});

describe('summarizeRunMetrics', () => {
  it('refuses to summarize an empty sample set', () => {
    // An empty summary would read as a passing budget nothing was measured against.
    expect(() => summarizeRunMetrics([])).toThrow(EmptyBaselineError);
  });

  it('reports nearest-rank percentiles that are real observations', () => {
    const samples = [10, 20, 30, 40, 100].map((ttftMs) => sample({ ttftMs }));
    const summary = summarizeRunMetrics(samples);
    expect(summary.turnCount).toBe(5);
    expect(summary.ttftMs.min).toBe(10);
    expect(summary.ttftMs.max).toBe(100);
    // Nearest-rank: every reported value is a value some turn actually produced.
    expect(samples.map((s) => s.ttftMs)).toContain(summary.ttftMs.p50);
    expect(samples.map((s) => s.ttftMs)).toContain(summary.ttftMs.p95);
    expect(summary.ttftMs.p50).toBe(30);
    expect(summary.ttftMs.p95).toBe(100);
  });

  it('summarizes a single sample without collapsing', () => {
    const summary = summarizeRunMetrics([sample({ ttftMs: 42, wallMs: 99 })]);
    expect(summary.ttftMs).toEqual({ p50: 42, p95: 42, min: 42, max: 42 });
    expect(summary.wallMs.p50).toBe(99);
  });

  it('summarizes token dimensions independently', () => {
    const summary = summarizeRunMetrics([
      sample({ inputTokens: 100, outputTokens: 5 }),
      sample({ inputTokens: 900, outputTokens: 50 }),
    ]);
    expect(summary.inputTokensPerTurn.max).toBe(900);
    expect(summary.outputTokensPerTurn.min).toBe(5);
  });

  it('omits cost when no sample carried a USD figure', () => {
    expect(summarizeRunMetrics([sample()]).usdPerTurn).toBeUndefined();
  });

  it('summarizes cost over only the priced samples', () => {
    const summary = summarizeRunMetrics([sample({ usd: 0.02 }), sample()]);
    expect(summary.usdPerTurn).toEqual({ p50: 0.02, p95: 0.02, min: 0.02, max: 0.02 });
  });

  it('excludes non-reporting providers from the cache denominator', () => {
    // One turn reported; the other never did. Counting the silent one as a miss
    // would halve the rate for a reason that has nothing to do with caching.
    const summary = summarizeRunMetrics([
      sample({ inputTokens: 1000, cacheReadInputTokens: 500 }),
      sample({ inputTokens: 1000 }),
    ]);
    expect(summary.cacheReportingTurns).toBe(1);
    expect(summary.cacheHitRate).toBeCloseTo(500 / 1500);
  });

  it('counts cached tokens as part of the total prompt, not on top of it', () => {
    // Anthropic's `input_tokens` is the NON-cached portion, so the denominator is
    // input + cacheRead. Dividing by `inputTokens` alone would report >100% on a
    // heavily-cached turn — healthiest exactly where it was most wrong.
    const summary = summarizeRunMetrics([sample({ inputTokens: 100, cacheReadInputTokens: 900 })]);
    expect(summary.cacheHitRate).toBeCloseTo(0.9);
    expect(summary.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it('reports "cannot tell" rather than 0% when nothing reported cache counts', () => {
    const summary = summarizeRunMetrics([sample()]);
    expect(summary.cacheHitRate).toBeUndefined();
    expect(summary.cacheReportingTurns).toBe(0);
  });

  it('distinguishes a measured zero hit rate from an unreported one', () => {
    const summary = summarizeRunMetrics([sample({ inputTokens: 1000, cacheReadInputTokens: 0 })]);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.cacheReportingTurns).toBe(1);
  });

  it('avoids dividing by zero when reporting turns had no input tokens', () => {
    const summary = summarizeRunMetrics([sample({ inputTokens: 0, cacheReadInputTokens: 0 })]);
    expect(summary.cacheHitRate).toBeUndefined();
    expect(summary.cacheReportingTurns).toBe(1);
  });

  it('carries cache-creation counts through without affecting the hit rate', () => {
    const summary = summarizeRunMetrics([
      sample({ inputTokens: 1000, cacheReadInputTokens: 250, cacheCreationInputTokens: 750 }),
    ]);
    expect(summary.cacheHitRate).toBeCloseTo(250 / 1250);
  });
});

describe('checkAgainstBudget', () => {
  const baseline = summarizeRunMetrics([
    sample({ ttftMs: 100, usd: 0.01, inputTokens: 1000, cacheReadInputTokens: 800 }),
  ]);

  it('passes an identical candidate', () => {
    const verdict = checkAgainstBudget(baseline, baseline);
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.regressions).toEqual([]);
  });

  it('flags a p50 and p95 TTFT regression', () => {
    const candidate = summarizeRunMetrics([sample({ ttftMs: 400 })]);
    const verdict = checkAgainstBudget(baseline, candidate);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.regressions.join(' ')).toContain('p50 TTFT');
    expect(verdict.regressions.join(' ')).toContain('p95 TTFT');
  });

  it('absorbs noise within an explicit tolerance', () => {
    const candidate = summarizeRunMetrics([sample({ ttftMs: 104 })]);
    expect(checkAgainstBudget(baseline, candidate, 0.05).withinBudget).toBe(true);
    expect(checkAgainstBudget(baseline, candidate, 0).withinBudget).toBe(false);
  });

  it('flags a cost-per-turn regression', () => {
    const candidate = summarizeRunMetrics([sample({ ttftMs: 100, usd: 0.05 })]);
    const verdict = checkAgainstBudget(baseline, candidate);
    expect(verdict.regressions.join(' ')).toContain('cost/turn');
  });

  it('flags a prompt-cache hit-rate drop as the risk-3 failure mode', () => {
    const candidate = summarizeRunMetrics([
      sample({ ttftMs: 100, usd: 0.01, inputTokens: 1000, cacheReadInputTokens: 100 }),
    ]);
    const verdict = checkAgainstBudget(baseline, candidate);
    expect(verdict.regressions.join(' ')).toContain('prompt-cache hit rate');
    expect(verdict.regressions.join(' ')).toContain('risk-3');
  });

  it('does not fail a candidate merely for not reporting cache or cost', () => {
    // A provider gap must never masquerade as a cost regression.
    const candidate = summarizeRunMetrics([sample({ ttftMs: 100 })]);
    expect(checkAgainstBudget(baseline, candidate).withinBudget).toBe(true);
  });

  it('does not fail when the baseline itself lacks cost and cache figures', () => {
    const bare: RunMetricsSummary = summarizeRunMetrics([sample({ ttftMs: 100 })]);
    const candidate = summarizeRunMetrics([
      sample({ ttftMs: 100, usd: 9, cacheReadInputTokens: 0 }),
    ]);
    expect(checkAgainstBudget(bare, candidate).withinBudget).toBe(true);
  });
});
