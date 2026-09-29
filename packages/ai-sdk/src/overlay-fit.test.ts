/**
 * The numbers here are not invented: they are what Pillow measures for the font the export
 * draws with. `ImageFont.load_default(size=1000).getlength(word) / 1000` is the em width,
 * and that font has no kerning, so the sum of the character advances IS the string width.
 * A test that drifts from those advances is a test that has stopped describing the export.
 */
import { describe, expect, it } from 'vitest';

import { getTextOverlayStyle } from '@framepilot/timeline-schema/text-overlay-styles';
import {
  largestFittingSizePercent,
  overflowingWords,
  typedTitleDrawnWidthPx,
  typedTitleFont,
  typedTitleOf,
  typedTitleWidthsPx,
  wordWidthEm,
} from './overlay-fit.js';
import { TITLE_REFERENCE_FRAME, TITLE_TYPED_REFERENCE_WIDTHS } from './title-metrics.generated.js';

const LANDSCAPE = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

describe('wordWidthEm', () => {
  it('matches what the export font measures', () => {
    // `ImageFont.load_default(size=1000).getlength(w)/1000`, to the digit.
    expect(wordWidthEm('opening')).toBeCloseTo(3.785, 3);
    expect(wordWidthEm('weekend')).toBeCloseTo(4.162, 3);
    expect(wordWidthEm('Unterhaltungselektronik')).toBeCloseTo(10.859, 2);
    // Narrow and wide glyphs are not the same character: 'illili' is under a third of
    // 'WWWWW', which is what makes a character count a useless proxy for width.
    expect(wordWidthEm('illili')).toBeCloseTo(1.455, 3);
    expect(wordWidthEm('WWWWW')).toBeCloseTo(4.76, 3);
  });

  it('treats an uncovered script as no wider than half an em, which under-reports', () => {
    // CJK is a full em each; charging 0.5 can only make a word look narrower than it is,
    // and a check that under-reports is the one this is allowed to be.
    expect(wordWidthEm('日本語')).toBeCloseTo(1.5, 2);
  });
});

describe('overflowingWords', () => {
  it('has no opinion without an authored size and box width', () => {
    const text = 'Unterhaltungselektronik';
    expect(overflowingWords({ text, fontSizePercent: 18 }, LANDSCAPE)).toEqual([]);
    expect(overflowingWords({ text, boxWidthPercent: 30 }, LANDSCAPE)).toEqual([]);
    expect(overflowingWords({ fontSizePercent: 18, boxWidthPercent: 30 }, LANDSCAPE)).toEqual([]);
    // A renderer default is not an authored value. Reporting against one would be
    // reporting against a number the editor never chose.
    expect(overflowingWords({ text, fontSizePercent: 0, boxWidthPercent: 30 }, LANDSCAPE)).toEqual(
      [],
    );
  });

  it('passes an ordinary caption', () => {
    // 8% of 1080 = 86px glyphs in an 80%-of-1920 = 1536px box: 17.7em of room.
    const params = {
      text: 'the world cup is the hardest trophy to win',
      fontSizePercent: 8,
      boxWidthPercent: 80,
    };
    expect(overflowingWords(params, LANDSCAPE)).toEqual([]);
  });

  it('catches the headline shape a model actually writes', () => {
    // `add_text_layer`'s own description offers "18+ is a headline that dominates the
    // frame", and a narrow box beside it is the combination that overflows: 18% of 1080 is
    // a 194px em, and 30% of 1920 is a 576px box — under 3em of room for a 4.16em word.
    const over = overflowingWords(
      { text: 'Breck, opening weekend', fontSizePercent: 18, boxWidthPercent: 30 },
      LANDSCAPE,
    );
    // Widest first, and 'weekend' (4.162em) is wider than 'opening' (3.785em) — a word's
    // width is its glyphs', not its letter count's.
    expect(over.map((o) => o.word)).toEqual(['weekend', 'opening']);
    // Recommended from the MEASURED width, so the box it names actually holds the word:
    // 4.162em × 18% of 1080 = 809px, which is 42.2% of 1920, rounded up.
    expect(over[0]?.requiredBoxWidthPercent).toBe(43);
    expect(over[0]?.boxWidthPercent).toBe(30);
  });

  it('reports past 100% when no box is wide enough', () => {
    const over = overflowingWords(
      { text: 'Unterhaltungselektronik', fontSizePercent: 20, boxWidthPercent: 80 },
      LANDSCAPE,
    );
    // 10.88em × 20% of 1080 = 2351px of glyphs in a 1920px frame. The box is not the
    // problem; the size is, and a value over 100 is how the caller can tell.
    expect(over[0]?.requiredBoxWidthPercent).toBeGreaterThan(100);
  });

  it('is aspect-aware: the same style overflows vertical and not landscape', () => {
    const params = { text: 'championship', fontSizePercent: 9, boxWidthPercent: 60 };
    expect(overflowingWords(params, LANDSCAPE)).toEqual([]);
    expect(overflowingWords(params, VERTICAL).map((o) => o.word)).toEqual(['championship']);
  });

  it('holds its tongue within the allowance for a narrower font', () => {
    // 'weekend' is 4.162em measured, so it is reported only below 3.746em (×0.9). A box of
    // 3.8em is too narrow for the bundled font, but a family 10% narrower would fit it, so
    // nothing is reported — the discount makes a report true of BOTH renderers, not just
    // the one that has metrics.
    const boxWidthPercent = (3.8 * 12 * 1080) / 1920;
    expect(
      overflowingWords({ text: 'weekend', fontSizePercent: 12, boxWidthPercent }, LANDSCAPE),
    ).toEqual([]);
    // 3.7em is past even that, and is reported.
    expect(
      overflowingWords(
        { text: 'weekend', fontSizePercent: 12, boxWidthPercent: (3.7 * 12 * 1080) / 1920 },
        LANDSCAPE,
      ).map((o) => o.word),
    ).toEqual(['weekend']);
  });

  it('reports each distinct word once, widest first', () => {
    const over = overflowingWords(
      { text: 'weekend opening weekend', fontSizePercent: 18, boxWidthPercent: 30 },
      LANDSCAPE,
    );
    expect(over.map((o) => o.word)).toEqual(['weekend', 'opening']);
  });
});

