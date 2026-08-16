/**
 * FramePilot 9.5 Phase-0 agent-run quality telemetry.
 *
 * This is an observer over existing run events and provider-call samples. It never applies
 * edits, changes routing, retries work or decides whether a run may commit. Missing evidence
 * stays `undefined` instead of being converted into a fabricated zero/pass.
 */
import type { AiEvent, RunStatus } from './events.js';
import type { CapturedTurn } from './kernel/cost/baseline-capture.js';
import type { AgentOutcomeEvalScenario, AgentOutcomeEvalTier } from './professional-agent-evals.js';

export type AgentRunRouteMode =
  | 'agent'
  | 'planned-edit'
  | 'direct_edit'
  | 'browser_edit'
  | 'auto'
  | 'question'
  | 'unknown';

export type EvidenceOutcome = 'passed' | 'failed' | 'not_run' | 'unavailable';
export type ValidationOutcome = 'passed' | 'failed' | 'not_run';

export interface AgentRunModelIdentity {
  readonly provider: string;
  readonly modelId?: string;
}

export interface AgentRunTokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface AgentRunOperationCounts {
  readonly attempted: number;
  readonly applied: number;
  readonly rejected: number;
}

export interface AgentRunRevisionRange {
  readonly before?: number;
  readonly after?: number;
}

export interface AgentRunCancellationMetric {
  readonly state: 'not_cancelled' | 'cancelled';
  /** Milliseconds from the cancellation request to terminal cancellation, when observed. */
  readonly latencyMs?: number;
}

/** Every Phase-0 metric requested by FRAMEPILOT-95-CONVERGENCE-ROADMAP.md §5.3. */
export interface AgentRunQualityMetrics {
  readonly routeMode: AgentRunRouteMode;
  readonly models: readonly AgentRunModelIdentity[];
  readonly modelCallCount: number;
  readonly toolSchemasExposedPerTurn: readonly number[];
  readonly toolCallCount: number;
  readonly invalidMalformedCallCount: number;
  readonly duplicateRedundantCallCount: number;
  readonly cacheMemoHitCount: number;
  readonly tokens: AgentRunTokenUsage;
  readonly wallClockMs?: number;
  readonly analysisReviewMs?: number;
  readonly operations: AgentRunOperationCounts;
  readonly revisions: AgentRunRevisionRange;
  readonly reviewFindingCount: number;
  readonly repairAttemptCount: number;
  readonly cancellation: AgentRunCancellationMetric;
  readonly runOutcome?: RunStatus;
  readonly deterministicValidation: ValidationOutcome;
  readonly renderEvidence: EvidenceOutcome;
  /** 0..1. Absent unless an editor/human sample was actually scored. */
  readonly humanEditorialScore?: number;
}

export interface CaptureAgentRunQualityInput {
  readonly routeMode: AgentRunRouteMode;
  readonly events: readonly AiEvent[];
  readonly capturedTurns?: readonly CapturedTurn[];
  readonly toolSchemasExposedPerTurn?: readonly number[];
  readonly invalidMalformedCallCount?: number;
  readonly duplicateRedundantCallCount?: number;
  readonly memoHitCount?: number;
  readonly operations?: Partial<AgentRunOperationCounts>;
  readonly projectRevisionBefore?: number;
  readonly projectRevisionAfter?: number;
  readonly repairAttemptCount?: number;
  readonly cancellationLatencyMs?: number;
  readonly deterministicValidation?: ValidationOutcome;
  readonly renderEvidence?: EvidenceOutcome;
  readonly humanEditorialScore?: number;
  /** Override when analysis/review work happens outside the AiEvent timestamp envelope. */
  readonly analysisReviewMs?: number;
}

function nonNegative(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : value;
}

function latestTerminalStatus(events: readonly AiEvent[]): RunStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === 'status' &&
      (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')
    ) {
      return event.status;
    }
  }
  return undefined;
}

function wallClockMs(events: readonly AiEvent[]): number | undefined {
  if (events.length < 2) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    min = Math.min(min, event.ts);
    max = Math.max(max, event.ts);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? Math.max(0, max - min) : undefined;
}

/**
 * Approximate only the event-visible analysis/review interval. Callers with host-side review
 * timings should pass `analysisReviewMs`, which takes precedence over this projection.
 */
function eventVisibleAnalysisReviewMs(events: readonly AiEvent[]): number | undefined {
  const relevant = events.filter(
    (event) => event.type === 'reasoning' || event.type === 'review_finding',
  );
  if (relevant.length < 2) return undefined;
  const timestamps = relevant.map((event) => event.ts);
  return Math.max(...timestamps) - Math.min(...timestamps);
}

