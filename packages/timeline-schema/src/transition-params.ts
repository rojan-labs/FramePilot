/**
 * @framepilot/timeline-schema/transition-params — the per-render-kind parameter
 * vocabulary for transitions (`plan/ADVANCED-TRANSITION-SYSTEM.md`).
 *
 * The effect-layer twin of this file (`effect-params.ts`, ADR 0088) explains the
 * reasoning in full; the same three consumers read this one — the validator, the
 * Inspector, and the AI tool layer — and the same rule applies: **parameters are a
 * property of the render KIND, not of the catalog entry**, which is what lets
 * `transition-catalog.ts` stay pure data.
 *
 * ## What is NOT here
 *
 * Four params are universal and live on every transition regardless of kind, so
 * they are deliberately absent from the per-kind tables:
 *
 * | param | type | why it is universal |
 * | --- | --- | --- |
 * | `durationSeconds` | number | a transition IS a length of time |
 * | `direction` | string | one vocabulary (`left`/`right`/`up`/`down`/`in`/`out`) across every kind that moves, so "make it go the other way" is one control everywhere |
 * | `intensity` | 0–1 | how far the kind travels from rest — mixed by the renderer's epilogue exactly as effect-layer intensity is |
 * | `softness` | 0–1 | edge feather for every kind that reveals through a mask |
 * | `easing` | string | the curve progress runs on |
 *
 * `direction` and `easing` are strings rather than numeric indices because they
 * were already strings on disk before this catalog existed, and re-encoding them
 * would have needed a migration for no gain. The renderers convert `direction` to
 * an angle at uniform-upload time — a shader never sees the word.
 *
 * ## Ordering is a contract
 *
 * The order of a kind's descriptors is the order the GLSL chain uploads them into
 * `uParams[i]` and the order the numpy dispatcher unpacks them. Reordering a table
 * silently re-points every shader index; the parity test pins it.
 */
import type { EffectParamDescriptor } from './effect-params.js';

export type { EffectParamDescriptor as TransitionParamDescriptor };

/**
 * The closed vocabulary of picture treatments the transition renderers implement.
 *
 * The same extensibility contract as {@link EffectRenderKind}: the compiler and
 * the WebGL preview branch **only** on these, never on a catalog entry id. Adding
 * "transition #78" that reuses a kind with new params is a one-object change;
 * adding a *kind* is a deliberate two-sided implementation (numpy pass + GLSL pass
 * + parity test).
 *
 * Kinds are primitive on purpose. "Whip Pan Left" and "Speed Blur" are both
 * `blur-directional` with different params, which is what keeps a 77-entry catalog
 * honest rather than 77 near-duplicate shaders.
 */
export type TransitionRenderKind =
  // Dissolves — alpha only
  | 'dissolve'
  | 'dip-color'
  | 'luma-fade'
  | 'noise-dissolve'
  | 'pixel-dissolve'
  | 'mosaic'
  // Wipes — a moving alpha boundary
  | 'wipe-linear'
  | 'wipe-radial'
  | 'wipe-clock'
  | 'wipe-split'
  | 'wipe-shape'
  | 'wipe-bars'
  // Motion — the picture travels
  | 'slide'
  | 'zoom'
  | 'spin'
  | 'stretch'
  | 'shake'
  // Optical — the lens misbehaves
  | 'blur-dissolve'
  | 'blur-directional'
  | 'blur-radial'
  | 'glitch'
  | 'rgb-split'
  | 'light-leak'
  // Deformation — the picture bends
  | 'ripple'
  | 'warp'
  | 'liquid'
  | 'kaleidoscope'
  // Spatial — the picture is a surface in 3D
  | 'perspective-3d'
  | 'page-turn';

/**
 * How the render engine applies a kind, which decides how much it costs.
 *
 * `geometry` and `mask` are the two paths the compiler already had before this
 * catalog existed: MoviePy positions/scales the clip, or a vectorized alpha array
 * goes onto its mask. Both avoid a full-frame resample. `frame` is the new
 * per-pixel numpy path, and it is only paid for the transition's own seconds.
 *
 * Stated per kind so the compiler can pick without a table of its own, and so a
 * reader can see at a glance which additions are cheap.
 */
