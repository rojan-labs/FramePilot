/**
 * Pins the TS transition envelopes to the engine's `render/transitions.py`
 * semantics — same constants, same ramps — so live preview and export can never
 * drift apart silently.
 *
 * The revamp Phase 9 cases carry an extra obligation: every parameter default must
 * reproduce the pre-Phase-9 output **exactly**, or existing projects change look for
 * no reason the user asked for. Each default is asserted against the old constant
 * rather than against itself.
 */
import { describe, expect, it } from 'vitest';
import type { Clip } from '@framepilot/timeline-schema';
import {
  DEFAULT_SOFTNESS,
  WIPE_SOFTNESS,
  affectsBlur,
  affectsGeometry,
  affectsOpacity,
  affectsWipe,
  blurRadiusAt,
  easedProgress,
  offsetAt,
  opacityAt,
  resolvedDirection,
  scaleAt,
  transitionActiveAt,
  transitionFromClip,
  transitionProgress,
  type TransitionEnvelope,
  wipeAlpha,
  wipeAxis,
  wipeCssMask,
  wipeEdge,
  wipeProgressAt,
  wipeSoftness,
  zoomFrom,
} from './transition-envelope.js';

/** An envelope with every Phase 9 param at its default — i.e. pre-Phase-9 behaviour. */
const env = (
  kind: string,
  duration: number,
  overrides: Partial<TransitionEnvelope> = {},
): TransitionEnvelope => ({
  kind,
  duration,
  direction: '',
  intensity: 1,
  softness: DEFAULT_SOFTNESS,
  easing: 'linear',
  ...overrides,
});

const clip = (effects: Clip['effects']): Clip => ({
  id: 'c',
  assetId: 'a',
  trackId: 'v',
  start: 0,
  end: 2,
  sourceStart: 0,
  sourceEnd: 2,
  effects,
  keyframes: [],
});

const transitionClip = (params: Record<string, unknown>): Clip =>
  clip([{ id: 'c__transition', type: 'transition', params, keyframes: [] }]);

