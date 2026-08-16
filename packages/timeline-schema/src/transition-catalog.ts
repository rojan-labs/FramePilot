/**
 * @framepilot/timeline-schema/transition-catalog — the canonical transition
 * catalog (`plan/ADVANCED-TRANSITION-SYSTEM.md`).
 *
 * Every entry is PURE DATA: a name, a browsable category, one
 * {@link TransitionRenderKind} from the closed enum, and a shallow override of
 * that kind's defaults. Neither the Python compiler nor the WebGL preview may
 * ever branch on an entry `id` — the same extensibility contract the caption
 * templates (ADR 0069) and the effect catalog (ADR 0088) established.
 *
 * An entry's `id` IS the value stored as `kind` in the transition effect's
 * params, which is why the seven ids that predate this file
 * (`fade`, `cross-dissolve`, `push`, `slide`, `zoom`, `blur`, `wipe`) appear here
 * unchanged, mapped onto the render kinds that reproduce exactly what they
 * already do. An old project opens with its transitions intact and renders
 * identically; nothing needed a migration.
 *
 * ORIGINALITY: every name, description, category and thumbnail here is original
 * to FramePilot. Thumbnails are two *generated* gradients — an outgoing and an
 * incoming synthetic frame — that the entry's own real shader then transitions
 * between, so the catalog ships no third-party preview media and nothing that
 * needs licensing. Hovering a tile runs the same pass the export will run.
 *
 * Cross-language parity: `scripts/generate-json-schema.mjs` exports this catalog
 * to `schema/transition-catalog.json` and copies it into the Python engine; drift
 * is guarded on both sides (`transition-catalog.test.ts` + the engine's
 * `test_transition_catalog.py`).
 */
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  defaultTransitionParams,
  type TransitionRenderKind,
} from './transition-params.js';

/**
 * Browsable groups — the category rail in the transitions panel. Order here is
 * the order shown, and it runs from the transitions every editor already knows to
 * the ones they came here to find.
 */
export type TransitionCategory =
  | 'basic'
  | 'slide'
  | 'zoom'
  | 'motion'
  | 'wipe'
  | 'creative'
  | 'spatial';

export interface TransitionCategoryMeta {
  readonly id: TransitionCategory;
  readonly label: string;
  /** One line, shown as the category's header and in its empty state. */
  readonly blurb: string;
}

export const TRANSITION_CATEGORIES: readonly TransitionCategoryMeta[] = [
  { id: 'basic', label: 'Basic', blurb: 'The cuts and dissolves every edit is built from.' },
  { id: 'slide', label: 'Slide & Push', blurb: 'One shot moves the other out of frame.' },
  { id: 'zoom', label: 'Zoom', blurb: 'Push in, pull out, land on the next shot.' },
  {
    id: 'motion',
    label: 'Blur & Motion',
    blurb: 'Whips, smears and camera energy across the cut.',
  },
  { id: 'wipe', label: 'Wipe', blurb: 'An edge or a shape reveals the next shot.' },
  {
    id: 'creative',
    label: 'Creative',
    blurb: 'Glitch, light, ink and liquid — the ones people notice.',
  },
  { id: 'spatial', label: '3D & Spatial', blurb: 'The frame becomes a surface in space.' },
];

/**
 * Synthetic thumbnail frames — an original gradient pair the real transition pass
 * runs between, so a tile shows an accurate result with no bundled media.
 *
 * Two gradients rather than one because a transition is a *relationship*: a wipe
 * on a single image is invisible. Pairs are chosen to differ in both hue and
 * value, which is what makes an edge, a dissolve and a displacement all legible
 * at 96px.
 */
export interface TransitionThumbnail {
  /** The outgoing frame. */
  readonly from: string;
  /** The incoming frame. */
  readonly to: string;
}

/** Reusable original gradient frames. */
const SHOT = {
  dawn: 'linear-gradient(150deg,#f7dcb4 0%,#e08a5a 55%,#6b3a2e 100%)',
  dusk: 'linear-gradient(160deg,#3a2450 0%,#a45a7c 50%,#f2c078 100%)',
  city: 'linear-gradient(155deg,#16273f 0%,#3f5f8a 45%,#efa96b 100%)',
  sea: 'linear-gradient(150deg,#e2f2f5 0%,#5fa8bf 55%,#123b52 100%)',
  forest: 'linear-gradient(150deg,#e9f1c9 0%,#5f9a52 50%,#1d3524 100%)',
  neon: 'linear-gradient(135deg,#2a0d3d 0%,#a2129b 50%,#26d0e0 100%)',
  studio: 'linear-gradient(150deg,#f4f4f2 0%,#b9b6ae 50%,#2e2b28 100%)',
  ember: 'linear-gradient(150deg,#ffe9c0 0%,#f26f3d 50%,#4a1414 100%)',
} as const;

const pair = (from: string, to: string): TransitionThumbnail => ({ from, to });

/**
 * One browsable transition.
 *
 * `params`, `direction`, `intensity`, `softness` and `easing` are *overrides*:
 * absent means "the render kind's own default", which is what keeps an entry to
 * the two or three numbers that make it itself.
 */
