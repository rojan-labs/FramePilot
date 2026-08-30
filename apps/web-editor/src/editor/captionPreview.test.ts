/**
 * Tests for the caption-preview interpreter math (schema v10, ADR 0069) —
 * the web-side mirror of the engine's display/emphasis/entrance/loop rules
 * (see engine/python/tests/test_caption_interpreter.py for the pixel side).
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import {
  accentWordIndices,
  captionLineCss,
  captionLineScale,
  captionWordCss,
  captionWordMotion,
  resolveCaptionStyle,
  visibleWordIndices,
  wordState,
} from './captionPreview.js';

const WORDS: readonly TranscriptWord[] = [
  { word: 'this', start: 0, end: 1 },
  { word: 'goes', start: 1, end: 2 },
  { word: 'really', start: 2, end: 3 },
  { word: 'viral', start: 3, end: 4 },
];

describe('wordState', () => {
  it('classifies upcoming/active/spoken by time', () => {
    expect(wordState(WORDS[1]!, 0.5)).toBe('upcoming');
    expect(wordState(WORDS[1]!, 1.5)).toBe('active');
    expect(wordState(WORDS[1]!, 2.5)).toBe('spoken');
  });
});

describe('visibleWordIndices', () => {
  it('phrase shows every word', () => {
    expect([...visibleWordIndices(WORDS, 'phrase', 0.5)]).toEqual([0, 1, 2, 3]);
    expect([...visibleWordIndices(WORDS, undefined, 0.5)]).toEqual([0, 1, 2, 3]);
  });

  it('active-word shows only the spoken word', () => {
    expect([...visibleWordIndices(WORDS, 'active-word', 2.5)]).toEqual([2]);
  });

  it('active-word holds the last spoken word through gaps', () => {
    const gappy: readonly TranscriptWord[] = [
      { word: 'hello', start: 0, end: 1 },
      { word: 'there', start: 2, end: 3 },
    ];
    expect([...visibleWordIndices(gappy, 'active-word', 1.5)]).toEqual([0]);
  });

  it('active-word before the first word shows the first word', () => {
    const late: readonly TranscriptWord[] = [{ word: 'late', start: 2, end: 3 }];
    expect([...visibleWordIndices(late, 'active-word', 0)]).toEqual([0]);
  });

  it('cumulative shows every started word', () => {
    expect([...visibleWordIndices(WORDS, 'cumulative', 2.5)]).toEqual([0, 1, 2]);
    expect([...visibleWordIndices(WORDS, 'cumulative', -1)]).toEqual([]);
  });

  it('is empty for no words', () => {
    expect(visibleWordIndices([], 'phrase', 0).size).toBe(0);
  });
});

describe('accentWordIndices', () => {
  const indices = (...args: Parameters<typeof accentWordIndices>): number[] => [
    ...accentWordIndices(...args),
  ];

  it('selects last-word and longest-word deterministically', () => {
    expect(indices(WORDS, 'last-word')).toEqual([3]);
    expect(indices(WORDS, 'longest-word')).toEqual([2]); // "really"
  });

  it('selects nothing for none/undefined/empty/unknown', () => {
    expect(indices(WORDS, 'none')).toEqual([]);
    expect(indices(WORDS, undefined)).toEqual([]);
    expect(indices([], 'last-word')).toEqual([]);
    expect(indices(WORDS, 'not-a-mode')).toEqual([]);
  });

  it('selects every word matching the style’s keyword list (schema v11)', () => {
    // Before v11 there was no keyword source in the schema, so this mode always
    // selected nothing and the editor's chips never reached a render.
    expect(indices(WORDS, 'keywords', [WORDS[2]!.word])).toEqual([2]);
  });

  it('accents the whole run of words a phrase keyword speaks', () => {
    // Emphasis is a unit of meaning, not of tokenization: "stop scrolling" is
    // the phrase an editor wants to hit, and folding it to one bare token
    // matched nothing here and was rejected outright by auto_emphasize_captions.
    const words = [
      { word: 'make', start: 0, end: 1 },
      { word: 'founders', start: 1, end: 2 },
      { word: 'stop', start: 2, end: 3 },
      { word: 'scrolling', start: 3, end: 4 },
    ];
    expect(indices(words, 'keywords', ['stop scrolling'])).toEqual([2, 3]);
    // Only consecutive words speak the phrase.
    const split = [
      { word: 'stop', start: 0, end: 1 },
      { word: 'now', start: 1, end: 2 },
      { word: 'scrolling', start: 2, end: 3 },
    ];
    expect(indices(split, 'keywords', ['stop scrolling'])).toEqual([]);
  });

  it('lets a longer phrase win over an overlapping bare word', () => {
    const words = [
      { word: 'stop', start: 0, end: 1 },
      { word: 'scrolling', start: 1, end: 2 },
      { word: 'and', start: 2, end: 3 },
      { word: 'stop', start: 3, end: 4 },
    ];
    expect(indices(words, 'keywords', ['stop', 'stop scrolling']).sort()).toEqual([0, 1, 3]);
  });

  it('matches keywords case- and punctuation-insensitively', () => {
    const words = [
      { word: 'Viral!', start: 0, end: 1 },
      { word: 'growth', start: 1, end: 2 },
    ];
    expect(indices(words, 'keywords', ['viral'])).toEqual([0]);
  });

  it('selects every occurrence, not just the first', () => {
    const words = [
      { word: 'go', start: 0, end: 1 },
      { word: 'now', start: 1, end: 2 },
      { word: 'go', start: 2, end: 3 },
    ];
    expect(indices(words, 'keywords', ['go'])).toEqual([0, 2]);
  });

  it('selects nothing for keywords mode with an empty list', () => {
    expect(indices(WORDS, 'keywords', [])).toEqual([]);
    expect(indices(WORDS, 'keywords')).toEqual([]);
  });
});

describe('captionWordMotion', () => {
  it('is fully arrived without an entrance', () => {
    const resolved = resolveCaptionStyle({});
    expect(captionWordMotion(resolved, WORDS[0]!, 0, 10, 0)).toEqual({
      opacity: 1,
      translateYEm: 0,
      scale: 1,
      reveal: 1,
    });
  });

  it('fade ramps opacity from the block start', () => {
    const resolved = resolveCaptionStyle({ animation: { in: { type: 'fade', duration: 0.4 } } });
    expect(captionWordMotion(resolved, WORDS[0]!, 0, 0.1, 0).opacity).toBeCloseTo(0.25);
    expect(captionWordMotion(resolved, WORDS[0]!, 0, 1, 0).opacity).toBe(1);
  });

  it('slide-up offsets downward early', () => {
    const resolved = resolveCaptionStyle({
      animation: { in: { type: 'slide-up', duration: 0.4 } },
    });
    expect(captionWordMotion(resolved, WORDS[0]!, 0, 0.1, 0).translateYEm).toBeGreaterThan(0);
  });

  it('zoom and bounce scale up toward 1', () => {
    const zoom = resolveCaptionStyle({ animation: { in: { type: 'zoom', duration: 0.4 } } });
    expect(captionWordMotion(zoom, WORDS[0]!, 0, 0.1, 0).scale).toBeLessThan(1);
    const bounce = resolveCaptionStyle({ animation: { in: { type: 'bounce', duration: 0.4 } } });
    expect(captionWordMotion(bounce, WORDS[0]!, 0, 0.05, 0).scale).toBeLessThan(1);
  });

  it('typewriter reveals characters', () => {
    const resolved = resolveCaptionStyle({
      animation: { in: { type: 'typewriter', duration: 1 }, perWord: true },
    });
    expect(captionWordMotion(resolved, WORDS[1]!, 1, 1.5, 0).reveal).toBeCloseTo(0.5);
  });

  it('perWord anchors the entrance on the word start', () => {
    const resolved = resolveCaptionStyle({
      animation: { in: { type: 'fade', duration: 0.4 }, perWord: true },
    });
    // Second word starts at t=1; at t=1.1 it is 25% in.
    expect(captionWordMotion(resolved, WORDS[1]!, 1, 1.1, 0).opacity).toBeCloseTo(0.25);
  });

  it('wave bobs words out of phase', () => {
    const resolved = resolveCaptionStyle({ animation: { loop: { type: 'wave', period: 1 } } });
    const a = captionWordMotion(resolved, WORDS[0]!, 0, 0.25, 0).translateYEm;
    const b = captionWordMotion(resolved, WORDS[1]!, 1, 0.25, 0).translateYEm;
    expect(a).not.toBeCloseTo(b);
  });
});

describe('captionLineScale', () => {
  it('pulses over time and is 1 without a pulse loop', () => {
    const pulse = resolveCaptionStyle({ animation: { loop: { type: 'pulse', period: 1 } } });
    expect(captionLineScale(pulse, 0.25)).toBeGreaterThan(1);
    expect(captionLineScale(pulse, 0.75)).toBeLessThan(1);
    expect(captionLineScale(resolveCaptionStyle({}), 0.25)).toBe(1);
  });
});

describe('captionLineCss', () => {
  it('maps typography, chip, shadow and outline', () => {
    const css = captionLineCss(
      resolveCaptionStyle({
        fontFamily: 'Inter',
        fontWeight: 900,
        fontStyle: 'italic',
        textTransform: 'uppercase',
        letterSpacing: 0.1,
        textColor: '#112233',
        outlineColor: '#000000',
        outlineWidth: 2,
        background: { color: '#00000080', radius: 0.5, paddingX: 0.4, paddingY: 0.2 },
        shadow: { color: '#ff00ff', blur: 0.3, offsetX: 0.1, offsetY: 0.2 },
      }),
    );
    expect(css.fontFamily).toBe('Inter');
    expect(css.fontWeight).toBe(900);
    expect(css.fontStyle).toBe('italic');
    expect(css.textTransform).toBe('uppercase');
    expect(css.letterSpacing).toBe('0.1em');
    expect(css.color).toBe('#112233');
    expect(css.backgroundColor).toBe('#00000080');
    expect(css.borderRadius).toBe('0.5em');
    expect(css.padding).toBe('0.2em 0.4em');
    expect(css.textShadow).toBe('0.1em 0.2em 0.3em #ff00ff');
    expect(css.WebkitTextStroke).toContain('#000000');
  });

  it('resolves a templateId into the template look', () => {
    const css = captionLineCss(resolveCaptionStyle({ templateId: 'impact' }));
    expect(css.color).toBe('#ffd60a');
    expect(css.fontFamily).toBe('Archivo Black');
    expect(css.textTransform).toBe('uppercase');
  });
});

describe('captionWordCss', () => {
  const arrived = { opacity: 1, translateYEm: 0, scale: 1, reveal: 1 } as const;

  const emphasisStyle = (animation: string) =>
    resolveCaptionStyle({
      textColor: '#ffffff',
      highlight: { enabled: true, color: '#ff0000', animation: animation as never },
    });

  it('dims upcoming words in phrase display', () => {
    const css = captionWordCss(emphasisStyle('color'), 'upcoming', arrived, false, 0.5, WORDS[3]!);
    expect(css.opacity).toBeCloseTo(0.6);
  });

  it('color emphasis recolors the active word only', () => {
    const active = captionWordCss(emphasisStyle('color'), 'active', arrived, false, 0.5, WORDS[0]!);
    expect(active.color).toBe('#ff0000');
    const spoken = captionWordCss(emphasisStyle('color'), 'spoken', arrived, false, 1.5, WORDS[0]!);
    expect(spoken.color).toBeUndefined();
  });

  it('pop scales the active word by the highlight scale', () => {
    const resolved = resolveCaptionStyle({
      highlight: { enabled: true, animation: 'pop', scale: 1.5 },
    });
    const css = captionWordCss(resolved, 'active', arrived, false, 0.5, WORDS[0]!);
    expect(css.transform).toContain('scale(1.500)');
  });

  it('karaoke-fill maps to a background-clip text gradient at the word fraction', () => {
    const css = captionWordCss(
      emphasisStyle('karaoke-fill'),
      'active',
      arrived,
      false,
      0.5,
      WORDS[0]!,
    );
    expect(css.color).toBe('transparent');
    expect(css.backgroundImage).toContain('linear-gradient');
    expect(css.backgroundImage).toContain('50.0%');
  });

  it('background emphasis draws a chip behind the active word', () => {
    const resolved = resolveCaptionStyle({
      highlight: {
        enabled: true,
        animation: 'background',
        color: '#111111',
        background: '#00ff00',
      },
    });
    const css = captionWordCss(resolved, 'active', arrived, false, 0.5, WORDS[0]!);
    expect(css.backgroundColor).toBe('#00ff00');
    expect(css.color).toBe('#111111');
  });

  it('glow and underline decorate the active word', () => {
    expect(
      captionWordCss(emphasisStyle('glow'), 'active', arrived, false, 0.5, WORDS[0]!).textShadow,
    ).toContain('#ff0000');
    expect(
      captionWordCss(emphasisStyle('underline'), 'active', arrived, false, 0.5, WORDS[0]!)
        .textDecoration,
    ).toBe('underline');
  });

  it('pulse emphasis varies scale within the word', () => {
    const a = captionWordCss(emphasisStyle('pulse'), 'active', arrived, false, 0.15, WORDS[0]!);
    const b = captionWordCss(emphasisStyle('pulse'), 'active', arrived, false, 0.45, WORDS[0]!);
    expect(a.transform).not.toBe(b.transform);
  });

  it('applies accent styling to the accent word', () => {
    const resolved = resolveCaptionStyle({
      accent: {
        mode: 'last-word',
        fontFamily: 'Caveat',
        fontScale: 1.5,
        color: '#00ff00',
        fontStyle: 'italic',
      },
    });
    const css = captionWordCss(resolved, 'spoken', arrived, true, 3.5, WORDS[3]!);
    expect(css.fontFamily).toBe('Caveat');
    expect(css.fontSize).toBe('1.5em');
    expect(css.color).toBe('#00ff00');
    expect(css.fontStyle).toBe('italic');
  });

  it('folds motion opacity/transform into the css', () => {
    const css = captionWordCss(
      resolveCaptionStyle({}),
      'spoken',
      { opacity: 0.5, translateYEm: 0.3, scale: 0.8, reveal: 1 },
      false,
      1.5,
      WORDS[0]!,
    );
    expect(css.opacity).toBeCloseTo(0.5);
    expect(css.transform).toBe('translateY(0.300em) scale(0.800)');
  });
});
