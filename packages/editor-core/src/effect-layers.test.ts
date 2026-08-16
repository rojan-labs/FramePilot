/**
 * Tests for effect-layer operations (schema v13, ADR 0088).
 *
 * The centrepiece is the reversibility guarantee: for every one of the six
 * primitives, `apply` then `apply(invert)` must reproduce the original timeline
 * **deep-equal** — not merely equivalent. That is stricter than it sounds and it
 * is why the ops canonicalize their "off" states as absent keys: a timeline that
 * came back carrying `disabled: false` where it once had no key would pass a
 * loose comparison and still break undo/redo history diffing.
 */
import { describe, expect, it } from 'vitest';
import type { EffectLayer, Timeline, Track } from '@framepilot/timeline-schema';
import { activeEffectLayersAt, effectLayersOf } from '@framepilot/timeline-schema';
import {
  applyOperation,
  invertOperation,
  OperationError,
  type Operation,
} from './operations.js';
import { validatePatch } from './validator.js';

// --- fixtures --------------------------------------------------------------

const layer = (
  over: Partial<EffectLayer> & Pick<EffectLayer, 'id'>,
): EffectLayer => ({
  effectId: 'halo-bloom',
  kind: 'bloom',
  start: 0,
  end: 2,
  params: {},
  keyframes: [],
  ...over,
});

const baseTimeline = (): Timeline => ({
  tracks: [
    { id: 'fx_1', type: 'effect', clips: [] },
    {
      id: 'video_1',
      type: 'video',
      clips: [
        {
          id: 'a',
          assetId: 'asset_1',
          trackId: 'video_1',
          start: 0,
          end: 10,
          sourceStart: 0,
          sourceEnd: 10,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
});

/** Apply an op, then its inverse, and assert we are exactly where we started. */
const expectReversible = (before: Timeline, op: Operation): void => {
  const after = applyOperation(before, op);
  const inverse = invertOperation(before, op);
  let restored = after;
  for (const step of inverse) restored = applyOperation(restored, step);
  expect(restored).toEqual(before);
};

const trackById = (timeline: Timeline, id: string): Track =>
  timeline.tracks.find((t) => t.id === id) as Track;

const addOp = (over: Partial<EffectLayer> & Pick<EffectLayer, 'id'>): Operation => ({
  type: 'add_effect_layer',
  trackId: 'fx_1',
  layer: layer(over),
});

// --- add -------------------------------------------------------------------

describe('add_effect_layer', () => {
  it('adds a layer to an effect track', () => {
    const next = applyOperation(baseTimeline(), addOp({ id: 'fx-a' }));
    expect(effectLayersOf(trackById(next, 'fx_1')).map((l) => l.id)).toEqual(['fx-a']);
  });

  it('is reversible', () => {
    expectReversible(baseTimeline(), addOp({ id: 'fx-a' }));
  });

  it('fills schema defaults so the layer round-trips canonically', () => {
    const next = applyOperation(baseTimeline(), {
      type: 'add_effect_layer',
      trackId: 'fx_1',
      // No params/keyframes: the op must persist them as [] / {}, not as missing
      // keys, or the project file would not survive a save/reopen unchanged.
      layer: { id: 'fx-a', effectId: 'halo-bloom', kind: 'bloom', start: 0, end: 2 } as EffectLayer,
    });
    const stored = effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer;
    expect(stored.params).toEqual({});
    expect(stored.keyframes).toEqual([]);
  });

  it('keeps the stored list sorted by start', () => {
    let tl = applyOperation(baseTimeline(), addOp({ id: 'late', start: 5, end: 7 }));
    tl = applyOperation(tl, addOp({ id: 'early', start: 1, end: 2 }));
    expect(effectLayersOf(trackById(tl, 'fx_1')).map((l) => l.id)).toEqual(['early', 'late']);
  });

  it('rejects a non-effect track', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_effect_layer',
        trackId: 'video_1',
        layer: layer({ id: 'fx-a' }),
      }),
    ).toThrow(OperationError);
  });

  it('rejects a duplicate layer id on the same track', () => {
    const tl = applyOperation(baseTimeline(), addOp({ id: 'fx-a' }));
    expect(() => applyOperation(tl, addOp({ id: 'fx-a' }))).toThrow(/already exists/);
  });

  it('rejects a zero-duration layer via the schema', () => {
    expect(() => applyOperation(baseTimeline(), addOp({ id: 'fx-a', start: 2, end: 2 }))).toThrow(
      /invalid layer/,
    );
  });

  it('rejects an unknown track', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_effect_layer',
        trackId: 'nope',
        layer: layer({ id: 'fx-a' }),
      }),
    ).toThrow(OperationError);
  });
});

