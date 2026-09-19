import { describe, expect, it } from 'vitest';
import { LONG_JOB_CONFIRM_SECONDS, estimateMatteJob } from './matte-estimate.js';

const HD = { width: 1920, height: 1080 };

describe('estimateMatteJob', () => {
  it('uses the measured 1080p row and asks to confirm a job over ten minutes', () => {
    const estimate = estimateMatteJob(6, HD);
    expect(estimate.computeSeconds).toBe(6 * 520);
    expect(estimate.needsConfirmation).toBe(true);
    expect(estimate.bytes).toBeGreaterThan(0);
  });

  it('does not ask for a job the editor would not notice', () => {
    const estimate = estimateMatteJob(1, HD);
    expect(estimate.computeSeconds).toBeLessThanOrEqual(LONG_JOB_CONFIRM_SECONDS);
    expect(estimate.needsConfirmation).toBe(false);
  });

  it('scales with the picture, and falls back to 1080p when the size is unknown', () => {
    expect(estimateMatteJob(6, { width: 3840, height: 2160 }).computeSeconds).toBe(6 * 1230);
    expect(estimateMatteJob(6, { width: 960, height: 540 }).computeSeconds).toBeLessThan(6 * 520);
    expect(estimateMatteJob(6, null).computeSeconds).toBe(6 * 520);
    expect(estimateMatteJob(-3, HD).computeSeconds).toBe(0);
  });
});
