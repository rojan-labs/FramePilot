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
import {
  CaptionBackgroundSchema,
  CaptionShadowSchema,
  CaptionStyleSchema,
  type CaptionStyle,
} from './index.js';
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

/** Most lines a lockup styles; a longer text draws its remaining lines in the overlay's own look. */
export const MAX_TEXT_OVERLAY_LINES = 6;

/**
 * One line of a LOCKUP: a text overlay whose lines are set in different faces, sizes and colours
 * (a tracked kicker over a heavy headline, a script word over caps, a name over a role). A line
 * is one `\n`-separated paragraph of the overlay's text; `typography.lines[i]` styles paragraph
 * `i`, and a paragraph with no entry keeps the overlay's own look.
 *
 * Every field is an OVERRIDE of the overlay's own look, so a lockup still answers to the
 * Inspector: a new size scales every line, a new colour recolours the lines that name none.
 *
 * - `scale` multiplies the overlay's `fontSizePercent` (a kicker at 0.3, a headline at 1).
 * - `color` is the line's letter colour; `background` its chip colour (`null`: no chip on this
 *   line even when the overlay has one); `chip` its chip shape.
 * - `spaceBefore` moves the line down (+) or up (−) from where it would stack, in ems of the
 *   OVERLAY's size. Lines stack box on box, and a box keeps the caption renderer's padding round
 *   its letters, so a tight lockup names a negative space here.
 */
export const TextOverlayLineSchema = CaptionStyleSchema.pick({
  fontFamily: true,
  fontWeight: true,
  fontStyle: true,
  textTransform: true,
  letterSpacing: true,
  lineHeight: true,
  textOpacity: true,
  outlineColor: true,
  outlineWidth: true,
}).extend({
  /** `null` draws the line with no shadow even when the overlay has one (a chip line). */
  shadow: CaptionShadowSchema.nullable().optional(),
  scale: z.number().positive().max(8).optional(),
  color: z.string().min(1).optional(),
  background: z.string().min(1).nullable().optional(),
  chip: TextOverlayChipSchema.optional(),
  spaceBefore: z.number().min(-3).max(3).optional(),
});

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
}).extend({
  background: TextOverlayChipSchema.optional(),
  lines: z.array(TextOverlayLineSchema).max(MAX_TEXT_OVERLAY_LINES).optional(),
});

export type TextOverlayChip = z.infer<typeof TextOverlayChipSchema>;
export type TextOverlayLine = z.infer<typeof TextOverlayLineSchema>;
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
  const { background: chip, lines: _lines, ...line } = typography;
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

/** One paragraph of a lockup, resolved: its words, its caption style and where it stacks. */
export interface TextOverlayLineLayout {
  /** The paragraph's index in the overlay's text (its `typography.lines` slot). */
  readonly index: number;
  readonly text: string;
  readonly style: CaptionStyle;
  /** The line's size relative to the overlay's `fontSizePercent`. */
  readonly scale: number;
  /** Extra space above the line, in ems of the OVERLAY's size (see {@link TextOverlayLineSchema}). */
  readonly spaceBefore: number;
}

/** The caption style of one lockup line: the overlay's style with the line's overrides. */
function lockupLineStyle(
  base: CaptionStyle,
  params: TextOverlayStyleParams,
  line: TextOverlayLine,
): CaptionStyle {
  const { scale = 1, color, background, chip, spaceBefore: _space, shadow, ...typography } = line;
  const style: CaptionStyle = { ...base, ...typography, fontScale: (base.fontScale ?? 1) * scale };
  if (shadow === null) delete style.shadow;
  else if (shadow !== undefined) style.shadow = shadow;
  if (line.fontWeight !== undefined) {
    style.fontWeight = Math.round(Math.min(900, Math.max(100, line.fontWeight)));
  }
  if (color !== undefined) style.textColor = color;
  const chipColor = background === undefined ? base.background?.color : background;
  if (chipColor === null || chipColor === undefined || chipColor.trim() === '') {
    delete style.background;
  } else {
    style.background = { ...params.typography?.background, ...chip, color: chipColor };
  }
  return style;
}

