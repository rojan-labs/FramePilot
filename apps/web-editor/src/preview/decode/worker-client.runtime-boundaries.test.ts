import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecodeWorkerClient } from './worker-client.js';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly posted: unknown[] = [];

  constructor(onCreated?: (worker: FakeWorker) => void) {
    onCreated?.(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

let latestWorker: FakeWorker | undefined;
const workers: FakeWorker[] = [];

function installWorker(): void {
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      constructor() {
        super((worker) => {
          latestWorker = worker;
          workers.push(worker);
        });
      }
    },
  );
}

/**
 * `DecodeWorkerClient.send`/`loadSource` resolve the worker lazily through an async
 * `ensureWorkerReady`, so the actual `postMessage` (and the pending-request bookkeeping
 * it enables) lands a microtask after the call returns. Tests that drive the fake worker
 * directly — firing `onerror`, reading `posted`, or disposing — must flush that microtask
 * first or they race ahead of the request the client hasn't registered yet.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

function completeLoad(worker: FakeWorker, sourceId = 'source-a'): void {
  const request = worker.posted.at(-1) as { requestId: number };
  worker.onmessage?.({
    data: {
      type: 'loaded',
      requestId: request.requestId,
      sourceId,
      frameCount: 10,
      frameDurationUs: 33_333,
      presentationTimestampsUs: [0, 33_333],
      codec: 'avc1.640028',
      fileBytes: new ArrayBuffer(0),
    },
  } as MessageEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
  latestWorker = undefined;
  workers.length = 0;
});

describe('DecodeWorkerClient teardown', () => {
  it('rejects an outstanding request when the worker errors', async () => {
    installWorker();
    const client = new DecodeWorkerClient();
    const pending = client.send({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();

    latestWorker?.onerror?.({ message: 'decoder crashed' } as ErrorEvent);

    await expect(pending).rejects.toThrow('decoder crashed');
    client.dispose();
  });

  it('terminates a failed worker and creates a fresh worker for the next request', async () => {
    installWorker();
    const client = new DecodeWorkerClient();
    const first = client.send<{
      type: 'stats';
      requestId: number;
      sourceId: string;
      reconfigureCount: number;
    }>({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();
    const failedWorker = latestWorker!;

    failedWorker.onerror?.({ message: 'decoder crashed' } as ErrorEvent);
    await expect(first).rejects.toThrow('decoder crashed');
    expect(failedWorker.terminated).toBe(true);

    const second = client.send<{
      type: 'stats';
      requestId: number;
      sourceId: string;
      reconfigureCount: number;
    }>({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();
    const replacement = latestWorker!;
    expect(replacement).not.toBe(failedWorker);
    expect(workers).toHaveLength(2);
    const request = replacement.posted.at(-1) as { requestId: number };
    replacement.onmessage?.({
      data: {
        type: 'stats',
        requestId: request.requestId,
        sourceId: 'source-a',
        reconfigureCount: 0,
      },
    } as MessageEvent);

    await expect(second).resolves.toMatchObject({ reconfigureCount: 0 });
    client.dispose();
  });

  it('does not let a stale worker error reject replacement requests', async () => {
    installWorker();
    const client = new DecodeWorkerClient();
    const first = client.send({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();
    const failedWorker = latestWorker!;

    failedWorker.onerror?.({ message: 'first crash' } as ErrorEvent);
    await expect(first).rejects.toThrow('first crash');

    const replacementRequest = client.send<{
      type: 'stats';
      requestId: number;
      sourceId: string;
      reconfigureCount: number;
    }>({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();
    const replacement = latestWorker!;
    expect(replacement).not.toBe(failedWorker);

    failedWorker.onerror?.({ message: 'late stale error' } as ErrorEvent);
    const request = replacement.posted.at(-1) as { requestId: number };
    replacement.onmessage?.({
      data: {
        type: 'stats',
        requestId: request.requestId,
        sourceId: 'source-a',
        reconfigureCount: 1,
      },
    } as MessageEvent);

    await expect(replacementRequest).resolves.toMatchObject({ reconfigureCount: 1 });
    client.dispose();
  });

  it('rehydrates loaded sources before decoding on a replacement worker', async () => {
    installWorker();
    const client = new DecodeWorkerClient();
    const initialLoad = client.loadSource('source-a', 'blob:source-a');
    await flushMicrotasks();
    const failedWorker = latestWorker!;
    completeLoad(failedWorker);
    await initialLoad;

    failedWorker.onerror?.({ message: 'decoder crashed' } as ErrorEvent);
    expect(failedWorker.terminated).toBe(true);

    const decode = client.decodeRange('source-a', 0, 1);
    await flushMicrotasks();
    const replacement = latestWorker!;
    expect(replacement).not.toBe(failedWorker);
    expect(replacement.posted).toHaveLength(1);
    expect(replacement.posted[0]).toMatchObject({
      type: 'load',
      sourceId: 'source-a',
      url: 'blob:source-a',
    });

    completeLoad(replacement);
    // The rehydrate response resolves through several chained awaits (the rehydrate loop,
    // then `ensureWorkerReady`, then `decodeRange` itself) before `decodeRange` posts its own
    // message, so poll rather than pin an exact microtask-tick count to internal plumbing.
    await expect.poll(() => replacement.posted.length).toBeGreaterThan(1);

    const decodeRequest = replacement.posted.at(-1) as {
      type: string;
      requestId: number;
      sourceId: string;
    };
    expect(decodeRequest).toMatchObject({
      type: 'decodeRange',
      sourceId: 'source-a',
    });
    replacement.onmessage?.({
      data: {
        type: 'rangeDone',
        requestId: decodeRequest.requestId,
        sourceId: 'source-a',
        decodeDurationMs: 4,
        reconfigured: true,
      },
    } as MessageEvent);

    await expect(decode).resolves.toMatchObject({
      frames: [],
      decodeDurationMs: 4,
      reconfigured: true,
    });
    client.dispose();
  });

  it('rejects an outstanding request when the client is disposed', async () => {
    installWorker();
    const client = new DecodeWorkerClient();
    const pending = client.send({ type: 'stats', sourceId: 'source-a' });
    await flushMicrotasks();

    client.dispose();

    await expect(pending).rejects.toThrow('disposed');
    expect(latestWorker?.terminated).toBe(true);
  });
});