describe('transition-envelope (mirror of render/transitions.py)', () => {
  it('progress ramps linearly then holds; zero duration is instantly done', () => {
    expect(transitionProgress(0, 1)).toBe(0);
    expect(transitionProgress(0.5, 1)).toBeCloseTo(0.5);
    expect(transitionProgress(1, 1)).toBe(1);
    expect(transitionProgress(5, 1)).toBe(1);
    expect(transitionProgress(0.5, 0)).toBe(1);
  });

  it('kind predicates match the engine sets', () => {
    expect(affectsOpacity(env('fade', 1))).toBe(true);
    expect(affectsOpacity(env('cross-dissolve', 1))).toBe(true);
    expect(affectsGeometry(env('push', 1))).toBe(true);
    expect(affectsGeometry(env('zoom', 1))).toBe(true);
    expect(affectsGeometry(env('slide', 1))).toBe(true);
    expect(affectsBlur(env('blur', 1))).toBe(true);
    expect(affectsWipe(env('wipe', 1))).toBe(true);
    expect(affectsOpacity(env('cut', 1))).toBe(false);
    expect(affectsGeometry(env('cut', 1))).toBe(false);
  });

  it('fade opacity ramps 0→1; cut stays opaque', () => {
    const tr = env('fade', 1);
    expect(opacityAt(tr, 0)).toBe(0);
    expect(opacityAt(tr, 0.25)).toBeCloseTo(0.25);
    expect(opacityAt(tr, 1)).toBe(1);
    expect(opacityAt(env('cut', 1), 0)).toBe(1);
  });

  it('zoom scale decays from 1.6 to 1 (the engine _ZOOM_FROM)', () => {
    const tr = env('zoom', 1);
    expect(scaleAt(tr, 0)).toBeCloseTo(1.6);
    expect(scaleAt(tr, 0.5)).toBeCloseTo(1.3);
    expect(scaleAt(tr, 1)).toBeCloseTo(1);
    expect(scaleAt(env('fade', 1), 0)).toBe(1);
  });

  it('push enters from the right, slide from below, both settling at 0', () => {
    const push = env('push', 1);
    expect(offsetAt(push, 0, 1000, 500)).toEqual([1000, 0]);
    expect(offsetAt(push, 1, 1000, 500)).toEqual([0, 0]);
    const slide = env('slide', 1);
    expect(offsetAt(slide, 0, 1000, 500)).toEqual([0, 500]);
    expect(offsetAt(slide, 0.5, 1000, 500)[1]).toBeCloseTo(250);
    expect(offsetAt(slide, 1, 1000, 500)).toEqual([0, 0]);
    expect(offsetAt(env('zoom', 1), 0, 1000, 500)).toEqual([0, 0]);
  });

  it('blur radius starts at 4% of the min dimension and decays to 0', () => {
    const tr = env('blur', 1);
    expect(blurRadiusAt(tr, 0, 1000)).toBeCloseTo(40);
    expect(blurRadiusAt(tr, 1, 1000)).toBeCloseTo(0);
    expect(blurRadiusAt(env('fade', 1), 0, 1000)).toBe(0);
  });

  it('wipe reveals left→right with the soft edge fully clearing at p=1', () => {
    expect(wipeAlpha(0, 0)).toBe(0);
    expect(wipeAlpha(1, 0)).toBe(0);
    expect(wipeAlpha(0, 1)).toBe(1);
    expect(wipeAlpha(1, 1)).toBe(1);
    const p = 0.5;
    expect(wipeAlpha(wipeEdge(p) - WIPE_SOFTNESS, p)).toBeCloseTo(1);
    expect(wipeAlpha(wipeEdge(p) + 1e-9, p)).toBe(0);
    const inBand = wipeAlpha(wipeEdge(p) - WIPE_SOFTNESS / 2, p);
    expect(inBand).toBeGreaterThan(0);
    expect(inBand).toBeLessThan(1);
  });

  it('wipeProgressAt ramps only for wipe', () => {
    const tr = env('wipe', 1);
    expect(wipeProgressAt(tr, 0)).toBe(0);
    expect(wipeProgressAt(tr, 0.25)).toBeCloseTo(0.25);
    expect(wipeProgressAt(tr, 2)).toBe(1);
    expect(wipeProgressAt(env('fade', 1), 0)).toBe(1);
  });

  it('transitionActiveAt is true only while ramping a kind that does something', () => {
    expect(transitionActiveAt(env('fade', 1), 0.5)).toBe(true);
    expect(transitionActiveAt(env('fade', 1), 1)).toBe(false);
    expect(transitionActiveAt(env('cut', 1), 0.5)).toBe(false);
    for (const kind of ['cross-dissolve', 'push', 'zoom', 'slide', 'blur', 'wipe']) {
      expect(transitionActiveAt(env(kind, 1), 0.5)).toBe(true);
    }
  });

  it('transitionFromClip parses the incoming-clip effect (null on a plain cut)', () => {
    expect(transitionFromClip(clip([]))).toBeNull();
    const parsed = transitionFromClip(
      transitionClip({ kind: 'wipe', durationSeconds: 0.75, fromClipId: 'b' }),
    );
    expect(parsed).toEqual(env('wipe', 0.75));
  });
});

// ---------------------------------------------------------------------------
// Revamp Phase 9 — parameters (§4.3): no schema change, no behaviour change by
// default. Every case below either pins a default to the OLD constant or proves a
// param does something the render can actually produce.
// ---------------------------------------------------------------------------

