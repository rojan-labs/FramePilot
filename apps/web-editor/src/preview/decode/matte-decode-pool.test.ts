/**
 * PX5.3: matte files decode off the picture worker, frame-parallel when every frame is a key
 * frame, and on one worker when it is not (so an FFV1 coder state is never split).
 */
import { describe, expect, it } from 'vitest';

import {
  MatteDecodeCancelled,
  MatteDecodePool,
  matteWorkerCount,
  type MatteWorkerClient,
} from './matte-decode-pool';

interface FakeWorker {
  readonly client: MatteWorkerClient;
  readonly opened: string[];
  readonly decoded: number[];
  readonly unloaded: string[];
  disposed: boolean;
  /** Resolve every decode sent so far. */
  flush(): void;
}

function fakeWorker(options: { intraOnly: boolean; failOpen?: boolean }): FakeWorker {
  const waiting: (() => void)[] = [];
  const worker: FakeWorker = {
    opened: [],
    decoded: [],
    unloaded: [],
    disposed: false,
    flush: () => waiting.splice(0).forEach((resolve) => resolve()),
    client: {
      loadMatte: async (sourceId: string) => {
        if (options.failOpen) throw new Error('boom');
        worker.opened.push(sourceId);
        return {
          type: 'matteLoaded' as const,
          requestId: 0,
          sourceId,
          width: 4,
          height: 2,
          format: 'gray8' as const,
          frameCount: 100,
          intraOnly: options.intraOnly,
        };
      },
      decodeMatte: (sourceId: string, frame: number) => {
        worker.decoded.push(frame);
        return new Promise((resolve) =>
          waiting.push(() =>
            resolve({
              type: 'matteFrame' as const,
              requestId: 0,
              sourceId,
              frame,
              width: 4,
              height: 2,
              format: 'gray8' as const,
              data: new ArrayBuffer(8),
            }),
          ),
        );
      },
      unloadSource: async (sourceId: string) => {
        worker.unloaded.push(sourceId);
      },
      dispose: () => {
        worker.disposed = true;
      },
    } as unknown as MatteWorkerClient,
  };
  return worker;
}

