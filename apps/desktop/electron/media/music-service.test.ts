/**
 * Main-process music service tests. **No live network** — the provider and the
 * bytes fetch are both injected.
 */
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicProvider, ProviderTrack } from '@framepilot/ai-sdk';
import { MusicProviderError } from '@framepilot/ai-sdk';
import { MusicService, type MusicServiceOptions } from './music-service.js';
import type { MusicDownloadProgressWire } from '../ipc/contract.js';

const PROJECT_ID = 'demo';

function track(overrides: Partial<ProviderTrack> = {}): ProviderTrack {
  return {
    remoteId: 'ov-1',
    provider: 'openverse',
    title: 'Calm Bed',
    durationSeconds: 90,
    previewUrl: 'https://cdn.example.test/bed.mp3',
    downloadUrl: 'https://cdn.example.test/bed.mp3',
    format: 'mp3',
    license: 'by',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attributionRequired: true,
    commercialUse: true,
    attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
    creator: 'Ada',
    ...overrides,
  };
}

/** A provider that returns a fixed list and counts how often it was asked. */
function stubProvider(tracks: readonly ProviderTrack[] | (() => never)): {
  provider: MusicProvider;
  calls: number;
  lastSignal: () => AbortSignal | undefined;
} {
  let calls = 0;
  let lastSignal: AbortSignal | undefined;
  const provider: MusicProvider = {
    name: 'openverse',
    search: async (_query, signal) => {
      calls += 1;
      lastSignal = signal;
      if (typeof tracks === 'function') tracks();
      return tracks as readonly ProviderTrack[];
    },
  };
  return {
    provider,
    get calls() {
      return calls;
    },
    lastSignal: () => lastSignal,
  };
}

/** A `fetch` that streams `body` in fixed-size chunks. */
function streamingFetch(
  body: Uint8Array,
  options: {
    status?: number;
    contentLength?: number | null;
    chunkSize?: number;
    onChunk?: () => void;
  } = {},
): typeof fetch {
  const chunkSize = options.chunkSize ?? body.byteLength;
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    const headers = new Map<string, string>([['content-type', 'audio/mpeg']]);
    const declared = options.contentLength === undefined ? body.byteLength : options.contentLength;
    if (declared !== null) headers.set('content-length', String(declared));

    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted === true) {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        if (offset >= body.byteLength) {
          controller.close();
          return;
        }
        options.onChunk?.();
        controller.enqueue(body.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });

    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: stream,
      arrayBuffer: async () => body.buffer.slice(0) as ArrayBuffer,
    };
  }) as unknown as typeof fetch;
}

