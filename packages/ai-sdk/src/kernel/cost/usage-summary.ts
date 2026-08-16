/**
 * @framepilot/ai-sdk/kernel/cost/usage-summary — creator-language usage surfacing (P7.2,
 * plan/AGENT-NATIVE-COMPLETION-PLAN.md P7.2, lens §2.5.6).
 *
 * `cost-meter.ts` prices a run in tokens/USD — an *engineering* instrument. The user must
 * never see that raw ledger by default: lens §2.5.6 is explicit that the token/$ readout
 * is not a creator-facing gauge. What the user sees is a short, honest phrase: "Instant ·
 * no AI needed" for a run that never called a model at all, or a
 * plain "AI edits used this session" for a run that spent real tokens. The raw numbers
 * are always attached (`raw`) so a dev/pro settings toggle can additionally show them —
 * off by default (P7.2's hard guardrail: no raw token/$ number in the default sidebar).
 *
 * WHY "this session", not "this month"/"on your plan": there is no real plan/billing/quota
 * concept anywhere in this codebase today (no `maxUsd`/`maxTokens` cap is wired to an
 * actual subscription tier) — inventing a monthly-limit framing here would be exactly the
 * kind of fabricated number this project's guardrails forbid. "This session" is the
 * honest scope: the sum of every run's cost since the app was opened, nothing more.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:kernel:cost:usage-summary');

/** A run's (or a session's) priced cost — the same shape as `GraphRunResult.cost`. */
export interface UsageCost {
  readonly tokens: number;
  readonly usd: number;
  /**
   * How many model calls the run made (see `UsageEvent.modelCalls`). `undefined` when
   * the emitter could not count them.
   */
  readonly modelCalls?: number;
}

/** The creator-facing summary of one run's usage, plus the raw numbers for a dev/pro toggle. */
export interface UsageSummary {
  /**
   * True only for a genuinely free run: no model call was made at all. A run that DID
   * call the model but whose provider reported no
   * usage is not instant, however much its `{tokens, usd}` look like zero.
   */
  readonly instant: boolean;
  /** The creator-language phrase the default sidebar renders — never a raw number. */
  readonly label: string;
  /**
   * The run really called the model, but no provider reported any token usage, so the
   * `{tokens, usd}` in `raw` are a floor, not a measurement. A dev/pro readout must say
   * so rather than print "0 tokens · $0.0000", which reads as a measured zero.
   */
  readonly usageUnknown: boolean;
  /**
   * The real `{tokens, usd}` this run cost, always present regardless of `instant` — a
   * dev/pro settings toggle reads this to show the engineering-instrument view. Never
   * rendered by default (P7.2's hard guardrail).
   */
  readonly raw: UsageCost;
}

/** Creator-language label for a run that made no model call at all. */
const INSTANT_LABEL = 'Instant · no AI needed';

/** Creator-language label for a run that spent real tokens — honestly session-scoped. */
const SESSION_USAGE_LABEL = 'AI edits used this session';

/**
 * Summarize one run's cost in creator language (P7.2). `sessionTotal`, when given, is the
 * running sum of every run's cost so far this session (accumulated by the caller — e.g.
 * the sidebar) — reserved for a future richer session-scoped phrase; today it changes
 * nothing about which label is chosen (a run's own cost alone decides `instant`), but is
 * threaded through so a caller can build a "N sessions' worth" style phrase later without
 * a signature change.
 *
 * ## Why a zero is not automatically "Instant"
 *
 * Cost alone cannot distinguish "this run never touched a model" from "this run called a
 * model that answered without a usage report". Both settle at `{tokens: 0, usd: 0}`, and
 * labelling the second one "Instant · no AI needed" is a false claim about a run the user
 * paid for — the exact bug users hit against OpenAI-compatible endpoints, which report
 * usage on a streamed call only when the request opts in (see `providers/openai-compatible.ts`).
 * `cost.modelCalls` is the discriminator: `0` (or a genuinely priced run) is trustworthy,
 * `> 0` with no tokens is an unknown, and `undefined` — an emitter that cannot count — is
 * treated as the old behaviour so no existing caller changes meaning.
 *
 * @param cost - This run's real `{tokens, usd}` (from `GraphRunResult.cost` or equivalent).
 * @param sessionTotal - The session's accumulated cost so far, including this run.
 */
export function summarizeUsage(cost: UsageCost, sessionTotal?: UsageCost): UsageSummary {
  const raw = sessionTotal ?? cost;
  const free = cost.usd === 0 && cost.tokens === 0;
  const usageUnknown = free && (cost.modelCalls ?? 0) > 0;
  if (free && !usageUnknown) {
    log.action('summarizeUsage → run-level usage', { instant: true, raw });
    return { instant: true, label: INSTANT_LABEL, usageUnknown: false, raw };
  }
  log.action('summarizeUsage → run-level usage', { instant: false, usageUnknown, raw });
  return { instant: false, label: SESSION_USAGE_LABEL, usageUnknown, raw };
}
