/**
 * @framepilot/timeline-schema/text-overlay-styles — text overlay (text overlay) typography and the text overlay
 * template catalog.
 *
 * WHY text overlays take the caption typography. A caption carries the whole caption vocabulary
 * (outline, shadow, chip shape, case, tracking, see-through letters) while a text overlay had a colour,
 * a family and a fixed black stroke, so a text overlay could never match the captions beside it. A
 * text overlay's `text` effect may now carry {@link TextOverlayTypography} — the caption style's LINE-level
 * fields — and a text overlay that does is drawn by the caption rasterizer itself
 * (`engine/python/framepilot_engine/render/text_overlay.py#text_overlay_caption_style`, the same call
 * the export and the desktop monitor make). The preview reads the same mapping,
 * {@link textOverlayCaptionStyle}, through the caption CSS (`captionPreview.ts`).
 *
 * The text overlay's own params stay authoritative for what they already said — family, weight,
 * colour, size, alignment, wrap width and whether there is a chip — so the Inspector, the
 * on-canvas editor and the AI's `add_text_layer` keep working unchanged.
 *
 * A chip may be frosted glass (`background.blur`): the picture composited beneath the text overlay
 * is blurred inside the chip, in the export (`compiler.py` `_composite_frosted`) and the desktop
 * monitor (`layer-compositor.ts` `frostPlaced`), placed with the text overlay's own transform.
 *
 * Left out on text overlays, by design: everything word-timed or animated (highlight, accent,
 * entrances, loops) — a text overlay animates through its layer transitions.
 *
 * The catalog is PURE DATA, like the caption catalog: a template is a complete {@link TextOverlayLook}
 * that the editor writes into the text overlay's params when it is applied. Nothing resolves a template
 * id at render time, so revising a template never changes a text overlay already placed.
 */
import { CaptionBackgroundSchema, CaptionStyleSchema, type CaptionStyle } from './index.js';
import { z } from 'zod/v4';

/**
 * The caption-style fields a text overlay's `typography` carries. Mirrors `TEXT_OVERLAY_TYPOGRAPHY_FIELDS` in
 * `render/text_overlay.py`; the chip's shape rides in `background`.
 */
export const TEXT_OVERLAY_TYPOGRAPHY_FIELDS = [
  'fontStyle',
  'textTransform',
  'letterSpacing',
  'lineHeight',
  'textOpacity',
  'outlineColor',
  'outlineWidth',
  'shadow',
] as const;

/**
 * The chip's shape (radius, padding, rim, frosted-glass blur). Its colour is the text overlay's
 * own `background` param — the Inspector's on/off switch.
 */
export const TextOverlayChipSchema = CaptionBackgroundSchema.omit({ color: true });

/** A text overlay's caption typography (see the module doc). */
export const TextOverlayTypographySchema = CaptionStyleSchema.pick({
  fontStyle: true,
  textTransform: true,
  letterSpacing: true,
  lineHeight: true,
  textOpacity: true,
  outlineColor: true,
  outlineWidth: true,
  shadow: true,
}).extend({ background: TextOverlayChipSchema.optional() });

export type TextOverlayChip = z.infer<typeof TextOverlayChipSchema>;
export type TextOverlayTypography = z.infer<typeof TextOverlayTypographySchema>;

/**
 * The typography a PLAIN text overlay (one with no `typography`) is drawn with, in caption terms: the
 * engine's fixed black stroke of a twelfth of the font size (`render_text_overlay_image`), which
 * is 16/12 sixteenths, and its square box padded by two strokes. The Inspector shows a plain
 * text overlay's typography as this and seeds the first edit with it, so converting a text overlay to the
 * caption typography keeps the look it had.
 */
export const PLAIN_TEXT_OVERLAY_TYPOGRAPHY: TextOverlayTypography = {
  outlineColor: '#000000',
  outlineWidth: 16 / 12,
  background: { radius: 0, paddingX: 1 / 6, paddingY: 1 / 6 },
};

/** Horizontal alignment of a text overlay's lines. */
export type TextOverlayAlign = 'left' | 'center' | 'right';

/**
 * Everything a template decides about a text overlay: the params it writes (the same keys as the web
 * editor's `TextOverlayParams`, minus the text and the animation, which stay the author's).
 */