export interface CatalogTransition {
  /** Stored verbatim as the transition effect's `kind`. Stable — never rename. */
  readonly id: string;
  readonly label: string;
  readonly category: TransitionCategory;
  readonly renderKind: TransitionRenderKind;
  /** Shallow override of {@link defaultTransitionParams}. */
  readonly params?: Readonly<Record<string, number>>;
  /** Overrides the render kind's default direction (must be one it accepts). */
  readonly direction?: string;
  /** 0–1 travel from rest. Absent ⇒ 1 (full strength). */
  readonly intensity?: number;
  /** 0–1 mask feather. Absent ⇒ the engine default (0.2 ⇒ a 5 % frame feather). */
  readonly softness?: number;
  /** Absent ⇒ `linear`, which is what this engine has always used. */
  readonly easing?: string;
  /** Seconds this transition is added with when nothing else is specified. */
  readonly defaultDuration: number;
  readonly thumbnail: TransitionThumbnail;
  /** One line, shown under the label and as the tile's tooltip. */
  readonly description: string;
  /** Free-text search terms beyond the label — synonyms, feel, use cases. */
  readonly tags: readonly string[];
  /** Surfaced in the "Popular" shelf. */
  readonly popular?: boolean;
  /** Surfaced in the "Recommended" shelf — safe on almost any cut. */
  readonly recommended?: boolean;
  /**
   * A hard cut: picking this REMOVES the transition rather than adding one.
   * Exactly one entry carries it, and it is first in the catalog because "take it
   * back off" is the most common thing a user wants after trying three.
   */
  readonly isCut?: boolean;
}

/**
 * The catalog. 77 transitions (plus the hard cut) across 7 categories, on 29
 * render kinds.
 *
 * Most kinds carry several entries because the *look* of a kind changes
 * completely with its params — a 0.25s 2.4× punch and a 0.8s 1.25× drift are
 * different tools even though both are `zoom`. That reuse is the point: it is
 * what keeps the shader surface small enough to keep honest across two renderers.
 */
