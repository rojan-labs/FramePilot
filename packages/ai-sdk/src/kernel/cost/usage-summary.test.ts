/**
 * Tests for `summarizeUsage` (P7.2 creator-language usage surfacing). The hard product
 * guardrail: `label` must NEVER contain a raw token/$ number — only `raw` may, and only a
 * dev/pro settings toggle in the host app renders it.
 */
import { describe, expect, it } from 'vitest';
import { summarizeUsage } from './usage-summary.js';

/** `label` must never smuggle in a digit — the hard "no raw numbers by default" guardrail. */
const containsDigit = (s: string): boolean => /\d/.test(s);

describe('summarizeUsage', () => {
  it('reports a zero-cost run (a recipe) as instant, in creator language', () => {
    const summary = summarizeUsage({ tokens: 0, usd: 0 });
    expect(summary.instant).toBe(true);
    expect(summary.label).toBe('Instant · no AI needed');
    expect(containsDigit(summary.label)).toBe(false);
  });

  it('reports a real-cost run honestly as session-scoped usage, never "this month"', () => {
    const summary = summarizeUsage({ tokens: 500, usd: 0.02 });
    expect(summary.instant).toBe(false);
    expect(summary.label).toBe('AI edits used this session');
    expect(summary.label.toLowerCase()).not.toContain('month');
    expect(summary.label.toLowerCase()).not.toContain('plan');
    expect(containsDigit(summary.label)).toBe(false);
  });

  it('always attaches the real numbers via `raw`, for a dev/pro toggle to render', () => {
    const summary = summarizeUsage({ tokens: 500, usd: 0.02 });
    expect(summary.raw).toEqual({ tokens: 500, usd: 0.02 });
    const instantSummary = summarizeUsage({ tokens: 0, usd: 0 });
    expect(instantSummary.raw).toEqual({ tokens: 0, usd: 0 });
  });

  it('threads a session total into `raw` when given, honestly scoped as "this session"', () => {
    const summary = summarizeUsage({ tokens: 500, usd: 0.02 }, { tokens: 1500, usd: 0.09 });
    expect(summary.raw).toEqual({ tokens: 1500, usd: 0.09 });
    // The label still describes creator language, not a number.
    expect(containsDigit(summary.label)).toBe(false);
  });

  it('a zero-cost run stays instant even inside a session that has spent real money before it', () => {
    const summary = summarizeUsage({ tokens: 0, usd: 0 }, { tokens: 1500, usd: 0.09 });
    expect(summary.instant).toBe(true);
    expect(summary.label).toBe('Instant · no AI needed');
  });

  // The bug this guards: an OpenAI-compatible provider that streams without reporting
  // usage settles a real, many-turn agent run at {tokens: 0, usd: 0}. Reading that as
  // "Instant · no AI needed" tells the user a run they paid for was free.
  it('does NOT call a run instant when it made model calls but reported no usage', () => {
    const summary = summarizeUsage({ tokens: 0, usd: 0, modelCalls: 7 });
    expect(summary.instant).toBe(false);
    expect(summary.usageUnknown).toBe(true);
    expect(summary.label).toBe('AI edits used this session');
  });

  it('flags a genuinely free run as neither instant-unknown nor spent', () => {
    const summary = summarizeUsage({ tokens: 0, usd: 0, modelCalls: 0 });
    expect(summary.instant).toBe(true);
    expect(summary.usageUnknown).toBe(false);
  });

  it('treats a priced run as known usage even when a call count is present', () => {
    const summary = summarizeUsage({ tokens: 500, usd: 0.02, modelCalls: 3 });
    expect(summary.instant).toBe(false);
    expect(summary.usageUnknown).toBe(false);
  });

  it('keeps the pre-existing meaning when no call count is reported at all', () => {
    expect(summarizeUsage({ tokens: 0, usd: 0 }).instant).toBe(true);
    expect(summarizeUsage({ tokens: 0, usd: 0 }).usageUnknown).toBe(false);
  });
});
