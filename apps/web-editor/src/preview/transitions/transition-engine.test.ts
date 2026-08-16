import { describe, expect, it } from 'vitest';
import { TRANSITION_CATALOG } from '@framepilot/timeline-schema/transition-catalog';
import { TRANSITION_PARAMS } from '@framepilot/timeline-schema/transition-params';
import type { Clip } from '@framepilot/timeline-schema';
import {
  DEFAULT_SOFTNESS,
  MAX_TRANSITION_PARAMS,
  directionSign,
  directionVector,
  easedProgress,
  isInertTransition,
  resolveClipTransition,
  resolveTransitionParamsFor,
  transitionUniforms,
} from './transition-engine.js';

const resolve = (params: Record<string, unknown>) => resolveTransitionParamsFor(params)!;

describe('resolveTransitionParamsFor', () => {
  it('resolves every catalog entry', () => {
    for (const entry of TRANSITION_CATALOG) {
      const resolved = resolveTransitionParamsFor({ kind: entry.id, durationSeconds: 0.5 });
      expect(resolved, entry.id).not.toBeNull();
      expect(resolved!.renderKind).toBe(entry.renderKind);
    }
  });

  it('returns null for a kind the catalog does not have', () => {
    expect(resolveTransitionParamsFor({ kind: 'teleport' })).toBeNull();
  });

  it('layers kind defaults, then catalog overrides, then stored values', () => {
    // `whip-pan-left` overrides the kind's radius; a stored value beats both.
    expect(resolve({ kind: 'whip-pan-left' }).params.radius).toBeCloseTo(0.16);
    expect(resolve({ kind: 'whip-pan-left', radius: 0.02 }).params.radius).toBeCloseTo(0.02);
    // A param the entry never mentions still comes back at the kind default.
    expect(resolve({ kind: 'whip-pan-left' }).params.travel).toBeCloseTo(0.85);
  });

  it('clamps stored params into the declared range and ignores unreadable ones', () => {
    expect(resolve({ kind: 'mosaic', blockPx: 100000 }).params.blockPx).toBe(160);
    expect(resolve({ kind: 'mosaic', blockPx: 'huge' }).params.blockPx).toBe(48);
  });

  it('resolves direction against what the render kind accepts', () => {
    expect(resolve({ kind: 'push' }).direction).toBe('left');
    expect(resolve({ kind: 'push', direction: 'down' }).direction).toBe('down');
    // A direction the kind cannot express falls back rather than being honoured.
    expect(resolve({ kind: 'push', direction: 'in' }).direction).toBe('left');
    // A kind with no direction resolves to none, not to an arbitrary heading.
    expect(resolve({ kind: 'cross-dissolve', direction: 'left' }).direction).toBe('');
  });

  it('defaults the universal look params to what the engine has always used', () => {
    const plain = resolve({ kind: 'cross-dissolve' });
    expect(plain.intensity).toBe(1);
    expect(plain.softness).toBe(DEFAULT_SOFTNESS);
    expect(plain.easing).toBe('linear');
    expect(plain.alignment).toBe('start');
  });

  it('honours a catalog entry that states its own look', () => {
    expect(resolve({ kind: 'soft-wipe' }).softness).toBeCloseTo(0.85);
    expect(resolve({ kind: 'smooth-zoom' }).easing).toBe('ease-in-out');
  });

  it('clamps intensity and softness rather than trusting the file', () => {
    expect(resolve({ kind: 'fade', intensity: 4 }).intensity).toBe(1);
    expect(resolve({ kind: 'fade', intensity: -2 }).intensity).toBe(0);
  });

  it('falls back to the entry duration when none is stored', () => {
    expect(resolve({ kind: 'punch-zoom' }).duration).toBeCloseTo(0.22);
  });

  it('marks the hard cut', () => {
    expect(resolve({ kind: 'cut' }).isCut).toBe(true);
    expect(resolve({ kind: 'fade' }).isCut).toBe(false);
  });
});