// --- remove ----------------------------------------------------------------

describe('remove_effect_layer', () => {
  const seeded = (): Timeline => applyOperation(baseTimeline(), addOp({ id: 'fx-a' }));

  it('removes the layer', () => {
    const next = applyOperation(seeded(), { type: 'remove_effect_layer', layerId: 'fx-a' });
    expect(effectLayersOf(trackById(next, 'fx_1'))).toEqual([]);
  });

  it('deletes the key entirely when the last layer goes, so undo lands deep-equal', () => {
    const next = applyOperation(seeded(), { type: 'remove_effect_layer', layerId: 'fx-a' });
    expect(trackById(next, 'fx_1').effectLayers).toBeUndefined();
    expect(next).toEqual(baseTimeline());
  });

  it('is reversible, restoring the whole layer', () => {
    expectReversible(seeded(), { type: 'remove_effect_layer', layerId: 'fx-a' });
  });

  it('is reversible for a fully-configured layer (params, intensity, disabled)', () => {
    const tl = applyOperation(
      baseTimeline(),
      addOp({
        id: 'fx-a',
        kind: 'mosaic',
        params: { size: 24 },
        intensity: 0.4,
        disabled: true,
      }),
    );
    expectReversible(tl, { type: 'remove_effect_layer', layerId: 'fx-a' });
  });

  it('rejects an unknown layer', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'remove_effect_layer', layerId: 'ghost' }),
    ).toThrow(/not found/);
  });
});

// --- move ------------------------------------------------------------------

