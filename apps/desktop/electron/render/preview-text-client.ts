/**
 * Desktop → sidecar text rasters for the program monitor (PX2.3).
 *
 * The export draws text with Pillow; a browser canvas cannot reproduce FreeType's hinted glyph
 * coverage. The renderer asks main for one text or caption layer, main validates the request
 * and forwards it to the sidecar's `POST /preview/text-raster`, which calls the compiler's own
 * rasteriser. No path, project or media crosses this channel: only text, style params and a
 * frame size. `fetch` is injected so this is unit-tested without a live sidecar.
 */
import {
  PREVIEW_CAPTION_MAX_FRAMES,
  type PreviewTextRasterImage,
  type PreviewTextRasterRequest,
  type PreviewTextRasterResult,
} from '../ipc/contract.js';

/** The sidecar's own limits, checked here so a bad request never reaches it. */
const MAX_FRAME_EDGE = 8192;
const MAX_TEXT_LENGTH = 2000;
/** `MAX_CUE_WORDS` in the engine's `preview_text.py`. */
const MAX_CUE_WORDS = 400;
/** A style object is a few dozen fields; anything bigger is not a caption style. */
const MAX_STYLE_JSON_LENGTH = 16_384;
/** A single layer rasterises in milliseconds; a stuck sidecar must not stall the monitor. */
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * A window of caption frames is one build plus a sample per frame (5-25 ms each at the monitor's
 * size), so it gets longer than one layer; the monitor asks well ahead of the playhead.
 */
const FRAMES_TIMEOUT_MS = 10_000;
/** The binary header of `/preview/caption-frames` is a few kilobytes of JSON. */
const MAX_FRAMES_HEADER_BYTES = 1024 * 1024;

function invalid(req: unknown): string | null {
  const r = (req ?? {}) as Partial<PreviewTextRasterRequest>;
  if (r.kind !== 'text' && r.kind !== 'caption' && r.kind !== 'shape') {
    return 'Unknown text raster kind.';
  }
  const edgeOk = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FRAME_EDGE;
  if (!edgeOk(r.frameWidth) || !edgeOk(r.frameHeight)) return 'Invalid frame size.';
  if (r.kind === 'caption') {
    if (typeof r.text !== 'string' || r.text.length > MAX_TEXT_LENGTH) return 'Invalid caption.';
    if (r.trackStyle !== undefined || r.clipStyle !== undefined) return invalidStyled(r);
  } else if (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params)) {
    return r.kind === 'shape' ? 'Invalid shape params.' : 'Invalid text params.';
  } else if (r.kind === 'shape') {
    // The engine validates the shape itself; the host only bounds what crosses the boundary.
    if (JSON.stringify(r.params).length > MAX_STYLE_JSON_LENGTH) return 'Invalid shape params.';
    if (r.rotates !== undefined && typeof r.rotates !== 'boolean') return 'Invalid shape params.';
  } else if (r.rotates !== undefined && typeof r.rotates !== 'boolean') {
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
  if (r.frameTimes !== undefined) {
    const times: unknown = r.frameTimes;
    if (
      !Array.isArray(times) ||
      times.length === 0 ||
      times.length > PREVIEW_CAPTION_MAX_FRAMES ||
      !times.every(finite)
    ) {
      return 'Invalid caption frame times.';
    }
  }
  const words = r.words ?? [];
  if (!Array.isArray(words) || words.length > MAX_CUE_WORDS) return 'Invalid caption words.';
  const wordOk = (word: unknown): boolean => {
    const w = (word ?? {}) as { word?: unknown; start?: unknown; end?: unknown };
    return typeof w.word === 'string' && finite(w.start) && finite(w.end);
  };
  return words.every(wordOk) ? null : 'Invalid caption words.';
}

/**
 * The sidecar's wire body for a validated request (snake_case, only the fields it reads).
 * Exported for the e2e hosts that stand in for main (the PX4 oracle, the fake desktop), so they
 * send exactly what the desktop sends: a copy of this body drifted once, and the oracle compared
 * a tight title raster with the export's rotation-safe one.
 */
export function previewTextWireBody(r: PreviewTextRasterRequest): Record<string, unknown> {
  const frame = { frame_width: r.frameWidth, frame_height: r.frameHeight };
  if (r.kind === 'text') {
    // EL2b.4: a turning title is drawn in the rotation-safe square the export turns it inside.
    return {
      kind: 'text',
      params: r.params,
      ...(r.rotates === true ? { rotates: true } : {}),
      ...frame,
    };
  }
  if (r.kind === 'shape') {
    return { kind: 'shape', params: r.params, rotates: r.rotates === true, ...frame };
  }
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
  if (r.frameTimes !== undefined && (r.trackStyle !== undefined || r.clipStyle !== undefined)) {
    return captionFramesViaSidecar(baseUrl, r, r.frameTimes, fetchFn);
  }
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/preview/text-raster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewTextWireBody(r)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: `Engine unavailable: ${String(error)}`, transient: true };
  }
  if (!response.ok) return refusal(response.status);
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

/**
 * A sidecar answer that is not a raster. 422 is the engine refusing this request as undrawable
 * (asking again would be refused again); anything else is a sidecar in trouble — restarting,
 * overloaded, failing — and worth asking again soon.
 */