export const TRANSITION_CATALOG: readonly CatalogTransition[] = [
  // --- Basic ---------------------------------------------------------------
  {
    id: 'cut',
    label: 'Cut',
    category: 'basic',
    renderKind: 'dissolve',
    defaultDuration: 0,
    thumbnail: pair(SHOT.dawn, SHOT.city),
    description: 'A hard cut — removes any transition at this edit point.',
    tags: ['none', 'remove', 'hard', 'straight'],
    isCut: true,
  },
  {
    id: 'cross-dissolve',
    label: 'Cross Dissolve',
    category: 'basic',
    renderKind: 'dissolve',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.forest, SHOT.sea),
    description: 'The classic blend. Softens a cut without drawing attention.',
    tags: ['dissolve', 'blend', 'mix', 'classic', 'smooth', 'cinematic'],
    popular: true,
    recommended: true,
  },
  {
    id: 'fade',
    label: 'Fade',
    category: 'basic',
    renderKind: 'dissolve',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.studio, SHOT.dawn),
    description: 'The incoming shot rises out of what is beneath it.',
    tags: ['fade', 'in', 'gentle', 'open', 'smooth'],
    recommended: true,
  },
  {
    id: 'soft-dissolve',
    label: 'Soft Dissolve',
    category: 'basic',
    renderKind: 'dissolve',
    params: { hold: 0.45 },
    easing: 'ease-in-out',
    defaultDuration: 1.2,
    thumbnail: pair(SHOT.sea, SHOT.forest),
    description: 'A long dissolve that lingers at the halfway blend.',
    tags: ['slow', 'dreamy', 'cinematic', 'linger', 'documentary'],
  },
  {
    id: 'fade-to-black',
    label: 'Fade to Black',
    category: 'basic',
    renderKind: 'dip-color',
    params: { red: 0, green: 0, blue: 0, hold: 0 },
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.city, SHOT.dusk),
    description: 'Down to black, then up into the next shot.',
    tags: ['black', 'fade out', 'end', 'chapter', 'scene break'],
    recommended: true,
  },
  {
    id: 'fade-to-white',
    label: 'Fade to White',
    category: 'basic',
    renderKind: 'dip-color',
    params: { red: 1, green: 1, blue: 1, hold: 0 },
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.dawn, SHOT.studio),
    description: 'Up to white, then back down into the next shot.',
    tags: ['white', 'bright', 'clean', 'dream', 'memory'],
  },
  {
    id: 'dip-to-black',
    label: 'Dip to Black',
    category: 'basic',
    renderKind: 'dip-color',
    params: { red: 0, green: 0, blue: 0, hold: 0.4 },
    defaultDuration: 0.9,
    thumbnail: pair(SHOT.dusk, SHOT.city),
    description: 'Holds on black long enough to feel like time passed.',
    tags: ['black', 'dip', 'time passing', 'chapter', 'pause'],
  },
  {
    id: 'dip-to-white',
    label: 'Dip to White',
    category: 'basic',
    renderKind: 'dip-color',
    params: { red: 1, green: 1, blue: 1, hold: 0.4 },
    defaultDuration: 0.9,
    thumbnail: pair(SHOT.studio, SHOT.sea),
    description: 'Holds on white — a clean break between two ideas.',
    tags: ['white', 'dip', 'clean', 'break', 'bright'],
  },

  // --- Slide & Push --------------------------------------------------------
  {
    id: 'push',
    label: 'Push Left',
    category: 'slide',
    renderKind: 'slide',
    direction: 'left',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.city, SHOT.forest),
    description: 'The next shot shoves this one out to the left.',
    tags: ['push', 'left', 'slide', 'move', 'shove'],
    popular: true,
  },
  {
    id: 'push-right',
    label: 'Push Right',
    category: 'slide',
    renderKind: 'slide',
    direction: 'right',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.forest, SHOT.city),
    description: 'The next shot shoves this one out to the right.',
    tags: ['push', 'right', 'slide', 'move', 'back'],
  },
  {
    id: 'push-up',
    label: 'Push Up',
    category: 'slide',
    renderKind: 'slide',
    direction: 'up',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dawn, SHOT.dusk),
    description: 'The next shot rises from below and lifts this one away.',
    tags: ['push', 'up', 'rise', 'vertical', 'reels'],
  },
  {
    id: 'push-down',
    label: 'Push Down',
    category: 'slide',
    renderKind: 'slide',
    direction: 'down',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dusk, SHOT.dawn),
    description: 'The next shot drops in from above.',
    tags: ['push', 'down', 'drop', 'vertical'],
  },
  {
    id: 'slide',
    label: 'Slide Up',
    category: 'slide',
    renderKind: 'slide',
    direction: 'up',
    params: { distance: 1 },
    easing: 'ease-out',
    defaultDuration: 0.45,
    thumbnail: pair(SHOT.sea, SHOT.neon),
    description: 'The next shot slides up over this one and settles.',
    tags: ['slide', 'up', 'over', 'vertical', 'social'],
  },
  {
    id: 'slide-left',
    label: 'Slide Left',
    category: 'slide',
    renderKind: 'slide',
    direction: 'left',
    easing: 'ease-out',
    defaultDuration: 0.45,
    thumbnail: pair(SHOT.neon, SHOT.sea),
    description: 'The next shot slides in from the right and settles.',
    tags: ['slide', 'left', 'over', 'lateral'],
  },
  {
    id: 'slide-right',
    label: 'Slide Right',
    category: 'slide',
    renderKind: 'slide',
    direction: 'right',
    easing: 'ease-out',
    defaultDuration: 0.45,
    thumbnail: pair(SHOT.studio, SHOT.ember),
    description: 'The next shot slides in from the left and settles.',
    tags: ['slide', 'right', 'over', 'lateral'],
  },
  {
    id: 'slide-down',
    label: 'Slide Down',
    category: 'slide',
    renderKind: 'slide',
    direction: 'down',
    easing: 'ease-out',
    defaultDuration: 0.45,
    thumbnail: pair(SHOT.ember, SHOT.studio),
    description: 'The next shot drops in from above and settles.',
    tags: ['slide', 'down', 'drop', 'vertical'],
  },
  {
    id: 'split-slide',
    label: 'Split Slide',
    category: 'slide',
    renderKind: 'slide',
    direction: 'left',
    params: { slices: 2, stagger: 0 },
    easing: 'ease-out',
    defaultDuration: 0.55,
    thumbnail: pair(SHOT.city, SHOT.neon),
    description: 'The frame arrives in two halves from opposite sides.',
    tags: ['split', 'halves', 'two', 'slide', 'graphic'],
  },
  {
    id: 'multi-slide',
    label: 'Multi Slide',
    category: 'slide',
    renderKind: 'slide',
    direction: 'left',
    params: { slices: 7, stagger: 0.55 },
    easing: 'ease-out',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.neon, SHOT.ember),
    description: 'Bands sweep in one after another from alternating sides.',
    tags: ['bands', 'stripes', 'stagger', 'graphic', 'energetic'],
  },

  // --- Zoom ----------------------------------------------------------------
  {
    id: 'zoom',
    label: 'Zoom In',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.forest, SHOT.dawn),
    description: 'The next shot lands from oversized down to frame.',
    tags: ['zoom', 'in', 'punch', 'scale', 'push in'],
    popular: true,
  },
  {
    id: 'zoom-out',
    label: 'Zoom Out',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'out',
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.dawn, SHOT.forest),
    description: 'The next shot grows in from small.',
    tags: ['zoom', 'out', 'pull', 'reveal', 'scale'],
  },
  {
    id: 'smooth-zoom',
    label: 'Smooth Zoom',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    params: { scaleFrom: 1.22 },
    easing: 'ease-in-out',
    defaultDuration: 0.8,
    thumbnail: pair(SHOT.sea, SHOT.studio),
    description: 'A gentle drift in — barely there, but the cut stops feeling hard.',
    tags: ['smooth', 'gentle', 'subtle', 'talking head', 'cinematic', 'social media'],
    recommended: true,
  },
  {
    id: 'punch-zoom',
    label: 'Punch Zoom',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    params: { scaleFrom: 2.4 },
    easing: 'ease-out',
    defaultDuration: 0.22,
    thumbnail: pair(SHOT.ember, SHOT.neon),
    description: 'A hard, fast punch onto the beat.',
    tags: ['punch', 'fast', 'beat', 'hit', 'energetic', 'music'],
    popular: true,
  },
  {
    id: 'centre-zoom',
    label: 'Centre Zoom',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    params: { scaleFrom: 3.4 },
    easing: 'ease-in-out',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.neon, SHOT.city),
    description: 'Rushes out of the centre of the frame at full force.',
    tags: ['centre', 'center', 'rush', 'big', 'dramatic'],
  },
  {
    id: 'directional-zoom',
    label: 'Directional Zoom',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    params: { scaleFrom: 1.9, centreX: 0.22, centreY: 0.5 },
    easing: 'ease-out',
    defaultDuration: 0.45,
    thumbnail: pair(SHOT.city, SHOT.dusk),
    description: 'Zooms towards one side, so the move reads as travel.',
    tags: ['directional', 'off centre', 'lead', 'travel', 'left'],
  },
  {
    id: 'lens-zoom',
    label: 'Lens Zoom',
    category: 'zoom',
    renderKind: 'zoom',
    direction: 'in',
    params: { scaleFrom: 1.8, rotate: 0.045 },
    easing: 'ease-out',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dusk, SHOT.ember),
    description: 'A zoom with a touch of roll, like a hand-held lens pull.',
    tags: ['lens', 'roll', 'handheld', 'organic', 'twist'],
  },
  {
    id: 'zoom-blur',
    label: 'Zoom Blur',
    category: 'zoom',
    renderKind: 'blur-radial',
    direction: 'in',
    params: { strength: 0.55, mode: 0 },
    easing: 'ease-out',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.ember, SHOT.dawn),
    description: 'Streaks pull out of the centre and resolve into the shot.',
    tags: ['zoom', 'blur', 'streak', 'fast', 'energetic'],
    popular: true,
  },

  // --- Blur & Motion -------------------------------------------------------
  {
    id: 'blur',
    label: 'Blur',
    category: 'motion',
    renderKind: 'blur-dissolve',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.studio, SHOT.sea),
    description: 'The next shot resolves out of a soft blur.',
    tags: ['blur', 'defocus', 'soft', 'resolve', 'smooth'],
    recommended: true,
  },
  {
    id: 'motion-blur',
    label: 'Motion Blur',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'left',
    params: { radius: 0.09, travel: 0.35 },
    easing: 'ease-out',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.city, SHOT.ember),
    description: 'The frame arrives smeared along its travel and settles sharp.',
    tags: ['motion', 'smear', 'speed', 'travel', 'fast'],
  },
  {
    id: 'directional-blur',
    label: 'Directional Blur',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'right',
    params: { radius: 0.14, travel: 0 },
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.ember, SHOT.city),
    description: 'A pure lateral smear that sharpens into place.',
    tags: ['directional', 'smear', 'streak', 'horizontal'],
  },
  {
    id: 'radial-blur',
    label: 'Radial Blur',
    category: 'motion',
    renderKind: 'blur-radial',
    direction: 'out',
    params: { strength: 0.6, mode: 0 },
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.sea, SHOT.neon),
    description: 'Streaks rush outward from the centre before the shot lands.',
    tags: ['radial', 'burst', 'rush', 'centre'],
  },
  {
    id: 'spin-blur',
    label: 'Spin Blur',
    category: 'motion',
    renderKind: 'blur-radial',
    params: { strength: 0.65, mode: 1 },
    easing: 'ease-out',
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.neon, SHOT.dusk),
    description: 'The frame arrives spinning and settles still.',
    tags: ['spin', 'rotate', 'whirl', 'blur', 'energetic'],
  },
  {
    id: 'whip-pan-left',
    label: 'Whip Pan Left',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'left',
    params: { radius: 0.16, travel: 0.85 },
    easing: 'ease-in-out',
    defaultDuration: 0.28,
    thumbnail: pair(SHOT.forest, SHOT.city),
    description: 'A hard camera whip to the left that lands on the next shot.',
    tags: ['whip', 'swish', 'pan', 'left', 'fast', 'energetic', 'social media'],
    popular: true,
  },
  {
    id: 'whip-pan-right',
    label: 'Whip Pan Right',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'right',
    params: { radius: 0.16, travel: 0.85 },
    easing: 'ease-in-out',
    defaultDuration: 0.28,
    thumbnail: pair(SHOT.city, SHOT.forest),
    description: 'A hard camera whip to the right that lands on the next shot.',
    tags: ['whip', 'swish', 'pan', 'right', 'fast', 'energetic'],
  },
  {
    id: 'whip-pan-up',
    label: 'Whip Pan Up',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'up',
    params: { radius: 0.16, travel: 0.85 },
    easing: 'ease-in-out',
    defaultDuration: 0.28,
    thumbnail: pair(SHOT.dawn, SHOT.neon),
    description: 'A vertical whip — the natural one for a 9:16 edit.',
    tags: ['whip', 'up', 'vertical', 'reels', 'tiktok', 'fast'],
  },
  {
    id: 'whip-pan-down',
    label: 'Whip Pan Down',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'down',
    params: { radius: 0.16, travel: 0.85 },
    easing: 'ease-in-out',
    defaultDuration: 0.28,
    thumbnail: pair(SHOT.neon, SHOT.dawn),
    description: 'A downward whip that drops onto the next shot.',
    tags: ['whip', 'down', 'vertical', 'fast'],
  },
  {
    id: 'speed-blur',
    label: 'Speed Blur',
    category: 'motion',
    renderKind: 'blur-directional',
    direction: 'right',
    params: { radius: 0.22, travel: 0.5 },
    easing: 'ease-out',
    defaultDuration: 0.32,
    thumbnail: pair(SHOT.dusk, SHOT.ember),
    description: 'Heavy horizontal streaking, like a whip-pan held one beat longer.',
    tags: ['speed', 'fast', 'streak', 'rush', 'energetic'],
  },
  {
    id: 'camera-shake',
    label: 'Camera Shake',
    category: 'motion',
    renderKind: 'shake',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.ember, SHOT.studio),
    description: 'An impact shake that settles into the next shot.',
    tags: ['shake', 'impact', 'hit', 'handheld', 'beat', 'energetic'],
  },

  {
    id: 'spin',
    label: 'Spin',
    category: 'motion',
    renderKind: 'spin',
    easing: 'ease-out',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dusk, SHOT.neon),
    description: 'The next shot spins down out of nowhere and lands square.',
    tags: ['spin', 'rotate', 'twist', 'whirl', 'graphic'],
  },

  // --- Wipe ----------------------------------------------------------------
  {
    id: 'wipe',
    label: 'Wipe Right',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'right',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.sea, SHOT.dawn),
    description: 'A clean edge sweeps left to right.',
    tags: ['wipe', 'right', 'edge', 'sweep', 'graphic'],
    popular: true,
  },
  {
    id: 'wipe-left',
    label: 'Wipe Left',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'left',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dawn, SHOT.sea),
    description: 'A clean edge sweeps right to left.',
    tags: ['wipe', 'left', 'edge', 'sweep'],
  },
  {
    id: 'wipe-up',
    label: 'Wipe Up',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'up',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.forest, SHOT.dusk),
    description: 'The edge sweeps upward from the bottom of frame.',
    tags: ['wipe', 'up', 'vertical', 'reveal'],
  },
  {
    id: 'wipe-down',
    label: 'Wipe Down',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'down',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dusk, SHOT.forest),
    description: 'The edge sweeps down from the top of frame.',
    tags: ['wipe', 'down', 'vertical', 'reveal'],
  },
  {
    id: 'diagonal-wipe',
    label: 'Diagonal Wipe',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'right',
    params: { angle: 45 },
    defaultDuration: 0.55,
    thumbnail: pair(SHOT.city, SHOT.studio),
    description: 'The edge crosses the frame corner to corner.',
    tags: ['diagonal', 'angle', 'corner', 'wipe', 'graphic'],
  },
  {
    id: 'soft-wipe',
    label: 'Soft Edge Wipe',
    category: 'wipe',
    renderKind: 'wipe-linear',
    direction: 'right',
    softness: 0.85,
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.studio, SHOT.city),
    description: 'A wipe with a wide feather — halfway to a dissolve.',
    tags: ['soft', 'feather', 'gentle', 'wipe', 'smooth'],
    recommended: true,
  },
  {
    id: 'circular-wipe',
    label: 'Circular Wipe',
    category: 'wipe',
    renderKind: 'wipe-radial',
    params: { invert: 0 },
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.neon, SHOT.sea),
    description: 'A circle opens out of the centre and fills the frame.',
    tags: ['circle', 'iris', 'open', 'radial', 'reveal'],
  },
  {
    id: 'iris-close',
    label: 'Iris Close',
    category: 'wipe',
    renderKind: 'wipe-radial',
    params: { invert: 1 },
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.sea, SHOT.neon),
    description: 'The old shot closes to a point and the new one is behind it.',
    tags: ['iris', 'close', 'circle', 'vintage', 'silent film'],
  },
  {
    id: 'clock-wipe',
    label: 'Clock Wipe',
    category: 'wipe',
    renderKind: 'wipe-clock',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.ember, SHOT.forest),
    description: 'A hand sweeps around the frame like a second hand.',
    tags: ['clock', 'radar', 'sweep', 'angular', 'time'],
  },
  {
    id: 'shape-wipe',
    label: 'Shape Wipe',
    category: 'wipe',
    renderKind: 'wipe-shape',
    params: { shape: 0 },
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.dawn, SHOT.neon),
    description: 'A diamond opens out of the centre of the frame.',
    tags: ['shape', 'diamond', 'graphic', 'reveal'],
  },
  {
    id: 'star-wipe',
    label: 'Star Wipe',
    category: 'wipe',
    renderKind: 'wipe-shape',
    params: { shape: 1 },
    defaultDuration: 0.65,
    thumbnail: pair(SHOT.neon, SHOT.ember),
    description: 'A star grows out of the centre — playful and unmistakable.',
    tags: ['star', 'shape', 'retro', 'fun', 'kids'],
  },
  {
    id: 'split-wipe',
    label: 'Split Wipe',
    category: 'wipe',
    renderKind: 'wipe-split',
    params: { axis: 0, invert: 0 },
    defaultDuration: 0.55,
    thumbnail: pair(SHOT.city, SHOT.dawn),
    description: 'The frame splits down the middle and opens outward.',
    tags: ['split', 'open', 'centre', 'graphic', 'reveal'],
  },
  {
    id: 'barn-door',
    label: 'Barn Door',
    category: 'wipe',
    renderKind: 'wipe-split',
    params: { axis: 0, invert: 1 },
    defaultDuration: 0.55,
    thumbnail: pair(SHOT.dawn, SHOT.city),
    description: 'Two panels close in from the edges to the centre.',
    tags: ['barn door', 'close', 'panels', 'edges'],
  },
  {
    id: 'blinds',
    label: 'Blinds',
    category: 'wipe',
    renderKind: 'wipe-bars',
    params: { bars: 10, axis: 0, stagger: 0.4 },
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.studio, SHOT.dusk),
    description: 'Vertical slats open one after another.',
    tags: ['blinds', 'bars', 'slats', 'venetian', 'graphic'],
  },

  // --- Creative ------------------------------------------------------------
  {
    id: 'glitch',
    label: 'Glitch',
    category: 'creative',
    renderKind: 'glitch',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.neon, SHOT.city),
    description: 'The signal tears apart and reassembles as the next shot.',
    tags: ['glitch', 'digital', 'broken', 'tear', 'fast', 'energetic'],
    popular: true,
  },
  {
    id: 'rgb-split',
    label: 'RGB Split',
    category: 'creative',
    renderKind: 'rgb-split',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.city, SHOT.neon),
    description: 'Colour channels fly apart and snap back together.',
    tags: ['rgb', 'chromatic', 'colour split', 'aberration', 'music'],
  },
  {
    id: 'flash',
    label: 'Flash',
    category: 'creative',
    renderKind: 'dip-color',
    params: { red: 1, green: 1, blue: 1, hold: 0.08, blend: 1 },
    easing: 'ease-out',
    defaultDuration: 0.22,
    thumbnail: pair(SHOT.dusk, SHOT.studio),
    description: 'A blown-out flash of light on the cut.',
    tags: ['flash', 'blowout', 'strobe', 'beat', 'fast', 'music'],
    popular: true,
  },
  {
    id: 'light-leak',
    label: 'Light Leak',
    category: 'creative',
    renderKind: 'light-leak',
    direction: 'right',
    params: { mode: 0 },
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.dawn, SHOT.ember),
    description: 'Warm light bleeds across the frame the way it does on film.',
    tags: ['light leak', 'warm', 'film', 'analog', 'cinematic', 'organic'],
    recommended: true,
  },
  {
    id: 'film-burn',
    label: 'Film Burn',
    category: 'creative',
    renderKind: 'light-leak',
    direction: 'right',
    params: { mode: 1, warmth: 0.9, brightness: 1 },
    defaultDuration: 0.8,
    thumbnail: pair(SHOT.ember, SHOT.dusk),
    description: 'The frame burns through, the way a stuck film print does.',
    tags: ['film burn', 'burn', 'analog', 'vintage', 'projector', 'cinematic'],
  },
  {
    id: 'pixel-dissolve',
    label: 'Pixel Dissolve',
    category: 'creative',
    renderKind: 'pixel-dissolve',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.studio, SHOT.neon),
    description: 'Blocks of the new shot arrive at random until it is whole.',
    tags: ['pixel', 'blocks', 'dissolve', 'digital', 'retro'],
  },
  {
    id: 'mosaic',
    label: 'Mosaic',
    category: 'creative',
    renderKind: 'mosaic',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.neon, SHOT.studio),
    description: 'The picture resolves out of coarse blocks into detail.',
    tags: ['mosaic', 'pixelate', 'blocks', 'resolve', 'digital'],
  },
  {
    id: 'ripple',
    label: 'Ripple',
    category: 'creative',
    renderKind: 'ripple',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.sea, SHOT.forest),
    description: 'Rings spread out from the centre and settle.',
    tags: ['ripple', 'water', 'wave', 'rings', 'organic'],
  },
  {
    id: 'warp',
    label: 'Warp',
    category: 'creative',
    renderKind: 'warp',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.forest, SHOT.sea),
    description: 'The frame bends through heat haze and straightens out.',
    tags: ['warp', 'heat', 'haze', 'bend', 'organic'],
  },
  {
    id: 'distortion',
    label: 'Distortion',
    category: 'creative',
    renderKind: 'warp',
    params: { amplitude: 0.4, cell: 0.12 },
    defaultDuration: 0.4,
    thumbnail: pair(SHOT.city, SHOT.neon),
    description: 'A violent short-wavelength wobble that tears and resolves.',
    tags: ['distortion', 'wobble', 'violent', 'harsh', 'glitch'],
  },
  {
    id: 'stretch',
    label: 'Stretch',
    category: 'creative',
    renderKind: 'stretch',
    defaultDuration: 0.35,
    thumbnail: pair(SHOT.dawn, SHOT.city),
    description: 'The frame stretches in from a smear and snaps to size.',
    tags: ['stretch', 'squash', 'smear', 'elastic', 'fast'],
  },
  {
    id: 'liquid',
    label: 'Liquid',
    category: 'creative',
    renderKind: 'liquid',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.sea, SHOT.dusk),
    description: 'The picture unwinds out of a swirl.',
    tags: ['liquid', 'swirl', 'vortex', 'twist', 'organic', 'dreamy'],
  },
  {
    id: 'kaleidoscope',
    label: 'Kaleidoscope',
    category: 'creative',
    renderKind: 'kaleidoscope',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.neon, SHOT.dawn),
    description: 'Mirrored wedges fold back into a single frame.',
    tags: ['kaleidoscope', 'mirror', 'symmetry', 'psychedelic', 'music'],
  },
  {
    id: 'page-turn',
    label: 'Page Turn',
    category: 'creative',
    renderKind: 'page-turn',
    direction: 'left',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.studio, SHOT.dawn),
    description: 'The old shot peels away like a page.',
    tags: ['page', 'turn', 'curl', 'book', 'peel', 'classic'],
  },
  {
    id: 'luma-fade',
    label: 'Luma Fade',
    category: 'creative',
    renderKind: 'luma-fade',
    softness: 0.35,
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.dusk, SHOT.sea),
    description: 'The bright parts of the next shot arrive first.',
    tags: ['luma', 'brightness', 'organic', 'cinematic', 'smooth'],
    recommended: true,
  },
  {
    id: 'ink-reveal',
    label: 'Ink Reveal',
    category: 'creative',
    renderKind: 'noise-dissolve',
    params: { cell: 0.09 },
    softness: 0.35,
    defaultDuration: 0.8,
    thumbnail: pair(SHOT.studio, SHOT.forest),
    description: 'The next shot bleeds through like ink through paper.',
    tags: ['ink', 'bleed', 'organic', 'paper', 'documentary'],
  },

  // --- 3D & Spatial --------------------------------------------------------
  {
    id: 'flip-horizontal',
    label: 'Flip Horizontal',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 0, turns: 0.5, depth: 0.55, shade: 0.6 },
    easing: 'ease-in-out',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.city, SHOT.sea),
    description: 'The frame flips over on its vertical axis.',
    tags: ['flip', 'horizontal', '3d', 'turn', 'card'],
    popular: true,
  },
  {
    id: 'flip-vertical',
    label: 'Flip Vertical',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 1, panels: 1, pivot: 0, turns: 0.5, depth: 0.55, shade: 0.6 },
    easing: 'ease-in-out',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.sea, SHOT.city),
    description: 'The frame flips over on its horizontal axis.',
    tags: ['flip', 'vertical', '3d', 'turn'],
  },
  {
    id: 'card-flip',
    label: 'Card Flip',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 0, turns: 0.5, depth: 0.9, shade: 0.85 },
    easing: 'ease-in-out',
    defaultDuration: 0.5,
    thumbnail: pair(SHOT.dawn, SHOT.studio),
    description: 'A hard-perspective flip with a shaded back face.',
    tags: ['card', 'flip', '3d', 'perspective', 'deck'],
  },
  {
    id: 'cube-rotate',
    label: 'Cube Rotate',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 1, turns: 0.25, depth: 0.85, shade: 0.55 },
    easing: 'ease-in-out',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.forest, SHOT.neon),
    description: 'The shots sit on adjacent faces of a cube that turns.',
    tags: ['cube', 'rotate', '3d', 'box', 'turn'],
    popular: true,
  },
  {
    id: 'door-open',
    label: 'Door Open',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 2, pivot: 1, turns: -0.3, depth: 0.75, shade: 0.6 },
    easing: 'ease-in-out',
    defaultDuration: 0.65,
    thumbnail: pair(SHOT.studio, SHOT.forest),
    description: 'The frame swings open in two panels.',
    tags: ['door', 'open', 'panels', '3d', 'reveal'],
  },
  {
    id: 'door-close',
    label: 'Door Close',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 2, pivot: 1, turns: 0.3, depth: 0.75, shade: 0.6 },
    easing: 'ease-in-out',
    defaultDuration: 0.65,
    thumbnail: pair(SHOT.forest, SHOT.studio),
    description: 'Two panels swing shut on the next shot.',
    tags: ['door', 'close', 'panels', '3d', 'shut'],
  },
  {
    id: 'fold',
    label: 'Fold',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 6, pivot: 1, turns: 0.35, depth: 0.7, shade: 0.7 },
    easing: 'ease-in-out',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.dusk, SHOT.dawn),
    description: 'The frame concertinas open like a folding screen.',
    tags: ['fold', 'accordion', 'concertina', 'panels', '3d'],
  },
  {
    id: 'perspective-slide',
    label: 'Perspective Slide',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 0, turns: 0.13, depth: 0.95, arc: 0.35, shade: 0.4 },
    easing: 'ease-out',
    defaultDuration: 0.55,
    thumbnail: pair(SHOT.city, SHOT.ember),
    description: 'The shot slides in along a plane that is angled away from you.',
    tags: ['perspective', 'slide', 'angle', '3d', 'travel'],
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 0, turns: 0, depth: 1, arc: 0, shade: 0.75, push: 1 },
    easing: 'ease-out',
    defaultDuration: 0.6,
    thumbnail: pair(SHOT.neon, SHOT.dusk),
    description: 'The next shot rushes at you out of the distance.',
    tags: ['tunnel', 'depth', 'rush', 'forward', 'z', '3d'],
  },
  {
    id: 'carousel',
    label: 'Carousel Rotate',
    category: 'spatial',
    renderKind: 'perspective-3d',
    params: { axis: 0, panels: 1, pivot: 1, turns: 0.3, depth: 0.7, arc: 0.9, shade: 0.5 },
    easing: 'ease-in-out',
    defaultDuration: 0.7,
    thumbnail: pair(SHOT.ember, SHOT.neon),
    description: 'The shots swing past on a carousel.',
    tags: ['carousel', 'rotate', 'swing', 'arc', '3d'],
  },
];

