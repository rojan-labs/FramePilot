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
 *
 * ## A title with caption typography is drawn by the caption rasterizer (#135)
 *
 * A `text` effect whose `typography` validates is drawn by `render_caption_raster`
 * (`text_overlay.text_overlay_caption_style`, ADR 0194), and that draws a word at other than
 * its advances: `letterSpacing` (em) follows every glyph, the last one and a space included, as
 * CSS `letter-spacing` does in the preview (a negative value tightens, down to `MIN_TRACKING_EM` —
 * `captions._token_width`); the ink spans only the spacing BETWEEN its glyphs. An italic is
 * drawn from the family's italic file, the stroke is `outlineWidth` sixteenths of the size,
 * and the wrap width is the box less the chip's padding on each side (0.35 em unless a chip
 * colour is set and its typography names its own `paddingX`). The harness's "WEEKEND TRIP" in
 * `tracked-caps` (0.24 em) draws 22 % wider than its advances, so a fit that ignored tracking
 * accepted boxes the export overflows. That path is measured in pixels, the way the caption
 * rasterizer lays it out (`typedTitleWidthsPx`; `tests/test_title_metrics.py` pins it).
 */

import {
  DEFAULT_TEXT_BOX_WIDTH_PERCENT,
  parseTextOverlayTypography,
} from '@framepilot/timeline-schema/text-overlay-styles';
import {
  TITLE_FACES,
  TITLE_FACE_LINES,
  TITLE_GLYPHS,
  TITLE_GLYPH_TABLES,
  TITLE_ITALIC_FACES,
  TITLE_ITALIC_FACE_LINES,
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
  /**
   * Only a title with caption typography draws italic, and only from a family that ships an
   * italic file (`TITLE_ITALIC_FACES`); any other family draws upright whatever this says.
   */
  readonly fontStyle?: 'normal' | 'italic';
}

/**
 * The caption-typography fields a typed title's WIDTH depends on, resolved the way
 * `text_overlay_caption_style` hands them to the caption rasterizer.
 */
export interface TypedTitle {
  /** Extra space between glyphs, em; negative tightens (clamped at {@link MIN_TRACKING_EM}). */
  readonly letterSpacing: number;
  /** Stroke width in sixteenths of the font size; 0 is no stroke. */
  readonly outlineWidth: number;
  /** Padding each side of the words inside the wrap width, em. */
  readonly paddingX: number;
  /** An italic is drawn from the family's italic file, where it ships one. */
  readonly fontStyle: 'normal' | 'italic';
}

/**
 * The tightest tracking either renderer draws, em (`captions.MIN_LETTER_SPACING_EM`,
 * `captionPreview.ts`): below it the letters run into each other.
 */
const MIN_TRACKING_EM = -0.2;
/** The caption rasterizer's chip padding when none is named (`captions._resolve_style`). */
const DEFAULT_CHIP_PADDING_EM = 0.35;
/** `outlineWidth`'s unit: sixteenths of the font size (`captions._OUTLINE_UNITS_PER_EM`). */
const OUTLINE_UNITS_PER_EM = 16;
/** The smallest title the export draws, in pixels (`text_overlay._MIN_FONT_SIZE`). */
const MIN_TITLE_FONT_PX = 16;
/**
 * The family a typed title is drawn in when the project stores none — the web editor's default,
 * which `text_overlay._with_editor_defaults` fills in for the caption path.
 */
const TYPED_DEFAULT_FAMILY = 'Inter';
/** The narrowest wrap box the caption rasterizer lays out in, percent of the frame width. */
const MIN_TYPED_BOX_PERCENT = 5;

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
  const family = font?.fontFamily ?? '';
  const rows =
    (font?.fontStyle === 'italic' ? TITLE_ITALIC_FACES[family] : undefined) ?? TITLE_FACES[family];
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

/**
 * The typed-title reading of a `text` effect's params: `undefined` for a plain title (no
 * `typography`, or one that does not validate — the export then draws the plain title too).
 *
 * @param typography - The stored `typography` param.
 * @param background - The title's own `background` param: the chip's padding comes from the
 *   typography only when a chip colour is set, exactly as `text_overlay_caption_style` reads it.
 */
