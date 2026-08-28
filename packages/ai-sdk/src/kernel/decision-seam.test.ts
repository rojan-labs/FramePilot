/**
 * M3 — the decision seam is pure (plan/LANGCHAIN-MIGRATION.md §5.2, M3.1/M3.4).
 *
 * §5.2 is the plan's single most important design decision: a LangGraph node must be a
 * thin shell — read state, do I/O, call a **pure** decision, write state — so the
 * orchestration logic stays table-testable with no mocks and replayable, instead of
 * dissolving into async node bodies.
 *
 * That property is only worth anything if something checks it. These tests call each
 * exported decision the way a graph node would and assert the three things that make it
 * a usable seam:
 *
 * 1. **Deterministic** — same state, same result, same events, twice.
 * 2. **Non-mutating** — the input state is untouched, so a node can hold the old value
 *    (shadow mode in M6 runs both paths over the same state and compares).
 * 3. **No mocks needed** — every test below constructs plain data. If a decision ever
 *    needed a stub to run, it would have acquired I/O and §5.2 would be broken.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '../events.js';
import type { TurnRef } from '../events.js';
import {
  initialConductorState,
  onApprovalResult,
  onDraftPlanResult,
  onResumeResult,
  onTurnResult,
  onVerifyResult,
  type AgentTurnResult,
  type ConductorState,
  type FramePilotRunState,
  type VerifyResult,
} from './conductor.js';

const ref: TurnRef = { conversationId: 'conv_m3', turnId: 'turn_m3', now: () => 1000 };

/** Seed an emitter exactly as a graph node would: at the state's current `seq`. */
const emitterFor = (state: ConductorState) => createTurnEmitter(ref, state.seq);

const baseState = (): ConductorState => initialConductorState(ref);

const turnResult = (overrides: Partial<AgentTurnResult> = {}): AgentTurnResult => ({
  kind: 'agent_turn',
  stepIndex: 1,
  aborted: false,
  done: true,
  anyToolCancelled: false,
  anyToolFailed: false,
  turnOpCount: 0,
  rejectedOpCount: 0,
  rejectionNotes: [],
  applied: false,
  appliedOps: [],
  describedActions: [],
  signature: 'sig',
  callFacts: [],
  note: 'note',
  planSteps: [{ id: 'step-1', label: 'tighten intro', status: 'running' }],
  planStepIndex: 0,
  intent: 'tighten intro',
  log: [],
  endSeq: 0,
  ...overrides,
});

const verifyResult = (overrides: Partial<VerifyResult> = {}): VerifyResult => ({
  kind: 'verify',
  ok: true,
  summary: 'verified',
  failedChecks: [],
  warnedChecks: [],
  repairOps: [],
  endSeq: 0,
  ...overrides,
});

/** Every decision, invoked the way a node would. Names match the exported functions. */
const DECISIONS = [
  [
    'onDraftPlanResult',
    (s: ConductorState) =>
      onDraftPlanResult(
        s,
        { kind: 'draft_plan', labels: ['a', 'b'], endSeq: s.seq },
        emitterFor(s),
      ),
  ],
  [
    'onApprovalResult',
    (s: ConductorState) =>
      onApprovalResult(s, { kind: 'approval', decision: 'approved', endSeq: s.seq }, emitterFor(s)),
  ],
  [
    'onResumeResult',
    (s: ConductorState) =>
      onResumeResult(
        s,
        { kind: 'resume', ok: false, ops: [], log: [], stepsCompleted: 0, endSeq: s.seq },
        emitterFor(s),
      ),
  ],
  ['onTurnResult', (s: ConductorState) => onTurnResult(s, turnResult(), emitterFor(s))],
  ['onVerifyResult', (s: ConductorState) => onVerifyResult(s, verifyResult(), emitterFor(s))],
] as const;

