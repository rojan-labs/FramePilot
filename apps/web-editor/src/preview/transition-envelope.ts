/**
 * Transition envelopes for the live preview — the TS mirror of the engine's
 * `framepilot_engine/render/transitions.py` (the source of truth for
 * semantics). Same constants, same progress, so what the preview shows
 * during the ramp is what the MoviePy render exports. Pure math: no DOM, no
 * canvas — both preview paths (WebCodecs canvas engine and the DOM
 * `PreviewPlayer`) evaluate these per frame.
 *
 * A transition is the `transition` effect stored on the *incoming* clip
 * (params `{ kind, durationSeconds, fromClipId }`); it eases that clip in over
 * its first `durationSeconds` of clip-relative time.
 *
 * ## Parameters (revamp Phase 9)
 *
 * `direction` / `intensity` / `softness` / `easing` are additive into the
 * free-form `Effect.params` — no schema change, no migration (sub-plan §4.3).
 * Every default reproduces the pre-Phase-9 output **exactly**, so existing
 * projects preview and render as they always did. The reasoning for each default
 * (notably why `easing` is `linear` and not `ease-in-out`) lives in the Python
 * module's docstring; this file must not drift from it.
 */
import { applyEasing } from '@framepilot/editor-core';
import type { Clip, Effect } from '@framepilot/timeline-schema';

/** A parsed transition on the incoming clip (identity kinds like `cut` are no-ops). */
export interface TransitionEnvelope {
  readonly kind: string;
  readonly duration: number;
  /** Which way the transition moves; `''` = use the kind's default. */
  readonly direction: string;
  /** How far the effect travels from rest, 0..1. */
  readonly intensity: number;
  /** Wipe edge feather, 0..1. */
  readonly softness: number;
  readonly easing: string;
}

// Mirrors of the Python module's constants — keep in lockstep with
// `render/transitions.py` (unit tests pin these values).
const OPACITY_KINDS: ReadonlySet<string> = new Set(['fade', 'cross-dissolve']);
const GEOMETRY_KINDS: ReadonlySet<string> = new Set(['push', 'zoom', 'slide']);
const ZOOM_FROM = 1.6;
const PUSH_FRACTION = 1.0;
const SLIDE_FRACTION = 1.0;
const BLUR_FRACTION = 0.04;
/** Wipe's default soft-edge width as a fraction of the sweep axis. */
export const WIPE_SOFTNESS = 0.05;
const WIPE_SOFTNESS_MAX = 0.25;
/** Chosen so the default softness reproduces {@link WIPE_SOFTNESS} exactly. */
export const DEFAULT_SOFTNESS = WIPE_SOFTNESS / WIPE_SOFTNESS_MAX;
const MIN_SOFTNESS_FRACTION = 1e-3;

/** The direction each kind moves when `direction` is absent (= pre-Phase-9 behaviour). */
export const DEFAULT_DIRECTIONS: Readonly<Record<string, string>> = {
  push: 'left',
  slide: 'up',
  wipe: 'right',
  zoom: 'in',
};

/** The directions each kind can express; anything else falls back to the default. */
export const DIRECTIONS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  push: ['left', 'right', 'up', 'down'],
  slide: ['left', 'right', 'up', 'down'],
  wipe: ['left', 'right', 'up', 'down'],
  zoom: ['in', 'out'],
};

/** Unit travel vector per direction, in screen space (y grows downward). */
const TRAVEL: Readonly<Record<string, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Coerce a free-form param to a finite number, falling back when it is not one.
 * `Effect.params` is `Record<string, unknown>`, so a value can arrive as a string
 * from a hand-edited project or an AI patch.
 */
const asNumber = (value: unknown, fallback: number): number => {
  const coerced = Number(value);
  return Number.isFinite(coerced) ? coerced : fallback;
};

/**
 * The clip on the other side of a transition's cut, as the effect itself names it.
 *
 * The monitor needs it for the same reason the export compiler does: a transition ramps the
 * incoming clip in over its own first frames, by which time the outgoing clip has ended, so
 * without that shot underneath the reveal happens over the empty ground — a dissolve from
 * black rather than from the previous shot.
 */
export function transitionCounterpartId(clip: Clip): string | null {
  const effect: Effect | undefined = clip.effects.find((e) => e.type === 'transition');
  const named = effect?.params?.['fromClipId'];
  return typeof named === 'string' && named.length > 0 ? named : null;
}

