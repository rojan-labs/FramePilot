/**
 * Tests for the shot-ledger client (ledger-client.ts, ADR 0175 / plan VU2.1).
 *
 * What they assert, in order: the request the engine actually receives; paging until the
 * cursor runs out, and the two ways paging is bounded; the per-asset cache and what it costs
 * a ten-turn run; the cache identity moving when a tier version does; and the four shapes of
 * honest failure — no sidecar, a non-2xx, a malformed payload, and an abort.
 */
import { describe, expect, it, vi } from 'vitest';
import { LEDGER_PAGE_LIMIT, LedgerClient, type LedgerSnapshotRequest } from './ledger-client.js';
import {
  TIER0_VERSION,
  TIER1_VERSION,
  type AssetDigest,
  type LedgerSnapshot,
  type MeasuredFacts,
  type ShotRecord,
} from './ledger.js';

const measured = (over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  tier0Version: TIER0_VERSION,
  luma: { mean: 0.42, std: 0.1, p10: 0.2, p90: 0.62 },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: 0.42,
  motion: { si: 40, ti: 1, class: 'static' },
  cutScore: 0,
  black: false,
  freeze: false,
  sharpness: 0.7,
  phash: '0000000000000000',
  ...over,
});

const shot = (assetId: string, shotIndex: number, over: Partial<ShotRecord> = {}): ShotRecord => ({
  assetId,
  contentHash: 'h1',
  shotIndex,
  t0: shotIndex * 4,
  t1: shotIndex * 4 + 4,
  keyframeT: shotIndex * 4 + 2,
  splitOf: false,
  measured: measured(),
  ...over,
});

const digest = (assetId: string, over: Partial<AssetDigest> = {}): AssetDigest => ({
  assetId,
  contentHash: 'h1',
  durationS: 60,
  shotCount: 2,
  medianShotS: 4,
  shotSizeMix: {},
  settingMix: {},
  motionMix: {},
  people: [],
  hasSpeech: false,
  lowQualityShots: [],
  coverage: { measured: 2, labelled: 0, described: 0, total: 2 },
  ...over,
});

