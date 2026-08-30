/**
 * Tests for the caption segmenter (ADR 0071).
 *
 * These assert *readability properties*, not just mechanics: a break lands on a
 * sentence end when one is available, a line never ends on "the", a cue is never
 * held for less than the configured floor, and cues never overlap. Those are the
 * things that make generated captions look authored, so they are what is pinned.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import {
  CAPTION_SEGMENT_PRESETS,
  DEFAULT_CAPTION_SEGMENT_PRESET,
  breakQuality,
  captionSegmentConfig,
  enforceReadingSpeed,
  enforceTiming,
  isClauseEnd,
  isSentenceEnd,
  layoutLines,
  packSegment,
  presetForWordsPerLine,
  segmentCaptions,
  splitIntoUtterances,
} from './segment.js';
import { secondsToFrame } from '../frame-grid.js';

/**
 * Build words from a sentence at a fixed cadence. `gapAfter` injects a real
 * silence after the given 0-based word index, so pause behavior is testable
 * without hand-writing timings.
 */
function speak(
  text: string,
  options: { readonly wordSeconds?: number; readonly gapAfter?: Record<number, number> } = {},
): TranscriptWord[] {
  const wordSeconds = options.wordSeconds ?? 0.3;
  const gaps = options.gapAfter ?? {};
  let t = 0;
  return text.split(' ').map((word, index) => {
    const entry = { word, start: +t.toFixed(4), end: +(t + wordSeconds).toFixed(4) };
    t += wordSeconds + (gaps[index] ?? 0);
    return entry;
  });
}

/** The words of a cue as a plain string, ignoring layout line breaks. */
const flat = (text: string): string => text.replace(/\n/g, ' ');

describe('captionSegmentConfig', () => {
  it('returns the named preset unchanged when there are no overrides', () => {
    expect(captionSegmentConfig('subtitle')).toEqual(CAPTION_SEGMENT_PRESETS.subtitle);
  });

  it('defaults to the short-form preset', () => {
    expect(captionSegmentConfig()).toEqual(CAPTION_SEGMENT_PRESETS[DEFAULT_CAPTION_SEGMENT_PRESET]);
  });

  it('applies overrides over the preset', () => {
    const config = captionSegmentConfig('subtitle', { maxWordsPerCue: 3 });
    expect(config.maxWordsPerCue).toBe(3);
    expect(config.maxCharsPerLine).toBe(CAPTION_SEGMENT_PRESETS.subtitle.maxCharsPerLine);
  });

  it('clamps nonsensical values instead of throwing or looping forever', () => {
    // Fed by UI sliders and AI tool arguments: 0 words per cue must degrade to 1,
    // not produce a segmenter that can never advance.
    const config = captionSegmentConfig('short-form', {
      maxCharsPerLine: 0,
      maxLines: 0,
      maxWordsPerCue: 0,
      minCueSeconds: -5,
      maxCueSeconds: 0,
      maxCharsPerSecond: 0,
      pauseSeconds: -1,
      bridgeGapSeconds: -1,
    });
    expect(config).toEqual({
      maxCharsPerLine: 1,
      maxLines: 1,
      maxWordsPerCue: 1,
      minCueSeconds: 0,
      maxCueSeconds: 0.1,
      maxCharsPerSecond: 1,
      pauseSeconds: 0,
      bridgeGapSeconds: 0,
      emphasisWords: [],
    });
  });

  it('normalizes and de-duplicates semantic emphasis words', () => {
    expect(
      captionSegmentConfig('short-form', { emphasisWords: ['Viral!', 'viral', 'RESULTS'] })
        .emphasisWords,
    ).toEqual(['viral', 'results']);
  });

  it('rounds fractional integer limits', () => {
    const config = captionSegmentConfig('short-form', {
      maxCharsPerLine: 20.6,
      maxLines: 1.4,
      maxWordsPerCue: 3.5,
    });
    expect(config.maxCharsPerLine).toBe(21);
    expect(config.maxLines).toBe(1);
    expect(config.maxWordsPerCue).toBe(4);
  });
});

