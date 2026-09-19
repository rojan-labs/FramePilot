/**
 * Which asynchronous stages of the program monitor are waiting right now, and for how long
 * (PX5.7).
 *
 * WHY: about one watched PX5 run in ten stopped inside a `page.evaluate` until the test timed
 * out (a seek that never returned, with normal memory), on a variant without a matte as well as
 * with one. A promise that never settles leaves no trace: nothing throws, nothing logs, and the
 * test only learns the whole step took too long. Every stage a seek or a decode-ahead waits on
 * goes through {@link StageTracker.track}, so a hang can be named — which stage, for which
 * source and range, how long — by asking ({@link StageTracker.inFlight}) and, without anyone
 * asking, by a warning once a stage has waited {@link StageTrackerOptions.stuckAfterMs}.
 *
 * It observes and never intervenes: a tracked promise settles exactly as it would untracked,
 * and nothing is cancelled or timed out here.
 */

/** One stage that has started and not settled. */
export interface StageSnapshot {
  /** What is waited on, e.g. `decode` or `seek.mattes`. */
  readonly stage: string;
  /** Which source / range / request, never a URL or path. */
  readonly detail: string;
  /** Milliseconds since the stage started. */
  readonly ageMs: number;
}

export interface StageTrackerOptions {
  /** A stage open this long is reported once through {@link onStuck}. */
  readonly stuckAfterMs: number;
  /** Called with the stages that just passed {@link stuckAfterMs}, oldest first. */
  readonly onStuck?: (stuck: readonly StageSnapshot[]) => void;
  readonly now?: () => number;
  /** Timer seam for tests; `setTimeout` by default. */
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

interface OpenStage {
  readonly stage: string;
  readonly detail: string;
  readonly startedMs: number;
  reported: boolean;
}

export class StageTracker {
  private nextId = 1;
  private readonly open = new Map<number, OpenStage>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: StageTrackerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * `work`, recorded as open from now until it settles.
   *
   * @returns The same outcome as `work` (the same value, the same rejection).
   */
  track<T>(stage: string, detail: string, work: Promise<T>): Promise<T> {
    const id = this.nextId++;
    this.open.set(id, { stage, detail, startedMs: this.now(), reported: false });
    this.arm();
    return work.finally(() => {
      this.open.delete(id);
      if (this.open.size === 0) this.disarm();
    });
  }

  /** Every open stage, oldest first. */
  inFlight(): StageSnapshot[] {
    const now = this.now();
    return [...this.open.values()]
      .sort((a, b) => a.startedMs - b.startedMs)
      .map(({ stage, detail, startedMs }) => ({ stage, detail, ageMs: now - startedMs }));
  }

  /** Stop the timer; open stages are forgotten. */
  dispose(): void {
    this.disarm();
    this.open.clear();
  }

  /** Wake at the earliest deadline of a stage not yet reported (a newer one is always later). */
  private arm(delayMs: number = this.options.stuckAfterMs): void {
    if (this.timer !== null) return;
    this.timer = this.schedule(() => this.check(), delayMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private check(): void {
    this.timer = null;
    const now = this.now();
    const newlyStuck: StageSnapshot[] = [];
    for (const entry of [...this.open.values()].sort((a, b) => a.startedMs - b.startedMs)) {
      if (entry.reported || now - entry.startedMs < this.options.stuckAfterMs) continue;
      entry.reported = true;
      newlyStuck.push({ stage: entry.stage, detail: entry.detail, ageMs: now - entry.startedMs });
    }
    if (newlyStuck.length > 0) this.options.onStuck?.(newlyStuck);
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.open.values()) {
      if (!entry.reported) next = Math.min(next, entry.startedMs + this.options.stuckAfterMs);
    }
    if (Number.isFinite(next)) this.arm(Math.max(0, next - now));
  }
}
