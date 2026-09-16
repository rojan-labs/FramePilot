/**
 * Mask stack operations (schema v22): every operation's apply, its real error branches,
 * and the round trip apply → invert → apply(inverse) back to the exact prior timeline.
 */
import { describe, expect, it } from 'vitest';
import type {
  MaskLayer,
  MaskLayerInput,
  MatteMask,
  PathMask,
  Timeline,
} from '@framepilot/timeline-schema';
import { MaskLayerSchema } from '@framepilot/timeline-schema';
import { decodeMaskPath, encodeMaskPath } from './mask-geometry.js';
import { MASK_OPERATION_TYPES, MaskOperationError, type MaskOperation } from './mask-operations.js';
import { applyOperation, invertOperation, type Operation } from './operations.js';
import { assertOperationContract, OperationContractError } from './operation-contract.js';
import { validatePatch } from './validator.js';

const SHA = 'b'.repeat(64);

const rect = (id: string, over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({ kind: 'rectangle', id, cx: 960, cy: 540, width: 400, height: 300, ...over }) as MaskLayerInput;

const square = (x: number): number[] =>
  encodeMaskPath([
    { x, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, type: 'corner' },
    { x: x + 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 30, type: 'smooth' },
    { x: x + 100, y: 100, inX: 0, inY: -30, outX: 0, outY: 0, type: 'corner' },
    { x, y: 100, inX: 0, inY: 0, outX: 0, outY: 0, type: 'corner' },
  ]).points;

const path = (id: string): MaskLayerInput => ({
  kind: 'path',
  id,
  pathKeyframes: [
    { id: `${id}_k0`, sourceTime: 1, points: square(0), vertexTypes: [0, 1, 0, 0] },
    { id: `${id}_k1`, sourceTime: 3, points: square(50), vertexTypes: [0, 1, 0, 0] },
  ],
});

const matte = (id: string): MaskLayerInput => ({
  kind: 'matte',
  id,
  artifact: {
    key: SHA,
    files: [{ name: 'matte.mkv', sha256: SHA }],
    width: 1920,
    height: 1080,
    coverage: { sourceStart: 1, sourceEnd: 5 },
    packId: 'subject-matte',
    packVersion: '1.0.0',
    modelDigests: [SHA],
  },
});

const parsed = (input: MaskLayerInput): MaskLayer => MaskLayerSchema.parse(input);

function timeline(masks: MaskLayerInput[] = [], effectLayerMasks: MaskLayerInput[] = []): Timeline {
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
            sourceStart: 1,
            sourceEnd: 5,
            effects: [{ id: 'blur', type: 'blur', params: {}, keyframes: [] }],
            keyframes: [],
            ...(masks.length > 0 ? { masks: masks.map(parsed) } : {}),
          },
          {
            id: 'c2',
            assetId: 'a2',
            trackId: 'v1',
            start: 4,
            end: 6,
            sourceStart: 10,
            sourceEnd: 12,
            effects: [],
            keyframes: [],
          },
        ],
      },
      {
        id: 'fx',
        type: 'effect',
        clips: [],
        effectLayers: [
          {
            id: 'L1',
            effectId: 'gaussian-blur',
            kind: 'blur-gaussian',
            start: 0,
            end: 4,
            params: {},
            keyframes: [],
            ...(effectLayerMasks.length > 0
              ? { masks: effectLayerMasks.map((mask) => parsed({ ...mask, space: 'frame' })) }
              : {}),
          },
        ],
      },
    ],
  };
}

const withoutRevision = (value: Timeline): Omit<Timeline, 'revision'> => {
  const { revision: _revision, ...rest } = value;
  return rest;
};

/** Apply, invert against the before-state, apply the inverse: must land exactly back. */
function roundTrip(before: Timeline, op: Operation): Timeline {
  const after = applyOperation(before, op);
  const inverse = invertOperation(before, op);
  const restored = inverse.reduce((current, step) => applyOperation(current, step), after);
  expect(withoutRevision(restored)).toEqual(withoutRevision(before));
  return after;
}

