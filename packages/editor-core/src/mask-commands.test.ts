/**
 * Mask commands (MK4): each command compiles to the operations its edit means, validates,
 * and round-trips through its inverse to the exact prior timeline.
 */
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type PathMask,
  type Timeline,
} from '@framepilot/timeline-schema';
import {
  compileMaskCommand,
  maskGeometryAt,
  maskKeyframeTimes,
  maskPathVerticesAt,
  nextMaskColor,
  type MaskCommand,
} from './mask-commands.js';
import { encodeMaskPath, type MaskPathVertex } from './mask-geometry.js';
import { applyPatch } from './patch.js';

const ASSETS: readonly Asset[] = [
  { id: 'a1', path: 'media/a1.mp4', type: 'video', media: { width: 3840, height: 2160 } } as Asset,
  { id: 'a2', path: 'media/a2.mp4', type: 'video', media: { width: 1920, height: 1080 } } as Asset,
  { id: 'raw', path: 'media/raw.mp4', type: 'video' } as Asset,
];

const corner = (x: number, y: number): MaskPathVertex => ({
  x,
  y,
  inX: 0,
  inY: 0,
  outX: 0,
  outY: 0,
  type: 'corner',
});

const SQUARE = [corner(100, 100), corner(300, 100), corner(300, 300), corner(100, 300)];

