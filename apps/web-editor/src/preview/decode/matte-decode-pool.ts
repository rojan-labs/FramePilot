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
 *   decoded frame-parallel: each request goes to the least busy worker, and each worker indexes
 *   the file the first time it is sent a frame of it;
 * - a file with non-key frames stays on one worker, so its decoder keeps its position and
 *   contiguous playback still decodes each frame once.
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

interface PoolWorker {
  readonly client: MatteWorkerClient;
  /** Requests sent and not yet answered: the load measure. */
  inFlight: number;
}

interface PoolSource {
  readonly url: string;
  readonly expectedFrames: number;
  readonly intraOnly: boolean;
  /** The worker that opened the file first; the only one a non-intra file uses. */
  readonly home: number;
  /** Per worker index: the file opened there (or the attempt in progress). */
  readonly opened: Map<number, Promise<boolean>>;
}

export class MatteDecodePool {
  private workers: PoolWorker[] | null = null;
  private readonly sources = new Map<string, PoolSource>();
  private nextHome = 0;
  private rotation = 0;
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

  /**
   * Open a matte artifact file. It is opened on ONE worker here, whose answer (or refusal) is
   * the file's; other workers open it when they are first sent one of its frames.
   */
  async loadMatte(sourceId: string, url: string, expectedFrames: number): Promise<MatteLoaded> {
    const workers = this.ensureWorkers();
    this.forget(sourceId);
    const home = this.nextHome;
    this.nextHome = (this.nextHome + 1) % workers.length;
    const info = await this.track(workers[home]!, (client) =>
      client.loadMatte(sourceId, url, expectedFrames),
    );
    const source: PoolSource = {
      url,
      expectedFrames,
      intraOnly: info.intraOnly,
      home,
      opened: new Map([[home, Promise.resolve(true)]]),
    };
    this.sources.set(sourceId, source);
    log.debug('matte file opened', { intraOnly: info.intraOnly, workers: workers.length });
    return info;
  }

  /** Decode one frame (file order) on the worker this file's frames go to now. */
  async decodeMatte(sourceId: string, frame: number): Promise<MatteFrame> {
    const source = this.sources.get(sourceId);
    const workers = this.workers;
    if (source === undefined || workers === null) {
      throw new Error(`Matte source ${sourceId} not loaded.`);
    }
    const chosen = source.intraOnly ? this.leastBusy(workers) : source.home;
    // Reserved now, not after the open: a burst of requests must see each other's choices.
    workers[chosen]!.inFlight += 1;
    let index = chosen;
    try {
      if (!(await this.openOn(sourceId, source, chosen))) index = source.home;
    } finally {
      workers[chosen]!.inFlight -= 1;
    }
    return this.track(workers[index]!, (client) => client.decodeMatte(sourceId, frame));
  }

  /** Close the file on every worker that opened it. */
  async unloadSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    this.sources.delete(sourceId);
    if (source === undefined || this.workers === null) return;
    const workers = this.workers;
    await Promise.all(
      [...source.opened.keys()].map((index) =>
        workers[index]!.client.unloadSource(sourceId).catch(() => undefined),
      ),
    );
  }

  /** Terminate every worker; pending requests reject in their clients. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sources.clear();
    for (const worker of this.workers ?? []) worker.client.dispose();
    this.workers = null;
  }

  private ensureWorkers(): PoolWorker[] {
    if (this.disposed) throw new Error('MatteDecodePool used after dispose().');
    this.workers ??= Array.from({ length: Math.max(1, this.size) }, () => ({
      client: this.create(),
      inFlight: 0,
    }));
    return this.workers;
  }

  /** Least in flight; ties rotate, so a burst of requests spreads over idle workers. */
  private leastBusy(workers: readonly PoolWorker[]): number {
    let best = -1;
    for (let step = 0; step < workers.length; step += 1) {
      const index = (this.rotation + step) % workers.length;
      if (best === -1 || workers[index]!.inFlight < workers[best]!.inFlight) best = index;
    }
    this.rotation = (this.rotation + 1) % workers.length;
    return best;
  }

  /**
   * Open `source` on worker `index` once. `false` (never a throw) when that fails: the home
   * worker already holds the file, so this file's frames go there from then on.
   */
  private openOn(sourceId: string, source: PoolSource, index: number): Promise<boolean> {
    const existing = source.opened.get(index);
    if (existing !== undefined) return existing;
    const worker = this.workers![index]!;
    const attempt = this.track(worker, (client) =>
      client.loadMatte(sourceId, source.url, source.expectedFrames),
    ).then(
      () => {
        // Unloaded or re-opened meanwhile: this worker's copy belongs to nobody.
        if (this.sources.get(sourceId) !== source) {
          void worker.client.unloadSource(sourceId).catch(() => undefined);
          return false;
        }
        return true;
      },
      (error: unknown) => {
        log.warn('matte file could not be opened on a second worker', {
          cause: error instanceof Error ? error.name : typeof error,
        });
        // Remembered as `false`: retrying on every frame would cost an index read each time.
        return false;
      },
    );
    source.opened.set(index, attempt);
    return attempt;
  }

  private forget(sourceId: string): void {
    if (this.sources.has(sourceId)) void this.unloadSource(sourceId);
  }

  private async track<T>(worker: PoolWorker, run: (client: MatteWorkerClient) => Promise<T>) {
    worker.inFlight += 1;
    try {
      return await run(worker.client);
    } finally {
      worker.inFlight -= 1;
    }
  }
}
