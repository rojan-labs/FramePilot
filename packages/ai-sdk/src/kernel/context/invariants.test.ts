import { describe, expect, it } from 'vitest';
import {
  type RunWorkingState,
  advanceStage,
  initialWorkingState,
  recordDecision,
  recordObjective,
  setNextAction,
  setObjective,
} from '../working-state.js';
import {
  checkContextInvariants,
  describeUnrecovered,
  ensureContextInvariants,
  recoverWorkingState,
} from './invariants.js';

/** A run that has been interpreted and moved to `inspect` — the ordinary healthy case. */
function healthy(): RunWorkingState {
  let state = initialWorkingState({
    runId: 'run_1',
    request: 'make a 45s reel',
    projectRevision: 2,
  });
  state = setObjective(state, {
    outcome: 'a 45s vertical reel from the interview',
    acceptance: [{ description: 'final duration is 45s ± 2s' }],
  });
  state = advanceStage(state, 'inspect', 1);
  return setNextAction(state, { stage: 'inspect', action: 'read the source duration' });
}

describe('checkContextInvariants', () => {
  it('passes a healthy mid-run state', () => {
    expect(checkContextInvariants(healthy())).toEqual({ ok: true, violations: [] });
  });

  it('does not demand an objective at interpret — that is where one is written', () => {
    const fresh = initialWorkingState({ runId: 'run_1', request: 'make a reel' });
    expect(checkContextInvariants(fresh).ok).toBe(true);
  });

  it('names a missing objective once the run has moved past interpretation', () => {
    let state = initialWorkingState({ runId: 'run_1', request: 'make a reel' });
    state = advanceStage(state, 'inspect', 1);
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'objective',
    );
    expect(violation?.detail).toContain('inspect');
    expect(violation?.recoverable).toBe(true);
  });

  it('treats a missing objective as unrecoverable when the request itself is blank', () => {
    let state = initialWorkingState({ runId: 'run_1', request: '   ' });
    state = advanceStage(state, 'inspect', 1);
    expect(
      checkContextInvariants(state).violations.find((v) => v.invariant === 'objective')
        ?.recoverable,
    ).toBe(false);
  });

  it('names a missing next action, which is what leaves the model nothing to continue', () => {
    const state = { ...healthy(), nextAction: null };
    expect(checkContextInvariants(state).violations.map((v) => v.invariant)).toEqual([
      'next_action',
    ]);
  });

  it('does not demand a next action once the run is complete', () => {
    let state = healthy();
    for (const stage of ['plan', 'apply', 'verify', 'complete'] as const) {
      state = advanceStage(state, stage, 2);
    }
    expect(checkContextInvariants({ ...state, nextAction: null }).ok).toBe(true);
  });

  it('flags an asymmetric identity (one id set, the other missing) once past interpret', () => {
    // A run identity is meant to be all-or-nothing: legacy runs carry neither id, live
    // ones carry both. Exactly one set is a corrupted record, not a legitimate state, and
    // is unrecoverable because there is no way to derive the missing half.
    const state = { ...healthy(), identity: { ...healthy().identity, projectId: 'proj_1' } };
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'identity',
    );
    expect(violation).toMatchObject({ recoverable: false });
  });

  it('flags the identity asymmetry in the other direction too (conversationId set, projectId missing)', () => {
    const state = {
      ...healthy(),
      identity: { ...healthy().identity, conversationId: 'conv_1' },
    };
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'identity',
    );
    expect(violation).toMatchObject({ recoverable: false });
  });

  it('does not demand identity symmetry at interpret, before either id would be set', () => {
    const fresh = initialWorkingState({ runId: 'run_1', request: 'make a reel', projectId: 'p1' });
    expect(checkContextInvariants(fresh).violations.some((v) => v.invariant === 'identity')).toBe(
      false,
    );
  });

  it('catches a revision that regressed behind the run base', () => {
    const state = { ...healthy(), currentProjectRevision: 1 };
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'project_revision',
    );
    expect(violation?.detail).toContain('behind');
  });

  it('refuses to call an executing run with nothing committed recoverable', () => {
    let state = healthy();
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'committed_work',
    );
    expect(violation).toMatchObject({ recoverable: false });
  });

  it('still flags committed_work when the plan says "committed" but never recorded an id', () => {
    // A plan record that claims `committed` status without a plan id is exactly as
    // untrustworthy as one that was never committed at all — the check must not treat
    // "status says committed" alone as proof there is a real, addressable plan.
    let state = healthy();
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    state = { ...state, plan: { ...state.plan, status: 'committed', id: null } };
    const violation = checkContextInvariants(state).violations.find(
      (v) => v.invariant === 'committed_work',
    );
    expect(violation).toMatchObject({ recoverable: false });
  });

  it('accepts an executing run that has an objective recorded', () => {
    let state = healthy();
    state = recordObjective(state, { description: 'cut to 45s', stage: 'apply' });
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    expect(
      checkContextInvariants(state).violations.some((v) => v.invariant === 'committed_work'),
    ).toBe(false);
  });

  it('accepts an executing run that has a committed decision', () => {
    let state = healthy();
    state = recordDecision(state, {
      decision: 'use 00:42–01:12 of the music',
      reconsiderIf: 'music_asset_changed',
      committed: true,
    });
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    expect(
      checkContextInvariants(state).violations.some((v) => v.invariant === 'committed_work'),
    ).toBe(false);
  });
});