export type TransitionApplyPath = 'geometry' | 'mask' | 'frame';

/** The path each kind takes through the render compiler. */
export const TRANSITION_APPLY_PATH: Readonly<Record<TransitionRenderKind, TransitionApplyPath>> = {
  dissolve: 'mask',
  'dip-color': 'frame',
  'luma-fade': 'mask',
  'noise-dissolve': 'mask',
  'pixel-dissolve': 'mask',
  mosaic: 'frame',
  'wipe-linear': 'mask',
  'wipe-radial': 'mask',
  'wipe-clock': 'mask',
  'wipe-split': 'mask',
  'wipe-shape': 'mask',
  'wipe-bars': 'mask',
  slide: 'frame',
  zoom: 'frame',
  spin: 'frame',
  stretch: 'frame',
  shake: 'frame',
  'blur-dissolve': 'frame',
  'blur-directional': 'frame',
  'blur-radial': 'frame',
  glitch: 'frame',
  'rgb-split': 'frame',
  'light-leak': 'frame',
  ripple: 'frame',
  warp: 'frame',
  liquid: 'frame',
  kaleidoscope: 'frame',
  'perspective-3d': 'frame',
  'page-turn': 'frame',
};

const withHint = (hint: string | undefined): { hint?: string } =>
  hint === undefined ? {} : { hint };

/** A normalized 0–1 amount — the most common parameter shape. */
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

const count = (
  name: string,
  label: string,
  min: number,
  max: number,
  def: number,
  hint?: string,
): EffectParamDescriptor => ({
  name,
  label,
  min,
  max,
  step: 1,
  default: def,
  ...withHint(hint),
});

/**
 * A choice rendered as a segmented control. The stored value is the INDEX, so the
 * wire format stays numeric for the shader and the numpy pass alike.
 */
const choice = (
  name: string,
  label: string,
  choices: readonly string[],
  def: number,
  hint?: string,
): EffectParamDescriptor => ({
  name,
  label,
  min: 0,
  max: choices.length - 1,
  step: 1,
  default: def,
  choices,
  ...withHint(hint),
});

/**
 * A focal point, in frame fractions. Two descriptors rather than one vec2 because
 * the wire format is a flat numeric record — and because the Inspector puts them
 * on one row anyway by looking for the `centreX`/`centreY` pair.
 */
const centre = (): readonly EffectParamDescriptor[] => [
  {
    name: 'centreX',
    label: 'Centre X',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    hint: 'Where the transition originates, across the frame.',
  },
  {
    name: 'centreY',
    label: 'Centre Y',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    hint: 'Where the transition originates, down the frame.',
  },
];

/**
 * A deterministic seed. Renderers derive every "random" value from this plus the
 * quantized frame clock — never from a RNG — so a preview and a render at the same
 * timestamp produce the same picture (the `deterministic.py` contract).
 */
const seed = (def = 1): EffectParamDescriptor => ({
  name: 'seed',
  label: 'Variation',
  min: 0,
  max: 64,
  step: 1,
  default: def,
  hint: 'Pick a different random arrangement. The same value always looks the same.',
});

/**
 * The parameter vocabulary, by render kind. Order is the uniform order — see the
 * module note before touching it.
 */
export const TRANSITION_PARAMS: Readonly<
  Record<TransitionRenderKind, readonly EffectParamDescriptor[]>
