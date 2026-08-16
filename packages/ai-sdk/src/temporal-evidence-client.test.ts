import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import {
  createTemporalEvidenceAcquirer,
  TemporalEvidenceClientError,
} from './temporal-evidence-client.js';
import type { TemporalEvidenceRequest } from './temporal-review.js';

const request: TemporalEvidenceRequest = {
  schemaVersion: 1,
  requestId: 'opening',
  projectRevision: 0,
  reason: 'Program opening',
  kind: 'frame',
  atFrame: 0,
  metrics: ['luma', 'black_ratio'],
};

const renderSettings = {
  identity: 'temporal-evidence:1920x1080@30:captions=true',
  presetId: 'temporal-evidence',
  width: 1920,
  height: 1080,
  fps: 30,
  burnCaptions: true,
} as const;

function fetchStub(
  reply: { ok: boolean; status?: number; json?: unknown; text?: string },
  onRequest?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(String(url), init ?? {});
    return {
      ok: reply.ok,
      status: reply.status ?? (reply.ok ? 200 : 500),
      json: async () => reply.json,
      text: async () => reply.text ?? '',
    } as Response;
  }) as typeof fetch;
}

describe('createTemporalEvidenceAcquirer', () => {
  it('posts the stripped working project and parses strict evidence results', async () => {
    let seen: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchStub(
        {
          ok: true,
          json: {
            renderSettings,
            results: [
              {
                schemaVersion: 1,
                requestId: 'opening',
                projectRevision: 0,
                kind: 'frame',
                renderSettings,
                sample: { frame: 0, luma: 0.4, blackRatio: 0 },
              },
            ],
          },
        },
        (url, init) => {
          seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        },
      ),
    });

    const results = await acquire(makeProject(), [request]);

    expect(seen.url).toBe('http://engine/review/temporal-evidence');
    expect(seen.body.requests).toEqual([request]);
    expect(seen.body.project).toMatchObject({ id: 'proj_1' });
    expect(results.renderSettings.identity).toBe(
      'temporal-evidence:1920x1080@30:captions=true',
    );
    expect(results.results[0]).toMatchObject({ requestId: 'opening', kind: 'frame' });
  });

  it('fails closed on an engine rejection with a bounded human detail', async () => {
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchStub({
        ok: false,
        status: 422,
        text: JSON.stringify({ detail: 'Requested revision is stale.' }),
      }),
    });

    await expect(acquire(makeProject(), [request])).rejects.toThrow(
      'engine rejected the batch (422): Requested revision is stale.',
    );
  });

  it('rejects malformed success payloads instead of fabricating evidence', async () => {
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchStub({ ok: true, json: { results: [{ kind: 'frame' }] } }),
    });

    await expect(acquire(makeProject(), [request])).rejects.toThrow(/did not match/i);
  });

  it('rejects render identities that contradict their settings', async () => {
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: fetchStub({
        ok: true,
        json: {
          renderSettings: {
            identity: 'temporal-evidence:640x360@30:captions=true',
            presetId: 'temporal-evidence',
            width: 1920,
            height: 1080,
            fps: 30,
            burnCaptions: true,
          },
          results: [],
        },
      }),
    });

    await expect(acquire(makeProject(), [request])).rejects.toThrow(/did not match/i);
  });

  it('honors cancellation and removes the request from the verification path', async () => {
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const acquire = createTemporalEvidenceAcquirer({ baseUrl: 'http://engine', fetchFn: hanging });
    const controller = new AbortController();
    const pending = acquire(makeProject(), [request], controller.signal);
    controller.abort();

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<TemporalEvidenceClientError>>({
        name: 'TemporalEvidenceClientError',
        message: 'Temporal evidence acquisition was cancelled.',
      }),
    );
  });

  it('bounds a hung engine call with an explicit timeout failure', async () => {
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: hanging,
      timeoutMs: 5,
    });

    await expect(acquire(makeProject(), [request])).rejects.toThrow(/timed out after 5ms/i);
  });

  it('rejects an empty plan before calling the engine', async () => {
    let called = false;
    const acquire = createTemporalEvidenceAcquirer({
      baseUrl: 'http://engine',
      fetchFn: (async () => {
        called = true;
        throw new Error('must not run');
      }) as typeof fetch,
    });
    await expect(acquire(makeProject(), [])).rejects.toThrow(/non-empty plan/i);
    expect(called).toBe(false);
  });
});