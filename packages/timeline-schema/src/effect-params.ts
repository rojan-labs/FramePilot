/**
 * @framepilot/timeline-schema/effect-params — the per-render-kind parameter
 * vocabulary for effect layers (schema v13, ADR 0088).
 *
 * WHY descriptors live with the KIND, not the catalog entry: parameters are a
 * property of the renderer. `blur-gaussian` accepts a `radius` in pixels
 * because the numpy pass and the GLSL pass both sample a radius — that fact is
 * true of every catalog entry built on the kind, so stating it once is what lets
 * `effect-catalog.ts` stay pure data (a name, a category, and a bag of
 * defaults).
 *
 * Three consumers read this file and they must agree:
 *   1. the patch validator — rejects an out-of-range or unknown param before it
 *      can reach a renderer (the schema itself cannot: `EffectLayer.params` is
 *      an open numeric record, since Zod cannot know the catalog without a
 *      circular import);
 *   2. the Inspector — builds its controls generically from these descriptors,
 *      which is why "add a kind" never means "write a new panel";
 *   3. the AI tool layer — publishes these ranges to the model so it can pick
 *      real values instead of guessing.
 *
 * Every param is a NUMBER. Discrete choices are expressed as a numeric index
 * plus {@link EffectParamDescriptor.choices} so the UI can render a segmented
 * control while the wire format stays `Record<string, number>` — one uniform
 * type for the validator, the renderers, and keyframe animation alike.
 */
import type { EffectRenderKind } from './index.js';

/** One tunable parameter of a render kind. */
export interface EffectParamDescriptor {
  /** Wire name, as it appears in `EffectLayer.params`. */
  readonly name: string;
  /** Human label for the Inspector control. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Slider granularity. */
  readonly step: number;
  /** Value used when a catalog entry does not override it. */
  readonly default: number;
  /**
   * Discrete options. When present the value is an INDEX into this list and the
   * Inspector renders a segmented control instead of a slider.
   */
  readonly choices?: readonly string[];
  /** Suffix shown next to the value (e.g. `px`, `°`). Cosmetic only. */
  readonly unit?: string;
  /** One-line explanation, surfaced as a tooltip and to the AI layer. */
  readonly hint?: string;
}

/**
 * `hint` is spread conditionally rather than passed as `hint: undefined`: the
 * package compiles with `exactOptionalPropertyTypes`, where an explicit
 * `undefined` is NOT the same as an absent key.
 */
const withHint = (hint: string | undefined): { hint?: string } => (hint === undefined ? {} : { hint });

const px = (
  name: string,
  label: string,
  max: number,
  def: number,
  hint?: string,
): EffectParamDescriptor => ({
  name,
  label,
  min: 0,
  max,
  step: 0.5,
  default: def,
  unit: 'px',
  ...withHint(hint),
});

/** A normalized 0–1 amount — by far the most common parameter shape. */
const amount = (
  name: string,
  label: string,
  def: number,
  hint?: string,
): EffectParamDescriptor => ({
  name,
  label,
  min: 0,
  max: 1,
  step: 0.01,
  default: def,
  ...withHint(hint),
});

const degrees = (
  name: string,
  label: string,
  def: number,
  hint?: string,
): EffectParamDescriptor => ({
  name,
  label,
  min: 0,
  max: 360,
  step: 1,
  default: def,
  unit: '°',
  ...withHint(hint),
});

const hz = (name: string, label: string, max: number, def: number): EffectParamDescriptor => ({
  name,
  label,
  min: 0,
  max,
  step: 0.1,
  default: def,
  unit: 'Hz',
});

const count = (
  name: string,
  label: string,
  min: number,
  max: number,
  def: number,
): EffectParamDescriptor => ({ name, label, min, max, step: 1, default: def });

/** Signed −1…1 control (warmth, contrast, barrel sign). */
const bipolar = (name: string, label: string, def: number): EffectParamDescriptor => ({
  name,
  label,
  min: -1,
  max: 1,
  step: 0.01,
  default: def,
});

/**
 * Animation speed multiplier for time-varying kinds. Deterministic: renderers
 * derive their noise from `floor(t * speed * BASE_RATE)`, never from a RNG, so
 * a render and a preview at the same timestamp agree exactly.
 */
const speed = (def = 1): EffectParamDescriptor => ({
  name: 'speed',
  label: 'Speed',
  min: 0,
  max: 4,
  step: 0.05,
  default: def,
  unit: '×',
  hint: 'Animation rate. Deterministic — the same timestamp always looks the same.',
});

/**
 * The complete parameter surface, keyed by render kind.
 *
 * Exhaustive by construction: the `Record<EffectRenderKind, …>` type makes
 * adding a kind to the enum a compile error here until its params are declared,
 * which is the guard that keeps the three consumers above in sync.
 */