function refusal(status: number): PreviewTextRasterResult {
  return {
    ok: false,
    error: `Engine refused the text raster (${status}).`,
    ...(status === 422 ? {} : { transient: true }),
  };
}

/** The sidecar's wire body for a window of one styled cue's frames. */
function captionFramesWireBody(
  r: PreviewTextRasterRequest,
  frameTimes: readonly number[],
): Record<string, unknown> {
  const { frame_time: _single, kind: _kind, ...styled } = previewTextWireBody(r);
  return { ...styled, words: styled.words ?? [], frame_times: [...frameTimes] };
}

interface WireRaster {
  readonly width: number;
  readonly height: number;
  readonly x: number | null;
  readonly y: number | null;
  readonly rgba: readonly [number, number];
  readonly backdrop: readonly [number, number] | null;
  readonly backdrop_sigma_px?: number;
}

/**
 * A window of a styled cue's frames through `POST /preview/caption-frames`: one build of the
 * export's caption layer, each distinct raster once, raw bytes rather than base64 JSON (a window
 * of a karaoke cue is tens of megabytes). The rasters are views into the one response buffer, so
 * the IPC clone copies it once.
 */
async function captionFramesViaSidecar(
  baseUrl: string,
  r: PreviewTextRasterRequest,
  frameTimes: readonly number[],
  fetchFn: typeof globalThis.fetch,
): Promise<PreviewTextRasterResult> {
  let response: Response;
  let body: ArrayBuffer;
  try {
    response = await fetchFn(`${baseUrl}/preview/caption-frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(captionFramesWireBody(r, frameTimes)),
      signal: AbortSignal.timeout(FRAMES_TIMEOUT_MS),
    });
    if (!response.ok) return refusal(response.status);
    body = await response.arrayBuffer();
  } catch (error) {
    return { ok: false, error: `Engine unavailable: ${String(error)}`, transient: true };
  }
  const decoded = decodeCaptionFrames(body);
  if (typeof decoded === 'string') return { ok: false, error: decoded, transient: true };
  const first = decoded.rasters[decoded.index[0]!]!;
  return {
    ok: true,
    ...first,
    animated: decoded.animated,
    sequence: { index: decoded.index, rasters: decoded.rasters },
  };
}

/**
 * Parse the binary body `encode_caption_frames` writes: a big-endian `uint32` header length, the
 * header's JSON, then the bytes its `[offset, length]` pairs point into. Every span is checked
 * against the body and every size against its raster, so a malformed answer is refused whole.
 *
 * @returns The rasters and index, or why the body was refused.
 */
export function decodeCaptionFrames(
  body: ArrayBuffer,
): { animated: boolean; index: number[]; rasters: PreviewTextRasterImage[] } | string {
  const malformed = 'Engine returned malformed caption frames.';
  if (body.byteLength < 4) return malformed;
  const headerLength = new DataView(body).getUint32(0, false);
  if (headerLength > MAX_FRAMES_HEADER_BYTES || 4 + headerLength > body.byteLength) {
    return malformed;
  }
  let header: { animated?: unknown; index?: unknown; rasters?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, headerLength))) as {
      animated?: unknown;
      index?: unknown;
      rasters?: unknown;
    };
  } catch {
    return malformed;
  }
  const payloadStart = 4 + headerLength;
  const payloadLength = body.byteLength - payloadStart;
  const view = (span: unknown, expected: number): Uint8Array | null => {
    if (!Array.isArray(span) || span.length !== 2) return null;
    const [offset, length] = span as unknown[];
    if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
    const start = offset as number;
    const size = length as number;
    if (start < 0 || size !== expected || start + size > payloadLength) return null;
    return new Uint8Array(body, payloadStart + start, size);
  };
  if (!Array.isArray(header.rasters) || header.rasters.length === 0) return malformed;
  const rasters: PreviewTextRasterImage[] = [];
  for (const entry of header.rasters as WireRaster[]) {
    const width = Number(entry?.width);
    const height = Number(entry?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return malformed;
    }
    const rgba = view(entry.rgba, width * height * 4);
    if (rgba === null) return malformed;
    const coordinate = (value: unknown): number | null =>
      typeof value === 'number' ? value : null;
    let backdrop: Uint8Array | undefined;
    if (entry.backdrop !== null && entry.backdrop !== undefined) {
      const coverage = view(entry.backdrop, width * height);
      if (coverage === null) return malformed;
      backdrop = coverage;
    }
    const sigma = Number(entry.backdrop_sigma_px);
    rasters.push({
      width,
      height,
      rgba,
      x: coordinate(entry.x),
      y: coordinate(entry.y),
      ...(backdrop === undefined
        ? {}
        : { backdrop, backdropSigmaPx: Number.isFinite(sigma) && sigma > 0 ? sigma : 0 }),
    });
  }
  const index = header.index;
  if (
    !Array.isArray(index) ||
    index.length === 0 ||
    !index.every(
      (slot) =>
        Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < rasters.length,
    )
  ) {
    return malformed;
  }
  return { animated: header.animated === true, index: index as number[], rasters };
}
