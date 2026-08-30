import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_FONT_CATALOG,
  DEFAULT_CAPTION_FONT_FAMILY,
  getCaptionFont,
  type CaptionFontCategory,
} from './caption-fonts.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const engineFontDir = `${root}/engine/python/framepilot_engine/render/fonts`;
const webFontDir = `${root}/apps/web-editor/public/fonts`;

describe('CAPTION_FONT_CATALOG', () => {
  it('ships at least 20 unique generally useful families across creative categories', () => {
    expect(CAPTION_FONT_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(new Set(CAPTION_FONT_CATALOG.map((font) => font.family)).size).toBe(
      CAPTION_FONT_CATALOG.length,
    );
    const categories = new Set<CaptionFontCategory>(
      CAPTION_FONT_CATALOG.map((font) => font.category),
    );
    expect(categories).toEqual(new Set(['sans', 'display', 'serif', 'mono', 'handwritten']));
  });

  it('keeps the default and lookup on the canonical catalog', () => {
    expect(getCaptionFont(DEFAULT_CAPTION_FONT_FAMILY)?.family).toBe(DEFAULT_CAPTION_FONT_FAMILY);
    expect(getCaptionFont('not bundled')).toBeUndefined();
  });

  it('mirrors every declared binary into preview and export runtimes', () => {
    for (const font of CAPTION_FONT_CATALOG) {
      for (const file of [font.file, font.boldFile, font.italicFile].filter(
        (value): value is string => value !== undefined,
      )) {
        const engineBytes = readFileSync(`${engineFontDir}/${file}`);
        const webBytes = readFileSync(`${webFontDir}/${file}`);
        expect(engineBytes.byteLength, file).toBeGreaterThan(1_000);
        expect(webBytes.byteLength, file).toBeGreaterThan(1_000);
        // Buffer.equals is an exact byte comparison; used instead of structural
        // `toEqual`, which is prohibitively slow on multi-MB binaries in vitest 3.
        expect(engineBytes.equals(webBytes), file).toBe(true);
      }
    }
  });

  it('keeps valid weight ranges', () => {
    for (const font of CAPTION_FONT_CATALOG) {
      expect(font.minWeight).toBeGreaterThanOrEqual(100);
      expect(font.maxWeight).toBeLessThanOrEqual(900);
      expect(font.minWeight).toBeLessThanOrEqual(font.maxWeight);
    }
  });
});

describe('committed schema/caption-fonts.json (cross-language contract)', () => {
  // Same gap the effect/transition/caption catalogs had: the generated JSON is
  // what non-TypeScript consumers read, and nothing pinned it to the source it
  // is generated from. A font added here without `schema:generate` would be
  // offered by the editor while the published catalog never listed it.
  it('matches the TS source (run `schema:generate` after editing the font catalog)', () => {
    const committed = JSON.parse(
      readFileSync(`${root}/packages/timeline-schema/schema/caption-fonts.json`, 'utf-8'),
    ) as unknown;
    expect({
      defaultFontFamily: DEFAULT_CAPTION_FONT_FAMILY,
      fonts: CAPTION_FONT_CATALOG,
    }).toEqual(committed);
  });
});
