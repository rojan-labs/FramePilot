/**
 * The text overlay template catalog and text overlay typography (`text-overlay-styles.ts`).
 *
 * The catalog is pure data drawn by the engine's caption rasterizer; these tests keep every look
 * drawable exactly as the tile shows it: bundled families only, weights and italics the family
 * really has (neither renderer fakes one), hex colours (the engine parses hex only), and every
 * typography valid under the schema the engine validates it against.
 */
import { describe, expect, it } from 'vitest';
import { CAPTION_FONT_CATALOG, getCaptionFont } from './caption-fonts.js';
import { CaptionStyleSchema } from './index.js';
import {
  CAPTION_FONT_HEIGHT_PERCENT,
  DEFAULT_TEXT_OVERLAY_STYLE_ID,
  TEXT_OVERLAY_STYLE_CATALOG,
  TEXT_OVERLAY_STYLE_CATEGORIES,
  TextOverlayTypographySchema,
  getTextOverlayStyle,
  parseTextOverlayTypography,
  textOverlayCaptionStyle,
  type TextOverlayStyleParams,
} from './text-overlay-styles.js';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

describe('TEXT_OVERLAY_STYLE_CATALOG', () => {
  it('has unique kebab-case ids and a sample text for every template', () => {
    const ids = TEXT_OVERLAY_STYLE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEXT_OVERLAY_STYLE_CATALOG) {
      expect(template.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.sampleText.trim().length).toBeGreaterThan(0);
    }
  });

  it('names every template differently, so a search never shows two tiles of one name', () => {
    const labels = TEXT_OVERLAY_STYLE_CATALOG.map((t) => t.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('fills every category, and the default template exists', () => {
    const used = new Set(TEXT_OVERLAY_STYLE_CATALOG.map((t) => t.category));
    for (const category of TEXT_OVERLAY_STYLE_CATEGORIES) expect(used).toContain(category.id);
    expect(getTextOverlayStyle(DEFAULT_TEXT_OVERLAY_STYLE_ID)?.category).toBe('basic');
    expect(getTextOverlayStyle('nope')).toBeUndefined();
  });

  it('offers many styles in every category, drawn in many different fonts', () => {
    expect(TEXT_OVERLAY_STYLE_CATALOG.length).toBeGreaterThanOrEqual(50);
    for (const category of TEXT_OVERLAY_STYLE_CATEGORIES) {
      const count = TEXT_OVERLAY_STYLE_CATALOG.filter((t) => t.category === category.id).length;
      expect(count, category.id).toBeGreaterThanOrEqual(5);
    }
    const families = new Set(TEXT_OVERLAY_STYLE_CATALOG.map((t) => t.look.fontFamily));
    expect(families.size).toBeGreaterThanOrEqual(35);
  });

  it('draws only bundled families, at weights and in styles the family ships', () => {
    const bundled = new Set(CAPTION_FONT_CATALOG.map((font) => font.family));
    for (const { id, look } of TEXT_OVERLAY_STYLE_CATALOG) {
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
    for (const { id, look } of TEXT_OVERLAY_STYLE_CATALOG) {
      expect(look.color, id).toMatch(HEX);
      if (look.background !== null) expect(look.background, id).toMatch(HEX);
      if (look.typography.outlineColor) expect(look.typography.outlineColor, id).toMatch(HEX);
      if (look.typography.shadow) expect(look.typography.shadow.color, id).toMatch(HEX);
      const parsed = TextOverlayTypographySchema.safeParse(look.typography);
      expect(parsed.success, `${id}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('keeps a separation layer on every hand-made look', () => {
    for (const { id, look } of TEXT_OVERLAY_STYLE_CATALOG) {
      const t = look.typography;
      const separated =
        look.background !== null || t.shadow !== undefined || (t.outlineWidth ?? 0) > 0;
      expect(separated, `${id} vanishes on a bright shot`).toBe(true);
    }
  });

  it('places every text overlay inside the frame at a sane size', () => {
    for (const { id, look } of TEXT_OVERLAY_STYLE_CATALOG) {
      expect(look.fontSizePercent, id).toBeGreaterThan(2);
      expect(look.fontSizePercent, id).toBeLessThanOrEqual(40);
      for (const value of [look.xPercent, look.yPercent, look.boxWidthPercent]) {
        expect(value, id).toBeGreaterThan(0);
        expect(value, id).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('textOverlayCaptionStyle', () => {
  const plain: TextOverlayStyleParams = {
    fontFamily: 'Anton',
    fontWeight: 400,
    color: '#ffffff',
    fontSizePercent: 8,
    align: 'left',
    boxWidthPercent: 60,
    background: null,
  };

  it('is undefined for a plain text overlay, which keeps its own drawing', () => {
    expect(textOverlayCaptionStyle(plain)).toBeUndefined();
  });

  it('keeps the text overlay authoritative for family, weight, colour, size, alignment and wrap', () => {
    const style = textOverlayCaptionStyle({ ...plain, typography: { outlineWidth: 2 } })!;
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

  it('takes the chip colour from the text overlay and its shape from the typography', () => {
    expect(
      textOverlayCaptionStyle({ ...plain, typography: { background: { radius: 0.4 } } })!
        .background,
    ).toBeUndefined();
    expect(
      textOverlayCaptionStyle({
        ...plain,
        background: '#ffd60a',
        typography: { background: { radius: 0.4 } },
      })!.background,
    ).toEqual({ color: '#ffd60a', radius: 0.4 });
  });
});

describe('parseTextOverlayTypography', () => {
  it('reads a valid typography and refuses anything else', () => {
    expect(parseTextOverlayTypography({ textTransform: 'uppercase' })).toEqual({
      textTransform: 'uppercase',
    });
    expect(parseTextOverlayTypography(undefined)).toBeUndefined();
    expect(parseTextOverlayTypography({ textOpacity: 7 })).toBeUndefined();
    expect(parseTextOverlayTypography('bold')).toBeUndefined();
  });

  it('never lets a frosted blur or a word-timed field through', () => {
    const parsed = parseTextOverlayTypography({
      background: { radius: 0.2, blur: 0.4 },
      highlight: { enabled: true },
    })!;
    expect(parsed.background).toEqual({ radius: 0.2 });
    expect('highlight' in parsed).toBe(false);
  });
});