const masksOfClip = (value: Timeline, clipId = 'c1'): readonly MaskLayer[] =>
  value.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)?.masks ?? [];

const expectMaskError = (fn: () => unknown, code: string, pattern?: RegExp): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MaskOperationError);
    expect((error as MaskOperationError).code).toBe(code);
    if (pattern) expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected a MaskOperationError');
};

describe('add_mask / remove_mask / add_effect_layer_mask', () => {
  it('adds a mask with defaults at an index and removes it exactly on undo', () => {
    const before = timeline([rect('top'), rect('bottom')]);
    const after = roundTrip(before, {
      type: 'add_mask',
      clipId: 'c1',
      mask: rect('middle'),
      index: 1,
    });
    expect(masksOfClip(after).map((mask) => mask.id)).toEqual(['top', 'middle', 'bottom']);
    expect(masksOfClip(after)[1]).toMatchObject({
      enabled: true,
      mode: 'add',
      featherModel: 'distance',
    });
  });

  it('adds the first mask to an unmasked clip and leaves no empty stack on undo', () => {
    const before = timeline();
    const after = roundTrip(before, { type: 'add_mask', clipId: 'c1', mask: rect('m') });
    expect(masksOfClip(after)).toHaveLength(1);
    expect('masks' in before.tracks[0]!.clips[0]!).toBe(false);
  });

  it('refuses duplicate ids, invalid values, missing clips and absent effect targets', () => {
    const before = timeline([rect('m')]);
    expectMaskError(
      () => applyOperation(before, { type: 'add_mask', clipId: 'c1', mask: rect('m') }),
      'duplicate_mask',
      /update_mask/,
    );
    expectMaskError(
      () =>
        applyOperation(before, { type: 'add_mask', clipId: 'c1', mask: rect('x', { opacity: 2 }) }),
      'invalid_mask',
      /'opacity'/,
    );
    expectMaskError(
      () => applyOperation(before, { type: 'add_mask', clipId: 'nope', mask: rect('x') }),
      'missing_clip',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_mask',
          clipId: 'c1',
          mask: rect('x', { target: { kind: 'effect', effectId: 'grade' } }),
        }),
      'invalid_mask_target',
    );
    expectMaskError(
      () => applyOperation(before, { type: 'add_mask', clipId: 'c1', mask: rect('x'), index: 0.5 }),
      'invalid_mask',
    );
  });

  it('removes a mask and restores it at its index', () => {
    const before = timeline([rect('a'), rect('b'), rect('c')]);
    const after = roundTrip(before, { type: 'remove_mask', clipId: 'c1', maskId: 'b' });
    expect(masksOfClip(after).map((mask) => mask.id)).toEqual(['a', 'c']);
    expectMaskError(
      () => applyOperation(before, { type: 'remove_mask', clipId: 'c1', maskId: 'zz' }),
      'missing_mask',
    );
  });

  it('adds a frame-space alpha mask to an effect layer, and refuses source space or effect targets', () => {
    const before = timeline();
    const after = roundTrip(before, {
      type: 'add_effect_layer_mask',
      layerId: 'L1',
      mask: rect('lane'),
    });
    expect(after.tracks[1]!.effectLayers![0]!.masks![0]!.space).toBe('frame');
    roundTrip(timeline([], [rect('lane')]), { type: 'remove_mask', layerId: 'L1', maskId: 'lane' });
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_effect_layer_mask',
          layerId: 'L1',
          mask: rect('x', { space: 'source' }),
        }),
      'invalid_mask',
      /space 'frame'/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_effect_layer_mask',
          layerId: 'L1',
          mask: rect('x', { target: { kind: 'effect', effectId: 'blur' } }),
        }),
      'invalid_mask_target',
    );
    expectMaskError(
      () =>
        applyOperation(before, { type: 'add_effect_layer_mask', layerId: 'nope', mask: rect('x') }),
      'missing_effect_layer',
    );
  });
});

