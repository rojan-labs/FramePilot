/**
 * Shape patches (plan/elements EL4a, EL5): one validated, reversible patch per click, drop or drag,
 * named for History, and never a patch the engine would refuse.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, invertPatch, validatePatch } from '@framepilot/editor-core';
import { shapePreset, type Timeline } from '@framepilot/timeline-schema';
import {
  addShapePatch,
  recolourPreset,
  setShapeParamsPatch,
  swapShapePatch,
} from './shape-builders.js';

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

  it('adds in the chosen colour, with a distinct patch id per colour', () => {
    const red = addShapePatch(timeline, 'rounded-rect/highlight', 2, 3, { colour: '#FF3B30' })!;
    const plain = addShapePatch(timeline, 'rounded-rect/highlight', 2, 3)!;
    const after = applyPatch(timeline, red.patch);
    const clip = after.tracks.flatMap((track) => track.clips).find((c) => c.id === red.clipId)!;
    expect(clip.effects[0]!.params).toMatchObject({ stroke: '#FF3B30', fill: null });
    expect(red.patch.patchId).not.toBe(plain.patch.patchId);
  });

  it('adds an icon by its id, and lands a drop on the lane it names', () => {
    const lane: Timeline = {
      tracks: [{ id: 'g1', type: 'overlay', clips: [] }, ...timeline.tracks],
    };
    const icon = addShapePatch(lane, 'icon/check', 1, 2, { trackId: 'g1' })!;
    expect(validatePatch(lane, icon.patch).valid).toBe(true);
    const after = applyPatch(lane, icon.patch);
    expect(after.tracks[0]!.clips.map((c) => c.id)).toEqual([icon.clipId]);
  });
});

describe('recolourPreset', () => {
  const style = (id: string) => shapePreset(id)!.preset;

  it('recolours the paint that carries the shape and keeps its alpha', () => {
    expect(recolourPreset(style('rounded-rect/highlight'), '#0A84FF')).toMatchObject({
      stroke: '#0A84FF',
      fill: null,
    });
    expect(recolourPreset(style('marker-highlight/yellow'), '#34C759')).toMatchObject({
      fill: '#34C75966',
      stroke: null,
    });
    // A filled cursor keeps its contrasting outline; a heart drawn in one colour recolours both.
    expect(recolourPreset(style('cursor-pointer/white'), '#FF3B30')).toMatchObject({
      fill: '#FF3B30',
      stroke: '#111111',
    });
    expect(recolourPreset(style('heart/red'), '#0A84FF')).toMatchObject({
      fill: '#0A84FF',
      stroke: '#0A84FF',
    });
  });

  it('keeps a badge number readable and leaves the preset alone without a colour', () => {
    expect(recolourPreset(style('numbered-circle/red-1'), '#FFD400').labelColor).toBe('#111111');
    expect(recolourPreset(style('numbered-circle/white-1'), '#111111').labelColor).toBe('#FFFFFF');
    const preset = style('ellipse/outline');
    expect(recolourPreset(preset, null)).toBe(preset);
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

describe('swapShapePatch', () => {
  const added = addShapePatch(timeline, 'rounded-rect/highlight', 2, 3)!;
  const withShape = applyPatch(timeline, added.patch);

  it('swaps the geometry, keeps the style, and undoes to the rounded box', () => {
    const patch = swapShapePatch(withShape, added.clipId, 'star-5')!;
    expect(patch.reason).toBe('Change rounded rectangle to star');
    expect(validatePatch(withShape, patch).valid).toBe(true);
    const after = applyPatch(withShape, patch);
    const params = after.tracks.flatMap((t) => t.clips).find((c) => c.id === added.clipId)!
      .effects[0]!.params;
    expect(params).toMatchObject({ shape: 'star-5', stroke: '#FFD400', points: 5 });
    expect(params.cornerRadius ?? null).toBeNull();
    expect(applyPatch(after, invertPatch(withShape, patch))).toEqual(withShape);
  });

  it('refuses a box-to-line swap', () => {
    expect(swapShapePatch(withShape, added.clipId, 'line-arrow')).toBeNull();
  });
});
