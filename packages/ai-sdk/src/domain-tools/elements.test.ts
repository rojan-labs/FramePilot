/**
 * The agent's shape tools (plan/elements EL4a, EL5): `search_elements` finds shapes and icons with
 * the Shapes tab's ranking; `add_shape` places any of them as the tab would, with the model's box,
 * ends, colours, label and knobs; `set_shape_style` restyles one; both refuse a shape that would
 * draw nothing, with the validator's sentence. And a request that names shapes is routed to the
 * `elements` domain.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddShapeOps,
  elementRectAt,
  type AnyOperation,
} from '@framepilot/editor-core';
import { presetShapeParams, type Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { shapeBoxInFrame, shapeColour } from './elements.js';

const project = (): Project =>
  makeProject({
    timeline: {
      tracks: [
        { id: 'o1', type: 'overlay', clips: [] },
        { id: 'video_1', type: 'video', clips: [] },
      ],
    },
  } as never);

function run(name: string, args: Record<string, unknown>, on: Project): AnyOperation[] {
  const tool = getTool(name);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${name} is not a mutate tool`);
  return tool.buildOps(args, { project: on }) as AnyOperation[];
}

function apply(on: Project, ops: AnyOperation[]): Project {
  return applyProjectPatch(on, assembleEdit(on, ops, 'shape', 'agent').patch);
}

const shapeParamsOf = (on: Project) =>
  on.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.assetId === '__shape__')
    ?.effects[0]?.params;

describe('add_shape', () => {
  it('places a preset exactly where the Shapes tab would', () => {
    const base = project();
    const ops = run('add_shape', { shape: 'rounded-rect/highlight', start: 2, end: 5 }, base);
    const tabOps = buildAddShapeOps(
      base.timeline,
      presetShapeParams('rounded-rect/highlight')!,
      2,
      5,
    ).operations;
    expect(ops).toEqual(tabOps);
  });

  it('takes the box, ends and colours the model gives, in its own words', () => {
    const boxed = apply(
      project(),
      run(
        'add_shape',
        {
          shape: 'rounded-rect/highlight',
          start: 1,
          end: 3,
          box: { x: 62, y: 40, width: 18, height: 9 },
          stroke: 'red',
          strokeWidth: 1.2,
        },
        project(),
      ),
    );
    expect(shapeParamsOf(boxed)).toMatchObject({
      x: 62,
      y: 40,
      width: 18,
      height: 9,
      stroke: '#FF3B30',
      strokeWidth: 1.2,
    });
    const aimed = apply(
      project(),
      run(
        'add_shape',
        { shape: 'line-arrow/red', start: 1, end: 3, ends: { x1: 10, y1: 10, x2: 40, y2: 30 } },
        project(),
      ),
    );
    expect(shapeParamsOf(aimed)).toMatchObject({ x1: 10, y1: 10, x2: 40, y2: 30, endCap: 'arrow' });
  });

  it('turns a rotation into the clip’s rotation keyframe', () => {
    const ops = run(
      'add_shape',
      { shape: 'ellipse/outline', start: 0, end: 2, rotation: 30 },
      project(),
    );
    expect(ops.at(-1)).toMatchObject({
      type: 'add_keyframes',
      keyframes: [{ property: 'rotation', value: 30, time: 0 }],
    });
  });

  it('refuses a shape that would draw nothing, with the validator’s sentence', () => {
    expect(() =>
      run(
        'add_shape',
        { shape: 'rounded-rect/highlight', start: 0, end: 2, stroke: 'none' },
        project(),
      ),
    ).toThrow('A shape needs a fill or a stroke — with both off it draws nothing.');
  });

  it('refuses a colour it cannot read, and an unknown shape at the schema', () => {
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', start: 0, end: 2, fill: 'teal-ish' }, project()),
    ).toThrow(ToolRefusalError);
    // No echo of the id: a new wrong id each attempt must not read as progress to the guard.
    const refusal =
      'That shape is not in the catalogue. Find one with search_elements, or use a staple: ' +
      'rounded-rect/highlight, rounded-rect/filled, ellipse/outline, marker-highlight/yellow, ' +
      'line-arrow/red, underline-marker/yellow.';
    expect(() => run('add_shape', { shape: 'dodecahedron', start: 0, end: 2 }, project())).toThrow(
      refusal,
    );
    expect(() => run('add_shape', { shape: 'icon/nope', start: 0, end: 2 }, project())).toThrow(
      refusal,
    );
  });

  it('places any catalogue style, a shape by name, or an icon, with a label and knobs', () => {
    const star = shapeParamsOf(
      apply(
        project(),
        run('add_shape', { shape: 'star-5', start: 0, end: 2, knobs: { points: 7 } }, project()),
      ),
    );
    expect(star).toMatchObject({ shape: 'star-5', points: 7, fill: '#FFFFFF' });
    const badge = shapeParamsOf(
      apply(
        project(),
        run(
          'add_shape',
          { shape: 'numbered-circle/red-1', start: 0, end: 2, label: '3', labelColor: 'black' },
          project(),
        ),
      ),
    );
    expect(badge).toMatchObject({ label: '3', labelColor: '#111111', fill: '#FF3B30' });
    const icon = shapeParamsOf(
      apply(
        project(),
        run('add_shape', { shape: 'icon/check', start: 0, end: 2, stroke: 'green' }, project()),
      ),
    );
    expect(icon).toMatchObject({ shape: 'icon/check', stroke: '#34C759' });
    expect(() =>
      run('add_shape', { shape: 'star-5', start: 0, end: 2, knobs: { wobble: 1 } }, project()),
    ).toThrow("Shape parameter 'wobble' is not one this shape has.");
    expect(() =>
      run(
        'add_shape',
        { shape: 'rounded-rect/highlight', start: 0, end: 2, label: '1' },
        project(),
      ),
    ).toThrow("'rounded-rect' has no label");
  });

  it('refuses an empty time range with the remedy', () => {
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', start: 2, end: 2 }, project()),
    ).toThrow('end must be after start. Give the shape a time range.');
  });
});

describe('search_elements', () => {
  function search(args: Record<string, unknown>) {
    const tool = getTool('search_elements');
    if (!tool || tool.kind !== 'read') throw new Error('search_elements is not a read tool');
    return tool.read(args, { project: project() }) as {
      results: { elementId: string; styles: { id: string }[]; knobs: { name: string }[] }[];
      total: number;
      returned: number;
    };
  }

  it('returns one row per shape, its styles and knobs, best first', () => {
    const found = search({ query: 'star', kind: 'shape' });
    expect(found.results[0]).toMatchObject({
      elementId: 'star-5',
      frame: 'box',
      labelled: false,
      license: 'first-party',
    });
    expect(found.results[0]!.styles.map((style) => style.id)).toEqual([
      'star-5/white',
      'star-5/outline',
      'star-5/translucent',
    ]);
    expect(found.results[0]!.knobs.map((knob) => knob.name)).toEqual(['points', 'innerRadius']);
    expect(new Set(found.results.map((row) => row.elementId)).size).toBe(found.results.length);
    expect(found.returned).toBeLessThanOrEqual(12);
  });

  it('reaches the icons, keeps to a category, and says how many there are', () => {
    const heart = search({ query: 'heart', kind: 'shape', category: 'icons', limit: 3 });
    expect(heart.results.map((row) => row.elementId)).toEqual([
      'icon/heart',
      'icon/heart-crack',
      'icon/heart-handshake',
    ]);
    expect(heart.total).toBeGreaterThan(3);
    const badges = search({ query: '', kind: 'shape', category: 'numbers' });
    expect(badges.results.every((row) => row.elementId.startsWith('numbered-'))).toBe(true);
    expect(search({ query: 'zzzz', kind: 'shape' }).total).toBe(0);
  });

  it('is disclosed with the elements domain', () => {
    expect(getTool('search_elements')?.mutates).toBe(false);
  });
});

describe('search_elements for stickers, and add_sticker', () => {
  async function search(args: Record<string, unknown>) {
    const tool = getTool('search_elements');
    if (!tool || tool.kind !== 'read') throw new Error('search_elements is not a read tool');
    return (await tool.read(args, { project: project() })) as {
      results: { elementId: string; kind: string; glyph?: string }[];
      total: number;
    };
  }

  it('finds a sticker by word or by its emoji, and leads with stickers when no kind is given', async () => {
    const byWord = await search({ query: 'fire', kind: 'sticker' });
    expect(byWord.results[0]).toMatchObject({ elementId: 'fire', kind: 'sticker', glyph: '🔥' });
    expect((await search({ query: '🔥', kind: 'sticker' })).results[0]?.elementId).toBe('fire');
    const both = await search({ query: 'heart' });
    expect(both.results[0]?.kind).toBe('sticker');
    expect(both.results.some((row) => row.kind === 'shape')).toBe(true);
    const hearts = await search({ query: '', kind: 'sticker', collection: 'hearts', limit: 3 });
    expect(hearts.results.map((row) => row.elementId)).toEqual([
      'red_heart',
      'orange_heart',
      'yellow_heart',
    ]);
  });

  it('reaches the whole library only where the host ships it (EL6b)', async () => {
    const tool = getTool('search_elements');
    if (!tool || tool.kind !== 'read') throw new Error('search_elements is not a read tool');
    const find = async (packagedStickers: boolean) =>
      (await tool.read(
        { query: 'dragon', kind: 'sticker' },
        { project: project(), ...(packagedStickers ? { packagedStickers } : {}) },
      )) as { results: { elementId: string }[] };
    // A dragon is not in the curated set: only a desktop with the packaged set offers it.
    expect((await find(false)).results.map((row) => row.elementId)).not.toContain('dragon');
    expect((await find(true)).results.map((row) => row.elementId)).toContain('dragon');
  });

  it('offers only shapes, and says why, where the host cannot place a sticker', async () => {
    // The MCP server has no way to copy a sticker into the project, so a sticker row there
    // is an id no call can use (plan/elements 07 §7).
    const tool = getTool('search_elements');
    if (!tool || tool.kind !== 'read') throw new Error('search_elements is not a read tool');
    const find = async (args: Record<string, unknown>) =>
      (await tool.read(args, { project: project(), placesStickers: false })) as {
        results: { kind: string }[];
        returned: number;
        note?: string;
      };
    const both = await find({ query: 'heart' });
    expect(both.results.length).toBeGreaterThan(0);
    expect(both.results.every((row) => row.kind === 'shape')).toBe(true);
    expect(both.note).toMatch(/desktop app/u);
    const stickers = await find({ query: 'fire', kind: 'sticker' });
    expect(stickers.returned).toBe(0);
    expect(stickers.note).toMatch(/add_shape/u);
    // The note is the same sentence every time, so the loop guards read it as one refusal.
    expect(both.note).toBe(stickers.note);
    expect(stickers.note).not.toMatch(/\d/u);
  });

  it('keeps a shape-only search free of the sticker catalogue', () => {
    const tool = getTool('search_elements');
    if (!tool || tool.kind !== 'read') throw new Error('search_elements is not a read tool');
    const value = tool.read({ query: 'star', kind: 'shape' }, { project: project() });
    expect(value).not.toBeInstanceOf(Promise);
  });

  it('takes a catalogue id, never a path, and is a host tool the MCP server does not offer', () => {
    const tool = getTool('add_sticker')!;
    expect(tool).toMatchObject({ kind: 'analysis', hostUiOnly: true, mutates: false });
    expect(() => tool.parse({ elementId: 'fire', start: 1 })).not.toThrow();
    expect(() => tool.parse({ elementId: '../fire', start: 1 })).toThrow();
    expect(() => tool.parse({ elementId: 'fire', start: 1, sizePercent: 500 })).toThrow();
  });
});

describe('a sticker already in the bin, through add_clip and move_clip', () => {
  const sticker = {
    id: 'element_fluent3d_fire',
    path: 'media/p/elements/fluent3d/fire.webp',
    kind: 'image',
    media: { width: 318, height: 318 },
    source: {
      provider: 'fluent-emoji',
      remoteId: 'fire',
      license: 'mit',
      attributionRequired: false,
      fetchedAt: '2026-09-26T00:00:00.000Z',
    },
  };
  const withSticker = (): Project => {
    const base = project();
    return { ...base, assets: [...base.assets, sticker] } as Project;
  };

  it('places it as a sticker on a graphics lane even when a picture lane is named', () => {
    const ops = run(
      'add_clip',
      { trackId: 'video_1', assetId: sticker.id, start: 1, end: 3 },
      withSticker(),
    );
    const clip = ops.find((op) => op.type === 'add_clip') as { trackId: string };
    expect(clip.trackId).not.toBe('video_1');
    expect(ops.map((op) => op.type)).toContain('add_keyframes');
    expect(ops.map((op) => op.type)).not.toContain('set_clip_crop');
  });

  it('moves it to a graphics lane rather than taking it for a cutaway', () => {
    const placed = apply(
      withSticker(),
      run('add_clip', { trackId: 'o1', assetId: sticker.id, start: 1, end: 3 }, withSticker()),
    );
    const clipId = placed.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.assetId === sticker.id)!.id;
    const ops = run('move_clip', { clipId, toTrackId: 'video_1', toStart: 5 }, placed);
    const move = ops.find((op) => op.type === 'move_clip') as { toTrackId: string };
    expect(move.toTrackId).toBe('o1');
  });
});

describe('a shape box stays inside the frame (#150)', () => {
  const vertical = (): Project => ({ ...project(), resolution: { width: 1080, height: 1920 } });
  const clipIdOf = (on: Project): string =>
    on.timeline.tracks.flatMap((track) => track.clips).find((c) => c.assetId === '__shape__')!.id;

  it('moves a box placed partly off the frame just far enough in, by the frame plan', () => {
    const on = apply(
      vertical(),
      run(
        'add_shape',
        {
          shape: 'rounded-rect/highlight',
          start: 0,
          end: 2,
          box: { x: 97, y: 2, width: 20, height: 10 },
        },
        vertical(),
      ),
    );
    // It is moved no further than the frame: its drawing now touches the right and top edges.
    const rect = elementRectAt(on, clipIdOf(on), 1)!;
    const px = (share: number, frame: number) => share * frame;
    expect(px(rect.x + rect.width, 1080)).toBeLessThanOrEqual(1080 + 1e-6);
    expect(px(rect.x + rect.width, 1080)).toBeGreaterThan(1080 - 2);
    expect(px(rect.y, 1920)).toBeGreaterThanOrEqual(-1e-6);
    expect(px(rect.y, 1920)).toBeLessThan(2);
    expect(rect.x).toBeGreaterThan(0);
    const params = shapeParamsOf(on)!;
    expect(params.width).toBe(20);
    expect(params.height).toBe(10);
  });

  it('leaves a box already in frame, an axis the box is bigger than, and a line, as asked', () => {
    const tall = { width: 1080, height: 1920 };
    const box = {
      ...presetShapeParams('rounded-rect/highlight')!,
      x: 72,
      y: 22,
      width: 7,
      height: 7,
    };
    expect(shapeBoxInFrame(box, tall)).toEqual(box);
    // A frame wider than the picture keeps its centre on that axis; the other is still held.
    const wide = shapeBoxInFrame(
      { ...box, x: 40, y: 99, width: 200, height: 20 },
      { width: 1920, height: 1080 },
    );
    expect(wide.x).toBe(40);
    expect(wide.y).toBeLessThan(90);
    // An arrow's ends are its target and where it comes from: never moved.
    const arrow = { ...presetShapeParams('line-arrow/red')!, x1: -20, y1: 50, x2: 30, y2: 50 };
    expect(shapeBoxInFrame(arrow, tall)).toEqual(arrow);
  });

  it('keeps a box moved by set_shape_style in frame too', () => {
    const on = apply(
      vertical(),
      run('add_shape', { shape: 'rounded-rect/highlight', start: 0, end: 2 }, vertical()),
    );
    const ops = run(
      'set_shape_style',
      { clipId: clipIdOf(on), box: { x: 1, y: 99, width: 10, height: 10 } },
      on,
    );
    const moved = apply(on, ops);
    const rect = elementRectAt(moved, clipIdOf(moved), 1)!;
    expect(rect.x).toBeGreaterThanOrEqual(-1e-6);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-6);
    expect(shapeParamsOf(moved)).toMatchObject({ width: 10, height: 10 });
  });
});

describe('set_shape_style', () => {
  const withShape = (): Project =>
    apply(
      project(),
      run('add_shape', { shape: 'rounded-rect/highlight', start: 0, end: 3 }, project()),
    );
  const shapeId = (on: Project): string =>
    on.timeline.tracks.flatMap((track) => track.clips).find((c) => c.assetId === '__shape__')!.id;

  it('changes only what it is given, as one set_effect_params', () => {
    const on = withShape();
    const ops = run(
      'set_shape_style',
      { clipId: shapeId(on), stroke: '#0a84ff', strokeWidth: 2 },
      on,
    );
    expect(ops).toEqual([
      {
        type: 'set_effect_params',
        clipId: shapeId(on),
        effectId: `${shapeId(on)}__shape`,
        params: { stroke: '#0a84ff', strokeWidth: 2 },
      },
    ]);
    expect(shapeParamsOf(apply(on, ops))).toMatchObject({ stroke: '#0a84ff', x: 50 });
  });

  it('refuses a clip that is not a shape, and a change that leaves nothing drawn', () => {
    const on = withShape();
    expect(() => run('set_shape_style', { clipId: 'nope', stroke: 'red' }, on)).toThrow(
      /is not a shape/,
    );
    expect(() => run('set_shape_style', { clipId: shapeId(on), stroke: 'none' }, on)).toThrow(
      'A shape needs a fill or a stroke — with both off it draws nothing.',
    );
    expect(() => run('set_shape_style', { clipId: shapeId(on) }, on)).toThrow(/Nothing to change/);
  });
});

describe('set_element_animation (EL7)', () => {
  const withShape = (): Project =>
    apply(project(), run('add_shape', { shape: 'line-arrow/red', start: 0, end: 3 }, project()));
  const shape = (on: Project) =>
    on.timeline.tracks.flatMap((track) => track.clips).find((c) => c.assetId === '__shape__')!;

  it('pops a shape in and pulses it, as one reversible edit', () => {
    const on = withShape();
    const ops = run(
      'set_element_animation',
      { clipId: shape(on).id, in: { kind: 'pop', seconds: 0.4 }, loop: { preset: 'pulse' } },
      on,
    );
    const after = apply(on, ops);
    const clip = shape(after);
    expect(clip.effects.find((e) => e.type === 'transition')?.params).toEqual({
      kind: 'zoom-out',
      durationSeconds: 0.4,
    });
    expect(clip.keyframes.some((k) => k.id.startsWith('loop__pulse__'))).toBe(true);
    // Nothing else on the timeline changed.
    expect(after.timeline.tracks.find((t) => t.id === 'video_1')).toEqual(
      on.timeline.tracks.find((t) => t.id === 'video_1'),
    );
  });

  it('removes an end or a loop with null, and refuses in the builder’s words', () => {
    const on = withShape();
    const animated = apply(
      on,
      run('set_element_animation', { clipId: shape(on).id, out: { kind: 'fade' } }, on),
    );
    const ops = run('set_element_animation', { clipId: shape(on).id, out: null }, animated);
    expect(shape(apply(animated, ops)).effects.some((e) => e.type === 'transition_out')).toBe(
      false,
    );
    expect(() => run('set_element_animation', { clipId: shape(on).id }, on)).toThrow(
      /Nothing to change/,
    );
    expect(() =>
      run('set_element_animation', { clipId: 'nope', in: { kind: 'fade' } }, on),
    ).toThrow(/graphics layer/);
    expect(() =>
      run('set_element_animation', { clipId: shape(on).id, in: { kind: 'teleport' } }, on),
    ).toThrow();
  });
});

describe('set_element_animation on a clip too short for its loop (#150)', () => {
  const shortShape = (): Project =>
    apply(
      project(),
      run('add_shape', { shape: 'rounded-rect/highlight', start: 40.2, end: 40.5 }, project()),
    );
  const clipId = (on: Project): string =>
    on.timeline.tracks.flatMap((track) => track.clips).find((c) => c.assetId === '__shape__')!.id;

  it('refuses with the loops and periods that fit, and the period it names then plans', () => {
    const on = shortShape();
    let refusal: unknown;
    try {
      run(
        'set_element_animation',
        { clipId: clipId(on), loop: { preset: 'float', period: 3 } },
        on,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ToolRefusalError);
    const detail = (refusal as Error).message;
    expect(detail).toContain('This clip is 0.3 s long');
    expect(detail).toContain('needs at least 0.75 s to move');
    expect(detail).toContain('A float fits here at a period of 1.2 s or less');
    expect(detail).toContain('spin (any period)');
    expect(detail).toContain('In and Out take up to 0.15 s each here');
    // No other loop was substituted: the named one, at the named period, is what lands.
    const ops = run(
      'set_element_animation',
      { clipId: clipId(on), loop: { preset: 'float', period: 1.2 } },
      on,
    );
    const looped = on.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId(on))!;
    expect(looped).toBeDefined();
    const keys = ops.flatMap((op) => (op.type === 'add_keyframes' ? op.keyframes : []));
    expect(keys.every((k) => k.id.startsWith('loop__float__1200__'))).toBe(true);
  });

  it('spins a shape shorter than one turn — the wall runs 7–9 hit', () => {
    const on = shortShape();
    const ops = run(
      'set_element_animation',
      {
        clipId: clipId(on),
        in: { kind: 'pop' },
        loop: { preset: 'spin', period: 2.4, amount: 20 },
      },
      on,
    );
    expect(ops.some((op) => op.type === 'add_keyframes')).toBe(true);
    expect(ops.some((op) => op.type === 'add_layer_transition')).toBe(true);
  });
});

describe('shapeColour', () => {
  it('reads the colours models write', () => {
    expect(shapeColour('#fff')).toBe('#ffffff');
    expect(shapeColour('Yellow')).toBe('#FFD400');
    expect(shapeColour('#ff3b3080')).toBe('#ff3b3080');
    expect(shapeColour('none')).toBeNull();
    expect(shapeColour('rgb(1,2,3)')).toBeUndefined();
  });
});

// Run 17 (AL43): three add_shape calls were rejected because the picker put each shape on the
// captions lane `CAP`, ending exactly where `text__CAP_17500` starts. That title carries an
// entrance (a layer transition that names no clip), and an entrance on a clip that now starts on
// a cut must name the clip before it — so the placement broke its neighbour.
describe('add_shape keeps its neighbours valid (AL43, run 17)', () => {
  const plain = (id: string, trackId: string, start: number, end: number, assetId = '__text__') => ({
    id,
    assetId,
    trackId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  });
  /** `text__CAP_17500` as run 17 left it: a zoom-out In and a fade Out, naming no clip. */
  const enteringTitle = {
    ...plain('text__CAP_17500', 'CAP', 17.5, 19.8),
    effects: [
      {
        id: 'text__CAP_17500__transition',
        type: 'transition',
        params: { kind: 'zoom-out', durationSeconds: 0.26666666666666666 },
        keyframes: [],
      },
      {
        id: 'text__CAP_17500__transition_out',
        type: 'transition_out',
        params: { kind: 'fade', durationSeconds: 0.26666666666666666, alignment: 'end' },
        keyframes: [],
      },
    ],
  };
  const cap = {
    id: 'CAP',
    type: 'overlay' as const,
    clips: [
      plain('text__CAP_6633', 'CAP', 6.633333333333334, 8),
      plain('text__CAP_8000', 'CAP', 8, 9.9),
      plain('shape__CAP_15100', 'CAP', 15.1, 15.6, '__shape__'),
      enteringTitle,
    ],
  };
  const txt = {
    id: 'TXT',
    type: 'overlay' as const,
    clips: [plain('text__TXT_9920', 'TXT', 9.933333333333334, 11.8)],
  };
  const video = { id: 'video_1', type: 'video' as const, clips: [] };
  const turn34 = (): Project => makeProject({ timeline: { tracks: [cap, txt, video] } } as never);
  const turn35 = (): Project =>
    makeProject({
      timeline: {
        tracks: [
          {
            id: 'STK',
            type: 'overlay',
            clips: [plain('shape__STK_15600', 'STK', 15.6, 17.5, '__shape__')],
          },
          cap,
          txt,
          video,
        ],
      },
    } as never);

  const landed = (on: Project, ops: AnyOperation[]) => {
    const edit = assembleEdit(on, ops, 'shape', 'agent');
    const shape = ops.find((op) => op.type === 'add_shape') as { trackId: string };
    return { valid: edit.validation.valid, issues: edit.validation.issues, trackId: shape.trackId };
  };

  it.each([
    ['the red arrow', { shape: 'line-arrow/red', start: 15.6, end: 17.5 }],
    ['the yellow pin', { shape: 'location-pin/yellow', start: 16.3, end: 17.5 }],
  ])('places %s off the lane whose next title enters on its own', (_, args) => {
    const on = turn34();
    const result = landed(on, run('add_shape', args, on));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.trackId).not.toBe('CAP');
  });

  it('a named lane with no room is never swapped for a lane the shape would break', () => {
    const on = turn35();
    const result = landed(
      on,
      run('add_shape', { shape: 'location-pin/yellow', trackId: 'STK', start: 16.1, end: 17.5 }, on),
    );
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(['STK', 'CAP']).not.toContain(result.trackId);
  });

  it('honours a named lane where the shape fits', () => {
    const on = turn35();
    const result = landed(
      on,
      run('add_shape', { shape: 'location-pin/yellow', trackId: 'STK', start: 20, end: 22 }, on),
    );
    expect(result.trackId).toBe('STK');
    expect(result.valid).toBe(true);
  });

  it('refuses a trackId that names no lane, rather than placing it somewhere else', () => {
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', trackId: 'STK', start: 1, end: 2 }, turn34()),
    ).toThrow(
      'trackId names no track on the timeline. Leave trackId out and the shape lands on a ' +
        'graphics lane with room (a new one if needed), or name a graphics lane from get_timeline.',
    );
  });

  it('refuses a trackId that names a picture or locked lane', () => {
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', trackId: 'video_1', start: 1, end: 2 }, turn34()),
    ).toThrow(
      'Shapes go on a graphics lane, and trackId names a picture or audio lane. Leave trackId ' +
        'out, or name a graphics lane from get_timeline.',
    );
    const locked = makeProject({
      timeline: { tracks: [{ ...txt, locked: true }, video] },
    } as never);
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', trackId: 'TXT', start: 1, end: 2 }, locked),
    ).toThrow('trackId names a locked lane. Leave trackId out, or name an unlocked graphics lane.');
  });
});
