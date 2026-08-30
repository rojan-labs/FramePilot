/**
 * Tests for the run working state (plan/AGENT-TASK-MEMORY.md §3.1, ADR 0075).
 *
 * The module is pure, so every rule it enforces is asserted directly here rather than
 * through a run: legal and illegal stage moves, the forward-only rule and its one
 * escape hatch, decision lifecycle, revision-scoped invalidation, and the fact that
 * delivery is computed from operations and verifications rather than asserted.
 * This is a core deterministic module: every branch and error path is covered.
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_STAGES,
  WORKING_STATE_SCHEMA_VERSION,
  addDiagnostic,
  advanceStage,
  canAdvance,
  commitDecision,
  commitExecutionPlan,
  committedDecisions,
  initialWorkingState,
  isDelivered,
  isExecutionStage,
  isInterpreted,
  isPlanningStage,
  liveEvidence,
  onProjectRevisionChanged,
  parseWorkingState,
  recordDecision,
  recordEvidence,
  recordFact,
  recordObjective,
  recordOperation,
  recordVerification,
  remainingObjectives,
  revisitStage,
  setBlocker,
  setExecutionAuthorization,
  setNextAction,
  setObjective,
  stageEntryViolation,
  supersedeDecision,
  type RunWorkingState,
  clearVerifications,
} from './working-state.js';

const base = (): RunWorkingState =>
  initialWorkingState({ runId: 'run_1', request: 'cut this to 60s', projectRevision: 3 });

/** Walk the happy path to a given stage, so a test can start where it needs to. */
function at(stage: (typeof RUN_STAGES)[number]): RunWorkingState {
  const path: Record<string, readonly (typeof RUN_STAGES)[number][]> = {
    interpret: [],
    inspect: ['inspect'],
    analyze: ['inspect', 'analyze'],
    plan: ['inspect', 'analyze', 'plan'],
    apply: ['inspect', 'analyze', 'plan', 'apply'],
    enhance: ['inspect', 'analyze', 'plan', 'apply', 'enhance'],
    verify: ['inspect', 'analyze', 'plan', 'apply', 'enhance', 'verify'],
    repair: ['inspect', 'analyze', 'plan', 'apply', 'enhance', 'verify', 'repair'],
    complete: ['inspect', 'analyze', 'plan', 'apply', 'enhance', 'verify', 'complete'],
  };
  return (path[stage] ?? []).reduce((s, next, i) => advanceStage(s, next, i + 1), base());
}

