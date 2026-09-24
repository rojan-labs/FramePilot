/**
 * @framepilot/timeline-schema/caption-templates — the canonical caption
 * template catalog (schema v10, ADR 0069).
 *
 * Every template is PURE DATA: a complete {@link CaptionStyle} built from the
 * closed enum vocabularies (`display` × emphasis × entrance × accent) that the
 * renderers interpret generically. Neither the Python engine nor the web
 * preview may ever branch on a template id — that is the extensibility
 * contract that makes "add a template" a one-object change to this file.
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
  'one-word' | 'phrase' | 'karaoke' | 'build' | 'boxed' | 'editorial' | 'aesthetic' | 'cinematic';

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

// ----------------------------------------------------------------- palette
// Tuned against real footage, not a dark canvas: every text colour is chosen to
// survive both a blown-out sky and a dark room once its separation layer (below)
// is applied.
const WHITE = '#ffffff';
const OFF_WHITE = '#f4f1ea';
const SOFT_WHITE = '#fffffff2';
const YELLOW = '#ffd60a';
const GOLD = '#f2c14e';
const RED = '#ff2e4d';
const LIME = '#8cff5a';
const ORANGE = '#ff6b1a';
const CYAN = '#3de0ff';
const PINK = '#ff4fa3';
const INK = '#0b0b0f';
const PHOSPHOR = '#7dff9b';

// ------------------------------------------------------ separation layers
// WHY every template carries one: a caption is drawn over footage nobody chose
// for it. Plain white text with no outline, shadow or chip vanishes on a sky, a
// white wall or a bright shirt — the failure `caption_legibility.py` measures.
// The catalog used to ship a dozen such templates. Units: blur/offsets are
// fractions of the font size; `outlineWidth` is sixteenths of it.

/** A soft drop shadow: lifts light text off bright picture without a hard edge. */
const SOFT_DROP = { color: '#000000b3', blur: 0.2, offsetX: 0, offsetY: 0.06 } as const;
/** A dark halo with no offset: the quiet choice for serif and light-weight looks. */
const HALO = { color: '#000000d9', blur: 0.26, offsetX: 0, offsetY: 0.02 } as const;
/** A hard offset shadow: the sticker/comic look, reads at a glance on anything. */
const HARD_DROP = { color: '#000000', blur: 0, offsetX: 0.05, offsetY: 0.07 } as const;
/**
 * Frosted glass (schema v24): the chip blurs the picture behind it (`blur` is the
 * blur's standard deviation, a fraction of the font size), a faint tint gives it
 * a body, and an inset rim catches the light. Light glass for dark or busy
 * footage, smoked glass for bright footage.
 */
const LIGHT_GLASS = {
  color: '#ffffff29',
  radius: 0.45,
  paddingX: 0.55,
  paddingY: 0.26,
  blur: 0.35,
  borderColor: '#ffffff73',
  borderWidth: 1,
} as const;
const SMOKED_GLASS = {
  color: '#0b0b0f4d',
  radius: 0.22,
  paddingX: 0.6,
  paddingY: 0.3,
  blur: 0.4,
  borderColor: '#ffffff2e',
  borderWidth: 1,
} as const;
/** Outline widths (sixteenths of the font size). */
const THIN = 1;
const MEDIUM = 1.5;
const BOLD = 2;
const HEAVY_STROKE = 2.5;

