/**
 * Loop motion (plan/elements EL7.2): a looping animation is ordinary keyframes over the clip's
 * span, written by one builder — pulse, float, wiggle, bounce, spin, blink — so it validates,
 * inverts, saves and renders through paths that already exist. One patch, one undo.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Timeline } from '@framepilot/timeline-schema';
import { evaluateKeyframes } from '@framepilot/timeline-schema/keyframe-curves';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';
import {
  LOOP_PRESETS,
  LOOP_PRESET_INFO,
  clearLoopOperations,
  clipLoop,
  planLoopMotion,
  type LoopPreset,
} from './loop-motion.js';

const FRAME = { width: 1920, height: 1080 } as const;

/** A sticker as the Stickers tab places it: its base transform keyed at time 0. */
function sticker(extra: Partial<Clip> = {}): Clip {
  const base = (property: string, value: number): Keyframe => ({
    id: `kf_st_${property}`,
    time: 0,
    property,
    value,
    easing: 'linear',
  });
  return {
    id: 'st',
    assetId: 'element_fluent3d_fire',
    trackId: 'o1',
    start: 2,
    end: 5,
    sourceStart: 0,
    sourceEnd: 3,
    effects: [],
    keyframes: [base('scale', 0.4), base('x', 120), base('y', -80)],
    ...extra,
  };
}

const timelineWith = (clip: Clip): Timeline => ({
  tracks: [{ id: 'o1', type: 'overlay', clips: [clip] }],
});

function apply(clip: Clip, operations: Patch['operations']): Clip {
  const patch: Patch = {
    patchId: 'loop' as Patch['patchId'],
    createdBy: 'user',
    reason: 'Loop',
    operations,
  };
  const before = timelineWith(clip);
  expect(validatePatch(before, patch, { assetIds: [clip.assetId] }).issues).toEqual([]);
  const after = applyPatch(before, patch);
  // One undo takes it all back.
  expect(applyPatch(after, invertPatch(before, patch))).toEqual(before);
  return after.tracks[0]!.clips[0]!;
}

const at = (clip: Clip, property: string, t: number): number | undefined =>
  evaluateKeyframes(clip.keyframes, property, t);

