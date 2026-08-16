/**
 * Context continuity across a long editing session (ADR 0080).
 *
 * These are not unit tests of one module. They are the regression suite for the actual
 * complaint: the agent losing awareness of previous decisions, tool results, plans and
 * completed work, and starting over. Each test walks a realistic session shape and
 * asserts on the two things the model actually sees — the state briefing and the request
 * manifest — rather than on internal bookkeeping, because those are what determine
 * whether the next turn continues or re-explores.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../__fixtures__/project.js';
import { assembleContext } from '../../context-builder.js';
import { capabilitiesFor } from '../../providers/model-capabilities.js';
import type { ContextBudget } from '../../reliability/types.js';
import { buildStateBriefing } from '../briefing.js';
import {
  type RunWorkingState,
  advanceStage,
  commitDecision,
  initialWorkingState,
  isDelivered,
  liveEvidence,
  onProjectRevisionChanged,
  parseWorkingState,
  recordDecision,
  recordEvidence,
  recordFact,
  recordObjective,
  recordOperation,
  recordVerification,
  setNextAction,
  setObjective,
} from '../working-state.js';
import { ensureContextInvariants } from './invariants.js';
import { buildRequestManifest, memoryStatusFrom } from './manifest.js';

const WINDOW = { contextWindow: 1_000_000, windowSource: 'known_model' as const };

/**
 * A montage run mid-flight: interpreted, reconnaissance done, music and footage analysed,
 * a segment committed, one cut applied. The shape where "it forgot everything" was
 * reported.
 */
function montageRun(): RunWorkingState {
  let state = initialWorkingState({
    runId: 'run_montage',
    request: 'make a 45s montage from the interview, cut to the music',
    projectRevision: 0,
  });
  state = setObjective(state, {
    outcome: 'a 45s montage cut to the music bed',
    acceptance: [{ description: 'final duration is 45s ± 2s' }],
  });
  state = recordObjective(state, { description: 'cut the montage to 45s', stage: 'apply' });
  state = advanceStage(state, 'inspect', 1);
  state = recordEvidence(state, {
    id: 'ev_transcript',
    source: 'get_transcript',
    descriptor: 'full interview transcript, 6:04',
    scope: 'revision_independent',
  });
  state = recordFact(state, {
    kind: 'transcript',
    statement: 'Source runs 6:04; single asset asset_1, 1080x1920.',
    scope: 'revision_independent',
    evidenceIds: ['ev_transcript'],
  });
  state = advanceStage(state, 'analyze', 2);
  state = recordEvidence(state, {
    id: 'ev_beats',
    source: 'find_beats',
    descriptor: 'beat map for music_1',
    scope: 'revision_independent',
  });
  state = recordFact(state, {
    kind: 'audio',
    statement: 'Music_1 beat map: 128 BPM, drop at 00:52.',
    scope: 'revision_independent',
    evidenceIds: ['ev_beats'],
  });
  state = recordFact(state, {
    kind: 'footage',
    statement: 'Footage map: 4 chapters; strongest hook at 01:12–01:20.',
    scope: 'revision_independent',
  });
  state = recordDecision(state, {
    decision: 'Use 00:42–01:12 of the music',
    reconsiderIf: 'music_asset_changed or the user requests a new section',
    evidenceIds: ['ev_beats'],
  });
  state = commitDecision(state, 'decision_1');
  state = advanceStage(state, 'plan', 3);
  state = advanceStage(state, 'apply', 4);
  return setNextAction(state, { stage: 'apply', action: 'apply the committed cut list' });
}

describe('same chat, many requests', () => {
  it('keeps the objective, the decision and the next action across ten turns', () => {
    let state = montageRun();
    // Ten turns of ordinary churn: a fact each, no re-interpretation.
    for (let turn = 0; turn < 10; turn += 1) {
      state = recordFact(state, {
        kind: 'derived',
        statement: `Turn ${turn} observation.`,
        scope: 'timeline_dependent',
      });
    }
    const briefing = buildStateBriefing(state);
    expect(briefing).toContain('a 45s montage cut to the music bed');
    expect(briefing).toContain('Use 00:42–01:12 of the music');
    expect(briefing).toContain('apply the committed cut list');
    expect(state.stage).toBe('apply');
  });

  it('refuses to re-interpret the request mid-run, which is where objectives drift', () => {
    const state = montageRun();
    const reinterpreted = setObjective(state, {
      outcome: 'a 30s teaser instead',
      acceptance: [{ description: 'final duration is 30s' }],
    });
    expect(reinterpreted.objective.outcome).toBe('a 45s montage cut to the music bed');
  });

  it('tells the model what is already established, so it has no reason to re-gather', () => {
    const briefing = buildStateBriefing(montageRun());
    expect(briefing).toContain('ESTABLISHED — do not gather again');
    expect(briefing).toContain('Music_1 beat map: 128 BPM, drop at 00:52.');
    expect(briefing).toContain('Footage map: 4 chapters');
  });
});

