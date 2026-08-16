/**
 * @framepilot/ai-sdk/proposers/candidate-proposer.test — plan FI4.1.
 *
 * Exercises every heuristic branch of the pure `proposeCandidates` function: each
 * candidate kind's trigger and non-trigger case, the ordering/cap behavior, and the
 * empty-input honesty guarantee.
 */
import { describe, expect, it } from 'vitest';
import { proposeCandidates, type ProposerInput } from './candidate-proposer.js';

describe('proposeCandidates', () => {
  it('returns an empty list for empty input (never fabricates a move)', () => {
    expect(proposeCandidates({})).toEqual([]);
  });

  describe('dead-air cuts', () => {
    it('proposes a cut for a silence at/over the dead-air threshold', () => {
      const result = proposeCandidates({ silences: [{ start: 2, end: 3.5 }] });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'cut', t0: 2, t1: 3.5 });
      expect(result[0]!.cite).toContain('silence 2.0–3.5s');
      expect(result[0]!.why).toContain('dead air');
    });

    it('ignores a silence shorter than the dead-air threshold', () => {
      expect(proposeCandidates({ silences: [{ start: 2, end: 2.5 }] })).toEqual([]);
    });

    it('caps the dead-air score contribution for a very long silence', () => {
      const [short, long] = [
        proposeCandidates({ silences: [{ start: 0, end: 2 }] })[0]!,
        proposeCandidates({ silences: [{ start: 0, end: 20 }] })[0]!,
      ];
      expect(long.score).toBeGreaterThan(short.score);
    });
  });

  describe('highlight punch-ins', () => {
    it('proposes a punch-in for each highlight, citing its label', () => {
      const result = proposeCandidates({
        highlights: [{ t0: 5, t1: 8, label: 'big laugh', score: 0.9 }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'punch_in', t0: 5, t1: 8 });
      expect(result[0]!.cite).toContain('big laugh');
      expect(result[0]!.score).toBeCloseTo(1.4);
    });

    it('defaults the highlight score contribution when score is absent', () => {
      const result = proposeCandidates({ highlights: [{ t0: 0, t1: 1, label: 'x' }] });
      expect(result[0]!.score).toBeCloseTo(1.0);
    });
  });

  describe('chapter reveal punch-ins', () => {
    it('proposes a punch-in for a chapter whose title reads as a reveal', () => {
      const result = proposeCandidates({
        chapters: [{ t0: 10, t1: 15, title: 'The big reveal' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'punch_in' });
      expect(result[0]!.t1).toBeLessThanOrEqual(15);
    });

    it('proposes a punch-in when only the summary reads as a payoff', () => {
      const result = proposeCandidates({
        chapters: [{ t0: 0, t1: 5, title: 'Chapter one', summary: 'the payoff moment' }],
      });
      expect(result).toHaveLength(1);
    });

    it('ignores a chapter with no reveal/payoff language', () => {
      expect(
        proposeCandidates({ chapters: [{ t0: 0, t1: 5, title: 'Setup', summary: 'intro' }] }),
      ).toEqual([]);
    });
  });

  describe('spoken-emphasis punch-ins', () => {
    it('detects an ALL-CAPS word', () => {
      const result = proposeCandidates({
        transcript: [{ word: 'AMAZING', start: 10, end: 10.4 }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'punch_in' });
      expect(result[0]!.why).toContain('AMAZING');
    });

    it('detects an exclamation', () => {
      const result = proposeCandidates({ transcript: [{ word: 'wow!', start: 1, end: 1.3 }] });
      expect(result).toHaveLength(1);
    });

    it('detects an elongated spelling', () => {
      const result = proposeCandidates({ transcript: [{ word: 'sooo', start: 1, end: 1.5 }] });
      expect(result).toHaveLength(1);
    });

    it('clamps the punch-in start at 0 for emphasis near the very start', () => {
      const result = proposeCandidates({ transcript: [{ word: 'WOW', start: 0, end: 0.1 }] });
      expect(result[0]!.t0).toBe(0);
    });

    it('ignores an ordinary, unemphasized word', () => {
      expect(proposeCandidates({ transcript: [{ word: 'hello', start: 0, end: 0.5 }] })).toEqual(
        [],
      );
    });

    it('ignores a single-letter token', () => {
      expect(proposeCandidates({ transcript: [{ word: 'I', start: 0, end: 0.2 }] })).toEqual([]);
    });
  });

  describe('speed ramp over low-information stretches', () => {
    it('proposes a speed ramp for a long chapter with no overlapping highlight', () => {
      const result = proposeCandidates({ chapters: [{ t0: 0, t1: 25, title: 'Setup' }] });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'speed', t0: 0, t1: 25 });
    });

    it('skips a chapter shorter than the long-chapter threshold', () => {
      expect(proposeCandidates({ chapters: [{ t0: 0, t1: 10, title: 'Setup' }] })).toEqual([]);
    });

    it('skips a long chapter that overlaps a highlight', () => {
      const result = proposeCandidates({
        chapters: [{ t0: 0, t1: 25, title: 'Setup' }],
        highlights: [{ t0: 5, t1: 6, label: 'moment' }],
      });
      expect(result.some((c) => c.kind === 'speed')).toBe(false);
    });
  });

  describe('b-roll slots over sustained narration', () => {
    it('proposes a b-roll slot when the summary reads as narration', () => {
      const result = proposeCandidates({
        chapters: [{ t0: 0, t1: 9, title: 'Interview', summary: 'talking to camera' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'broll' });
    });

    it('proposes a b-roll slot for sustained dialogue with no narration wording, given enough words', () => {
      const transcript = Array.from({ length: 6 }, (_, i) => ({
        word: `word${i}`,
        start: i,
        end: i + 0.5,
      }));
      const result = proposeCandidates({
        chapters: [{ t0: 0, t1: 9, title: 'Chat' }],
        transcript,
      });
      expect(result.some((c) => c.kind === 'broll')).toBe(true);
    });

    it('skips a chapter shorter than the b-roll minimum', () => {
      expect(
        proposeCandidates({ chapters: [{ t0: 0, t1: 5, title: 'Interview', summary: 'talk' }] }),
      ).toEqual([]);
    });

    it('skips a long non-narration chapter with too little dialogue', () => {
      expect(proposeCandidates({ chapters: [{ t0: 0, t1: 9, title: 'B-roll only' }] })).toEqual([]);
    });
  });

  describe('reframe for a vertical target', () => {
    it('proposes a reframe per highlight only when verticalTarget is true', () => {
      const input: ProposerInput = {
        highlights: [{ t0: 1, t1: 2, label: 'h', score: 0.5 }],
        verticalTarget: true,
      };
      const result = proposeCandidates(input);
      expect(result.some((c) => c.kind === 'reframe')).toBe(true);
    });

    it('omits reframe candidates when verticalTarget is absent', () => {
      const result = proposeCandidates({ highlights: [{ t0: 1, t1: 2, label: 'h' }] });
      expect(result.some((c) => c.kind === 'reframe')).toBe(false);
    });

    it('defaults the reframe score contribution when the highlight has no score', () => {
      const result = proposeCandidates({
        highlights: [{ t0: 1, t1: 2, label: 'h' }],
        verticalTarget: true,
      });
      const reframe = result.find((c) => c.kind === 'reframe');
      expect(reframe!.score).toBeCloseTo(0.8);
    });
  });

  describe('ordering and cap', () => {
    it('orders candidates best-first by score, then by start time', () => {
      const result = proposeCandidates({
        silences: [{ start: 100, end: 101.5 }], // score ~1.3
        highlights: [{ t0: 0, t1: 1, label: 'h', score: 1 }], // score 1.5
      });
      expect(result[0]!.kind).toBe('punch_in');
      expect(result[1]!.kind).toBe('cut');
    });

    it('caps the result at 40 candidates', () => {
      const highlights = Array.from({ length: 60 }, (_, i) => ({
        t0: i,
        t1: i + 0.5,
        label: `h${i}`,
        score: 0.5,
      }));
      const result = proposeCandidates({ highlights });
      expect(result).toHaveLength(40);
    });
  });
});