> = {
  // --- Dissolves -----------------------------------------------------------
  // A plain opacity ramp has nothing to tune that `intensity` does not already
  // cover, but every kind must declare at least one param so the Inspector, the
  // validator and the shader share one shape. `hold` is the honest one: it is how
  // long the dissolve sits at its midpoint, which is what separates a lazy
  // dissolve from a snappy one.
  dissolve: [amount('hold', 'Hold', 0, 'Linger at the halfway blend before completing.')],

  'dip-color': [
    amount('red', 'Red', 0),
    amount('green', 'Green', 0),
    amount('blue', 'Blue', 0),
    amount('hold', 'Hold', 0.2, 'How long the frame sits at full colour.'),
    choice(
      'blend',
      'Blend',
      ['dip', 'flash'],
      0,
      'Dip replaces the picture; flash adds light to it.',
    ),
  ],

  'luma-fade': [
    choice('invert', 'From', ['highlights', 'shadows'], 0, 'Which tones arrive first.'),
  ],

  'noise-dissolve': [
    amount('cell', 'Grain', 0.15, 'Size of the organic patches that arrive first.'),
    seed(),
  ],

  'pixel-dissolve': [count('blockPx', 'Block size', 2, 128, 24), seed()],

  mosaic: [count('blockPx', 'Block size', 2, 160, 48)],

  // --- Wipes ---------------------------------------------------------------
  // `direction` sets the base angle; `angle` tilts off it, which is what turns a
  // horizontal wipe into a diagonal one without a second kind.
  'wipe-linear': [degrees('angle', 'Tilt', 0, 'Rotate the wipe edge off its direction.')],

  'wipe-radial': [...centre(), choice('invert', 'Shape', ['circle in', 'circle out'], 0)],

  'wipe-clock': [
    ...centre(),
    degrees('start', 'Start angle', 0),
    choice('reverse', 'Sweep', ['clockwise', 'anticlockwise'], 0),
  ],

  'wipe-split': [
    choice('axis', 'Axis', ['horizontal', 'vertical'], 0),
    choice('invert', 'From', ['centre', 'edges'], 0),
  ],

  'wipe-shape': [
    choice('shape', 'Shape', ['diamond', 'star', 'cross', 'heart', 'hexagon'], 0),
    ...centre(),
  ],

  'wipe-bars': [
    count('bars', 'Bars', 2, 32, 8),
    choice('axis', 'Axis', ['vertical', 'horizontal'], 0),
    amount('stagger', 'Stagger', 0.3, 'Delay each bar behind the one before it.'),
  ],

  // --- Motion --------------------------------------------------------------
  slide: [
    amount('distance', 'Distance', 1, 'How far off-frame the picture starts.'),
    count(
      'slices',
      'Slices',
      1,
      12,
      1,
      'Split the picture into bands that arrive from alternating sides.',
    ),
    amount('stagger', 'Stagger', 0, 'Delay each slice behind the one before it.'),
  ],

  zoom: [
    { name: 'scaleFrom', label: 'Scale from', min: 0.1, max: 4, step: 0.05, default: 1.6 },
    ...centre(),
    { name: 'rotate', label: 'Rotate', min: -1, max: 1, step: 0.01, default: 0, unit: 'turns' },
  ],

  spin: [
    { name: 'turns', label: 'Turns', min: -3, max: 3, step: 0.05, default: 1 },
    { name: 'scaleFrom', label: 'Scale from', min: 0.1, max: 4, step: 0.05, default: 2 },
  ],

  stretch: [
    choice('axis', 'Axis', ['horizontal', 'vertical'], 0),
    { name: 'stretchAmount', label: 'Stretch', min: 1, max: 12, step: 0.1, default: 5 },
  ],

  shake: [
    amount('shakeAmount', 'Shake', 0.35),
    { name: 'frequency', label: 'Frequency', min: 1, max: 60, step: 1, default: 18, unit: 'Hz' },
    amount('rotate', 'Roll', 0.3, 'How much the frame rolls as well as jumps.'),
    seed(),
  ],

  // --- Optical -------------------------------------------------------------
  'blur-dissolve': [amount('radius', 'Blur', 0.04, 'Starting radius, as a fraction of the frame.')],

  'blur-directional': [
    amount('radius', 'Blur', 0.06, 'Starting smear length, as a fraction of the frame.'),
    amount('travel', 'Travel', 0.35, 'How far the picture also moves along the smear.'),
  ],

  'blur-radial': [
    amount('strength', 'Strength', 0.4),
    ...centre(),
    choice('mode', 'Mode', ['zoom', 'spin'], 0),
  ],

  glitch: [
    count('blocks', 'Blocks', 2, 64, 16),
    amount('displace', 'Displace', 0.25),
    amount('rgbSplit', 'Colour split', 0.4),
    seed(),
  ],

  'rgb-split': [amount('split', 'Split', 0.35), degrees('angle', 'Angle', 0)],

  'light-leak': [
    amount('warmth', 'Warmth', 0.8),
    amount('brightness', 'Brightness', 0.9),
    degrees('angle', 'Angle', 30),
    choice(
      'mode',
      'Mode',
      ['leak', 'burn'],
      0,
      'A leak streaks light in; a burn eats the frame away.',
    ),
  ],

  // --- Deformation ---------------------------------------------------------
  ripple: [
    amount('amplitude', 'Amplitude', 0.12),
    { name: 'frequency', label: 'Frequency', min: 1, max: 40, step: 0.5, default: 12 },
    ...centre(),
  ],

  warp: [amount('amplitude', 'Amplitude', 0.18), amount('cell', 'Scale', 0.35), seed()],

  liquid: [amount('swirl', 'Swirl', 0.6), ...centre()],

  kaleidoscope: [count('segments', 'Segments', 2, 16, 6)],

  // --- Spatial -------------------------------------------------------------
  // One kind, seven looks. A flip is one panel pivoting on its centre; a door is
  // two panels pivoting on their outer edges; a fold is many; a cube pivots on an
  // edge with depth; a carousel adds an arc. Those are genuinely different
  // pictures, and they are all the same projection with different numbers — which
  // is exactly the reuse this catalog is built on.
  'perspective-3d': [
    choice('axis', 'Axis', ['vertical', 'horizontal'], 0, 'Which way the surface turns.'),
    count('panels', 'Panels', 1, 12, 1),
    amount('pivot', 'Pivot', 0, 'Turn about the panel centre (0) or its outer edge (1).'),
    amount('depth', 'Depth', 0.6, 'How much perspective the turn has.'),
    { name: 'turns', label: 'Turn', min: -1, max: 1, step: 0.01, default: 0.25, unit: 'turns' },
    amount('arc', 'Arc', 0, 'Swing the surface along a curve as it turns.'),
    amount('shade', 'Shading', 0.5, 'Darken the surface as it turns away.'),
    amount('push', 'Distance', 0, 'Start the surface further away and let it rush in.'),
  ],

  'page-turn': [
    amount('curl', 'Curl', 0.35, 'How tightly the page rolls.'),
    degrees('angle', 'Angle', 0),
    amount('shade', 'Shading', 0.6),
  ],
};

