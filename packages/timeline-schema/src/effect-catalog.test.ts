/**
 * Effect catalog + param-vocabulary invariants (schema v13, ADR 0088).
 *
 * These are the guards that keep the catalog pure data and the renderers
 * honest. The important ones are structural: if any of these fail, some effect
 * would reach a renderer that cannot draw it, or an Inspector control would
 * render for a param no shader reads — both are silent visual bugs rather than
 * crashes, which is exactly why they are asserted here.
 */
import { describe, expect, it } from 'vitest';
import {
  EFFECT_CATALOG,
  EFFECT_CATEGORIES,
  POPULAR_EFFECTS,
  RECOMMENDED_EFFECTS,
  effectsInCategory,
  findEffect,
  resolveParams,
  searchEffects,
} from './effect-catalog.js';
import {
  EFFECT_PARAMS,
  clampParamsForKind,
  defaultParamsForKind,
  paramsForKind,
} from './effect-params.js';
import {
  EffectLayerSchema,
  EffectRenderKindSchema,
  TrackSchema,
  TrackTypeSchema,
  activeEffectLayersAt,
  effectLayersOf,
  isEffectTrack,
  type EffectLayer,
  type Timeline,
  type Track,
} from './index.js';

const ALL_KINDS = EffectRenderKindSchema.options;

