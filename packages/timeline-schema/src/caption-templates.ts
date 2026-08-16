/**
 * @framepilot/timeline-schema/caption-templates — the canonical caption
 * template catalog (schema v10, ADR 0069).
 *
 * Every template is PURE DATA: a complete {@link CaptionStyle} built from the
 * closed enum vocabularies (`display` × emphasis × entrance × accent) that the
 * renderers interpret generically. Neither the Python engine nor the web
 * preview may ever branch on a template id — that is the extensibility
 * contract that makes "add template #46" a one-object change to this file.
 *
 * Cross-language parity: `scripts/generate-json-schema.mjs` exports this
 * catalog to `schema/caption-templates.json` and copies it into the Python
 * engine (`framepilot_engine/render/caption_templates.json`); drift is guarded
 * on both sides (see `caption-templates.test.ts` and the engine's
 * `test_caption_templates.py`).
 *
 * WHY hex-only colors: the engine's Pillow rasterizer parses `#rrggbb[aa]`
 * (see `render/captions.py#_hex_to_rgba`); CSS color functions would silently
 * fall back to white there, so the catalog restricts itself to hex.
 */
import { CaptionStyleSchema, type CaptionStyle } from './index.js';

/** Gallery grouping, mirroring the reference template-gallery tabs. */
export type CaptionTemplateCategory =
  | 'one-word'
  | 'phrase'
  | 'karaoke'
  | 'build'
  | 'boxed'
  | 'editorial'
  | 'aesthetic'
  | 'cinematic';

export interface CaptionTemplate {
  /** Stable id persisted in `captionStyle.templateId`. Never rename. */
  readonly id: string;
  /** Display name shown in the gallery. */
  readonly label: string;
  readonly category: CaptionTemplateCategory;
  /**
   * How many transcript words each generated caption clip should hold —
   * `generateCaptionsPatch` and the AI `transcript_cues` leaf use this as the
   * grouping size (1 for the one-word family).
   */
  readonly suggestedWordsPerLine: number;
  /**
   * The complete look. `templateId` is deliberately omitted — it is stamped
   * onto the clip's style at apply time, and resolution would be circular.
   */
  readonly style: CaptionStyle;
}

// Shared palette (approximated from the reference gallery's dark-canvas look).
const WHITE = '#ffffff';
const OFF_WHITE = '#e8e8ee';
const YELLOW = '#ffd60a';
const GOLD = '#e6b800';
const RED = '#e63946';
const GREEN = '#a8e05f';
const ORANGE = '#ff6b1a';
const INK = '#111111';
const CHIP_DARK = '#000000b3'; // rgba(0,0,0,0.7)

const SANS = 'Inter';
const HEAVY = 'Archivo Black';
const CONDENSED = 'Oswald';
const SERIF = 'DM Serif Display';
const MONO = 'Space Mono';
const SCRIPT = 'Caveat';
const ROUNDED = 'Nunito';
const MODERN = 'Montserrat';
const CREATOR = 'Poppins';
const HUMANIST = 'Open Sans';
const NEUTRAL = 'Roboto';
const WARM = 'Lato';
const ELEGANT = 'Raleway';
const FRIENDLY = 'Figtree';
const POLISHED = 'Manrope';
const CLASSIC = 'Playfair Display';
const READABLE_SERIF = 'Merriweather';
const POSTER = 'Anton';
const TALL = 'Bebas Neue';
const COMIC = 'Bangers';
const BRUSH = 'Pacifico';
const MARKER = 'Shadows Into Light';

/**
 * The built-in caption template catalog. Order within each category is the
 * gallery display order. 45 templates — the full reference gallery.
 */
