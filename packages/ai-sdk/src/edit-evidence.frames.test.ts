/**
 * Frame-safe evidence normalization — the guards and edges.
 *
 * Autonomous cutting must never reason over arbitrary floating-point boundaries: a cut
 * that lands 3ms inside a word clips the word, and no test of the happy path would show
 * it. Every function here either rounds conservatively or refuses, so these tests are
 * about the refusals and the rounding direction, not the arithmetic.
 */
import { describe, expect, it } from 'vitest';
import {
  cutSplitsWord,
  evidenceOverlappingRange,
  nearestSafeCutFrame,
  normalizeEditEvidence,
  normalizeEditObservation,
  safeCutWindowsBetweenWords,
  type FrameEditObservation,
  type TimedEditObservation,
} from './edit-evidence.js';

const FPS = 30;

const observation = (over: Partial<TimedEditObservation> = {}): TimedEditObservation => ({
  id: 'w1',
  kind: 'word',
  assetId: 'asset_1',
  startSeconds: 1,
  endSeconds: 2,
  ...over,
});

const word = (
  id: string,
  startFrame: number,
  endFrame: number,
  assetId = 'asset_1',
): FrameEditObservation => ({
  id,
  kind: 'word',
  assetId,
  startFrame,
  endFrame,
  startSeconds: startFrame / FPS,
  endSeconds: endFrame / FPS,
});

describe('normalizeEditObservation — refusing bad evidence rather than rounding it', () => {
  it.each([
    ['an empty id', { id: '  ' }, /id must not be empty/],
    ['an empty assetId', { assetId: '' }, /assetId must not be empty/],
    ['a negative start', { startSeconds: -1 }, /startSeconds must be finite/],
    ['a non-finite start', { startSeconds: Number.NaN }, /startSeconds must be finite/],
    ['an end before the start', { startSeconds: 2, endSeconds: 1 }, /endSeconds must be finite/],
    ['a zero-length range', { startSeconds: 1, endSeconds: 1 }, /endSeconds must be finite/],
    ['a non-finite end', { endSeconds: Number.POSITIVE_INFINITY }, /endSeconds must be finite/],
    ['confidence below 0', { confidence: -0.1 }, /confidence must be within/],
    ['confidence above 1', { confidence: 1.1 }, /confidence must be within/],
    ['non-finite confidence', { confidence: Number.NaN }, /confidence must be within/],
  ])('rejects %s', (_label, over, message) => {
    expect(() => normalizeEditObservation(observation(over), FPS)).toThrow(message);
  });

  it('accepts confidence at both ends of the legal range', () => {
    expect(normalizeEditObservation(observation({ confidence: 0 }), FPS).confidence).toBe(0);
    expect(normalizeEditObservation(observation({ confidence: 1 }), FPS).confidence).toBe(1);
  });

  it('floors the start and ceils the end, so a retained word is never clipped', () => {
    // The rounding direction IS the safety property: rounding the end down would cut
    // the tail off a word that the edit meant to keep.
    const normalized = normalizeEditObservation(
      observation({ startSeconds: 1.04, endSeconds: 1.99 }),
      FPS,
    );
    expect(normalized.startFrame).toBe(Math.floor(1.04 * FPS));
    expect(normalized.endFrame).toBe(Math.ceil(1.99 * FPS));
  });

  it('never produces a zero-length frame range from a sub-frame observation', () => {
    // A 1ms word still has to occupy a frame, or it would vanish from the evidence.
    const normalized = normalizeEditObservation(
      observation({ startSeconds: 1.0, endSeconds: 1.001 }),
      FPS,
    );
    expect(normalized.endFrame).toBeGreaterThan(normalized.startFrame);
  });

  it('derives canonical seconds from the frames, not from the input', () => {
    const normalized = normalizeEditObservation(
      observation({ startSeconds: 1.04, endSeconds: 1.99 }),
      FPS,
    );
    expect(normalized.startSeconds).toBeCloseTo(normalized.startFrame / FPS, 9);
    expect(normalized.endSeconds).toBeCloseTo(normalized.endFrame / FPS, 9);
  });

  it('omits optional fields entirely rather than carrying undefined', () => {
    const normalized = normalizeEditObservation(observation(), FPS);
    expect(normalized).not.toHaveProperty('text');
    expect(normalized).not.toHaveProperty('label');
    expect(normalized).not.toHaveProperty('confidence');
  });

  it('carries text and label through when present', () => {
    const normalized = normalizeEditObservation(
      observation({ text: 'hello', label: 'speech' }),
      FPS,
    );
    expect(normalized).toMatchObject({ text: 'hello', label: 'speech' });
  });
});

