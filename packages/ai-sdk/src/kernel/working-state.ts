/**
 * @framepilot/ai-sdk/kernel/working-state — durable task memory for one run
 * (plan/AGENT-TASK-MEMORY.md §3.1, proposed ADR 0075).
 *
 * ## Why this exists
 *
 * The agent's memory of its own run used to be a rolling window of note strings whose
 * payloads compaction deleted after two turns. Everything the run learned — the source
 * duration, the beats it chose, the ranges it committed to — aged out of the only channel
 * that carried it, so the model re-derived it, forever. `scoped-memory.ts` calls the task
 * scope "derivable, so it is not a store here". It is not derivable. This module is that
 * store.
 *
 * ## The three rules that make it safe
 *
 * 1. **Conclusions, not payloads.** A {@link Fact} is one model-facing line; the raw
 *    transcript stays in the evidence store and is reachable by handle. That is what
 *    keeps the briefing flat in project duration instead of growing with the footage.
 * 2. **Causal authority.** The project file remains media/timeline truth, while this
 *    ledger is the authority for WHY an automated mutation is allowed. Missing causal
 *    state pauses execution; it never degrades to an amnesiac editing loop.
 * 3. **Pure.** Every function here is a total function of its inputs, with no I/O and no
 *    clock, so the Conductor can own this state and stay a pure reducer. Distillation —
 *    which needs I/O — happens in handlers and folds its *result* back through here.
 *
 * Persistence-agnostic and defensive in the same way as `memory-store.ts` and
 * `workflow-memory.ts`: {@link parseWorkingState} drops what it cannot understand rather
 * than throwing, because a corrupt snapshot must never take a run down with it.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { ProjectRevision } from '../run-contracts.js';

const log = createLogger('ai-sdk:kernel:working-state');

/**
 * Local mirror of `run-contracts.ts`'s `ProjectRevisionSchema`. Deliberately re-declared
 * rather than imported: that module is authored against `zod/v4` and this one against
 * `zod` (v3), and composing a v4 schema inside a v3 object silently misbehaves. Only the
 * TYPE is shared, so the two cannot drift in meaning.
 */
const ProjectRevisionSchema = z.number().int().nonnegative().finite();

/** v2 adds the canonical identity, plan, execution authorization, and integrity ledger. */
export const WORKING_STATE_SCHEMA_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Stages (§3.2)
// ---------------------------------------------------------------------------

/**
 * The nine task stages. Orthogonal to `conductor.ts`'s {@link RunPhase}, which describes
 * the *harness* (planning/executing/verifying) rather than the *task*: a repair turn is
 * `phase: 'executing'` and `stage: 'repair'` at the same time, and neither can express
 * the other.
 */
export const RUN_STAGES = [
  'interpret',
  'inspect',
  'analyze',
  'plan',
  'apply',
  'enhance',
  'verify',
  'repair',
  'complete',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

const RunStageSchema = z.enum(RUN_STAGES);

/** Position of a stage in the forward order — the basis of the forward-only rule. */
const STAGE_ORDER: Readonly<Record<RunStage, number>> = Object.freeze(
  Object.fromEntries(RUN_STAGES.map((stage, i) => [stage, i])) as Record<RunStage, number>,
);

/**
 * Stages a run may move to from each stage. Forward moves dominate; the two backward
 * edges are deliberate and narrow:
 *
 * - `verify → repair` — the ordinary corrective cycle.
 * - `repair → verify` — re-check what was just repaired.
 * - `apply`/`enhance` ← `verify` is NOT permitted: a failed verification is repaired in
 *   place, so a run can never wash back into planning or reconnaissance. That is the
 *   whole point of the machine.
 *
 * `inspect` and `analyze` are re-enterable ONLY through {@link revisitStage}, which
 * demands a recorded cause; they are not listed here.
 */
const STAGE_SUCCESSORS: Readonly<Record<RunStage, readonly RunStage[]>> = Object.freeze({
  interpret: ['inspect'],
  inspect: ['analyze', 'plan'],
  analyze: ['plan'],
  plan: ['apply'],
  apply: ['enhance', 'verify'],
  enhance: ['verify'],
  verify: ['complete', 'repair'],
  repair: ['verify'],
  complete: [],
});

/** Stages during which the run is still deciding what to do (the planning half, §3.6). */
const PLANNING_STAGES: ReadonlySet<RunStage> = new Set<RunStage>([
  'interpret',
  'inspect',
  'analyze',
  'plan',
]);

/** True while the run is still gathering and deciding rather than changing the project. */
export function isPlanningStage(stage: RunStage): boolean {
  return PLANNING_STAGES.has(stage);
}

/** True once the run is executing against a locked plan — reads are closed here (§3.6). */
export function isExecutionStage(stage: RunStage): boolean {
  return stage === 'apply' || stage === 'enhance' || stage === 'repair';
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Whether a piece of knowledge survives a timeline change (§3.7). The distinction is the
 * entire reason an applied cut no longer costs the run its transcript:
 *
 * - `revision_independent` — true of the *source material*: the words that were spoken,
 *   the footage map, the source asset's duration, the creator's request. Cutting the
 *   timeline cannot change any of it.
 * - `timeline_dependent` — true of the *arrangement*: clip ids, positions, gaps, the
 *   edited duration. An applied patch invalidates exactly these and nothing else.
 */
export const FactScopeSchema = z.enum(['revision_independent', 'timeline_dependent']);
export type FactScope = z.infer<typeof FactScopeSchema>;

export const FactKindSchema = z.enum([
  'project',
  'asset',
  'transcript',
  'footage',
  'audio',
  'derived',
]);
export type FactKind = z.infer<typeof FactKindSchema>;

const FactSchema = z.object({
  id: z.string().min(1),
  kind: FactKindSchema,
  /** One model-facing line: "Source runs 6:04; single asset asset_1, 1080x1920." */
  statement: z.string().min(1),
  /** Handles into the evidence store, so the model can check any claim made here. */
  evidenceIds: z.array(z.string()).default([]),
  scope: FactScopeSchema,
  observedAtRevision: ProjectRevisionSchema,
  stage: RunStageSchema,
});
export type Fact = z.infer<typeof FactSchema>;

/**
 * A decision the run has taken. `reconsiderIf` is load-bearing rather than
 * documentation: it is the ONLY admissible reason to reopen a committed decision, which
 * is what stops the run re-litigating its segment selection every turn.
 */
const DecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.string().min(1),
  evidenceIds: z.array(z.string()).default([]),
  stage: RunStageSchema,
  status: z.enum(['tentative', 'committed', 'superseded']),
  reconsiderIf: z.string().min(1),
  supersededBy: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * One unit of work the run owes the creator. Satisfied ONLY by an applied patch plus a
 * passing verification (§3.8) — never by the model asserting it is done.
 */
const ObjectiveSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** The stage that discharges it, so the briefing can show what remains where. */
  stage: RunStageSchema,
  status: z.enum(['pending', 'satisfied', 'blocked']),
  blockedReason: z.string().optional(),
});
export type Objective = z.infer<typeof ObjectiveSchema>;

const OperationRecordSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  status: z.enum(['attempted', 'succeeded', 'failed', 'orphaned']),
  patchId: z.string().optional(),
  atRevision: ProjectRevisionSchema,
  failureReason: z.string().optional(),
  attempts: z.number().int().positive(),
  objectiveId: z.string().optional(),
  planId: z.string().min(1),
  decisionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  projectRevisionBefore: ProjectRevisionSchema,
  projectRevisionAfter: ProjectRevisionSchema,
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

const VerificationRecordSchema = z.object({
  id: z.string().min(1),
  criterion: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().optional(),
  atRevision: ProjectRevisionSchema,
});
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

/**
 * A pointer into the evidence store: the run knows this payload exists, what produced it,
 * and roughly how big it is, without carrying any of it in the prompt.
 */
const EvidenceHandleSchema = z.object({
  id: z.string().min(1),
  /** The tool call that produced it, for provenance in the briefing. */
  source: z.string().min(1),
  /** One line describing what is inside — enough to decide whether to recall it. */
  descriptor: z.string().min(1),
  scope: FactScopeSchema,
  observedAtRevision: ProjectRevisionSchema,
});
export type EvidenceHandle = z.infer<typeof EvidenceHandleSchema>;

/** A checkable completion criterion, derived from the request at `interpret`. */
const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** The one imperative instruction the next turn is given (§3.3). */
const NextActionSchema = z.object({
  stage: RunStageSchema,
  action: z.string().min(1),
  toolHint: z.string().optional(),
  objectiveId: z.string().optional(),
});
export type NextAction = z.infer<typeof NextActionSchema>;

/** Why the run cannot proceed — the named dependency that reopens a closed read (§3.6). */
const BlockerSchema = z.object({
  reason: z.string().min(1),
  /** The specific missing thing, if the run can name it. */
  missing: z.string().optional(),
  atStage: RunStageSchema,
});
export type Blocker = z.infer<typeof BlockerSchema>;

const RunDiagnosticSchema = z.object({
  code: z.enum([
    'RUN_IDENTITY_MISMATCH',
    'OBJECTIVE_MISSING',
    'PLAN_NOT_COMMITTED',
    'DECISIONS_MISSING',
    'EXECUTION_NOT_AUTHORIZED',
    'PROJECT_REVISION_STALE',
    'OPERATIONS_UNTRACEABLE',
    'VERIFICATION_INCONCLUSIVE',
    'RECOVERY_INCOMPATIBLE',
  ]),
  message: z.string().min(1),
  stage: RunStageSchema,
  atVersion: z.number().int().nonnegative(),
  blocking: z.boolean(),
});
export type RunDiagnostic = z.infer<typeof RunDiagnosticSchema>;