/** Fast lookup by stored `kind`. */
const BY_ID = new Map<string, CatalogTransition>(TRANSITION_CATALOG.map((t) => [t.id, t]));

/** The catalog entry for a stored transition kind, or `undefined` if unknown. */
export function getTransition(id: string): CatalogTransition | undefined {
  return BY_ID.get(id);
}

/**
 * The default this product reaches for when nothing was chosen.
 *
 * A cross dissolve, because it is the transition that is right more often than
 * any other and the one every editor already recognises.
 */
export const DEFAULT_TRANSITION_ID = 'cross-dissolve';

/**
 * The seven ids that predate this catalog. Their render path in the Python
 * compiler is deliberately untouched, so every project made before the catalog
 * existed renders byte-identically — see the sub-plan's invariant 2.
 */
export const LEGACY_TRANSITION_IDS: readonly string[] = [
  'cut',
  'fade',
  'cross-dissolve',
  'push',
  'slide',
  'zoom',
  'blur',
  'wipe',
];

/**
 * The fully-resolved numeric params for a catalog entry — kind defaults with the
 * entry's overrides applied. What a renderer actually receives.
 */
export function resolveTransitionParams(entry: CatalogTransition): Record<string, number> {
  const out = defaultTransitionParams(entry.renderKind);
  if (entry.params) {
    for (const [name, value] of Object.entries(entry.params)) {
      if (name in out) out[name] = value;
    }
  }
  return out;
}