describe('presetForWordsPerLine', () => {
  it('maps the one-word template family to the one-word preset', () => {
    expect(presetForWordsPerLine(1)).toBe('one-word');
    expect(presetForWordsPerLine(0)).toBe('one-word');
  });

  it('maps short groupings to short-form', () => {
    expect(presetForWordsPerLine(2)).toBe('short-form');
    expect(presetForWordsPerLine(6)).toBe('short-form');
  });

  it('maps long groupings to subtitle timing', () => {
    expect(presetForWordsPerLine(7)).toBe('subtitle');
    expect(presetForWordsPerLine(12)).toBe('subtitle');
  });
});

describe('isSentenceEnd / isClauseEnd', () => {
  it('recognizes sentence-final punctuation', () => {
    expect(isSentenceEnd('done.')).toBe(true);
    expect(isSentenceEnd('really?')).toBe(true);
    expect(isSentenceEnd('stop!')).toBe(true);
    expect(isSentenceEnd('wait…')).toBe(true);
  });

  it('allows a closing quote or bracket to trail the punctuation', () => {
    expect(isSentenceEnd('"done."')).toBe(true);
    expect(isSentenceEnd('done.)')).toBe(true);
  });

  it('does not treat a known abbreviation as a sentence end', () => {
    // Breaking after "Dr." reads as a dropped sentence.
    expect(isSentenceEnd('Dr.')).toBe(false);
    expect(isSentenceEnd('vs.')).toBe(false);
    expect(isSentenceEnd('etc.')).toBe(false);
  });

  it('recognizes clause punctuation, excluding sentence ends', () => {
    expect(isClauseEnd('broke,')).toBe(true);
    expect(isClauseEnd('this:')).toBe(true);
    expect(isClauseEnd('aside—')).toBe(true);
    expect(isClauseEnd('done.')).toBe(false);
    expect(isClauseEnd('plain')).toBe(false);
  });

  it('treats a bare word as neither', () => {
    expect(isSentenceEnd('plain')).toBe(false);
    expect(isClauseEnd('plain')).toBe(false);
  });
});

describe('breakQuality', () => {
  const at = (text: string, index: number, gapAfter?: Record<number, number>): number =>
    breakQuality(speak(text, gapAfter ? { gapAfter } : {}), index);

  it('scores a sentence end above a clause end above a plain word', () => {
    const sentence = at('one. two three', 0);
    const clause = at('one, two three', 0);
    const plain = at('one two three', 0);
    expect(sentence).toBeGreaterThan(clause);
    expect(clause).toBeGreaterThan(plain);
  });

  it('rewards a pause, in proportion to its length', () => {
    const short = at('one two three', 0, { 0: 0.1 });
    const long = at('one two three', 0, { 0: 0.5 });
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(at('one two three', 0));
  });

  it('saturates the pause bonus so a very long pause is not scored unboundedly', () => {
    expect(at('one two three', 0, { 0: 0.5 })).toBe(at('one two three', 0, { 0: 5 }));
  });

  it('rewards breaking before a word that starts a new clause', () => {
    expect(at('shipped it and broke', 1)).toBeGreaterThan(at('shipped it now broke', 1));
  });

  it('penalizes stranding an article or preposition at the end of a cue', () => {
    expect(at('went to the store', 2)).toBeLessThan(0);
    expect(at('went to the store', 1)).toBeLessThan(at('went now the store', 1));
  });

  it('does not penalize a trailing function word on the very last word', () => {
    // Nothing follows, so there is nothing to strand it from.
    const words = speak('this is the');
    expect(breakQuality(words, 2)).toBe(0);
  });

  it('scores a break with no following word purely on its own punctuation', () => {
    expect(breakQuality(speak('done.'), 0)).toBe(100);
  });
});

