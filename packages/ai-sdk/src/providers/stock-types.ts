/**
 * @framepilot/ai-sdk/providers/stock-types — stock photo & video contracts.
 *
 * One provider, one adapter, a named union — the same shape as `music-types.ts`,
 * and for the same reason: the second provider generalizes this when it actually
 * lands, not in anticipation of it (`plan/3rd-party-sourcing/photo-video/README.md`
 * §D2, `.agents/rules/product-discipline.mdc` §5).
 *
 * ## Why the error union is duplicated rather than shared with music
 *
 * Nine of these arms have a music counterpart, and the plan proposed extracting a
 * shared union now that a second consumer exists. Implementation found the stop
 * condition it wrote for itself: the **sentences diverge**. "The music provider
 * rejected this request" and "Pexels rejected this key. Check it in Settings."
 * are not the same sentence, and a shared table that took a provider label as a
 * parameter would produce worse copy on both sides while coupling a shipped
 * feature to a new one. Two small closed unions beat one leaky shared one
 * (`PHASE-1-provider-adapter.md` §P1.1).
 *
 * ## All provider input is untrusted
 *
 * Responses are Zod-parsed at the boundary. A title renders as text and never as
 * markup; every URL is scheme-checked before the main process fetches it; every
 * dimension and duration is range-checked before it can reach the timeline.
 */
import { z } from 'zod';
// One scheme check for both provider families. `music-types` owns it because it
// shipped first; duplicating it would give the two adapters two ideas of what a
// safe URL is, which is exactly one idea too many.
import { isHttpsUrl } from './music-types.js';
// Likewise `HeaderLike` and the `Retry-After` parser: `errors.ts` already had
// both, and a second copy would be a second set of edge cases to keep in step.
import { parseRetryAfterMs, type HeaderLike } from './errors.js';

/** Re-exported under a stock-facing name so this adapter family has one import. */
export const isSafeStockUrl = isHttpsUrl;

/** User-facing provider roster. Settings and new requests derive from this tuple. */
export const STOCK_PROVIDER_NAMES = ['pexels'] as const;
export type StockProviderName = (typeof STOCK_PROVIDER_NAMES)[number];