describe('effect catalog', () => {
  it('ships at least the 50 effects the product promises', () => {
    expect(EFFECT_CATALOG.length).toBeGreaterThanOrEqual(50);
  });

  it('has unique ids', () => {
    const ids = EFFECT_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique labels (two effects with one name is a UI bug)', () => {
    const labels = EFFECT_CATALOG.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('only uses render kinds the renderers dispatch on', () => {
    for (const effect of EFFECT_CATALOG) {
      expect(ALL_KINDS).toContain(effect.kind);
    }
  });

  it('only uses declared categories', () => {
    const declared = new Set(EFFECT_CATEGORIES.map((c) => c.id));
    for (const effect of EFFECT_CATALOG) {
      expect(declared.has(effect.category)).toBe(true);
    }
  });

  it('populates every category — an empty category rail entry is a dead end', () => {
    for (const category of EFFECT_CATEGORIES) {
      expect(effectsInCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  it('covers all 20 promised families', () => {
    expect(EFFECT_CATEGORIES).toHaveLength(20);
  });

  it('gives every effect a positive default duration', () => {
    for (const effect of EFFECT_CATALOG) {
      expect(effect.defaultDuration).toBeGreaterThan(0);
    }
  });

  it('gives every effect a thumbnail gradient and a description', () => {
    for (const effect of EFFECT_CATALOG) {
      expect(effect.thumbnail.gradient).toMatch(/gradient\(/);
      expect(effect.description.length).toBeGreaterThan(10);
    }
  });

  it('uses only valid hex colours in thumbnail gradients', () => {
    // A malformed stop makes the tile render transparent rather than error, so
    // it would ship unnoticed. (This test caught a 5-digit hex during authoring.)
    for (const effect of EFFECT_CATALOG) {
      for (const hex of effect.thumbnail.gradient.match(/#[0-9a-f]+/gi) ?? []) {
        expect(hex).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
      }
    }
  });

  it('gives every effect searchable tags', () => {
    for (const effect of EFFECT_CATALOG) {
      expect(effect.tags.length).toBeGreaterThan(0);
      // Lower-case, because `searchEffects` lower-cases the query and compares raw.
      for (const tag of effect.tags) expect(tag).toBe(tag.toLowerCase());
    }
  });

  it('only overrides params the kind actually declares', () => {
    for (const effect of EFFECT_CATALOG) {
      const declared = new Set(paramsForKind(effect.kind).map((p) => p.name));
      for (const name of Object.keys(effect.params ?? {})) {
        expect(declared, `${effect.id} overrides unknown param "${name}"`).toContain(name);
      }
    }
  });

  it('keeps every param override inside its declared range', () => {
    for (const effect of EFFECT_CATALOG) {
      for (const descriptor of paramsForKind(effect.kind)) {
        const value = effect.params?.[descriptor.name];
        if (value === undefined) continue;
        expect(value, `${effect.id}.${descriptor.name}`).toBeGreaterThanOrEqual(descriptor.min);
        expect(value, `${effect.id}.${descriptor.name}`).toBeLessThanOrEqual(descriptor.max);
      }
    }
  });

  it('resolves a complete param bag for every effect', () => {
    for (const effect of EFFECT_CATALOG) {
      const resolved = resolveParams(effect);
      for (const descriptor of paramsForKind(effect.kind)) {
        expect(resolved[descriptor.name]).toBeTypeOf('number');
      }
    }
  });

  it('exposes populated Popular and Recommended shelves', () => {
    expect(POPULAR_EFFECTS.length).toBeGreaterThanOrEqual(8);
    expect(RECOMMENDED_EFFECTS.length).toBeGreaterThanOrEqual(8);
  });

  it('finds effects by id and reports misses', () => {
    expect(findEffect('halo-bloom')?.label).toBe('Halo Bloom');
    expect(findEffect('does-not-exist')).toBeUndefined();
  });
});

describe('searchEffects', () => {
  it('returns everything for an empty query', () => {
    expect(searchEffects('   ')).toHaveLength(EFFECT_CATALOG.length);
  });

  it('matches on label', () => {
    expect(searchEffects('kaleido').map((e) => e.id)).toContain('kaleidoscope');
  });

  it('matches on a tag synonym the label does not contain', () => {
    // The point of tags: an editor types the industry term, not our name.
    expect(searchEffects('teal orange').map((e) => e.id)).toContain('teal-amber');
    expect(searchEffects('censor').map((e) => e.id)).toContain('mosaic-block');
    expect(searchEffects('8mm').map((e) => e.id)).toContain('super-eight');
  });

  it('matches on description text', () => {
    expect(searchEffects('newspaper').map((e) => e.id)).toContain('newsprint');
  });

  it('is case-insensitive', () => {
    expect(searchEffects('NEON').length).toBeGreaterThan(0);
  });

  it('returns nothing for a miss', () => {
    expect(searchEffects('zzzznotathing')).toHaveLength(0);
  });
});

describe('effect param vocabulary', () => {
  it('declares params for every render kind', () => {
    for (const kind of ALL_KINDS) {
      expect(EFFECT_PARAMS[kind], `kind "${kind}" has no params`).toBeDefined();
      expect(EFFECT_PARAMS[kind].length).toBeGreaterThan(0);
    }
  });

  it('declares no params for kinds outside the enum', () => {
    expect(Object.keys(EFFECT_PARAMS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('gives every param a default inside its own range', () => {
    for (const kind of ALL_KINDS) {
      for (const p of EFFECT_PARAMS[kind]) {
        expect(p.default, `${kind}.${p.name}`).toBeGreaterThanOrEqual(p.min);
        expect(p.default, `${kind}.${p.name}`).toBeLessThanOrEqual(p.max);
        expect(p.max).toBeGreaterThan(p.min);
        expect(p.step).toBeGreaterThan(0);
      }
    }
  });

  it('gives every param a unique name within its kind', () => {
    for (const kind of ALL_KINDS) {
      const names = EFFECT_PARAMS[kind].map((p) => p.name);
      expect(new Set(names).size, kind).toBe(names.length);
    }
  });

  it('keeps choice params integral and index-addressable', () => {
    for (const kind of ALL_KINDS) {
      for (const p of EFFECT_PARAMS[kind]) {
        if (!p.choices) continue;
        expect(p.step).toBe(1);
        expect(p.min).toBe(0);
        // max is the last valid index, so there are exactly max+1 choices.
        expect(p.choices).toHaveLength(p.max + 1);
      }
    }
  });

  it('builds a complete default bag per kind', () => {
    for (const kind of ALL_KINDS) {
      const defaults = defaultParamsForKind(kind);
      expect(Object.keys(defaults).sort()).toEqual(EFFECT_PARAMS[kind].map((p) => p.name).sort());
    }
  });
});

describe('clampParamsForKind', () => {
  it('clamps above-range values to max', () => {
    expect(clampParamsForKind('mosaic', { size: 9999 }).size).toBe(128);
  });

  it('clamps below-range values to min', () => {
    expect(clampParamsForKind('mosaic', { size: -50 }).size).toBe(2);
  });

  it('drops unknown param names rather than forwarding them to a shader', () => {
    const out = clampParamsForKind('mosaic', { size: 8, bogus: 1 });
    expect(out).toEqual({ size: 8 });
  });

  it('falls back to the default for NaN and non-numbers', () => {
    const fallback = defaultParamsForKind('mosaic').size;
    expect(clampParamsForKind('mosaic', { size: Number.NaN }).size).toBe(fallback);
    expect(clampParamsForKind('mosaic', { size: 'big' as unknown as number }).size).toBe(fallback);
  });

  it('fills every missing param from the kind defaults', () => {
    const out = clampParamsForKind('analog-vhs', {});
    expect(out).toEqual(defaultParamsForKind('analog-vhs'));
  });
});

describe('schema v13 shapes', () => {
  it('accepts the new effect track type', () => {
    expect(TrackTypeSchema.parse('effect')).toBe('effect');
  });

  it('still accepts every pre-v13 track type', () => {
    for (const type of ['video', 'audio', 'caption', 'overlay']) {
      expect(TrackTypeSchema.parse(type)).toBe(type);
    }
  });

  it('parses a minimal effect layer and defaults params/keyframes', () => {
    const layer = EffectLayerSchema.parse({
      id: 'fx1',
      effectId: 'halo-bloom',
      kind: 'bloom',
      start: 1,
      end: 3,
    });
    expect(layer.params).toEqual({});
    expect(layer.keyframes).toEqual([]);
    expect(layer.intensity).toBeUndefined();
    expect(layer.disabled).toBeUndefined();
  });

  it('rejects a zero- or negative-duration layer', () => {
    const base = { id: 'fx1', effectId: 'halo-bloom', kind: 'bloom' };
    expect(EffectLayerSchema.safeParse({ ...base, start: 2, end: 2 }).success).toBe(false);
    expect(EffectLayerSchema.safeParse({ ...base, start: 3, end: 1 }).success).toBe(false);
  });

  it('rejects an unknown render kind', () => {
    const bad = EffectLayerSchema.safeParse({
      id: 'fx1',
      effectId: 'x',
      kind: 'not-a-kind',
      start: 0,
      end: 1,
    });
    expect(bad.success).toBe(false);
  });

  it('bounds intensity to 0..1', () => {
    const base = { id: 'fx1', effectId: 'halo-bloom', kind: 'bloom', start: 0, end: 1 };
    expect(EffectLayerSchema.safeParse({ ...base, intensity: 1.5 }).success).toBe(false);
    expect(EffectLayerSchema.safeParse({ ...base, intensity: -0.1 }).success).toBe(false);
    expect(EffectLayerSchema.parse({ ...base, intensity: 0.5 }).intensity).toBe(0.5);
  });

  it('leaves effectLayers absent on a v12-shaped track (byte-identical round-trip)', () => {
    // The whole reason the field is optional rather than defaulted: parsing a
    // pre-v13 track must not inject a key that would then be written back out.
    const parsed = TrackSchema.parse({ id: 't1', type: 'video', clips: [] });
    expect('effectLayers' in parsed && parsed.effectLayers !== undefined).toBe(false);
  });

  it('every catalog effect produces a schema-valid layer', () => {
    // The end-to-end contract: catalog → layer must never need fixing up.
    for (const effect of EFFECT_CATALOG) {
      const parsed = EffectLayerSchema.safeParse({
        id: `fx-${effect.id}`,
        effectId: effect.id,
        kind: effect.kind,
        start: 0,
        end: effect.defaultDuration,
        params: resolveParams(effect),
      });
      expect(parsed.success, `${effect.id} → invalid layer`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer resolution — the "effects combine predictably" contract
// ---------------------------------------------------------------------------

const layer = (id: string, start: number, end: number, over: Partial<EffectLayer> = {}) =>
  EffectLayerSchema.parse({ id, effectId: 'halo-bloom', kind: 'bloom', start, end, ...over });

const fxTrack = (id: string, layers: readonly EffectLayer[], over: Partial<Track> = {}): Track =>
  TrackSchema.parse({ id, type: 'effect', clips: [], effectLayers: layers, ...over });

const timelineOf = (...tracks: Track[]): Timeline => ({ tracks, revision: 0 });

describe('effectLayersOf', () => {
  it('returns the layers when present', () => {
    const track = fxTrack('fx', [layer('a', 0, 1)]);
    expect(effectLayersOf(track).map((l) => l.id)).toEqual(['a']);
  });

  it('returns empty for a track that has never had effects', () => {
    const track = TrackSchema.parse({ id: 'v1', type: 'video', clips: [] });
    expect(effectLayersOf(track)).toEqual([]);
  });

  it('returns the SAME empty array each time (no hot-path allocation)', () => {
    const a = TrackSchema.parse({ id: 'v1', type: 'video', clips: [] });
    const b = TrackSchema.parse({ id: 'v2', type: 'audio', clips: [] });
    expect(effectLayersOf(a)).toBe(effectLayersOf(b));
  });
});

describe('isEffectTrack', () => {
  it('identifies effect tracks and nothing else', () => {
    expect(isEffectTrack(fxTrack('fx', []))).toBe(true);
    for (const type of ['video', 'audio', 'caption', 'overlay'] as const) {
      expect(isEffectTrack(TrackSchema.parse({ id: 't', type, clips: [] }))).toBe(false);
    }
  });
});

describe('activeEffectLayersAt', () => {
  it('includes a layer covering the time', () => {
    const tl = timelineOf(fxTrack('fx', [layer('a', 1, 3)]));
    expect(activeEffectLayersAt(tl, 2).map((e) => e.layer.id)).toEqual(['a']);
  });

  it('is inclusive of start and EXCLUSIVE of end, so abutting layers never double-fire', () => {
    const tl = timelineOf(fxTrack('fx', [layer('a', 0, 2), layer('b', 2, 4)]));
    expect(activeEffectLayersAt(tl, 2).map((e) => e.layer.id)).toEqual(['b']);
    expect(activeEffectLayersAt(tl, 0).map((e) => e.layer.id)).toEqual(['a']);
  });

  it('excludes times outside every layer', () => {
    const tl = timelineOf(fxTrack('fx', [layer('a', 1, 2)]));
    expect(activeEffectLayersAt(tl, 5)).toEqual([]);
  });

  it('skips disabled layers', () => {
    const tl = timelineOf(fxTrack('fx', [layer('a', 0, 5, { disabled: true }), layer('b', 0, 5)]));
    expect(activeEffectLayersAt(tl, 1).map((e) => e.layer.id)).toEqual(['b']);
  });

  it('skips layers on a hidden track', () => {
    const tl = timelineOf(fxTrack('fx', [layer('a', 0, 5)], { hidden: true }));
    expect(activeEffectLayersAt(tl, 1)).toEqual([]);
  });

  it('orders overlapping layers within a track by start time', () => {
    const tl = timelineOf(fxTrack('fx', [layer('late', 2, 6), layer('early', 0, 6)]));
    expect(activeEffectLayersAt(tl, 3).map((e) => e.layer.id)).toEqual(['early', 'late']);
  });

  it('applies LOWER tracks first — the bottom-up compositing contract', () => {
    // tracks[0] is the visual front, so it must run LAST: an effect on a track
    // above receives the frame the one below already changed.
    const tl = timelineOf(fxTrack('front', [layer('front-fx', 0, 5)]), fxTrack('back', [layer('back-fx', 0, 5)]));
    expect(activeEffectLayersAt(tl, 1).map((e) => e.layer.id)).toEqual(['back-fx', 'front-fx']);
  });

  it('reports the owning track alongside each layer', () => {
    const tl = timelineOf(fxTrack('fx-1', [layer('a', 0, 2)]));
    expect(activeEffectLayersAt(tl, 1)[0]?.track.id).toBe('fx-1');
  });

  it('ignores clip-bearing tracks that carry no effect layers', () => {
    const video = TrackSchema.parse({ id: 'v1', type: 'video', clips: [] });
    expect(activeEffectLayersAt(timelineOf(video), 1)).toEqual([]);
  });
});