const CommittedPlanSchema = z.object({
  status: z.enum(['none', 'draft', 'committed', 'stale']),
  id: z.string().min(1).nullable(),
  committedAtTurn: z.number().int().nonnegative().nullable(),
  basedOnProjectRevision: ProjectRevisionSchema.nullable(),
  decisionIds: z.array(z.string().min(1)).default([]),
});
export type CommittedPlan = z.infer<typeof CommittedPlanSchema>;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const WorkingStateSchema = z.object({
  schemaVersion: z.literal(WORKING_STATE_SCHEMA_VERSION),
  runId: z.string().min(1),
  identity: z.object({
    conversationId: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    attemptId: z.string().min(1),
  }),
  /** Bumped on every mutation — the observability "task-memory version" (§3.9). */
  version: z.number().int().nonnegative(),
  objective: z.object({
    request: z.string(),
    outcome: z.string(),
    acceptance: z.array(AcceptanceCriterionSchema).default([]),
    /**
     * True while `outcome` is the run's own deterministic reading of the request rather
     * than an interpretation the turn recorded.
     *
     * WHY this flag exists: every stage past `interpret` is gated on a NON-EMPTY outcome
     * (see {@link stageEntryViolation}), so the outcome cannot simply start blank and wait
     * to be written — a run with nothing there cannot move. It is therefore seeded from
     * the request, which then made {@link setObjective}'s write-once rule permanent: the
     * seed occupied the field, so a real interpretation could never land. Marking the seed
     * provisional keeps write-once where it belongs — on an interpretation — while letting
     * the first genuine one replace a placeholder.
     */
    provisional: z.boolean().default(false),
  }),
  stage: RunStageSchema,
  completedStages: z.array(RunStageSchema).default([]),
  stageEnteredAtTurn: z.number().int().nonnegative(),
  facts: z.array(FactSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  plan: CommittedPlanSchema,
  execution: z.object({ authorized: z.boolean() }),
  evidence: z.array(EvidenceHandleSchema).default([]),
  objectives: z.array(ObjectiveSchema).default([]),
  operations: z.array(OperationRecordSchema).default([]),
  verifications: z.array(VerificationRecordSchema).default([]),
  nextAction: NextActionSchema.nullable().default(null),
  blockedOn: BlockerSchema.nullable().default(null),
  integrity: z.object({
    status: z.enum(['valid', 'recovering', 'needs_review']),
    diagnostics: z.array(RunDiagnosticSchema).default([]),
  }),
  baseProjectRevision: ProjectRevisionSchema,
  currentProjectRevision: ProjectRevisionSchema,
});

export type RunWorkingState = z.infer<typeof WorkingStateSchema>;

/**
 * A run's task memory at turn zero: the request is known, nothing else is. Deliberately
 * NOT `interpret`-complete — the objective's `outcome` and acceptance criteria are
 * written by the first turn, so an empty outcome is the signal that interpretation has
 * not happened yet.
 */
export function initialWorkingState(args: {
  readonly runId: string;
  readonly request: string;
  readonly conversationId?: string;
  readonly projectId?: string;
  readonly attemptId?: string;
  readonly projectRevision?: ProjectRevision;
}): RunWorkingState {
  const revision = args.projectRevision ?? 0;
  const request = args.request.trim();
  return {
    schemaVersion: WORKING_STATE_SCHEMA_VERSION,
    runId: args.runId,
    identity: {
      conversationId: args.conversationId ?? null,
      projectId: args.projectId ?? null,
      attemptId: args.attemptId ?? args.runId,
    },
    version: 0,
    objective: { request, outcome: '', acceptance: [], provisional: false },
    stage: 'interpret',
    completedStages: [],
    stageEnteredAtTurn: 0,
    facts: [],
    decisions: [],
    plan: {
      status: 'none',
      id: null,
      committedAtTurn: null,
      basedOnProjectRevision: null,
      decisionIds: [],
    },
    execution: { authorized: false },
    evidence: [],
    objectives: [],
    operations: [],
    verifications: [],
    nextAction: null,
    blockedOn: null,
    integrity: { status: 'valid', diagnostics: [] },
    baseProjectRevision: revision,
    currentProjectRevision: revision,
  };
}

/**
 * Parse a persisted record. Returns `null` — never throws — when the record is absent,
 * malformed, or from a schema version this build does not understand. The caller then
 * starts a fresh working state, which costs the run its accumulated conclusions but never
 * its correctness (guardrail 2: derived data, never authority).
 */
export function parseWorkingState(value: unknown): RunWorkingState | null {
  const migrated = migrateWorkingState(value);
  const parsed = WorkingStateSchema.safeParse(migrated);
  if (parsed.success) return parsed.data;
  // An ABSENT record is the normal case, not a fault: every run's first `run_state` event is
  // validated against a snapshot that has no previous ledger yet. Warning on it trained the
  // log to cry wolf twice per run, which is how a genuinely dropped ledger came to look like
  // routine noise. Only a record that EXISTS and cannot be understood is worth a warning.
  if (value !== undefined && value !== null) {
    log.warn('working state dropped — unparseable', { issues: parsed.error.issues.length });
  }
  return null;
}

/** Migrate v1 checkpoints without inventing a plan from assistant prose. */
function migrateWorkingState(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const legacy = value as Record<string, unknown>;
  if (legacy['schemaVersion'] !== 1) return value;
  const decisions = Array.isArray(legacy['decisions']) ? legacy['decisions'] : [];
  const committedIds = decisions
    .filter(
      (decision): decision is Record<string, unknown> =>
        typeof decision === 'object' &&
        decision !== null &&
        !Array.isArray(decision) &&
        decision['status'] === 'committed' &&
        typeof decision['id'] === 'string',
    )
    .map((decision) => decision['id'] as string);
  const stage = typeof legacy['stage'] === 'string' ? legacy['stage'] : 'interpret';
  const hasPlan = committedIds.length > 0;
  const revision =
    typeof legacy['currentProjectRevision'] === 'number' ? legacy['currentProjectRevision'] : 0;
  const operations = Array.isArray(legacy['operations'])
    ? legacy['operations'].map((operation, index) => {
        if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
          return operation;
        }
        const record = operation as Record<string, unknown>;
        const atRevision =
          typeof record['atRevision'] === 'number' ? record['atRevision'] : revision;
        return {
          ...record,
          status: !hasPlan && record['status'] === 'succeeded' ? 'orphaned' : record['status'],
          planId: hasPlan ? 'legacy_plan_1' : 'untraceable_legacy_plan',
          decisionId: committedIds[0] ?? 'untraceable_legacy_decision',
          idempotencyKey: `legacy:${String(record['id'] ?? index + 1)}`,
          // `atRevision` itself must be written back too, not just the before/after pair
          // derived from it — a legacy op that never carried one (only newer schemas
          // required it) would otherwise migrate to a record missing a required field.
          atRevision,
          projectRevisionBefore: atRevision,
          projectRevisionAfter: atRevision,
        };
      })
    : [];
  const executing = stage === 'apply' || stage === 'enhance' || stage === 'repair';
  const diagnostics =
    executing && !hasPlan
      ? [
          {
            code: 'RECOVERY_INCOMPATIBLE',
            message: 'Legacy run reached execution without an authoritative committed plan.',
            stage,
            atVersion: typeof legacy['version'] === 'number' ? legacy['version'] : 0,
            blocking: true,
          },
        ]
      : [];
  return {
    ...legacy,
    schemaVersion: WORKING_STATE_SCHEMA_VERSION,
    identity: {
      conversationId: null,
      projectId: null,
      attemptId: String(legacy['runId'] ?? 'legacy'),
    },
    plan: {
      status: hasPlan ? 'committed' : 'none',
      id: hasPlan ? 'legacy_plan_1' : null,
      committedAtTurn: hasPlan ? 0 : null,
      basedOnProjectRevision: hasPlan ? revision : null,
      decisionIds: committedIds,
    },
    execution: { authorized: hasPlan },
    operations,
    integrity: {
      status: diagnostics.length > 0 ? 'needs_review' : 'valid',
      diagnostics,
    },
  };
}

