/**
 * The two real photographs every effect and transition tile previews on,
 * replacing the earlier synthetic canvas-drawn frames.
 *
 * `a` stands in as "the footage" for a single-frame preview (effects); `a`→`b`
 * stands in as the outgoing/incoming shot for a two-frame preview (transitions),
 * so a wipe, a dissolve or a displacement all have an actual photographic edge
 * and texture to act on rather than a flat gradient.
 *
 * One `<img>` element per id, created on first use and shared by every tile —
 * the browser fetches each URL once regardless of how many tiles reference it.
 * The GL passes accept an `HTMLImageElement` directly as a texture source, so
 * there is no need to rasterise these into a canvas first.
 */

const FRAME_URLS = {
  a: '/preview-media/preview-frame-a.jpg',
  b: '/preview-media/preview-frame-b.jpg',
} as const;

export type PhotoFrameId = keyof typeof FRAME_URLS;

const images = new Map<PhotoFrameId, HTMLImageElement>();

function ensureImage(id: PhotoFrameId): HTMLImageElement {
  const existing = images.get(id);
  if (existing !== undefined) return existing;
  const img = new Image();
  img.src = FRAME_URLS[id];
  images.set(id, img);
  return img;
}

/**
 * Resolves once the frame has decoded and has real pixel dimensions — safe to
 * hand to `texImage2D`. Resolves `null` off the DOM (SSR/test) or on a decode
 * failure, so an animation loop can fall back to its static still.
 */
export function photoFrameReady(id: PhotoFrameId): Promise<HTMLImageElement | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  const img = ensureImage(id);
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
  return img.decode().then(
    () => img,
    () => null,
  );
}

/** The raw asset URL — for CSS `background-image` use on the static still. */
export function photoFrameUrl(id: PhotoFrameId): string {
  return FRAME_URLS[id];
}
