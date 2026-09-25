/**
 * Shape patches (plan/elements EL4a): one validated, reversible patch per click or drag, named
 * for History, and never a patch the engine would refuse.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, invertPatch, validatePatch } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import { addShapePatch, setShapeParamsPatch } from './shape-builders.js';

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
  ],
};

describe('addShapePatch', () => {
  it('adds a preset at the playhead as one undoable patch named for History', () => {
    const added = addShapePatch(timeline, 'rounded-rect/highlight', 2, 3)!;
    expect(added.patch.reason).toBe('Add shape “Highlight box”');
    expect(validatePatch(timeline, added.patch).valid).toBe(true);
    const after = applyPatch(timeline, added.patch);
    const clip = after.tracks.flatMap((track) => track.clips).find((c) => c.id === added.clipId);
    expect(clip).toMatchObject({ start: 2, end: 5, assetId: '__shape__' });
    expect(applyPatch(after, invertPatch(timeline, added.patch))).toEqual(timeline);
  });

  it('refuses an unknown preset and an empty span', () => {
    expect(addShapePatch(timeline, 'nope/none', 0, 3)).toBeNull();
    expect(addShapePatch(timeline, 'ellipse/outline', 0, 0)).toBeNull();
  });
});

describe('setShapeParamsPatch', () => {
  const added = addShapePatch(timeline, 'rounded-rect/highlight', 2, 3)!;
  const withShape = applyPatch(timeline, added.patch);

  it('restyles as one patch', () => {
    const patch = setShapeParamsPatch(withShape, added.clipId, { stroke: '#FF3B30' })!;
    expect(patch.reason).toBe('Change rounded rectangle style');
    const after = applyPatch(withShape, patch);
    const clip = after.tracks.flatMap((track) => track.clips).find((c) => c.id === added.clipId)!;
    expect(clip.effects[0]!.params.stroke).toBe('#FF3B30');
  });

  it('gives two different edits two different ids', () => {
    const red = setShapeParamsPatch(withShape, added.clipId, { stroke: '#FF3B30' })!;
    const blue = setShapeParamsPatch(withShape, added.clipId, { stroke: '#0A84FF' })!;
    expect(red.patchId).not.toBe(blue.patchId);
  });

  it('never builds a change that would leave the shape drawing nothing', () => {
    expect(setShapeParamsPatch(withShape, added.clipId, { stroke: null })).toBeNull();
    expect(setShapeParamsPatch(withShape, 'c1', { stroke: '#FF3B30' })).toBeNull();
  });
});