describe('move_effect_layer', () => {
  const seeded = (): Timeline =>
    applyOperation(baseTimeline(), addOp({ id: 'fx-a', start: 1, end: 3 }));

  it('repositions in time preserving duration', () => {
    const next = applyOperation(seeded(), {
      type: 'move_effect_layer',
      layerId: 'fx-a',
      toStart: 6,
    });
    const moved = effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer;
    expect([moved.start, moved.end]).toEqual([6, 8]);
  });

  it('is reversible', () => {
    expectReversible(seeded(), { type: 'move_effect_layer', layerId: 'fx-a', toStart: 6 });
  });

  it('moves across effect tracks', () => {
    const withSecondLane: Timeline = {
      ...seeded(),
      tracks: [...seeded().tracks, { id: 'fx_2', type: 'effect', clips: [] }],
    };
    const next = applyOperation(withSecondLane, {
      type: 'move_effect_layer',
      layerId: 'fx-a',
      toStart: 4,
      toTrackId: 'fx_2',
    });
    expect(effectLayersOf(trackById(next, 'fx_1'))).toEqual([]);
    expect(effectLayersOf(trackById(next, 'fx_2')).map((l) => l.id)).toEqual(['fx-a']);
  });

  it('is reversible across tracks — returns to the lane it left', () => {
    const withSecondLane: Timeline = {
      ...seeded(),
      tracks: [...seeded().tracks, { id: 'fx_2', type: 'effect', clips: [] }],
    };
    expectReversible(withSecondLane, {
      type: 'move_effect_layer',
      layerId: 'fx-a',
      toStart: 4,
      toTrackId: 'fx_2',
    });
  });

  it('rejects a move onto a non-effect track', () => {
    expect(() =>
      applyOperation(seeded(), {
        type: 'move_effect_layer',
        layerId: 'fx-a',
        toStart: 0,
        toTrackId: 'video_1',
      }),
    ).toThrow(/effect' tracks/);
  });

  it('rejects a negative start', () => {
    expect(() =>
      applyOperation(seeded(), { type: 'move_effect_layer', layerId: 'fx-a', toStart: -1 }),
    ).toThrow(/negative start/);
  });
});

// --- trim ------------------------------------------------------------------

describe('trim_effect_layer', () => {
  const seeded = (): Timeline =>
    applyOperation(baseTimeline(), addOp({ id: 'fx-a', start: 2, end: 4 }));

  it('shortens from the out point', () => {
    const next = applyOperation(seeded(), {
      type: 'trim_effect_layer',
      layerId: 'fx-a',
      start: 2,
      end: 3,
    });
    const trimmed = effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer;
    expect([trimmed.start, trimmed.end]).toEqual([2, 3]);
  });

  it('extends past the original range', () => {
    const next = applyOperation(seeded(), {
      type: 'trim_effect_layer',
      layerId: 'fx-a',
      start: 0,
      end: 9,
    });
    const trimmed = effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer;
    expect([trimmed.start, trimmed.end]).toEqual([0, 9]);
  });

  it('is reversible', () => {
    expectReversible(seeded(), { type: 'trim_effect_layer', layerId: 'fx-a', start: 2.5, end: 3 });
  });

  it('rejects a non-positive duration', () => {
    expect(() =>
      applyOperation(seeded(), { type: 'trim_effect_layer', layerId: 'fx-a', start: 3, end: 3 }),
    ).toThrow(/non-positive duration/);
  });

  it('rejects a negative start', () => {
    expect(() =>
      applyOperation(seeded(), { type: 'trim_effect_layer', layerId: 'fx-a', start: -1, end: 2 }),
    ).toThrow(/negative start/);
  });
});

// --- params ----------------------------------------------------------------

describe('set_effect_layer_params', () => {
  const seeded = (): Timeline =>
    applyOperation(
      baseTimeline(),
      addOp({ id: 'fx-a', kind: 'analog-vhs', params: { tracking: 0.4, noise: 0.2 } }),
    );

  it('merges partially, preserving untouched params', () => {
    const next = applyOperation(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      params: { tracking: 0.9 },
    });
    const updated = effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer;
    expect(updated.params).toEqual({ tracking: 0.9, noise: 0.2 });
  });

  it('is reversible after a partial merge', () => {
    // The forward op merges, so a partial inverse would leave the new key behind.
    expectReversible(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      params: { tracking: 0.9, jitter: 0.5 },
    });
  });

  it('sets intensity', () => {
    const next = applyOperation(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      intensity: 0.25,
    });
    expect((effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer).intensity).toBe(0.25);
  });

  it('clears intensity with null, canonicalized as absent', () => {
    const withIntensity = applyOperation(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      intensity: 0.25,
    });
    const cleared = applyOperation(withIntensity, {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      intensity: null,
    });
    expect((effectLayersOf(trackById(cleared, 'fx_1'))[0] as EffectLayer).intensity).toBeUndefined();
    expect(cleared).toEqual(seeded());
  });

  it('is reversible when clearing intensity', () => {
    const withIntensity = applyOperation(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      intensity: 0.25,
    });
    expectReversible(withIntensity, {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      intensity: null,
    });
  });

  it('is a no-op when neither params nor intensity is given', () => {
    const next = applyOperation(seeded(), { type: 'set_effect_layer_params', layerId: 'fx-a' });
    expect(next).toEqual(seeded());
  });
});

// --- enable / disable ------------------------------------------------------

describe('set_effect_layer_enabled', () => {
  const seeded = (): Timeline => applyOperation(baseTimeline(), addOp({ id: 'fx-a' }));

  it('disables a layer', () => {
    const next = applyOperation(seeded(), {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: true,
    });
    expect((effectLayersOf(trackById(next, 'fx_1'))[0] as EffectLayer).disabled).toBe(true);
  });

  it('re-enables by deleting the key, not storing false', () => {
    const off = applyOperation(seeded(), {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: true,
    });
    const on = applyOperation(off, {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: false,
    });
    expect(on).toEqual(seeded());
  });

  it('is reversible in both directions', () => {
    expectReversible(seeded(), {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: true,
    });
    const off = applyOperation(seeded(), {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: true,
    });
    expectReversible(off, { type: 'set_effect_layer_enabled', layerId: 'fx-a', disabled: false });
  });

  it('keeps a disabled layer out of the active set but still on the timeline', () => {
    const off = applyOperation(seeded(), {
      type: 'set_effect_layer_enabled',
      layerId: 'fx-a',
      disabled: true,
    });
    expect(activeEffectLayersAt(off, 1)).toEqual([]);
    expect(effectLayersOf(trackById(off, 'fx_1'))).toHaveLength(1);
  });
});

