/**
 * @framepilot/timeline-schema/title-templates — title (text overlay) typography and the title
 * template catalog.
 *
 * WHY titles take the caption typography. A caption carries the whole caption vocabulary
 * (outline, shadow, chip shape, case, tracking, see-through letters) while a title had a colour,
 * a family and a fixed black stroke, so a title could never match the captions beside it. A
 * title's `text` effect may now carry {@link TitleTypography} — the caption style's LINE-level
 * fields — and a title that does is drawn by the caption rasterizer itself
 * (`engine/python/framepilot_engine/render/text_overlay.py#title_caption_style`, the same call
 * the export and the desktop monitor make). The preview reads the same mapping,
 * {@link titleCaptionStyle}, through the caption CSS (`captionPreview.ts`).
 *
 * The title's own params stay authoritative for what they already said — family, weight,
 * colour, size, alignment, wrap width and whether there is a chip — so the Inspector, the
 * on-canvas editor and the AI's `add_text_layer` keep working unchanged.
 *
 * Left out on titles, by design: the frosted chip blur (a title has no backdrop pass), and
 * everything word-timed or animated (highlight, accent, entrances, loops) — a title animates
 * through its layer transitions.
 *
 * The catalog is PURE DATA, like the caption catalog: a template is a complete {@link TitleLook}
 * that the editor writes into the title's params when it is applied. Nothing resolves a template
 * id at render time, so revising a template never changes a title already placed.
 */
import { CaptionBackgroundSchema, CaptionStyleSchema, type CaptionStyle } from './index.js';
import { CAPTION_TEMPLATE_CATALOG, type CaptionTemplate } from './caption-templates.js';
import { z } from 'zod/v4';

/**
 * The caption-style fields a title's `typography` carries. Mirrors `TITLE_TYPOGRAPHY_FIELDS` in
 * `render/text_overlay.py`; the chip's shape rides in `background`.
 */