describe('splitIntoUtterances', () => {
  it('returns no runs for no words', () => {
    expect(splitIntoUtterances([], 0.5)).toEqual([]);
  });

  it('keeps continuous speech in one run', () => {
    const words = speak('one two three');
    expect(splitIntoUtterances(words, 0.5)).toEqual([words]);
  });

  it('splits where the gap reaches the threshold', () => {
    const words = speak('one two three four', { gapAfter: { 1: 0.8 } });
    const runs = splitIntoUtterances(words, 0.5);
    expect(runs.map((run) => run.map((w) => w.word))).toEqual([
      ['one', 'two'],
      ['three', 'four'],
    ]);
  });

  it('treats a gap exactly at the threshold as a split (inclusive)', () => {
    const words = speak('one two', { gapAfter: { 0: 0.5 } });
    expect(splitIntoUtterances(words, 0.5)).toHaveLength(2);
  });

  it('does not split on a gap below the threshold', () => {
    const words = speak('one two', { gapAfter: { 0: 0.49 } });
    expect(splitIntoUtterances(words, 0.5)).toHaveLength(1);
  });

  it('splits at a sentence end even with no pause at all', () => {
    // One sentence per cue is a hard rule, not a preference — see the WHY on
    // splitIntoUtterances. Without it, two sentences that both fit a cue tie on
    // linguistic score and cue fullness silently decides between them.
    const words = speak('all done. next up');
    expect(splitIntoUtterances(words, 0.5).map((run) => run.map((w) => w.word))).toEqual([
      ['all', 'done.'],
      ['next', 'up'],
    ]);
  });

  it('does not split after an abbreviation', () => {
    const words = speak('ask Dr. Smith today');
    expect(splitIntoUtterances(words, 0.5)).toHaveLength(1);
  });

  it('gives each of a run of short sentences its own utterance', () => {
    const words = speak('no. yes. maybe.');
    expect(splitIntoUtterances(words, 0.5).map((run) => run.map((w) => w.word))).toEqual([
      ['no.'],
      ['yes.'],
      ['maybe.'],
    ]);
  });
});

