/**
 * Pexels stock photo & video adapter.
 *
 * Pexels is the only self-serve candidate that covers **photos and videos under
 * one free, instantly-issued key**, with a content licence that permits
 * commercial use and obliges the end user to credit nobody
 * (`plan/3rd-party-sourcing/photo-video/PEXELS-API.md`).
 *
 * ## Two normalizations that matter more than the rest
 *
 * **Photos download at `original` only.** Pexels' other `src` sizes are not
 * scaled copies — they are *crops* into fixed boxes (`large` is a 940×650 box,
 * `medium` a 350px-high one). A 16:9 photo fetched as `large` comes back at
 * roughly 1.45:1, so a timeline that trusted the search result's aspect ratio
 * would letterbox or stretch it at render time. The smaller sizes are therefore
 * used for grid tiles, where a crop is exactly what you want, and never as a
 * download variant.
 *
 * **Videos download by rendition.** `video_files` carries real `width`/`height`/
 * `fps` per entry, so {@link chooseVariant} can pick the smallest rendition that
 * still covers the project — which is the difference between a 24 MB download and
 * a 400 MB one nobody asked for.
 *
 * ## Attribution is requested, not required
 *
 * `attributionRequired` is FALSE, deliberately. The Pexels *content* licence
 * obliges the end user to credit nobody; the *API guidelines* oblige the app to
 * show a prominent Pexels link, which the panel does. Setting this TRUE "to be
 * safe" would tell users their video needs a credit line it does not, teaching
 * them to ignore the badge that is real on a CC-BY music track
 * (`photo-video/README.md` §D4). The photographer's name is still carried
 * through, and surfaced as a *suggested* credit.
 *
 * ## Quota is observed here, decided elsewhere
 *
 * Every response's `X-Ratelimit-*` headers are parsed onto the returned page.
 * This adapter never interprets them — the main-process store does. Note that
 * only the **monthly** allowance is reported; the ~200/hour cap is invisible, so
 * a 429 is surfaced as its own error rather than reconciled against a
 * healthy-looking remaining count.
 */
import { z } from 'zod';
import { createLogger } from '@framepilot/shared-types';
import {
  STOCK_SEARCH_MAX_LIMIT,
  STOCK_SEARCH_TIMEOUT_MS,
  StockProviderError,
  isSafeStockUrl,
  parseQuotaHeaders,
  safeStockFormat,
  type StockItem,
  type StockMediaKind,
  type StockProvider,
  type StockSearchPage,
  type StockSearchQuery,
  type StockVariant,
} from './stock-types.js';
import type { HeaderLike } from './errors.js';
import type { FetchLike } from './types.js';

const log = createLogger('ai-sdk:providers:pexels-stock');

export const PEXELS_PHOTO_SEARCH_URL = 'https://api.pexels.com/v1/search';
export const PEXELS_VIDEO_SEARCH_URL = 'https://api.pexels.com/videos/search';

/**
 * Where an empty query goes.
 *
 * A panel that shows nothing until the user types is a panel that looks broken,
 * and "search for a shot" is a worse first prompt than a wall of usable shots.
 * Pexels publishes exactly this list — hand-picked photos, most-watched video —
 * so browsing is the provider's own front page rather than a query invented here
 * and presented as if it were curation.
 */
export const PEXELS_PHOTO_CURATED_URL = 'https://api.pexels.com/v1/curated';
export const PEXELS_VIDEO_POPULAR_URL = 'https://api.pexels.com/videos/popular';

/**
 * Pexels asks integrators to identify themselves, and a generic agent string
 * earns harsher throttling. Being anonymous about it would also be rude to a
 * service handing out free keys.
 */
const USER_AGENT = 'FramePilot/1.0 (+https://framepilot.app)';

/** The canonical licence page, so a curious user can read the actual terms. */
const PEXELS_LICENSE_URL = 'https://www.pexels.com/license/';

// ---------------------------------------------------------------------------
// Response schemas — as loose as the API actually behaves
// ---------------------------------------------------------------------------

const PhotoSrcSchema = z.object({
  original: z.string().nullish(),
  large2x: z.string().nullish(),
  large: z.string().nullish(),
  medium: z.string().nullish(),
  small: z.string().nullish(),
  tiny: z.string().nullish(),
});

const PexelsPhotoSchema = z.object({
  id: z.union([z.number(), z.string()]),
  width: z.number(),
  height: z.number(),
  url: z.string().nullish(),
  photographer: z.string().nullish(),
  photographer_url: z.string().nullish(),
  avg_color: z.string().nullish(),
  alt: z.string().nullish(),
  src: PhotoSrcSchema,
});