/** Every mutation goes through here, so `version` can never drift from the content. */
function bump(state: RunWorkingState, patch: Partial<RunWorkingState>): RunWorkingState {
  return { ...state, ...patch, version: state.version + 1 };
}

// ---------------------------------------------------------------------------
// Stage transitions (§3.2)
// ---------------------------------------------------------------------------

/** Is `to` a declared successor of `from`? */
export function canAdvance(from: RunStage, to: RunStage): boolean {
  return STAGE_SUCCESSORS[from].includes(to);
}

/**
 * Move to a successor stage. A move that is not declared in {@link STAGE_SUCCESSORS} is
 * refused and the state returned unchanged — the reducer never trusts a caller (or a
 * model) to pick a legal transition.
 */
export function advanceStage(state: RunWorkingState, to: RunStage, turn: number): RunWorkingState {
  if (!canAdvance(state.stage, to)) {
    log.warn('stage advance refused — not a declared successor', { from: state.stage, to });
    return state;
  }
  const violation = stageEntryViolation(state, to);
  if (violation) {
    log.error('stage advance blocked by run integrity guard', {
      runId: state.runId,
      from: state.stage,
      to,
      code: violation.code,
    });
    return addDiagnostic(state, violation);
  }
  return bump(state, {
    stage: to,
    completedStages: state.completedStages.includes(state.stage)
      ? state.completedStages
      : [...state.completedStages, state.stage],
    stageEnteredAtTurn: turn,
  });
}

/** The first unmet prerequisite for a stage, or null when entry is safe. */
export function stageEntryViolation(
  state: RunWorkingState,
  to: RunStage,
): Omit<RunDiagnostic, 'atVersion'> | null {
  // Records created before v2 have no cross-surface identity. They remain readable and
  // recoverable, but only new fully-correlated runs are authorized by these entry guards.
  if (state.identity.projectId === null || state.identity.conversationId === null) return null;
  const blocking = true;
  if (to !== 'interpret' && !isInterpreted(state)) {
    return {
      code: 'OBJECTIVE_MISSING',
      message: `Cannot enter ${to}: the durable run objective is missing.`,
      stage: to,
      blocking,
    };
  }
  if (
    to === 'apply' ||
    to === 'enhance' ||
    to === 'repair' ||
    to === 'verify' ||
    to === 'complete'
  ) {
    if (state.plan.status !== 'committed' || state.plan.id === null) {
      return {
        code: 'PLAN_NOT_COMMITTED',
        message: `Cannot enter ${to}: no execution plan has been committed.`,
        stage: to,
        blocking,
      };
    }
    if (committedDecisions(state).length === 0 || state.plan.decisionIds.length === 0) {
      return {
        code: 'DECISIONS_MISSING',
        message: `Cannot enter ${to}: the committed plan has no decisions.`,
        stage: to,
        blocking,
      };
    }
  }
  if (to === 'apply' || to === 'enhance' || to === 'repair') {
    if (!state.execution.authorized) {
      return {
        code: 'EXECUTION_NOT_AUTHORIZED',
        message: `Cannot enter ${to}: execution has not crossed the durable plan-commit barrier.`,
        stage: to,
        blocking,
      };
    }
    if (
      state.operations.length === 0 &&
      state.plan.basedOnProjectRevision !== state.currentProjectRevision
    ) {
      return {
        code: 'PROJECT_REVISION_STALE',
        message:
          `Cannot enter ${to}: plan revision ${String(state.plan.basedOnProjectRevision)} ` +
          `does not match project revision ${state.currentProjectRevision}.`,
        stage: to,
        blocking,
      };
    }
  }
  if (to === 'verify' && !state.operations.some((operation) => operation.status === 'succeeded')) {
    return {
      code: 'OPERATIONS_UNTRACEABLE',
      message: 'Cannot verify: no successful plan-bound operation is recorded.',
      stage: to,
      blocking,
    };
  }
  if (to === 'complete') {
    if (
      !isDelivered(state) ||
      state.verifications.length === 0 ||
      state.verifications.some((v) => !v.passed)
    ) {
      return {
        code: 'VERIFICATION_INCONCLUSIVE',
        message: 'Cannot complete: required objectives and verification evidence are incomplete.',
        stage: to,
        blocking,
      };
    }
  }
  return null;
}

/** Persist a blocking diagnostic and move the run into safe review exactly once. */
export function addDiagnostic(
  state: RunWorkingState,
  diagnostic: Omit<RunDiagnostic, 'atVersion'>,
): RunWorkingState {
  if (
    state.integrity.diagnostics.some(
      (existing) => existing.code === diagnostic.code && existing.message === diagnostic.message,
    )
  ) {
    return state;
  }
  return bump(state, {
    execution: { authorized: diagnostic.blocking ? false : state.execution.authorized },
    integrity: {
      status: diagnostic.blocking ? 'needs_review' : state.integrity.status,
      diagnostics: [...state.integrity.diagnostics, { ...diagnostic, atVersion: state.version }],
    },
    blockedOn: diagnostic.blocking
      ? { reason: diagnostic.message, missing: diagnostic.code, atStage: state.stage }
      : state.blockedOn,
  });
}

/**
 * Return to an EARLIER stage — the only way a run may move backwards, and only with a
 * named cause, which is recorded as a fact so the regression is auditable. This is the
 * mechanism behind "a new reasoning cycle is never itself a reason to change stage": a
 * turn that merely wants to re-orient has no cause to offer and therefore cannot.
 *
 * A `cause` that is blank, or a target that is not strictly earlier, is refused.
 */
