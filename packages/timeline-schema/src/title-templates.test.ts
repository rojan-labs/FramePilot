/**
 * The title template catalog and title typography (`title-templates.ts`).
 *
 * The catalog is pure data drawn by the engine's caption rasterizer; these tests keep every look
 * drawable exactly as the tile shows it: bundled families only, weights and italics the family
 * really has (neither renderer fakes one), hex colours (the engine parses hex only), and every
 * typography valid under the schema the engine validates it against.
 */
import { describe, expect, it } from 'vitest';
import { CAPTION_FONT_CATALOG, getCaptionFont } from './caption-fonts.js';
import { CAPTION_TEMPLATE_CATALOG } from './caption-templates.js';
import { CaptionStyleSchema } from './index.js';
import {
  CAPTION_FONT_HEIGHT_PERCENT,
  CAPTION_LOOK_ID_PREFIX,
  DEFAULT_TITLE_TEMPLATE_ID,
  TITLE_TEMPLATE_CATALOG,
  TITLE_TEMPLATE_CATEGORIES,
  TitleTypographySchema,
  getTitleTemplate,
  parseTitleTypography,
  titleCaptionStyle,
  titleLookFromCaptionTemplate,
  type TitleStyleParams,
} from './title-templates.js';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

describe('TITLE_TEMPLATE_CATALOG', () => {
  it('has unique kebab-case ids and a sample text for every template', () => {
    const ids = TITLE_TEMPLATE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TITLE_TEMPLATE_CATALOG) {
      expect(template.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.sampleText.trim().length).toBeGreaterThan(0);
    }
  });

  it('names every template differently, so a search never shows two tiles of one name', () => {
    const labels = TITLE_TEMPLATE_CATALOG.map((t) => t.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('fills every category, and the default template exists', () => {
    const used = new Set(TITLE_TEMPLATE_CATALOG.map((t) => t.category));
    for (const category of TITLE_TEMPLATE_CATEGORIES) expect(used).toContain(category.id);
    expect(getTitleTemplate(DEFAULT_TITLE_TEMPLATE_ID)?.category).toBe('basic');
    expect(getTitleTemplate('nope')).toBeUndefined();
  });

  it('carries every caption template as a caption look', () => {
    for (const caption of CAPTION_TEMPLATE_CATALOG) {
      const title = getTitleTemplate(`${CAPTION_LOOK_ID_PREFIX}${caption.id}`);
      expect(title?.category, caption.id).toBe('caption-looks');
    }
  });

  it('draws only bundled families, at weights and in styles the family ships', () => {
    const bundled = new Set(CAPTION_FONT_CATALOG.map((font) => font.family));
    for (const { id, look } of TITLE_TEMPLATE_CATALOG) {
      expect(bundled.has(look.fontFamily), `${id}: ${look.fontFamily}`).toBe(true);
      const font = getCaptionFont(look.fontFamily)!;
      expect(look.fontWeight, id).toBeGreaterThanOrEqual(font.minWeight);
      expect(look.fontWeight, id).toBeLessThanOrEqual(font.maxWeight);
      if (look.typography.fontStyle === 'italic') {
        expect(font.italicFile, `${id} asks ${font.family} for an italic`).toBeDefined();
      }
    }
  });

  it('uses hex colours only and a valid typography', () => {
    for (const { id, look } of TITLE_TEMPLATE_CATALOG) {
      expect(look.color, id).toMatch(HEX);
      if (look.background !== null) expect(look.background, id).toMatch(HEX);
      if (look.typography.outlineColor) expect(look.typography.outlineColor, id).toMatch(HEX);
      if (look.typography.shadow) expect(look.typography.shadow.color, id).toMatch(HEX);
      const parsed = TitleTypographySchema.safeParse(look.typography);
      expect(parsed.success, `${id}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('keeps a separation layer on every hand-made look', () => {
    for (const { id, category, look } of TITLE_TEMPLATE_CATALOG) {
      if (category === 'caption-looks') continue;
      const t = look.typography;
      const separated =
        look.background !== null || t.shadow !== undefined || (t.outlineWidth ?? 0) > 0;
      expect(separated, `${id} vanishes on a bright shot`).toBe(true);
    }
  });

  it('places every title inside the frame at a sane size', () => {
    for (const { id, look } of TITLE_TEMPLATE_CATALOG) {
      expect(look.fontSizePercent, id).toBeGreaterThan(2);
      expect(look.fontSizePercent, id).toBeLessThanOrEqual(40);
      for (const value of [look.xPercent, look.yPercent, look.boxWidthPercent]) {
        expect(value, id).toBeGreaterThan(0);
        expect(value, id).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('titleCaptionStyle', () => {
  const plain: TitleStyleParams = {
    fontFamily: 'Anton',
    fontWeight: 400,
    color: '#ffffff',
    fontSizePercent: 8,
    align: 'left',
    boxWidthPercent: 60,
    background: null,
  };

  it('is undefined for a plain title, which keeps its own drawing', () => {
    expect(titleCaptionStyle(plain)).toBeUndefined();
  });

  it('keeps the title authoritative for family, weight, colour, size, alignment and wrap', () => {
    const style = titleCaptionStyle({ ...plain, typography: { outlineWidth: 2 } })!;
    expect(CaptionStyleSchema.safeParse(style).success).toBe(true);
    expect(style).toMatchObject({
      display: 'phrase',
      fontFamily: 'Anton',
      fontWeight: 400,
      textColor: '#ffffff',
      textAlign: 'left',
      maxWidthPercent: 60,
      outlineWidth: 2,
    });
    expect(style.fontScale! * CAPTION_FONT_HEIGHT_PERCENT).toBeCloseTo(8);
    expect(style.position).toBeUndefined();
  });

  it('takes the chip colour from the title and its shape from the typography', () => {
    expect(
      titleCaptionStyle({ ...plain, typography: { background: { radius: 0.4 } } })!.background,
    ).toBeUndefined();
    expect(
      titleCaptionStyle({
        ...plain,
        background: '#ffd60a',
        typography: { background: { radius: 0.4 } },
      })!.background,
    ).toEqual({ color: '#ffd60a', radius: 0.4 });
  });
});

describe('parseTitleTypography', () => {
  it('reads a valid typography and refuses anything else', () => {
    expect(parseTitleTypography({ textTransform: 'uppercase' })).toEqual({
      textTransform: 'uppercase',
    });
    expect(parseTitleTypography(undefined)).toBeUndefined();
    expect(parseTitleTypography({ textOpacity: 7 })).toBeUndefined();
    expect(parseTitleTypography('bold')).toBeUndefined();
  });

  it('never lets a frosted blur or a word-timed field through', () => {
    const parsed = parseTitleTypography({
      background: { radius: 0.2, blur: 0.4 },
      highlight: { enabled: true },
    })!;
    expect(parsed.background).toEqual({ radius: 0.2 });
    expect('highlight' in parsed).toBe(false);
  });
});

describe('titleLookFromCaptionTemplate', () => {
  it('drops the frost and the word-timed fields but keeps the chip tint and rim', () => {
    const frosted = CAPTION_TEMPLATE_CATALOG.find((t) => (t.style.background?.blur ?? 0) > 0);
    expect(frosted).toBeDefined();
    const look = titleLookFromCaptionTemplate(frosted!);
    expect(look.background).toBe(frosted!.style.background!.color);
    expect(look.typography.background).not.toHaveProperty('blur');
    expect(look.typography).not.toHaveProperty('highlight');
    expect(look.typography).not.toHaveProperty('animation');
  });

  it('reads a transparent caption chip as no chip', () => {
    const look = titleLookFromCaptionTemplate({
      ...CAPTION_TEMPLATE_CATALOG[0]!,
      style: { fontFamily: 'Inter', background: { color: '#00000000' } },
    });
    expect(look.background).toBeNull();
    expect(look.typography.background).toBeUndefined();
  });
});
