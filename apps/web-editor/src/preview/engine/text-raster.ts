/**
 * Text overlays rasterised the way the export rasterises them (PX2.3).
 *
 * The export draws a text clip with `render/text_overlay.py`: Pillow's default FreeType font
 * (Aileron Regular) at a frame-relative size, words wrapped greedily at the box width, a black
 * stroke under the fill, the lines stacked into a tight RGBA image that is then placed like any
 * other layer (centre at `xPercent`/`yPercent`, the clip's transform keyframes applied). It
 * ignores the editor's font family, weight and entrance animations. The monitor used to paint the
 * editor's styling on top of every picture instead, so text looked different and sat in front of
 * layers the export draws over it.
 *
 * This module reproduces the layout arithmetic exactly (sizes, wrap, bounding boxes, padding,
 * gaps, integer glyph pens) with the same font bytes (`public/fonts/Aileron-Regular.ttf`,
 * extracted from Pillow) and Pillow's own metrics for them.
 * Glyph anti-aliasing comes from the browser's rasteriser rather than FreeType's, so edge pixels
 * can differ by a few levels; geometry and layer order do not.
 *
 * Pillow stores a drawn RGBA pixel as the fill blended into the (transparent black) background
 * channel by channel, so an anti-aliased edge keeps colour × coverage in RGB. The canvas result is
 * converted to that representation before it is composited.
 */

/** The family name the export's text font is registered under. */
export const EXPORT_TEXT_FONT_FAMILY = 'FramePilotExportText';
const FONT_URL = '/fonts/Aileron-Regular.ttf';
/**
 * Pillow's own measurements of that font (see `PillowFontMetrics`). Generated from Pillow 12.3's
 * `ImageFont.load_default(size)` for every size in range: per character the hinted integer advance
 * and the glyph bbox, per size the ascent/descent.
 */
const METRICS_URL = '/fonts/Aileron-Regular.pillow-metrics.json';
const MIN_FONT_SIZE = 16;
const FONT_HEIGHT_FRACTION = 1 / 14;
const DEFAULT_BOX_WIDTH_PERCENT = 80;
const ALIGNMENTS = new Set(['left', 'center', 'right']);
type Rgba = readonly [number, number, number, number];
const DEFAULT_COLOR: Rgba = [255, 255, 255, 255];
const GLYPH_FIELDS = 5;
const SIZE_FIELDS = 2;

/**
 * Pillow's basic-layout text metrics for the export font.
 *
 * Pillow places glyphs at whole-pixel pens (hinted integer advances, no kerning), measures a
 * line's bbox as the union of the glyph boxes (x starting at 0 or the first glyph's overhang), and
 * anchors "la" text at the font ascent. Browser text measurement uses unhinted fractional
 * advances, which drifts glyphs by a pixel or two per line; these tables remove that drift.
 */
export interface PillowFontMetrics {
  readonly minSize: number;
  readonly maxSize: number;
  readonly chars: ReadonlyMap<string, number>;
  /** `[advance, x0, x1, y0, y1]` per size per char. */
  readonly glyphs: Int16Array;
  /** `[ascent, descent]` per size. */
  readonly sizes: Int16Array;
}

interface PillowMetricsDocument {
  readonly minSize: number;
  readonly maxSize: number;
  readonly chars: string;
  readonly glyphs: string;
  readonly metrics: string;
}

function int16FromBase64(encoded: string): Int16Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Decode the metrics JSON shipped next to the font. */
export function parsePillowMetrics(doc: PillowMetricsDocument): PillowFontMetrics {
  const chars = new Map<string, number>();
  Array.from(doc.chars).forEach((char, index) => chars.set(char, index));
  return {
    minSize: doc.minSize,
    maxSize: doc.maxSize,
    chars,
    glyphs: int16FromBase64(doc.glyphs),
    sizes: int16FromBase64(doc.metrics),
  };
}

