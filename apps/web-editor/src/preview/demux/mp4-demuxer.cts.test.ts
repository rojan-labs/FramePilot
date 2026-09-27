import { describe, expect, it } from 'vitest';
import { earliestCtsUs } from './mp4-demuxer.js';

describe('earliestCtsUs', () => {
  it('finds the first displayed time of a table far past the spread-argument limit', () => {
    // Two hours of 60 fps video: spreading this into Math.min threw a RangeError.
    const samples = Array.from({ length: 432_000 }, (_, i) => ({ ctsUs: 66_666 + i * 16_667 }));
    samples[1_000] = { ctsUs: 33_333 };
    expect(earliestCtsUs(samples)).toBe(33_333);
  });
});
