/**
 * One queue for heavy pack inference (plan 03 "Job scheduler", audit P10/P11, BR4.9).
 *
 * Rules:
 * - **One GPU inference job at a time.** A job holds the slot from start to finish, except while
 *   it is suspended at a checkpoint.
 * - **Priorities:** interactive > the clip the editor is looking at (`focused`) > background,
 *   FIFO within a priority.
 * - **Pre-emption only between windows.** A job calls `checkpoint()` between windows. A
 *   higher-priority job waiting, a user pause, or an export in progress suspends it THERE and
 *   hands the slot on; nothing is ever interrupted mid-window.
 * - **Pause during export.** `beginExport()` suspends inference at the next checkpoint and holds
 *   the queue until `endExport()`, so export and inference never compete for memory.
 * - **Resume after restart.** Every unfinished job is journaled (kind, label, clip, payload,
 *   finished windows). `restore()` hands each to a factory that confirms the clip and media still
 *   match; jobs it rejects are dropped, the rest are queued and marked `resumed`.
 * - **Quit prompt.** `hasActiveJobs()` drives `createQuitGuard`.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('desktop:capability-packs:job-scheduler');

export type JobPriority = 'interactive' | 'focused' | 'background';
export type JobState =
  | 'queued'
  | 'running'
  | 'preempted'
  | 'paused'
  | 'paused_export'
  | 'completed'
  | 'failed'
  | 'cancelled';

const PRIORITY_RANK: Readonly<Record<JobPriority, number>> = { interactive: 0, focused: 1, background: 2 };
const TERMINAL: ReadonlySet<JobState> = new Set(['completed', 'failed', 'cancelled']);
/** How many finished jobs the panel keeps showing. */
const FINISHED_KEPT = 20;

/** What survives a restart. `payload` is the job's own request (never media or frames). */
export interface JobDescriptor {
  readonly id: string;
  readonly kind: 'matte' | 'tracking' | 'segment_frame';
  readonly label: string;
  readonly clipId?: string;
  readonly projectPath?: string;
  readonly payload: unknown;
  readonly finishedWindows: readonly number[];
}

export interface JobProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
  readonly round?: number;
  readonly etaSeconds?: number;
}

export interface JobSnapshot {
  readonly id: string;
  readonly kind: JobDescriptor['kind'];
  readonly label: string;
  readonly clipId?: string;
  readonly priority: JobPriority;
  readonly state: JobState;
  readonly progress?: JobProgress;
  /** Queued again after an app restart. */
  readonly resumed: boolean;
  readonly error?: string;
}

export interface JobContext {
  readonly signal: AbortSignal;
  /** Call between windows: returns when the job may continue; throws once cancelled. */
  checkpoint(): Promise<void>;
  progress(progress: JobProgress): void;
  /** Record a finished window so a restart can skip it. */
  finishWindow(index: number): void;
  readonly finishedWindows: ReadonlySet<number>;
}

export type JobRunner<T> = (context: JobContext) => Promise<T>;

export interface JobJournal {
  load(): Promise<readonly JobDescriptor[]>;
  save(descriptors: readonly JobDescriptor[]): Promise<void>;
}

export class JobCancelledError extends Error {
  public constructor() {
    super('Job cancelled.');
    this.name = 'JobCancelledError';
  }
}

interface Entry {
  descriptor: JobDescriptor;
  priority: JobPriority;
  readonly seq: number;
  state: JobState;
  started: boolean;
  userPaused: boolean;
  resumed: boolean;
  progress?: JobProgress;
  error?: string;
  readonly controller: AbortController;
  readonly run: JobRunner<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  /** Set while suspended at a checkpoint; calling it lets the job continue. */
  wake?: (() => void) | undefined;
}

export interface JobSchedulerOptions {
  readonly journal?: JobJournal;
  readonly onChange?: (jobs: readonly JobSnapshot[]) => void;
}

export class CapabilityPackJobScheduler {
  private readonly entries: Entry[] = [];
  private active: Entry | undefined;
  private exporting = false;
  private seq = 0;

  public constructor(private readonly options: JobSchedulerOptions = {}) {}

