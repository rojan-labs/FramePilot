/**
 * FramePilot 9.5 Phase-0 agent-run quality telemetry.
 *
 * This is an observer over existing run events and provider-call samples. It never applies
 * edits, changes routing, retries work or decides whether a run may commit. Missing evidence
 * stays absent instead of being converted into a fabricated pass.
 */
import type { AiEvent, RunStatus } from './events.js';
import type { CapturedTurn } from './kernel/cost/baseline-capture.js';
import { summarizeRunContext, type RunContextLedger } from './kernel/context/run-ledger.js';
import type { AgentOutcomeEvalScenario, AgentOutcomeEvalTier } from './professional-agent-evals.js';

/**
 * The route a measured run took.
 *
 * `planned-edit` is retained deliberately even though the route was retired (ADR 0126):
 * this type labels RECORDED runs, and Phase-0 Foundation records captured before the
 * convergence still carry it. Dropping the label would make historic evidence unreadable
 * by the very tooling that produced it. Nothing emits it any more.
 */
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
export type CancellationIntegrityOutcome = 'passed' | 'failed';
type TerminalRunStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>;

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
  /** Explicitly observed post-cancel integrity. Absent means it was not evaluated. */
  readonly integrity?: CancellationIntegrityOutcome;
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
  /**
   * Milliseconds from the first event of the run to the first moment the editor could SEE
   * the timeline change — the first `timeline_action` or `diff`.
   *
   * Distinct from `wallClockMs`, and the metric that actually separates "an editor working"
   * from "a research agent deliberating": a run can finish quickly and still feel broken if
   * it spends its first ninety seconds reading before anything moves. Absent when the run
   * never produced a visible edit, which is itself the answer.
   */
  readonly timeToFirstEditMs?: number;
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
  /**
   * What the whole run spent assembling context (05).
   *
   * Every figure in it was already recorded per request and never summed, which is how a
   * run that assembled 1,223,811 tokens across 52 calls — 60.2% of them tool definitions,
   * 115,967 re-billed across nine tool-set changes — read as fifty-two healthy requests
   * using a third of their window. `modelCallCount` above counts the calls; this says what
   * they cost and where it went.
   */
  readonly context: RunContextLedger;
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
  readonly cancellationIntegrity?: CancellationIntegrityOutcome;
  readonly deterministicValidation?: ValidationOutcome;
  readonly renderEvidence?: EvidenceOutcome;
  readonly humanEditorialScore?: number;
  /** Full host-observed run latency. Preferred over the event-envelope fallback. */
  readonly wallClockMs?: number;
  /**
   * Host-observed time to the first visible timeline change. Preferred over the
   * event-derived fallback, for a host that can time the paint rather than the event.
   */
  readonly timeToFirstEditMs?: number;
  /** Override when analysis/review work happens outside the AiEvent timestamp envelope. */
  readonly analysisReviewMs?: number;
}

function nonNegativeNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function optionalNonNegativeNumber(name: string, value: number | undefined): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(name, value);
}

function nonNegativeInteger(name: string, value: number): number {
  const checked = nonNegativeNumber(name, value);
  if (!Number.isInteger(checked)) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return checked;
}

function optionalNonNegativeInteger(name: string, value: number | undefined): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(name, value);
}

function countOrZero(name: string, value: number | undefined): number {
  return value === undefined ? 0 : nonNegativeInteger(name, value);
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

function eventEnvelopeWallClockMs(events: readonly AiEvent[]): number | undefined {
  if (events.length < 2) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!Number.isFinite(event.ts)) return undefined;
    min = Math.min(min, event.ts);
    max = Math.max(max, event.ts);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? Math.max(0, max - min) : undefined;
}

/**
 * Time from the run's first event to the first VISIBLE timeline change.
 *
 * `timeline_action` is the action card the host draws the moment an operation lands, and
 * `diff` is the reviewable patch itself — whichever arrives first is the first instant the
 * editor sees their project move. Reads, analysis, planning and reasoning all precede it and
 * all count against it, which is the point: this is the number that says whether the agent
 * behaves like an editor or like a researcher.
 *
 * Returns `undefined` for a run that never moved the timeline (no visible edit to time) and
 * for events with a non-finite clock, mirroring {@link eventEnvelopeWallClockMs} — a
 * fabricated zero would read as "instant" for a run that did nothing.
 */