describe('update_mask', () => {
  it('merges scalar changes, validates the result and restores the exact prior mask', () => {
    const before = timeline([rect('m')]);
    const after = roundTrip(before, {
      type: 'update_mask',
      clipId: 'c1',
      maskId: 'm',
      changes: { opacity: 0.5, mode: 'subtract', cx: 100, name: 'Face' },
    });
    expect(masksOfClip(after)[0]).toMatchObject({
      opacity: 0.5,
      mode: 'subtract',
      cx: 100,
      name: 'Face',
    });
  });

  it('swaps a matte artifact through update_mask', () => {
    const before = timeline([matte('subject')]);
    const newKey = 'c'.repeat(64);
    const after = roundTrip(before, {
      type: 'update_mask',
      clipId: 'c1',
      maskId: 'subject',
      changes: { artifact: { ...(parsed(matte('subject')) as MatteMask).artifact, key: newKey } },
    });
    expect((masksOfClip(after)[0] as MatteMask).artifact.key).toBe(newKey);
  });

  it.each(['id', 'kind', 'keyframes', 'pathKeyframes', 'target', 'space', 'tracking'])(
    'refuses a structural field (%s) and names the owning operation',
    (field) => {
      expectMaskError(
        () =>
          applyOperation(timeline([rect('m')]), {
            type: 'update_mask',
            clipId: 'c1',
            maskId: 'm',
            changes: { [field]: 1 },
          }),
        'invalid_mask',
        /Use /,
      );
    },
  );

  it('refuses a value the schema rejects', () => {
    expectMaskError(
      () =>
        applyOperation(timeline([rect('m')]), {
          type: 'update_mask',
          clipId: 'c1',
          maskId: 'm',
          changes: { width: -1 },
        }),
      'invalid_mask',
    );
  });
});

describe('scalar keyframes', () => {
  const keyframe = { id: 'k1', sourceTime: 2, property: 'opacity', value: 0.25 } as const;

  it('adds, moves and removes keyframes with exact inverses', () => {
    const before = timeline([rect('m')]);
    const added = roundTrip(before, {
      type: 'add_mask_keyframe',
      clipId: 'c1',
      maskId: 'm',
      keyframe,
    });
    expect(masksOfClip(added)[0]!.keyframes).toEqual([{ ...keyframe, easing: 'linear' }]);
    const moved = roundTrip(added, {
      type: 'move_mask_keyframe',
      clipId: 'c1',
      maskId: 'm',
      keyframeId: 'k1',
      sourceTime: 3.5,
    });
    expect(masksOfClip(moved)[0]!.keyframes[0]!.sourceTime).toBe(3.5);
    const removed = roundTrip(moved, {
      type: 'remove_mask_keyframe',
      clipId: 'c1',
      maskId: 'm',
      keyframeId: 'k1',
    });
    expect(masksOfClip(removed)[0]!.keyframes).toEqual([]);
  });

  it('keeps keyframes sorted by source time', () => {
    let current = timeline([rect('m')]);
    for (const [id, sourceTime] of [
      ['late', 4],
      ['early', 1.5],
      ['mid', 2],
    ] as const) {
      current = applyOperation(current, {
        type: 'add_mask_keyframe',
        clipId: 'c1',
        maskId: 'm',
        keyframe: { id, sourceTime, property: 'cx', value: sourceTime },
      });
    }
    expect(masksOfClip(current)[0]!.keyframes.map((k) => k.id)).toEqual(['early', 'mid', 'late']);
  });

  it('refuses a property the kind cannot animate, a duplicate id or a shared instant', () => {
    const before = applyOperation(timeline([rect('m'), path('p')]), {
      type: 'add_mask_keyframe',
      clipId: 'c1',
      maskId: 'm',
      keyframe,
    });
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_mask_keyframe',
          clipId: 'c1',
          maskId: 'p',
          keyframe: { id: 'k9', sourceTime: 2, property: 'cx', value: 1 },
        }),
      'invalid_mask',
      /cannot animate 'cx'/,
    );
    expectMaskError(
      () =>
        applyOperation(before, { type: 'add_mask_keyframe', clipId: 'c1', maskId: 'm', keyframe }),
      'duplicate_keyframe',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_mask_keyframe',
          clipId: 'c1',
          maskId: 'm',
          keyframe: { ...keyframe, id: 'k2' },
        }),
      'duplicate_keyframe',
      /at that instant/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'move_mask_keyframe',
          clipId: 'c1',
          maskId: 'm',
          keyframeId: 'nope',
          sourceTime: 1,
        }),
      'missing_keyframe',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'move_mask_keyframe',
          clipId: 'c1',
          maskId: 'm',
          keyframeId: 'k1',
          sourceTime: -1,
        }),
      'invalid_mask',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'remove_mask_keyframe',
          clipId: 'c1',
          maskId: 'm',
          keyframeId: 'nope',
        }),
      'missing_keyframe',
    );
  });
});

