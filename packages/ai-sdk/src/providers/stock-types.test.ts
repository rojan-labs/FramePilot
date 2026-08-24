import { describe, expect, it } from 'vitest';
import {
  STOCK_ERROR_CODES,
  chooseVariant,
  isStockMediaKind,
  isStockOrientation,
  isStockProviderName,
  isVariantBelowTarget,
  parseQuotaHeaders,
  parseRetryAfterSeconds,
  safeStockFormat,
  stockErrorMessage,
  StockProviderError,
  toStockItemWire,
  type StockItem,
  type StockVariant,
} from './stock-types.js';

/** A `Headers`-shaped stub, case-insensitive like the real thing. */
function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function variant(overrides: Partial<StockVariant> = {}): StockVariant {
  return {
    id: 'v1',
    width: 1920,
    height: 1080,
    contentType: 'video/mp4',
    format: 'mp4',
    url: 'https://cdn.example.com/a.mp4',
    ...overrides,
  };
}

describe('roster guards', () => {
  it('narrows only known values', () => {
    expect(isStockProviderName('pexels')).toBe(true);
    expect(isStockProviderName('unsplash')).toBe(false);
    expect(isStockMediaKind('photo')).toBe(true);
    expect(isStockMediaKind('audio')).toBe(false);
    expect(isStockOrientation('portrait')).toBe(true);
    expect(isStockOrientation('tall')).toBe(false);
  });
});

describe('stockErrorMessage', () => {
  it('gives every arm a specific sentence', () => {
    for (const code of STOCK_ERROR_CODES) {
      const message = stockErrorMessage(code);
      if (code === 'cancelled') {
        // The user did it on purpose. Saying so would be noise.
        expect(message).toBe('');
        continue;
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/something went wrong/i);
    }
  });

  it('separates the hourly and monthly limits, because the provider does not', () => {
    expect(stockErrorMessage('rate_limited')).toMatch(/hourly/i);
    expect(stockErrorMessage('quota_exhausted')).toMatch(/month/i);
    expect(stockErrorMessage('rate_limited')).not.toBe(stockErrorMessage('quota_exhausted'));
  });

  it('appends a detail but never decorates silence', () => {
    expect(stockErrorMessage('timeout', 'HTTP 504')).toBe(
      'Pexels took too long to answer. (HTTP 504)',
    );
    expect(stockErrorMessage('cancelled', 'ignored')).toBe('');
  });

  it('carries the code and detail on the thrown error', () => {
    const error = new StockProviderError('unauthorized', 'HTTP 401');
    expect(error.code).toBe('unauthorized');
    expect(error.detail).toBe('HTTP 401');
    expect(error.name).toBe('StockProviderError');
  });
});