/** Parse a clip's `transition` effect (or `null` when the clip enters on a cut). */
export function transitionFromClip(clip: Clip): TransitionEnvelope | null {
  const effect: Effect | undefined = clip.effects.find((e) => e.type === 'transition');
  if (!effect) return null;
  const params = effect.params ?? {};
  return {
    kind: String(params.kind ?? 'cut'),
    duration: Math.max(0, asNumber(params.durationSeconds ?? 0.5, 0)),
    direction: String(params.direction ?? ''),
    intensity: clamp01(asNumber(params.intensity ?? 1, 1)),
    softness: clamp01(asNumber(params.softness ?? DEFAULT_SOFTNESS, DEFAULT_SOFTNESS)),
    easing: String(params.easing ?? 'linear'),
  };
}

/** The direction actually used: the param when the kind accepts it, else the default. */
export function resolvedDirection(tr: TransitionEnvelope): string {
  const allowed = DIRECTIONS_BY_KIND[tr.kind] ?? [];
  if (allowed.includes(tr.direction)) return tr.direction;
  return DEFAULT_DIRECTIONS[tr.kind] ?? '';
}

/** Linear progress in [0, 1] over the first `duration` seconds (1 after). */
export function transitionProgress(t: number, duration: number): number {
  if (duration <= 0) return 1;
  if (t <= 0) return 0;
  if (t >= duration) return 1;
  return t / duration;
}

/**
 * Progress through `tr` at clip-relative `t`, on the transition's own curve.
 *
 * Every envelope below runs on this rather than raw {@link transitionProgress}, so
 * easing applies to the *whole* effect — a slide's motion and a dissolve's opacity
 * alike — rather than to one aspect of it.
 */
export function easedProgress(tr: TransitionEnvelope, t: number): number {
  return applyEasing(tr.easing, transitionProgress(t, tr.duration));
}

export function affectsOpacity(tr: TransitionEnvelope): boolean {
  return OPACITY_KINDS.has(tr.kind);
}

export function affectsGeometry(tr: TransitionEnvelope): boolean {
  return GEOMETRY_KINDS.has(tr.kind);
}

export function affectsBlur(tr: TransitionEnvelope): boolean {
  return tr.kind === 'blur';
}

export function affectsWipe(tr: TransitionEnvelope): boolean {
  return tr.kind === 'wipe';
}

/** True when the envelope changes anything at clip-relative time `t`. */
export function transitionActiveAt(tr: TransitionEnvelope, t: number): boolean {
  if (t >= tr.duration) return false;
  return affectsOpacity(tr) || affectsGeometry(tr) || affectsBlur(tr) || affectsWipe(tr);
}

/**
 * Opacity multiplier (1 unless this is an opacity transition, still ramping).
 *
 * `intensity` sets how far down the dip goes: 1 ramps from fully transparent,
 * 0.5 from half-opaque — a softer dissolve that never fully loses the picture.
 */
export function opacityAt(tr: TransitionEnvelope, t: number): number {
  if (!affectsOpacity(tr)) return 1;
  const floor = 1 - tr.intensity;
  return floor + (1 - floor) * easedProgress(tr, t);
}

/**
 * The scale a zoom transition starts at, before decaying to 1.
 *
 * `in` starts larger and settles; `out` starts smaller and grows. The two are
 * reciprocals so neither can reach zero and intensity 0 is a no-op either way.
 */
export function zoomFrom(tr: TransitionEnvelope): number {
  const magnitude = 1 + (ZOOM_FROM - 1) * tr.intensity;
  return resolvedDirection(tr) === 'out' ? 1 / magnitude : magnitude;
}

/** Extra scale factor for a zoom transition (1 otherwise). */
export function scaleAt(tr: TransitionEnvelope, t: number): number {
  if (tr.kind !== 'zoom') return 1;
  const start = zoomFrom(tr);
  return start + (1 - start) * easedProgress(tr, t);
}

/**
 * Pixel `[dx, dy]` offset for a push/slide transition (zero otherwise).
 *
 * The clip starts one frame away **opposite** its travel direction and decays to
 * rest, so `direction: 'left'` starts off-screen right and moves left.
 */