describe('initialWorkingState / parseWorkingState', () => {
  it('starts at interpret, uninterpreted, bound to the given revision', () => {
    const state = base();
    expect(state.stage).toBe('interpret');
    expect(state.version).toBe(0);
    expect(isInterpreted(state)).toBe(false);
    expect(state.baseProjectRevision).toBe(3);
    expect(state.currentProjectRevision).toBe(3);
  });

  it('defaults the revision to 0 when the caller has none', () => {
    expect(initialWorkingState({ runId: 'r', request: 'x' }).currentProjectRevision).toBe(0);
  });

  it('round-trips through the schema', () => {
    const state = recordFact(base(), {
      kind: 'transcript',
      statement: 'Source runs 6:04.',
      scope: 'revision_independent',
    });
    expect(parseWorkingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('drops an unparseable record instead of throwing', () => {
    expect(parseWorkingState({ nonsense: true })).toBeNull();
    // An absent record — `undefined` or `null` — is the ordinary no-previous-ledger case
    // (a run's first `run_state` event), not a corrupt one.
    expect(parseWorkingState(undefined)).toBeNull();
    expect(parseWorkingState(null)).toBeNull();
    expect(parseWorkingState({ ...base(), schemaVersion: 99 })).toBeNull();
  });

  it('pins the schema version', () => {
    expect(WORKING_STATE_SCHEMA_VERSION).toBe(2);
  });
});

/**
 * v1 → v2 migration (RSI1, ADR 0081 §"Consequences": "persisted v1 working states
 * require deterministic migration"). v1 had no `identity`, `plan`, `execution`, or
 * `integrity` ledger and no per-operation `planId`/`decisionId`/`idempotencyKey`/
 * revision pair; v2 added all of them as the causal-authority record. A v1 record
 * therefore must be reconstructed ONLY from evidence it already contains — a committed
 * decision restores a legacy plan; a succeeded operation with no such evidence becomes
 * `orphaned` rather than silently trusted.
 */
describe('v1 → v2 working-state migration', () => {
  /** A minimally valid legacy (v1-shaped) persisted record. */
  function legacyRecord(overrides: {
    readonly stage?: (typeof RUN_STAGES)[number];
    readonly decisions?: readonly Record<string, unknown>[];
    readonly operations?: readonly Record<string, unknown>[];
  }): Record<string, unknown> {
    return {
      schemaVersion: 1,
      runId: 'run_legacy',
      version: 3,
      objective: { request: 'cut this to 60s', outcome: 'cut this to 60s', acceptance: [] },
      stage: overrides.stage ?? 'interpret',
      completedStages: [],
      stageEnteredAtTurn: 0,
      facts: [],
      decisions: overrides.decisions ?? [],
      evidence: [],
      objectives: [],
      operations: overrides.operations ?? [],
      verifications: [],
      nextAction: null,
      blockedOn: null,
      baseProjectRevision: 0,
      currentProjectRevision: 0,
      // v1 had none of these — included here only to prove migration REPLACES them
      // rather than trusting whatever a legacy caller happened to persist.
      identity: { conversationId: 'should-be-discarded', projectId: 'should-be-discarded' },
      plan: { status: 'committed', id: 'should-be-discarded' },
      execution: { authorized: true },
      integrity: { status: 'valid', diagnostics: [] },
    };
  }

  it('restores a legacy plan from a committed decision and keeps its succeeded operation traceable', () => {
    const legacyOp = {
      id: 'op_1',
      intent: 'Deleted 0:00–0:03',
      status: 'succeeded',
      atRevision: 1,
      attempts: 1,
    };
    const record = legacyRecord({
      stage: 'apply',
      decisions: [
        {
          id: 'decision_1',
          decision: 'Trim the intro',
          evidenceIds: [],
          stage: 'plan',
          status: 'committed',
          reconsiderIf: 'The project revision changes.',
        },
      ],
      operations: [legacyOp],
    });
    const migrated = parseWorkingState(record);
    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(WORKING_STATE_SCHEMA_VERSION);
    // Identity is reconstructed from scratch, never trusted from the legacy payload.
    expect(migrated?.identity).toEqual({
      conversationId: null,
      projectId: null,
      attemptId: 'run_legacy',
    });
    expect(migrated?.plan).toMatchObject({
      status: 'committed',
      id: 'legacy_plan_1',
      decisionIds: ['decision_1'],
    });
    expect(migrated?.execution.authorized).toBe(true);
    // A committed decision exists, so the previously-succeeded operation is trusted and
    // bound to the reconstructed plan/decision rather than orphaned.
    expect(migrated?.operations[0]).toMatchObject({
      status: 'succeeded',
      planId: 'legacy_plan_1',
      decisionId: 'decision_1',
    });
    expect(migrated?.operations[0]?.idempotencyKey).toContain('legacy:op_1');
    expect(migrated?.integrity.status).toBe('valid');
  });

  it('orphans an untraceable succeeded operation and flags for review when execution has no committed decision', () => {
    const legacyOp = {
      id: 'op_1',
      intent: 'Deleted 0:00–0:03',
      status: 'succeeded',
      atRevision: 1,
      attempts: 1,
    };
    const record = legacyRecord({ stage: 'apply', decisions: [], operations: [legacyOp] });
    const migrated = parseWorkingState(record);
    expect(migrated).not.toBeNull();
    expect(migrated?.plan.status).toBe('none');
    expect(migrated?.execution.authorized).toBe(false);
    // No committed decision backs this edit — the record cannot be trusted as-is, so the
    // operation is marked `orphaned` rather than kept `succeeded` on no evidence.
    expect(migrated?.operations[0]).toMatchObject({
      status: 'orphaned',
      planId: 'untraceable_legacy_plan',
      decisionId: 'untraceable_legacy_decision',
    });
    expect(migrated?.integrity.status).toBe('needs_review');
    expect(migrated?.integrity.diagnostics[0]).toMatchObject({
      code: 'RECOVERY_INCOMPATIBLE',
      blocking: true,
    });
  });

  it('does not flag a legacy record for review outside an execution stage, even with no committed decision', () => {
    const record = legacyRecord({ stage: 'analyze', decisions: [], operations: [] });
    const migrated = parseWorkingState(record);
    expect(migrated).not.toBeNull();
    expect(migrated?.plan.status).toBe('none');
    expect(migrated?.integrity.status).toBe('valid');
  });

  it('leaves a v2 record (or any other schema version) untouched by the v1 migration', () => {
    const state = base();
    expect(parseWorkingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    // A record claiming an unknown future version is neither migrated nor coerced.
    expect(parseWorkingState({ ...legacyRecord({}), schemaVersion: 3 })).toBeNull();
  });

  it('treats a missing (non-array) decisions list as no committed plan, not a crash', () => {
    const record = legacyRecord({ stage: 'analyze' });
    delete (record as Record<string, unknown>)['decisions'];
    const migrated = parseWorkingState(record);
    expect(migrated?.plan.status).toBe('none');
  });

  it('defaults the internal stage read to interpret without throwing when the legacy stage is missing', () => {
    // `stage` is ALSO required by the v2 schema (there is no separate internal-only
    // copy), so a record missing it is never schema-valid after migration either way —
    // but computing whether the run was `executing` (for the review diagnostic) from
    // this same defaulted value must not throw on the way to that rejection.
    const record = legacyRecord({});
    delete (record as Record<string, unknown>)['stage'];
    expect(() => parseWorkingState(record)).not.toThrow();
    expect(parseWorkingState(record)).toBeNull();
  });

  it('falls back the internal revision read to 0 without throwing when currentProjectRevision is not a number', () => {
    // `currentProjectRevision` is passed straight through from the legacy record (it is
    // not one of the fields this migration rewrites), so a non-numeric value here is
    // ALSO a schema violation on the output — the record is correctly rejected either
    // way. What this proves is that deriving the internal per-operation revision default
    // from the same malformed value never throws on the way to that rejection.
    const record = { ...legacyRecord({}), currentProjectRevision: 'unknown' };
    expect(() => parseWorkingState(record)).not.toThrow();
    expect(parseWorkingState(record)).toBeNull();
  });

  it('treats a missing (non-array) operations list as none rather than throwing', () => {
    const record = legacyRecord({ stage: 'interpret' });
    delete (record as Record<string, unknown>)['operations'];
    const migrated = parseWorkingState(record);
    expect(migrated?.operations).toEqual([]);
  });

  it('carries a non-object legacy operation through unchanged rather than indexing into it', () => {
    // A legacy record this malformed will not end up schema-valid overall (operations
    // are objects), but the per-operation migration step itself must not throw when an
    // entry is not the shape it expects — it hands the value back as-is and lets the
    // schema be the one that rejects it.
    const record = legacyRecord({ stage: 'interpret', operations: [] });
    (record as Record<string, unknown>)['operations'] = ['not an operation object', null];
    expect(() => parseWorkingState(record)).not.toThrow();
    expect(parseWorkingState(record)).toBeNull();
  });

  it('defaults a legacy operation missing atRevision to the record-level revision', () => {
    const legacyOp = { id: 'op_1', intent: 'Deleted 0:00–0:03', status: 'succeeded', attempts: 1 };
    const record = legacyRecord({
      stage: 'apply',
      decisions: [
        {
          id: 'decision_1',
          decision: 'Trim the intro',
          evidenceIds: [],
          stage: 'plan',
          status: 'committed',
          reconsiderIf: 'x',
        },
      ],
      operations: [legacyOp],
    });
    const migrated = parseWorkingState({ ...record, currentProjectRevision: 2 });
    expect(migrated?.operations[0]).toMatchObject({
      projectRevisionBefore: 2,
      projectRevisionAfter: 2,
      idempotencyKey: 'legacy:op_1',
    });
  });

  it('falls back an unindexed legacy operation id to its 1-based position without throwing', () => {
    // An operation record's own `id` is ALSO required by the v2 schema (there is no
    // separate internal-only copy), so an operation missing it is never schema-valid
    // after migration — but building its idempotency key from the positional fallback
    // must still not throw on the way to that (correct) rejection.
    const legacyOp = { intent: 'Deleted 0:00–0:03', status: 'succeeded', attempts: 1 };
    const record = legacyRecord({ stage: 'interpret', operations: [legacyOp] });
    expect(() => parseWorkingState(record)).not.toThrow();
    expect(parseWorkingState(record)).toBeNull();
  });

  it('attempts migration without throwing even when the legacy record omits version/runId', () => {
    // Both fields are ALSO required by the v2 schema itself (there is no separate
    // "internal-only" copy), so a record missing either one is never schema-valid after
    // migration either way — but the migration step that reads them for the review
    // diagnostic and the reconstructed identity must still degrade safely rather than
    // throwing on the way to that (correct) rejection.
    const noVersion = legacyRecord({ stage: 'apply', decisions: [], operations: [] });
    delete (noVersion as Record<string, unknown>)['version'];
    expect(() => parseWorkingState(noVersion)).not.toThrow();
    expect(parseWorkingState(noVersion)).toBeNull();

    const noRunId = legacyRecord({});
    delete (noRunId as Record<string, unknown>)['runId'];
    expect(() => parseWorkingState(noRunId)).not.toThrow();
    expect(parseWorkingState(noRunId)).toBeNull();
  });
});

describe('stage machine', () => {
  it('permits exactly the declared successors', () => {
    expect(canAdvance('interpret', 'inspect')).toBe(true);
    expect(canAdvance('inspect', 'plan')).toBe(true);
    expect(canAdvance('inspect', 'analyze')).toBe(true);
    expect(canAdvance('plan', 'apply')).toBe(true);
    expect(canAdvance('verify', 'repair')).toBe(true);
    expect(canAdvance('repair', 'verify')).toBe(true);
    expect(canAdvance('complete', 'inspect')).toBe(false);
  });

  it('refuses a jump that skips the machine', () => {
    const state = base();
    expect(advanceStage(state, 'apply', 1)).toBe(state);
  });

  it('refuses to wash back into reconnaissance from execution', () => {
    const state = at('apply');
    expect(advanceStage(state, 'inspect', 5)).toBe(state);
    expect(advanceStage(state, 'analyze', 5)).toBe(state);
  });

  it('records the stage it left as completed, once', () => {
    const state = advanceStage(advanceStage(base(), 'inspect', 1), 'analyze', 2);
    expect(state.completedStages).toEqual(['interpret', 'inspect']);
    expect(state.stageEnteredAtTurn).toBe(2);
  });

  it('cycles verify↔repair without duplicating completed stages', () => {
    const first = advanceStage(at('verify'), 'repair', 7);
    const back = advanceStage(first, 'verify', 8);
    const again = advanceStage(back, 'repair', 9);
    expect(again.stage).toBe('repair');
    expect(again.completedStages.filter((s) => s === 'verify')).toHaveLength(1);
    expect(again.completedStages.filter((s) => s === 'repair')).toHaveLength(1);
  });

  it('classifies planning and execution stages', () => {
    expect(isPlanningStage('analyze')).toBe(true);
    expect(isPlanningStage('apply')).toBe(false);
    expect(isExecutionStage('apply')).toBe(true);
    expect(isExecutionStage('enhance')).toBe(true);
    expect(isExecutionStage('repair')).toBe(true);
    expect(isExecutionStage('verify')).toBe(false);
  });
});

/**
 * `stageEntryViolation`'s guards are gated on the run having cross-surface identity
 * (`identity-gated guards`, ADR 0081): a v1-migrated or otherwise identity-less record is
 * exempt (line 515), so every guard below needs BOTH ids set to actually exercise the
 * checks — otherwise the whole function is a no-op and these lines never run.
 */
const identified = (): RunWorkingState =>
  initialWorkingState({
    runId: 'run_1',
    request: 'cut this to 60s',
    projectRevision: 3,
    conversationId: 'conv_1',
    projectId: 'proj_1',
  });

describe('stageEntryViolation — identity-gated guards', () => {
  it('allows entry with no violation once every requirement for the stage is met', () => {
    // The single "everything is fine" case — establishes the negative (null) result the
    // other cases below are contrasted against.
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    expect(stageEntryViolation(withObjective, 'inspect')).toBeNull();
  });

  it('blocks any stage past interpret while the durable objective is still unset', () => {
    expect(stageEntryViolation(identified(), 'inspect')).toMatchObject({
      code: 'OBJECTIVE_MISSING',
      blocking: true,
    });
  });

  it('blocks execution/verify/complete entry when no plan has been committed', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    expect(stageEntryViolation(withObjective, 'apply')).toMatchObject({
      code: 'PLAN_NOT_COMMITTED',
    });
  });

  it('blocks entry when the plan claims committed but was never given an id', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const claimedCommitted: RunWorkingState = {
      ...withObjective,
      plan: { ...withObjective.plan, status: 'committed', id: null },
    };
    expect(stageEntryViolation(claimedCommitted, 'apply')).toMatchObject({
      code: 'PLAN_NOT_COMMITTED',
    });
  });

  it('blocks entry when the committed plan has no committed decisions backing it', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const decisionsWiped: RunWorkingState = { ...committed, decisions: [] };
    expect(stageEntryViolation(decisionsWiped, 'apply')).toMatchObject({
      code: 'DECISIONS_MISSING',
    });
  });

  it('blocks entry when the plan itself lists no decision ids, even with committed decisions', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const planIdsWiped: RunWorkingState = {
      ...committed,
      plan: { ...committed.plan, decisionIds: [] },
    };
    expect(stageEntryViolation(planIdsWiped, 'apply')).toMatchObject({
      code: 'DECISIONS_MISSING',
    });
  });

  it('blocks execution entry when the plan-commit barrier was never crossed', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const notAuthorized: RunWorkingState = {
      ...committed,
      execution: { authorized: false },
    };
    expect(stageEntryViolation(notAuthorized, 'apply')).toMatchObject({
      code: 'EXECUTION_NOT_AUTHORIZED',
    });
  });

  it('blocks execution entry when the project moved on since the plan was committed and nothing landed yet', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const drifted: RunWorkingState = { ...committed, currentProjectRevision: 9 };
    expect(stageEntryViolation(drifted, 'apply')).toMatchObject({
      code: 'PROJECT_REVISION_STALE',
    });
  });

  it('does not treat revision drift as blocking once an operation has actually landed', () => {
    // The guard only fires while `operations` is empty — once something has been applied
    // against the plan, a later revision bump is ordinary progress, not staleness.
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const withOp = recordOperation(committed, { intent: 'Trim the intro', status: 'succeeded' });
    const drifted: RunWorkingState = { ...withOp, currentProjectRevision: 9 };
    expect(stageEntryViolation(drifted, 'apply')).toBeNull();
  });

  it('blocks verify entry when nothing has actually landed against the plan', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    expect(stageEntryViolation(committed, 'verify')).toMatchObject({
      code: 'OPERATIONS_UNTRACEABLE',
    });
  });

  it('blocks complete entry when the run has not actually delivered (no succeeded operation)', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    expect(stageEntryViolation(committed, 'complete')).toMatchObject({
      code: 'VERIFICATION_INCONCLUSIVE',
    });
  });

  it('blocks complete entry when delivery is proven but no verification evidence was recorded', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const delivered = recordOperation(committed, {
      intent: 'Trim the intro',
      status: 'succeeded',
      objectiveId: 'objective_1',
    });
    const satisfied: RunWorkingState = {
      ...delivered,
      objectives: delivered.objectives.map((o) => ({ ...o, status: 'satisfied' as const })),
    };
    expect(stageEntryViolation(satisfied, 'complete')).toMatchObject({
      code: 'VERIFICATION_INCONCLUSIVE',
    });
  });

  it('blocks complete entry when a recorded verification actually failed', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const delivered = recordOperation(committed, {
      intent: 'Trim the intro',
      status: 'succeeded',
      objectiveId: 'objective_1',
    });
    const satisfied: RunWorkingState = {
      ...delivered,
      objectives: delivered.objectives.map((o) => ({ ...o, status: 'satisfied' as const })),
    };
    const failedVerify = recordVerification(satisfied, { criterion: 'duration', passed: false });
    expect(stageEntryViolation(failedVerify, 'complete')).toMatchObject({
      code: 'VERIFICATION_INCONCLUSIVE',
    });
  });

  it('allows complete entry once delivery is proven and every verification passed', () => {
    const withObjective = setObjective(identified(), { outcome: 'x', acceptance: [] });
    const committed = commitExecutionPlan(withObjective, ['Trim the intro'], 0);
    const delivered = recordOperation(committed, {
      intent: 'Trim the intro',
      status: 'succeeded',
      objectiveId: 'objective_1',
    });
    const satisfied: RunWorkingState = {
      ...delivered,
      objectives: delivered.objectives.map((o) => ({ ...o, status: 'satisfied' as const })),
    };
    const verified = recordVerification(satisfied, { criterion: 'duration', passed: true });
    expect(stageEntryViolation(verified, 'complete')).toBeNull();
  });

  it('surfaces the violation through advanceStage itself: the run is diverted into review, not silently stuck', () => {
    // advanceStage's own log+addDiagnostic branch (not just stageEntryViolation) needs an
    // identity-bearing state to run at all — this is the one integration-level assertion.
    let atPlan = setObjective(identified(), { outcome: 'x', acceptance: [] });
    atPlan = advanceStage(atPlan, 'inspect', 1);
    atPlan = advanceStage(atPlan, 'analyze', 2);
    atPlan = advanceStage(atPlan, 'plan', 3);
    expect(atPlan.stage).toBe('plan');
    const blocked = advanceStage(atPlan, 'apply', 4);
    expect(blocked.stage).toBe('plan');
    expect(blocked.integrity.status).toBe('needs_review');
    expect(blocked.integrity.diagnostics.at(-1)).toMatchObject({ code: 'PLAN_NOT_COMMITTED' });
  });
});

