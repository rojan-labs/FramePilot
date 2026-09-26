/**
 * `add_shape` (schema v25, plan/elements EL4a): a typed, validated, reversible op, and a shape's
 * params stay drawable through every later `set_effect_params`.
 */
import { describe, expect, it } from 'vitest';
import { presetShapeParams, type Timeline } from '@framepilot/timeline-schema';
import {
  OperationError,
  applyOperation,
  invertOperation,
  shapeClipId,
  shapeEffectId,
  type Operation,
} from './operations.js';
import { SHAPE_ASSET_ID } from './synthetic-assets.js';
import { validatePatch } from './validator.js';

const box = presetShapeParams('rounded-rect/highlight')!;
const arrow = presetShapeParams('line-arrow/red')!;

const timeline: Timeline = {
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'v1',
          start: 0,
          end: 10,
          sourceStart: 0,
          sourceEnd: 10,
          effects: [],
          keyframes: [],
        },
      ],
    },
    { id: 'o1', type: 'overlay', clips: [] },
  ],
};

const add: Operation = { type: 'add_shape', trackId: 'o1', start: 2, end: 5, params: box };

describe('add_shape', () => {
  it('adds a shape clip carrying one shape effect with the params', () => {
    const after = applyOperation(timeline, add);
    const clip = after.tracks[1]!.clips[0]!;
    expect(clip).toMatchObject({
      id: shapeClipId('o1', 2),
      assetId: SHAPE_ASSET_ID,
      start: 2,
      end: 5,
      sourceStart: 0,
      sourceEnd: 3,
    });
    expect(clip.effects).toEqual([
      { id: shapeEffectId(clip.id), type: 'shape', params: box, keyframes: [] },
    ]);
  });

  it('inverts to exactly the timeline before', () => {
    const after = applyOperation(timeline, add);
    const undo = invertOperation(timeline, add);
    const restored = undo.reduce((state, op) => applyOperation(state, op), after);
    expect(restored).toEqual(timeline);
  });

  it('derives the same id every time, and honours an explicit one', () => {
    expect(applyOperation(timeline, add).tracks[1]!.clips[0]!.id).toBe('shape__o1_2000');
    const named = applyOperation(timeline, { ...add, clipId: 'callout' } as Operation);
    expect(named.tracks[1]!.clips[0]!.id).toBe('callout');
  });

  it('refuses params that cannot be drawn, with the remedy', () => {
    const bad = { ...add, params: { ...box, fill: null, stroke: null } } as Operation;
    expect(() => applyOperation(timeline, bad)).toThrow(OperationError);
    expect(() => applyOperation(timeline, bad)).toThrow(
      'A shape needs a fill or a stroke — with both off it draws nothing.',
    );
  });

  it('refuses a shape over another clip on the same lane', () => {
    const once = applyOperation(timeline, add);
    const overlapping = { ...add, start: 3, end: 6, clipId: 'second' } as Operation;
    const result = validatePatch(once, {
      patchId: 'p',
      createdBy: 'user',
      reason: 'overlap',
      operations: [overlapping],
    });
    expect(result.valid).toBe(false);
  });

  it('passes the validator as a patch', () => {
    const result = validatePatch(timeline, {
      patchId: 'p',
      createdBy: 'ai',
      reason: 'highlight',
      operations: [add],
    });
    expect(result.valid).toBe(true);
  });
});

describe('set_effect_params on a shape', () => {
  const withShape = applyOperation(timeline, add);
  const clipId = shapeClipId('o1', 2);
  const effectId = shapeEffectId(clipId);

  it('restyles, and inverts', () => {
    const op: Operation = {
      type: 'set_effect_params',
      clipId,
      effectId,
      params: { stroke: '#FF3B30', strokeWidth: 1.5 },
    };
    const after = applyOperation(withShape, op);
    expect(after.tracks[1]!.clips[0]!.effects[0]!.params).toMatchObject({
      stroke: '#FF3B30',
      strokeWidth: 1.5,
      shape: 'rounded-rect',
    });
    const restored = invertOperation(withShape, op).reduce(
      (state, inverse) => applyOperation(state, inverse),
      after,
    );
    expect(restored).toEqual(withShape);
  });

  it('refuses a merge that would leave the shape undrawable', () => {
    const op: Operation = {
      type: 'set_effect_params',
      clipId,
      effectId,
      params: { stroke: null },
    };
    // The box has no fill, so turning its stroke off would leave nothing.
    expect(() => applyOperation(withShape, op)).toThrow(
      'A shape needs a fill or a stroke — with both off it draws nothing.',
    );
  });

  it('refuses a key the shape does not have', () => {
    const op: Operation = {
      type: 'set_effect_params',
      clipId,
      effectId,
      params: { endCap: 'arrow' },
    };
    expect(() => applyOperation(withShape, op)).toThrow(/has no ends to cap/);
  });

  it('accepts an arrow moving its ends', () => {
    const arrowAdded = applyOperation(timeline, { ...add, params: arrow } as Operation);
    const op: Operation = {
      type: 'set_effect_params',
      clipId,
      effectId,
      params: { x1: 10, y1: 10, x2: 40, y2: 30 },
    };
    expect(applyOperation(arrowAdded, op).tracks[1]!.clips[0]!.effects[0]!.params).toMatchObject({
      x1: 10,
      x2: 40,
    });
  });
});
