/**
 * Tests for caption cue resolution (ADR 0071).
 *
 * The headline case is the one that used to be broken three different ways: a
 * word straddling a cue boundary. Overlap is now the single rule, and there is a
 * test pinning it against the start-containment semantics `CaptionEditor` used.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import { alignCueWords, resolveCaptionCue, transcriptWordsInRange } from './cue.js';

const word = (w: string, start: number, end: number): TranscriptWord => ({ word: w, start, end });

describe('transcriptWordsInRange', () => {
  const transcript = [word('one', 0, 1), word('two', 1, 2), word('three', 2, 3)];

  it('returns the words audible during the range', () => {
    expect(transcriptWordsInRange(transcript, 0.5, 2.5).map((w) => w.word)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('includes a word that STARTS before the range but sounds inside it', () => {
    // The bug this closes: CaptionEditor used start-containment, so this word
    // was missing from the caption list but present in the export.
    expect(transcriptWordsInRange(transcript, 0.5, 0.9).map((w) => w.word)).toEqual(['one']);
  });

  it('includes a word that starts inside the range but continues past it', () => {
    expect(transcriptWordsInRange(transcript, 2.5, 2.8).map((w) => w.word)).toEqual(['three']);
  });

  it('excludes a word that merely abuts the range (end is exclusive)', () => {
    // `one` spans [0,1); a cue starting exactly at 1 does not contain it.
    expect(transcriptWordsInRange(transcript, 1, 2).map((w) => w.word)).toEqual(['two']);
  });

  it('returns nothing for a range with no speech', () => {
    expect(transcriptWordsInRange(transcript, 10, 12)).toEqual([]);
  });

  it('returns nothing for an empty transcript', () => {
    expect(transcriptWordsInRange([], 0, 5)).toEqual([]);
  });
});

describe('alignCueWords', () => {
  const fallback = { start: 0, end: 2 };

  it('aligns tokens to timings by position', () => {
    const lines = alignCueWords('we shipped it', [word('we', 0.1, 0.3), word('shipped', 0.3, 0.8), word('it', 0.8, 1)], fallback);
    expect(lines).toEqual([
      [word('we', 0.1, 0.3), word('shipped', 0.3, 0.8), word('it', 0.8, 1)],
    ]);
  });

  it('keeps the timing but takes the DISPLAY token, so an edit keeps its beat', () => {
    // The editor fixed a typo; the karaoke timing for that word must survive.
    const lines = alignCueWords('we received it', [
      word('we', 0.1, 0.3),
      word('recieve', 0.3, 0.8),
      word('it', 0.8, 1),
    ], fallback);
    expect(lines[0]![1]).toEqual(word('received', 0.3, 0.8));
  });

  it('groups tokens by explicit line break without consuming a timing', () => {
    const lines = alignCueWords('we shipped\nit today', [
      word('we', 0, 0.2),
      word('shipped', 0.2, 0.6),
      word('it', 0.6, 0.8),
      word('today', 0.8, 1.2),
    ], fallback);
    expect(lines.map((line) => line.map((w) => w.word))).toEqual([
      ['we', 'shipped'],
      ['it', 'today'],
    ]);
    // Timings did not shift across the break.
    expect(lines[1]![0]).toEqual(word('it', 0.6, 0.8));
  });

  it('times surplus tokens to the fallback range rather than dropping them', () => {
    const lines = alignCueWords('one two three', [word('one', 0, 0.5)], fallback);
    expect(lines[0]).toEqual([word('one', 0, 0.5), word('two', 0, 2), word('three', 0, 2)]);
  });

  it('times every token to the fallback when there are no timings at all', () => {
    // A hand-typed cue: no word timing, but it must still draw.
    const lines = alignCueWords('typed by hand', [], fallback);
    expect(lines[0]!.every((w) => w.start === 0 && w.end === 2)).toBe(true);
  });

  it('ignores surplus timings', () => {
    const lines = alignCueWords('one', [word('one', 0, 0.5), word('two', 0.5, 1)], fallback);
    expect(lines).toEqual([[word('one', 0, 0.5)]]);
  });

  it('collapses runs of whitespace and drops empty tokens', () => {
    const lines = alignCueWords('  one   two  ', [], fallback);
    expect(lines[0]!.map((w) => w.word)).toEqual(['one', 'two']);
  });

  it('yields an empty line for empty text', () => {
    expect(alignCueWords('', [], fallback)).toEqual([[]]);
  });
});

describe('resolveCaptionCue', () => {
  const transcript = [word('we', 0, 0.4), word('shipped', 0.4, 1), word('it', 1, 1.4)];

  it('uses the clip cue when present, and marks it authored', () => {
    const resolved = resolveCaptionCue(
      { start: 0, end: 2, captionCue: { text: 'something else', words: [] } },
      transcript,
    );
    expect(resolved.text).toBe('something else');
    expect(resolved.authored).toBe(true);
  });

  it('derives from the transcript by overlap when there is no cue', () => {
    const resolved = resolveCaptionCue({ start: 0, end: 1, captionCue: undefined }, transcript);
    expect(resolved.text).toBe('we shipped');
    expect(resolved.authored).toBe(false);
    expect(resolved.lines).toEqual([[word('we', 0, 0.4), word('shipped', 0.4, 1)]]);
  });

  it('honours a deliberately blanked cue instead of falling back', () => {
    // If an empty cue fell back to the transcript, clearing a caption would be
    // impossible — the text would reappear.
    const resolved = resolveCaptionCue(
      { start: 0, end: 2, captionCue: { text: '', words: [] } },
      transcript,
    );
    expect(resolved.text).toBe('');
    expect(resolved.lines).toEqual([[]]);
    expect(resolved.authored).toBe(true);
  });

  it('yields no lines when the derived range has no speech', () => {
    const resolved = resolveCaptionCue({ start: 10, end: 12, captionCue: undefined }, transcript);
    expect(resolved.text).toBe('');
    expect(resolved.lines).toEqual([]);
  });

  it('times an authored cue with no words to the clip range', () => {
    const resolved = resolveCaptionCue(
      { start: 3, end: 5, captionCue: { text: 'hand typed', words: [] } },
      transcript,
    );
    expect(resolved.lines[0]!.every((w) => w.start === 3 && w.end === 5)).toBe(true);
  });

  it('keeps a cue independent of the transcript — a re-run cannot change it', () => {
    const clip = {
      start: 0,
      end: 2,
      captionCue: { text: 'we shipped it', words: [...transcript] },
    };
    const before = resolveCaptionCue(clip, transcript);
    // Transcript replaced wholesale (a different ASR provider, say).
    const after = resolveCaptionCue(clip, [word('totally', 0, 1), word('different', 1, 2)]);
    expect(after).toEqual(before);
  });
});