// --- restore_effect_layer (internal inverse primitive) ---------------------

describe('restore_effect_layer', () => {
  const seeded = (): Timeline =>
    applyOperation(baseTimeline(), addOp({ id: 'fx-a', kind: 'mosaic', params: { size: 8 } }));

  it('replaces the layer wholesale rather than merging', () => {
    const snapshot = effectLayersOf(trackById(seeded(), 'fx_1'))[0] as EffectLayer;
    const drifted = applyOperation(seeded(), {
      type: 'set_effect_layer_params',
      layerId: 'fx-a',
      params: { size: 64 },
    });
    const restored = applyOperation(drifted, {
      type: 'restore_effect_layer',
      trackId: 'fx_1',
      layer: snapshot,
    });
    expect(restored).toEqual(seeded());
  });

  it('is itself reversible, so redo works', () => {
    const snapshot = effectLayersOf(trackById(seeded(), 'fx_1'))[0] as EffectLayer;
    expectReversible(seeded(), {
      type: 'restore_effect_layer',
      trackId: 'fx_1',
      layer: { ...snapshot, params: { size: 100 } },
    });
  });

  it('rejects a snapshot aimed at the wrong track', () => {
    const withSecondLane: Timeline = {
      ...seeded(),
      tracks: [...seeded().tracks, { id: 'fx_2', type: 'effect', clips: [] }],
    };
    const snapshot = effectLayersOf(trackById(seeded(), 'fx_1'))[0] as EffectLayer;
    expect(() =>
      applyOperation(withSecondLane, {
        type: 'restore_effect_layer',
        trackId: 'fx_2',
        layer: snapshot,
      }),
    ).toThrow(/but found it on/);
  });

  it('rejects an unknown layer', () => {
    expect(() =>
      applyOperation(seeded(), {
        type: 'restore_effect_layer',
        trackId: 'fx_1',
        layer: layer({ id: 'ghost' }),
      }),
    ).toThrow(/not found/);
  });
});

// --- layer removal must not lose effects (regression) ----------------------

describe('remove_layer of an effect lane', () => {
  it('restores its effect layers on undo', () => {
    // Regression: `remove_layer`'s inverse only carried `clips`, so deleting an
    // effect lane and undoing brought the track back EMPTY — every effect on it
    // was silently gone, with no error anywhere.
    let tl = applyOperation(baseTimeline(), addOp({ id: 'fx-a', start: 0, end: 2 }));
    tl = applyOperation(tl, addOp({ id: 'fx-b', start: 3, end: 5 }));
    expectReversible(tl, { type: 'remove_layer', layerId: 'fx_1' });
  });
});

// --- stacking / combination ------------------------------------------------

describe('stacking effect layers', () => {
  it('lets two layers overlap on one lane and reports both in order', () => {
    let tl = applyOperation(baseTimeline(), addOp({ id: 'first', start: 0, end: 4 }));
    tl = applyOperation(tl, addOp({ id: 'second', kind: 'mosaic', start: 2, end: 6 }));
    expect(activeEffectLayersAt(tl, 3).map((e) => e.layer.id)).toEqual(['first', 'second']);
  });

  it('applies a lower lane before a higher one', () => {
    const stacked: Timeline = {
      tracks: [
        { id: 'fx_top', type: 'effect', clips: [] },
        { id: 'fx_bottom', type: 'effect', clips: [] },
        ...baseTimeline().tracks.filter((t) => t.type !== 'effect'),
      ],
    };
    let tl = applyOperation(stacked, {
      type: 'add_effect_layer',
      trackId: 'fx_top',
      layer: layer({ id: 'top', start: 0, end: 4 }),
    });
    tl = applyOperation(tl, {
      type: 'add_effect_layer',
      trackId: 'fx_bottom',
      layer: layer({ id: 'bottom', kind: 'mosaic', start: 0, end: 4 }),
    });
    expect(activeEffectLayersAt(tl, 1).map((e) => e.layer.id)).toEqual(['bottom', 'top']);
  });

  it('duplicating is an add with a fresh id, and both survive independently', () => {
    let tl = applyOperation(baseTimeline(), addOp({ id: 'fx-a', params: { strength: 0.5 } }));
    const original = effectLayersOf(trackById(tl, 'fx_1'))[0] as EffectLayer;
    tl = applyOperation(tl, {
      type: 'add_effect_layer',
      trackId: 'fx_1',
      layer: { ...original, id: 'fx-a-copy', start: 4, end: 6 },
    });
    expect(effectLayersOf(trackById(tl, 'fx_1')).map((l) => l.id)).toEqual(['fx-a', 'fx-a-copy']);
  });
});

