import { describe, expect, it } from 'vitest';
import type { Patch } from '@framepilot/editor-core';
import { makeProject } from '../__fixtures__/project.js';
import type { AiEvent } from '../events.js';
import {
  canonicalJson,
  checkReversibility,
  estimateRun,
  intentMatches,
  measureGoldenTurn,
  observeIntent,
  percentile,
  renderGoldenSummary,
  summarizeGoldenRun,
  type GoldenRow,
  type GoldenSummary,
  type GoldenTurnEvidence,
  type GoldenTurnMetrics,
} from './golden-metrics.js';
import type { RubricScore } from './mission-rubric.js';

const T0 = 1_000_000;

function ev(type: AiEvent['type'], extra: Record<string, unknown> = {}, ts = T0 + 100): AiEvent {
  return { id: `e_${type}_${String(ts)}`, conversationId: 'c', turnId: 't', ts, type, ...extra } as unknown as AiEvent;
}

function patch(operations: Patch['operations'], id = 'p1'): Patch {
  return { patchId: id as Patch['patchId'], createdBy: 'agent', reason: 'test', operations };
}

const trimA = patch([{ type: 'trim_clip', clipId: 'clip_a', start: 0, end: 5 }]);
const deleteTail = patch([{ type: 'delete_range', trackId: 'video_1', start: 8, end: 10 }], 'p2');

function rubric(score: number, checks: RubricScore['checks'] = []): RubricScore {
  return { scenario: 'unchanged', score, checks };
}

function evidence(overrides: Partial<GoldenTurnEvidence> = {}): GoldenTurnEvidence {
  return {
    events: [ev('status', { status: 'completed' }, T0 + 5000)],
    startedAt: T0,
    wallMs: 5000,
    before: makeProject(),
    appliedPatches: [],
    rubric: rubric(1),
    expectedIntent: 'edit',
    modelCalls: 2,
    toolCalls: 3,
    tokens: { prompt: 1000, output: 100 },
    usd: 0.01,
    ...overrides,
  };
}

/**
 * Evidence as an IMPORTED event dump carries it: the run's events and numbers, but no
 * project state — `before` and `appliedPatches` are absent, not empty.
 */
function importedEvidence(overrides: Partial<GoldenTurnEvidence> = {}): GoldenTurnEvidence {
  const { before: _before, appliedPatches: _appliedPatches, ...dump } = evidence(overrides);
  return dump;
}

const completed = ev('status', { status: 'completed' }, T0 + 5000);

describe('observeIntent', () => {
  it('a failed status is a failure whatever else happened', () => {
    expect(observeIntent([ev('ask', { question: 'which?' }), ev('status', { status: 'failed' })], 3)).toBe('failed');
  });
  it('a cancelled status is cancelled', () => {
    expect(observeIntent([ev('status', { status: 'cancelled' })], 0)).toBe('cancelled');
  });
  it('a question wins over a later edit — asking came first', () => {
    expect(observeIntent([ev('ask', { question: 'which clip?' }), ev('status', { status: 'completed' })], 2)).toBe('ask');
  });
  it('applied operations mean an edit', () => {
    expect(observeIntent([ev('status', { status: 'completed' })], 1)).toBe('edit');
  });
  it('an explanation with no change is a decline', () => {
    expect(
      observeIntent([ev('assistant_message', { text: 'There is no drone footage in this project.' }), ev('status', { status: 'completed' })], 0),
    ).toBe('decline');
  });
  it('nothing at all is silent', () => {
    expect(observeIntent([ev('status', { status: 'completed' })], 0)).toBe('silent');
  });
});

describe('intentMatches', () => {
  it('ask-or-edit accepts either reading of an ambiguous request', () => {
    expect(intentMatches('ask-or-edit', 'ask')).toBe(true);
    expect(intentMatches('ask-or-edit', 'edit')).toBe(true);
    expect(intentMatches('ask-or-edit', 'silent')).toBe(false);
  });
  it('everything else is exact', () => {
    expect(intentMatches('edit', 'edit')).toBe(true);
    expect(intentMatches('edit', 'ask')).toBe(false);
    expect(intentMatches('decline', 'decline')).toBe(true);
  });
});

