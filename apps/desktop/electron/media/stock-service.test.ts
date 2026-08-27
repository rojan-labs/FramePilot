/**
 * StockService tests — offline, with a stubbed provider and injected fetch.
 *
 * The properties worth holding onto here are the ones that are invisible when
 * they work and expensive when they break: no provider URL crosses the wire, a
 * cached hit spends nothing, a cancelled download leaves nothing on disk, and a
 * 429 reaches the quota store so Settings does not keep showing a healthy bar.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StockItem, StockProvider, StockSearchPage } from '@framepilot/ai-sdk';
import { STOCK_DOWNLOAD_STALL_MS, StockProviderError } from '@framepilot/ai-sdk';
import { StockService } from './stock-service.js';
import { StockQuotaStore } from './stock-quota.js';

const PROJECT_ID = 'proj_1';

const VIDEO_ITEM: StockItem = {
  remoteId: '3129671',
  provider: 'pexels',
  kind: 'video',
  title: 'City skyline',
  width: 3840,
  height: 2160,
  durationSeconds: 12,
  avgColor: '#6a8fbf',
  thumbnailUrl: 'https://images.pexels.com/videos/3129671/thumb.jpg',
  previewUrl: 'https://player.vimeo.com/external/preview.sd.mp4',
  variants: [
    {
      id: 'uhd',
      width: 3840,
      height: 2160,
      fps: 25,
      contentType: 'video/mp4',
      format: 'mp4',
      url: 'https://player.vimeo.com/external/uhd.mp4',
    },
    {
      id: 'hd',
      width: 1920,
      height: 1080,
      fps: 25,
      contentType: 'video/mp4',
      format: 'mp4',
      url: 'https://player.vimeo.com/external/hd.mp4',
    },
  ],
  license: 'pexels',
  licenseUrl: 'https://www.pexels.com/license/',
  attributionRequired: false,
  attribution: 'Video by Ruvim on Pexels',
  creator: 'Ruvim',
  creatorUrl: 'https://www.pexels.com/@digitech',
  sourceUrl: 'https://www.pexels.com/video/3129671/',
};

const PHOTO_ITEM: StockItem = {
  remoteId: '2014422',
  provider: 'pexels',
  kind: 'photo',
  title: 'Brown rocks',
  width: 3024,
  height: 3024,
  thumbnailUrl: 'https://images.pexels.com/photos/2014422/thumb.jpg',
  variants: [
    {
      id: 'original',
      width: 3024,
      height: 3024,
      contentType: 'image/jpeg',
      format: 'jpg',
      url: 'https://images.pexels.com/photos/2014422/original.jpeg',
    },
  ],
  license: 'pexels',
  attributionRequired: false,
  attribution: 'Photo by Joey on Pexels',
  creator: 'Joey',
};

function page(
  items: readonly StockItem[],
  overrides: Partial<StockSearchPage> = {},
): StockSearchPage {
  return { items, page: 1, totalResults: items.length, hasMore: false, ...overrides };
}

function stubProvider(result: StockSearchPage | Error): StockProvider & { calls: number } {
  const provider = {
    name: 'pexels' as const,
    calls: 0,
    async search(): Promise<StockSearchPage> {
      provider.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return provider;
}

/**
 * A provider that keeps every signal it was handed, so a test can assert which searches
 * were aborted. Resolves on a macrotask so concurrent calls genuinely overlap.
 */
function signalRecordingProvider(): StockProvider & { signals: (AbortSignal | undefined)[] } {
  const provider = {
    name: 'pexels' as const,
    signals: [] as (AbortSignal | undefined)[],
    async search(_request: unknown, signal?: AbortSignal): Promise<StockSearchPage> {
      provider.signals.push(signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return page([VIDEO_ITEM]);
    },
  };
  return provider as StockProvider & { signals: (AbortSignal | undefined)[] };
}

/** A streaming Response over fixed bytes, so downloads exercise the real path. */
function bytesResponse(
  body: Uint8Array,
  init: { contentType?: string; contentLength?: number | null; status?: number } = {},
): Response {
  const headers: Record<string, string> = {
    'content-type': init.contentType ?? 'video/mp4',
  };
  if (init.contentLength !== null) {
    headers['content-length'] = String(init.contentLength ?? body.byteLength);
  }
  return new Response(body, { status: init.status ?? 200, headers });
}

let root: string;
let quotaFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fp-stock-svc-'));
  quotaFile = join(root, 'quota.json');
});