describe('path masks', () => {
  const pathOf = (value: Timeline): PathMask => masksOfClip(value)[0] as PathMask;

  it('replaces a path keyframe by id and adds a new one in time order', () => {
    const before = timeline([path('p')]);
    const replaced = roundTrip(before, {
      type: 'set_mask_path',
      clipId: 'c1',
      maskId: 'p',
      keyframe: { id: 'p_k1', sourceTime: 3, points: square(10), vertexTypes: [0, 0, 0, 0] },
    });
    expect(pathOf(replaced).pathKeyframes[1]!.points[0]).toBe(10);
    const added = roundTrip(before, {
      type: 'set_mask_path',
      clipId: 'c1',
      maskId: 'p',
      keyframe: { id: 'p_k2', sourceTime: 2, points: square(20), vertexTypes: [0, 0, 0, 0] },
    });
    expect(pathOf(added).pathKeyframes.map((keyframe) => keyframe.id)).toEqual([
      'p_k0',
      'p_k2',
      'p_k1',
    ]);
  });

  it('refuses a keyframe with a different vertex count, broken stride, a non-path mask, or a shared instant', () => {
    const before = timeline([path('p'), rect('r')]);
    const three = encodeMaskPath(
      decodeMaskPath({ points: square(0), vertexTypes: [0, 1, 0, 0] }).slice(0, 3),
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'set_mask_path',
          clipId: 'c1',
          maskId: 'p',
          keyframe: { id: 'new', sourceTime: 2, ...three },
        }),
      'invalid_mask_path',
      /same number of vertices/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'set_mask_path',
          clipId: 'c1',
          maskId: 'p',
          keyframe: { id: 'p_k0', sourceTime: 1, points: [1, 2, 3], vertexTypes: [0, 0, 0, 0] },
        }),
      'invalid_mask_path',
      /six numbers/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'set_mask_path',
          clipId: 'c1',
          maskId: 'r',
          keyframe: { id: 'x', sourceTime: 2, ...three },
        }),
      'invalid_mask_path',
      /path masks only/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'set_mask_path',
          clipId: 'c1',
          maskId: 'p',
          keyframe: { id: 'other', sourceTime: 3, points: square(0), vertexTypes: [0, 0, 0, 0] },
        }),
      'duplicate_keyframe',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'add_mask',
          clipId: 'c1',
          mask: {
            kind: 'path',
            id: 'tiny',
            pathKeyframes: [
              {
                id: 't',
                sourceTime: 1,
                ...three,
                ...encodeMaskPath(decodeMaskPath(three).slice(0, 2)),
              },
            ],
          },
        }),
      'invalid_mask_path',
      /at least three vertices/,
    );
  });

  it('moves and removes path keyframes, but never the last one', () => {
    const before = timeline([path('p')]);
    roundTrip(before, {
      type: 'move_mask_keyframe',
      clipId: 'c1',
      maskId: 'p',
      keyframeId: 'p_k1',
      sourceTime: 4,
    });
    const removed = roundTrip(before, {
      type: 'remove_mask_keyframe',
      clipId: 'c1',
      maskId: 'p',
      keyframeId: 'p_k1',
    });
    expectMaskError(
      () =>
        applyOperation(removed, {
          type: 'remove_mask_keyframe',
          clipId: 'c1',
          maskId: 'p',
          keyframeId: 'p_k0',
        }),
      'invalid_mask_path',
      /Remove the mask instead/,
    );
  });

  it('inserts a vertex on every keyframe at the same parametric position without changing the curve', () => {
    const before = timeline([path('p')]);
    const after = roundTrip(before, {
      type: 'insert_mask_vertex',
      clipId: 'c1',
      maskId: 'p',
      segment: 1,
      t: 0.5,
    });
    const mask = pathOf(after);
    for (const keyframe of mask.pathKeyframes) {
      const vertices = decodeMaskPath(keyframe);
      expect(vertices).toHaveLength(5);
      // Segment 1 runs (x+100, 0) → (x+100, 100) with tangents (0,30) and (0,-30): its
      // midpoint is exactly halfway down the right edge.
      const offset = keyframe.id === 'p_k0' ? 0 : 50;
      expect(vertices[2]).toMatchObject({ x: offset + 100, y: 50, type: 'smooth' });
      expect(vertices[1]!.outY).toBeCloseTo(15, 12);
      expect(vertices[3]!.inY).toBeCloseTo(-15, 12);
    }
  });

  it('inserts a corner on a straight segment and keeps firstVertex on the same vertex', () => {
    const before = applyOperation(timeline([path('p')]), {
      type: 'update_mask',
      clipId: 'c1',
      maskId: 'p',
      changes: {},
    });
    const withFirst = applyOperation(before, {
      type: 'restore_masks',
      clipId: 'c1',
      masks: [{ ...(masksOfClip(before)[0] as PathMask), firstVertex: 3 }],
    });
    const after = applyOperation(withFirst, {
      type: 'insert_mask_vertex',
      clipId: 'c1',
      maskId: 'p',
      segment: 2,
      t: 0.25,
    });
    const mask = pathOf(after);
    expect(mask.firstVertex).toBe(4);
    expect(decodeMaskPath(mask.pathKeyframes[0]!)[3]).toEqual({
      // A cubic whose control points sit on its end points is still parametrised as a
      // cubic: t = 0.25 lands 15.625% of the way along, not 25%.
      x: 84.375,
      y: 100,
      inX: 0,
      inY: 0,
      outX: 0,
      outY: 0,
      type: 'corner',
    });
  });

  it('removes a vertex from every keyframe, keeps three, and refuses bad indices', () => {
    const before = timeline([path('p')]);
    const after = roundTrip(before, {
      type: 'remove_mask_vertex',
      clipId: 'c1',
      maskId: 'p',
      vertex: 0,
    });
    expect(pathOf(after).pathKeyframes.every((keyframe) => keyframe.vertexTypes.length === 3)).toBe(
      true,
    );
    expectMaskError(
      () =>
        applyOperation(after, { type: 'remove_mask_vertex', clipId: 'c1', maskId: 'p', vertex: 0 }),
      'invalid_mask_path',
      /at least three vertices/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'insert_mask_vertex',
          clipId: 'c1',
          maskId: 'p',
          segment: 9,
          t: 0.5,
        }),
      'invalid_mask_path',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'insert_mask_vertex',
          clipId: 'c1',
          maskId: 'p',
          segment: 0,
          t: 1,
        }),
      'invalid_mask_path',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'remove_mask_vertex',
          clipId: 'c1',
          maskId: 'p',
          vertex: -1,
        }),
      'invalid_mask_path',
    );
  });

  it('interpolates per-vertex feather for an inserted vertex', () => {
    const before = timeline([
      {
        kind: 'path',
        id: 'p',
        pathKeyframes: [
          {
            id: 'k',
            sourceTime: 1,
            points: square(0),
            vertexTypes: [0, 0, 0, 0],
            featherPx: [0, 10, 20, 0],
          },
        ],
      },
    ]);
    const after = applyOperation(before, {
      type: 'insert_mask_vertex',
      clipId: 'c1',
      maskId: 'p',
      segment: 1,
      t: 0.5,
    });
    expect(pathOf(after).pathKeyframes[0]!.featherPx).toEqual([0, 10, 15, 20, 0]);
  });
});

