/**
 * @framepilot/editor-core/frame-grid — the project's frame grid (ADR 0146).
 *
 * The persisted project format still stores seconds. At the canonical patch boundary,
 * SEQUENCE timing is snapped to an integer project frame before patch identity,
 * validation, preview, and render can disagree about a fractional value.
 *
 * This lived in `packages/ai-sdk` and therefore ran for AI-authored edits ONLY: a human
 * trim landed at 12.3874s on a 30fps timeline, 0.4 of a frame from any frame boundary,
 * and nothing in the stack decided which frame it meant. "The AI cuts on frames and you
 * do not" is not a defensible product, so the grid moved here — where `apply`, `invert`
 * and the patch engine are — and `commitProjectPatch` applies it to every patch, from
 * either author.
 *
 * **Rounding is named, not incidental: nearest frame, ties away from zero.** Timeline
 * times are non-negative, so `Math.round` and Python's `math.floor(x + 0.5)` agree by
 * construction; `engine/python/.../render/frame_grid.py` mirrors this file and a shared
 * fixture pins them together.
 *
 * Source-domain values are intentionally not snapped here. A source asset can have a
 * different frame rate from the sequence, and this boundary currently receives only
 * the project FPS. Rewriting source timestamps against the sequence FPS would be less
 * precise, not more. Operations that couple source and sequence duration (`add_clip`)
 * therefore remain unchanged until the media-time contract supplies source FPS and an
 * explicit retime policy. Transcript observations and inverse snapshots also stay
 * untouched because they are evidence or exact prior state, not new edit decisions.
 */
import type { AnyOperation, Patch } from './patch.js';
import type { AddClipOp } from './operations.js';
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
 * (`set_transcript`, caption cue words, speed-ramp source points) deliberately pass
 * through unchanged. Their values describe exact prior state or provider evidence.
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
    case 'add_clip':
      return snapAddClip(op, fps);
    case 'add_asset':
    case 'remove_asset':
    case 'move_asset':
    case 'create_folder':
    case 'rename_folder':
    case 'move_folder':
    case 'delete_folder':
    case 'set_clip_source_range':
    case 'set_clip_media':
    case 'set_transcript':
    case 'remove_marker':
    case 'restore_assets':
    case 'restore_folders':
    case 'set_ai_memory':
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

/**
 * Snap the SEQUENCE edit points of an `add_clip`, carrying its source range with them.
 *
 * `add_clip` was the one authoring operation exempt from the grid, and it is by a wide
 * margin the most common one. The exemption was deliberate — the docstring above used to
 * call the ranges "coupled … two time domains that require more context" — and the reason
 * is real: `start`/`end` are sequence time while `sourceStart`/`sourceEnd` are source
 * time, and moving one without the other changes the clip's speed.
 *
 * But the conclusion did not follow. Snapping the sequence points and RESCALING the source
 * range by the same factor preserves the coupling exactly, and leaves `sourceStart` — the
 * frame the viewer actually sees first — untouched. What the exemption cost instead was
 * every cut in the product: run `fc10301a` asked in so many words for "exact frame-aligned
 * cuts" at 30fps and placed thirty-four clips at 16.277s, 18.042s, 20.573s, 24.079s. Not
 * one of them is a frame boundary; the nearest are 10–23ms away, which is ten to twenty
 * times `compiler.py`'s `_CUT_ADJACENCY_TOLERANCE`. Every neighbouring operation —
 * `trim_clip`, `split_clip`, `move_clip`, `add_transition`, `add_marker` — was already
 * snapped, so an agent could not place a clip and then trim it without the two disagreeing.
 *
 * A still is the easy case and the common one: its source range equals its sequence
 * duration, the scale factor is 1, and both domains move together.
 *
 * Degenerate inputs pass through rather than being repaired here: a zero-length or
 * non-finite range has no speed to preserve, and turning invalid intent into a valid edit
 * before validation sees it is exactly what `add_transition`'s guard above refuses to do.
 *
 * Two limits, both deliberate:
 *
 * - `sourceStart` is NOT snapped. It is the frame the viewer sees first and moving it
 *   would change which one that is; the out-point is rescaled around it instead. So a
 *   run asking for "exact frame-aligned cuts" gets frame-aligned CUTS — its in-points
 *   may still seek to an off-grid source frame, which no downstream operation reads.
 * - Snapping `end` up can push a full-source placement (`sourceEnd` = the asset's whole
 *   duration, which is how `stock-placement.ts` and `music-placement.ts` build one)
 *   under a frame past the real end. That is safe and already handled where it lands:
 *   `compiler.py#_subclipped_source` drops a `source_end` at or beyond the asset's
 *   duration and plays to the end. Clamping here is not possible anyway — this is a pure
 *   operation transform and knows nothing of the media bin.
 */
function snapAddClip(op: AddClipOp, fps: number): AddClipOp {
  const start = snapSecondsToFrame(op.start, fps);
  const end = snapSecondsToFrame(op.end, fps);
  const sequence = op.end - op.start;
  const source = op.sourceEnd - op.sourceStart;
  if (!Number.isFinite(sequence) || sequence <= 0 || !Number.isFinite(source)) {
    return { ...op, start, end };
  }
  // The clip's speed, preserved exactly: one second of sequence consumes `speed` seconds
  // of source, and that ratio must survive a sub-frame nudge of the out-point.
  const speed = source / sequence;
  return { ...op, start, end, sourceEnd: op.sourceStart + (end - start) * speed };
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

/**
 * Snap every edit point in a patch to the project's frame grid (ADR 0146).
 *
 * Applied to the patch as a whole, BEFORE it is validated, inverted, applied or recorded
 * — so all four see the same numbers. Quantizing inside `applyOperation` instead would
 * have been the obvious move and is the wrong one: the inverse is computed from the
 * operation, so an apply that quantized privately would invert to a different state than
 * it applied from, and undo would drift a fraction of a frame per edit.
 *
 * Idempotent, which is what lets `applyUserPatch` quantize to validate the edit it will
 * actually commit and `commitProjectPatch` quantize again without consequence.
 *
 * @param patch - The proposed patch, from either author.
 * @param fps - The project's frame rate.
 * @returns The same patch with its sequence edit points on the grid.
 */
export function quantizePatch(patch: Patch, fps: number): Patch {
  const operations = normalizeOperationTimes(patch.operations, fps);
  // Structural comparison, not reference: `normalizeOperationTime` rebuilds each operation
  // whether or not a value moved, so a reference check would report "changed" for every
  // patch and quietly defeat the identity below.
  const changed = operations.some((op, index) =>
    operationTimeChanged(patch.operations[index] as AnyOperation, op),
  );
  return changed ? { ...patch, operations } : patch;
}
