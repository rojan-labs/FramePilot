/**
 * VU3.2 — the three solved colour tools.
 *
 * What matters here is not the arithmetic (that is `color-solver.test.ts`'s job) but the
 * contract around it: the model supplies no numbers, the tools grade only what needs it,
 * and everything that makes a result partial is said in words an editor would use.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { COLOR_GRADE_PARAMETER_CONTRACTS } from '@framepilot/editor-core';
import type { ColorEvidenceEntry, ColorMeasurement } from '../color-evidence.js';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from '../ledger.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { colorSolveNote } from './solved-color.js';

// --- fixtures ---------------------------------------------------------------

function project(): Project {
  return parseProject({
    id: 'solved_color',
    name: 'Solved colour fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 10 },
      { id: 'b', path: 'b.mp4', kind: 'video', durationSeconds: 10 },
      { id: 'c', path: 'c.mp4', kind: 'video', durationSeconds: 10 },
    ],
    timeline: {
      revision: 4,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: ['a', 'b', 'c'].map((assetId, index) => ({
            id: `shot_${assetId}`,
            assetId,
            trackId: 'v1',
            start: index * 5,
            end: index * 5 + 5,
            sourceStart: 0,
            sourceEnd: 5,
            effects: [],
            keyframes: [],
          })),
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const measured = (lumaMean: number, over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  tier0Version: 1,
  luma: { mean: lumaMean, std: 0.1, p10: lumaMean * 0.4, p90: Math.min(1, lumaMean * 1.6) },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: Math.min(1, lumaMean * 1.6) - lumaMean * 0.4,
  motion: { si: 40, ti: 8, class: 'static' },
  cutScore: 0.3,
  black: false,
  freeze: false,
  sharpness: 0.8,
  phash: '0000000000000000',
  ...over,
});

const shot = (assetId: string, facts: MeasuredFacts): ShotRecord => ({
  assetId,
  contentHash: 'hash_1',
  shotIndex: 0,
  t0: 0,
  t1: 5,
  keyframeT: 2.5,
  splitOf: false,
  measured: facts,
});

function ledger(entries: Record<string, MeasuredFacts>): LedgerSnapshot {
  const shots = Object.entries(entries).map(([assetId, facts]) => shot(assetId, facts));
  return {
    shots,
    digests: [],
    coverage: { measured: shots.length, labelled: 0, described: 0, total: shots.length },
  };
}

/** A `measure_color` evidence payload, in the shape the host stores it in. */
function measurement(
  clipId: string,
  values: Partial<Record<'luma' | 'red' | 'green' | 'blue' | 'saturation', number>>,
  revision = 4,
): ColorMeasurement {
  const channels = ['luma', 'red', 'green', 'blue', 'saturation'] as const;
  return {
    schemaVersion: 1,
    projectRevision: revision,
    clipId,
    trackId: 'v1',
    startFrame: 0,
    endFrame: 3,
    isolation: 'timeline_composite',
    occlusionFree: true,
    renderSettingsIdentity: 'temporal-evidence:1920x1080@30:captions=true',
    samples: [0, 1, 2].flatMap((frame) =>
      channels.map((channel) => {
        const value = values[channel] ?? 0.25;
        return {
          frame,
          channel,
          min: 0,
          max: 1,
          mean: value,
          p10: value * 0.5,
          p50: value,
          p90: Math.min(1, value * 1.5),
          nearBlackRatio: 0,
          nearWhiteRatio: 0,
        };
      }),
    ),
  };
}

function context(options: {
  ledger?: LedgerSnapshot;
  measurements?: readonly ColorMeasurement[];
}): ToolContext {
  const entries: ColorEvidenceEntry[] = (options.measurements ?? []).map((data) => ({
    source: 'measure_color',
    data,
  }));
  return {
    project: project(),
    projectRevision: 4,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    evidence: {
      byHandle: () => undefined,
      entries: () => entries,
    },
  };
}