// --- validation ------------------------------------------------------------

describe('effect-layer validation', () => {
  const patchOf = (...operations: Operation[]) => ({
    id: 'p1',
    description: 'test',
    operations,
  });

  it('accepts a catalog-shaped layer', () => {
    const result = validatePatch(baseTimeline(), patchOf(addOp({ id: 'fx-a' })));
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown render kind', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf(addOp({ id: 'fx-a', kind: 'not-a-kind' as EffectLayer['kind'] })),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('unsupported_effect_kind');
  });

  it('accepts a known kind with no params at all', () => {
    // Reachable from AI/untyped input: the layer object may omit `params`
    // entirely (the schema defaults it on parse, but validation runs first).
    // A known kind with nothing to check must pass, not fault.
    const result = validatePatch(
      baseTimeline(),
      patchOf({
        type: 'add_effect_layer',
        trackId: 'fx_1',
        layer: {
          id: 'fx-a',
          effectId: 'halo-bloom',
          kind: 'bloom',
          start: 0,
          end: 2,
        } as EffectLayer,
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a param the kind does not declare', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf(addOp({ id: 'fx-a', kind: 'mosaic', params: { bogus: 1 } })),
    );
    expect(result.issues.map((i) => i.code)).toContain('invalid_effect_params');
  });

  it('rejects an out-of-range param', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf(addOp({ id: 'fx-a', kind: 'mosaic', params: { size: 9999 } })),
    );
    expect(result.issues.map((i) => i.code)).toContain('invalid_effect_params');
  });

  it('rejects a non-finite param', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf(addOp({ id: 'fx-a', kind: 'mosaic', params: { size: Number.NaN } })),
    );
    expect(result.issues.map((i) => i.code)).toContain('invalid_effect_params');
  });

  it('validates a params update against the EXISTING layer kind', () => {
    const seeded = applyOperation(baseTimeline(), addOp({ id: 'fx-a', kind: 'mosaic' }));
    const bad = validatePatch(
      seeded,
      patchOf({ type: 'set_effect_layer_params', layerId: 'fx-a', params: { size: 9999 } }),
    );
    expect(bad.issues.map((i) => i.code)).toContain('invalid_effect_params');

    const good = validatePatch(
      seeded,
      patchOf({ type: 'set_effect_layer_params', layerId: 'fx-a', params: { size: 32 } }),
    );
    expect(good.valid).toBe(true);
  });

  it('reports adding to a non-effect track', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf({
        type: 'add_effect_layer',
        trackId: 'video_1',
        layer: layer({ id: 'fx-a' }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('invalid_track');
  });

  it('reports a duplicate layer id', () => {
    const seeded = applyOperation(baseTimeline(), addOp({ id: 'fx-a' }));
    const result = validatePatch(seeded, patchOf(addOp({ id: 'fx-a' })));
    expect(result.issues.map((i) => i.code)).toContain('duplicate_effect_layer');
  });

  it('reports a missing layer reference', () => {
    const result = validatePatch(
      baseTimeline(),
      patchOf({ type: 'remove_effect_layer', layerId: 'ghost' }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('missing_reference');
  });

  it('defers to the replay for a params op on a layer that does not exist', () => {
    // The param check needs the existing layer to know which kind's ranges to use.
    // With no such layer there is nothing to check against, so it must NOT invent
    // a param error — the replay reports the missing reference instead.
    const result = validatePatch(
      baseTimeline(),
      patchOf({ type: 'set_effect_layer_params', layerId: 'ghost', params: { size: 8 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(['missing_reference']);
  });
});