function distinctModels(turns: readonly CapturedTurn[]): readonly AgentRunModelIdentity[] {
  const seen = new Set<string>();
  const models: AgentRunModelIdentity[] = [];
  for (const turn of turns) {
    const key = `${turn.provider}\u0000${turn.modelId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider: turn.provider, ...(turn.modelId ? { modelId: turn.modelId } : {}) });
  }
  return models;
}

/**
 * Project the existing event/provider trace into the complete Phase-0 metric record.
 * The function is pure and serializable so eval outputs can persist it directly.
 */
export function captureAgentRunQuality(input: CaptureAgentRunQualityInput): AgentRunQualityMetrics {
  const turns = input.capturedTurns ?? [];
  const uniqueToolCalls = new Set(
    input.events.filter((event) => event.type === 'tool_call').map((event) => event.id),
  );
  const providerCacheHits = turns.filter((turn) => (turn.cacheReadInputTokens ?? 0) > 0).length;
  const inputTokens = turns.reduce((sum, turn) => sum + nonNegative(turn.inputTokens), 0);
  const outputTokens = turns.reduce((sum, turn) => sum + nonNegative(turn.outputTokens), 0);
  const runOutcome = latestTerminalStatus(input.events);
  const reviewFindingIds = new Set(
    input.events.filter((event) => event.type === 'review_finding').map((event) => event.id),
  );
  const operations = input.operations ?? {};
  const humanEditorialScore = input.humanEditorialScore;
  const measuredWallClockMs = wallClockMs(input.events);
  const measuredAnalysisReviewMs =
    input.analysisReviewMs ?? eventVisibleAnalysisReviewMs(input.events);
  if (
    humanEditorialScore !== undefined &&
    (!Number.isFinite(humanEditorialScore) || humanEditorialScore < 0 || humanEditorialScore > 1)
  ) {
    throw new RangeError('humanEditorialScore must be between 0 and 1 when supplied.');
  }

  return {
    routeMode: input.routeMode,
    models: distinctModels(turns),
    modelCallCount: turns.length,
    toolSchemasExposedPerTurn: [...(input.toolSchemasExposedPerTurn ?? [])].map(nonNegative),
    toolCallCount: uniqueToolCalls.size,
    invalidMalformedCallCount: nonNegative(input.invalidMalformedCallCount),
    duplicateRedundantCallCount: nonNegative(input.duplicateRedundantCallCount),
    cacheMemoHitCount: providerCacheHits + nonNegative(input.memoHitCount),
    tokens: { input: inputTokens, output: outputTokens },
    ...(measuredWallClockMs !== undefined ? { wallClockMs: measuredWallClockMs } : {}),
    ...(measuredAnalysisReviewMs !== undefined
      ? { analysisReviewMs: measuredAnalysisReviewMs }
      : {}),
    operations: {
      attempted: nonNegative(operations.attempted),
      applied: nonNegative(operations.applied),
      rejected: nonNegative(operations.rejected),
    },
    revisions: {
      ...(input.projectRevisionBefore !== undefined ? { before: input.projectRevisionBefore } : {}),
      ...(input.projectRevisionAfter !== undefined ? { after: input.projectRevisionAfter } : {}),
    },
    reviewFindingCount: reviewFindingIds.size,
    repairAttemptCount: nonNegative(input.repairAttemptCount),
    cancellation: {
      state: runOutcome === 'cancelled' ? 'cancelled' : 'not_cancelled',
      ...(runOutcome === 'cancelled' && input.cancellationLatencyMs !== undefined
        ? { latencyMs: nonNegative(input.cancellationLatencyMs) }
        : {}),
    },
    ...(runOutcome ? { runOutcome } : {}),
    deterministicValidation: input.deterministicValidation ?? 'not_run',
    renderEvidence: input.renderEvidence ?? 'not_run',
    ...(humanEditorialScore !== undefined ? { humanEditorialScore } : {}),
  };
}

export interface AgentOutcomePredicateObservation {
  readonly predicate: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface AgentOutcomeEvalRunRecord {
  readonly scenarioId: string;
  readonly tier: AgentOutcomeEvalTier;
  readonly status: 'passed' | 'failed';
  readonly hardConstraints: readonly AgentOutcomePredicateObservation[];
  readonly finalStatePredicates: readonly AgentOutcomePredicateObservation[];
  readonly failures: readonly string[];
  readonly metrics: AgentRunQualityMetrics;
}

export interface BuildAgentOutcomeEvalRunRecordInput {
  readonly scenario: AgentOutcomeEvalScenario;
  readonly hardConstraints: readonly AgentOutcomePredicateObservation[];
  readonly finalStatePredicates: readonly AgentOutcomePredicateObservation[];
  readonly metrics: AgentRunQualityMetrics;
}

function observationFailures(
  expected: readonly string[],
  observed: readonly AgentOutcomePredicateObservation[],
  label: string,
): readonly string[] {
  const byPredicate = new Map(observed.map((entry) => [entry.predicate, entry] as const));
  const failures: string[] = [];
  for (const predicate of expected) {
    const observation = byPredicate.get(predicate);
    if (!observation) {
      failures.push(`${label} was not evaluated: ${predicate}`);
    } else if (!observation.passed) {
      failures.push(`${label} failed: ${predicate}${observation.detail ? ` (${observation.detail})` : ''}`);
    }
  }
  return failures;
}

/** Grade hard constraints before semantic outcome predicates, matching the roadmap order. */
export function buildAgentOutcomeEvalRunRecord(
  input: BuildAgentOutcomeEvalRunRecordInput,
): AgentOutcomeEvalRunRecord {
  const hardFailures = observationFailures(
    input.scenario.expectedHardConstraints,
    input.hardConstraints,
    'Hard constraint',
  );
  const outcomeFailures = observationFailures(
    input.scenario.expectedFinalStatePredicates,
    input.finalStatePredicates,
    'Final-state predicate',
  );
  const failures = [...hardFailures, ...outcomeFailures];
  if (input.metrics.deterministicValidation === 'failed') {
    failures.push('Deterministic validation failed.');
  }
  if (input.scenario.reviewExpected && input.metrics.renderEvidence === 'failed') {
    failures.push('Required render/media evidence failed.');
  }
  return {
    scenarioId: input.scenario.id,
    tier: input.scenario.tier,
    status: failures.length === 0 ? 'passed' : 'failed',
    hardConstraints: [...input.hardConstraints],
    finalStatePredicates: [...input.finalStatePredicates],
    failures,
    metrics: input.metrics,
  };
}

/** Stable eval artifact payload. No clock is injected, so identical evidence diffs cleanly. */
export function serializeAgentOutcomeEvalRunRecords(
  records: readonly AgentOutcomeEvalRunRecord[],
): string {
  return `${JSON.stringify([...records].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)), null, 2)}\n`;
}

export interface PercentilePair {
  readonly p50?: number;
  readonly p95?: number;
}

export interface AgentOutcomeTopLineScore {
  readonly tierSuccessRate: Readonly<Record<AgentOutcomeEvalTier, number | undefined>>;
  readonly latencyMs: PercentilePair;
  readonly toolCalls: PercentilePair;
  readonly revisionRate: number | undefined;
  readonly cancellationIntegrity: number | undefined;
  readonly renderValidity: number | undefined;
}

function percentilePair(values: readonly number[]): PercentilePair {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    const rank = Math.max(1, Math.ceil(fraction * sorted.length));
    return sorted[Math.min(rank - 1, sorted.length - 1)] as number;
  };
  return { p50: at(0.5), p95: at(0.95) };
}

/** Top-line score used to compare later convergence phases against the frozen Foundation run. */
export function summarizeAgentOutcomeRuns(
  records: readonly AgentOutcomeEvalRunRecord[],
): AgentOutcomeTopLineScore {
  const tierSuccessRate = Object.fromEntries(
    (['A', 'B', 'C', 'D', 'E'] as const).map((tier) => {
      const tierRecords = records.filter((record) => record.tier === tier);
      return [
        tier,
        tierRecords.length === 0
          ? undefined
          : tierRecords.filter((record) => record.status === 'passed').length / tierRecords.length,
      ];
    }),
  ) as Readonly<Record<AgentOutcomeEvalTier, number | undefined>>;
  const withRevisions = records.filter(
    (record) => record.metrics.revisions.before !== undefined && record.metrics.revisions.after !== undefined,
  );
  const revised = withRevisions.filter(
    (record) => record.metrics.revisions.after !== record.metrics.revisions.before,
  ).length;
  const cancelled = records.filter((record) => record.metrics.cancellation.state === 'cancelled');
  const cleanCancelled = cancelled.filter(
    (record) => record.metrics.runOutcome === 'cancelled' && record.metrics.operations.rejected === 0,
  );
  const rendered = records.filter(
    (record) => record.metrics.renderEvidence === 'passed' || record.metrics.renderEvidence === 'failed',
  );
  return {
    tierSuccessRate,
    latencyMs: percentilePair(
      records.flatMap((record) =>
        record.metrics.wallClockMs === undefined ? [] : [record.metrics.wallClockMs],
      ),
    ),
    toolCalls: percentilePair(records.map((record) => record.metrics.toolCallCount)),
    revisionRate: withRevisions.length === 0 ? undefined : revised / withRevisions.length,
    cancellationIntegrity:
      cancelled.length === 0 ? undefined : cleanCancelled.length / cancelled.length,
    renderValidity:
      rendered.length === 0
        ? undefined
        : rendered.filter((record) => record.metrics.renderEvidence === 'passed').length / rendered.length,
  };
}
