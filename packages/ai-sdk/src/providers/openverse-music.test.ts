/**
 * Openverse adapter tests. **No live network** — every response is a recorded
 * fixture or a hand-built shape, served through the injected `fetch`.
 */
import { describe, expect, it, vi } from 'vitest';
import recorded from './__fixtures__/openverse-audio-search.json' with { type: 'json' };
import { MusicProviderError } from './music-types.js';
import {
  OpenverseMusicProvider,
  createMusicProvider,
  normalizeOpenverseTrack,
  safeFormat,
} from './openverse-music.js';
import type { FetchLike } from './types.js';

function response(
  body: unknown,
  options: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): Awaited<ReturnType<FetchLike>> {
  const headers = options.headers ?? {};
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Awaited<ReturnType<FetchLike>>;
}

/** A fetch that always answers with the same response, recording every call. */
function stubFetch(
  body: unknown,
  options?: Parameters<typeof response>[1],
): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return response(body, options);
  };
  return { fetchImpl, calls };
}

/** A minimal usable record, for tests that vary exactly one field. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ov-1',
    title: 'A Track',
    duration: 90_000,
    url: 'https://cdn.example.test/track.mp3',
    filetype: 'mp3',
    license: 'by',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: '"A Track" by Ada is licensed under CC BY 4.0.',
    creator: 'Ada',
    creator_url: 'https://example.test/ada',
    foreign_landing_url: 'https://example.test/track',
    ...overrides,
  };
}

describe('OpenverseMusicProvider.search', () => {
  it('normalizes a real recorded response, converting milliseconds to seconds', async () => {
    const { fetchImpl, calls } = stubFetch(recorded);
    const tracks = await new OpenverseMusicProvider(fetchImpl).search({ text: 'calm', limit: 3 });

    expect(tracks).toHaveLength(3);
    // The single most important normalization: Openverse reports milliseconds.
    expect(tracks[0]?.durationSeconds).toBeCloseTo(127.044, 3);
    expect(tracks[0]?.remoteId).toBe('bd0081f7-482a-4c8c-9690-2f5d89d9008a');
    expect(tracks[0]?.provider).toBe('openverse');
    expect(calls).toHaveLength(1);
  });

  it('asks the provider to exclude non-commercial content server-side', async () => {
    const { fetchImpl, calls } = stubFetch(recorded);
    await new OpenverseMusicProvider(fetchImpl).search({ text: 'calm piano', limit: 3 });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('license_type')).toBe('commercial');
    expect(url.searchParams.get('q')).toBe('calm piano');
    expect(url.searchParams.get('page_size')).toBe('3');
  });

  it('keeps an attribution-required track with its credit line intact', async () => {
    const { fetchImpl } = stubFetch(recorded);
    const tracks = await new OpenverseMusicProvider(fetchImpl).search({ text: 'calm', limit: 3 });

    const byShareAlike = tracks.find((track) => track.license === 'by-sa');
    expect(byShareAlike?.attributionRequired).toBe(true);
    expect(byShareAlike?.attribution).toContain('Pal Zoltan Illes');
    expect(byShareAlike?.creator).toBe('Pal Zoltan Illes');
    // CC0 is labelled too — an unlabelled row would read as "unknown", which is
    // the one thing a licence badge must never mean.
    expect(tracks[0]?.attributionRequired).toBe(false);
  });

  it("rewrites Jamendo's mp32 quality code to a container an OS can open", async () => {
    const { fetchImpl } = stubFetch(recorded);
    const tracks = await new OpenverseMusicProvider(fetchImpl).search({ text: 'calm', limit: 3 });
    expect(tracks.find((track) => track.license === 'by-sa')?.format).toBe('mp3');
  });

  it('returns an empty list for an empty query without calling the provider', async () => {
    const { fetchImpl, calls } = stubFetch(recorded);
    expect(await new OpenverseMusicProvider(fetchImpl).search({ text: '   ', limit: 10 })).toEqual(
      [],
    );
    expect(calls).toHaveLength(0);
  });

  it('handles an empty result set without inventing a failure', async () => {
    const { fetchImpl } = stubFetch({ result_count: 0, results: [] });
    expect(await new OpenverseMusicProvider(fetchImpl).search({ text: 'zzz', limit: 10 })).toEqual(
      [],
    );
  });

  it('caps the page size so a provider cannot flood the panel', async () => {
    const { fetchImpl, calls } = stubFetch({ results: [] });
    await new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 10_000 });
    expect(Number(new URL(calls[0]?.url ?? '').searchParams.get('page_size'))).toBeLessThanOrEqual(
      40,
    );
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ] as const)('maps HTTP %i onto the %s error code', async (status, code) => {
    const { fetchImpl } = stubFetch({}, { ok: false, status });
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code });
  });

  it('carries the retry-after hint through on a 429', async () => {
    const { fetchImpl } = stubFetch(
      {},
      { ok: false, status: 429, headers: { 'retry-after': '30' } },
    );
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code: 'rate_limited', detail: 'retry after 30' });
  });

  it('reports malformed JSON as a provider problem, not a network one', async () => {
    const { fetchImpl } = stubFetch('<html>502 Bad Gateway</html>');
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code: 'provider_unavailable', detail: 'malformed JSON' });
  });

  it('reports an unexpected response shape rather than returning nothing quietly', async () => {
    const { fetchImpl } = stubFetch({ results: 'not-an-array' });
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('reports a transport failure as offline', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code: 'offline' });
  });

  it('distinguishes a user cancelling from the network dropping', async () => {
    // Telling someone "no network connection" when they simply typed another
    // letter is a lie the UI then acts on.
    const controller = new AbortController();
    const fetchImpl: FetchLike = async () => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a timeout when the request aborts without the caller asking', async () => {
    const fetchImpl: FetchLike = async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    };
    await expect(
      new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('never puts the query anywhere but the provider request', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fetchImpl } = stubFetch(recorded);
    await new OpenverseMusicProvider(fetchImpl).search({ text: 'secret client name', limit: 3 });
    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret client name');
    }
    logSpy.mockRestore();
  });
});

describe('normalizeOpenverseTrack', () => {
  it('drops a non-commercial track even if the server filter let it through', () => {
    // A query-string parameter is not a guarantee, and no badge makes an NC
    // track safe in a sponsored video.
    for (const license of ['by-nc', 'by-nc-sa', 'by-nc-nd']) {
      expect(normalizeOpenverseTrack(record({ license }))).toBeNull();
    }
  });

  it('drops a licence code it does not recognise', () => {
    // Failure modes are asymmetric: wrongly hiding a usable track costs a search
    // result, wrongly showing an unusable one costs a licence violation.
    expect(normalizeOpenverseTrack(record({ license: 'sampling+' }))).toBeNull();
    expect(normalizeOpenverseTrack(record({ license: 'some-future-licence' }))).toBeNull();
  });

  it('rejects a non-https media URL', () => {
    // Main fetches this, so a file:/http: URL would be a real read primitive.
    expect(normalizeOpenverseTrack(record({ url: 'http://cdn.example.test/t.mp3' }))).toBeNull();
    expect(normalizeOpenverseTrack(record({ url: 'file:///etc/passwd' }))).toBeNull();
    expect(normalizeOpenverseTrack(record({ url: null }))).toBeNull();
  });

  it('drops a record with no usable duration rather than guessing one', () => {
    for (const duration of [null, 0, -1, Number.NaN]) {
      expect(normalizeOpenverseTrack(record({ duration }))).toBeNull();
    }
  });

  it('drops an absurd duration before it can reach the timeline', () => {
    expect(normalizeOpenverseTrack(record({ duration: 25 * 60 * 60 * 1000 }))).toBeNull();
  });

  it('omits a non-https licence or creator link instead of rendering it', () => {
    const track = normalizeOpenverseTrack(
      record({ license_url: 'javascript:alert(1)', creator_url: 'http://example.test/x' }),
    );
    expect(track?.licenseUrl).toBeUndefined();
    expect(track?.creatorUrl).toBeUndefined();
    // The track itself is still usable — one bad link is not a reason to hide it.
    expect(track?.remoteId).toBe('ov-1');
  });

  it('falls back to a placeholder title rather than an empty row', () => {
    expect(normalizeOpenverseTrack(record({ title: '   ' }))?.title).toBe('Untitled');
    expect(normalizeOpenverseTrack(record({ title: null }))?.title).toBe('Untitled');
  });

  it('returns null for a record missing its id, not a track with an empty one', () => {
    expect(normalizeOpenverseTrack(record({ id: '' }))).toBeNull();
    expect(normalizeOpenverseTrack({ license: 'by' })).toBeNull();
    expect(normalizeOpenverseTrack(null)).toBeNull();
  });

  it('keeps the other results when one record in the page is malformed', async () => {
    // One odd row from one aggregated upstream source must not cost the user
    // their other results.
    const { fetchImpl } = stubFetch({
      results: [record({ id: 'good-1' }), { totally: 'wrong' }, record({ id: 'good-2' })],
    });
    const tracks = await new OpenverseMusicProvider(fetchImpl).search({ text: 'a', limit: 5 });
    expect(tracks.map((track) => track.remoteId)).toEqual(['good-1', 'good-2']);
  });
});

describe('safeFormat', () => {
  it('rejects anything that is not a short alphanumeric extension', () => {
    // This becomes part of an on-disk filename.
    for (const value of ['../../etc/passwd', 'mp3/../x', '', null, undefined, 'a'.repeat(20)]) {
      expect(safeFormat(value)).toBe('mp3');
    }
  });

  it('passes a normal container through, lowercased', () => {
    expect(safeFormat('WAV')).toBe('wav');
    expect(safeFormat('ogg')).toBe('ogg');
  });
});

describe('createMusicProvider', () => {
  it('builds the Openverse adapter', () => {
    expect(createMusicProvider('openverse').name).toBe('openverse');
  });
});

describe('MusicProviderError', () => {
  it('carries a specific sentence for every arm, and stays silent on cancel', () => {
    expect(new MusicProviderError('rate_limited').message).toContain('Too many searches');
    // The user cancelled on purpose; telling them so is noise.
    expect(new MusicProviderError('cancelled').message).toBe('');
  });
});
