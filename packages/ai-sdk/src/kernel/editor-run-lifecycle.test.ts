import { describe, expect, it } from 'vitest';
import {
  EDITOR_RUN_ROUTE_POLICY,
  EDITOR_RUN_STAGES,
  createEditorRunLifecycle,
  parseEditorRunStageEvent,
  reduceEditorRunStageEvent,
  type EditorRunLifecycleState,
  type EditorRunRoute,
  type EditorRunStage,
  type EditorRunStageEvent,
} from './editor-run-lifecycle.js';

function event(
  state: EditorRunLifecycleState,
  stage: EditorRunStage,
  status: EditorRunStageEvent['state'],
  reason?: string,
): EditorRunStageEvent {
  return parseEditorRunStageEvent({
    schemaVersion: 1,
    runId: state.runId,
    route: state.route,
    sequence: state.sequence + 1,
    stage,
    state: status,
    occurredAt: 1000 + state.sequence,
    attempt:
      state.activeStage === 'repair'
        ? state.repairAttempt
        : Math.max(1, state.repairAttempt + 1),
    evidence: [],
    ...(reason ? { reason } : {}),
  });
}

function settle(
  state: EditorRunLifecycleState,
  stage: EditorRunStage,
): EditorRunLifecycleState {
  const entered = reduceEditorRunStageEvent(state, event(state, stage, 'entered'));
  return reduceEditorRunStageEvent(entered, event(entered, stage, 'completed'));
}

describe('EditorRun lifecycle', () => {
  it('defines the one ordered professional editing vocabulary', () => {
    expect(EDITOR_RUN_STAGES).toEqual([
      'understand',
      'resolve',
      'inspect',
      'plan',
      'compile',
      'execute',
      'verify',
      'review',
      'repair',
      'finalize',
    ]);
  });

  it.each(['edit', 'agent'] as const)(
    'gives %s an explicit disposition for every stage',
    (route: EditorRunRoute) => {
      expect(Object.keys(EDITOR_RUN_ROUTE_POLICY[route])).toEqual(EDITOR_RUN_STAGES);
      expect(EDITOR_RUN_ROUTE_POLICY[route].finalize).toBe('required');
    },
  );

  it('runs the straight-through lifecycle to one terminal finalize', () => {
    let state = createEditorRunLifecycle('run_1', 'agent');
    for (const stage of EDITOR_RUN_STAGES.filter((candidate) => candidate !== 'repair')) {
      state = settle(state, stage);
    }
    expect(state).toMatchObject({
      terminal: true,
      completedStages: EDITOR_RUN_STAGES.filter((stage) => stage !== 'repair'),
    });
    expect(state.activeStage).toBeUndefined();
    expect(() => settle(state, 'repair')).toThrow('finalized');
  });

  it('allows bounded repair to re-enter resolution/compile but forbids arbitrary rewind', () => {
    let state = createEditorRunLifecycle('run_2', 'agent');
    for (const stage of ['understand', 'resolve', 'inspect', 'plan', 'compile', 'execute', 'verify', 'review'] as const) {
      state = settle(state, stage);
    }
    state = settle(state, 'repair');
    state = settle(state, 'resolve');
    state = settle(state, 'compile');
    expect(state.repairAttempt).toBe(1);
    expect(() => settle(state, 'understand')).toThrow('Illegal EditorRun transition');
  });

  it('rejects gaps in event sequence, settling inactive stages, and failures without reasons', () => {
    const initial = createEditorRunLifecycle('run_3', 'edit');
    expect(() =>
      reduceEditorRunStageEvent(initial, { ...event(initial, 'understand', 'entered'), sequence: 2 }),
    ).toThrow('sequence');
    expect(() => reduceEditorRunStageEvent(initial, event(initial, 'understand', 'completed'))).toThrow(
      'inactive',
    );
    expect(() => event(initial, 'understand', 'failed')).toThrow('requires a reason');
    expect(() => event(initial, 'understand', 'cancelled')).toThrow('requires a reason');
  });

  it('records cancellation as a terminal stage outcome', () => {
    const initial = createEditorRunLifecycle('run_cancel', 'agent');
    const entered = reduceEditorRunStageEvent(initial, event(initial, 'understand', 'entered'));
    const cancelled = reduceEditorRunStageEvent(
      entered,
      event(entered, 'understand', 'cancelled', 'user stopped'),
    );

    expect(cancelled).toMatchObject({ terminal: true, completedStages: [] });
    expect(cancelled.activeStage).toBeUndefined();
  });
});
