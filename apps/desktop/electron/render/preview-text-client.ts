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
  } else if (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params)) {
    return 'Invalid text params.';
  }
  return null;
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
      body: JSON.stringify({
        kind: r.kind,
        ...(r.kind === 'text' ? { params: r.params } : { text: r.text }),
        frame_width: r.frameWidth,
        frame_height: r.frameHeight,
      }),
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
  return { ok: true, width, height, rgba, x: coordinate(body.x), y: coordinate(body.y) };
}
