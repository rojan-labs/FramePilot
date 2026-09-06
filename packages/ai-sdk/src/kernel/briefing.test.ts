/**
 * Tests for distillation and the state briefing (plan/AGENT-TASK-MEMORY.md §3.3/§3.4).
 *
 * The briefing is the model's memory of its own run, so what it must NOT contain matters
 * as much as what it must: no payloads (they belong in the evidence store), and no
 * restatements of things already recorded.
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../context-builder.js';
import { buildStateBriefing, distil } from './briefing.js';
import {
  advanceStage,
  commitDecision,
  REQUEST_ECHO_CHARS,
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
      // The handle travels with the conclusion so the reducer can index it. Without this
      // the working state's `evidence` array stayed empty in every run while its facts
      // cited handles it did not contain.
      evidence: {
        id: 'ev_3',
        source: 'get_transcript',
        descriptor: 'Reading the transcript 0:22–0:23',
        scope: 'revision_independent',
      },
    });
  });

  it("records the digest's conclusion, not the rest of its records", () => {
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
    expect(distil({ ...settled, summary: 'Reading the transcript 0:22–0:23' })).toBeUndefined();
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

  it("does not print the editor's request back under four different headings", () => {
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
    // Every acceptance criterion here IS the request, so the section has nothing to say.
    expect(text).not.toContain('WHAT DONE LOOKS LIKE');
    expect(text).not.toContain('DECIDED');
    expect(text).not.toContain('OBJECTIVES');
    // One mention of the request in the whole briefing is one too many: the request is
    // already its own section of the prompt.
    expect(text).not.toContain(request);
  });

  // GAP-001 (run `fc10301a`). The suppression above is about the request said back, and
  // nothing else. A criterion the Critic will actually settle the run against is not the
  // request said back — it is the only statement of what "done" means that the model ever
  // gets, and it was being dropped alongside the echoes because the section hung on the
  // outcome rather than on its own contents.
  // GAP-014 (run `fc10301a`). The duration and picture-coverage checks are pure and
  // render-free — `checkPictureCoverage`'s own docstring says it "can be consulted BEFORE
  // a run is allowed to call itself complete". Nothing consulted it. That run laid a
  // 47.8-second bed on turn five against a 27.5-second target, which decided both of its
  // terminal failures, and learned about neither for seventeen turns.
  it('shows where the cut stands against its target, while the run can still act', () => {
    const state = initialWorkingState({
      runId: 'run_1',
      request: 'a 30s reel',
      projectRevision: 0,
    });
    const text = buildStateBriefing(state, [
      'Timeline is 47.8s but the target is 27.5s (off by 20.3s).',
      '23.7s of the 47.8s programme has no picture under it — that renders as black.',
    ]);
    expect(text).toContain('WHERE YOU STAND');
    expect(text).toContain('off by 20.3s');
    expect(text).toContain('renders as black');
  });

  it('says nothing about where it stands when every condition is met', () => {
    const state = initialWorkingState({
      runId: 'run_1',
      request: 'a 30s reel',
      projectRevision: 0,
    });
    expect(buildStateBriefing(state, [])).not.toContain('WHERE YOU STAND');
  });

  it('shows checkable acceptance criteria even when the outcome is only the request echoed', () => {
    const request = 'Turn my 61 hiking photos into a 20-35 second beat-synced reel';
    let state = initialWorkingState({ runId: 'run_1', request, projectRevision: 0 });
    state = setObjective(state, {
      outcome: request,
      acceptance: [
        { description: request },
        { description: 'The finished sequence runs about 27.5s.' },
        { description: 'The cut uses at least 61 distinct shots.' },
      ],
      provisional: true,
    });
    const text = buildStateBriefing(state);
    expect(text).toContain('WHAT DONE LOOKS LIKE');
    expect(text).toContain('The finished sequence runs about 27.5s.');
    expect(text).toContain('The cut uses at least 61 distinct shots.');
    // The echo is still filtered — per criterion, which is where the filter belongs.
    expect(text).not.toContain(request);
  });

  // GAP-009. The same four copies, sized. A 10,000-token brief was stored whole in the
  // objective, its decision, its objective entry and the recovery instruction — a state
  // that is persisted and streamed to the host on every turn.
  it('stores a long request as an excerpt, and still prints none of it', () => {
    const request = `Make a reel about ${'the unit conversion error '.repeat(400)}`;
    let state = initialWorkingState({ runId: 'run_1', request, projectRevision: 0 });
    state = setObjective(state, {
      outcome: request,
      acceptance: [{ description: 'Runtime is 30s ± 2s' }],
      provisional: true,
    });
    state = commitExecutionPlan(state, [request], 0);

    // One full copy survives — the request itself, which is what it is for.
    expect(state.objective.request).toBe(request.trim());
    expect(state.objective.outcome.length).toBeLessThanOrEqual(REQUEST_ECHO_CHARS + 1);
    expect(state.objectives[0]!.description.length).toBeLessThanOrEqual(REQUEST_ECHO_CHARS + 1);
    expect(state.decisions[0]!.decision.length).toBeLessThanOrEqual(REQUEST_ECHO_CHARS + 1);
    // Shortening must not defeat the suppression: an excerpt says exactly as little.
    const text = buildStateBriefing(
      recordFact(state, {
        kind: 'project',
        statement: 'Reading the timeline → 0 tracks',
        scope: 'timeline_dependent',
      }),
    );
    // The real criterion survives (GAP-001); the 10,000-token request does not.
    expect(text).toContain('WHAT DONE LOOKS LIKE');
    expect(text).toContain('Runtime is 30s ± 2s');
    expect(text).not.toContain('OBJECTIVES');
    expect(text).not.toContain('DECIDED');
    expect(text).not.toContain('unit conversion error');
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

  it('groups failures that share one reason instead of printing the reason per call', () => {
    // Run `cc907070`: eleven ledger rows refused for one sentence, printed eleven times per
    // turn. One row per reason, naming the calls; a different reason is still its own row.
    let state = base();
    for (let i = 0; i < 5; i++) {
      state = recordOperation(state, {
        intent: `add_clips batch ${String(i)}`,
        status: 'failed',
        failureReason: 'refused by the same rule',
      });
    }
    state = recordOperation(state, {
      intent: 'set_track_flags v_main',
      status: 'failed',
      failureReason: 'a different reason',
    });
    const text = buildStateBriefing(state);
    expect(text.split('refused by the same rule')).toHaveLength(2);
    expect(text).toContain(
      '- 5 calls (add_clips batch 0; add_clips batch 1; add_clips batch 2; and 2 more): refused by the same rule',
    );
    expect(text).toContain('- set_track_flags v_main: a different reason');
  });

  describe('ALREADY APPLIED collapses repetition without losing work', () => {
    /** The ledger's fan-out: one record per timeline operation, distinct idempotency keys. */
    const fanOut = (
      state: RunWorkingState,
      intents: readonly string[],
      keyPrefix = 'op',
    ): RunWorkingState =>
      intents.reduce(
        (acc, intent, index) =>
          recordOperation(acc, {
            intent,
            status: 'succeeded',
            idempotencyKey: `${keyPrefix}_${index}`,
          }),
        state,
      );

    const applied = (text: string): string[] => {
      const section = text.split('\n\n').find((s) => s.startsWith('ALREADY APPLIED'));
      return (section ?? '').split('\n').slice(1);
    };

    it('renders a lone operation exactly as it always did — no count on one', () => {
      // A run that did each thing once must pay nothing for this collapse, and its frozen
      // recordings must not move because of it.
      const text = buildStateBriefing(fanOut(base(), ['Trimmed Intro.mp4 · 0s–3.2s']));
      expect(applied(text)).toEqual(['- Trimmed Intro.mp4 · 0s–3.2s']);
    });

    it('collapses a caption pass to one line per intent, carrying the count', () => {
      // The shape of captured run `369e8c82`: `caption_the_edit` builds one operation per
      // cue, so the ledger held 34 + 34 records and the briefing restated two facts 68
      // times on every turn after the pass.
      const intents = [
        ...Array.from({ length: 34 }, () => 'Added captions'),
        ...Array.from({ length: 34 }, () => 'Set caption cue'),
      ];
      const text = buildStateBriefing(fanOut(base(), intents));
      expect(applied(text)).toEqual(['- Added captions (×34)', '- Set caption cue (×34)']);
    });

    it('holds flat at a hundred repeats of one intent', () => {
      const text = buildStateBriefing(
        fanOut(
          base(),
          Array.from({ length: 100 }, () => 'Set caption cue'),
        ),
      );
      expect(applied(text)).toEqual(['- Set caption cue (×100)']);
    });

    it('keeps every DISTINCT operation, in the order the run did them', () => {
      // The section exists so a run does not redo work. A distinct intent is the only
      // record that a distinct piece of work happened, so it is never elided — the
      // redundancy was the cost, not the length.
      const intents = Array.from({ length: 100 }, (_, i) => `Trimmed clip_${i}`);
      const lines = applied(buildStateBriefing(fanOut(base(), intents)));
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe('- Trimmed clip_0');
      expect(lines.at(-1)).toBe('- Trimmed clip_99');
    });

    it('orders by first occurrence, not by count', () => {
      const text = buildStateBriefing(
        fanOut(base(), ['Trimmed clip_a', 'Added captions', 'Added captions', 'Trimmed clip_a']),
      );
      expect(applied(text)).toEqual(['- Trimmed clip_a (×2)', '- Added captions (×2)']);
    });

    it('leaves FAILED alone — a reason is what distinguishes two failures', () => {
      let state = recordOperation(base(), {
        intent: 'add_clip',
        status: 'failed',
        failureReason: 'overlaps clip_b',
        idempotencyKey: 'f1',
      });
      state = recordOperation(state, {
        intent: 'add_clip',
        status: 'failed',
        failureReason: 'clip not found',
        idempotencyKey: 'f2',
      });
      const text = buildStateBriefing(state);
      expect(text).toContain('overlaps clip_b');
      expect(text).toContain('clip not found');
    });

    it('costs a bounded number of tokens for the captured run (gated, Workstream E)', () => {
      // Prompt cost as an assertion, not an intuition. The pre-collapse rendering of this
      // exact ledger was 1,189 characters / 298 estimated tokens, paid on EVERY turn after
      // the caption pass. Loosen this only with a measured accuracy reason.
      const intents = [
        ...Array.from({ length: 34 }, () => 'Added captions'),
        ...Array.from({ length: 34 }, () => 'Set caption cue'),
      ];
      const section = applied(buildStateBriefing(fanOut(base(), intents))).join('\n');
      expect(estimateTokens(section)).toBeLessThanOrEqual(20);
    });
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

  // The fifth echo, and the one the filter missed. `recoveryAction` composes its instruction
  // out of the first outstanding objective, and an objective is seeded from `userPrompt` — so
  // "DO THIS NOW" rendered the editor's entire request back at a model already holding it. A
  // captured run paid ~7,000 tokens a turn for that, under the one heading whose job is to
  // name a single concrete step, and it fired exactly when the run had stopped progressing.
  it('suppresses a next action that is only the request restated', () => {
    const request = 'make me a 30 second vertical reel about the Mars Climate Orbiter';
    let state = setObjective(initialWorkingState({ runId: 'run_2', request, projectRevision: 0 }), {
      outcome: request,
      acceptance: [],
    });
    state = setNextAction(state, {
      stage: 'apply',
      action: `Do this now: ${request}. Everything you need is in the run state above.`,
    });
    const text = buildStateBriefing(state);
    expect(text).not.toContain('DO THIS NOW');
    expect(text).not.toContain('Mars Climate Orbiter');
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
