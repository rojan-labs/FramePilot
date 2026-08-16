/**
 * Canonical frame-time conversion for AI-authored edits.
 *
 * The persisted project format still stores seconds. At the trusted patch boundary,
 * model-authored SEQUENCE timing is snapped to an integer project frame before patch
 * identity, validation, preview, and render can disagree about a fractional value.
 *
 * Source-domain values are intentionally not snapped here. A source asset can have a
 * different frame rate from the sequence, and this boundary currently receives only
 * the project FPS. Rewriting source timestamps against the sequence FPS would be less
 * precise, not more. Operations that couple source and sequence duration (`add_clip`)
 * therefore remain unchanged until the media-time contract supplies source FPS and an
 * explicit retime policy. Transcript observations and inverse snapshots also stay
 * untouched because they are evidence or exact prior state, not new edit decisions.
 */
import type { AnyOperation } from '@framepilot/editor-core';
import type { Effect, EffectLayer, Keyframe } from '@framepilot/timeline-schema';

export type FrameRounding = 'nearest' | 'floor' | 'ceil';

export interface RationalFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

const MAX_RATE_DENOMINATOR = 1001;
const RATE_EPSILON = 1e-6;
const COMMON_RATES: readonly { readonly fps: number; readonly rate: RationalFrameRate }[] = [
  { fps: 23.976, rate: { numerator: 24_000, denominator: 1001 } },
  { fps: 29.97, rate: { numerator: 30_000, denominator: 1001 } },
  { fps: 47.952, rate: { numerator: 48_000, denominator: 1001 } },
  { fps: 59.94, rate: { numerator: 60_000, denominator: 1001 } },
  { fps: 119.88, rate: { numerator: 120_000, denominator: 1001 } },
];

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

/** Resolve a positive finite FPS value to a stable rational rate. */
export function rationalFrameRate(fps: number): RationalFrameRate {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`Frame rate must be a positive finite number, got ${String(fps)}.`);
  }

  const common = COMMON_RATES.find((candidate) => Math.abs(candidate.fps - fps) <= RATE_EPSILON);
  if (common) return common.rate;

  let bestNumerator = Math.round(fps);
  let bestDenominator = 1;
  let bestError = Math.abs(bestNumerator / bestDenominator - fps);

  for (let denominator = 2; denominator <= MAX_RATE_DENOMINATOR; denominator += 1) {
    const numerator = Math.round(fps * denominator);
    const error = Math.abs(numerator / denominator - fps);
    if (error < bestError) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestError = error;
    }
    if (error === 0) break;
  }

  const divisor = greatestCommonDivisor(bestNumerator, bestDenominator);
  return {
    numerator: bestNumerator / divisor,
    denominator: bestDenominator / divisor,
  };
}

/** Convert seconds to an integer frame using one explicit rounding policy. */
export function secondsToFrame(
  seconds: number,
  fps: number,
  rounding: FrameRounding = 'nearest',
): number {
  if (!Number.isFinite(seconds)) {
    throw new RangeError(`Time must be finite, got ${String(seconds)}.`);
  }
  const rate = rationalFrameRate(fps);
  const frame = (seconds * rate.numerator) / rate.denominator;
  switch (rounding) {
    case 'floor':
      return Math.floor(frame);
    case 'ceil':
      return Math.ceil(frame);
    case 'nearest':
      return Math.round(frame);
  }
}

/** Convert an integer frame back to seconds at the same rational rate. */
export function frameToSeconds(frame: number, fps: number): number {
  if (!Number.isInteger(frame)) {
    throw new RangeError(`Frame must be an integer, got ${String(frame)}.`);
  }
  const rate = rationalFrameRate(fps);
  return (frame * rate.denominator) / rate.numerator;
}

/** Snap a sequence time to the nearest project frame. */
export function snapSecondsToFrame(seconds: number, fps: number): number {
  return frameToSeconds(secondsToFrame(seconds, fps), fps);
}

function snapKeyframe(keyframe: Keyframe, fps: number): Keyframe {
  return { ...keyframe, time: snapSecondsToFrame(keyframe.time, fps) };
}

function snapKeyframes(
  keyframes: readonly Keyframe[] | undefined,
  fps: number,
): readonly Keyframe[] | undefined {
  return keyframes?.map((keyframe) => snapKeyframe(keyframe, fps));
}

function snapEffect(effect: Effect, fps: number): Effect {
  return { ...effect, keyframes: effect.keyframes.map((keyframe) => snapKeyframe(keyframe, fps)) };
}

function snapEffectLayer(layer: EffectLayer, fps: number): EffectLayer {
  return {
    ...layer,
    start: snapSecondsToFrame(layer.start, fps),
    end: snapSecondsToFrame(layer.end, fps),
    keyframes: layer.keyframes.map((keyframe) => snapKeyframe(keyframe, fps)),
  };
}

/**
 * Normalize one AI-authored operation to project-frame boundaries.
 *
 * Snapshot operations (`restore_*`, seeded `add_layer`) and source observations
 * (`set_transcript`, caption cue words, speed-ramp source points, coupled add-clip
 * ranges) deliberately pass through unchanged. Their values describe exact prior
 * state, provider evidence, or two time domains that require more context.
 */
