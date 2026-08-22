/**
 * Tests for distillation and the state briefing (plan/AGENT-TASK-MEMORY.md §3.3/§3.4).
 *
 * The briefing is the model's memory of its own run, so what it must NOT contain matters
 * as much as what it must: no payloads (they belong in the evidence store), and no
 * restatements of things already recorded.
 */
import { describe, expect, it } from 'vitest';
import { buildStateBriefing, distil } from './briefing.js';
import {
  advanceStage,
  commitDecision,
  initialWorkingState,
  recordDecision,
  recordFact,
  recordObjective,
  recordOperation,
  recordVerification,
  setBlocker,
  commitExecutionPlan,
  setNextAction,
  setObjective,
  type RunWorkingState,
} from './working-state.js';

const settled = {
  toolName: 'get_transcript',
  role: 'analysis' as const,
  descriptor: 'Reading the transcript 0:22–0:23',
  summary: '8 words',
  scope: 'revision_independent' as const,
  status: 'completed',
  fromCache: false,
  evidenceId: 'ev_3',
};

describe('distil', () => {
  it('turns a settled read into a conclusion that cites its evidence', () => {
    expect(distil(settled)).toEqual({
      statement: 'Reading the transcript 0:22–0:23 → 8 words',
      kind: 'transcript',
      scope: 'revision_independent',
      evidenceId: 'ev_3',
    });
  });

  it('records the digest\'s conclusion, not the rest of its records', () => {
    // A read digest is a head line plus its records. The head line is the conclusion; the
    // records belong in the evidence store, and flattening them into a 180-character fact
    // would put four of forty-six clips in the briefing and call it what the run knows.
    const digest = [
      '5 tracks, 87 clips: fx(0), captions(40), audio(1), music(0), video_main(46)',
      'video_main [video]:',
      '- v_0 asset=asset_x 0–0.47s',
      '- v_1 asset=asset_x 0.47–0.94s',
    ].join('\n');
    const out = distil({ ...settled, toolName: 'get_timeline', summary: digest });
    expect(out?.statement).toBe(
      'Reading the transcript 0:22–0:23 → 5 tracks, 87 clips: fx(0), captions(40), audio(1), music(0), video_main(46)',
    );
    expect(out?.statement).not.toContain('v_0');
  });

  it('concludes nothing when the finding only restates the label', () => {
    // Every in-process read reported its DESCRIPTOR as its summary, so the fact read
    // "Reading the timeline → Reading the timeline". A run's entire memory of what it had
    // learned was a list of restatements of what it had done — which is why a real
    // montage run re-derived the project's shape on six consecutive turns, re-read the
    // media bin, and spent 391 seconds in one thinking block. An absent fact at least
    // shows the gap.
    expect(
      distil({ ...settled, summary: 'Reading the transcript 0:22–0:23' }),
    ).toBeUndefined();
    expect(distil({ ...settled, summary: '   ' })).toBeUndefined();
  });

  it('concludes nothing from a memo hit — it was recorded the first time', () => {
    expect(distil({ ...settled, fromCache: true })).toBeUndefined();
  });

  it('concludes nothing from a failure — there is no finding', () => {
    expect(distil({ ...settled, status: 'failed' })).toBeUndefined();
  });

  it('concludes nothing from a recall, a mutation, or an unclassified tool', () => {
    expect(distil({ ...settled, role: 'recall' })).toBeUndefined();
    expect(distil({ ...settled, role: 'mutation' })).toBeUndefined();
    expect(distil({ ...settled, role: 'other' })).toBeUndefined();
  });

  it('keeps a statement to one line, however large the payload', () => {
    const statement = distil({ ...settled, summary: 'x'.repeat(5_000) })!.statement;
    expect(statement.length).toBeLessThanOrEqual(180);
    expect(statement).not.toContain('\n');
  });

  it('classifies the kind of knowledge from the tool', () => {
    expect(distil({ ...settled, toolName: 'get_timeline', role: 'inspection' })!.kind).toBe(
      'project',
    );
    expect(distil({ ...settled, toolName: 'list_assets', role: 'inspection' })!.kind).toBe('asset');
    expect(distil({ ...settled, toolName: 'analyze_silence' })!.kind).toBe('audio');
    expect(distil({ ...settled, toolName: 'map_footage' })!.kind).toBe('footage');
    expect(distil({ ...settled, toolName: 'load_skill', role: 'guidance' })!.kind).toBe('derived');
  });

  it('accepts a warning as a finding — a partial result is still something learned', () => {
    expect(distil({ ...settled, status: 'warning' })).toBeDefined();
  });

  it('omits the citation when there is no handle', () => {
    const { evidenceId: _drop, ...noHandle } = settled;
    expect(distil(noHandle)).not.toHaveProperty('evidenceId');
  });
});

