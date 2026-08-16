/**
 * Reading a stored transition into something a renderer can run.
 *
 * A transition on disk is deliberately loose — `Effect.params` is
 * `Record<string, unknown>`, so a kind can arrive as a number, an intensity as a
 * string, and a param can name something the kind does not have. Every renderer
 * needs the same tidy, clamped, fully-defaulted view of it, and there must be
 * exactly one place that produces that view: the GPU preview and the panel's
 * hover previews both read this module, and the numpy dispatcher mirrors it.
 *
 * ## The uniform contract
 *
 * {@link transitionUniforms} lays a kind's params out in the order
 * `TRANSITION_PARAMS` declares them. That order IS the shader's `uParams[i]`
 * indices and the numpy dispatcher's unpack order. Nothing else enforces it, so
 * `parity.test.ts` pins it.
 *
 * ## What this module does NOT do
 *
 * It does not evaluate a look. `opacityAt`, `wipeAlpha` and friends stayed in
 * `../transition-envelope.ts`: those are the *legacy* seven kinds' envelope math,
 * mirrored value-for-value against `render/transitions.py`, and they still drive
 * the DOM preview's CSS approximation. This module resolves; the shader draws.
 */
import { applyEasing, readAlignment, type TransitionAlignment } from '@framepilot/editor-core';
import type { Clip, Effect } from '@framepilot/timeline-schema';
import {
  DEFAULT_TRANSITION_ID,
  getTransition,
  resolveTransitionParams,
} from '@framepilot/timeline-schema/transition-catalog';
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_PARAMS,
  type TransitionRenderKind,
} from '@framepilot/timeline-schema/transition-params';

/** Max params any kind declares — the shader's `uParams` array size. */
export const MAX_TRANSITION_PARAMS = 8;

/** The default softness, matching `render/transitions.py`'s `DEFAULT_SOFTNESS`. */
export const DEFAULT_SOFTNESS = 0.2;