function ops(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return operationsForCall({ id: 'call_1', name, arguments: args }, ctx);
}

// --- match_color ------------------------------------------------------------

describe('match_color', () => {
  it('grades every target toward the reference and touches nothing else', () => {
    const ctx = context({
      ledger: ledger({ a: measured(0.5), b: measured(0.25), c: measured(0.5) }),
    });
    const built = ops('match_color', { targetClipIds: ['shot_b'], referenceClipId: 'shot_a' }, ctx);
    expect(built).toHaveLength(1);
    const [op] = built as [
      { type: string; clipId: string; effect: { params: Record<string, number> } },
    ];
    expect(op.type).toBe('apply_color_grade');
    expect(op.clipId).toBe('shot_b');
    // Half the reference's brightness is one stop down, so the solve brightens it.
    expect(op.effect.params.exposure).toBeGreaterThan(0);
  });

  it('refuses to accept a grade value from the model at all', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5), b: measured(0.25) }) });
    expect(() =>
      ops(
        'match_color',
        { targetClipIds: ['shot_b'], referenceClipId: 'shot_a', exposure: 0.4 },
        ctx,
      ),
    ).toThrow();
  });

  it('refuses when nothing has measured the reference, and names the remedy', () => {
    const ctx = context({ ledger: ledger({ b: measured(0.25) }) });
    expect(() =>
      ops('match_color', { targetClipIds: ['shot_b'], referenceClipId: 'shot_a' }, ctx),
    ).toThrow(/measure_color/);
  });

  it('leaves an unmeasured target alone and says so instead of grading it blind', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5), b: measured(0.25) }) });
    const args = { targetClipIds: ['shot_b', 'shot_c'], referenceClipId: 'shot_a' };
    expect(ops('match_color', args, ctx)).toHaveLength(1);
    const note = colorSolveNote('match_color', ctx, args);
    expect(note).toContain('shot_c');
    expect(note).toContain('nothing has measured it');
  });

  it('says the match is partial, and which axes ran out, when the solve clamps', () => {
    // A near-black target against a bright reference asks for far more exposure than the
    // contract allows, so the match cannot be completed and must not be reported as done.
    const ctx = context({
      ledger: ledger({ a: measured(0.9), b: measured(0.02) }),
    });
    const args = { targetClipIds: ['shot_b'], referenceClipId: 'shot_a' };
    const [op] = ops('match_color', args, ctx) as [{ effect: { params: { exposure: number } } }];
    expect(op.effect.params.exposure).toBe(COLOR_GRADE_PARAMETER_CONTRACTS.exposure.max);
    const note = colorSolveNote('match_color', ctx, args);
    expect(note).toContain('the match is partial');
    expect(note).toContain('exposure');
  });

  it('says when the reading came from the imported footage rather than from the timeline', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5), b: measured(0.25) }) });
    const note = colorSolveNote('match_color', ctx, {
      targetClipIds: ['shot_b'],
      referenceClipId: 'shot_a',
    });
    expect(note).toContain('do not include any grade already on the clip');
  });

  it('prefers a fresh render measurement over the ledger when the run has one', () => {
    const ctx = context({
      ledger: ledger({ a: measured(0.5), b: measured(0.5) }),
      measurements: [
        measurement('shot_a', { luma: 0.5, red: 0.5, green: 0.5, blue: 0.5, saturation: 0.3 }),
        measurement('shot_b', { luma: 0.25, red: 0.25, green: 0.25, blue: 0.25, saturation: 0.3 }),
      ],
    });
    const args = { targetClipIds: ['shot_b'], referenceClipId: 'shot_a' };
    // The ledger says the two agree; the render says they do not. The render wins, so a
    // grade IS produced and the "imported footage" caveat is not printed.
    expect(ops('match_color', args, ctx)).toHaveLength(1);
    expect(colorSolveNote('match_color', ctx, args)).not.toContain('imported footage');
  });

  it('does nothing at all when the target already measures like the reference', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5), b: measured(0.5) }) });
    const args = { targetClipIds: ['shot_b'], referenceClipId: 'shot_a' };
    expect(ops('match_color', args, ctx)).toEqual([]);
    expect(colorSolveNote('match_color', ctx, args)).toContain(
      'already measures the same as the reference',
    );
  });
});

