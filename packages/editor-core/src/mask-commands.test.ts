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
  frameSpaceRefusal,
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

  it('places a split, a mirror band and a gradient (MK8.1), keyframing them like any mask', () => {
    let tl = applied(timeline(), {
      type: 'draw_mask',
      sourceTime: 2,
      geometry: { kind: 'linear', originX: 1920, originY: 1080, angle: 30, softnessPx: 12 },
    });
    expect(masksOn(tl)[0]).toMatchObject({ kind: 'linear', name: 'Split 1', angle: 30 });
    tl = applied(tl, {
      type: 'draw_mask',
      sourceTime: 2,
      geometry: {
        kind: 'band',
        originX: 1920,
        originY: 1080,
        angle: 0,
        widthPx: 400,
        softnessPx: 0,
      },
    });
    tl = applied(tl, {
      type: 'draw_mask',
      sourceTime: 2,
      geometry: {
        kind: 'gradient',
        shape: 'linear',
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 2160,
        curve: 'smooth',
      },
    });
    expect(masksOn(tl).map((mask) => mask.kind)).toEqual(['gradient', 'band', 'linear']);
    const split = masksOn(tl)[2]!;
    tl = applied(tl, {
      type: 'toggle_mask_keyframe',
      maskId: split.id,
      property: 'angle',
      sourceTime: 2,
    });
    tl = applied(tl, {
      type: 'set_mask_properties',
      maskId: split.id,
      sourceTime: 4,
      changes: { angle: 90, originX: 100 },
    });
    const keyed = masksOn(tl)[2]!;
    expect(keyed.keyframes.map((keyframe) => [keyframe.property, keyframe.value])).toEqual([
      ['angle', 30],
      ['angle', 90],
    ]);
    expect(keyed).toMatchObject({ originX: 100 });
  });

  it('refuses a zero-width band, a gradient with no length and edge controls on a gradient', () => {
    expect(
      compile(timeline(), {
        type: 'draw_mask',
        sourceTime: 2,
        geometry: { kind: 'band', originX: 1, originY: 1, angle: 0, widthPx: 0, softnessPx: 0 },
      }),
    ).toMatchObject({ code: 'not_editable' });
    expect(
      compile(timeline(), {
        type: 'draw_mask',
        sourceTime: 2,
        geometry: {
          kind: 'gradient',
          shape: 'radial',
          startX: 5,
          startY: 5,
          endX: 5,
          endY: 5,
          curve: 'linear',
        },
      }),
    ).toMatchObject({ code: 'not_editable' });
    const gradient = applied(timeline(), {
      type: 'draw_mask',
      sourceTime: 2,
      geometry: {
        kind: 'gradient',
        shape: 'linear',
        startX: 0,
        startY: 0,
        endX: 10,
        endY: 0,
        curve: 'linear',
      },
    });
    const result = compile(gradient, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 2,
      changes: { featherOuterPx: 8 },
    });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(JSON.stringify(result)).toMatch(/no edge to grow or soften/);
  });

  it('inserts a shape preset as ordinary path masks, a frame as two in one undo (MK8.3)', () => {
    let tl = applied(timeline([rect({ id: 'existing' })]), {
      type: 'draw_shape_preset',
      preset: 'star',
      box: { cx: 1920, cy: 1080, width: 800, height: 800 },
      options: { points: 6 },
      sourceTime: 2,
    });
    const star = masksOn(tl)[0] as PathMask;
    expect(star).toMatchObject({ kind: 'path', name: 'Star', mode: 'add' });
    expect(star.pathKeyframes[0]!.vertexTypes).toHaveLength(12);
    expect(star.pathKeyframes[0]!.sourceTime).toBe(2);
    const result = compile(tl, {
      type: 'draw_shape_preset',
      preset: 'rounded-frame',
      box: { cx: 1920, cy: 1080, width: 3000, height: 1800 },
      sourceTime: 2,
    });
    expect(result.status).toBe('compiled');
    tl = applied(tl, {
      type: 'draw_shape_preset',
      preset: 'rounded-frame',
      box: { cx: 1920, cy: 1080, width: 3000, height: 1800 },
      sourceTime: 2,
    });
    const [outer, inner] = masksOn(tl);
    expect(outer).toMatchObject({ kind: 'path', name: 'Rounded frame (outer)', mode: 'add' });
    expect(inner).toMatchObject({
      kind: 'path',
      name: 'Rounded frame (inner)',
      mode: 'subtract',
    });
    expect(outer!.id).not.toBe(inner!.id);
    expect(outer!.color).not.toBe(inner!.color);
    expect(
      compile(timeline(), {
        type: 'draw_shape_preset',
        preset: 'heart',
        box: { cx: 1, cy: 1, width: 0, height: 10 },
        sourceTime: 0,
      }),
    ).toMatchObject({ status: 'rejected', code: 'not_editable' });
  });

  it('adds a track matte reading another clip or a track, and refuses a loop (MK8.2)', () => {
    const tl = timeline();
    // The fixture timeline's second clip (c2) is the source here.
    const after = applied(tl, {
      type: 'add_track_matte',
      source: { kind: 'clip', clipId: 'c2' },
      channel: 'luma',
    });
    expect(masksOn(after)[0]).toMatchObject({
      kind: 'layer',
      name: 'Track matte 1',
      source: { kind: 'clip', clipId: 'c2' },
      channel: 'luma',
    });
    expect(
      compile(tl, { type: 'add_track_matte', source: { kind: 'clip', clipId: 'c1' } }),
    ).toMatchObject({ status: 'rejected', code: 'not_editable' });
    expect(
      compile(tl, { type: 'add_track_matte', source: { kind: 'track', trackId: 'nope' } }),
    ).toMatchObject({ status: 'rejected', code: 'missing_track' });
    const back = compileMaskCommand({
      timeline: after,
      assets: ASSETS,
      command: {
        type: 'add_track_matte',
        timelineRevision: 3,
        clipId: 'c2',
        source: { kind: 'clip', clipId: 'c1' },
      },
    });
    expect(back).toMatchObject({ status: 'rejected', code: 'invalid_patch' });
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
    ).toMatchObject({ code: 'not_editable' });
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

describe('mask presets (schema v23)', () => {
  it('saves shape masks as a preset, applies it rescaled to another clip, and deletes it', () => {
    const tl = timeline([rect({ name: 'Face' })]);
    const saved = applied(tl, {
      type: 'save_mask_preset',
      name: 'Face box',
      maskIds: ['c1__mask'],
    });
    expect(saved.maskPresets).toMatchObject([
      { id: 'preset__face_box', name: 'Face box', width: 3840, height: 2160, sourceStart: 2 },
    ]);
    const onOther = applied(saved, {
      type: 'apply_mask_preset',
      clipId: 'c2',
      presetId: 'preset__face_box',
    });
    expect(masksOn(onOther, 'c2')[0]).toMatchObject({ cx: 960, cy: 540, width: 400, height: 300 });
    const removed = applied(saved, { type: 'remove_mask_preset', presetId: 'preset__face_box' });
    expect(removed.maskPresets).toBeUndefined();
  });

  it('gives a second preset with the same name a free id and refuses empty or matte-only saves', () => {
    const tl = timeline([rect()]);
    const once = applied(tl, { type: 'save_mask_preset', name: 'Box', maskIds: ['c1__mask'] });
    const twice = applied(once, { type: 'save_mask_preset', name: 'Box', maskIds: ['c1__mask'] });
    expect(twice.maskPresets?.map((preset) => preset.id)).toEqual(['preset__box', 'preset__box_2']);
    expect(
      compile(tl, { type: 'save_mask_preset', name: '  ', maskIds: ['c1__mask'] }),
    ).toMatchObject({
      code: 'not_editable',
    });
    expect(compile(tl, { type: 'save_mask_preset', name: 'X', maskIds: [] })).toMatchObject({
      code: 'nothing_to_change',
    });
    expect(compile(tl, { type: 'apply_mask_preset', presetId: 'gone' })).toMatchObject({
      code: 'missing_mask',
    });
    expect(compile(tl, { type: 'remove_mask_preset', presetId: 'gone' })).toMatchObject({
      code: 'missing_mask',
    });
  });
});

/**
 * MK5.1: "Add mask" on an effect row draws a mask that already limits that effect, and the
 * panel's target menu retargets an existing one. Both refuse an effect the clip does not carry.
 */
describe('effect-target masks', () => {
  /** The `c1` timeline with one grade the mask can be pointed at. */
  const withGrade = (masks: MaskLayerInput[] = []): Timeline => {
    const tl = timeline(masks);
    const clip = tl.tracks[0]!.clips[0]!;
    return {
      ...tl,
      tracks: [
        {
          ...tl.tracks[0]!,
          clips: [
            {
              ...clip,
              effects: [{ id: 'grade', type: 'color_grade', params: {}, keyframes: [] }],
            },
            tl.tracks[0]!.clips[1]!,
          ],
        },
      ],
    } as unknown as Timeline;
  };

  const SQUARE_GEOMETRY = {
    kind: 'rectangle',
    cx: 1000,
    cy: 800,
    width: 400,
    height: 300,
    rotation: 0,
    roundness: 0,
  } as const;

  it('draws a mask that already targets the effect, in one reversible operation', () => {
    const tl = withGrade();
    const after = applied(tl, {
      type: 'draw_mask',
      sourceTime: 0,
      geometry: SQUARE_GEOMETRY,
      target: { kind: 'effect', effectId: 'grade' },
    });
    expect(masksOn(after)).toHaveLength(1);
    expect(masksOn(after)[0]!.target).toEqual({ kind: 'effect', effectId: 'grade' });
  });

  it('draws an alpha mask when no target is armed', () => {
    const after = applied(withGrade(), {
      type: 'draw_mask',
      sourceTime: 0,
      geometry: SQUARE_GEOMETRY,
    });
    expect(masksOn(after)[0]!.target).toEqual({ kind: 'alpha' });
  });

  it('retargets an existing mask and back again', () => {
    const tl = withGrade([rect()]);
    const after = applied(tl, {
      type: 'set_mask_target',
      maskId: 'c1__mask',
      target: { kind: 'effect', effectId: 'grade' },
    });
    expect(masksOn(after)[0]!.target).toEqual({ kind: 'effect', effectId: 'grade' });
    const back = applied(after, {
      type: 'set_mask_target',
      maskId: 'c1__mask',
      target: { kind: 'alpha' },
    });
    expect(masksOn(back)[0]!.target).toEqual({ kind: 'alpha' });
  });

  it('refuses an effect that is not on the clip, with the remedy', () => {
    const tl = withGrade([rect()]);
    const drawn = compile(tl, {
      type: 'draw_mask',
      sourceTime: 0,
      geometry: SQUARE_GEOMETRY,
      target: { kind: 'effect', effectId: 'not-here' },
    });
    expect(drawn).toMatchObject({ code: 'missing_effect' });
    expect(drawn.status === 'rejected' ? drawn.detail : '').toContain('Add the effect first.');
    expect(
      compile(tl, {
        type: 'set_mask_target',
        maskId: 'c1__mask',
        target: { kind: 'effect', effectId: 'not-here' },
      }),
    ).toMatchObject({ code: 'missing_effect' });
  });
});

// ---------------------------------------------------------------------------
// MK9.4 — fixing a clip mask to the frame (the Inspector toggle and the agent's `space`)
// ---------------------------------------------------------------------------

describe('set_mask_space', () => {
  it('fixes a shape to the frame and back, keeping its numbers, one undo step each', () => {
    const tl = timeline([rect()]);
    const fixed = applied(tl, { type: 'set_mask_space', maskId: 'c1__mask', space: 'frame' });
    expect(masksOn(fixed)[0]).toMatchObject({ space: 'frame', cx: 1920, cy: 1080, width: 800 });
    const result = compile(tl, { type: 'set_mask_space', maskId: 'c1__mask', space: 'frame' });
    expect(result.status === 'compiled' && result.patch.operations).toEqual([
      { type: 'set_mask_space', clipId: 'c1', maskId: 'c1__mask', space: 'frame' },
    ]);
    const back = applied(fixed, { type: 'set_mask_space', maskId: 'c1__mask', space: 'source' });
    expect(masksOn(back)[0]!.space).toBe('source');
  });

  it('fixes a split to the frame', () => {
    const split = {
      kind: 'linear',
      id: 'c1__mask',
      originX: 1920,
      originY: 1080,
      angle: 0,
    } as unknown as MaskLayerInput;
    const fixed = applied(timeline([split]), {
      type: 'set_mask_space',
      maskId: 'c1__mask',
      space: 'frame',
    });
    expect(masksOn(fixed)[0]!.space).toBe('frame');
  });

  it('says nothing changed when the mask is already in that space', () => {
    expect(
      compile(timeline([rect()]), { type: 'set_mask_space', maskId: 'c1__mask', space: 'source' }),
    ).toMatchObject({ status: 'rejected', code: 'nothing_to_change' });
  });

  it('refuses what follows the picture, with the remedy the export gives', () => {
    const key = {
      kind: 'key',
      id: 'c1__mask',
      model: 'hsl',
      ranges: [{ channel: 'hue', low: 0.2, high: 0.4, softness: 0.05 }],
    } as unknown as MaskLayerInput;
    const refused = compile(timeline([key]), {
      type: 'set_mask_space',
      maskId: 'c1__mask',
      space: 'frame',
    });
    expect(refused).toMatchObject({ status: 'rejected', code: 'not_editable' });
    expect(refused.status === 'rejected' ? refused.detail : '').toContain('follows the picture');
    const legacy = MaskLayerSchema.parse(rect({ featherModel: 'gaussian-legacy' }));
    expect(frameSpaceRefusal(legacy)).toContain('Redraw it first');
    expect(frameSpaceRefusal(MaskLayerSchema.parse(rect()))).toBeNull();
    const tracked = MaskLayerSchema.parse({
      ...rect(),
      tracking: {
        artifact: { key: 'a'.repeat(64), sha256: 'b'.repeat(64) },
        method: 'position',
        referenceSourceTime: 3,
      },
    });
    expect(frameSpaceRefusal(tracked)).toContain('Clear the track');
  });

  it('refuses on an adjustment lane, whose masks are always fixed to the frame', () => {
    const tl = {
      ...timeline(),
      tracks: [
        {
          id: 'fx',
          type: 'effect',
          clips: [],
          effectLayers: [
            {
              id: 'lane',
              effectId: 'soft-veil',
              kind: 'blur-gaussian',
              start: 1,
              end: 3,
              params: { radius: 8 },
              keyframes: [],
              masks: [MaskLayerSchema.parse({ ...rect({ id: 'lane__mask' }), space: 'frame' })],
            },
          ],
        },
        ...timeline().tracks,
      ],
    } as unknown as Timeline;
    expect(
      compile(tl, {
        type: 'set_mask_space',
        clipId: 'lane',
        owner: 'effect_layer',
        maskId: 'lane__mask',
        space: 'source',
      }),
    ).toMatchObject({ status: 'rejected', code: 'not_editable' });
  });
});

// ---------------------------------------------------------------------------
// MK7.3 — the track, its constraints and its review
// ---------------------------------------------------------------------------

describe('tracking commands', () => {
  const KEY = 'a'.repeat(64);
  const TRACKING = {
    artifact: { key: KEY, sha256: 'b'.repeat(64) },
    method: 'position' as const,
    referenceSourceTime: 3,
  };
  const RECT: MaskLayerInput = {
    id: 'm1',
    kind: 'rectangle',
    cx: 200,
    cy: 200,
    width: 100,
    height: 100,
  };

  function tracked(): Timeline {
    return applied(timeline([RECT]), {
      type: 'set_mask_track',
      maskId: 'm1',
      tracking: TRACKING,
    });
  }

  it('attaches a measured track, reversibly', () => {
    const after = tracked();
    expect(masksOf(after.tracks[0]!.clips[0]!)[0]!.tracking).toMatchObject({
      artifact: { key: KEY },
      method: 'position',
    });
  });

  it('records the frame the editor fixed as a constraint', () => {
    const after = applied(tracked(), {
      type: 'add_track_constraint',
      maskId: 'm1',
      sourceTime: 3.5,
    });
    expect(masksOf(after.tracks[0]!.clips[0]!)[0]!.tracking?.constraints).toEqual([
      { sourceTime: 3.5 },
    ]);
  });

  it('refuses a constraint on an untracked mask, and a duplicate one', () => {
    expect(
      compile(timeline([RECT]), { type: 'add_track_constraint', maskId: 'm1', sourceTime: 3 }),
    ).toMatchObject({ status: 'rejected', code: 'missing_track' });
    const once = applied(tracked(), {
      type: 'add_track_constraint',
      maskId: 'm1',
      sourceTime: 3.5,
    });
    expect(
      compile(once, { type: 'add_track_constraint', maskId: 'm1', sourceTime: 3.5 }),
    ).toMatchObject({ status: 'rejected', code: 'nothing_to_change' });
  });

  it('stores the review the editor left on the track', () => {
    const after = applied(tracked(), {
      type: 'review_mask_track',
      maskId: 'm1',
      review: { flagged: [], approved: [{ start: 3, end: 4 }], locked: [3.5] },
    });
    expect(masksOf(after.tracks[0]!.clips[0]!)[0]!.tracking?.review).toMatchObject({
      approved: [{ start: 3, end: 4 }],
      locked: [3.5],
    });
  });

  it('detaches a track, and refuses to detach one that is not there', () => {
    const after = applied(tracked(), { type: 'clear_mask_track', maskId: 'm1' });
    expect(masksOf(after.tracks[0]!.clips[0]!)[0]!.tracking).toBeUndefined();
    expect(compile(timeline([RECT]), { type: 'clear_mask_track', maskId: 'm1' })).toMatchObject({
      status: 'rejected',
      code: 'nothing_to_change',
    });
  });
});

/**
 * MK6.1: a key's structured fields (`ranges`, `samples3d`, `finesse`) travel through
 * `set_mask_properties` whole, and a malformed one is refused by the schema, not stored.
 */
describe('key mask properties', () => {
  const keyMask = (over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
    ({
      kind: 'key',
      id: 'c1__mask',
      model: 'hsl',
      ranges: [{ channel: 'hue', low: 0.2, high: 0.4, softness: 0.05 }],
      ...over,
    }) as MaskLayerInput;

  const keyOn = (tl: Timeline) => masksOn(tl)[0] as Extract<MaskLayer, { kind: 'key' }> | undefined;

  it('writes ranges, samples and finesse as one reversible edit', () => {
    const tl = timeline([keyMask()]);
    const after = applied(tl, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 0,
      changes: {
        model: '3d',
        ranges: [],
        samples3d: [[0, 0.7, 0.25]],
        softness: 0.2,
        finesse: { blurPx: 2, cleanBlack: 0.1 },
      },
    });
    const mask = keyOn(after)!;
    expect(mask.model).toBe('3d');
    expect(mask.samples3d).toEqual([[0, 0.7, 0.25]]);
    expect(mask.finesse.blurPx).toBe(2);
    expect(mask.finesse.cleanBlack).toBe(0.1);
    // Untouched finesse fields keep their defaults rather than disappearing.
    expect(mask.finesse.cleanWhite).toBe(1);
  });

  it('refuses a range outside the schema instead of storing it', () => {
    const tl = timeline([keyMask()]);
    const rejected = compile(tl, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 0,
      changes: { ranges: [{ channel: 'chroma', low: 0, high: 1 }] },
    });
    expect(rejected.status).toBe('rejected');
    expect(keyOn(tl)!.ranges).toHaveLength(1);
  });

  it('keeps opacity animatable while the structured fields stay static', () => {
    const tl = timeline([keyMask()]);
    const after = applied(tl, {
      type: 'set_mask_properties',
      maskId: 'c1__mask',
      sourceTime: 1.5,
      changes: { opacity: 0.5, despill: 'green' },
    });
    const mask = keyOn(after)!;
    expect(mask.despill).toBe('green');
    expect(mask.opacity).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Background removal (BR6): a finished pack run becomes a reversible matte
// ---------------------------------------------------------------------------

const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

const artifact = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  files: [{ name: 'matte.mkv', sha256: SHA }],
  width: 3840,
  height: 2160,
  coverage: { sourceStart: 0, sourceEnd: 8 },
  packId: 'smart-mask',
  packVersion: '1.0.0',
  modelDigests: [SHA],
  ...over,
});

const matteMask = (over: Partial<MaskLayerInput> = {}): MaskLayerInput =>
  ({ kind: 'matte', id: 'c1__mask', artifact: artifact(), ...over }) as MaskLayerInput;

const matteOn = (tl: Timeline): (MaskLayer & { kind: 'matte' }) | null => {
  const found = masksOn(tl).find((mask) => mask.kind === 'matte');
  return found?.kind === 'matte' ? found : null;
};

describe('add_matte_mask', () => {
  it('adds the matte at the top of the stack with its artifact and review', () => {
    const tl = timeline([rect({ id: 'existing' })]);
    const after = applied(tl, {
      type: 'add_matte_mask',
      artifact: artifact(),
      prompts: [{ kind: 'points', sourceTime: 2, points: [{ x: 0.5, y: 0.4, label: 'include' }] }],
      review: { flagged: [{ start: 3, end: 3.5 }], approved: [], locked: [] },
    });
    const masks = masksOn(after);
    expect(masks[0]!.kind).toBe('matte');
    expect(masks[1]!.id).toBe('existing');
    const matte = matteOn(after)!;
    expect(matte.artifact.key).toBe(KEY);
    expect(matte.review.flagged).toEqual([{ start: 3, end: 3.5 }]);
    expect(matte.prompts).toHaveLength(1);
  });

  it('replaces the named matte rather than stacking a second one on a re-run', () => {
    const tl = timeline([matteMask()]);
    const after = applied(tl, {
      type: 'add_matte_mask',
      maskId: 'c1__mask',
      artifact: artifact({ key: 'c'.repeat(64) }),
      review: { flagged: [], approved: [], locked: [] },
    });
    expect(masksOn(after)).toHaveLength(1);
    expect(matteOn(after)!.artifact.key).toBe('c'.repeat(64));
  });

  it('refuses to replace a shape mask with a matte', () => {
    const rejected = compile(timeline([rect()]), {
      type: 'add_matte_mask',
      maskId: 'c1__mask',
      artifact: artifact(),
    });
    expect(rejected.status).toBe('rejected');
  });
});

describe('review_matte', () => {
  it('records an approval as one reversible edit', () => {
    const tl = timeline([matteMask({ review: { flagged: [{ start: 3, end: 3.5 }] } })]);
    const after = applied(tl, {
      type: 'review_matte',
      maskId: 'c1__mask',
      review: { flagged: [], approved: [{ start: 3, end: 3.5 }], locked: [] },
    });
    expect(matteOn(after)!.review).toEqual({
      flagged: [],
      approved: [{ start: 3, end: 3.5 }],
      locked: [],
    });
  });

  it('refuses a mask that is not a background removal', () => {
    const rejected = compile(timeline([rect()]), {
      type: 'review_matte',
      maskId: 'c1__mask',
      review: { flagged: [], approved: [], locked: [] },
    });
    expect(rejected.status).toBe('rejected');
  });
});

describe('text_behind_subject', () => {
  it('compiles to the composite operation, naming the clip’s matte', () => {
    const result = compile(timeline([matteMask()]), {
      type: 'text_behind_subject',
      text: 'BEHIND',
    });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.patch.operations[0]).toMatchObject({
      type: 'add_text_behind_subject',
      clipId: 'c1',
      maskId: 'c1__mask',
      text: 'BEHIND',
    });
  });

  it('asks for a background removal first when the clip has none', () => {
    const rejected = compile(timeline([rect()]), { type: 'text_behind_subject', text: 'HI' });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') return;
    expect(rejected.detail).toContain('Remove the background');
  });

  it('refuses empty text instead of creating a blank text clip', () => {
    const rejected = compile(timeline([matteMask()]), {
      type: 'text_behind_subject',
      text: '   ',
    });
    expect(rejected.status).toBe('rejected');
  });

  it('takes a second title on a shot whose matte already moved to its front copy', () => {
    // The refusal the captured run hit: "Remove the background on this clip first" on a shot
    // whose background WAS removed — by the first title, which moved the matte forward.
    const first = compile(timeline([matteMask()]), {
      type: 'text_behind_subject',
      text: 'ONE',
      start: 0,
      end: 1,
    });
    expect(first.status).toBe('compiled');
    if (first.status !== 'compiled') return;
    const withSandwich = applyPatch(timeline([matteMask()]), first.patch);
    const second = compile(withSandwich, {
      type: 'text_behind_subject',
      timelineRevision: withSandwich.revision,
      text: 'TWO',
      start: 2,
      end: 3,
    });
    expect(second.status).toBe('compiled');
    if (second.status !== 'compiled') return;
    expect(second.patch.operations[0]).toMatchObject({
      type: 'add_text_behind_subject',
      clipId: 'c1',
      text: 'TWO',
      start: 2,
      end: 3,
    });
  });
});

describe('adjustment-lane stacks (MK9.1, owner: effect_layer)', () => {
  const withLane = (masks: MaskLayerInput[] = []): Timeline => {
    const base = timeline();
    return {
      ...base,
      tracks: [
        {
          id: 'fx',
          type: 'effect',
          clips: [],
          effectLayers: [
            {
              id: 'lane',
              effectId: 'soft-veil',
              kind: 'blur-gaussian',
              start: 1,
              end: 3,
              params: { radius: 8 },
              keyframes: [],
              ...(masks.length > 0
                ? { masks: masks.map((mask) => MaskLayerSchema.parse({ ...mask, space: 'frame' })) }
                : {}),
            },
          ],
        },
        ...base.tracks,
      ],
    } as unknown as Timeline;
  };
  const laneMasks = (tl: Timeline): readonly MaskLayer[] =>
    masksOf(tl.tracks[0]!.effectLayers![0]!);

  it('draws a frame-space mask on the lane with the clip command, one undo step', () => {
    const tl = withLane();
    const after = applied(tl, {
      type: 'draw_mask',
      clipId: 'lane',
      owner: 'effect_layer',
      sourceTime: 0.5,
      geometry: {
        kind: 'rectangle',
        cx: 540,
        cy: 400,
        width: 300,
        height: 200,
        rotation: 0,
        roundness: 0,
      },
    });
    const [mask] = laneMasks(after);
    expect(mask).toMatchObject({ id: 'lane__mask', kind: 'rectangle', space: 'frame', cx: 540 });
    // The clips' stacks are untouched.
    expect(masksOn({ ...after, tracks: after.tracks.slice(1) })).toEqual([]);
  });

  it('draws with no measured media (a lane has none) and keys an instant on the lane clock', () => {
    const tl = withLane([
      rect({ id: 'lane__mask', cx: 540, cy: 400, width: 300, height: 200 }) as MaskLayerInput,
    ]);
    const keyed = applied(tl, {
      type: 'toggle_mask_keyframe',
      clipId: 'lane',
      owner: 'effect_layer',
      maskId: 'lane__mask',
      property: 'cx',
      sourceTime: 0.25,
    });
    expect(laneMasks(keyed)[0]!.keyframes).toMatchObject([{ property: 'cx', sourceTime: 0.25 }]);
    const moved = applied(tl, {
      type: 'set_mask_properties',
      clipId: 'lane',
      owner: 'effect_layer',
      maskId: 'lane__mask',
      sourceTime: 0,
      changes: { featherOuterPx: 12, invert: true },
    });
    expect(laneMasks(moved)[0]).toMatchObject({ featherOuterPx: 12, invert: true, space: 'frame' });
  });

  it('refuses what only a clip picture can have, and a lane that does not exist', () => {
    const tl = withLane([rect({ id: 'lane__mask' }) as MaskLayerInput]);
    const matte = compile(tl, {
      type: 'add_track_matte',
      clipId: 'lane',
      owner: 'effect_layer',
      source: { kind: 'clip', clipId: 'c2' },
    });
    expect(matte.status).toBe('rejected');
    if (matte.status === 'rejected') expect(matte.code).toBe('not_editable');
    const missing = compile(tl, {
      type: 'remove_mask',
      clipId: 'nope',
      owner: 'effect_layer',
      maskId: 'lane__mask',
    });
    expect(missing.status === 'rejected' && missing.code).toBe('missing_clip');
    const effectTarget = compile(tl, {
      type: 'draw_mask',
      clipId: 'lane',
      owner: 'effect_layer',
      sourceTime: 0,
      target: { kind: 'effect', effectId: 'g1' },
      geometry: { kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5, rotation: 0 },
    });
    expect(effectTarget.status).toBe('rejected');
  });
});
