/**
 * Titles can be set in any bundled face, and restyled after they are placed.
 *
 * Run `6cb12e30` was briefed for Playfair Display, Inter and Caveat — all three in the
 * catalogue the export and the desktop preview draw a title's `fontFamily` from — and set
 * every title in the default face, because `add_text_layer` had no font argument. It faked
 * tracking with spaces, told the editor the default face was the only one, and later called
 * `adjust_effect` on a title's own effect id to enlarge it: "Effect layer not found".
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, type AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';
import { TITLE_FONT_FAMILIES } from './title-fonts.js';

function run(name: string, project: Project, args: Record<string, unknown>): Project {
  const tool = getTool(name);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${name} is not a mutate tool`);
  const ops = tool.buildOps!(args, { project }) as AnyOperation[];
  const edit = assembleEdit(project, ops, name, 'agent');
  expect(edit.validation.valid).toBe(true);
  return applyProjectPatch(project, edit.patch);
}

const vertical = (): Project =>
  makeProject({
    resolution: { width: 1080, height: 1920 },
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips: [] },
        { id: 'titles', type: 'overlay', clips: [] },
      ],
    },
  } as never);

const textParams = (project: Project): Record<string, unknown> => {
  const clip = project.timeline.tracks.flatMap((track) => track.clips)[0]!;
  return clip.effects.find((effect) => effect.type === 'text')!.params;
};

const titleClipId = (project: Project): string =>
  project.timeline.tracks.flatMap((track) => track.clips)[0]!.id;

describe('add_text_layer sets the face', () => {
  it('offers the three families the brief named', () => {
    for (const family of ['Playfair Display', 'Inter', 'Caveat']) {
      expect(TITLE_FONT_FAMILIES).toContain(family);
    }
  });

  it('writes fontFamily and fontWeight into the title the renderer reads', () => {
    const after = run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'Weekend',
      start: 0,
      end: 3,
      sizePercent: 8,
      fontFamily: 'Playfair Display',
      fontWeight: 700,
    });
    expect(textParams(after)).toMatchObject({
      text: 'Weekend',
      fontFamily: 'Playfair Display',
      fontWeight: 700,
      fontSizePercent: 8,
    });
  });

  it('refuses a family the catalogue does not bundle, rather than rendering a fallback', () => {
    const tool = getTool('add_text_layer')!;
    expect(() =>
      tool.parse!({
        trackId: 'titles',
        text: 'Weekend',
        start: 0,
        end: 3,
        fontFamily: 'Comic Sans MS',
      }),
    ).toThrow();
  });
});

describe('set_text_style restyles a placed title', () => {
  const placed = (): Project =>
    run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'road',
      start: 0,
      end: 3,
      sizePercent: 6,
      boxWidthPercent: 80,
    });

  it('changes only what it is given, on the same clip', () => {
    const before = placed();
    const after = run('set_text_style', before, {
      clipId: titleClipId(before),
      sizePercent: 9,
      fontFamily: 'Inter',
      fontWeight: 800,
    });
    expect(textParams(after)).toMatchObject({
      text: 'road',
      fontSizePercent: 9,
      fontFamily: 'Inter',
      fontWeight: 800,
      boxWidthPercent: 80,
    });
    expect(after.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(1);
  });

  it('re-fits a restyle the way a fresh title is fitted', () => {
    const before = placed();
    const after = run('set_text_style', before, {
      clipId: titleClipId(before),
      text: 'extraordinarily',
      sizePercent: 30,
    });
    const params = textParams(after);
    // A 30%-of-height word in an 80% box cannot fit a 1080-wide frame at that size.
    const widened = (params['boxWidthPercent'] as number) > 80;
    const shrunk = (params['fontSizePercent'] as number) < 30;
    expect(widened || shrunk).toBe(true);
  });

  it('refuses a clip that is not a title, naming the tool that is', () => {
    const project = makeProject();
    const clipId = project.timeline.tracks.flatMap((track) => track.clips)[0]!.id;
    const tool = getTool('set_text_style')!;
    expect(
      () => tool.kind === 'mutate' && tool.buildOps({ clipId, color: '#fff' }, { project }),
    ).toThrow(/not a text overlay/);
  });
});

describe('adjust_effect on a title', () => {
  it('points at set_text_style instead of "Effect layer not found"', () => {
    const before = run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'trip',
      start: 0,
      end: 3,
    });
    const clipId = titleClipId(before);
    const tool = getTool('adjust_effect')!;
    expect(
      () =>
        tool.kind === 'mutate' &&
        tool.buildOps(
          { layerId: `${clipId}__text`, params: { fontSizePercent: 9 } },
          { project: before },
        ),
    ).toThrow(new RegExp(`set_text_style \\(clipId "${clipId}"\\)`));
  });
});