let fontLoad: Promise<boolean> | null = null;
let loadedMetrics: PillowFontMetrics | null = null;

/** Register the export's text font once. Resolves `false` when it cannot load (text is skipped). */
export function loadExportTextFont(): Promise<boolean> {
  if (fontLoad) return fontLoad;
  fontLoad = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
    try {
      const face = new FontFace(EXPORT_TEXT_FONT_FAMILY, `url(${FONT_URL})`);
      const metrics = fetch(METRICS_URL)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null) as Promise<PillowMetricsDocument | null>;
      await face.load();
      document.fonts.add(face);
      const doc = await metrics;
      // Without the tables text still draws, measured by the browser (a pixel or two off).
      if (doc) loadedMetrics = parsePillowMetrics(doc);
      return true;
    } catch {
      return false;
    }
  })();
  return fontLoad;
}

type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
/** `[advance, x0, x1, y0, y1]`, y measured down from the ascent line. */
type GlyphBox = readonly [number, number, number, number, number];

/** Measures text the way Pillow's basic layout does, for one font size. */
export class PillowTextMeasure {
  private readonly row: number | null;
  readonly ascent: number;

  constructor(
    readonly size: number,
    private readonly metrics: PillowFontMetrics | null,
    private readonly probe: Context2D | null,
  ) {
    this.row =
      metrics && size >= metrics.minSize && size <= metrics.maxSize ? size - metrics.minSize : null;
    this.ascent =
      this.row !== null && metrics
        ? metrics.sizes[this.row * SIZE_FIELDS]!
        : Math.ceil(probe?.measureText('H').fontBoundingBoxAscent ?? size);
  }

  glyph(char: string): GlyphBox {
    const index = this.metrics?.chars.get(char);
    if (this.row !== null && this.metrics && index !== undefined) {
      const o = (this.row * this.metrics.chars.size + index) * GLYPH_FIELDS;
      const g = this.metrics.glyphs;
      return [g[o]!, g[o + 1]!, g[o + 2]!, g[o + 3]!, g[o + 4]!];
    }
    if (!this.probe) return [0, 0, 0, 0, 0];
    const m = this.probe.measureText(char);
    return [
      Math.round(m.width),
      Math.floor(-m.actualBoundingBoxLeft),
      Math.ceil(m.actualBoundingBoxRight),
      this.ascent - Math.ceil(m.actualBoundingBoxAscent),
      this.ascent + Math.ceil(m.actualBoundingBoxDescent),
    ];
  }

  /** `font.getlength(text)`. */
  length(text: string): number {
    let total = 0;
    for (const char of text) total += this.glyph(char)[0];
    return total;
  }

  /** Integer pen x of every glyph. */
  pens(text: string): number[] {
    const pens: number[] = [];
    let pen = 0;
    for (const char of text) {
      pens.push(pen);
      pen += this.glyph(char)[0];
    }
    return pens;
  }

  /** `draw.textbbox((0, 0), text, stroke_width=stroke)`. */
  bbox(text: string, stroke = 0): readonly [number, number, number, number] {
    let pen = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const char of text) {
      const [advance, gx0, gx1, gy0, gy1] = this.glyph(char);
      x0 = Math.min(x0, pen + gx0);
      x1 = Math.max(x1, pen + gx1);
      y0 = Math.min(y0, gy0);
      y1 = Math.max(y1, gy1);
      pen += advance;
    }
    if (x0 === Infinity) return [-stroke, -stroke, stroke, stroke];
    return [Math.min(0, x0) - stroke, y0 - stroke, x1 + stroke, y1 + stroke];
  }

  /** `wrap_lines(text.split(), font, max_width)`. */
  wrap(text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = `${current} ${word}`.trim();
      if (current !== '' && this.length(candidate) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== '') lines.push(current);
    return lines;
  }
}