describe('revisitStage — the only way backwards', () => {
  it('refuses without a named cause', () => {
    const state = at('plan');
    expect(revisitStage(state, 'analyze', 4, '   ')).toBe(state);
  });

  it('refuses a target that is not strictly earlier', () => {
    const state = at('plan');
    expect(revisitStage(state, 'apply', 4, 'because')).toBe(state);
    expect(revisitStage(state, 'plan', 4, 'because')).toBe(state);
  });

  it('moves back with a cause, and records the cause as an auditable fact', () => {
    const state = revisitStage(at('plan'), 'analyze', 4, 'silence report came back empty');
    expect(state.stage).toBe('analyze');
    expect(state.stageEnteredAtTurn).toBe(4);
    expect(state.facts.at(-1)?.statement).toContain('silence report came back empty');
    // Stages at or after the revisit target are no longer "completed".
    expect(state.completedStages).toEqual(['interpret', 'inspect']);
  });
});

describe('facts and evidence', () => {
  it('records a fact with provenance at the current revision', () => {
    const state = recordFact(base(), {
      kind: 'transcript',
      statement: 'Hook is at 0:12.',
      scope: 'revision_independent',
      evidenceIds: ['ev_1'],
    });
    expect(state.facts).toHaveLength(1);
    expect(state.facts[0]).toMatchObject({
      id: 'fact_1',
      evidenceIds: ['ev_1'],
      observedAtRevision: 3,
      stage: 'interpret',
    });
    expect(state.version).toBe(1);
  });

  it('deduplicates an identical statement without bumping the version', () => {
    const once = recordFact(base(), {
      kind: 'derived',
      statement: 'same',
      scope: 'timeline_dependent',
    });
    expect(
      recordFact(once, { kind: 'derived', statement: 'same', scope: 'timeline_dependent' }),
    ).toBe(once);
  });

  it('indexes evidence handles once each', () => {
    const handle = {
      id: 'ev_1',
      source: 'get_transcript',
      descriptor: '400 words, 0:00–6:04',
      scope: 'revision_independent' as const,
    };
    const once = recordEvidence(base(), handle);
    expect(once.evidence).toHaveLength(1);
    expect(recordEvidence(once, handle)).toBe(once);
  });
});

