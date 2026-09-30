/**
 * The text overlay template catalog and text overlay typography (`text-overlay-styles.ts`).
 *
 * The catalog is pure data drawn by the engine's caption rasterizer; these tests keep every look
 * drawable exactly as the tile shows it: bundled families only, weights and italics the family
 * really has (neither renderer fakes one), hex colours (the engine parses hex only), and every
 * typography valid under the schema the engine validates it against.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
  textOverlayLineLayouts,
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

  it('offers frosted glass', () => {
    const frosted = TEXT_OVERLAY_STYLE_CATALOG.filter(
      (t) => (t.look.typography.background?.blur ?? 0) > 0 && t.look.background !== null,
    );
    expect(frosted.map((t) => t.id)).toEqual(expect.arrayContaining(['frosted', 'glass-pill']));
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

describe('textOverlayLineLayouts (lockups)', () => {
  const lockup = {
    fontFamily: 'Anton',
    fontWeight: 400,
    color: '#ffffff',
    fontSizePercent: 12,
    align: 'center',
    boxWidthPercent: 80,
    background: '#101010',
    text: 'CHAPTER ONE\nTHE ROAD NORTH',
    typography: {
      textTransform: 'uppercase',
      background: { radius: 0, paddingX: 0.4 },
      lines: [
        {
          fontFamily: 'Montserrat',
          fontWeight: 650,
          scale: 0.3,
          letterSpacing: 0.3,
          color: '#ffd60a',
          background: null,
        },
        { spaceBefore: -0.2, chip: { radius: 0.2 } },
      ],
    },
  } as const satisfies TextOverlayStyleParams & { text: string };

  it('is undefined for a text overlay with no lines, which draws as one block', () => {
    const { lines: _lines, ...typography } = lockup.typography;
    expect(textOverlayLineLayouts({ ...lockup, typography })).toBeUndefined();
    expect(textOverlayLineLayouts({ ...lockup, typography: undefined })).toBeUndefined();
  });

  it("styles each paragraph with its line's overrides of the overlay's look", () => {
    const [kicker, headline] = textOverlayLineLayouts(lockup)!;
    expect(CaptionStyleSchema.safeParse(kicker!.style).success).toBe(true);
    expect(kicker).toMatchObject({ index: 0, text: 'CHAPTER ONE', scale: 0.3, spaceBefore: 0 });
    expect(kicker!.style).toMatchObject({
      fontFamily: 'Montserrat',
      fontWeight: 650,
      letterSpacing: 0.3,
      textColor: '#ffd60a',
      textTransform: 'uppercase',
    });
    expect(kicker!.style.background).toBeUndefined();
    expect(kicker!.style.fontScale! * CAPTION_FONT_HEIGHT_PERCENT).toBeCloseTo(12 * 0.3);
    expect(headline).toMatchObject({
      index: 1,
      text: 'THE ROAD NORTH',
      scale: 1,
      spaceBefore: -0.2,
    });
    expect(headline!.style).toMatchObject({ fontFamily: 'Anton', textColor: '#ffffff' });
    expect(headline!.style.background).toEqual({ color: '#101010', radius: 0.2, paddingX: 0.4 });
  });

  it('draws extra paragraphs in the overlay look and leaves empty ones out', () => {
    const layouts = textOverlayLineLayouts({ ...lockup, text: 'A\n\nB\nC' })!;
    expect(layouts.map((line) => [line.index, line.style.fontFamily])).toEqual([
      [0, 'Montserrat'],
      [2, 'Anton'],
      [3, 'Anton'],
    ]);
  });

  it('refuses lines the engine refuses', () => {
    for (const line of [{ scale: 0 }, { spaceBefore: 4 }, { fontWeight: 650.5 }, { color: '' }]) {
      expect(parseTextOverlayTypography({ lines: [line] }), JSON.stringify(line)).toBeUndefined();
    }
    expect(parseTextOverlayTypography({ lines: Array.from({ length: 7 }, () => ({})) })).toBe(
      undefined,
    );
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

  it('keeps a frosted blur and never lets a word-timed field through', () => {
    const parsed = parseTextOverlayTypography({
      background: { radius: 0.2, blur: 0.4 },
      highlight: { enabled: true },
    })!;
    expect(parsed.background).toEqual({ radius: 0.2, blur: 0.4 });
    expect('highlight' in parsed).toBe(false);
  });
});

describe('committed schema/text-overlay-styles.json (cross-language contract)', () => {
  // The engine's `add_text_layer` twin writes a style's look from its packaged copy of this
  // file (`test_text_overlay_styles.py` checks that copy against it). This ties the JSON back
  // to the TypeScript it is generated from: a style edited here but never regenerated would
  // make an MCP client and Agent mode write two different looks for one style id.
  it('matches the TS source (run `schema:generate` after editing the catalog)', () => {
    const committed = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'schema',
          'text-overlay-styles.json',
        ),
        'utf-8',
      ),
    ) as unknown;
    expect({
      defaultStyleId: DEFAULT_TEXT_OVERLAY_STYLE_ID,
      categories: TEXT_OVERLAY_STYLE_CATEGORIES,
      styles: TEXT_OVERLAY_STYLE_CATALOG,
    }).toEqual(committed);
  });
});
