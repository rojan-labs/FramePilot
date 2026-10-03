import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import { autoEmphasisKeywords } from './emphasis.js';

const words = (tokens: readonly string[]): TranscriptWord[] =>
  tokens.map((word, index) => ({ word, start: index * 0.3, end: index * 0.3 + 0.22 }));

describe('autoEmphasisKeywords', () => {
  it('returns sparse meaningful anchors instead of function words', () => {
    const result = autoEmphasisKeywords(
      words(['this', 'is', 'the', 'biggest', 'mistake', 'you', 'must', 'avoid']),
      { density: 0.3, maxKeywords: 3 },
    );
    expect(result).toEqual(['biggest', 'mistake']);
  });

  it('uses delivery pauses and stretched words as emphasis evidence', () => {
    const transcript: TranscriptWord[] = [
      { word: 'ordinary', start: 0, end: 0.15 },
      { word: 'breakthrough', start: 0.6, end: 1.35 },
      { word: 'today', start: 1.7, end: 1.85 },
    ];
    expect(autoEmphasisKeywords(transcript, { maxKeywords: 1 })).toEqual(['breakthrough']);
  });

  it('is deterministic, punctuation-insensitive and bounded', () => {
    const transcript = words(['Viral!', 'ideas', 'viral', 'results', 'viral.']);
    const first = autoEmphasisKeywords(transcript, { density: 0.3, maxKeywords: 2 });
    expect(autoEmphasisKeywords(transcript, { density: 0.3, maxKeywords: 2 })).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(2);
    expect(first.filter((word) => word === 'viral')).toHaveLength(1);
  });

  it('returns no emphasis for empty or filler-only speech', () => {
    expect(autoEmphasisKeywords([])).toEqual([]);
    expect(autoEmphasisKeywords(words(['the', 'and', 'to']))).toEqual([]);
  });

  it('boosts numeric tokens as emphasis candidates', () => {
    const result = autoEmphasisKeywords(
      words(['we', 'shipped', '2024', 'results', 'today']),
      { density: 0.3, maxKeywords: 1 },
    );
    expect(result).toEqual(['2024']);
  });

  it('keeps Devanagari vowel signs, so the keyword is the word that was said', () => {
    // Run 001be135 stored "लफ" for "लूफी": the vowel signs are combining marks, and a
    // letters-only filter dropped them, leaving a keyword no cue contains.
    const transcript: TranscriptWord[] = [
      { word: 'अब', start: 0, end: 0.15 },
      { word: 'लूफी', start: 0.6, end: 1.4 },
      { word: 'यहाँ', start: 1.7, end: 1.85 },
    ];
    expect(autoEmphasisKeywords(transcript, { maxKeywords: 1 })).toEqual(['लूफी']);
  });

  it('folds a precomposed and a decomposed spelling into one keyword', () => {
    // U+0958 (क़) is a composition exclusion: NFKC writes it as क + nukta, the spelling an
    // ASR engine may emit directly. Two spellings of one word must not be two keywords.
    const precomposed = 'क़िला!';
    const decomposed = 'क़िला';
    const transcript: TranscriptWord[] = [
      { word: 'अब', start: 0, end: 0.15 },
      { word: precomposed, start: 0.6, end: 1.4 },
      { word: 'और', start: 1.7, end: 1.85 },
      { word: decomposed, start: 1.9, end: 2.1 },
    ];
    expect(autoEmphasisKeywords(transcript, { density: 0.3, maxKeywords: 3 })).toEqual([
      decomposed.normalize('NFKC'),
    ]);
  });

  it('penalizes low-confidence words so they lose to a confident anchor', () => {
    const transcript: TranscriptWord[] = [
      { word: 'mistake', start: 0, end: 0.3, confidence: 0.2 },
      { word: 'breakthrough', start: 0.3, end: 0.6, confidence: 0.95 },
    ];
    expect(autoEmphasisKeywords(transcript, { maxKeywords: 1 })).toEqual(['breakthrough']);
  });
});
