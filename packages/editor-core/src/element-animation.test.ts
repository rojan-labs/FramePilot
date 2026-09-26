/**
 * Element animation (plan/elements EL7): In and Out are layer transitions from a curated set,
 * Loop is keyframes from the loop builder, and one request becomes one reversible set of
 * operations — the Inspector's Animation section and the agent's `set_element_animation` both
 * build through it.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';
import {
  ANIMATION_KINDS,
  clipAnimation,
  planElementAnimation,
  type ElementAnimationRequest,
} from './element-animation.js';

const FRAME = { width: 1920, height: 1080 } as const;

const sticker: Clip = {
  id: 'st',
  assetId: 'element_fluent3d_fire',
  trackId: 'o1',
  start: 1,
  end: 5,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [{ id: 'kf_st_scale', time: 0, property: 'scale', value: 0.4, easing: 'linear' }],
};

const title: Clip = {
  id: 'ti',
  assetId: '__text__',
  trackId: 'o2',
  start: 0,
  end: 3,
  sourceStart: 0,
  sourceEnd: 3,
  effects: [
    {
      id: 'ti__text',
      type: 'text',
      params: {
        text: 'HELLO',
        inAnimation: 'slide-up',
        outAnimation: 'fade',
        animDurationSeconds: 0.4,
      },
      keyframes: [],
    },
  ],
  keyframes: [],
};

const timeline: Timeline = {
  tracks: [
    { id: 'o2', type: 'overlay', clips: [title] },
    { id: 'o1', type: 'overlay', clips: [sticker] },
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'bg',
          assetId: 'land',
          trackId: 'v1',
          start: 0,
          end: 6,
          sourceStart: 0,
          sourceEnd: 6,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function animate(clipId: string, request: ElementAnimationRequest, from: Timeline = timeline) {
  const plan = planElementAnimation(from, clipId, request, FRAME);
  if (!plan.ok) throw new Error(plan.detail);
  const patch: Patch = {
    patchId: 'animate' as Patch['patchId'],
    createdBy: 'agent',
    reason: 'Animate',
    operations: plan.operations,
  };
  expect(
    validatePatch(from, patch, { assetIds: ['element_fluent3d_fire', 'land'] }).issues,
  ).toEqual([]);
  const after = applyPatch(from, patch);
  expect(applyPatch(after, invertPatch(from, patch))).toEqual(from);
  return after;
}

const clipOf = (tl: Timeline, id: string): Clip =>
  tl.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;

describe('planElementAnimation', () => {
  it('pops a sticker in, slides it out to the left, and pulses it, as one undoable edit', () => {
    const after = animate('st', {
      in: { kind: 'pop', seconds: 0.5 },
      out: { kind: 'slide-left', seconds: 0.6 },
      loop: { preset: 'pulse' },
    });
    const clip = clipOf(after, 'st');
    expect(clip.effects).toEqual([
      {
        id: 'st__transition',
        type: 'transition',
        params: { kind: 'zoom-out', durationSeconds: 0.5 },
        keyframes: [],
      },
      {
        id: 'st__transition_out',
        type: 'transition_out',
        // Leaving to the left is a slide that entered from the left, played backwards.
        params: { kind: 'slide-right', durationSeconds: 0.6, alignment: 'end' },
        keyframes: [],
      },
    ]);
    expect(clipAnimation(clip)).toEqual({
      in: { kind: 'pop', seconds: 0.5 },
      out: { kind: 'slide-left', seconds: 0.6 },
      loop: expect.objectContaining({ preset: 'pulse', coversClip: true }),
    });
  });

  it('names every In and Out it offers by where the layer goes, over a real catalogue kind', () => {
    for (const [kind, spec] of Object.entries(ANIMATION_KINDS)) {
      const after = animate('st', { in: { kind: spec.id }, out: { kind: spec.id } });
      expect(clipAnimation(clipOf(after, 'st')), kind).toMatchObject({
        in: { kind: spec.id },
        out: { kind: spec.id },
      });
    }
  });

  it('removes an In or an Out with null, and leaves what it is not asked about', () => {
    const animated = animate('st', { in: { kind: 'fade' }, out: { kind: 'wipe' } });
    const after = animate('st', { in: null }, animated);
    expect(clipAnimation(clipOf(after, 'st'))).toEqual({
      in: null,
      out: expect.objectContaining({ kind: 'wipe' }),
      loop: null,
    });
  });

  it('moves a title off its old In/Out onto layer transitions, keeping what it had otherwise', () => {
    // The title reads its legacy In/Out until the animation is set, and the new In replaces it.
    expect(clipAnimation(title)).toEqual({
      in: { kind: 'slide-up', seconds: 0.4 },
      out: { kind: 'fade', seconds: 0.4 },
      loop: null,
    });
    const after = animate('ti', { in: { kind: 'pop', seconds: 0.3 } });
    const clip = clipOf(after, 'ti');
    const text = clip.effects.find((effect) => effect.type === 'text')!;
    expect(text.params.inAnimation).toBeUndefined();
    expect(text.params.outAnimation).toBe('fade');
    expect(clipAnimation(clip)).toEqual({
      in: { kind: 'pop', seconds: 0.3 },
      out: { kind: 'fade', seconds: 0.4 },
      loop: null,
    });
  });

  it('refuses what is not a graphic, an unknown kind, and nothing to do, each with a way on', () => {
    const notGraphic = planElementAnimation(timeline, 'bg', { in: { kind: 'pop' } }, FRAME);
    expect(notGraphic).toMatchObject({ ok: false });
    const unknown = planElementAnimation(
      timeline,
      'st',
      { in: { kind: 'teleport' as never } },
      FRAME,
    );
    expect(unknown).toMatchObject({ ok: false });
    const nothing = planElementAnimation(timeline, 'st', {}, FRAME);
    expect(nothing).toMatchObject({ ok: false });
    for (const refusal of [notGraphic, unknown, nothing]) {
      if (!refusal.ok) expect(refusal.detail).not.toMatch(/\d/);
    }
  });

  it('passes a loop’s refusal on in the loop builder’s words', () => {
    const animated: Clip = {
      ...sticker,
      keyframes: [
        ...sticker.keyframes,
        { id: 'kf_grow', time: 2, property: 'scale', value: 0.8, easing: 'linear' },
      ],
    };
    const plan = planElementAnimation(
      { tracks: [{ id: 'o1', type: 'overlay', clips: [animated] }] },
      'st',
      { loop: { preset: 'pulse' } },
      FRAME,
    );
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.detail).toContain('already animated');
  });
});