describe('transitionUniforms', () => {
  it('lays params out in the order the kind declares them', () => {
    const uniforms = transitionUniforms(resolve({ kind: 'flash' }));
    const names = TRANSITION_PARAMS['dip-color'].map((d) => d.name);
    expect(names).toEqual(['red', 'green', 'blue', 'hold', 'blend']);
    expect(Array.from(uniforms.slice(0, 5))).toEqual([1, 1, 1, expect.closeTo(0.08), 1]);
  });

  it('is always MAX_TRANSITION_PARAMS long, with unused slots zeroed', () => {
    for (const entry of TRANSITION_CATALOG) {
      const uniforms = transitionUniforms(resolve({ kind: entry.id }));
      expect(uniforms).toHaveLength(MAX_TRANSITION_PARAMS);
      const declared = TRANSITION_PARAMS[entry.renderKind].length;
      for (let i = declared; i < MAX_TRANSITION_PARAMS; i += 1) {
        expect(uniforms[i], `${entry.id}[${i}]`).toBe(0);
      }
    }
  });
});

describe('direction encoding', () => {
  it('uses screen space, where y grows downward', () => {
    expect(directionVector('up')).toEqual([0, -1]);
    expect(directionVector('down')).toEqual([0, 1]);
    expect(directionVector('left')).toEqual([-1, 0]);
    expect(directionVector('right')).toEqual([1, 0]);
  });

  it('returns a zero vector for in/out and for no direction at all', () => {
    expect(directionVector('in')).toEqual([0, 0]);
    expect(directionVector('')).toEqual([0, 0]);
  });

  it('encodes in/out as a sign, not a heading', () => {
    expect(directionSign('in')).toBe(1);
    expect(directionSign('out')).toBe(-1);
    expect(directionSign('left')).toBe(0);
  });
});

describe('progress', () => {
  it('runs on the transition’s own curve', () => {
    const linear = resolve({ kind: 'cross-dissolve' });
    expect(easedProgress(linear, 0.25)).toBeCloseTo(0.25);
    const eased = resolve({ kind: 'cross-dissolve', easing: 'ease-in-out' });
    expect(easedProgress(eased, 0.25)).toBeLessThan(0.25);
    expect(easedProgress(eased, 0.5)).toBeCloseTo(0.5);
  });

  it('clamps out-of-range progress instead of extrapolating', () => {
    const t = resolve({ kind: 'cross-dissolve' });
    expect(easedProgress(t, -1)).toBe(0);
    expect(easedProgress(t, 5)).toBe(1);
  });

  it('reports a transition that cannot change anything as inert', () => {
    expect(isInertTransition(resolve({ kind: 'cut' }), 0)).toBe(true);
    expect(isInertTransition(resolve({ kind: 'fade', durationSeconds: 0 }), 0)).toBe(true);
    expect(isInertTransition(resolve({ kind: 'fade', durationSeconds: 1 }), 1)).toBe(true);
    expect(isInertTransition(resolve({ kind: 'fade', durationSeconds: 1 }), 0.5)).toBe(false);
  });
});

describe('resolveClipTransition', () => {
  const clip = (effects: Clip['effects']): Clip => ({
    id: 'c',
    assetId: 'a',
    trackId: 'v',
    start: 0,
    end: 4,
    sourceStart: 0,
    sourceEnd: 4,
    effects,
    keyframes: [],
  });

  it('reads the transition entering a clip', () => {
    const resolved = resolveClipTransition(
      clip([
        {
          id: 'c__transition',
          type: 'transition',
          params: { kind: 'glitch', durationSeconds: 0.3, fromClipId: 'b' },
          keyframes: [],
        },
      ]),
    );
    expect(resolved?.renderKind).toBe('glitch');
    expect(resolved?.duration).toBeCloseTo(0.3);
  });

  it('is null for a clip that enters on a cut', () => {
    expect(resolveClipTransition(clip([]))).toBeNull();
  });

  it('is null for a transition this build does not know', () => {
    // A project from a newer FramePilot must preview as a hard cut, not crash.
    expect(
      resolveClipTransition(
        clip([
          { id: 'c__transition', type: 'transition', params: { kind: 'teleport' }, keyframes: [] },
        ]),
      ),
    ).toBeNull();
  });
});