export function typedTitleOf(typography: unknown, background: unknown): TypedTitle | undefined {
  const parsed = parseTextOverlayTypography(typography);
  if (parsed === undefined) return undefined;
  const chip = typeof background === 'string' && background.trim() !== '';
  return {
    letterSpacing: parsed.letterSpacing ?? 0,
    outlineWidth: parsed.outlineWidth ?? 0,
    paddingX: (chip ? parsed.background?.paddingX : undefined) ?? DEFAULT_CHIP_PADDING_EM,
    fontStyle: parsed.fontStyle ?? 'normal',
  };
}

/**
 * The font a typed title is drawn in: the caption path fills in the editor's family when the
 * project stores none, and the italic comes from the typography.
 */
export function typedTitleFont(font: TitleFont | undefined, typed: TypedTitle): TitleFont {
  return {
    fontFamily: font?.fontFamily ?? TYPED_DEFAULT_FAMILY,
    ...(font?.fontWeight === undefined ? {} : { fontWeight: font.fontWeight }),
    fontStyle: typed.fontStyle,
  };
}

/** The pixel size a title is drawn at for `sizePercent` of a frame `height` tall. */
function titleFontPx(sizePercent: number, height: number): number {
  return Math.max(MIN_TITLE_FONT_PX, Math.floor((height * sizePercent) / 100));
}

/**
 * How wide the caption rasterizer draws one `word` of a typed title at `fontPx`.
 *
 * - `wrapPx` — what it wraps against: the tracked advances (floored, as `block_w` is) plus the
 *   chip padding each side. Every glyph carries its tracking, the last one too: the preview's
 *   inline box ends one tracking past its last letter, and the export's box is that box. Equal to
 *   `measure_caption_layout(...).box_width` for one line (a space is a tracked glyph like any).
 * - `inkPx` — the stroked ink from the first glyph's left edge to the last one's right edge,
 *   the tracking between them included: what shows past the padding (an italic overhang, a
 *   heavy stroke).
 *
 * `unknownEm` is what a glyph the metrics do not cover is charged.
 */
export function typedTitleWidthsPx(
  word: string,
  fontPx: number,
  font: TitleFont | undefined,
  typed: TypedTitle,
  unknownEm: number = UNKNOWN_FIT_EM,
): { readonly wrapPx: number; readonly inkPx: number } {
  const row = rowOrDefault(font);
  const glyphs = [...word];
  if (glyphs.length === 0) return { wrapPx: 0, inkPx: 0 };
  const spacingPx = Math.max(MIN_TRACKING_EM, typed.letterSpacing) * fontPx;
  const trackedPx = spacingPx * glyphs.length;
  const gapsPx = spacingPx * (glyphs.length - 1);
  let advance = 0;
  let inkLeft = 0;
  let inkRight = 0;
  glyphs.forEach((ch, position) => {
    const index = GLYPH_INDEX.get(ch);
    const unknown = unknownEm * 1000;
    const [glyphAdvance, left, right] = index === undefined ? [unknown, 0, unknown] : row[index]!;
    if (position === 0) inkLeft = left;
    if (position === glyphs.length - 1) inkRight = advance + right;
    advance += glyphAdvance;
  });
  const stroke =
    typed.outlineWidth <= 0
      ? 0
      : Math.max(1, Math.round((typed.outlineWidth * fontPx) / OUTLINE_UNITS_PER_EM));
  const padPx = Math.floor(fontPx * typed.paddingX);
  return {
    wrapPx: Math.floor((advance / 1000) * fontPx + trackedPx) + 2 * padPx,
    inkPx: ((inkRight - inkLeft) / 1000) * fontPx + gapsPx + 2 * stroke,
  };
}

/** Everything of a typed `word` that is drawn, in whole pixels: chip or ink, whichever is wider. */
export function typedTitleDrawnWidthPx(
  word: string,
  fontPx: number,
  font: TitleFont | undefined,
  typed: TypedTitle,
  unknownEm: number = UNKNOWN_FIT_EM,
): number {
  const { wrapPx, inkPx } = typedTitleWidthsPx(word, fontPx, font, typed, unknownEm);
  return Math.ceil(Math.max(wrapPx, inkPx));
}