/**
 * The directions each render kind can express, in menu order.
 *
 * Keyed by render KIND rather than by catalog id, because "can this go left?" is a
 * fact about the shader. A kind with an empty list has no direction to have — a
 * dissolve does not arrive from anywhere — and the Inspector omits the control
 * rather than offering one the renderer ignores.
 *
 * Kinds whose sense of direction is genuinely two-dimensional (which axis a split
 * opens on, which way a clock sweeps) express it as a `choice` param instead, so
 * the single `direction` vocabulary stays one thing everywhere it appears.
 */
export const TRANSITION_DIRECTIONS: Readonly<Record<TransitionRenderKind, readonly string[]>> = {
  dissolve: [],
  'dip-color': [],
  'luma-fade': [],
  'noise-dissolve': [],
  'pixel-dissolve': [],
  mosaic: [],
  'wipe-linear': ['left', 'right', 'up', 'down'],
  'wipe-radial': [],
  'wipe-clock': [],
  'wipe-split': [],
  'wipe-shape': [],
  'wipe-bars': [],
  slide: ['left', 'right', 'up', 'down'],
  zoom: ['in', 'out'],
  spin: [],
  stretch: [],
  shake: [],
  'blur-dissolve': [],
  'blur-directional': ['left', 'right', 'up', 'down'],
  'blur-radial': ['in', 'out'],
  glitch: [],
  'rgb-split': [],
  'light-leak': ['left', 'right', 'up', 'down'],
  ripple: [],
  warp: [],
  liquid: [],
  kaleidoscope: [],
  // Expressed through `axis` and the sign of `turns` instead — the shader never
  // reads a direction, so offering one would be a control with no effect.
  'perspective-3d': [],
  'page-turn': ['left', 'right', 'up', 'down'],
};