export interface TextOverlayLook {
  readonly fontFamily: string;
  readonly fontWeight: number;
  /** Letter colour, `#rrggbb[aa]` (the engine parses hex only). */
  readonly color: string;
  /** Glyph size as a percentage of the frame HEIGHT. */
  readonly fontSizePercent: number;
  readonly align: TextOverlayAlign;
  /** Wrap width as a percentage of the frame width. */
  readonly boxWidthPercent: number;
  /** Box centre as a percentage of each axis, origin top-left. */
  readonly xPercent: number;
  readonly yPercent: number;
  /** Chip colour, or `null` for no chip. */
  readonly background: string | null;
  readonly typography: TextOverlayTypography;
}

/** The inputs {@link textOverlayCaptionStyle} reads: a text overlay's params, as stored or as defaulted. */
export interface TextOverlayStyleParams {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly color: string;
  readonly fontSizePercent: number;
  readonly align: TextOverlayAlign;
  readonly boxWidthPercent: number;
  readonly background: string | null;
  readonly typography?: TextOverlayTypography | undefined;
}

/**
 * A caption's base glyph height as a percentage of the frame height (the engine's
 * `_FONT_HEIGHT_FRACTION` = 1/22, the preview's `CAPTION_FONT_CQH`). A caption's size is this
 * times its `fontScale`, which is how a text overlay's `fontSizePercent` becomes a caption scale.
 */
export const CAPTION_FONT_HEIGHT_PERCENT = 100 / 22;

const MIN_BOX_WIDTH_PERCENT = 5;

/**
 * The caption style a text overlay with `typography` is drawn in (the web twin of the engine's
 * `text_overlay_caption_style`); `undefined` for a plain text overlay, which keeps its own drawing.
 *
 * Nothing positional is included: a text overlay is placed by its `xPercent`/`yPercent` and transform.
 */
export function textOverlayCaptionStyle(params: TextOverlayStyleParams): CaptionStyle | undefined {
  const typography = params.typography;
  if (typography === undefined) return undefined;
  const { background: chip, ...line } = typography;
  const style: CaptionStyle = {
    ...line,
    display: 'phrase',
    fontFamily: params.fontFamily,
    fontWeight: Math.round(Math.min(900, Math.max(100, params.fontWeight))),
    fontScale: params.fontSizePercent / CAPTION_FONT_HEIGHT_PERCENT,
    textColor: params.color,
    textAlign: params.align,
    maxWidthPercent: Math.min(100, Math.max(MIN_BOX_WIDTH_PERCENT, params.boxWidthPercent)),
  };
  if (params.background !== null && params.background.trim() !== '') {
    style.background = { ...chip, color: params.background };
  }
  return style;
}

/**
 * Read a stored `typography` param: the parsed value, or `undefined` when it is absent or does
 * not validate (the engine then draws the plain text overlay too, so the preview agrees with it).
 */
export function parseTextOverlayTypography(value: unknown): TextOverlayTypography | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = TextOverlayTypographySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// --------------------------------------------------------------------------- catalog

/** Gallery grouping in the Text panel. */
export type TextOverlayStyleCategory =
  'basic' | 'headlines' | 'lower-thirds' | 'callouts' | 'social' | 'quotes' | 'script' | 'retro';

export const TEXT_OVERLAY_STYLE_CATEGORIES: readonly {
  readonly id: TextOverlayStyleCategory;
  readonly label: string;
}[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'headlines', label: 'Headlines' },
  { id: 'lower-thirds', label: 'Lower thirds' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'social', label: 'Social' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'script', label: 'Script' },
  { id: 'retro', label: 'Retro & fun' },
];

export interface TextOverlayStyle {
  /** Stable id, stored on the text overlay as `templateId` for provenance. Never rename. */
  readonly id: string;
  readonly label: string;
  readonly category: TextOverlayStyleCategory;
  /** The text a new text overlay from this template starts with, and its tile shows. */
  readonly sampleText: string;
  readonly look: TextOverlayLook;
}

// Palette and separation layers. Every look keeps a separation layer (outline, shadow or chip):
// a text overlay is drawn over footage nobody chose for it, and plain white text vanishes on a sky.
// Units, as in the caption catalog: shadow blur/offsets are fractions of the font size;
// outlineWidth and borderWidth are sixteenths of it.
const WHITE = '#ffffff';
const OFF_WHITE = '#f4f1ea';
const INK = '#0b0b0f';
const YELLOW = '#ffd60a';
const RED = '#ff2e4d';
const CYAN = '#3de0ff';
const LIME = '#8cff5a';
const PINK = '#ff4fa3';
const BLUE = '#2f6bff';
const YOUTUBE_RED = '#ff0033';
const GOLD = '#f2c14e';
const ORANGE = '#ff6b1a';
const GREEN = '#16a34a';
const PHOSPHOR = '#7dff9b';