// --- normalize_exposure -----------------------------------------------------

describe('normalize_exposure', () => {
  it('grades only the outliers and names the clips it left where they were', () => {
    const ctx = context({
      ledger: ledger({ a: measured(0.5), b: measured(0.52), c: measured(0.15) }),
    });
    const args = { trackId: 'v1' };
    const built = ops('normalize_exposure', args, ctx) as { clipId: string }[];
    expect(built.map((op) => op.clipId)).toEqual(['shot_c']);
    const note = colorSolveNote('normalize_exposure', ctx, args);
    expect(note).toContain('within a third of a stop');
    expect(note).toContain('shot_a');
  });

  it('falls back to the median and says so when the named anchor is not measured', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5), c: measured(0.15) }) });
    const note = colorSolveNote('normalize_exposure', ctx, { trackId: 'v1', anchor: 'shot_b' });
    expect(note).toContain('not a measured clip on this track');
  });

  it('refuses on a track with no picture rather than grading an audio layer', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    expect(() => ops('normalize_exposure', { trackId: 'audio_1' }, ctx)).toThrow(/audio track/);
  });

  it('names the CLIPS to measure when nothing on the track has been', () => {
    // The old refusal named the tool — "measure_color reads one clip; indexing measures
    // them all" — and the model did not act on it: run `3ed87ff0` asked twice, measured
    // nothing, and fell back to 36 hand-picked apply_color_grade calls carrying identical
    // numbers on every shot. A remedy naming the arguments is a call it can make.
    const ctx = context({ ledger: ledger({}) });
    let thrown: unknown;
    try {
      ops('normalize_exposure', { trackId: 'v1' }, ctx);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toMatch(/Call measure_color on "shot_a"/);
    expect(message).toMatch(/then call normalize_exposure again/);
  });
});

// --- apply_look -------------------------------------------------------------

describe('apply_look', () => {
  it('moves warmth without being handed a temperature value', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    const [op] = ops('apply_look', { clipIds: ['shot_a'], look: 'warmer' }, ctx) as [
      { effect: { params: Record<string, number> } },
    ];
    expect(op.effect.params.temperature).toBeGreaterThan(0);
  });

  it('goes further at strong than at subtle, on the same footage', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    const of = (amount: string) =>
      (
        ops('apply_look', { clipIds: ['shot_a'], look: 'warmer', amount }, ctx) as [
          { effect: { params: Record<string, number> } },
        ]
      )[0].effect.params.temperature ?? 0;
    expect(of('strong')).toBeGreaterThan(of('subtle'));
  });

  it('refuses when neither clipIds nor trackId names the shots', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    expect(() => ops('apply_look', { look: 'warmer' }, ctx)).toThrow(/name the shots/);
  });

  it('rejects a look word that is not one of the eight intents', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    expect(() => ops('apply_look', { clipIds: ['shot_a'], look: 'teal-orange' }, ctx)).toThrow();
  });

  it('skips a clip nothing has measured rather than assuming a baseline', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    const args = { clipIds: ['shot_a', 'shot_b'], look: 'warmer' };
    expect(ops('apply_look', args, ctx)).toHaveLength(1);
    expect(colorSolveNote('apply_look', ctx, args)).toContain('shot_b: not measured yet');
  });
});

// --- the note ---------------------------------------------------------------

describe('colorSolveNote', () => {
  it('says nothing for a tool it does not speak for', () => {
    const ctx = context({ ledger: ledger({ a: measured(0.5) }) });
    expect(colorSolveNote('apply_color_grade', ctx, { clipId: 'shot_a' })).toBe('');
  });
});