describe('parseQuotaHeaders', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const reset = Math.floor(new Date('2026-09-01T00:00:00.000Z').getTime() / 1000);

  it('parses a complete set, case-insensitively', () => {
    const observation = parseQuotaHeaders(
      headers({
        'X-Ratelimit-Limit': '20000',
        'X-Ratelimit-Remaining': '18431',
        'X-Ratelimit-Reset': String(reset),
      }),
      now,
    );
    expect(observation).toEqual({
      limit: 20000,
      remaining: 18431,
      resetAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-08-24T12:00:00.000Z',
    });
  });

  it('is all three headers or nothing', () => {
    expect(
      parseQuotaHeaders(headers({ 'x-ratelimit-limit': '20000' }), now),
    ).toBeUndefined();
    expect(
      parseQuotaHeaders(
        headers({ 'x-ratelimit-limit': '20000', 'x-ratelimit-remaining': '10' }),
        now,
      ),
    ).toBeUndefined();
    expect(parseQuotaHeaders(headers({}), now)).toBeUndefined();
  });

  it('rejects implausible values rather than rendering them', () => {
    const base = { 'x-ratelimit-limit': '20000', 'x-ratelimit-reset': String(reset) };
    // remaining > limit means we misread one of them; a >100% bar reads as an app bug.
    expect(
      parseQuotaHeaders(headers({ ...base, 'x-ratelimit-remaining': '20001' }), now),
    ).toBeUndefined();
    expect(
      parseQuotaHeaders(headers({ ...base, 'x-ratelimit-remaining': 'lots' }), now),
    ).toBeUndefined();
    expect(
      parseQuotaHeaders(headers({ ...base, 'x-ratelimit-remaining': '-1' }), now),
    ).toBeUndefined();
    expect(
      parseQuotaHeaders(
        headers({ 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0', ...base }),
        now,
      ),
    ).toBeDefined();
  });

  it('rejects a reset beyond any plausible monthly horizon', () => {
    // A seconds/milliseconds mix-up would otherwise render "resets in 1,700 years".
    const observation = parseQuotaHeaders(
      headers({
        'x-ratelimit-limit': '20000',
        'x-ratelimit-remaining': '1',
        'x-ratelimit-reset': String(reset * 1000 * 1000),
      }),
      now,
    );
    expect(observation).toBeUndefined();
  });

  it('rescales a millisecond reset that still lands inside the horizon', () => {
    const observation = parseQuotaHeaders(
      headers({
        'x-ratelimit-limit': '20000',
        'x-ratelimit-remaining': '1',
        'x-ratelimit-reset': String(reset * 1000),
      }),
      now,
    );
    expect(observation?.resetAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads a numeric header', () => {
    expect(parseRetryAfterSeconds(headers({ 'retry-after': '120' }))).toBe(120);
  });

  it('returns undefined rather than inventing a wait', () => {
    expect(parseRetryAfterSeconds(headers({}))).toBeUndefined();
    expect(parseRetryAfterSeconds(headers({ 'retry-after': 'soon' }))).toBeUndefined();
  });
});

describe('chooseVariant', () => {
  const renditions = [
    variant({ id: '4k', width: 3840, height: 2160, fps: 25 }),
    variant({ id: 'hd', width: 1920, height: 1080, fps: 25 }),
    variant({ id: 'sd', width: 1280, height: 720, fps: 25 }),
    variant({ id: 'tiny', width: 640, height: 360, fps: 25 }),
  ];

  it('takes the smallest rendition that still covers the project', () => {
    expect(chooseVariant(renditions, { height: 1080 }).id).toBe('hd');
    expect(chooseVariant(renditions, { height: 720 }).id).toBe('sd');
  });

  it('never just takes the biggest', () => {
    // The whole point: a 4K download into a 1080p project is wasted bytes.
    expect(chooseVariant(renditions, { height: 1080 }).id).not.toBe('4k');
  });

  it('takes an exact match when one exists', () => {
    expect(chooseVariant(renditions, { height: 2160 }).id).toBe('4k');
  });

  it('falls back to the largest available when nothing covers, and says so', () => {
    const small = [variant({ id: 'sd', width: 1280, height: 720 })];
    const chosen = chooseVariant(small, { height: 2160 });
    expect(chosen.id).toBe('sd');
    expect(isVariantBelowTarget(chosen, { height: 2160 })).toBe(true);
    expect(isVariantBelowTarget(chosen, { height: 720 })).toBe(false);
  });

  it('breaks a height tie on nearest frame rate', () => {
    const mixed = [
      variant({ id: 'hd60', height: 1080, width: 1920, fps: 60 }),
      variant({ id: 'hd24', height: 1080, width: 1920, fps: 24 }),
    ];
    expect(chooseVariant(mixed, { height: 1080, fps: 24 }).id).toBe('hd24');
    expect(chooseVariant(mixed, { height: 1080, fps: 60 }).id).toBe('hd60');
  });

  it('handles a single-variant list', () => {
    expect(chooseVariant([variant({ id: 'only' })], { height: 4320 }).id).toBe('only');
  });
});

describe('toStockItemWire', () => {
  const item: StockItem = {
    remoteId: '3129671',
    provider: 'pexels',
    kind: 'video',
    title: 'City skyline at dusk',
    width: 3840,
    height: 2160,
    durationSeconds: 12,
    avgColor: '#6a8fbf',
    thumbnailUrl: 'https://images.pexels.com/thumb.jpg',
    previewUrl: 'https://cdn.example.com/preview.mp4',
    variants: [variant({ id: 'hd', approxBytes: 24_000_000 })],
    license: 'pexels',
    licenseUrl: 'https://www.pexels.com/license/',
    attributionRequired: false,
    attribution: 'Video by Jane Doe on Pexels',
    creator: 'Jane Doe',
    creatorUrl: 'https://www.pexels.com/@janedoe',
    sourceUrl: 'https://www.pexels.com/video/3129671/',
  };

  it('strips every provider URL', () => {
    const wire = toStockItemWire(item);
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('images.pexels.com');
    expect(serialized).not.toContain('cdn.example.com');
    expect(wire).not.toHaveProperty('thumbnailUrl');
    expect(wire).not.toHaveProperty('previewUrl');
    for (const v of wire.variants) expect(v).not.toHaveProperty('url');
  });

  it('keeps what the panel must render', () => {
    const wire = toStockItemWire(item);
    // The tile shows "1920×1080 · 24 MB" without ever being able to fetch it.
    expect(wire.variants[0]).toMatchObject({ width: 1920, height: 1080, approxBytes: 24_000_000 });
    expect(wire.hasPreview).toBe(true);
    expect(wire.avgColor).toBe('#6a8fbf');
    expect(wire.creatorUrl).toBe('https://www.pexels.com/@janedoe');
  });

  it('reports a missing preview without leaking its absence as a URL', () => {
    const { previewUrl: _dropped, ...withoutPreview } = item;
    expect(toStockItemWire(withoutPreview).hasPreview).toBe(false);
  });
});

describe('safeStockFormat', () => {
  it('maps known types and tolerates parameters', () => {
    expect(safeStockFormat('image/jpeg', 'photo')).toBe('jpg');
    expect(safeStockFormat('image/jpeg; charset=utf-8', 'photo')).toBe('jpg');
    expect(safeStockFormat('video/mp4', 'video')).toBe('mp4');
  });

  it('falls back by kind rather than trusting provider text on the filesystem', () => {
    expect(safeStockFormat('application/octet-stream', 'video')).toBe('mp4');
    expect(safeStockFormat('../../etc/passwd', 'photo')).toBe('jpg');
  });
});
