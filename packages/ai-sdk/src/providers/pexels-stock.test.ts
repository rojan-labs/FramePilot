/**
 * Pexels adapter tests — offline, against fixture responses.
 *
 * The fixtures below are shaped from the published API documentation rather than
 * captured from a live call, because CI has no key. `PEXELS-API.md` §5 records
 * the open questions this leaves, and the manual evidence run is where a real
 * response replaces these verbatim. Every field asserted here is one the docs
 * name explicitly.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PexelsStockProvider,
  createStockProvider,
  normalizePexelsPhoto,
  normalizePexelsVideo,
} from './pexels-stock.js';
import { StockProviderError, chooseVariant } from './stock-types.js';

const PHOTO = {
  id: 2014422,
  width: 3024,
  height: 3024,
  url: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/',
  photographer: 'Joey Farina',
  photographer_url: 'https://www.pexels.com/@joey',
  avg_color: '#978E82',
  alt: 'Brown Rocks During Golden Hour',
  src: {
    original: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg',
    large2x: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?w=1880',
    large: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?w=940',
    medium: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=350',
    small: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=130',
    tiny: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?w=280&h=200',
  },
};

const VIDEO = {
  id: 3129671,
  width: 3840,
  height: 2160,
  url: 'https://www.pexels.com/video/3129671/',
  image: 'https://images.pexels.com/videos/3129671/free-video-3129671.jpg',
  duration: 12,
  avg_color: '#6A8FBF',
  user: { id: 1498112, name: 'Ruvim Miksanskiy', url: 'https://www.pexels.com/@digitech' },
  video_files: [
    {
      id: 1440938,
      quality: 'hd',
      file_type: 'video/mp4',
      width: 3840,
      height: 2160,
      fps: 25,
      link: 'https://player.vimeo.com/external/3129671.hd.mp4?4k',
    },
    {
      id: 1440939,
      quality: 'hd',
      file_type: 'video/mp4',
      width: 1920,
      height: 1080,
      fps: 25,
      link: 'https://player.vimeo.com/external/3129671.hd.mp4?1080',
    },
    {
      id: 1440940,
      quality: 'sd',
      file_type: 'video/mp4',
      width: 640,
      height: 360,
      fps: 25,
      link: 'https://player.vimeo.com/external/3129671.sd.mp4?360',
    },
  ],
};

const RESET = String(Math.floor(new Date('2026-09-01T00:00:00.000Z').getTime() / 1000));

function respond(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function provider(fetchImpl: unknown, apiKey = 'test-key'): PexelsStockProvider {
  return new PexelsStockProvider({ apiKey }, fetchImpl as never);
}

const photoQuery = { text: 'golden hour', kind: 'photo', limit: 24, page: 1 } as const;
const videoQuery = { text: 'city skyline', kind: 'video', limit: 24, page: 1 } as const;

describe('request shape', () => {
  it('sends the raw key with no Bearer prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ photos: [PHOTO] }));
    await provider(fetchImpl, 'secret-key').search(photoQuery);

    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    // A `Bearer ` prefix here produces a 401 that looks convincingly like a
    // bad key, which is a long afternoon for whoever debugs it.
    expect(headers['authorization']).toBe('secret-key');
    expect(headers['authorization']).not.toMatch(/^Bearer/i);
  });

  it('hits the photo and video endpoints, which live on different bases', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi.fn().mockImplementation(() => respond({ photos: [], videos: [] }));
    await provider(fetchImpl).search(photoQuery);
    await provider(fetchImpl).search(videoQuery);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('https://api.pexels.com/v1/search');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('https://api.pexels.com/videos/search');
  });

  it('passes query, paging and orientation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ photos: [] }));
    await provider(fetchImpl).search({ ...photoQuery, page: 3, orientation: 'portrait' });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('query')).toBe('golden hour');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('per_page')).toBe('24');
    expect(url.searchParams.get('orientation')).toBe('portrait');
  });

  it('clamps the page size to the provider ceiling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ photos: [] }));
    await provider(fetchImpl).search({ ...photoQuery, limit: 500 });
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('per_page')).toBe('80');
  });

  it('never calls the network for an empty query or a missing key', async () => {
    const fetchImpl = vi.fn();
    const page = await provider(fetchImpl).search({ ...photoQuery, text: '   ' });
    expect(page.items).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(provider(fetchImpl, '').search(photoQuery)).rejects.toMatchObject({
      code: 'no_key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('photo normalization', () => {
  it('maps a documented photo record', () => {
    const item = normalizePexelsPhoto(PHOTO);
    expect(item).toMatchObject({
      remoteId: '2014422',
      provider: 'pexels',
      kind: 'photo',
      title: 'Brown Rocks During Golden Hour',
      width: 3024,
      height: 3024,
      avgColor: '#978E82',
      license: 'pexels',
      creator: 'Joey Farina',
      attribution: 'Photo by Joey Farina on Pexels',
    });
    // A photo has no duration and must not be given a fake one.
    expect(item?.durationSeconds).toBeUndefined();
  });

  it('offers `original` as the only download variant', () => {
    // The other src sizes are CROPS into fixed boxes, not scaled copies, so
    // downloading one would silently change the photo's aspect ratio.
    const item = normalizePexelsPhoto(PHOTO);
    expect(item?.variants).toHaveLength(1);
    expect(item?.variants[0]).toMatchObject({ id: 'original', width: 3024, height: 3024 });
    expect(item?.variants[0]?.url).toBe(PHOTO.src.original);
  });

  it('uses a small cropped size for the tile, where cropping is what you want', () => {
    expect(normalizePexelsPhoto(PHOTO)?.thumbnailUrl).toBe(PHOTO.src.medium);
  });

  it('derives a title when alt is empty, rather than rendering a blank tile', () => {
    expect(normalizePexelsPhoto({ ...PHOTO, alt: '   ' })?.title).toBe('Photo 2014422');
    expect(normalizePexelsPhoto({ ...PHOTO, alt: null })?.title).toBe('Photo 2014422');
  });

  it('drops a record with no usable original', () => {
    expect(normalizePexelsPhoto({ ...PHOTO, src: { ...PHOTO.src, original: null } })).toBeNull();
  });

  it('rejects a non-https URL rather than handing main something to fetch', () => {
    expect(
      normalizePexelsPhoto({
        ...PHOTO,
        src: { ...PHOTO.src, original: 'http://images.pexels.com/x.jpg' },
      }),
    ).toBeNull();
    expect(
      normalizePexelsPhoto({
        ...PHOTO,
        src: { ...PHOTO.src, original: 'file:///etc/passwd' },
      }),
    ).toBeNull();
  });

  it('drops an avg_color that is not a plain hex triple', () => {
    // It goes straight into an inline style; provider text does not.
    expect(
      normalizePexelsPhoto({ ...PHOTO, avg_color: 'red; background:url(x)' })?.avgColor,
    ).toBeUndefined();
  });

  it('marks attribution as NOT required, and still carries the credit', () => {
    const item = normalizePexelsPhoto(PHOTO);
    // The content licence obliges the end user to credit nobody. The credit is
    // kept anyway and surfaced as a suggestion (README §D4).
    expect(item?.attributionRequired).toBe(false);
    expect(item?.attribution).toBe('Photo by Joey Farina on Pexels');
    expect(item?.creatorUrl).toBe('https://www.pexels.com/@joey');
  });
});

describe('video normalization', () => {
  it('maps a documented video record with all renditions', () => {
    const item = normalizePexelsVideo(VIDEO);
    expect(item).toMatchObject({
      remoteId: '3129671',
      provider: 'pexels',
      kind: 'video',
      width: 3840,
      height: 2160,
      durationSeconds: 12,
      creator: 'Ruvim Miksanskiy',
      attribution: 'Video by Ruvim Miksanskiy on Pexels',
      attributionRequired: false,
    });
    expect(item?.variants).toHaveLength(3);
  });

  it('picks the smallest rendition as the hover-scrub source', () => {
    // Seeking is a decode. Decoding 4K to answer a mouse move would make
    // scrubbing feel broken on exactly the machines that need it to feel good.
    expect(normalizePexelsVideo(VIDEO)?.previewUrl).toContain('sd.mp4');
  });

  it('feeds chooseVariant real dimensions, so a 1080p project gets 1080p', () => {
    const item = normalizePexelsVideo(VIDEO)!;
    expect(chooseVariant(item.variants, { height: 1080 }).height).toBe(1080);
    expect(chooseVariant(item.variants, { height: 2160 }).height).toBe(2160);
  });

  it('gives each rendition a unique id even when quality repeats', () => {
    const item = normalizePexelsVideo(VIDEO)!;
    // Two `hd` entries in one result is normal; `quality` alone is not an id.
    const ids = item.variants.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives an id from dimensions when the provider omits one', () => {
    const item = normalizePexelsVideo({
      ...VIDEO,
      video_files: [{ ...VIDEO.video_files[1], id: null }],
    });
    expect(item?.variants[0]?.id).toBe('1920x1080');
  });

  it('drops renditions with no usable link but keeps the rest', () => {
    const item = normalizePexelsVideo({
      ...VIDEO,
      video_files: [{ ...VIDEO.video_files[0], link: 'http://insecure' }, VIDEO.video_files[1]],
    });
    expect(item?.variants).toHaveLength(1);
    expect(item?.variants[0]?.height).toBe(1080);
  });

  it('drops a video with no usable rendition at all', () => {
    expect(normalizePexelsVideo({ ...VIDEO, video_files: [] })).toBeNull();
    expect(normalizePexelsVideo({ ...VIDEO, video_files: null })).toBeNull();
  });

  it('drops an absent or absurd duration rather than placing an absurd clip', () => {
    expect(normalizePexelsVideo({ ...VIDEO, duration: 0 })).toBeNull();
    expect(normalizePexelsVideo({ ...VIDEO, duration: null })).toBeNull();
    expect(normalizePexelsVideo({ ...VIDEO, duration: 60 * 60 * 24 })).toBeNull();
  });
});

describe('search results', () => {
  it('returns normalized items and paging', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        respond({
          page: 1,
          per_page: 24,
          total_results: 8000,
          next_page: 'https://api.pexels.com/v1/search?page=2',
          photos: [PHOTO],
        }),
      );
    const page = await provider(fetchImpl).search(photoQuery);
    expect(page.items).toHaveLength(1);
    expect(page.totalResults).toBe(8000);
    expect(page.hasMore).toBe(true);
  });

  it('reports hasMore false on the last page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ total_results: 1, photos: [PHOTO] }));
    expect((await provider(fetchImpl).search(photoQuery)).hasMore).toBe(false);
  });

  it('keeps the good rows when one record is malformed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(respond({ photos: [{ id: 1 }, PHOTO, { nonsense: true }] }));
    // One odd row must not cost the user their other results.
    expect((await provider(fetchImpl).search(photoQuery)).items).toHaveLength(1);
  });

  it('returns an empty page rather than an error for no results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ total_results: 0, photos: [] }));
    const page = await provider(fetchImpl).search(photoQuery);
    expect(page.items).toEqual([]);
    expect(page.totalResults).toBe(0);
  });
});

describe('quota observation', () => {
  it('parses the rate-limit headers onto the page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respond(
        { photos: [PHOTO] },
        {
          headers: {
            'x-ratelimit-limit': '20000',
            'x-ratelimit-remaining': '19980',
            'x-ratelimit-reset': RESET,
          },
        },
      ),
    );
    const page = await provider(fetchImpl).search(photoQuery);
    expect(page.quota).toMatchObject({ limit: 20000, remaining: 19980 });
  });

  it('succeeds with no quota when the provider sends no headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond({ photos: [PHOTO] }));
    const page = await provider(fetchImpl).search(photoQuery);
    expect(page.quota).toBeUndefined();
    expect(page.items).toHaveLength(1);
  });
});

describe('failures', () => {
  const cases: readonly [number, string][] = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ];

  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const fetchImpl = vi.fn().mockResolvedValue(respond({}, { status }));
      await expect(provider(fetchImpl).search(photoQuery)).rejects.toMatchObject({ code });
    });
  }

  it('separates an hourly 429 from a spent month', async () => {
    const hourly = vi.fn().mockResolvedValue(
      respond(
        {},
        {
          status: 429,
          headers: {
            'x-ratelimit-limit': '20000',
            'x-ratelimit-remaining': '19400',
            'x-ratelimit-reset': RESET,
            'retry-after': '120',
          },
        },
      ),
    );
    await expect(provider(hourly).search(photoQuery)).rejects.toMatchObject({
      code: 'rate_limited',
      detail: 'retry after 120s',
    });

    const spent = vi.fn().mockResolvedValue(
      respond(
        {},
        {
          status: 429,
          headers: {
            'x-ratelimit-limit': '20000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': RESET,
          },
        },
      ),
    );
    // "Try again within the hour" would send this user back 400 times before
    // September. The month is genuinely spent and the sentence must say so.
    await expect(provider(spent).search(photoQuery)).rejects.toMatchObject({
      code: 'quota_exhausted',
    });
  });

  it('maps malformed JSON and an unexpected shape to provider_unavailable', async () => {
    const bad = vi.fn().mockResolvedValue(respond('<html>oops</html>'));
    await expect(provider(bad).search(photoQuery)).rejects.toMatchObject({
      code: 'provider_unavailable',
      detail: 'malformed JSON',
    });

    const shape = vi.fn().mockResolvedValue(respond({ photos: 'not-an-array' }));
    await expect(provider(shape).search(photoQuery)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });

  it('tells a cancel, a timeout and a dropped connection apart', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });

    const cancelled = vi.fn().mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();
    await expect(provider(cancelled).search(photoQuery, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });

    const timedOut = vi.fn().mockRejectedValue(abortError);
    await expect(provider(timedOut).search(photoQuery)).rejects.toMatchObject({ code: 'timeout' });

    const dropped = vi.fn().mockRejectedValue(new TypeError('network error'));
    // Saying "no network connection" because the user typed another letter is a
    // lie the UI then acts on.
    await expect(provider(dropped).search(photoQuery)).rejects.toMatchObject({ code: 'offline' });
  });

  it('always throws a StockProviderError, never a raw one', async () => {
    const fetchImpl = vi.fn().mockRejectedValue('a bare string');
    await expect(provider(fetchImpl).search(photoQuery)).rejects.toBeInstanceOf(StockProviderError);
  });
});

describe('createStockProvider', () => {
  it('builds the pexels adapter', () => {
    expect(createStockProvider('pexels', { apiKey: 'k' }).name).toBe('pexels');
  });
});