export function revisitStage(
  state: RunWorkingState,
  to: RunStage,
  turn: number,
  cause: string,
): RunWorkingState {
  if (!cause.trim()) {
    log.warn('stage revisit refused — no cause given', { from: state.stage, to });
    return state;
  }
  if (STAGE_ORDER[to] >= STAGE_ORDER[state.stage]) {
    log.warn('stage revisit refused — not an earlier stage', { from: state.stage, to });
    return state;
  }
  const next = recordFact(state, {
    kind: 'derived',
    statement: `Returned to ${to} from ${state.stage}: ${cause.trim()}`,
    scope: 'timeline_dependent',
  });
  return bump(next, {
    stage: to,
    stageEnteredAtTurn: turn,
    completedStages: next.completedStages.filter((s) => STAGE_ORDER[s] < STAGE_ORDER[to]),
  });
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/** Deterministic id — no clock, no randomness, so replay reproduces the run exactly. */
function nextId(prefix: string, count: number): string {
  return `${prefix}_${count + 1}`;
}

/**
 * Record a distilled conclusion. Deduplicated on the exact statement: distilling the same
 * payload twice must not grow the briefing, and re-recording an identical fact is a
 * no-op that does not even bump the version (so it cannot masquerade as progress).
 */
export function recordFact(
  state: RunWorkingState,
  fact: {
    readonly kind: FactKind;
    readonly statement: string;
    readonly scope: FactScope;
    readonly evidenceIds?: readonly string[];
  },
): RunWorkingState {
  if (state.facts.some((f) => f.statement === fact.statement)) return state;
  const entry: Fact = {
    id: nextId('fact', state.facts.length),
    kind: fact.kind,
    statement: fact.statement,
    evidenceIds: [...(fact.evidenceIds ?? [])],
    scope: fact.scope,
    observedAtRevision: state.currentProjectRevision,
    stage: state.stage,
  };
  return bump(state, { facts: [...state.facts, entry] });
}

/** Register a raw payload in the evidence index (the payload itself lives elsewhere). */
export function recordEvidence(
  state: RunWorkingState,
  handle: {
    readonly id: string;
    readonly source: string;
    readonly descriptor: string;
    readonly scope: FactScope;
  },
): RunWorkingState {
  if (state.evidence.some((e) => e.id === handle.id)) return state;
  const entry: EvidenceHandle = {
    ...handle,
    observedAtRevision: state.currentProjectRevision,
  };
  return bump(state, { evidence: [...state.evidence, entry] });
}

/** Add a decision. New decisions start `tentative` unless explicitly committed. */
export function recordDecision(
  state: RunWorkingState,
  decision: {
    readonly decision: string;
    readonly reconsiderIf: string;
    readonly evidenceIds?: readonly string[];
    readonly committed?: boolean;
  },
): RunWorkingState {
  const entry: Decision = {
    id: nextId('decision', state.decisions.length),
    decision: decision.decision,
    evidenceIds: [...(decision.evidenceIds ?? [])],
    stage: state.stage,
    status: decision.committed ? 'committed' : 'tentative',
    reconsiderIf: decision.reconsiderIf,
  };
  return bump(state, { decisions: [...state.decisions, entry] });
}

/** Promote a tentative decision. A superseded decision can never be re-committed. */
export function commitDecision(state: RunWorkingState, id: string): RunWorkingState {
  const target = state.decisions.find((d) => d.id === id);
  if (!target || target.status !== 'tentative') return state;
  return bump(state, {
    decisions: state.decisions.map((d) => (d.id === id ? { ...d, status: 'committed' } : d)),
  });
}

/**
 * Replace a committed decision — the *only* legitimate way one changes. The replacement
 * is a new decision, and the original is kept as `superseded` rather than deleted, so the
 * ledger shows what the run believed and when it stopped believing it.
 */
export function supersedeDecision(
  state: RunWorkingState,
  id: string,
  replacement: { readonly decision: string; readonly reconsiderIf: string },
): RunWorkingState {
  const target = state.decisions.find((d) => d.id === id);
  if (!target || target.status === 'superseded') return state;
  const added = recordDecision(state, { ...replacement, committed: true });
  const newId = added.decisions[added.decisions.length - 1]!.id;
  return bump(added, {
    decisions: added.decisions.map((d) =>
      d.id === id ? { ...d, status: 'superseded', supersededBy: newId } : d,
    ),
  });
}

/** Decisions the briefing shows and the run is bound by. */
export function committedDecisions(state: RunWorkingState): readonly Decision[] {
  return state.decisions.filter((d) => d.status === 'committed');
}

/**
 * How much of the request is kept when the run has to store the request as its own
 * objective. Long enough to recognise which request this is, short enough that four
 * copies of it are not the run's state.
 */
export const REQUEST_ECHO_CHARS = 180;

/**
 * The request, bounded, for the places the run stores it back as its own objective.
 *
 * Until a turn records a real interpretation, the objective, its single decision and its
 * single objective entry are all seeded from the request itself — three verbatim copies,
 * plus a fourth inside the recovery instruction, in a state that is persisted and
 * streamed to the host on every turn. For a 10,000-token brief that was ~40 KB per turn
 * of a run describing its own input back to itself. The briefing already refuses to print
 * any of them (they say nothing the request has not), so nothing downstream needs the
 * whole text — `objective.request` remains the one full copy.
 *
 * @param request - The editor's request.
 * @returns The request unchanged when it is already short, otherwise a bounded excerpt.
 */
export function requestEcho(request: string): string {
  const trimmed = request.trim();
  if (trimmed.length <= REQUEST_ECHO_CHARS) return trimmed;
  return `${trimmed.slice(0, REQUEST_ECHO_CHARS).trimEnd()}…`;
}

/**
 * Is this text the request said back, whole or excerpted?
 *
 * The briefing suppresses five sections that would otherwise restate the request under
 * headings claiming something had been decided. It matched on exact equality, which
 * {@link requestEcho} would defeat — so the test lives here, next to the shortening, and
 * both sides move together.
 */
export function isRequestEcho(text: string, request: string): boolean {
  const trimmed = text.trim();
  const full = request.trim();
  return full.length > 0 && (trimmed === full || trimmed === requestEcho(full));
}

/** Commit the model's machine-readable numbered plan before any mutating turn runs. */
export function commitExecutionPlan(
  state: RunWorkingState,
  labels: readonly string[],
  turn: number,
): RunWorkingState {
  // A label that IS the request is stored as a bounded excerpt (see `requestEcho`): the
  // briefing never prints it, and three verbatim copies of a long brief in a state that is
  // persisted and streamed every turn is pure weight.
  const normalized = labels
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => (isRequestEcho(label, state.objective.request) ? requestEcho(label) : label));
  if (normalized.length === 0) {
    return addDiagnostic(state, {
      code: 'PLAN_NOT_COMMITTED',
      message: 'The planning turn produced no executable decisions; mutation is paused.',
      stage: 'plan',
      blocking: true,
    });
  }
  if (state.plan.status === 'committed') return state;
  const planId = `plan_${state.runId}_1`;
  const decisions: Decision[] = normalized.map((decision, index) => ({
    id: `decision_${index + 1}`,
    decision,
    evidenceIds: [],
    stage: 'plan',
    status: 'committed',
    reconsiderIf: 'The project revision changes outside this run or verification disproves it.',
  }));
  const objectives: Objective[] = normalized.map((description, index) => ({
    id: `objective_${index + 1}`,
    description,
    stage: 'verify',
    status: 'pending',
  }));
  return bump(state, {
    decisions,
    objectives,
    plan: {
      status: 'committed',
      id: planId,
      committedAtTurn: turn,
      basedOnProjectRevision: state.currentProjectRevision,
      decisionIds: decisions.map((decision) => decision.id),
    },
    execution: { authorized: true },
    integrity: { status: 'valid', diagnostics: [] },
    blockedOn: null,
  });
}