// ------------------------------------------------------------------- fonts
// Every family is bundled (`caption-fonts.ts`) and drawn identically by both
// renderers. Italic is only asked of families that ship an italic file — the
// renderers never fake one.
const ANTON = 'Anton';
const LUCKIEST = 'Luckiest Guy';
const ARCHIVO_BLACK = 'Archivo Black';
const BEBAS = 'Bebas Neue';
const BANGERS = 'Bangers';
const UNBOUNDED = 'Unbounded';
const JAKARTA = 'Plus Jakarta Sans';
const OUTFIT = 'Outfit';
const RUBIK = 'Rubik';
const JOSEFIN = 'Josefin Sans';
const SORA = 'Sora';
const PATRICK = 'Patrick Hand';
const POPPINS = 'Poppins';
const MONTSERRAT = 'Montserrat';
const BARLOW = 'Barlow';
const KANIT = 'Kanit';
const GEIST = 'Geist';
const LEXEND = 'Lexend';
const FREDOKA = 'Fredoka';
const COURIER = 'Courier Prime';
const JETBRAINS = 'JetBrains Mono';
const SPARTAN = 'League Spartan';
const RUSSO = 'Russo One';
const QUICKSAND = 'Quicksand';
const LILITA = 'Lilita One';
const INTER = 'Inter';
const INSTRUMENT = 'Instrument Serif';
const LORA = 'Lora';
const BASKERVILLE = 'Libre Baskerville';
const DM_SANS = 'DM Sans';
const PLAYFAIR = 'Playfair Display';
const CINZEL = 'Cinzel';
const URBANIST = 'Urbanist';
const NUNITO = 'Nunito';
const BUNGEE = 'Bungee';
const VT323 = 'VT323';
const ORBITRON = 'Orbitron';
const RUBIK_MONO = 'Rubik Mono One';
const BIG_SHOULDERS = 'Big Shoulders';
const BARLOW_CONDENSED = 'Barlow Condensed';
const SYNE = 'Syne';
const STAATLICHES = 'Staatliches';
const PERMANENT_MARKER = 'Permanent Marker';
const MANROPE = 'Manrope';
const DM_SERIF = 'DM Serif Display';
const YELLOWTAIL = 'Yellowtail';
const BODONI = 'Bodoni Moda';
const MERRIWEATHER = 'Merriweather';
const GREAT_VIBES = 'Great Vibes';
const TITAN = 'Titan One';
const RIGHTEOUS = 'Righteous';
const PRESS_START = 'Press Start 2P';
const MR_DAFOE = 'Mr Dafoe';

