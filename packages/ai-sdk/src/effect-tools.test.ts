/**
 * Tests for the effect-layer AI tools (schema v13, ADR 0088).
 *
 * The headline guarantee is the last describe block: an AI-driven edit and the
 * equivalent manual edit must produce the SAME timeline. That holds by
 * construction — both drive the same six editor-core operations — and these tests
 * pin it, because "manual editing and AI editing produce the same visible
 * results" is a product requirement, not an implementation detail.
 *
 * The rest guards the things a model gets wrong: hallucinated effect ids,
 * out-of-range params, missing effect tracks, and inverted enable/disable.
 */
import { describe, expect, it } from 'vitest';
import { applyOperation, invertOperation, type Operation } from '@framepilot/editor-core';
import {
  EFFECT_CATALOG,
  findEffect,
  resolveParams,
} from '@framepilot/timeline-schema/effect-catalog';
import { effectLayersOf, type Project, type Timeline } from '@framepilot/timeline-schema';
import { getTool } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';

const baseProject = (tracks: Timeline['tracks'] = []): Project =>
  ({
    id: 'p1',
    name: 'Effects',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    folders: [],
    timeline: { tracks },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  }) as unknown as Project;

const ctxOf = (project: Project): ToolContext => ({ project });

const run = (name: string, args: unknown, project = baseProject()): Operation[] => {
  const tool = getTool(name);
  if (tool?.buildOps === undefined) throw new Error(`no mutating tool "${name}"`);
  return tool.buildOps(args, ctxOf(project)) as Operation[];
};

const read = (name: string, args: unknown): unknown => {
  const tool = getTool(name);
  if (tool?.read === undefined) throw new Error(`no read tool "${name}"`);
  return tool.read(args, ctxOf(baseProject()));
};