function timeline(masks: MaskLayerInput[] = [], assetId = 'a1'): Timeline {
  return {
    revision: 3,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId,
            trackId: 'v1',
            start: 0,
            end: 4,
            sourceStart: 2,
            sourceEnd: 6,
            effects: [],
            keyframes: [],
            ...(masks.length > 0
              ? { masks: masks.map((mask) => MaskLayerSchema.parse(mask)) }
              : {}),
          },
          {
            id: 'c2',
            assetId: 'a2',
            trackId: 'v1',
            start: 4,
            end: 6,
            sourceStart: 0,
            sourceEnd: 2,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

type CommandInput = { readonly type: MaskCommand['type'] } & Record<string, unknown>;

function compile(tl: Timeline, command: CommandInput) {
  return compileMaskCommand({
    timeline: tl,
    assets: ASSETS,
    command: { timelineRevision: 3, clipId: 'c1', ...command } as unknown as MaskCommand,
  });
}

/** Compile, apply, and prove the inverse restores the exact document. */
function applied(tl: Timeline, command: CommandInput): Timeline {
  const result = compile(tl, command);
  if (result.status !== 'compiled') throw new Error(`${result.code}: ${result.detail}`);
  const after = applyPatch(tl, result.patch);
  expect(applyPatch(after, result.inversePatch)).toEqual(tl);
  return after;
}

const masksOn = (tl: Timeline, clipId = 'c1'): readonly MaskLayer[] =>
  masksOf(tl.tracks[0]!.clips.find((clip) => clip.id === clipId)!);

const rect = (over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({
    kind: 'rectangle',
    id: 'c1__mask',
    cx: 1920,
    cy: 1080,
    width: 800,
    height: 600,
    ...over,
  }) as MaskLayerInput;

const pathMask = (keyframes: { id: string; sourceTime: number; dx: number }[]): MaskLayerInput => ({
  kind: 'path',
  id: 'c1__mask',
  pathKeyframes: keyframes.map((keyframe) => ({
    id: keyframe.id,
    sourceTime: keyframe.sourceTime,
    ...encodeMaskPath(SQUARE.map((vertex) => ({ ...vertex, x: vertex.x + keyframe.dx }))),
  })),
});

describe('draw_mask', () => {
  it('adds a rectangle at the top of the stack with a name and a free colour', () => {
    const tl = timeline([rect({ id: 'existing' })]);
    const after = applied(tl, {
      type: 'draw_mask',
      sourceTime: 3,
      geometry: {
        kind: 'rectangle',
        cx: 100.5,
        cy: 200.25,
        width: 50,
        height: 60,
        rotation: 12,
        roundness: 0.2,
      },
    });
    const [drawn] = masksOn(after);
    expect(drawn).toMatchObject({
      id: 'c1__mask',
      kind: 'rectangle',
      name: 'Mask 2',
      cx: 100.5,
      cy: 200.25,
      rotation: 12,
      roundness: 0.2,
      color: '#f97316',
    });
  });

  it('adds a path whose first keyframe sits at the source instant', () => {
    const after = applied(timeline(), {
      type: 'draw_mask',
      sourceTime: 3.5,
      geometry: { kind: 'path', vertices: SQUARE },
    });
    const drawn = masksOn(after)[0] as PathMask;
    expect(drawn.pathKeyframes).toHaveLength(1);
    expect(drawn.pathKeyframes[0]!.sourceTime).toBe(3.5);
    expect(maskPathVerticesAt(drawn, 0)).toEqual(SQUARE);
  });

  it('refuses unmeasured media, too few points and non-finite numbers', () => {
    const raw = timeline([], 'raw');
    expect(
      compile(raw, {
        type: 'draw_mask',
        sourceTime: 2,
        geometry: { kind: 'ellipse', cx: 1, cy: 1, rx: 1, ry: 1, rotation: 0 },
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'needs_media_dimensions',
    });
    expect(
      compile(timeline(), {
        type: 'draw_mask',
        sourceTime: 2,
        geometry: { kind: 'path', vertices: SQUARE.slice(0, 2) },
      }),
    ).toMatchObject({ code: 'too_few_vertices' });
    expect(
      compile(timeline(), {
        type: 'draw_mask',
        sourceTime: 2,
        geometry: { kind: 'ellipse', cx: Number.NaN, cy: 1, rx: 1, ry: 1, rotation: 0 },
      }),
    ).toMatchObject({ code: 'not_editable' });
  });

  it('refuses a stale timeline revision and a missing clip', () => {
    const result = compileMaskCommand({
      timeline: timeline(),
      assets: ASSETS,
      command: {
        type: 'draw_mask',
        timelineRevision: 1,
        clipId: 'c1',
        sourceTime: 2,
        geometry: { kind: 'path', vertices: SQUARE },
      },
    });
    expect(result).toMatchObject({ status: 'rejected', code: 'stale_timeline' });
    expect(compile(timeline(), { type: 'remove_mask', clipId: 'nope', maskId: 'x' })).toMatchObject(
      { code: 'missing_clip' },
    );
    expect(compile(timeline(), { type: 'remove_mask', maskId: 'x' })).toMatchObject({
      code: 'missing_mask',
    });
  });
});

describe('set_mask_geometry', () => {
  it('writes static fields on an unanimated rectangle', () => {
    const after = applied(timeline([rect()]), {
      type: 'set_mask_geometry',
      maskId: 'c1__mask',
      sourceTime: 3,
      geometry: {
        kind: 'rectangle',
        cx: 1000.125,
        cy: 1080,
        width: 800,
        height: 600,
        rotation: 0,
        roundness: 0,
      },
    });
    expect(masksOn(after)[0]).toMatchObject({ cx: 1000.125, keyframes: [] });
  });

  it('keys an animated property at the instant, replacing a keyframe already there', () => {
    const tl = timeline([
      rect({
        keyframes: [
          { id: 'k0', sourceTime: 2, property: 'cx', value: 100 },
          { id: 'k1', sourceTime: 4, property: 'cx', value: 300 },
        ],
      }),
    ]);
    const keyed = applied(tl, {
      type: 'set_mask_geometry',
      maskId: 'c1__mask',
      sourceTime: 3,
      geometry: {
        kind: 'rectangle',
        cx: 250,
        cy: 900,
        width: 800,
        height: 600,
        rotation: 0,
        roundness: 0,
      },
    });
    const mask = masksOn(keyed)[0]!;
    expect(mask.keyframes.map((keyframe) => [keyframe.sourceTime, keyframe.value])).toEqual([
      [2, 100],
      [3, 250],
      [4, 300],
    ]);
    // cy was not animated: a static change.
    expect(mask).toMatchObject({ cy: 900 });
    const replaced = applied(keyed, {
      type: 'set_mask_geometry',
      maskId: 'c1__mask',
      sourceTime: 4,
      geometry: {
        kind: 'rectangle',
        cx: 50,
        cy: 900,
        width: 800,
        height: 600,
        rotation: 0,
        roundness: 0,
      },
    });
    expect(masksOn(replaced)[0]!.keyframes.find((keyframe) => keyframe.id === 'k1')?.value).toBe(
      50,
    );
  });

  it('replaces a static path, keys an animated one at a new instant', () => {
    const moved = SQUARE.map((vertex) => ({ ...vertex, x: vertex.x + 10.5 }));
    const single = applied(timeline([pathMask([{ id: 'p0', sourceTime: 2, dx: 0 }])]), {
      type: 'set_mask_geometry',
      maskId: 'c1__mask',
      sourceTime: 5,
      geometry: { kind: 'path', vertices: moved },
    });
    const one = masksOn(single)[0] as PathMask;
    expect(one.pathKeyframes).toHaveLength(1);
    expect(maskPathVerticesAt(one, 2)[0]!.x).toBe(110.5);

    const animated = timeline([
      pathMask([
        { id: 'p0', sourceTime: 2, dx: 0 },
        { id: 'p1', sourceTime: 4, dx: 100 },
      ]),
    ]);
    const keyed = masksOn(
      applied(animated, {
        type: 'set_mask_geometry',
        maskId: 'c1__mask',
        sourceTime: 3,
        geometry: { kind: 'path', vertices: moved },
      }),
    )[0] as PathMask;
    expect(keyed.pathKeyframes.map((keyframe) => keyframe.sourceTime)).toEqual([2, 3, 4]);
    expect(
      compile(animated, {
        type: 'set_mask_geometry',
        maskId: 'c1__mask',
        sourceTime: 3,
        geometry: { kind: 'path', vertices: [...moved, corner(0, 0)] },
      }),
    ).toMatchObject({ code: 'not_editable' });
  });

  it('refuses a kind change', () => {
    expect(
      compile(timeline([rect()]), {
        type: 'set_mask_geometry',
        maskId: 'c1__mask',
        sourceTime: 3,
        geometry: { kind: 'path', vertices: SQUARE },
      }),
    ).toMatchObject({ code: 'not_editable' });
  });
});

describe('set_mask_properties', () => {
  const animatedFeather = rect({
    featherOuterPx: 5,
    keyframes: [
      { id: 'f0', sourceTime: 2, property: 'featherOuterPx', value: 10 },
      { id: 'f1', sourceTime: 5, property: 'featherOuterPx', value: 40 },
    ],
  });

  it('changes settings and static scalars in one update', () => {
    const after = applied(timeline([rect()]), {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 3,
      changes: { mode: 'subtract', invert: true, opacity: 0.5, name: 'Face' },
    });
    expect(masksOn(after)[0]).toMatchObject({
      mode: 'subtract',
      invert: true,
      opacity: 0.5,
      name: 'Face',
    });
  });

  it('keys an animated scalar at the instant by default', () => {
    const after = applied(timeline([animatedFeather]), {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 3,
      changes: { featherOuterPx: 12 },
    });
    expect(masksOn(after)[0]!.keyframes).toHaveLength(3);
  });

  it('applies to all keyframes with one update_mask offsetting every keyframe', () => {
    const tl = timeline([animatedFeather]);
    const result = compile(tl, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 2,
      changes: { featherOuterPx: 15 },
      allKeyframes: true,
    });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.patch.operations).toHaveLength(1);
    expect(result.patch.operations[0]).toMatchObject({
      type: 'update_mask',
      keyframeOffsets: { featherOuterPx: 5 },
    });
    const after = applied(tl, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 2,
      changes: { featherOuterPx: 0 },
      allKeyframes: true,
    });
    // Offset −10 clamps the first keyframe at 0 (feather cannot be negative).
    expect(masksOn(after)[0]!.keyframes.map((keyframe) => keyframe.value)).toEqual([0, 30]);
  });

  it('refuses non-finite numbers', () => {
    expect(
      compile(timeline([rect()]), {
        type: 'set_mask_properties',
        maskId: 'c1__mask',
        sourceTime: 3,
        changes: { opacity: Number.POSITIVE_INFINITY },
      }),
    ).toMatchObject({ code: 'not_editable' });
  });
});

describe('toggle_mask_keyframe', () => {
  it('adds a scalar keyframe with the current value, then removes it restoring the static value', () => {
    const tl = timeline([rect({ opacity: 0.75 })]);
    const added = applied(tl, {
      type: 'toggle_mask_keyframe',
      maskId: 'c1__mask',
      property: 'opacity',
      sourceTime: 3,
    });
    expect(masksOn(added)[0]!.keyframes).toMatchObject([
      { property: 'opacity', value: 0.75, sourceTime: 3 },
    ]);
    const removed = applied(added, {
      type: 'toggle_mask_keyframe',
      maskId: 'c1__mask',
      property: 'opacity',
      sourceTime: 3,
    });
    expect(masksOn(removed)[0]).toMatchObject({ opacity: 0.75, keyframes: [] });
    expect(maskKeyframeTimes(masksOn(added)[0]!, 'opacity')).toEqual([3]);
  });

  it('adds a path keyframe with the interpolated shape and refuses removing the only one', () => {
    const tl = timeline([
      pathMask([
        { id: 'p0', sourceTime: 2, dx: 0 },
        { id: 'p1', sourceTime: 4, dx: 100 },
      ]),
    ]);
    const added = masksOn(
      applied(tl, {
        type: 'toggle_mask_keyframe',
        maskId: 'c1__mask',
        property: 'path',
        sourceTime: 3,
      }),
    )[0] as PathMask;
    expect(maskPathVerticesAt(added, 3)[0]!.x).toBe(150);
    expect(maskKeyframeTimes(added)).toEqual([2, 3, 4]);
    const single = timeline([pathMask([{ id: 'p0', sourceTime: 2, dx: 0 }])]);
    expect(
      compile(single, {
        type: 'toggle_mask_keyframe',
        maskId: 'c1__mask',
        property: 'path',
        sourceTime: 2,
      }),
    ).toMatchObject({ code: 'nothing_to_change' });
    expect(
      compile(timeline([rect()]), {
        type: 'toggle_mask_keyframe',
        maskId: 'c1__mask',
        property: 'path',
        sourceTime: 2,
      }),
    ).toMatchObject({ code: 'not_editable' });
    expect(
      compile(timeline([rect()]), {
        type: 'toggle_mask_keyframe',
        maskId: 'c1__mask',
        property: 'rx',
        sourceTime: 2,
      }),
    ).toMatchObject({ code: 'not_editable' });
  });
});

describe('vertices', () => {
  const tl = timeline([
    pathMask([
      { id: 'p0', sourceTime: 2, dx: 0 },
      { id: 'p1', sourceTime: 4, dx: 100 },
    ]),
  ]);

  it('inserts a vertex on every keyframe', () => {
    const after = masksOn(
      applied(tl, { type: 'insert_mask_vertex', maskId: 'c1__mask', segment: 0, t: 0.5 }),
    )[0] as PathMask;
    expect(after.pathKeyframes.every((keyframe) => keyframe.vertexTypes.length === 5)).toBe(true);
  });

  it('removes several vertices highest first and refuses going below three', () => {
    const five = applied(tl, {
      type: 'insert_mask_vertex',
      maskId: 'c1__mask',
      segment: 0,
      t: 0.5,
    });
    const after = masksOn(
      applied(five, { type: 'remove_mask_vertices', maskId: 'c1__mask', vertices: [1, 3] }),
    )[0] as PathMask;
    expect(maskPathVerticesAt(after, 2).map((vertex) => [vertex.x, vertex.y])).toEqual([
      [100, 100],
      [300, 100],
      [100, 300],
    ]);
    expect(
      compile(tl, { type: 'remove_mask_vertices', maskId: 'c1__mask', vertices: [0, 1] }),
    ).toMatchObject({
      code: 'too_few_vertices',
    });
    expect(
      compile(tl, { type: 'remove_mask_vertices', maskId: 'c1__mask', vertices: [99] }),
    ).toMatchObject({
      code: 'nothing_to_change',
    });
  });
});

describe('stack commands', () => {
  const tl = timeline([rect(), rect({ id: 'second', color: '#f97316' })]);

  it('reorders, and refuses the order it already has', () => {
    const after = applied(tl, { type: 'reorder_masks', maskIds: ['second', 'c1__mask'] });
    expect(masksOn(after).map((mask) => mask.id)).toEqual(['second', 'c1__mask']);
    expect(compile(tl, { type: 'reorder_masks', maskIds: ['c1__mask', 'second'] })).toMatchObject({
      code: 'nothing_to_change',
    });
  });

  it('removes, duplicates with renamed keyframes, and retargets', () => {
    expect(masksOn(applied(tl, { type: 'remove_mask', maskId: 'second' }))).toHaveLength(1);
    const withKeys = timeline([
      rect({
        name: 'Face',
        keyframes: [{ id: 'c1__mask__cx__0', sourceTime: 2, property: 'cx', value: 1 }],
      }),
    ]);
    const duplicated = masksOn(applied(withKeys, { type: 'duplicate_mask', maskId: 'c1__mask' }));
    expect(duplicated.map((mask) => mask.name)).toEqual(['Face copy', 'Face']);
    expect(duplicated[0]!.keyframes[0]!.id).toBe('c1__mask_2__cx__0');
    expect(nextMaskColor({ masks: [...duplicated] })).not.toBe(duplicated[0]!.color);
  });

  it('pastes masks rescaled to the target picture', () => {
    const after = applied(timeline([]), {
      type: 'paste_masks',
      clipId: 'c2',
      clipboard: {
        assetId: 'a1',
        width: 3840,
        height: 2160,
        sourceStart: 2,
        masks: [MaskLayerSchema.parse(rect())],
      },
    });
    expect(masksOn(after, 'c2')[0]).toMatchObject({ cx: 960, cy: 540, width: 400, height: 300 });
    expect(
      compile(timeline([]), {
        type: 'paste_masks',
        clipboard: { assetId: 'a1', width: 3840, height: 2160, sourceStart: 2, masks: [] },
      }),
    ).toMatchObject({ code: 'nothing_to_change' });
  });

  it('moves keyframes in the direction of travel without colliding', () => {
    const keyed = timeline([
      rect({
        keyframes: [
          { id: 'a', sourceTime: 2, property: 'cx', value: 1 },
          { id: 'b', sourceTime: 2.5, property: 'cx', value: 2 },
        ],
      }),
    ]);
    const after = applied(keyed, {
      type: 'move_mask_keyframes',
      maskId: 'c1__mask',
      keyframeIds: ['a', 'b'],
      deltaSeconds: 0.5,
    });
    expect(masksOn(after)[0]!.keyframes.map((keyframe) => keyframe.sourceTime)).toEqual([2.5, 3]);
    expect(
      compile(keyed, {
        type: 'move_mask_keyframes',
        maskId: 'c1__mask',
        keyframeIds: ['a'],
        deltaSeconds: 0,
      }),
    ).toMatchObject({ code: 'nothing_to_change' });
  });
});

describe('maskGeometryAt', () => {
  it('reads keyframed rectangle geometry and refuses normalized masks', () => {
    const mask = MaskLayerSchema.parse(
      rect({ keyframes: [{ id: 'k', sourceTime: 2, property: 'width', value: 10 }] }),
    );
    expect(maskGeometryAt(mask, 9)).toMatchObject({ kind: 'rectangle', width: 10, height: 600 });
    expect(maskGeometryAt({ ...mask, units: 'normalized' }, 2)).toBeNull();
  });
});