describe('stack order, target, space, tracking, review', () => {
  const tracking = {
    artifact: { key: SHA, sha256: SHA },
    method: 'perspective',
    referenceSourceTime: 2,
  } as const;

  it('reorders a stack with an exact inverse and refuses a partial order', () => {
    const before = timeline([rect('a'), rect('b'), rect('c')]);
    const after = roundTrip(before, {
      type: 'reorder_masks',
      clipId: 'c1',
      maskIds: ['c', 'a', 'b'],
    });
    expect(masksOfClip(after).map((mask) => mask.id)).toEqual(['c', 'a', 'b']);
    expectMaskError(
      () => applyOperation(before, { type: 'reorder_masks', clipId: 'c1', maskIds: ['a', 'b'] }),
      'invalid_mask',
    );
    expectMaskError(
      () =>
        applyOperation(before, { type: 'reorder_masks', clipId: 'c1', maskIds: ['a', 'a', 'b'] }),
      'invalid_mask',
    );
  });

  it('retargets a mask to an effect on its clip and back', () => {
    const before = timeline([rect('m')]);
    const after = roundTrip(before, {
      type: 'set_mask_target',
      clipId: 'c1',
      maskId: 'm',
      target: { kind: 'effect', effectId: 'blur' },
    });
    expect(masksOfClip(after)[0]!.target).toEqual({ kind: 'effect', effectId: 'blur' });
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'set_mask_target',
          clipId: 'c1',
          maskId: 'm',
          target: { kind: 'effect', effectId: 'missing' },
        }),
      'invalid_mask_target',
      /not on clip 'c1'/,
    );
  });

  it('sets a clip mask to frame space and refuses source space on an effect layer', () => {
    roundTrip(timeline([rect('m')]), {
      type: 'set_mask_space',
      clipId: 'c1',
      maskId: 'm',
      space: 'frame',
    });
    expectMaskError(
      () =>
        applyOperation(timeline([], [rect('lane')]), {
          type: 'set_mask_space',
          layerId: 'L1',
          maskId: 'lane',
          space: 'source',
        }),
      'invalid_mask',
    );
  });

  it('applies, replaces and clears tracking with exact inverses', () => {
    const before = timeline([rect('m')]);
    const tracked = roundTrip(before, {
      type: 'apply_mask_tracking',
      clipId: 'c1',
      maskId: 'm',
      tracking,
    });
    expect(masksOfClip(tracked)[0]!.tracking).toMatchObject({
      method: 'perspective',
      constraints: [],
    });
    roundTrip(tracked, {
      type: 'apply_mask_tracking',
      clipId: 'c1',
      maskId: 'm',
      tracking: { ...tracking, method: 'position' },
    });
    const cleared = roundTrip(tracked, { type: 'clear_mask_tracking', clipId: 'c1', maskId: 'm' });
    expect(masksOfClip(cleared)[0]!.tracking).toBeUndefined();
    roundTrip(before, { type: 'clear_mask_tracking', clipId: 'c1', maskId: 'm' });
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'apply_mask_tracking',
          clipId: 'c1',
          maskId: 'm',
          tracking: { ...tracking, method: 'warp' as never },
        }),
      'invalid_mask',
    );
  });

  it('reuses a track on another clip mask, and refuses an untracked source', () => {
    const tracked = applyOperation(timeline([rect('m'), rect('n')]), {
      type: 'apply_mask_tracking',
      clipId: 'c1',
      maskId: 'm',
      tracking,
    });
    const target = applyOperation(tracked, { type: 'add_mask', clipId: 'c2', mask: rect('title') });
    const after = roundTrip(target, {
      type: 'use_track',
      fromClipId: 'c1',
      fromMaskId: 'm',
      to: { clipId: 'c2', maskId: 'title' },
    });
    expect(masksOfClip(after, 'c2')[0]!.tracking).toEqual(masksOfClip(after)[0]!.tracking);
    expectMaskError(
      () =>
        applyOperation(target, {
          type: 'use_track',
          fromClipId: 'c1',
          fromMaskId: 'n',
          to: { clipId: 'c2', maskId: 'title' },
        }),
      'invalid_mask',
      /Track that mask first/,
    );
  });

  it('reviews a matte and a track, and refuses the wrong subject', () => {
    const before = timeline([matte('subject'), rect('box')]);
    const review = { flagged: [{ start: 1, end: 2 }], approved: [], locked: [1.5] };
    const after = roundTrip(before, {
      type: 'review_mask',
      clipId: 'c1',
      maskId: 'subject',
      subject: 'matte',
      review,
    });
    expect((masksOfClip(after)[0] as MatteMask).review).toEqual(review);
    const tracked = applyOperation(before, {
      type: 'apply_mask_tracking',
      clipId: 'c1',
      maskId: 'box',
      tracking,
    });
    const reviewedTrack = roundTrip(tracked, {
      type: 'review_mask',
      clipId: 'c1',
      maskId: 'box',
      subject: 'tracking',
      review,
    });
    expect(masksOfClip(reviewedTrack)[1]!.tracking!.review).toEqual(review);
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'review_mask',
          clipId: 'c1',
          maskId: 'box',
          subject: 'matte',
          review,
        }),
      'invalid_mask',
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'review_mask',
          clipId: 'c1',
          maskId: 'box',
          subject: 'tracking',
          review,
        }),
      'invalid_mask',
      /Track it first/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'review_mask',
          clipId: 'c1',
          maskId: 'subject',
          subject: 'matte',
          review: { flagged: [{ start: 3, end: 2 }] },
        }),
      'invalid_mask',
    );
  });
});