describe('checkReversibility', () => {
  it('nothing applied is trivially reversible', () => {
    expect(checkReversibility(makeProject(), []).ok).toBe(true);
  });
  it('real patches undone in reverse order restore the prior project', () => {
    const result = checkReversibility(makeProject(), [trimA, deleteTail]);
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain('2 patch(es)');
  });
  it('a patch that cannot be applied is a failed check with the reason', () => {
    const ghost = patch([{ type: 'trim_clip', clipId: 'ghost', start: 0, end: 1 }]);
    const result = checkReversibility(makeProject(), [ghost]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/undo threw/);
  });
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});

describe('measureGoldenTurn', () => {
  it('a correct, complete, reversible edit is a first-pass acceptance', () => {
    const events = [
      ev('tool_call', { toolName: 'trim_clip', status: 'completed' }, T0 + 800),
      ev('diff', { edit: { validation: { valid: true }, patch: trimA, text: '' } }, T0 + 900),
      ev('assistant_message', { text: 'Trimmed the first clip to 5s.' }, T0 + 4000),
      ev('status', { status: 'completed' }, T0 + 5000),
    ];
    const m = measureGoldenTurn(
      evidence({
        events,
        appliedPatches: [trimA],
        rubric: rubric(1, [
          { id: 'first-clip-ends-at', ok: true, detail: '0.00 frame(s) off', facet: 'boundary' },
          { id: 'only-target-touched', ok: true, detail: 'no other clip changed', facet: 'target' },
        ]),
      }),
    );
    expect(m.intent).toEqual({ expected: 'edit', observed: 'edit', ok: true });
    expect(m.target?.ok).toBe(true);
    expect(m.boundary?.ok).toBe(true);
    expect(m.validity).toEqual({ diffs: 1, valid: 1, invalid: 0, rate: 1 });
    expect(m.firstPass).toBe(true);
    expect(m.silentSuccess).toBe(false);
    expect(m.latency.firstProgressMs).toBe(800);
    expect(m.latency.doneMs).toBe(5000);
    expect(m.reversibility.ok, m.reversibility.detail).toBe(true);
    expect(m.failureQuality).toBeNull();
    expect(m.operations).toBe(1);
    expect(m.tokens.total).toBe(1100);
  });

  it('a run that completes with no edit where one was expected is a silent success', () => {
    const m = measureGoldenTurn(evidence({ events: [ev('status', { status: 'completed' }, T0 + 100)] }));
    expect(m.intent.observed).toBe('silent');
    expect(m.silentSuccess).toBe(true);
    expect(m.firstPass).toBe(false);
    expect(m.latency.firstProgressMs).toBeNull();
    expect(m.failureQuality).toEqual({ loud: false, explained: false, message: null });
  });

  it('invalid proposals count against validity even when a later one lands', () => {
    const events = [
      ev('diff', { edit: { validation: { valid: false }, patch: trimA, text: '' } }, T0 + 100),
      ev('diff', { edit: { validation: { valid: true }, patch: trimA, text: '' } }, T0 + 200),
      ev('status', { status: 'completed' }, T0 + 300),
    ];
    const m = measureGoldenTurn(evidence({ events, appliedPatches: [trimA] }));
    expect(m.validity).toEqual({ diffs: 2, valid: 1, invalid: 1, rate: 0.5 });
  });

  it('a question on a guard case is the right intent and needs no edit to pass', () => {
    const events = [
      ev('ask', { question: 'Delete all five clips on V1?', toolCallId: 'x' }, T0 + 700),
      ev('status', { status: 'completed' }, T0 + 900),
    ];
    const m = measureGoldenTurn(evidence({ events, expectedIntent: 'ask', rubric: rubric(1) }));
    expect(m.intent.ok).toBe(true);
    expect(m.firstPass).toBe(true);
    expect(m.silentSuccess).toBe(false);
  });

  it('a failure that leaks an internal is loud but not explained', () => {
    const events = [
      ev('error', { message: 'Internal Server Error' }, T0 + 100),
      ev('status', { status: 'failed' }, T0 + 200),
    ];
    const m = measureGoldenTurn(evidence({ events }));
    expect(m.intent.observed).toBe('failed');
    expect(m.failureQuality).toEqual({ loud: true, explained: false, message: 'Internal Server Error' });
  });

  it('a failure in plain words is loud and explained', () => {
    const events = [
      ev('error', { message: 'The model provider refused the request (rate limited). Try again in a minute.' }, T0 + 100),
      ev('status', { status: 'failed' }, T0 + 200),
    ];
    expect(measureGoldenTurn(evidence({ events })).failureQuality?.explained).toBe(true);
  });

  it('target and boundary are null when the rubric has no such check', () => {
    const m = measureGoldenTurn(evidence({ rubric: rubric(1, [{ id: 'x', ok: true, detail: '' }]) }));
    expect(m.target).toBeNull();
    expect(m.boundary).toBeNull();
  });

  it('a dump that records no patches leaves undo unknown — neither a pass nor a failure', () => {
    const m = measureGoldenTurn(
      importedEvidence({
        events: [ev('diff', { edit: { valid: true, ops: ['trim_clip'] } }, T0 + 900), completed],
      }),
    );
    expect(m.reversibility).toEqual({ ok: null, detail: 'patches not recorded' });
    // And it is counted in neither direction: the one row leaves the rate with no sample.
    const summary = summarizeGoldenRun([{ caseId: 'imported', category: 'trim', turnIndex: 0, run: 1, metrics: m }]);
    expect(summary.reversibility).toBeNull();
    expect(summary.perCase.imported?.reversible).toBeNull();
  });

  it('an empty patch list is "applied nothing" and really checked, unlike an absent one', () => {
    const appliedNothing = measureGoldenTurn(evidence({ events: [completed], appliedPatches: [] }));
    const notRecorded = measureGoldenTurn(importedEvidence({ events: [completed] }));
    expect(appliedNothing.operations).toBe(0);
    expect(appliedNothing.reversibility.ok).toBe(true);
    expect(appliedNothing.reversibility.detail).toContain('nothing applied');
    expect(notRecorded.operations).toBe(0);
    expect(notRecorded.reversibility.ok).toBeNull();
    expect(notRecorded.reversibility.detail).toBe('patches not recorded');
    // Same operation count, deliberately different verdicts — the two must never collapse.
    expect(notRecorded.operations).toBe(appliedNothing.operations);
    expect(notRecorded.reversibility.ok).not.toBe(appliedNothing.reversibility.ok);
  });

  it('half the evidence is no evidence: a `before` with no patches, and the mirror of it', () => {
    const { appliedPatches: _appliedPatches, ...beforeOnly } = evidence({ events: [completed] });
    const { before: _before, ...patchesOnly } = evidence({ events: [completed], appliedPatches: [trimA] });
    expect(measureGoldenTurn(beforeOnly).reversibility).toEqual({ ok: null, detail: 'patches not recorded' });
    const mirrored = measureGoldenTurn(patchesOnly);
    expect(mirrored.reversibility).toEqual({ ok: null, detail: 'patches not recorded' });
    // The patches still count as operations — it is only the undo check that is unknown.
    expect(mirrored.operations).toBe(1);
  });

  it('a compact dump scores the validity and operations of the live run it came from', () => {
    const live = measureGoldenTurn(
      evidence({
        events: [ev('diff', { edit: { validation: { valid: true }, patch: trimA, text: '' } }, T0 + 900), completed],
        appliedPatches: [trimA],
      }),
    );
    const compact = measureGoldenTurn(
      importedEvidence({ events: [ev('diff', { edit: { valid: true, ops: ['trim_clip'] } }, T0 + 900), completed] }),
    );
    expect(compact.validity).toEqual(live.validity);
    expect(compact.validity.rate).toBe(1);
    expect(compact.operations).toBe(live.operations);
    expect(compact.intent.observed).toBe('edit');
    expect(compact.silentSuccess).toBe(false);
  });

  it('an invalid compact proposal counts against validity and contributes no operations', () => {
    const m = measureGoldenTurn(
      importedEvidence({
        events: [
          ev('diff', { edit: { valid: false, ops: ['trim_clip', 'delete_range'] } }, T0 + 100),
          ev('diff', { edit: { valid: true, ops: ['trim_clip'] } }, T0 + 200),
          ev('status', { status: 'completed' }, T0 + 300),
        ],
      }),
    );
    expect(m.validity).toEqual({ diffs: 2, valid: 1, invalid: 1, rate: 0.5 });
    // The two operations of the rejected proposal were never applied, so they never count.
    expect(m.operations).toBe(1);
  });

  it('a malformed dump scores zero operations rather than throwing', () => {
    const measure = (): GoldenTurnMetrics =>
      measureGoldenTurn(
        importedEvidence({
          events: [
            ev('diff', { edit: { valid: true } }, T0 + 100), // passed validation, names no operations
            ev('diff', {}, T0 + 150), // truncated: no `edit` at all
            ev('status', { status: 'completed' }, T0 + 300),
          ],
        }),
      );
    expect(measure).not.toThrow();
    const m = measure();
    expect(m.operations).toBe(0);
    // An edit with no recorded validation cannot be read as valid.
    expect(m.validity).toEqual({ diffs: 2, valid: 1, invalid: 1, rate: 0.5 });
    expect(m.intent.observed).toBe('silent');
    expect(m.silentSuccess).toBe(true);
  });

  it('an explicit operation count overrides both the patches and the diffs', () => {
    const events = [ev('diff', { edit: { valid: true, ops: ['a', 'b', 'c'] } }, T0 + 100), ev('status', { status: 'completed' }, T0 + 300)];
    const overridden = measureGoldenTurn(evidence({ events, appliedPatches: [trimA, deleteTail], operations: 7 }));
    expect(overridden.operations).toBe(7); // not the 2 patch operations, not the 3 diff operations
    // Zero is a count, not a missing value: it must not fall back to the recorded patches.
    const none = measureGoldenTurn(evidence({ events, appliedPatches: [trimA, deleteTail], operations: 0 }));
    expect(none.operations).toBe(0);
    expect(none.intent.observed).toBe('silent');
    expect(none.silentSuccess).toBe(true);
  });
});