export function normalizeOperationTime(op: AnyOperation, fps: number): AnyOperation {
  switch (op.type) {
    case 'trim_clip':
      return {
        ...op,
        start: snapSecondsToFrame(op.start, fps),
        end: snapSecondsToFrame(op.end, fps),
      };
    case 'split_clip': {
      // An old deterministic recipe fixture used `time` before the operation contract
      // standardized on `at`. Accept it only at this migration boundary and emit the
      // canonical shape, so downstream validation never receives two field names.
      const legacy = op as typeof op & { readonly time?: number };
      const at = Number.isFinite(op.at) ? op.at : legacy.time;
      if (at === undefined) return op;
      const { time: _legacyTime, ...canonical } = legacy;
      return { ...canonical, at: snapSecondsToFrame(at, fps) };
    }
    case 'delete_range':
    case 'ripple_delete':
      return {
        ...op,
        start: snapSecondsToFrame(op.start, fps),
        end: snapSecondsToFrame(op.end, fps),
      };
    case 'move_clip':
      return { ...op, toStart: snapSecondsToFrame(op.toStart, fps) };
    case 'add_text_overlay':
    case 'add_caption_layer':
      return {
        ...op,
        start: snapSecondsToFrame(op.start, fps),
        end: snapSecondsToFrame(op.end, fps),
      };
    case 'add_keyframes':
      return { ...op, keyframes: op.keyframes.map((keyframe) => snapKeyframe(keyframe, fps)) };
    case 'remove_keyframes':
      return {
        ...op,
        targets: op.targets.map((target) => ({
          ...target,
          ...(target.time === undefined ? {} : { time: snapSecondsToFrame(target.time, fps) }),
        })),
      };
    case 'apply_color_grade':
      return { ...op, effect: snapEffect(op.effect, fps) };
    case 'adjust_audio':
      return {
        ...op,
        ...(op.fadeInSeconds === undefined
          ? {}
          : { fadeInSeconds: snapSecondsToFrame(op.fadeInSeconds, fps) }),
        ...(op.fadeOutSeconds === undefined
          ? {}
          : { fadeOutSeconds: snapSecondsToFrame(op.fadeOutSeconds, fps) }),
      };
    case 'add_transition': {
      // A positive request shorter than one frame is intentionally promoted to one
      // frame. A zero/negative/non-finite request is different: changing its sign or
      // finiteness would turn invalid intent into a valid edit before validation.
      if (!Number.isFinite(op.durationSeconds) || op.durationSeconds <= 0) {
        throw new RangeError(
          `Transition duration must be a positive finite number, got ${String(op.durationSeconds)}.`,
        );
      }
      const durationFrames = Math.max(1, secondsToFrame(op.durationSeconds, fps));
      return { ...op, durationSeconds: frameToSeconds(durationFrames, fps) };
    }
    case 'add_mask': {
      const keyframes = snapKeyframes(op.keyframes, fps);
      return { ...op, ...(keyframes === undefined ? {} : { keyframes }) };
    }
    case 'track_object': {
      const keyframes = snapKeyframes(op.keyframes, fps);
      return { ...op, ...(keyframes === undefined ? {} : { keyframes }) };
    }
    case 'add_effect_layer':
      return { ...op, layer: snapEffectLayer(op.layer, fps) };
    case 'move_effect_layer':
      return { ...op, toStart: snapSecondsToFrame(op.toStart, fps) };
    case 'trim_effect_layer':
      return {
        ...op,
        start: snapSecondsToFrame(op.start, fps),
        end: snapSecondsToFrame(op.end, fps),
      };
    case 'add_marker':
      return { ...op, time: snapSecondsToFrame(op.time, fps) };
    case 'add_asset':
    case 'remove_asset':
    case 'move_asset':
    case 'create_folder':
    case 'rename_folder':
    case 'move_folder':
    case 'delete_folder':
    case 'add_clip':
    case 'set_clip_source_range':
    case 'set_clip_media':
    case 'set_transcript':
    case 'remove_marker':
    case 'restore_assets':
    case 'restore_folders':
    case 'set_effect_params':
    case 'set_track_flags':
    case 'set_track_caption_style':
    case 'set_caption_style':
    case 'set_caption_cue':
    case 'set_clip_speed':
    case 'set_clip_speed_ramp':
    case 'set_clip_crop':
    case 'set_clip_blend_mode':
    case 'add_layer':
    case 'remove_layer':
    case 'move_layer':
    case 'remove_effect_layer':
    case 'set_effect_layer_params':
    case 'set_effect_layer_enabled':
    case 'restore_effect_layer':
    case 'restore_clips':
      return op;
  }
}

/** Normalize a complete proposed patch before identity and validation are computed. */
export function normalizeOperationTimes(
  operations: readonly AnyOperation[],
  fps: number,
): AnyOperation[] {
  return operations.map((operation) => normalizeOperationTime(operation, fps));
}

/** Exposed for tests and diagnostics that need to distinguish an actual change. */
export function operationTimeChanged(before: AnyOperation, after: AnyOperation): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Snap an optional value without manufacturing an absent field. */
export function snapOptionalSeconds(value: number | undefined, fps: number): number | undefined {
  return value === undefined ? undefined : snapSecondsToFrame(value, fps);
}