/** The box a typed title wraps in, in pixels, as the caption rasterizer computes it. */
function typedBoxPx(boxWidthPercent: number, frameWidth: number): number {
  const fraction = Math.min(1, Math.max(MIN_TYPED_BOX_PERCENT / 100, boxWidthPercent / 100));
  return Math.floor(frameWidth * fraction);
}

/** `text` in the case the typography draws it in. */
function inTypedCase(text: string, typography: unknown): string {
  const transform = parseTextOverlayTypography(typography)?.textTransform;
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  return text;
}

/** The style values this check needs; anything missing means it has no opinion. */
export interface OverlayFitInput {
  readonly text?: unknown;
  readonly fontSizePercent?: unknown;
  readonly boxWidthPercent?: unknown;
  readonly fontFamily?: unknown;
  readonly fontWeight?: unknown;
  /** The caption typography; a valid one means the caption rasterizer draws the title. */
  readonly typography?: unknown;
  /** The chip colour, which decides whether the typography's chip padding applies. */
  readonly background?: unknown;
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
 *
 * With `typed` (a title the caption rasterizer draws — {@link typedTitleOf}) the words are
 * measured as that draws them: tracked, in the typography's italic, inside the chip padding.
 * The caller passes the text in the case drawn.
 */
export function largestFittingSizePercent(
  text: string,
  boxWidthPercent: number,
  resolution: { readonly width: number; readonly height: number },
  font?: TitleFont,
  typed?: TypedTitle,
): number | undefined {
  const width = positive(resolution.width);
  const height = positive(resolution.height);
  const box = positive(boxWidthPercent);
  if (width === undefined || height === undefined || box === undefined) return undefined;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  if (typed !== undefined) return largestTypedSizePercent(words, box, width, height, font, typed);
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

/** {@link largestFittingSizePercent} for a typed title, in the caption rasterizer's pixels. */
function largestTypedSizePercent(
  words: readonly string[],
  box: number,
  width: number,
  height: number,
  font: TitleFont | undefined,
  typed: TypedTitle,
): number | undefined {
  const limitPx = typedBoxPx(box, width);
  const drawnIn = typedTitleFont(font, typed);
  const fits = (tenths: number): boolean => {
    const fontPx = titleFontPx(tenths / 10, height);
    return words.every((word) => typedTitleDrawnWidthPx(word, fontPx, drawnIn, typed) <= limitPx);
  };
  // Linear in size apart from the floors, as above: estimate, then walk. Below the export's
  // smallest size every size draws the same, so the walk stops there rather than at zero.
  const perPx = Math.max(
    ...words.map((word) => typedTitleDrawnWidthPx(word, 1000, drawnIn, typed) / 1000),
  );
  const floorTenths = Math.ceil((MIN_TITLE_FONT_PX * 1000) / height);
  let tenths = Math.max(floorTenths, Math.floor(((limitPx / perPx) * 1000) / height));
  while (tenths > floorTenths && !fits(tenths)) tenths -= 1;
  if (!fits(tenths)) return undefined;
  while (fits(tenths + 1)) tenths += 1;
  return tenths / 10;
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
  const typed = typedTitleOf(input.typography, input.background);
  if (typed !== undefined) {
    return overflowingTypedWords(text, fontSizePercent, boxWidthPercent, input, typed, {
      width,
      height,
    });
  }

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

/**
 * {@link overflowingWords} for a title the caption rasterizer draws: a word overflows when its
 * drawn width ({@link typedTitleDrawnWidthPx}) is wider than the box — which, for the wrap
 * part, is exactly when the rasterizer puts it on a line of its own and lets it run out.
 */
function overflowingTypedWords(
  text: string,
  fontSizePercent: number,
  boxWidthPercent: number,
  input: OverlayFitInput,
  typed: TypedTitle,
  frame: { readonly width: number; readonly height: number },
): OverflowingWord[] {
  const font = typedTitleFont(fontOf(input), typed);
  const allowance = isMeasuredFont(font) ? 1 : NARROW_FONT_ALLOWANCE;
  const fontPx = titleFontPx(fontSizePercent, frame.height);
  const boxPx = typedBoxPx(boxWidthPercent, frame.width);
  const seen = new Set<string>();
  const over: OverflowingWord[] = [];
  for (const word of inTypedCase(text, input.typography).split(/\s+/)) {
    if (word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    // A report, so an unknown glyph is charged the narrow estimate (see UNKNOWN_ADVANCE_EM).
    const drawnPx = typedTitleDrawnWidthPx(word, fontPx, font, typed, UNKNOWN_ADVANCE_EM);
    if (drawnPx * allowance <= boxPx) continue;
    over.push({
      word,
      requiredBoxWidthPercent: Math.ceil((drawnPx * 100) / frame.width),
      boxWidthPercent,
    });
  }
  return over.sort((a, b) => b.requiredBoxWidthPercent - a.requiredBoxWidthPercent);
}

// --------------------------------------------------------------------------- drawn geometry

/** A rectangle in frame pixels, origin top-left. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The params {@link drawnTextRects} reads: the fit's, plus where and how the text is set. */
export interface TextBoxInput extends OverlayFitInput {
  /** The box CENTRE, percent of the frame width (both renderers default to 50). */
  readonly xPercent?: unknown;
  /** The box CENTRE, percent of the frame height (both renderers default to 50). */
  readonly yPercent?: unknown;
  readonly align?: unknown;
  /** Legacy pixel size, honoured by the export when `fontSizePercent` is absent. */
  readonly fontSize?: unknown;
}

/** What {@link drawnTextRects} says is certainly drawn, in frame pixels. */
export interface DrawnText {
  /**
   * One rectangle per line of a typed title — the line's width by its x-height band, stroke
   * included — plus the chip where one is filled; one rectangle for a plain title's block.
   */
  readonly rects: readonly PixelRect[];
  /**
   * The whole box the text is set in: a typed title's chip (its lines and padding, drawn only
   * where the chip is filled), a plain title's block as {@link rects} bounds it.
   */
  readonly box: PixelRect;
  /** The pixel size the text is drawn at: what a tolerance in em is relative to. */
  readonly fontPx: number;
}

/** A plain title's size when it names none: `text_overlay._font_size_for`. */
const PLAIN_DEFAULT_SIZE_FRACTION = 1 / 14;
/** A typed title's size when it names none: the web editor's default, `_with_editor_defaults`. */
const TYPED_DEFAULT_SIZE_PERCENT = 8;
/** The caption rasterizer's chip padding when no chip names its own (`_resolve_style`). */
const DEFAULT_CHIP_PADDING_Y_EM = 0.35;
/** A plain title's stroke is a twelfth of its size, at least a pixel (`render_text_overlay_image`). */
const PLAIN_STROKE_DIVISOR = 12;
/** The gap between lines when no `lineHeight` says otherwise: a sixth of the size, both paths. */
const DEFAULT_LINE_GAP_DIVISOR = 6;

/** `[ascent, descent, xHeight]` in 1/1000 em of the face `font` is drawn from. */
function faceLines(font: TitleFont | undefined): readonly [number, number, number] {
  const family = font?.fontFamily ?? '';
  const known = font?.fontStyle === 'italic' ? TITLE_ITALIC_FACE_LINES[family] : undefined;
  return known ?? TITLE_FACE_LINES[family] ?? TITLE_FACE_LINES['']!;
}

/** The pixel size the export draws `input` at (`text_overlay_style`, or the editor default). */
function drawnFontPx(input: TextBoxInput, height: number, typed: boolean): number {
  const percent = positive(input.fontSizePercent);
  if (percent !== undefined) return titleFontPx(percent, height);
  const legacy = positive(input.fontSize);
  if (legacy !== undefined) return Math.floor(legacy);
  return typed
    ? titleFontPx(TYPED_DEFAULT_SIZE_PERCENT, height)
    : Math.max(MIN_TITLE_FONT_PX, Math.floor(height * PLAIN_DEFAULT_SIZE_FRACTION));
}

/** The sum of the advances of `text` at `fontPx`, tracked by `spacingPx` after every glyph. */
function advancePx(
  text: string,
  fontPx: number,
  font: TitleFont | undefined,
  spacingPx = 0,
): number {
  const row = rowOrDefault(font);
  let total = 0;
  for (const ch of text) {
    const index = GLYPH_INDEX.get(ch);
    // A report: an unknown glyph is charged the narrow estimate (see UNKNOWN_ADVANCE_EM).
    total +=
      (index === undefined ? UNKNOWN_ADVANCE_EM : row[index]![0] / 1000) * fontPx + spacingPx;
  }
  return total;
}

/**
 * Greedy wrap, as `wrap_lines` / `_wrap_plans` do: a word joins the line while the line stays
 * inside `maxPx`, and a word wider than that takes a line of its own. `breaks` are the author's
 * `\n` lines, each wrapped on its own. Returns each line's width in pixels.
 */
function wrapWidthsPx(
  authoredLines: readonly string[],
  maxPx: number,
  wordPx: (word: string) => number,
  spacePx: number,
): number[] {
  const widths: number[] = [];
  for (const authored of authoredLines) {
    let current: number | undefined;
    for (const word of authored.split(/\s+/).filter((w) => w.length > 0)) {
      const width = wordPx(word);
      if (current === undefined) current = width;
      else if (current + spacePx + width > maxPx) {
        widths.push(current);
        current = width;
      } else current += spacePx + width;
    }
    if (current !== undefined) widths.push(current);
  }
  return widths;
}

const percentOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * What a `text` effect certainly draws on the frame, in pixels — the geometry the critic's
 * `text_collision` check compares two overlays by.
 *
 * Laid out the way the export lays it out, both paths centred on `xPercent`/`yPercent`:
 *
 * - A typed title (a `typography` that validates) goes through the caption rasterizer: words
 *   tracked and wrapped inside the box less the chip padding, lines stacked at the face's
 *   ascent + descent + stroke with a sixth-of-a-size gap (or `lineHeight`), the chip padded
 *   `paddingY` above and below. Each line's rectangle spans its tracked width across its x-height
 *   band (baseline up to the top of an "x", stroke included): every line of letters inks at
 *   least that, and neither the ascender room nor the descender room of a line is drawn unless
 *   a letter reaches into it. A filled chip is drawn edge to edge, so it is a rectangle too.
 * - A plain title is drawn tight to its ink (`render_text_overlay_image`), and its line height is
 *   the ink's, which the table does not carry: its block is the widest line's inked width by
 *   `lines × (x-height + stroke)` plus the gaps, centred — inside the raster whatever the letters
 *   are, and mostly ink. With a background colour, the raster is filled, padding and all.
 *
 * Every estimate here errs SMALL, like the rest of this module's reports: a collision it names
 * is on screen; one it misses is the cost of not crying wolf.
 *
 * @param input - The `text` effect's params.
 * @param resolution - The project's frame size in pixels.
 * @returns The drawn rectangles, or `undefined` when there is no text or no frame.
 */
export function drawnTextRects(
  input: TextBoxInput,
  resolution: { readonly width: number; readonly height: number },
): DrawnText | undefined {
  const text = typeof input.text === 'string' ? input.text : undefined;
  const width = positive(resolution.width);
  const height = positive(resolution.height);
  if (!text || text.trim() === '' || width === undefined || height === undefined) return undefined;
  const centre = {
    x: (width * percentOr(input.xPercent, 50)) / 100,
    y: (height * percentOr(input.yPercent, 50)) / 100,
  };
  const boxPercent = percentOr(input.boxWidthPercent, DEFAULT_TEXT_BOX_WIDTH_PERCENT);
  const typed = typedTitleOf(input.typography, input.background);
  return typed === undefined
    ? plainTextRects(text, input, { width, height }, centre, boxPercent)
    : typedTextRects(text, input, typed, { width, height }, centre, boxPercent);
}

const chipFilled = (background: unknown): boolean =>
  typeof background === 'string' && background.trim() !== '';

function typedTextRects(
  text: string,
  input: TextBoxInput,
  typed: TypedTitle,
  frame: { readonly width: number; readonly height: number },
  centre: { readonly x: number; readonly y: number },
  boxPercent: number,
): DrawnText {
  const typography = parseTextOverlayTypography(input.typography);
  const fontPx = drawnFontPx(input, frame.height, true);
  const font = typedTitleFont(fontOf(input), typed);
  const spacingPx = Math.max(MIN_TRACKING_EM, typed.letterSpacing) * fontPx;
  const filled = chipFilled(input.background);
  const padX = Math.floor(fontPx * typed.paddingX);
  const padY = Math.floor(
    fontPx * ((filled ? typography?.background?.paddingY : undefined) ?? DEFAULT_CHIP_PADDING_Y_EM),
  );
  const stroke =
    typed.outlineWidth <= 0
      ? 0
      : Math.max(1, Math.round((typed.outlineWidth * fontPx) / OUTLINE_UNITS_PER_EM));
  const lineHeight = typography?.lineHeight;
  const gap =
    lineHeight === undefined
      ? Math.max(1, Math.floor(fontPx / DEFAULT_LINE_GAP_DIVISOR))
      : Math.max(0, Math.floor(fontPx * (lineHeight - 1)));
  const maxTextPx = Math.max(fontPx, typedBoxPx(boxPercent, frame.width) - 2 * padX);
  const lineWidths = wrapWidthsPx(
    inTypedCase(text, input.typography).split('\n'),
    maxTextPx,
    (word) => advancePx(word, fontPx, font, spacingPx),
    advancePx(' ', fontPx, font, spacingPx),
  );
  const [ascentEm, descentEm, xHeightEm] = faceLines(font);
  const ascent = Math.ceil((ascentEm * fontPx) / 1000);
  const descent = Math.ceil((descentEm * fontPx) / 1000);
  const xHeight = Math.floor((xHeightEm * fontPx) / 1000);
  const linePx = ascent + descent + 2 * stroke;
  const blockW = Math.floor(Math.max(0, ...lineWidths));
  const blockH = lineWidths.length * linePx + gap * Math.max(0, lineWidths.length - 1);
  const chip = {
    x: centre.x - (blockW + 2 * padX) / 2,
    y: centre.y - (blockH + 2 * padY) / 2,
    width: blockW + 2 * padX,
    height: blockH + 2 * padY,
  };
  const align = input.align === 'left' || input.align === 'right' ? input.align : 'center';
  const rects: PixelRect[] = lineWidths.map((lineWidth, index) => {
    const slack = blockW - lineWidth;
    const offset = align === 'left' ? 0 : align === 'right' ? slack : slack / 2;
    const baseline = chip.y + padY + index * (linePx + gap) + ascent + stroke;
    return {
      x: chip.x + padX + offset,
      y: baseline - xHeight - stroke,
      width: lineWidth,
      height: xHeight + 2 * stroke,
    };
  });
  return { rects: filled ? [chip, ...rects] : rects, box: chip, fontPx };
}

function plainTextRects(
  text: string,
  input: TextBoxInput,
  frame: { readonly width: number; readonly height: number },
  centre: { readonly x: number; readonly y: number },
  boxPercent: number,
): DrawnText {
  const fontPx = drawnFontPx(input, frame.height, false);
  const font = fontOf(input);
  const boxPx = Math.max(
    1,
    Math.floor((frame.width * Math.min(Math.max(boxPercent, 1), 100)) / 100),
  );
  const stroke = Math.max(1, Math.floor(fontPx / PLAIN_STROKE_DIVISOR));
  // `render_text_overlay_image` wraps `text.split()`: an authored newline is only whitespace here.
  const lineWidths = wrapWidthsPx(
    [text],
    boxPx,
    (word) => advancePx(word, fontPx, font),
    advancePx(' ', fontPx, font),
  );
  const xHeight = Math.floor((faceLines(font)[2] * fontPx) / 1000);
  const gap = Math.max(1, Math.floor(fontPx / DEFAULT_LINE_GAP_DIVISOR));
  const blockW = Math.max(...lineWidths) + 2 * stroke;
  const blockH = lineWidths.length * (xHeight + 2 * stroke) + gap * (lineWidths.length - 1);
  // The raster's padding is two strokes each side; filled by a background colour.
  const pad = chipFilled(input.background) ? 2 * stroke : 0;
  const box = {
    x: centre.x - blockW / 2 - pad,
    y: centre.y - blockH / 2 - pad,
    width: blockW + 2 * pad,
    height: blockH + 2 * pad,
  };
  return { rects: [box], box, fontPx };
}
