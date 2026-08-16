/**
 * Bounded, deduplicated task pool used by asset-thumbnail capture.
 *
 * Virtualized asset cards mount and unmount as the user scrolls. A plain FIFO
 * concurrency gate keeps abandoned work queued, starts duplicate decodes for the
 * same media source, and cannot stop an active decoder once its card leaves the
 * viewport. This pool makes visibility the lifetime of the work:
 *
 * - requests for the same key share one promise;
 * - no more than `maxConcurrent` workers run at once;
 * - queued work is removed when its final consumer releases it;
 * - running work receives an AbortSignal when its final consumer releases it.
 *
 * The pool owns scheduling only. Successful-result caching remains with the
 * caller because cache policy and invalidation are media concerns, not queue
 * concerns.
 */

/** One consumer's handle to a shared task. `release` is idempotent. */
export interface SharedTaskRequest<T> {
  readonly promise: Promise<T>;
  readonly release: () => void;
}

type JobState = 'queued' | 'running' | 'settled';

interface Job<T> {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  consumers: number;
  state: JobState;
}

/** A consistent cancellation error for queued jobs that never reach a worker. */
function cancellationError(): Error {
  const error = new Error('Thumbnail capture cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * A small scheduler for expensive, abortable work keyed by media source.
 *
 * `worker` must observe the supplied signal. The pool still remains correct if a
 * worker is slow to abort: its slot is released only when that worker actually
 * settles, so the concurrency ceiling is never exceeded.
 */
export class ThumbnailCapturePool<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private readonly queue: Job<T>[] = [];
  private active = 0;

  public constructor(
    private readonly maxConcurrent: number,
    private readonly worker: (key: string, signal: AbortSignal) => Promise<T>,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('Thumbnail capture concurrency must be a positive integer.');
    }
  }

  /** Acquire a shared task for `key`, starting it when a worker slot is free. */
  public request(key: string): SharedTaskRequest<T> {
    let job = this.jobs.get(key);
    if (job) {
      job.consumers += 1;
    } else {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      job = {
        key,
        controller: new AbortController(),
        promise,
        resolve,
        reject,
        consumers: 1,
        state: 'queued',
      };
      this.jobs.set(key, job);
      this.queue.push(job);
      this.drain();
    }

    let released = false;
    return {
      promise: job.promise,
      release: () => {
        if (released) return;
        released = true;
        this.release(job!);
      },
    };
  }

  /** Observable only for focused tests and diagnostic assertions. */
  public snapshot(): { readonly active: number; readonly queued: number; readonly jobs: number } {
    return { active: this.active, queued: this.queue.length, jobs: this.jobs.size };
  }

  private release(job: Job<T>): void {
    job.consumers = Math.max(0, job.consumers - 1);
    if (job.consumers > 0 || job.state === 'settled') return;

    // Remove the key immediately. A new visible consumer may start a fresh job
    // instead of attaching to one that has already been cancelled.
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);

    if (job.state === 'queued') {
      const index = this.queue.indexOf(job);
      if (index !== -1) this.queue.splice(index, 1);
      job.state = 'settled';
      job.controller.abort();
      job.reject(cancellationError());
      this.drain();
      return;
    }

    // The worker owns its cleanup. Aborting here asks it to release decoder,
    // canvas, and media resources, while the slot remains counted until settle.
    job.controller.abort();
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.state !== 'queued' || job.consumers === 0 || job.controller.signal.aborted) {
        continue;
      }
      job.state = 'running';
      this.active += 1;
      void this.run(job);
    }
  }

  private async run(job: Job<T>): Promise<void> {
    try {
      const value = await this.worker(job.key, job.controller.signal);
      job.resolve(value);
    } catch (error) {
      job.reject(error);
    } finally {
      job.state = 'settled';
      this.active -= 1;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.drain();
    }
  }
}
