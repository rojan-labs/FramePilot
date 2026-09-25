/**
 * Desktop → sidecar text rasters for the program monitor (PX2.3).
 *
 * The export draws text with Pillow; a browser canvas cannot reproduce FreeType's hinted glyph
 * coverage. The renderer asks main for one text or caption layer, main validates the request
 * and forwards it to the sidecar's `POST /preview/text-raster`, which calls the compiler's own
 * rasteriser. No path, project or media crosses this channel: only text, style params and a
 * frame size. `fetch` is injected so this is unit-tested without a live sidecar.
 */
import type { PreviewTextRasterRequest, PreviewTextRasterResult } from '../ipc/contract.js';

/** The sidecar's own limits, checked here so a bad request never reaches it. */
const MAX_FRAME_EDGE = 8192;
const MAX_TEXT_LENGTH = 2000;
/** `MAX_CUE_WORDS` in the engine's `preview_text.py`. */
const MAX_CUE_WORDS = 400;
/** A style object is a few dozen fields; anything bigger is not a caption style. */
const MAX_STYLE_JSON_LENGTH = 16_384;
/** A single layer rasterises in milliseconds; a stuck sidecar must not stall the monitor. */
const REQUEST_TIMEOUT_MS = 5_000;

function invalid(req: unknown): string | null {
  const r = (req ?? {}) as Partial<PreviewTextRasterRequest>;
  if (r.kind !== 'text' && r.kind !== 'caption') return 'Unknown text raster kind.';
  const edgeOk = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FRAME_EDGE;
  if (!edgeOk(r.frameWidth) || !edgeOk(r.frameHeight)) return 'Invalid frame size.';
  if (r.kind === 'caption') {
    if (typeof r.text !== 'string' || r.text.length > MAX_TEXT_LENGTH) return 'Invalid caption.';
    if (r.trackStyle !== undefined || r.clipStyle !== undefined) return invalidStyled(r);
  } else if (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params)) {
    return 'Invalid text params.';
  }
  return null;
}

/** The styled-caption half of the request: styles, words and the times they are drawn at. */
function invalidStyled(r: Partial<PreviewTextRasterRequest>): string | null {
  const styleOk = (value: unknown): boolean =>
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      JSON.stringify(value).length <= MAX_STYLE_JSON_LENGTH);
  if (!styleOk(r.trackStyle) || !styleOk(r.clipStyle)) return 'Invalid caption style.';
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(r.clipStart) || !finite(r.clipEnd) || !(r.clipEnd > r.clipStart)) {
    return 'Invalid caption span.';
  }
  if (r.frameTime !== undefined && !finite(r.frameTime)) return 'Invalid caption frame time.';
  const words = r.words ?? [];
  if (!Array.isArray(words) || words.length > MAX_CUE_WORDS) return 'Invalid caption words.';
  const wordOk = (word: unknown): boolean => {
    const w = (word ?? {}) as { word?: unknown; start?: unknown; end?: unknown };
    return typeof w.word === 'string' && finite(w.start) && finite(w.end);
  };
  return words.every(wordOk) ? null : 'Invalid caption words.';
}

/** The sidecar's wire body for a validated request (snake_case, only the fields it reads). */
function wireBody(r: PreviewTextRasterRequest): Record<string, unknown> {
  const frame = { frame_width: r.frameWidth, frame_height: r.frameHeight };
  if (r.kind === 'text') return { kind: 'text', params: r.params, ...frame };
  if (r.trackStyle === undefined && r.clipStyle === undefined) {
    return { kind: 'caption', text: r.text, ...frame };
  }
  return {
    kind: 'caption',
    text: r.text,
    ...frame,
    ...(r.trackStyle === undefined ? {} : { track_style: r.trackStyle }),
    ...(r.clipStyle === undefined ? {} : { clip_style: r.clipStyle }),
    words: (r.words ?? []).map(({ word, start, end }) => ({ word, start, end })),
    clip_start: r.clipStart,
    clip_end: r.clipEnd,
    ...(r.frameTime === undefined ? {} : { frame_time: r.frameTime }),
  };
}

/**
 * Rasterise one layer through the sidecar.
 *
 * @param baseUrl - The sidecar origin, e.g. `http://127.0.0.1:8799`.
 * @param req - Untrusted renderer input; validated here.
 * @param fetchFn - Injected fetch.
 * @returns The raster bytes, or `{ ok: false }` with a reason (the monitor then falls back and
 *   says "Preview text approximate").
 */
export async function previewTextRasterViaSidecar(
  baseUrl: string,
  req: unknown,
  fetchFn: typeof globalThis.fetch,
): Promise<PreviewTextRasterResult> {
  const reason = invalid(req);
  if (reason !== null) return { ok: false, error: reason };
  const r = req as PreviewTextRasterRequest;
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/preview/text-raster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wireBody(r)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: `Engine unavailable: ${String(error)}` };
  }
  if (!response.ok)
    return { ok: false, error: `Engine refused the text raster (${response.status}).` };
  const body = (await response.json()) as {
    width?: unknown;
    height?: unknown;
    rgba_base64?: unknown;
    x?: unknown;
    y?: unknown;
    animated?: unknown;
    backdrop_base64?: unknown;
    backdrop_sigma_px?: unknown;
  };
  const width = Number(body.width);
  const height = Number(body.height);
  if (typeof body.rgba_base64 !== 'string' || !(width > 0) || !(height > 0)) {
    return { ok: false, error: 'Engine returned a malformed text raster.' };
  }
  const rgba = new Uint8Array(Buffer.from(body.rgba_base64, 'base64'));
  if (rgba.length !== width * height * 4) {
    return { ok: false, error: 'Engine returned a text raster of the wrong size.' };
  }
  const coordinate = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  let backdrop: Uint8Array | undefined;
  if (typeof body.backdrop_base64 === 'string') {
    backdrop = new Uint8Array(Buffer.from(body.backdrop_base64, 'base64'));
    if (backdrop.length !== width * height) {
      return { ok: false, error: 'Engine returned a caption backdrop of the wrong size.' };
    }
  }
  const sigma = Number(body.backdrop_sigma_px);
  return {
    ok: true,
    width,
    height,
    rgba,
    x: coordinate(body.x),
    y: coordinate(body.y),
    animated: body.animated === true,
    ...(backdrop === undefined
      ? {}
      : { backdrop, backdropSigmaPx: Number.isFinite(sigma) && sigma > 0 ? sigma : 0 }),
  };
}
