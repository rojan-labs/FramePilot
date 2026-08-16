/**
 * Tests for the caption template catalog (schema v10, ADR 0069).
 *
 * The catalog is pure data interpreted by two renderers; these tests are the
 * contract that keeps it honest: every entry must be a valid, complete
 * CaptionStyle, ids must be stable/unique, the legacy-preset migration must
 * land on real templates, and the resolver's precedence must match the Python
 * mirror's.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTION_TEMPLATE_CATALOG,
  DEFAULT_CAPTION_TEMPLATE_ID,
  getCaptionTemplate,
  layerCaptionStyle,
  resolveCaptionStyle,
  type CaptionTemplateCategory,
} from './caption-templates.js';
import { LEGACY_PRESET_TO_TEMPLATE_ID } from './migrations.js';
import { CaptionStyleSchema } from './index.js';
import { CAPTION_FONT_CATALOG } from './caption-fonts.js';

const ALL_CATEGORIES: readonly CaptionTemplateCategory[] = [
  'one-word',
  'phrase',
  'karaoke',
  'build',
  'boxed',
  'editorial',
  'aesthetic',
  'cinematic',
];

describe('CAPTION_TEMPLATE_CATALOG', () => {
  it('has at least the 40 reference templates', () => {
    expect(CAPTION_TEMPLATE_CATALOG.length).toBeGreaterThanOrEqual(40);
  });

  it('has unique, kebab-case ids and non-empty labels', () => {
    const ids = CAPTION_TEMPLATE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      expect(template.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(template.label.length).toBeGreaterThan(0);
    }
  });

  it('covers every gallery category', () => {
    const covered = new Set(CAPTION_TEMPLATE_CATALOG.map((t) => t.category));
    for (const category of ALL_CATEGORIES) expect(covered).toContain(category);
  });

  it('every style parses under CaptionStyleSchema and omits templateId', () => {
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      const parsed = CaptionStyleSchema.safeParse(template.style);
      expect(parsed.success, `template ${template.id}: ${parsed.error?.message}`).toBe(true);
      expect(template.style.templateId, `template ${template.id}`).toBeUndefined();
    }
  });

  it('uses only bundled fonts and spreads templates across creative families', () => {
    const bundled = new Set(CAPTION_FONT_CATALOG.map((font) => font.family));
    const used = new Set<string>();
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      for (const family of [template.style.fontFamily, template.style.accent?.fontFamily]) {
        if (!family) continue;
        expect(bundled.has(family), `${template.id}: ${family}`).toBe(true);
        used.add(family);
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(15);
  });

  it('one-word templates group one word per line; others more', () => {
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      expect(Number.isInteger(template.suggestedWordsPerLine)).toBe(true);
      if (template.style.display === 'active-word') {
        expect(template.suggestedWordsPerLine, `template ${template.id}`).toBe(1);
      } else {
        expect(template.suggestedWordsPerLine, `template ${template.id}`).toBeGreaterThan(1);
      }
    }
  });

  it('uses hex-only colors (the engine rasterizer cannot parse CSS color functions)', () => {
    const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
    for (const template of CAPTION_TEMPLATE_CATALOG) {
      const s = template.style;
      const colors = [
        s.textColor,
        s.outlineColor,
        s.background?.color,
        s.shadow?.color,
        s.highlight?.color,
        s.highlight?.background,
        s.accent?.color,
      ];
      for (const color of colors) {
        if (color !== undefined) expect(color, `template ${template.id}`).toMatch(HEX);
      }
    }
  });

  it('resolves the default template and every legacy-preset migration target', () => {
    expect(getCaptionTemplate(DEFAULT_CAPTION_TEMPLATE_ID)).toBeDefined();
    for (const templateId of Object.values(LEGACY_PRESET_TO_TEMPLATE_ID)) {
      expect(getCaptionTemplate(templateId), `migration target ${templateId}`).toBeDefined();
    }
  });
});

describe('resolveCaptionStyle', () => {
  it('returns an empty style for undefined (baseline rendering)', () => {
    expect(resolveCaptionStyle(undefined)).toEqual({});
  });

  it('returns explicit fields unchanged when there is no templateId', () => {
    expect(resolveCaptionStyle({ textColor: '#ff0000', fontScale: 2 })).toEqual({
      textColor: '#ff0000',
      fontScale: 2,
    });
  });

  it('fills unset fields from the template', () => {
    const template = getCaptionTemplate('karaoke')!;
    const resolved = resolveCaptionStyle({ templateId: 'karaoke' });
    expect(resolved).toEqual(template.style);
  });

  it('lets explicit fields win over the template (field-level replace)', () => {
    const resolved = resolveCaptionStyle({
      templateId: 'karaoke',
      textColor: '#123456',
      highlight: { enabled: false },
    });
    expect(resolved.textColor).toBe('#123456');
    // An explicit nested object replaces the template's wholesale.
    expect(resolved.highlight).toEqual({ enabled: false });
    // Untouched fields still come from the template.
    expect(resolved.fontWeight).toBe(getCaptionTemplate('karaoke')!.style.fontWeight);
  });

  it('ignores an unknown templateId and keeps the explicit fields', () => {
    expect(resolveCaptionStyle({ templateId: 'nope', textColor: '#123456' })).toEqual({
      textColor: '#123456',
    });
  });

  it('never returns a templateId (resolution is not re-entrant)', () => {
    const resolved = resolveCaptionStyle({ templateId: 'karaoke' });
    expect('templateId' in resolved && resolved.templateId).toBeFalsy();
  });
});

// --- track-level caption style (schema v11, ADR 0071) ----------------------

describe('layerCaptionStyle', () => {
  it('returns the clip override when there is no track default', () => {
    expect(layerCaptionStyle(undefined, { textColor: '#fff' })).toEqual({ textColor: '#fff' });
  });

  it('returns the track default when the clip overrides nothing', () => {
    expect(layerCaptionStyle({ templateId: 'karaoke' }, undefined)).toEqual({
      templateId: 'karaoke',
    });
  });

  it('returns undefined when neither side has a style', () => {
    expect(layerCaptionStyle(undefined, undefined)).toBeUndefined();
  });

  it('lets the clip win field-by-field over the track default', () => {
    expect(
      layerCaptionStyle(
        { templateId: 'karaoke', textColor: '#ffffff', fontScale: 1 },
        { textColor: '#ffd84d' },
      ),
    ).toEqual({ templateId: 'karaoke', textColor: '#ffd84d', fontScale: 1 });
  });

  it('lets one cue adopt a different template than its track', () => {
    expect(layerCaptionStyle({ templateId: 'karaoke' }, { templateId: 'boxed' })).toEqual({
      templateId: 'boxed',
    });
  });
});

describe('resolveCaptionStyle — with a track default (schema v11)', () => {
  it('resolves the track template for a cue with no style of its own', () => {
    // This is what makes a track-wide restyle work: the cue itself is unstyled.
    const resolved = resolveCaptionStyle(undefined, { templateId: 'karaoke' });
    expect(resolved.fontWeight).toBe(getCaptionTemplate('karaoke')!.style.fontWeight);
  });

  it('applies the full precedence chain: clip over track over template', () => {
    const resolved = resolveCaptionStyle(
      { textColor: '#ffd84d' },
      { templateId: 'karaoke', fontScale: 1.4 },
    );
    // Clip wins.
    expect(resolved.textColor).toBe('#ffd84d');
    // Track fills what the clip left unset.
    expect(resolved.fontScale).toBe(1.4);
    // Template fills what neither set.
    expect(resolved.fontWeight).toBe(getCaptionTemplate('karaoke')!.style.fontWeight);
  });

  it('behaves exactly as v10 did when no track default is passed', () => {
    expect(resolveCaptionStyle({ templateId: 'karaoke' })).toEqual(
      resolveCaptionStyle({ templateId: 'karaoke' }, undefined),
    );
  });
});