export const TITLE_TYPOGRAPHY_FIELDS = [
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
 * The chip's shape (radius, padding, rim). Its colour is the title's own `background` param —
 * the Inspector's on/off switch — and `blur` is excluded: only the caption compositor has a
 * backdrop pass.
 */
export const TitleChipShapeSchema = CaptionBackgroundSchema.omit({ color: true, blur: true });

/** A title's caption typography (see the module doc). */
export const TitleTypographySchema = CaptionStyleSchema.pick({
  fontStyle: true,
  textTransform: true,
  letterSpacing: true,
  lineHeight: true,
  textOpacity: true,
  outlineColor: true,
  outlineWidth: true,
  shadow: true,
}).extend({ background: TitleChipShapeSchema.optional() });

export type TitleChipShape = z.infer<typeof TitleChipShapeSchema>;
export type TitleTypography = z.infer<typeof TitleTypographySchema>;

/**
 * The typography a PLAIN title (one with no `typography`) is drawn with, in caption terms: the
 * engine's fixed black stroke of a twelfth of the font size (`render_text_overlay_image`), which
 * is 16/12 sixteenths, and its square box padded by two strokes. The Inspector shows a plain
 * title's typography as this and seeds the first edit with it, so converting a title to the
 * caption typography keeps the look it had.
 */
export const PLAIN_TITLE_TYPOGRAPHY: TitleTypography = {
  outlineColor: '#000000',
  outlineWidth: 16 / 12,
  background: { radius: 0, paddingX: 1 / 6, paddingY: 1 / 6 },
};

/** Horizontal alignment of a title's lines. */
export type TitleAlign = 'left' | 'center' | 'right';

/**
 * Everything a template decides about a title: the params it writes (the same keys as the web
 * editor's `TextOverlayParams`, minus the text and the animation, which stay the author's).
 */
export interface TitleLook {
  readonly fontFamily: string;
  readonly fontWeight: number;
  /** Letter colour, `#rrggbb[aa]` (the engine parses hex only). */
  readonly color: string;
  /** Glyph size as a percentage of the frame HEIGHT. */
  readonly fontSizePercent: number;
  readonly align: TitleAlign;
  /** Wrap width as a percentage of the frame width. */
  readonly boxWidthPercent: number;
  /** Box centre as a percentage of each axis, origin top-left. */
  readonly xPercent: number;
  readonly yPercent: number;
  /** Chip colour, or `null` for no chip. */
  readonly background: string | null;
  readonly typography: TitleTypography;
}

/** The inputs {@link titleCaptionStyle} reads: a title's params, as stored or as defaulted. */
export interface TitleStyleParams {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly color: string;
  readonly fontSizePercent: number;
  readonly align: TitleAlign;
  readonly boxWidthPercent: number;
  readonly background: string | null;
  readonly typography?: TitleTypography | undefined;
}

/**
 * A caption's base glyph height as a percentage of the frame height (the engine's
 * `_FONT_HEIGHT_FRACTION` = 1/22, the preview's `CAPTION_FONT_CQH`). A caption's size is this
 * times its `fontScale`, which is how a title's `fontSizePercent` becomes a caption scale.
 */
export const CAPTION_FONT_HEIGHT_PERCENT = 100 / 22;

const MIN_BOX_WIDTH_PERCENT = 5;

/**
 * The caption style a title with `typography` is drawn in (the web twin of the engine's
 * `title_caption_style`); `undefined` for a plain title, which keeps its own drawing.
 *
 * Nothing positional is included: a title is placed by its `xPercent`/`yPercent` and transform.
 */
export function titleCaptionStyle(params: TitleStyleParams): CaptionStyle | undefined {
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
 * not validate (the engine then draws the plain title too, so the preview agrees with it).
 */
export function parseTitleTypography(value: unknown): TitleTypography | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = TitleTypographySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// --------------------------------------------------------------------------- catalog

/** Gallery grouping in the Text panel. `caption-looks` holds every caption template as a title. */
export type TitleTemplateCategory =
  'basic' | 'titles' | 'lower-thirds' | 'callouts' | 'social' | 'quotes' | 'caption-looks';

export const TITLE_TEMPLATE_CATEGORIES: readonly {
  readonly id: TitleTemplateCategory;
  readonly label: string;
}[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'titles', label: 'Titles' },
  { id: 'lower-thirds', label: 'Lower thirds' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'social', label: 'Social' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'caption-looks', label: 'Caption looks' },
];

export interface TitleTemplate {
  /** Stable id, stored on the title as `templateId` for provenance. Never rename. */
  readonly id: string;
  readonly label: string;
  readonly category: TitleTemplateCategory;
  /** The text a new title from this template starts with, and its tile shows. */
  readonly sampleText: string;
  readonly look: TitleLook;
}

// Palette and separation layers. Every look keeps a separation layer (outline, shadow or chip):
// a title is drawn over footage nobody chose for it, and plain white text vanishes on a sky.
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

const SOFT_DROP = { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 } as const;
const HALO = { color: '#000000d9', blur: 0.26, offsetX: 0, offsetY: 0.02 } as const;
const HARD_DROP = { color: '#000000', blur: 0, offsetX: 0.05, offsetY: 0.07 } as const;

/** Centre-frame placement, the default for a title. */
const CENTRE = { align: 'center', boxWidthPercent: 80, xPercent: 50, yPercent: 50 } as const;
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
  fields: Omit<TitleLook, 'background' | 'typography'> & Partial<TitleLook>,
): TitleLook {
  return { background: null, typography: {}, ...fields };
}

