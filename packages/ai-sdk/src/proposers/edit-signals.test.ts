/**
 * @framepilot/ai-sdk/proposers/edit-signals.test
 *
 * This module used to decide editorial moves — seven rules mapping a signal to a move and a
 * hand-tuned score — and its tests asserted those verdicts ("a chapter whose title reads as a
 * reveal earns a punch-in at 0.7"). The authority moved to the agent, so the tests move with
 * it: what is pinned now is that every signal is DESCRIBED, in time order, with its provenance,
 * and that no verdict, ranking or recommendation survives anywhere in the payload.
 */
import { describe, expect, it } from 'vitest';
import { readEditSignals, type EditSignalInput } from './edit-signals.js';

describe('readEditSignals', () => {
  it('returns nothing for empty input (never fabricates a span)', () => {
    expect(readEditSignals({})).toEqual([]);
  });

  it('never emits a move, a score, or a rationale', () => {
    // The captured run received five candidates whose entire reasoning was the same constant
    // string — "salient highlight — a push-in makes it land" — scored 1.45 down to 1.30. No
    // rule can express a choice its author did not anticipate, and a score that looks like
    // evidence invites the model to stop judging.
    const signals = readEditSignals({
      chapters: [{ t0: 0, t1: 120, title: 'The big reveal', summary: 'talking to camera' }],
      highlights: [{ t0: 10, t1: 20, label: 'the fall', score: 0.95 }],
      silences: [{ start: 30, end: 34 }],
      sceneCuts: [50],
      transcript: [{ word: 'HUGE', start: 60, end: 60.4 }],
    });
    const serialized = JSON.stringify(signals);
    for (const verdict of ['punch_in', 'reframe', 'broll', 'speed', '"score"', 'makes it land']) {
      expect(serialized).not.toContain(verdict);
    }
    for (const signal of signals) {
      expect(Object.keys(signal).sort()).toEqual(['from', 'kind', 'observation', 't0', 't1']);
    }
  });

  it('reports every signal in TIME order, not by rank', () => {
    const signals = readEditSignals({
      highlights: [
        { t0: 40, t1: 45, label: 'late', score: 0.99 },
        { t0: 5, t1: 6, label: 'early', score: 0.1 },
      ],
      silences: [{ start: 20, end: 22 }],
    });
    expect(signals.map((s) => s.t0)).toEqual([5, 20, 40]);
    // The strongest highlight is NOT hoisted: ranking is the judgement this module dropped.
    expect(signals.at(-1)?.observation).toContain('late');
  });

  describe('highlights', () => {
    it('states the label, the length, and the supplied salience', () => {
      const [signal] = readEditSignals({
        highlights: [{ t0: 5, t1: 8, label: 'big laugh', score: 0.9 }],
      });
      expect(signal).toMatchObject({ kind: 'highlight', t0: 5, t1: 8, from: 'supplied' });
      expect(signal?.observation).toContain('big laugh');
      expect(signal?.observation).toContain('3.0s long');
      // "as supplied" is the point: the number is the caller's, not this module's judgement.
      expect(signal?.observation).toContain('salience 0.9 as supplied');
    });

    it('says nothing about salience when none was supplied', () => {
      const [signal] = readEditSignals({ highlights: [{ t0: 0, t1: 1, label: 'x' }] });
      expect(signal?.observation).not.toContain('salience');
    });
  });

  describe('chapters', () => {
    it('describes a chapter by its SHAPE, not by reading its title', () => {
      // The old rule ran a reveal-word regex over the title and emitted a punch-in. Duration,
      // highlights inside and words spoken are what that regex stood in for, and the agent can
      // read them itself — including for a title no regex would have matched.
      const input: EditSignalInput = {
        chapters: [{ t0: 0, t1: 95, title: 'Down the slope', summary: 'the descent' }],
        highlights: [
          { t0: 10, t1: 12, label: 'a', score: 0.5 },
          { t0: 80, t1: 81, label: 'b', score: 0.5 },
          { t0: 200, t1: 201, label: 'outside', score: 0.5 },
        ],
        transcript: [
          { word: 'one', start: 5, end: 5.3 },
          { word: 'two', start: 6, end: 6.3 },
          { word: 'elsewhere', start: 300, end: 300.4 },
        ],
      };
      const chapter = readEditSignals(input).find((signal) => signal.kind === 'chapter');
      expect(chapter?.observation).toContain('95.0s long');
      expect(chapter?.observation).toContain('2 highlight(s) inside');
      expect(chapter?.observation).toContain('2 transcript word(s)');
      expect(chapter?.observation).toContain('the descent');
    });

    it('reports a chapter with nothing in it just the same', () => {
      // A long chapter with no highlight used to become a `speed` ramp candidate at 0.5. Now
      // it is reported as what it is, and what to do about it is open.
      const chapter = readEditSignals({
        chapters: [{ t0: 0, t1: 200, title: 'Empty stretch' }],
      })[0];
      expect(chapter?.observation).toContain('0 highlight(s) inside');
      expect(chapter?.observation).toContain('0 transcript word(s)');
    });
  });

  describe('silence', () => {
    it('reports a silence long enough to notice', () => {
      const [signal] = readEditSignals({ silences: [{ start: 2, end: 3.5 }] });
      expect(signal).toMatchObject({ kind: 'silence', t0: 2, t1: 3.5 });
      expect(signal?.observation).toBe('1.5s of silence');
    });

    it('skips a gap short enough to be a breath', () => {
      expect(readEditSignals({ silences: [{ start: 2, end: 2.5 }] })).toEqual([]);
    });
  });

  describe('scene changes and emphasis', () => {
    it('reports each detected scene cut as a point where the picture changes', () => {
      const [signal] = readEditSignals({ sceneCuts: [12] });
      expect(signal).toMatchObject({ kind: 'scene_change', t0: 12, from: 'supplied' });
      expect(signal?.t1).toBeGreaterThan(12);
    });

    it('measures spoken emphasis from the project, and says so', () => {
      const signals = readEditSignals({
        transcript: [
          { word: 'HUGE', start: 1, end: 1.4 },
          { word: 'ordinary', start: 2, end: 2.4 },
          { word: 'wow!', start: 3, end: 3.4 },
          { word: 'sooo', start: 4, end: 4.4 },
        ],
      });
      expect(signals.map((s) => s.observation)).toEqual([
        'spoken emphasis: "HUGE"',
        'spoken emphasis: "wow!"',
        'spoken emphasis: "sooo"',
      ]);
      // Not supplied by the caller — derived here from the project's own transcript.
      expect(signals.every((s) => s.from === 'measured here')).toBe(true);
    });
  });

  it('bounds a long recording to a readable set', () => {
    const many = readEditSignals({
      highlights: Array.from({ length: 200 }, (_, index) => ({
        t0: index,
        t1: index + 0.5,
        label: `h${String(index)}`,
      })),
    });
    expect(many.length).toBeLessThanOrEqual(60);
    // The bound keeps the EARLIEST spans, so the description still starts where the edit does.
    expect(many[0]?.observation).toContain('h0');
  });
});
