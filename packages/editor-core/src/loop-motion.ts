/**
 * Loop motion for stickers, shapes and titles (plan/elements EL7.2, 05 §5).
 *
 * A loop — pulse, float, wiggle, bounce, spin, blink — is written as ordinary keyframes over the
 * clip's span, the way `track-follow.ts` plans follow keyframes. No new effect type, no evaluator
 * in two runtimes, no schema bump: the transform pipeline already renders keyframed scale, x, y,
 * rotation and opacity for every layer kind, in the monitor and the export alike.
 *
 * The trade-off (ADR 0192): the keyframes cover the clip as it was when the loop was applied, so
 * extending the clip leaves the loop stopping early until it is applied again. `clipLoop` reads
 * a loop back from its keyframe ids and says whether it still covers its clip, for the
 * Inspector's "Re-apply" and the agent's critic.
 *
 * Each loop keyframe's id records what wrote it — `loop__<preset>__<period ms>__<amount ×1000>__<n>`
 * — so the loop can be read back, replaced or cleared without guessing from values.
 */
import type { Clip, Keyframe } from '@framepilot/timeline-schema';
import { evaluateKeyframes } from '@framepilot/timeline-schema/keyframe-curves';
import type { Easing } from './keyframes.js';
import type { ClipKeyframeProperty } from './edit-value-contracts.js';
import type { Operation } from './operations.js';

export const LOOP_PRESETS = ['pulse', 'float', 'wiggle', 'bounce', 'spin', 'blink'] as const;
export type LoopPreset = (typeof LOOP_PRESETS)[number];

