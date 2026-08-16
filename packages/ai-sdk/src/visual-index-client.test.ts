/**
 * Tests for the visual-index client (plan MI4.2): schema parsing, the
 * injectable-fetch client's honest degradation on every failure path, and the
 * paced-loop driver's terminal-signal handling (done, no-key, cancelled, keys
 * failing, unreachable, abort). Fully offline — no sidecar, no NVIDIA.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  VisualIndexClient,
  runVisualIndexLoop,
  visualIndexResponseSchema,
  visualStatusResponseSchema,
  type VisualIndexRequestInput,
  type VisualIndexResponse,
} from './visual-index-client.js';

const BASE = 'http://127.0.0.1:8765';

/** A fetch stub that records the request and replies with the given response. */
function fetchStub(
  reply: { ok: boolean; status?: number; json?: unknown },
  onRequest?: (url: string, init?: RequestInit) => void,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(url), init);
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.json,
    } as Response;
  }) as typeof fetch;
}

/** A fetch stub that replies with each queued response in turn (for the loop). */
function fetchQueue(replies: readonly unknown[]): { fetchFn: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const json = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => json } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('schemas', () => {
  it('defaults absent status fields to honest zeros/empties', () => {
    expect(visualStatusResponseSchema.parse({ available: false, reason: 'no root' })).toEqual({
      available: false,
      reason: 'no root',
      counts: {},
      indexedAssets: 0,
      totalAssets: 0,
      keyConfigured: false,
    });
  });

  it('parses a full index slice response with items', () => {
    const parsed = visualIndexResponseSchema.parse({
      available: true,
      jobId: 'job-1',
      cursor: 1,
      total: 3,
      done: false,
      indexed: 12,
      captioned: 2,
      items: [{ assetId: 'a1', ok: true, indexed: 12, captioned: 2 }],
    });
    expect(parsed.jobId).toBe('job-1');
    expect(parsed.items).toHaveLength(1);
  });
});

