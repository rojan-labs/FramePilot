/**
 * VU4.2 — a transition is chosen from a reason and a measured cut.
 *
 * The assertion this file exists for is the negative one: an `'auto'` pass over a sequence
 * whose cuts are continuous adds nothing AND says which cuts it left hard and why. A pass
 * that stayed quiet about them would be read as an oversight and "fixed" on the next turn.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from '../ledger.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { transitionsNote } from './transition-planning.js';

// --- fixtures ---------------------------------------------------------------

/** Three 5s shots butted together on one layer: two cuts, at 5s and at 10s. */
function project(): Project {
  return parseProject({
    id: 'transitions',
    name: 'Transition fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: ['a', 'b', 'c'].map((id) => ({
      id,
      path: `${id}.mp4`,
      kind: 'video',
      durationSeconds: 30,
    })),
    timeline: {
      revision: 2,
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
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const measured = (over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  tier0Version: 1,
  luma: { mean: 0.5, std: 0.1, p10: 0.2, p90: 0.8 },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: 0.6,
  motion: { si: 40, ti: 8, class: 'static' },
  cutScore: 0.3,
  black: false,
  freeze: false,
  sharpness: 0.8,
  phash: '0000000000000000',
  ...over,
});

const shot = (assetId: string, setting: string, over: Partial<ShotRecord> = {}): ShotRecord => ({
  assetId,
  contentHash: 'hash_1',
  shotIndex: 0,
  t0: 0,
  t1: 5,
  keyframeT: 2.5,
  splitOf: false,
  measured: measured(),
  labelled: {
    tier1Version: 1,
    model: 'siglip',
    setting: { value: setting, p: 0.9 },
    faces: 0,
    entities: [],
  },
  ...over,
});

function ledgerOf(shots: ShotRecord[]): LedgerSnapshot {
  return {
    shots,
    digests: [],
    coverage: { measured: shots.length, labelled: shots.length, described: 0, total: shots.length },
  };
}

/** Every shot in the same room: two continuity cuts, and nothing belongs at either. */
function continuousLedger(): LedgerSnapshot {
  return ledgerOf([shot('a', 'office'), shot('b', 'office'), shot('c', 'office')]);
}

/** The middle shot is somewhere else, so the cut at 5s is a change of place. */
function locationChangeLedger(): LedgerSnapshot {
  return ledgerOf([shot('a', 'office'), shot('b', 'street'), shot('c', 'street')]);
}

function context(ledger?: LedgerSnapshot): ToolContext {
  const base = project();
  return { project: base, projectRevision: 2, ...(ledger === undefined ? {} : { ledger }) };
}

function ops(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return operationsForCall({ id: 'call_1', name, arguments: args }, ctx);
}

// --- add_transition ---------------------------------------------------------