export const CAPTION_TEMPLATE_CATALOG: readonly CaptionTemplate[] = [
  // -------------------------------------------------------------- one-word
  {
    id: 'punchline',
    label: 'Punchline',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: POSTER,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.5,
      textColor: WHITE,
      animation: { in: { type: 'zoom', duration: 0.12 } },
    },
  },
  {
    id: 'beast',
    label: 'Beast',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: COMIC,
      fontWeight: 700,
      textTransform: 'uppercase',
      fontScale: 1.7,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: 2,
      animation: { in: { type: 'bounce', duration: 0.18 } },
    },
  },
  {
    id: 'impact',
    label: 'Impact',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: HEAVY,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.5,
      textColor: YELLOW,
      animation: { in: { type: 'zoom', duration: 0.1 } },
    },
  },
  {
    id: 'stamp',
    label: 'Stamp',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: TALL,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.3,
      textColor: WHITE,
      background: { color: RED, radius: 0.2, paddingX: 0.4, paddingY: 0.25 },
      animation: { in: { type: 'zoom', duration: 0.1 } },
    },
  },
  // ---------------------------------------------------------------- phrase
  {
    id: 'trio',
    label: 'Trio',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: CREATOR,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      animation: { in: { type: 'fade', duration: 0.12 } },
    },
  },
  {
    id: 'duo',
    label: 'Duo',
    category: 'phrase',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: MODERN,
      fontWeight: 800,
      textTransform: 'uppercase',
      fontScale: 1.2,
      textColor: WHITE,
      animation: { in: { type: 'fade', duration: 0.1 } },
    },
  },
  {
    id: 'phrase-pop',
    label: 'Phrase Pop',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: FRIENDLY,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      highlight: { enabled: true, color: YELLOW, animation: 'pop', scale: 1.15 },
    },
  },
  {
    id: 'duo-gold',
    label: 'Duo Gold',
    category: 'phrase',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: ELEGANT,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
    },
  },
  {
    id: 'phrase-box',
    label: 'Phrase Box',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: POLISHED,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      highlight: { enabled: true, color: WHITE, animation: 'background', background: RED },
    },
  },
  {
    id: 'phrase-marker',
    label: 'Phrase Marker',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: MARKER,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      highlight: { enabled: true, color: INK, animation: 'background', background: YELLOW },
    },
  },
  // --------------------------------------------------------------- karaoke
  {
    id: 'karaoke',
    label: 'Karaoke',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: NEUTRAL,
      fontWeight: 700,
      textColor: WHITE,
      highlight: { enabled: true, color: RED, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: HUMANIST,
      fontWeight: 700,
      textColor: WHITE,
      shadow: { color: '#000000cc', blur: 0.12, offsetX: 0, offsetY: 0.06 },
      highlight: { enabled: true, color: YELLOW, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'outline',
    label: 'Outline',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: WARM,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: 2,
      highlight: { enabled: true, color: RED, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'glow',
    label: 'Glow',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      shadow: { color: GREEN, blur: 0.35, offsetX: 0, offsetY: 0 },
      highlight: { enabled: true, color: GREEN, animation: 'glow' },
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 500,
      textColor: WHITE,
      highlight: { enabled: true, color: WHITE, animation: 'karaoke-fill' },
    },
  },
  // ----------------------------------------------------------------- build
  {
    id: 'hormozi',
    label: 'Hormozi',
    category: 'build',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: HEAVY,
      fontWeight: 900,
      textTransform: 'uppercase',
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: 2,
      highlight: { enabled: true, color: YELLOW, animation: 'pop', scale: 1.15 },
      animation: { perWord: true, in: { type: 'zoom', duration: 0.08 } },
    },
  },
  {
    id: 'slide',
    label: 'Slide',
    category: 'build',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: SANS,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { perWord: true, in: { type: 'slide-up', duration: 0.15 } },
    },
  },
  {
    id: 'bounce',
    label: 'Bounce',
    category: 'build',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: SANS,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { perWord: true, in: { type: 'bounce', duration: 0.2 } },
    },
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    category: 'build',
    suggestedWordsPerLine: 4,
    style: {
      display: 'cumulative',
      fontFamily: MONO,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: 0.05,
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { perWord: true, in: { type: 'typewriter', duration: 0.15 } },
    },
  },
  {
    id: 'ticker',
    label: 'Ticker',
    category: 'build',
    suggestedWordsPerLine: 4,
    style: {
      display: 'cumulative',
      fontFamily: MONO,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.08,
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
    },
  },
  // ----------------------------------------------------------------- boxed
  {
    id: 'boxed',
    label: 'Boxed',
    category: 'boxed',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      background: { color: CHIP_DARK, radius: 0.15, paddingX: 0.4, paddingY: 0.3 },
      highlight: { enabled: true, color: WHITE, animation: 'background', background: RED },
    },
  },
  {
    id: 'tag',
    label: 'Tag',
    category: 'boxed',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: ROUNDED,
      fontWeight: 800,
      textTransform: 'lowercase',
      textColor: INK,
      background: { color: WHITE, radius: 0.35, paddingX: 0.45, paddingY: 0.3 },
      animation: { in: { type: 'zoom', duration: 0.12 } },
    },
  },
  // ------------------------------------------------------------- editorial
  {
    id: 'spotlight',
    label: 'Spotlight',
    category: 'editorial',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: CLASSIC,
      fontWeight: 400,
      textTransform: 'lowercase',
      textColor: OFF_WHITE,
      highlight: { enabled: true, color: WHITE, animation: 'color' },
      animation: { in: { type: 'fade', duration: 0.2 } },
    },
  },
  {
    id: 'headline',
    label: 'Headline',
    category: 'editorial',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: READABLE_SERIF,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.2,
      textColor: WHITE,
      accent: { mode: 'last-word', fontStyle: 'italic', color: GOLD },
      animation: { in: { type: 'fade', duration: 0.2 } },
    },
  },
  {
    id: 'whisper',
    label: 'Whisper',
    category: 'editorial',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SERIF,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 0.85,
      textColor: OFF_WHITE,
      animation: { in: { type: 'fade', duration: 0.3 } },
    },
  },
  // ------------------------------------------------------------- aesthetic
  {
    id: 'highlighter',
    label: 'Highlighter',
    category: 'aesthetic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      highlight: { enabled: true, color: INK, animation: 'background', background: YELLOW },
    },
  },
  {
    id: 'pill',
    label: 'Pill',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: ROUNDED,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      background: { color: '#ffffff33', radius: 0.6, paddingX: 0.5, paddingY: 0.3 },
      animation: { in: { type: 'fade', duration: 0.12 } },
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: HEAVY,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.4,
      textColor: ORANGE,
      shadow: { color: ORANGE, blur: 0.4, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'fade', duration: 0.1 }, loop: { type: 'pulse', period: 1.2 } },
    },
  },
  {
    id: 'retro',
    label: 'Retro',
    category: 'aesthetic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: MONO,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.1,
      textColor: WHITE,
      highlight: { enabled: true, color: RED, animation: 'color' },
    },
  },
  {
    id: 'caption-bar',
    label: 'Caption Bar',
    category: 'aesthetic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 500,
      textTransform: 'lowercase',
      textColor: WHITE,
      background: { color: '#00000080', radius: 0, paddingX: 0.6, paddingY: 0.35 },
      highlight: { enabled: true, color: GOLD, animation: 'color' },
    },
  },
  {
    id: 'pulse',
    label: 'Pulse',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: SANS,
      fontWeight: 800,
      textTransform: 'uppercase',
      fontScale: 1.4,
      textColor: GREEN,
      shadow: { color: GREEN, blur: 0.35, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'zoom', duration: 0.1 }, loop: { type: 'pulse', period: 0.8 } },
    },
  },
  {
    id: 'negative',
    label: 'Negative',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: HEAVY,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.3,
      textColor: INK,
      background: { color: WHITE, radius: 0, paddingX: 0.4, paddingY: 0.25 },
      animation: { in: { type: 'fade', duration: 0.08 } },
    },
  },
  {
    id: 'knockout',
    label: 'Knockout',
    category: 'aesthetic',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: CONDENSED,
      fontWeight: 700,
      textTransform: 'uppercase',
      fontScale: 1.4,
      textColor: WHITE,
      highlight: { enabled: true, color: RED, animation: 'color' },
    },
  },
  {
    id: 'kinetic',
    label: 'Kinetic',
    category: 'aesthetic',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: CONDENSED,
      fontWeight: 700,
      textTransform: 'uppercase',
      fontScale: 1.3,
      textColor: WHITE,
      highlight: { enabled: true, color: RED, animation: 'pop', scale: 1.2 },
      animation: { perWord: true, in: { type: 'zoom', duration: 0.1 } },
    },
  },
  {
    id: 'cascade',
    label: 'Cascade',
    category: 'aesthetic',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: GREEN,
      animation: { perWord: true, in: { type: 'fade', duration: 0.25 } },
    },
  },
  {
    id: 'stacked',
    label: 'Stacked',
    category: 'aesthetic',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: HEAVY,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.2,
      textColor: WHITE,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { in: { type: 'slide-up', duration: 0.15 } },
    },
  },
  // ------------------------------------------------------------- cinematic
  {
    id: 'soft-focus',
    label: 'Soft Focus',
    category: 'cinematic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 400,
      textTransform: 'lowercase',
      textColor: '#ffffffd9',
      shadow: { color: '#ffffff99', blur: 0.3, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'fade', duration: 0.4 } },
    },
  },
  {
    id: 'soft-2',
    label: 'Soft 2.0',
    category: 'cinematic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SERIF,
      fontWeight: 400,
      textTransform: 'lowercase',
      textColor: '#ffffffcc',
      shadow: { color: '#ffffff80', blur: 0.25, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'fade', duration: 0.4 } },
    },
  },
  {
    id: 'soft-3',
    label: 'Soft 3.0',
    category: 'cinematic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 300,
      textTransform: 'lowercase',
      fontScale: 0.9,
      letterSpacing: 0.08,
      textColor: '#ffffffcc',
      animation: { in: { type: 'fade', duration: 0.5 } },
    },
  },
  {
    id: 'soft-4',
    label: 'Soft 4.0',
    category: 'cinematic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 0.85,
      letterSpacing: 0.15,
      textColor: '#ffffffcc',
      shadow: { color: '#ffffff66', blur: 0.2, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'fade', duration: 0.4 } },
    },
  },
  {
    id: 'motion',
    label: 'Motion',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      accent: {
        mode: 'last-word',
        fontFamily: BRUSH,
        fontScale: 1.5,
        color: YELLOW,
        fontStyle: 'italic',
      },
      animation: { in: { type: 'fade', duration: 0.2 } },
    },
  },
  {
    id: 'cinematic-cut',
    label: 'Cinematic Cut',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: CLASSIC,
      fontWeight: 500,
      textTransform: 'lowercase',
      textColor: WHITE,
      accent: { mode: 'last-word', fontFamily: POSTER, fontScale: 1.8, color: WHITE },
      animation: { in: { type: 'fade', duration: 0.25 } },
    },
  },
  {
    id: 'cinetop',
    label: 'Cinetop',
    category: 'cinematic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      position: 'top',
      fontFamily: READABLE_SERIF,
      fontWeight: 400,
      textTransform: 'lowercase',
      textColor: WHITE,
      accent: { mode: 'last-word', fontStyle: 'italic', color: GOLD },
      animation: { in: { type: 'fade', duration: 0.3 } },
    },
  },
  {
    id: 'real-estate',
    label: 'Real Estate',
    category: 'cinematic',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      accent: { mode: 'last-word', fontFamily: BRUSH, fontScale: 1.9, color: YELLOW },
      animation: { in: { type: 'fade', duration: 0.2 } },
    },
  },
  {
    id: 'subtitle-pop',
    label: 'Subtitle Pop',
    category: 'cinematic',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      accent: { mode: 'last-word', fontScale: 2, color: GREEN },
      animation: { in: { type: 'slide-up', duration: 0.15 } },
    },
  },
  // ----------------------------------------------- creator reference set (2026)
  {
    id: 'semantic-anchor',
    label: 'Semantic Anchor',
    category: 'phrase',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: CREATOR,
      fontWeight: 700,
      fontScale: 1.05,
      textColor: WHITE,
      textAlign: 'center',
      lineHeight: 0.96,
      accent: { mode: 'longest-word', fontFamily: POSTER, fontScale: 1.85, color: WHITE },
      animation: { in: { type: 'slide-up', duration: 0.14 } },
    },
  },
  {
    id: 'editorial-contrast',
    label: 'Editorial Contrast',
    category: 'editorial',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: WARM,
      fontWeight: 400,
      fontScale: 0.95,
      textColor: WHITE,
      accent: {
        mode: 'longest-word',
        fontFamily: CLASSIC,
        fontScale: 1.55,
        color: WHITE,
        fontStyle: 'italic',
      },
      animation: { in: { type: 'fade', duration: 0.2 } },
    },
  },
  {
    id: 'compact-tier',
    label: 'Compact Tier',
    category: 'boxed',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SANS,
      fontWeight: 650,
      fontScale: 0.92,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: 1,
      lineHeight: 0.98,
      accent: { mode: 'longest-word', fontFamily: HEAVY, fontScale: 1.45, color: WHITE },
      animation: { in: { type: 'zoom', duration: 0.1 } },
    },
  },
  {
    id: 'kinetic-stack',
    label: 'Kinetic Stack',
    category: 'build',
    suggestedWordsPerLine: 4,
    style: {
      display: 'cumulative',
      fontFamily: HEAVY,
      fontWeight: 900,
      fontScale: 1.2,
      textTransform: 'lowercase',
      textColor: WHITE,
      textAlign: 'left',
      lineHeight: 0.86,
      maxWidthPercent: 72,
      animation: { perWord: true, in: { type: 'slide-up', duration: 0.09 } },
    },
  },
  {
    id: 'handwritten-zone',
    label: 'Handwritten Zone',
    category: 'aesthetic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: SCRIPT,
      fontWeight: 500,
      fontScale: 1.15,
      textTransform: 'uppercase',
      letterSpacing: 0.03,
      textColor: OFF_WHITE,
      lineHeight: 1.12,
      animation: { in: { type: 'typewriter', duration: 0.3 } },
    },
  },
  {
    id: 'social-headline-2026',
    label: 'Social Headline',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: SERIF,
      fontWeight: 400,
      fontStyle: 'italic',
      fontScale: 0.9,
      textColor: WHITE,
      lineHeight: 0.92,
      accent: {
        mode: 'longest-word',
        fontFamily: HEAVY,
        fontScale: 2.05,
        color: ORANGE,
        fontStyle: 'normal',
      },
      animation: { in: { type: 'zoom', duration: 0.12 } },
    },
  },
];

