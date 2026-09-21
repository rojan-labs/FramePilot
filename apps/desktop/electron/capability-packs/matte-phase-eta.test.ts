import { describe, expect, it } from 'vitest';
import { createPhaseEta, resolveMatteQuality } from './matte.js';

const line = (phase: 'segment' | 'matte' | 'prepare', completed: number, total: number) =>
  ({ type: 'progress', protocolVersion: 1, requestId: 'r', phase, completed, total }) as const;

describe('createPhaseEta', () => {
  it('measures the rate from the start of the phase, not the start of the job', () => {
    let now = 0;
    const eta = createPhaseEta(() => now);
    // An hour of earlier phases must not leak into this phase's estimate.
    eta('r', line('prepare', 1, 1));
    now = 3_600_000;
    eta('r', line('segment', 0, 300));
    now += 30_000;
    expect(eta('r', line('segment', 3, 300)).etaSeconds).toBe(2_970);
  });

  it('gives no time until a few steps are measured, and none for a finished phase', () => {
    let now = 0;
    const eta = createPhaseEta(() => now);
    eta('r', line('matte', 0, 100));
    now = 10_000;
    expect(eta('r', line('matte', 2, 100)).etaSeconds).toBeUndefined();
    expect(eta('r', line('matte', 100, 100)).etaSeconds).toBeUndefined();
  });

  it('restarts the measurement when the same phase begins again in the next window', () => {
    let now = 0;
    const eta = createPhaseEta(() => now);
    eta('r', line('matte', 0, 100));
    now = 100_000;
    eta('r', line('matte', 100, 100));
    now = 5_000_000;
    eta('r', line('matte', 0, 100));
    now += 40_000;
    expect(eta('r', line('matte', 4, 100)).etaSeconds).toBe(960);
  });

  it('estimates the whole job from this run\u2019s frame rate, so a resumed job is not flattered', () => {
    let now = 0;
    const eta = createPhaseEta(() => now);
    const overall = (done: number) => ({
      ...line('segment', 1, 240),
      overallCompleted: done,
      overallTotal: 1_500,
    });
    // Resumed at 600 frames already done: those took no time in THIS run.
    expect(eta('r', overall(600)).jobEtaSeconds).toBeUndefined();
    now = 10_000;
    expect(eta('r', overall(620)).jobEtaSeconds).toBeUndefined();
    now = 20_000;
    const progress = eta('r', overall(640));
    expect(progress).toMatchObject({
      overallCompleted: 640,
      overallTotal: 1_500,
      jobEtaSeconds: 430,
    });
    expect(eta('r', line('segment', 2, 240)).overallTotal).toBeUndefined();
  });
});

describe('resolveMatteQuality', () => {
  it('never sends quality to a pack that cannot parse it', () => {
    expect(resolveMatteQuality('fast', 'darwin', '1.0.0')).toBeUndefined();
    expect(resolveMatteQuality(undefined, 'win32', '1.0.9')).toBeUndefined();
  });

  it('defaults to fast on macOS and runs best everywhere the Fast engine does not exist', () => {
    expect(resolveMatteQuality(undefined, 'darwin', '1.1.0')).toBe('fast');
    expect(resolveMatteQuality('best', 'darwin', '1.2.0')).toBe('best');
    expect(resolveMatteQuality('fast', 'win32', '1.1.0')).toBe('best');
  });
});