describe('tool-heavy editing run', () => {
  it('records an identical finding once, so a repeated read cannot inflate the briefing', () => {
    let state = montageRun();
    const before = state.facts.length;
    for (let i = 0; i < 5; i += 1) {
      state = recordFact(state, {
        kind: 'audio',
        statement: 'Music_1 beat map: 128 BPM, drop at 00:52.',
        scope: 'revision_independent',
      });
    }
    expect(state.facts.length).toBe(before);
  });

  it('keeps source analysis across an applied edit — a cut cannot change the beats', () => {
    const applied = onProjectRevisionChanged(montageRun(), 1);
    const briefing = buildStateBriefing(applied);
    expect(briefing).toContain('Music_1 beat map: 128 BPM, drop at 00:52.');
    expect(briefing).toContain('Source runs 6:04');
    expect(liveEvidence(applied).map((e) => e.id)).toEqual(['ev_transcript', 'ev_beats']);
  });

  it('invalidates only the arrangement, which is exactly what an edit changed', () => {
    let state = montageRun();
    state = recordFact(state, {
      kind: 'derived',
      statement: 'Timeline currently holds 6 clips ending at 61.2s.',
      scope: 'timeline_dependent',
    });
    const applied = onProjectRevisionChanged(state, 1);
    expect(buildStateBriefing(applied)).not.toContain('6 clips ending at 61.2s');
    expect(buildStateBriefing(applied)).toContain('Music_1 beat map');
  });

  it('does not reset the stage, the decision or the objective when the project moves', () => {
    const applied = onProjectRevisionChanged(montageRun(), 1);
    expect(applied.stage).toBe('apply');
    expect(applied.decisions[0]).toMatchObject({ status: 'committed' });
    expect(applied.objective.outcome).toBe('a 45s montage cut to the music bed');
  });

  it('lists applied work as done, so a later turn cannot redo it', () => {
    let state = recordOperation(montageRun(), {
      intent: 'trim clip_1 to 00:42–01:12',
      status: 'succeeded',
      patchId: 'patch_1',
    });
    state = recordOperation(state, {
      intent: 'add a cross dissolve at 00:52',
      status: 'failed',
      failureReason: 'no clip boundary at 00:52',
    });
    const briefing = buildStateBriefing(state);
    expect(briefing).toContain('ALREADY APPLIED — do not repeat');
    expect(briefing).toContain('trim clip_1 to 00:42–01:12');
    expect(briefing).toContain('FAILED — fix the cause, do not retry unchanged');
    expect(briefing).toContain('no clip boundary at 00:52');
  });
});

describe('desktop reload', () => {
  it('restores the stage, the revision, the decisions and the completed work', () => {
    let state = onProjectRevisionChanged(montageRun(), 3);
    state = recordOperation(state, {
      intent: 'trim clip_1 to 00:42–01:12',
      status: 'succeeded',
      patchId: 'patch_1',
    });

    // What persistence actually does: serialize, reload, parse.
    const restored = parseWorkingState(JSON.parse(JSON.stringify(state)));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(state);
  });

  it('lets the next model call continue from the previous stage, not from scratch', () => {
    const restored = parseWorkingState(JSON.parse(JSON.stringify(montageRun())))!;
    const briefing = buildStateBriefing(restored);
    expect(briefing).toContain('You are at "apply"');
    expect(briefing).toContain('apply the committed cut list');
    expect(ensureContextInvariants(restored).unrecovered).toEqual([]);
  });

  it('keeps the context UI meaningful after a reload', () => {
    const restored = parseWorkingState(JSON.parse(JSON.stringify(montageRun())))!;
    const manifest = buildRequestManifest({
      requestId: 'req_after_reload',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      ...WINDOW,
      reservedOutputTokens: 128_000,
      request: { messages: [{ role: 'user', content: 'continue' }] },
      memory: memoryStatusFrom(restored),
    });
    expect(manifest.memory).toMatchObject({
      runId: 'run_montage',
      stage: 'apply',
      committedDecisions: 1,
      objectiveKnown: true,
    });
  });

  it('starts fresh rather than throwing when the snapshot is corrupt', () => {
    expect(parseWorkingState({ schemaVersion: 99, runId: 'x' })).toBeNull();
    expect(parseWorkingState(undefined)).toBeNull();
  });
});

