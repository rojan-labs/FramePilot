/**
 * Matte artifact files decoded on their own workers, several frames at a time (PX5.3).
 *
 * WHY: the FFV1 decoder is TypeScript and single-threaded. A 4K matte frame costs 32 ms and its
 * foreground 69 ms, and both used to run in the ONE decode worker that also feeds the picture
 * decoders, one after the other: 101 ms of matte per project frame, with every picture decode
 * window queued behind it (58 ms → 1,566 ms p50, `PX5-BUDGETS.md`). Here:
 *
 * - mattes never share a worker with pictures, so picture decode keeps its own critical path;
 * - an intra-only file (every frame a key frame, which is how the pack writes its masters) is
 *   decoded frame-parallel: any free worker takes its next frame, and each worker indexes the
 *   file the first time it is given one of its frames;
 * - a file with non-key frames stays on one worker, so its decoder keeps its position and
 *   contiguous playback still decodes each frame once;
 * - requests wait HERE, not in the workers: a worker is given one frame at a time, the
 *   best-ranked one it can run, and a request whose rank says nobody wants it any more is
 *   dropped with {@link MatteDecodeCancelled}. A worker's own queue is first-in first-out, so a
 *   backlog left there decodes frames the playhead has already passed (measured: 1.4 s p50 from
 *   request to planes, most of it spent on stale frames).
 *
 * Every worker is a `decode-worker.ts` instance behind its own {@link DecodeWorkerClient}, so
 * failure recovery (a replacement worker re-opens its files) is the client's, unchanged. The
 * workers are created on the first matte load: a timeline without mattes starts none.
 */
import { createLogger } from '@framepilot/shared-types';

import type { WorkerResponse } from './decode-worker.js';
import { DecodeWorkerClient } from './worker-client.js';

const log = createLogger('web-editor:preview:matte-decode-pool');

/** Most matte workers, whatever the core count: past this, memory grows faster than speed. */
export const MATTE_DECODE_WORKERS_MAX = 4;

type MatteLoaded = Extract<WorkerResponse, { type: 'matteLoaded' }>;
type MatteFrame = Extract<WorkerResponse, { type: 'matteFrame' }>;

/** What the pool needs of one worker's client. */
export type MatteWorkerClient = Pick<
  DecodeWorkerClient,
  'loadMatte' | 'decodeMatte' | 'unloadSource' | 'dispose'
>;

/**
 * Workers for this machine: half its cores (picture decode is mostly hardware, and the main
 * thread and GPU process need the rest), at least one, at most {@link MATTE_DECODE_WORKERS_MAX}.
 */
export function matteWorkerCount(hardwareConcurrency: number | undefined): number {
  const cores =
    hardwareConcurrency !== undefined && hardwareConcurrency > 0 ? hardwareConcurrency : 2;
  return Math.min(MATTE_DECODE_WORKERS_MAX, Math.max(1, Math.floor(cores / 2)));
}

/** A request dropped before it reached a worker because nobody wants its frame any more. */
export class MatteDecodeCancelled extends Error {
  constructor() {
    super('The matte frame is no longer wanted.');
    this.name = 'MatteDecodeCancelled';
  }
}

/**
 * How urgent a request is now: lower runs first; `null` means nobody wants it any more.
 * Asked every time a worker frees up, so it can change while the request waits.
 */
export type MatteDecodeRank = () => number | null;

interface PoolWorker {
  readonly client: MatteWorkerClient;
  /** Opening a file or decoding a frame: the worker is given nothing else meanwhile. */
  busy: boolean;
}

interface QueuedDecode {
  readonly sourceId: string;
  readonly frame: number;
  readonly rank: MatteDecodeRank;
  readonly resolve: (frame: MatteFrame) => void;
  readonly reject: (error: unknown) => void;
}

interface PoolSource {
  readonly url: string;
  readonly expectedFrames: number;
  readonly intraOnly: boolean;
  /** The worker that opened the file first; the only one a non-intra file uses. */
  readonly home: number;
  /** Workers that hold the file open. */
  readonly opened: Set<number>;
  /** Workers that could not open it: its frames never go there again. */
  readonly unavailable: Set<number>;
}

export class MatteDecodePool {
  private workers: PoolWorker[] | null = null;
  private readonly sources = new Map<string, PoolSource>();
  private readonly queue: QueuedDecode[] = [];
  private nextHome = 0;
  private disposed = false;

  /**
   * @param size - Worker count ({@link matteWorkerCount} of this machine by default).
   * @param create - One worker's client; tests pass fakes.
   */
  constructor(
    private readonly size: number = matteWorkerCount(globalThis.navigator?.hardwareConcurrency),
    private readonly create: () => MatteWorkerClient = () => new DecodeWorkerClient(),
  ) {}

  /** How many workers exist now (0 until the first matte load). */
  get workerCount(): number {
    return this.workers?.length ?? 0;
  }