function measureFor(size: number, probe: Context2D, metrics: PillowFontMetrics | null) {
  probe.font = `${size}px ${EXPORT_TEXT_FONT_FAMILY}`;
  // Pillow's basic layout applies no GPOS kerning; the browser's shaper would.
  probe.fontKerning = 'none';
  return new PillowTextMeasure(size, metrics, probe);
}

/** Draw `line` glyph by glyph at Pillow's integer pens, with the text origin at (x, y) "la". */
function drawLine(
  ctx: Context2D,
  measure: PillowTextMeasure,
  line: string,
  x: number,
  y: number,
  paint: 'fill' | 'stroke',
): void {
  const pens = measure.pens(line);
  let index = 0;
  for (const char of line) {
    const pen = x + pens[index++]!;
    if (paint === 'fill') ctx.fillText(char, pen, y + measure.ascent);
    else ctx.strokeText(char, pen, y + measure.ascent);
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** `_color_from_param`. */
function colorFromParam(value: unknown): Rgba {
  if (typeof value !== 'string') return DEFAULT_COLOR;
  const hex = value.replace(/^#+/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return DEFAULT_COLOR;
  const channel = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
  if (hex.length === 6) return [channel(0), channel(2), channel(4), 255];
  if (hex.length === 8) return [channel(0), channel(2), channel(4), channel(6)];
  return DEFAULT_COLOR;
}

/** `text_overlay_layout` + `text_overlay_style`. */
export interface TextOverlayLayout {
  readonly fontSize: number;
  readonly color: Rgba;
  readonly align: 'left' | 'center' | 'right';
  readonly boxWidth: number;
  readonly centreX: number;
  readonly centreY: number;
  readonly background: Rgba | null;
}

export function textOverlayLayout(
  params: Readonly<Record<string, unknown>>,
  frameWidth: number,
  frameHeight: number,
): TextOverlayLayout {
  let fontSize = Math.max(MIN_FONT_SIZE, Math.trunc(frameHeight * FONT_HEIGHT_FRACTION));
  const percent = params.fontSizePercent;
  if (isNumber(percent) && percent > 0) {
    fontSize = Math.max(MIN_FONT_SIZE, Math.trunc((frameHeight * percent) / 100));
  } else if (isNumber(params.fontSize) && params.fontSize > 0) {
    fontSize = Math.trunc(params.fontSize);
  }
  const boxPercent = isNumber(params.boxWidthPercent)
    ? params.boxWidthPercent
    : DEFAULT_BOX_WIDTH_PERCENT;
  const align =
    typeof params.align === 'string' && ALIGNMENTS.has(params.align)
      ? (params.align as TextOverlayLayout['align'])
      : 'center';
  return {
    fontSize,
    color: colorFromParam(params.color),
    align,
    boxWidth: Math.max(1, Math.trunc((frameWidth * Math.min(Math.max(boxPercent, 1), 100)) / 100)),
    centreX: (frameWidth * (isNumber(params.xPercent) ? params.xPercent : 50)) / 100,
    centreY: (frameHeight * (isNumber(params.yPercent) ? params.yPercent : 50)) / 100,
    background: typeof params.background === 'string' ? colorFromParam(params.background) : null,
  };
}

/** The export's text for a `text` effect, or `null` when it draws nothing. */
export function exportText(params: Readonly<Record<string, unknown>>): string | null {
  const raw = params.text;
  const text = raw === undefined || raw === null ? '' : String(raw);
  return text.trim() === '' ? null : text;
}

export interface TextRaster {
  readonly image: ImageData;
  readonly width: number;
  readonly height: number;
  readonly layout: TextOverlayLayout;
}

const css = ([r, g, b, a]: Rgba): string => `rgba(${r}, ${g}, ${b}, ${a / 255})`;

/**
 * `render_text_overlay_image`, on a 2D canvas.
 *
 * @returns The RGBA raster (Pillow's stored representation) and its layout, or `null` when the
 *   text is empty or no 2D context is available.
 */
export function rasterizeTextOverlay(
  params: Readonly<Record<string, unknown>>,
  frameWidth: number,
  frameHeight: number,
  createCanvas: (width: number, height: number) => OffscreenCanvas | HTMLCanvasElement = (w, h) =>
    new OffscreenCanvas(w, h),
  metrics: PillowFontMetrics | null = loadedMetrics,
): TextRaster | null {
  const text = exportText(params);
  if (text === null) return null;
  const layout = textOverlayLayout(params, frameWidth, frameHeight);
  const size = layout.fontSize;
  const probe = createCanvas(1, 1).getContext('2d') as Context2D | null;
  if (!probe) return null;
  const measure = measureFor(size, probe, metrics);
  const lines = measure.wrap(text, layout.boxWidth);
  if (lines.length === 0) return null;

  const stroke = Math.max(1, Math.trunc(size / 12));
  const boxes = lines.map((line) => measure.bbox(line, stroke));
  const lineWidths = boxes.map((b) => Math.trunc(b[2] - b[0]));
  const lineHeight = Math.trunc(Math.max(...boxes.map((b) => b[3] - b[1])));
  const lineGap = Math.max(1, Math.trunc(size / 6));
  const textWidth = Math.max(...lineWidths);
  const textHeight = lineHeight * lines.length + lineGap * (lines.length - 1);
  const pad = stroke * 2;
  const width = textWidth + 2 * pad;
  const height = textHeight + 2 * pad;
  if (width <= 0 || height <= 0) return null;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Context2D | null;
  if (!ctx) return null;
  if (layout.background) {
    ctx.fillStyle = css(layout.background);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.font = `${size}px ${EXPORT_TEXT_FONT_FAMILY}`;
  ctx.fontKerning = 'none';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke * 2;
  ctx.strokeStyle = 'rgb(0, 0, 0)';
  ctx.fillStyle = css(layout.color);
  // `canvas.text((x - bbox[0], y - bbox[1]), …)`: Pillow strokes the whole line, then fills it.
  const origins = lines.map((_, index) => {
    const lineWidth = lineWidths[index]!;
    const x =
      layout.align === 'left'
        ? pad
        : layout.align === 'right'
          ? pad + (textWidth - lineWidth)
          : pad + Math.floor((textWidth - lineWidth) / 2);
    const y = pad + index * (lineHeight + lineGap);
    return [x - boxes[index]![0], y - boxes[index]![1]] as const;
  });
  lines.forEach((line, i) =>
    drawLine(ctx, measure, line, origins[i]![0], origins[i]![1], 'stroke'),
  );
  lines.forEach((line, i) => drawLine(ctx, measure, line, origins[i]![0], origins[i]![1], 'fill'));

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  if (!layout.background || layout.background[3] < 255) {
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]!;
      if (alpha === 255) continue;
      data[i] = Math.round((data[i]! * alpha) / 255);
      data[i + 1] = Math.round((data[i + 1]! * alpha) / 255);
      data[i + 2] = Math.round((data[i + 2]! * alpha) / 255);
    }
  }
  return { image, width, height, layout };
}

// --- burned captions, baseline style (render/captions.py `_render_baseline_caption_image`) ---

const CAPTION_MAX_WIDTH_FRACTION = 0.9;
const CAPTION_FONT_HEIGHT_FRACTION = 1 / 22;
const CAPTION_MIN_FONT_SIZE = 14;
const CAPTION_BOX_PAD_FRACTION = 0.35;
const CAPTION_BOX_FILL: Rgba = [0, 0, 0, 160];
const CAPTION_TEXT_FILL: Rgba = [255, 255, 255, 255];
/** `_CAPTION_BOTTOM_MARGIN_FRACTION` of the compiler. */
const CAPTION_BOTTOM_MARGIN_FRACTION = 0.08;

export interface CaptionRaster {
  readonly image: ImageData;
  readonly width: number;
  readonly height: number;
  /** Paste position (`_caption_position` for the default bottom placement). */
  readonly x: number;
  readonly y: number;
}

/**
 * A caption with no style, as the export burns it: a translucent rounded box (Pillow's shapes are
 * not anti-aliased, so the box edge is a hard pixel test here too) with centred white text, in
 * the lower safe area.
 */
export function rasterizeBaselineCaption(
  text: string,
  frameWidth: number,
  frameHeight: number,
  createCanvas: (width: number, height: number) => OffscreenCanvas | HTMLCanvasElement = (w, h) =>
    new OffscreenCanvas(w, h),
  metrics: PillowFontMetrics | null = loadedMetrics,
): CaptionRaster | null {
  if (text.trim() === '') return null;
  const size = Math.max(
    CAPTION_MIN_FONT_SIZE,
    Math.trunc(frameHeight * CAPTION_FONT_HEIGHT_FRACTION),
  );
  const pad = Math.trunc(size * CAPTION_BOX_PAD_FRACTION);
  const maxTextWidth = Math.trunc(frameWidth * CAPTION_MAX_WIDTH_FRACTION) - 2 * pad;
  const probe = createCanvas(1, 1).getContext('2d') as Context2D | null;
  if (!probe) return null;
  const measure = measureFor(size, probe, metrics);
  const lines = measure.wrap(text, maxTextWidth);
  if (lines.length === 0) return null;
  const boxes = lines.map((line) => measure.bbox(line));
  const lineWidths = boxes.map((b) => Math.trunc(b[2] - b[0]));
  const lineHeight = Math.trunc(Math.max(...boxes.map((b) => b[3] - b[1])));
  const lineGap = Math.max(1, Math.trunc(size / 6));
  const textWidth = Math.max(...lineWidths);
  const textHeight = lineHeight * lines.length + lineGap * (lines.length - 1);
  const width = textWidth + 2 * pad;
  const height = textHeight + 2 * pad;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;

  // `rounded_rectangle((0, 0, w - 1, h - 1), radius=pad)`, drawn without anti-aliasing.
  const box = ctx.createImageData(width, height);
  const radius = pad;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = x < radius ? radius : x > width - 1 - radius ? width - 1 - radius : x;
      const cy = y < radius ? radius : y > height - 1 - radius ? height - 1 - radius : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      const o = (y * width + x) * 4;
      box.data[o] = CAPTION_BOX_FILL[0];
      box.data[o + 1] = CAPTION_BOX_FILL[1];
      box.data[o + 2] = CAPTION_BOX_FILL[2];
      box.data[o + 3] = CAPTION_BOX_FILL[3];
    }
  }
  ctx.putImageData(box, 0, 0);
  ctx.font = `${size}px ${EXPORT_TEXT_FONT_FAMILY}`;
  ctx.fontKerning = 'none';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = css(CAPTION_TEXT_FILL);
  lines.forEach((line, index) => {
    const b = boxes[index]!;
    const x = Math.floor((width - lineWidths[index]!) / 2);
    const y = pad + index * (lineHeight + lineGap);
    drawLine(ctx, measure, line, x - b[0], y - b[1], 'fill');
  });
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha === 255 || alpha === 0) continue;
    // Pillow blends the text into the box channel by channel (see the module note).
    data[i] = Math.round((data[i]! * alpha) / 255);
    data[i + 1] = Math.round((data[i + 1]! * alpha) / 255);
    data[i + 2] = Math.round((data[i + 2]! * alpha) / 255);
  }
  const margin = Math.trunc(frameHeight * CAPTION_BOTTOM_MARGIN_FRACTION);
  const x = Math.floor((frameWidth - width) / 2);
  const top = Math.max(
    0,
    Math.min(frameHeight - height - margin, Math.max(0, frameHeight - height)),
  );
  return { image, width, height, x, y: top };
}