/** A stored transition, resolved against the catalog and clamped. */
export interface ResolvedTransition {
  /** The catalog id as stored. */
  readonly kind: string;
  /** The pass a renderer actually runs. */
  readonly renderKind: TransitionRenderKind;
  readonly duration: number;
  readonly alignment: TransitionAlignment;
  /** Resolved against what the render kind accepts; `''` when it has no direction. */
  readonly direction: string;
  readonly intensity: number;
  readonly softness: number;
  readonly easing: string;
  /** Kind defaults ← catalog overrides ← stored overrides, all clamped. */
  readonly params: Readonly<Record<string, number>>;
  /** True for the catalog's hard-cut entry: renders nothing. */
  readonly isCut: boolean;
  /**
   * Held off without being removed — the "compare with and without" toggle.
   *
   * Distinct from removing it: the transition, its duration and every tuned
   * parameter are still there, so turning it back on is not a re-decision.
   */
  readonly disabled: boolean;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Coerce a free-form param to a finite number, falling back when it is not one. */
const asNumber = (value: unknown, fallback: number): number => {
  const coerced = Number(value);
  return Number.isFinite(coerced) ? coerced : fallback;
};

/**
 * Resolve one transition effect's params.
 *
 * Layering is deliberate and one-way: the render kind's declared defaults are the
 * floor, the catalog entry states what makes it itself, and only then does what
 * the user actually stored win. That is what lets the Inspector write a single
 * changed number without having to re-serialize the whole look — and what lets a
 * catalog entry be improved later without rewriting anyone's project file.
 */
export function resolveTransitionParamsFor(
  params: Readonly<Record<string, unknown>>,
): ResolvedTransition | null {
  const kind = String(params.kind ?? DEFAULT_TRANSITION_ID);
  const entry = getTransition(kind);
  if (entry === undefined) return null;

  const resolved = resolveTransitionParams(entry);
  for (const descriptor of TRANSITION_PARAMS[entry.renderKind]) {
    const stored = params[descriptor.name];
    if (stored === undefined) continue;
    const value = asNumber(stored, resolved[descriptor.name] ?? descriptor.default);
    resolved[descriptor.name] = Math.min(descriptor.max, Math.max(descriptor.min, value));
  }

  const allowed = TRANSITION_DIRECTIONS[entry.renderKind];
  const storedDirection = typeof params.direction === 'string' ? params.direction : '';
  const direction = allowed.includes(storedDirection)
    ? storedDirection
    : ((entry.direction !== undefined && allowed.includes(entry.direction)
        ? entry.direction
        : allowed[0]) ?? '');

  return {
    kind,
    renderKind: entry.renderKind,
    duration: Math.max(0, asNumber(params.durationSeconds ?? entry.defaultDuration, 0)),
    alignment: readAlignment(params),
    direction,
    intensity: clamp01(asNumber(params.intensity ?? entry.intensity ?? 1, 1)),
    softness: clamp01(
      asNumber(params.softness ?? entry.softness ?? DEFAULT_SOFTNESS, DEFAULT_SOFTNESS),
    ),
    easing: String(params.easing ?? entry.easing ?? 'linear'),
    params: resolved,
    isCut: entry.isCut === true,
    disabled: params.disabled === true,
  };
}

/** Resolve the `transition` effect entering `clip`, or `null` when it enters on a cut. */
export function resolveClipTransition(clip: Clip): ResolvedTransition | null {
  const effect: Effect | undefined = clip.effects.find((e) => e.type === 'transition');
  if (effect === undefined) return null;
  return resolveTransitionParamsFor(effect.params ?? {});
}

/**
 * The transition's params as the shader's `uParams`, in declared order.
 *
 * Always {@link MAX_TRANSITION_PARAMS} long. Unused slots stay 0 rather than being
 * left uninitialized: a stale value from the previously-drawn kind in those slots
 * is the kind of bug that only appears when two different transitions are on
 * screen in the same session.
 */
export function transitionUniforms(transition: ResolvedTransition): Float32Array {
  const out = new Float32Array(MAX_TRANSITION_PARAMS);
  const descriptors = TRANSITION_PARAMS[transition.renderKind];
  for (let i = 0; i < descriptors.length && i < MAX_TRANSITION_PARAMS; i += 1) {
    out[i] = transition.params[descriptors[i]!.name] ?? descriptors[i]!.default;
  }
  return out;
}

/**
 * Unit travel vector for a direction, in SCREEN space (y grows downward).
 *
 * Screen space rather than GL space because every other consumer of a direction
 * in this app — CSS transforms, canvas offsets, the numpy compiler — is already
 * y-down, and the one place that is not (the shader) flips it once, on upload.
 * The historical values in `../transition-envelope.ts` are the same table.
 */
export function directionVector(direction: string): readonly [number, number] {
  switch (direction) {
    case 'left':
      return [-1, 0];
    case 'right':
      return [1, 0];
    case 'up':
      return [0, -1];
    case 'down':
      return [0, 1];
    default:
      // `in`/`out` and the direction-less kinds. Zero, so a pass that multiplies
      // by the vector is a no-op rather than picking an arbitrary axis.
      return [0, 0];
  }
}

/**
 * +1 for `in`, −1 for `out`, 0 when the kind has no in/out sense.
 *
 * Separate from {@link directionVector} because `in`/`out` is a scalar: it is a
 * sign on a magnitude, not a heading, and encoding it as a vector would let a
 * pass accidentally translate along it.
 */
export function directionSign(direction: string): number {
  if (direction === 'in') return 1;
  if (direction === 'out') return -1;
  return 0;
}

/**
 * Progress on the transition's own curve.
 *
 * Easing applies to the WHOLE effect — a slide's motion and a dissolve's opacity
 * alike — rather than to one aspect of it, matching `eased_progress` in
 * `render/transitions.py`. Unknown curve names fall back to linear inside
 * `applyEasing`, which is the pre-catalog behaviour.
 */
export function easedProgress(transition: ResolvedTransition, progress: number): number {
  return applyEasing(transition.easing, clamp01(progress));
}

/**
 * True when this transition changes nothing and can be skipped entirely.
 *
 * The cheap identity check the preview engine needs per frame: a hard cut, a
 * zero-length ramp, or a transition that has already finished costs nothing.
 */
export function isInertTransition(transition: ResolvedTransition, progress: number): boolean {
  return transition.isCut || transition.disabled || transition.duration <= 0 || progress >= 1;
}
