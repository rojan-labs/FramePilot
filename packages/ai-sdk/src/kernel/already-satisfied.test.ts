/**
 * An edit the timeline already reflects is DONE, not broken.
 *
 * `applyAgentTurn` refuses a turn whose patch id it has already applied — the operations
 * hash to the same value, so the timeline already says what the turn is asking it to say.
 * Until this was fixed the reducer filed that turn as a `failed` operation, and the state
 * briefing renders failures under:
 *
 *     FAILED — fix the cause, do not retry unchanged
 *
 * In the captured caption run that line appeared twenty-four times for caption emphasis that
 * had in fact been applied and was sitting on the timeline. There was no cause to fix, so
 * the model tried again, and again. The fix is not to suppress the message but to tell the
 * truth: the operation SUCCEEDED, and belongs under "ALREADY APPLIED — do not repeat".
 */
import { describe, expect, it } from 'vitest';
import type { ContextInput } from '../context-builder.js';
import { makeProject } from '../__fixtures__/project.js';
import type { Command } from './commands.js';
import {
  type AgentTurnResult,
  type ConductorState,
  initialConductorState,
  onCommand,
  onEffectResult,
} from './conductor.js';
import { buildStateBriefing } from './briefing.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'emphasize the captions' };
const stream = { conversationId: 'conv_1', turnId: 'turn_1', now: () => 1000 };
const command = (): Command => ({ kind: 'submit_turn', mode: 'agent', input, stream });

const turn = (over: Partial<AgentTurnResult>): AgentTurnResult => ({
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
  signature: 'auto_emphasize_captions:{"trackId":"caption_1"}',
  callFacts: [],
  note: 'note',
  planSteps: [],
  planStepIndex: 0,
  intent: 'Emphasising key words in the captions',
  log: [],
  endSeq: 1,
  ...over,
});

const started = (): ConductorState => onCommand(initialConductorState(stream), command()).state;

describe('a turn whose edit is already on the timeline', () => {
  it('is recorded as succeeded, not failed', () => {
    const step = onEffectResult(
      started(),
      turn({
        turnOpCount: 1,
        satisfied: true,
        note: 'Emphasising key words → Set track caption style; already in place',
      }),
    );
    const [operation] = step.state.working.operations;
    expect(operation?.status).toBe('succeeded');
    // A success carries no failure reason — there is nothing that went wrong.
    expect(operation?.failureReason).toBeUndefined();
  });

  it('reaches the model as ALREADY APPLIED, never as FAILED', () => {
    const step = onEffectResult(started(), turn({ turnOpCount: 1, satisfied: true }));
    const briefing = buildStateBriefing(step.state.working);
    expect(briefing).toContain('ALREADY APPLIED');
    expect(briefing).not.toContain('FAILED — fix the cause');
  });

  it('still records a genuinely rejected turn as a failure with its reason', () => {
    const step = onEffectResult(
      started(),
      turn({ turnOpCount: 1, note: 'Rejected "auto_emphasize_captions": unknown track' }),
    );
    const [operation] = step.state.working.operations;
    expect(operation?.status).toBe('failed');
    expect(operation?.failureReason).toContain('unknown track');
    const briefing = buildStateBriefing(step.state.working);
    expect(briefing).toContain('FAILED — fix the cause');
  });

  it('keeps a failure and a later already-satisfied result as separate facts', () => {
    // Same signature, different outcomes. Sharing one idempotency key would let the second
    // overwrite the first in place, erasing the record of what the run actually tried.
    let step = onEffectResult(started(), turn({ turnOpCount: 1, note: 'Rejected: bad args' }));
    step = onEffectResult(step.state, turn({ stepIndex: 2, turnOpCount: 1, satisfied: true }));
    const statuses = step.state.working.operations.map((o) => o.status);
    expect(statuses).toContain('failed');
    expect(statuses).toContain('succeeded');
  });

  it('is not counted as skipped work in the run report', () => {
    // The tally becomes "**Skipped:** N proposed changes did not validate (…)" in the
    // completion report. The captured run told the editor two changes had failed
    // validation; both had validated and were already on the timeline.
    const step = onEffectResult(started(), turn({ turnOpCount: 2, satisfied: true }));
    expect(step.state.rejectedOpCount).toBe(0);
    expect(step.state.rejectionReasons).toHaveLength(0);
  });

  it('still counts a genuine rejection as skipped work, with its reason', () => {
    const step = onEffectResult(
      started(),
      turn({ turnOpCount: 2, note: 'Rejected: overlaps a neighbour' }),
    );
    expect(step.state.rejectedOpCount).toBe(2);
    expect(step.state.rejectionReasons).toContain('Rejected: overlaps a neighbour');
  });
});

describe('a verification whose criterion is just the request echoed back', () => {
  /** A run state carrying one verification against the raw request. */
  const withVerification = (passed: boolean) => {
    const base = onCommand(initialConductorState(stream), command()).state.working;
    return {
      ...base,
      verifications: [
        {
          id: 'verify_1',
          criterion: base.objective.request,
          passed,
          atRevision: base.currentProjectRevision,
          detail: 'All checks passed.',
        },
      ],
    };
  };

  it('does not tell the model its request passed', () => {
    // The observed run recorded "PASS <the whole request> — All checks passed." having
    // called no effect tool at all. Timeline checks cannot verify a compound request.
    const briefing = buildStateBriefing(withVerification(true));
    expect(briefing).toContain('VERIFIED');
    expect(briefing).not.toContain(`PASS ${withVerification(true).objective.request}`);
    expect(briefing).toContain('NOT the request itself');
  });

  it('still reports the deterministic outcome, including a failure', () => {
    expect(buildStateBriefing(withVerification(false))).toMatch(/FAIL the timeline consistency/);
  });

  it('leaves a real, specific criterion exactly as written', () => {
    const base = onCommand(initialConductorState(stream), command()).state.working;
    const briefing = buildStateBriefing({
      ...base,
      verifications: [
        {
          id: 'verify_1',
          criterion: 'every caption cue sits inside its clip',
          passed: true,
          atRevision: base.currentProjectRevision,
          detail: '40 cues checked.',
        },
      ],
    });
    expect(briefing).toContain('PASS every caption cue sits inside its clip — 40 cues checked.');
  });
});