describe('paste_masks', () => {
  it('scales source geometry by normalised coordinates and keeps keyframe offsets from the in-point', () => {
    const copied = parsed(
      rect('m', {
        featherOuterPx: 10,
        keyframes: [{ id: 'k', sourceTime: 2, property: 'cx', value: 960 }],
      }),
    );
    const before = timeline([rect('m')]);
    const after = roundTrip(before, {
      type: 'paste_masks',
      clipId: 'c2',
      masks: [copied, path('p')],
      from: { assetId: 'a1', width: 1920, height: 1080, sourceStart: 1 },
      to: { width: 3840, height: 2160 },
    });
    const [rectangle, pastedPath] = masksOfClip(after, 'c2') as [MaskLayer, PathMask];
    expect(rectangle).toMatchObject({
      id: 'm',
      cx: 1920,
      cy: 1080,
      width: 800,
      height: 600,
      featherOuterPx: 20,
    });
    // Source 2s was 1s after c1's in-point; c2's in-point is 10s.
    expect(rectangle.keyframes[0]).toMatchObject({ sourceTime: 11, value: 1920 });
    expect(pastedPath.pathKeyframes[0]!.points.slice(0, 2)).toEqual([0, 0]);
    expect(pastedPath.pathKeyframes[0]!.points.slice(6, 8)).toEqual([200, 0]);
  });

  it('derives a free id on collision and refuses a matte from other media or unmeasured sizes', () => {
    const before = timeline([rect('m')]);
    const pasted = applyOperation(before, {
      type: 'paste_masks',
      clipId: 'c1',
      masks: [rect('m')],
      from: { assetId: 'a1', width: 1920, height: 1080, sourceStart: 1 },
      to: { width: 1920, height: 1080 },
    });
    expect(masksOfClip(pasted).map((mask) => mask.id)).toEqual(['m', 'm__paste_1']);
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'paste_masks',
          clipId: 'c2',
          masks: [matte('s')],
          from: { assetId: 'a1', width: 1920, height: 1080, sourceStart: 1 },
          to: { width: 1920, height: 1080 },
        }),
      'invalid_mask',
      /Run background removal/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'paste_masks',
          clipId: 'c2',
          masks: [rect('x')],
          from: { assetId: 'a1', width: 0, height: 1080, sourceStart: 1 },
          to: { width: 1920, height: 1080 },
        }),
      'invalid_mask',
      /Measure this media first/,
    );
    expectMaskError(
      () =>
        applyOperation(before, {
          type: 'paste_masks',
          clipId: 'c1',
          masks: [rect('x')],
          ids: ['m'],
          from: { assetId: 'a1', width: 1920, height: 1080, sourceStart: 1 },
          to: { width: 1920, height: 1080 },
        }),
      'duplicate_mask',
    );
  });
});