/** A page as the engine would send it, with only the fields the route sets. */
const page = (
  shots: ShotRecord[],
  digests: AssetDigest[],
  nextCursor?: string,
): Record<string, unknown> => ({
  shots,
  digests,
  coverage: { measured: shots.length, labelled: 0, described: 0, total: shots.length },
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

/** A `fetch` that answers each call from `bodies`, recording the URLs it was given. */
function fakeFetch(bodies: readonly (Record<string, unknown> | 'error' | 'boom')[]): {
  fetchFn: typeof fetch;
  urls: string[];
  calls: () => number;
} {
  const urls: string[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    // A real `fetch` rejects on an aborted signal; the client's abort handling is only
    // meaningful against a transport that does.
    if (init?.signal?.aborted === true) throw new Error('The operation was aborted.');
    urls.push(String(url));
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    if (body === 'boom') throw new Error('ECONNREFUSED');
    if (body === 'error') return new Response('nope', { status: 503 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, urls, calls: () => i };
}

const clientFor = (
  bodies: readonly (Record<string, unknown> | 'error' | 'boom')[],
  options: { maxPages?: number } = {},
): { client: LedgerClient; urls: string[]; calls: () => number } => {
  const { fetchFn, urls, calls } = fakeFetch(bodies);
  const client = new LedgerClient({
    baseUrl: 'http://127.0.0.1:8765',
    fetchFn,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  });
  return { client, urls, calls };
};

const request = (over: Partial<LedgerSnapshotRequest> = {}): LedgerSnapshotRequest => ({
  projectId: 'p1',
  assetIds: ['a1'],
  ...over,
});

describe('LedgerClient.snapshot — the request', () => {
  it('asks /brain/shots for exactly the assets it does not already have', async () => {
    const { client, urls } = clientFor([page([shot('a1', 0), shot('a2', 0)], [digest('a1')])]);
    await client.snapshot(request({ assetIds: ['a1', 'a2', 'a1'] }));
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] as string);
    expect(url.pathname).toBe('/brain/shots');
    expect(url.searchParams.get('projectId')).toBe('p1');
    // Duplicates collapsed; the asset list is comma-separated as the route documents.
    expect(url.searchParams.get('assetIds')).toBe('a1,a2');
    expect(url.searchParams.get('limit')).toBe(String(LEDGER_PAGE_LIMIT));
    expect(url.searchParams.get('after')).toBeNull();
  });

  it('reads nothing for an empty asset list and reports zero coverage', async () => {
    const { client, calls } = clientFor([page([], [])]);
    const snapshot = await client.snapshot(request({ assetIds: [] }));
    expect(calls()).toBe(0);
    expect(snapshot).toEqual({
      shots: [],
      digests: [],
      coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
    });
  });
});

describe('LedgerClient.snapshot — paging', () => {
  it('follows the cursor until the engine stops handing one back', async () => {
    const { client, urls } = clientFor([
      page([shot('a1', 0)], [], 'a1:0'),
      page([shot('a1', 1)], [], 'a1:1'),
      page([shot('a1', 2)], [digest('a1', { shotCount: 3 })]),
    ]);
    const snapshot = await client.snapshot(request());
    expect(urls).toHaveLength(3);
    expect(new URL(urls[1] as string).searchParams.get('after')).toBe('a1:0');
    expect(new URL(urls[2] as string).searchParams.get('after')).toBe('a1:1');
    expect(snapshot?.shots.map((s) => s.shotIndex)).toEqual([0, 1, 2]);
    expect(snapshot?.digests).toHaveLength(1);
    // Coverage is recomputed over every page, not carried from the last one.
    expect(snapshot?.coverage).toEqual({ measured: 3, labelled: 0, described: 0, total: 3 });
  });

  it('stops rather than spinning when the cursor does not advance', async () => {
    const { client, urls } = clientFor([page([shot('a1', 0)], [], 'stuck')]);
    const snapshot = await client.snapshot(request());
    // Page 1 returns `stuck`; page 2 returns `stuck` again and the loop ends there.
    expect(urls).toHaveLength(2);
    expect(snapshot?.shots).toHaveLength(2);
  });

  it('stops at the page safety bound', async () => {
    const bodies = [0, 1, 2, 3, 4].map((i) => page([shot('a1', i)], [], `a1:${String(i)}`));
    const { client, urls } = clientFor(bodies, { maxPages: 3 });
    const snapshot = await client.snapshot(request());
    expect(urls).toHaveLength(3);
    expect(snapshot?.shots).toHaveLength(3);
  });
});

describe('LedgerClient.snapshot — the cache', () => {
  it('reads an asset once, however many turns ask for it', async () => {
    const { client, calls } = clientFor([page([shot('a1', 0)], [digest('a1')])]);
    const first = await client.snapshot(request());
    const second = await client.snapshot(request());
    const third = await client.snapshot(request());
    expect(calls()).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('returns the SAME object while nothing changed, so downstream memoization holds', async () => {
    const { client } = clientFor([page([shot('a1', 0)], [digest('a1')])]);
    const first = await client.snapshot(request());
    const second = await client.snapshot(request());
    // Identity, not equality: `pictureSliceFor` keys its WeakMap on this object.
    expect(second).toBe(first);
  });

  it('fetches only the assets a mid-run addition introduced', async () => {
    const { client, urls } = clientFor([
      page([shot('a1', 0)], [digest('a1')]),
      page([shot('a2', 0)], [digest('a2')]),
    ]);
    await client.snapshot(request({ assetIds: ['a1'] }));
    const snapshot = await client.snapshot(request({ assetIds: ['a1', 'a2'] }));
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1] as string).searchParams.get('assetIds')).toBe('a2');
    // The second snapshot carries BOTH assets: the cached one and the new one.
    expect(snapshot?.shots.map((s) => s.assetId)).toEqual(['a1', 'a2']);
    expect(snapshot?.digests.map((d) => d.assetId)).toEqual(['a1', 'a2']);
  });

  it('caches "this asset has no shots" so an unread project is not re-asked every turn', async () => {
    const { client, calls } = clientFor([page([], [])]);
    const snapshot = await client.snapshot(request());
    await client.snapshot(request());
    expect(calls()).toBe(1);
    expect(snapshot?.shots).toEqual([]);
    // A distinguishable identity: asked, and told nothing.
    expect(client.cacheKeyFor('a1')).toBe('a1|-|0.0.0');
  });

  it('keys the cache on the content hash and the tier versions, and refetches on refresh', async () => {
    const { client, calls } = clientFor([
      page([shot('a1', 0)], [digest('a1')]),
      page(
        [
          shot('a1', 0, {
            labelled: { tier1Version: TIER1_VERSION, model: 'siglip', faces: 1, entities: [] },
          }),
        ],
        [digest('a1')],
      ),
    ]);
    await client.snapshot(request());
    expect(client.cacheKeyFor('a1')).toBe(`a1|h1|${String(TIER0_VERSION)}.0.0`);
    // A tier finished indexing: the host says so, and the identity moves with it.
    const after = await client.snapshot(request({ refresh: ['a1'] }));
    expect(calls()).toBe(2);
    expect(client.cacheKeyFor('a1')).toBe(
      `a1|h1|${String(TIER0_VERSION)}.${String(TIER1_VERSION)}.0`,
    );
    expect(after?.coverage).toEqual({ measured: 1, labelled: 1, described: 0, total: 1 });
  });

  it('invalidate() and clearCache() drop what they say they drop', async () => {
    const { client, calls } = clientFor([page([shot('a1', 0)], [digest('a1')])]);
    await client.snapshot(request());
    client.invalidate(['a2']);
    expect(client.cacheKeyFor('a1')).toBeDefined();
    client.invalidate(['a1']);
    expect(client.cacheKeyFor('a1')).toBeUndefined();
    await client.snapshot(request());
    expect(calls()).toBe(2);
    client.clearCache();
    expect(client.cacheKeyFor('a1')).toBeUndefined();
  });
});

describe('LedgerClient.snapshot — honest failure', () => {
  it('resolves to null when the sidecar is not there', async () => {
    const { client } = clientFor(['boom']);
    await expect(client.snapshot(request())).resolves.toBeNull();
  });

  it('resolves to null on a non-2xx', async () => {
    const { client } = clientFor(['error']);
    await expect(client.snapshot(request())).resolves.toBeNull();
  });

  it('resolves to null on a payload the ledger schema rejects', async () => {
    const { client } = clientFor([{ shots: [{ assetId: 'a1' }] }]);
    await expect(client.snapshot(request())).resolves.toBeNull();
  });

  it('resolves to null when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = clientFor([page([shot('a1', 0)], [])]);
    await expect(client.snapshot(request(), controller.signal)).resolves.toBeNull();
  });

  it('does not cache a failed read', async () => {
    const { client, calls } = clientFor(['boom', page([shot('a1', 0)], [digest('a1')])]);
    expect(await client.snapshot(request())).toBeNull();
    const retry = await client.snapshot(request());
    expect(calls()).toBe(2);
    expect(retry?.shots).toHaveLength(1);
  });

  it('keeps the assets it already has when a later read fails', async () => {
    // The alternative — returning null — would erase the picture facts of every clip on the
    // timeline because one mid-run addition could not be read.
    const { client } = clientFor([page([shot('a1', 0)], [digest('a1')]), 'boom']);
    await client.snapshot(request({ assetIds: ['a1'] }));
    const snapshot = (await client.snapshot(request({ assetIds: ['a1', 'a2'] }))) as LedgerSnapshot;
    expect(snapshot.shots.map((s) => s.assetId)).toEqual(['a1']);
    expect(snapshot.coverage.total).toBe(1);
    expect(client.cacheKeyFor('a2')).toBeUndefined();
  });
});

describe('an unavailable brain is not an empty one', () => {
  it('does not cache "no shots" when the engine says it could not look', async () => {
    // The route answers 200 with `available: false` and no rows when there is no sandbox
    // root. That body is also a valid empty snapshot, so a client reading only the snapshot
    // shape would record a measured claim about the footage — "this asset has no shots" —
    // when the truth is that nobody could look. It must degrade instead, and it must not
    // poison the cache against a later, working call.
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(
            JSON.stringify({
              available: false,
              reason: 'the shot ledger requires a configured sandbox root',
              shots: [],
              digests: [],
              coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              available: true,
              shots: [],
              digests: [],
              coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
            }),
            { status: 200 },
          );
    });
    const client = new LedgerClient({ baseUrl: 'http://engine', fetchFn: fetchFn as never });

    expect(await client.snapshot({ projectId: 'p', assetIds: ['a1'] })).toBeNull();
    // Nothing was cached, so the next call really asks again rather than serving the lie.
    const second = await client.snapshot({ projectId: 'p', assetIds: ['a1'] });
    expect(second).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