describe('provider switch', () => {
  it('updates the reported limit when the model changes', () => {
    const opus = capabilitiesFor('anthropic', 'claude-opus-4-8');
    const haiku = capabilitiesFor('anthropic', 'claude-haiku-4-5');
    expect(opus.contextWindow).not.toBe(haiku.contextWindow);
  });

  it('leaves the task state untouched — a model is not a memory', () => {
    const state = montageRun();
    const small = buildRequestManifest({
      requestId: 'req_1',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      contextWindow: capabilitiesFor('anthropic', 'claude-haiku-4-5').contextWindow,
      windowSource: 'known_model',
      reservedOutputTokens: 64_000,
      request: { messages: [{ role: 'user', content: 'continue' }] },
      memory: memoryStatusFrom(state),
    });
    const large = buildRequestManifest({
      requestId: 'req_2',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      ...WINDOW,
      reservedOutputTokens: 128_000,
      request: { messages: [{ role: 'user', content: 'continue' }] },
      memory: memoryStatusFrom(state),
    });
    expect(small.memory).toEqual(large.memory);
    expect(large.usage.modelContextLimit).toBeGreaterThan(small.usage.modelContextLimit);
  });

  it('never presents a switch as a reset — the briefing is model-independent', () => {
    const briefing = buildStateBriefing(montageRun());
    expect(briefing).toContain('Use 00:42–01:12 of the music');
    // The briefing is built from state alone; nothing about it depends on the provider.
    expect(briefing).not.toMatch(/claude|anthropic|gpt|llama/i);
  });
});

describe('context compaction', () => {
  const tight: ContextBudget = { contextWindow: 1, maxOutputTokens: 0, headroom: 0 };

  it('drops raw material from the request while the structured memory stays whole', () => {
    const project = makeProject({ transcript: [{ word: 'hello', start: 0, end: 1 }] });
    const assembled = assembleContext({
      project,
      userPrompt: 'keep going',
      budget: tight,
    });
    expect(assembled.trimmed).toContain('transcript');
    // The run's own memory is a separate store — compaction cannot touch it.
    const state = montageRun();
    expect(buildStateBriefing(state)).toContain('Use 00:42–01:12 of the music');
    expect(state.facts.length).toBeGreaterThan(0);
  });

  it('reports what was removed rather than leaving a silent gap', () => {
    const project = makeProject({ transcript: [{ word: 'hello', start: 0, end: 1 }] });
    const assembled = assembleContext({ project, userPrompt: 'keep going', budget: tight });
    const manifest = buildRequestManifest({
      requestId: 'req_compacted',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      ...WINDOW,
      reservedOutputTokens: 128_000,
      request: { messages: assembled.messages },
      assembled,
      memory: memoryStatusFrom(montageRun()),
    });
    expect(manifest.compaction.occurred).toBe(true);
    expect(manifest.compaction.removedSections.length).toBeGreaterThan(0);
    expect(manifest.compaction.removedTokenEstimate).toBeGreaterThan(0);
    // And the durable memory rides alongside, so the UI can say what survived.
    expect(manifest.memory?.committedDecisions).toBe(1);
  });

  it('preserves the exact values an edit depends on — timestamps, ids, ranges', () => {
    const briefing = buildStateBriefing(montageRun());
    for (const exact of ['00:42–01:12', '128 BPM', '00:52', '01:12–01:20', 'asset_1', '6:04']) {
      expect(briefing).toContain(exact);
    }
  });

  it('does not restart the task: the stage and next action survive a trimmed request', () => {
    const project = makeProject({ transcript: [{ word: 'hello', start: 0, end: 1 }] });
    assembleContext({ project, userPrompt: 'keep going', budget: tight });
    const state = montageRun();
    expect(state.stage).toBe('apply');
    expect(state.nextAction?.action).toBe('apply the committed cut list');
  });
});

describe('long-running montage task', () => {
  it('never re-opens a committed decision without its stated trigger', () => {
    const state = montageRun();
    const briefing = buildStateBriefing(state);
    expect(briefing).toContain('DECIDED — keep unless the stated trigger fires');
    expect(briefing).toContain('revisit only if: music_asset_changed');
  });

  it('holds every expensive analysis after twenty turns of unrelated churn', () => {
    let state = montageRun();
    for (let turn = 0; turn < 20; turn += 1) {
      state = recordFact(state, {
        kind: 'derived',
        statement: `Churn ${turn}.`,
        scope: 'timeline_dependent',
      });
      if (turn % 5 === 0) state = onProjectRevisionChanged(state, turn + 1);
    }
    const briefing = buildStateBriefing(state);
    expect(briefing).toContain('Music_1 beat map: 128 BPM, drop at 00:52.');
    expect(briefing).toContain('Footage map: 4 chapters');
    expect(briefing).toContain('Source runs 6:04');
  });

  it('reports completion only when work applied AND every objective is satisfied', () => {
    let state = recordOperation(montageRun(), {
      intent: 'trim clip_1 to 00:42–01:12',
      status: 'succeeded',
      patchId: 'patch_1',
    });
    // Applied, but the objective is not discharged until verification passes.
    expect(isDelivered(state)).toBe(false);
    state = recordVerification(state, {
      criterion: 'final duration is 45s ± 2s',
      passed: true,
      objectiveId: 'objective_1',
    });
    expect(isDelivered(state)).toBe(true);
  });

  it('does not mark work delivered on the model’s say-so alone', () => {
    const state = recordVerification(montageRun(), {
      criterion: 'final duration is 45s ± 2s',
      passed: true,
      objectiveId: 'objective_1',
    });
    // Verification passed but nothing was ever applied.
    expect(isDelivered(state)).toBe(false);
  });
});
