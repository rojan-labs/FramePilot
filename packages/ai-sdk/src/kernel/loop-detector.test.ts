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
  catalogueSearchRefusal,
  isSemanticLoop,
  madeMeaningfulProgress,
  normalizeIntent,
  recoveryAction,
  shouldWithholdCatalogueSearch,
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

  // GAP-009. Recovery fires because the run is not progressing, and the objective it is
  // handed is usually the request said back. "Do this now: [everything you were asked
  // for]" is the least useful thing this heading can say, and in a captured run it was
  // 10,000 tokens of it, in a state persisted and streamed on every turn.
  it('names the act, not the request, when the objective is only the request', () => {
    const request = 'cut to 60s';
    const state = recordObjective(base(), { description: request, stage: 'apply' });
    const action = recoveryAction(state)!;
    expect(action.action).not.toContain(request);
    expect(action.action).toMatch(/Make the next edit the request calls for/);
    expect(action.objectiveId).toBe('objective_1');
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

describe('shouldWithholdCatalogueSearch (02 — the commit-only latch)', () => {
  it('never engages before a search has landed', () => {
    // ADR 0147's exact case: on an empty project there is no remoteId to add BY, and the
    // only thing that mints one is the search this would refuse. Withholding here is what
    // left run f1d5285e with no legal move at all.
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 0, placementsApplied: 0 })).toBe(false);
  });

  it('engages once results are banked and nothing has been placed', () => {
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 1, placementsApplied: 0 })).toBe(true);
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 19, placementsApplied: 0 })).toBe(true);
  });

  it('releases on the first placement and stays released', () => {
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 19, placementsApplied: 1 })).toBe(false);
    expect(shouldWithholdCatalogueSearch({ bankedSearches: 99, placementsApplied: 50 })).toBe(
      false,
    );
  });

  it('names a way out rather than only saying no', () => {
    const refusal = catalogueSearchRefusal(19);
    expect(refusal).toContain('19 search result(s)');
    expect(refusal).toContain('recall_evidence');
    // `ask_user` must not be offered: no askUser host is wired, so naming it would
    // advertise an escape that does not exist.
    expect(refusal).not.toContain('ask_user');
  });
});

describe('novelty alone stays progress here — the bound lives elsewhere', () => {
  const base = {
    learnedSomethingNew: false,
    attemptedEdit: false,
    appliedEdit: false,
    recordedVerification: false,
    advancedStage: false,
    committedDecision: false,
    satisfiedObjective: false,
  };

  it('credits a turn that learned something, however many came before it', () => {
    // An earlier pass capped this, and the cap silently pre-empted RESEARCH_BUDGET_TURNS
    // and the diminishing-returns guard — so runs stopped for a reason that was no longer
    // the true one. The bound on gathering belongs to the research budget, which is tuned
    // and tested; this test exists to keep a second one from growing back here.
    expect(madeMeaningfulProgress({ ...base, learnedSomethingNew: true })).toBe(true);
  });

  it('credits every stronger signal on its own', () => {
    expect(madeMeaningfulProgress({ ...base, attemptedEdit: true })).toBe(true);
    expect(madeMeaningfulProgress({ ...base, appliedEdit: true })).toBe(true);
    expect(madeMeaningfulProgress({ ...base, advancedStage: true })).toBe(true);
    expect(madeMeaningfulProgress({ ...base, committedDecision: true })).toBe(true);
    expect(madeMeaningfulProgress({ ...base, recordedVerification: true })).toBe(true);
    expect(madeMeaningfulProgress({ ...base, satisfiedObjective: true })).toBe(true);
  });

  it('credits nothing to a turn that did nothing', () => {
    expect(madeMeaningfulProgress(base)).toBe(false);
  });
});
