/**
 * @framepilot/ai-sdk/kernel/context/run-ledger — what a whole RUN spent on context.
 *
 * ## Why this exists
 *
 * Every number here was already being recorded per request, in
 * {@link ContextManifest}, and nothing ever added them up. That gap is not cosmetic — it
 * is why a genuinely expensive run reads as a healthy one.
 *
 * In captured run `e36235cc` every single manifest looked fine: 19,051–41,990 estimated
 * input tokens against a 128,000 window, peaking at 33% used, `compaction.occurred` false
 * on all 105 of them. Nothing grew, nothing was trimmed, nothing overflowed. The run made
 * **52 model calls** and assembled **1,223,811 tokens**, of which **736,595 (60.2%) were
 * tool definitions** — re-sent whole on every call — and **115,967 were re-billed at full
 * price** because the advertised tool set changed nine times mid-run. The per-request
 * instrument (`toolSchemaTokensRebilled`, context-management P5.3) had measured that
 * last figure correctly on every call. No reader summed it.
 *
 * The editor's own description of the symptom was exact: *"context seems less on the UI
 * but actually context is increasing at a very high rate."* Context per call was not
 * increasing. It was being rebuilt, in full, fifty-two times.
 *
 * ## What it deliberately does not do
 *
 * No clock, no I/O, no provider, no estimation of its own — manifests in, arithmetic out,
 * the same discipline as `kernel/cost/run-metrics.ts`. And the same honest-degradation
 * rule: a request whose provider never reported cache counts is EXCLUDED from the cached
 * share rather than counted as a miss, because "cannot report" and "did not hit" are not
 * the same fact and conflating them understates the rate exactly when it matters.
 */
import type { ContextManifest } from './manifest.js';

/** One line of the ledger: a section type and what the whole run spent on it. */
export interface LedgerLine {
  readonly type: string;
  readonly tokens: number;
  /** Share of total assembled input, 0–1. */
  readonly share: number;
  /** Requests that included at least one section of this type. */
  readonly requests: number;
}

/** What a run spent assembling context, across every model call it made. */
export interface RunContextLedger {
  readonly modelCalls: number;
  /** Sum of every included section's estimate, across every request. */
  readonly estimatedInputTokens: number;
  /** Sum of provider-reported input, over the requests that reported it. */
  readonly reportedInputTokens?: number;
  /** Cached input / reported input, over requests whose provider reported cache counts. */
  readonly cachedInputShare?: number;
  /** Requests whose provider reported cache counts at all. */
  readonly cacheReportingRequests: number;
  /** Tool-schema tokens across the run, and their share of everything assembled. */
  readonly toolSchemaTokens: number;
  readonly toolSchemaShare: number;
  /**
   * Tool-schema tokens re-billed because the advertised set changed since the previous
   * request, and how many times it changed. A stable set is `0` changes.
   */
  readonly toolSchemaTokensRebilled: number;
  readonly toolSchemaChanges: number;
  /** Highest single-request window utilisation, 0–1. The "is it nearly full?" number. */
  readonly peakWindowUtilisation: number;
  /** Requests where the assembler had to drop a tier to fit. */
  readonly compactedRequests: number;
  /** Every section type, largest spend first. */
  readonly byType: readonly LedgerLine[];
}

/** Included sections only: an omitted block was never sent and was never paid for. */
function includedTokens(manifest: ContextManifest): number {
  return manifest.sections
    .filter((section) => section.included)
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
}

function tokensOfType(manifest: ContextManifest, type: string): number {
  return manifest.sections
    .filter((section) => section.included && section.type === type)
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
}

/**
 * Add up what a run spent on context.
 *
 * @param manifests - Every request's manifest, in the order the requests were made.
 *   Duplicates by `requestId` are collapsed (a manifest is emitted both before and after a
 *   send, and counting both would double every figure in this ledger).
 * @returns The run-level account. An empty input yields a ledger of zeroes rather than
 *   `undefined`, so a caller rendering a summary never has to branch.
 */