  /**
   * Queue a job. Resolves with the runner's result; rejects with its error or
   * {@link JobCancelledError}. A new `focused` job demotes earlier focused ones to background:
   * the clip the editor started last is the one it is looking at.
   */
  public submit<T>(descriptor: JobDescriptor, priority: JobPriority, run: JobRunner<T>, resumed = false): Promise<T> {
    if (this.entries.some((entry) => entry.descriptor.id === descriptor.id && !TERMINAL.has(entry.state))) {
      return Promise.reject(new Error('A job with this id is already scheduled.'));
    }
    if (priority === 'focused') {
      for (const entry of this.entries) if (entry.priority === 'focused') entry.priority = 'background';
    }
    return new Promise<T>((resolve, reject) => {
      this.entries.push({
        descriptor: { ...descriptor, finishedWindows: [...descriptor.finishedWindows] },
        priority,
        seq: (this.seq += 1),
        state: 'queued',
        started: false,
        userPaused: false,
        resumed,
        controller: new AbortController(),
        run: run as JobRunner<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      log.action('jobQueued', { kind: descriptor.kind, priority, resumed });
      this.changed();
      this.pump();
    });
  }

  public pause(jobId: string): boolean {
    const entry = this.live(jobId);
    if (entry === undefined || entry.userPaused) return false;
    entry.userPaused = true;
    // A queued or suspended job pauses now; a running one at its next checkpoint.
    if (entry !== this.active) entry.state = 'paused';
    this.changed();
    return true;
  }

  public resume(jobId: string): boolean {
    const entry = this.live(jobId);
    if (entry === undefined || !entry.userPaused) return false;
    entry.userPaused = false;
    if (entry !== this.active) entry.state = entry.started ? 'preempted' : 'queued';
    this.changed();
    this.pump();
    return true;
  }

  public cancel(jobId: string): boolean {
    const entry = this.live(jobId);
    if (entry === undefined) return false;
    entry.controller.abort();
    if (!entry.started) {
      this.settle(entry, 'cancelled', new JobCancelledError());
    } else if (entry.wake !== undefined) {
      const wake = entry.wake;
      entry.wake = undefined;
      wake();
    }
    this.changed();
    return true;
  }

  /** Suspend inference at the next checkpoint and hold the queue until {@link endExport}. */
  public beginExport(): void {
    this.exporting = true;
    log.action('jobsPausedForExport', { active: this.active !== undefined });
    this.changed();
  }

  public endExport(): void {
    if (!this.exporting) return;
    this.exporting = false;
    for (const entry of this.entries) if (entry.state === 'paused_export') entry.state = 'preempted';
    this.changed();
    this.pump();
  }

  public hasActiveJobs(): boolean {
    return this.entries.some((entry) => !TERMINAL.has(entry.state));
  }

  public snapshot(): JobSnapshot[] {
    return this.entries.map((entry) => ({
      id: entry.descriptor.id,
      kind: entry.descriptor.kind,
      label: entry.descriptor.label,
      ...(entry.descriptor.clipId === undefined ? {} : { clipId: entry.descriptor.clipId }),
      priority: entry.priority,
      state: entry.state,
      ...(entry.progress === undefined ? {} : { progress: entry.progress }),
      resumed: entry.resumed,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
  }

  /**
   * Re-queue journaled jobs after a restart. The factory confirms the clip and media still
   * match and returns the runner, or `undefined` to drop the job.
   */
  public async restore(
    factory: (descriptor: JobDescriptor) => Promise<{ priority: JobPriority; run: JobRunner<unknown> } | undefined>,
  ): Promise<number> {
    const journal = this.options.journal;
    if (journal === undefined) return 0;
    let descriptors: readonly JobDescriptor[];
    try {
      descriptors = await journal.load();
    } catch (error) {
      log.warn('jobJournalUnreadable', { error: error instanceof Error ? error.name : 'unknown' });
      return 0;
    }
    let restored = 0;
    for (const descriptor of descriptors) {
      const job = await factory(descriptor).catch(() => undefined);
      if (job === undefined) continue;
      restored += 1;
      // Nobody awaits a restored job; its outcome is visible in the panel and the cache.
      this.submit(descriptor, job.priority, job.run, true).catch(() => undefined);
    }
    log.action('jobsRestored', { journaled: descriptors.length, restored });
    this.persist();
    return restored;
  }

  private live(jobId: string): Entry | undefined {
    return this.entries.find((entry) => entry.descriptor.id === jobId && !TERMINAL.has(entry.state));
  }

  /** Grant the slot to the best waiting job, if the slot is free and export is not running. */
  private pump(): void {
    if (this.active !== undefined || this.exporting) return;
    const next = this.waiting()[0];
    if (next === undefined) return;
    this.active = next;
    next.state = 'running';
    this.changed();
    if (next.wake !== undefined) {
      const wake = next.wake;
      next.wake = undefined;
      wake();
      return;
    }
    next.started = true;
    const started = Date.now();
    void next
      .run(this.contextFor(next))
      .then(
        (value) => {
          // Cancelled during its last window: the result is discarded like any cancelled job's.
          if (next.controller.signal.aborted) {
            this.settle(next, 'cancelled', new JobCancelledError());
            return;
          }
          log.action('jobCompleted', { kind: next.descriptor.kind, elapsedMs: Date.now() - started });
          this.settle(next, 'completed', undefined, value);
        },
        (error: unknown) => {
          const cancelled = next.controller.signal.aborted || error instanceof JobCancelledError;
          log.action('jobEnded', { kind: next.descriptor.kind, state: cancelled ? 'cancelled' : 'failed' });
          this.settle(next, cancelled ? 'cancelled' : 'failed', cancelled ? new JobCancelledError() : error);
        },
      );
  }

  private waiting(): Entry[] {
    return this.entries
      .filter((entry) => (entry.state === 'queued' || entry.state === 'preempted') && !entry.userPaused)
      .sort((left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.seq - right.seq);
  }

  private contextFor(entry: Entry): JobContext {
    const finished = new Set(entry.descriptor.finishedWindows);
    return {
      signal: entry.controller.signal,
      finishedWindows: finished,
      progress: (progress) => {
        entry.progress = progress;
        this.changed(false);
      },
      finishWindow: (index) => {
        if (finished.has(index)) return;
        finished.add(index);
        entry.descriptor = { ...entry.descriptor, finishedWindows: [...finished].sort((a, b) => a - b) };
        this.persist();
      },
      checkpoint: async () => {
        if (entry.controller.signal.aborted) throw new JobCancelledError();
        const better = this.waiting().some((other) => PRIORITY_RANK[other.priority] < PRIORITY_RANK[entry.priority]);
        if (!entry.userPaused && !this.exporting && !better) return;
        entry.state = entry.userPaused ? 'paused' : this.exporting ? 'paused_export' : 'preempted';
        if (this.active === entry) this.active = undefined;
        log.action('jobSuspended', { kind: entry.descriptor.kind, state: entry.state });
        await new Promise<void>((resolve) => {
          entry.wake = resolve;
          this.changed();
          this.pump();
        });
        if (entry.controller.signal.aborted) throw new JobCancelledError();
      },
    };
  }

  private settle(entry: Entry, state: 'completed' | 'failed' | 'cancelled', error?: unknown, value?: unknown): void {
    entry.state = state;
    if (error !== undefined && state === 'failed') entry.error = error instanceof Error ? error.message : String(error);
    if (this.active === entry) this.active = undefined;
    if (state === 'completed') entry.resolve(value);
    else entry.reject(error);
    const finished = this.entries.filter((candidate) => TERMINAL.has(candidate.state));
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) {
      this.entries.splice(this.entries.indexOf(old), 1);
    }
    this.changed();
    this.pump();
  }

  private changed(persist = true): void {
    if (persist) this.persist();
    try {
      this.options.onChange?.(this.snapshot());
    } catch (error) {
      log.warn('jobObserverFailed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private persist(): void {
    const journal = this.options.journal;
    if (journal === undefined) return;
    const descriptors = this.entries.filter((entry) => !TERMINAL.has(entry.state)).map((entry) => entry.descriptor);
    journal.save(descriptors).catch((error: unknown) => {
      log.warn('jobJournalWriteFailed', { error: error instanceof Error ? error.name : 'unknown' });
    });
  }
}

/**
 * The quit prompt: while a job is unfinished, quitting asks first ("Background removal is
 * running"). Returns a `before-quit` handler.
 */
export function createQuitGuard(options: {
  readonly hasActiveJobs: () => boolean;
  /** Resolve true to quit anyway. */
  readonly confirmQuit: () => Promise<boolean>;
  readonly quit: () => void;
}): (event: { preventDefault(): void }) => void {
  let confirmed = false;
  let asking = false;
  return (event) => {
    if (confirmed || !options.hasActiveJobs()) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    void options
      .confirmQuit()
      .then((quit) => {
        if (!quit) return;
        confirmed = true;
        options.quit();
      })
      .finally(() => {
        asking = false;
      });
  };
}

/** The dialog copy for the quit prompt, in one place. */
export const QUIT_PROMPT = {
  message: 'Background removal is running',
  detail: 'Finished parts are kept and the job resumes the next time you open FramePilot.',
  buttons: ['Keep working', 'Quit anyway'] as const,
} as const;

const JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
const JOB_KINDS: ReadonlySet<string> = new Set(['matte', 'tracking', 'segment_frame']);

/** The journal as one JSON file in app data, written atomically. Invalid entries are dropped. */
export class FileJobJournal implements JobJournal {
  public constructor(private readonly file: string) {}

  public async load(): Promise<readonly JobDescriptor[]> {
    const { lstat, readFile } = await import('node:fs/promises');
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) return [];
      const document = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const jobs = (document as { version?: unknown; jobs?: unknown } | null)?.jobs;
      if ((document as { version?: unknown }).version !== 1 || !Array.isArray(jobs)) return [];
      return jobs.filter(isDescriptor);
    } catch {
      return [];
    }
  }

  public async save(descriptors: readonly JobDescriptor[]): Promise<void> {
    const { mkdir, rename, rm, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, jobs: descriptors })}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function isDescriptor(value: unknown): value is JobDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(record.id) &&
    typeof record.kind === 'string' &&
    JOB_KINDS.has(record.kind) &&
    typeof record.label === 'string' &&
    record.label.length <= 200 &&
    (record.clipId === undefined || typeof record.clipId === 'string') &&
    (record.projectPath === undefined || typeof record.projectPath === 'string') &&
    Array.isArray(record.finishedWindows) &&
    record.finishedWindows.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)
  );
}