/**
 * The built-in caption template catalog. Order within each category is the
 * gallery display order. Ids are persisted in projects and never change; the
 * look behind an id may be revised (2026-09-24: every template given a
 * separation layer and a font from the 92-family catalog).
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
      fontFamily: ANTON,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.01,
      fontScale: 1.55,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: BOLD,
      shadow: SOFT_DROP,
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
      fontFamily: LUCKIEST,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 1.4,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: HEAVY_STROKE,
      shadow: HARD_DROP,
      animation: { in: { type: 'bounce', duration: 0.22 } },
    },
  },
  {
    id: 'impact',
    label: 'Impact',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: ARCHIVO_BLACK,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.45,
      textColor: YELLOW,
      outlineColor: INK,
      outlineWidth: BOLD,
      shadow: SOFT_DROP,
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
      fontFamily: BEBAS,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.04,
      fontScale: 1.35,
      textColor: WHITE,
      background: { color: RED, radius: 0.12, paddingX: 0.38, paddingY: 0.14 },
      animation: { in: { type: 'zoom', duration: 0.1 } },
    },
  },
  {
    id: 'comic',
    label: 'Comic',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: BANGERS,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.03,
      fontScale: 1.55,
      textColor: YELLOW,
      outlineColor: INK,
      outlineWidth: HEAVY_STROKE,
      shadow: HARD_DROP,
      rotation: -4,
      animation: { in: { type: 'bounce', duration: 0.2 } },
    },
  },
  {
    id: 'shout',
    label: 'Shout',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: UNBOUNDED,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.05,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: BOLD,
      shadow: SOFT_DROP,
      animation: { in: { type: 'zoom', duration: 0.09 } },
    },
  },
  {
    id: 'hollow',
    label: 'Hollow',
    category: 'one-word',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: ANTON,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 1.6,
      letterSpacing: 0.02,
      textColor: WHITE,
      // See-through at 0: the picture fills the letters, only the rim is drawn.
      textOpacity: 0,
      outlineColor: WHITE,
      outlineWidth: BOLD,
      shadow: SOFT_DROP,
      animation: { in: { type: 'zoom', duration: 0.12 } },
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
      fontFamily: JAKARTA,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.1,
      textColor: WHITE,
      shadow: SOFT_DROP,
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
      fontFamily: OUTFIT,
      fontWeight: 800,
      textTransform: 'uppercase',
      letterSpacing: 0.01,
      fontScale: 1.3,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      shadow: SOFT_DROP,
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
      fontFamily: RUBIK,
      fontWeight: 800,
      textTransform: 'uppercase',
      fontScale: 1.1,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      highlight: { enabled: true, color: YELLOW, animation: 'pop', scale: 1.18 },
    },
  },
  {
    id: 'duo-gold',
    label: 'Duo Gold',
    category: 'phrase',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: JOSEFIN,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.2,
      textColor: WHITE,
      shadow: SOFT_DROP,
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { in: { type: 'fade', duration: 0.15 } },
    },
  },
  {
    id: 'phrase-box',
    label: 'Phrase Box',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: SORA,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: SOFT_DROP,
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
      fontFamily: PATRICK,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.25,
      textColor: WHITE,
      shadow: SOFT_DROP,
      highlight: { enabled: true, color: INK, animation: 'background', background: YELLOW },
    },
  },
  {
    id: 'bubble',
    label: 'Bubble',
    category: 'phrase',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: TITAN,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.15,
      textColor: WHITE,
      outlineColor: PINK,
      outlineWidth: MEDIUM,
      shadow: HARD_DROP,
      highlight: { enabled: true, color: YELLOW, animation: 'pop', scale: 1.15 },
      animation: { in: { type: 'bounce', duration: 0.2 } },
    },
  },
  {
    id: 'vlog',
    label: 'Vlog',
    category: 'phrase',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: FREDOKA,
      fontWeight: 600,
      textTransform: 'lowercase',
      fontScale: 1.05,
      textColor: INK,
      background: { color: '#fffffff0', radius: 0.45, paddingX: 0.5, paddingY: 0.22 },
      highlight: { enabled: true, color: PINK, animation: 'color' },
      animation: { in: { type: 'slide-up', duration: 0.14 } },
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
      fontFamily: MONTSERRAT,
      fontWeight: 800,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      shadow: SOFT_DROP,
      highlight: { enabled: true, color: YELLOW, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    category: 'karaoke',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: BARLOW,
      fontWeight: 700,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: { color: '#000000e6', blur: 0.14, offsetX: 0, offsetY: 0.05 },
      highlight: { enabled: true, color: YELLOW, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'outline',
    label: 'Outline',
    category: 'karaoke',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: KANIT,
      fontWeight: 800,
      textTransform: 'uppercase',
      fontScale: 1.1,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: HEAVY_STROKE,
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
      fontFamily: SORA,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: { color: '#8cff5a8c', blur: 0.45, offsetX: 0, offsetY: 0 },
      highlight: { enabled: true, color: LIME, animation: 'glow' },
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    category: 'karaoke',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: GEIST,
      fontWeight: 600,
      textColor: WHITE,
      shadow: HALO,
      highlight: { enabled: true, color: WHITE, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'podcast',
    label: 'Podcast',
    category: 'karaoke',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: LEXEND,
      fontWeight: 700,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      shadow: SOFT_DROP,
      lineHeight: 1.15,
      highlight: { enabled: true, color: CYAN, animation: 'karaoke-fill' },
    },
  },
  {
    id: 'frosted-bar',
    label: 'Frosted Bar',
    category: 'karaoke',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: LEXEND,
      fontWeight: 600,
      textColor: WHITE,
      shadow: { color: '#00000059', blur: 0.12, offsetX: 0, offsetY: 0.03 },
      background: SMOKED_GLASS,
      highlight: { enabled: true, color: YELLOW, animation: 'karaoke-fill' },
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
      fontFamily: MONTSERRAT,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.15,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: HEAVY_STROKE,
      shadow: SOFT_DROP,
      highlight: { enabled: true, color: YELLOW, animation: 'pop', scale: 1.12 },
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
      fontFamily: OUTFIT,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.1,
      textColor: WHITE,
      shadow: SOFT_DROP,
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
      animation: { perWord: true, in: { type: 'slide-up', duration: 0.14 } },
    },
  },
  {
    id: 'bounce',
    label: 'Bounce',
    category: 'build',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: FREDOKA,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.15,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
      animation: { perWord: true, in: { type: 'bounce', duration: 0.22 } },
    },
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    category: 'build',
    suggestedWordsPerLine: 4,
    style: {
      display: 'cumulative',
      fontFamily: COURIER,
      fontWeight: 700,
      textTransform: 'lowercase',
      letterSpacing: 0.02,
      textColor: WHITE,
      shadow: HALO,
      outlineColor: INK,
      outlineWidth: THIN,
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
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
      fontFamily: JETBRAINS,
      fontWeight: 800,
      textTransform: 'uppercase',
      letterSpacing: 0.04,
      fontScale: 0.9,
      textColor: WHITE,
      background: { color: '#0b0b0fd9', radius: 0.08, paddingX: 0.45, paddingY: 0.22 },
      highlight: { enabled: true, color: CYAN, animation: 'color' },
    },
  },
  {
    id: 'gamer',
    label: 'Gamer',
    category: 'build',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: RUSSO,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 1.1,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: BOLD,
      shadow: HARD_DROP,
      highlight: { enabled: true, color: CYAN, animation: 'pop', scale: 1.15 },
      animation: { perWord: true, in: { type: 'zoom', duration: 0.08 } },
    },
  },
  // ----------------------------------------------------------------- boxed
  {
    id: 'boxed',
    label: 'Boxed',
    category: 'boxed',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: GEIST,
      fontWeight: 800,
      textTransform: 'uppercase',
      textColor: WHITE,
      background: { color: '#0b0b0fcc', radius: 0.18, paddingX: 0.45, paddingY: 0.26 },
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
      fontFamily: QUICKSAND,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.15,
      textColor: INK,
      background: { color: WHITE, radius: 0.5, paddingX: 0.5, paddingY: 0.2 },
      animation: { in: { type: 'zoom', duration: 0.12 } },
    },
  },
  {
    id: 'sticker',
    label: 'Sticker',
    category: 'boxed',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: LILITA,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.35,
      textColor: INK,
      background: { color: YELLOW, radius: 0.28, paddingX: 0.42, paddingY: 0.14 },
      rotation: -3,
      animation: { in: { type: 'bounce', duration: 0.2 } },
    },
  },
  {
    id: 'glass',
    label: 'Glass',
    category: 'boxed',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: JAKARTA,
      fontWeight: 700,
      textColor: WHITE,
      shadow: { color: '#00000066', blur: 0.15, offsetX: 0, offsetY: 0.03 },
      background: LIGHT_GLASS,
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
      animation: { in: { type: 'fade', duration: 0.15 } },
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
      fontFamily: INSTRUMENT,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.2,
      textColor: OFF_WHITE,
      shadow: HALO,
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
      fontFamily: LORA,
      fontWeight: 600,
      textTransform: 'lowercase',
      fontScale: 1.2,
      textColor: WHITE,
      shadow: HALO,
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
      fontFamily: BASKERVILLE,
      fontWeight: 400,
      fontStyle: 'italic',
      textTransform: 'lowercase',
      fontScale: 0.95,
      textColor: OFF_WHITE,
      shadow: HALO,
      animation: { in: { type: 'fade', duration: 0.35 } },
    },
  },
  {
    id: 'luxe',
    label: 'Luxe',
    category: 'editorial',
    suggestedWordsPerLine: 4,
    style: {
      display: 'phrase',
      fontFamily: CINZEL,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.08,
      fontScale: 0.95,
      textColor: OFF_WHITE,
      shadow: HALO,
      // Gold marks the spoken word only: gold text throughout vanishes on warm,
      // bright picture — the exact footage (interiors, sunsets) this look is for.
      highlight: { enabled: true, color: GOLD, animation: 'color' },
      animation: { in: { type: 'fade', duration: 0.4 } },
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
      fontFamily: URBANIST,
      fontWeight: 800,
      textTransform: 'lowercase',
      fontScale: 1.05,
      textColor: WHITE,
      shadow: SOFT_DROP,
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
      fontFamily: NUNITO,
      fontWeight: 800,
      textTransform: 'lowercase',
      fontScale: 1.1,
      textColor: WHITE,
      background: { color: '#0b0b0f8c', radius: 0.6, paddingX: 0.55, paddingY: 0.2 },
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
      fontFamily: BUNGEE,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 1.25,
      textColor: ORANGE,
      outlineColor: '#2a0800',
      outlineWidth: THIN,
      shadow: { color: '#ff6b1acc', blur: 0.45, offsetX: 0, offsetY: 0 },
      animation: { in: { type: 'fade', duration: 0.1 }, loop: { type: 'pulse', period: 1.2 } },
    },
  },
  {
    id: 'retro',
    label: 'Retro',
    category: 'aesthetic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: VT323,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.03,
      fontScale: 1.45,
      textColor: PHOSPHOR,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: { color: '#7dff9b80', blur: 0.35, offsetX: 0, offsetY: 0 },
      highlight: { enabled: true, color: WHITE, animation: 'color' },
    },
  },
  {
    id: 'caption-bar',
    label: 'Caption Bar',
    category: 'aesthetic',
    suggestedWordsPerLine: 6,
    style: {
      display: 'phrase',
      fontFamily: LEXEND,
      fontWeight: 500,
      textColor: WHITE,
      background: { color: '#000000b3', radius: 0.12, paddingX: 0.6, paddingY: 0.3 },
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
    },
  },
  {
    id: 'pulse',
    label: 'Pulse',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: ORBITRON,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.2,
      textColor: LIME,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: { color: '#8cff5a99', blur: 0.4, offsetX: 0, offsetY: 0 },
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
      fontFamily: RUBIK_MONO,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 1.05,
      textColor: INK,
      background: { color: WHITE, radius: 0, paddingX: 0.35, paddingY: 0.2 },
      animation: { in: { type: 'zoom', duration: 0.08 } },
    },
  },
  {
    id: 'knockout',
    label: 'Knockout',
    category: 'aesthetic',
    suggestedWordsPerLine: 2,
    style: {
      display: 'phrase',
      fontFamily: BIG_SHOULDERS,
      fontWeight: 900,
      textTransform: 'uppercase',
      letterSpacing: 0.01,
      fontScale: 1.55,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      shadow: SOFT_DROP,
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
      fontFamily: BARLOW_CONDENSED,
      fontWeight: 800,
      textTransform: 'uppercase',
      fontScale: 1.45,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      highlight: { enabled: true, color: RED, animation: 'pop', scale: 1.2 },
      animation: { perWord: true, in: { type: 'zoom', duration: 0.1 } },
    },
  },
  {
    id: 'cascade',
    label: 'Cascade',
    category: 'aesthetic',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: SYNE,
      fontWeight: 700,
      textTransform: 'lowercase',
      fontScale: 1.1,
      textColor: LIME,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: SOFT_DROP,
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
      fontFamily: STAATLICHES,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.02,
      fontScale: 1.55,
      lineHeight: 0.95,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      highlight: { enabled: true, color: YELLOW, animation: 'color' },
      animation: { in: { type: 'slide-up', duration: 0.15 } },
    },
  },
  {
    id: 'neon',
    label: 'Neon',
    category: 'aesthetic',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: RIGHTEOUS,
      fontWeight: 400,
      textTransform: 'uppercase',
      letterSpacing: 0.03,
      fontScale: 1.15,
      textColor: '#ffd9ee',
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: { color: '#ff4fa3cc', blur: 0.5, offsetX: 0, offsetY: 0 },
      highlight: { enabled: true, color: PINK, animation: 'glow' },
      animation: { in: { type: 'fade', duration: 0.18 } },
    },
  },
  {
    id: 'pixel',
    label: 'Pixel',
    category: 'aesthetic',
    suggestedWordsPerLine: 3,
    style: {
      display: 'cumulative',
      fontFamily: PRESS_START,
      fontWeight: 400,
      textTransform: 'uppercase',
      fontScale: 0.75,
      lineHeight: 1.4,
      textColor: WHITE,
      shadow: { color: '#000000', blur: 0, offsetX: 0.12, offsetY: 0.12 },
      highlight: { enabled: true, color: CYAN, animation: 'color' },
      animation: { perWord: true, in: { type: 'typewriter', duration: 0.12 } },
    },
  },
  {
    id: 'glass-pill',
    label: 'Glass Pill',
    category: 'aesthetic',
    suggestedWordsPerLine: 1,
    style: {
      display: 'active-word',
      fontFamily: NUNITO,
      fontWeight: 800,
      textTransform: 'lowercase',
      fontScale: 1.15,
      textColor: WHITE,
      shadow: { color: '#00000059', blur: 0.12, offsetX: 0, offsetY: 0.03 },
      background: { ...LIGHT_GLASS, radius: 0.6, paddingX: 0.55, paddingY: 0.2 },
      animation: { in: { type: 'zoom', duration: 0.12 } },
    },
  },
  {
    id: 'ghost',
    label: 'Ghost',
    category: 'aesthetic',
    suggestedWordsPerLine: 3,
    style: {
      display: 'phrase',
      fontFamily: MONTSERRAT,
      fontWeight: 900,
      textTransform: 'uppercase',
      fontScale: 1.25,
      textColor: WHITE,
      // The picture shows through the letters; a crisp rim and a soft drop keep
      // them readable, and neither is ever drawn inside a letter.
      textOpacity: 0.35,
      outlineColor: WHITE,
      outlineWidth: MEDIUM,
      shadow: SOFT_DROP,
      // No colour highlight: a highlight colour is see-through too, and a
      // translucent yellow over dark picture reads as olive.
      animation: { in: { type: 'slide-up', duration: 0.14 } },
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
      fontFamily: MANROPE,
      fontWeight: 500,
      textTransform: 'lowercase',
      textColor: SOFT_WHITE,
      shadow: { color: '#000000cc', blur: 0.34, offsetX: 0, offsetY: 0.03 },
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
      fontFamily: DM_SERIF,
      fontWeight: 400,
      textTransform: 'lowercase',
      fontScale: 1.05,
      textColor: SOFT_WHITE,
      shadow: HALO,
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
      fontFamily: URBANIST,
      fontWeight: 500,
      textTransform: 'lowercase',
      fontScale: 0.92,
      letterSpacing: 0.06,
      textColor: SOFT_WHITE,
      shadow: HALO,
      animation: { in: { type: 'fade', duration: 0.5 } },
    },
  },
  {
    id: 'soft-4',
    label: 'Soft 4.0',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: JOSEFIN,
      fontWeight: 500,
      textTransform: 'uppercase',
      fontScale: 0.85,
      letterSpacing: 0.16,
      textColor: SOFT_WHITE,
      shadow: HALO,
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
      fontFamily: DM_SANS,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      shadow: SOFT_DROP,
      accent: { mode: 'last-word', fontFamily: YELLOWTAIL, fontScale: 1.6, color: YELLOW },
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
      fontFamily: BODONI,
      fontWeight: 500,
      textTransform: 'lowercase',
      textColor: WHITE,
      shadow: HALO,
      accent: { mode: 'last-word', fontFamily: ANTON, fontScale: 1.75, color: WHITE },
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
      fontFamily: MERRIWEATHER,
      fontWeight: 400,
      textTransform: 'lowercase',
      textColor: WHITE,
      shadow: HALO,
      accent: { mode: 'last-word', fontFamily: PLAYFAIR, fontStyle: 'italic', color: GOLD },
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
      fontFamily: JAKARTA,
      fontWeight: 600,
      textTransform: 'lowercase',
      textColor: WHITE,
      shadow: SOFT_DROP,
      accent: { mode: 'last-word', fontFamily: GREAT_VIBES, fontScale: 2, color: GOLD },
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
      fontFamily: POPPINS,
      fontWeight: 700,
      textTransform: 'lowercase',
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: SOFT_DROP,
      accent: { mode: 'last-word', fontFamily: LILITA, fontScale: 1.9, color: LIME },
      animation: { in: { type: 'slide-up', duration: 0.15 } },
    },
  },
  {
    id: 'signature',
    label: 'Signature',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: LORA,
      fontWeight: 500,
      textTransform: 'lowercase',
      textColor: OFF_WHITE,
      shadow: HALO,
      accent: { mode: 'last-word', fontFamily: MR_DAFOE, fontScale: 1.9, color: WHITE },
      animation: { in: { type: 'fade', duration: 0.3 } },
    },
  },
  {
    id: 'veil',
    label: 'Veil',
    category: 'cinematic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: BODONI,
      fontWeight: 600,
      textTransform: 'lowercase',
      fontScale: 1.1,
      textColor: WHITE,
      textOpacity: 0.6,
      shadow: HALO,
      animation: { in: { type: 'fade', duration: 0.4 } },
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
      fontFamily: POPPINS,
      fontWeight: 700,
      fontScale: 1.05,
      textColor: WHITE,
      textAlign: 'center',
      lineHeight: 0.96,
      shadow: SOFT_DROP,
      accent: { mode: 'longest-word', fontFamily: ANTON, fontScale: 1.85, color: WHITE },
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
      fontFamily: DM_SANS,
      fontWeight: 400,
      fontScale: 0.95,
      textColor: WHITE,
      shadow: HALO,
      accent: {
        mode: 'longest-word',
        fontFamily: PLAYFAIR,
        fontScale: 1.6,
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
      fontFamily: INTER,
      fontWeight: 650,
      fontScale: 0.92,
      textColor: WHITE,
      outlineColor: INK,
      outlineWidth: THIN,
      shadow: SOFT_DROP,
      lineHeight: 0.98,
      accent: { mode: 'longest-word', fontFamily: ARCHIVO_BLACK, fontScale: 1.45, color: WHITE },
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
      fontFamily: SPARTAN,
      fontWeight: 900,
      fontScale: 1.25,
      textTransform: 'lowercase',
      textColor: WHITE,
      textAlign: 'left',
      lineHeight: 0.9,
      maxWidthPercent: 72,
      outlineColor: INK,
      outlineWidth: MEDIUM,
      animation: { perWord: true, in: { type: 'slide-up', duration: 0.09 } },
    },
  },
  {
    id: 'handwritten-zone',
    label: 'Handwritten Zone',
    category: 'aesthetic',
    suggestedWordsPerLine: 5,
    style: {
      display: 'phrase',
      fontFamily: PERMANENT_MARKER,
      fontWeight: 400,
      fontScale: 1.05,
      textColor: WHITE,
      lineHeight: 1.1,
      shadow: SOFT_DROP,
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
      fontFamily: DM_SERIF,
      fontWeight: 400,
      fontStyle: 'italic',
      fontScale: 0.9,
      textColor: WHITE,
      lineHeight: 0.92,
      shadow: HALO,
      accent: {
        mode: 'longest-word',
        fontFamily: ARCHIVO_BLACK,
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
