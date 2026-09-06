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

/**
 * Advance widths in em of the font the export actually uses — Pillow's bundled TrueType,
 * measured at size 1000 (`ImageFont.load_default`, which `captions.py` and
 * `text_overlay.py` both load unless a named family resolves). It has no kerning: the
 * width of a string is the sum of its characters' advances, exact to the pixel.
 */
const ADVANCE_EM: Readonly<Record<string, number>> = {
  ' ': 0.216,
  '!': 0.242,
  '"': 0.339,
  '#': 0.58,
  $: 0.58,
  '%': 0.74,
  '&': 0.654,
  "'": 0.176,
  '(': 0.315,
  ')': 0.315,
  '*': 0.56,
  '+': 0.58,
  ',': 0.22,
  '-': 0.274,
  '.': 0.22,
  '/': 0.303,
  '0': 0.58,
  '1': 0.58,
  '2': 0.58,
  '3': 0.58,
  '4': 0.58,
  '5': 0.58,
  '6': 0.58,
  '7': 0.58,
  '8': 0.58,
  '9': 0.58,
  ':': 0.22,
  ';': 0.22,
  '<': 0.58,
  '=': 0.58,
  '>': 0.58,
  '?': 0.499,
  '@': 0.852,
  A: 0.639,
  B: 0.627,
  C: 0.699,
  D: 0.709,
  E: 0.587,
  F: 0.567,
  G: 0.71,
  H: 0.73,
  I: 0.264,
  J: 0.544,
  K: 0.609,
  L: 0.575,
  M: 0.866,
  N: 0.718,
  O: 0.737,
  P: 0.598,
  Q: 0.733,
  R: 0.619,
  S: 0.585,
  T: 0.612,
  U: 0.682,
  V: 0.622,
  W: 0.952,
  X: 0.625,
  Y: 0.581,
  Z: 0.591,
  '[': 0.307,
  '\\': 0.303,
  ']': 0.295,
  '^': 0.58,
  _: 0.5,
  '`': 0.3,
  a: 0.531,
  b: 0.611,
  c: 0.529,
  d: 0.615,
  e: 0.549,
  f: 0.29,
  g: 0.615,
  h: 0.593,
  i: 0.238,
  j: 0.233,
  k: 0.522,
  l: 0.247,
  m: 0.855,
  n: 0.593,
  o: 0.586,
  p: 0.611,
  q: 0.615,
  r: 0.33,
  s: 0.459,
  t: 0.313,
  u: 0.592,
  v: 0.514,
  w: 0.785,
  x: 0.482,
  y: 0.513,
  z: 0.462,
  '{': 0.303,
  '|': 0.25,
  '}': 0.303,
  '~': 0.58,
};

/**
 * What an unknown character is worth. Every script this table does not cover is WIDER than
 * this — CJK is a full em, and Latin-1 accented forms match their base letters — so an
 * unknown character can only make this estimate too small, which is the safe direction.
 */
const UNKNOWN_ADVANCE_EM = 0.5;

/**
 * How much narrower than the bundled font a custom family is assumed able to be.
 *
 * `fontFamily` is authored, and the preview honours it (`ctx.font`) while the export falls
 * back to the bundled font when it cannot resolve one. A report is only worth making when
 * it holds for the narrower of the two, so the measured width is discounted before it is
 * compared. 10% is roughly the gap between a normal sans and a condensed one; past that a
 * word simply is not reported, and under-reporting is the failure this check can afford.
 */
const NARROW_FONT_ALLOWANCE = 0.9;

/** The width of `word` in em, in the font the export draws with. */
export function wordWidthEm(word: string): number {
  let total = 0;
  for (const ch of word) total += ADVANCE_EM[ch] ?? UNKNOWN_ADVANCE_EM;
  return total;
}

/** The style values this check needs; anything missing means it has no opinion. */
export interface OverlayFitInput {
  readonly text?: unknown;
  readonly fontSizePercent?: unknown;
  readonly boxWidthPercent?: unknown;
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
/**
 * The largest `fontSizePercent` at which every word of `text` fits a box of
 * `boxWidthPercent`, by the same measurement {@link overflowingWords} judges with.
 *
 * `undefined` when nothing constrains it (no text, no box, no frame). Floored to one decimal
 * so the number reads back as something an editor would type.
 */
export function largestFittingSizePercent(
  text: string,
  boxWidthPercent: number,
  resolution: { readonly width: number; readonly height: number },
): number | undefined {
  const width = positive(resolution.width);
  const height = positive(resolution.height);
  const box = positive(boxWidthPercent);
  if (width === undefined || height === undefined || box === undefined) return undefined;
  let widest = 0;
  for (const word of text.split(/\s+/)) widest = Math.max(widest, wordWidthEm(word));
  if (widest === 0) return undefined;
  // fits ⇔ widest·allowance ≤ box·W / (size·H)  ⇒  size ≤ box·W / (widest·allowance·H)
  const size = (box * width) / (widest * NARROW_FONT_ALLOWANCE * height);
  return Math.floor(size * 10) / 10;
}

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
  const seen = new Set<string>();
  const over: OverflowingWord[] = [];
  for (const word of text.split(/\s+/)) {
    if (word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    const measuredEm = wordWidthEm(word);
    if (measuredEm * NARROW_FONT_ALLOWANCE <= boxEm) continue;
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