/** Cross the execution barrier after any required human plan gate settles. */
export function setExecutionAuthorization(
  state: RunWorkingState,
  authorized: boolean,
): RunWorkingState {
  if (state.execution.authorized === authorized) return state;
  if (authorized && state.plan.status !== 'committed') {
    return addDiagnostic(state, {
      code: 'PLAN_NOT_COMMITTED',
      message: 'Execution authorization was refused because no plan is committed.',
      stage: state.stage,
      blocking: true,
    });
  }
  return bump(state, { execution: { authorized } });
}

// ---------------------------------------------------------------------------
// Objectives, operations, verifications
// ---------------------------------------------------------------------------

export function recordObjective(
  state: RunWorkingState,
  objective: { readonly description: string; readonly stage: RunStage },
): RunWorkingState {
  const entry: Objective = {
    id: nextId('objective', state.objectives.length),
    description: objective.description,
    stage: objective.stage,
    status: 'pending',
  };
  return bump(state, { objectives: [...state.objectives, entry] });
}

/** Objectives still owed — what "remaining work" means, computed not asserted. */
export function remainingObjectives(state: RunWorkingState): readonly Objective[] {
  return state.objectives.filter((o) => o.status === 'pending');
}

export function recordOperation(
  state: RunWorkingState,
  operation: {
    readonly intent: string;
    readonly status: OperationRecord['status'];
    readonly patchId?: string;
    readonly failureReason?: string;
    readonly objectiveId?: string;
    readonly planId?: string;
    readonly decisionId?: string;
    readonly idempotencyKey?: string;
    readonly projectRevisionBefore?: ProjectRevision;
    readonly projectRevisionAfter?: ProjectRevision;
  },
): RunWorkingState {
  const planId = operation.planId ?? state.plan.id ?? 'legacy_plan';
  const decisionId = operation.decisionId ?? state.plan.decisionIds[0] ?? 'legacy_decision';
  const idempotencyKey = operation.idempotencyKey ?? `legacy:${operation.intent}`;
  const projectRevisionBefore = operation.projectRevisionBefore ?? state.currentProjectRevision;
  const projectRevisionAfter = operation.projectRevisionAfter ?? state.currentProjectRevision;
  const prior = state.operations.find((o) => o.idempotencyKey === idempotencyKey);
  if (prior?.status === 'succeeded' && operation.status === 'succeeded') return state;
  const entry: OperationRecord = {
    id: prior?.id ?? nextId('op', state.operations.length),
    intent: operation.intent,
    status: operation.status,
    atRevision: state.currentProjectRevision,
    attempts: (prior?.attempts ?? 0) + 1,
    planId,
    decisionId,
    idempotencyKey,
    projectRevisionBefore,
    projectRevisionAfter,
    ...(operation.patchId ? { patchId: operation.patchId } : {}),
    ...(operation.failureReason ? { failureReason: operation.failureReason } : {}),
    ...(operation.objectiveId ? { objectiveId: operation.objectiveId } : {}),
  };
  const operations = prior
    ? state.operations.map((o) => (o.id === prior.id ? entry : o))
    : [...state.operations, entry];
  return bump(state, { operations });
}

/**
 * Correct a `succeeded` operation the HOST then refused to write.
 *
 * The ledger records success on local validation alone (`conductor.ts#foldTurn`), which on
 * desktop is not the last word: the host re-checks every patch against the authoritative
 * project and can refuse it. A captured run's ledger read `status: 'succeeded'`,
 * `projectRevisionAfter: 1` for two edits against a project still at revision 0 with an
 * empty bin — and the briefing then listed them under "ALREADY APPLIED — do not repeat",
 * so the run would never retry the one thing it still owed.
 *
 * Corrects IN PLACE rather than appending a second row: `recordOperation` keys updates on
 * `idempotencyKey`, and the key carries the outcome, so re-recording the same work as failed
 * would leave the false success standing beside its own correction. The project revision is
 * wound back to what the operation started from, because that is the revision that still
 * exists.
 *
 * @param state - The run's working state.
 * @param patchId - The refused patch, matched against the operations' recorded `patchId`.
 * @param reason - The host's own words for the refusal; carried into `failureReason` so the
 *   briefing's "FAILED — fix the cause" section has a cause behind it.
 * @returns The corrected state, or `state` unchanged when no operation matches.
 */
