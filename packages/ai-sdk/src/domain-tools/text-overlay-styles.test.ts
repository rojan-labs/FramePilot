/**
 * The assistant can use the designed text overlay styles, and find out what they look like.
 *
 * `add_text_layer` used to take a size, a colour and a place, and could not pick a typeface or
 * any of the styles the Text panel offers. `style` now writes a style's whole look — the same
 * params the Text panel writes — with every other styling arg overriding its one field, and
 * `discover_text_overlay_styles` names each style with a line derived from its data.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { CAPTION_FONT_CATALOG } from '@framepilot/timeline-schema/caption-fonts';
import {
  TEXT_OVERLAY_STYLE_CATALOG,
  TEXT_OVERLAY_STYLE_CATEGORIES,
  getTextOverlayStyle,
  textOverlayLookParams,
} from '@framepilot/timeline-schema/text-overlay-styles';
import type { Operation } from '@framepilot/editor-core';
import { getTool } from '../tool-registry.js';
import type { ToolContext } from '../tool-context.js';
import { overflowingWords } from '../overlay-fit.js';
import { summarizeReadResult } from '../orchestrator.js';
import { describeTextOverlayLook } from '../text-overlay-style-facts.js';

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

function project(resolution = LANDSCAPE): Project {
  return parseProject({
    id: 'styles',
    name: 'Text overlay styles',
    version: 1,
    fps: 30,
    resolution,
    assets: [],
    timeline: { tracks: [{ id: 'titles', type: 'overlay', clips: [] }] },
  });
}

function addText(args: Record<string, unknown>, resolution = LANDSCAPE): Operation[] {
  const tool = getTool('add_text_layer');
  if (!tool?.buildOps) throw new Error('add_text_layer is not a mutate tool');
  return tool.buildOps({ trackId: 'titles', text: 'Hi', start: 0, end: 3, ...args }, {
    project: project(resolution),
  } as unknown as ToolContext) as Operation[];
}

function paramsOf(ops: readonly Operation[]): Record<string, unknown> {
  const set = ops.find((op) => op.type === 'set_effect_params');
  if (set?.type !== 'set_effect_params') throw new Error('no set_effect_params op');
  return set.params;
}

function discover(args: Record<string, unknown> = {}): {
  matched: number;
  total: number;
  note?: string;
  styles: { styleId: string; label: string; category: string; look: string }[];
} {
  const tool = getTool('discover_text_overlay_styles');
  if (!tool?.read) throw new Error('discover_text_overlay_styles is not a read tool');
  return tool.read(args, { project: project() } as unknown as ToolContext) as ReturnType<
    typeof discover
  >;
}

describe('add_text_layer style', () => {
  it('writes the whole look of the style, exactly as the Text panel does', () => {
    const style = getTextOverlayStyle('heading')!;
    expect(paramsOf(addText({ style: 'heading' }))).toEqual(
      textOverlayLookParams(style.look, style.id),
    );
  });

  it('lets each explicit arg override just the field it names', () => {
    const style = getTextOverlayStyle('name-tag')!;
    const params = paramsOf(
      addText({ style: 'name-tag', text: 'Jane Doe', color: '#ff2d55', yPercent: 70 }),
    );
    expect(params).toEqual({
      ...textOverlayLookParams(style.look, style.id),
      color: '#ff2d55',
      yPercent: 70,
    });
  });

  it('refuses a style the catalog does not have, before building anything', () => {
    expect(() => addText({ style: 'glitter-bomb' })).toThrow();
    const schema = getTool('add_text_layer')!.parameters.properties.style as { enum: string[] };
    // The model is shown every catalog id, so it has no reason to invent one.
    expect(schema.enum).toEqual(TEXT_OVERLAY_STYLE_CATALOG.map((s) => s.id));
  });

  it('writes no style fields when no style or styling arg is given', () => {
    expect(addText({}).some((op) => op.type === 'set_effect_params')).toBe(false);
  });
});

describe('add_text_layer typeface', () => {
  it('sets any bundled family and weight', () => {
    const params = paramsOf(addText({ fontFamily: 'Playfair Display', fontWeight: 700 }));
    expect(params).toEqual({ fontFamily: 'Playfair Display', fontWeight: 700 });
  });

  it('refuses a family the renderer does not bundle, and a weight past the CSS range', () => {
    expect(() => addText({ fontFamily: 'Comic Sans MS' })).toThrow();
    expect(() => addText({ fontWeight: 950 })).toThrow();
    const schema = getTool('add_text_layer')!.parameters.properties.fontFamily as {
      enum: string[];
    };
    expect(schema.enum).toEqual(CAPTION_FONT_CATALOG.map((font) => font.family));
  });

  it('holds a family named over a style to the weights that family ships', () => {
    // The heading is Inter 800; Bebas Neue has one weight, and neither renderer invents one.
    const bebas = CAPTION_FONT_CATALOG.find((font) => font.family === 'Bebas Neue')!;
    expect(bebas.maxWeight).toBeLessThan(800);
    const params = paramsOf(addText({ style: 'heading', fontFamily: 'Bebas Neue' }));
    expect(params.fontFamily).toBe('Bebas Neue');
    expect(params.fontWeight).toBe(bebas.maxWeight);
  });
});

describe('add_text_layer fits a styled overlay to the frame', () => {
  it('measures the capitals a capitalising style draws, in its own face', () => {
    const style = getTextOverlayStyle('impact-title')!;
    expect(style.look.typography.textTransform).toBe('uppercase');
    const text = 'unbelievable';
    const font = { fontFamily: style.look.fontFamily, fontWeight: style.look.fontWeight };
    const at = (fontSizePercent: number, words: string) =>
      overflowingWords(
        { text: words, fontSizePercent, boxWidthPercent: style.look.boxWidthPercent, ...font },
        PORTRAIT,
      );
    // The premise: what is DRAWN overflows at the style's size.
    expect(at(style.look.fontSizePercent, text.toUpperCase()).length).toBeGreaterThan(0);

    const params = paramsOf(addText({ style: 'impact-title', text }, PORTRAIT));
    expect(
      overflowingWords(
        {
          text: text.toUpperCase(),
          fontSizePercent: params.fontSizePercent,
          boxWidthPercent: params.boxWidthPercent,
          ...font,
        },
        PORTRAIT,
      ),
    ).toEqual([]);
  });

  it('keeps a widened lower third inside the frame', () => {
    const style = getTextOverlayStyle('name-tag')!;
    const word = 'Unterhaltungselektronik';
    // A size at which the name needs a box wider than twice the style's centre — left where
    // it was, the box would start off the left edge — but one the fit can still widen to.
    let size = style.look.fontSizePercent;
    const needs = (s: number) =>
      overflowingWords(
        {
          text: word,
          fontSizePercent: s,
          boxWidthPercent: style.look.boxWidthPercent,
          fontFamily: style.look.fontFamily,
          fontWeight: style.look.fontWeight,
        },
        PORTRAIT,
      )[0]?.requiredBoxWidthPercent ?? 0;
    while (needs(size) <= 2 * style.look.xPercent + 1) size += 0.1;
    expect(needs(size)).toBeLessThanOrEqual(92);

    const params = paramsOf(
      addText({ style: 'name-tag', text: word, sizePercent: size }, PORTRAIT),
    );
    const box = params.boxWidthPercent as number;
    const x = params.xPercent as number;
    expect(box).toBeGreaterThan(style.look.boxWidthPercent);
    expect(x - box / 2).toBeGreaterThanOrEqual(0);
    expect(x + box / 2).toBeLessThanOrEqual(100);
  });
});

describe('discover_text_overlay_styles', () => {
  it('lists every style with a look line derived from its data', () => {
    const result = discover();
    expect(result.matched).toBe(TEXT_OVERLAY_STYLE_CATALOG.length);
    expect(result.styles.map((s) => s.styleId)).toEqual(
      TEXT_OVERLAY_STYLE_CATALOG.map((s) => s.id),
    );
    const heading = result.styles.find((s) => s.styleId === 'heading')!;
    expect(heading.look).toBe(describeTextOverlayLook(getTextOverlayStyle('heading')!.look));
    expect(heading.look).toMatch(/^Inter 800 #ffffff, 8% high, middle, shadow$/);
  });

  it('names the chip, the outline, the glow and the case where a style has them', () => {
    const look = (id: string) => describeTextOverlayLook(getTextOverlayStyle(id)!.look);
    expect(look('hook')).toContain('#ff2e4d chip');
    expect(look('hook')).toContain('caps');
    expect(look('name-tag')).toContain('bottom-left');
    expect(look('frosted')).toContain('frosted-glass chip');
    expect(look('chrome')).toContain('glow');
    expect(look('seventies')).toContain('outline');
  });

  it('filters by category and by search', () => {
    const lowerThirds = discover({ category: 'lower-thirds' });
    expect(lowerThirds.styles.length).toBeGreaterThan(0);
    expect(lowerThirds.styles.every((s) => s.category === 'lower-thirds')).toBe(true);
    const bebas = discover({ query: 'bebas' });
    expect(bebas.styles.map((s) => s.styleId).sort()).toEqual(['big-number', 'poster']);
  });

  it('answers a name searched in the wrong category with where it really is', () => {
    const result = discover({ query: 'poster', category: 'script' });
    expect(result.matched).toBe(0);
    expect(result.styles.map((s) => s.styleId)).toEqual(['poster']);
    expect(result.note).toContain('own category');
  });

  it('refuses a category the catalog does not have', () => {
    expect(() => discover({ category: 'vintage' })).toThrow();
    expect(TEXT_OVERLAY_STYLE_CATEGORIES.map((c) => c.id)).not.toContain('vintage');
  });

  it('reaches the model as a grouped list of ids and looks', () => {
    const note = summarizeReadResult('discover_text_overlay_styles', discover());
    const lines = note.split('\n');
    expect(lines[0]).toContain(`${TEXT_OVERLAY_STYLE_CATALOG.length} of`);
    expect(lines[0]).toContain('add_text_layer `style`');
    expect(note).toContain('basic: heading (Inter 800 #ffffff, 8% high, middle, shadow)');
    expect(lines).toHaveLength(1 + TEXT_OVERLAY_STYLE_CATEGORIES.length);
  });

  it('says so when nothing matches, and falls back on a payload of another shape', () => {
    expect(summarizeReadResult('discover_text_overlay_styles', discover({ query: 'zzz' }))).toMatch(
      /no text overlay style matches "zzz"/,
    );
    expect(summarizeReadResult('discover_text_overlay_styles', { unexpected: true })).toContain(
      'unexpected',
    );
  });
});
