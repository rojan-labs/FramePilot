import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import {
  chunkTemporalRequests,
  createTemporalEvidenceAcquirer,
  estimatedBatchDeadline,
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
    expect(results.renderSettings.identity).toBe('temporal-evidence:1920x1080@30:captions=true');
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

  /**
   * Run `19e20922`: "Review could not run: Temporal evidence acquisition timed out after
   * 300000ms" on the run's LAST turn, so the edits shipped perceptually unchecked. The
   * engine serializes one batch at a time, so a big plan waits behind an export and
   * another run's batch before it renders anything — and a deadline that ignores the size
   * of the plan discards every frame already rendered.
   */
  describe('estimatedBatchDeadline', () => {
    const sweep: TemporalEvidenceRequest = {
      schemaVersion: 1,
      requestId: 'sweep',
      projectRevision: 0,
      reason: 'Whole programme',
      kind: 'range',
      startFrame: 0,
      endFrame: 300,
      sampleEveryFrames: 10,
      checks: ['black_frames'],
    };
    const scope: TemporalEvidenceRequest = {
      schemaVersion: 1,
      requestId: 'scope',
      projectRevision: 0,
      reason: 'Legal range',
      kind: 'scope',
      startFrame: 0,
      endFrame: 30,
      channels: ['luma'],
      legalMin: 0,
      legalMax: 1,
    };

    it('never gives a batch less than the old fixed deadline', () => {
      expect(estimatedBatchDeadline([request])).toBeGreaterThanOrEqual(300_000);
    });

    it('grows with the frames the batch renders', () => {
      // 30 sampled frames x 726 ms measured x 3 headroom on top of the 300 s floor.
      expect(estimatedBatchDeadline([sweep])).toBe(300_000 + 3 * 30 * 726);
      expect(estimatedBatchDeadline([sweep, sweep])).toBeGreaterThan(
        estimatedBatchDeadline([sweep]),
      );
    });

    it('scales with the size the engine will render at', () => {
      const small = { width: 320, height: 180 };
      const vertical = { width: 1080, height: 1920 };
      const uhd = { width: 3840, height: 2160 };
      // Review frames are capped at 960 on the long side, so 1080x1920 renders at the
      // measured 540x960 and a 4K project costs no more per review frame.
      expect(estimatedBatchDeadline([sweep], vertical)).toBe(estimatedBatchDeadline([sweep]));
      expect(estimatedBatchDeadline([sweep], uhd)).toBe(estimatedBatchDeadline([sweep], vertical));
      expect(estimatedBatchDeadline([sweep], small)).toBeLessThan(
        estimatedBatchDeadline([sweep], vertical),
      );
      // Scope frames are measured at FULL resolution, so there 4K is dearer.
      expect(estimatedBatchDeadline([scope], uhd)).toBeGreaterThan(
        estimatedBatchDeadline([scope], vertical),
      );
    });

    it('is bounded above however large the batch', () => {
      const huge = Array.from({ length: 64 }, (_, index) => ({ ...sweep, requestId: `s${index}` }));
      expect(estimatedBatchDeadline(huge)).toBe(900_000);
    });
  });

  describe('chunked acquisition', () => {
    const frameAt = (atFrame: number): TemporalEvidenceRequest => ({
      ...request,
      requestId: `f${atFrame}`,
      atFrame,
    });
    const requests = Array.from({ length: 20 }, (_, index) => frameAt(index * 10));
    const resultFor = (item: TemporalEvidenceRequest) => ({
      schemaVersion: 1,
      requestId: item.requestId,
      projectRevision: 0,
      kind: 'frame',
      renderSettings,
      sample: { frame: item.kind === 'frame' ? item.atFrame : 0, luma: 0.4, blackRatio: 0 },
    });
    const reply = (json: unknown): Response =>
      ({ ok: true, status: 200, json: async () => json, text: async () => '' }) as Response;
    const sentRequests = (init?: RequestInit): TemporalEvidenceRequest[] =>
      (JSON.parse(String(init?.body)) as { requests: TemporalEvidenceRequest[] }).requests;

    it('splits a plan into small calls in plan order, and merges them whole', () => {
      const chunks = chunkTemporalRequests(requests);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.flat()).toEqual(requests);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8);
    });

    it('sends a request bigger than a chunk alone, and a mix measurement alone', () => {
      const wide: TemporalEvidenceRequest = {
        ...request,
        requestId: 'wide',
        kind: 'range',
        startFrame: 0,
        endFrame: 100,
        sampleEveryFrames: 1,
        checks: ['black_frames'],
      } as TemporalEvidenceRequest;
      const mix: TemporalEvidenceRequest = {
        schemaVersion: 1,
        requestId: 'mix',
        projectRevision: 0,
        reason: 'Mix',
        kind: 'audio',
        startFrame: 0,
        endFrame: 30,
        channels: 'mix',
        maxPeakDbfs: -1,
        maxBoundaryJumpDb: 6,
      };
      const chunks = chunkTemporalRequests([frameAt(0), wide, mix, frameAt(5)]);
      expect(chunks.map((chunk) => chunk.map((item) => item.requestId))).toEqual([
        ['f0'],
        ['wide'],
        ['mix'],
        ['f5'],
      ]);
    });

    it('returns every result and no incompleteness when every call lands', async () => {
      let calls = 0;
      const acquire = createTemporalEvidenceAcquirer({
        baseUrl: 'http://engine',
        fetchFn: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          return reply({ renderSettings, results: sentRequests(init).map(resultFor) });
        }) as unknown as typeof fetch,
      });
      const batch = await acquire(makeProject(), requests);
      expect(calls).toBe(chunkTemporalRequests(requests).length);
      expect(batch.results.map((result) => result.requestId)).toEqual(
        requests.map((item) => item.requestId),
      );
      expect(batch.incomplete).toBeUndefined();
    });

    it('keeps what landed when the deadline passes mid-way', async () => {
      let calls = 0;
      const acquire = createTemporalEvidenceAcquirer({
        baseUrl: 'http://engine',
        timeoutMs: 30,
        fetchFn: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          if (calls === 1)
            return reply({ renderSettings, results: sentRequests(init).map(resultFor) });
          // Every later call waits behind the queue until the deadline aborts it.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }) as unknown as typeof fetch,
      });
      const batch = await acquire(makeProject(), requests);
      const firstChunk = chunkTemporalRequests(requests)[0]!;
      expect(batch.results.map((result) => result.requestId)).toEqual(
        firstChunk.map((item) => item.requestId),
      );
      expect(batch.incomplete).toMatch(
        new RegExp(
          `${requests.length - firstChunk.length} of ${requests.length} .*timed out after 30ms`,
        ),
      );
    });

    it('keeps the other chunks when one call fails, and says which failed', async () => {
      let calls = 0;
      const acquire = createTemporalEvidenceAcquirer({
        baseUrl: 'http://engine',
        fetchFn: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          if (calls === 2)
            return {
              ok: false,
              status: 422,
              json: async () => ({}),
              text: async () => JSON.stringify({ detail: 'reaches past the timeline end' }),
            } as Response;
          return reply({ renderSettings, results: sentRequests(init).map(resultFor) });
        }) as unknown as typeof fetch,
      });
      const chunks = chunkTemporalRequests(requests);
      const batch = await acquire(makeProject(), requests);
      const failedIds = new Set(chunks[1]!.map((item) => item.requestId));
      expect(batch.results.map((result) => result.requestId)).toEqual(
        requests.filter((item) => !failedIds.has(item.requestId)).map((item) => item.requestId),
      );
      expect(batch.incomplete).toMatch(
        /failed \(Temporal evidence engine rejected the batch \(422\)/,
      );
    });

    it('still fails closed when nothing came back', async () => {
      const acquire = createTemporalEvidenceAcquirer({
        baseUrl: 'http://engine',
        fetchFn: fetchStub({ ok: false, status: 503, text: 'sidecar down' }),
      });
      await expect(acquire(makeProject(), requests)).rejects.toThrow(/rejected the batch \(503\)/);
    });

    it('throws on cancellation even after some chunks landed', async () => {
      const controller = new AbortController();
      let calls = 0;
      const acquire = createTemporalEvidenceAcquirer({
        baseUrl: 'http://engine',
        fetchFn: (async (_url: unknown, init?: RequestInit) => {
          calls += 1;
          if (calls === 1)
            return reply({ renderSettings, results: sentRequests(init).map(resultFor) });
          controller.abort();
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            if (init?.signal?.aborted) reject(new Error('aborted'));
          });
        }) as unknown as typeof fetch,
      });
      await expect(acquire(makeProject(), requests, controller.signal)).rejects.toThrow(
        'Temporal evidence acquisition was cancelled.',
      );
    });
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