describe('packSegment', () => {
  it('respects the word cap', () => {
    const config = captionSegmentConfig('subtitle', { maxWordsPerCue: 2, maxCharsPerLine: 200 });
    const cues = packSegment(speak('one two three four five'), config);
    expect(cues.every((cue) => cue.length <= 2)).toBe(true);
    expect(cues.flatMap((cue) => cue.map((w) => w.word))).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  it('respects the character cap', () => {
    const config = captionSegmentConfig('subtitle', { maxCharsPerLine: 9, maxLines: 1 });
    const cues = packSegment(speak('alpha bravo charlie'), config);
    // "alpha" + " " + "bravo" is 11 chars — over the 9-char capacity.
    expect(cues.map((cue) => cue.map((w) => w.word).join(' '))).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  it('respects the duration cap even mid-sentence', () => {
    const config = captionSegmentConfig('subtitle', { maxCueSeconds: 0.7, maxCharsPerLine: 200 });
    const cues = packSegment(speak('one two three four', { wordSeconds: 0.3 }), config);
    expect(cues.every((cue) => cue[cue.length - 1]!.end - cue[0]!.start <= 0.7)).toBe(true);
  });

  it('emits a single over-long word rather than dropping speech', () => {
    // A word longer than the whole capacity must still be captioned.
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 3, maxLines: 1 });
    const cues = packSegment(speak('extraordinarily long'), config);
    expect(cues.map((cue) => cue.map((w) => w.word))).toEqual([['extraordinarily'], ['long']]);
  });

  it('breaks at a sentence end in preference to filling the cue', () => {
    const config = captionSegmentConfig('subtitle', { maxWordsPerCue: 6, maxCharsPerLine: 200 });
    const cues = packSegment(speak('stop. keep going for now'), config);
    expect(cues[0]!.map((w) => w.word)).toEqual(['stop.']);
  });

  it('breaks at a comma in preference to filling the cue', () => {
    const config = captionSegmentConfig('subtitle', { maxWordsPerCue: 6, maxCharsPerLine: 200 });
    const cues = packSegment(speak('it broke, then we fixed'), config);
    expect(cues[0]!.map((w) => w.word)).toEqual(['it', 'broke,']);
  });

  it('avoids ending a cue on an article', () => {
    const config = captionSegmentConfig('subtitle', { maxWordsPerCue: 3, maxCharsPerLine: 200 });
    const cues = packSegment(speak('I went to the store today'), config);
    for (const cue of cues) {
      expect(cue[cue.length - 1]!.word).not.toBe('the');
      expect(cue[cue.length - 1]!.word).not.toBe('to');
    }
  });

  it('always advances when only one word can fit (no infinite loop)', () => {
    const config = captionSegmentConfig('one-word');
    const cues = packSegment(speak('one two three'), config);
    expect(cues.map((cue) => cue.length)).toEqual([1, 1, 1]);
  });

  it('covers every input word exactly once, in order', () => {
    const config = captionSegmentConfig('short-form');
    const words = speak('the quick brown fox jumps over the lazy dog again and again');
    const cues = packSegment(words, config);
    expect(cues.flatMap((cue) => [...cue])).toEqual(words);
  });
});

describe('enforceReadingSpeed', () => {
  const config = captionSegmentConfig('subtitle', { maxCharsPerSecond: 10 });

  it('leaves a readable cue alone', () => {
    const cue = speak('slow words here', { wordSeconds: 2 });
    expect(enforceReadingSpeed([cue], config)).toEqual([cue]);
  });

  it('splits a cue that arrives faster than it can be read', () => {
    // Dense, but spoken slowly enough that the first half still clears
    // `minCueSeconds` once the second half caps it — so the split is worth
    // taking and the density limit is enforced.
    const cue = speak('these words arrive far too fast', { wordSeconds: 0.4 });
    const result = enforceReadingSpeed([cue], config);
    expect(result.length).toBeGreaterThan(1);
    expect(result.flatMap((c) => [...c])).toEqual(cue);
  });

  it('keeps a dense cue whole when splitting would leave an unreadable first half', () => {
    // Six words in 0.3s. Halving gives the FIRST half 0.15s on screen — its
    // ceiling is the second half's first word, so `enforceTiming` can never
    // extend it — which is worse than the dense cue it replaced. Splitting on
    // regardless is what shattered a real transcript into 10ms flashes and, once
    // snapped to the frame grid, into zero-length operations (run 7d159862).
    const cue = speak('these words arrive far too fast', { wordSeconds: 0.05 });
    expect(enforceReadingSpeed([cue], config)).toEqual([cue]);
  });

  it('never emits a cue whose words span less than the minimum, however dense', () => {
    // The invariant the caption patch depends on: every multi-word cue this
    // stage emits has enough room to be held. Single words are unsplittable and
    // are the one documented exception.
    const cue = speak('one two three four five six seven eight', { wordSeconds: 0.02 });
    for (const emitted of enforceReadingSpeed([cue], config)) {
      const spanned = emitted[emitted.length - 1]!.end - emitted[0]!.start;
      expect(emitted.length === 1 || spanned > 0).toBe(true);
    }
  });

  it('never splits a single word, however dense', () => {
    const cue = speak('incomprehensiblyquick', { wordSeconds: 0.01 });
    expect(enforceReadingSpeed([cue], config)).toEqual([cue]);
  });

  it('splits repeatedly until every remaining cue is readable or unsplittable', () => {
    const cue = speak('one two three four five six seven eight', { wordSeconds: 0.4 });
    const result = enforceReadingSpeed([cue], config);
    expect(result.length).toBeGreaterThan(1);
    expect(result.flatMap((c) => [...c])).toEqual(cue);

    // The stage's real contract, stated exactly: a cue is emitted once it is
    // within the density ceiling, or is a single word, or has no internal break
    // that would leave the first half holdable for `minCueSeconds`. The third
    // arm is the one that matters — density is a target the segmenter pursues
    // only while pursuing it does not produce a cue too brief to read.
    for (const c of result) {
      const duration = c[c.length - 1]!.end - c[0]!.start;
      const density = c.map((w) => w.word).join(' ').length / duration;
      const hasHoldableBreak = c
        .slice(1)
        .some((word) => word.start - c[0]!.start >= config.minCueSeconds);
      expect(c.length === 1 || density <= config.maxCharsPerSecond || !hasHoldableBreak).toBe(true);
    }
  });

  it('treats a zero-duration cue as readable rather than dividing by zero', () => {
    const cue: TranscriptWord[] = [
      { word: 'a', start: 1, end: 1 },
      { word: 'b', start: 1, end: 1 },
    ];
    expect(enforceReadingSpeed([cue], config)).toEqual([cue]);
  });

  it('prefers a syntactic seam when it has to split', () => {
    // Deliberately uneven: the first clause is spoken slowly (so it is readable
    // once separated) and the rest is rattled off. The split must land on the
    // comma, not at the arithmetic midpoint.
    const cue: TranscriptWord[] = [
      { word: 'it', start: 0, end: 0.6 },
      { word: 'broke,', start: 0.6, end: 1.2 },
      { word: 'we', start: 1.2, end: 1.25 },
      { word: 'fixed', start: 1.25, end: 1.3 },
      { word: 'it', start: 1.3, end: 1.35 },
      { word: 'fast', start: 1.35, end: 1.4 },
    ];
    const result = enforceReadingSpeed([cue], config);
    expect(result[0]!.map((w) => w.word)).toEqual(['it', 'broke,']);
  });
});

describe('coalesceSubFrameCues', () => {
  const config = captionSegmentConfig('short-form');

  it('merges two cues that would begin on the same project frame', () => {
    // The exact shape that broke run 7d159862: a 0.02s ASR artifact whose cue
    // both starts and ends inside frame 542 at 30fps.
    const words: TranscriptWord[] = [
      { word: 'build', start: 18.06, end: 18.08 },
      { word: "India's", start: 18.08, end: 18.58 },
    ];
    const cues = segmentCaptions(words, config, 30);
    expect(cues).toHaveLength(1);
    expect(flat(cues[0]!.text)).toBe("build India's");
  });

  it('leaves cues that start on distinct frames alone', () => {
    const words = speak('one two three four', { wordSeconds: 0.6 });
    expect(segmentCaptions(words, config, 30).length).toBe(segmentCaptions(words, config).length);
  });

  it('emits no cue that quantises to zero length, at any project frame rate', () => {
    // Sub-frame words at every rate the grid supports. Each emitted cue must
    // still occupy at least one frame once snapped, or the operation contract
    // rejects it — and rejects the whole patch with it.
    const words: TranscriptWord[] = [
      { word: 'To', start: 18.0, end: 18.01 },
      { word: 'build', start: 18.06, end: 18.08 },
      { word: "India's", start: 18.08, end: 18.58 },
      { word: 'top', start: 18.58, end: 18.79 },
      { word: 'We', start: 18.79, end: 18.8 },
    ];
    for (const fps of [24, 25, 29.97, 30, 50, 60]) {
      for (const preset of ['short-form', 'subtitle', 'one-word'] as const) {
        for (const cue of segmentCaptions(words, captionSegmentConfig(preset), fps)) {
          const frames = secondsToFrame(cue.end, fps) - secondsToFrame(cue.start, fps);
          expect(frames).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('layoutLines', () => {
  it('never breaks a single-line configuration', () => {
    const config = captionSegmentConfig('one-word', { maxCharsPerLine: 3 });
    expect(layoutLines(speak('alpha bravo'), config)).toBe('alpha bravo');
  });

  it('never breaks a one-word cue', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 2 });
    expect(layoutLines(speak('alpha'), config)).toBe('alpha');
  });

  it('leaves text that fits on one line unbroken', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 40 });
    expect(layoutLines(speak('short enough'), config)).toBe('short enough');
  });

  it('breaks into two lines when the text exceeds one', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 12, maxLines: 2 });
    const text = layoutLines(speak('alpha bravo charlie'), config);
    expect(text.split('\n')).toHaveLength(2);
    expect(flat(text)).toBe('alpha bravo charlie');
  });

  it('prefers a sentence-end break point', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 14, maxLines: 2 });
    expect(layoutLines(speak('all done. next up'), config)).toBe('all done.\nnext up');
  });

  it('does not end the first line on an article when a clean break exists', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 18, maxLines: 2 });
    const first = layoutLines(speak('we shipped the new build today'), config).split('\n')[0]!;
    // Breaking after "the" would balance the lines better; not ending a line on
    // an article outranks tidy balance (LAYOUT_BALANCE_WEIGHT < DANGLING_WORD_PENALTY).
    expect(first.endsWith('the')).toBe(false);
  });

  it('takes the least-bad break when every legal split ends on a function word', () => {
    // "I went to the big store" at 14 chars/line can only split 9/13 or 13/9,
    // and both end on a function word. It must still emit something legal
    // rather than overflowing the line.
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 14, maxLines: 2 });
    const lines = layoutLines(speak('I went to the big store'), config).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length <= 14)).toBe(true);
  });

  it('scores both a lone anchor word and a multi-word anchor span', () => {
    // "breakthrough" anchors the break candidate ending exactly on it (span of
    // one word) as well as a later candidate ending on its second occurrence
    // (a multi-word span) — exercising both emphasis break weights.
    const config = captionSegmentConfig('short-form', {
      maxCharsPerLine: 20,
      maxLines: 2,
      emphasisWords: ['breakthrough'],
    });
    const text = layoutLines(speak('breakthrough day one breakthrough moment truly here'), config);
    expect(flat(text)).toBe('breakthrough day one breakthrough moment truly here');
  });

  it('prefers the shorter line first (bottom-heavy)', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 16, maxLines: 2 });
    const [first, second] = layoutLines(speak('one two three four five'), config).split('\n');
    expect(second!.length).toBeGreaterThanOrEqual(first!.length);
  });

  it('still renders text too long for its lines rather than dropping it', () => {
    const config = captionSegmentConfig('short-form', { maxCharsPerLine: 4, maxLines: 2 });
    const text = layoutLines(speak('alpha bravo charlie delta'), config);
    expect(flat(text)).toBe('alpha bravo charlie delta');
  });
});

