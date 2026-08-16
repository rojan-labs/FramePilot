/**
 * Which transition controls a kind can accept (revamp Phase 9, F7; catalog era).
 *
 * The single fact these tests exist to protect: **the inspector must never offer a
 * control the render ignores.** Which is why nothing here restates a table — the
 * assertions go through to `TRANSITION_DIRECTIONS` / `TRANSITION_UNIVERSAL_PARAMS`,
 * which a parity test in turn checks against the shaders themselves. Two hand-kept
 * copies is exactly how a phantom control gets shipped.
 */
import { describe, expect, it } from 'vitest';
import { TRANSITION_CATALOG } from '@framepilot/timeline-schema/transition-catalog';
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  readsUniversalParam,
} from '@framepilot/timeline-schema/transition-params';
import {
  EXCLUDED_EASINGS,
  TRANSITION_EASINGS,
  acceptsParam,
  allLookParamNames,
  defaultKindParamValue,
  defaultParamValue,
  directionsFor,
  isKindParamOverridden,
  isParamOverridden,
  kindParamsFor,
  readKindParam,
  readParam,
  renderKindOf,
} from './transition-params.js';

describe('which controls a kind accepts', () => {
  it('offers a direction exactly where its render kind has one', () => {
    for (const entry of TRANSITION_CATALOG) {
      expect(acceptsParam(entry.id, 'direction'), entry.id).toBe(
        TRANSITION_DIRECTIONS[entry.renderKind].length > 0,
      );
    }
  });

  it('offers intensity and softness exactly where the render kind reads them', () => {
    for (const entry of TRANSITION_CATALOG) {
      for (const param of ['intensity', 'softness'] as const) {
        expect(acceptsParam(entry.id, param), `${entry.id}.${param}`).toBe(
          readsUniversalParam(entry.renderKind, param),
        );
      }
    }
  });

  it('offers easing for every entry, because it shapes every envelope', () => {
    for (const entry of TRANSITION_CATALOG) {
      expect(acceptsParam(entry.id, 'easing'), entry.id).toBe(true);
    }
  });

  it('offers nothing at all for a kind this build does not know', () => {
    // A project written by a newer FramePilot: the section must render empty
    // rather than throwing or inventing controls.
    expect(renderKindOf('teleport')).toBeNull();
    for (const param of ['direction', 'intensity', 'softness', 'easing'] as const) {
      expect(acceptsParam('teleport', param)).toBe(false);
    }
    expect(kindParamsFor('teleport')).toEqual([]);
    expect(allLookParamNames('teleport')).toEqual([]);
  });

  it('surfaces the kind’s own numeric params, in the renderers’ order', () => {
    const names = kindParamsFor('flash').map((d) => d.name);
    expect(names).toEqual(TRANSITION_PARAMS['dip-color'].map((d) => d.name));
  });

  it('never offers an easing the engine treats as a trap', () => {
    for (const excluded of EXCLUDED_EASINGS) {
      expect(TRANSITION_EASINGS).not.toContain(excluded);
    }
  });
});

describe('what a control currently reads', () => {
  it('falls back to the catalog entry’s own look, not a global default', () => {
    // `soft-wipe` IS a wipe with a wide feather; showing the generic default
    // would make the inspector disagree with what is on screen.
    expect(defaultParamValue('soft-wipe', 'softness')).toBeCloseTo(0.85);
    expect(defaultParamValue('smooth-zoom', 'easing')).toBe('ease-in-out');
    expect(defaultParamValue('push-right', 'direction')).toBe('right');
  });

  it('resolves a direction the kind cannot express back to one it can', () => {
    expect(readParam({ direction: 'in' }, 'push', 'direction')).toBe('left');
    expect(readParam({ direction: 'down' }, 'push', 'direction')).toBe('down');
  });

  it('clamps a stored universal param rather than trusting the file', () => {
    expect(readParam({ intensity: 9 }, 'fade', 'intensity')).toBe(1);
    expect(readParam({ intensity: 'loud' }, 'fade', 'intensity')).toBe(1);
  });

  it('clamps a kind param to its own declared range', () => {
    expect(readKindParam({ blockPx: 1e6 }, 'mosaic', 'blockPx')).toBe(160);
    expect(readKindParam({}, 'mosaic', 'blockPx')).toBe(defaultKindParamValue('mosaic', 'blockPx'));
    expect(readKindParam({}, 'mosaic', 'nonsense')).toBe(0);
  });

  it('reports an override only when the value actually moved', () => {
    expect(isParamOverridden({}, 'push', 'direction')).toBe(false);
    expect(isParamOverridden({ direction: 'up' }, 'push', 'direction')).toBe(true);
    expect(isKindParamOverridden({}, 'mosaic', 'blockPx')).toBe(false);
    expect(isKindParamOverridden({ blockPx: 12 }, 'mosaic', 'blockPx')).toBe(true);
  });

  it('lists every look param a reset would have to clear', () => {
    const names = allLookParamNames('soft-wipe');
    expect(names).toContain('direction');
    expect(names).toContain('softness');
    expect(names).toContain('easing');
    expect(names).toContain('angle');
    // A wipe has no magnitude, so a reset must not pretend to clear one.
    expect(names).not.toContain('intensity');
  });
});

describe('directions', () => {
  it('are the render kind’s, not the entry’s', () => {
    expect(directionsFor('push')).toEqual(['left', 'right', 'up', 'down']);
    expect(directionsFor('zoom')).toEqual(['in', 'out']);
    expect(directionsFor('cross-dissolve')).toEqual([]);
  });
});