const HAND_MADE: readonly TitleTemplate[] = [
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
  // ----------------------------------------------------------------- titles
  {
    id: 'impact-title',
    label: 'Big title',
    category: 'titles',
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
    category: 'titles',
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
    category: 'titles',
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
    category: 'titles',
    sampleText: 'Night mode',
    look: look({
      ...CENTRE,
      fontFamily: 'Righteous',
      fontWeight: 400,
      color: CYAN,
      fontSizePercent: 9,
      typography: { shadow: { color: '#3de0ffcc', blur: 0.55, offsetX: 0, offsetY: 0 } },
    }),
  },
  {
    id: 'retro-pop',
    label: 'Retro pop',
    category: 'titles',
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
    category: 'titles',
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
    category: 'titles',
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
    category: 'quotes',
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
  },
];

/** A caption look drawn as a title is this much larger than the caption (a title reads as a title). */
const CAPTION_LOOK_TITLE_SCALE = 1.5;
const CAPTION_LOOK_MIN_PERCENT = 4;
const CAPTION_LOOK_MAX_PERCENT = 14;
/** Where a caption's vertical anchor puts a title (centre, % of the frame height). */
const CAPTION_ANCHOR_Y: Readonly<Record<string, number>> = { top: 20, middle: 50, bottom: 76 };
/** A colour whose alpha is zero draws nothing: the caption catalog's "no chip". */
const TRANSPARENT = /^#[0-9a-f]{6}00$/i;

/** Prefix of the id a caption look gets as a title template. */
export const CAPTION_LOOK_ID_PREFIX = 'caption-';

/**
 * A caption template drawn as a title: the same family, weight, colours and every line-level
 * field, at a title's size. Its highlight, accent and animation are left out (they are
 * word-timed or animated), and so is a frosted chip's blur — the chip keeps its tint and rim.
 */
export function titleLookFromCaptionTemplate(template: CaptionTemplate): TitleLook {
  const style = template.style;
  const typography: TitleTypography = {};
  for (const field of TITLE_TYPOGRAPHY_FIELDS) {
    const value = style[field];
    if (value !== undefined) Object.assign(typography, { [field]: value });
  }
  const chip = style.background;
  const hasChip = chip !== undefined && !TRANSPARENT.test(chip.color);
  if (hasChip) {
    const { color: _color, blur: _blur, ...shape } = chip;
    typography.background = shape;
  }
  const size = CAPTION_FONT_HEIGHT_PERCENT * (style.fontScale ?? 1) * CAPTION_LOOK_TITLE_SCALE;
  return {
    fontFamily: style.fontFamily ?? 'Inter',
    fontWeight: style.fontWeight ?? 400,
    color: style.textColor ?? '#ffffff',
    fontSizePercent:
      Math.round(
        Math.min(CAPTION_LOOK_MAX_PERCENT, Math.max(CAPTION_LOOK_MIN_PERCENT, size)) * 10,
      ) / 10,
    align: style.textAlign ?? 'center',
    boxWidthPercent: Math.min(90, style.maxWidthPercent ?? 84),
    xPercent: 50,
    yPercent: CAPTION_ANCHOR_Y[style.position ?? 'middle'] ?? 50,
    background: hasChip ? chip.color : null,
    typography,
  };
}

const CAPTION_LOOKS: readonly TitleTemplate[] = CAPTION_TEMPLATE_CATALOG.map((template) => ({
  id: `${CAPTION_LOOK_ID_PREFIX}${template.id}`,
  label: template.label,
  category: 'caption-looks' as const,
  sampleText: template.label,
  look: titleLookFromCaptionTemplate(template),
}));

/** Every title template: the hand-made looks, then every caption template as a title. */
export const TITLE_TEMPLATE_CATALOG: readonly TitleTemplate[] = [...HAND_MADE, ...CAPTION_LOOKS];

/** The template a plain "add text" (a timeline drop, the Heading button) uses. */
export const DEFAULT_TITLE_TEMPLATE_ID = 'heading';

const BY_ID: ReadonlyMap<string, TitleTemplate> = new Map(
  TITLE_TEMPLATE_CATALOG.map((template) => [template.id, template]),
);

/** Look up a title template by id. */
export function getTitleTemplate(id: string): TitleTemplate | undefined {
  return BY_ID.get(id);
}
