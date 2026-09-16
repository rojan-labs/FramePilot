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
 * gaps) with the same font bytes (`public/fonts/Aileron-Regular.ttf`, extracted from Pillow).
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
const MIN_FONT_SIZE = 16;
const FONT_HEIGHT_FRACTION = 1 / 14;
const DEFAULT_BOX_WIDTH_PERCENT = 80;
const ALIGNMENTS = new Set(['left', 'center', 'right']);
type Rgba = readonly [number, number, number, number];
const DEFAULT_COLOR: Rgba = [255, 255, 255, 255];

let fontLoad: Promise<boolean> | null = null;

/** Register the export's text font once. Resolves `false` when it cannot load (text is skipped). */
export function loadExportTextFont(): Promise<boolean> {
  if (fontLoad) return fontLoad;
  fontLoad = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
    try {
      const face = new FontFace(EXPORT_TEXT_FONT_FAMILY, `url(${FONT_URL})`);
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      return false;
    }
  })();
  return fontLoad;
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
): TextRaster | null {
  const text = exportText(params);
  if (text === null) return null;
  const layout = textOverlayLayout(params, frameWidth, frameHeight);
  const size = layout.fontSize;
  const probe = createCanvas(1, 1).getContext('2d') as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!probe) return null;
  const font = `${size}px ${EXPORT_TEXT_FONT_FAMILY}`;
  probe.font = font;

  // `wrap_lines(text.split(), font, max_width)`.
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = `${current} ${word}`.trim();
    if (current !== '' && probe.measureText(candidate).width > layout.boxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);

  const stroke = Math.max(1, Math.trunc(size / 12));
  // `textbbox((0, 0), line, stroke_width=…)` with Pillow's default "la" anchor: y is measured
  // from the ascender line.
  const ascender = Math.ceil(probe.measureText('H').fontBoundingBoxAscent);
  const boxes = lines.map((line) => {
    const m = probe.measureText(line);
    return [
      Math.floor(-m.actualBoundingBoxLeft) - stroke,
      ascender - Math.ceil(m.actualBoundingBoxAscent) - stroke,
      Math.ceil(m.actualBoundingBoxRight) + stroke,
      ascender + Math.ceil(m.actualBoundingBoxDescent) + stroke,
    ] as const;
  });
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
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (layout.background) {
    ctx.fillStyle = css(layout.background);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke * 2;
  ctx.strokeStyle = 'rgb(0, 0, 0)';
  ctx.fillStyle = css(layout.color);
  let y = pad;
  lines.forEach((line, index) => {
    const box = boxes[index]!;
    const lineWidth = lineWidths[index]!;
    const x =
      layout.align === 'left'
        ? pad
        : layout.align === 'right'
          ? pad + (textWidth - lineWidth)
          : pad + Math.floor((textWidth - lineWidth) / 2);
    const originX = x - box[0];
    const baseline = y - box[1] + ascender;
    ctx.strokeText(line, originX, baseline);
    ctx.fillText(line, originX, baseline);
    y += lineHeight + lineGap;
  });

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
