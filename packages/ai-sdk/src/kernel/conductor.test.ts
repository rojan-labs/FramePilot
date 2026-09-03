/**
 * Table tests for the K1.2 Conductor reducer (plan/AI-ORCHESTRATION-REDESIGN.md §7).
 *
 * Pure `(state, x) → step` — no mocks, no timers. Each case asserts the next phase,
 * the emitted effect(s), and the structural events for one decision of the ported
 * agent-loop control flow: start (+ resume / planFirst pre-turn effects), the plan
 * ledger the reducer owns (running → terminal), cancel/checkpoint (turn-boundary vs
 * mid-turn tool cancel), done→verify, the per-turn/per-run op caps, the step cap,
 * validator-rejection accounting, the no-progress guard, `timeline_action` emission,
 * and verify(+repair)→finalize. Event-id seq is seeded from each result's `endSeq`.
 */
import { JUDGEMENT_CRITERION } from '../acceptance.js';
import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import type { ContextInput } from '../context-builder.js';
import type { PlanStep } from '../events.js';
import { makeProject } from '../__fixtures__/project.js';
import type { Command } from './commands.js';
import {
  type AgentTurnResult,
  type TurnCallFact,
  type ConductorState,
  type DraftPlanResult,
  type ResumeResult,
  type VerifyResult,
  STALL_CONFIRM_TURNS,
  RESEARCH_BUDGET_TURNS,
  PLAN_APPROVAL_STEP_THRESHOLD,
  DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
  DIMINISHING_RETURNS_REASON,
  DIMINISHING_RETURNS_TURNS,
  initialConductorState,
  onCommand,
  onEffectResult,
  MAX_VERIFY_FIX_TURNS,
  failedAfterApplyMessage,
} from './conductor.js';
import { SEMANTIC_LOOP_TURNS } from './loop-detector.js';

/** Exactly `PLAN_APPROVAL_STEP_THRESHOLD` step labels — at the gate, not over it. */
const labelsAtThreshold = Array.from({ length: PLAN_APPROVAL_STEP_THRESHOLD }, (_, i) => `s${i}`);
/** One more than the gate threshold — the smallest plan the approval gate catches. */
const labelsOverThreshold = [...labelsAtThreshold, 'one more'];

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const stream = { conversationId: 'conv_1', turnId: 'turn_1', now: () => 1000 };
const command = (agentOptions?: Command['agentOptions']): Command => ({
  kind: 'submit_turn',
  mode: 'agent',
  input,
  stream,
  ...(agentOptions ? { agentOptions } : {}),
});

/** `n` opaque operations (the reducer only counts/accumulates them). */
const ops = (n: number): AnyOperation[] =>
  Array.from({ length: n }, (_, i) => ({ type: 'noop', i }) as unknown as AnyOperation);

const runningStep = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: 'step-1',
  label: 'Deleting a range on Video 1',
  status: 'running',
  detail: 'Deleting a range on Video 1',
  ...over,
});

// A concrete idle state to start from (onCommand builds a fresh run regardless).
const idle = initialConductorState(stream);

/** A started run's state, with optional overrides for a specific scenario. */
const started = (over: Partial<ConductorState> = {}): ConductorState => ({
  ...onCommand(idle, command()).state,
  ...over,
});

const turn = (over: Partial<AgentTurnResult> = {}): AgentTurnResult => ({
  kind: 'agent_turn',
  stepIndex: 1,
  aborted: false,
  done: false,
  anyToolCancelled: false,
  anyToolFailed: false,
  turnOpCount: 0,
  rejectedOpCount: 0,
  rejectionNotes: [],
  applied: false,
  appliedOps: [],
  describedActions: [],
  signature: 'sig',
  // Default: a turn that learned nothing new (the conservative case — the fixture's
  // default turn applies nothing either). Tests that model real reconnaissance pass
  // their own novel facts.
  callFacts: [],
  note: 'note',
  planSteps: [runningStep()],
  planStepIndex: 0,
  intent: 'Deleting a range on Video 1',
  log: [],
  endSeq: 1,
  ...over,
});

const verify = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  kind: 'verify',
  ok: true,
  summary: 'looks good',
  failedChecks: [],
  warnedChecks: [],
  repairOps: [],
  endSeq: 1,
  ...over,
});

const draftPlan = (over: Partial<DraftPlanResult> = {}): DraftPlanResult => ({
  kind: 'draft_plan',
  labels: [],
  endSeq: 3,
  ...over,
});

const resume = (over: Partial<ResumeResult> = {}): ResumeResult => ({
  kind: 'resume',
  ok: true,
  ops: [],
  log: [],
  stepsCompleted: 0,
  endSeq: 1,
  ...over,
});

const types = (events: readonly { type: string }[]) => events.map((e) => e.type);

describe('onCommand', () => {
  it('starts an agent run: executing, step 1, a run_turn effect, header spinner', () => {
    const { state, effects, events } = onCommand(idle, command());
    expect(state.phase).toBe('executing');
    expect(state.stepIndex).toBe(1);
    expect(state.goal).toBe('tighten the intro');
    expect(effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 1,
        planSteps: [],
        ledgerLength: 0,
        stage: 'interpret',
        working: state.working,
      },
    ]);
    // No run-level reasoning node any more — reasoning is opened PER STEP inside each
    // run_turn (`${turnId}:reasoning:${index}`). onCommand only emits the header spinner.
    // Just the header spinner: the run budget is a permanent editor setting, not a line
    // the run opens with (see the 'run budgets' block below).
    expect(types(events)).toEqual(['status']);
    expect(events[0]).toMatchObject({ type: 'status', status: 'thinking' });
  });

  it('records the objective as provisional when the request states nothing checkable', () => {
    const { state } = onCommand(idle, command());
    expect(state.working.objective.outcome).toBe('tighten the intro');
    expect(state.working.objective.provisional).toBe(true);
  });

  it('records the checkable conditions a request DID state as acceptance criteria', () => {
    // Until now the outcome, the single criterion, the committed decision and the criterion
    // verification reported against were all the same sentence the editor typed — so a
    // request for "20+ different best moments" was satisfied, as far as the ledger knew, by
    // eight shots. See `acceptance.ts`.
    const asked: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      stream,
      input: {
        project: makeProject(),
        userPrompt: 'make a 30 second reel from at least 20 different best moments',
      },
    };
    const { working } = onCommand(idle, asked).state;
    const descriptions = working.objective.acceptance.map((entry) => entry.description);
    expect(descriptions.some((text) => text.includes('30s'))).toBe(true);
    expect(descriptions.some((text) => text.includes('20 distinct shots'))).toBe(true);
    // The unmeasurable half of the ask is still a criterion — as a pointer to the request,
    // not a copy of it (the run already persists it verbatim as `objective.request`).
    expect(descriptions.at(-1)).toBe(JUDGEMENT_CRITERION);
    // A reading with something checkable in it is not a placeholder.
    expect(working.objective.provisional).toBe(false);
  });

  it('resolves a bare "continue" to the request underneath it, not to the nudge', () => {
    // The whole failure this closes: a turn whose message was "contine" recorded that word
    // as the outcome, the acceptance criterion, the committed decision AND the criterion
    // verification checked — so the run lost its goal and could only report itself
    // inconclusive. The referent was in the history the entire time.
    const nudged: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      stream,
      input: {
        project: makeProject(),
        userPrompt: 'contine',
        history: [
          { role: 'user', content: 'use a different caption style and emphasize the captions' },
          { role: 'assistant', content: 'I read the timeline.' },
        ],
      },
    };
    const { working } = onCommand(idle, nudged).state;
    const goal = 'use a different caption style and emphasize the captions';
    expect(working.objective.outcome).toBe(goal);
    // Nothing here is checkable, so the judgement criterion is the only one — and it points
    // at the objective rather than copying it.
    expect(working.objective.acceptance.map((c) => c.description)).toEqual([JUDGEMENT_CRITERION]);
    // The decision and the objective verification reports against must name the real work.
    expect(working.decisions[0]!.decision).toBe(goal);
    expect(working.objectives[0]!.description).toBe(goal);
    // The raw request is still preserved verbatim — the nudge is what the editor typed.
    expect(working.objective.request).toBe('contine');
  });

  it('resolves config from agentOptions, else defaults', () => {
    expect(onCommand(idle, command()).state.config).toEqual({
      maxSteps: 300,
      maxOpsPerTurn: 200,
      maxOpsPerRun: 800,
      maxUsd: 5,
      maxWallMs: 20 * 60_000,
      planApprovalGated: false,
      diminishingReturnsTurns: DIMINISHING_RETURNS_TURNS,
      diminishingReturnsMinOutputTokens: DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
    });
    expect(
      onCommand(
        idle,
        command({
          maxSteps: 3,
          maxOpsPerTurn: 5,
          maxOpsPerRun: 9,
          maxUsd: 2,
          maxMinutes: 1,
          diminishingReturns: { turns: 4, minOutputTokens: 50 },
        }),
      ).state.config,
    ).toEqual({
      maxSteps: 3,
      maxOpsPerTurn: 5,
      maxOpsPerRun: 9,
      maxUsd: 2,
      maxWallMs: 60_000,
      planApprovalGated: false,
      diminishingReturnsTurns: 4,
      diminishingReturnsMinOutputTokens: 50,
    });
  });

  it('gates on requirePlanApproval', () => {
    expect(onCommand(idle, command({ requirePlanApproval: true })).state.config).toMatchObject({
      planApprovalGated: true,
    });
  });

  it('emits a draft_plan effect (planning phase) when planFirst is set', () => {
    const { state, effects } = onCommand(idle, command({ planFirst: true }));
    expect(state.phase).toBe('planning');
    expect(effects).toEqual([{ kind: 'draft_plan' }]);
  });

  it('skips draft_plan (runs the first turn) when planFirst races an already-aborted signal', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const cmd: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      input,
      stream: { ...stream, signal: ctrl.signal },
      agentOptions: { planFirst: true },
    };
    const { state, effects } = onCommand(initialConductorState(cmd.stream), cmd);
    expect(state.phase).toBe('executing');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('emits a resume effect (resuming phase) when a checkpoint with ops is present', () => {
    const { state, effects } = onCommand(
      idle,
      command({ resume: { ops: ops(2), log: ['l'], stepsCompleted: 1 } }),
    );
    expect(state.phase).toBe('resuming');
    expect(effects).toEqual([{ kind: 'resume' }]);
  });

  it('ignores an empty resume checkpoint (falls through to the first turn)', () => {
    const { effects } = onCommand(
      idle,
      command({ resume: { ops: [], log: [], stepsCompleted: 0 } }),
    );
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('ignores non-agent modes (they stay on the coarse gateway path)', () => {
    const chat = onCommand(idle, { kind: 'submit_turn', mode: 'chat', input, stream });
    expect(chat).toEqual({ state: idle, effects: [], events: [] });
  });
});