export function offsetAt(
  tr: TransitionEnvelope,
  t: number,
  frameWidth: number,
  frameHeight: number,
): readonly [number, number] {
  if (tr.kind !== 'push' && tr.kind !== 'slide') return [0, 0];
  const [travelX, travelY] = TRAVEL[resolvedDirection(tr)] ?? [0, 0];
  const remaining = (1 - easedProgress(tr, t)) * tr.intensity;
  // `+ 0` normalises the negative zero a horizontal travel produces on the y axis.
  // Harmless in CSS, but `-0` survives `Object.is`, so a caller comparing an offset
  // against 0 to skip a transform would take the slow path forever.
  return [
    -travelX * frameWidth * PUSH_FRACTION * remaining + 0,
    -travelY * frameHeight * SLIDE_FRACTION * remaining + 0,
  ];
}

/** Gaussian blur radius (px) for a blur transition, decaying to 0 (0 otherwise). */
export function blurRadiusAt(tr: TransitionEnvelope, t: number, frameMinDim: number): number {
  if (tr.kind !== 'blur') return 0;
  return frameMinDim * BLUR_FRACTION * tr.intensity * (1 - easedProgress(tr, t));
}

/** Wipe reveal progress in [0, 1] (1 for non-wipe kinds — fully shown). */
export function wipeProgressAt(tr: TransitionEnvelope, t: number): number {
  if (!affectsWipe(tr)) return 1;
  return easedProgress(tr, t);
}

/** The wipe's edge feather as a frame fraction, from its `softness` param. */
export function wipeSoftness(tr: TransitionEnvelope): number {
  return Math.max(MIN_SOFTNESS_FRACTION, tr.softness * WIPE_SOFTNESS_MAX);
}

/**
 * Which axis a wipe sweeps along, and whether the axis fraction is inverted.
 *
 * Inverting the fraction is what turns a left→right sweep into right→left without a
 * second formula: the reveal always advances in increasing fraction, and the
 * fraction itself is mirrored.
 */
export function wipeAxis(tr: TransitionEnvelope): readonly ['x' | 'y', boolean] {
  const direction = resolvedDirection(tr);
  if (direction === 'left') return ['x', true];
  if (direction === 'up') return ['y', true];
  if (direction === 'down') return ['y', false];
  return ['x', false];
}

/** The wipe edge position (frame fraction) at progress `p`. */
export function wipeEdge(p: number, softness: number = WIPE_SOFTNESS): number {
  return p * (1 + softness);
}

/**
 * Alpha at position `xFrac` (0..1 along the sweep axis) for wipe progress `p` — a
 * reveal with a `softness`-wide soft edge (0 everywhere at `p === 0`, 1 everywhere
 * at `p === 1`).
 *
 * `p >= 1` short-circuits rather than relying on the edge overshoot, which is only
 * *exactly* clear in exact arithmetic: at `softness = 0.15` the far column comes out
 * as `0.9999999999999994`. Mirrors the Python guard — see its docstring.
 */
export function wipeAlpha(xFrac: number, p: number, softness: number = WIPE_SOFTNESS): number {
  if (p >= 1) return 1;
  const alpha = (wipeEdge(p, softness) - xFrac) / softness;
  if (alpha <= 0) return 0;
  if (alpha >= 1) return 1;
  return alpha;
}

/** CSS gradient direction per wipe direction — the reveal sweeps *towards* this side. */
const WIPE_CSS_SIDE: Readonly<Record<string, string>> = {
  right: 'to right',
  left: 'to left',
  down: 'to bottom',
  up: 'to top',
};

/**
 * The `mask-image` gradient that reveals a wiping picture in the DOM preview, or
 * `undefined` once it is fully revealed.
 *
 * Lives here rather than in the component so the direction → CSS-side mapping has
 * exactly one definition; the canvas engine reads {@link wipeAxis} for the same
 * fact, and the two disagreeing would mean the two preview surfaces wiped opposite
 * ways from each other and from the export.
 *
 * @param tr - The wipe envelope.
 * @param p - Reveal progress from {@link wipeProgressAt}.
 */
export function wipeCssMask(tr: TransitionEnvelope, p: number): string | undefined {
  if (p >= 1) return undefined;
  const softness = wipeSoftness(tr);
  const side = WIPE_CSS_SIDE[resolvedDirection(tr)] ?? 'to right';
  const edge = wipeEdge(p, softness);
  return `linear-gradient(${side}, black ${(edge - softness) * 100}%, transparent ${edge * 100}%)`;
}