describe('decision ledger', () => {
  it('starts tentative and commits on request', () => {
    const drafted = recordDecision(base(), {
      decision: 'Keep 0:12–0:26',
      reconsiderIf: 'the hook proves to be elsewhere',
    });
    expect(drafted.decisions[0]!.status).toBe('tentative');
    expect(committedDecisions(drafted)).toHaveLength(0);

    const committed = commitDecision(drafted, 'decision_1');
    expect(committedDecisions(committed)).toHaveLength(1);
  });

  it('can be committed at birth', () => {
    const state = recordDecision(base(), {
      decision: 'Target 90s',
      reconsiderIf: 'the creator asks for a different length',
      committed: true,
    });
    expect(committedDecisions(state)).toHaveLength(1);
  });

  it('commits one decision without disturbing its siblings', () => {
    const two = recordDecision(recordDecision(base(), { decision: 'a', reconsiderIf: 'r' }), {
      decision: 'b',
      reconsiderIf: 'r',
    });
    const state = commitDecision(two, 'decision_2');
    expect(state.decisions.map((d) => d.status)).toEqual(['tentative', 'committed']);
  });

  it('ignores commits for unknown or already-settled decisions', () => {
    const state = recordDecision(base(), { decision: 'd', reconsiderIf: 'r', committed: true });
    expect(commitDecision(state, 'nope')).toBe(state);
    expect(commitDecision(state, 'decision_1')).toBe(state);
  });

  it('supersedes rather than deletes, keeping the ledger honest', () => {
    const state = recordDecision(base(), {
      decision: 'Keep 0:12–0:26',
      reconsiderIf: 'the hook proves to be elsewhere',
      committed: true,
    });
    const revised = supersedeDecision(state, 'decision_1', {
      decision: 'Keep 1:48–2:03',
      reconsiderIf: 'never',
    });
    expect(revised.decisions[0]).toMatchObject({
      status: 'superseded',
      supersededBy: 'decision_2',
    });
    expect(committedDecisions(revised).map((d) => d.id)).toEqual(['decision_2']);
  });

  it('refuses to supersede an unknown or already-superseded decision', () => {
    const state = recordDecision(base(), { decision: 'd', reconsiderIf: 'r', committed: true });
    expect(supersedeDecision(state, 'nope', { decision: 'x', reconsiderIf: 'y' })).toBe(state);
    const once = supersedeDecision(state, 'decision_1', { decision: 'x', reconsiderIf: 'y' });
    expect(supersedeDecision(once, 'decision_1', { decision: 'z', reconsiderIf: 'y' })).toBe(once);
  });
});