describe('add_transition takes a reason', () => {
  it('chooses the kind and the length from the reason and the pacing', () => {
    const ctx = context(locationChangeLedger());
    const [op] = ops(
      'add_transition',
      { trackId: 'v1', fromClipId: 'shot_a', toClipId: 'shot_b', reason: 'location_change' },
      ctx,
    ) as [{ kind: string; durationSeconds: number }];
    expect(op.kind).toBeTruthy();
    // 0.25 x a 5s median shot is 1.25s, clamped to the 1.2s scene maximum.
    expect(op.durationSeconds).toBeGreaterThan(0);
    expect(op.durationSeconds).toBeLessThanOrEqual(1.2);
  });

  it('refuses a continuity reason rather than quietly substituting a dissolve', () => {
    const ctx = context(continuousLedger());
    expect(() =>
      ops(
        'add_transition',
        { trackId: 'v1', fromClipId: 'shot_a', toClipId: 'shot_b', reason: 'continuity' },
        ctx,
      ),
    ).toThrow(/hard cut/);
  });

  it('refuses when the call carries neither a kind nor a reason', () => {
    expect(() =>
      ops(
        'add_transition',
        { trackId: 'v1', fromClipId: 'shot_a', toClipId: 'shot_b' },
        context(continuousLedger()),
      ),
    ).toThrow(/reason/);
  });

  it("still takes an explicit kind, and fills the length from the catalog's own default", () => {
    const [op] = ops(
      'add_transition',
      { trackId: 'v1', fromClipId: 'shot_a', toClipId: 'shot_b', kind: 'cross-dissolve' },
      context(),
    ) as [{ kind: string; durationSeconds: number }];
    expect(op.kind).toBe('cross-dissolve');
    expect(op.durationSeconds).toBeGreaterThan(0);
  });

  it('keeps an explicitly named duration exactly as asked', () => {
    const [op] = ops(
      'add_transition',
      {
        trackId: 'v1',
        fromClipId: 'shot_a',
        toClipId: 'shot_b',
        kind: 'cross-dissolve',
        durationSeconds: 0.25,
      },
      context(),
    ) as [{ durationSeconds: number }];
    expect(op.durationSeconds).toBe(0.25);
  });

  it('rejects a kind the catalog does not hold', () => {
    expect(() =>
      ops(
        'add_transition',
        { trackId: 'v1', fromClipId: 'shot_a', toClipId: 'shot_b', kind: 'sparkle-swoosh' },
        context(),
      ),
    ).toThrow();
  });
});

// --- add_transitions --------------------------------------------------------

describe('add_transitions', () => {
  it('adds nothing to a continuous sequence AND names every cut it left hard', () => {
    const ctx = context(continuousLedger());
    expect(ops('add_transitions', { reason: 'auto' }, ctx)).toEqual([]);
    const note = transitionsNote('add_transitions', ctx, { reason: 'auto' });
    expect(note).toContain('2 cut(s) deliberately left as hard cuts');
    expect(note).toContain('5.0s');
    expect(note).toContain('10.0s');
    expect(note).toContain('the same setting and the cut reads as continuous');
    expect(note).toContain('decisions, not omissions');
  });

  it('transitions the change of place and leaves the continuity cut alone', () => {
    const ctx = context(locationChangeLedger());
    const built = ops('add_transitions', {}, ctx) as { fromClipId: string; toClipId: string }[];
    expect(built).toHaveLength(1);
    expect(built[0]?.fromClipId).toBe('shot_a');
    expect(built[0]?.toClipId).toBe('shot_b');
    const note = transitionsNote('add_transitions', ctx, {});
    expect(note).toContain('1 transition(s)');
    expect(note).toContain('1 cut(s) deliberately left as hard cuts');
  });

  it('leaves an unmeasured cut hard, and says it was never measured', () => {
    const ctx = context();
    expect(ops('add_transitions', { reason: 'auto' }, ctx)).toEqual([]);
    expect(transitionsNote('add_transitions', ctx, { reason: 'auto' })).toContain(
      'nothing has measured this cut',
    );
  });

  it('applies one named reason to every cut in scope', () => {
    const ctx = context(continuousLedger());
    const built = ops('add_transitions', { reason: 'time_jump' }, ctx);
    expect(built).toHaveLength(2);
  });

  it('treats only the cuts a caller lists', () => {
    const ctx = context(continuousLedger());
    const built = ops(
      'add_transitions',
      { cuts: [{ fromClipId: 'shot_b', toClipId: 'shot_c', reason: 'time_jump' }] },
      ctx,
    ) as { fromClipId: string }[];
    expect(built.map((op) => op.fromClipId)).toEqual(['shot_b']);
  });

  it('rejects a reason word the policy does not know', () => {
    expect(() => ops('add_transitions', { reason: 'vibes' }, context())).toThrow();
  });

  it('says so plainly when the layer has no cuts to treat', () => {
    const ctx = context();
    expect(transitionsNote('add_transitions', ctx, { trackId: 'nope' })).toContain(
      'no cuts in scope',
    );
  });
});
