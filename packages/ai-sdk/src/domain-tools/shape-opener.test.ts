/**
 * The shape-mask opener, built from the tools the masking skill names: a filled rounded
 * rectangle from add_shape, keyframed to grow, used as the clip's alpha matte.
 *
 * Harness run 14 left the brief's "open the hook through an expanding rounded rectangle"
 * undone and told the editor "no tool here animates a mask wipe". The route exists — the
 * matte is its source as drawn at each instant (AL31), and a shape on an overlay lane is a
 * valid source (AL31a) — so the skill spells it out, and this pins that the chain is legal.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, type AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';

function run(name: string, project: Project, args: Record<string, unknown>): Project {
  const tool = getTool(name);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${name} is not a mutate tool`);
  const ops = tool.buildOps!(args, { project }) as AnyOperation[];
  const edit = assembleEdit(project, ops, name, 'agent');
  expect(edit.validation.issues ?? []).toEqual([]);
  expect(edit.validation.valid).toBe(true);
  return applyProjectPatch(project, edit.patch);
}

const clipsOf = (project: Project) => project.timeline.tracks.flatMap((track) => track.clips);

describe('the shape-mask opener', () => {
  it('grows a rounded rectangle and uses it as the hook clip’s alpha matte', () => {
    let project = makeProject({
      assets: [
        {
          id: 'asset_1',
          path: 'media/a.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1920, height: 1080 },
        },
      ],
    } as never);
    project = run('add_shape', project, {
      shape: 'rounded-rect/filled',
      start: 0,
      end: 2,
      box: { x: 0, y: 0, width: 100, height: 100 },
    });
    const shape = clipsOf(project).find((clip) => clip.id.startsWith('shape__'))!;
    project = run('add_keyframes', project, {
      clipId: shape.id,
      keyframes: [
        { time: 0, property: 'scale', value: 0.4, easing: 'ease-in-out' },
        { time: 0.47, property: 'scale', value: 1 },
      ],
    });
    project = run('mask_with_layer', project, {
      clipId: 'clip_a',
      sourceClipId: shape.id,
      channel: 'alpha',
    });
    const hook = clipsOf(project).find((clip) => clip.id === 'clip_a')!;
    expect(hook.masks).toEqual([
      expect.objectContaining({
        kind: 'layer',
        source: { kind: 'clip', clipId: shape.id },
        channel: 'alpha',
      }),
    ]);
    const grown = clipsOf(project).find((clip) => clip.id === shape.id)!;
    expect(grown.keyframes?.filter((k) => k.property === 'scale').map((k) => k.value)).toEqual([
      0.4, 1,
    ]);
  });
});