describe('VisualIndexClient', () => {
  it('GETs /brain/visual/status with the project id', async () => {
    let seenUrl = '';
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub(
        { ok: true, json: { available: true, indexedAssets: 2, totalAssets: 4 } },
        (url) => {
          seenUrl = url;
        },
      ),
    });
    const status = await client.status('p1');
    expect(seenUrl).toBe(`${BASE}/brain/visual/status?projectId=p1`);
    expect(status?.available).toBe(true);
    expect(status?.indexedAssets).toBe(2);
  });

  it('POSTs the index body verbatim (camelCase) to /brain/visual/index', async () => {
    let seenUrl = '';
    let seenBody = '';
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub(
        { ok: true, json: { available: true, jobId: 'j', done: true } },
        (url, init) => {
          seenUrl = url;
          seenBody = String(init?.body);
        },
      ),
    });
    await client.index({ projectId: 'p1', assetIds: ['a1'], nvidiaKeys: 'nvapi-x' });
    expect(seenUrl).toBe(`${BASE}/brain/visual/index`);
    expect(JSON.parse(seenBody)).toEqual({
      projectId: 'p1',
      assetIds: ['a1'],
      nvidiaKeys: 'nvapi-x',
    });
  });

  it('forwards a twelveLabsKey in the index body (TwelveLabs backend)', async () => {
    let seenBody = '';
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub(
        { ok: true, json: { available: true, jobId: 'j', done: true } },
        (_url, init) => {
          seenBody = String(init?.body);
        },
      ),
    });
    await client.index({ projectId: 'p1', twelveLabsKey: 'tlk-secret' });
    expect(JSON.parse(seenBody)).toEqual({ projectId: 'p1', twelveLabsKey: 'tlk-secret' });
  });

  it('POSTs the footage-map body to /brain/visual/footage-map (FI3.1)', async () => {
    let seenUrl = '';
    let seenBody = '';
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub(
        { ok: true, json: { available: true, chapters: [{ t0: 0, t1: 10, title: 'Intro' }] } },
        (url, init) => {
          seenUrl = url;
          seenBody = String(init?.body);
        },
      ),
    });
    const map = await client.footageMap({ projectId: 'p1', refresh: true });
    expect(seenUrl).toBe(`${BASE}/brain/visual/footage-map`);
    expect(JSON.parse(seenBody)).toEqual({ projectId: 'p1', refresh: true });
    expect(map?.chapters).toHaveLength(1);
  });

  it('degrades footageMap to undefined on a transport failure', async () => {
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub({ ok: false, status: 500 }),
    });
    expect(await client.footageMap({ projectId: 'p1' })).toBeUndefined();
  });

  it('routes index() through an injected indexFn (desktop transport) instead of fetch, stripping captionProvider', async () => {
    let seenInput: unknown;
    const indexFn = vi.fn(async (input: unknown) => {
      seenInput = input;
      return { available: true, jobId: 'desktop-job', done: true };
    });
    const client = new VisualIndexClient({ baseUrl: BASE, indexFn });
    const result = await client.index({
      projectId: 'p1',
      assetIds: ['a1'],
      captionProvider: { kind: 'openai', model: 'vision-x', apiKey: 'secret' },
    });
    expect(indexFn).toHaveBeenCalledTimes(1);
    expect(seenInput).toEqual({ projectId: 'p1', assetIds: ['a1'] });
    expect(result?.jobId).toBe('desktop-job');
  });

  it('POSTs the cancel body to /brain/visual/index/cancel', async () => {
    let seenUrl = '';
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub(
        { ok: true, json: { available: true, jobId: 'j', state: 'failed' } },
        (url) => {
          seenUrl = url;
        },
      ),
    });
    const res = await client.cancel({ projectId: 'p1', jobId: 'j' });
    expect(seenUrl).toBe(`${BASE}/brain/visual/index/cancel`);
    expect(res?.state).toBe('failed');
  });

  it('degrades to undefined on HTTP error, malformed payload, and a thrown fetch', async () => {
    const httpError = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub({ ok: false, status: 500 }),
    });
    expect(await httpError.status('p1')).toBeUndefined();

    const malformed = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub({ ok: true, json: { available: 'not-a-bool' } }),
    });
    expect(await malformed.status('p1')).toBeUndefined();

    const threw = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await threw.index({ projectId: 'p1' })).toBeUndefined();

    const threwString = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: (async () => {
        throw 'plain string failure';
      }) as typeof fetch,
    });
    expect(await threwString.status('p1')).toBeUndefined();
  });

  it('binds the default (unconfigured) fetch to globalThis so calling it as `this.fetchFn(...)` does not throw "Illegal invocation"', async () => {
    // Real browsers' native fetch is brand-checked: calling it with `this` set
    // to anything other than the global object throws "Illegal invocation".
    // Storing an unbound `fetch` reference as a class field and invoking it via
    // `this.fetchFn(...)` rebinds `this` to the client instance and trips this
    // check — Node's fetch does not enforce it, so this stub reproduces the
    // real-browser failure mode a plain `vi.stubGlobal('fetch', vi.fn())` would
    // silently pass even with the bug present.
    const brandCheckedFetch = function (this: unknown): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ available: true }),
      } as Response);
    };
    vi.stubGlobal('fetch', brandCheckedFetch);

    const client = new VisualIndexClient({ baseUrl: BASE });
    const result = await client.status('p1');

    expect(result?.available).toBe(true);
    vi.unstubAllGlobals();
  });

  it('aborts the request when an external signal is already aborted', async () => {
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { ok: true, status: 200, json: async () => ({ available: true }) } as Response;
      }) as typeof fetch,
    });
    expect(await client.status('p1', AbortSignal.abort())).toBeUndefined();
  });

  it('completes normally with an external signal that never fires, cleaning up its listener', async () => {
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: fetchStub({ ok: true, json: { available: true, indexedAssets: 1, totalAssets: 1 } }),
    });
    const controller = new AbortController();
    const status = await client.status('p1', controller.signal);
    expect(status?.available).toBe(true);
  });

  it('gives an index slice a longer timeout than status (large uploads take minutes)', async () => {
    vi.useFakeTimers();
    // Never resolves on its own — only the client's own timeout can abort it,
    // so the abort time reveals which per-route bound the client applied.
    const hangUntilAbort = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      })) as typeof fetch;
    const client = new VisualIndexClient({
      baseUrl: BASE,
      fetchFn: hangUntilAbort,
      timeoutMs: 1_000,
      indexTimeoutMs: 10_000,
    });

    const statusP = client.status('p1');
    const indexP = client.index({ projectId: 'p1' });
    // At the short bound, status has aborted but the index slice is still in flight.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await statusP).toBeUndefined();
    // Only at the far longer index bound does the slice abort.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await indexP).toBeUndefined();
    vi.useRealTimers();
  });
});

const request: VisualIndexRequestInput = { projectId: 'p1', nvidiaKeys: 'nvapi-x' };

