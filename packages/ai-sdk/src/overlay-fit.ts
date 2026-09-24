/**
 * @framepilot/ai-sdk/overlay-fit — will this word fit the box it was given?
 *
 * Both engines wrap text the same way and neither breaks a word: `wrap_lines`
 * (`engine/python/framepilot_engine/render/captions.py`) and `wrapLines`
 * (`apps/web-editor/src/preview/engine/overlay-painter.ts`) put a word that is wider than
 * the box on a line of its own and let it run out the sides. They AGREE, so the export
 * looks like the preview and the output is consistently wrong rather than divergently
 * wrong — which is why nothing in the product has ever said so, and why the two obvious
 * repairs were both rejected: breaking mid-word or auto-shrinking would have to produce
 * the same pixels in PIL and in canvas, and a wrap bug traded for a preview/export parity
 * bug is a worse bug.
 *
 * So this does not change what is drawn. It says, before the render, that a word cannot
 * fit — leaving the fix (a wider box, a smaller size, different words) to the editor or
 * the agent, which is the decision neither renderer is in a position to make.
 *
 * ## Why a percentage comparison is exact
 *
 * Both renderers resolve the same two params the same way:
 *
 *     font px = fontSizePercent/100 × FRAME HEIGHT     (`text_overlay_style`, `paintTextOverlay`)
 *     box  px = boxWidthPercent/100 × FRAME WIDTH      (`text_overlay_layout`, `paintTextOverlay`)
 *
 * so a word of `w` em overflows exactly when
 *
 *     w × fontSizePercent × height > boxWidthPercent × width
 *
 * and the frame's pixel dimensions cancel down to its aspect ratio. No pixel measurement
 * is needed at this boundary; only the width of the word in em.
 */

import {
  TITLE_FACES,
  TITLE_GLYPHS,
  TITLE_GLYPH_TABLES,
  TITLE_WEIGHT_BUCKETS,
} from './title-metrics.generated.js';

/**
 * What an unknown character is worth when judging WRAP overflow. Every script the metrics do
 * not cover is WIDER than this — CJK is a full em, and Latin-1 accented forms match their base
 * letters — so an unknown character can only make this estimate too small, which is the safe
 * direction for a check that reports (it may stay quiet; it must not cry wolf).
 */
const UNKNOWN_ADVANCE_EM = 0.5;

/**
 * What an unknown character is worth when FITTING a title to the frame: a full em. There the
 * safe direction is the opposite one — an under-read puts the title off the frame.
 */
const UNKNOWN_FIT_EM = 1;

/**
 * How much narrower than the bundled font a custom family is assumed able to be.
 *
 * `fontFamily` is authored, and the preview honours it (`ctx.font`) while the export falls
 * back to the default face when it cannot resolve one. A report is only worth making when
 * it holds for the narrower of the two, so the measured width is discounted before it is
 * compared. 10% is roughly the gap between a normal sans and a condensed one; past that a
 * word simply is not reported, and under-reporting is the failure this check can afford.
 */
const NARROW_FONT_ALLOWANCE = 0.9;

/**
 * The widest a title's box may be, as a percent of the frame width: a 4 % margin each side.
 * Shared by every title tool so a fitted title sits inside the same safe width, and the same
 * fraction the engine fits against (`service.TITLE_SAFE_WIDTH_FRACTION`).
 */
export const MAX_TITLE_BOX_WIDTH_PERCENT = 92;

/** The font a title is drawn in, when its style names one. */
export interface TitleFont {
  readonly fontFamily?: string;
  readonly fontWeight?: number;
}

/** The weight the export draws a title at when its style names none (`text_overlay.py`). */
const DEFAULT_TITLE_WEIGHT = 700;

const GLYPH_INDEX: ReadonlyMap<string, number> = new Map(
  [...TITLE_GLYPHS].map((glyph, index) => [glyph, index]),
);

type GlyphRow = readonly (readonly [number, number, number])[];