function pool(size: number, options: { intraOnly: boolean; failOpenAfterFirst?: boolean }) {
  const workers: FakeWorker[] = [];
  const decoders = new MatteDecodePool(size, () => {
    const worker = fakeWorker({
      intraOnly: options.intraOnly,
      failOpen: options.failOpenAfterFirst === true && workers.length > 0,
    });
    workers.push(worker);
    return worker.client;
  });
  return { decoders, workers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('matteWorkerCount', () => {
  it('takes half the cores, at least one, at most four', () => {
    expect(matteWorkerCount(undefined)).toBe(1);
    expect(matteWorkerCount(2)).toBe(1);
    expect(matteWorkerCount(4)).toBe(2);
    expect(matteWorkerCount(8)).toBe(4);
    expect(matteWorkerCount(10)).toBe(4);
  });
});

describe('MatteDecodePool', () => {
  it('starts no worker until a matte is opened', async () => {
    const { decoders, workers } = pool(3, { intraOnly: true });
    expect(decoders.workerCount).toBe(0);
    await decoders.loadMatte('m', 'u', 100);
    expect(workers).toHaveLength(3);
  });

  it('spreads an intra-only burst over every worker, one frame each at a time', async () => {
    const { decoders, workers } = pool(4, { intraOnly: true });
    await decoders.loadMatte('m', 'u', 100);
    const frames = Array.from({ length: 8 }, (_, i) => decoders.decodeMatte('m', i));
    await settle();
    expect(workers.map((worker) => worker.decoded)).toEqual([[0], [1], [2], [3]]);
    expect(workers.map((worker) => worker.opened)).toEqual([['m'], ['m'], ['m'], ['m']]);
    expect(decoders.queued).toBe(4);
    workers.forEach((worker) => worker.flush());
    await settle();
    expect(workers.map((worker) => worker.decoded.length)).toEqual([2, 2, 2, 2]);
    workers.forEach((worker) => worker.flush());
    expect((await Promise.all(frames)).map((frame) => frame.frame)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('gives a free worker the most urgent waiting frame, and drops unwanted ones', async () => {
    const { decoders, workers } = pool(1, { intraOnly: true });
    await decoders.loadMatte('m', 'u', 100);
    const ranks = new Map<number, number | null>([
      [0, 0],
      [1, 5],
      [2, 1],
      [3, 2],
    ]);
    const frames = [0, 1, 2, 3].map((i) =>
      decoders.decodeMatte('m', i, () => ranks.get(i) ?? null),
    );
    const cancelled = expect(frames[3]).rejects.toBeInstanceOf(MatteDecodeCancelled);
    await settle();
    // Frame 3 is no longer wanted by the time a worker is free (the playhead passed it).
    ranks.set(3, null);
    for (let step = 0; step < 3; step += 1) {
      workers[0]!.flush();
      await settle();
    }
    expect(workers[0]!.decoded).toEqual([0, 2, 1]);
    await cancelled;
    await Promise.all(frames.slice(0, 3));
  });

  it('keeps a file with non-key frames on the worker that opened it', async () => {
    const { decoders, workers } = pool(4, { intraOnly: false });
    await decoders.loadMatte('m', 'u', 100);
    const frames = [0, 1, 2].map((i) => decoders.decodeMatte('m', i));
    for (let step = 0; step < 3; step += 1) {
      await settle();
      workers[0]!.flush();
    }
    await Promise.all(frames);
    expect(workers.map((worker) => worker.decoded)).toEqual([[0, 1, 2], [], [], []]);
    expect(workers.map((worker) => worker.opened.length)).toEqual([1, 0, 0, 0]);
  });

  it('gives the alpha and the foreground different home workers', async () => {
    const { decoders, workers } = pool(2, { intraOnly: false });
    await decoders.loadMatte('alpha', 'a', 100);
    await decoders.loadMatte('foreground', 'f', 100);
    expect(workers.map((worker) => worker.opened)).toEqual([['alpha'], ['foreground']]);
  });

  it('decodes on the home worker when a second worker cannot open the file', async () => {
    const { decoders, workers } = pool(2, { intraOnly: true, failOpenAfterFirst: true });
    await decoders.loadMatte('m', 'u', 100);
    const frames = [0, 1, 2].map((i) => decoders.decodeMatte('m', i));
    for (let step = 0; step < 4; step += 1) {
      await settle();
      workers[0]!.flush();
    }
    await Promise.all(frames);
    expect(workers[1]!.decoded).toEqual([]);
    expect([...workers[0]!.decoded].sort()).toEqual([0, 1, 2]);
  });

  it('unloads the file on every worker that opened it, and refuses its frames after', async () => {
    const { decoders, workers } = pool(3, { intraOnly: true });
    await decoders.loadMatte('m', 'u', 100);
    const frames = [0, 1, 2].map((i) => decoders.decodeMatte('m', i));
    await settle();
    workers.forEach((worker) => worker.flush());
    await Promise.all(frames);
    await decoders.unloadSource('m');
    expect(workers.map((worker) => worker.unloaded)).toEqual([['m'], ['m'], ['m']]);
    await expect(decoders.decodeMatte('m', 0)).rejects.toThrow(/not loaded/);
  });

  it('terminates every worker on dispose and refuses what was waiting', async () => {
    const { decoders, workers } = pool(1, { intraOnly: true });
    await decoders.loadMatte('m', 'u', 100);
    const running = decoders.decodeMatte('m', 0).catch(() => 'rejected');
    const waiting = expect(decoders.decodeMatte('m', 1)).rejects.toThrow(/disposed/);
    await settle();
    decoders.dispose();
    await waiting;
    // A real client rejects its own pending requests on dispose; the fake just never answers.
    void running;
    expect(workers.every((worker) => worker.disposed)).toBe(true);
    await expect(decoders.loadMatte('m', 'u', 100)).rejects.toThrow(/after dispose/);
  });
});
