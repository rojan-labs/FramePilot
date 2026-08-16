/**
 * Tests for semantic loop detection, meaningful progress, and recovery
 * (plan/AGENT-TASK-MEMORY.md §3.5, ADR 0075).
 *
 * The headline case is the reported run: four turns, four different sentences, one
 * intent, nothing achieved. The intent vocabulary exists to make those four turns compare
 * equal, so that is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_NO_PROGRESS_TURNS,
  SEMANTIC_LOOP_TURNS,
  isSemanticLoop,
  madeMeaningfulProgress,
  normalizeIntent,
  recoveryAction,
  type TurnProgress,
} from './loop-detector.js';
import {
  advanceStage,
  initialWorkingState,
  recordObjective,
  recordOperation,
  type RunWorkingState,
} from './working-state.js';

const noProgress: TurnProgress = {
  learnedSomethingNew: false,
  attemptedEdit: false,
  appliedEdit: false,
  recordedVerification: false,
  advancedStage: false,
  committedDecision: false,
  satisfiedObjective: false,
};

describe('normalizeIntent', () => {
  it("collapses the reported run's four sentences into one intent", () => {
    // These are the actual phrasings from the run that looped. If they do not compare
    // equal, nothing downstream can notice the repetition.
    const phrasings = [
      'Let me orient myself.',
      'Let me get the full picture.',
      'Let me first understand the project.',
      'Let me start by understanding the project before editing.',
    ];
    expect(phrasings.map(normalizeIntent)).toEqual(['orient', 'orient', 'orient', 'orient']);
  });

  it('reads the other purposes', () => {
    expect(normalizeIntent('Let me read the transcript for that section.')).toBe('analyze');
    expect(normalizeIntent('Now I need to plan the cuts.')).toBe('plan');
    expect(normalizeIntent('Cutting the dead air on Video 1.')).toBe('execute');
    expect(normalizeIntent('Let me verify the new duration.')).toBe('verify');
    expect(normalizeIntent('Done — here is a summary.')).toBe('report');
  });

  it('is case-insensitive', () => {
    expect(normalizeIntent('LET ME ORIENT MYSELF')).toBe('orient');
  });

  it('reads unrecognised or empty prose as unknown rather than guessing', () => {
    expect(normalizeIntent('')).toBe('unknown');
    expect(normalizeIntent('   ')).toBe('unknown');
    expect(normalizeIntent('The weather is pleasant today.')).toBe('unknown');
  });
});

describe('isSemanticLoop', () => {
  const orienting = Array.from({ length: SEMANTIC_LOOP_TURNS }, () => 'orient' as const);

  it('fires on consecutive turns with one intent and nothing to show for them', () => {
    expect(isSemanticLoop(orienting, { stageAdvanced: false, decisionCommitted: false })).toBe(
      true,
    );
  });

  it('does not fire while the run is still advancing', () => {
    // Three turns of cutting are three turns of cutting, not a loop.
    expect(isSemanticLoop(orienting, { stageAdvanced: true, decisionCommitted: false })).toBe(
      false,
    );
    expect(isSemanticLoop(orienting, { stageAdvanced: false, decisionCommitted: true })).toBe(
      false,
    );
  });

  it('needs a full window before it will call anything a loop', () => {
    expect(
      isSemanticLoop(['orient', 'orient'], { stageAdvanced: false, decisionCommitted: false }),
    ).toBe(false);
  });

  it('does not fire on mixed intents', () => {
    expect(
      isSemanticLoop(['orient', 'analyze', 'orient'], {
        stageAdvanced: false,
        decisionCommitted: false,
      }),
    ).toBe(false);
  });

  it('never builds a loop out of prose it could not read', () => {
    const unknowns = Array.from({ length: SEMANTIC_LOOP_TURNS }, () => 'unknown' as const);
    expect(isSemanticLoop(unknowns, { stageAdvanced: false, decisionCommitted: false })).toBe(
      false,
    );
  });

  it('reads only the most recent window', () => {
    expect(
      isSemanticLoop(['analyze', 'orient', 'orient', 'orient'], {
        stageAdvanced: false,
        decisionCommitted: false,
      }),
    ).toBe(true);
  });
});

describe('madeMeaningfulProgress', () => {
  it('counts every way a run can actually move', () => {
    for (const key of Object.keys(noProgress) as (keyof TurnProgress)[]) {
      expect(madeMeaningfulProgress({ ...noProgress, [key]: true })).toBe(true);
    }
  });

  it('counts nothing when the turn only produced words', () => {
    // Reasoning text, stream events, restated summaries and memo hits are a run
    // describing itself — 3,430 of them left the timeline untouched.
    expect(madeMeaningfulProgress(noProgress)).toBe(false);
  });

  it('has a tighter tolerance than the older stall guard', () => {
    expect(MAX_NO_PROGRESS_TURNS).toBeLessThan(SEMANTIC_LOOP_TURNS);
  });
});

describe('recoveryAction — an action, never a plan', () => {
  const base = (): RunWorkingState =>
    initialWorkingState({ runId: 'run_1', request: 'cut to 60s', projectRevision: 0 });

  it('names the first outstanding objective', () => {
    let state = recordObjective(base(), { description: 'cut to 90s', stage: 'apply' });
    state = recordObjective(state, { description: 'add captions', stage: 'enhance' });
    const action = recoveryAction(state)!;
    expect(action.action).toContain('cut to 90s');
    expect(action.objectiveId).toBe('objective_1');
    expect(action.stage).toBe('apply');
  });

  it('names an unresolved failure when nothing is enumerated', () => {
    const state = recordOperation(base(), {
      intent: 'ripple_delete 2:10–3:40',
      status: 'failed',
      failureReason: 'overlaps clip_b',
    });
    const action = recoveryAction(state)!;
    expect(action.action).toContain('ripple_delete 2:10–3:40');
    expect(action.action).toContain('overlaps clip_b');
  });

  it('keeps a failure recovery in the stage the run is already executing in', () => {
    const executing = advanceStage(
      ['inspect', 'analyze', 'plan', 'apply', 'enhance'].reduce(
        (s, next) => advanceStage(s, next as never, 1),
        base(),
      ),
      'verify',
      6,
    );
    const state = recordOperation(
      { ...executing, stage: 'enhance' },
      {
        intent: 'add caption track',
        status: 'failed',
      },
    );
    expect(recoveryAction(state)!.stage).toBe('enhance');
  });

  it('falls back to making the edit at all when the run has applied nothing', () => {
    const action = recoveryAction(base())!;
    expect(action.stage).toBe('apply');
    expect(action.action).toContain('Make the edit the creator asked for');
  });

  it('returns nothing when the run genuinely has nothing left to do', () => {
    // Applied, no outstanding objectives, no failures — the caller must report honestly
    // rather than invent work.
    const state = recordOperation(base(), { intent: 'cut', status: 'succeeded', patchId: 'p' });
    expect(recoveryAction(state)).toBeNull();
  });
});