/** The directions this entry's render kind accepts (empty when it has none). */
export function directionsForTransition(entry: CatalogTransition): readonly string[] {
  return TRANSITION_DIRECTIONS[entry.renderKind];
}

/**
 * The direction an entry uses when its stored `direction` is absent or not one
 * its kind accepts — its own override, else the first direction the kind offers.
 *
 * "First offered" rather than a separate default table because the tables would
 * then have to be kept in agreement, and the entries that care state a direction
 * anyway (that IS what makes "Push Left" different from "Push Right").
 */
export function defaultDirectionFor(entry: CatalogTransition): string {
  const allowed = directionsForTransition(entry);
  if (entry.direction !== undefined && allowed.includes(entry.direction)) return entry.direction;
  return allowed[0] ?? '';
}

/**
 * Everything a search box needs, lower-cased once at module load.
 *
 * Built here rather than in the panel because the on-cut popover searches the same
 * catalog, and two components building two indexes would drift on what "matches"
 * means — the failure the brief calls out where searching "left" misses `push-left`.
 */
export interface TransitionSearchEntry {
  readonly transition: CatalogTransition;
  /** Label, id, category label and tags, joined and lower-cased. */
  readonly haystack: string;
}

const CATEGORY_LABEL = new Map(TRANSITION_CATEGORIES.map((c) => [c.id, c.label]));