describe('runVisualIndexLoop', () => {
  it('re-POSTs with the returned jobId until done', async () => {
    const slices: VisualIndexResponse[] = [
      {
        available: true,
        jobId: 'j1',
        cursor: 1,
        total: 3,
        done: false,
        indexed: 4,
        captioned: 0,
        items: [],
      },
      {
        available: true,
        jobId: 'j1',
        cursor: 2,
        total: 3,
        done: false,
        indexed: 4,
        captioned: 0,
        items: [],
      },
      {
        available: true,
        jobId: 'j1',
        cursor: 3,
        total: 3,
        done: true,
        indexed: 4,
        captioned: 0,
        items: [],
      },
    ];
    const { fetchFn, calls } = fetchQueue(slices);
    const seen: number[] = [];
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
      onSlice: (r) => seen.push(r.cursor),
    });
    expect(result.status).toBe('done');
    expect(result.jobId).toBe('j1');
    expect(seen).toEqual([1, 2, 3]);
    // First call omits jobId (start); later calls carry it (continue).
    expect(JSON.parse(String(calls[0]?.body)).jobId).toBeUndefined();
    expect(JSON.parse(String(calls[1]?.body)).jobId).toBe('j1');
  });

  it('reports no-key when the engine returns available with no jobId (one iteration)', async () => {
    const { fetchFn, calls } = fetchQueue([
      { available: true, reason: 'no NVIDIA embedding key configured' },
    ]);
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('no-key');
    expect(calls).toHaveLength(1);
  });

  it('reports unavailable when the engine reports available:false', async () => {
    const { fetchFn } = fetchQueue([{ available: false, reason: 'no sandbox root' }]);
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('unavailable');
  });

  it('reports keys-failing when a slice reason is all_keys_failing', async () => {
    const { fetchFn } = fetchQueue([
      {
        available: true,
        jobId: 'j1',
        cursor: 1,
        total: 3,
        done: false,
        reason: 'all_keys_failing',
      },
    ]);
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('keys-failing');
  });

  it('reports cancelled when a slice reason is cancelled', async () => {
    const { fetchFn } = fetchQueue([
      { available: true, jobId: 'j1', cursor: 1, total: 3, done: false, reason: 'cancelled' },
    ]);
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('cancelled');
  });

  it('reports unreachable when a slice cannot be fetched', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('unreachable');
  });

  it('reports unreachable mid-loop, carrying the jobId and last slice already seen', async () => {
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, jobId: 'j1', cursor: 1, total: 5, done: false }),
        } as Response;
      }
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
    });
    expect(result.status).toBe('unreachable');
    expect(result.jobId).toBe('j1');
    expect(result.last?.cursor).toBe(1);
  });

  it('cancels immediately, with no jobId/last, when the signal is already aborted before any slice runs', async () => {
    const cancel = vi.fn();
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes('/cancel')) {
        cancel();
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, jobId: 'j1', state: 'ok' }),
        } as Response;
      }
      throw new Error('should never slice — already aborted');
    }) as typeof fetch;
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
      signal: AbortSignal.abort(),
    });
    expect(result.status).toBe('cancelled');
    expect(result.jobId).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('exhausts immediately with no jobId/last when maxSlices is 0', async () => {
    const fetchFn = (async () => {
      throw new Error('should never be called');
    }) as typeof fetch;
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
      maxSlices: 0,
    });
    expect(result.status).toBe('exhausted-slices');
    expect(result.jobId).toBeUndefined();
    expect(result.last).toBeUndefined();
  });

  it('cancels the in-flight job and reports cancelled when the signal aborts', async () => {
    const cancel = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ available: true, jobId: 'j1', state: 'failed' }),
        }) as Response,
    );
    const controller = new AbortController();
    let call = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes('/cancel')) return cancel();
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, jobId: 'j1', cursor: 1, total: 5, done: false }),
        } as Response;
      }
      controller.abort();
      return {
        ok: true,
        status: 200,
        json: async () => ({ available: true, jobId: 'j1', cursor: 2, total: 5, done: false }),
      } as Response;
    }) as typeof fetch;
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops at the slice safety bound without spinning forever', async () => {
    const { fetchFn } = fetchQueue([
      // A pathological engine that never advances to done and never sets a reason.
      { available: true, jobId: 'j1', cursor: 1, total: 5, done: false },
    ]);
    const result = await runVisualIndexLoop({
      client: new VisualIndexClient({ baseUrl: BASE, fetchFn }),
      request,
      maxSlices: 3,
    });
    expect(result.status).toBe('exhausted-slices');
  });
});