/**
 * The measured glyph row the export draws `font` with, or `undefined` for a family this build
 * does not bundle. No family is the default face (`""`), which is what the export draws then.
 *
 * A weight is bucketed UP (`TITLE_WEIGHT_BUCKETS`): a heavier cut is never narrower, so a
 * weight between two measured ones reads a little wide — the direction a fit can afford.
 */
function glyphRow(font: TitleFont | undefined): GlyphRow | undefined {
  const rows = TITLE_FACES[font?.fontFamily ?? ''];
  if (rows === undefined) return undefined;
  const weight = font?.fontWeight ?? DEFAULT_TITLE_WEIGHT;
  const bucket = TITLE_WEIGHT_BUCKETS.findIndex((top) => weight <= top);
  const index = rows[bucket === -1 ? rows.length - 1 : bucket];
  return index === undefined ? undefined : TITLE_GLYPH_TABLES[index];
}

/** The measured row for `font`, falling back to the default face the export would draw. */
function rowOrDefault(font: TitleFont | undefined): GlyphRow {
  return glyphRow(font) ?? glyphRow(undefined)!;
}

/**
 * Whether the export draws `font` from a bundled file this module has measured. A family it
 * cannot resolve falls back in the export, and only the allowance below speaks for it.
 */
export function isMeasuredFont(font: TitleFont | undefined): boolean {
  return glyphRow(font) !== undefined;
}

/**
 * The width of `word` in em as the WRAP sees it — the sum of the advances, which is what
 * `wrap_lines` (`font.getlength`) and the preview's `measureText` compare against the box.
 */
export function wordWidthEm(word: string, font?: TitleFont): number {
  const row = rowOrDefault(font);
  let total = 0;
  for (const ch of word) {
    const index = GLYPH_INDEX.get(ch);
    total += index === undefined ? UNKNOWN_ADVANCE_EM : row[index]![0] / 1000;
  }
  return total;
}

/**
 * The drawn width of one line of `word`, in pixels, as `render_text_overlay_image` rasterizes
 * it: the ink from the first glyph's left edge to the last glyph's right edge, plus the stroke
 * and the padding around it (`6 × max(1, size // 12)`). The engine's title fit measures this
 * same raster, so the two agree to rounding (`tests/test_title_metrics.py` pins the formula).
 */
export function titleDrawnWidthPx(word: string, fontPx: number, font?: TitleFont): number {
  const row = rowOrDefault(font);
  const glyphs = [...word];
  if (glyphs.length === 0) return 0;
  let advance = 0;
  let inkLeft = 0;
  let inkRight = 0;
  glyphs.forEach((ch, position) => {
    const index = GLYPH_INDEX.get(ch);
    const [glyphAdvance, left, right] =
      index === undefined ? [UNKNOWN_FIT_EM * 1000, 0, UNKNOWN_FIT_EM * 1000] : row[index]!;
    if (position === 0) inkLeft = left;
    if (position === glyphs.length - 1) inkRight = advance + right;
    advance += glyphAdvance;
  });
  const stroke = Math.max(1, Math.floor(fontPx / 12));
  return ((inkRight - inkLeft) / 1000) * fontPx + 6 * stroke;
}

/** The style values this check needs; anything missing means it has no opinion. */
export interface OverlayFitInput {
  readonly text?: unknown;
  readonly fontSizePercent?: unknown;
  readonly boxWidthPercent?: unknown;
  readonly fontFamily?: unknown;
  readonly fontWeight?: unknown;
}

/** The named font on a fit input, when it names a string family. */
function fontOf(input: OverlayFitInput): TitleFont | undefined {
  if (typeof input.fontFamily !== 'string') return undefined;
  return {
    fontFamily: input.fontFamily,
    ...(typeof input.fontWeight === 'number' ? { fontWeight: input.fontWeight } : {}),
  };
}

