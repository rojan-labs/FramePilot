/**
 * The numbers here are not invented: they are what Pillow measures for the font the export
 * draws with. `ImageFont.load_default(size=1000).getlength(word) / 1000` is the em width,
 * and that font has no kerning, so the sum of the character advances IS the string width.
 * A test that drifts from those advances is a test that has stopped describing the export.
 */
import { describe, expect, it } from 'vitest';

import { overflowingWords, wordWidthEm } from './overlay-fit.js';

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
