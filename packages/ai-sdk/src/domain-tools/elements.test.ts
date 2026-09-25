/**
 * The agent's shape tools (plan/elements EL4a): `add_shape` places a preset as the Shapes tab
 * would, with the model's box, ends and colours; `set_shape_style` restyles one; both refuse a
 * shape that would draw nothing, with the validator's sentence. And a request that names shapes
 * is routed to the `elements` domain.
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
    expect(() =>
      run('add_shape', { shape: 'dodecahedron', start: 0, end: 2 }, project()),
    ).toThrow();
  });

  it('refuses an empty time range with the remedy', () => {
    expect(() =>
      run('add_shape', { shape: 'ellipse/outline', start: 2, end: 2 }, project()),
    ).toThrow('end must be after start. Give the shape a time range.');
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
