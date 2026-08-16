/**
 * @framepilot/timeline-schema/effect-catalog — the canonical effect catalog
 * (schema v13, ADR 0088).
 *
 * Every entry is PURE DATA: a name, a browsable category, one
 * {@link EffectRenderKind} from the closed enum, and a shallow override of that
 * kind's default params (see `effect-params.ts`). Neither the Python compiler
 * nor the WebGL preview may ever branch on an entry `id` — that is the same
 * extensibility contract the caption template catalog established (ADR 0069),
 * and it is what makes "add effect #73" a one-object change to this file with
 * zero renderer work.
 *
 * ORIGINALITY: every name, description, category label and thumbnail here is
 * original to FramePilot. Thumbnails are *generated* — an original synthetic
 * gradient base with the effect's own real shader applied over it — so the
 * catalog ships no third-party preview media, no scraped artwork, and nothing
 * that needs licensing. Hovering runs the same shader on a frame of the user's
 * OWN footage, which is both more useful than a canned clip and free of any
 * asset provenance question.
 *
 * Cross-language parity: `scripts/generate-json-schema.mjs` exports this catalog
 * to `schema/effect-catalog.json` and copies it into the Python engine; drift is
 * guarded on both sides (`effect-catalog.test.ts` + the engine's
 * `test_effect_catalog.py`).
 */
import type { EffectRenderKind } from './index.js';
import { defaultParamsForKind } from './effect-params.js';

/**
 * Browsable groups, one per family the product promises. These are the left
 * category rail in the effects library; order here is the order shown.
 */
export type EffectCategory =
  | 'blur-focus'
  | 'glow'
  | 'light'
  | 'film'
  | 'retro'
  | 'analog'
  | 'glitch'
  | 'motion'
  | 'zoom'
  | 'chromatic'
  | 'dreamy'
  | 'warp'
  | 'pixel'
  | 'texture'
  | 'party'
  | 'comic'
  | 'outline'
  | 'lens-deform'
  | 'strobe'
  | 'mirror';

/** Display metadata for the category rail. */
export interface EffectCategoryMeta {
  readonly id: EffectCategory;
  readonly label: string;
  /** One-line description for the category's empty/header state. */
  readonly blurb: string;
}

export const EFFECT_CATEGORIES: readonly EffectCategoryMeta[] = [
  { id: 'blur-focus', label: 'Blur & Focus', blurb: 'Soften the frame or pull attention to one plane.' },
  { id: 'glow', label: 'Glow & Bloom', blurb: 'Bleed light out of the highlights.' },
  { id: 'light', label: 'Light & Lens', blurb: 'Leaks, flares and falloff from real glass.' },
  { id: 'film', label: 'Film & Cinematic', blurb: 'Print stocks and graded looks.' },
  { id: 'retro', label: 'Retro & Vintage', blurb: 'Faded, sun-bleached, decades old.' },
  { id: 'analog', label: 'VHS & Analog', blurb: 'Tape, tracking error and CRT lines.' },
  { id: 'glitch', label: 'Glitch & Digital', blurb: 'Corrupt the signal on purpose.' },
  { id: 'motion', label: 'Shake & Impact', blurb: 'Hits, handheld energy and camera weight.' },
  { id: 'zoom', label: 'Zoom & Directional', blurb: 'Punch in, whip across, rush forward.' },
  { id: 'chromatic', label: 'Chromatic', blurb: 'Split the colour channels apart.' },
  { id: 'dreamy', label: 'Dreamy & Soft', blurb: 'Hazy, gentle, half-remembered.' },
  { id: 'warp', label: 'Distortion & Warp', blurb: 'Bend the picture through water and heat.' },
  { id: 'pixel', label: 'Pixel & Halftone', blurb: 'Quantise into blocks, dots and levels.' },
  { id: 'texture', label: 'Grain & Texture', blurb: 'Grain, dust and physical wear.' },
  { id: 'party', label: 'Party & Neon', blurb: 'Loud colour and moving light.' },
  { id: 'comic', label: 'Comic & Stylised', blurb: 'Flatten into ink and poster colour.' },
  { id: 'outline', label: 'Edge & Outline', blurb: 'Trace and light up the contours.' },
  { id: 'lens-deform', label: 'Fisheye & Lens', blurb: 'Extreme glass geometry.' },
  { id: 'strobe', label: 'Flash & Strobe', blurb: 'Cut the light on a rhythm.' },
  { id: 'mirror', label: 'Mirror & Split', blurb: 'Fold the frame back on itself.' },
];

/**
 * Synthetic thumbnail base — an original gradient the real shader is then run
 * over, so the tile shows an accurate result with no bundled media.
 *
 * `css` is a cheap static approximation painted immediately on mount, before the
 * shared WebGL thumbnail pass has produced the accurate version. It exists so
 * the grid never flashes empty tiles on a cold scroll; it is replaced, never
 * shown as final.
 */
