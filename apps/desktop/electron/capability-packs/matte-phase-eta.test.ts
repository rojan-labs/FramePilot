import { describe, expect, it } from 'vitest';
import { createPhaseEta } from './matte.js';

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
});