/**
 * Default template used when none is chosen — `karaoke` reads well on any
 * footage and demonstrates the transcript-driven active-word behavior.
 */
export const DEFAULT_CAPTION_TEMPLATE_ID = 'karaoke';

const TEMPLATES_BY_ID: ReadonlyMap<string, CaptionTemplate> = new Map(
  CAPTION_TEMPLATE_CATALOG.map((t) => [t.id, t]),
);

export function getCaptionTemplate(id: string): CaptionTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}

/**
 * A caption style with the template layer already folded in. Same shape as
 * {@link CaptionStyle} minus `templateId` (resolution is not re-entrant).
 */
export type ResolvedCaptionStyle = Omit<CaptionStyle, 'templateId'>;

/**
 * Layer a clip's caption style over its track's default (schema v11, ADR 0071).
 *
 * Field-level merge with the clip winning — including `templateId`, so a single
 * cue can adopt a different template than the rest of the track while every cue
 * that specifies nothing follows the track. Either side may be absent.
 *
 * WHY the track layer exists: in v10 style lived only on the clip, so a
 * finished caption set had no shared look and restyling it meant one operation
 * per cue.
 */
export function layerCaptionStyle(
  trackDefault: CaptionStyle | undefined,
  clipOverride: CaptionStyle | undefined,
): CaptionStyle | undefined {
  if (trackDefault === undefined) return clipOverride;
  if (clipOverride === undefined) return trackDefault;
  const merged: Record<string, unknown> = { ...trackDefault };
  for (const [key, value] of Object.entries(clipOverride)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as CaptionStyle;
}

/**
 * Fold the catalog template named by `style.templateId` (if any) under the
 * clip's explicit fields: the template fills every field the style leaves
 * unset; explicit fields always win. Field-level (not deep) merge — an
 * explicit `highlight`/`background`/… object REPLACES the template's, so an
 * override is always a complete, self-describing object.
 *
 * Full precedence, highest first: **clip override → track default → template
 * catalog**. Pass `trackDefault` to include the track layer (schema v11); omit
 * it and this behaves exactly as it did in v10, which is why every existing
 * caller is unaffected.
 *
 * The Python engine mirrors this exactly
 * (`framepilot_engine/render/caption_templates.py#resolve_caption_style`);
 * change both together.
 */
export function resolveCaptionStyle(
  style: CaptionStyle | undefined,
  trackDefault?: CaptionStyle | undefined,
): ResolvedCaptionStyle {
  const layered = layerCaptionStyle(trackDefault, style);
  if (layered === undefined) return {};
  const { templateId, ...explicit } = layered;
  const template = templateId === undefined ? undefined : TEMPLATES_BY_ID.get(templateId);
  if (template === undefined) return explicit;
  const merged: Record<string, unknown> = { ...template.style };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) merged[key] = value;
  }
  return CaptionStyleSchema.parse(merged) as ResolvedCaptionStyle;
}
