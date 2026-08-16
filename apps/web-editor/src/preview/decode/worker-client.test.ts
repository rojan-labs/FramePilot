/**
 * Frame-hygiene guard for the decode worker client.
 *
 * The preview budget is "leaked frames: 0" (`framesCreatedTotal ===
 * framesClosedTotal`) because an unclosed `VideoFrame` is GPU-backed and the GC
 * makes no promise about when — or whether — it returns that memory.
 *
 * `decodeRange` collects transferred frames into a waiter keyed by request id and
 * hands them to the caller when the range completes. The failure path had no
 * counterpart: a rejection left the waiter in the map forever and every frame it
 * had already collected unclosed. That path is routine rather than exotic —
 * pruning a source while a decode is in flight makes the worker reject, and an AI
 * run prunes sources on every commit — so the leak grew with the length of a run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecodeWorkerClient } from './worker-client.js';
import type { WorkerResponse } from './decode-worker.js';

/** A stand-in for the module worker: records requests, replays responses. */
class FakeWorker {
  public static latest: FakeWorker | undefined;
  public onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public readonly sent: unknown[] = [];
  public terminated = false;

  public constructor() {
    FakeWorker.latest = this;
  }

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  /** Deliver a response as the real worker would. */
  public deliver(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

/** jsdom has no `VideoFrame`; only `close()` is exercised here. */
function fakeFrame(): { closed: boolean; close: () => void } {
  const frame = {
    closed: false,
    close: (): void => {
      frame.closed = true;
    },
  };
  return frame;
}

function frameMessage(requestId: number, frame: unknown): WorkerResponse {
  return {
    type: 'frame',
    requestId,
    sourceId: 'main',
    chunkIndex: 0,
    frame,
    decodeStartedAtMs: 0,
  } as unknown as WorkerResponse;
}

const originalWorker = globalThis.Worker;

beforeEach(() => {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = originalWorker;
  FakeWorker.latest = undefined;
});

/**
 * `DecodeWorkerClient.decodeRange` resolves the worker through an async
 * `ensureWorkerReady` before it registers the request (`frameWaiters`/`pending`) or posts
 * the message, so callers driving the fake worker directly must flush that microtask first
 * or they deliver a response the client hasn't registered a waiter for yet.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe('DecodeWorkerClient frame hygiene', () => {
  it('closes frames already collected when the range rejects', async () => {
    const client = new DecodeWorkerClient();
    const pending = client.decodeRange('main', 0, 0);
    await flushMicrotasks();
    const worker = FakeWorker.latest!;

    const first = fakeFrame();
    const second = fakeFrame();
    worker.deliver(frameMessage(1, first));
    worker.deliver(frameMessage(1, second));
    // The source was pruned mid-flight — exactly what a commit does.
    worker.deliver({ type: 'error', requestId: 1, message: 'Source main not loaded.' });

    await expect(pending).rejects.toThrow('Source main not loaded.');
    expect([first.closed, second.closed]).toEqual([true, true]);

    const accounting = client.frameAccounting();
    expect(accounting.framesClosedTotal).toBe(accounting.framesCreatedTotal);
  });

  it('does not close frames it successfully handed to the caller', async () => {
    const client = new DecodeWorkerClient();
    const pending = client.decodeRange('main', 0, 0);
    await flushMicrotasks();
    const worker = FakeWorker.latest!;

    const delivered = fakeFrame();
    worker.deliver(frameMessage(1, delivered));
    worker.deliver({
      type: 'rangeDone',
      requestId: 1,
      decodeDurationMs: 1,
      reconfigured: false,
    } as unknown as WorkerResponse);

    const result = await pending;
    expect(result.frames).toHaveLength(1);
    // Ownership transferred: closing here would hand the caller a dead frame.
    expect(delivered.closed).toBe(false);
  });

  it('closes frames still collected when the client is disposed', async () => {
    const client = new DecodeWorkerClient();
    void client.decodeRange('main', 0, 0).catch(() => undefined);
    await flushMicrotasks();
    const worker = FakeWorker.latest!;

    const stranded = fakeFrame();
    worker.deliver(frameMessage(1, stranded));
    client.dispose();

    expect(stranded.closed).toBe(true);
    const accounting = client.frameAccounting();
    expect(accounting.framesClosedTotal).toBe(accounting.framesCreatedTotal);
  });
});