describe('planLoopMotion', () => {
  it('pulses a sticker around its own size, and leaves its position alone', () => {
    const plan = planLoopMotion(
      sticker(),
      { preset: 'pulse', periodSeconds: 1, amount: 0.1 },
      FRAME,
    );
    if (!plan.ok) throw new Error(plan.detail);
    expect(plan.property).toBe('scale');
    const looped = apply(sticker(), plan.operations);
    expect(at(looped, 'scale', 0)).toBeCloseTo(0.4);
    expect(at(looped, 'scale', 0.25)).toBeCloseTo(0.44);
    expect(at(looped, 'scale', 0.5)).toBeCloseTo(0.4);
    expect(at(looped, 'scale', 0.75)).toBeCloseTo(0.36);
    expect(at(looped, 'scale', 2.25)).toBeCloseTo(0.44);
    // Position keeps its placement.
    expect(at(looped, 'x', 1)).toBe(120);
    expect(at(looped, 'y', 1)).toBe(-80);
  });

  it('animates the property each preset names, within what that property may be', () => {
    const expected: Record<LoopPreset, string> = {
      pulse: 'scale',
      float: 'y',
      wiggle: 'rotation',
      bounce: 'y',
      spin: 'rotation',
      blink: 'opacity',
    };
    for (const preset of LOOP_PRESETS) {
      const plan = planLoopMotion(sticker(), { preset }, FRAME);
      if (!plan.ok) throw new Error(`${preset}: ${plan.detail}`);
      expect(plan.property, preset).toBe(expected[preset]);
      expect(LOOP_PRESET_INFO[preset].property).toBe(expected[preset]);
      const looped = apply(sticker(), plan.operations);
      for (let t = 0; t <= 3; t += 0.05) {
        const value = at(looped, plan.property, t)!;
        if (plan.property === 'opacity') expect(value).toBeGreaterThanOrEqual(0);
        if (plan.property === 'opacity') expect(value).toBeLessThanOrEqual(1);
        if (plan.property === 'scale') expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('floats and bounces in frame pixels, so the motion is the same share of any frame', () => {
    const float = planLoopMotion(
      sticker(),
      { preset: 'float', periodSeconds: 2, amount: 0.02 },
      FRAME,
    );
    if (!float.ok) throw new Error(float.detail);
    const floated = apply(sticker(), float.operations);
    expect(at(floated, 'y', 0.5)! - -80).toBeCloseTo(0.02 * 1080);
    const bounce = planLoopMotion(
      sticker(),
      { preset: 'bounce', periodSeconds: 1, amount: 0.05 },
      FRAME,
    );
    if (!bounce.ok) throw new Error(bounce.detail);
    const bounced = apply(sticker(), bounce.operations);
    // Up is negative y; it lands back where it was placed.
    expect(at(bounced, 'y', 0.5)).toBeCloseTo(-80 - 0.05 * 1080);
    expect(at(bounced, 'y', 1)).toBeCloseTo(-80);
  });

  it('spins at a steady rate with two keyframes, whatever the clip length', () => {
    const plan = planLoopMotion(sticker(), { preset: 'spin', periodSeconds: 1.5 }, FRAME);
    if (!plan.ok) throw new Error(plan.detail);
    const spun = apply(sticker(), plan.operations);
    const rotations = spun.keyframes.filter((k) => k.property === 'rotation');
    expect(rotations.map((k) => [k.time, k.value, k.easing])).toEqual([
      [0, 0, 'linear'],
      [3, 720, 'linear'],
    ]);
  });

  it('reads a loop back, and knows when the clip has outgrown it', () => {
    const plan = planLoopMotion(
      sticker(),
      { preset: 'wiggle', periodSeconds: 0.5, amount: 6 },
      FRAME,
    );
    if (!plan.ok) throw new Error(plan.detail);
    const looped = apply(sticker(), plan.operations);
    expect(clipLoop(looped)).toEqual({
      preset: 'wiggle',
      property: 'rotation',
      periodSeconds: 0.5,
      amount: 6,
      coversClip: true,
    });
    expect(clipLoop({ ...looped, end: looped.end + 2 })?.coversClip).toBe(false);
    expect(clipLoop(sticker())).toBeNull();
  });

  it('replaces a loop with another, and clears one back to the placement', () => {
    const pulse = planLoopMotion(sticker(), { preset: 'pulse' }, FRAME);
    if (!pulse.ok) throw new Error(pulse.detail);
    const pulsing = apply(sticker(), pulse.operations);
    const wiggle = planLoopMotion(pulsing, { preset: 'wiggle' }, FRAME);
    if (!wiggle.ok) throw new Error(wiggle.detail);
    const wiggling = apply(pulsing, wiggle.operations);
    // The pulse is gone, its size restored; only the wiggle loops.
    expect(clipLoop(wiggling)?.preset).toBe('wiggle');
    expect(
      wiggling.keyframes.filter((k) => k.property === 'scale').map((k) => [k.time, k.value]),
    ).toEqual([[0, 0.4]]);
    const cleared = apply(wiggling, clearLoopOperations(wiggling));
    expect(clipLoop(cleared)).toBeNull();
    expect(at(cleared, 'rotation', 1)).toBe(0);
    expect(at(cleared, 'scale', 1)).toBeCloseTo(0.4);
    expect(clearLoopOperations(sticker())).toEqual([]);
  });

  it('will not loop over animation the clip already has, or loop a clip too short to move', () => {
    const animated = sticker({
      keyframes: [
        ...sticker().keyframes,
        { id: 'kf_grow', time: 2, property: 'scale', value: 0.8, easing: 'linear' },
      ],
    });
    const refused = planLoopMotion(animated, { preset: 'pulse' }, FRAME);
    expect(refused).toMatchObject({ ok: false, reason: 'property_animated' });
    if (!refused.ok) expect(refused.detail).not.toMatch(/\d/);
    // Another property is free.
    expect(planLoopMotion(animated, { preset: 'wiggle' }, FRAME).ok).toBe(true);
    const tiny = planLoopMotion(
      sticker({ end: 2.05, sourceEnd: 0.05 }),
      { preset: 'float' },
      FRAME,
    );
    expect(tiny).toMatchObject({ ok: false, reason: 'clip_too_short' });
    if (!tiny.ok) expect(tiny.detail).not.toMatch(/\d/);
  });

  it('holds period and amount to each preset’s range', () => {
    const plan = planLoopMotion(
      sticker(),
      { preset: 'pulse', periodSeconds: 0.01, amount: 9 },
      FRAME,
    );
    if (!plan.ok) throw new Error(plan.detail);
    const looped = apply(sticker(), plan.operations);
    const loop = clipLoop(looped)!;
    expect(loop.periodSeconds).toBe(LOOP_PRESET_INFO.pulse.period.min);
    expect(loop.amount).toBe(LOOP_PRESET_INFO.pulse.amount.max);
  });
});