describe('commitExecutionPlan — the one durable commitment barrier', () => {
  it('is idempotent: re-committing an already-committed plan is a no-op, not a second plan', () => {
    const once = commitExecutionPlan(base(), ['Trim the intro'], 0);
    const twice = commitExecutionPlan(once, ['A completely different label'], 5);
    // Same reference back — no new decisions/objectives, no version bump.
    expect(twice).toBe(once);
  });
});

describe('setExecutionAuthorization', () => {
  it('is a no-op when the state already reads the requested value', () => {
    const state = base();
    expect(setExecutionAuthorization(state, false)).toBe(state);
  });

  it('refuses to authorize execution without a committed plan, filing a diagnostic instead', () => {
    const state = base();
    const result = setExecutionAuthorization(state, true);
    expect(result.execution.authorized).toBe(false);
    expect(result.integrity.diagnostics.at(-1)).toMatchObject({ code: 'PLAN_NOT_COMMITTED' });
  });

  it('authorizes execution once a plan is committed', () => {
    const committed = commitExecutionPlan(base(), ['Trim the intro'], 0);
    const deauthorized = setExecutionAuthorization(committed, false);
    const reauthorized = setExecutionAuthorization(deauthorized, true);
    expect(reauthorized.execution.authorized).toBe(true);
  });
});

