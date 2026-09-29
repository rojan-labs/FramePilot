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
import { TEXT_OVERLAY_STYLE_CATALOG } from '@framepilot/timeline-schema/text-overlay-styles';
import { bundledFontFamily } from './tool-args.js';
import { typedTitleDrawnWidthPx, typedTitleFont, typedTitleOf } from '../overlay-fit.js';

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
      expect(bundledFontFamily.options).toContain(family);
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

describe('a text overlay box stays inside the frame', () => {
  it("moves a style's wide box back into frame instead of letting its words start off it", () => {
    // Harness run 6: the accent-bar style's 76% box centred at x 30 spanned -8%…68%, so its
    // left-aligned "THE ROAD" began off the frame.
    const after = run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'THE ROAD',
      start: 0,
      end: 3,
      style: 'accent-bar',
      xPercent: 30,
    });
    const params = textParams(after);
    const half = (params['boxWidthPercent'] as number) / 2;
    expect(params['xPercent'] as number).toBeGreaterThanOrEqual(half);
    expect((params['xPercent'] as number) + half).toBeLessThanOrEqual(100);
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

  it('applies a designed style the way the Text panel does, keeping where the overlay sits', () => {
    const start = placed();
    const before = run('set_text_style', start, {
      clipId: titleClipId(start),
      xPercent: 45,
      yPercent: 70,
    });
    const style = TEXT_OVERLAY_STYLE_CATALOG[0]!;
    const after = run('set_text_style', before, { clipId: titleClipId(before), style: style.id });
    const params = textParams(after);
    expect(params).toMatchObject({
      text: 'road',
      templateId: style.id,
      fontFamily: style.look.fontFamily,
      color: style.look.color,
      xPercent: 45,
      yPercent: 70,
    });
  });

  it('refuses a restyle that changes nothing', () => {
    const before = placed();
    const tool = getTool('set_text_style')!;
    expect(
      () =>
        tool.kind === 'mutate' &&
        tool.buildOps({ clipId: titleClipId(before), sizePercent: 6 }, { project: before }),
    ).toThrow(/Nothing to change/);
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

describe('set_text_style re-fits into a tracked style (#135)', () => {
  it('shrinks a title whose new tracking would run it out of its box', () => {
    const placed = run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'WEEKEND TRIP',
      start: 0,
      end: 3,
      sizePercent: 7.5,
      boxWidthPercent: 92,
      fontFamily: 'Montserrat',
      fontWeight: 600,
    });
    expect(textParams(placed).fontSizePercent).toBe(7.5);
    const after = run('set_text_style', placed, {
      clipId: titleClipId(placed),
      style: 'tracked-caps',
      fontFamily: 'Montserrat',
      fontWeight: 600,
    });
    const params = textParams(after);
    const typed = typedTitleOf(params.typography, params.background)!;
    expect(typed.letterSpacing).toBe(0.24);
    expect(params.fontSizePercent).toBeLessThan(7.5);
    const font = typedTitleFont({ fontFamily: 'Montserrat', fontWeight: 600 }, typed);
    const fontPx = Math.floor((1920 * (params.fontSizePercent as number)) / 100);
    const boxPx = Math.floor((1080 * (params.boxWidthPercent as number)) / 100);
    expect(typedTitleDrawnWidthPx('WEEKEND', fontPx, font, typed)).toBeLessThanOrEqual(boxPx);
  });
});