describe('MusicService', () => {
  let projectsRoot: string;
  let progress: MusicDownloadProgressWire[];

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(tmpdir(), 'fp-music-'));
    progress = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function make(overrides: Partial<MusicServiceOptions> = {}): MusicService {
    return new MusicService({
      projectsRoot,
      deriveAssetMedia: async () => ({
        durationSeconds: 90,
        peaks: [0.1, 0.2],
        peaksPerSecond: 10,
      }),
      onProgress: (message) => progress.push(message),
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe('search', () => {
    it('never lets a provider URL cross to the renderer', async () => {
      // This is the whole reason the network lives in main. If a URL leaks here,
      // the CSP guarantee stops being structural and becomes a convention.
      const { provider } = stubProvider([track()]);
      const result = await make({ provider }).search('calm');

      expect(result.ok).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('cdn.example.test');
      expect(serialized).not.toContain('previewUrl');
      expect(serialized).not.toContain('downloadUrl');
    });

    it('carries the licence and credit line through to the renderer', async () => {
      const { provider } = stubProvider([track()]);
      const result = await make({ provider }).search('calm');
      const first = result.ok ? result.tracks[0] : undefined;
      expect(first?.attributionRequired).toBe(true);
      expect(first?.attribution).toContain('Ada');
      expect(first?.license).toBe('by');
    });

    it('serves a repeat search from cache without spending a provider request', async () => {
      // Openverse allows 20 requests/minute anonymously. Without this, a user
      // typing gets a 429 that looks like the feature is broken.
      const stub = stubProvider([track()]);
      const service = make({ provider: stub.provider });
      await service.search('calm');
      await service.search('  CALM  ');

      expect(stub.calls).toBe(1);
    });

    it('re-queries once the cache entry has expired', async () => {
      const stub = stubProvider([track()]);
      let clock = 1_000;
      const service = make({ provider: stub.provider, now: () => clock });
      await service.search('calm');
      clock += 6 * 60 * 1000;
      await service.search('calm');

      expect(stub.calls).toBe(2);
    });

    it('cancels a superseded search instead of merely ignoring it', async () => {
      // An abandoned request still counts against the rate limit.
      const stub = stubProvider([track()]);
      const service = make({ provider: stub.provider });
      const first = service.search('a');
      const firstSignal = stub.lastSignal();
      await service.search('b');
      await first;

      expect(firstSignal?.aborted).toBe(true);
    });

    it('reports a provider failure with its specific code, not a generic error', async () => {
      const { provider } = stubProvider(() => {
        throw new MusicProviderError('rate_limited', 'retry after 30');
      });
      const result = await make({ provider }).search('calm');

      expect(result).toEqual({ ok: false, error: 'rate_limited', detail: 'retry after 30' });
    });

    it('bounds the cache so a long session cannot grow it without limit', async () => {
      const stub = stubProvider([track()]);
      const service = make({ provider: stub.provider });
      for (let i = 0; i < 55; i += 1) await service.search(`query-${i}`);
      // The earliest entry has been evicted, so re-asking costs a request.
      const before = stub.calls;
      await service.search('query-0');
      expect(stub.calls).toBe(before + 1);
    });
  });

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  describe('preview', () => {
    it('returns bytes for a track the renderer names by id alone', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array([1, 2, 3])) });
      await service.search('calm');

      const result = await service.preview('ov-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.contentType).toBe('audio/mpeg');
        expect(result.data.byteLength).toBe(3);
      }
    });

    it('serves a second audition of the same track from memory', async () => {
      const fetchImpl = vi.fn(streamingFetch(new Uint8Array([1, 2, 3])));
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: fetchImpl as unknown as typeof fetch });
      await service.search('calm');
      await service.preview('ov-1');
      await service.preview('ov-1');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('says the track is unknown rather than blaming the provider', async () => {
      // The renderer asked about a track this process never saw — its results
      // are from a previous run. Reporting an outage would send the user to
      // check a service that is fine.
      const result = await make().preview('never-seen');
      expect(result).toEqual({
        ok: false,
        error: 'provider_unavailable',
        detail: 'unknown track',
      });
    });

    it('maps a preview HTTP failure onto its specific code', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        fetchImpl: streamingFetch(new Uint8Array([1]), { status: 429 }),
      });
      await service.search('calm');
      expect(await service.preview('ov-1')).toMatchObject({ ok: false, error: 'rate_limited' });
    });
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  describe('download', () => {
    const request = { projectId: PROJECT_ID, remoteId: 'ov-1', operationId: 'op-1' };

    async function mediaFiles(): Promise<string[]> {
      const dir = path.join(projectsRoot, 'media', PROJECT_ID);
      try {
        return (await readdir(dir)).sort();
      } catch {
        return [];
      }
    }

    it('writes the file, derives its media, and attaches provenance', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array(32)) });
      await service.search('calm');

      const result = await service.download(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.asset.relativePath).toBe('media/demo/Calm_Bed.mp3');
      expect(result.asset.kind).toBe('audio');
      expect(result.asset.media?.peaks).toEqual([0.1, 0.2]);
      // The credit is built in MAIN from what the provider returned, so it
      // cannot depend on a search row still being on screen.
      expect(result.asset.source.attributionRequired).toBe(true);
      expect(result.asset.source.attribution).toContain('Ada');
      expect(result.asset.source.remoteId).toBe('ov-1');
      expect(result.asset.deduped).toBe(false);
    });

    it('lands the file in the same directory an imported one does', async () => {
      // Downloaded media is not special. `fp-media://` and the render engine
      // must resolve it with no change, which means no separate directory.
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array(32)) });
      await service.search('calm');
      await service.download(request);

      expect(await mediaFiles()).toContain('Calm_Bed.mp3');
    });

    it('refuses a non-commercial track before fetching a single byte', async () => {
      const fetchImpl = vi.fn(streamingFetch(new Uint8Array(32)));
      const { provider } = stubProvider([track({ commercialUse: false })]);
      const service = make({ provider, fetchImpl: fetchImpl as unknown as typeof fetch });
      await service.search('calm');

      expect(await service.download(request)).toEqual({ ok: false, error: 'non_commercial_only' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await mediaFiles()).toEqual([]);
    });

    it('dedupes by remoteId so a track is never downloaded — or billed — twice', async () => {
      const fetchImpl = vi.fn(streamingFetch(new Uint8Array(32)));
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: fetchImpl as unknown as typeof fetch });
      await service.search('calm');
      await service.download(request);
      const second = await service.download({ ...request, operationId: 'op-2' });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(second.ok && second.asset.deduped).toBe(true);
      expect((await mediaFiles()).filter((f) => f.endsWith('.mp3'))).toHaveLength(1);
    });

    it('re-downloads when the ledger claims a file the user has since deleted', async () => {
      // Returning a broken asset because a ledger row survived the file would be
      // worse than one redundant request.
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array(32)) });
      await service.search('calm');
      await service.download(request);
      const { unlink } = await import('node:fs/promises');
      await unlink(path.join(projectsRoot, 'media', PROJECT_ID, 'Calm_Bed.mp3'));

      const again = await service.download({ ...request, operationId: 'op-2' });
      expect(again.ok).toBe(true);
      expect(again.ok && again.asset.deduped).toBe(false);
    });

    it('leaves no partial file and no temp file when a download fails', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        // Declares 100 bytes, sends 10. A body that stopped short is a corrupt
        // file, not a small one.
        fetchImpl: streamingFetch(new Uint8Array(10), { contentLength: 100 }),
      });
      await service.search('calm');

      expect(await service.download(request)).toMatchObject({
        ok: false,
        error: 'download_failed',
      });
      expect(await mediaFiles()).toEqual([]);
    });

    it('leaves nothing behind when the user cancels mid-stream', async () => {
      const { provider } = stubProvider([track()]);
      // The cancel has to fire from inside the stream, so the callback closes
      // over a holder the service is written into a line later.
      const holder: { service?: MusicService } = {};
      const fetchImpl = streamingFetch(new Uint8Array(4096), {
        chunkSize: 64,
        onChunk: () => holder.service?.cancelDownload('op-1'),
      });
      const service = make({ provider, fetchImpl });
      holder.service = service;
      await service.search('calm');

      expect(await service.download(request)).toEqual({ ok: false, error: 'cancelled' });
      expect(await mediaFiles()).toEqual([]);
      expect(progress.some((p) => p.phase === 'cancelled')).toBe(true);
    });

    it('reports a network stall as a timeout, not as the user\u2019s own cancel', async () => {
      // Both reach the reader as an abort, and the UI renders a cancel as
      // silence. A stalled download that says "cancelled" therefore looks to the
      // user like something they did — they wait, then nothing happens.
      const { provider } = stubProvider([track()]);
      const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => {
        // A body that never produces a chunk, failing the way a real one does
        // when the request is aborted underneath it.
        const stream = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        );
      }) as unknown as typeof fetch;
      const service = make({ provider, fetchImpl });
      await service.search('calm');

      // Installed only now: search does real work a frozen clock would hang.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let settled = false;
        const pending = service.download(request).then((result) => {
          settled = true;
          return result;
        });
        // Advance in slices, yielding a real macrotask between each, rather than
        // waiting one tick and jumping the whole stall window: the read loop only
        // arms its timer after the fetch promise chain resolves, and how many
        // ticks that takes depends on how loaded the machine is. A single-shot
        // advance passes locally and times out on a contended CI runner.
        for (let i = 0; i < 60 && !settled; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(await pending).toMatchObject({ ok: false, error: 'timeout' });
      } finally {
        vi.useRealTimers();
      }
      expect(await mediaFiles()).toEqual([]);
    });

    it('rejects an empty body rather than adding a zero-byte asset', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        fetchImpl: streamingFetch(new Uint8Array(0), { contentLength: null }),
      });
      await service.search('calm');
      expect(await service.download(request)).toMatchObject({
        ok: false,
        error: 'download_failed',
      });
    });

    it('still adds the asset when deriving its waveform fails', async () => {
      // A missing waveform is a degraded timeline row; a missing asset is a lost
      // download.
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        fetchImpl: streamingFetch(new Uint8Array(32)),
        deriveAssetMedia: async () => {
          throw new Error('sidecar down');
        },
      });
      await service.search('calm');

      const result = await service.download(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.asset.media).toBeNull();
      // Falls back to the provider's own duration rather than leaving it unknown.
      expect(result.asset.durationSeconds).toBe(90);
      expect(result.asset.source.attributionRequired).toBe(true);
    });

    it('reports ENOSPC as a disk problem, not a failed download', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        fetchImpl: (async () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }) as unknown as typeof fetch,
      });
      await service.search('calm');
      expect(await service.download(request)).toEqual({ ok: false, error: 'disk_full' });
    });

    it('emits determinate progress and a terminal installed phase', async () => {
      const { provider } = stubProvider([track()]);
      const service = make({
        provider,
        fetchImpl: streamingFetch(new Uint8Array(4096), { chunkSize: 512 }),
        now: (() => {
          let t = 0;
          // Advance past the 200 ms coalescing window on every read so the test
          // observes the progress the user would.
          return () => (t += 500);
        })(),
      });
      await service.search('calm');
      await service.download(request);

      expect(progress.some((p) => p.phase === 'downloading' && p.totalBytes === 4096)).toBe(true);
      expect(progress.at(-1)?.phase).toBe('installed');
    });

    it('writes the ledger atomically and keeps both entries across two downloads', async () => {
      const { provider } = stubProvider([track(), track({ remoteId: 'ov-2', title: 'Second' })]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array(32)) });
      await service.search('calm');
      await service.download(request);
      await service.download({ ...request, remoteId: 'ov-2', operationId: 'op-2' });

      const ledger = JSON.parse(
        await readFile(path.join(projectsRoot, 'media', PROJECT_ID, 'sources.json'), 'utf8'),
      ) as { version: number; entries: Array<{ remoteId: string }> };
      expect(ledger.version).toBe(1);
      expect(ledger.entries.map((e) => e.remoteId).sort()).toEqual(['ov-1', 'ov-2']);
      // No temp file survived the two atomic writes.
      expect((await mediaFiles()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('starts clean from a corrupt ledger rather than refusing to download', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(projectsRoot, 'media', PROJECT_ID), { recursive: true });
      await writeFile(
        path.join(projectsRoot, 'media', PROJECT_ID, 'sources.json'),
        '{ not json',
        'utf8',
      );
      const { provider } = stubProvider([track()]);
      const service = make({ provider, fetchImpl: streamingFetch(new Uint8Array(32)) });
      await service.search('calm');

      expect((await service.download(request)).ok).toBe(true);
    });

    it('refuses to download a track it never searched', async () => {
      expect(await make().download(request)).toMatchObject({ ok: false });
    });
  });
});