function makeQuota(keyed = true): StockQuotaStore {
  return new StockQuotaStore({ filePath: quotaFile, isKeyConfigured: () => keyed });
}

function makeService(
  options: {
    provider?: StockProvider;
    fetchImpl?: unknown;
    quota?: StockQuotaStore;
    apiKey?: string | undefined;
    derive?: unknown;
    onProgress?: (message: never) => void;
  } = {},
): StockService {
  return new StockService({
    projectsRoot: root,
    resolveApiKey: () => ('apiKey' in options ? options.apiKey : 'test-key'),
    quota: options.quota ?? makeQuota(),
    ...(options.provider ? { provider: options.provider } : {}),
    fetchImpl: (options.fetchImpl ?? vi.fn()) as never,
    deriveAssetMedia: (options.derive ?? (async () => null)) as never,
    ...(options.onProgress ? { onProgress: options.onProgress as never } : {}),
  });
}

/** Mirrors `mediaRelativeDir`: `<projectsRoot>/media/<projectId>`. */
function mediaDir(): string {
  return join(root, 'media', PROJECT_ID);
}

describe('search', () => {
  it('returns wire items with no provider URL anywhere', async () => {
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])) });
    const result = await service.search({ text: 'skyline', kind: 'video' });

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    // The property that makes the CSP guarantee structural rather than a rule.
    expect(serialized).not.toContain('player.vimeo.com');
    expect(serialized).not.toContain('images.pexels.com');
    expect(serialized).not.toContain('test-key');
  });

  it('keeps the variant facts the tile needs to render', async () => {
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])) });
    const result = await service.search({ text: 'skyline', kind: 'video' });
    if (!result.ok) throw new Error('expected ok');
    // "1920×1080" on the tile, with no way to fetch it.
    expect(result.items[0]?.variants).toHaveLength(2);
    expect(result.items[0]?.variants[1]).toMatchObject({ width: 1920, height: 1080 });
    expect(result.items[0]?.hasPreview).toBe(true);
  });

  it('serves a repeat search from cache without a second provider call', async () => {
    const provider = stubProvider(page([VIDEO_ITEM]));
    const service = makeService({ provider });
    await service.search({ text: 'skyline', kind: 'video' });
    await service.search({ text: '  SKYLINE ', kind: 'video' });
    // Normalized key: re-opening the panel must not spend one of ~200 per hour.
    expect(provider.calls).toBe(1);
  });

  it('regression: parallel agent searches do not cancel each other', async () => {
    // The agent batches concurrency-safe calls four at a time, so four DELIBERATE
    // queries arrive together. Under the panel's supersede rule each aborted the one
    // before it: in run `f014f3ac` the fourth query of every batch returned forty clips
    // while the first three came back `cancelled` in ~120ms — and `cancelled` renders as
    // the empty string, so the model saw three failures with no reason and asked again.
    // Fifteen of twenty-one footage searches were lost that way and the montage never
    // got its pictures.
    const provider = signalRecordingProvider();
    const service = makeService({ provider });
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((text) =>
        service.search({ text, kind: 'video' }, { supersedePrevious: false }),
      ),
    );

    expect(provider.signals.some((signal) => signal?.aborted === true)).toBe(false);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("the panel's supersede behaviour is untouched by default", async () => {
    // A person typing revises one question and means the last version of it.
    const provider = signalRecordingProvider();
    const service = makeService({ provider });
    const first = service.search({ text: 'a', kind: 'video' });
    await service.search({ text: 'b', kind: 'video' });
    await first;

    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("a caller's own signal still cancels its search", async () => {
    // Not superseding must not mean uncancellable: an agent run's Stop reaches the
    // provider through the caller's signal rather than through the supersede slot.
    const provider = signalRecordingProvider();
    const service = makeService({ provider });
    const controller = new AbortController();
    const pending = service.search(
      { text: 'a', kind: 'video' },
      { supersedePrevious: false, signal: controller.signal },
    );
    controller.abort();
    await pending;

    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it('treats a different kind or page as a different search', async () => {
    const provider = stubProvider(page([VIDEO_ITEM]));
    const service = makeService({ provider });
    await service.search({ text: 'skyline', kind: 'video' });
    await service.search({ text: 'skyline', kind: 'photo' });
    await service.search({ text: 'skyline', kind: 'video', page: 2 });
    expect(provider.calls).toBe(3);
  });

  it('does not touch the quota store on a cached hit', async () => {
    const quota = makeQuota();
    const observe = vi.spyOn(quota, 'observe');
    const service = makeService({
      provider: stubProvider(
        page([VIDEO_ITEM], {
          quota: {
            limit: 20000,
            remaining: 19000,
            resetAt: '2026-09-01T00:00:00.000Z',
            observedAt: new Date().toISOString(),
          },
        }),
      ),
      quota,
    });
    await service.search({ text: 'skyline', kind: 'video' });
    await service.search({ text: 'skyline', kind: 'video' });
    // A cached hit spent no request, so it must not move the meter — otherwise
    // the Settings readout drifts away from what the provider actually counted.
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('records the observed quota so Settings can render it', async () => {
    const quota = makeQuota();
    const service = makeService({
      provider: stubProvider(
        page([VIDEO_ITEM], {
          quota: {
            limit: 20000,
            remaining: 19000,
            resetAt: '2026-09-01T00:00:00.000Z',
            observedAt: new Date().toISOString(),
          },
        }),
      ),
      quota,
    });
    await service.search({ text: 'skyline', kind: 'video' });
    expect(quota.snapshot()).toMatchObject({ kind: 'measured', monthly: { remaining: 19000 } });
  });

  it('reports a 429 to the quota store, not just to the caller', async () => {
    const quota = makeQuota();
    const service = makeService({
      provider: stubProvider(new StockProviderError('rate_limited')),
      quota,
    });
    const result = await service.search({ text: 'skyline', kind: 'video' });
    expect(result).toMatchObject({ ok: false, error: 'rate_limited' });
    // Without this, Settings keeps showing a healthy monthly bar while every
    // search fails — the exact contradiction the two-arm design exists to avoid.
    expect(quota.snapshot().kind).toBe('hourly_limited');
  });

  it('returns no_key without a network call when no key is configured', async () => {
    const fetchImpl = vi.fn();
    const service = makeService({ apiKey: undefined, fetchImpl });
    expect(await service.search({ text: 'skyline', kind: 'video' })).toMatchObject({
      ok: false,
      error: 'no_key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps every provider error arm onto the wire', async () => {
    for (const code of ['unauthorized', 'timeout', 'offline', 'quota_exhausted'] as const) {
      const service = makeService({ provider: stubProvider(new StockProviderError(code)) });
      expect(await service.search({ text: 'x', kind: 'photo' })).toMatchObject({
        ok: false,
        error: code,
      });
    }
  });
});

describe('thumbnails and hover preview', () => {
  it('fetches tile bytes for a known item and caches them', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        bytesResponse(new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' }),
      );
    const service = makeService({ provider: stubProvider(page([PHOTO_ITEM])), fetchImpl });
    await service.search({ text: 'rocks', kind: 'photo' });

    const first = await service.thumbnail(PHOTO_ITEM.remoteId);
    expect(first).toMatchObject({ ok: true, contentType: 'image/jpeg' });
    await service.thumbnail(PHOTO_ITEM.remoteId);
    // Re-searching a query the user already looked at costs nothing.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps tile and preview bytes in separate caches', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(new Uint8Array([9])));
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])), fetchImpl });
    await service.search({ text: 'skyline', kind: 'video' });
    await service.thumbnail(VIDEO_ITEM.remoteId);
    await service.preview(VIDEO_ITEM.remoteId);
    // One hover-scrub rendition outweighs a hundred tiles; sharing a budget
    // would evict the whole grid on the first hover.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(VIDEO_ITEM.thumbnailUrl);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(VIDEO_ITEM.previewUrl);
  });

  it('says the item is unknown rather than blaming the provider', async () => {
    const service = makeService();
    expect(await service.thumbnail('never-seen')).toMatchObject({
      ok: false,
      detail: 'unknown item',
    });
  });

  it('reports no preview for a photo instead of inventing one', async () => {
    const service = makeService({ provider: stubProvider(page([PHOTO_ITEM])) });
    await service.search({ text: 'rocks', kind: 'photo' });
    expect(await service.preview(PHOTO_ITEM.remoteId)).toMatchObject({
      ok: false,
      detail: 'no preview for this item',
    });
  });
});

describe('download', () => {
  const body = new Uint8Array(1024).fill(7);

  async function seeded(fetchImpl: unknown, item = VIDEO_ITEM) {
    const service = makeService({ provider: stubProvider(page([item])), fetchImpl });
    await service.search({ text: 'q', kind: item.kind });
    return service;
  }

  // GAP-011. The searched-item table lives in this process's memory; the ids that
  // reference it live in the run's evidence store, which outlives the process. A resumed
  // run can hold a perfectly valid id this service has never heard of, and "unknown item"
  // told nobody what to do about that.
  it('explains an id it cannot resolve, and names the way back', async () => {
    const service = await seeded(vi.fn());
    expect(service.unresolvableReason(VIDEO_ITEM.remoteId)).toBeNull();

    const forgotten = service.unresolvableReason('34707892');
    expect(forgotten).toMatch(/not in this session's search results/);
    expect(forgotten).toMatch(/do not survive a restart/);
    expect(forgotten).toMatch(/Run search_stock again/);
    expect(service.unresolvableReason('  ')).toMatch(/needs the remoteId/);
  });

  it('writes the file, records the ledger, and returns provenance', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);

    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
      targetHeight: 1080,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.kind).toBe('video');
    expect(result.asset.source).toMatchObject({
      provider: 'pexels',
      remoteId: '3129671',
      attributionRequired: false,
      attribution: 'Video by Ruvim on Pexels',
      creator: 'Ruvim',
    });
    // `relativePath` is POSIX by contract; `join` handles the separator on
    // Windows, so no rewriting is needed here.
    expect(existsSync(join(root, result.asset.relativePath))).toBe(true);

    const ledger = JSON.parse(readFileSync(join(mediaDir(), 'sources.json'), 'utf8'));
    expect(ledger.entries[0]).toMatchObject({
      provider: 'pexels',
      remoteId: '3129671',
      variantId: 'hd',
      kind: 'video',
    });
  });

  it('downloads the rendition that matches the project, not the biggest', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
      targetHeight: 1080,
    });
    // The difference between a 24 MB download and a 400 MB one nobody asked for.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://player.vimeo.com/external/hd.mp4',
      expect.anything(),
    );
  });

  it('honours an explicitly chosen rendition', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
      variantId: 'uhd',
      targetHeight: 1080,
    });
    // A user who picked a size meant it.
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://player.vimeo.com/external/uhd.mp4',
      expect.anything(),
    );
  });

  it('gives a photo no duration rather than a manufactured one', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => bytesResponse(body, { contentType: 'image/jpeg' }));
    const service = await seeded(fetchImpl, PHOTO_ITEM);
    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: PHOTO_ITEM.remoteId,
      operationId: 'op1',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.asset.kind).toBe('image');
    expect(result.asset.durationSeconds).toBeUndefined();
  });

  it('trusts the engine classification over our expectation', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = makeService({
      provider: stubProvider(page([PHOTO_ITEM])),
      fetchImpl,
      // A provider that served an MJPEG under a .jpg name has not changed what
      // the file is; the engine reads the container and wins.
      derive: async () => ({ kind: 'video', durationSeconds: 4 }),
    });
    await service.search({ text: 'q', kind: 'photo' });
    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: PHOTO_ITEM.remoteId,
      operationId: 'op1',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.asset.kind).toBe('video');
  });

  it('still adds the asset when derivation fails', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = makeService({
      provider: stubProvider(page([VIDEO_ITEM])),
      fetchImpl,
      derive: async () => {
        throw new Error('sidecar down');
      },
    });
    await service.search({ text: 'q', kind: 'video' });
    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });
    // A missing thumbnail is a degraded bin tile; a missing asset is a lost
    // download.
    expect(result.ok).toBe(true);
  });

  it('dedupes the same rendition without fetching', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);
    const request = {
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
      targetHeight: 1080,
    };
    await service.download(request);
    const second = await service.download({ ...request, operationId: 'op2' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (!second.ok) throw new Error('expected ok');
    expect(second.asset.deduped).toBe(true);
  });

  it('still fetches a different rendition of the same item', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);
    const base = { projectId: PROJECT_ID, remoteId: VIDEO_ITEM.remoteId, targetHeight: 1080 };
    await service.download({ ...base, operationId: 'op1' });
    await service.download({ ...base, operationId: 'op2', variantId: 'uhd' });
    // 720p and 1080p of the same clip are different files, and a user who
    // deliberately reaches for the larger one should get it.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the ledger row survived a file the user deleted', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seeded(fetchImpl);
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
      targetHeight: 1080,
    });
    for (const name of readdirSync(mediaDir())) {
      if (name.endsWith('.mp4')) writeFileSync(join(mediaDir(), name), '');
    }
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(mediaDir())) {
      if (name.endsWith('.mp4')) rmSync(join(mediaDir(), name));
    }
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op2',
      targetHeight: 1080,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses an oversized declared length before writing a byte', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => bytesResponse(body, { contentLength: 3 * 1024 * 1024 * 1024 }));
    const service = await seeded(fetchImpl);
    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });
    expect(result).toMatchObject({ ok: false, error: 'too_large' });
    expect(leftovers()).toEqual([]);
  });

  it('detects a truncated body and leaves nothing behind', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => bytesResponse(body, { contentLength: body.byteLength * 4 }));
    const service = await seeded(fetchImpl);
    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });
    // A body that stopped short of its declared length is a corrupt file, not a
    // small one.
    expect(result).toMatchObject({ ok: false, error: 'download_failed' });
    expect(leftovers()).toEqual([]);
  });

  it('rejects an empty body', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => bytesResponse(new Uint8Array(0), { contentLength: null }));
    const service = await seeded(fetchImpl);
    expect(
      await service.download({
        projectId: PROJECT_ID,
        remoteId: VIDEO_ITEM.remoteId,
        operationId: 'op1',
      }),
    ).toMatchObject({ ok: false, error: 'download_failed' });
    expect(leftovers()).toEqual([]);
  });

  it('leaves no temp and no final file when cancelled mid-stream', async () => {
    // A holder, because the fetch stub has to reach the service that is built
    // from it — the cancel must fire while the request is genuinely in flight.
    const ref: { current?: StockService } = {};
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      // Cancel once the request is in flight, the way the panel's Cancel does.
      queueMicrotask(() => ref.current?.cancelDownload('op1'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (init.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return bytesResponse(body);
    });
    const service = await seeded(fetchImpl);
    ref.current = service;

    const result = await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });
    expect(result).toMatchObject({ ok: false, error: 'cancelled' });
    expect(leftovers()).toEqual([]);
  });

  it('reports a network stall as a timeout, not as the user\u2019s own cancel', async () => {
    // Both reach the reader as an abort, and the UI renders a cancel as silence.
    // A stalled download that says "cancelled" therefore looks to the user like
    // something they did — they wait, then nothing ever happens.
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // A body that never produces a chunk, and that fails the way a real one
      // does when the request is aborted underneath it.
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      );
    });
    const service = await seeded(fetchImpl);
    // Installed only now: seeding does real filesystem and quota work, which a
    // frozen clock would hang.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let settled = false;
      const pending = service
        .download({
          projectId: PROJECT_ID,
          remoteId: VIDEO_ITEM.remoteId,
          operationId: 'op-stall',
        })
        .then((result) => {
          settled = true;
          return result;
        });
      // Advance in slices, yielding a real macrotask between each, rather than
      // waiting one tick and jumping the whole stall window: the read loop only
      // arms its timer after the fetch promise chain resolves, and how many ticks
      // that takes depends on how loaded the machine is. A single-shot advance
      // passes locally and times out on a contended CI runner.
      for (let i = 0; i < 60 && !settled; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(STOCK_DOWNLOAD_STALL_MS / 10);
      }
      expect(await pending).toMatchObject({ ok: false, error: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
    expect(leftovers()).toEqual([]);
  });

  it('maps ENOSPC to disk_full rather than a generic failure', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    const service = await seeded(fetchImpl);
    expect(
      await service.download({
        projectId: PROJECT_ID,
        remoteId: VIDEO_ITEM.remoteId,
        operationId: 'op1',
      }),
    ).toMatchObject({ ok: false, error: 'disk_full' });
  });

  it('emits coarse progress rather than one event per chunk', async () => {
    const events: { phase: string }[] = [];
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = new StockService({
      projectsRoot: root,
      resolveApiKey: () => 'k',
      quota: makeQuota(),
      provider: stubProvider(page([VIDEO_ITEM])),
      fetchImpl: fetchImpl as never,
      deriveAssetMedia: async () => null,
      onProgress: (message) => events.push(message),
    });
    await service.search({ text: 'q', kind: 'video' });
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });
    // A 400 MB file at 64 KB chunks is 6,400 IPC messages and an unreadable
    // live region.
    expect(events.filter((e) => e.phase === 'downloading').length).toBeLessThan(4);
    expect(events.at(-1)?.phase).toBe('installed');
  });

  it('refuses an unknown item', async () => {
    const service = makeService();
    expect(
      await service.download({
        projectId: PROJECT_ID,
        remoteId: 'nope',
        operationId: 'op1',
      }),
    ).toMatchObject({ ok: false, detail: 'unknown item' });
  });

  function leftovers(): string[] {
    if (!existsSync(mediaDir())) return [];
    return readdirSync(mediaDir()).filter((name) => name !== 'sources.json');
  }
});