const withEffectTrack = (): Timeline['tracks'] => [
  { id: 'fx_1', type: 'effect', clips: [] },
  { id: 'video_1', type: 'video', clips: [] },
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('effect tool registration', () => {
  const names = [
    'discover_effects',
    'apply_effect',
    'move_effect',
    'resize_effect',
    'adjust_effect',
    'set_effect_enabled',
    'remove_effect',
  ];

  it.each(names)('%s is registered', (name) => {
    expect(getTool(name)).toBeDefined();
  });

  it('marks discover_effects as non-mutating and the rest as mutating', () => {
    expect(getTool('discover_effects')?.mutates).toBe(false);
    for (const name of names.slice(1)) {
      expect(getTool(name)?.mutates, name).toBe(true);
    }
  });

  it('publishes a JSON schema for every effect tool', () => {
    for (const name of names) {
      expect(getTool(name)?.parameters, name).toBeDefined();
    }
  });

  it('rejects unknown arguments rather than ignoring them', () => {
    // `.strict()` on every schema: a model passing `clipId` to apply_effect has
    // misunderstood that effects are layers, and a silent drop would hide that.
    expect(() =>
      run('apply_effect', { effectId: 'halo-bloom', startTime: 0, clipId: 'a' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// discover_effects
// ---------------------------------------------------------------------------

describe('discover_effects', () => {
  interface Result {
    matched: number;
    returned: number;
    categories: { id: string; label: string }[];
    effects: {
      effectId: string;
      label: string;
      params: { name: string; min: number; max: number; default: number }[];
    }[];
  }

  it('returns the catalog with a default cap', () => {
    const result = read('discover_effects', {}) as Result;
    expect(result.matched).toBe(EFFECT_CATALOG.length);
    // Capped: dumping all 72 entries with every param would burn a large slice of
    // the context window on effects the model will not use.
    expect(result.returned).toBe(20);
  });

  it('honours an explicit limit', () => {
    expect((read('discover_effects', { limit: 3 }) as Result).returned).toBe(3);
  });

  it('searches by tag synonym, not just label', () => {
    const result = read('discover_effects', { query: 'teal orange' }) as Result;
    expect(result.effects.map((e) => e.effectId)).toContain('teal-amber');
  });

  it('filters by category', () => {
    const result = read('discover_effects', { category: 'glitch', limit: 80 }) as Result;
    expect(result.effects.length).toBeGreaterThan(0);
    for (const effect of result.effects) {
      expect(findEffect(effect.effectId)?.category).toBe('glitch');
    }
  });

  it('filters to the popular and recommended shelves', () => {
    for (const shelf of ['popular', 'recommended'] as const) {
      const result = read('discover_effects', { shelf, limit: 80 }) as Result;
      expect(result.effects.length).toBeGreaterThan(0);
      for (const effect of result.effects) {
        expect(findEffect(effect.effectId)?.[shelf]).toBe(true);
      }
    }
  });

  it('reports real param ranges so the model can pick a legal value', () => {
    // Without ranges the model guesses, the validator rejects the patch, and the
    // user sees a failed edit for no reason they can act on.
    const result = read('discover_effects', { query: 'Mosaic Block' }) as Result;
    const params = result.effects[0]?.params ?? [];
    const size = params.find((p) => p.name === 'size');
    expect(size).toMatchObject({ min: 2, max: 128 });
  });

  it('reports the effect’s OWN default, not the kind default', () => {
    // Chunky Pixel overrides `size` to 56; reporting the kind default (16) would
    // make the model think it was applying a different look.
    const result = read('discover_effects', { query: 'Chunky Pixel' }) as Result;
    const size = result.effects[0]?.params.find((p) => p.name === 'size');
    expect(size?.default).toBe(56);
  });

  it('lists every category so the model can navigate', () => {
    expect((read('discover_effects', {}) as Result).categories).toHaveLength(20);
  });

  it('returns an empty result for a miss rather than throwing', () => {
    const result = read('discover_effects', { query: 'zzzznotathing' }) as Result;
    expect(result.matched).toBe(0);
    expect(result.effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// apply_effect
// ---------------------------------------------------------------------------

describe('apply_effect', () => {
  it('creates an effect track when the project has none', () => {
    const ops = run('apply_effect', { effectId: 'halo-bloom', startTime: 1 });
    expect(ops.map((o) => o.type)).toEqual(['add_layer', 'add_effect_layer']);
  });

  it('puts the new effect lane at the front so it sits above the picture', () => {
    const ops = run('apply_effect', { effectId: 'halo-bloom', startTime: 0 });
    expect(ops[0]).toMatchObject({ type: 'add_layer', layerType: 'effect', atIndex: 0 });
  });

  it('reuses an existing effect lane instead of stacking empty tracks', () => {
    const ops = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 1 },
      baseProject(withEffectTrack()),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'add_effect_layer', trackId: 'fx_1' });
  });

  it('targets a named lane when asked', () => {
    const tracks = [...withEffectTrack(), { id: 'fx_2', type: 'effect' as const, clips: [] }];
    const ops = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 1, trackId: 'fx_2' },
      baseProject(tracks),
    );
    expect(ops[0]).toMatchObject({ trackId: 'fx_2' });
  });

  it('uses the effect’s own default duration when endTime is omitted', () => {
    const entry = findEffect('cine-grain');
    const ops = run(
      'apply_effect',
      { effectId: 'cine-grain', startTime: 2 },
      baseProject(withEffectTrack()),
    );
    const op = ops[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(op.layer.end).toBe(2 + (entry?.defaultDuration ?? 0));
  });

  it('resolves the COMPLETE param bag, not just the overrides', () => {
    // A layer carrying only overrides would change appearance if a kind's
    // defaults were ever retuned, silently altering already-saved projects.
    const ops = run(
      'apply_effect',
      { effectId: 'tape-warp', startTime: 0 },
      baseProject(withEffectTrack()),
    );
    const op = ops[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(op.layer.params).toEqual(resolveParams(findEffect('tape-warp')!));
  });

  it('applies caller param overrides over the catalog defaults', () => {
    const ops = run(
      'apply_effect',
      { effectId: 'mosaic-block', startTime: 0, params: { size: 40 } },
      baseProject(withEffectTrack()),
    );
    const op = ops[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(op.layer.params['size']).toBe(40);
  });

  it('clamps an out-of-range param instead of forwarding it to a shader', () => {
    const ops = run(
      'apply_effect',
      { effectId: 'mosaic-block', startTime: 0, params: { size: 99999 } },
      baseProject(withEffectTrack()),
    );
    const op = ops[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(op.layer.params['size']).toBe(128);
  });

  it('drops a param the kind does not declare', () => {
    const ops = run(
      'apply_effect',
      { effectId: 'mosaic-block', startTime: 0, params: { nonsense: 1 } },
      baseProject(withEffectTrack()),
    );
    const op = ops[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(op.layer.params).not.toHaveProperty('nonsense');
  });

  it('carries intensity through when given, and omits it when not', () => {
    const withI = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 0, intensity: 0.3 },
      baseProject(withEffectTrack()),
    )[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    expect(withI.layer.intensity).toBe(0.3);

    const withoutI = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 0 },
      baseProject(withEffectTrack()),
    )[0] as Extract<Operation, { type: 'add_effect_layer' }>;
    // Absent, not 1: the canonical "full strength" form keeps undo deep-equal.
    expect(withoutI.layer.intensity).toBeUndefined();
  });

  it('rejects a hallucinated effect id with an actionable message', () => {
    // Thrown, not a no-op patch: the model must get the error back so it can
    // correct itself, rather than reporting a successful edit that did nothing.
    expect(() => run('apply_effect', { effectId: 'super-vhs-9000', startTime: 0 })).toThrow(
      /discover_effects/,
    );
  });

  it('rejects an endTime at or before startTime', () => {
    expect(() => run('apply_effect', { effectId: 'halo-bloom', startTime: 5, endTime: 5 })).toThrow(
      /greater than startTime/,
    );
  });

  it('produces a deterministic layer id for identical input', () => {
    const a = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 1.5 },
      baseProject(withEffectTrack()),
    );
    const b = run(
      'apply_effect',
      { effectId: 'halo-bloom', startTime: 1.5 },
      baseProject(withEffectTrack()),
    );
    expect(a).toEqual(b);
  });

  it('builds a schema-valid, appliable patch for EVERY catalog effect', () => {
    // The end-to-end guarantee behind "every effect is available to the AI".
    for (const effect of EFFECT_CATALOG) {
      const ops = run(
        'apply_effect',
        { effectId: effect.id, startTime: 0 },
        baseProject(withEffectTrack()),
      );
      let timeline: Timeline = { tracks: withEffectTrack() };
      for (const op of ops) timeline = applyOperation(timeline, op);
      const layers = effectLayersOf(
        timeline.tracks.find((t) => t.id === 'fx_1') as Timeline['tracks'][number],
      );
      expect(layers, effect.id).toHaveLength(1);
      expect(layers[0]?.kind, effect.id).toBe(effect.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// The other five mutators
// ---------------------------------------------------------------------------

describe('move_effect', () => {
  it('moves in time', () => {
    expect(run('move_effect', { layerId: 'fx-a', toStart: 4 })).toEqual([
      { type: 'move_effect_layer', layerId: 'fx-a', toStart: 4 },
    ]);
  });

  it('moves across lanes when a target is named', () => {
    expect(run('move_effect', { layerId: 'fx-a', toStart: 4, toTrackId: 'fx_2' })).toEqual([
      { type: 'move_effect_layer', layerId: 'fx-a', toStart: 4, toTrackId: 'fx_2' },
    ]);
  });

  it('rejects a negative start at the schema boundary', () => {
    expect(() => run('move_effect', { layerId: 'fx-a', toStart: -1 })).toThrow();
  });
});

describe('resize_effect', () => {
  it('sets both edges', () => {
    expect(run('resize_effect', { layerId: 'fx-a', start: 1, end: 3 })).toEqual([
      { type: 'trim_effect_layer', layerId: 'fx-a', start: 1, end: 3 },
    ]);
  });
});

describe('adjust_effect', () => {
  it('sends a partial param patch', () => {
    expect(run('adjust_effect', { layerId: 'fx-a', params: { size: 20 } })).toEqual([
      { type: 'set_effect_layer_params', layerId: 'fx-a', params: { size: 20 } },
    ]);
  });

  it('sets intensity', () => {
    expect(run('adjust_effect', { layerId: 'fx-a', intensity: 0.5 })).toEqual([
      { type: 'set_effect_layer_params', layerId: 'fx-a', intensity: 0.5 },
    ]);
  });

  it('clears intensity with null', () => {
    expect(run('adjust_effect', { layerId: 'fx-a', intensity: null })).toEqual([
      { type: 'set_effect_layer_params', layerId: 'fx-a', intensity: null },
    ]);
  });

  it('omits absent fields so a params-only call does not touch intensity', () => {
    const op = run('adjust_effect', { layerId: 'fx-a', params: { size: 8 } })[0];
    expect(op).not.toHaveProperty('intensity');
  });

  it('rejects an intensity outside 0..1', () => {
    expect(() => run('adjust_effect', { layerId: 'fx-a', intensity: 1.5 })).toThrow();
  });
});

describe('set_effect_enabled', () => {
  it('inverts enabled → disabled for the operation', () => {
    // The tool speaks the user's language ("enabled"); the op stores the
    // non-default state ("disabled"). Getting this backwards would make the AI
    // toggle do the opposite of what it says.
    expect(run('set_effect_enabled', { layerId: 'fx-a', enabled: false })).toEqual([
      { type: 'set_effect_layer_enabled', layerId: 'fx-a', disabled: true },
    ]);
    expect(run('set_effect_enabled', { layerId: 'fx-a', enabled: true })).toEqual([
      { type: 'set_effect_layer_enabled', layerId: 'fx-a', disabled: false },
    ]);
  });
});

describe('remove_effect', () => {
  it('removes by layer id', () => {
    expect(run('remove_effect', { layerId: 'fx-a' })).toEqual([
      { type: 'remove_effect_layer', layerId: 'fx-a' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Manual ↔ AI parity — the product requirement
// ---------------------------------------------------------------------------

describe('AI and manual editing produce identical timelines', () => {
  const seeded = (): Timeline => ({ tracks: withEffectTrack() });

  const applyAll = (timeline: Timeline, ops: readonly Operation[]): Timeline => {
    let out = timeline;
    for (const op of ops) out = applyOperation(out, op);
    return out;
  };

  it('applying an effect via the AI equals the manual operation', () => {
    const aiOps = run(
      'apply_effect',
      { effectId: 'tape-warp', startTime: 1, endTime: 3 },
      baseProject(withEffectTrack()),
    );
    const entry = findEffect('tape-warp')!;
    const manual: Operation[] = [
      {
        type: 'add_effect_layer',
        trackId: 'fx_1',
        layer: {
          // The id is the tool's deterministic scheme; a manual edit would use its
          // own, so it is taken from the AI op — every OTHER field must match.
          id: (aiOps[0] as Extract<Operation, { type: 'add_effect_layer' }>).layer.id,
          effectId: entry.id,
          kind: entry.kind,
          start: 1,
          end: 3,
          params: resolveParams(entry),
          keyframes: [],
        },
      },
    ];
    expect(applyAll(seeded(), aiOps)).toEqual(applyAll(seeded(), manual));
  });

  it('a full AI edit session round-trips through undo', () => {
    // Apply → adjust → move → resize → disable, then invert every step in
    // reverse. If the AI path produced anything the inverses do not cover, this
    // lands on a different timeline.
    const start = seeded();
    const applyOps = run(
      'apply_effect',
      { effectId: 'mosaic-block', startTime: 0, endTime: 2 },
      baseProject(withEffectTrack()),
    );
    const layerId = (applyOps[0] as Extract<Operation, { type: 'add_effect_layer' }>).layer.id;

    const session: Operation[] = [
      ...applyOps,
      ...run('adjust_effect', { layerId, params: { size: 48 } }),
      ...run('adjust_effect', { layerId, intensity: 0.6 }),
      ...run('move_effect', { layerId, toStart: 5 }),
      ...run('resize_effect', { layerId, start: 5, end: 9 }),
      ...run('set_effect_enabled', { layerId, enabled: false }),
    ];

    // Forward, recording the state each op saw so its inverse can be built.
    const states: Timeline[] = [];
    let current = start;
    for (const op of session) {
      states.push(current);
      current = applyOperation(current, op);
    }
    // Backward.
    for (let i = session.length - 1; i >= 0; i -= 1) {
      for (const inverse of invertOperation(states[i] as Timeline, session[i] as Operation)) {
        current = applyOperation(current, inverse);
      }
    }
    expect(current).toEqual(start);
  });

  it('stacking two effects via the AI combines them on one lane', () => {
    let timeline = seeded();
    timeline = applyAll(
      timeline,
      run(
        'apply_effect',
        { effectId: 'cine-grain', startTime: 0, endTime: 4 },
        baseProject(withEffectTrack()),
      ),
    );
    const project = baseProject(timeline.tracks);
    timeline = applyAll(
      timeline,
      run('apply_effect', { effectId: 'edge-fall', startTime: 1, endTime: 3 }, project),
    );
    const track = timeline.tracks.find((t) => t.id === 'fx_1') as Timeline['tracks'][number];
    expect(effectLayersOf(track)).toHaveLength(2);
  });
});