/**
 * The universal look params each render kind actually READS.
 *
 * `direction` is answered by {@link TRANSITION_DIRECTIONS} and `easing` is true of
 * every kind (they all run on eased progress), so only these two vary.
 *
 * The point is honesty in the Inspector. A softness slider on a pixel dissolve
 * would move a number the render never looks at — a control with no effect, which
 * is exactly the failure the kind-aware inspector exists to prevent. A parity test
 * checks each shader against this table rather than trusting it.
 */
export const TRANSITION_UNIVERSAL_PARAMS: Readonly<
  Record<TransitionRenderKind, readonly ('intensity' | 'softness')[]>
> = {
  dissolve: ['intensity'],
  'dip-color': ['intensity'],
  // A reveal either happens or it does not; "80 % of a reveal" is not a picture
  // the render can produce. What these kinds have instead is an edge to feather.
  'luma-fade': ['softness'],
  'noise-dissolve': ['softness'],
  // Hard-edged by design — a feather here softens each block and turns the effect
  // back into the dissolve it exists as an alternative to.
  'pixel-dissolve': [],
  mosaic: ['intensity'],
  'wipe-linear': ['softness'],
  'wipe-radial': ['softness'],
  'wipe-clock': ['softness'],
  'wipe-split': ['softness'],
  'wipe-shape': ['softness'],
  'wipe-bars': ['softness'],
  slide: ['intensity'],
  zoom: ['intensity'],
  spin: ['intensity'],
  stretch: ['intensity'],
  shake: ['intensity'],
  'blur-dissolve': ['intensity'],
  'blur-directional': ['intensity'],
  'blur-radial': ['intensity'],
  glitch: ['intensity'],
  'rgb-split': ['intensity'],
  // Burn mode reveals through an edge, so it reads both.
  'light-leak': ['intensity', 'softness'],
  ripple: ['intensity'],
  warp: ['intensity'],
  liquid: ['intensity'],
  kaleidoscope: ['intensity'],
  'perspective-3d': ['intensity'],
  // The curl radius IS its softness and its magnitude; a second knob for either
  // would be two controls fighting over one value.
  'page-turn': [],
};

/** True when `kind` reads the universal param `name` at render time. */
export function readsUniversalParam(
  kind: TransitionRenderKind,
  name: 'intensity' | 'softness',
): boolean {
  return TRANSITION_UNIVERSAL_PARAMS[kind].includes(name);
}

/**
 * Where a transition sits relative to the cut it treats.
 *
 * `start` puts the whole ramp on the incoming clip (this engine's original and
 * still-default behaviour); `end` puts it on the outgoing clip; `centre` splits it.
 * See `docs/guides/transitions.md` for what each looks like on a butt-joined cut.
 */
export type TransitionAlignment = 'start' | 'centre' | 'end';

export const TRANSITION_ALIGNMENTS: readonly TransitionAlignment[] = ['start', 'centre', 'end'];

/** Every render kind, in declaration order. */
export const TRANSITION_RENDER_KINDS = Object.keys(
  TRANSITION_PARAMS,
) as readonly TransitionRenderKind[];

/** Descriptors for a kind. Never empty — every kind declares at least one param. */
export function transitionParamsForKind(
  kind: TransitionRenderKind,
): readonly EffectParamDescriptor[] {
  return TRANSITION_PARAMS[kind];
}

/**
 * The full default parameter set for a kind. Catalog entries shallow-override
 * this, so an entry only has to state what makes it distinctive.
 */
export function defaultTransitionParams(kind: TransitionRenderKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const descriptor of TRANSITION_PARAMS[kind]) out[descriptor.name] = descriptor.default;
  return out;
}

/**
 * Clamp a param bag to its kind's declared ranges, dropping unknown names.
 *
 * The same posture as `clampParamsForKind`: an out-of-range value is worth
 * surfacing, but an *unclamped* one reaches a shader and produces a black frame,
 * so every layer that accepts model- or file-authored params clamps first.
 */
export function clampTransitionParams(
  kind: TransitionRenderKind,
  params: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const out = defaultTransitionParams(kind);
  for (const descriptor of TRANSITION_PARAMS[kind]) {
    const raw = Number(params[descriptor.name]);
    if (!Number.isFinite(raw)) continue;
    out[descriptor.name] = Math.min(descriptor.max, Math.max(descriptor.min, raw));
  }
  return out;
}
