import { describe, expect, it } from 'vitest';
import type { Clip, Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { SNIPPET_CONTEXT_WORDS, searchTranscript } from './transcriptSearch.js';

const sampleClip: Clip = {
  id: 'c',
  assetId: 'a',
  trackId: 't',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
};

/** Build a transcript where each word is 1s long, starting at `word * 1s`. */
function makeTranscript(words: readonly string[]): readonly TranscriptWord[] {
  return words.map((word, index) => ({ word, start: index, end: index + 1 }));
}

describe('searchTranscript', () => {
  const transcript = makeTranscript([
    'Welcome',
    'to',
    'the',
    'category',
    'of',
    'cats,',
    'and',
    'thank',
    'you',
    'for',
    'watching.',
  ]);

  it('matches whole words only, case-insensitively, not substrings', () => {
    const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [sampleClip] }] };
    // "cat" must not fire on "category" — whole-word match avoids that noise.
    expect(searchTranscript(transcript, timeline, 'cat')).toEqual([]);
    // "cats" (punctuation-stripped) matches, case-insensitively.
    const hits = searchTranscript(transcript, timeline, 'CATS');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchText).toBe('cats,');
    expect(hits[0]?.start).toBe(5);
  });

  it('matches a multi-word phrase across contiguous words', () => {
    const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [sampleClip] }] };
    const hits = searchTranscript(transcript, timeline, 'thank you');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchText).toBe('thank you');
    expect(hits[0]?.start).toBe(7);
    expect(hits[0]?.end).toBe(9);
  });

  it('builds a keyword-in-context snippet with words on both sides', () => {
    const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [sampleClip] }] };
    const hits = searchTranscript(transcript, timeline, 'of');
    expect(hits[0]?.snippet.split(' ').length).toBeLessThanOrEqual(SNIPPET_CONTEXT_WORDS * 2 + 1);
    expect(hits[0]?.snippet).toContain('category');
    expect(hits[0]?.snippet).toContain('cats,');
  });

  it('maps a match back to the clip/asset occupying that timeline moment', () => {
    const clipA: Clip = { ...sampleClip, id: 'a-clip', assetId: 'asset-a', start: 0, end: 5 };
    const clipB: Clip = {
      ...sampleClip,
      id: 'b-clip',
      assetId: 'asset-b',
      start: 5,
      end: 11,
      sourceStart: 0,
      sourceEnd: 6,
    };
    const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [clipA, clipB] }] };
    // "thank" starts at t=7, inside clipB's [5, 11) range.
    const hits = searchTranscript(transcript, timeline, 'thank');
    expect(hits[0]?.assetId).toBe('asset-b');
    expect(hits[0]?.clipId).toBe('b-clip');
  });

  it('returns null asset/clip when no clip occupies that time (stale transcript)', () => {
    const timeline: Timeline = { tracks: [{ id: 't', type: 'video', clips: [] }] };
    const hits = searchTranscript(transcript, timeline, 'watching');
    expect(hits[0]?.assetId).toBeNull();
    expect(hits[0]?.clipId).toBeNull();
  });

  it('returns no matches for an empty query or empty transcript', () => {
    const timeline: Timeline = { tracks: [] };
    expect(searchTranscript(transcript, timeline, '   ')).toEqual([]);
    expect(searchTranscript([], timeline, 'thank')).toEqual([]);
  });
});