describe('onEffectResult — draft_plan fold', () => {
  it('seeds the ledger (all pending), emits plan + status(thinking), then the first turn', () => {
    const s = onCommand(idle, command({ planFirst: true })).state;
    const { state, effects, events } = onEffectResult(
      s,
      draftPlan({ labels: ['Trim', 'Wrap up'] }),
    );
    expect(state.phase).toBe('executing');
    expect(state.ledgerLength).toBe(2);
    expect(state.planSteps).toEqual([
      { id: 'step-1', label: 'Trim', status: 'pending' },
      { id: 'step-2', label: 'Wrap up', status: 'pending' },
    ]);
    expect(types(events)).toEqual(['plan', 'status']);
    expect(events[1]).toMatchObject({ status: 'thinking' });
    expect(effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 1,
        planSteps: state.planSteps,
        ledgerLength: 2,
        stage: 'interpret',
        working: state.working,
      },
    ]);
  });

  // GAP-015 (run `fc10301a`). `setObjective` is written to yield a provisional outcome —
  // the request read back — to "the first real interpretation", and `acceptance.ts` records
  // that nothing ever produced one: it "had exactly one caller, the seed itself". So a
  // 12,000-character brief with ten enumerated deliverables became one objective, one
  // decision and one criterion, all of them the brief; `buildStateBriefing` then suppressed
  // every one of them as noise, and the model was shown a STAGE line and nothing else.
  it('takes the drafted plan as the run’s own reading of the request', () => {
    const s = onCommand(idle, command({ planFirst: true })).state;
    expect(s.working.objective.provisional).toBe(true);
    const { state } = onEffectResult(s, draftPlan({ labels: ['Trim', 'Wrap up'] }));
    expect(state.working.objective.provisional).toBe(false);
    expect(state.working.objective.outcome).toBe('Plan: Trim; Wrap up');
  });

  it('does not take a plan that is only the request said back', () => {
    // The seed arriving by another route. Storing it as an interpretation would put a
    // second copy of the brief in a state persisted and streamed every turn. The label
    // below is `input.userPrompt` verbatim — that is what makes it an echo.
    const s = onCommand(idle, command({ planFirst: true })).state;
    expect(s.working.objective.request).toBe(input.userPrompt);
    const { state } = onEffectResult(s, draftPlan({ labels: [input.userPrompt] }));
    expect(state.working.objective.provisional).toBe(true);
    expect(state.working.objective.outcome).not.toContain('Plan:');
  });

  it('an empty drafted plan cannot commit and pauses the run for integrity review (RSI1)', () => {
    // A planFirst run whose drafted plan has zero usable steps has nothing to authorize
    // execution against — `commitExecutionPlan` refuses to commit it, which is a genuine
    // integrity failure (no committed decisions), not a silent fallback to unplanned
    // execution. The run finalizes immediately: the specific "no executable decisions"
    // warning, plus the generic empty-run notice is suppressed because that warning
    // already explained why (no ops touched, nothing to add to it).
    const s = onCommand(idle, command({ planFirst: true })).state;
    const { state, events } = onEffectResult(s, draftPlan({ labels: [] }));
    expect(state.ledgerLength).toBe(0);
    expect(types(events)).toEqual(['warning']);
    expect(events[0]).toMatchObject({
      type: 'warning',
      text: expect.stringContaining('no executable decisions'),
    });
  });

  it('widens the step budget only for a NEW plan — a re-drafted empty plan on an already-committed run keeps the existing budget', () => {
    // `commitExecutionPlan` short-circuits to a no-op when the working state's plan is
    // already `committed` (it never re-commits mid-run), so a later draft_plan result
    // with zero labels can still see `working.plan.status === 'committed'` while
    // `planSteps.length` is 0 here — the budget-widening branch must fall back to the
    // unchanged config rather than reading `planSteps.length + headroom` off an empty plan.
    const s = onCommand(idle, command({ planFirst: true })).state;
    const alreadyCommitted: typeof s = {
      ...s,
      working: {
        ...s.working,
        plan: {
          status: 'committed',
          id: 'plan_prior',
          committedAtTurn: 0,
          basedOnProjectRevision: 0,
          decisionIds: ['decision_1'],
        },
      },
    };
    const { state } = onEffectResult(alreadyCommitted, draftPlan({ labels: [] }));
    expect(state.config.maxSteps).toBe(alreadyCommitted.config.maxSteps);
  });

  it('does NOT gate a plan at/under the threshold even when requirePlanApproval is set', () => {
    const s = onCommand(idle, command({ planFirst: true, requirePlanApproval: true })).state;
    const { state, effects } = onEffectResult(s, draftPlan({ labels: labelsAtThreshold }));
    expect(state.phase).toBe('executing');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('gates a plan OVER the threshold when requirePlanApproval is set: awaiting_approval, no run_turn yet', () => {
    const s = onCommand(idle, command({ planFirst: true, requirePlanApproval: true })).state;
    const { state, effects, events } = onEffectResult(
      s,
      draftPlan({ labels: labelsOverThreshold }),
    );
    expect(state.phase).toBe('awaiting_approval');
    expect(types(events)).toEqual(['plan', 'status']);
    expect(events[1]).toMatchObject({ status: 'awaiting_approval' });
    expect(effects).toEqual([{ kind: 'await_approval', planSteps: state.planSteps }]);
  });

  it('does not gate an over-threshold plan when requirePlanApproval is unset (default, unchanged behavior)', () => {
    const s = onCommand(idle, command({ planFirst: true })).state;
    const { state, effects } = onEffectResult(s, draftPlan({ labels: labelsOverThreshold }));
    expect(state.phase).toBe('executing');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });
});

describe('onEffectResult — approval fold (P11.3)', () => {
  it('approved: falls through to the first turn, same as an un-gated planFirst run', () => {
    const drafted = onEffectResult(
      onCommand(idle, command({ planFirst: true, requirePlanApproval: true })).state,
      draftPlan({ labels: labelsOverThreshold }),
    );
    expect(drafted.state.phase).toBe('awaiting_approval');
    const { state, effects, events } = onEffectResult(drafted.state, {
      kind: 'approval',
      decision: 'approved',
      endSeq: drafted.state.seq,
    });
    expect(state.phase).toBe('executing');
    expect(types(events)).toEqual(['status']);
    expect(events[0]).toMatchObject({ status: 'thinking' });
    expect(effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 1,
        planSteps: state.planSteps,
        ledgerLength: state.ledgerLength,
        stage: state.working.stage,
        working: state.working,
      },
    ]);
  });

  it('cancelled: finalizes immediately — no turn ever ran, no ops touched, no checkpoint', () => {
    const drafted = onEffectResult(
      onCommand(idle, command({ planFirst: true, requirePlanApproval: true })).state,
      draftPlan({ labels: labelsOverThreshold }),
    );
    const { state, effects, events } = onEffectResult(drafted.state, {
      kind: 'approval',
      decision: 'cancelled',
      endSeq: drafted.state.seq,
    });
    expect(state.phase).toBe('cancelled');
    expect(effects).toEqual([
      {
        kind: 'finalize',
        ops: [],
        cancelled: true,
        failed: false,
        appliedTurns: 0,
        rejectedOpCount: 0,
        rejectionReasons: [],
      },
    ]);
    // No checkpoint event — `finalize`'s checkpoint only fires when cumulativeOps.length > 0.
    expect(types(events)).toEqual(['notification']);
  });
});

describe('onEffectResult — resume fold', () => {
  it('adopts the prior ops/log and continues from the next step', () => {
    const s = onCommand(
      idle,
      command({ resume: { ops: ops(2), log: ['a'], stepsCompleted: 1 } }),
    ).state;
    const { state, effects } = onEffectResult(
      s,
      resume({ ok: true, ops: ops(2), log: ['a'], stepsCompleted: 1 }),
    );
    expect(state.cumulativeOps).toHaveLength(2);
    expect(state.appliedTurns).toBe(1);
    expect(state.stepIndex).toBe(2);
    expect(effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 2,
        planSteps: [],
        ledgerLength: 0,
        stage: 'interpret',
        working: state.working,
      },
    ]);
  });

  it('verifies immediately when the checkpoint already spent the step budget', () => {
    const s = started({ config: { maxSteps: 2, maxOpsPerTurn: 40, maxOpsPerRun: 200 } });
    const { state, effects } = onEffectResult(
      s,
      resume({ ok: true, ops: ops(1), log: [], stepsCompleted: 2 }),
    );
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('pauses for reconciliation — never silently restarts — when the replay no longer validates (RSI1)', () => {
    // A checkpoint that no longer validates means the project moved on without this
    // run's knowledge. Silently restarting from step 1 would execute against a project
    // state the interrupted run never saw; the run must instead stop for the creator to
    // reconcile, same as any other integrity failure.
    const { state, effects, events } = onEffectResult(started(), resume({ ok: false }));
    expect(state.phase).toBe('review');
    expect(state.working.integrity.status).not.toBe('valid');
    expect(effects).toEqual([
      {
        kind: 'finalize',
        ops: [],
        cancelled: false,
        failed: true,
        appliedTurns: 0,
        rejectedOpCount: 0,
        rejectionReasons: [],
      },
    ]);
    expect(types(events)).toEqual(['warning']);
    expect(events[0]).toMatchObject({
      type: 'warning',
      text: expect.stringContaining('reconciliation'),
    });
  });
});

describe('onEffectResult — turn cancellation', () => {
  it('a turn-boundary abort finalizes as cancelled with a checkpoint (no plan event)', () => {
    const s = started({ cumulativeOps: ops(2), appliedTurns: 1 });
    const { state, effects, events } = onEffectResult(
      s,
      turn({ aborted: true, log: ['Step 1: x'] }),
    );
    expect(state.phase).toBe('cancelled');
    expect(types(events)).toEqual(['checkpoint']);
    expect(effects[0]).toMatchObject({ kind: 'finalize', cancelled: true, appliedTurns: 1 });
    expect(events[0]).toMatchObject({
      goal: 'tighten the intro',
      stepsCompleted: 1,
      log: ['Step 1: x'],
    });
  });

  it('a mid-turn tool cancel marks the step failed (Stopped by user), then cancels', () => {
    const { state, effects, events } = onEffectResult(started(), turn({ anyToolCancelled: true }));
    expect(state.phase).toBe('cancelled');
    // Unplanned run (ledgerLength 0): the failed status lives in state, no pinned ledger.
    expect(types(events)).not.toContain('plan');
    expect(state.planSteps[0]).toMatchObject({ status: 'failed', detail: 'Stopped by user' });
    expect(effects[0]).toMatchObject({ kind: 'finalize', cancelled: true });
  });

  it('emits the plan event with the failed status when a plan WAS drafted (ledgerLength > 0)', () => {
    const { events } = onEffectResult(
      started({ ledgerLength: 1 }),
      turn({ anyToolCancelled: true }),
    );
    expect(types(events)).toEqual(['plan']);
    const plan = events[0] as { steps: PlanStep[] };
    expect(plan.steps[0]).toMatchObject({ status: 'failed', detail: 'Stopped by user' });
  });

  it('emits no checkpoint when a cancelled run applied nothing', () => {
    const { events } = onEffectResult(started(), turn({ aborted: true }));
    expect(events.some((e) => e.type === 'checkpoint')).toBe(false);
  });
});