export const EFFECT_PARAMS: Readonly<Record<EffectRenderKind, readonly EffectParamDescriptor[]>> = {
  // --- Blur & focus --------------------------------------------------------
  'blur-gaussian': [px('radius', 'Blur', 64, 12, 'Gaussian sample radius.')],
  'blur-directional': [px('radius', 'Length', 64, 16), degrees('angle', 'Direction', 0)],
  'blur-radial': [
    amount('strength', 'Strength', 0.4),
    amount('centerX', 'Center X', 0.5),
    amount('centerY', 'Center Y', 0.5),
  ],
  'tilt-shift': [
    px('radius', 'Blur', 48, 18),
    amount('focusY', 'Focus line', 0.5, 'Vertical position of the sharp band.'),
    amount('bandHeight', 'Band height', 0.3),
  ],

  // --- Glow & bloom --------------------------------------------------------
  bloom: [
    amount('threshold', 'Threshold', 0.7, 'Only pixels brighter than this bloom.'),
    { name: 'strength', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.8 },
    px('radius', 'Spread', 64, 20),
  ],
  'glow-diffuse': [amount('strength', 'Strength', 0.5), px('radius', 'Spread', 64, 24)],
  halation: [
    amount('threshold', 'Threshold', 0.75),
    amount('strength', 'Strength', 0.5),
    degrees('tint', 'Tint', 15, 'Hue of the bleed around highlights.'),
  ],

  // --- Light leaks & lens --------------------------------------------------
  'light-leak': [
    degrees('angle', 'Angle', 45),
    amount('strength', 'Strength', 0.5),
    amount('warmth', 'Warmth', 0.7),
    amount('position', 'Position', 0.2),
  ],
  'lens-flare': [
    amount('x', 'Source X', 0.3),
    amount('y', 'Source Y', 0.3),
    amount('strength', 'Strength', 0.6),
    amount('spread', 'Spread', 0.4),
  ],
  vignette: [
    amount('amount', 'Amount', 0.4),
    amount('radius', 'Radius', 0.7),
    amount('softness', 'Softness', 0.5),
  ],

  // --- Film & cinematic ----------------------------------------------------
  'film-fade': [
    { name: 'lift', label: 'Black lift', min: 0, max: 0.3, step: 0.005, default: 0.08 },
    amount('rolloff', 'Highlight rolloff', 0.4),
    bipolar('warmth', 'Warmth', 0.15),
    { name: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 0.9 },
  ],
  'film-curve': [
    bipolar('contrast', 'Contrast', 0.2),
    degrees('shadowTint', 'Shadow tint', 210),
    degrees('highlightTint', 'Highlight tint', 40),
    amount('strength', 'Strength', 0.6),
  ],

  // --- VHS / camcorder / analog -------------------------------------------
  'analog-vhs': [
    amount('tracking', 'Tracking error', 0.4),
    amount('chroma', 'Chroma bleed', 0.5),
    amount('noise', 'Noise', 0.35),
    amount('jitter', 'Line jitter', 0.3),
    speed(),
  ],
  scanlines: [
    count('count', 'Line count', 50, 1080, 320),
    amount('strength', 'Strength', 0.35),
    amount('roll', 'Roll', 0.2, 'Vertical drift of the line pattern over time.'),
    speed(),
  ],
  'tape-dropout': [
    amount('density', 'Density', 0.3),
    amount('length', 'Streak length', 0.4),
    speed(),
  ],

  // --- Chromatic & colour separation --------------------------------------
  'chroma-shift': [amount('amount', 'Amount', 0.35), degrees('angle', 'Angle', 0)],
  'rgb-split': [amount('amount', 'Amount', 0.4), degrees('angle', 'Angle', 90)],

  // --- Glitch & digital distortion ----------------------------------------
  'glitch-block': [
    amount('density', 'Density', 0.4),
    amount('size', 'Block size', 0.35),
    amount('displace', 'Displacement', 0.5),
    speed(),
  ],
  datamosh: [amount('strength', 'Strength', 0.5), amount('blockSize', 'Block size', 0.4), speed()],
  'pixel-sort': [
    amount('threshold', 'Threshold', 0.5),
    amount('amount', 'Amount', 0.5),
    { name: 'axis', label: 'Axis', min: 0, max: 1, step: 1, default: 0, choices: ['Horizontal', 'Vertical'] },
  ],

  // --- Shake, impact & motion ---------------------------------------------
  shake: [
    amount('amplitude', 'Amplitude', 0.35),
    hz('frequency', 'Frequency', 20, 8),
    amount('rotation', 'Rotation', 0.2),
  ],
  'zoom-punch': [
    amount('amount', 'Amount', 0.3),
    amount('attack', 'Attack', 0.15, 'Fraction of the layer spent zooming in.'),
    amount('hold', 'Hold', 0.2, 'Fraction held at full zoom before releasing.'),
  ],
  'whip-pan': [
    amount('amount', 'Amount', 0.5),
    degrees('angle', 'Direction', 0),
    amount('blur', 'Motion blur', 0.6),
  ],

  // --- Dreamy & soft -------------------------------------------------------
  'soft-focus': [
    px('radius', 'Softness', 64, 20),
    amount('mix', 'Mix', 0.5),
    { name: 'lift', label: 'Glow lift', min: 0, max: 0.3, step: 0.005, default: 0.06 },
  ],

  // --- Distortion & warp ---------------------------------------------------
  fisheye: [
    amount('amount', 'Amount', 0.5),
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 2, step: 0.01, default: 1 },
  ],
  'barrel-warp': [bipolar('amount', 'Amount', 0.4)],
  ripple: [
    amount('amplitude', 'Amplitude', 0.3),
    count('frequency', 'Frequency', 1, 40, 10),
    speed(),
  ],

  // --- Pixel, mosaic & halftone -------------------------------------------
  mosaic: [count('size', 'Cell size', 2, 128, 16)],
  halftone: [
    count('dotSize', 'Dot size', 2, 64, 8),
    degrees('angle', 'Screen angle', 45),
    amount('mix', 'Mix', 1),
  ],
  dither: [count('levels', 'Levels', 2, 16, 4), amount('strength', 'Strength', 1)],

  // --- Noise, grain, dust & scratches -------------------------------------
  grain: [
    amount('amount', 'Amount', 0.35),
    { name: 'size', label: 'Grain size', min: 0.5, max: 4, step: 0.1, default: 1 },
    speed(),
  ],
  'dust-scratches': [
    amount('density', 'Dust', 0.35),
    amount('scratches', 'Scratches', 0.3),
    speed(),
  ],

  // --- Party, neon & energetic ---------------------------------------------
  'neon-edge': [
    amount('threshold', 'Edge threshold', 0.3),
    degrees('hue', 'Hue', 300),
    amount('strength', 'Strength', 0.7),
    amount('thickness', 'Thickness', 0.4),
  ],
  'strobe-color': [
    degrees('hueA', 'Colour A', 300),
    degrees('hueB', 'Colour B', 180),
    hz('frequency', 'Rate', 20, 6),
    amount('strength', 'Strength', 0.5),
  ],

  // --- Comic & stylised ----------------------------------------------------
  posterize: [
    count('levels', 'Levels', 2, 16, 5),
    { name: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 1.2 },
  ],
  sketch: [amount('strength', 'Strength', 0.6), amount('threshold', 'Threshold', 0.4)],

  // --- Edge, outline & highlight ------------------------------------------
  'edge-outline': [
    amount('threshold', 'Threshold', 0.3),
    amount('thickness', 'Thickness', 0.3),
    amount('mix', 'Mix', 0.6),
  ],

  // --- Flash, strobe & flicker --------------------------------------------
  flash: [
    hz('frequency', 'Rate', 20, 4),
    amount('strength', 'Strength', 0.6),
    amount('duty', 'Duty cycle', 0.3, 'Fraction of each cycle the flash is lit.'),
  ],
  flicker: [
    hz('frequency', 'Rate', 20, 10),
    amount('depth', 'Depth', 0.35),
    amount('irregular', 'Irregularity', 0.4),
  ],

  // --- Split-screen & mirrored --------------------------------------------
  mirror: [
    {
      name: 'axis',
      label: 'Mirror',
      min: 0,
      max: 3,
      step: 1,
      default: 0,
      choices: ['Left → right', 'Right → left', 'Top → bottom', 'Bottom → top'],
    },
    amount('offset', 'Seam', 0.5),
  ],
  kaleidoscope: [
    count('segments', 'Segments', 2, 16, 6),
    degrees('rotation', 'Rotation', 0),
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 2, step: 0.01, default: 1 },
  ],
};

