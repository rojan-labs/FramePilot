/**
 * The agent's shape tools (plan/elements EL4a, EL5): `search_elements` finds shapes and icons with
 * the Shapes tab's ranking; `add_shape` places any of them as the tab would, with the model's box,
 * ends, colours, label and knobs; `set_shape_style` restyles one; both refuse a shape that would
 * draw nothing, with the validator's sentence. And a request that names shapes is routed to the
 * `elements` domain.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, buildAddShapeOps, type AnyOperation } from '@framepilot/editor-core';
import { presetShapeParams, type Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { requestedDomainsNeverLoaded } from '../tool-domains.js';
import { shapeColour } from './elements.js';

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

describe('shapeColour', () => {
  it('reads the colours models write', () => {
    expect(shapeColour('#fff')).toBe('#ffffff');
    expect(shapeColour('Yellow')).toBe('#FFD400');
    expect(shapeColour('#ff3b3080')).toBe('#ff3b3080');
    expect(shapeColour('none')).toBeNull();
    expect(shapeColour('rgb(1,2,3)')).toBeUndefined();
  });
});

describe('the elements domain is what a callout request names', () => {
  it.each([
    'circle the export button when I mention it',
    'put an arrow pointing at the price',
    'draw a highlight box around the settings menu',
    'underline the headline',
    'add a callout on the pricing page',
    'number each step with a badge',
    'add a speech bubble over the host',
  ])('%s', (request) => {
    const named = requestedDomainsNeverLoaded(request, new Set()).map((entry) => entry.domain);
    expect(named).toContain('elements');
  });

  it('does not claim colour-grade highlights or a highlight reel', () => {
    for (const request of ['pull down the highlights', 'make a highlight reel']) {
      const named = requestedDomainsNeverLoaded(request, new Set()).map((entry) => entry.domain);
      expect(named).not.toContain('elements');
    }
  });
});