/** Narrow an untrusted string to a known provider. */
export function isStockProviderName(value: string): value is StockProviderName {
  return (STOCK_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Two media kinds, one provider, one panel.
 *
 * Deliberately not `AssetKind`: that union includes `audio`, which this provider
 * does not serve. A type that can express "search Pexels for audio" invites a
 * caller to try.
 */
export const STOCK_MEDIA_KINDS = ['photo', 'video'] as const;
export type StockMediaKind = (typeof STOCK_MEDIA_KINDS)[number];

export function isStockMediaKind(value: string): value is StockMediaKind {
  return (STOCK_MEDIA_KINDS as readonly string[]).includes(value);
}

/**
 * Every failure the stock surface can produce, as one closed union.
 *
 * `rate_limited` and `quota_exhausted` are two arms rather than one on purpose.
 * They need different sentences and different remedies — wait an hour, versus
 * wait until next month — and the provider reports only the monthly figure in its
 * headers, so collapsing them would let a healthy-looking monthly bar contradict
 * the error beside it (`PEXELS-API.md` §3).
 */
export const STOCK_ERROR_CODES = [
  'no_key',
  'unauthorized',
  'rate_limited',
  'quota_exhausted',
  'provider_unavailable',
  'offline',
  'timeout',
  'cancelled',
  'too_large',
  'disk_full',
  'download_failed',
  'derive_failed',
] as const;
export type StockErrorCode = (typeof STOCK_ERROR_CODES)[number];

/**
 * The sentence the user sees for each failure.
 *
 * `cancelled` is deliberately empty: the user did it on purpose, and telling them
 * so is noise. Callers must treat an empty string as "return to idle silently".
 */
export function stockErrorMessage(code: StockErrorCode, detail?: string): string {
  const sentence = stockErrorSentence(code);
  return sentence === '' || detail === undefined ? sentence : `${sentence} (${detail})`;
}

function stockErrorSentence(code: StockErrorCode): string {
  switch (code) {
    case 'no_key':
      return 'Add your Pexels API key in Settings to search.';
    case 'unauthorized':
      return 'Pexels rejected this key. Check it in Settings.';
    case 'rate_limited':
      return "You've hit the hourly limit of about 200 requests. It clears within the hour.";
    case 'quota_exhausted':
      return "You've used this month's request allowance.";
    case 'provider_unavailable':
      return 'Pexels is not responding. Try again shortly.';
    case 'offline':
      return 'No network connection.';
    case 'timeout':
      return 'Pexels took too long to answer.';
    case 'cancelled':
      return '';
    case 'too_large':
      return 'That file is larger than the 2 GB limit. Pick a smaller size.';
    case 'disk_full':
      return 'Not enough disk space to save this file.';
    case 'download_failed':
      return "The download didn't finish. Nothing was added.";
    case 'derive_failed':
      return "Saved the file, but couldn't read its thumbnails.";
  }
}

/**
 * A failure with a code and, where it helps, the specific detail behind it.
 *
 * Thrown by adapters rather than returned, so a caller cannot forget to check —
 * the search handler converts it to a wire result at exactly one place.
 */
export class StockProviderError extends Error {
  public constructor(
    public readonly code: StockErrorCode,
    public readonly detail?: string,
  ) {
    super(detail ? `${stockErrorMessage(code)} (${detail})` : stockErrorMessage(code));
    this.name = 'StockProviderError';
  }
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * What one provider response told us about the quota. Facts only.
 *
 * Note the absence of anything hourly. Pexels enforces ~200 requests/hour *and*
 * 20,000/month, but only reports the monthly figure. Inventing an hourly field
 * here would mean inventing its value somewhere, and a fabricated number in a
 * quota readout is worse than an absent one.
 */
export interface StockQuotaObservation {
  /** `X-Ratelimit-Limit` — the MONTHLY allowance. */
  readonly limit: number;
  /** `X-Ratelimit-Remaining`. */
  readonly remaining: number;
  /** `X-Ratelimit-Reset` as ISO-8601: when the monthly period rolls over. */
  readonly resetAt: string;
  /** ISO-8601. When *we* saw it — every displayed number is "as of" this. */
  readonly observedAt: string;
}

/**
 * A reset timestamp further out than this is not a monthly rollover, it is a
 * parse error wearing one. Guards against a seconds/milliseconds mix-up landing
 * a "resets in 1,700 years" in the Settings panel.
 */
const MAX_RESET_HORIZON_MS = 70 * 24 * 60 * 60 * 1000;

/**
 * Parse the three rate-limit headers into one observation, or `undefined`.
 *
 * **All three or nothing.** A partial set yields `undefined` rather than a
 * half-filled observation, because a bar rendered from a limit with no remaining
 * is a guess, and this whole surface exists to avoid guessing.
 */
export function parseQuotaHeaders(
  headers: HeaderLike,
  at: Date,
): StockQuotaObservation | undefined {
  const limit = numericHeader(headers, 'x-ratelimit-limit');
  const remaining = numericHeader(headers, 'x-ratelimit-remaining');
  const reset = numericHeader(headers, 'x-ratelimit-reset');
  if (limit === null || remaining === null || reset === null) return undefined;

  // A remaining count above the limit means we misread one of them. Rendering it
  // would produce a progress bar past 100%, which reads as a bug in the app
  // rather than in the response.
  if (limit <= 0 || remaining < 0 || remaining > limit) return undefined;

  // The provider documents seconds. Anything that looks like milliseconds is
  // rescaled rather than rejected, because a plausible reset is worth more than
  // a strict one — but only if the result still lands inside the horizon.
  const epochMs = reset > 1e11 ? reset : reset * 1000;
  const resetAt = new Date(epochMs);
  if (!Number.isFinite(resetAt.getTime())) return undefined;
  if (resetAt.getTime() - at.getTime() > MAX_RESET_HORIZON_MS) return undefined;

  return {
    limit,
    remaining,
    resetAt: resetAt.toISOString(),
    observedAt: at.toISOString(),
  };
}

function numericHeader(headers: HeaderLike, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `Retry-After` in whole seconds, when the provider bothers to send one.
 *
 * Seconds rather than the milliseconds `parseRetryAfterMs` returns, because this
 * value is rendered to a person ("try again in 90 seconds") rather than fed to a
 * timer. Never invented: absent stays absent.
 */
export function parseRetryAfterSeconds(headers: HeaderLike): number | undefined {
  const ms = parseRetryAfterMs(headers.get('retry-after'));
  return ms === undefined ? undefined : Math.max(0, Math.round(ms / 1000));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * One downloadable rendition of a result.
 *
 * Videos genuinely have several — a single Pexels result routinely carries 4K,
 * 1080p, 720p and 360p renditions at mixed frame rates. Photos have the same
 * shape over `src` sizes. Modelling both as a variant list is what makes
 * {@link chooseVariant} possible, and "always take the biggest" impossible.
 */
export const StockVariantSchema = z.object({
  /** Provider-local variant id where one exists, else a derived stable key. */
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Frames per second. Absent for photos. */
  fps: z.number().positive().optional(),
  /** e.g. `'video/mp4'` | `'image/jpeg'`. */
  contentType: z.string().min(1),
  /** Extension for the on-disk filename, e.g. `'mp4'` | `'jpg'`. */
  format: z.string().min(1),
  /** https-only. Main fetches it; the renderer never sees the host. */
  url: z.string().url(),
  /** Bytes, when the provider states it. Absent means "unknown until Content-Length". */
  approxBytes: z.number().int().positive().optional(),
});
export type StockVariant = z.infer<typeof StockVariantSchema>;

export const StockItemSchema = z.object({
  remoteId: z.string().min(1),
  provider: z.enum(STOCK_PROVIDER_NAMES),
  kind: z.enum(STOCK_MEDIA_KINDS),
  /** Provider `alt` where supplied, else a derived label. Rendered as TEXT. */
  title: z.string().min(1),
  /** Native dimensions, so a grid tile can reserve the right box before load. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Videos only. A photo has no duration and must not be given a fake one. */
  durationSeconds: z.number().positive().optional(),
  /** Provider-supplied average colour, used as the tile placeholder. */
  avgColor: z.string().optional(),
  /** Small still for the grid tile. */
  thumbnailUrl: z.string().url(),
  /** Videos: a low-res rendition for hover preview and scrubbing. */
  previewUrl: z.string().url().optional(),
  variants: z.array(StockVariantSchema).min(1),

  // --- Provenance, carried verbatim into `Asset.source` (schema v20). ---
  license: z.string().min(1),
  licenseUrl: z.string().optional(),
  /**
   * FALSE for Pexels, and that is the considered value rather than the lazy one.
   *
   * The *content* licence obliges the end user to credit nobody. The *API*
   * guidelines oblige the integrating app to show a prominent Pexels link, which
   * the panel does. Setting this TRUE would tell the user their video needs a
   * credit line it does not — training them to ignore the badge, which then
   * fails them on the CC-BY music track where the obligation is real
   * (`photo-video/README.md` §D4).
   */
  attributionRequired: z.boolean(),
  /** Ready-to-paste courtesy credit, e.g. `'Photo by Jane Doe on Pexels'`. */
  attribution: z.string().optional(),
  creator: z.string().optional(),
  creatorUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
});
export type StockItem = z.infer<typeof StockItemSchema>;

/**
 * What the renderer receives: an item with **no provider URL anywhere**.
 *
 * Variants keep their dimensions and byte size — the panel must be able to show
 * "1920×1080 · 24 MB" — but lose their `url`. The renderer addresses an item by
 * `remoteId` + `variantId` and asks main to act, which is what makes the CSP
 * guarantee structural rather than a convention someone can forget.
 */
export type StockVariantWire = Omit<StockVariant, 'url'>;
export type StockItemWire = Omit<StockItem, 'thumbnailUrl' | 'previewUrl' | 'variants'> & {
  readonly variants: readonly StockVariantWire[];
  /** TRUE when a hover-scrub rendition exists, without saying where it lives. */
  readonly hasPreview: boolean;
};

/** Strip every provider URL from an item before it crosses to the renderer. */
export function toStockItemWire(item: StockItem): StockItemWire {
  const { thumbnailUrl: _thumb, previewUrl: preview, variants, ...rest } = item;
  return {
    ...rest,
    hasPreview: preview !== undefined,
    variants: variants.map(({ url: _url, ...variant }) => variant),
  };
}

export interface StockSearchQuery {
  readonly text: string;
  readonly kind: StockMediaKind;
  readonly limit: number;
  /** 1-based. "Load more" increments it; there is no infinite scroll. */
  readonly page: number;
  readonly orientation?: StockOrientation;
}

export const STOCK_ORIENTATIONS = ['landscape', 'portrait', 'square'] as const;
export type StockOrientation = (typeof STOCK_ORIENTATIONS)[number];

export function isStockOrientation(value: string): value is StockOrientation {
  return (STOCK_ORIENTATIONS as readonly string[]).includes(value);
}

export interface StockSearchPage {
  readonly items: readonly StockItem[];
  readonly page: number;
  readonly totalResults: number;
  readonly hasMore: boolean;
  /** Observed on this very response. Undefined when the provider sent no headers. */
  readonly quota?: StockQuotaObservation;
}

/** One configured provider's capability: find pictures. */
export interface StockProvider {
  readonly name: StockProviderName;
  search(query: StockSearchQuery, signal?: AbortSignal): Promise<StockSearchPage>;
}

/** The provider's own `per_page` ceiling. */
export const STOCK_SEARCH_MAX_LIMIT = 80;
/** Default page size: enough to fill a grid without over-fetching a metered API. */
export const STOCK_SEARCH_DEFAULT_LIMIT = 24;
/** A search the user is waiting on must fail fast. */
export const STOCK_SEARCH_TIMEOUT_MS = 10_000;
/** Thumbnails are user-visible waits; fail fast rather than hang a tile. */
export const STOCK_THUMBNAIL_TIMEOUT_MS = 15_000;
/** No wall-clock cap on a download — a 4K clip on a slow line is not an error — but silence is. */
export const STOCK_DOWNLOAD_STALL_MS = 30_000;
/** Refuse an implausibly large file rather than filling the user's disk. */
export const STOCK_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------

/** What the project needs a rendition to cover. */
export interface StockVariantTarget {
  /** Project height in pixels, e.g. 1080. */
  readonly height: number;
  /** Project frame rate, when known. Used only to break ties. */
  readonly fps?: number;
}

/**
 * Pick the rendition to download.
 *
 * **The smallest variant that still covers the project.** Enough resolution to
 * survive a punch-in, and no more: a 4K rendition in a 1080p project costs the
 * user a 400 MB download, minutes of their time, and a proxy transcode, in
 * exchange for pixels the export throws away.
 *
 * When nothing reaches the project height the largest available wins, and the
 * caller is expected to say so — {@link isVariantBelowTarget} answers that
 * without recomputing the choice.
 */
export function chooseVariant(
  variants: readonly StockVariant[],
  target: StockVariantTarget,
): StockVariant {
  const sorted = [...variants].sort(compareVariants(target));
  const covering = sorted.filter((variant) => variant.height >= target.height);
  // `sorted` is ascending by height, so the first covering variant is the
  // smallest one that covers, and the last overall is the largest available.
  return covering[0] ?? sorted[sorted.length - 1] ?? variants[0]!;
}

/** TRUE when the chosen rendition cannot fill the project frame. */
export function isVariantBelowTarget(variant: StockVariant, target: StockVariantTarget): boolean {
  return variant.height < target.height;
}

function compareVariants(target: StockVariantTarget) {
  return (a: StockVariant, b: StockVariant): number => {
    if (a.height !== b.height) return a.height - b.height;
    if (target.fps !== undefined && a.fps !== undefined && b.fps !== undefined) {
      // Nearest frame rate, so a 60 fps rendition does not win a 24 fps project
      // purely by declaration order.
      const delta = Math.abs(a.fps - target.fps) - Math.abs(b.fps - target.fps);
      if (delta !== 0) return delta;
    }
    return a.width - b.width;
  };
}

/**
 * Reduce a provider-supplied type to a safe file extension.
 *
 * This value becomes part of an on-disk filename, so it is derived from a
 * closed map rather than trusted: a content type is provider text, and
 * `image/jpeg; charset=utf-8` or an outright junk value must not reach the
 * filesystem.
 */
export function safeStockFormat(contentType: string, kind: StockMediaKind): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };
  return known[base] ?? (kind === 'video' ? 'mp4' : 'jpg');
}