const PexelsVideoFileSchema = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  quality: z.string().nullish(),
  file_type: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  fps: z.number().nullish(),
  link: z.string().nullish(),
});

const PexelsVideoSchema = z.object({
  id: z.union([z.number(), z.string()]),
  width: z.number(),
  height: z.number(),
  url: z.string().nullish(),
  image: z.string().nullish(),
  duration: z.number().nullish(),
  avg_color: z.string().nullish(),
  user: z
    .object({
      id: z.union([z.number(), z.string()]).nullish(),
      name: z.string().nullish(),
      url: z.string().nullish(),
    })
    .nullish(),
  video_files: z.array(z.unknown()).nullish(),
});

const SearchEnvelopeSchema = z.object({
  page: z.number().nullish(),
  per_page: z.number().nullish(),
  total_results: z.number().nullish(),
  next_page: z.string().nullish(),
  photos: z.array(z.unknown()).nullish(),
  videos: z.array(z.unknown()).nullish(),
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * A duration outside this range is a bad record, not a long clip. Range-checked
 * before it can reach a patch builder and produce an absurd clip length.
 */
const MAX_CLIP_SECONDS = 60 * 30;

function positiveInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

/** Pexels ids arrive as numbers; everything downstream keys on strings. */
function remoteId(raw: number | string): string {
  return String(raw).trim();
}

/**
 * A short, human label for a tile.
 *
 * `alt` is the right answer when Pexels supplies one — it is real descriptive
 * text written for accessibility, which is exactly what a tile's accessible name
 * should be. It is frequently empty, hence the fallback.
 */
function titleFor(alt: string | null | undefined, kind: StockMediaKind, id: string): string {
  const trimmed = (alt ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length > 0) return trimmed.slice(0, 200);
  return kind === 'video' ? `Video ${id}` : `Photo ${id}`;
}

/** `#RRGGBB` only. Anything else is dropped rather than injected into a style. */
function safeAvgColor(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

/** `Photo by Jane Doe on Pexels` — the courtesy credit, ready to paste. */
function creditLine(creator: string | undefined, kind: StockMediaKind): string | undefined {
  if (creator === undefined) return undefined;
  return `${kind === 'video' ? 'Video' : 'Photo'} by ${creator} on Pexels`;
}

/**
 * Normalize one Pexels photo, or `null` if it cannot be used.
 *
 * Returning `null` rather than throwing is the point: one odd record must not
 * cost the user their other twenty-three results.
 */
export function normalizePexelsPhoto(raw: unknown): StockItem | null {
  const parsed = PexelsPhotoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const record = parsed.data;

  const width = positiveInt(record.width);
  const height = positiveInt(record.height);
  if (width === null || height === null) return null;

  const original = record.src.original ?? '';
  if (!isSafeStockUrl(original)) return null;

  // Only `original` is a download variant. The other sizes are crops into fixed
  // boxes, so their dimensions do not describe the same image — see the module
  // note. Using one as a download would quietly change the photo's aspect ratio.
  const variants: StockVariant[] = [
    {
      id: 'original',
      width,
      height,
      contentType: 'image/jpeg',
      format: 'jpg',
      url: original,
    },
  ];

  // Tile bytes, where a crop is exactly what is wanted. `medium` first because
  // it is the smallest size that still reads at grid scale.
  const thumbnailUrl = firstSafeUrl([
    record.src.medium,
    record.src.small,
    record.src.tiny,
    original,
  ]);
  if (thumbnailUrl === undefined) return null;

  const id = remoteId(record.id);
  const creator = trimmedOrUndefined(record.photographer);
  const creatorUrl = safeOrUndefined(record.photographer_url);
  const sourceUrl = safeOrUndefined(record.url);
  const avgColor = safeAvgColor(record.avg_color);
  const attribution = creditLine(creator, 'photo');

  return {
    remoteId: id,
    provider: 'pexels',
    kind: 'photo',
    title: titleFor(record.alt, 'photo', id),
    width,
    height,
    ...(avgColor !== undefined ? { avgColor } : {}),
    thumbnailUrl,
    variants,
    license: 'pexels',
    licenseUrl: PEXELS_LICENSE_URL,
    // See the module note: requested, not required.
    attributionRequired: false,
    ...(attribution !== undefined ? { attribution } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(creatorUrl !== undefined ? { creatorUrl } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

/** Normalize one Pexels video, or `null` if it cannot be used. */
export function normalizePexelsVideo(raw: unknown): StockItem | null {
  const parsed = PexelsVideoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const record = parsed.data;

  const width = positiveInt(record.width);
  const height = positiveInt(record.height);
  if (width === null || height === null) return null;

  const duration = positiveInt(record.duration);
  if (duration === null || duration > MAX_CLIP_SECONDS) return null;

  const variants = (record.video_files ?? [])
    .map(normalizeVideoFile)
    .filter((variant): variant is StockVariant => variant !== null);
  if (variants.length === 0) return null;

  const thumbnailUrl = firstSafeUrl([record.image]);
  if (thumbnailUrl === undefined) return null;

  // The smallest rendition doubles as the hover-scrub source: seeking is a
  // decode, and decoding 4K to answer a mouse move would make scrubbing feel
  // broken on exactly the machines that need it to feel good.
  const previewUrl = [...variants].sort((a, b) => a.height - b.height)[0]?.url;

  const id = remoteId(record.id);
  const creator = trimmedOrUndefined(record.user?.name);
  const creatorUrl = safeOrUndefined(record.user?.url);
  const sourceUrl = safeOrUndefined(record.url);
  const avgColor = safeAvgColor(record.avg_color);
  const attribution = creditLine(creator, 'video');

  return {
    remoteId: id,
    provider: 'pexels',
    kind: 'video',
    title: titleFor(null, 'video', id),
    width,
    height,
    durationSeconds: duration,
    ...(avgColor !== undefined ? { avgColor } : {}),
    thumbnailUrl,
    ...(previewUrl !== undefined ? { previewUrl } : {}),
    variants,
    license: 'pexels',
    licenseUrl: PEXELS_LICENSE_URL,
    attributionRequired: false,
    ...(attribution !== undefined ? { attribution } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(creatorUrl !== undefined ? { creatorUrl } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

function normalizeVideoFile(raw: unknown): StockVariant | null {
  const parsed = PexelsVideoFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const file = parsed.data;

  const width = positiveInt(file.width);
  const height = positiveInt(file.height);
  if (width === null || height === null) return null;

  const link = file.link ?? '';
  if (!isSafeStockUrl(link)) return null;

  const contentType = (file.file_type ?? 'video/mp4').trim().toLowerCase();
  const fps =
    typeof file.fps === 'number' && Number.isFinite(file.fps) && file.fps > 0
      ? Math.round(file.fps * 100) / 100
      : undefined;

  return {
    // `quality` alone is not an id — a result routinely carries several `hd`
    // entries — so the dimensions are folded in to keep it stable and unique.
    id: file.id != null ? remoteId(file.id) : `${width}x${height}`,
    width,
    height,
    ...(fps !== undefined ? { fps } : {}),
    contentType,
    format: safeStockFormat(contentType, 'video'),
    url: link,
  };
}

function trimmedOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = trimmedOrUndefined(value);
  return trimmed !== undefined && isSafeStockUrl(trimmed) ? trimmed : undefined;
}

function firstSafeUrl(candidates: readonly (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const safe = safeOrUndefined(candidate);
    if (safe !== undefined) return safe;
  }
  return undefined;
}

/** The endpoint for this kind, in the mode the caller is in. */
function browseOrSearchUrl(kind: StockSearchQuery['kind'], browsing: boolean): string {
  if (kind === 'video') return browsing ? PEXELS_VIDEO_POPULAR_URL : PEXELS_VIDEO_SEARCH_URL;
  return browsing ? PEXELS_PHOTO_CURATED_URL : PEXELS_PHOTO_SEARCH_URL;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface PexelsStockConfig {
  readonly apiKey: string;
}

export class PexelsStockProvider implements StockProvider {
  public readonly name = 'pexels' as const;

  public constructor(
    private readonly config: PexelsStockConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as FetchLike,
  ) {}

  public async search(query: StockSearchQuery, signal?: AbortSignal): Promise<StockSearchPage> {
    const text = query.text.trim();
    // No words means browse, not "no results": the curated endpoints answer with
    // the same envelope the search ones do, so only the URL changes here.
    const browsing = text === '';
    if (this.config.apiKey.trim() === '') throw new StockProviderError('no_key');

    const limit = Math.max(1, Math.min(query.limit, STOCK_SEARCH_MAX_LIMIT));
    const page = Math.max(1, Math.trunc(query.page));
    const url = new URL(browseOrSearchUrl(query.kind, browsing));
    if (!browsing) url.searchParams.set('query', text);
    url.searchParams.set('per_page', String(limit));
    url.searchParams.set('page', String(page));
    // `orientation` is a search-only filter; the curated endpoints reject it.
    if (query.orientation !== undefined && !browsing) {
      url.searchParams.set('orientation', query.orientation);
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), STOCK_SEARCH_TIMEOUT_MS);
    const onCallerAbort = (): void => timeout.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      // The query text goes to the provider; nothing else about the project does.
      log.action('search → request', {
        provider: 'pexels',
        kind: query.kind,
        mode: browsing ? 'browse' : 'search',
        page,
        limit,
      });
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          // No `Bearer` prefix. Pexels takes the raw key, and prefixing it
          // produces a 401 that looks convincingly like a bad key.
          authorization: this.config.apiKey,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        signal: timeout.signal,
      });

      // `FetchLike` types headers as optional, because the streaming seam it was
      // written for does not always carry them. Absent headers simply mean no
      // quota observation, which is a fact the store already knows how to hold.
      const quota =
        response.headers === undefined
          ? undefined
          : parseQuotaHeaders(response.headers, new Date());
      if (!response.ok)
        throw this.statusToError(response.status, response.headers, quota?.remaining);

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        throw new StockProviderError('provider_unavailable', 'malformed JSON');
      }

      const envelope = SearchEnvelopeSchema.safeParse(payload);
      if (!envelope.success) {
        throw new StockProviderError('provider_unavailable', 'unexpected response shape');
      }

      const raw = (query.kind === 'video' ? envelope.data.videos : envelope.data.photos) ?? [];
      const normalize = query.kind === 'video' ? normalizePexelsVideo : normalizePexelsPhoto;
      const items = raw.map(normalize).filter((item): item is StockItem => item !== null);
      const totalResults = envelope.data.total_results ?? items.length;

      log.action('search → results', {
        provider: 'pexels',
        kind: query.kind,
        returned: raw.length,
        usable: items.length,
      });

      return {
        items,
        page,
        totalResults,
        // `next_page` is provider-supplied and deliberately not followed
        // verbatim — it is untrusted input like everything else. Its presence is
        // all we take from it.
        hasMore: typeof envelope.data.next_page === 'string' && envelope.data.next_page !== '',
        ...(quota !== undefined ? { quota } : {}),
      };
    } catch (error) {
      throw this.toProviderError(error, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Map an HTTP status onto the closed union.
   *
   * The 429 split is the interesting one: with `remaining` at zero the month is
   * genuinely spent, and telling the user to "try again within the hour" would
   * send them back four hundred times before September.
   */
  private statusToError(
    status: number,
    headers: HeaderLike | undefined,
    remaining?: number,
  ): StockProviderError {
    if (status === 401 || status === 403) return new StockProviderError('unauthorized');
    if (status === 429) {
      if (remaining === 0) return new StockProviderError('quota_exhausted');
      const retryAfter = headers?.get('retry-after') ?? null;
      return new StockProviderError(
        'rate_limited',
        retryAfter ? `retry after ${retryAfter}s` : undefined,
      );
    }
    return new StockProviderError('provider_unavailable', `HTTP ${status}`);
  }

  /**
   * Distinguish the three ways an aborted or failed fetch look identical.
   *
   * A caller-cancelled search, a timed-out one, and a dropped connection all
   * arrive as thrown errors. Telling the user "no network connection" because
   * they typed another letter is a lie the UI then acts on.
   */
  private toProviderError(error: unknown, signal?: AbortSignal): StockProviderError {
    if (error instanceof StockProviderError) return error;
    if (signal?.aborted === true) return new StockProviderError('cancelled');
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new StockProviderError('timeout');
    }
    return new StockProviderError('offline', error instanceof Error ? error.message : undefined);
  }
}

/**
 * Build the configured provider.
 *
 * `fetchImpl` is injected so adapter tests run against recorded fixture
 * responses with **no live network in CI**.
 */
export function createStockProvider(
  name: 'pexels',
  config: PexelsStockConfig,
  fetchImpl?: FetchLike,
): StockProvider {
  // The union has one member today. The switch exists so adding the second
  // provider is a compile error here rather than a silent fallthrough.
  switch (name) {
    case 'pexels':
      return new PexelsStockProvider(config, fetchImpl);
  }
}