describe('parameters default to exactly the pre-Phase-9 render', () => {
  it('parses missing params as the defaults, not as undefined', () => {
    const parsed = transitionFromClip(
      transitionClip({ kind: 'push', durationSeconds: 1, fromClipId: 'b' }),
    );
    expect(parsed).toEqual(env('push', 1));
  });

  it("easing defaults to LINEAR, not the sub-plan table's ease-in-out", () => {
    // Defaulting to a curve would silently re-time every transition in every
    // existing project — a change nobody asked for, visible only as "my dissolves
    // feel different".
    const tr = env('fade', 1);
    expect(tr.easing).toBe('linear');
    expect(easedProgress(tr, 0.25)).toBeCloseTo(0.25);
  });

  it('default softness reproduces the old WIPE_SOFTNESS constant exactly', () => {
    expect(wipeSoftness(env('wipe', 1))).toBeCloseTo(WIPE_SOFTNESS, 12);
  });

  it('default directions are the directions the render already used', () => {
    expect(resolvedDirection(env('push', 1))).toBe('left'); // started right, travelled left
    expect(resolvedDirection(env('slide', 1))).toBe('up'); // started below, travelled up
    expect(resolvedDirection(env('wipe', 1))).toBe('right');
    expect(resolvedDirection(env('zoom', 1))).toBe('in');
  });

  it('falls back to the default when a direction is not one this kind has', () => {
    // A stale param survives a kind swap on purpose (swap away and back and your
    // tuning returns), so it must be inert rather than wrong on the new kind.
    expect(resolvedDirection(env('push', 1, { direction: 'in' }))).toBe('left');
    expect(resolvedDirection(env('zoom', 1, { direction: 'left' }))).toBe('in');
  });

  it('coerces junk params instead of rendering NaN', () => {
    // `Effect.params` is free-form, so a value can arrive as a string from a
    // hand-edited project or an AI patch. A NaN offset is an invisible clip.
    const parsed = transitionFromClip(
      transitionClip({
        kind: 'push',
        durationSeconds: 'nonsense',
        intensity: 'x',
        softness: null,
        fromClipId: 'b',
      }),
    );
    expect(parsed?.duration).toBe(0);
    expect(parsed?.intensity).toBe(1);
    expect(parsed?.softness).toBeCloseTo(DEFAULT_SOFTNESS);
  });

  it('clamps intensity and softness into [0, 1]', () => {
    const parsed = transitionFromClip(
      transitionClip({
        kind: 'fade',
        durationSeconds: 1,
        intensity: 5,
        softness: -3,
        fromClipId: 'b',
      }),
    );
    expect(parsed?.intensity).toBe(1);
    expect(parsed?.softness).toBe(0);
  });
});

describe('easing shapes the whole effect, not one aspect of it', () => {
  it('applies the curve to opacity, geometry and blur alike', () => {
    // ease-in is t², so at the midpoint every envelope is a quarter of the way.
    const fade = env('fade', 1, { easing: 'ease-in' });
    expect(opacityAt(fade, 0.5)).toBeCloseTo(0.25);
    const push = env('push', 1, { easing: 'ease-in' });
    expect(offsetAt(push, 0.5, 1000, 500)[0]).toBeCloseTo(750);
    const blur = env('blur', 1, { easing: 'ease-in' });
    expect(blurRadiusAt(blur, 0.5, 1000)).toBeCloseTo(30);
  });

  it('an unknown easing name falls back to linear rather than throwing', () => {
    expect(easedProgress(env('fade', 1, { easing: 'wobble' }), 0.5)).toBeCloseTo(0.5);
  });

  it('still starts at 0 and ends at 1 whatever the curve', () => {
    for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'bezier']) {
      const tr = env('fade', 1, { easing });
      expect(opacityAt(tr, 0)).toBeCloseTo(0);
      expect(opacityAt(tr, 1)).toBeCloseTo(1);
    }
  });
});

describe('intensity scales how far the effect travels', () => {
  it('half a dissolve never fully loses the picture', () => {
    const tr = env('cross-dissolve', 1, { intensity: 0.5 });
    expect(opacityAt(tr, 0)).toBeCloseTo(0.5);
    expect(opacityAt(tr, 1)).toBeCloseTo(1);
  });

  it('zero intensity is a no-op for every kind that has a magnitude', () => {
    expect(opacityAt(env('fade', 1, { intensity: 0 }), 0)).toBeCloseTo(1);
    expect(offsetAt(env('push', 1, { intensity: 0 }), 0, 1000, 500)).toEqual([0, 0]);
    expect(scaleAt(env('zoom', 1, { intensity: 0 }), 0)).toBeCloseTo(1);
    expect(blurRadiusAt(env('blur', 1, { intensity: 0 }), 0, 1000)).toBeCloseTo(0);
  });

  it('scales a push and a blur proportionally', () => {
    expect(offsetAt(env('push', 1, { intensity: 0.5 }), 0, 1000, 500)[0]).toBeCloseTo(500);
    expect(blurRadiusAt(env('blur', 1, { intensity: 0.5 }), 0, 1000)).toBeCloseTo(20);
  });
});