describe('percentile', () => {
  it('is nearest-rank and null on an empty sample', () => {
    const xs = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([null, undefined, 3], 0.5)).toBe(3);
  });
});

function metrics(overrides: Partial<GoldenTurnMetrics> = {}): GoldenTurnMetrics {
  return {
    intent: { expected: 'edit', observed: 'edit', ok: true },
    target: { ok: true, checks: [] },
    boundary: null,
    validity: { diffs: 1, valid: 1, invalid: 0, rate: 1 },
    firstPass: true,
    silentSuccess: false,
    modelCalls: 4,
    toolCalls: 6,
    tokens: { prompt: 9000, output: 1000, total: 10000 },
    usd: 0.05,
    latency: { firstProgressMs: 1200, doneMs: 30000 },
    reversibility: { ok: true, detail: '' },
    failureQuality: null,
    score: 1,
    finalStatus: 'completed',
    operations: 3,
    ...overrides,
  };
}

describe('summarizeGoldenRun', () => {
  const rows: GoldenRow[] = [
    { caseId: 'trim', category: 'trim', turnIndex: 0, run: 1, metrics: metrics() },
    { caseId: 'trim', category: 'trim', turnIndex: 0, run: 2, metrics: metrics({ firstPass: false, score: 0.5, usd: 0.07, latency: { firstProgressMs: 2000, doneMs: 50000 } }) },
    {
      caseId: 'guard',
      category: 'guard',
      turnIndex: 0,
      run: 1,
      metrics: metrics({
        intent: { expected: 'ask', observed: 'silent', ok: false },
        silentSuccess: false,
        firstPass: false,
        operations: 0,
        validity: { diffs: 0, valid: 0, invalid: 0, rate: null },
        target: null,
        failureQuality: { loud: false, explained: false, message: null },
        usd: null,
      }),
    },
  ];

  it('folds turns into the goal.md numbers', () => {
    const s = summarizeGoldenRun(rows);
    expect(s.cases).toBe(2);
    expect(s.turns).toBe(3);
    expect(s.intentAccuracy).toBeCloseTo(2 / 3);
    expect(s.targetAccuracy).toBe(1);
    expect(s.boundaryPrecision).toBeNull();
    expect(s.validityRate).toBe(1);
    expect(s.firstPassAcceptance).toBeCloseTo(1 / 3);
    expect(s.acceptedEdits).toBe(1);
    expect(s.tokensPerAcceptedEdit).toBe(30000);
    // One row is unpriced, so a dollar figure would be a fabrication.
    expect(s.usdPerAcceptedEdit).toBeNull();
    expect(s.latency.doneMs).toEqual({ p50: 30000, p95: 50000, n: 3 });
    expect(s.failureQuality).toEqual({ failures: 1, loud: 0, explained: 0 });
    expect(s.perCase.trim).toMatchObject({ runs: 2, score: 0.5, firstPass: 0.5, usdPerRun: 0.05, wallMsPerRun: 30000 });
    expect(s.perCase.guard?.usdPerRun).toBeNull();
  });

  it('prices the accepted edit when every row is priced', () => {
    const s = summarizeGoldenRun(rows.slice(0, 2));
    expect(s.usdPerAcceptedEdit).toBeCloseTo(0.12);
  });

  it('reversibility is the share over the rows that recorded patches, not over every row', () => {
    const mixed: GoldenRow[] = [
      { caseId: 'live', category: 'trim', turnIndex: 0, run: 1, metrics: metrics() },
      {
        caseId: 'live',
        category: 'trim',
        turnIndex: 1,
        run: 1,
        metrics: metrics({ reversibility: { ok: false, detail: 'differs after undo at $.timeline.tracks[0]' } }),
      },
      {
        caseId: 'dump',
        category: 'import',
        turnIndex: 0,
        run: 1,
        metrics: metrics({ reversibility: { ok: null, detail: 'patches not recorded' } }),
      },
    ];
    const s = summarizeGoldenRun(mixed);
    expect(s.turns).toBe(3);
    // One pass over TWO checkable rows. The unrecorded third row is not in the denominator:
    // over all three it would read 33%, which would be a fabricated undo failure.
    expect(s.reversibility).toBe(0.5);
    expect(s.perCase.live?.reversible).toBe(0.5);
    // A case whose every turn recorded nothing has no rate at all, rather than a 0 that
    // reads as broken undo.
    expect(s.perCase.dump?.reversible).toBeNull();
    const md = renderGoldenSummary(s, { label: 'mixed', provider: 'mock', model: 'm', generatedAt: '2026-09-02' });
    expect(md).toContain('| reversibility | 50% |');
    expect(md).toContain('| dump | import | 1 |');
  });

  it('renders a human summary with the metric table and one row per case', () => {
    const md = renderGoldenSummary(summarizeGoldenRun(rows), {
      label: 'test',
      provider: 'mock',
      model: 'm',
      generatedAt: '2026-09-02',
      replayed: true,
    });
    expect(md).toContain('| first-pass acceptance | 33% |');
    expect(md).toContain('| trim | trim | 2 |');
    expect(md).toContain('| guard | guard | 1 |');
    expect(md).toContain('replayed from recordings');
  });
});

describe('estimateRun', () => {
  const prior = summarizeGoldenRun([
    { caseId: 'a', category: 'trim', turnIndex: 0, run: 1, metrics: metrics({ usd: 0.5, latency: { firstProgressMs: 1, doneMs: 60000 } }) },
  ]) as GoldenSummary;

  it('multiplies the prior per-run cost by the run count', () => {
    const e = estimateRun(prior, ['a'], 3);
    expect(e.usd).toBeCloseTo(1.5);
    expect(e.minutes).toBeCloseTo(3);
    expect(e.unknown).toEqual([]);
  });

  it('a case with no prior leaves the total unknown rather than partial', () => {
    const e = estimateRun(prior, ['a', 'b'], 1);
    expect(e.usd).toBeNull();
    expect(e.minutes).toBeNull();
    expect(e.unknown).toEqual(['b']);
    expect(e.perCase[0]).toMatchObject({ caseId: 'a', basis: 'prior' });
  });

  it('with no prior at all, everything is unknown', () => {
    expect(estimateRun(undefined, ['a'], 1).unknown).toEqual(['a']);
  });
});
