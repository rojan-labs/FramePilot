/**
 * `set_clip_edge_style` (MK9.2): one outline, glow or shadow per kind on a clip, set, edited in
 * place and removed as validated, exactly reversible edits.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { applyOperation, edgeStyleEffectId, invertOperation } from './operations.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';
import type { PatchId } from '@framepilot/shared-types';

function timeline(): Timeline {
  return {
    revision: 0,
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
            end: 4,
            sourceStart: 0,
            sourceEnd: 4,
            effects: [{ id: 'g1', type: 'color_grade', params: { exposure: 0.2 }, keyframes: [] }],
            keyframes: [],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

const effectsOf = (tl: Timeline) => tl.tracks[0]!.clips[0]!.effects;

const patchOf = (operations: Patch['operations']): Patch => ({
  patchId: 'edge-test' as PatchId,
  createdBy: 'user',
  reason: 'edge style',
  operations,
});

describe('set_clip_edge_style', () => {
  it('adds a style with the kind defaults filled in, and undoes to the exact prior clip', () => {
    const before = timeline();
    const patch = patchOf([
      { type: 'set_clip_edge_style', clipId: 'c1', kind: 'stroke', params: { widthPx: 12 } },
    ]);
    expect(validatePatch(before, patch, { assetIds: ['a1'] }).valid).toBe(true);
    const after = applyPatch(before, patch);
    expect(effectsOf(after)[1]).toEqual({
      id: edgeStyleEffectId('c1', 'stroke'),
      type: 'edge_style',
      params: { kind: 'stroke', widthPx: 12, red: 255, green: 255, blue: 255, opacity: 1 },
      keyframes: [],
    });
    expect(applyPatch(after, invertPatch(before, patch))).toEqual(before);
  });

  it('edits a kind in place rather than stacking a second one, and removes it', () => {
    const one = applyOperation(timeline(), {
      type: 'set_clip_edge_style',
      clipId: 'c1',
      kind: 'shadow',
      params: {},
    });
    const withGlow = applyOperation(one, {
      type: 'set_clip_edge_style',
      clipId: 'c1',
      kind: 'glow',
      params: { radiusPx: 30 },
    });
    const edited = applyOperation(withGlow, {
      type: 'set_clip_edge_style',
      clipId: 'c1',
      kind: 'shadow',
      params: { opacity: 0.25 },
    });
    expect(effectsOf(edited).map((effect) => effect.id)).toEqual([
      'g1',
      'c1__edge_shadow',
      'c1__edge_glow',
    ]);
    expect(effectsOf(edited)[1]!.params.opacity).toBe(0.25);
    const removed = applyOperation(edited, {
      type: 'set_clip_edge_style',
      clipId: 'c1',
      kind: 'shadow',
      params: null,
    });
    expect(effectsOf(removed).map((effect) => effect.id)).toEqual(['g1', 'c1__edge_glow']);
    const inverse = invertOperation(edited, {
      type: 'set_clip_edge_style',
      clipId: 'c1',
      kind: 'shadow',
      params: null,
    });
    expect(inverse.reduce((tl, op) => applyOperation(tl, op), removed)).toEqual(edited);
  });

  it('refuses out-of-range or unknown settings before they reach a renderer', () => {
    const tooWide = patchOf([
      { type: 'set_clip_edge_style', clipId: 'c1', kind: 'stroke', params: { widthPx: 900 } },
    ]);
    const result = validatePatch(timeline(), tooWide, { assetIds: ['a1'] });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/outside its range/);
    expect(() =>
      applyOperation(timeline(), {
        type: 'set_clip_edge_style',
        clipId: 'c1',
        kind: 'glow',
        params: { widthPx: 3 },
      }),
    ).toThrow(/does not use/);
    expect(() =>
      applyOperation(timeline(), {
        type: 'set_clip_edge_style',
        clipId: 'c1',
        kind: 'glow',
        params: null,
      }),
    ).toThrow(/no glow edge style/);
  });
});