describe('shared ledger', () => {
  it('does not evict a music entry that shares an id', async () => {
    const dir = mediaDir();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sources.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            fileName: 'bed.mp3',
            provider: 'openverse',
            remoteId: '3129671',
            license: 'cc0',
            attributionRequired: false,
            downloadedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(new Uint8Array(64).fill(1)));
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])), fetchImpl });
    await service.search({ text: 'q', kind: 'video' });
    await service.download({
      projectId: PROJECT_ID,
      remoteId: VIDEO_ITEM.remoteId,
      operationId: 'op1',
    });

    const ledger = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'));
    // The two providers share this file and can share a numeric id.
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.map((e: { provider: string }) => e.provider).sort()).toEqual([
      'openverse',
      'pexels',
    ]);
  });
});

describe('concurrent acquisition is safe (03)', () => {
  const body = new Uint8Array(2048).fill(3);

  /** Three distinct clips in one search, so a turn can download them together. */
  const clip = (remoteId: string): StockItem => ({
    ...VIDEO_ITEM,
    remoteId,
    title: `clip ${remoteId}`,
  });

  async function seededMany(fetchImpl: unknown, items: readonly StockItem[]) {
    const service = makeService({ provider: stubProvider(page([...items])), fetchImpl });
    await service.search({ text: 'q', kind: 'video' });
    return service;
  }

  const ledgerEntries = (): { remoteId: string }[] =>
    JSON.parse(readFileSync(join(mediaDir(), 'sources.json'), 'utf8')).entries;

  it('shares one fetch between concurrent callers asking for the same file', async () => {
    // The agent now issues a turn's downloads concurrently. Two calls for the same clip
    // would otherwise both miss the ledger (written only after the rename), take the same
    // `dedupeName` (the real file does not exist yet, only two `.tmp`s), and both rename
    // onto the same path — atomic, so nothing corrupts, but the bytes are paid for twice.
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seededMany(fetchImpl, [VIDEO_ITEM]);
    const base = { projectId: PROJECT_ID, remoteId: VIDEO_ITEM.remoteId, targetHeight: 1080 };
    const results = await Promise.all([
      service.download({ ...base, operationId: 'op_a' }),
      service.download({ ...base, operationId: 'op_b' }),
      service.download({ ...base, operationId: 'op_c' }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a later download of the same file from the ledger, not the network', async () => {
    // This is what makes warming a turn's downloads free: the serial commit that follows
    // hits the dedupe path at zero bytes.
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const service = await seededMany(fetchImpl, [VIDEO_ITEM]);
    const base = { projectId: PROJECT_ID, remoteId: VIDEO_ITEM.remoteId, targetHeight: 1080 };
    await service.download({ ...base, operationId: 'op_a' });
    const second = await service.download({ ...base, operationId: 'op_b' });
    expect(second.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not lose a ledger entry when downloads finish together', async () => {
    // `appendLedger` is a read-modify-write. It re-reads rather than trusting a stale
    // snapshot, which is necessary but not sufficient: two concurrent completions can still
    // interleave read/read/write/write and drop an entry, costing a redundant download
    // later — the exact cost this concurrency exists to remove.
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body));
    const items = ['1001', '1002', '1003'].map(clip);
    const service = await seededMany(fetchImpl, items);
    await Promise.all(
      items.map((item, index) =>
        service.download({
          projectId: PROJECT_ID,
          remoteId: item.remoteId,
          operationId: `op_${String(index)}`,
          targetHeight: 1080,
        }),
      ),
    );
    expect(
      ledgerEntries()
        .map((entry) => entry.remoteId)
        .sort(),
    ).toEqual(['1001', '1002', '1003']);
  });
});

describe('transport failures, retried once (03)', () => {
  const body = new Uint8Array(2048).fill(9);

  async function seededOne(fetchImpl: unknown) {
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])), fetchImpl });
    await service.search({ text: 'q', kind: 'video' });
    return service;
  }
  const req = { projectId: PROJECT_ID, remoteId: VIDEO_ITEM.remoteId, operationId: 'op' };

  it('retries a network error once and succeeds', () => {
    // The captured run's ladder -- timeout, QUIC, DNS, no-internet -- is Chromium session
    // state clustered at the tail of a long serial chain, not Pexels refusing.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_QUIC_PROTOCOL_ERROR'))
      .mockImplementation(() => bytesResponse(body));
    return seededOne(fetchImpl)
      .then((service) => service.download(req))
      .then((result) => {
        expect(result.ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });
  });

  it('retries at most once', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const service = await seededOne(fetchImpl);
    const result = await service.download(req);
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never replays a provider ANSWER', async () => {
    // A second attempt at "unauthorized" or "too large" is a second bill for the same
    // information.
    const fetchImpl = vi.fn().mockImplementation(() => bytesResponse(body, { status: 401 }));
    const service = await seededOne(fetchImpl);
    const result = await service.download(req);
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('crash-left download fragments are swept (03)', () => {
  it('removes .tmp files a previous session left behind, and only those', async () => {
    // A crash neither renames nor unlinks the fragment, so it survives -- invisible to the
    // media bin and to fp-media://, occupying disk forever. Nothing ever swept them.
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])) });
    const dir = mediaDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'clip.mp4.1234.abcd.tmp'), 'partial');
    writeFileSync(join(dir, 'clip.mp4'), 'real');
    writeFileSync(join(dir, 'sources.json'), '{"entries":[]}');

    expect(await service.sweepPartialDownloads(PROJECT_ID)).toBe(1);
    expect(existsSync(join(dir, 'clip.mp4.1234.abcd.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'clip.mp4'))).toBe(true);
    expect(existsSync(join(dir, 'sources.json'))).toBe(true);
  });

  it('is a no-op for a project that has downloaded nothing', async () => {
    const service = makeService({ provider: stubProvider(page([VIDEO_ITEM])) });
    expect(await service.sweepPartialDownloads('proj_never_used')).toBe(0);
  });
});
