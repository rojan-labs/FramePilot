/**
 * The run-level context ledger.
 *
 * The figures asserted here are the ones that were individually visible and collectively
 * invisible in captured run `e36235cc`: per request everything looked healthy (19k–42k of a
 * 128k window, nothing trimmed, nothing compacted), while the run as a whole assembled
 * 1,223,811 tokens across 52 calls with 60.2% of it tool definitions.
 */
import { describe, expect, it } from 'vitest';
import type { ContextManifest } from './manifest.js';
import { describeRunContext, summarizeRunContext } from './run-ledger.js';

const manifest = (
  requestId: string,
  sections: readonly [type: string, tokens: number, included?: boolean][],
  usage: Partial<ContextManifest['usage']> = {},
  compacted = false,
): ContextManifest =>
  ({
    requestId,
    provider: 'openrouter',
    model: 'openrouter/auto-beta',
    sections: sections.map(([type, tokenEstimate, included = true], index) => ({
      id: `s${String(index)}`,
      type,
      label: type,
      tokenEstimate,
      included,
    })),
    usage: {
      modelContextLimit: 128_000,
      limitAssumed: true,
      estimatedInputTokensBeforeSend: sections
        .filter(([, , included = true]) => included)
        .reduce((sum, [, tokens]) => sum + tokens, 0),
      reservedOutputTokens: 8_192,
      estimatedRemainingCapacity: 96_000,
      calculationSource: 'local_estimate',
      ...usage,
    },
    compaction: { occurred: compacted, removedTokenEstimate: 0, removedSections: [] },
  }) as ContextManifest;

describe('summarizeRunContext', () => {
  it('is all zeroes for a run that made no calls', () => {
    const ledger = summarizeRunContext([]);
    expect(ledger.modelCalls).toBe(0);
    expect(ledger.estimatedInputTokens).toBe(0);
    expect(ledger.toolSchemaShare).toBe(0);
    expect(ledger.byType).toEqual([]);
    expect(describeRunContext(ledger)).toBe('No model calls.');
  });

  it('collapses the duplicate manifest each request emits', () => {
    // A manifest is recorded before and after a send. Counting both would double the whole
    // ledger, which is worse than not having one.
    const one = manifest('r1', [['tool_schemas', 1_000]]);
    expect(summarizeRunContext([one, one, one]).modelCalls).toBe(1);
    expect(summarizeRunContext([one, one]).estimatedInputTokens).toBe(1_000);
  });

  it('sums what every call spent, and names the largest line', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [
        ['tool_schemas', 16_962],
        ['latest_user_message', 1_279],
        ['system', 135],
      ]),
      manifest('r2', [
        ['tool_schemas', 16_962],
        ['latest_user_message', 2_000],
        ['system', 135],
      ]),
    ]);
    expect(ledger.modelCalls).toBe(2);
    expect(ledger.estimatedInputTokens).toBe(37_473);
    expect(ledger.toolSchemaTokens).toBe(33_924);
    expect(ledger.toolSchemaShare).toBeCloseTo(0.905, 2);
    expect(ledger.byType[0]?.type).toBe('tool_schemas');
  });

  it('never counts a section the assembler dropped', () => {
    // An omitted block was not sent, so it was not paid for.
    const ledger = summarizeRunContext([
      manifest('r1', [
        ['tool_schemas', 1_000],
        ['retrieved_evidence', 9_000, false],
      ]),
    ]);
    expect(ledger.estimatedInputTokens).toBe(1_000);
  });

  it('counts tool-set churn and what it re-billed', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 16_962]], { toolSchemaTokensRebilled: 0 }),
      manifest('r2', [['tool_schemas', 12_263]], { toolSchemaTokensRebilled: 12_263 }),
      manifest('r3', [['tool_schemas', 12_263]], { toolSchemaTokensRebilled: 0 }),
      manifest('r4', [['tool_schemas', 13_663]], { toolSchemaTokensRebilled: 13_663 }),
    ]);
    expect(ledger.toolSchemaChanges).toBe(2);
    expect(ledger.toolSchemaTokensRebilled).toBe(25_926);
  });

  it('excludes a non-reporting provider from the cached share rather than scoring it zero', () => {
    // "Cannot report" and "did not hit" are different facts. The captured run's provider
    // reported no cache counts at all, and calling that a 0% hit rate would have invented a
    // measurement — the same rule `kernel/cost/run-metrics.ts` follows.
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 1_000]], { providerReportedInputTokens: 1_000 }),
      manifest('r2', [['tool_schemas', 1_000]], { providerReportedInputTokens: 1_000 }),
    ]);
    expect(ledger.cacheReportingRequests).toBe(0);
    expect(ledger.cachedInputShare).toBeUndefined();
    expect(describeRunContext(ledger)).toContain('cache not reported');
  });

  it('reports the cached share over the requests that reported one', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 1_000]], {
        providerReportedInputTokens: 1_000,
        cachedInputTokens: 800,
      }),
      manifest('r2', [['tool_schemas', 1_000]], {
        providerReportedInputTokens: 1_000,
        cachedInputTokens: 600,
      }),
    ]);
    expect(ledger.cacheReportingRequests).toBe(2);
    expect(ledger.cachedInputShare).toBeCloseTo(0.7, 5);
    expect(describeRunContext(ledger)).toContain('70% served from cache');
  });

  it('reports the peak window use, not the average', () => {
    // The captured run peaked at 33% — which is the point: it never came close to full, and
    // the cost was the number of rebuilds, not the size of any one.
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 20_000]]),
      manifest('r2', [['tool_schemas', 42_000]]),
      manifest('r3', [['tool_schemas', 19_000]]),
    ]);
    expect(ledger.peakWindowUtilisation).toBeCloseTo(42_000 / 128_000, 5);
  });

  it('prefers what the provider reported over what was estimated', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 20_000]], { providerReportedInputTokens: 64_000 }),
    ]);
    expect(ledger.peakWindowUtilisation).toBeCloseTo(0.5, 5);
    expect(ledger.reportedInputTokens).toBe(64_000);
  });

  it('counts the requests where a tier had to be dropped', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [['tool_schemas', 1_000]], {}, true),
      manifest('r2', [['tool_schemas', 1_000]], {}, false),
    ]);
    expect(ledger.compactedRequests).toBe(1);
  });

  it('counts a type once per request however many sections carry it', () => {
    const ledger = summarizeRunContext([
      manifest('r1', [
        ['conversation', 100],
        ['conversation', 200],
        ['conversation', 300],
      ]),
    ]);
    expect(ledger.byType[0]).toMatchObject({ type: 'conversation', tokens: 600, requests: 1 });
  });
});

describe('describeRunContext', () => {
  it('says the thing the per-request view could not', () => {
    // The shape of the sentence that was missing from the captured run.
    const line = describeRunContext(
      summarizeRunContext([
        manifest('r1', [
          ['tool_schemas', 16_962],
          ['latest_user_message', 5_000],
        ]),
        manifest('r2', [['tool_schemas', 12_263]], { toolSchemaTokensRebilled: 12_263 }),
      ]),
    );
    expect(line).toContain('2 model calls');
    expect(line).toContain('34,225 tokens assembled');
    expect(line).toContain('tool definitions 85% of it');
    expect(line).toContain('12,263 re-billed across 1 tool-set change(s)');
  });
});
