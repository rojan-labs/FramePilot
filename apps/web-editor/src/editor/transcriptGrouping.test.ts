/**
 * Tests for transcript→footage grouping (the Transcription panel's data layer).
 *
 * The contract that matters: runs follow the EDIT (contiguous, in timeline order,
 * never merged across a return to earlier footage), flat indices survive so the
 * active-word highlight still lines up, and words with no clip under them land in
 * an honest `null` group instead of being attributed to a neighbour.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { groupTranscriptByAsset, transcriptText } from './transcriptGrouping.js';

const clip = (
  id: string,
  assetId: string,
  start: number,
  end: number,
): Timeline['tracks'][number]['clips'][number] => ({
  id,
  assetId,
  trackId: 'v',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

/** A → B → A, with a gap at [6,7): three runs plus one orphan run. */
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [clip('c1', 'a', 0, 3), clip('c2', 'b', 3, 6), clip('c3', 'a', 7, 10)],
    },
  ],
};

const word = (text: string, start: number): TranscriptWord => ({
  word: text,
  start,
  end: start + 0.4,
});

describe('groupTranscriptByAsset', () => {
  it('cuts the flat transcript into contiguous per-asset runs in timeline order', () => {
    const transcript = [word('one', 0.5), word('two', 1.5), word('three', 4), word('four', 8)];
    const groups = groupTranscriptByAsset(transcript, timeline);
    expect(groups.map((g) => g.assetId)).toEqual(['a', 'b', 'a']);
    expect(groups[0]?.words.map((w) => w.word.word)).toEqual(['one', 'two']);
    // Flat indices are preserved so `activeWordIndex` over the whole transcript matches.
    expect(groups[2]?.words[0]?.index).toBe(3);
    expect(groups[0]?.start).toBe(0.5);
    expect(groups[0]?.end).toBeCloseTo(1.9);
  });

  it('puts words with no clip under them in a null group rather than guessing', () => {
    const groups = groupTranscriptByAsset([word('gap', 6.5)], timeline);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.assetId).toBeNull();
  });

  it('returns no groups for an empty transcript', () => {
    expect(groupTranscriptByAsset([], timeline)).toEqual([]);
  });

  it('joins a run back into plain text for copying', () => {
    const groups = groupTranscriptByAsset([word('hello', 0.5), word('there', 1)], timeline);
    expect(transcriptText(groups[0]!.words)).toBe('hello there');
  });
});