describe('add_text_behind_subject', () => {
  it('copies the clip in front with the matte moved onto it, puts text between, and undoes exactly', () => {
    const before = timeline([matte('subject'), rect('vignette')]);
    const after = roundTrip(before, {
      type: 'add_text_behind_subject',
      clipId: 'c1',
      text: 'HELLO',
      style: { color: '#fff' },
    });
    expect(after.tracks.map((track) => track.id)).toEqual([
      'c1__subject_track',
      'c1__text_track',
      'v1',
      'fx',
    ]);
    const [subject, text, original] = after.tracks;
    expect(subject).toMatchObject({ type: 'video', muted: true });
    expect(subject!.clips[0]).toMatchObject({
      id: 'c1__subject',
      start: 0,
      end: 4,
      sourceStart: 1,
    });
    expect(subject!.clips[0]!.masks!.map((mask) => mask.id)).toEqual(['subject']);
    expect(text!.clips[0]!.effects[0]).toMatchObject({
      type: 'text',
      params: { text: 'HELLO', color: '#fff' },
    });
    expect(masksOfClip(after).map((mask) => mask.id)).toEqual(['vignette']);
    expect(original!.id).toBe('v1');
  });

  it('refuses a clip without a matte, empty text, and ids that already exist', () => {
    expectMaskError(
      () =>
        applyOperation(timeline([rect('m')]), {
          type: 'add_text_behind_subject',
          clipId: 'c1',
          text: 'A',
        }),
      'invalid_mask',
      /Remove the background/,
    );
    expectMaskError(
      () =>
        applyOperation(timeline([matte('s')]), {
          type: 'add_text_behind_subject',
          clipId: 'c1',
          text: '  ',
        }),
      'invalid_mask',
    );
    expectMaskError(
      () =>
        applyOperation(timeline([matte('s')]), {
          type: 'add_text_behind_subject',
          clipId: 'c1',
          text: 'A',
          textTrackId: 'fx',
        }),
      'duplicate_layer',
    );
  });
});

