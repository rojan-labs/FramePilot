/**
 * @framepilot/ai-sdk/providers/music-types — third-party music search contracts.
 *
 * One provider, one adapter, a named union. Not a registry, not a plugin layer:
 * the second provider generalizes this when it actually lands, not in
 * anticipation of it (`plan/3rd-party-sourcing/README.md` §D4,
 * `.agents/rules/product-discipline.mdc` §5). Modelled on `asr-types.ts`.
 *
 * ## Normalization is the adapter's whole job
 *
 * Providers disagree about duration units, licence vocabulary, and whether a
 * preview exists. Every field below is normalized at the adapter boundary so
 * nothing downstream ever branches on which provider a track came from.
 *
 * ## All provider input is untrusted
 *
 * Responses are Zod-parsed at the boundary, exactly as tool inputs are. A title
 * is rendered as text and never as markup; a URL is scheme-checked before the
 * main process fetches it; a duration is range-checked before it can reach the
 * timeline.
 */
import { z } from 'zod';

/** User-facing provider roster. Settings and new requests derive from this tuple. */
export const MUSIC_PROVIDER_NAMES = ['openverse'] as const;
export type MusicProviderName = (typeof MUSIC_PROVIDER_NAMES)[number];

/** Narrow an untrusted string to a known provider. */
export function isMusicProviderName(value: string): value is MusicProviderName {
  return (MUSIC_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Every failure the music surface can produce, as one closed union.
 *
 * Each arm maps to a specific user-facing sentence (see {@link musicErrorMessage}).
 * There is no generic "something went wrong" arm, because a user who is told only
 * that cannot tell a typo from an outage from an empty catalogue.
 */
export const MUSIC_ERROR_CODES = [
  'unauthorized',
  'rate_limited',
  'provider_unavailable',
  'unknown_track',
  'offline',
  'timeout',
  'cancelled',
  'non_commercial_only',
  'disk_full',
  'download_failed',
  'derive_failed',
] as const;
export type MusicErrorCode = (typeof MUSIC_ERROR_CODES)[number];

/**
 * The sentence the user sees for each failure.
 *
 * `cancelled` is deliberately empty: the user did it on purpose, and telling them
 * so is noise. Callers must treat an empty string as "return to idle silently".
 */
export function musicErrorMessage(code: MusicErrorCode, detail?: string): string {
  const sentence = musicErrorSentence(code);
  // The detail is a real fact the sentence cannot carry — a retry-after, an HTTP
  // status — so it is appended rather than dropped. `cancelled` stays empty:
  // decorating silence would defeat the point of it.
  return sentence === '' || detail === undefined ? sentence : `${sentence} (${detail})`;
}

function musicErrorSentence(code: MusicErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'The music provider rejected this request.';
    case 'rate_limited':
      return 'Too many searches in a row. Try again in a moment.';
    case 'provider_unavailable':
      return 'The music provider is not responding. Try again shortly.';
    case 'unknown_track':
      // Deliberately NOT "try again": retrying is the one thing that cannot work, and
      // this sentence is read by an agent as an instruction.
      return 'That track id is no longer valid. Search again and use an id from the new results.';
    case 'offline':
      return 'No network connection.';
    case 'timeout':
      return 'The music provider took too long to answer.';
    case 'cancelled':
      return '';
    case 'non_commercial_only':
      return "This track can't be used in monetized videos.";
    case 'disk_full':
      return 'Not enough disk space to save this track.';
    case 'download_failed':
      return "The download didn't finish. Nothing was added.";
    case 'derive_failed':
      return "Saved the file, but couldn't read its waveform.";
  }
}

/**
 * A failure with a code and, where it helps, the specific detail behind it.
 *
 * Thrown by adapters rather than returned, so a caller cannot forget to check —
 * the search handler converts it to a wire result at exactly one place.
 */
export class MusicProviderError extends Error {
  public constructor(
    public readonly code: MusicErrorCode,
    public readonly detail?: string,
  ) {
    super(detail ? `${musicErrorMessage(code)} (${detail})` : musicErrorMessage(code));
    this.name = 'MusicProviderError';
  }
}

/**
 * One search result, normalized across providers.
 *
 * `previewUrl` and `downloadUrl` are present here because the **main process**
 * acts on them. They are stripped before anything crosses to the renderer — see
 * {@link ProviderTrackWire}.
 */
export const ProviderTrackSchema = z.object({
  /** Provider-local id. Stable — download dedupe and `sources.json` key on it. */
  remoteId: z.string().min(1),
  provider: z.enum(MUSIC_PROVIDER_NAMES),
  title: z.string().min(1),
  durationSeconds: z.number().positive(),
  /** Streamable audition URL. Main fetches it; the renderer never sees the host. */
  previewUrl: z.string().url(),
  /** Full-quality download URL. */
  downloadUrl: z.string().url(),
  /** Container hint for the on-disk filename, e.g. 'mp3' | 'wav' | 'ogg'. */
  format: z.string().min(1),
  /** Licence identifier verbatim from the provider, e.g. 'cc0' | 'by'. */
  license: z.string().min(1),
  /** Canonical licence text URL, so the user can read the actual terms. */
  licenseUrl: z.string().optional(),
  /**
   * TRUE when the licence obliges the end user to credit someone. These ARE
   * usable — the UI badges them and the project persists the credit
   * (`Asset.source`, schema v20). What is refused is non-commercial-only content.
   */
  attributionRequired: z.boolean(),
  /**
   * TRUE when the licence permits commercial/monetized use. FALSE results are
   * REFUSED, not badged: FramePilot users monetize, and no badge makes an NC
   * track safe in a sponsored video.
   */
  commercialUse: z.boolean(),
  /** Ready-to-paste credit line, persisted verbatim into `Asset.source.attribution`. */
  attribution: z.string().optional(),
  creator: z.string().optional(),
  creatorUrl: z.string().optional(),
  /** Landing page for the item on the provider. */
  sourceUrl: z.string().optional(),
});
export type ProviderTrack = z.infer<typeof ProviderTrackSchema>;

/**
 * What the renderer receives: a track **minus every provider URL**.
 *
 * The renderer addresses tracks by `remoteId` and asks main to act on them. That
 * is what makes the CSP guarantee structural rather than a convention — there is
 * no provider host in the renderer to put in `connect-src`, because the renderer
 * was never handed one.
 */
export type ProviderTrackWire = Omit<ProviderTrack, 'previewUrl' | 'downloadUrl'>;

/** Strip the provider URLs from a track before it crosses to the renderer. */
export function toTrackWire(track: ProviderTrack): ProviderTrackWire {
  const { previewUrl: _preview, downloadUrl: _download, ...wire } = track;
  return wire;
}

export interface MusicSearchQuery {
  readonly text: string;
  /** One page only. Pagination is deferred (`README.md` §2). */
  readonly limit: number;
}

/** One configured provider's capability: find music. */
export interface MusicProvider {
  readonly name: MusicProviderName;
  search(query: MusicSearchQuery, signal?: AbortSignal): Promise<readonly ProviderTrack[]>;
}

/** Hard cap on results per search, so a provider cannot flood the panel. */
export const MUSIC_SEARCH_MAX_LIMIT = 40;
/** Search request timeout. A search the user is waiting on must fail fast. */
export const MUSIC_SEARCH_TIMEOUT_MS = 10_000;

/**
 * Reject any URL that is not `https:`.
 *
 * The main process fetches these, so a `file:` or `http:` URL from a compromised
 * or merely sloppy provider response would be a real read primitive, not a
 * cosmetic problem.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
