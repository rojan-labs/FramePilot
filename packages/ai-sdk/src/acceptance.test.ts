/**
 * Tests for reading checkable acceptance out of a request.
 *
 * The bar for adding a criterion is high on purpose: a wrong one fails a run that did the
 * work, which is worse than a missing one. The captured run's own words are the primary case —
 * "can you use at least of 20+ different best moments" was satisfied, as far as the run's
 * ledger knew, by an eight-shot timeline.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptanceCriteria,
  checkableAcceptance,
  explicitMinShotCount,
  hasCheckableAcceptance,
} from './acceptance.js';

describe('explicitMinShotCount', () => {
  it('reads a shot count from the way editors actually ask', () => {
    expect(
      explicitMinShotCount(
        'can you use at least of 20+ different best moments and combine and prepare a nice video',
      ),
    ).toBe(20);
    expect(explicitMinShotCount('use 12 clips')).toBe(12);
    expect(explicitMinShotCount('I want at least 8 different shots in this')).toBe(8);
    expect(explicitMinShotCount('cut it into 15 segments')).toBe(15);
  });

  it('does not mistake a duration for a shot count', () => {
    // "30 second cuts" names a length, not a number of shots — and reading it as one would
    // fail every montage that used fewer than thirty clips.
    expect(explicitMinShotCount('make a 30 second video')).toBeUndefined();
    expect(explicitMinShotCount('use 30 second cuts')).toBeUndefined();
    expect(explicitMinShotCount('prepare a 30s instagram story')).toBeUndefined();
  });

  it('ignores numbers that are not counts of shots', () => {
    expect(explicitMinShotCount('export at 1080p')).toBeUndefined();
    expect(explicitMinShotCount('a few clips from the middle')).toBeUndefined();
    // Below the meaningful floor: "2 clips" describes an edit, it is not an acceptance bar.
    expect(explicitMinShotCount('join these 2 clips')).toBeUndefined();
    // Absurdly high: not a shot count.
    expect(explicitMinShotCount('grow to 1000 clips')).toBeUndefined();
  });

  it('has nothing to say about an empty request', () => {
    expect(explicitMinShotCount('   ')).toBeUndefined();
  });
});

describe('checkableAcceptance', () => {
  it('carries the duration its caller already read, plus any shot count', () => {
    const acceptance = checkableAcceptance('a 30s reel from at least 20 moments', 30);
    expect(acceptance).toEqual({ durationSeconds: 30, minShotCount: 20 });
    expect(hasCheckableAcceptance(acceptance)).toBe(true);
  });

  it('is empty for a request that states no measurable condition', () => {
    const acceptance = checkableAcceptance('make this look nicer', undefined);
    expect(acceptance).toEqual({});
    expect(hasCheckableAcceptance(acceptance)).toBe(false);
  });
});

describe('acceptanceCriteria', () => {
  it('lists each checkable condition and keeps the request last', () => {
    const prompt = 'a 30s reel from at least 20 moments';
    const criteria = acceptanceCriteria(prompt, { durationSeconds: 30, minShotCount: 20 });
    expect(criteria).toHaveLength(3);
    expect(criteria[0]).toContain('30s');
    expect(criteria[1]).toContain('20 distinct shots');
    // The request is the part no check settles, so it is never dropped.
    expect(criteria.at(-1)).toBe(prompt);
  });

  it('is just the request when nothing is measurable', () => {
    expect(acceptanceCriteria('make it pop', {})).toEqual(['make it pop']);
  });
});