describe('mask operations through the patch validator and the contract', () => {
  it('reports apply failures as typed validation issues', () => {
    const result = validatePatch(timeline([rect('m')]), {
      operations: [
        { type: 'add_mask', clipId: 'c1', mask: rect('m') },
        { type: 'remove_mask', clipId: 'c1', maskId: 'ghost' },
        {
          type: 'set_mask_target',
          clipId: 'c1',
          maskId: 'm',
          target: { kind: 'effect', effectId: 'x' },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'duplicate_mask',
      'missing_reference',
      'invalid_mask_target',
    ]);
  });

  it('refuses edits to a locked mask except unlocking it', () => {
    const locked = timeline([rect('m', { locked: true })]);
    expect(() =>
      assertOperationContract(locked, {
        type: 'update_mask',
        clipId: 'c1',
        maskId: 'm',
        changes: { opacity: 0.5 },
      }),
    ).toThrow(OperationContractError);
    expect(() =>
      assertOperationContract(locked, {
        type: 'update_mask',
        clipId: 'c1',
        maskId: 'm',
        changes: { locked: false },
      }),
    ).not.toThrow();
    expect(() =>
      assertOperationContract(locked, { type: 'remove_mask', clipId: 'c1', maskId: 'm' }),
    ).toThrow(/locked mask/);
  });

  it('declares every mask operation type supported by the validator', () => {
    const result = validatePatch(timeline(), {
      operations: MASK_OPERATION_TYPES.map((type) => ({ type }) as unknown as MaskOperation),
    });
    expect(result.issues.some((issue) => issue.code === 'unsupported_operation')).toBe(false);
  });
});