describe('onEffectResult — turn stop/continue decisions', () => {
  it('a done turn (no tool calls) stops and verifies with no plan event', () => {
    const { state, effects, events } = onEffectResult(started(), turn({ done: true }));
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
    expect(events).toEqual([]);
  });

  it('does not accept early done while a drafted deliverable remains unfinished', () => {
    const planned = started({
      ledgerLength: 2,
      stepIndex: 2,
      cumulativeOps: ops(1),
      planSteps: [
        { id: 'step-1', label: 'Build the first half', status: 'completed' },
        { id: 'step-2', label: 'Fill the timeline through 30 seconds', status: 'pending' },
      ],
    });
    const step = onEffectResult(planned, turn({ stepIndex: 2, done: true }));
    expect(step.state.phase).toBe('executing');
    expect(step.state.actionRecoveryPending).toBe(true);
    expect(step.state.working.nextAction?.action).toBe('Fill the timeline through 30 seconds');
    expect(step.effects[0]).toMatchObject({
      kind: 'run_turn',
      stepIndex: 3,
      actionRecovery: true,
    });
    expect(step.events).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        text: expect.stringContaining('unfinished'),
      }),
    );
  });

  it('does not accept early done while the request itself is unmet', () => {
    // Run 4c9b5f82. A 61-photo brief was decomposed into ONE objective, so the first
    // applied batch — ten photos over the first ten seconds of a thirty-six-second music
    // bed — reconciled the whole ledger. The model then said it was done, the plan guard
    // above found nothing unfinished, and the run reported `completed` while its own
    // memory still read "Continue apply / remainingObjectives: 1". The plan is the model's
    // account of the work; the shortfall is the request's.
    const planned = started({
      ledgerLength: 1,
      cumulativeOps: ops(1),
      planSteps: [{ id: 'step-1', label: 'Build the montage', status: 'completed' }],
    });
    const step = onEffectResult(
      planned,
      turn({
        done: true,
        acceptanceShortfall: [
          '26.099s of the 36.107s programme has no picture under it.',
          'The cut uses 10 shots but at least 61 were asked for.',
        ],
      }),
    );
    expect(step.state.phase).toBe('executing');
    expect(step.state.actionRecoveryPending).toBe(true);
    expect(step.state.working.nextAction?.action).toContain('no picture under it');
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn', actionRecovery: true });
    expect(step.events).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        text: expect.stringContaining('not met yet'),
      }),
    );
  });

  it('bounds an unmet-request recovery to one turn, like the plan one', () => {
    const planned = started({
      ledgerLength: 1,
      actionRecoveryPending: true,
      cumulativeOps: ops(1),
      planSteps: [{ id: 'step-1', label: 'Build the montage', status: 'completed' }],
    });
    const step = onEffectResult(
      planned,
      turn({ done: true, acceptanceShortfall: ['The cut uses 10 shots but 61 were asked for.'] }),
    );
    expect(step.state.phase).toBe('verifying');
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('accepts done when the request states nothing the timeline fails', () => {
    const planned = started({
      ledgerLength: 1,
      cumulativeOps: ops(1),
      planSteps: [{ id: 'step-1', label: 'Build the montage', status: 'completed' }],
    });
    const step = onEffectResult(planned, turn({ done: true, acceptanceShortfall: [] }));
    expect(step.state.phase).toBe('verifying');
  });

  it('bounds an early-done recovery to one turn', () => {
    const planned = started({
      ledgerLength: 1,
      actionRecoveryPending: true,
      planSteps: [{ id: 'step-1', label: 'Finish the montage', status: 'pending' }],
    });
    const step = onEffectResult(planned, turn({ done: true }));
    expect(step.state.phase).toBe('verifying');
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('falls back to a generic integrity message when a needs_review state carries no diagnostic', () => {
    // `addDiagnostic` always pairs `needs_review` with a diagnostic, but nothing in the
    // type system enforces that pairing — the fallback text exists for the case where it
    // ever drifts, and must still produce an honest, non-empty message rather than
    // `undefined` leaking into the warning shown to the creator.
    const s = started({
      working: { ...started().working, integrity: { status: 'needs_review', diagnostics: [] } },
    });
    const { state, events } = onEffectResult(s, turn({ done: true }));
    expect(state.integrityFailed).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'warning',
        text: expect.stringContaining('Run integrity is incomplete.'),
      }),
    ]);
  });

  it('rejects a turn exceeding the per-turn op cap: failed step + warning, then verifies', () => {
    const s = started({ config: { maxSteps: 8, maxOpsPerTurn: 5, maxOpsPerRun: 200 } });
    const { state, effects, events } = onEffectResult(s, turn({ turnOpCount: 6 }));
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
    // Unplanned run: the warning still fires, but no pinned checklist is emitted.
    expect(types(events)).toEqual(['warning']);
    expect(state.planSteps[0]).toMatchObject({ status: 'failed' });
    expect(state.cumulativeOps).toHaveLength(0);
  });

  it('also re-emits the pinned checklist when a planned run rejects an over-cap turn', () => {
    const s = started({
      config: { maxSteps: 8, maxOpsPerTurn: 5, maxOpsPerRun: 200 },
      ledgerLength: 1,
      planSteps: [runningStep()],
    });
    const { events } = onEffectResult(s, turn({ turnOpCount: 6 }));
    expect(types(events)).toEqual(['plan', 'warning']);
  });

  it('applies a turn (completed step + timeline_action cards) and advances', () => {
    const { state, effects, events } = onEffectResult(
      started(),
      turn({
        applied: true,
        appliedOps: ops(2),
        turnOpCount: 2,
        describedActions: [
          { action: 'Deleted', detail: '0s–3s', refs: [] },
          { action: 'Trimmed', detail: '4s–5s' },
        ],
      }),
    );
    expect(state.cumulativeOps).toHaveLength(2);
    expect(state.appliedTurns).toBe(1);
    expect(state.stepIndex).toBe(2);
    // Unplanned run: only the timeline_action cards surface; no pinned plan checklist.
    expect(types(events)).toEqual(['timeline_action', 'timeline_action']);
    expect(state.planSteps[0]).toMatchObject({
      status: 'completed',
      detail: 'Deleting a range on Video 1',
    });
    expect(effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 2,
        planSteps: state.planSteps,
        ledgerLength: 0,
        stage: 'interpret',
        working: state.working,
      },
    ]);
  });

  it('emits the plan event (completed step) for an applied turn when a plan WAS drafted', () => {
    const { events } = onEffectResult(
      started({ ledgerLength: 1 }),
      turn({ applied: true, appliedOps: ops(1), turnOpCount: 1, describedActions: [] }),
    );
    expect(types(events)).toContain('plan');
    const plan = events.find((e) => e.type === 'plan') as { steps: PlanStep[] };
    expect(plan.steps[0]).toMatchObject({ status: 'completed' });
  });

  it('stops after applying when the per-run op cap is hit', () => {
    const s = started({ config: { maxSteps: 8, maxOpsPerTurn: 40, maxOpsPerRun: 3 } });
    const { state, effects, events } = onEffectResult(
      s,
      turn({ applied: true, appliedOps: ops(3), turnOpCount: 3 }),
    );
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
    expect(events.some((e) => e.type === 'notification')).toBe(true);
  });

  it('verifies (not advance) when an applied turn lands exactly on the step cap', () => {
    const s = started({
      stepIndex: 8,
      config: { maxSteps: 8, maxOpsPerTurn: 100, maxOpsPerRun: 800 },
    });
    const { state, effects } = onEffectResult(
      s,
      turn({ stepIndex: 8, applied: true, appliedOps: ops(1), turnOpCount: 1 }),
    );
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('accounts for a validator-rejected real-ops turn (failed step) and CONTINUES so the model can fix the cause', () => {
    const { state, effects, events } = onEffectResult(
      started(),
      turn({ applied: false, turnOpCount: 4, note: 'overlaps neighbour' }),
    );
    expect(state.rejectedOpCount).toBe(4);
    expect(state.rejectionReasons).toEqual(['overlaps neighbour']);
    // The rejection reason is in the log the model reads next turn — retry, bounded
    // by the exact-repeat guard (never a silent dead end). An ATTEMPTED edit is progress,
    // so the convergence streak stays at 0 — the model is trying, not stalling.
    expect(effects[0]).toMatchObject({ kind: 'run_turn', stepIndex: 2 });
    expect(state.stallStreak).toBe(0);
    expect(state.noProgress).toContain('sig');
    // Unplanned run: the failed status lives in state, not an emitted checklist.
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(state.planSteps[0]).toMatchObject({ status: 'failed', detail: 'overlaps neighbour' });
  });

  // GAP-003 (run `fc10301a`). Applying a patch correctly invalidates every timeline fact
  // the run held — a cut moves the ids the next patch is written against. But the run
  // AUTHORED that cut and is handed the resulting project, so making it call get_timeline
  // to learn what it just did is asking it to pay for knowledge it already has. That run
  // alternated apply / re-read for its whole second half, and the re-read is also what
  // collided with the spin guard.
  it('records the arrangement it just made, so the next turn need not re-read it', () => {
    const { state } = onEffectResult(
      started(),
      turn({
        applied: true,
        appliedOps: ops(1),
        turnOpCount: 1,
        arrangement: 'Timeline now: sequence 24.08s, 3 tracks, 35 clips — layer_video_3 …',
      }),
    );
    expect(state.working.facts.map((f) => f.statement)).toContain(
      'Timeline now: sequence 24.08s, 3 tracks, 35 clips — layer_video_3 …',
    );
  });

  // GAP-019. This counter looks like it should be `project.timeline.revision` and must
  // not be: that field bumps only when an operation changes the source↔sequence MAPPING
  // (ADR 0076), so a colour grade, an audio gain change or a blend-mode change leave it
  // exactly where it was. It drives `onProjectRevisionChanged`, which invalidates every
  // timeline-dependent fact the run holds — and a grade does stale a `get_clips` payload.
  it('counts every applied patch, including one that changes no timing', () => {
    const graded = onEffectResult(
      started(),
      turn({
        applied: true,
        turnOpCount: 1,
        appliedOps: [
          {
            type: 'apply_color_grade',
            clipId: 'clip_a',
            effect: { id: 'g', type: 'color_grade', params: {}, keyframes: [] },
          },
        ] as never,
      }),
    ).state;
    expect(graded.working.currentProjectRevision).toBe(1);
  });

  it('replaces the previous arrangement rather than stacking them', () => {
    const first = onEffectResult(
      started(),
      turn({ applied: true, appliedOps: ops(1), turnOpCount: 1, arrangement: 'Timeline now: A' }),
    ).state;
    const second = onEffectResult(
      first,
      turn({ applied: true, appliedOps: ops(1), turnOpCount: 1, arrangement: 'Timeline now: B' }),
    ).state;
    const arrangements = second.working.facts
      .map((f) => f.statement)
      .filter((t) => t.startsWith('Timeline now:'));
    // The revision bump drops the stale one immediately before the new one is recorded,
    // so "replace" needs no special case — it falls out of the existing invalidation.
    expect(arrangements).toEqual(['Timeline now: B']);
  });

  it('stops a rejected turn that exactly repeats a no-progress signature', () => {
    const s = started({ noProgress: ['sig'] });
    const { effects } = onEffectResult(
      s,
      turn({ applied: false, turnOpCount: 2, note: 'overlaps neighbour' }),
    );
    expect(effects).toEqual([{ kind: 'run_verify' }]);
  });

  // GAP-002 (run `fc10301a`). The exact-repeat arm ended runs in silence: a tool card went
  // green and the run settled `failed` in the same breath, with only the timeline's
  // self-check warnings to explain it. The editor could not tell a converged run from a
  // crashed one.
  it('says why it is settling when a signature exactly repeats', () => {
    const { events } = onEffectResult(
      started({ noProgress: ['sig'] }),
      turn({ applied: false, turnOpCount: 2, note: 'overlaps neighbour' }),
    );
    expect(
      events.some(
        (e) => e.type === 'notification' && e.text.includes('already made against this same'),
      ),
    ).toBe(true);
  });

  // GAP-002, the banking half. A turn that ANSWERED is not evidence of a spin, whatever
  // the model then did with the answer — and banking it arms a trap for the next turn
  // that legitimately asks the same question. Run `fc10301a` banked
  // `get_timeline + list_assets` on a memo-hit turn, made the same pair four turns and
  // thirty-four clips later against a moved timeline, and was killed on the match.
  it('does not bank a signature for a turn whose reads came back with fresh data', () => {
    const { state } = onEffectResult(
      started(),
      turn({
        signature: 'read-timeline',
        callFacts: [{ key: 'get_timeline', status: 'completed', fromCache: false }],
      }),
    );
    expect(state.noProgress).not.toContain('read-timeline');
  });

  it('still banks a signature for a turn that learned nothing', () => {
    const { state } = onEffectResult(
      started(),
      turn({
        signature: 'read-timeline',
        callFacts: [{ key: 'get_timeline', status: 'completed', fromCache: true }],
      }),
    );
    expect(state.noProgress).toContain('read-timeline');
  });

  it('treats an attempted (even rejected) edit as progress — the streak resets, not climbs', () => {
    // A model actively proposing edits is not stalling, even if the validator rejects
    // them: the reason is now in the log and it gets to correct itself. Only the
    // exact-repeat guard (above) stops a model re-proposing the identical bad edit.
    const s = started({ stallStreak: STALL_CONFIRM_TURNS - 1 });
    const { state, effects } = onEffectResult(
      s,
      turn({ applied: false, turnOpCount: 1, note: 'bad range', signature: 'novel' }),
    );
    expect(state.stallStreak).toBe(0);
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('tallies per-call validator rejections (failed cards) into the empty-run bookkeeping', () => {
    const { state, effects } = onEffectResult(
      started(),
      turn({
        turnOpCount: 0,
        anyToolFailed: true,
        rejectedOpCount: 3,
        rejectionNotes: ['Rejected "add_text_layer" — clips overlap'],
      }),
    );
    expect(state.rejectedOpCount).toBe(3);
    expect(state.rejectionReasons).toEqual(['Rejected "add_text_layer" — clips overlap']);
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  /**
   * Run `ea8e46ec`: six turns, one byte-identical rejection, thirty minutes. Every attempt
   * reset the stall streak because "a rejected op is a bounded retry" — and nothing bounded
   * it. A retry that changes nothing the runtime can see and learns nothing new is the same
   * nothing the stall guard exists to catch.
   */
  it('does not credit a turn refused with the reason that refused the last one', () => {
    const refusal = 'rejected by the beat grid: the analyzed audio asset is not on the timeline';
    const first = onEffectResult(
      started(),
      turn({ applied: false, turnOpCount: 61, rejection: refusal, note: refusal }),
    );
    // The FIRST attempt is a real attempt: it is progress and the streak stays at 0.
    expect(first.state.stallStreak).toBe(0);
    expect(first.state.lastRejectionReason).toBe(refusal);

    // The second, refused identically and learning nothing, is not.
    const second = onEffectResult(
      { ...first.state, noProgress: [] },
      turn({
        applied: false,
        turnOpCount: 61,
        rejection: refusal,
        note: refusal,
        signature: 'sig-2',
      }),
    );
    expect(second.state.stallStreak).toBe(1);
  });

  it('still credits a repeated refusal when the turn learned something new', () => {
    const refusal = 'rejected by the beat grid: ungrounded';
    const first = onEffectResult(
      started(),
      turn({ applied: false, turnOpCount: 3, rejection: refusal, note: refusal }),
    );
    const second = onEffectResult(
      { ...first.state, noProgress: [] },
      turn({
        applied: false,
        turnOpCount: 3,
        rejection: refusal,
        note: refusal,
        signature: 'sig-2',
        callFacts: [{ key: 'detect_beats:music_c', status: 'completed', role: 'analysis' }],
      }),
    );
    expect(second.state.stallStreak).toBe(0);
  });

  it('forgets a standing refusal once an edit lands, so a later one is a fresh attempt', () => {
    const refusal = 'rejected by the beat grid: ungrounded';
    const refused = onEffectResult(
      started(),
      turn({ applied: false, turnOpCount: 3, rejection: refusal, note: refusal }),
    );
    const landed = onEffectResult(
      { ...refused.state, noProgress: [] },
      turn({ applied: true, turnOpCount: 2, appliedOps: ops(2), signature: 'sig-2' }),
    );
    expect(landed.state.lastRejectionReason).toBe('');
    const refusedAgain = onEffectResult(
      { ...landed.state, noProgress: [] },
      turn({
        applied: false,
        turnOpCount: 3,
        rejection: refusal,
        note: refusal,
        signature: 'sig-3',
      }),
    );
    expect(refusedAgain.state.stallStreak).toBe(0);
  });

  it('caps retained rejection reasons at three', () => {
    const s = started({ rejectedOpCount: 9, rejectionReasons: ['a', 'b', 'c'] });
    const { state } = onEffectResult(s, turn({ applied: false, turnOpCount: 1, note: 'd' }));
    expect(state.rejectionReasons).toEqual(['a', 'b', 'c']);
    expect(state.rejectedOpCount).toBe(10);
  });

  it('marks a zero-op turn whose tool genuinely failed as a failed step (still continues)', () => {
    const { state, effects, events } = onEffectResult(
      started(),
      turn({ turnOpCount: 0, anyToolFailed: true, note: 'Rejected: bad', signature: 'z' }),
    );
    expect(events.some((e) => e.type === 'plan')).toBe(false);
    expect(state.planSteps[0]).toMatchObject({ status: 'failed' });
    expect(state.noProgress).toContain('z');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('continues a novel zero-op turn without falsely completing its plan step', () => {
    const first = onEffectResult(started(), turn({ signature: 'sigX' }));
    expect(first.state.noProgress).toContain('sigX');
    expect(first.state.planSteps[0]).toMatchObject({ status: 'running' });
    expect(first.events.some((event) => event.type === 'plan')).toBe(false);
    expect(first.effects[0]).toMatchObject({ kind: 'run_turn', stepIndex: 2 });

    const repeat = onEffectResult(started({ noProgress: ['sigX'] }), turn({ signature: 'sigX' }));
    expect(repeat.state.phase).toBe('verifying');
    expect(repeat.effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('counts an unproductive zero-op turn toward the convergence streak but still advances', () => {
    // A novel signature whose calls taught nothing new (no first-seen, successful,
    // uncached call) is the arg-varying spin the exact-signature guard misses — one such
    // turn advances (the streak is only 1), but the streak climbs toward convergence.
    const first = onEffectResult(started(), turn({ signature: 'a' }));
    expect(first.state.stallStreak).toBe(1);
    expect(first.effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('treats productive reconnaissance as progress, not spinning (W3)', () => {
    // The regression that ended two real runs: reading the project, loading playbooks and
    // analysing the music are how an edit becomes POSSIBLE — they are not a failure to
    // edit. A turn with a first-seen, successful, uncached call is PROGRESS: the
    // convergence streak resets and the run continues, with the key remembered.
    const s = started({ stallStreak: 1 });
    const { state, effects } = onEffectResult(
      s,
      turn({
        signature: 'recon',
        callFacts: [{ key: 'detect_beats:asset_music', status: 'completed', fromCache: false }],
      }),
    );
    expect(state.stallStreak).toBe(0);
    expect(state.seenCallKeys).toContain('detect_beats:asset_music');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('a turn whose only new calls FAILED learned nothing (W3)', () => {
    // Failed first-seen calls carry no information.
    const { state, effects } = onEffectResult(
      started(),
      turn({
        signature: 'failed-analysis',
        callFacts: [
          { key: 'detect_scenes:a', status: 'failed', fromCache: false },
          { key: 'detect_scenes:b', status: 'failed', fromCache: false },
        ],
      }),
    );
    expect(state.stallStreak).toBe(1);
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('regression: three productive turns are not a loop just because they say so alike', () => {
    // Run `f1d5285e`. The semantic loop detector reads the model's prose, `'find the'` is
    // an `analyze` marker, and every one of these three sentences contains it — so three
    // music searches that each returned a DIFFERENT catalogue were declared to be going
    // in circles and the run was switched onto the restricted recovery surface. The
    // window now holds stuck turns only, so a turn that learned something empties it.
    const rationales = [
      'First, I need to find the right music — an energetic cinematic track.',
      'Let me find the right energetic track to drive this montage.',
      'Let me find the right music first, then build the beat-synced montage.',
    ];
    let s = started();
    const emitted: string[] = [];
    rationales.forEach((rationale, i) => {
      const step = onEffectResult(
        s,
        turn({
          signature: `search-${String(i)}`,
          rationale,
          callFacts: [
            { key: `search_music:query="q${String(i)}"`, status: 'completed', fromCache: false },
          ],
        }),
      );
      emitted.push(...step.events.flatMap((e) => (e.type === 'notification' ? [e.text] : [])));
      s = step.state;
    });
    expect(emitted.some((text) => /circles/i.test(text))).toBe(false);
    expect(s.actionRecoveryPending).toBe(false);
    expect(s.stallStreak).toBe(0);
  });

  it('still fills the loop window when the turns discover nothing', () => {
    // The counterpart, asserted on the window itself rather than on which of the three
    // recovery sentences wins the race: a run that keeps re-asking a question it has
    // already answered accumulates its intent, exactly as before. (Whether `looping` or
    // `noProgressStreak` reaches the recovery gate first depends on the run; both lead
    // to the same restricted turn.)
    const rationales = [
      'Let me orient myself.',
      'Let me get the full picture.',
      'Let me first understand the project.',
    ];
    let s = started();
    for (const rationale of rationales) {
      s = onEffectResult(
        s,
        turn({
          signature: 'orienting',
          rationale,
          callFacts: [{ key: 'get_timeline:', status: 'completed', fromCache: true }],
        }),
      ).state;
    }
    expect(s.recentIntents).toEqual(['orient', 'orient', 'orient']);
  });

  it('still declares a loop when a run keeps proposing under one purpose and learns nothing', () => {
    // The case the detector is actually reachable for, and the one it was built for:
    // every turn "progresses" in the loose sense (it proposed operations, so the
    // no-progress streak resets and the research budget is refunded) while discovering
    // nothing and saying the same thing about it. Three of those trip the loop and the
    // run is switched onto the recovery surface — the behaviour the productive-search
    // regression above must not have removed.
    let s = started();
    const emitted: string[] = [];
    for (let i = 0; i < SEMANTIC_LOOP_TURNS; i += 1) {
      const step = onEffectResult(
        s,
        turn({
          signature: `propose-${String(i)}`,
          rationale: 'Let me find the right place to cut.',
          turnOpCount: 1,
          applied: false,
          satisfied: false,
          callFacts: [],
        }),
      );
      emitted.push(...step.events.flatMap((e) => (e.type === 'notification' ? [e.text] : [])));
      s = step.state;
    }
    expect(emitted.some((text) => /circles/i.test(text))).toBe(true);
    expect(s.actionRecoveryPending).toBe(true);
  });

  it('one novel turn clears the loop window rather than shortening it', () => {
    // The window is not a rolling average — a turn that genuinely learned something means
    // the run is not circling NOW, so what it was doing two turns ago stops counting.
    const stuck = onEffectResult(
      started(),
      turn({
        signature: 'a',
        rationale: 'Let me orient myself.',
        callFacts: [{ key: 'get_timeline:', status: 'completed', fromCache: true }],
      }),
    ).state;
    expect(stuck.recentIntents).toEqual(['orient']);
    const learned = onEffectResult(
      stuck,
      turn({
        signature: 'b',
        rationale: 'Let me orient myself again.',
        callFacts: [{ key: 'list_assets:', status: 'completed', fromCache: false }],
      }),
    ).state;
    expect(learned.recentIntents).toEqual([]);
  });

  it('regression: a failed call does not bank its key against the retry that works', () => {
    // Run `f1d5285e`: the first `search_music` was rejected by the provider. Its key was
    // recorded in `seenCallKeys` anyway, so the retry that actually returned a catalogue
    // read as "already seen" and was credited with nothing — and so was every search
    // after it. A key claims the run HOLDS this call's answer; a failure holds nothing.
    const first = onEffectResult(
      started(),
      turn({
        signature: 'rejected-search',
        callFacts: [{ key: 'search_music:query="epic"', status: 'failed', fromCache: false }],
      }),
    );
    expect(first.state.stallStreak).toBe(1);
    expect(first.state.seenCallKeys).not.toContain('search_music:query="epic"');

    const retry = onEffectResult(
      first.state,
      turn({
        signature: 'retried-search',
        callFacts: [{ key: 'search_music:query="epic"', status: 'completed', fromCache: false }],
      }),
    );
    expect(retry.state.stallStreak).toBe(0);
    expect(retry.state.seenCallKeys).toContain('search_music:query="epic"');
  });

  it('a call that keeps failing still never buys the run runway', () => {
    // The relaxation above cannot resurrect the spin it sits next to: novelty is denied
    // on the call's own status, so retrying a broken call forever still stalls out.
    let s = started();
    for (const expected of [1, 2, 3]) {
      const step = onEffectResult(
        s,
        turn({
          signature: `broken-${String(expected)}`,
          callFacts: [{ key: 'detect_scenes:a', status: 'failed', fromCache: false }],
        }),
      );
      expect(step.state.stallStreak).toBe(expected);
      s = step.state;
    }
  });

  it('a turn served entirely from the memo learned nothing (W3)', () => {
    // Real data, but nothing the run did not already have — the memo suppressed a repeat.
    const { state } = onEffectResult(
      started(),
      turn({
        signature: 'cached',
        callFacts: [{ key: 'detect_beats:m', status: 'completed', fromCache: true }],
      }),
    );
    expect(state.stallStreak).toBe(1);
  });

  it('regression: a first recall of a handle is progress, a repeat of it is not', () => {
    // Run `09529490`. The agent log keeps payloads for only the two freshest entries and a
    // stock `remoteId` exists nowhere else, so a run holding twenty-one search handles has
    // to recall them to act — which the contract explicitly tells it to do. Every recall is
    // `fromCache` by construction, so every one of those turns scored as learning nothing
    // and the run was killed by the stall guard for obeying its own instructions.
    const recall = (evidenceId: string): TurnCallFact => ({
      key: `recall_evidence:evidenceId="${evidenceId}"`,
      status: 'completed',
      fromCache: true,
      role: 'recall',
    });
    const first = onEffectResult(
      started({ stallStreak: 2 }),
      turn({ signature: 'recall-ev1', callFacts: [recall('ev_1')] }),
    );
    expect(first.state.stallStreak).toBe(0);
    expect(first.state.seenCallKeys).toContain('recall_evidence:evidenceId="ev_1"');

    // Working through DIFFERENT handles keeps earning credit — that is a run reading its
    // own material, not one going in circles.
    const second = onEffectResult(
      first.state,
      turn({ signature: 'recall-ev2', callFacts: [recall('ev_2')] }),
    );
    expect(second.state.stallStreak).toBe(0);

    // Re-opening one it has already opened teaches nothing, and still stalls.
    const repeat = onEffectResult(
      second.state,
      turn({ signature: 'recall-ev1-again', callFacts: [recall('ev_1')] }),
    );
    expect(repeat.state.stallStreak).toBe(1);
  });

  it('the memo exemption is for recalls only — an ordinary cached read still stalls', () => {
    // The exemption is about how `recall_evidence` is SERVED, not a general licence to
    // treat cache hits as discoveries.
    const { state } = onEffectResult(
      started(),
      turn({
        signature: 'cached-read',
        callFacts: [{ key: 'get_timeline:', status: 'completed', fromCache: true, role: 'read' }],
      }),
    );
    expect(state.stallStreak).toBe(1);
  });

  it('a call whose key was already seen is not novel (W3)', () => {
    const s = started({ seenCallKeys: ['detect_beats:m'] });
    const { state } = onEffectResult(
      s,
      turn({
        signature: 'again',
        callFacts: [{ key: 'detect_beats:m', status: 'completed', fromCache: false }],
      }),
    );
    expect(state.stallStreak).toBe(1);
  });

  it('a single no-progress turn does not stop the run — convergence needs confirmation (W3)', () => {
    // One no-progress turn can be a momentary re-read; it takes STALL_CONFIRM_TURNS in a
    // row to prove the run is stuck. So the first such turn advances.
    const { state, effects } = onEffectResult(
      started(),
      turn({
        signature: 'first-stall',
        callFacts: [{ key: 'get_timeline:{}', status: 'completed', fromCache: true }],
      }),
    );
    expect(state.stallStreak).toBe(1);
    expect(state.phase).toBe('executing');
    expect(effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('gives a cached-only repeat one mutation/ask recovery turn before convergence', () => {
    const { state, effects, events } = onEffectResult(
      started({ stallStreak: STALL_CONFIRM_TURNS - 1 }),
      turn({
        signature: 'still-stuck',
        callFacts: [{ key: 'list_assets:{}', status: 'completed', fromCache: true }],
      }),
    );
    expect(state.phase).toBe('executing');
    expect(state.actionRecoveryPending).toBe(true);
    expect(effects[0]).toMatchObject({ kind: 'run_turn', actionRecovery: true });
    expect(events.some((e) => e.type === 'notification' && /progress/i.test(e.text))).toBe(false);
  });

  it('also grants recovery for a cached-only repeat whose facts settled as "warning"', () => {
    const { state } = onEffectResult(
      started({ stallStreak: STALL_CONFIRM_TURNS - 1 }),
      turn({
        signature: 'still-stuck-warning',
        callFacts: [{ key: 'search_visual:{}', status: 'warning', fromCache: true }],
      }),
    );
    expect(state.actionRecoveryPending).toBe(true);
  });

  it('stops honestly when a recovery turn still cannot make progress', () => {
    const { state, effects, events } = onEffectResult(
      started({
        stallStreak: STALL_CONFIRM_TURNS - 1,
        actionRecoveryPending: true,
      }),
      turn({ signature: 'recovery-stuck' }),
    );
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
    expect(
      events.some((event) => event.type === 'notification' && /progress/i.test(event.text)),
    ).toBe(true);
  });

  it('lets a real multi-step run gather and then edit without being cut off (W3)', () => {
    // The end-to-end shape of the reported failure: four productive setup turns
    // (session_context → project state → skills → beats) must NOT end the run — each
    // learns something new, so each is progress and the convergence streak stays at 0.
    let s = started();
    const keys = [
      'session_context:{}',
      'get_project_state:{}',
      'load_skill:beat',
      'detect_beats:m',
    ];
    for (const [i, key] of keys.entries()) {
      const step = onEffectResult(
        { ...s, stepIndex: i + 1 },
        turn({
          stepIndex: i + 1,
          signature: `s${i}`,
          callFacts: [{ key, status: 'completed', fromCache: false }],
        }),
      );
      expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
      expect(step.state.phase).toBe('executing');
      s = step.state;
    }
    expect(s.stallStreak).toBe(0);
  });

  it('stops a no-edit spin at the convergence threshold even when every signature is novel', () => {
    // Novel signatures dodge the exact-repeat guard, but turns that learn nothing new still
    // accumulate the convergence streak — so a spin that varies its args every turn stops.
    const s = started({ stallStreak: STALL_CONFIRM_TURNS - 1 });
    const { state, effects } = onEffectResult(s, turn({ signature: 'never-seen-before' }));
    expect(state.stallStreak).toBe(STALL_CONFIRM_TURNS);
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('resets the convergence streak when a turn applies an edit', () => {
    const s = started({ stallStreak: STALL_CONFIRM_TURNS - 1, stepIndex: 2 });
    const { state } = onEffectResult(
      s,
      turn({ stepIndex: 2, applied: true, appliedOps: ops(1), turnOpCount: 1 }),
    );
    expect(state.stallStreak).toBe(0);
  });

  it('a novel zero-op turn on the step cap verifies instead of advancing', () => {
    const s = started({
      stepIndex: 8,
      config: { maxSteps: 8, maxOpsPerTurn: 100, maxOpsPerRun: 800 },
    });
    const { state, effects } = onEffectResult(s, turn({ stepIndex: 8, signature: 'sigCap' }));
    expect(state.phase).toBe('verifying');
    expect(effects).toEqual([{ kind: 'run_verify' }]);
    expect(state.noProgress).toContain('sigCap');
  });

  it('appends a derived step beyond the ledger (turns past a seeded plan)', () => {
    const appended: PlanStep[] = [
      { id: 'step-1', label: 'Trim', status: 'completed' },
      runningStep({ id: 'step-2', label: 'more' }),
    ];
    const { events } = onEffectResult(
      started({ ledgerLength: 1 }),
      turn({
        stepIndex: 2,
        planSteps: appended,
        planStepIndex: 1,
        applied: true,
        appliedOps: ops(1),
        turnOpCount: 1,
      }),
    );
    const plan = events[0] as { steps: PlanStep[] };
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1]).toMatchObject({ id: 'step-2', status: 'completed' });
  });
});

// goal.md Workstream D: every run is bounded by explicit turn, time and cost budgets.
// The bound is SURFACED as a permanent editor setting (Settings → AI → Run budget), not
// as a line the run emits before its first model call — so the opener spends no transcript
// on it, and the run only speaks about the budget when it actually stops on one.
describe('run budgets', () => {
  it('does not announce the budget — the opener is just the status', () => {
    const { events } = onCommand(idle, command());
    expect(events.some((e) => e.type === 'notification')).toBe(false);
    expect(types(events)).toEqual(['status']);
  });

  it("honours the caller's own caps", () => {
    const { events, state } = onCommand(idle, command({ maxUsd: 1.5, maxMinutes: 3 }));
    // The caps live in the run's config, where every later budget check reads them; there
    // is no announcement left to read them out of.
    expect(state.config).toMatchObject({ maxUsd: 1.5, maxWallMs: 180_000 });
    expect(events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('stops at the cost budget and verifies what was applied', () => {
    const s = started({ config: { ...started().config, maxUsd: 1 } });
    const { state, effects, events } = onEffectResult(s, turn({ applied: true, turnOpCount: 1, appliedOps: ops(1), runUsd: 1.25 }));
    expect(state.runUsd).toBe(1.25);
    expect(effects[0]).toMatchObject({ kind: 'run_verify' });
    expect(events.some((e) => e.type === 'notification' && e.text.startsWith("Reached this run's $1.00 budget after 1 step ($1.25 spent)"))).toBe(true);
  });

  it('stops at the time limit', () => {
    const s = started({ config: { ...started().config, maxWallMs: 60_000 } });
    const { effects, events } = onEffectResult(s, turn({ runElapsedMs: 61_000 }));
    expect(effects[0]).toMatchObject({ kind: 'run_verify' });
    expect(events.some((e) => e.type === 'notification' && e.text.includes("1-minute limit"))).toBe(true);
  });

  it('within budget, the run advances; an unpriced run is never stopped for money', () => {
    const s = started({ config: { ...started().config, maxUsd: 1 } });
    const within = onEffectResult(s, turn({ runUsd: 0.4 }));
    expect(within.effects[0]).toMatchObject({ kind: 'run_turn' });
    const unpriced = onEffectResult(s, turn({ runUsd: 0 }));
    expect(unpriced.effects[0]).toMatchObject({ kind: 'run_turn' });
    expect(unpriced.events.some((e) => e.type === 'notification' && e.text.includes('budget'))).toBe(false);
  });

  it('a turn that does not report spend keeps the last known figures', () => {
    const s = started({ runUsd: 0.7, runElapsedMs: 5_000 });
    const { state } = onEffectResult(s, turn({}));
    expect(state).toMatchObject({ runUsd: 0.7, runElapsedMs: 5_000 });
  });
});

// goal.md Workstream D: "audit these guards together — overlapping stop conditions
// silently kill valid long runs". Six stoppers act on a run (stall streak, semantic loop
// window, research budget, diminishing returns, op caps, cost/time budget); this drives a
// long run that keeps LEARNING and LANDING through all of them and asserts that only the
// step cap ends it.
describe('progress guards, audited together', () => {
  const STOP_WORDS = /stopping|stall|circles|budget|limit|diminish|converg|cap of|no longer/i;

  it('a long productive run is ended by the step cap and nothing else', () => {
    const maxSteps = 40;
    let s = started({ config: { ...started().config, maxSteps } });
    const notices: string[] = [];
    let usd = 0;
    let elapsed = 0;
    for (let i = 1; i < maxSteps; i += 1) {
      usd += 0.05;
      elapsed += 20_000;
      const applied = i % 2 === 0;
      const step = onEffectResult(
        s,
        turn({
          stepIndex: i,
          signature: `turn-${String(i)}`,
          rationale: applied ? `Now placing shot ${String(i)}.` : `Reading scene ${String(i)} to choose the next shot.`,
          callFacts: applied
            ? []
            : [{ key: `describe_footage:scene-${String(i)}`, status: 'completed', fromCache: false }],
          ...(applied ? { applied: true, turnOpCount: 1, appliedOps: ops(1) } : {}),
          runUsd: usd,
          runElapsedMs: elapsed,
        }),
      );
      notices.push(...step.events.flatMap((e) => (e.type === 'notification' ? [e.text] : [])));
      expect(step.effects[0], `turn ${String(i)} should continue`).toMatchObject({ kind: 'run_turn' });
      expect(step.state.stallStreak, `turn ${String(i)} stall streak`).toBe(0);
      expect(step.state.actionRecoveryPending, `turn ${String(i)} recovery`).toBe(false);
      s = step.state;
    }
    // The step cap, and only the step cap, ends it.
    const last = onEffectResult(
      s,
      turn({ stepIndex: maxSteps, signature: 'last', applied: true, turnOpCount: 1, appliedOps: ops(1) }),
    );
    expect(last.effects[0]).toMatchObject({ kind: 'run_verify' });
    const stoppers = notices.filter((text) => STOP_WORDS.test(text));
    expect(stoppers, `no guard may speak during a productive run:\n${stoppers.join('\n')}`).toEqual([]);
    expect(s.cumulativeOps.length).toBe(19);
  });

  it('a run that only ever reads something NEW is bounded by the cost budget, not the guards', () => {
    // Each novel, successful read is progress by design (W3: reconnaissance is how an edit
    // becomes possible), so the stall, loop and research guards correctly let a run read
    // forty different scenes. What bounds it is money: without the cost budget such a run
    // ran to the 300-step cap. Here the budget is the backstop, and it says so.
    let s = started({ config: { ...started().config, maxSteps: 40, maxUsd: 1 } });
    let ended: string | undefined;
    let i = 1;
    for (; i < 40 && ended === undefined; i += 1) {
      const step = onEffectResult(
        s,
        turn({
          stepIndex: i,
          signature: `read-${String(i)}`,
          rationale: `Reading scene ${String(i)}.`,
          callFacts: [{ key: `describe_footage:scene-${String(i)}`, status: 'completed', fromCache: false }],
          runUsd: i * 0.1,
        }),
      );
      s = step.state;
      if (step.effects[0]?.kind !== 'run_turn') {
        ended = step.events.flatMap((e) => (e.type === 'notification' ? [e.text] : [])).join(' | ');
      }
    }
    expect(ended).toMatch(/Reached this run's \$1\.00 budget after 10 steps \(\$1\.00 spent\)/);
    expect(i).toBe(11);
  });
});

describe('onEffectResult — verify(+repair) → finalize', () => {
  it('surfaces the self-check summary + a warning per failed check, then finalizes', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(2), appliedTurns: 1 });
    const { state, effects, events } = onEffectResult(
      s,
      verify({
        ok: false,
        summary: 'one issue',
        failedChecks: [{ label: 'Duration', detail: 'too long' }],
      }),
    );
    expect(state.phase).toBe('review');
    // …and, because work was applied and the run still could not finish, ONE error card
    // that says the edits are on the timeline and why the run stopped.
    expect(types(events)).toEqual(['notification', 'warning', 'error']);
    expect(events[0]).toMatchObject({ text: 'Deterministic self-check: one issue' });
    expect(events[2]).toMatchObject({
      type: 'error',
      message: expect.stringContaining(
        'Applied 2 changes, but the run could not finish: the self-check still fails — Duration',
      ),
      retryable: false,
    });
    expect(effects[0]).toMatchObject({
      kind: 'finalize',
      ops: s.cumulativeOps,
      cancelled: false,
      failed: true,
    });
  });

  it('a failed run that applied nothing gets no "applied" error card', () => {
    const s = started({ phase: 'verifying', cumulativeOps: [], appliedTurns: 0 });
    const { events } = onEffectResult(
      s,
      verify({
        ok: false,
        summary: 'one issue',
        failedChecks: [{ label: 'Duration', detail: 'too long' }],
      }),
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a cancelled run never gets the failure card — the checkpoint is its account', () => {
    const s = started({
      phase: 'verifying',
      cumulativeOps: ops(2),
      appliedTurns: 1,
      cancelled: true,
    });
    const { events } = onEffectResult(
      s,
      verify({
        ok: false,
        summary: 'one issue',
        failedChecks: [{ label: 'Duration', detail: 'too long' }],
      }),
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  // GAP-010 (run `fc10301a`). Advisory checks are non-blocking on purpose, and the price
  // of that was that their advice never arrived: only failures were carried, so a `warn`
  // reached the editor as the number in "3 check(s) failed, 1 warning(s)". The withheld
  // sentence in that run was "any landscape source will render with black bars", over a
  // montage of landscape stills in a portrait frame.
  it('says what an advisory check found, not just how many there were', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(2), appliedTurns: 1 });
    const { events } = onEffectResult(
      s,
      verify({
        ok: false,
        summary: '1 check(s) failed, 1 warning(s)',
        failedChecks: [{ label: 'Duration', detail: 'too long' }],
        warnedChecks: [
          { label: 'Reframing is consistent', detail: 'any landscape source will render…' },
        ],
      }),
    );
    // The failure is a warning event; the advisory is a notification — the severity
    // distinction survives to the stream rather than being flattened.
    expect(types(events)).toEqual(['notification', 'warning', 'notification', 'error']);
    expect(events[2]).toMatchObject({
      text: 'Reframing is consistent: any landscape source will render…',
    });
  });

  // GAP-016. Four different things could have happened; they all looked identical.
  it('says what the repair pass did, including when it did nothing', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(2), appliedTurns: 1 });
    const { events } = onEffectResult(
      s,
      verify({ ok: false, summary: 'one issue', repairOutcome: { kind: 'no_calls' } }),
    );
    expect(
      events.some((e) => e.type === 'notification' && e.text.includes('proposed no change')),
    ).toBe(true);
  });

  it('names the validator when the repair pass was rejected', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(2), appliedTurns: 1 });
    const { events } = onEffectResult(
      s,
      verify({
        ok: false,
        summary: 'one issue',
        repairOutcome: { kind: 'all_rejected', reasons: ['Rejected: overlaps neighbour'] },
      }),
    );
    expect(
      events.some((e) => e.type === 'notification' && e.text.includes('overlaps neighbour')),
    ).toBe(true);
  });

  it('blocks successful completion when deterministic verification still fails', () => {
    const applied = onEffectResult(
      started(),
      turn({ applied: true, appliedOps: ops(1), turnOpCount: 1 }),
    ).state;
    const step = onEffectResult(
      { ...applied, phase: 'verifying' },
      verify({
        ok: false,
        summary: 'duration is incomplete',
        failedChecks: [{ label: 'Duration', detail: '6s of 30s' }],
      }),
    );
    expect(step.state.integrityFailed).toBe(true);
    expect(step.effects[0]).toMatchObject({ kind: 'finalize', failed: true });
  });

  // P4.3 — the bounded verify loop. A failed self-check on a run that did land work gets
  // ONE model turn scoped to the findings, then verifies again; two such turns at most,
  // after which the run settles honestly with the list.
  /** A turn that landed an edit the ledger can trace (an operation row needs a described action). */
  const landed = (over: Partial<AgentTurnResult> = {}): AgentTurnResult =>
    turn({
      applied: true,
      appliedOps: ops(1),
      turnOpCount: 1,
      describedActions: [{ action: 'Placed a clip', detail: 'clip_1 on video_1' }],
      ...over,
    });

  it('routes a failed self-check into a findings-scoped fix turn instead of failing outright', () => {
    const applied = onEffectResult(started(), landed()).state;
    const step = onEffectResult(
      { ...applied, phase: 'verifying' },
      verify({
        ok: false,
        summary: '2 check(s) failed',
        failedChecks: [
          { label: 'No overlaps', detail: 'clip_2 overlaps clip_1 by 0.4s' },
          { label: 'Cuts on frame grid', detail: 'clip_3 ends off-grid' },
        ],
      }),
    );
    expect(step.state.phase).toBe('executing');
    expect(step.state.verifyFixTurns).toBe(1);
    expect(step.state.integrityFailed).toBe(false);
    expect(step.state.working.stage).toBe('repair');
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn', stage: 'repair' });
    // The findings are in the run's memory, one FAIL line each, for the briefing to show.
    const failed = step.state.working.verifications.filter((v) => !v.passed);
    expect(failed.map((v) => `${v.criterion} — ${v.detail ?? ''}`)).toEqual([
      'No overlaps — clip_2 overlaps clip_1 by 0.4s',
      'Cuts on frame grid — clip_3 ends off-grid',
    ]);
    expect(
      step.events.some((e) => e.type === 'notification' && e.text.includes('fix turn 1 of 1')),
    ).toBe(true);
  });

  it('a fixed run passes the second self-check and completes', () => {
    const applied = onEffectResult(started(), landed()).state;
    const fixing = onEffectResult(
      { ...applied, phase: 'verifying' },
      verify({
        ok: false,
        summary: '1 failed',
        failedChecks: [{ label: 'No overlaps', detail: 'x' }],
      }),
    ).state;
    // The fix turn lands an edit and declares itself done → back to verify.
    const fixed = onEffectResult(fixing, landed({ done: true, stepIndex: fixing.stepIndex }));
    expect(fixed.effects[0]).toMatchObject({ kind: 'run_verify' });
    const done = onEffectResult(fixed.state, verify({ ok: true, summary: 'all checks passed' }));
    expect(done.state.working.stage).toBe('complete');
    expect(done.state.integrityFailed).toBe(false);
    expect(done.effects[0]).toMatchObject({ kind: 'finalize', failed: false });
  });

  it('never spends more than MAX_VERIFY_FIX_TURNS — the next failing self-check settles the run', () => {
    const failing = verify({
      ok: false,
      summary: 'still failing',
      failedChecks: [{ label: 'Duration', detail: '6s of 30s' }],
    });
    let state = onEffectResult(started(), landed()).state;
    state = { ...state, phase: 'verifying' };
    for (let fix = 1; fix <= MAX_VERIFY_FIX_TURNS; fix += 1) {
      const step = onEffectResult(state, failing);
      expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
      expect(step.state.verifyFixTurns).toBe(fix);
      const back = onEffectResult(
        step.state,
        landed({ done: true, stepIndex: step.state.stepIndex }),
      );
      expect(back.effects[0]).toMatchObject({ kind: 'run_verify' });
      state = back.state;
    }
    const settled = onEffectResult(state, failing);
    expect(settled.state.verifyFixTurns).toBe(MAX_VERIFY_FIX_TURNS);
    expect(settled.state.integrityFailed).toBe(true);
    expect(settled.effects[0]).toMatchObject({ kind: 'finalize', failed: true });
    expect(settled.events.some((e) => e.type === 'warning' && e.text.includes('6s of 30s'))).toBe(
      true,
    );
  });

  it('does not open a fix turn when nothing landed — there is nothing to fix', () => {
    const s = started({ phase: 'verifying' });
    const step = onEffectResult(
      s,
      verify({
        ok: false,
        summary: 'no edit',
        failedChecks: [{ label: 'Changed', detail: 'unchanged' }],
      }),
    );
    expect(step.state.verifyFixTurns ?? 0).toBe(0);
    expect(step.effects[0]).toMatchObject({ kind: 'finalize' });
  });

  it('folds the repair pass ops into the finalized combined patch', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(1), appliedTurns: 1 });
    const { effects } = onEffectResult(s, verify({ repairOps: ops(2) }));
    expect((effects[0] as { ops: unknown[] }).ops).toHaveLength(3);
  });

  it('emits the honest empty-run notice when nothing applied but edits were attempted', () => {
    const s = started({ phase: 'verifying', rejectedOpCount: 2, rejectionReasons: ['bad'] });
    const events = onEffectResult(s, verify()).events;
    const warn = events.find((e) => e.type === 'warning');
    expect((warn as { text: string }).text).toContain('No edits were applied');
    expect(events.some((e) => e.type === 'notification' && /self-check/i.test(e.text))).toBe(false);
  });

  it('emits no empty-run notice when the run applied edits', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(1), appliedTurns: 1 });
    const { events } = onEffectResult(s, verify());
    expect(events.some((e) => e.type === 'warning')).toBe(false);
  });

  /**
   * Run `ea8e46ec` landed two audio operations and was refused sixty-one picture clips six
   * times. Because the only account of a refusal was gated on the run being COMPLETELY
   * empty, the editor was shown a stall notice and two warnings about the resulting
   * timeline, and nothing about the rule that produced it.
   */
  it('says what did NOT land when a run applied some edits and had others refused', () => {
    const s = started({
      phase: 'verifying',
      cumulativeOps: ops(2),
      appliedTurns: 1,
      rejectedOpCount: 61,
      rejectionReasons: ['rejected by the beat grid: the analyzed music is not on the timeline'],
    });
    const { events } = onEffectResult(s, verify());
    const warn = events.find((e) => e.type === 'warning') as { text: string } | undefined;
    expect(warn?.text).toContain('61 proposed changes');
    expect(warn?.text).toContain('beat grid');
    // And it must not read as a total failure: what landed is real and undoable.
    expect(warn?.text).toContain('can be undone');
  });

  // GAP-006. `assessEditCompletion` was written to stop a run reporting incomplete planned
  // work as success, and then wired only into `autonomous-edit-runtime.ts`, which no
  // production code ever called — a green suite for a rail that was not installed. This is
  // the rail, on the path that actually runs.
  it('says so when the plan the editor was shown was not finished', () => {
    const s = started({
      phase: 'verifying',
      cumulativeOps: ops(1),
      appliedTurns: 1,
      ledgerLength: 3,
      planSteps: [
        { id: 'step-1', label: 'Trim the intro', status: 'completed' },
        { id: 'step-2', label: 'Add captions', status: 'pending' },
        { id: 'step-3', label: 'Colour match', status: 'failed' },
      ],
    });
    const warn = onEffectResult(s, verify()).events.find((e) => e.type === 'warning');
    expect((warn as { text: string }).text).toContain('Not everything in the plan was done');
    expect((warn as { text: string }).text).toContain('1 of 3');
    expect((warn as { text: string }).text).toContain('1 planned task(s) failed');
  });

  it('stays quiet when every planned step finished', () => {
    const s = started({
      phase: 'verifying',
      cumulativeOps: ops(1),
      appliedTurns: 1,
      ledgerLength: 1,
      planSteps: [{ id: 'step-1', label: 'Trim the intro', status: 'completed' }],
    });
    expect(onEffectResult(s, verify()).events.some((e) => e.type === 'warning')).toBe(false);
  });

  // An unplanned run carries internal step rows for status tracking but never showed the
  // editor a checklist, so there is no promise to report against.
  it('never reports unfinished plan work for a run that drafted no plan', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(1), appliedTurns: 1 });
    expect(onEffectResult(s, verify()).events.some((e) => e.type === 'warning')).toBe(false);
  });

  it('uses the singular form when exactly one proposed change was rejected', () => {
    const s = started({ phase: 'verifying', rejectedOpCount: 1, rejectionReasons: ['bad'] });
    const warn = onEffectResult(s, verify()).events.find((e) => e.type === 'warning');
    expect((warn as { text: string }).text).toContain('1 proposed change couldn');
  });
});

describe('clock fallback', () => {
  it('stamps events with Date.now when the turnRef carries no clock', () => {
    const before = Date.now();
    const noClock: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      input,
      stream: { conversationId: 'c', turnId: 't' },
    };
    const { events } = onCommand(
      initialConductorState({ conversationId: 'c', turnId: 't' }),
      noClock,
    );
    expect(events[0]!.ts).toBeGreaterThanOrEqual(before);
  });
});

describe('event id sequencing', () => {
  it('seeds the fold emitter from the result endSeq so ids continue the run sequence', () => {
    const s = started({ phase: 'verifying', cumulativeOps: ops(1), appliedTurns: 1 });
    const notice = onEffectResult(s, verify({ endSeq: 5 })).events.find(
      (e) => e.type === 'notification',
    )!;
    expect(notice.id).toBe('turn_1:notice:6');
  });
});

/**
 * E4 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — the diminishing-returns stop.
 * Each scenario folds turns that stay NOVEL (fresh callFacts, so the stall guard never
 * fires) but tiny: the reducer must recognize convergence by token delta alone.
 */
describe('diminishing-returns stop (E4)', () => {
  /** A novel, zero-edit turn with the given reported output-token delta. */
  const lowTurn = (i: number, outputTokens?: number): AgentTurnResult =>
    turn({
      stepIndex: i,
      signature: `sig-${i}`,
      callFacts: [{ key: `read:${i}`, status: 'completed', fromCache: false }],
      ...(outputTokens === undefined ? {} : { usage: { inputTokens: 10, outputTokens } }),
    });

  /** Fold a sequence of turn results, returning the last step. */
  const fold = (state: ConductorState, turns: readonly AgentTurnResult[]) => {
    let step: ReturnType<typeof onEffectResult> = { state, effects: [], events: [] };
    for (const t of turns) step = onEffectResult(step.state, t);
    return step;
  };

  it('stops with the converged notice after N consecutive low-delta, zero-edit turns', () => {
    // Fold exactly DIMINISHING_RETURNS_TURNS low-delta turns — the reducer must confirm
    // convergence at that threshold regardless of how it happens to be tuned.
    const deltas = Array.from({ length: DIMINISHING_RETURNS_TURNS }, (_, i) => 30 + (i % 3) * 20);
    const step = fold(
      started(),
      deltas.map((delta, i) => lowTurn(i + 1, delta)),
    );
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
    const notice = step.events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({
      reason: DIMINISHING_RETURNS_REASON,
      detail: expect.stringContaining(deltas.join(', ')),
    });
    expect(notice?.type === 'notification' ? notice.text : '').toContain('converged');
    // Distinct from the stall notice — this run never stalled.
    expect(step.state.stallStreak).toBe(0);
  });

  it('boundary: a delta exactly AT the threshold never counts as diminishing', () => {
    const at = DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS;
    const step = fold(started(), [lowTurn(1, at), lowTurn(2, at), lowTurn(3, at)]);
    expect(step.effects).toEqual([
      {
        kind: 'run_turn',
        stepIndex: 4,
        planSteps: step.state.planSteps,
        ledgerLength: 0,
        stage: step.state.working.stage,
        working: step.state.working,
      },
    ]);
    expect(step.events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('one delta under the threshold among big ones does not trigger (window must be uniform)', () => {
    const step = fold(started(), [lowTurn(1, 50), lowTurn(2, 5000), lowTurn(3, 50)]);
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('an interleaved APPLIED turn resets the streak', () => {
    const applied = turn({
      stepIndex: 2,
      signature: 'sig-applied',
      applied: true,
      turnOpCount: 1,
      appliedOps: ops(1),
      usage: { inputTokens: 10, outputTokens: 40 },
    });
    const step = fold(started(), [
      lowTurn(1, 50),
      lowTurn(2, 50),
      applied,
      lowTurn(4, 50),
      lowTurn(5, 50),
    ]);
    // Only two low turns since the applied one — no stop yet.
    expect(step.state.recentOutputDeltas).toEqual([50, 50]);
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('a turn with NO reported usage resets the window (a streak must be provable end-to-end)', () => {
    const step = fold(started(), [lowTurn(1, 50), lowTurn(2, undefined), lowTurn(3, 50)]);
    expect(step.state.recentOutputDeltas).toEqual([50]);
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
  });

  it('honors tuned thresholds from agentOptions', () => {
    const tuned = onCommand(
      idle,
      command({ diminishingReturns: { turns: 2, minOutputTokens: 10 } }),
    ).state;
    // Two 5-token turns trip the tuned rule; the default rule would need three < 120.
    const step = fold(tuned, [lowTurn(1, 5), lowTurn(2, 5)]);
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
    expect(step.events.some((e) => e.type === 'notification')).toBe(true);
  });

  it('the genuine stall notice still wins over diminishing returns (checked first)', () => {
    // Non-novel turns (empty callFacts) with tiny usage: the stall streak confirms
    // first and keeps its more specific explanation.
    const stallTurns = Array.from({ length: STALL_CONFIRM_TURNS }, (_, i) =>
      turn({ stepIndex: i + 1, signature: `stall-${i}`, usage: { outputTokens: 10 } }),
    );
    const step = fold(started(), stallTurns);
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
    const notice = step.events.find((e) => e.type === 'notification');
    expect(notice?.type === 'notification' ? notice.text : '').toContain('stopped making progress');
    expect(notice?.type === 'notification' ? notice.reason : 'set').toBeUndefined();
  });

  /**
   * "No further edits could be found for this request" was said unconditionally, and in run
   * `ea8e46ec` it was false: 61 edits were found, six times over, and refused six times by
   * one internal rule. A run that knows exactly why it could not act must say so.
   */
  it('names the standing refusal instead of claiming no edits could be found', () => {
    const refusal = 'rejected by the beat grid: the analyzed music is not on the timeline';
    // The FIRST refusal is a genuine attempt and resets the streak, so confirmation takes
    // one more turn than a pure non-progress stall — which is exactly the bound intended.
    const refusedTurns = Array.from({ length: STALL_CONFIRM_TURNS + 1 }, (_, i) =>
      turn({
        stepIndex: i + 1,
        signature: `refused-${i}`,
        turnOpCount: 61,
        rejection: refusal,
        note: refusal,
      }),
    );
    const step = fold(started(), refusedTurns);
    const notice = step.events.find((e) => e.type === 'notification');
    const text = notice?.type === 'notification' ? notice.text : '';
    expect(text).toContain('kept being refused');
    expect(text).toContain('beat grid');
    expect(text).not.toContain('no further edits could be found');
  });
});

describe('research budget (R1) — the forced research→execute transition', () => {
  /**
   * One novel, verbose, zero-edit reconnaissance turn: exactly the shape that defeats
   * BOTH existing guards. Novel `callFacts` keep the stall streak at 0; a large output
   * delta keeps the diminishing-returns window from ever filling.
   */
  const reconTurn = (i: number): AgentTurnResult =>
    turn({
      stepIndex: i,
      signature: `recon-${i}`,
      callFacts: [{ key: `read:${i}`, status: 'completed', fromCache: false }],
      usage: { inputTokens: 100, outputTokens: 900 },
    });

  const fold = (state: ConductorState, turns: readonly AgentTurnResult[]) => {
    let step: ReturnType<typeof onEffectResult> = { state, effects: [], events: [] };
    for (const t of turns) step = onEffectResult(step.state, t);
    return step;
  };

  it('regression: the reported "research forever, never edit" run now forces action', () => {
    // The real failure: every turn re-read the transcript at a NEW window, so every turn
    // looked novel, the stall streak never advanced, and the run researched until the
    // step cap having applied nothing. Budget exhaustion must now force an action turn.
    const step = fold(
      started(),
      Array.from({ length: RESEARCH_BUDGET_TURNS }, (_, i) => reconTurn(i + 1)),
    );
    expect(step.state.researchStreak).toBe(RESEARCH_BUDGET_TURNS);
    // Both pre-existing guards are still disarmed — proving the budget is what fired.
    expect(step.state.stallStreak).toBe(0);
    expect(step.state.recentOutputDeltas.every((d) => d >= 120)).toBe(true);
    // The next turn runs with read/analysis descriptors withheld.
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn', actionRecovery: true });
    const notice = step.events.find((e) => e.type === 'notification');
    expect(notice?.type === 'notification' ? notice.text : '').toContain('making the edit');
  });

  it('does not fire one turn early (budget is a ceiling, not a target)', () => {
    const step = fold(
      started(),
      Array.from({ length: RESEARCH_BUDGET_TURNS - 1 }, (_, i) => reconTurn(i + 1)),
    );
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn' });
    expect(step.effects[0]).not.toHaveProperty('actionRecovery');
    expect(step.events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('an APPLIED edit refunds the budget, so a long multi-step edit is never squeezed', () => {
    const applied = turn({
      stepIndex: 3,
      signature: 'applied',
      applied: true,
      turnOpCount: 1,
      appliedOps: ops(1),
    });
    const step = fold(started(), [reconTurn(1), reconTurn(2), applied, reconTurn(4)]);
    expect(step.state.researchStreak).toBe(1);
    expect(step.effects[0]).not.toHaveProperty('actionRecovery');
  });

  /** A turn that only stocked the media bin: it produced ops, but changed no cut. */
  const binTurn = (i: number): AgentTurnResult =>
    turn({
      stepIndex: i,
      signature: `bin-${i}`,
      callFacts: [{ key: `add_stock:${i}`, status: 'completed', fromCache: false }],
      turnOpCount: 3,
      turnPlacementCount: 0,
    });

  /** A turn that put a clip on the timeline. */
  const cutTurn = (i: number): AgentTurnResult =>
    turn({
      stepIndex: i,
      signature: `cut-${i}`,
      callFacts: [{ key: `add_clip:${i}`, status: 'completed', fromCache: false }],
      turnOpCount: 2,
      turnPlacementCount: 2,
    });

  it('a bin-only turn spends budget instead of refunding it', () => {
    // The captured run's thirteen "Added asset" operations refunded the whole eight-turn
    // budget again and again, so the guard built to force research→execute could not fire
    // on a run that spent thirty minutes researching. Downloading is not editing.
    const step = fold(started(), [binTurn(1), binTurn(2), binTurn(3)]);
    expect(step.state.researchStreak).toBe(3);
  });

  it('a turn that changes the cut refunds the whole budget', () => {
    const step = fold(started(), [binTurn(1), binTurn(2), cutTurn(3)]);
    expect(step.state.researchStreak).toBe(0);
  });

  it('a run that only ever shops still reaches the budget', () => {
    const step = fold(
      started(),
      Array.from({ length: RESEARCH_BUDGET_TURNS }, (_, i) => binTurn(i + 1)),
    );
    expect(step.state.researchStreak).toBe(RESEARCH_BUDGET_TURNS);
    expect(step.effects[0]).toMatchObject({ kind: 'run_turn', actionRecovery: true });
  });

  it('a caller that does not report placements keeps the old behaviour', () => {
    // Additive: the legacy loop and every fixture are unchanged.
    const legacy = turn({
      stepIndex: 1,
      signature: 'legacy',
      callFacts: [{ key: 'x', status: 'completed', fromCache: false }],
      turnOpCount: 3,
    });
    expect(fold(started(), [legacy]).state.researchStreak).toBe(0);
  });

  it('a REJECTED edit attempt also refunds it — attempting proves recon is over', () => {
    const attempted = turn({ stepIndex: 3, signature: 'tried', turnOpCount: 2, note: 'rejected' });
    const step = fold(started(), [reconTurn(1), reconTurn(2), attempted]);
    expect(step.state.researchStreak).toBe(0);
  });

  it('the forced action turn is single-use — a still-idle run then converges normally', () => {
    // Budget exhaustion grants exactly ONE forced turn. If the model still refuses to
    // act, the run must fall through to the ordinary convergence guard, not loop on
    // recovery turns forever.
    let step = fold(
      started(),
      Array.from({ length: RESEARCH_BUDGET_TURNS }, (_, i) => reconTurn(i + 1)),
    );
    expect(step.effects[0]).toMatchObject({ actionRecovery: true });
    // Non-novel, zero-edit turns from here on: the stall streak can finally advance.
    for (let i = 0; i < STALL_CONFIRM_TURNS; i++) {
      step = onEffectResult(step.state, turn({ stepIndex: 20 + i, signature: `stuck-${i}` }));
    }
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
  });
});

describe('empty-run honesty (R2)', () => {
  it('a run the harness cut short without an edit attempt says so, not nothing', () => {
    // The worst case used to be the quietest: no rejections meant no warning, so a run
    // that changed nothing reported like a normal one with an empty diff.
    const step = onEffectResult(started({ phase: 'verifying' }), verify());
    const warning = step.events.find((e) => e.type === 'warning');
    expect(warning?.type === 'warning' ? warning.text : '').toContain('never made a change');
    expect(step.state.cumulativeOps).toHaveLength(0);
  });

  it('a voluntary finish that still ends FAILED explains the failure once', () => {
    // "The silences were already trimmed — nothing to do" is a legitimate outcome the model
    // has already explained, so it is never scolded with the never-attempted notice. But a
    // run with no traceable mutation settles `failed` (ADR 0081), and the host renders that
    // as a bare Retry button — so the outcome itself must be stated, or the model's prose is
    // the only account of a run the app considers failed.
    const step = onEffectResult(started({ phase: 'verifying', modelDeclaredDone: true }), verify());
    const warnings = step.events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type === 'warning' ? warnings[0].text : '').toContain(
      'ended without applying anything',
    );
    expect(warnings[0]?.type === 'warning' ? warnings[0].text : '').not.toContain(
      'never made a change',
    );
  });

  it('the done fold records the voluntary finish', () => {
    const step = onEffectResult(started(), turn({ done: true }));
    expect(step.state.modelDeclaredDone).toBe(true);
    expect(step.effects).toEqual([{ kind: 'run_verify' }]);
  });

  it('a run with validator rejections keeps its more specific explanation', () => {
    const step = onEffectResult(
      started({ phase: 'verifying', rejectedOpCount: 2, rejectionReasons: ['overlap'] }),
      verify(),
    );
    const warning = step.events.find((e) => e.type === 'warning');
    expect(warning?.type === 'warning' ? warning.text : '').toContain('overlap');
  });

  it('a run whose ops were dropped by the per-turn cap is not told it never tried', () => {
    // The cap path discards the turn's ops without adding to the rejection tally, so
    // `rejectedOpCount` alone would misread it as "never attempted" — and the run would
    // get a second, contradictory warning on top of the specific cap explanation.
    const capped = onEffectResult(
      started({ config: { ...started().config, maxOpsPerTurn: 1 } }),
      turn({ turnOpCount: 5 }),
    );
    expect(capped.state.attemptedAnyEdit).toBe(true);
    const final = onEffectResult(capped.state, verify());
    const warnings = final.events.filter((e) => e.type === 'warning');
    const saidNeverTried = warnings.some(
      (w) => w.type === 'warning' && w.text.includes('never made a change'),
    );
    expect(saidNeverTried).toBe(false);
  });

  it('a run that applied ops emits no empty-run warning', () => {
    const step = onEffectResult(started({ phase: 'verifying', cumulativeOps: ops(3) }), verify());
    expect(step.events.some((e) => e.type === 'warning')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task memory (ADR 0075) — the state that must outlive every turn
// ---------------------------------------------------------------------------

describe('working state', () => {
  it('commits a durable objective from the raw request at command time (RSI1)', () => {
    // There is no separate interpret-stage tool call that normalizes the objective —
    // `advanceStage` refuses every stage past `interpret` until `isInterpreted` is true
    // (working-state.ts), so `onCommand` must commit *some* durable outcome up front or
    // the run can never leave `interpret`. It carries the creator's raw request verbatim
    // (never a fabricated paraphrase) rather than deferring to a turn that does not exist.
    const state = onCommand(idle, command()).state;
    expect(state.working.objective.request).toBe('tighten the intro');
    expect(state.working.objective.outcome).toBe('tighten the intro');
    expect(state.working.stage).toBe('interpret');
    expect(state.working.operations).toEqual([]);
  });

  it('records an applied edit and advances the project revision', () => {
    const step = onEffectResult(
      started(),
      turn({
        applied: true,
        appliedOps: ops(1),
        turnOpCount: 1,
        describedActions: [{ action: 'Deleted 2:10–3:40 on Video 1', detail: '', refs: [] }],
      }),
    );
    expect(step.state.working.currentProjectRevision).toBe(1);
    expect(step.state.working.operations).toEqual([
      expect.objectContaining({
        intent: 'Deleted 2:10–3:40 on Video 1',
        status: 'succeeded',
        atRevision: 1,
      }),
    ]);
  });

  it('records an attempted edit the validator refused, so trying is not mistaken for idling', () => {
    const step = onEffectResult(
      started(),
      turn({ applied: false, turnOpCount: 3, rejectedOpCount: 3, note: 'overlaps clip_b' }),
    );
    expect(step.state.working.operations).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'overlaps clip_b' }),
    ]);
  });

  it('tags a recorded operation with the plan objective it discharges, when the committed plan has one', () => {
    // Only a `planFirst` run commits objectives up front (one per drafted step); an
    // applied edit whose step index lines up with an objective must carry that
    // objective's id so completion can later be computed from the ledger, not the
    // model's say-so.
    const drafted = onCommand(idle, command({ planFirst: true })).state;
    const withPlan = onEffectResult(
      drafted,
      draftPlan({ labels: ['Trim the intro', 'Wrap up'] }),
    ).state;
    const step = onEffectResult(
      withPlan,
      turn({
        applied: true,
        appliedOps: ops(1),
        turnOpCount: 1,
        planStepIndex: 0,
        describedActions: [{ action: 'Trimmed the intro', detail: '', refs: [] }],
      }),
    );
    expect(step.state.working.operations).toEqual([
      expect.objectContaining({ objectiveId: 'objective_1' }),
    ]);
  });

  it('records an applied edit with no objective tag when the working state carries none (defensive: id-suffix matching only ever succeeds when objectives exist)', () => {
    // Every reachable committed-plan state seeds at least one objective (either the
    // command-time default or a drafted plan's), so an empty `objectives` array here is
    // synthesized rather than reachable through the exposed reducer — this locks in that
    // the operation record omits `objectiveId` instead of tagging it with a fabricated id
    // if that invariant were ever to drift.
    const s = { ...started(), working: { ...started().working, objectives: [] } };
    const step = onEffectResult(
      s,
      turn({
        applied: true,
        appliedOps: ops(1),
        turnOpCount: 1,
        describedActions: [{ action: 'Trimmed the intro', detail: '', refs: [] }],
      }),
    );
    expect(step.state.working.operations).toEqual([
      expect.not.objectContaining({ objectiveId: expect.anything() }),
    ]);
  });

  it('leaves the ledger alone for a pure reconnaissance turn', () => {
    const step = onEffectResult(started(), turn({ applied: false, turnOpCount: 0 }));
    expect(step.state.working.operations).toEqual([]);
  });

  it('keeps source-material knowledge across an applied edit', () => {
    // A cut cannot change the words that were spoken; it can only change where the
    // clips are. This is the whole reason a run no longer re-reads its own transcript.
    const withFacts = started();
    const seeded: ConductorState = {
      ...withFacts,
      working: {
        ...withFacts.working,
        facts: [
          {
            id: 'fact_1',
            kind: 'transcript',
            statement: 'Hook lands at 0:12.',
            evidenceIds: ['ev_1'],
            scope: 'revision_independent',
            observedAtRevision: 0,
            stage: 'analyze',
          },
          {
            id: 'fact_2',
            kind: 'project',
            statement: 'clip_b runs 6–10s.',
            evidenceIds: [],
            scope: 'timeline_dependent',
            observedAtRevision: 0,
            stage: 'inspect',
          },
        ],
      },
    };
    const step = onEffectResult(
      seeded,
      turn({ applied: true, appliedOps: ops(1), turnOpCount: 1 }),
    );
    expect(step.state.working.facts.map((f) => f.id)).toEqual(['fact_1']);
  });
});


describe('failedAfterApplyMessage — the card an editor actually reads', () => {
  const detail = (label: string, text: string) => `${label}: ${text}`;

  it('says what is wrong, not the name of the property that was checked', () => {
    // The label alone is a positive assertion, so a card built from labels reads inside
    // out. A real montage run was told "the self-check still fails — Reframing is
    // consistent." and given nothing to act on.
    const message = failedAfterApplyMessage(30, [
      detail(
        'Reframing is consistent',
        '13 of 13 picture clips use a landscape source in a 1080x1920 portrait frame with no crop, so they render with black bars. Crop each to fill the frame.',
      ),
    ]);
    expect(message).toContain('Applied 30 changes, but the run could not finish');
    expect(message).toContain('render with black bars');
    expect(message).toContain('Crop each to fill the frame.');
    expect(message).toContain('The changes are on your timeline; undo reverts them');
  });

  it('spells out the first two failures and counts the rest', () => {
    const message = failedAfterApplyMessage(4, [
      detail('A', 'first thing is wrong.'),
      detail('B', 'second thing is wrong.'),
      detail('C', 'third thing is wrong.'),
      detail('D', 'fourth thing is wrong.'),
    ]);
    expect(message).toContain('first thing is wrong.');
    expect(message).toContain('second thing is wrong.');
    expect(message).not.toContain('third thing is wrong.');
    expect(message).toContain('(2 more checks also failed.)');
  });

  it('punctuates a reason that does not end in a full stop, and singularises the rest', () => {
    const message = failedAfterApplyMessage(2, ['A: no full stop', 'B: nor here', 'C: third']);
    expect(message).toContain('A: no full stop. B: nor here.');
    expect(message).toContain('(1 more check also failed.)');
  });

  it('passes a single prose reason through unchanged', () => {
    expect(failedAfterApplyMessage(1, 'the run ran out of budget')).toContain(
      'Applied 1 change, but the run could not finish: the run ran out of budget',
    );
  });
});
