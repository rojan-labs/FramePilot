import { describe, expect, it, vi } from 'vitest';
import { ThumbnailCapturePool } from './thumbnailCapturePool.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const nextTurn = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ThumbnailCapturePool', () => {
  it('deduplicates simultaneous consumers of the same media source', async () => {
    const gate = deferred<string>();
    const worker = vi.fn(() => gate.promise);
    const pool = new ThumbnailCapturePool(4, worker);

    const first = pool.request('fp-media://clip-a');
    const second = pool.request('fp-media://clip-a');

    expect(first.promise).toBe(second.promise);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(pool.snapshot()).toEqual({ active: 1, queued: 0, jobs: 1 });

    gate.resolve('thumbnail-a');
    await expect(first.promise).resolves.toBe('thumbnail-a');
    await expect(second.promise).resolves.toBe('thumbnail-a');
    await nextTurn();
    expect(pool.snapshot()).toEqual({ active: 0, queued: 0, jobs: 0 });
  });

  it('never exceeds the configured decoder concurrency', async () => {
    const gates = new Map<string, Deferred<string>>();
    const started: string[] = [];
    const worker = vi.fn((key: string) => {
      started.push(key);
      const gate = deferred<string>();
      gates.set(key, gate);
      return gate.promise;
    });
    const pool = new ThumbnailCapturePool(2, worker);

    const a = pool.request('a');
    const b = pool.request('b');
    const c = pool.request('c');

    expect(started).toEqual(['a', 'b']);
    expect(pool.snapshot()).toEqual({ active: 2, queued: 1, jobs: 3 });

    gates.get('a')!.resolve('a-thumb');
    await expect(a.promise).resolves.toBe('a-thumb');
    await nextTurn();

    expect(started).toEqual(['a', 'b', 'c']);
    expect(pool.snapshot().active).toBe(2);

    gates.get('b')!.resolve('b-thumb');
    gates.get('c')!.resolve('c-thumb');
    await Promise.all([b.promise, c.promise]);
  });

  it('removes queued work when its final virtualized consumer unmounts', async () => {
    const activeGate = deferred<string>();
    const worker = vi.fn((key: string) =>
      key === 'visible' ? activeGate.promise : Promise.resolve('should-not-run'),
    );
    const pool = new ThumbnailCapturePool(1, worker);

    const visible = pool.request('visible');
    const offscreen = pool.request('offscreen');
    const cancelled = expect(offscreen.promise).rejects.toMatchObject({ name: 'AbortError' });

    expect(pool.snapshot()).toEqual({ active: 1, queued: 1, jobs: 2 });
    offscreen.release();
    await cancelled;

    expect(worker).toHaveBeenCalledTimes(1);
    expect(pool.snapshot()).toEqual({ active: 1, queued: 0, jobs: 1 });

    activeGate.resolve('visible-thumb');
    await visible.promise;
  });

  it('aborts a running decode only after the last shared consumer releases it', async () => {
    let seenSignal: AbortSignal | undefined;
    const worker = vi.fn(
      (_key: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const pool = new ThumbnailCapturePool(1, worker);

    const first = pool.request('shared');
    const second = pool.request('shared');
    const cancelled = expect(first.promise).rejects.toMatchObject({ name: 'AbortError' });

    first.release();
    expect(seenSignal?.aborted).toBe(false);

    second.release();
    expect(seenSignal?.aborted).toBe(true);
    await cancelled;
    await nextTurn();
    expect(pool.snapshot()).toEqual({ active: 0, queued: 0, jobs: 0 });
  });

  it('keeps a 500-asset fast-scroll workload bounded to four active decoders', async () => {
    const worker = vi.fn(
      (_key: string, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const pool = new ThumbnailCapturePool(4, worker);
    const requests = Array.from({ length: 500 }, (_, index) => pool.request(`asset-${index}`));
    const settlements = requests.map((request) => request.promise.catch(() => undefined));

    expect(pool.snapshot()).toEqual({ active: 4, queued: 496, jobs: 500 });
    expect(worker).toHaveBeenCalledTimes(4);

    // Simulate the virtualized window moving away before queued decodes start.
    for (const request of requests.slice(4)) request.release();
    expect(pool.snapshot()).toEqual({ active: 4, queued: 0, jobs: 4 });
    expect(worker).toHaveBeenCalledTimes(4);

    for (const request of requests.slice(0, 4)) request.release();
    await Promise.all(settlements);
    await nextTurn();
    expect(pool.snapshot()).toEqual({ active: 0, queued: 0, jobs: 0 });
  });
});