  /** Requests waiting for a worker. */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Open a matte artifact file. It is opened on ONE worker here, whose answer (or refusal) is
   * the file's; other workers open it when they are first given one of its frames.
   */
  async loadMatte(sourceId: string, url: string, expectedFrames: number): Promise<MatteLoaded> {
    const workers = this.ensureWorkers();
    this.forget(sourceId);
    const home = this.nextHome;
    this.nextHome = (this.nextHome + 1) % workers.length;
    const info = await workers[home]!.client.loadMatte(sourceId, url, expectedFrames);
    this.sources.set(sourceId, {
      url,
      expectedFrames,
      intraOnly: info.intraOnly,
      home,
      opened: new Set([home]),
      unavailable: new Set(),
    });
    log.debug('matte file opened', { intraOnly: info.intraOnly, workers: workers.length });
    this.pump();
    return info;
  }

  /**
   * Decode one frame (file order) when a worker that can run it is free.
   *
   * @param rank - Asked each time a worker frees up; `null` drops the request with
   *   {@link MatteDecodeCancelled}. By default every request is wanted, first come first served.
   */
  decodeMatte(
    sourceId: string,
    frame: number,
    rank: MatteDecodeRank = () => 0,
  ): Promise<MatteFrame> {
    if (!this.sources.has(sourceId) || this.workers === null) {
      return Promise.reject(new Error(`Matte source ${sourceId} not loaded.`));
    }
    return new Promise<MatteFrame>((resolve, reject) => {
      this.queue.push({ sourceId, frame, rank, resolve, reject });
      this.pump();
    });
  }

  /** Close the file on every worker that opened it; its waiting requests are refused. */
  async unloadSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    this.sources.delete(sourceId);
    if (source === undefined || this.workers === null) return;
    const workers = this.workers;
    this.pump();
    await Promise.all(
      [...source.opened].map((index) =>
        workers[index]!.client.unloadSource(sourceId).catch(() => undefined),
      ),
    );
  }

  /** Terminate every worker; waiting and running requests reject. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sources.clear();
    for (const item of this.queue.splice(0)) item.reject(new Error('MatteDecodePool disposed.'));
    for (const worker of this.workers ?? []) worker.client.dispose();
    this.workers = null;
  }

  private ensureWorkers(): PoolWorker[] {
    if (this.disposed) throw new Error('MatteDecodePool used after dispose().');
    this.workers ??= Array.from({ length: Math.max(1, this.size) }, () => ({
      client: this.create(),
      busy: false,
    }));
    return this.workers;
  }

  /** Give every free worker the best request it can run. */
  private pump(): void {
    const workers = this.workers;
    if (workers === null) return;
    workers.forEach((worker, index) => {
      if (worker.busy) return;
      const item = this.take(index);
      if (item === null) return;
      worker.busy = true;
      void this.run(worker, index, item).finally(() => {
        worker.busy = false;
        this.pump();
      });
    });
  }

  /**
   * The lowest-ranked request worker `index` can run, removed from the queue. Requests for a
   * closed file are refused, and unwanted ones cancelled, on the way.
   */
  private take(index: number): QueuedDecode | null {
    let best = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.queue.length;) {
      const item = this.queue[i]!;
      const source = this.sources.get(item.sourceId);
      const rank = source === undefined ? null : item.rank();
      if (source === undefined || rank === null) {
        this.queue.splice(i, 1);
        item.reject(
          source === undefined
            ? new Error(`Matte source ${item.sourceId} not loaded.`)
            : new MatteDecodeCancelled(),
        );
        continue;
      }
      const runnable =
        index === source.home || (source.intraOnly && !source.unavailable.has(index));
      if (runnable && rank < bestRank) {
        best = i;
        bestRank = rank;
      }
      i += 1;
    }
    return best === -1 ? null : this.queue.splice(best, 1)[0]!;
  }

  /** Run one request on `worker`; settles `item`, never rejects. */
  private async run(worker: PoolWorker, index: number, item: QueuedDecode): Promise<void> {
    const source = this.sources.get(item.sourceId);
    if (source === undefined) {
      item.reject(new Error(`Matte source ${item.sourceId} not loaded.`));
      return;
    }
    if (!(await this.openOn(worker, item.sourceId, source, index))) {
      if (this.disposed) {
        item.reject(new Error('MatteDecodePool disposed.'));
        return;
      }
      // The home worker holds the file: back in the queue, where only it can take this now.
      this.queue.unshift(item);
      return;
    }
    try {
      item.resolve(await worker.client.decodeMatte(item.sourceId, item.frame));
    } catch (error) {
      item.reject(error);
    }
  }

  /** Open `source` on worker `index` once; `false` (never a throw) when it cannot be. */
  private async openOn(
    worker: PoolWorker,
    sourceId: string,
    source: PoolSource,
    index: number,
  ): Promise<boolean> {
    if (source.opened.has(index)) return true;
    try {
      await worker.client.loadMatte(sourceId, source.url, source.expectedFrames);
    } catch (error) {
      log.warn('matte file could not be opened on a second worker', {
        cause: error instanceof Error ? error.name : typeof error,
      });
      // Remembered: retrying on every frame would cost an index read each time.
      source.unavailable.add(index);
      return false;
    }
    if (this.sources.get(sourceId) !== source) {
      // Closed or re-opened meanwhile: this worker's copy belongs to nobody.
      void worker.client.unloadSource(sourceId).catch(() => undefined);
      source.unavailable.add(index);
      return false;
    }
    source.opened.add(index);
    return true;
  }

  private forget(sourceId: string): void {
    if (this.sources.has(sourceId)) void this.unloadSource(sourceId);
  }
}