/** A bounded number, with the default a loop takes when none is asked for. */
export interface LoopRange {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/** What a preset moves and how far: the Inspector and the agent's tool read the same table. */
export interface LoopPresetInfo {
  readonly label: string;
  readonly property: ClipKeyframeProperty;
  /** Seconds per cycle. */
  readonly period: LoopRange;
  /**
   * How far it moves: a share of its size (pulse), a share of the frame height (float,
   * bounce), degrees (wiggle; per cycle for spin, negative turns the other way), or a share of
   * its opacity it dims by (blink).
   */
  readonly amount: LoopRange;
  readonly amountUnit: 'share of size' | 'share of frame height' | 'degrees' | 'share dimmed';
}

export const LOOP_PRESET_INFO: Readonly<Record<LoopPreset, LoopPresetInfo>> = {
  pulse: {
    label: 'Pulse',
    property: 'scale',
    period: { default: 1, min: 0.2, max: 10 },
    amount: { default: 0.08, min: 0.01, max: 0.5 },
    amountUnit: 'share of size',
  },
  float: {
    label: 'Float',
    property: 'y',
    period: { default: 2, min: 0.2, max: 10 },
    amount: { default: 0.02, min: 0.002, max: 0.2 },
    amountUnit: 'share of frame height',
  },
  wiggle: {
    label: 'Wiggle',
    property: 'rotation',
    period: { default: 0.5, min: 0.2, max: 10 },
    amount: { default: 8, min: 1, max: 45 },
    amountUnit: 'degrees',
  },
  bounce: {
    label: 'Bounce',
    property: 'y',
    period: { default: 0.8, min: 0.2, max: 10 },
    amount: { default: 0.04, min: 0.005, max: 0.3 },
    amountUnit: 'share of frame height',
  },
  spin: {
    label: 'Spin',
    property: 'rotation',
    period: { default: 2, min: 0.2, max: 10 },
    amount: { default: 360, min: -1080, max: 1080 },
    amountUnit: 'degrees',
  },
  blink: {
    label: 'Blink',
    property: 'opacity',
    period: { default: 1, min: 0.2, max: 10 },
    amount: { default: 0.8, min: 0.1, max: 1 },
    amountUnit: 'share dimmed',
  },
};

/** What a property is with no keyframes at all (the compiler's defaults). */
const PROPERTY_DEFAULTS: Readonly<Record<ClipKeyframeProperty, number>> = {
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
};

/**
 * More keyframes than this is a loop too fast for its clip (a minute of wiggle every fifth of a
 * second): refused rather than written, because the project would carry it on every save.
 */
const MAX_LOOP_KEYFRAMES = 1200;
const TIME_EPSILON = 1e-9;
const ID_PATTERN = /^loop__([a-z]+)__(\d+)__(-?\d+)__\d+$/;

export interface LoopRequest {
  readonly preset: LoopPreset;
  readonly periodSeconds?: number;
  readonly amount?: number;
}

export type LoopPlan =
  | {
      readonly ok: true;
      readonly property: ClipKeyframeProperty;
      readonly operations: readonly Operation[];
    }
  | {
      readonly ok: false;
      readonly reason: 'property_animated' | 'clip_too_short' | 'too_many_keyframes';
      readonly detail: string;
    };

/** A loop found on a clip. */
export interface AppliedLoop {
  readonly preset: LoopPreset;
  readonly property: ClipKeyframeProperty;
  readonly periodSeconds: number;
  readonly amount: number;
  /** False once the clip has been extended past the loop's last cycle. */
  readonly coversClip: boolean;
}

const clamp = (value: number, range: LoopRange): number =>
  Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : range.default;

const isLoopKeyframe = (keyframe: Keyframe): boolean => ID_PATTERN.test(keyframe.id);

/** One cycle of a waveform: points at phases 0..1, each easing into the next. */
interface WavePoint {
  readonly phase: number;
  /** -1..1, scaled by the amount (bounce and blink use 0..1). */
  readonly level: number;
  readonly easing: Easing;
}

const SINE: readonly WavePoint[] = [
  { phase: 0, level: 0, easing: 'ease-out' },
  { phase: 0.25, level: 1, easing: 'ease-in-out' },
  { phase: 0.5, level: 0, easing: 'ease-in-out' },
  { phase: 0.75, level: -1, easing: 'ease-in' },
];
const HOP: readonly WavePoint[] = [
  { phase: 0, level: 0, easing: 'ease-out' },
  { phase: 0.5, level: 1, easing: 'ease-in' },
];
const BLINK: readonly WavePoint[] = [
  { phase: 0, level: 0, easing: 'hold' },
  { phase: 0.5, level: 1, easing: 'hold' },
];

/** The value at `level` of a waveform, around `base`. */
function valueAt(
  preset: LoopPreset,
  base: number,
  amount: number,
  level: number,
  frameHeight: number,
): number {
  switch (preset) {
    case 'pulse':
      return base * (1 + amount * level);
    case 'float':
      return base + amount * frameHeight * level;
    case 'bounce':
      // Up is negative y in frame pixels.
      return base - amount * frameHeight * level;
    case 'wiggle':
      return base + amount * level;
    case 'blink':
      return base * (1 - amount * level);
    case 'spin':
      return base;
  }
}

const WAVES: Readonly<Record<Exclude<LoopPreset, 'spin'>, readonly WavePoint[]>> = {
  pulse: SINE,
  float: SINE,
  wiggle: SINE,
  bounce: HOP,
  blink: BLINK,
};

/** The property's value at the clip's start, from what is not a loop. */
function baseValue(clip: Clip, property: ClipKeyframeProperty): number {
  const loop = clip.keyframes
    .filter((keyframe) => keyframe.property === property && isLoopKeyframe(keyframe))
    .sort((a, b) => a.time - b.time)[0];
  // Every waveform starts at its base, so a loop being replaced remembers the placement.
  if (loop !== undefined) return loop.value;
  const own = clip.keyframes.filter((keyframe) => !isLoopKeyframe(keyframe));
  return evaluateKeyframes(own, property, 0) ?? PROPERTY_DEFAULTS[property];
}

/** Clear `property`'s keyframes and key it at the clip's start at `value`. */
function restoreOperations(clip: Clip, property: ClipKeyframeProperty, value: number): Operation[] {
  return [
    { type: 'remove_keyframes', clipId: clip.id, targets: [{ property }] },
    {
      type: 'add_keyframes',
      clipId: clip.id,
      keyframes: [
        { id: `kf_${clip.id}_${property}_0`, time: 0, property, value, easing: 'linear' },
      ],
    },
  ];
}

/**
 * The keyframes that loop `request.preset` over `clip`, as one reversible set of operations: the
 * clip's existing loop is cleared first (its property restored to the placement), then the
 * loop's property is keyed over the whole clip.
 *
 * @param frame - The project frame, which float and bounce move a share of.
 */
export function planLoopMotion(
  clip: Clip,
  request: LoopRequest,
  frame: { readonly width: number; readonly height: number },
): LoopPlan {
  const info = LOOP_PRESET_INFO[request.preset];
  const property = info.property;
  const period = clamp(request.periodSeconds ?? info.period.default, info.period);
  const amount = clamp(request.amount ?? info.amount.default, info.amount);
  const duration = clip.end - clip.start;
  const own = clip.keyframes.filter(
    (keyframe) => keyframe.property === property && !isLoopKeyframe(keyframe),
  );
  if (own.some((keyframe) => keyframe.time > TIME_EPSILON)) {
    return {
      ok: false,
      reason: 'property_animated',
      detail: `This clip's ${property} is already animated. Clear those keyframes first, or pick a loop that moves something else.`,
    };
  }
  const wave = request.preset === 'spin' ? null : WAVES[request.preset];
  const step = wave === null ? period : period * (wave[1]?.phase ?? 1);
  if (duration < step - TIME_EPSILON) {
    return {
      ok: false,
      reason: 'clip_too_short',
      detail:
        'This clip is too short for that loop to move. Make the clip longer, or pick a faster loop.',
    };
  }
  const base = baseValue(clip, property);
  const id = (index: number): string =>
    `loop__${request.preset}__${Math.round(period * 1000)}__${Math.round(amount * 1000)}__${index}`;
  const keyframes: Keyframe[] = [];
  if (wave === null) {
    keyframes.push(
      { id: id(0), time: 0, property, value: base, easing: 'linear' },
      {
        id: id(1),
        time: duration,
        property,
        value: base + amount * (duration / period),
        easing: 'linear',
      },
    );
  } else {
    for (let cycle = 0; cycle * period <= duration + TIME_EPSILON; cycle += 1) {
      for (const point of wave) {
        const time = (cycle + point.phase) * period;
        if (time > duration + TIME_EPSILON) break;
        if (keyframes.length >= MAX_LOOP_KEYFRAMES) {
          return {
            ok: false,
            reason: 'too_many_keyframes',
            detail:
              'That loop is too fast for a clip this long. Slow it down, or shorten the clip.',
          };
        }
        keyframes.push({
          id: id(keyframes.length),
          time: Math.min(time, duration),
          property,
          value: valueAt(request.preset, base, amount, point.level, frame.height),
          easing: point.easing,
        });
      }
    }
  }
  const existing = clipLoop(clip);
  const clearOld =
    existing !== null && existing.property !== property
      ? restoreOperations(clip, existing.property, baseValue(clip, existing.property))
      : [];
  return {
    ok: true,
    property,
    operations: [
      ...clearOld,
      { type: 'remove_keyframes', clipId: clip.id, targets: [{ property }] },
      { type: 'add_keyframes', clipId: clip.id, keyframes },
    ],
  };
}

/** The loop on `clip`, read from its keyframe ids, or `null`. */
export function clipLoop(clip: Clip): AppliedLoop | null {
  const loopKeys = clip.keyframes.filter(isLoopKeyframe);
  const first = loopKeys[0];
  if (first === undefined) return null;
  const match = ID_PATTERN.exec(first.id);
  const preset = match?.[1] as LoopPreset | undefined;
  if (match === null || preset === undefined || !(preset in LOOP_PRESET_INFO)) return null;
  const periodSeconds = Number(match[2]) / 1000;
  const last = Math.max(...loopKeys.map((keyframe) => keyframe.time));
  const duration = clip.end - clip.start;
  // A loop covers its clip while no more than one cycle is left unkeyed at the end.
  return {
    preset,
    property: LOOP_PRESET_INFO[preset].property,
    periodSeconds,
    amount: Number(match[3]) / 1000,
    coversClip: duration - last <= periodSeconds + TIME_EPSILON,
  };
}

/** Clear `clip`'s loop, restoring its property to the placement; empty when there is none. */
export function clearLoopOperations(clip: Clip): readonly Operation[] {
  const loop = clipLoop(clip);
  if (loop === null) return [];
  return restoreOperations(clip, loop.property, baseValue(clip, loop.property));
}