describe('addDiagnostic', () => {
  it('deduplicates the identical (code, message) pair rather than piling up repeats', () => {
    const once = addDiagnostic(base(), {
      code: 'PLAN_NOT_COMMITTED',
      message: 'no plan',
      stage: 'plan',
      blocking: true,
    });
    const twice = addDiagnostic(once, {
      code: 'PLAN_NOT_COMMITTED',
      message: 'no plan',
      stage: 'plan',
      blocking: true,
    });
    expect(twice).toBe(once);
  });

  it('records a non-blocking diagnostic without touching execution authorization or integrity status', () => {
    const committed = commitExecutionPlan(base(), ['Trim the intro'], 0);
    const noted = addDiagnostic(committed, {
      code: 'NOTE',
      message: 'informational only',
      stage: committed.stage,
      blocking: false,
    });
    expect(noted.execution.authorized).toBe(true);
    expect(noted.integrity.status).toBe('valid');
    expect(noted.blockedOn).toBeNull();
    expect(noted.integrity.diagnostics.at(-1)).toMatchObject({ code: 'NOTE' });
  });
});

describe('objectives, operations, verification', () => {
  it('tracks what is still owed', () => {
    const state = recordObjective(recordObjective(base(), { description: 'cut', stage: 'apply' }), {
      description: 'captions',
      stage: 'enhance',
    });
    expect(remainingObjectives(state)).toHaveLength(2);
  });

  it('counts attempts against one intent rather than piling up records', () => {
    const first = recordOperation(base(), { intent: 'ripple_delete 2:10–3:40', status: 'failed' });
    const retried = recordOperation(first, {
      intent: 'ripple_delete 2:10–3:40',
      status: 'succeeded',
      patchId: 'patch_1',
    });
    expect(retried.operations).toHaveLength(1);
    expect(retried.operations[0]).toMatchObject({
      status: 'succeeded',
      patchId: 'patch_1',
      attempts: 2,
    });
  });

  it('treats a second "succeeded" report for the same intent as the same fact, not a new attempt', () => {
    // Idempotency key collision + both sides already succeeded means this is a replay of
    // the same completed edit (e.g. a retried tool-result delivery), not a genuine retry
    // — the ledger entry (and its `attempts` count) must not double-count it.
    const first = recordOperation(base(), {
      intent: 'ripple_delete 2:10–3:40',
      status: 'succeeded',
    });
    const replayed = recordOperation(first, {
      intent: 'ripple_delete 2:10–3:40',
      status: 'succeeded',
    });
    expect(replayed).toBe(first);
  });

  it('retries one operation without disturbing the others', () => {
    let state = recordOperation(base(), { intent: 'cut A', status: 'succeeded', patchId: 'p1' });
    state = recordOperation(state, { intent: 'cut B', status: 'failed' });
    state = recordOperation(state, { intent: 'cut B', status: 'succeeded', patchId: 'p2' });
    expect(state.operations).toHaveLength(2);
    expect(state.operations.map((o) => o.attempts)).toEqual([1, 2]);
    expect(state.operations[0]!.patchId).toBe('p1');
  });

  it('keeps the failure reason and objective link', () => {
    const state = recordOperation(base(), {
      intent: 'x',
      status: 'failed',
      failureReason: 'validator refused',
      objectiveId: 'objective_1',
    });
    expect(state.operations[0]).toMatchObject({
      failureReason: 'validator refused',
      objectiveId: 'objective_1',
    });
  });

  it('satisfies an objective only through a passing verification', () => {
    const withObjective = recordObjective(base(), { description: 'cut', stage: 'apply' });
    const failed = recordVerification(withObjective, {
      criterion: 'duration ≤ 90s',
      passed: false,
      detail: 'still 4:10',
      objectiveId: 'objective_1',
    });
    expect(remainingObjectives(failed)).toHaveLength(1);

    const passed = recordVerification(failed, {
      criterion: 'duration ≤ 90s',
      passed: true,
      objectiveId: 'objective_1',
    });
    expect(remainingObjectives(passed)).toHaveLength(0);
  });

  it('discharges only the objective it names', () => {
    let state = recordObjective(base(), { description: 'cut', stage: 'apply' });
    state = recordObjective(state, { description: 'captions', stage: 'enhance' });
    state = recordVerification(state, {
      criterion: 'duration ≤ 90s',
      passed: true,
      objectiveId: 'objective_1',
    });
    expect(state.objectives.map((o) => o.status)).toEqual(['satisfied', 'pending']);
  });

  it('does not satisfy anything when the verification names no objective', () => {
    const state = recordVerification(
      recordObjective(base(), { description: 'c', stage: 'apply' }),
      {
        criterion: 'looks fine',
        passed: true,
      },
    );
    expect(remainingObjectives(state)).toHaveLength(1);
  });

  it('reports delivery only when work applied AND nothing is outstanding', () => {
    const withObjective = recordObjective(base(), { description: 'cut', stage: 'apply' });
    expect(isDelivered(withObjective)).toBe(false);

    const applied = recordOperation(withObjective, {
      intent: 'cut',
      status: 'succeeded',
      patchId: 'p',
    });
    expect(isDelivered(applied)).toBe(false); // objective still pending

    const verified = recordVerification(applied, {
      criterion: 'c',
      passed: true,
      objectiveId: 'objective_1',
    });
    expect(isDelivered(verified)).toBe(true);
  });

  it('is not delivered on verification alone — analysis is not editing', () => {
    const state = recordVerification(base(), { criterion: 'c', passed: true });
    expect(isDelivered(state)).toBe(false);
  });
});