export function summarizeRunContext(manifests: readonly ContextManifest[]): RunContextLedger {
  const unique = new Map<string, ContextManifest>();
  for (const manifest of manifests) {
    if (!unique.has(manifest.requestId)) unique.set(manifest.requestId, manifest);
  }
  const requests = [...unique.values()];

  let estimatedInputTokens = 0;
  let reportedInput = 0;
  let reportedInputRequests = 0;
  let cachedInput = 0;
  let cacheReportingRequests = 0;
  let toolSchemaTokens = 0;
  let toolSchemaTokensRebilled = 0;
  let toolSchemaChanges = 0;
  let peakWindowUtilisation = 0;
  let compactedRequests = 0;
  const byType = new Map<string, { tokens: number; requests: number }>();

  for (const manifest of requests) {
    estimatedInputTokens += includedTokens(manifest);
    toolSchemaTokens += tokensOfType(manifest, 'tool_schemas');

    const { usage } = manifest;
    if (usage.providerReportedInputTokens !== undefined) {
      reportedInput += usage.providerReportedInputTokens;
      reportedInputRequests += 1;
      if (usage.cachedInputTokens !== undefined) {
        cachedInput += usage.cachedInputTokens;
        cacheReportingRequests += 1;
      }
    }
    const rebilled = usage.toolSchemaTokensRebilled;
    if (rebilled !== undefined && rebilled > 0) {
      toolSchemaTokensRebilled += rebilled;
      toolSchemaChanges += 1;
    }
    if (usage.modelContextLimit > 0) {
      const used = usage.providerReportedInputTokens ?? usage.estimatedInputTokensBeforeSend;
      peakWindowUtilisation = Math.max(peakWindowUtilisation, used / usage.modelContextLimit);
    }
    if (manifest.compaction.occurred) compactedRequests += 1;

    const countedTypes = new Set<string>();
    for (const section of manifest.sections) {
      if (!section.included) continue;
      const line = byType.get(section.type) ?? { tokens: 0, requests: 0 };
      line.tokens += section.tokenEstimate;
      if (!countedTypes.has(section.type)) {
        line.requests += 1;
        countedTypes.add(section.type);
      }
      byType.set(section.type, line);
    }
  }

  const share = (tokens: number): number =>
    estimatedInputTokens === 0 ? 0 : tokens / estimatedInputTokens;

  return {
    modelCalls: requests.length,
    estimatedInputTokens,
    ...(reportedInputRequests > 0 ? { reportedInputTokens: reportedInput } : {}),
    // Denominator is the reported input of the CACHE-REPORTING requests only. Dividing by
    // every request's input would dilute the rate with requests that could never have
    // contributed a hit — the same conflation `run-metrics.ts` refuses.
    ...(cacheReportingRequests > 0 && reportedInput > 0
      ? { cachedInputShare: cachedInput / reportedInput }
      : {}),
    cacheReportingRequests,
    toolSchemaTokens,
    toolSchemaShare: share(toolSchemaTokens),
    toolSchemaTokensRebilled,
    toolSchemaChanges,
    peakWindowUtilisation,
    compactedRequests,
    byType: [...byType.entries()]
      .map(([type, line]) => ({
        type,
        tokens: line.tokens,
        share: share(line.tokens),
        requests: line.requests,
      }))
      .sort((left, right) => right.tokens - left.tokens),
  };
}

/**
 * The ledger as the two or three lines worth saying out loud at the end of a run.
 *
 * Written for the person paying for it, not for a dashboard: the figures that were
 * individually visible and collectively invisible.
 */
export function describeRunContext(ledger: RunContextLedger): string {
  if (ledger.modelCalls === 0) return 'No model calls.';
  const pct = (value: number): string => `${String(Math.round(value * 100))}%`;
  const parts = [
    `${String(ledger.modelCalls)} model calls · ` +
      `${ledger.estimatedInputTokens.toLocaleString('en-US')} tokens assembled`,
    `tool definitions ${pct(ledger.toolSchemaShare)} of it`,
  ];
  if (ledger.toolSchemaChanges > 0) {
    parts.push(
      `${ledger.toolSchemaTokensRebilled.toLocaleString('en-US')} re-billed across ` +
        `${String(ledger.toolSchemaChanges)} tool-set change(s)`,
    );
  }
  if (ledger.cachedInputShare !== undefined) {
    parts.push(`${pct(ledger.cachedInputShare)} served from cache`);
  } else {
    // Said plainly rather than shown as 0%: an unreported cache is not a cold one, and a
    // provider path that silently ignores the cache breakpoint looks identical to one that
    // honours it until someone asks this question.
    parts.push('cache not reported by this provider');
  }
  parts.push(`peak window use ${pct(ledger.peakWindowUtilisation)}`);
  return parts.join(' · ');
}