export interface EffectThumbnail {
  /** CSS gradient stops for the synthetic base image. */
  readonly gradient: string;
  /** Static CSS-filter approximation shown until the shader pass lands. */
  readonly css?: string;
}

/** Reusable original gradient bases, chosen to make each family read clearly. */
const BASE = {
  portrait: 'linear-gradient(145deg,#f7d9c4 0%,#c98a6b 45%,#3b2b2b 100%)',
  city: 'linear-gradient(160deg,#1b2a4a 0%,#3f5f8a 40%,#f0a868 100%)',
  neon: 'linear-gradient(135deg,#2a0d3d 0%,#a2129b 50%,#26d0e0 100%)',
  daylight: 'linear-gradient(150deg,#dff0f7 0%,#8fbfd8 55%,#2f5f76 100%)',
  warm: 'linear-gradient(150deg,#ffe7c2 0%,#f0a05a 50%,#7a3b1f 100%)',
  mono: 'linear-gradient(150deg,#f2f2f2 0%,#8a8a8a 50%,#1c1c1c 100%)',
  dusk: 'linear-gradient(160deg,#38254d 0%,#a05a7a 50%,#f2c17a 100%)',
} as const;

/** One browsable effect. */
export interface CatalogEffect {
  /** Stable id, persisted on {@link EffectLayer.effectId}. Never rendered on. */
  readonly id: string;
  readonly label: string;
  readonly category: EffectCategory;
  /** The render contract — the renderers' only dispatch key. */
  readonly kind: EffectRenderKind;
  /**
   * Shallow override of {@link defaultParamsForKind}. Only the values that make
   * this entry distinctive are listed; everything else inherits the kind default.
   */
  readonly params?: Readonly<Record<string, number>>;
  /** Default layer length in seconds when applied without an explicit range. */
  readonly defaultDuration: number;
  readonly thumbnail: EffectThumbnail;
  /** One line, shown under the label in list density and as a tooltip. */
  readonly description: string;
  /** Free-text search terms beyond the label (synonyms, use cases). */
  readonly tags: readonly string[];
  /** Surfaced in the "Popular" shelf. */
  readonly popular?: boolean;
  /** Surfaced in the "Recommended" shelf — safe, broadly flattering defaults. */
  readonly recommended?: boolean;
}

/**
 * The catalog. 72 entries covering all 20 categories on 40 render kinds — most
 * kinds carry two or more entries because the *look* of a kind changes
 * completely with its params (a 6px and a 40px gaussian are different tools),
 * and that reuse is deliberate: it is what keeps the shader surface honest.
 */
