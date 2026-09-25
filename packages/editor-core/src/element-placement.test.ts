/**
 * `buildAddShapeOps` (plan/elements EL4a): a shape lands on an overlay lane with room, a new one
 * when none has, never on a picture lane, and always as one valid, reversible patch.
 */
import { describe, expect, it } from 'vitest';
import { presetShapeParams, type Timeline } from '@framepilot/timeline-schema';
import { buildAddShapeOps, setShapeParamsOp } from './element-placement.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { asId } from '@framepilot/shared-types';
import { validatePatch } from './validator.js';

const params = presetShapeParams('rounded-rect/highlight')!;

const video = {
  id: 'v1',
  type: 'video' as const,
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
};

const patchOf = (operations: Patch['operations']): Patch => ({
  patchId: asId<'PatchId'>('p'),
  createdBy: 'user',
  reason: 'Add shape',
  operations,
});

function roundTrip(timeline: Timeline, patch: Patch): void {
  expect(validatePatch(timeline, patch).valid).toBe(true);
  const after = applyPatch(timeline, patch);
  expect(applyPatch(after, invertPatch(timeline, patch))).toEqual(timeline);
}

describe('buildAddShapeOps', () => {
  it('opens an overlay lane at the front when the timeline has none', () => {
    const timeline: Timeline = { tracks: [video] };
    const placed = buildAddShapeOps(timeline, params, 2, 5);
    expect(placed.operations[0]).toMatchObject({
      type: 'add_layer',
      layerType: 'overlay',
      atIndex: 0,
    });
    const after = applyPatch(timeline, patchOf(placed.operations));
    expect(after.tracks[0]!.clips[0]!.id).toBe(placed.clipId);
    roundTrip(timeline, patchOf(placed.operations));
  });

  it('uses the overlay lane that has room', () => {
    const timeline: Timeline = { tracks: [{ id: 'o1', type: 'overlay', clips: [] }, video] };
    const placed = buildAddShapeOps(timeline, params, 2, 5);
    expect(placed.trackId).toBe('o1');
    expect(placed.operations).toHaveLength(1);
    roundTrip(timeline, patchOf(placed.operations));
  });

  it('stacks a second shape over the same span on a new overlay lane, never a picture lane', () => {
    const first: Timeline = { tracks: [{ id: 'o1', type: 'overlay', clips: [] }, video] };
    const withOne = applyPatch(first, patchOf(buildAddShapeOps(first, params, 2, 5).operations));
    const second = buildAddShapeOps(withOne, params, 3, 6);
    expect(second.trackId).not.toBe('o1');
    expect(second.trackId).not.toBe('v1');
    expect(second.operations[0]).toMatchObject({ type: 'add_layer', layerType: 'overlay' });
    roundTrip(withOne, patchOf(second.operations));
  });

  it('honours a named overlay lane, and ignores a named picture lane', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'o1', type: 'overlay', clips: [] },
        { id: 'o2', type: 'overlay', clips: [] },
        video,
      ],
    };
    expect(buildAddShapeOps(timeline, params, 2, 5, 'o2').trackId).toBe('o2');
    expect(buildAddShapeOps(timeline, params, 2, 5, 'v1').trackId).toBe('o1');
  });

  it('skips a locked overlay lane', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'o1', type: 'overlay', locked: true, clips: [] }, video],
    };
    expect(buildAddShapeOps(timeline, params, 2, 5).trackId).not.toBe('o1');
  });
});

describe('setShapeParamsOp', () => {
  it('addresses the shape effect of the clip', () => {
    expect(setShapeParamsOp('shape__o1_2000', { stroke: '#FF3B30' })).toEqual({
      type: 'set_effect_params',
      clipId: 'shape__o1_2000',
      effectId: 'shape__o1_2000__shape',
      params: { stroke: '#FF3B30' },
    });
  });
});