/** A word that cannot be wrapped into its box, and the box width that would hold it. */
export interface OverflowingWord {
  readonly word: string;
  /**
   * The `boxWidthPercent` this word needs at the authored size, rounded up to a percent.
   * Can exceed 100: a box cannot be wider than the frame, so a word past that is saying
   * the SIZE has to come down, not the box go out.
   */
  readonly requiredBoxWidthPercent: number;
  /** The `boxWidthPercent` it was given. */
  readonly boxWidthPercent: number;
}

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The largest `fontSizePercent` at which every word of `text` is DRAWN inside a box of
 * `boxWidthPercent` — stroke and padding included, measured the way the engine's own title
 * fit measures (`service._fit_title_size`), so the two land on the same size.
 *
 * `undefined` when nothing constrains it (no text, no box, no frame). Floored to one decimal
 * so the number reads back as something an editor would type.
 */
export function largestFittingSizePercent(
  text: string,
  boxWidthPercent: number,
  resolution: { readonly width: number; readonly height: number },
  font?: TitleFont,
): number | undefined {
  const width = positive(resolution.width);
  const height = positive(resolution.height);
  const box = positive(boxWidthPercent);
  if (width === undefined || height === undefined || box === undefined) return undefined;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  const limitPx = (box / 100) * width;
  // The engine floors the pixel size (`text_overlay_style`): draw at that size.
  const fits = (tenths: number): boolean => {
    const fontPx = Math.floor((height * tenths) / 1000);
    return fontPx >= 1 && words.every((word) => titleDrawnWidthPx(word, fontPx, font) <= limitPx);
  };
  // Width is linear in size apart from the stroke's floor, so an estimate lands within a
  // step or two of the answer; walk from there.
  const perPx = Math.max(...words.map((word) => titleDrawnWidthPx(word, 1000, font) / 1000));
  let tenths = Math.floor(((limitPx / perPx) * 1000) / height);
  while (tenths > 0 && !fits(tenths)) tenths -= 1;
  while (fits(tenths + 1)) tenths += 1;
  return tenths > 0 ? tenths / 10 : undefined;
}

/**
 * The words in `input` that no wrap can fit into the box, widest first.
 *
 * Empty whenever the check cannot form an opinion: no text, no explicit size, no explicit
 * box width. A default in the renderer is not an authored value, and reporting against one
 * would be reporting against a number the editor never chose.
 *
 * @param input - The `text` effect's params.
 * @param resolution - The project's frame size; only its aspect ratio is used.
 * @returns The overflowing words, widest first. Empty when everything fits or the check
 *   cannot form an opinion.
 */
export function overflowingWords(
  input: OverlayFitInput,
  resolution: { readonly width: number; readonly height: number },
): OverflowingWord[] {
  const text = typeof input.text === 'string' ? input.text : undefined;
  const fontSizePercent = positive(input.fontSizePercent);
  const boxWidthPercent = positive(input.boxWidthPercent);
  const width = positive(resolution.width);
  const height = positive(resolution.height);
  if (!text || fontSizePercent === undefined || boxWidthPercent === undefined) return [];
  if (width === undefined || height === undefined) return [];

  // The box, expressed in em of the current font size — the unit the word widths are in.
  const boxEm = (boxWidthPercent * width) / (fontSizePercent * height);
  const font = fontOf(input);
  // A named bundled family is drawn from the same file by both the preview and the export,
  // so its measured width stands; with no family, or one the export cannot resolve, the two
  // may draw different faces and only the narrower one's overflow is worth reporting.
  const allowance = font !== undefined && isMeasuredFont(font) ? 1 : NARROW_FONT_ALLOWANCE;
  const seen = new Set<string>();
  const over: OverflowingWord[] = [];
  for (const word of text.split(/\s+/)) {
    if (word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    const measuredEm = wordWidthEm(word, font);
    if (measuredEm * allowance <= boxEm) continue;
    over.push({
      word,
      // DETECTED against the discounted width, RECOMMENDED from the measured one. The
      // discount exists so a narrow custom family cannot be reported wrongly; carrying it
      // into the recommendation would name a box that still does not hold the word in the
      // font the export actually draws with. Rounded up for the same reason.
      requiredBoxWidthPercent: Math.ceil((measuredEm * fontSizePercent * height) / width),
      boxWidthPercent,
    });
  }
  return over.sort((a, b) => b.requiredBoxWidthPercent - a.requiredBoxWidthPercent);
}