/**
 * A lockup's lines — the overlay's text split at its line breaks, each with the caption style it
 * is drawn in — or `undefined` for a text overlay that is not a lockup (no `typography.lines`),
 * which is drawn as one block. Empty paragraphs are left out: they draw nothing and take no
 * room, in the export as in the preview.
 *
 * The engine's twin is `render/text_overlay.py#text_overlay_line_layouts`; both stack the lines
 * box on box, aligned by the overlay's `align`, `spaceBefore` apart.
 */
export function textOverlayLineLayouts(
  params: TextOverlayStyleParams & { readonly text: string },
): readonly TextOverlayLineLayout[] | undefined {
  const lines = params.typography?.lines;
  if (lines === undefined || lines.length === 0) return undefined;
  const base = textOverlayCaptionStyle(params);
  if (base === undefined) return undefined;
  return params.text.split('\n').flatMap((text, index) => {
    if (text.trim() === '') return [];
    const line = lines[index] ?? {};
    return [
      {
        index,
        text,
        style: lockupLineStyle(base, params, line),
        scale: line.scale ?? 1,
        spaceBefore: line.spaceBefore ?? 0,
      },
    ];
  });
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
  | 'combos'
  | 'basic'
  | 'headlines'
  | 'lower-thirds'
  | 'callouts'
  | 'social'
  | 'quotes'
  | 'script'
  | 'retro';

export const TEXT_OVERLAY_STYLE_CATEGORIES: readonly {
  readonly id: TextOverlayStyleCategory;
  readonly label: string;
}[] = [
  { id: 'combos', label: 'Combos' },
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
/** A secondary line's white, stepped back so the headline leads (research: fg at ~75 %). */
const MUTED = '#ffffffbf';
const MUTED_WARM = '#f4f1eabf';
const PAPER = '#f2ecdf';
const HIGHLIGHTER = '#ffd200';
const CHAMPAGNE = '#f3dfb4';

const SOFT_DROP = { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 } as const;
const HALO = { color: '#000000d9', blur: 0.26, offsetX: 0, offsetY: 0.02 } as const;
const HARD_DROP = { color: '#000000', blur: 0, offsetX: 0.05, offsetY: 0.07 } as const;
/** The cinematic register: a soft lift off the picture, never a visible drop. */
const LIFT = { color: '#00000080', blur: 0.3, offsetX: 0, offsetY: 0.03 } as const;
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
/**
 * A two-line lower third (name over role). The box is centred on x/y and hugs its lines, so a
 * lockup sits nearer the left edge than a one-line tag, toward where lower thirds start
 * (research: text from ~7 % of the width), and stays above the caption band. Its wrap box
 * still fits in the frame (x ± box / 2), the rule the assistant's fit keeps.
 */
const LOWER_THIRD_LOCKUP = {
  align: 'left',
  boxWidthPercent: 60,
  xPercent: 30,
  yPercent: 78,
} as const;

function look(
  fields: Omit<TextOverlayLook, 'background' | 'typography'> & Partial<TextOverlayLook>,
): TextOverlayLook {
  return { background: null, typography: {}, ...fields };
}

const HAND_MADE: readonly TextOverlayStyle[] = [
  // ------------------------------------------------------------------ basic
  // ----------------------------------------------------------------- combos
  // Multi-font LOCKUPS (typography.lines): one text overlay whose lines are set in different
  // faces, sizes and colours, the way title designers build a title. Researched 2026-09-30
  // (docs/guides/text-overlays.md "Lockups"): two families, a third only as a script or hand
  // accent; secondary lines 15–40 % of the headline; tracked caps for kickers (+0.2–0.4 em),
  // tight display tracking; lines close enough to read as one group. The base look is the
  // HEADLINE, so the Inspector's font, size and colour act on it; the other lines override.
  {
    id: 'kicker-headline',
    label: 'Kicker + headline',
    category: 'combos',
    sampleText: 'EPISODE 04\nTHE LONG WAY HOME',
    look: look({
      ...CENTRE,
      fontFamily: 'Bebas Neue',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 13,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.01,
        lineHeight: 0.9,
        shadow: SOFT_DROP,
        lines: [
          {
            fontFamily: 'Montserrat',
            fontWeight: 600,
            scale: 0.26,
            letterSpacing: 0.3,
            lineHeight: 1.2,
            color: YELLOW,
          },
          { spaceBefore: -0.3 },
        ],
      },
    }),
  },
  {
    id: 'doc-title',
    label: 'Documentary',
    category: 'combos',
    sampleText: 'The Last Glacier\nA FILM BY MAYA ROSS',
    look: look({
      ...CENTRE,
      fontFamily: 'Instrument Serif',
      fontWeight: 400,
      color: OFF_WHITE,
      fontSizePercent: 11,
      typography: {
        letterSpacing: -0.015,
        lineHeight: 1.0,
        shadow: LIFT,
        lines: [
          {},
          {
            fontFamily: 'Inter',
            fontWeight: 500,
            scale: 0.24,
            textTransform: 'uppercase',
            letterSpacing: 0.32,
            lineHeight: 1.2,
            color: MUTED_WARM,
            spaceBefore: 0.12,
          },
        ],
      },
    }),
  },
  {
    id: 'script-over-caps',
    label: 'Script + caps',
    category: 'combos',
    sampleText: 'welcome to\nBALI',
    look: look({
      ...CENTRE,
      fontFamily: 'Anton',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 17,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.02,
        lineHeight: 0.9,
        shadow: SOFT_DROP,
        lines: [
          {
            fontFamily: 'Great Vibes',
            fontWeight: 400,
            scale: 0.62,
            textTransform: 'none',
            letterSpacing: 0,
            color: YELLOW,
            shadow: LIFT,
          },
          { spaceBefore: -1.0 },
        ],
      },
    }),
  },
  {
    id: 'fashion',
    label: 'Fashion',
    category: 'combos',
    sampleText: 'ISSUE NO. 12\nThe New Minimal',
    look: look({
      ...CENTRE,
      fontFamily: 'Bodoni Moda',
      fontWeight: 500,
      color: WHITE,
      fontSizePercent: 11,
      typography: {
        fontStyle: 'italic',
        letterSpacing: -0.015,
        lineHeight: 1.0,
        shadow: LIFT,
        lines: [
          {
            fontFamily: 'Raleway',
            fontWeight: 500,
            fontStyle: 'normal',
            scale: 0.24,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            lineHeight: 1.2,
          },
          { spaceBefore: -0.2 },
        ],
      },
    }),
  },
  {
    id: 'minimal-luxe',
    label: 'Serif + wide',
    category: 'combos',
    sampleText: 'Golden hour\nLISBON — PORTUGAL',
    look: look({
      ...CENTRE,
      fontFamily: 'Instrument Serif',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 12,
      typography: {
        letterSpacing: -0.02,
        lineHeight: 1.0,
        shadow: LIFT,
        lines: [
          {},
          {
            fontFamily: 'Unbounded',
            fontWeight: 500,
            scale: 0.21,
            textTransform: 'uppercase',
            letterSpacing: 0.35,
            lineHeight: 1.2,
            spaceBefore: 0.1,
          },
        ],
      },
    }),
  },
  {
    id: 'wedding',
    label: 'Wedding',
    category: 'combos',
    sampleText: 'THE WEDDING OF\nAnna & Luca\n12 · 09 · 2026',
    look: look({
      ...CENTRE,
      fontFamily: 'Great Vibes',
      fontWeight: 400,
      color: CHAMPAGNE,
      fontSizePercent: 13,
      typography: {
        lineHeight: 1.0,
        shadow: LIFT,
        lines: [
          {
            fontFamily: 'Cinzel',
            fontWeight: 400,
            scale: 0.2,
            textTransform: 'uppercase',
            letterSpacing: 0.35,
            lineHeight: 1.2,
            color: WHITE,
          },
          { spaceBefore: -0.2 },
          {
            fontFamily: 'Cinzel',
            fontWeight: 400,
            scale: 0.19,
            letterSpacing: 0.3,
            lineHeight: 1.2,
            color: MUTED,
            spaceBefore: 0.1,
          },
        ],
      },
    }),
  },
  {
    id: 'chapter',
    label: 'Chapter title',
    category: 'combos',
    sampleText: 'CHAPTER 03\nWhere it all began',
    look: look({
      ...CENTRE,
      fontFamily: 'Fraunces',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 9.5,
      typography: {
        letterSpacing: -0.01,
        lineHeight: 1.05,
        shadow: LIFT,
        lines: [
          {
            fontFamily: 'Space Mono',
            fontWeight: 400,
            scale: 0.3,
            textTransform: 'uppercase',
            letterSpacing: 0.25,
            lineHeight: 1.2,
            color: YELLOW,
          },
          { spaceBefore: -0.1 },
        ],
      },
    }),
  },
  {
    id: 'creator-title',
    label: 'Creator',
    category: 'combos',
    sampleText: 'LESSON 1\nStart before you’re ready\n(seriously)',
    look: look({
      ...CENTRE,
      fontFamily: 'Inter',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 7.5,
      typography: {
        letterSpacing: -0.02,
        lineHeight: 1.05,
        shadow: SOFT_DROP,
        lines: [
          {
            fontWeight: 600,
            scale: 0.36,
            textTransform: 'uppercase',
            letterSpacing: 0.2,
            lineHeight: 1.2,
            color: YELLOW,
          },
          { spaceBefore: -0.2 },
          {
            fontFamily: 'Caveat',
            fontWeight: 600,
            scale: 0.7,
            letterSpacing: 0,
            color: YELLOW,
            spaceBefore: -0.2,
          },
        ],
      },
    }),
  },
  {
    id: 'explainer',
    label: 'Explainer',
    category: 'combos',
    sampleText: 'THE STRAIT OF HORMUZ\n20% of the world’s oil',
    look: look({
      ...CENTRE,
      fontFamily: 'Archivo Black',
      fontWeight: 400,
      color: '#161513',
      fontSizePercent: 6.5,
      background: HIGHLIGHTER,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: -0.01,
        lineHeight: 0.98,
        background: { radius: 0.04, paddingX: 0.3, paddingY: 0.12 },
        lines: [
          {},
          {
            fontFamily: 'Caveat',
            fontWeight: 700,
            scale: 0.9,
            textTransform: 'none',
            letterSpacing: 0,
            color: PAPER,
            background: null,
            shadow: SOFT_DROP,
            spaceBefore: -0.1,
          },
        ],
      },
    }),
  },
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
    sampleText: 'The Long Road\nA JOURNEY NORTH',
    look: look({
      ...CENTRE,
      fontFamily: 'Cinzel',
      fontWeight: 500,
      color: OFF_WHITE,
      fontSizePercent: 6.5,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.28,
        shadow: LIFT,
        lines: [
          {},
          {
            fontFamily: 'Raleway',
            fontWeight: 400,
            scale: 0.4,
            letterSpacing: 0.5,
            color: MUTED_WARM,
            spaceBefore: 0.35,
          },
        ],
      },
    }),
  },
  {
    id: 'sport',
    label: 'Sport',
    category: 'headlines',
    sampleText: 'MATCH DAY\nFINAL WHISTLE',
    look: look({
      ...CENTRE,
      fontFamily: 'Big Shoulders',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 14,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.01,
        lineHeight: 0.9,
        shadow: SOFT_DROP,
        background: { radius: 0, paddingX: 0.45, paddingY: 0.15 },
        lines: [
          {
            fontFamily: 'Barlow Condensed',
            fontWeight: 600,
            scale: 0.28,
            letterSpacing: 0.14,
            lineHeight: 1.1,
            background: RED,
            shadow: null,
          },
          { spaceBefore: -0.05 },
        ],
      },
    }),
  },
  {
    id: 'shout',
    label: 'Shout',
    category: 'headlines',
    sampleText: 'DAY 7\nI SURVIVED',
    look: look({
      ...CENTRE,
      fontFamily: 'Luckiest Guy',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 13,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.02,
        lineHeight: 0.95,
        outlineColor: INK,
        outlineWidth: 1.6,
        shadow: HARD_DROP,
        lines: [{ scale: 0.45, color: YELLOW }, { spaceBefore: -0.25 }],
      },
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
    sampleText: 'Slow mornings\nTHE SPRING EDIT',
    look: look({
      ...CENTRE,
      fontFamily: 'Instrument Serif',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 10,
      typography: {
        fontStyle: 'italic',
        lineHeight: 1.05,
        shadow: HALO,
        lines: [
          {},
          {
            fontFamily: 'Montserrat',
            fontWeight: 500,
            fontStyle: 'normal',
            scale: 0.26,
            textTransform: 'uppercase',
            letterSpacing: 0.35,
            lineHeight: 1.2,
            spaceBefore: -0.1,
          },
        ],
      },
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
    sampleText: 'Alex Rivera\nPRODUCT LEAD',
    look: look({
      ...LOWER_THIRD_LOCKUP,
      fontFamily: 'Inter',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 4.2,
      background: '#0b0b0fcc',
      typography: {
        letterSpacing: -0.005,
        background: { radius: 0.1, paddingX: 0.55, paddingY: 0.28 },
        lines: [
          {},
          { fontWeight: 500, scale: 0.6, letterSpacing: 0.12, color: MUTED, spaceBefore: -0.02 },
        ],
      },
    }),
  },
  {
    id: 'accent-bar',
    label: 'Accent bar',
    category: 'lower-thirds',
    sampleText: 'ALEX RIVERA\nProduct lead, Northwind',
    look: look({
      ...LOWER_THIRD_LOCKUP,
      fontFamily: 'Montserrat',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 3.6,
      background: BLUE,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.06,
        background: { radius: 0, paddingX: 0.6, paddingY: 0.3 },
        lines: [
          {},
          {
            fontWeight: 500,
            scale: 0.72,
            textTransform: 'none',
            letterSpacing: 0,
            color: INK,
            background: WHITE,
          },
        ],
      },
    }),
  },
  {
    id: 'minimal-lower',
    label: 'Location',
    category: 'lower-thirds',
    sampleText: 'LISBON, PORTUGAL\n04 MAY 2026 — 06:12',
    look: look({
      ...LOWER_THIRD_LOCKUP,
      fontFamily: 'IBM Plex Mono',
      fontWeight: 500,
      color: WHITE,
      fontSizePercent: 3.4,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.06,
        shadow: SOFT_DROP,
        lines: [{}, { fontWeight: 400, scale: 0.8, color: MUTED, spaceBefore: -0.35 }],
      },
    }),
  },
  {
    id: 'smoked-lower',
    label: 'Smoked',
    category: 'lower-thirds',
    sampleText: 'Jordan Lee\nFounder, Northwind',
    look: look({
      ...LOWER_THIRD_LOCKUP,
      fontFamily: 'Plus Jakarta Sans',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 3.8,
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
        lines: [{}, { fontWeight: 500, scale: 0.68, color: MUTED, spaceBefore: 0.08 }],
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
    sampleText: '3x\nFASTER EXPORTS',
    look: look({
      ...CENTRE,
      fontFamily: 'Bebas Neue',
      fontWeight: 400,
      color: YELLOW,
      fontSizePercent: 22,
      typography: {
        lineHeight: 0.9,
        shadow: SOFT_DROP,
        lines: [
          {},
          {
            fontFamily: 'Inter',
            fontWeight: 600,
            scale: 0.13,
            textTransform: 'uppercase',
            letterSpacing: 0.16,
            lineHeight: 1.2,
            color: WHITE,
            spaceBefore: -0.55,
          },
        ],
      },
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
    id: 'hook-chips',
    label: 'Hook chips',
    category: 'social',
    sampleText: 'Nobody tells you\nthis about Lisbon',
    look: look({
      ...UPPER,
      fontFamily: 'Montserrat',
      fontWeight: 800,
      color: INK,
      fontSizePercent: 5.5,
      background: WHITE,
      typography: {
        letterSpacing: -0.01,
        background: { radius: 0.25, paddingX: 0.4, paddingY: 0.18 },
        lines: [{}, { background: YELLOW, spaceBefore: 0.06 }],
      },
    }),
  },
  {
    id: 'end-card',
    label: 'End card',
    category: 'social',
    sampleText: 'thanks for watching\n@yourchannel\nSUBSCRIBE',
    look: look({
      ...CENTRE,
      fontFamily: 'Montserrat',
      fontWeight: 800,
      color: WHITE,
      fontSizePercent: 7,
      typography: {
        letterSpacing: -0.01,
        shadow: SOFT_DROP,
        background: { radius: 0.6, paddingX: 0.9, paddingY: 0.35 },
        lines: [
          {
            fontFamily: 'Caveat',
            fontWeight: 600,
            scale: 0.62,
            letterSpacing: 0,
            color: YELLOW,
          },
          { spaceBefore: -0.35 },
          {
            fontFamily: 'Inter',
            fontWeight: 700,
            scale: 0.36,
            textTransform: 'uppercase',
            letterSpacing: 0.2,
            color: INK,
            background: YELLOW,
            shadow: null,
            spaceBefore: 0.2,
          },
        ],
      },
    }),
  },
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
    sampleText: 'LIVE\nMarkets rally after rate cut',
    look: look({
      ...LOWER_THIRD_LOCKUP,
      fontFamily: 'Barlow',
      fontWeight: 700,
      color: INK,
      fontSizePercent: 4.2,
      background: WHITE,
      typography: {
        background: { radius: 0, paddingX: 0.45, paddingY: 0.22 },
        lines: [
          {
            fontFamily: 'Barlow Condensed',
            fontWeight: 700,
            scale: 0.62,
            textTransform: 'uppercase',
            letterSpacing: 0.08,
            color: WHITE,
            background: RED,
          },
          {},
        ],
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
    sampleText: '“It changed how we work.”\n— SAM CARTER, NORTHWIND',
    look: look({
      ...CENTRE,
      fontFamily: 'DM Serif Display',
      fontWeight: 400,
      color: WHITE,
      fontSizePercent: 6,
      typography: {
        fontStyle: 'italic',
        lineHeight: 1.15,
        shadow: HALO,
        lines: [
          {},
          {
            fontFamily: 'Inter',
            fontWeight: 600,
            fontStyle: 'normal',
            scale: 0.4,
            letterSpacing: 0.15,
            lineHeight: 1.2,
            color: MUTED,
            spaceBefore: 0.1,
          },
        ],
      },
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
    id: 'vlog-script',
    label: 'Vlog',
    category: 'script',
    sampleText: 'summer\nROAD TRIP',
    look: look({
      ...CENTRE,
      fontFamily: 'Poppins',
      fontWeight: 700,
      color: WHITE,
      fontSizePercent: 11,
      typography: {
        textTransform: 'uppercase',
        letterSpacing: 0.02,
        lineHeight: 0.95,
        shadow: SOFT_DROP,
        lines: [
          {
            fontFamily: 'Yellowtail',
            fontWeight: 400,
            scale: 0.85,
            textTransform: 'none',
            letterSpacing: 0,
            color: PINK,
          },
          { spaceBefore: -0.8 },
        ],
      },
    }),
  },
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