const SOFT_DROP = { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 } as const;
const HALO = { color: '#000000d9', blur: 0.26, offsetX: 0, offsetY: 0.02 } as const;
const HARD_DROP = { color: '#000000', blur: 0, offsetX: 0.05, offsetY: 0.07 } as const;
/** A coloured glow: zero offset, a wide blur in the letter colour. */
const glow = (color: string) => ({ color, blur: 0.55, offsetX: 0, offsetY: 0 }) as const;

/**
 * The box width, % of the frame, both renderers draw a text overlay with when its params name
 * none (web editor `DEFAULT_TEXT_PARAMS`, `text-raster.ts`; engine `text_overlay.py`
 * `_DEFAULT_BOX_WIDTH_PERCENT`). The box is centred on `xPercent`, so anything placing text
 * must keep THIS box in frame, not only a width someone chose.
 */
export const DEFAULT_TEXT_BOX_WIDTH_PERCENT = 80;

/** Centre-frame placement, the default for a text overlay. */
const CENTRE = {
  align: 'center',
  boxWidthPercent: DEFAULT_TEXT_BOX_WIDTH_PERCENT,
  xPercent: 50,
  yPercent: 50,
} as const;
/** Upper third: a hook sits above the subject's face. */
const UPPER = { align: 'center', boxWidthPercent: 84, xPercent: 50, yPercent: 22 } as const;
/**
 * A lower third: left-aligned in the bottom-left, clear of the caption band (captions sit 8% of
 * the height from the bottom edge). Sizes are a share of the frame HEIGHT, so a portrait frame
 * is far narrower per letter than a landscape one: the wrap width and the sizes below keep a
 * name on one line in 9:16 as well as 16:9.
 */
const LOWER_THIRD = { align: 'left', boxWidthPercent: 76, xPercent: 42, yPercent: 76 } as const;

function look(
  fields: Omit<TextOverlayLook, 'background' | 'typography'> & Partial<TextOverlayLook>,
): TextOverlayLook {
  return { background: null, typography: {}, ...fields };
}

