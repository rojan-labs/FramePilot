/**
 * Catalog invariants. These are the rules a reviewer cannot check by eye across 77
 * entries, and every one of them has a failure mode that only shows up at render
 * time: a param the shader never receives, a direction the kind ignores, an id
 * that silently stopped matching what is stored in existing project files.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_TRANSITION_PARAM_NAMES,
  DEFAULT_TRANSITION_ID,
  LEGACY_TRANSITION_IDS,
  TRANSITION_CATALOG,
  TRANSITION_CATEGORIES,
  defaultDirectionFor,
  directionsForTransition,
  getTransition,
  resolveTransitionParams,
  searchTransitions,
  transitionsInCategory,
} from './transition-catalog.js';
import {
  TRANSITION_ALIGNMENTS,
  TRANSITION_APPLY_PATH,
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  TRANSITION_RENDER_KINDS,
  clampTransitionParams,
  defaultTransitionParams,
  readsUniversalParam,
  transitionParamsForKind,
} from './transition-params.js';

describe('transition catalog', () => {
  it('ships the promised breadth', () => {
    // The brief's floor is 50. Asserting the floor rather than the exact count
    // keeps adding entry 78 from being a test edit.
    expect(TRANSITION_CATALOG.length).toBeGreaterThanOrEqual(50);
  });

  it('has unique, stable, kebab-case ids', () => {
    const ids = TRANSITION_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('keeps every id that predates the catalog', () => {
    // These are stored in real project files. Losing one means a saved project
    // opens with a transition the catalog cannot name.
    for (const id of LEGACY_TRANSITION_IDS) expect(getTransition(id)).toBeDefined();
  });

  it('resolves the default id', () => {
    expect(getTransition(DEFAULT_TRANSITION_ID)).toBeDefined();
  });

  it('fills every category', () => {
    for (const category of TRANSITION_CATEGORIES) {
      expect(transitionsInCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  it('uses only declared categories', () => {
    const known = new Set(TRANSITION_CATEGORIES.map((c) => c.id));
    for (const t of TRANSITION_CATALOG) expect(known.has(t.category)).toBe(true);
  });

  it('exercises every render kind', () => {
    // An unused kind is a shader and a numpy pass nobody can reach from the UI.
    const used = new Set(TRANSITION_CATALOG.map((t) => t.renderKind));
    for (const kind of TRANSITION_RENDER_KINDS) expect(used.has(kind)).toBe(true);
  });

  it('only overrides params its render kind declares', () => {
    for (const t of TRANSITION_CATALOG) {
      const declared = new Set(TRANSITION_PARAMS[t.renderKind].map((d) => d.name));
      for (const name of Object.keys(t.params ?? {})) {
        expect({ id: t.id, name, declared: [...declared] }).toMatchObject({
          name: expect.stringMatching(new RegExp(`^(${[...declared].join('|')})$`)),
        });
      }
    }
  });

  it('overrides params only within their declared range', () => {
    for (const t of TRANSITION_CATALOG) {
      for (const descriptor of TRANSITION_PARAMS[t.renderKind]) {
        const value = t.params?.[descriptor.name];
        if (value === undefined) continue;
        expect(value, `${t.id}.${descriptor.name}`).toBeGreaterThanOrEqual(descriptor.min);
        expect(value, `${t.id}.${descriptor.name}`).toBeLessThanOrEqual(descriptor.max);
      }
    }
  });

  it('only names a direction its render kind accepts', () => {
    for (const t of TRANSITION_CATALOG) {
      if (t.direction === undefined) continue;
      expect(directionsForTransition(t), t.id).toContain(t.direction);
    }
  });

  it('resolves a direction for every directional kind', () => {
    for (const t of TRANSITION_CATALOG) {
      const allowed = directionsForTransition(t);
      const resolved = defaultDirectionFor(t);
      if (allowed.length === 0) expect(resolved).toBe('');
      else expect(allowed).toContain(resolved);
    }
  });

  it('gives every entry a positive duration except the cut', () => {
    for (const t of TRANSITION_CATALOG) {
      if (t.isCut) expect(t.defaultDuration).toBe(0);
      else expect(t.defaultDuration, t.id).toBeGreaterThan(0);
    }
  });

  it('has exactly one cut entry, and it is first', () => {
    const cuts = TRANSITION_CATALOG.filter((t) => t.isCut);
    expect(cuts).toHaveLength(1);
    expect(TRANSITION_CATALOG[0]?.isCut).toBe(true);
  });

  it('describes and tags every entry', () => {
    for (const t of TRANSITION_CATALOG) {
      expect(t.description.length, t.id).toBeGreaterThan(10);
      expect(t.tags.length, t.id).toBeGreaterThanOrEqual(3);
      expect(t.thumbnail.from).not.toBe(t.thumbnail.to);
    }
  });

  it('keeps intensity and softness overrides normalized', () => {
    for (const t of TRANSITION_CATALOG) {
      for (const value of [t.intensity, t.softness]) {
        if (value === undefined) continue;
        expect(value, t.id).toBeGreaterThanOrEqual(0);
        expect(value, t.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it('resolves params to the kind defaults plus overrides', () => {
    const flash = getTransition('flash');
    expect(flash).toBeDefined();
    const resolved = resolveTransitionParams(flash!);
    expect(resolved).toMatchObject({ red: 1, green: 1, blue: 1, blend: 1 });
    // Untouched params keep the kind default rather than vanishing.
    expect(resolved.hold).toBeCloseTo(0.08);
  });
});

describe('transition search', () => {
  it('returns the whole catalog for an empty query', () => {
    expect(searchTransitions('   ')).toHaveLength(TRANSITION_CATALOG.length);
  });

  it('finds every directional transition by its direction word', () => {
    // The brief's own example: "left" must surface slide, push, whip and wipe.
    const ids = searchTransitions('left').map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(['push', 'slide-left', 'whip-pan-left', 'wipe-left']),
    );
  });

  it('finds transitions by feel rather than by name', () => {
    expect(searchTransitions('cinematic').length).toBeGreaterThanOrEqual(3);
    expect(searchTransitions('fast').length).toBeGreaterThanOrEqual(3);
    expect(searchTransitions('social media').length).toBeGreaterThanOrEqual(2);
  });

  it('narrows on multiple terms rather than widening', () => {
    const soft = searchTransitions('soft');
    const softWipe = searchTransitions('soft wipe');
    expect(softWipe.length).toBeLessThan(soft.length);
    expect(softWipe.map((t) => t.id)).toContain('soft-wipe');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchTransitions('zzzznotathing')).toHaveLength(0);
  });
});

describe('transition params', () => {
  it('declares at least one param per kind, within MAX_PARAMS', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      const descriptors = TRANSITION_PARAMS[kind];
      expect(descriptors.length, kind).toBeGreaterThan(0);
      // The shader uploads params into a fixed `uParams[8]`.
      expect(descriptors.length, kind).toBeLessThanOrEqual(8);
    }
  });

  it('gives every param a unique name and an in-range default', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      const names = TRANSITION_PARAMS[kind].map((d) => d.name);
      expect(new Set(names).size, kind).toBe(names.length);
      for (const d of TRANSITION_PARAMS[kind]) {
        expect(d.default, `${kind}.${d.name}`).toBeGreaterThanOrEqual(d.min);
        expect(d.default, `${kind}.${d.name}`).toBeLessThanOrEqual(d.max);
        expect(d.max).toBeGreaterThan(d.min);
        expect(d.step).toBeGreaterThan(0);
      }
    }
  });

  it('indexes choice params from zero to the last choice', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      for (const d of TRANSITION_PARAMS[kind]) {
        if (!d.choices) continue;
        expect(d.min).toBe(0);
        expect(d.max).toBe(d.choices.length - 1);
        expect(d.step).toBe(1);
      }
    }
  });

  it('declares a path and a direction vocabulary for every kind', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      expect(TRANSITION_APPLY_PATH[kind]).toBeDefined();
      expect(TRANSITION_DIRECTIONS[kind]).toBeDefined();
      for (const direction of TRANSITION_DIRECTIONS[kind]) {
        expect(['left', 'right', 'up', 'down', 'in', 'out']).toContain(direction);
      }
    }
  });

  it('clamps out-of-range and unreadable params to the declared window', () => {
    const clamped = clampTransitionParams('mosaic', { blockPx: 9999 });
    expect(clamped.blockPx).toBe(160);
    expect(clampTransitionParams('mosaic', { blockPx: 'wide' }).blockPx).toBe(
      defaultTransitionParams('mosaic').blockPx,
    );
    // Unknown names are dropped rather than passed to a shader that has no slot.
    expect(clampTransitionParams('mosaic', { nonsense: 3 })).not.toHaveProperty('nonsense');
  });

  it('offers exactly the three alignments the inspector draws', () => {
    expect(TRANSITION_ALIGNMENTS).toEqual(['start', 'centre', 'end']);
  });

  it('answers which universal params a kind reads', () => {
    // The Inspector builds its controls from this; a wipe with an intensity
    // slider would be a knob the render ignores.
    expect(readsUniversalParam('wipe-linear', 'softness')).toBe(true);
    expect(readsUniversalParam('wipe-linear', 'intensity')).toBe(false);
    expect(readsUniversalParam('slide', 'intensity')).toBe(true);
    expect(readsUniversalParam('slide', 'softness')).toBe(false);
  });

  it('hands out a kind’s descriptors by reference to the declared table', () => {
    for (const kind of TRANSITION_RENDER_KINDS) {
      expect(transitionParamsForKind(kind)).toBe(TRANSITION_PARAMS[kind]);
    }
  });

  it('collects every param name for the validator', () => {
    expect(ALL_TRANSITION_PARAM_NAMES.has('blockPx')).toBe(true);
    expect(ALL_TRANSITION_PARAM_NAMES.has('nonsense')).toBe(false);
  });
});

describe('committed schema/transition-catalog.json (cross-language contract)', () => {
  // `test_transition_catalog.py` compares the engine's copy to this committed
  // artifact — both of them generated. Without this assertion nothing tied
  // either one back to the TypeScript source, so a catalog edit without
  // `schema:generate` shipped a transition the preview knows and the export
  // does not: the exact "previews as one thing, exports as another" failure the
  // engine-side test exists to prevent, arriving through the door it left open.
  it('matches the TS source (run `schema:generate` after editing the catalog or its params)', () => {
    const committed = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'schema',
          'transition-catalog.json',
        ),
        'utf-8',
      ),
    ) as unknown;
    expect({
      categories: TRANSITION_CATEGORIES,
      params: TRANSITION_PARAMS,
      directions: TRANSITION_DIRECTIONS,
      applyPath: TRANSITION_APPLY_PATH,
      transitions: TRANSITION_CATALOG,
    }).toEqual(committed);
  });
});
