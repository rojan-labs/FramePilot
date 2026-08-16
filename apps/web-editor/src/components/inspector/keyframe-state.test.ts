/**
 * Tests for the keyframe diamond's state model (revamp Phase 5).
 *
 * The five diamond states are the whole phase — a diamond that reads "no keyframe"
 * where one exists tells the user that clicking will add one, and then it removes
 * one instead. So the arithmetic is tested directly rather than through a render.
 */
import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@framepilot/timeline-schema';
import {
  ANIMATABLE_DEFAULTS,
  ANIMATABLE_PROPERTIES,
  animatedProperties,
  displayValue,
  keyframeStateAt,
  sameKeyframeTime,
} from './keyframe-state.js';

const kf = (property: string, time: number, value: number, easing = 'linear'): Keyframe =>
  ({ id: `${property}_${time}`, property, time, value, easing }) as Keyframe;

/** scale ramping 1 → 2 across 0…2s, plus an unrelated x keyframe. */
const animated: readonly Keyframe[] = [kf('scale', 0, 1), kf('scale', 2, 2), kf('x', 1, 10)];

describe('ANIMATABLE_PROPERTIES', () => {
  it('is exactly the set the render composites', () => {
    // Guards the render-honesty rule: a diamond on a property `evaluate_clip_transform`
    // ignores would animate the preview and not the export. If this list grows, the
    // Python transform must have grown first.
    expect([...ANIMATABLE_PROPERTIES]).toEqual(['scale', 'x', 'y', 'rotation', 'opacity']);
  });

  it('excludes volume, which is an effect param and not a keyframed property', () => {
    expect(ANIMATABLE_PROPERTIES as readonly string[]).not.toContain('volume');
    expect(ANIMATABLE_PROPERTIES as readonly string[]).not.toContain('gainDb');
  });

  it('has an identity default for every property', () => {
    for (const property of ANIMATABLE_PROPERTIES) {
      expect(ANIMATABLE_DEFAULTS[property]).toBeTypeOf('number');
    }
    expect(ANIMATABLE_DEFAULTS.scale).toBe(1);
    expect(ANIMATABLE_DEFAULTS.opacity).toBe(1);
    expect(ANIMATABLE_DEFAULTS.rotation).toBe(0);
  });
});

describe('sameKeyframeTime', () => {
  it('uses the engine epsilon, so the diamond agrees with what replace does', () => {
    // A UI tolerance looser or tighter than the engine's is the bug this exists to
    // prevent: the diamond would read empty while `replace: true` swapped a keyframe.
    expect(sameKeyframeTime(1, 1.0005)).toBe(true);
    expect(sameKeyframeTime(1, 1.001)).toBe(true);
    expect(sameKeyframeTime(1, 1.002)).toBe(false);
  });
});

describe('keyframeStateAt', () => {
  it('reports `none` for a property with no keyframes', () => {
    const state = keyframeStateAt(animated, 'rotation', 1);
    expect(state.status).toBe('none');
    expect(state.points).toEqual([]);
    expect(state.curveValue).toBeUndefined();
    expect(state.willCreateKeyframe).toBe(false);
  });

  it('reports `at-playhead` when a keyframe sits on the playhead', () => {
    const state = keyframeStateAt(animated, 'scale', 2);
    expect(state.status).toBe('at-playhead');
    expect(state.atPlayhead?.value).toBe(2);
    // Editing here rewrites the existing keyframe, so nothing new is created.
    expect(state.willCreateKeyframe).toBe(false);
  });

  it('matches a playhead within the epsilon of a keyframe', () => {
    expect(keyframeStateAt(animated, 'scale', 2.0008).status).toBe('at-playhead');
    expect(keyframeStateAt(animated, 'scale', 2.05).status).toBe('animated');
  });

  it('reports `animated` between keyframes, and warns a write would add one', () => {
    const state = keyframeStateAt(animated, 'scale', 1);
    expect(state.status).toBe('animated');
    expect(state.atPlayhead).toBeUndefined();
    expect(state.willCreateKeyframe).toBe(true);
  });

  it('evaluates the curve at the playhead, not the base value', () => {
    // The number in the panel must be the number the render uses; showing the base
    // (1) halfway through a 1→2 ramp would disagree with the picture in the monitor.
    expect(keyframeStateAt(animated, 'scale', 1).curveValue).toBeCloseTo(1.5);
    expect(keyframeStateAt(animated, 'scale', 0).curveValue).toBe(1);
    expect(keyframeStateAt(animated, 'scale', 2).curveValue).toBe(2);
  });

  it('holds the end values outside the animated span, matching the engine', () => {
    expect(keyframeStateAt(animated, 'scale', -5).curveValue).toBe(1);
    expect(keyframeStateAt(animated, 'scale', 99).curveValue).toBe(2);
  });

  it('sorts points ascending regardless of stored order', () => {
    const unsorted = [kf('scale', 3, 3), kf('scale', 1, 1), kf('scale', 2, 2)];
    expect(keyframeStateAt(unsorted, 'scale', 0).points.map((p) => p.time)).toEqual([1, 2, 3]);
  });

  it('finds the neighbouring keyframes for the chevrons', () => {
    const points = [kf('scale', 0, 1), kf('scale', 2, 2), kf('scale', 4, 3)];
    const middle = keyframeStateAt(points, 'scale', 3);
    expect(middle.prevTime).toBe(2);
    expect(middle.nextTime).toBe(4);
  });

  it('leaves prev undefined at the first keyframe and next undefined at the last', () => {
    // Which is what disables the chevrons — a chevron that looks enabled and does
    // nothing is worse than one that says it cannot go further.
    const first = keyframeStateAt(animated, 'scale', 0);
    expect(first.prevTime).toBeUndefined();
    expect(first.nextTime).toBe(2);

    const last = keyframeStateAt(animated, 'scale', 2);
    expect(last.prevTime).toBe(0);
    expect(last.nextTime).toBeUndefined();
  });

  it('never counts the keyframe AT the playhead as prev or next', () => {
    // The three buckets partition the keyframes: within-epsilon belongs to
    // `atPlayhead` only, so "next" cannot be a keyframe you are already standing on.
    const state = keyframeStateAt(animated, 'scale', 2.0005);
    expect(state.atPlayhead?.time).toBe(2);
    expect(state.nextTime).toBeUndefined();
    expect(state.prevTime).toBe(0);
  });

  it('ignores other properties entirely', () => {
    const state = keyframeStateAt(animated, 'x', 1);
    expect(state.status).toBe('at-playhead');
    expect(state.points).toHaveLength(1);
  });
});

describe('displayValue', () => {
  it('prefers the curve when animated and the base otherwise', () => {
    expect(displayValue(keyframeStateAt(animated, 'scale', 1), 99)).toBeCloseTo(1.5);
    expect(displayValue(keyframeStateAt(animated, 'rotation', 1), 45)).toBe(45);
  });
});

describe('animatedProperties', () => {
  it('lists only animatable properties that carry keyframes, in declaration order', () => {
    expect(animatedProperties(animated)).toEqual(['scale', 'x']);
  });

  it('returns nothing for an un-animated clip', () => {
    expect(animatedProperties([])).toEqual([]);
  });

  it('ignores keyframes for properties outside the animatable set', () => {
    // An effect or a future property should not appear in a summary of what the
    // transform rows can show.
    expect(animatedProperties([kf('mysteryParam', 0, 1)])).toEqual([]);
  });
});