describe('revision awareness', () => {
  const seeded = () => {
    let state = base();
    state = recordFact(state, {
      kind: 'transcript',
      statement: 'The words spoken do not change when the timeline does.',
      scope: 'revision_independent',
    });
    state = recordFact(state, {
      kind: 'project',
      statement: 'clip_b runs 6–10s.',
      scope: 'timeline_dependent',
    });
    state = recordEvidence(state, {
      id: 'ev_transcript',
      source: 'get_transcript',
      descriptor: 'words',
      scope: 'revision_independent',
    });
    state = recordEvidence(state, {
      id: 'ev_timeline',
      source: 'get_timeline',
      descriptor: 'clips',
      scope: 'timeline_dependent',
    });
    return state;
  };

  it('invalidates only timeline-dependent knowledge', () => {
    const next = onProjectRevisionChanged(seeded(), 4);
    expect(next.facts.map((f) => f.kind)).toEqual(['transcript']);
    expect(next.evidence.map((e) => e.id)).toEqual(['ev_transcript']);
    expect(next.currentProjectRevision).toBe(4);
  });

  it('leaves stage, decisions and objectives untouched — a cut is progress, not amnesia', () => {
    let state = at('apply');
    state = recordDecision(state, {
      decision: 'keep 0:12–0:26',
      reconsiderIf: 'x',
      committed: true,
    });
    state = recordObjective(state, { description: 'captions', stage: 'enhance' });
    const next = onProjectRevisionChanged(state, 9);
    expect(next.stage).toBe('apply');
    expect(committedDecisions(next)).toHaveLength(1);
    expect(remainingObjectives(next)).toHaveLength(1);
  });

  it('is a no-op when the revision has not moved', () => {
    const state = seeded();
    expect(onProjectRevisionChanged(state, 3)).toBe(state);
  });

  it('reports evidence still valid at the current revision', () => {
    const state = seeded();
    expect(liveEvidence(state).map((e) => e.id)).toEqual(['ev_transcript', 'ev_timeline']);
    // A handle observed at an older revision is stale unless it is revision-independent.
    const moved = { ...state, currentProjectRevision: 4 };
    expect(liveEvidence(moved).map((e) => e.id)).toEqual(['ev_transcript']);
  });
});