describe('enforceTiming', () => {
  const config = captionSegmentConfig('short-form', {
    minCueSeconds: 1,
    bridgeGapSeconds: 0.3,
  });

  it('holds a short cue for the minimum duration', () => {
    const timed = enforceTiming([speak('hi', { wordSeconds: 0.2 })], config);
    expect(timed[0]!.start).toBe(0);
    expect(timed[0]!.end).toBe(1);
  });

  it('bridges a gap small enough not to be worth blinking for', () => {
    const first = speak('one', { wordSeconds: 0.4 });
    const second: TranscriptWord[] = [{ word: 'two', start: 0.6, end: 1.0 }];
    const timed = enforceTiming([first, second], config);
    // The 0.2s gap is absorbed: the first cue runs right up to the second.
    expect(timed[0]!.end).toBe(0.6);
  });

  it('does not bridge a genuine pause', () => {
    const first = speak('one', { wordSeconds: 0.4 });
    const second: TranscriptWord[] = [{ word: 'two', start: 3, end: 3.4 }];
    const timed = enforceTiming([first, second], config);
    // Held for the minimum, not stretched across the silence.
    expect(timed[0]!.end).toBe(1);
  });

  it('never overlaps the next cue, even to reach the minimum duration', () => {
    const first = speak('one', { wordSeconds: 0.2 });
    const second: TranscriptWord[] = [{ word: 'two', start: 0.55, end: 1 }];
    const timed = enforceTiming([first, second], config);
    expect(timed[0]!.end).toBeLessThanOrEqual(timed[1]!.start);
  });

  it('never ends a cue before its words finish', () => {
    const long = speak('a very long spoken phrase', { wordSeconds: 1 });
    const timed = enforceTiming([long], captionSegmentConfig('short-form', { minCueSeconds: 0.1 }));
    expect(timed[0]!.end).toBe(long[long.length - 1]!.end);
  });

  it('gives the final cue a finite end', () => {
    const timed = enforceTiming([speak('last', { wordSeconds: 0.2 })], config);
    expect(Number.isFinite(timed[0]!.end)).toBe(true);
  });
});

