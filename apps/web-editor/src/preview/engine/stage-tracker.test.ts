import { describe, expect, it } from 'vitest';

import { StageTracker, type StageSnapshot } from './stage-tracker.js';

/** A tracker on a hand-driven clock and timer, so no test waits in real time. */
function harness(stuckAfterMs = 10_000) {
  let now = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const reports: StageSnapshot[][] = [];
  const tracker = new StageTracker({
    stuckAfterMs,
    now: () => now,
    onStuck: (stuck) => reports.push([...stuck]),
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as { live: boolean }).live = false;
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.live && timer.at <= now) {
        timer.live = false;
        timer.run();
      }
    }
  };
  const liveTimers = (): number => timers.filter((timer) => timer.live).length;
  return { tracker, reports, advance, liveTimers };
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('StageTracker (PX5.7)', () => {
  it('names a stage whose promise never settles, once, with its age', () => {
    const { tracker, reports, advance } = harness();
    void tracker.track('decode', 'a 30-37', never());
    advance(9_999);
    expect(reports).toEqual([]);
    advance(1);
    expect(reports).toEqual([[{ stage: 'decode', detail: 'a 30-37', ageMs: 10_000 }]]);
    advance(50_000);
    // Reported once; still listed as in flight, older.
    expect(reports).toHaveLength(1);
    expect(tracker.inFlight()).toEqual([{ stage: 'decode', detail: 'a 30-37', ageMs: 60_000 }]);
  });

  it('forgets a stage when it settles, either way, and passes its outcome through', async () => {
    const { tracker, reports, advance, liveTimers } = harness();
    await expect(tracker.track('decode', 'a', Promise.resolve(7))).resolves.toBe(7);
    const failure = new Error('decoder error');
    await expect(tracker.track('decode', 'b', Promise.reject(failure))).rejects.toBe(failure);
    expect(tracker.inFlight()).toEqual([]);
    expect(liveTimers()).toBe(0);
    advance(60_000);
    expect(reports).toEqual([]);
  });

  it('reports only the stages that are stuck, oldest first, among many that finish', async () => {
    const { tracker, reports, advance } = harness();
    void tracker.track('seek.mattes', 'seek 12', never());
    advance(4_000);
    let release!: () => void;
    const released = tracker.track('decode', 'b 0-7', new Promise<void>((r) => (release = r)));
    void tracker.track('decode', 'c 8-15', never());
    advance(6_000);
    expect(reports).toEqual([[{ stage: 'seek.mattes', detail: 'seek 12', ageMs: 10_000 }]]);
    release();
    await released;
    advance(4_000);
    expect(reports[1]).toEqual([{ stage: 'decode', detail: 'c 8-15', ageMs: 10_000 }]);
    expect(tracker.inFlight().map((s) => s.stage)).toEqual(['seek.mattes', 'decode']);
  });

  it('stops its timer on dispose', () => {
    const { tracker, liveTimers } = harness();
    void tracker.track('decode', 'a', never());
    expect(liveTimers()).toBe(1);
    tracker.dispose();
    expect(liveTimers()).toBe(0);
    expect(tracker.inFlight()).toEqual([]);
  });
});