describe('objective, next action, blockers', () => {
  it('writes the interpreted objective once and never rewrites it', () => {
    const first = setObjective(base(), {
      outcome: '≤90s vertical cut, captioned',
      acceptance: [{ description: 'duration between 60 and 90 seconds' }],
    });
    expect(isInterpreted(first)).toBe(true);
    expect(first.objective.acceptance[0]!.id).toBe('criterion_1');
    expect(first.objective.request).toBe('cut this to 60s');

    const attempted = setObjective(first, { outcome: 'something else', acceptance: [] });
    expect(attempted).toBe(first);
  });

  it('lets a real interpretation replace a PROVISIONAL objective, once', () => {
    // Every stage past `interpret` is gated on a non-empty outcome, so the field cannot
    // start blank and wait — it is seeded from the request. Write-once then made that seed
    // permanent, so an interpretation could never land. Write-once belongs on the
    // interpretation, not on the placeholder holding its seat.
    const seeded = setObjective(base(), {
      outcome: 'cut this to 60s',
      acceptance: [{ description: 'cut this to 60s' }],
      provisional: true,
    });
    expect(seeded.objective.provisional).toBe(true);
    expect(isInterpreted(seeded)).toBe(true);

    const interpreted = setObjective(seeded, {
      outcome: '≤60s vertical cut, captioned',
      acceptance: [{ description: 'duration at or under 60 seconds' }],
    });
    expect(interpreted.objective.outcome).toBe('≤60s vertical cut, captioned');
    expect(interpreted.objective.provisional).toBe(false);
    // …and it is now protected like any interpretation.
    expect(setObjective(interpreted, { outcome: 'drift', acceptance: [] })).toBe(interpreted);
  });

  it('does not let a second placeholder overwrite the first', () => {
    // Two provisional writes in a row must not make the objective a moving target.
    const seeded = setObjective(base(), {
      outcome: 'cut this to 60s',
      acceptance: [],
      provisional: true,
    });
    expect(setObjective(seeded, { outcome: 'contine', acceptance: [], provisional: true })).toBe(
      seeded,
    );
  });

  it('carries the next action and the blocker that reopens a closed read', () => {
    const action = { stage: 'apply' as const, action: 'apply the three ripple deletes' };
    const state = setNextAction(base(), action);
    expect(state.nextAction).toEqual(action);
    expect(setNextAction(state, null).nextAction).toBeNull();

    const blocked = setBlocker(state, {
      reason: 'no caption track exists yet',
      missing: 'transcript for 4:31–4:58',
      atStage: 'enhance',
    });
    expect(blocked.blockedOn?.missing).toBe('transcript for 4:31–4:58');
    expect(setBlocker(blocked, null).blockedOn).toBeNull();
  });
});

describe('D4 — the brief is not stored twice', () => {
  it('bounds an outcome that is the request handed straight back', () => {
    // A turn can hand the request back VERBATIM as its interpretation, and with
    // `provisional: false` that stored a second whole copy: captured run `e36235cc` carried
    // its 9,885-character brief twice in every one of 57 run-state serializations.
    const brief = `Build a 50-clip montage. ${'Every cut lands on a beat. '.repeat(60)}`;
    const seeded = initialWorkingState({ request: brief, projectRevision: 0 });
    const state = setObjective(seeded, { outcome: brief, acceptance: [], provisional: false });
    expect(state.objective.outcome.length).toBeLessThan(brief.length);
    expect(state.objective.request).toBe(brief.trim());
  });

  it('keeps a real interpretation whole — that one says something new', () => {
    const brief = `Build a 50-clip montage. ${'Every cut lands on a beat. '.repeat(60)}`;
    const interpretation =
      'Source 60 nature clips, detect the beat grid, and cut every clip to an onset.';
    const seeded = initialWorkingState({ request: brief, projectRevision: 0 });
    const state = setObjective(seeded, {
      outcome: interpretation,
      acceptance: [],
      provisional: false,
    });
    expect(state.objective.outcome).toBe(interpretation);
  });
});

describe('clearVerifications (P4.3)', () => {
  it('flips only the named standing failures to passed, keeping the original finding', () => {
    let state = initialWorkingState({ runId: 'run_x', request: 'r' });
    state = recordVerification(state, { criterion: 'No overlaps', passed: false, detail: 'a' });
    state = recordVerification(state, { criterion: 'Duration', passed: false, detail: 'b' });
    state = recordVerification(state, { criterion: 'Refs', passed: true });
    const next = clearVerifications(state, new Set(['No overlaps']), 'cleared on fix turn 1');
    expect(next.verifications.map((v) => [v.criterion, v.passed, v.detail])).toEqual([
      ['No overlaps', true, 'cleared on fix turn 1 (was: a)'],
      ['Duration', false, 'b'],
      ['Refs', true, undefined],
    ]);
    // Nothing to clear → the same state object, no version bump.
    expect(clearVerifications(next, new Set(['Refs', 'ghost']), 'n')).toBe(next);
  });
});