export function recordHostRefusal(
  state: RunWorkingState,
  patchId: string,
  reason: string,
): RunWorkingState {
  const refused = state.operations.filter((op) => op.patchId === patchId);
  if (refused.length === 0) return state;
  const operations = state.operations.map((op) =>
    op.patchId === patchId
      ? {
          ...op,
          status: 'failed' as const,
          failureReason: reason,
          projectRevisionAfter: op.projectRevisionBefore,
        }
      : op,
  );
  // The earliest revision any refused operation started from: nothing the host rejected ever
  // advanced the project, so the run must not go on believing it did.
  const rewound = Math.min(...refused.map((op) => op.projectRevisionBefore));
  return bump(state, {
    operations,
    currentProjectRevision: Math.min(state.currentProjectRevision, rewound),
  });
}

/**
 * Record a verification and, when it passes, discharge the objective it was checking.
 * This is the ONLY path that satisfies an objective (§3.8) — reading, mapping, planning
 * and asserting cannot, which is what makes the completion report trustworthy.
 */
export function recordVerification(
  state: RunWorkingState,
  verification: {
    readonly criterion: string;
    readonly passed: boolean;
    readonly detail?: string;
    readonly objectiveId?: string;
  },
): RunWorkingState {
  const entry: VerificationRecord = {
    id: nextId('verify', state.verifications.length),
    criterion: verification.criterion,
    passed: verification.passed,
    atRevision: state.currentProjectRevision,
    ...(verification.detail ? { detail: verification.detail } : {}),
  };
  const objectives =
    verification.passed && verification.objectiveId
      ? state.objectives.map((o) =>
          o.id === verification.objectiveId ? { ...o, status: 'satisfied' as const } : o,
        )
      : state.objectives;
  return bump(state, { verifications: [...state.verifications, entry], objectives });
}

// ---------------------------------------------------------------------------
// Revision awareness (§3.7)
// ---------------------------------------------------------------------------

/**
 * Advance to a new project revision after an applied patch.
 *
 * Invalidates ONLY `timeline_dependent` knowledge. The transcript, the footage map, the
 * source durations and the creator's objective all survive, because a cut cannot change
 * any of them. This replaces the blanket `readCache.clear()` that used to throw away a
 * run's entire reconnaissance every time an edit landed.
 *
 * Stage, decisions and objectives are untouched by design: a project mutation is the run
 * making progress, not a reason to forget what it is doing.
 */
export function onProjectRevisionChanged(
  state: RunWorkingState,
  revision: ProjectRevision,
): RunWorkingState {
  if (revision === state.currentProjectRevision) return state;
  const facts = state.facts.filter((f) => f.scope === 'revision_independent');
  const evidence = state.evidence.filter((e) => e.scope === 'revision_independent');
  const dropped = state.facts.length - facts.length;
  if (dropped > 0) {
    log.debug('timeline-dependent knowledge invalidated', { revision, dropped });
  }
  return bump(state, { facts, evidence, currentProjectRevision: revision });
}

/** Evidence handles still valid at the current revision. */
export function liveEvidence(state: RunWorkingState): readonly EvidenceHandle[] {
  return state.evidence.filter(
    (e) =>
      e.scope === 'revision_independent' || e.observedAtRevision === state.currentProjectRevision,
  );
}

// ---------------------------------------------------------------------------
// Objective, next action, blockers
// ---------------------------------------------------------------------------

/**
 * Write the objective. Idempotent by intent: once an INTERPRETED outcome is recorded it is
 * never rewritten, because re-interpreting the request mid-run is exactly the drift this
 * module exists to prevent. A genuinely new request is a new run.
 *
 * `provisional` marks a deterministic placeholder derived from the request itself (see
 * {@link RunWorkingState}'s `objective.provisional`). A placeholder holds the field open so
 * the stage guards can pass, and yields to the first interpretation — which is what the
 * write-once rule was always meant to protect, rather than protecting the seed from ever
 * being improved.
 */
export function setObjective(
  state: RunWorkingState,
  objective: {
    readonly outcome: string;
    readonly acceptance: readonly { readonly description: string }[];
    readonly provisional?: boolean;
  },
): RunWorkingState {
  const provisional = objective.provisional === true;
  // A committed interpretation stands. A placeholder stands only against another one, so
  // the first real interpretation wins and a second placeholder cannot undo it.
  if (state.objective.outcome && (!state.objective.provisional || provisional)) return state;
  return bump(state, {
    objective: {
      request: state.objective.request,
      // A provisional outcome is the request read back, so it is stored bounded. A real
      // interpretation a turn wrote is kept whole — that one says something new.
      //
      // …unless it says nothing new. A turn can hand back the request VERBATIM as its
      // interpretation, and with `provisional: false` that stored a second whole copy of it:
      // captured run `e36235cc` carried its 9,885-character brief twice in every one of 57
      // run-state serializations. `JUDGEMENT_CRITERION` records the same problem being
      // solved for `criteria` ("a pointer keeps the meaning and drops the duplication") and
      // the fix was never applied here. Bounded by what it IS, not by which flag was set.
      outcome:
        provisional || isRequestEcho(objective.outcome, state.objective.request)
          ? requestEcho(objective.outcome)
          : objective.outcome,
      provisional,
      acceptance: objective.acceptance.map((a, i) => ({
        id: `criterion_${i + 1}`,
        description: a.description,
      })),
    },
  });
}

export function setNextAction(state: RunWorkingState, action: NextAction | null): RunWorkingState {
  return bump(state, { nextAction: action });
}

export function setBlocker(state: RunWorkingState, blocker: Blocker | null): RunWorkingState {
  return bump(state, { blockedOn: blocker });
}

/** Has the run been interpreted — i.e. does it know what "done" means? */
export function isInterpreted(state: RunWorkingState): boolean {
  return state.objective.outcome.trim().length > 0;
}