/** Descriptors for a kind. Never empty — every kind declares at least one param. */
export function paramsForKind(kind: EffectRenderKind): readonly EffectParamDescriptor[] {
  return EFFECT_PARAMS[kind];
}

/**
 * The full default parameter set for a kind, as stored on a new effect layer.
 * Catalog entries shallow-override this, so a catalog entry only has to state
 * what makes it distinctive.
 */
export function defaultParamsForKind(kind: EffectRenderKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const descriptor of EFFECT_PARAMS[kind]) out[descriptor.name] = descriptor.default;
  return out;
}

/**
 * Clamp a param bag to its kind's declared ranges, dropping unknown names.
 *
 * Used by the validator and by every AI tool that accepts model-authored
 * params: an out-of-range value is a bug worth surfacing, but a *silently
 * unclamped* one reaches a shader and produces a black frame, so the tool layer
 * clamps and reports rather than trusting the caller.
 */
export function clampParamsForKind(
  kind: EffectRenderKind,
  params: Readonly<Record<string, number>>,
): Record<string, number> {
  const out = defaultParamsForKind(kind);
  for (const descriptor of EFFECT_PARAMS[kind]) {
    const raw = params[descriptor.name];
    if (typeof raw !== 'number' || Number.isNaN(raw)) continue;
    out[descriptor.name] = Math.min(descriptor.max, Math.max(descriptor.min, raw));
  }
  return out;
}