describe('segmentCaptions', () => {
  it('yields no cues for an empty transcript', () => {
    expect(segmentCaptions([])).toEqual([]);
  });

  it('yields no cues when every word has zero duration', () => {
    expect(segmentCaptions([{ word: 'ghost', start: 1, end: 1 }])).toEqual([]);
  });

  it('drops zero-duration words but keeps the rest', () => {
    const cues = segmentCaptions([
      { word: 'real', start: 0, end: 0.4 },
      { word: 'ghost', start: 0.4, end: 0.4 },
      { word: 'words', start: 0.5, end: 0.9 },
    ]);
    expect(cues.flatMap((cue) => cue.words.map((w) => w.word))).toEqual(['real', 'words']);
  });

  it('is deterministic — the same input always gives the same cues', () => {
    const words = speak('the quick brown fox jumps over the lazy dog');
    expect(segmentCaptions(words)).toEqual(segmentCaptions(words));
  });

  it('preserves every transcript word exactly once, in order', () => {
    const words = speak('so I shipped it on a Friday. that was a mistake, honestly.');
    const cues = segmentCaptions(words);
    expect(cues.flatMap((cue) => [...cue.words])).toEqual(words);
  });

  it('produces cue text that matches its words (modulo layout breaks)', () => {
    const words = speak('the build broke, the tests were red, and nobody was around');
    for (const cue of segmentCaptions(words)) {
      expect(flat(cue.text)).toBe(cue.words.map((w) => w.word).join(' '));
    }
  });

  it('produces non-overlapping cues in time order', () => {
    const words = speak('one two three four five six seven eight nine ten');
    const cues = segmentCaptions(words);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
    }
  });

  it('starts each cue on its first spoken word', () => {
    const words = speak('alpha bravo charlie delta echo foxtrot');
    for (const cue of segmentCaptions(words)) {
      expect(cue.start).toBe(cue.words[0]!.start);
    }
  });

  it('never ends a cue before its last word is spoken', () => {
    const words = speak('alpha bravo charlie delta echo foxtrot');
    for (const cue of segmentCaptions(words)) {
      expect(cue.end).toBeGreaterThanOrEqual(cue.words[cue.words.length - 1]!.end);
    }
  });

  it('breaks at sentence boundaries in real speech', () => {
    // 0.4s/word keeps all three sentences inside the subtitle reading-speed
    // budget, so sentence structure is the only thing deciding the breaks.
    const words = speak('I shipped it on a Friday. that was a mistake. never again.', {
      wordSeconds: 0.4,
    });
    const texts = segmentCaptions(words, captionSegmentConfig('subtitle')).map((c) => flat(c.text));
    expect(texts).toEqual(['I shipped it on a Friday.', 'that was a mistake.', 'never again.']);
  });

  it('holds a dense short sentence rather than splitting it into flashes', () => {
    // "never again." is 12 characters spoken in 0.6s — 20 cps, over the 17 cps
    // broadcast norm. Splitting is the wrong remedy: the halves abut, so "never"
    // would be capped at 0.3s on screen and read FASTER than the cue it
    // replaced. Held whole for the 0.8s minimum instead, the same 12 characters
    // arrive at 15 cps — under the ceiling. Reading speed is a ceiling, and
    // holding is how this pipeline gets under it.
    const words = speak('never again.', { wordSeconds: 0.3 });
    const cues = segmentCaptions(words, captionSegmentConfig('subtitle'));
    expect(cues.map((c) => c.text)).toEqual(['never again.']);
    const [only] = cues;
    expect(only!.end - only!.start).toBeCloseTo(0.8, 5);
  });

  it('splits across a genuine pause even mid-sentence', () => {
    const words = speak('one two three four', { gapAfter: { 1: 1.5 } });
    const cues = segmentCaptions(words, captionSegmentConfig('subtitle'));
    expect(cues.map((c) => flat(c.text))).toEqual(['one two', 'three four']);
  });

  it('gives the one-word preset exactly one word per cue', () => {
    const words = speak('every word stands alone here');
    const cues = segmentCaptions(words, captionSegmentConfig('one-word'));
    expect(cues.map((c) => c.text)).toEqual(['every', 'word', 'stands', 'alone', 'here']);
  });

  it('keeps short-form cues within their line budget', () => {
    const config = captionSegmentConfig('short-form');
    const words = speak('the quick brown fox jumped over the extremely lazy sleeping dog');
    for (const cue of segmentCaptions(words, config)) {
      expect(cue.words.length).toBeLessThanOrEqual(config.maxWordsPerCue);
      expect(cue.text.split('\n').length).toBeLessThanOrEqual(config.maxLines);
    }
  });

  it('applies emphasis-aware break scoring when emphasis words are configured', () => {
    const words = speak('the quick brown breakthrough moment changes everything here today', {
      wordSeconds: 0.3,
    });
    const config = captionSegmentConfig('short-form', { emphasisWords: ['breakthrough'] });
    const cues = segmentCaptions(words, config);
    expect(cues.flatMap((cue) => cue.words.map((w) => w.word))).toEqual(words.map((w) => w.word));
  });

  it('honours the minimum hold even for a single clipped word', () => {
    const config = captionSegmentConfig('short-form', { minCueSeconds: 1.2 });
    const cues = segmentCaptions([{ word: 'go', start: 0, end: 0.15 }], config);
    expect(cues[0]!.end - cues[0]!.start).toBeCloseTo(1.2, 5);
  });
});
