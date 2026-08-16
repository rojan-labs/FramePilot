/**
 * Tests for the session-start warmup driver (plan B5.6). `fetch` is injected, so these
 * exercise the paced batch loop, cancellation, honest degradation, and the slice backstop
 * fully offline.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSessionWarmup } from './session-warmup.js';

/** A fetch stub replaying a queue of batch-slice JSON bodies (one per call). */
function batchFetch(bodies: readonly unknown[], record?: (body: unknown) => void): typeof fetch {
  let i = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    if (init?.body) record?.(JSON.parse(String(init.body)));
    i += 1;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

const req = (over: Partial<Parameters<typeof runSessionWarmup>[0]> = {}) => ({
  baseUrl: 'http://127.0.0.1:8765',
  projectId: 'p1',
  projectPath: '/proj/p1.fp.json',
  ...over,
});

describe('runSessionWarmup', () => {
  it('paces the batch across slices until done, threading the returned jobId', async () => {
    const seen: unknown[] = [];
    const fetchFn = batchFetch(
      [
        { available: true, jobId: 'j1', cursor: 2, total: 4, done: false },
        { available: true, jobId: 'j1', cursor: 4, total: 4, done: true },
      ],
      (b) => seen.push(b),
    );
    const result = await runSessionWarmup(req({ fetchFn, maxAssetsPerSlice: 2 }));
    expect(result).toEqual({ status: 'completed', analysed: 4, total: 4, slices: 2 });
    // First call mints the job (no jobId); the second continues it.
    expect((seen[0] as { jobId?: string }).jobId).toBeUndefined();
    expect((seen[1] as { jobId?: string }).jobId).toBe('j1');
    expect((seen[0] as { depth?: string }).depth).toBe('quick');
  });

  it('reports empty when the project has no analysable assets', async () => {
    const fetchFn = batchFetch([{ available: true, jobId: 'j1', cursor: 0, total: 0, done: true }]);
    const result = await runSessionWarmup(req({ fetchFn }));
    expect(result).toEqual({ status: 'empty', analysed: 0, total: 0, slices: 1 });
  });

  it('honestly degrades to unavailable when the brain is unreachable', async () => {
    const fetchFn = batchFetch([{ available: false, reason: 'projects_root not configured' }]);
    const result = await runSessionWarmup(req({ fetchFn }));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('projects_root');
  });

  it('reports failed on a non-2xx response', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as Response) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('500');
  });

  it('is cancellable — an aborted signal stops before the next slice', async () => {
    const controller = new AbortController();
    const fetchFn = (async () => {
      controller.abort(); // abort after the first slice returns
      return {
        ok: true,
        status: 200,
        json: async () => ({ available: true, jobId: 'j1', cursor: 2, total: 10, done: false }),
      } as Response;
    }) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn, signal: controller.signal }));
    expect(result.status).toBe('cancelled');
    expect(result.analysed).toBe(2);
  });

  it('treats a thrown fetch during abort as cancelled, not failed', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = (async () => {
      throw new Error('aborted');
    }) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn, signal: controller.signal }));
    expect(result.status).toBe('cancelled');
  });

  it('reports failed on a transport error when not aborted', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('stops at the slice backstop instead of looping forever', async () => {
    // Engine that never reports done → the backstop must trip.
    const fetchFn = batchFetch([
      { available: true, jobId: 'j1', cursor: 1, total: 999, done: false },
    ]);
    const progress = vi.fn();
    const result = await runSessionWarmup(req({ fetchFn, maxSlices: 3, onProgress: progress }));
    expect(result.status).toBe('failed');
    expect(result.slices).toBe(3);
    expect(result.reason).toContain('3 slices');
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it('falls back to the global fetch when no fetchFn is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = batchFetch([
      { available: true, jobId: 'j1', cursor: 1, total: 1, done: true },
    ]);
    try {
      const result = await runSessionWarmup(req());
      expect(result.status).toBe('completed');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends an inline project instead of a path when no projectPath is given', async () => {
    const seen: unknown[] = [];
    const fetchFn = batchFetch(
      [{ available: true, jobId: 'j1', cursor: 1, total: 1, done: true }],
      (b) => seen.push(b),
    );
    const result = await runSessionWarmup({
      baseUrl: 'http://127.0.0.1:8765',
      projectId: 'p1',
      project: { id: 'p1' },
      fetchFn,
    });
    expect(result.status).toBe('completed');
    expect((seen[0] as { project?: unknown }).project).toEqual({ id: 'p1' });
    expect((seen[0] as { project_path?: unknown }).project_path).toBeUndefined();
  });

  it('reports failed (not cancelled) on a transport error when a signal exists but was never aborted', async () => {
    const controller = new AbortController();
    const fetchFn = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn, signal: controller.signal }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('ECONNRESET');
  });

  it('stringifies a thrown non-Error value when reporting a transport failure', async () => {
    const controller = new AbortController();
    const fetchFn = (async () => {
      throw 'ECONNRESET';
    }) as unknown as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn, signal: controller.signal }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('ECONNRESET');
  });

  it('treats a mid-flight abort (signal aborts during the in-flight fetch) as cancelled', async () => {
    const controller = new AbortController();
    const fetchFn = (async () => {
      // The pre-loop check above hasn't seen the abort yet — it lands while this
      // "request" is in flight, same as a caller-triggered Stop mid-call.
      controller.abort();
      throw new Error('aborted mid-flight');
    }) as typeof fetch;
    const result = await runSessionWarmup(req({ fetchFn, signal: controller.signal }));
    expect(result.status).toBe('cancelled');
  });

  it('degrades to unavailable without a reason when the brain omits one', async () => {
    const fetchFn = batchFetch([{ available: false }]);
    const result = await runSessionWarmup(req({ fetchFn }));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBeUndefined();
  });

  it('carries the cursor/total forward and defaults a missing done to false', async () => {
    const fetchFn = batchFetch([
      { available: true, jobId: 'j1', cursor: 2, total: 4 }, // `done` omitted → not done
      { available: true, jobId: 'j1', done: true }, // `cursor`/`total` omitted → carried over
    ]);
    const progress = vi.fn();
    const result = await runSessionWarmup(
      req({ fetchFn, maxAssetsPerSlice: 2, onProgress: progress }),
    );
    expect(result).toEqual({ status: 'completed', analysed: 2, total: 4, slices: 2 });
    // The first slice omits `done` — the callback must still see an explicit `false`.
    expect(progress).toHaveBeenNthCalledWith(1, { cursor: 2, total: 4, done: false });
  });
});