describe('direction', () => {
  it('sends a push each of the four ways, always settling at rest', () => {
    // The clip starts one frame OPPOSITE its travel direction.
    expect(offsetAt(env('push', 1, { direction: 'left' }), 0, 1000, 500)).toEqual([1000, 0]);
    expect(offsetAt(env('push', 1, { direction: 'right' }), 0, 1000, 500)).toEqual([-1000, 0]);
    expect(offsetAt(env('push', 1, { direction: 'up' }), 0, 1000, 500)).toEqual([0, 500]);
    expect(offsetAt(env('push', 1, { direction: 'down' }), 0, 1000, 500)).toEqual([0, -500]);
    for (const direction of ['left', 'right', 'up', 'down']) {
      expect(offsetAt(env('push', 1, { direction }), 1, 1000, 500)).toEqual([0, 0]);
    }
  });

  it('zoom out starts smaller and grows, and is the reciprocal of zoom in', () => {
    const zoomIn = env('zoom', 1, { direction: 'in' });
    const zoomOut = env('zoom', 1, { direction: 'out' });
    expect(zoomFrom(zoomIn)).toBeCloseTo(1.6);
    expect(zoomFrom(zoomOut)).toBeCloseTo(1 / 1.6);
    // Never zero: a zero scale is a clip with no pixels at all.
    expect(zoomFrom(zoomOut)).toBeGreaterThan(0);
    expect(scaleAt(zoomOut, 1)).toBeCloseTo(1);
  });

  it('maps a wipe to a sweep axis, mirroring the fraction rather than forking the formula', () => {
    expect(wipeAxis(env('wipe', 1, { direction: 'right' }))).toEqual(['x', false]);
    expect(wipeAxis(env('wipe', 1, { direction: 'left' }))).toEqual(['x', true]);
    expect(wipeAxis(env('wipe', 1, { direction: 'down' }))).toEqual(['y', false]);
    expect(wipeAxis(env('wipe', 1, { direction: 'up' }))).toEqual(['y', true]);
  });

  it('gives the DOM preview a gradient that sweeps the same way', () => {
    // The canvas engine reads `wipeAxis` and the DOM player reads this. If the two
    // disagreed the two preview surfaces would wipe opposite ways from each other.
    expect(wipeCssMask(env('wipe', 1, { direction: 'right' }), 0.5)).toContain('to right');
    expect(wipeCssMask(env('wipe', 1, { direction: 'left' }), 0.5)).toContain('to left');
    expect(wipeCssMask(env('wipe', 1, { direction: 'down' }), 0.5)).toContain('to bottom');
    expect(wipeCssMask(env('wipe', 1, { direction: 'up' }), 0.5)).toContain('to top');
    expect(wipeCssMask(env('wipe', 1), 1)).toBeUndefined();
  });
});

describe('softness widens the wipe feather', () => {
  it('is bounded and never reaches zero', () => {
    // A zero feather divides by zero in the alpha formula, and a truly hard edge
    // shimmers at frame rate anyway.
    expect(wipeSoftness(env('wipe', 1, { softness: 0 }))).toBeGreaterThan(0);
    expect(wipeSoftness(env('wipe', 1, { softness: 1 }))).toBeCloseTo(0.25);
  });

  it('a wider feather reaches further ahead of the edge at the same progress', () => {
    const wide = wipeSoftness(env('wipe', 1, { softness: 1 }));
    // Probed just BEYOND the narrow feather's reveal (edge 0.525 at p=0.5). Probing
    // behind the edge proves nothing — both feathers are fully revealed there.
    expect(wipeAlpha(0.55, 0.5, WIPE_SOFTNESS)).toBe(0);
    const inBand = wipeAlpha(0.55, 0.5, wide);
    expect(inBand).toBeGreaterThan(0);
    expect(inBand).toBeLessThan(1);
  });

  it('still clears completely at p = 1 whatever the feather', () => {
    for (const softness of [0.05, 0.15, 0.25]) {
      expect(wipeAlpha(0, 1, softness)).toBe(1);
      expect(wipeAlpha(1, 1, softness)).toBe(1);
      expect(wipeAlpha(0.5, 0, softness)).toBe(0);
    }
  });
});