export const EFFECT_CATALOG: readonly CatalogEffect[] = [
  // --- Blur & focus --------------------------------------------------------
  {
    id: 'soft-veil',
    label: 'Soft Veil',
    category: 'blur-focus',
    kind: 'blur-gaussian',
    params: { radius: 8 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.portrait, css: 'blur(3px)' },
    description: 'A gentle overall blur that takes the edge off a hard frame.',
    tags: ['blur', 'soft', 'gaussian', 'defocus'],
    recommended: true,
  },
  {
    id: 'deep-blur',
    label: 'Deep Blur',
    category: 'blur-focus',
    kind: 'blur-gaussian',
    params: { radius: 34 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.portrait, css: 'blur(9px)' },
    description: 'Heavy defocus — good for backgrounds, titles and reveals.',
    tags: ['blur', 'heavy', 'background', 'obscure'],
  },
  {
    id: 'motion-streak',
    label: 'Motion Streak',
    category: 'blur-focus',
    kind: 'blur-directional',
    params: { radius: 22, angle: 0 },
    defaultDuration: 1,
    thumbnail: { gradient: BASE.city, css: 'blur(4px)' },
    description: 'Directional smear that reads as speed along one axis.',
    tags: ['motion blur', 'speed', 'streak', 'directional'],
    popular: true,
  },
  {
    id: 'miniature',
    label: 'Miniature',
    category: 'blur-focus',
    kind: 'tilt-shift',
    defaultDuration: 3,
    thumbnail: { gradient: BASE.city, css: 'blur(2px) saturate(1.2)' },
    description: 'Sharp band through the middle, soft above and below.',
    tags: ['tilt shift', 'diorama', 'focus', 'band'],
  },

  // --- Glow & bloom --------------------------------------------------------
  {
    id: 'halo-bloom',
    label: 'Halo Bloom',
    category: 'glow',
    kind: 'bloom',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.warm, css: 'brightness(1.15) saturate(1.1)' },
    description: 'Light blooms out of the brightest parts of the picture.',
    tags: ['bloom', 'glow', 'highlight', 'light'],
    popular: true,
    recommended: true,
  },
  {
    id: 'angel-glow',
    label: 'Angel Glow',
    category: 'glow',
    kind: 'glow-diffuse',
    defaultDuration: 2.5,
    thumbnail: { gradient: BASE.daylight, css: 'brightness(1.12) blur(1px)' },
    description: 'An even, diffuse glow across the whole frame.',
    tags: ['glow', 'diffuse', 'soft', 'ethereal'],
  },
  {
    id: 'highlight-bleed',
    label: 'Highlight Bleed',
    category: 'glow',
    kind: 'halation',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.warm, css: 'saturate(1.2) brightness(1.08)' },
    description: 'Warm halation ringing the highlights, the way film prints do.',
    tags: ['halation', 'film', 'bleed', 'red', 'highlight'],
    recommended: true,
  },
  {
    id: 'overexposed',
    label: 'Overexposed',
    category: 'glow',
    kind: 'bloom',
    params: { threshold: 0.45, strength: 1.6, radius: 34 },
    defaultDuration: 1,
    thumbnail: { gradient: BASE.daylight, css: 'brightness(1.4) contrast(0.9)' },
    description: 'Blown-out blooming light for a hard, hot look.',
    tags: ['blown out', 'bright', 'hot', 'bloom'],
  },

  // --- Light & lens --------------------------------------------------------
  {
    id: 'golden-leak',
    label: 'Golden Leak',
    category: 'light',
    kind: 'light-leak',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.warm, css: 'saturate(1.25) brightness(1.1)' },
    description: 'Warm light spilling in from the frame edge.',
    tags: ['light leak', 'warm', 'golden', 'sun', 'flare'],
    popular: true,
    recommended: true,
  },
  {
    id: 'window-streak',
    label: 'Window Streak',
    category: 'light',
    kind: 'light-leak',
    params: { angle: 110, strength: 0.62, warmth: 0.35, position: 0.6 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.daylight, css: 'brightness(1.12)' },
    description: 'A cooler, harder shaft of light raking across the shot.',
    tags: ['light leak', 'shaft', 'cool', 'window', 'raking'],
  },
  {
    id: 'anamorphic-star',
    label: 'Anamorphic Star',
    category: 'light',
    kind: 'lens-flare',
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.city, css: 'brightness(1.15) saturate(1.15)' },
    description: 'A streaked lens flare anchored to a bright source.',
    tags: ['lens flare', 'anamorphic', 'streak', 'star', 'blue'],
    popular: true,
  },
  {
    id: 'edge-fall',
    label: 'Edge Fall',
    category: 'light',
    kind: 'vignette',
    defaultDuration: 3,
    thumbnail: { gradient: BASE.portrait, css: 'brightness(0.95) contrast(1.05)' },
    description: 'Darkened corners that pull the eye to centre frame.',
    tags: ['vignette', 'corners', 'falloff', 'darken', 'focus'],
    recommended: true,
  },

  // --- Film & cinematic ----------------------------------------------------
  {
    id: 'cinema-print',
    label: 'Cinema Print',
    category: 'film',
    kind: 'film-curve',
    defaultDuration: 4,
    thumbnail: { gradient: BASE.dusk, css: 'contrast(1.15) saturate(0.95)' },
    description: 'Split-toned contrast curve — cool shadows, warm highlights.',
    tags: ['cinematic', 'film', 'grade', 'split tone', 'contrast'],
    popular: true,
    recommended: true,
  },
  {
    id: 'teal-amber',
    label: 'Teal & Amber',
    category: 'film',
    kind: 'film-curve',
    params: { shadowTint: 185, highlightTint: 32, contrast: 0.28, strength: 0.75 },
    defaultDuration: 4,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.2) saturate(1.1) hue-rotate(-6deg)' },
    description: 'The blockbuster complement — teal shadows against amber skin.',
    tags: ['teal orange', 'blockbuster', 'grade', 'cinematic'],
    popular: true,
  },
  {
    id: 'faded-stock',
    label: 'Faded Stock',
    category: 'film',
    kind: 'film-fade',
    defaultDuration: 4,
    thumbnail: { gradient: BASE.mono, css: 'contrast(0.9) brightness(1.05) saturate(0.9)' },
    description: 'Lifted blacks and rolled highlights, like aged print stock.',
    tags: ['faded', 'matte', 'film', 'lifted blacks', 'vintage'],
    recommended: true,
  },
  {
    id: 'silver-halide',
    label: 'Silver Halide',
    category: 'film',
    kind: 'film-fade',
    params: { saturation: 0.08, lift: 0.05, rolloff: 0.5, warmth: -0.05 },
    defaultDuration: 4,
    thumbnail: { gradient: BASE.mono, css: 'grayscale(0.92) contrast(1.1)' },
    description: 'Near-monochrome with a trace of colour left in.',
    tags: ['black and white', 'monochrome', 'silver', 'desaturate'],
  },

  // --- Retro & vintage -----------------------------------------------------
  {
    id: 'polaroid-79',
    label: 'Polaroid 79',
    category: 'retro',
    kind: 'film-fade',
    params: { lift: 0.18, rolloff: 0.55, warmth: 0.35, saturation: 0.82 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'contrast(0.88) sepia(0.22) brightness(1.06)' },
    description: 'Milky, warm-shifted instant film with soft blacks.',
    tags: ['polaroid', 'instant', 'retro', '70s', 'warm', 'faded'],
    popular: true,
  },
  {
    id: 'sun-bleached',
    label: 'Sun-Bleached',
    category: 'retro',
    kind: 'film-fade',
    params: { lift: 0.12, rolloff: 0.7, warmth: 0.45, saturation: 0.62 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'saturate(0.7) brightness(1.12) sepia(0.15)' },
    description: 'Colour cooked out of the picture by years of daylight.',
    tags: ['bleached', 'washed out', 'faded', 'summer', 'retro'],
  },
  {
    id: 'super-eight',
    label: 'Super Eight',
    category: 'retro',
    kind: 'film-curve',
    params: { contrast: -0.12, shadowTint: 35, highlightTint: 45, strength: 0.8 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'sepia(0.3) contrast(0.95) brightness(1.05)' },
    description: 'Amber-cast home-movie warmth. Stack with Cine Grain for the full look.',
    tags: ['super 8', '8mm', 'home movie', 'amber', 'retro'],
    recommended: true,
  },

  // --- VHS & analog --------------------------------------------------------
  {
    id: 'tape-warp',
    label: 'Tape Warp',
    category: 'analog',
    kind: 'analog-vhs',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.3) contrast(1.05)' },
    description: 'Tracking error, chroma bleed and tape noise together.',
    tags: ['vhs', 'tape', 'analog', 'tracking', 'retro', '80s'],
    popular: true,
    recommended: true,
  },
  {
    id: 'camcorder-88',
    label: 'Camcorder 88',
    category: 'analog',
    kind: 'scanlines',
    params: { count: 240, strength: 0.42, roll: 0.3 },
    defaultDuration: 2.5,
    thumbnail: { gradient: BASE.mono, css: 'contrast(1.1) saturate(0.9)' },
    description: 'Coarse interlaced lines with a slow vertical roll.',
    tags: ['camcorder', 'interlace', 'scanline', 'analog', '80s'],
  },
  {
    id: 'signal-dropout',
    label: 'Signal Dropout',
    category: 'analog',
    kind: 'tape-dropout',
    defaultDuration: 1,
    thumbnail: { gradient: BASE.neon, css: 'contrast(1.15)' },
    description: 'Horizontal streaks where the tape loses the signal.',
    tags: ['dropout', 'tape', 'streak', 'damage', 'analog'],
  },
  {
    id: 'crt-lines',
    label: 'CRT Lines',
    category: 'analog',
    kind: 'scanlines',
    params: { count: 720, strength: 0.28, roll: 0.05 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.08) brightness(0.97)' },
    description: 'Fine, stable phosphor lines like a studio monitor.',
    tags: ['crt', 'monitor', 'scanline', 'fine', 'phosphor'],
  },

  // --- Glitch & digital ----------------------------------------------------
  {
    id: 'block-shift',
    label: 'Block Shift',
    category: 'glitch',
    kind: 'glitch-block',
    defaultDuration: 0.8,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.35) contrast(1.1)' },
    description: 'Rectangular regions tear sideways out of position.',
    tags: ['glitch', 'block', 'tear', 'digital', 'corrupt'],
    popular: true,
    recommended: true,
  },
  {
    id: 'data-smear',
    label: 'Data Smear',
    category: 'glitch',
    kind: 'datamosh',
    defaultDuration: 1.2,
    thumbnail: { gradient: BASE.dusk, css: 'saturate(1.2) blur(1px)' },
    description: 'Compression artefacts dragged forward through time.',
    tags: ['datamosh', 'compression', 'smear', 'glitch', 'artefact'],
    popular: true,
  },
  {
    id: 'pixel-drift',
    label: 'Pixel Drift',
    category: 'glitch',
    kind: 'pixel-sort',
    defaultDuration: 1,
    thumbnail: { gradient: BASE.dusk, css: 'saturate(1.15)' },
    description: 'Bright pixels bleed along rows in sorted runs.',
    tags: ['pixel sort', 'drift', 'glitch', 'bleed'],
  },
  {
    id: 'hard-corrupt',
    label: 'Hard Corrupt',
    category: 'glitch',
    kind: 'glitch-block',
    params: { density: 0.75, size: 0.6, displace: 0.85, speed: 2 },
    defaultDuration: 0.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.5) contrast(1.2)' },
    description: 'Violent, fast corruption for hard cuts and impacts.',
    tags: ['glitch', 'corrupt', 'violent', 'hard', 'impact'],
  },
  {
    id: 'scan-tear',
    label: 'Scan Tear',
    category: 'glitch',
    kind: 'glitch-block',
    params: { density: 0.3, size: 0.9, displace: 0.35, speed: 0.6 },
    defaultDuration: 1.2,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.1)' },
    description: 'Wide, slow horizontal tears across the whole frame.',
    tags: ['tear', 'scan', 'slow', 'glitch', 'wide'],
  },

  // --- Shake & impact ------------------------------------------------------
  {
    id: 'impact-shake',
    label: 'Impact Shake',
    category: 'motion',
    kind: 'shake',
    defaultDuration: 0.5,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.1)' },
    description: 'A sharp camera hit — lands beat changes and cuts.',
    tags: ['shake', 'impact', 'hit', 'beat', 'punch'],
    popular: true,
    recommended: true,
  },
  {
    id: 'handheld',
    label: 'Handheld',
    category: 'motion',
    kind: 'shake',
    params: { amplitude: 0.12, frequency: 3.2, rotation: 0.1 },
    defaultDuration: 4,
    thumbnail: { gradient: BASE.portrait },
    description: 'Subtle organic drift that makes a locked-off shot breathe.',
    tags: ['handheld', 'organic', 'subtle', 'drift', 'documentary'],
    recommended: true,
  },
  {
    id: 'earthquake',
    label: 'Earthquake',
    category: 'motion',
    kind: 'shake',
    params: { amplitude: 0.8, frequency: 14, rotation: 0.45 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.15)' },
    description: 'Heavy sustained shaking with rotation.',
    tags: ['earthquake', 'heavy', 'violent', 'shake', 'rumble'],
  },
  {
    id: 'rotor-jitter',
    label: 'Rotor Jitter',
    category: 'motion',
    kind: 'shake',
    params: { amplitude: 0.2, frequency: 18, rotation: 0.7 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.mono },
    description: 'Fast rotational vibration, more twist than travel.',
    tags: ['jitter', 'rotate', 'vibrate', 'fast', 'engine'],
  },

  // --- Zoom & directional --------------------------------------------------
  {
    id: 'punch-in',
    label: 'Punch In',
    category: 'zoom',
    kind: 'zoom-punch',
    defaultDuration: 0.6,
    thumbnail: { gradient: BASE.portrait, css: 'contrast(1.05)' },
    description: 'Quick scale-up and release to emphasise a moment.',
    tags: ['punch in', 'zoom', 'emphasis', 'beat', 'scale'],
    popular: true,
    recommended: true,
  },
  {
    id: 'slam-zoom',
    label: 'Slam Zoom',
    category: 'zoom',
    kind: 'zoom-punch',
    params: { amount: 0.65, attack: 0.06, hold: 0.1 },
    defaultDuration: 0.4,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.12)' },
    description: 'Aggressive snap zoom for hard emphasis.',
    tags: ['slam', 'snap zoom', 'aggressive', 'fast', 'impact'],
    popular: true,
  },
  {
    id: 'whip-across',
    label: 'Whip Across',
    category: 'zoom',
    kind: 'whip-pan',
    defaultDuration: 0.4,
    thumbnail: { gradient: BASE.city, css: 'blur(4px)' },
    description: 'A blurred lateral throw — pairs with a cut for a whip transition.',
    tags: ['whip pan', 'swish', 'transition', 'lateral', 'blur'],
  },
  {
    id: 'speed-rush',
    label: 'Speed Rush',
    category: 'zoom',
    kind: 'blur-radial',
    defaultDuration: 0.8,
    thumbnail: { gradient: BASE.neon, css: 'blur(2px) saturate(1.2)' },
    description: 'Radial streaks rushing out from centre frame.',
    tags: ['radial blur', 'speed', 'rush', 'warp', 'zoom blur'],
    popular: true,
  },

  // --- Chromatic -----------------------------------------------------------
  {
    id: 'prism-edge',
    label: 'Prism Edge',
    category: 'chromatic',
    kind: 'chroma-shift',
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.3)' },
    description: 'Colour fringing that grows toward the frame edges.',
    tags: ['chromatic aberration', 'prism', 'fringe', 'lens'],
    recommended: true,
  },
  {
    id: 'rgb-tear',
    label: 'RGB Tear',
    category: 'chromatic',
    kind: 'rgb-split',
    defaultDuration: 1,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.4) contrast(1.1)' },
    description: 'Red, green and blue pulled apart along one axis.',
    tags: ['rgb split', 'channel', 'separation', 'glitch', '3d'],
    popular: true,
  },
  {
    id: 'colour-fringe',
    label: 'Colour Fringe',
    category: 'chromatic',
    kind: 'chroma-shift',
    params: { amount: 0.12, angle: 0 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.daylight },
    description: 'Barely-there aberration for subtle lens realism.',
    tags: ['subtle', 'fringe', 'lens', 'realism', 'aberration'],
  },

  // --- Dreamy & soft -------------------------------------------------------
  {
    id: 'daydream',
    label: 'Daydream',
    category: 'dreamy',
    kind: 'soft-focus',
    defaultDuration: 3,
    thumbnail: { gradient: BASE.dusk, css: 'blur(2px) brightness(1.08) saturate(1.05)' },
    description: 'Soft bloom over a sharp core — flattering and hazy.',
    tags: ['dreamy', 'soft focus', 'haze', 'romantic', 'glow'],
    popular: true,
    recommended: true,
  },
  {
    id: 'milk-glass',
    label: 'Milk Glass',
    category: 'dreamy',
    kind: 'soft-focus',
    params: { radius: 44, mix: 0.78, lift: 0.14 },
    defaultDuration: 2.5,
    thumbnail: { gradient: BASE.daylight, css: 'blur(5px) brightness(1.12)' },
    description: 'Heavier diffusion, like shooting through frosted glass.',
    tags: ['frosted', 'diffusion', 'milky', 'soft', 'dreamy'],
  },
  {
    id: 'bloom-haze',
    label: 'Bloom Haze',
    category: 'dreamy',
    kind: 'glow-diffuse',
    params: { strength: 0.32, radius: 40 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'brightness(1.1) blur(1px)' },
    description: 'Wide, low glow that lifts the whole image gently.',
    tags: ['haze', 'atmosphere', 'glow', 'soft', 'lift'],
  },

  // --- Distortion & warp ---------------------------------------------------
  {
    id: 'ripple-tide',
    label: 'Ripple Tide',
    category: 'warp',
    kind: 'ripple',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.daylight, css: 'saturate(1.1)' },
    description: 'Rolling waves travelling across the picture.',
    tags: ['ripple', 'wave', 'water', 'warp', 'liquid'],
    recommended: true,
  },
  {
    id: 'heat-haze',
    label: 'Heat Haze',
    category: 'warp',
    kind: 'ripple',
    params: { amplitude: 0.09, frequency: 28, speed: 1.6 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'saturate(1.15) brightness(1.04)' },
    description: 'Fine shimmering distortion like hot air over tarmac.',
    tags: ['heat', 'shimmer', 'haze', 'desert', 'subtle'],
  },
  {
    id: 'barrel-push',
    label: 'Barrel Push',
    category: 'warp',
    kind: 'barrel-warp',
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.city },
    description: 'Bulges the centre outward for a pressurised look.',
    tags: ['barrel', 'bulge', 'distort', 'warp', 'push'],
  },

  // --- Pixel & halftone ----------------------------------------------------
  {
    id: 'mosaic-block',
    label: 'Mosaic Block',
    category: 'pixel',
    kind: 'mosaic',
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon },
    description: 'Quantises the frame into flat colour cells.',
    tags: ['mosaic', 'pixelate', 'censor', 'block', 'blur'],
    popular: true,
    recommended: true,
  },
  {
    id: 'chunky-pixel',
    label: 'Chunky Pixel',
    category: 'pixel',
    kind: 'mosaic',
    params: { size: 56 },
    defaultDuration: 1,
    thumbnail: { gradient: BASE.dusk },
    description: 'Very large cells for an 8-bit, low-resolution read.',
    tags: ['8 bit', 'pixel art', 'retro game', 'chunky', 'lo-fi'],
  },
  {
    id: 'newsprint',
    label: 'Newsprint',
    category: 'pixel',
    kind: 'halftone',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.mono, css: 'contrast(1.2) grayscale(0.5)' },
    description: 'Dot-screen halftone like a printed newspaper.',
    tags: ['halftone', 'dots', 'print', 'newspaper', 'comic'],
    popular: true,
  },
  {
    id: 'retro-dither',
    label: 'Retro Dither',
    category: 'pixel',
    kind: 'dither',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.mono, css: 'contrast(1.3)' },
    description: 'Ordered dithering down to a few colour levels.',
    tags: ['dither', 'bayer', 'retro', 'levels', 'lo-fi'],
  },

  // --- Grain & texture -----------------------------------------------------
  {
    id: 'cine-grain',
    label: 'Cine Grain',
    category: 'texture',
    kind: 'grain',
    defaultDuration: 4,
    thumbnail: { gradient: BASE.mono, css: 'contrast(1.05)' },
    description: 'Fine animated grain that gives digital footage some tooth.',
    tags: ['grain', 'film', 'texture', 'noise', 'organic'],
    popular: true,
    recommended: true,
  },
  {
    id: 'heavy-grain',
    label: 'Heavy Grain',
    category: 'texture',
    kind: 'grain',
    params: { amount: 0.72, size: 2.4 },
    defaultDuration: 3,
    thumbnail: { gradient: BASE.mono, css: 'contrast(1.1)' },
    description: 'Coarse, pushed-stock grain for a gritty look.',
    tags: ['grain', 'gritty', 'coarse', 'pushed', 'grunge'],
  },
  {
    id: 'dust-and-scratch',
    label: 'Dust & Scratch',
    category: 'texture',
    kind: 'dust-scratches',
    defaultDuration: 3,
    thumbnail: { gradient: BASE.warm, css: 'sepia(0.15) contrast(1.05)' },
    description: 'Specks and vertical scratches like a worn print.',
    tags: ['dust', 'scratches', 'old film', 'damage', 'wear'],
    recommended: true,
  },
  {
    id: 'archive-wear',
    label: 'Archive Wear',
    category: 'texture',
    kind: 'dust-scratches',
    params: { density: 0.72, scratches: 0.68, speed: 1.4 },
    defaultDuration: 2.5,
    thumbnail: { gradient: BASE.mono, css: 'sepia(0.25) contrast(1.12)' },
    description: 'Badly-kept archive footage — heavy dirt and damage.',
    tags: ['archive', 'damaged', 'found footage', 'heavy', 'old'],
  },

  // --- Party & neon --------------------------------------------------------
  {
    id: 'neon-trace',
    label: 'Neon Trace',
    category: 'party',
    kind: 'neon-edge',
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.5) contrast(1.15)' },
    description: 'Contours lit up in saturated neon over a dark frame.',
    tags: ['neon', 'edge', 'glow', 'outline', 'cyberpunk'],
    popular: true,
    recommended: true,
  },
  {
    id: 'club-strobe',
    label: 'Club Strobe',
    category: 'party',
    kind: 'strobe-color',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.6)' },
    description: 'Alternating colour washes on a steady beat.',
    tags: ['strobe', 'club', 'party', 'colour', 'beat', 'rave'],
    popular: true,
  },
  {
    id: 'laser-edge',
    label: 'Laser Edge',
    category: 'party',
    kind: 'neon-edge',
    params: { threshold: 0.16, hue: 150, strength: 0.9, thickness: 0.14 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.7) contrast(1.2)' },
    description: 'Thin, intense green edge light like a scanning laser.',
    tags: ['laser', 'thin', 'green', 'scan', 'neon'],
  },
  {
    id: 'rave-pulse',
    label: 'Rave Pulse',
    category: 'party',
    kind: 'strobe-color',
    params: { frequency: 14, strength: 0.78, hueA: 320, hueB: 90 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.8) contrast(1.15)' },
    description: 'Fast, high-contrast colour flashing.',
    tags: ['rave', 'fast', 'pulse', 'strobe', 'energetic'],
  },

  // --- Comic & stylised ----------------------------------------------------
  {
    id: 'poster-print',
    label: 'Poster Print',
    category: 'comic',
    kind: 'posterize',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.warm, css: 'saturate(1.4) contrast(1.25)' },
    description: 'Flattens tones into bold poster bands.',
    tags: ['posterize', 'poster', 'flat', 'bold', 'screenprint'],
    recommended: true,
  },
  {
    id: 'ink-sketch',
    label: 'Ink Sketch',
    category: 'comic',
    kind: 'sketch',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.mono, css: 'grayscale(1) contrast(1.4)' },
    description: 'Renders the frame as pen-and-ink line work.',
    tags: ['sketch', 'ink', 'line art', 'drawing', 'pencil'],
    popular: true,
  },
  {
    id: 'cel-shade',
    label: 'Cel Shade',
    category: 'comic',
    kind: 'posterize',
    params: { levels: 3, saturation: 1.5 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.6) contrast(1.3)' },
    description: 'Three-tone flat shading for an animated-cel read.',
    tags: ['cel', 'anime', 'cartoon', 'flat', 'toon'],
  },

  // --- Edge & outline -----------------------------------------------------
  {
    id: 'edge-light',
    label: 'Edge Light',
    category: 'outline',
    kind: 'edge-outline',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.city, css: 'contrast(1.2)' },
    description: 'Traces contours and lights them over the original.',
    tags: ['edge detect', 'outline', 'contour', 'highlight'],
    recommended: true,
  },
  {
    id: 'contour-glow',
    label: 'Contour Glow',
    category: 'outline',
    kind: 'edge-outline',
    params: { threshold: 0.18, thickness: 0.72, mix: 0.9 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.dusk, css: 'contrast(1.25) brightness(1.05)' },
    description: 'Thick, dominant outlines that read almost graphic.',
    tags: ['thick', 'outline', 'graphic', 'contour', 'bold'],
  },

  // --- Fisheye & lens ------------------------------------------------------
  {
    id: 'fisheye-wide',
    label: 'Fisheye Wide',
    category: 'lens-deform',
    kind: 'fisheye',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.city },
    description: 'Ultra-wide lens curvature bowing the frame outward.',
    tags: ['fisheye', 'wide', 'lens', 'gopro', 'action cam'],
    popular: true,
    recommended: true,
  },
  {
    id: 'bubble-lens',
    label: 'Bubble Lens',
    category: 'lens-deform',
    kind: 'fisheye',
    params: { amount: 0.92, zoom: 1.18 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.neon },
    description: 'Extreme spherical warp — the frame becomes a bubble.',
    tags: ['bubble', 'extreme', 'sphere', 'fisheye', 'dome'],
  },
  {
    id: 'lens-pinch',
    label: 'Lens Pinch',
    category: 'lens-deform',
    kind: 'barrel-warp',
    params: { amount: -0.5 },
    defaultDuration: 1.5,
    thumbnail: { gradient: BASE.portrait },
    description: 'Pulls the centre inward for a concave, pinched frame.',
    tags: ['pinch', 'concave', 'pincushion', 'inward', 'lens'],
  },

  // --- Flash & strobe ------------------------------------------------------
  {
    id: 'white-flash',
    label: 'White Flash',
    category: 'strobe',
    kind: 'flash',
    defaultDuration: 0.6,
    thumbnail: { gradient: BASE.daylight, css: 'brightness(1.35)' },
    description: 'Rhythmic white blowouts — great on a cut or a beat.',
    tags: ['flash', 'white', 'blowout', 'beat', 'transition'],
    popular: true,
    recommended: true,
  },
  {
    id: 'camera-pop',
    label: 'Camera Pop',
    category: 'strobe',
    kind: 'flash',
    params: { frequency: 11, strength: 0.85, duty: 0.12 },
    defaultDuration: 1,
    thumbnail: { gradient: BASE.mono, css: 'brightness(1.3) contrast(1.1)' },
    description: 'Short, hard flashes like a burst of stills photography.',
    tags: ['camera flash', 'paparazzi', 'burst', 'pop', 'fast'],
  },
  {
    id: 'bulb-flicker',
    label: 'Bulb Flicker',
    category: 'strobe',
    kind: 'flicker',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.warm, css: 'brightness(0.95)' },
    description: 'Irregular brightness wobble like a failing bulb.',
    tags: ['flicker', 'bulb', 'unstable', 'horror', 'irregular'],
    recommended: true,
  },

  // --- Mirror & split ------------------------------------------------------
  {
    id: 'mirror-split',
    label: 'Mirror Split',
    category: 'mirror',
    kind: 'mirror',
    defaultDuration: 2,
    thumbnail: { gradient: BASE.portrait },
    description: 'Reflects one half of the frame across the centre.',
    tags: ['mirror', 'split screen', 'reflect', 'symmetry'],
    popular: true,
    recommended: true,
  },
  {
    id: 'vertical-mirror',
    label: 'Vertical Mirror',
    category: 'mirror',
    kind: 'mirror',
    params: { axis: 2, offset: 0.5 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.daylight },
    description: 'Reflects top over bottom for a waterline effect.',
    tags: ['mirror', 'vertical', 'waterline', 'reflect', 'flip'],
  },
  {
    id: 'kaleidoscope',
    label: 'Kaleidoscope',
    category: 'mirror',
    kind: 'kaleidoscope',
    defaultDuration: 2.5,
    thumbnail: { gradient: BASE.neon, css: 'saturate(1.4)' },
    description: 'Folds the frame into radial mirrored wedges.',
    tags: ['kaleidoscope', 'radial', 'symmetry', 'wedge', 'psychedelic'],
    popular: true,
  },
  {
    id: 'prism-fold',
    label: 'Prism Fold',
    category: 'mirror',
    kind: 'kaleidoscope',
    params: { segments: 14, rotation: 20, zoom: 1.25 },
    defaultDuration: 2,
    thumbnail: { gradient: BASE.dusk, css: 'saturate(1.35)' },
    description: 'Many fine wedges for a dense, jewel-like fold.',
    tags: ['prism', 'dense', 'fold', 'jewel', 'radial'],
  },
];