describe('M3 — the decision seam is callable and pure', () => {
  it.each(DECISIONS)('%s is deterministic across identical calls', (_name, call) => {
    // A graph node calls this twice in shadow mode (M6) over the same state and compares.
    // A decision that folded in a clock, a random id or a module-level counter would
    // make every shadow run report a false divergence.
    expect(call(baseState())).toEqual(call(baseState()));
  });

  it.each(DECISIONS)('%s does not mutate the state it was given', (_name, call) => {
    // Compared against a freshly built pristine state rather than a clone: `turnRef`
    // carries the injected `now` function, which `structuredClone` refuses — and
    // `initialConductorState` is itself deterministic, so a pristine build IS the
    // "before" snapshot.
    const state = baseState();
    call(state);
    expect(state).toEqual(baseState());
  });

  it.each(DECISIONS)('%s returns the full step contract a node writes back', (_name, call) => {
    const step = call(baseState());
    expect(step.state).toBeDefined();
    expect(Array.isArray(step.effects)).toBe(true);
    expect(Array.isArray(step.events)).toBe(true);
  });

  it.each(DECISIONS)('%s advances seq monotonically, never rewinding it', (_name, call) => {
    // §7.4: `seq` is one monotonic sequence shared across the control/execution
    // boundary. A decision that reset or rewound it would break event ids for the
    // sidebar, the WAL and the replay harness at once.
    const state = baseState();
    expect(call(state).state.seq).toBeGreaterThanOrEqual(state.seq);
  });

  it('needs no mocks — a decision is reached with plain data alone', () => {
    // The assertion is the absence of any stub in this file. Stated as a test so the
    // property is recorded where it can fail, rather than only in a comment.
    const step = onTurnResult(baseState(), turnResult({ done: true }), emitterFor(baseState()));
    expect(step.effects.length + step.events.length).toBeGreaterThan(0);
  });
});

describe('M3 — decisions branch on evidence, table-testable with no mocks', () => {
  it('an aborted turn finalizes rather than continuing', () => {
    const state = baseState();
    const step = onTurnResult(state, turnResult({ aborted: true }), emitterFor(state));
    expect(step.effects.map((effect) => effect.kind)).toContain('finalize');
  });

  it('a mid-turn tool cancellation also finalizes, and does not verify', () => {
    const state = baseState();
    const step = onTurnResult(state, turnResult({ anyToolCancelled: true }), emitterFor(state));
    expect(step.effects.map((effect) => effect.kind)).toContain('finalize');
    expect(step.effects.map((effect) => effect.kind)).not.toContain('run_verify');
  });

  it('a turn that is not done runs another turn instead of verifying', () => {
    const state = baseState();
    const step = onTurnResult(state, turnResult({ done: false }), emitterFor(state));
    expect(step.effects.map((effect) => effect.kind)).toContain('run_turn');
  });

  it('a cancelled approval does not proceed to a turn', () => {
    const state = baseState();
    const step = onApprovalResult(
      state,
      { kind: 'approval', decision: 'cancelled', endSeq: state.seq },
      emitterFor(state),
    );
    expect(step.effects.map((effect) => effect.kind)).not.toContain('run_turn');
  });
});

describe('M3.4 — the frozen run-state contract', () => {
  it('FramePilotRunState IS the reducer state, not a translated copy', () => {
    // §4.2 freezes the shape deliberately: a parallel type would mean a translation
    // layer on every node boundary, and that is where typed Operation/Patch contracts
    // get quietly bent (risk 10). Assigning both ways proves they are one type.
    const fromReducer: ConductorState = baseState();
    const asContract: FramePilotRunState = fromReducer;
    const backAgain: ConductorState = asContract;
    expect(backAgain).toBe(fromReducer);
  });

  it('carries the fields §4.2 lists as graph state', () => {
    const state: FramePilotRunState = baseState();
    expect(state).toHaveProperty('seq');
    expect(state).toHaveProperty('stepIndex');
    expect(state).toHaveProperty('working');
    expect(state).toHaveProperty('planSteps');
    expect(state).toHaveProperty('turnRef');
  });
});