/**
 * A title with caption typography is drawn by the caption rasterizer: tracked, in its italic
 * file, stroked and padded (#135). The reference widths are what that rasterizer drew,
 * written by `python -m framepilot_engine.render.title_metrics`; `tests/test_title_metrics.py`
 * checks the same arithmetic against the rasterizer directly.
 */
describe('typed titles are measured as the caption rasterizer draws them', () => {
  const typedOf = (ref: (typeof TITLE_TYPED_REFERENCE_WIDTHS)[number]) => {
    const typography = {
      letterSpacing: ref.letterSpacing,
      fontStyle: ref.fontStyle,
      ...(ref.outlineWidth > 0 ? { outlineColor: '#000000', outlineWidth: ref.outlineWidth } : {}),
      ...(ref.paddingX === null ? {} : { background: { paddingX: ref.paddingX } }),
    };
    return typedTitleOf(typography, ref.background)!;
  };

  it('predicts every width the engine drew, to rounding and weight bucketing', () => {
    expect(TITLE_TYPED_REFERENCE_WIDTHS.length).toBeGreaterThan(0);
    for (const ref of TITLE_TYPED_REFERENCE_WIDTHS) {
      const typed = typedOf(ref);
      const font = typedTitleFont({ fontFamily: ref.family, fontWeight: ref.weight }, typed);
      const fontPx = Math.floor((TITLE_REFERENCE_FRAME.height * ref.size) / 100);
      const { wrapPx } = typedTitleWidthsPx(ref.word, fontPx, font, typed);
      const drawn = typedTitleDrawnWidthPx(ref.word, fontPx, font, typed);
      const label = `${ref.family} ${ref.word} ${String(ref.size)}%`;
      // The wrap width reads wide only where a weight is bucketed up (600 → 700), never narrow.
      expect(wrapPx, label).toBeGreaterThanOrEqual(ref.wrapPx * 0.975 - 2);
      expect(wrapPx, label).toBeLessThanOrEqual(ref.wrapPx * 1.03 + 2);
      // Everything drawn — the chip, or the stroked, slanted ink — is inside what the fit reads.
      expect(drawn, label).toBeGreaterThanOrEqual(ref.drawnPx * 0.975 - 2);
    }
  });

  it('adds the tracking between the letters of "WEEKEND TRIP" in tracked-caps', () => {
    const style = getTextOverlayStyle('tracked-caps')!;
    expect(style.look.typography.letterSpacing).toBe(0.24);
    const typed = typedTitleOf(style.look.typography, style.look.background)!;
    const font = typedTitleFont({ fontFamily: 'Montserrat', fontWeight: 600 }, typed);
    const untracked = { ...typed, letterSpacing: 0 };
    // At the harness's 4 % of a 1080×1920 frame (76 px), six gaps of 0.24 em are 109 px.
    const fontPx = Math.floor((1920 * 4) / 100);
    const tracked = typedTitleWidthsPx('WEEKEND', fontPx, font, typed).wrapPx;
    const plain = typedTitleWidthsPx('WEEKEND', fontPx, font, untracked).wrapPx;
    expect(tracked - plain).toBeGreaterThanOrEqual(Math.floor(6 * 0.24 * fontPx) - 1);
    expect(tracked - plain).toBeLessThanOrEqual(Math.ceil(6 * 0.24 * fontPx) + 1);
    // A single glyph has no gap, and negative tracking is not drawn by the export at all.
    expect(typedTitleWidthsPx('I', fontPx, font, typed).wrapPx).toBe(
      typedTitleWidthsPx('I', fontPx, font, untracked).wrapPx,
    );
    expect(
      typedTitleWidthsPx('WEEKEND', fontPx, font, { ...typed, letterSpacing: -0.1 }).wrapPx,
    ).toBe(plain);
  });

  it('reports a tracked word the untracked measure would have let through', () => {
    const style = getTextOverlayStyle('tracked-caps')!;
    const base = {
      text: 'weekend trip',
      fontFamily: 'Montserrat',
      fontWeight: 600,
      fontSizePercent: 7.5,
      boxWidthPercent: 92,
      background: null,
    };
    // Untracked (the fit before #135): "WEEKEND" at 7.5 % fits a 92 % box.
    const untracked = { ...style.look.typography, letterSpacing: 0 };
    expect(overflowingWords({ ...base, typography: untracked }, VERTICAL)).toEqual([]);
    // Tracked as drawn, it does not — and the box it needs is past the frame's safe width.
    const over = overflowingWords({ ...base, typography: style.look.typography }, VERTICAL);
    expect(over.map((o) => o.word)).toEqual(['WEEKEND']);
    expect(over[0]!.requiredBoxWidthPercent).toBeGreaterThan(92);
  });

  it('fits the largest size whose tracked words the box holds', () => {
    const style = getTextOverlayStyle('tracked-caps')!;
    const typed = typedTitleOf(style.look.typography, null)!;
    const font = { fontFamily: 'Montserrat', fontWeight: 600 };
    const size = largestFittingSizePercent('WEEKEND TRIP', 92, VERTICAL, font, typed)!;
    const limit = Math.floor(1080 * 0.92);
    const drawnAt = (percent: number) =>
      typedTitleDrawnWidthPx(
        'WEEKEND',
        Math.floor((1920 * percent) / 100),
        typedTitleFont(font, typed),
        typed,
      );
    expect(drawnAt(size)).toBeLessThanOrEqual(limit);
    expect(drawnAt(size + 0.1)).toBeGreaterThan(limit);
    // Tracking costs size: untracked, the same words fit larger.
    const plain = largestFittingSizePercent('WEEKEND TRIP', 92, VERTICAL, font, {
      ...typed,
      letterSpacing: 0,
    })!;
    expect(plain).toBeGreaterThan(size);
  });

  it('measures an italic from the italic file, and ignores italic where none ships', () => {
    const typed = typedTitleOf({ fontStyle: 'italic' }, null)!;
    const upright = { ...typed, fontStyle: 'normal' as const };
    const playfair = { fontFamily: 'Playfair Display', fontWeight: 400 };
    const italic = typedTitleWidthsPx('Journey', 200, typedTitleFont(playfair, typed), typed);
    const roman = typedTitleWidthsPx('Journey', 200, typedTitleFont(playfair, upright), upright);
    expect(italic.wrapPx).not.toBe(roman.wrapPx);
    // Montserrat ships no italic file: the export draws it upright, and so does the fit.
    const montserrat = { fontFamily: 'Montserrat', fontWeight: 400 };
    expect(typedTitleWidthsPx('Journey', 200, typedTitleFont(montserrat, typed), typed)).toEqual(
      typedTitleWidthsPx('Journey', 200, typedTitleFont(montserrat, upright), upright),
    );
  });

  it('reads the chip padding only when a chip colour is set, and a plain title as plain', () => {
    const typography = { background: { paddingX: 0.1 } };
    expect(typedTitleOf(typography, '#000000cc')!.paddingX).toBe(0.1);
    // No chip colour: the caption path keeps its default padding (text_overlay_caption_style).
    expect(typedTitleOf(typography, null)!.paddingX).toBe(0.35);
    // No typography, or one that does not validate: the export draws the plain title.
    expect(typedTitleOf(undefined, null)).toBeUndefined();
    expect(typedTitleOf({ lineHeight: 9 }, null)).toBeUndefined();
    // A typed title with no family is drawn in the editor's Inter.
    expect(typedTitleFont(undefined, typedTitleOf({}, null)!).fontFamily).toBe('Inter');
  });
});