const HAND_MADE: readonly TextOverlayStyle[] = [
  // ------------------------------------------------------------------ basic
  {
    id: 'heading',
    label: 'Heading',
    category: 'basic',
    sampleText: 'Add a heading',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 8,
      typography: { letterSpacing: -0.01, shadow: SOFT_DROP },
    }),
  },
  {
    id: 'subheading',
    label: 'Subheading',
    category: 'basic',
    sampleText: 'Add a subheading',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 5.5,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'body',
    label: 'Body text',
    category: 'basic',
    sampleText: 'Add a little bit of body text',
    look: look({
      ...CENTRE,
      boxWidthPercent: 70,
      fontFamily: 'Inter',
      fontWeight: 500,
      color: WHITE,
      fontSizePercent: 4,
      typography: { lineHeight: 1.3, shadow: SOFT_DROP },
    }),
  },
  {
    id: 'outline-caps',
    label: 'Outline caps',
    category: 'basic',
    sampleText: 'Outline caps',
    look: look({
      ...CENTRE,
      fontFamily: 'Montserrat',
      fontWeight: 900,
      color: WHITE,
      fontSizePercent: 7,
      typography: { textTransform: 'uppercase', outlineColor: INK, outlineWidth: 2 },
    }),
  },
  {
    id: 'serif-heading',
    label: 'Serif',
    category: 'basic',
    sampleText: 'A serif heading',
    look: look({
      ...CENTRE,
      fontFamily: 'Playfair Display',
      fontWeight: 700,
      color: OFF_WHITE,
      fontSizePercent: 7.5,
      typography: { shadow: HALO },
    }),
  },
  {
    id: 'hollow',
    label: 'Hollow caps',
    category: 'basic',
    sampleText: 'Hollow',
    look: look({
      ...CENTRE,
      fontFamily: 'Archivo Black',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 10,
      typography: {
        textTransform: 'uppercase',
        textOpacity: 0,
        outlineColor: WHITE,
        outlineWidth: 1.5,
      },
    }),
  },
  // -------------------------------------------------------------- headlines
  {
    id: 'impact-title',
    label: 'Big headline',
    category: 'headlines',
    sampleText: 'Big news',
    look: look({
      ...CENTRE,
      fontFamily: 'Anton',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 11,
      typography: {
        textTransform: 'uppercase',
        outlineColor: INK,
        outlineWidth: 2,
        shadow: HARD_DROP,
      },
    }),
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    category: 'headlines',
    sampleText: 'The long road',
    look: look({
      ...CENTRE,
      fontFamily: 'Cinzel',
      fontWeight: 600,
      color: OFF_WHITE,
      fontSizePercent: 6,
      typography: { textTransform: 'uppercase', letterSpacing: 0.22, shadow: HALO },
    }),
  },
  {
    id: 'hook',
    label: 'Hook',
    category: 'headlines',
    sampleText: 'Stop scrolling',
    look: look({
      ...UPPER,
      fontFamily: 'Unbounded',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 6.5,
      background: RED,
      typography: {
        textTransform: 'uppercase',
        background: { radius: 0.18, paddingX: 0.45, paddingY: 0.25 },
      },
    }),
  },
  {
    id: 'neon',
    label: 'Neon sign',
    category: 'headlines',
    sampleText: 'Night mode',
    look: look({
      ...CENTRE,
      fontFamily: 'Righteous',
      fontWeight: 400,
      color: CYAN,
      fontSizePercent: 9,
      typography: { shadow: glow('#3de0ffcc') },
    }),
  },
  {
    id: 'retro-pop',
    label: 'Retro pop',
    category: 'headlines',
    sampleText: 'Game on',
    look: look({
      ...CENTRE,
      fontFamily: 'Luckiest Guy',
      fontWeight: 400,
      color: YELLOW,
      fontSizePercent: 10,
      typography: { outlineColor: INK, outlineWidth: 2.5, shadow: HARD_DROP },
    }),
  },
  {
    id: 'editorial',
    label: 'Editorial',
    category: 'headlines',
    sampleText: 'Slow mornings',
    look: look({
      ...CENTRE,
      fontFamily: 'Instrument Serif',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 10,
      typography: { fontStyle: 'italic', lineHeight: 1.05, shadow: HALO },
    }),
  },
  {
    id: 'terminal',
    label: 'Terminal',
    category: 'headlines',
    sampleText: '> ship it',
    look: look({
      ...CENTRE,
      fontFamily: 'JetBrains Mono',
      fontWeight: 700,
      color: LIME,
      fontSizePercent: 6,
      background: '#0b0b0fd9',
      typography: { background: { radius: 0.12, paddingX: 0.5, paddingY: 0.3 } },
    }),
  },
  // ----------------------------------------------------------- lower thirds
  {
    id: 'name-tag',
    label: 'Name tag',
    category: 'lower-thirds',
    sampleText: 'Alex Rivera',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Inter',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 3.6,
      background: '#0b0b0fcc',
      typography: { background: { radius: 0.15, paddingX: 0.6, paddingY: 0.32 } },
    }),
  },
  {
    id: 'accent-bar',
    label: 'Accent bar',
    category: 'lower-thirds',
    sampleText: 'Product lead',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Montserrat',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 3.2,
      background: BLUE,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.06,
        background: { radius: 0.08, paddingX: 0.6, paddingY: 0.3 },
      },
    }),
  },
  {
    id: 'minimal-lower',
    label: 'Location',
    category: 'lower-thirds',
    sampleText: 'Filmed in Lisbon',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'DM Sans',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 3.2,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'smoked-lower',
    label: 'Smoked',
    category: 'lower-thirds',
    sampleText: 'Jordan Lee · Founder',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Plus Jakarta Sans',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 3.2,
      background: '#0b0b0f99',
      typography: {
        background: {
          radius: 0.3,
          paddingX: 0.6,
          paddingY: 0.3,
          blur: 0.4,
          borderColor: '#ffffff2e',
          borderWidth: 1,
        },
      },
    }),
  },
  {
    id: 'serif-credit',
    label: 'Credit',
    category: 'lower-thirds',
    sampleText: 'Music by Nova',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Lora',
      fontWeight: 500,
      color: OFF_WHITE,
      fontSizePercent: 3.4,
      typography: { fontStyle: 'italic', shadow: HALO },
    }),
  },
  // --------------------------------------------------------------- callouts
  {
    id: 'highlight',
    label: 'Highlight',
    category: 'callouts',
    sampleText: 'Key point',
    look: look({
      ...CENTRE,
      fontFamily: 'Poppins',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 6,
      background: YELLOW,
      typography: { background: { radius: 0.15, paddingX: 0.45, paddingY: 0.2 } },
    }),
  },
  {
    id: 'pill-tag',
    label: 'Pill tag',
    category: 'callouts',
    sampleText: 'New',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 4,
      background: RED,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.08,
        background: { radius: 0.6, paddingX: 0.7, paddingY: 0.28 },
      },
    }),
  },
  {
    id: 'sticker',
    label: 'Pow',
    category: 'callouts',
    sampleText: 'Wow!',
    look: look({
      ...CENTRE,
      fontFamily: 'Bangers',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 11,
      typography: { letterSpacing: 0.03, outlineColor: INK, outlineWidth: 2.5, shadow: HARD_DROP },
    }),
  },
  {
    id: 'big-number',
    label: 'Big number',
    category: 'callouts',
    sampleText: '3x faster',
    look: look({
      ...CENTRE,
      fontFamily: 'Bebas Neue',
      fontWeight: 400,
      color: YELLOW,
      fontSizePercent: 15,
      typography: { shadow: HARD_DROP },
    }),
  },
  {
    id: 'label',
    label: 'Label',
    category: 'callouts',
    sampleText: 'Step 1',
    look: look({
      ...CENTRE,
      fontFamily: 'Space Mono',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 4.5,
      background: LIME,
      typography: {
        textTransform: 'uppercase',
        background: { radius: 0.05, paddingX: 0.5, paddingY: 0.22 },
      },
    }),
  },
  // ----------------------------------------------------------------- social
  {
    id: 'subscribe',
    label: 'Subscribe',
    category: 'social',
    sampleText: 'Subscribe',
    look: look({
      ...CENTRE,
      yPercent: 78,
      fontFamily: 'Montserrat',
      fontWeight: 900,
      color: WHITE,
      fontSizePercent: 5,
      background: YOUTUBE_RED,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.04,
        background: { radius: 0.25, paddingX: 0.7, paddingY: 0.32 },
      },
    }),
  },
  {
    id: 'follow',
    label: 'Follow',
    category: 'social',
    sampleText: 'Follow for more',
    look: look({
      ...CENTRE,
      yPercent: 78,
      fontFamily: 'Poppins',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 4.5,
      background: PINK,
      typography: { background: { radius: 0.6, paddingX: 0.7, paddingY: 0.3 } },
    }),
  },
  {
    id: 'handle',
    label: 'Handle',
    category: 'social',
    sampleText: '@yourhandle',
    look: look({
      ...CENTRE,
      yPercent: 86,
      fontFamily: 'Inter',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 3.6,
      background: '#00000080',
      typography: { background: { radius: 0.6, paddingX: 0.6, paddingY: 0.25 } },
    }),
  },
  {
    id: 'comment-bubble',
    label: 'Comment',
    category: 'social',
    sampleText: 'Wait for it…',
    look: look({
      ...UPPER,
      fontFamily: 'Nunito',
      fontWeight: 800,
      color: INK,
      fontSizePercent: 4.5,
      background: WHITE,
      typography: { background: { radius: 0.45, paddingX: 0.6, paddingY: 0.3 } },
    }),
  },
  // ----------------------------------------------------------------- quotes
  {
    id: 'quote-serif',
    label: 'Quote',
    category: 'quotes',
    sampleText: '“Make it simple.”',
    look: look({
      ...CENTRE,
      fontFamily: 'Playfair Display',
      fontWeight: 500,
      color: WHITE,
      fontSizePercent: 6.5,
      typography: { fontStyle: 'italic', lineHeight: 1.2, shadow: HALO },
    }),
  },
  {
    id: 'quote-hand',
    label: 'Handwritten',
    category: 'script',
    sampleText: 'best day ever',
    look: look({
      ...CENTRE,
      fontFamily: 'Caveat',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 9,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'typewriter-card',
    label: 'Chapter card',
    category: 'quotes',
    sampleText: 'Chapter one',
    look: look({
      ...CENTRE,
      fontFamily: 'Courier Prime',
      fontWeight: 400,
      color: OFF_WHITE,
      fontSizePercent: 5,
      background: '#0b0b0fcc',
      typography: { background: { radius: 0.06, paddingX: 0.6, paddingY: 0.35 } },
    }),
  },
  {
    id: 'statement',
    label: 'Statement',
    category: 'quotes',
    sampleText: 'Less, but better.',
    look: look({
      ...CENTRE,
      fontFamily: 'Fraunces',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 8,
      typography: { letterSpacing: -0.02, lineHeight: 1.05, shadow: SOFT_DROP },
    }),
  }, // ------------------------------------------------------ basic (more)
  {
    id: 'tracked-caps',
    label: 'Tracked caps',
    category: 'basic',
    sampleText: 'Behind the scenes',
    look: look({
      ...CENTRE,
      fontFamily: 'Montserrat',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 4,
      typography: { textTransform: 'uppercase', letterSpacing: 0.24, shadow: SOFT_DROP },
    }),
  },
  {
    id: 'rounded',
    label: 'Rounded',
    category: 'basic',
    sampleText: 'Hello there',
    look: look({
      ...CENTRE,
      fontFamily: 'Nunito',
      fontWeight: 900,
      color: WHITE,
      fontSizePercent: 7.5,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'white-box',
    label: 'White box',
    category: 'basic',
    sampleText: 'Simple and clear',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 5,
      background: WHITE,
      typography: { background: { radius: 0.12, paddingX: 0.5, paddingY: 0.25 } },
    }),
  },
  {
    id: 'frosted',
    label: 'Frosted',
    category: 'basic',
    sampleText: 'Frosted glass',
    look: look({
      ...CENTRE,
      fontFamily: 'Plus Jakarta Sans',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 5,
      background: '#ffffff26',
      typography: {
        shadow: SOFT_DROP,
        background: {
          radius: 0.45,
          paddingX: 0.6,
          paddingY: 0.3,
          blur: 0.4,
          borderColor: '#ffffff66',
          borderWidth: 1,
        },
      },
    }),
  },
  // --------------------------------------------------------- headlines (more)
  {
    id: 'poster',
    label: 'Poster',
    category: 'headlines',
    sampleText: 'Summer drop',
    look: look({
      ...CENTRE,
      fontFamily: 'Bebas Neue',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 14,
      typography: { textTransform: 'uppercase', letterSpacing: 0.04, shadow: HARD_DROP },
    }),
  },
  {
    id: 'luxury',
    label: 'Luxury',
    category: 'headlines',
    sampleText: 'The collection',
    look: look({
      ...CENTRE,
      fontFamily: 'Bodoni Moda',
      fontWeight: 700,
      color: GOLD,
      fontSizePercent: 7,
      typography: { fontStyle: 'italic', shadow: HALO },
    }),
  },
  {
    id: 'block',
    label: 'Block',
    category: 'headlines',
    sampleText: 'Part two',
    look: look({
      ...CENTRE,
      fontFamily: 'Archivo Black',
      fontWeight: 400,
      color: INK,
      fontSizePercent: 8,
      background: WHITE,
      typography: {
        textTransform: 'uppercase',
        background: { radius: 0.04, paddingX: 0.4, paddingY: 0.18 },
      },
    }),
  },
  // ----------------------------------------------- lower thirds (more)
  {
    id: 'glass-pill',
    label: 'Glass pill',
    category: 'lower-thirds',
    sampleText: 'Sam Carter · Designer',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Manrope',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 3.2,
      background: '#ffffff29',
      typography: {
        shadow: SOFT_DROP,
        background: {
          radius: 0.6,
          paddingX: 0.7,
          paddingY: 0.3,
          blur: 0.35,
          borderColor: '#ffffff73',
          borderWidth: 1,
        },
      },
    }),
  },
  {
    id: 'news-bar',
    label: 'News bar',
    category: 'lower-thirds',
    sampleText: 'Breaking news',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'Oswald',
      fontWeight: 600,
      color: WHITE,
      fontSizePercent: 3.6,
      background: RED,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.04,
        background: { radius: 0, paddingX: 0.6, paddingY: 0.2 },
      },
    }),
  },
  {
    id: 'mono-tag',
    label: 'Mono tag',
    category: 'lower-thirds',
    sampleText: 'v2.4 — release notes',
    look: look({
      ...LOWER_THIRD,
      fontFamily: 'IBM Plex Mono',
      fontWeight: 400,
      color: PHOSPHOR,
      fontSizePercent: 3,
      background: '#0b0b0fcc',
      typography: { background: { radius: 0.1, paddingX: 0.6, paddingY: 0.3 } },
    }),
  },
  // --------------------------------------------------- callouts (more)
  {
    id: 'look-here',
    label: 'Look here',
    category: 'callouts',
    sampleText: 'Look here →',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 800,
      color: YELLOW,
      fontSizePercent: 5.5,
      typography: { outlineColor: INK, outlineWidth: 1.5, shadow: HARD_DROP },
    }),
  },
  {
    id: 'heads-up',
    label: 'Heads up',
    category: 'callouts',
    sampleText: 'Heads up',
    look: look({
      ...CENTRE,
      fontFamily: 'Space Grotesk',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 4.5,
      background: ORANGE,
      typography: { background: { radius: 0.2, paddingX: 0.55, paddingY: 0.22 } },
    }),
  },
  {
    id: 'price-tag',
    label: 'Price tag',
    category: 'callouts',
    sampleText: '$19 / month',
    look: look({
      ...CENTRE,
      fontFamily: 'Rubik',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 5,
      background: GREEN,
      typography: { background: { radius: 0.3, paddingX: 0.55, paddingY: 0.22 } },
    }),
  },
  // ----------------------------------------------------- social (more)
  {
    id: 'like-share',
    label: 'Like & share',
    category: 'social',
    sampleText: 'Like & share',
    look: look({
      ...CENTRE,
      yPercent: 80,
      fontFamily: 'Montserrat',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 4.5,
      background: BLUE,
      typography: { background: { radius: 0.3, paddingX: 0.7, paddingY: 0.3 } },
    }),
  },
  {
    id: 'link-in-bio',
    label: 'Link in bio',
    category: 'social',
    sampleText: 'Link in bio',
    look: look({
      ...CENTRE,
      yPercent: 82,
      fontFamily: 'Poppins',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 4.2,
      background: YELLOW,
      typography: { background: { radius: 0.6, paddingX: 0.7, paddingY: 0.28 } },
    }),
  },
  {
    id: 'watch-to-end',
    label: 'Watch to the end',
    category: 'social',
    sampleText: 'Watch to the end',
    look: look({
      ...UPPER,
      fontFamily: 'Inter',
      fontWeight: 900,
      color: WHITE,
      fontSizePercent: 5.5,
      typography: { textTransform: 'uppercase', outlineColor: INK, outlineWidth: 2 },
    }),
  },
  // ----------------------------------------------------- quotes (more)
  {
    id: 'testimonial',
    label: 'Testimonial',
    category: 'quotes',
    sampleText: '“It changed how we work.”',
    look: look({
      ...CENTRE,
      fontFamily: 'DM Serif Display',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 6,
      typography: { fontStyle: 'italic', lineHeight: 1.15, shadow: HALO },
    }),
  },
  {
    id: 'manifesto',
    label: 'Manifesto',
    category: 'quotes',
    sampleText: 'Make things people love',
    look: look({
      ...CENTRE,
      fontFamily: 'Syne',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 7,
      typography: { textTransform: 'uppercase', lineHeight: 1, shadow: SOFT_DROP },
    }),
  },
  // --------------------------------------------------------------- script
  {
    id: 'signature',
    label: 'Signature',
    category: 'script',
    sampleText: 'with love',
    look: look({
      ...CENTRE,
      fontFamily: 'Great Vibes',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 11,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'marker',
    label: 'Marker',
    category: 'script',
    sampleText: 'Day one',
    look: look({
      ...CENTRE,
      fontFamily: 'Permanent Marker',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 9,
      typography: { shadow: HARD_DROP },
    }),
  },
  {
    id: 'brush',
    label: 'Brush',
    category: 'script',
    sampleText: 'Weekend vibes',
    look: look({
      ...CENTRE,
      fontFamily: 'Caveat Brush',
      fontWeight: 400,
      color: YELLOW,
      fontSizePercent: 10,
      typography: { shadow: SOFT_DROP },
    }),
  },
  {
    id: 'sweet',
    label: 'Sweet',
    category: 'script',
    sampleText: 'So good',
    look: look({
      ...CENTRE,
      fontFamily: 'Pacifico',
      fontWeight: 400,
      color: PINK,
      fontSizePercent: 8,
      typography: { outlineColor: WHITE, outlineWidth: 1.5, shadow: SOFT_DROP },
    }),
  },
  {
    id: 'notebook',
    label: 'Notebook',
    category: 'script',
    sampleText: 'note to self',
    look: look({
      ...CENTRE,
      fontFamily: 'Patrick Hand',
      fontWeight: 400,
      color: INK,
      fontSizePercent: 5,
      background: OFF_WHITE,
      typography: { background: { radius: 0.08, paddingX: 0.6, paddingY: 0.3 } },
    }),
  },
  // ---------------------------------------------------------------- retro
  {
    id: 'arcade',
    label: 'Arcade',
    category: 'retro',
    sampleText: 'Level up',
    look: look({
      ...CENTRE,
      fontFamily: 'Press Start 2P',
      fontWeight: 400,
      color: LIME,
      fontSizePercent: 4,
      typography: { textTransform: 'uppercase', lineHeight: 1.5, shadow: HARD_DROP },
    }),
  },
  {
    id: 'pixel',
    label: 'Pixel',
    category: 'retro',
    sampleText: 'Loading…',
    look: look({
      ...CENTRE,
      fontFamily: 'VT323',
      fontWeight: 400,
      color: CYAN,
      fontSizePercent: 9,
      typography: { shadow: glow('#3de0ffb3') },
    }),
  },
  {
    id: 'seventies',
    label: 'Seventies',
    category: 'retro',
    sampleText: 'Groovy',
    look: look({
      ...CENTRE,
      fontFamily: 'Shrikhand',
      fontWeight: 400,
      color: ORANGE,
      fontSizePercent: 10,
      typography: { outlineColor: INK, outlineWidth: 2, shadow: HARD_DROP },
    }),
  },
  {
    id: 'slab',
    label: 'Slab',
    category: 'retro',
    sampleText: 'Est. 1985',
    look: look({
      ...CENTRE,
      fontFamily: 'Alfa Slab One',
      fontWeight: 400,
      color: GOLD,
      fontSizePercent: 8,
      typography: { outlineColor: INK, outlineWidth: 1.5, shadow: HARD_DROP },
    }),
  },
  {
    id: 'chrome',
    label: 'Chrome',
    category: 'retro',
    sampleText: 'Future',
    look: look({
      ...CENTRE,
      fontFamily: 'Orbitron',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 8,
      typography: { textTransform: 'uppercase', letterSpacing: 0.08, shadow: glow('#3de0ffcc') },
    }),
  },
  {
    id: 'bubble',
    label: 'Bubble',
    category: 'retro',
    sampleText: 'Yay!',
    look: look({
      ...CENTRE,
      fontFamily: 'Titan One',
      fontWeight: 400,
      color: PINK,
      fontSizePercent: 11,
      typography: { outlineColor: WHITE, outlineWidth: 2.5, shadow: HARD_DROP },
    }),
  },
];

/** Every text overlay template, in gallery order. */
export const TEXT_OVERLAY_STYLE_CATALOG: readonly TextOverlayStyle[] = HAND_MADE;

/** The template a plain "add text" (a timeline drop, the Heading button) uses. */
export const DEFAULT_TEXT_OVERLAY_STYLE_ID = 'heading';

const BY_ID: ReadonlyMap<string, TextOverlayStyle> = new Map(
  TEXT_OVERLAY_STYLE_CATALOG.map((template) => [template.id, template]),
);

/** Look up a text overlay template by id. */
export function getTextOverlayStyle(id: string): TextOverlayStyle | undefined {
  return BY_ID.get(id);
}

/** The params a style writes: its whole look, and the id it came from for provenance. */
export interface TextOverlayLookParams extends TextOverlayLook {
  readonly templateId: string;
}

/**
 * The params a text overlay style writes into the overlay's `text` effect: its whole look, and
 * the id it came from. The text and the animation stay the author's.
 *
 * One function for every host that applies a style — the Text panel and the AI's
 * `add_text_layer` (whose Python twin mirrors these keys in `ai_tools/text_overlay_styles.py`)
 * — so one style id is one patch whichever of them applied it.
 */
export function textOverlayLookParams(
  look: TextOverlayLook,
  templateId: string,
): TextOverlayLookParams {
  return {
    fontFamily: look.fontFamily,
    fontWeight: look.fontWeight,
    color: look.color,
    fontSizePercent: look.fontSizePercent,
    align: look.align,
    boxWidthPercent: look.boxWidthPercent,
    xPercent: look.xPercent,
    yPercent: look.yPercent,
    background: look.background,
    typography: look.typography,
    templateId,
  };
}
