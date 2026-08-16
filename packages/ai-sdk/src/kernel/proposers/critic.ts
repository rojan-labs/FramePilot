/**
 * @framepilot/ai-sdk/kernel/proposers/critic — the Critic / Verifier proposer
 * (plan/AI-ORCHESTRATION-REDESIGN.md §6, line 184 "KEEP, PROMOTE", Phase K3.3).
 *
 * The verify-phase proposer (§6 roster). Unlike the other three it is **deterministic
 * first**: its {@link CriticInput} — working project + goal + render validation — runs
 * through the existing pure {@link critique} battery (`src/critic.ts`), producing
 * {@link Finding}s without any model call. This is the promotion the plan asks for: the
 * Critic becomes a scheduled `verify` proposer instead of a post-hoc afterthought, but its
 * trust core stays plain code (a misbehaving model can never talk it into approving a
 * broken edit — the same reason `critic.ts` is LLM-free).
 *
 * The optional "LLM judgment" the §6 table mentions is a *separate, additive* seam
 * ({@link buildJudgmentRequest}/{@link parseJudgment}) at the small tier — subjective
 * findings ("the pacing feels uneven") the deterministic checks can't express. Those
 * findings are advisory (`source: 'judgment'`) and never flip the deterministic `ok`
 * verdict. Pure + stateless throughout.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import {
  type CheckStatus,
  type CriticCheck,
  type CritiqueOptions,
  critique,
} from '../../critic.js';
import { CRITIC_JUDGMENT_SYSTEM_PROMPT } from '../../prompts.js';
import {
  type ModelTier,
  type ProposerResult,
  parseJsonResponse,
  proposerModelEffect,
} from './types.js';

const log = createLogger('ai-sdk:kernel:proposers:critic');

/** Severity of a {@link Finding}, one-to-one with the Critic's {@link CheckStatus}. */
export type FindingSeverity = CheckStatus;

/** One verify finding. Deterministic findings carry a stable check id (§8.6). */
export interface Finding {
  readonly id: string;
  readonly label: string;
  readonly severity: FindingSeverity;
  readonly detail: string;
  /** `deterministic` (the `critique` battery) or `judgment` (optional LLM advice). */
  readonly source: 'deterministic' | 'judgment';
}

/** The Critic proposer's verdict: the findings plus the deterministic pass/fail. */
export interface CriticReport {
  readonly findings: readonly Finding[];
  /** True when no *deterministic* finding is a `fail` (warnings/judgment don't block). */
  readonly ok: boolean;
  readonly summary: string;
}

/** Bounded input to the Critic (§6 roster): working project + goal + render validation. */
export interface CriticInput {
  readonly project: Project;
  /** Goal/target + optional render-validation facts (the same shape `critique` takes). */
  readonly options?: CritiqueOptions;
}

/** Map a deterministic {@link CriticCheck} to a {@link Finding}. */
function toFinding(check: CriticCheck): Finding {
  return {
    id: check.id,
    label: check.label,
    severity: check.status,
    detail: check.detail,
    source: 'deterministic',
  };
}

/**
 * Run the deterministic verify battery (no model call). Reuses {@link critique} verbatim
 * — the Critic proposer is a thin, schema-shaped promotion of the existing reviewer.
 */
export function runCritic(input: CriticInput): CriticReport {
  const report = critique(input.project, input.options ?? {});
  log.action('runCritic → verdict', {
    ok: report.ok,
    checks: report.checks.length,
    failing: report.checks.filter((c) => c.status === 'fail').length,
  });
  return {
    findings: report.checks.map(toFinding),
    ok: report.ok,
    summary: report.summary,
  };
}

// --- optional LLM judgment seam (small tier, advisory) --------------------------------

const JudgmentFindingSchema = z.object({
  label: z.string().min(1),
  severity: z.enum(['pass', 'warn', 'fail', 'skipped']),
  detail: z.string().min(1),
});

/** The optional judgment call's output schema (advisory subjective findings). */
export const JudgmentSchema = z.object({
  findings: z.array(JudgmentFindingSchema),
});

/** Bounded input to the optional judgment call: the goal + a compact project summary. */
export interface CriticJudgmentInput {
  /** The user's goal/request the edit should satisfy. */
  readonly goal: string;
  /** A compact, model-facing description of the edited result (e.g. an index summary). */
  readonly summary: string;
}

// The prompt text lives in prompts.ts (the single home for model-facing prompts).
const JUDGMENT_SYSTEM = CRITIC_JUDGMENT_SYSTEM_PROMPT;

/** Build the inert judgment {@link ModelEffect} (small tier). Advisory, never blocking. */
export function buildJudgmentRequest(
  input: CriticJudgmentInput,
): ReturnType<typeof proposerModelEffect> {
  log.action('buildJudgmentRequest → critic judgment', { goal: input.goal, tier: 'small' });
  return proposerModelEffect(JUDGMENT_SYSTEM, `Goal: ${input.goal}\nResult: ${input.summary}`, {
    tier: 'small',
  });
}

/** Validate the optional judgment reply into advisory {@link Finding}s (`source: 'judgment'`). */
export function parseJudgment(raw: string): ProposerResult<readonly Finding[]> {
  const parsed = parseJsonResponse(raw, JudgmentSchema);
  if (!parsed.ok) {
    log.warn('parseJudgment ← critic judgment rejected', { error: parsed.error });
    return parsed;
  }
  const findings: Finding[] = parsed.value.findings.map((f, i) => ({
    id: `judgment_${String(i + 1)}`,
    label: f.label,
    severity: f.severity,
    detail: f.detail,
    source: 'judgment',
  }));
  log.action('parseJudgment ← critic judgment parsed', { findings: findings.length });
  return { ok: true, value: findings };
}

/**
 * The Critic / Verifier proposer. `tier: 'small'` per §6 ("small + deterministic") — the
 * trust core ({@link runCritic}) needs no model; the small tier applies only to the
 * optional {@link buildJudgmentRequest} advisory pass.
 */
export const critic: {
  readonly name: string;
  readonly tier: ModelTier;
  readonly run: typeof runCritic;
  readonly buildJudgmentRequest: typeof buildJudgmentRequest;
  readonly parseJudgment: typeof parseJudgment;
} = {
  name: 'critic',
  tier: 'small',
  run: runCritic,
  buildJudgmentRequest,
  parseJudgment,
};