export const TRANSITION_SEARCH_INDEX: readonly TransitionSearchEntry[] = TRANSITION_CATALOG.map(
  (transition) => ({
    transition,
    haystack: [
      transition.label,
      transition.id.replace(/-/g, ' '),
      CATEGORY_LABEL.get(transition.category) ?? '',
      transition.renderKind.replace(/-/g, ' '),
      transition.description,
      ...transition.tags,
    ]
      .join(' ')
      .toLowerCase(),
  }),
);

/**
 * Search the catalog. Every whitespace-separated term must appear somewhere in an
 * entry's haystack (AND, not OR), which is what makes "soft wipe" narrow rather
 * than return every soft thing and every wipe.
 *
 * @param query - Raw user input; empty returns the whole catalog in catalog order.
 */
export function searchTransitions(query: string): readonly CatalogTransition[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return TRANSITION_CATALOG;
  return TRANSITION_SEARCH_INDEX.filter((entry) =>
    terms.every((term) => entry.haystack.includes(term)),
  ).map((entry) => entry.transition);
}

/** Entries in one category, in catalog order. */
export function transitionsInCategory(category: TransitionCategory): readonly CatalogTransition[] {
  return TRANSITION_CATALOG.filter((t) => t.category === category);
}

/** Every param name any kind declares — the set the validator will accept. */
export const ALL_TRANSITION_PARAM_NAMES: ReadonlySet<string> = new Set(
  Object.values(TRANSITION_PARAMS).flatMap((descriptors) => descriptors.map((d) => d.name)),
);
