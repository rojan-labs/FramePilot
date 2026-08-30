import { describe, expect, it, vi } from 'vitest';
import { exportViaSidecar } from './export-client.js';

const BASE = 'http://127.0.0.1:8765';

/** A `fetch` stub returning a JSON body with a given status. */
const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

/** A no-op sleep so poll-loop tests run instantly instead of waiting on real timers. */
const noSleep = async (): Promise<void> => {};

describe('exportViaSidecar — /render/preview (unchanged synchronous contract)', () => {
  it('POSTs to /render/preview when preview is requested, defaulting settings/captions', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ state: 'completed', output_path: '/p/preview.mp4' }),
    );
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, outputPath: '/p/preview.mp4', state: 'completed' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${BASE}/render/preview`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      project_path: '/p/project.fp.json',
      settings: null,
      burn_captions: false,
      denoise: false,
      eq: null,
      compression: null,
      loudness: null,
      limiter: false,
    });
  });

  it('reports a failed preview render job as an error', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ state: 'failed', error: 'black frames detected' }),
    );
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: 'black frames detected' });
  });

  it('carries the raw encoder text as detail behind the plain error line (P7.6)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        state: 'failed',
        error: "The video encoder failed. Open details for the encoder's own message.",
        error_detail: 'ffmpeg: Error while opening encoder for output stream #0:0',
      }),
    );
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toMatchObject({
      ok: false,
      error: "The video encoder failed. Open details for the encoder's own message.",
      detail: 'ffmpeg: Error while opening encoder for output stream #0:0',
    });
  });

  it('maps a non-2xx preview response to an error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse('project not found', false, 400));
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/missing.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('400');
  });

  it('maps a transport failure (sidecar down) to an error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('exportViaSidecar — /render (async submit + poll contract, H1.3a)', () => {
  it('submits, polls queued → running → completed, and reports every transition', async () => {
    const jobId = 'job-1';
    const statuses = ['queued', 'running', 'running', 'completed'];
    let getCallIndex = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        const status = statuses[getCallIndex]!;
        getCallIndex += 1;
        const isTerminal = status === 'completed';
        return jsonResponse({
          id: jobId,
          status,
          attempts: 1,
          error: null,
          result: isTerminal ? { state: 'completed', output_path: '/p/out.mp4' } : null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const onProgress = vi.fn();
    const result = await exportViaSidecar(
      BASE,
      {
        projectPath: '/p/project.fp.json',
        settings: {
          resolution: '1080p',
          fps: 'source',
          quality: 'recommended',
          videoCodec: 'h264',
          container: 'mp4',
        },
        burnCaptions: true,
      },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep, onProgress },
    );

    expect(result).toEqual({ ok: true, outputPath: '/p/out.mp4', state: 'completed' });
    expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
      { jobId, status: 'queued' },
      { jobId, status: 'queued' },
      { jobId, status: 'running' },
      { jobId, status: 'running' },
      { jobId, status: 'completed' },
    ]);

    const [postUrl, postInit] = fetchFn.mock.calls[0]!;
    expect(postUrl).toBe(`${BASE}/render`);
    expect(JSON.parse((postInit as RequestInit).body as string)).toEqual({
      project_path: '/p/project.fp.json',
      settings: {
        resolution: '1080p',
        fps: 'source',
        quality: 'recommended',
        video_codec: 'h264',
        container: 'mp4',
      },
      burn_captions: true,
      denoise: false,
      eq: null,
      compression: null,
      loudness: null,
      limiter: false,
    });
  });

  it('reports a failed job (terminal status=failed) as an error', async () => {
    const jobId = 'job-2';
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        return jsonResponse({
          id: jobId,
          status: 'failed',
          attempts: 1,
          error: 'black frames detected',
          result: { state: 'failed', error: 'black frames detected' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep },
    );
    expect(result).toEqual({ ok: false, error: 'black frames detected' });
  });

  it('cancels via POST /render/jobs/{id}/cancel when the signal aborts mid-poll', async () => {
    const jobId = 'job-3';
    const controller = new AbortController();
    let cancelCalled = false;
    let pollCount = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}/cancel`) {
        cancelCalled = true;
        return jsonResponse({ id: jobId, status: 'cancelled', attempts: 1, result: null });
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        pollCount += 1;
        if (pollCount === 1) {
          // First poll: still running — this is when the caller decides to abort.
          controller.abort();
          return jsonResponse({ id: jobId, status: 'running', attempts: 1, result: null });
        }
        // After cancel, the sidecar reports the job as cancelled.
        return jsonResponse({
          id: jobId,
          status: 'cancelled',
          attempts: 1,
          error: null,
          result: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const onProgress = vi.fn();
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep, onProgress, signal: controller.signal },
    );

    expect(cancelCalled).toBe(true);
    expect(result).toEqual({ ok: false, error: 'Export cancelled.' });
    expect(onProgress.mock.calls.at(-1)?.[0]).toEqual({ jobId, status: 'cancelled' });
  });

  it('maps a non-202 response from /render to an error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse('project not found', false, 400));
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/missing.fp.json' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('400');
  });

  it('maps a transport failure submitting /render to an error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });

  it('reports a lost job only after three consecutive failed status checks, and cancels it', async () => {
    // FM-5: this used to give up after ONE null — including a 503 while the sidecar
    // restarts under its own supervision — and left the job running, so ffmpeg finished
    // and wrote the output while the user was told the export had failed.
    const jobId = 'job-4';
    let statusCalls = 0;
    let cancelCalled = false;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}/cancel`) {
        cancelCalled = true;
        return jsonResponse({ id: jobId, status: 'cancelled' });
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        statusCalls += 1;
        return jsonResponse('service unavailable', false, 503);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep },
    );

    expect(statusCalls).toBe(3);
    expect(cancelCalled).toBe(true); // the job is stopped, not abandoned mid-render
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(jobId);
  });

  it('rides out a transient status failure and still completes the export', async () => {
    // The sidecar manager restarts a dead engine on its own; an export must be at least
    // as patient as the recovery it is racing.
    const jobId = 'job-5';
    const statuses: (string | null)[] = ['running', null, null, 'completed'];
    let index = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        const status = statuses[index] ?? 'completed';
        index += 1;
        if (status === null) return jsonResponse('service unavailable', false, 503);
        return jsonResponse({
          id: jobId,
          status,
          result: status === 'completed' ? { state: 'completed', output_path: '/p/out.mp4' } : null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep },
    );

    expect(result).toEqual({ ok: true, outputPath: '/p/out.mp4', state: 'completed' });
  });
});

describe('exportViaSidecar — request bounding (FM-2)', () => {
  it('wires the caller signal into the submit request and the status polls', async () => {
    // A `signal?.aborted` check BETWEEN poll iterations never observes an abort raised
    // while awaiting a hung request. The signal has to reach `fetch` itself.
    const jobId = 'job-6';
    const controller = new AbortController();
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        seen.push(init.signal);
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        seen.push(init?.signal);
        return jsonResponse({
          id: jobId,
          status: 'completed',
          result: { state: 'completed', output_path: '/p/out.mp4' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep, signal: controller.signal },
    );

    expect(seen).toHaveLength(2);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('observes an abort raised while a status request is still in flight', async () => {
    const jobId = 'job-7';
    const controller = new AbortController();
    let cancelCalled = false;
    let statusCalls = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}/cancel`) {
        cancelCalled = true;
        return jsonResponse({ id: jobId, status: 'cancelled' });
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        statusCalls += 1;
        if (statusCalls > 1) {
          // The confirming read AFTER cancel deliberately carries no caller signal.
          expect(init?.signal?.aborted).toBe(false);
          return jsonResponse({ id: jobId, status: 'cancelled', result: null });
        }
        // Hang until the request's own signal aborts — the abort is raised only once we
        // are already awaiting, which the old between-iterations check could never see.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep, signal: controller.signal },
    );

    expect(cancelCalled).toBe(true);
    expect(result).toEqual({ ok: false, error: 'Export cancelled.' });
  });

  it('reports an abort during the submit itself as a cancellation, not a render failure', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        }),
    );

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep, signal: controller.signal },
    );

    expect(result).toEqual({ ok: false, error: 'Export cancelled.' });
  });

  it('leaves /render/preview unbounded — it is a full render on that one request', async () => {
    // A submit-sized deadline here would abort real encoding work mid-flight.
    const fetchFn = vi.fn(async () =>
      jsonResponse({ state: 'completed', output_path: '/p/preview.mp4' }),
    );

    await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json', preview: true },
      fetchFn as unknown as typeof fetch,
    );

    const init = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeUndefined();
  });
});
