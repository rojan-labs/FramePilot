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
import {
  applyPatch,
  applyProjectPatch,
  invertPatch,
  type AnyOperation,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';
import {
  DEFAULT_TEXT_BOX_WIDTH_PERCENT,
  PLAIN_TEXT_OVERLAY_TYPOGRAPHY,
  TEXT_OVERLAY_STYLE_CATALOG,
  getTextOverlayStyle,
  parseTextOverlayTypography,
} from '@framepilot/timeline-schema/text-overlay-styles';
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

  it('keeps the default box in frame when no box width was given', () => {
    // Harness run 13: a left-aligned stamp at x 30 with no box width drew in the renderers'
    // default 80% box, -10%…70%, and "CAMP · 7:40 A.M." lost its first letter off the frame.
    const after = run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'CAMP · 7:40 A.M.',
      start: 0,
      end: 3,
      sizePercent: 1.8,
      align: 'left',
      xPercent: 30,
    });
    const params = textParams(after);
    expect(params['boxWidthPercent']).toBeUndefined();
    expect(params['xPercent']).toBe(DEFAULT_TEXT_BOX_WIDTH_PERCENT / 2);
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
    ).toThrow(/already has the sizePercent you gave, so nothing changed/);
  });

  it('says a call that names nothing to name something', () => {
    // Harness run 14 heard "name at least one of … color, background" for a call that named
    // both (at the values the clip already had). That sentence is for a call naming nothing.
    const before = placed();
    const tool = getTool('set_text_style')!;
    expect(
      () =>
        tool.kind === 'mutate' &&
        tool.buildOps({ clipId: titleClipId(before) }, { project: before }),
    ).toThrow(/Nothing to change on .*: name at least one of/);
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

describe('typography args override one field of the typography (#135)', () => {
  const add = (args: Record<string, unknown>): Project =>
    run('add_text_layer', vertical(), {
      trackId: 'titles',
      text: 'Weekend',
      start: 0,
      end: 3,
      ...args,
    });

  it("writes a brief's tracking over a style and keeps the rest of the style's typography", () => {
    const style = getTextOverlayStyle('tracked-caps')!;
    const params = textParams(add({ style: 'tracked-caps', letterSpacing: 0.1, lineHeight: 0.9 }));
    expect(params.typography).toEqual({
      ...style.look.typography,
      letterSpacing: 0.1,
      lineHeight: 0.9,
    });
    // What was written is a typography both renderers draw, not one they fall back from.
    expect(parseTextOverlayTypography(params.typography)).toEqual(params.typography);
  });

  it('starts a plain overlay from its own look, so one field does not drop its stroke', () => {
    const params = textParams(add({ fontFamily: 'Inter', letterSpacing: 0.2 }));
    expect(params.typography).toEqual({ ...PLAIN_TEXT_OVERLAY_TYPOGRAPHY, letterSpacing: 0.2 });
  });

  it('sets or removes the shadow, and sets outline, case and letter opacity', () => {
    const shadow = { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 };
    const set = textParams(
      add({
        style: 'heading',
        shadow,
        outlineWidth: 0,
        textTransform: 'uppercase',
        textOpacity: 0.8,
      }),
    );
    expect(set.typography).toMatchObject({
      shadow,
      outlineWidth: 0,
      textTransform: 'uppercase',
      textOpacity: 0.8,
    });
    const removed = textParams(add({ style: 'tracked-caps', shadow: 'none' }));
    expect(removed.typography).not.toHaveProperty('shadow');
    expect(removed.typography).toMatchObject({ letterSpacing: 0.24 });
  });

  it('draws italic from a family that ships one, and refuses it where none does', () => {
    const params = textParams(add({ fontFamily: 'Playfair Display', fontStyle: 'italic' }));
    expect(params.typography).toMatchObject({ fontStyle: 'italic' });
    expect(() => add({ fontFamily: 'Montserrat', fontStyle: 'italic' })).toThrow(
      /Montserrat ships no italic.*Playfair Display/,
    );
    // No family named: a typed overlay is drawn in Inter, which has no italic either.
    expect(() => add({ fontStyle: 'italic' })).toThrow(/Inter ships no italic/);
  });

  it('refuses values outside the bounds the renderers draw', () => {
    const tool = getTool('add_text_layer')!;
    const base = { trackId: 'titles', text: 'Weekend', start: 0, end: 3 };
    for (const bad of [
      { letterSpacing: -0.3 }, // below the -0.2 em both renderers clamp to
      { letterSpacing: 0.7 },
      { lineHeight: 0.5 },
      { lineHeight: 3.5 },
      { textOpacity: 1.2 },
      { outlineWidth: 9 },
      { fontStyle: 'oblique' },
      { textTransform: 'capitalize' },
      { shadow: { color: '#000', blur: 0.2, offsetX: 0, offsetY: 2 } },
      { shadow: 'soft' },
    ]) {
      expect(() => tool.parse!({ ...base, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('fits the words with the tracking that was asked for', () => {
    // 0.6 em between the letters of "WEEKEND" at 7.5 % cannot fit 92 % of a 1080-wide frame.
    const params = textParams(
      add({
        text: 'WEEKEND',
        fontFamily: 'Montserrat',
        fontWeight: 600,
        sizePercent: 7.5,
        boxWidthPercent: 92,
        letterSpacing: 0.6,
      }),
    );
    expect(params.fontSizePercent).toBeLessThan(7.5);
    const typed = typedTitleOf(params.typography, params.background)!;
    const fontPx = Math.floor((1920 * (params.fontSizePercent as number)) / 100);
    const font = typedTitleFont({ fontFamily: 'Montserrat', fontWeight: 600 }, typed);
    expect(typedTitleDrawnWidthPx('WEEKEND', fontPx, font, typed)).toBeLessThanOrEqual(
      Math.floor(1080 * 0.92),
    );
  });

  it('restyles one typography field of a placed overlay, reversibly', () => {
    const placed = add({ style: 'tracked-caps' });
    const before = textParams(placed);
    const tool = getTool('set_text_style')!;
    const ops = tool.buildOps!(
      { clipId: titleClipId(placed), letterSpacing: 0.12 },
      {
        project: placed,
      },
    ) as AnyOperation[];
    const after = run('set_text_style', placed, {
      clipId: titleClipId(placed),
      letterSpacing: 0.12,
    });
    expect(textParams(after).typography).toEqual({
      ...(before.typography as object),
      letterSpacing: 0.12,
    });
    // Undo restores the style's own tracking.
    const patch = { patchId: 'p', createdBy: 'agent' as const, reason: 'r', operations: ops };
    const back = applyPatch(
      applyPatch(placed.timeline, patch as never),
      invertPatch(placed.timeline, patch as never),
    );
    expect(back).toEqual(placed.timeline);
  });

  it('says so when the typography asked for is already what the overlay has', () => {
    const placed = add({ style: 'tracked-caps' });
    expect(() =>
      run('set_text_style', placed, { clipId: titleClipId(placed), letterSpacing: 0.24 }),
    ).toThrow(/already has the letterSpacing you gave, so nothing changed/);
  });
});