describe('buildStateBriefing', () => {
  const base = (): RunWorkingState =>
    initialWorkingState({ runId: 'run_1', request: 'cut to 60s', projectRevision: 0 });

  it('says nothing at all on a run that has established nothing', () => {
    // An empty scaffold of headings would only teach the model the section is noise.
    expect(buildStateBriefing(base())).toBe('');
  });

  it('leads with the instruction to continue, not restart', () => {
    const state = recordFact(base(), {
      kind: 'transcript',
      statement: 'Read 0:22–0:23 → 8 words',
      scope: 'revision_independent',
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('already in progress');
    expect(text).toContain('do not restart');
  });

  it('does not print the editor\'s request back under four different headings', () => {
    // The conductor seeds objective, acceptance, the committed plan's decision and the
    // run's objective ALL from the raw prompt before any turn runs. Rendered naively, the
    // briefing said the same sentence five times — and "DECIDED" listing the request tells
    // the model something was decided when nothing was, while "OBJECTIVES 0/1" restates
    // the request as a checkbox no tool can tick.
    const request = 'cut to 60s';
    let state = initialWorkingState({ runId: 'run_1', request, projectRevision: 0 });
    state = setObjective(state, { outcome: request, acceptance: [{ description: request }] });
    state = commitExecutionPlan(state, [request], 0);
    state = recordFact(state, {
      kind: 'project',
      statement: 'Reading the timeline → 5 tracks, 87 clips',
      scope: 'timeline_dependent',
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('5 tracks, 87 clips');
    expect(text).not.toContain('WHAT DONE LOOKS LIKE');
    expect(text).not.toContain('DECIDED');
    expect(text).not.toContain('OBJECTIVES');
    // One mention of the request in the whole briefing is one too many: the request is
    // already its own section of the prompt.
    expect(text).not.toContain(request);
  });

  it('still shows an objective and a decision that say something of their own', () => {
    let state = initialWorkingState({ runId: 'run_1', request: 'cut to 60s', projectRevision: 0 });
    state = setObjective(state, {
      outcome: 'A 60s cut whose hook lands in the first 3 seconds',
      acceptance: [{ description: 'Runtime is 60s ± 1s' }],
    });
    state = commitExecutionPlan(state, ['Move the hook to the top'], 0);
    const text = buildStateBriefing(state);
    expect(text).toContain('WHAT DONE LOOKS LIKE');
    expect(text).toContain('hook lands in the first 3 seconds');
    expect(text).toContain('Runtime is 60s ± 1s');
    expect(text).toContain('DECIDED');
    expect(text).toContain('Move the hook to the top');
  });

  it('shows established facts with their handles, so any claim can be checked', () => {
    const state = recordFact(base(), {
      kind: 'transcript',
      statement: 'Hook lands at 0:12',
      scope: 'revision_independent',
      evidenceIds: ['ev_1', 'ev_2'],
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('ESTABLISHED — do not gather again');
    expect(text).toContain('Hook lands at 0:12 [ev_1, ev_2]');
  });

  it('shows committed decisions with the trigger that would reopen them', () => {
    let state = recordDecision(base(), {
      decision: 'Keep 0:12–0:26, 1:48–2:03',
      reconsiderIf: 'the transcript shows a stronger hook',
    });
    state = commitDecision(state, 'decision_1');
    const text = buildStateBriefing(state);
    expect(text).toContain('Keep 0:12–0:26, 1:48–2:03');
    expect(text).toContain('revisit only if: the transcript shows a stronger hook');
  });

  it('hides a decision that is still tentative', () => {
    const state = recordDecision(base(), { decision: 'maybe', reconsiderIf: 'x' });
    expect(buildStateBriefing(state)).not.toContain('maybe');
  });

  it('separates what applied from what failed, and says not to retry unchanged', () => {
    let state = recordOperation(base(), {
      intent: 'ripple_delete 2:10–3:40',
      status: 'succeeded',
      patchId: 'p1',
    });
    state = recordOperation(state, {
      intent: 'add_clip over clip_b',
      status: 'failed',
      failureReason: 'overlaps clip_b',
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('ALREADY APPLIED — do not repeat');
    expect(text).toContain('ripple_delete 2:10–3:40');
    expect(text).toContain('FAILED — fix the cause, do not retry unchanged');
    expect(text).toContain('overlaps clip_b');
  });

  it('reports a failure with no recorded reason honestly', () => {
    const state = recordOperation(base(), { intent: 'x', status: 'failed' });
    expect(buildStateBriefing(state)).toContain('no reason recorded');
  });

  it('shows the stage, the stages behind it, and where the run stands on its objectives', () => {
    let state = advanceStage(base(), 'inspect', 1);
    state = advanceStage(state, 'analyze', 2);
    state = recordObjective(state, { description: 'cut to 90s', stage: 'apply' });
    state = recordObjective(state, { description: 'add captions', stage: 'enhance' });
    state = recordVerification(state, {
      criterion: 'duration ≤ 90s',
      passed: true,
      objectiveId: 'objective_1',
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('You are at "analyze"');
    expect(text).toContain('finished: interpret → inspect');
    expect(text).toContain('OBJECTIVES (1/2 satisfied)');
    expect(text).toContain('[x] cut to 90s');
    expect(text).toContain('[ ] add captions');
    expect(text).toContain('PASS duration ≤ 90s');
  });

  it('reports a failed verification as a failure', () => {
    const state = recordVerification(base(), {
      criterion: 'duration ≤ 90s',
      passed: false,
      detail: 'still 4:10',
    });
    expect(buildStateBriefing(state)).toContain('FAIL duration ≤ 90s — still 4:10');
  });

  it('states what done looks like once the run has interpreted the request', () => {
    const state = setObjective(base(), {
      outcome: '≤90s vertical cut, captioned',
      acceptance: [{ description: 'duration between 60 and 90 seconds' }],
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('WHAT DONE LOOKS LIKE');
    expect(text).toContain('≤90s vertical cut, captioned');
    expect(text).toContain('duration between 60 and 90 seconds');
  });

  it('states an outcome with no criteria without inventing any', () => {
    const state = setObjective(base(), { outcome: 'tighten the intro', acceptance: [] });
    expect(buildStateBriefing(state)).toContain('tighten the intro');
  });

  it('surfaces the blocker and the next action as imperatives', () => {
    let state = setBlocker(base(), {
      reason: 'no caption track exists',
      missing: 'a caption track',
      atStage: 'enhance',
    });
    state = setNextAction(state, {
      stage: 'apply',
      action: 'Apply the three ripple deletes',
      toolHint: 'ripple_delete',
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('BLOCKED');
    expect(text).toContain('missing: a caption track');
    expect(text).toContain('DO THIS NOW');
    expect(text).toContain('Apply the three ripple deletes (use ripple_delete)');
  });

  it('omits the hint and the missing clause when neither was recorded', () => {
    let state = setBlocker(base(), { reason: 'sidecar offline', atStage: 'analyze' });
    state = setNextAction(state, { stage: 'apply', action: 'Apply the cut' });
    const text = buildStateBriefing(state);
    expect(text).toContain('sidecar offline');
    expect(text).not.toContain('missing:');
    expect(text).toContain('DO THIS NOW\nApply the cut');
  });

  it('stays flat as evidence grows — conclusions, never payloads', () => {
    // Twenty reads of a long transcript add twenty short lines, not twenty transcripts.
    let state = base();
    for (let i = 0; i < 20; i += 1) {
      state = recordFact(state, {
        kind: 'transcript',
        statement: `Read window ${i} → 40 words`,
        scope: 'revision_independent',
        evidenceIds: [`ev_${i}`],
      });
    }
    expect(buildStateBriefing(state).length).toBeLessThan(2_000);
  });
});