describe('recoverWorkingState', () => {
  it('falls back to the creator’s own request rather than sending no objective', () => {
    let state = initialWorkingState({ runId: 'run_1', request: 'make a 45s reel' });
    state = advanceStage(state, 'inspect', 1);
    const outcome = ensureContextInvariants(state);
    expect(outcome.recovered).toContain('objective');
    expect(outcome.state.objective.outcome).toBe('make a 45s reel');
  });

  it('never invents acceptance criteria while recovering an objective', () => {
    let state = initialWorkingState({ runId: 'run_1', request: 'make a 45s reel' });
    state = advanceStage(state, 'inspect', 1);
    expect(ensureContextInvariants(state).state.objective.acceptance).toEqual([]);
  });

  it('derives the next action from the outstanding objective when one exists', () => {
    let state = healthy();
    state = recordObjective(state, { description: 'trim the dead air', stage: 'inspect' });
    const outcome = ensureContextInvariants({ ...state, nextAction: null });
    expect(outcome.state.nextAction?.action).toBe('Continue inspect: trim the dead air');
  });

  it('falls back to a stage-appropriate instruction when nothing is outstanding', () => {
    const outcome = ensureContextInvariants({ ...healthy(), nextAction: null });
    expect(outcome.state.nextAction).toMatchObject({
      stage: 'inspect',
      action: 'Continue inspect: read only what the objective still needs.',
    });
  });

  it('gives every mid-run stage a recoverable instruction', () => {
    const stages = ['analyze', 'plan', 'apply', 'enhance', 'verify', 'repair'] as const;
    for (const stage of stages) {
      const outcome = ensureContextInvariants({ ...healthy(), stage, nextAction: null });
      expect(outcome.state.nextAction?.action).toMatch(/^Continue /);
      expect(outcome.unrecovered.filter((v) => v.invariant === 'next_action')).toEqual([]);
    }
  });

  it('clamps a regressed revision back to the run base', () => {
    const outcome = ensureContextInvariants({ ...healthy(), currentProjectRevision: 0 });
    expect(outcome.state.currentProjectRevision).toBe(2);
    expect(outcome.recovered).toContain('project_revision');
  });

  it('reports an unrecoverable violation instead of fabricating a plan', () => {
    let state = healthy();
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    const outcome = ensureContextInvariants(state);
    expect(outcome.unrecovered.map((v) => v.invariant)).toContain('committed_work');
    expect(outcome.state.decisions).toEqual([]);
    expect(outcome.state.objectives).toEqual([]);
  });

  it('leaves a healthy state untouched and reports nothing recovered', () => {
    const state = healthy();
    const outcome = ensureContextInvariants(state);
    expect(outcome.state).toBe(state);
    expect(outcome.recovered).toEqual([]);
    expect(outcome.unrecovered).toEqual([]);
  });

  it('bumps the memory version on every repair, so a repair cannot masquerade as no-op', () => {
    const before = { ...healthy(), nextAction: null, currentProjectRevision: 0 };
    const outcome = ensureContextInvariants(before);
    expect(outcome.state.version).toBeGreaterThan(before.version);
  });

  it('does not mutate the state it was given', () => {
    const before = { ...healthy(), nextAction: null };
    ensureContextInvariants(before);
    expect(before.nextAction).toBeNull();
  });

  it('applies recovery only for violations it was handed', () => {
    const state = { ...healthy(), nextAction: null };
    const outcome = recoverWorkingState(state, { ok: true, violations: [] });
    expect(outcome.state.nextAction).toBeNull();
    expect(outcome.recovered).toEqual([]);
  });
});

describe('describeUnrecovered', () => {
  it('names what specifically could not be confirmed', () => {
    let state = healthy();
    state = advanceStage(state, 'plan', 2);
    state = advanceStage(state, 'apply', 3);
    const line = describeUnrecovered(ensureContextInvariants(state).unrecovered);
    expect(line).toContain('no committed decision or objective');
    expect(line).not.toMatch(/undefined|\[object/);
  });
});