function eventTimeToFirstEditMs(events: readonly AiEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  let start = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (!Number.isFinite(event.ts)) return undefined;
    start = Math.min(start, event.ts);
  }
  let firstEdit = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.type === 'timeline_action' || event.type === 'diff') {
      firstEdit = Math.min(firstEdit, event.ts);
    }
  }
  return Number.isFinite(firstEdit) ? Math.max(0, firstEdit - start) : undefined;
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
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) return undefined;
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
  const inputTokens = turns.reduce(
    (sum, turn, index) =>
      sum + nonNegativeInteger(`capturedTurns[${String(index)}].inputTokens`, turn.inputTokens),
    0,
  );
  const outputTokens = turns.reduce(
    (sum, turn, index) =>
      sum + nonNegativeInteger(`capturedTurns[${String(index)}].outputTokens`, turn.outputTokens),
    0,
  );
  // Assembled from the manifests the turn emitter already attaches to `context_usage`.
  // `summarizeRunContext` collapses the duplicate each request emits (one before the send,
  // one after), so this counts calls, not events.
  const contextLedger = summarizeRunContext(
    input.events.flatMap((event) =>
      event.type === 'context_usage' && event.manifest ? [event.manifest] : [],
    ),
  );
  const runOutcome = latestTerminalStatus(input.events);
  const reviewFindingIds = new Set(
    input.events.filter((event) => event.type === 'review_finding').map((event) => event.id),
  );
  const operations = input.operations ?? {};
  const operationCounts: AgentRunOperationCounts = {
    attempted: countOrZero('operations.attempted', operations.attempted),
    applied: countOrZero('operations.applied', operations.applied),
    rejected: countOrZero('operations.rejected', operations.rejected),
  };
  const humanEditorialScore = input.humanEditorialScore;
  const measuredWallClockMs =
    optionalNonNegativeNumber('wallClockMs', input.wallClockMs) ??
    eventEnvelopeWallClockMs(input.events);
  const measuredTimeToFirstEditMs =
    optionalNonNegativeNumber('timeToFirstEditMs', input.timeToFirstEditMs) ??
    eventTimeToFirstEditMs(input.events);
  const measuredAnalysisReviewMs =
    optionalNonNegativeNumber('analysisReviewMs', input.analysisReviewMs) ??
    eventVisibleAnalysisReviewMs(input.events);
  const projectRevisionBefore = optionalNonNegativeInteger(
    'projectRevisionBefore',
    input.projectRevisionBefore,
  );
  const projectRevisionAfter = optionalNonNegativeInteger(
    'projectRevisionAfter',
    input.projectRevisionAfter,
  );
  const cancellationLatencyMs = optionalNonNegativeNumber(
    'cancellationLatencyMs',
    input.cancellationLatencyMs,
  );

  if (operationCounts.applied + operationCounts.rejected > operationCounts.attempted) {
    throw new RangeError(
      'operations.applied + operations.rejected cannot exceed operations.attempted.',
    );
  }
  if (
    runOutcome !== 'cancelled' &&
    (cancellationLatencyMs !== undefined || input.cancellationIntegrity !== undefined)
  ) {
    throw new RangeError(
      'Cancellation evidence may only be supplied for a terminal cancelled run.',
    );
  }
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
    context: contextLedger,
    toolSchemasExposedPerTurn: [...(input.toolSchemasExposedPerTurn ?? [])].map((value, index) =>
      nonNegativeInteger(`toolSchemasExposedPerTurn[${String(index)}]`, value),
    ),
    toolCallCount: uniqueToolCalls.size,
    invalidMalformedCallCount: countOrZero(
      'invalidMalformedCallCount',
      input.invalidMalformedCallCount,
    ),
    duplicateRedundantCallCount: countOrZero(
      'duplicateRedundantCallCount',
      input.duplicateRedundantCallCount,
    ),
    cacheMemoHitCount: providerCacheHits + countOrZero('memoHitCount', input.memoHitCount),
    tokens: { input: inputTokens, output: outputTokens },
    ...(measuredWallClockMs !== undefined ? { wallClockMs: measuredWallClockMs } : {}),
    ...(measuredTimeToFirstEditMs !== undefined
      ? { timeToFirstEditMs: measuredTimeToFirstEditMs }
      : {}),
    ...(measuredAnalysisReviewMs !== undefined
      ? { analysisReviewMs: measuredAnalysisReviewMs }
      : {}),
    operations: operationCounts,
    revisions: {
      ...(projectRevisionBefore !== undefined ? { before: projectRevisionBefore } : {}),
      ...(projectRevisionAfter !== undefined ? { after: projectRevisionAfter } : {}),
    },
    reviewFindingCount: reviewFindingIds.size,
    repairAttemptCount: countOrZero('repairAttemptCount', input.repairAttemptCount),
    cancellation: {
      state: runOutcome === 'cancelled' ? 'cancelled' : 'not_cancelled',
      ...(runOutcome === 'cancelled' && cancellationLatencyMs !== undefined
        ? { latencyMs: cancellationLatencyMs }
        : {}),
      ...(runOutcome === 'cancelled' && input.cancellationIntegrity !== undefined
        ? { integrity: input.cancellationIntegrity }
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

export interface AgentOutcomeExecutionEvidence {
  readonly inspection: 'observed' | 'not_observed' | 'not_required';
  readonly review: 'observed' | 'not_observed' | 'not_required';
  readonly revisionCount?: number;
}

export interface AgentOutcomeEvalRunRecord {
  readonly scenarioId: string;
  readonly tier: AgentOutcomeEvalTier;
  readonly status: 'passed' | 'failed';
  readonly hardConstraints: readonly AgentOutcomePredicateObservation[];
  readonly finalStatePredicates: readonly AgentOutcomePredicateObservation[];
  readonly executionEvidence: AgentOutcomeExecutionEvidence;
  readonly failures: readonly string[];
  readonly metrics: AgentRunQualityMetrics;
}

export interface BuildAgentOutcomeEvalRunRecordInput {
  readonly scenario: AgentOutcomeEvalScenario;
  readonly hardConstraints: readonly AgentOutcomePredicateObservation[];
  readonly finalStatePredicates: readonly AgentOutcomePredicateObservation[];
  readonly metrics: AgentRunQualityMetrics;
  readonly inspectionObserved?: boolean;
  readonly reviewObserved?: boolean;
}

function observationFailures(
  expected: readonly string[],
  observed: readonly AgentOutcomePredicateObservation[],
  label: string,
): readonly string[] {
  const failures: string[] = [];
  for (const predicate of expected) {
    const observations = observed.filter((entry) => entry.predicate === predicate);
    if (observations.length === 0) {
      failures.push(`${label} was not evaluated: ${predicate}`);
      continue;
    }
    if (observations.length > 1) {
      failures.push(`${label} was evaluated more than once: ${predicate}`);
      continue;
    }
    const observation = observations[0];
    if (observation && !observation.passed) {
      failures.push(
        `${label} failed: ${predicate}${observation.detail ? ` (${observation.detail})` : ''}`,
      );
    }
  }
  return failures;
}

function revisionCount(metrics: AgentRunQualityMetrics): number | undefined {
  const { before, after } = metrics.revisions;
  if (before === undefined || after === undefined) return undefined;
  return after - before;
}

const ADVERSARIAL_TERMINAL_OUTCOMES: Readonly<
  Partial<Record<string, readonly TerminalRunStatus[]>>
> = {
  'E01-offline-media': ['completed', 'failed'],
  'E02-missing-transcript': ['completed', 'failed'],
  'E03-stale-context': ['completed', 'failed'],
  'E04-revision-changes-mid-run': ['completed', 'failed'],
  'E05-cancel-analysis': ['cancelled'],
  'E06-cancel-mutation': ['cancelled'],
  'E07-invalid-tool-args': ['completed', 'failed'],
  'E08-transition-handles': ['completed', 'failed'],
};

function acceptedTerminalOutcomes(
  scenario: AgentOutcomeEvalScenario,
): readonly TerminalRunStatus[] {
  return ADVERSARIAL_TERMINAL_OUTCOMES[scenario.id] ?? ['completed'];
}

/** Grade the scenario contract before accepting semantic outcome predicates as a pass. */
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
  const observedRevisionCount = revisionCount(input.metrics);
  const inspection = input.scenario.inspectionExpected
    ? input.inspectionObserved === true
      ? 'observed'
      : 'not_observed'
    : 'not_required';
  const review = input.scenario.reviewExpected
    ? input.reviewObserved === true
      ? 'observed'
      : 'not_observed'
    : 'not_required';

  if (input.scenario.inspectionExpected && inspection !== 'observed') {
    failures.push('Required inspection evidence was not observed.');
  }
  if (input.scenario.reviewExpected && review !== 'observed') {
    failures.push('Required review evidence was not observed.');
  }
  if (observedRevisionCount === undefined) {
    failures.push('Project revision range was not observed.');
  } else if (observedRevisionCount < 0) {
    failures.push('Project revision moved backwards during the run.');
  } else if (observedRevisionCount > input.scenario.maxToleratedRevisionCount) {
    failures.push(
      `Project revision count ${String(observedRevisionCount)} exceeded the tolerated maximum ${String(input.scenario.maxToleratedRevisionCount)}.`,
    );
  }
  if (input.metrics.operations.applied > 0 && input.metrics.deterministicValidation !== 'passed') {
    failures.push('Applied operations were not proven to pass deterministic validation.');
  }
  if (input.metrics.operations.applied > 0 && observedRevisionCount === 0) {
    failures.push('Applied operations were reported without an authoritative revision change.');
  }
  if (input.metrics.runOutcome === undefined) {
    failures.push('Terminal run outcome was not observed.');
  } else if (
    !acceptedTerminalOutcomes(input.scenario).includes(
      input.metrics.runOutcome as TerminalRunStatus,
    )
  ) {
    failures.push(
      `Terminal run outcome "${input.metrics.runOutcome}" is not accepted for scenario ${input.scenario.id}.`,
    );
  }
  if (input.metrics.deterministicValidation === 'failed') {
    failures.push('Deterministic validation failed.');
  }
  if (input.metrics.renderEvidence === 'failed') {
    failures.push('Render/media evidence failed.');
  }

  return {
    scenarioId: input.scenario.id,
    tier: input.scenario.tier,
    status: failures.length === 0 ? 'passed' : 'failed',
    hardConstraints: [...input.hardConstraints],
    finalStatePredicates: [...input.finalStatePredicates],
    executionEvidence: {
      inspection,
      review,
      ...(observedRevisionCount !== undefined ? { revisionCount: observedRevisionCount } : {}),
    },
    failures,
    metrics: input.metrics,
  };
}

/** Stable eval artifact payload. No clock is injected, so identical evidence diffs cleanly. */
export function serializeAgentOutcomeEvalRunRecords(
  records: readonly AgentOutcomeEvalRunRecord[],
): string {
  return `${JSON.stringify(
    [...records].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
    null,
    2,
  )}\n`;
}

export interface PercentilePair {
  readonly p50?: number;
  readonly p95?: number;
}

export interface AgentOutcomeTopLineScore {
  readonly tierSuccessRate: Readonly<Record<AgentOutcomeEvalTier, number | undefined>>;
  readonly latencyMs: PercentilePair;
  /**
   * Time-to-first-visible-edit across the set — the budget FRAMEPILOT-95 Phase E is about.
   * Runs that never moved the timeline contribute nothing rather than a zero.
   */
  readonly timeToFirstEditMs: PercentilePair;
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
    (record) =>
      record.metrics.revisions.before !== undefined && record.metrics.revisions.after !== undefined,
  );
  const revised = withRevisions.filter(
    (record) => record.metrics.revisions.after !== record.metrics.revisions.before,
  ).length;
  const cancellationEvidence = records.filter(
    (record) =>
      record.metrics.cancellation.state === 'cancelled' &&
      record.metrics.cancellation.integrity !== undefined,
  );
  const cleanCancelled = cancellationEvidence.filter(
    (record) => record.metrics.cancellation.integrity === 'passed',
  );
  const rendered = records.filter(
    (record) =>
      record.metrics.renderEvidence === 'passed' || record.metrics.renderEvidence === 'failed',
  );
  return {
    tierSuccessRate,
    timeToFirstEditMs: percentilePair(
      records.flatMap((record) =>
        record.metrics.timeToFirstEditMs === undefined ? [] : [record.metrics.timeToFirstEditMs],
      ),
    ),
    latencyMs: percentilePair(
      records.flatMap((record) =>
        record.metrics.wallClockMs === undefined ? [] : [record.metrics.wallClockMs],
      ),
    ),
    toolCalls: percentilePair(records.map((record) => record.metrics.toolCallCount)),
    revisionRate: withRevisions.length === 0 ? undefined : revised / withRevisions.length,
    cancellationIntegrity:
      cancellationEvidence.length === 0
        ? undefined
        : cleanCancelled.length / cancellationEvidence.length,
    renderValidity:
      rendered.length === 0
        ? undefined
        : rendered.filter((record) => record.metrics.renderEvidence === 'passed').length /
          rendered.length,
  };
}