describe('normalizeEditEvidence', () => {
  it('rejects a duplicate id — two observations sharing one id are unresolvable', () => {
    expect(() =>
      normalizeEditEvidence([observation({ id: 'x' }), observation({ id: 'x' })], FPS),
    ).toThrow(/Duplicate evidence id "x"/);
  });

  it('sorts by start, then end, then id, so the order is total and stable', () => {
    const sorted = normalizeEditEvidence(
      [
        observation({ id: 'b', startSeconds: 1, endSeconds: 2 }),
        observation({ id: 'a', startSeconds: 1, endSeconds: 2 }),
        observation({ id: 'c', startSeconds: 0, endSeconds: 1 }),
      ],
      FPS,
    );
    expect(sorted.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('handles an empty list', () => {
    expect(normalizeEditEvidence([], FPS)).toEqual([]);
  });
});

describe('cutSplitsWord', () => {
  it('rejects a non-integer or negative cut frame', () => {
    expect(() => cutSplitsWord(1.5, [])).toThrow(/non-negative integer/);
    expect(() => cutSplitsWord(-1, [])).toThrow(/non-negative integer/);
  });

  it('is true strictly INSIDE a word, and false on either edge', () => {
    // The edges are legal cuts — that is what makes a word boundary a safe cut point.
    const words = [word('w1', 10, 20)];
    expect(cutSplitsWord(15, words)).toBe(true);
    expect(cutSplitsWord(10, words)).toBe(false);
    expect(cutSplitsWord(20, words)).toBe(false);
  });

  it('ignores non-word evidence — only speech protects a boundary', () => {
    const silence = { ...word('s1', 10, 20), kind: 'silence' as const };
    expect(cutSplitsWord(15, [silence])).toBe(false);
  });
});

describe('safeCutWindowsBetweenWords', () => {
  it('rejects a non-integer or negative minimum gap', () => {
    expect(() => safeCutWindowsBetweenWords([], 1.5)).toThrow(/non-negative integer/);
    expect(() => safeCutWindowsBetweenWords([], -1)).toThrow(/non-negative integer/);
  });

  it('prefers the centre of the gap, keeping equal handles on both sides', () => {
    const windows = safeCutWindowsBetweenWords([word('a', 0, 10), word('b', 20, 30)]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      afterWordId: 'a',
      beforeWordId: 'b',
      startFrame: 10,
      endFrame: 20,
      preferredFrame: 15,
      durationFrames: 10,
    });
  });

  it('skips a gap narrower than the minimum', () => {
    expect(safeCutWindowsBetweenWords([word('a', 0, 10), word('b', 11, 20)], 5)).toEqual([]);
  });

  it('never spans two assets — a cut between clips is not a gap in speech', () => {
    expect(safeCutWindowsBetweenWords([word('a', 0, 10), word('b', 20, 30, 'asset_2')])).toEqual(
      [],
    );
  });

  it('ignores non-word evidence when finding gaps', () => {
    const silence = { ...word('s', 10, 20), kind: 'silence' as const };
    expect(safeCutWindowsBetweenWords([word('a', 0, 10), silence, word('b', 20, 30)])).toHaveLength(
      1,
    );
  });

  it('returns nothing for fewer than two words', () => {
    expect(safeCutWindowsBetweenWords([word('a', 0, 10)])).toEqual([]);
    expect(safeCutWindowsBetweenWords([])).toEqual([]);
  });
});

describe('nearestSafeCutFrame', () => {
  const evidence = [word('a', 0, 10), word('b', 20, 30)];

  it('rejects a non-integer or negative target', () => {
    expect(() => nearestSafeCutFrame(1.5, evidence)).toThrow(/non-negative integer/);
    expect(() => nearestSafeCutFrame(-1, evidence)).toThrow(/non-negative integer/);
  });

  it('rejects a negative or NaN maximum distance', () => {
    expect(() => nearestSafeCutFrame(0, evidence, -1)).toThrow(/non-negative/);
    expect(() => nearestSafeCutFrame(0, evidence, Number.NaN)).toThrow(/non-negative/);
  });

  it('snaps to the nearest legal boundary', () => {
    expect(nearestSafeCutFrame(11, evidence)).toBe(10);
    expect(nearestSafeCutFrame(19, evidence)).toBe(20);
  });

  it('never returns a frame inside a word', () => {
    // The whole contract: asking to cut mid-word yields a boundary, not the target.
    expect(nearestSafeCutFrame(5, evidence)).not.toBe(5);
  });

  it('breaks a distance tie toward the lower frame, so the result is deterministic', () => {
    expect(nearestSafeCutFrame(15, evidence)).toBe(10);
  });

  it('returns undefined when every boundary is beyond the allowed distance', () => {
    // Undefined is the honest answer — an edit that cannot find a legal cut must not
    // fall back to an illegal one.
    expect(nearestSafeCutFrame(100, evidence, 5)).toBeUndefined();
  });

  it('returns undefined when there is no evidence at all', () => {
    expect(nearestSafeCutFrame(10, [])).toBeUndefined();
  });
});

describe('evidenceOverlappingRange', () => {
  const evidence = [word('a', 0, 10), word('b', 20, 30)];

  it('rejects an invalid range', () => {
    expect(() => evidenceOverlappingRange(evidence, -1, 5)).toThrow(/startFrame/);
    expect(() => evidenceOverlappingRange(evidence, 1.5, 5)).toThrow(/startFrame/);
    expect(() => evidenceOverlappingRange(evidence, 5, 5)).toThrow(/endFrame/);
    expect(() => evidenceOverlappingRange(evidence, 5, 4)).toThrow(/endFrame/);
  });

  it('selects half-open overlaps, excluding a range that merely touches an edge', () => {
    expect(evidenceOverlappingRange(evidence, 5, 25).map((item) => item.id)).toEqual(['a', 'b']);
    expect(evidenceOverlappingRange(evidence, 10, 20)).toEqual([]);
    expect(evidenceOverlappingRange(evidence, 9, 10).map((item) => item.id)).toEqual(['a']);
  });
});
