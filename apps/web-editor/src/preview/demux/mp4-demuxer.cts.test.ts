import { describe, expect, it } from 'vitest';
import { displayRotationCw, earliestCtsUs } from './mp4-demuxer.js';

describe('earliestCtsUs', () => {
  it('finds the first displayed time of a table far past the spread-argument limit', () => {
    // Two hours of 60 fps video: spreading this into Math.min threw a RangeError.
    const samples = Array.from({ length: 432_000 }, (_, i) => ({ ctsUs: 66_666 + i * 16_667 }));
    samples[1_000] = { ctsUs: 33_333 };
    expect(earliestCtsUs(samples)).toBe(33_333);
  });
});

describe('displayRotationCw', () => {
  // The tkhd matrices the PX4 media generator writes (`px4_parity_frames._TKHD_MATRICES`).
  const Q = 0x10000;
  const W = 0x40000000;
  it('reads the clockwise turn a track matrix asks for, 0 for none', () => {
    expect(displayRotationCw([Q, 0, 0, 0, Q, 0, 0, 0, W])).toBe(0);
    expect(displayRotationCw([0, Q, 0, -Q, 0, 0, 0, 0, W])).toBe(90);
    expect(displayRotationCw([-Q, 0, 0, 0, -Q, 0, 0, 0, W])).toBe(180);
    expect(displayRotationCw([0, -Q, 0, Q, 0, 0, 0, 0, W])).toBe(270);
    expect(displayRotationCw(undefined)).toBe(0);
  });
});
