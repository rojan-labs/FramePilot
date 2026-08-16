/**
 * Content-Security-Policy + sandboxed media protocol for the renderer
 * (Phase 8 security audit finding 3.2 / plan "Renderer media/CSP hardening").
 *
 * WHY: the renderer had no CSP and loaded clip media via raw `file://` URLs, so a
 * stored-XSS vector combined with the (now-fixed) unsandboxed IPC would give an
 * attacker arbitrary file read. We (a) serve a strict CSP header for every
 * renderer response and (b) replace `file://` with a privileged `fp-media://`
 * scheme whose handler resolves each request through the path sandbox before
 * streaming bytes — so the renderer can only fetch media inside the projects
 * folder. The pure helpers here (CSP string, URL⇄path) are unit-tested; the
 * Electron `protocol.handle` / `onHeadersReceived` glue lives in `main.ts`.
 * See ADR 0025.
 */

/** The privileged custom scheme used for in-sandbox media in the desktop app. */
export const FP_MEDIA_SCHEME = 'fp-media';

/**
 * Build a `fp-media://` URL for an absolute on-disk media path. The path is
 * percent-encoded into the URL pathname so arbitrary characters survive.
 */
export function mediaUrlForPath(absolutePath: string): string {
  // Host segment `local` is a fixed placeholder; the path carries the payload.
  return `${FP_MEDIA_SCHEME}://local/${encodeURIComponent(absolutePath)}`;
}

/**
 * Decode the absolute media path from an `fp-media://` request URL.
 *
 * @throws {Error} if the URL is not a well-formed `fp-media://local/<path>` URL.
 */
export function pathFromMediaUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.protocol !== `${FP_MEDIA_SCHEME}:`) {
    throw new Error(`Not an ${FP_MEDIA_SCHEME} URL: ${requestUrl}`);
  }
  // pathname is `/<encoded>`; strip the leading slash before decoding.
  const encoded = url.pathname.replace(/^\//, '');
  if (encoded === '') {
    throw new Error(`Empty media path in URL: ${requestUrl}`);
  }
  return decodeURIComponent(encoded);
}

/** An inclusive byte range `[start, end]` within a resource. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single-range HTTP `Range` header against a known resource `size`,
 * returning the inclusive byte range to serve (status 206), or `null` to serve
 * the whole resource (status 200).
 *
 * WHY this matters: the renderer's `<video>`/`<audio>` elements stream and seek
 * via range requests. A handler that ignores `Range` and always returns the full
 * body (status 200) lets Chromium play only what it buffered up front, then
 * stalls — the "video freezes a couple seconds in" bug. Honouring the range with
 * a 206 + `Content-Range` is what makes local media stream and seek.
 *
 * Supports `bytes=START-END`, `bytes=START-` and the `bytes=-SUFFIX` suffix form.
 * Absent, multi-range, malformed, or unsatisfiable headers fall back to `null`
 * (serve the whole file) — media elements only ever issue the single-range form.
 *
 * @param header - The request's `Range` header value (or `null`/`undefined`).
 * @param size - Total size of the resource in bytes.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  end = Math.min(end, size - 1);
  if (start > end || start < 0 || start >= size) return null; // unsatisfiable → serve full
  return { start, end };
}

/** File extension → MIME type for the media kinds the editor imports. */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * The MIME type to serve for a media file, inferred from its extension. Falls
 * back to `application/octet-stream`. The element needs an accurate media type to
 * pick a decoder, which the previous `file://` fetch sniffed for us; serving the
 * file ourselves means we must set it.
 *
 * @param filePath - The on-disk media path (only its extension is read).
 */
export function mediaContentType(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  return MEDIA_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The renderer Content-Security-Policy. Locks scripts/styles to self (the bundled
 * app), allows media only from the `fp-media:` scheme + blob/data (preview object
 * URLs), permits connections to the local engine sidecar and (dev only) the Vite
 * server + its HMR websocket, and forbids objects/frames and remote script.
 *
 * @param engineBaseUrl - The Python sidecar origin the renderer's main process talks to.
 * @param devServerUrl - The Vite dev server origin (dev only); omit in production.
 */
export function buildCsp(engineBaseUrl: string, devServerUrl?: string): string {
  // fp-media: is included in connect-src so the renderer can fetch() audio bytes
  // for waveform extraction via Web Audio API. The path sandbox in the main process
  // handler still enforces that only project-relative paths are served, so this
  // does not expand what files are accessible — it only allows fetch() to reach
  // the same paths that <audio src="fp-media://…"> already can.
  const connect = ["'self'", `${FP_MEDIA_SCHEME}:`, engineBaseUrl];
  const script = ["'self'"];
  const style = ["'self'", "'unsafe-inline'"]; // inline styles are used by the UI tokens
  if (devServerUrl) {
    connect.push(devServerUrl);
    // Vite HMR uses a websocket on the same host.
    connect.push(devServerUrl.replace(/^http/, 'ws'));
    // Dev bundles are served (and eval'd by Vite's dev runtime) from the dev origin.
    script.push(devServerUrl, "'unsafe-inline'", "'unsafe-eval'");
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    `style-src ${style.join(' ')}`,
    `img-src 'self' ${FP_MEDIA_SCHEME}: blob: data:`,
    `media-src ${FP_MEDIA_SCHEME}: blob: data:`,
    `connect-src ${connect.join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}
