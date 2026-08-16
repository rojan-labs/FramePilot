/**
 * Media source resolution shared by every renderer surface that points an
 * `<video>`/`<img>` at a clip or asset (the preview monitor and the bin
 * thumbnails).
 *
 * On-disk paths are stored **relative** to the project file (`media/<...>`) or,
 * for the demo, as a leading-slash absolute path (`/media/intro.mp4`). Either
 * way they are NOT web URLs: assigning one to an element `src` makes the browser
 * resolve it against the page origin, producing `http://localhost:5173/media/…`
 * in the desktop dev shell — which the renderer CSP (`media-src`/`img-src` =
 * `fp-media: blob: data:`) forbids, so the element fails to load.
 *
 * So an on-disk path is served through the sandboxed `fp-media://` scheme
 * registered by the desktop main process (never raw `file://`, also blocked by
 * the CSP — Phase 8 audit 3.2). Session URLs (object/remote/data) already point
 * at real bytes and pass through unchanged.
 */

/** A source that is already a usable URL and must not be `fp-media://`-wrapped. */
const PASSTHROUGH_SCHEME = /^(blob:|https?:|fp-media:|data:)/;

/**
 * Resolve a clip/asset media path into a source usable by a renderer element.
 * Object/remote/data URLs pass through; an on-disk path is served via the
 * sandboxed `fp-media://` scheme.
 *
 * @param path - The asset's stored path (object URL or on-disk relative/absolute path).
 * @returns A URL safe to assign to an `<video>`/`<img>` `src` under the renderer CSP.
 */
export function mediaSrc(path: string): string {
  if (PASSTHROUGH_SCHEME.test(path)) return path;
  return `fp-media://local/${encodeURIComponent(path)}`;
}

/** The minimal asset shape {@link previewMediaSrc} reads (kind + path + optional proxy). */
export interface PreviewSource {
  readonly path: string;
  /** Asset kind; only `'video'` has a meaningful preview proxy. */
  readonly kind?: string | undefined;
  readonly media?: { readonly proxyPath?: string | null | undefined } | null | undefined;
}

/**
 * Resolve the source the PREVIEW should play for an asset: the engine-generated
 * low-res proxy when one exists, else the original. Proxies decode and seek far
 * cheaper than camera originals — the difference between smooth and stuttering
 * scrubbing on long/heavy footage (H3). The export/render path never reads this;
 * the engine always renders from the original media.
 *
 * A proxy is only meaningful for VIDEO. An image must always preview from its
 * own source: a proxy is an `.mp4`, which cannot render in an `<img>`, and an
 * older import that mislabelled a photo as video may have left a (now-stale)
 * proxy path on an image asset — using it would break the preview.
 *
 * @param asset - The asset (or any object carrying `kind` + `path` + `media.proxyPath`).
 * @returns A CSP-safe URL for `<video>`/`<img>` `src`.
 */
export function previewMediaSrc(asset: PreviewSource): string {
  const proxy = asset.kind === 'image' ? undefined : asset.media?.proxyPath;
  return mediaSrc(proxy && proxy.length > 0 ? proxy : asset.path);
}
