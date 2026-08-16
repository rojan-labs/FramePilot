/**
 * Main-thread client for `decode-worker.ts` — request/response correlation,
 * frame-accounting (gate #5-style hygiene: every `VideoFrame` closes through
 * one place), and the `decodeRange` + collect-all-frames convenience used by
 * both the P0 spike harness and the real single-clip preview engine (P1).
 */
import { createLogger } from '@framepilot/shared-types';
import type { DecodedFrameMessage, WorkerRequest, WorkerResponse } from './decode-worker.js';

const log = createLogger('web-editor:preview:decode-worker-client');

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface DecodeRangeResult {
  frames: DecodedFrameMessage[];
  decodeDurationMs: number;
  reconfigured: boolean;
}

export interface FrameAccounting {
  framesCreatedTotal: number;
  framesClosedTotal: number;
  inFlightPeak: number;
}

export class DecodeWorkerClient {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private pending = new Map<
    number,
    { resolve: (msg: WorkerResponse) => void; reject: (err: Error) => void }
  >();
  private frameWaiters = new Map<number, DecodedFrameMessage[]>();
  private framesCreatedTotal = 0;
  private framesClosedTotal = 0;
  private inFlightPeak = 0;
  private disposed = false;
  /** Desired worker-owned source registrations. Replayed after a worker-level failure. */
  private readonly sourceUrls = new Map<string, string>();
  private workerNeedsRehydrate = false;
  private rehydratePromise: Promise<void> | undefined;

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('DecodeWorkerClient used after dispose().');
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      const error = new Error(`Decode worker failed: ${event.message || 'unknown worker error'}`);
      log.error('decode worker error', { message: event.message });
      // Ignore a late error from an already-replaced instance. Pending requests belong to the
      // current worker, so a stale worker must never be allowed to reject replacement work.
      if (this.worker !== worker) {
        worker.terminate();
        return;
      }
      // A worker-level error means this instance is no longer trustworthy. Clear it before
      // rejecting callers so a retry cannot reuse a worker that may never process messages again.
      this.worker = undefined;
      this.workerNeedsRehydrate = false;
      worker.terminate();
      this.failPending(error);
    };
    this.worker = worker;
    this.workerNeedsRehydrate = this.sourceUrls.size > 0;
    return worker;
  }

  /** Restore successfully loaded sources before a replacement worker accepts dependent work. */
  private async ensureWorkerReady(): Promise<Worker> {
    const worker = this.ensureWorker();
    if (!this.workerNeedsRehydrate) return worker;

    const recovery =
      this.rehydratePromise ??
      (async () => {
        const registrations = [...this.sourceUrls.entries()];
        for (const [sourceId, url] of registrations) {
          await this.sendToWorker<Extract<WorkerResponse, { type: 'loaded' }>>(worker, {
            type: 'load',
            sourceId,
            url,
          });
        }
        if (this.worker !== worker) {
          throw new Error('Decode worker failed while restoring loaded sources.');
        }
        this.workerNeedsRehydrate = false;
      })();
    if (this.rehydratePromise === undefined) this.rehydratePromise = recovery;

    try {
      await recovery;
    } finally {
      if (this.rehydratePromise === recovery) this.rehydratePromise = undefined;
    }
    if (this.worker !== worker) {
      throw new Error('Decode worker failed while restoring loaded sources.');
    }
    return worker;
  }

  /** The single point every held `VideoFrame` closes through. */
  closeFrame(frame: VideoFrame): void {
    frame.close();
    this.framesClosedTotal++;
  }

  frameAccounting(): FrameAccounting {
    return {
      framesCreatedTotal: this.framesCreatedTotal,
      framesClosedTotal: this.framesClosedTotal,
      inFlightPeak: this.inFlightPeak,
    };
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'frame') {
      this.framesCreatedTotal++;
      this.inFlightPeak = Math.max(
        this.inFlightPeak,
        this.framesCreatedTotal - this.framesClosedTotal,
      );
      const waiter = this.frameWaiters.get(message.requestId);
      if (waiter) {
        waiter.push(message);
        return;
      }
      this.closeFrame(message.frame);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new Error(message.message));
    else pending.resolve(message);
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    // Reject first. decodeRange's finally block owns and closes the frames it collected.
    for (const request of pending) request.reject(error);
  }

  private sendToWorker<T extends WorkerResponse>(
    worker: Worker,
    request: DistributiveOmit<WorkerRequest, 'requestId'>,
  ): Promise<T> {
    const requestId = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (msg: WorkerResponse) => void, reject });
      try {
        worker.postMessage({ ...request, requestId } as WorkerRequest);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async send<T extends WorkerResponse>(
    request: DistributiveOmit<WorkerRequest, 'requestId'>,
  ): Promise<T> {
    const worker = await this.ensureWorkerReady();
    return this.sendToWorker<T>(worker, request);
  }

  async loadSource(
    sourceId: string,
    url: string,
  ): Promise<{
    frameCount: number;
    frameDurationUs: number;
    presentationTimestampsUs: number[];
    codec: string;
    fileBytes: ArrayBuffer;
  }> {
    const response = await this.send<Extract<WorkerResponse, { type: 'loaded' }>>({
      type: 'load',
      sourceId,
      url,
    });
    this.sourceUrls.set(sourceId, url);
    return response;
  }

  unloadSource(sourceId: string): Promise<void> {
    // Desired state changes before transport: if this request itself loses the worker, a later
    // replacement must not resurrect the source the caller already asked to unload.
    this.sourceUrls.delete(sourceId);
    return this.send<Extract<WorkerResponse, { type: 'unloaded' }>>({
      type: 'unload',
      sourceId,
    }).then(() => undefined);
  }

  reconfigureCountFor(sourceId: string): Promise<number> {
    return this.send<Extract<WorkerResponse, { type: 'stats' }>>({ type: 'stats', sourceId }).then(
      (r) => r.reconfigureCount,
    );
  }

  async decodeRange(
    sourceId: string,
    fromChunkIndex: number,
    toChunkIndex: number,
  ): Promise<DecodeRangeResult> {
    const worker = await this.ensureWorkerReady();
    const requestId = this.nextRequestId++;
    this.frameWaiters.set(requestId, []);

    const rangeDone = new Promise<{ decodeDurationMs: number; reconfigured: boolean }>(
      (resolve, reject) => {
        this.pending.set(requestId, {
          resolve: (msg) => {
            if (msg.type !== 'rangeDone') {
              reject(new Error(`Expected rangeDone, got ${msg.type}`));
              return;
            }
            resolve({ decodeDurationMs: msg.decodeDurationMs, reconfigured: msg.reconfigured });
          },
          reject,
        });
      },
    );

    worker.postMessage({
      type: 'decodeRange',
      requestId,
      sourceId,
      fromChunkIndex,
      toChunkIndex,
    } satisfies WorkerRequest);

    let delivered = false;
    try {
      const { decodeDurationMs, reconfigured } = await rangeDone;
      const frames = this.frameWaiters.get(requestId) ?? [];
      delivered = true;
      return { frames, decodeDurationMs, reconfigured };
    } finally {
      const collected = this.frameWaiters.get(requestId) ?? [];
      this.frameWaiters.delete(requestId);
      this.pending.delete(requestId);
      if (!delivered) {
        for (const message of collected) this.closeFrame(message.frame);
      }
    }
  }

  /** Terminate the worker and reject every request that can no longer complete. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Decode worker disposed before the request completed.');
    this.failPending(error);
    this.worker?.terminate();
    this.worker = undefined;
    this.workerNeedsRehydrate = false;
    this.rehydratePromise = undefined;
    this.sourceUrls.clear();
    // Requests rejected above now run their decodeRange finally blocks in microtasks. Close
    // anything still owned here immediately, then clear the waiter map so those finally blocks
    // see an empty collection and cannot double-close frames.
    for (const collected of this.frameWaiters.values()) {
      for (const message of collected) this.closeFrame(message.frame);
    }
    this.frameWaiters.clear();
  }
}
