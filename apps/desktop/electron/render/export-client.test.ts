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

  it('reports a lost job when a mid-poll status check fails', async () => {
    const jobId = 'job-4';
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE}/render` && init?.method === 'POST') {
        return jsonResponse({ jobId, status: 'queued' }, true, 202);
      }
      if (url === `${BASE}/render/jobs/${jobId}`) {
        return jsonResponse('gone', false, 404);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await exportViaSidecar(
      BASE,
      { projectPath: '/p/project.fp.json' },
      fetchFn as unknown as typeof fetch,
      { sleepFn: noSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(jobId);
  });
});