/**
 * Has the run actually delivered? True only when at least one operation succeeded and
 * every objective is satisfied — never because the model said so (§3.8).
 */
export function isDelivered(state: RunWorkingState): boolean {
  const applied = state.operations.some((o) => o.status === 'succeeded');
  const outstanding = state.objectives.some((o) => o.status === 'pending');
  return applied && !outstanding;
}

// ---------------------------------------------------------------------------
// Carrying knowledge across the run boundary (context-management P5.1)
// ---------------------------------------------------------------------------

/**
 * How a fact carried from an earlier run is marked in the briefing.
 *
 * The model must be able to tell a fact THIS run established from one it inherited: the
 * first has evidence it can recall, the second does not (see {@link carryForwardWorkingState}).
 * Presenting them identically would be the more comfortable choice and the wrong one.
 */
export const CARRIED_FACT_PREFIX = '(from an earlier session) ';

/**
 * Seed a fresh run's ledger with what the PREVIOUS run for the same conversation and
 * project established, and nothing else.
 *
 * ## Why this exists
 *
 * Run memory used to die at the run boundary. `historyFromEvents` keeps only the user and
 * assistant TEXT of prior turns, and `initialWorkingState` builds an empty ledger for
 * every command — so turn 1 ("find the best moments in this recording") could spend six
 * turns reading the transcript, mapping the footage and distilling forty facts, and turn 2
 * ("now tighten the middle") would start knowing the prose of what was said and nothing
 * about what was found. The only restore path was `agentOptions.resume`, which is a
 * within-run crash checkpoint, never a previous run's state.
 *
 * ## What is carried, and what is deliberately not
 *
 * Carried:
 *
 * - **`revision_independent` facts.** A fact about the SOURCE FOOTAGE ("asset_3 is 8:42,
 *   speech from 0:04") outlives any number of cuts. A fact about the TIMELINE ARRANGEMENT
 *   ("46 clips, sequence duration 21.87s") does not, and `FactScope` is exactly the field
 *   that tells them apart — it exists so this distinction can be made.
 * - **Committed decisions** made with the editor ("vertical, 9:16, no music"). These are
 *   the answers that die with the run today and get re-asked next turn.
 *
 * Not carried, each for its own reason:
 *
 * - **`nextAction`, `stage`, `objective`, the plan, blockers, verifications, operations.**
 *   They belong to the run that made them. A new request gets a new objective; inheriting
 *   the old one is how a run ends up executing the previous turn's plan.
 * - **Evidence handles — and the `evidenceIds` on carried facts with them.** The handles
 *   are addresses into the previous run's `EvidenceStore`, which is in-memory and per-run:
 *   the payloads are gone. Carrying an address that cannot be dereferenced is precisely the
 *   broken promise `clearedWithHandle` was written to end — an offer to re-read with
 *   nowhere to read from. Persisting the payloads would mean a new store, which this phase
 *   forbids. So a carried fact arrives uncited and SAYS SO, via
 *   {@link CARRIED_FACT_PREFIX}.
 * - **Anything at all, when the identity does not match.** Same conversation AND same
 *   project, or nothing is carried. A ledger from another project is not stale, it is
 *   wrong.
 *
 * Pure: `previous` and `fresh` are never mutated.
 *
 * @param previous - The prior run's parsed ledger, or `null` when there is none.
 * @param fresh - The new run's ledger from {@link initialWorkingState}.
 * @returns `fresh`, seeded — or `fresh` unchanged when there is nothing safe to carry.
 */
export function carryForwardWorkingState(
  previous: RunWorkingState | null,
  fresh: RunWorkingState,
): RunWorkingState {
  if (!previous) return fresh;
  // Identity first: a ledger from a different conversation or project is not stale, it is
  // about something else. `null` on either side is unknown, which is not a match.
  const sameConversation =
    previous.identity.conversationId !== null &&
    previous.identity.conversationId === fresh.identity.conversationId;
  const sameProject =
    previous.identity.projectId !== null &&
    previous.identity.projectId === fresh.identity.projectId;
  if (!sameConversation || !sameProject) return fresh;

  // Ids are re-prefixed because they are only unique WITHIN a run: `commitExecutionPlan`
  // mints `decision_1…n` for the new run's own plan, and a carried `decision_1` would
  // collide with it. The prefix also makes an inherited record identifiable in a dump.
  const carriedId = (id: string): string => (id.startsWith('carried_') ? id : `carried_${id}`);
  const facts = previous.facts
    .filter((fact) => fact.scope === 'revision_independent')
    .map((fact) => ({
      ...fact,
      id: carriedId(fact.id),
      // Uncited on purpose, and marked. See the docstring: the handles do not resolve.
      evidenceIds: [],
      statement: fact.statement.startsWith(CARRIED_FACT_PREFIX)
        ? fact.statement
        : `${CARRIED_FACT_PREFIX}${fact.statement}`,
      // Re-stamped to the new run's baseline: the fact is true of the source material, so
      // it is true at this revision, and leaving the old number would make the briefing
      // read as though it were observed here.
      observedAtRevision: fresh.baseProjectRevision,
      stage: fresh.stage,
    }));

  const decisions = previous.decisions
    .filter((decision) => decision.status === 'committed')
    .map((decision) => ({
      ...decision,
      id: carriedId(decision.id),
      evidenceIds: [],
      stage: fresh.stage,
    }));

  if (facts.length === 0 && decisions.length === 0) return fresh;
  const known = new Set(fresh.decisions.map((decision) => decision.decision));
  return {
    ...fresh,
    facts: [...facts, ...fresh.facts],
    // Carried decisions come FIRST and this run's own plan decisions LAST, so what the
    // run was actually asked to do reads as the live commitment and the inherited answers
    // read as background. A decision this run has already committed in the same words is
    // not repeated.
    decisions: [
      ...decisions.filter((decision) => !known.has(decision.decision)),
      ...fresh.decisions,
    ],
  };
}