/** Fast id lookup. */
const BY_ID = new Map(EFFECT_CATALOG.map((effect) => [effect.id, effect]));

export function findEffect(id: string): CatalogEffect | undefined {
  return BY_ID.get(id);
}

/**
 * The full, resolved param bag for a catalog entry — kind defaults with the
 * entry's overrides applied. This is what a freshly-applied layer stores, and it
 * is deliberately *complete*: a layer that carried only the overrides would
 * change appearance if a kind's defaults were ever retuned, which would silently
 * alter already-saved projects.
 */
export function resolveParams(effect: CatalogEffect): Record<string, number> {
  return { ...defaultParamsForKind(effect.kind), ...(effect.params ?? {}) };
}

export function effectsInCategory(category: EffectCategory): readonly CatalogEffect[] {
  return EFFECT_CATALOG.filter((effect) => effect.category === category);
}

export const POPULAR_EFFECTS: readonly CatalogEffect[] = EFFECT_CATALOG.filter((e) => e.popular);
export const RECOMMENDED_EFFECTS: readonly CatalogEffect[] = EFFECT_CATALOG.filter(
  (e) => e.recommended,
);

/**
 * Search across label, description and tags.
 *
 * Tags carry the synonyms an editor actually types ("teal orange", "8mm",
 * "censor") which the labels deliberately do not, so a query matches intent
 * rather than only our naming.
 */
export function searchEffects(query: string): readonly CatalogEffect[] {
  const q = query.trim().toLowerCase();
  if (q === '') return EFFECT_CATALOG;
  return EFFECT_CATALOG.filter(
    (effect) =>
      effect.label.toLowerCase().includes(q) ||
      effect.description.toLowerCase().includes(q) ||
      effect.tags.some((tag) => tag.includes(q)),
  );
}
