/**
 * Deterministic conversion of tracker measurements into timeline keyframes.
 *
 * A Capability Pack worker measures; it never smooths and never guesses. All of
 * that judgement lives here, in the host, for three reasons: it must be
 * versioned with the project rather than with a downloadable binary, it must be
 * identical for every pack that ever produces samples, and it must be auditable
 * because it is the step where measurement becomes an edit.
 *
 * The policy is intentionally conservative:
 *
 * - Samples below the confidence floor, or flagged occluded, are **not** used.
 *   A worker that says "I am not sure" must not steer the mask.
 * - A gap between usable samples is bridged by straight-line interpolation only
 *   while it stays under {@link DEFAULT_TRACK_POLICY}.maximumGapFrames. Past
 *   that, conversion is rejected: nobody can honestly say where the subject went
 *   during a long occlusion, and a plausible curve would be a fabrication.
 * - The result is smoothed with a fixed centred moving average, so tracker
 *   jitter does not become visible mask chatter.
 * - Per-frame motion is clamped, so a single bad measurement cannot yank the
 *   mask across the frame.
 *
 * Every step is pure and order-independent of wall-clock time, so the same
 * samples always produce the same keyframes.
 */
import type { Keyframe } from '@framepilot/timeline-schema';
import type { MaskBounds } from './operations.js';

const BOX_PROPERTIES = ['x', 'y', 'width', 'height'] as const;
type BoxProperty = (typeof BOX_PROPERTIES)[number];
const EPSILON = 1e-6;

export interface TrackSample {
  readonly frame: number;
  readonly box: MaskBounds;
  readonly confidence: number;
  readonly occluded: boolean;
}

export interface TrackConversionPolicy {
  /** Measurements under this confidence do not steer the track. */
  readonly minimumConfidence: number;
  /** Centred moving-average width, in frames. Must be odd so the window has a centre. */
  readonly smoothingWindowFrames: number;
  /** Largest normalized movement one frame may make, per box property. */
  readonly maximumCorrectionPerFrame: number;
  /** Longest run of unusable frames that may be bridged by interpolation. */
  readonly maximumGapFrames: number;
}

export const DEFAULT_TRACK_POLICY: TrackConversionPolicy = {
  minimumConfidence: 0.35,
  smoothingWindowFrames: 5,
  maximumCorrectionPerFrame: 0.08,
  maximumGapFrames: 12,
};

export type TrackConversionRejectionCode =
  | 'no_samples'
  | 'unordered_samples'
  | 'no_confident_samples'
  | 'gap_too_long'
  | 'invalid_geometry'
  | 'invalid_policy';

export interface TrackConversionFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type TrackConversionResult =
  | {
      readonly status: 'converted';
      readonly keyframes: readonly Keyframe[];
      readonly facts: readonly TrackConversionFact[];
    }
  | {
      readonly status: 'rejected';
      readonly code: TrackConversionRejectionCode;
      readonly detail: string;
      readonly facts: readonly TrackConversionFact[];
    };

export interface ConvertTrackSamplesInput {
  readonly samples: readonly TrackSample[];
  /** Frames per second of the tracked media, used to place keyframes in clip time. */
  readonly fps: number;
  /** Clip-relative time, in seconds, of the first tracked frame. */
  readonly startSeconds: number;
  /** Clip duration in seconds; keyframes may not fall outside it. */
  readonly durationSeconds: number;
  readonly keyframePrefix: string;
  readonly policy?: Partial<TrackConversionPolicy>;
}

function rejected(
  code: TrackConversionRejectionCode,
  detail: string,
  facts: readonly TrackConversionFact[] = [],
): TrackConversionResult {
  return { status: 'rejected', code, detail, facts };
}

function insideFrame(box: MaskBounds): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    box.width > 0 &&
    box.height > 0 &&
    box.x >= -EPSILON &&
    box.y >= -EPSILON &&
    box.x + box.width <= 1 + EPSILON &&
    box.y + box.height <= 1 + EPSILON
  );
}

function clampBox(box: MaskBounds): MaskBounds {
  const width = Math.min(Math.max(box.width, EPSILON), 1);
  const height = Math.min(Math.max(box.height, EPSILON), 1);
  return {
    x: Math.min(Math.max(box.x, 0), 1 - width),
    y: Math.min(Math.max(box.y, 0), 1 - height),
    width,
    height,
  };
}

function property(box: MaskBounds, name: BoxProperty): number {
  return box[name];
}

/** Straight-line bridge across a bounded gap between two measured frames. */
function interpolate(from: MaskBounds, to: MaskBounds, ratio: number): MaskBounds {
  const mix = (left: number, right: number): number => left + (right - left) * ratio;
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
  };
}

/** Convert tracker samples into smoothed, clamped, in-frame box keyframes. */
export function convertTrackSamples(input: ConvertTrackSamplesInput): TrackConversionResult {
  const policy = { ...DEFAULT_TRACK_POLICY, ...input.policy };
  if (
    policy.smoothingWindowFrames < 1 ||
    policy.smoothingWindowFrames % 2 === 0 ||
    policy.maximumCorrectionPerFrame <= 0 ||
    policy.maximumGapFrames < 0 ||
    policy.minimumConfidence < 0 ||
    policy.minimumConfidence > 1
  ) {
    return rejected('invalid_policy', 'Track conversion policy is out of range.');
  }
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    return rejected('invalid_policy', 'Track conversion needs a positive fps.');
  }
  if (input.samples.length === 0) return rejected('no_samples', 'No tracker samples were returned.');
  for (let index = 1; index < input.samples.length; index += 1) {
    if (input.samples[index]!.frame <= input.samples[index - 1]!.frame) {
      return rejected(
        'unordered_samples',
        'Tracker samples must arrive in strictly ascending frame order.',
      );
    }
  }
  if (!input.samples.every((sample) => insideFrame(sample.box))) {
    return rejected('invalid_geometry', 'A tracker sample left the normalized frame.');
  }

  const usable = input.samples.filter(
    (sample) => !sample.occluded && sample.confidence >= policy.minimumConfidence,
  );
  const facts: TrackConversionFact[] = [
    { name: 'sampleCount', value: input.samples.length },
    { name: 'confidentSampleCount', value: usable.length },
    { name: 'minimumConfidence', value: policy.minimumConfidence },
    { name: 'smoothingWindowFrames', value: policy.smoothingWindowFrames },
  ];
  if (usable.length === 0) {
    return rejected(
      'no_confident_samples',
      'Every tracker sample was occluded or below the confidence floor.',
      facts,
    );
  }
  const firstFrame = usable[0]!.frame;
  const lastFrame = usable[usable.length - 1]!.frame;
  let widestGap = 0;
  for (let index = 1; index < usable.length; index += 1) {
    const gap = usable[index]!.frame - usable[index - 1]!.frame - 1;
    widestGap = Math.max(widestGap, gap);
  }
  facts.push({ name: 'widestBridgedGapFrames', value: widestGap });
  if (widestGap > policy.maximumGapFrames) {
    return rejected(
      'gap_too_long',
      `The subject was unmeasurable for ${widestGap} consecutive frames, which exceeds the ${policy.maximumGapFrames}-frame bridge limit. Shorten the range or re-specify the target.`,
      facts,
    );
  }

  // 1. Densify: one box per frame across the measured span, bridging bounded gaps.
  const dense: MaskBounds[] = [];
  let cursor = 0;
  for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
    while (cursor + 1 < usable.length && usable[cursor + 1]!.frame <= frame) cursor += 1;
    const current = usable[cursor]!;
    if (current.frame === frame) {
      dense.push(current.box);
      continue;
    }
    const next = usable[cursor + 1];
    if (next === undefined) {
      dense.push(current.box);
      continue;
    }
    const span = next.frame - current.frame;
    dense.push(interpolate(current.box, next.box, (frame - current.frame) / span));
  }

  // 2. Smooth with a centred moving average, clamped at the ends.
  const half = (policy.smoothingWindowFrames - 1) / 2;
  const smoothed = dense.map((_, index) => {
    const from = Math.max(0, index - half);
    const to = Math.min(dense.length - 1, index + half);
    const count = to - from + 1;
    const total = { x: 0, y: 0, width: 0, height: 0 };
    for (let cursorIndex = from; cursorIndex <= to; cursorIndex += 1) {
      for (const name of BOX_PROPERTIES) {
        total[name] += property(dense[cursorIndex]!, name);
      }
    }
    return {
      x: total.x / count,
      y: total.y / count,
      width: total.width / count,
      height: total.height / count,
    };
  });

  // 3. Clamp per-frame correction so one bad measurement cannot yank the mask.
  const limited: MaskBounds[] = [];
  let clampedFrames = 0;
  for (const box of smoothed) {
    const previous = limited[limited.length - 1];
    if (previous === undefined) {
      limited.push(clampBox(box));
      continue;
    }
    let clamped = false;
    const next = { ...box };
    for (const name of BOX_PROPERTIES) {
      const delta = box[name] - previous[name];
      if (Math.abs(delta) > policy.maximumCorrectionPerFrame) {
        next[name] =
          previous[name] + Math.sign(delta) * policy.maximumCorrectionPerFrame;
        clamped = true;
      }
    }
    if (clamped) clampedFrames += 1;
    limited.push(clampBox(next));
  }
  facts.push({ name: 'clampedFrameCount', value: clampedFrames });

  // 4. Place the boxes in clip time.
  const keyframes: Keyframe[] = [];
  for (let index = 0; index < limited.length; index += 1) {
    const frame = firstFrame + index;
    const time = input.startSeconds + (frame - firstFrame) / input.fps;
    if (time < -EPSILON || time > input.durationSeconds + EPSILON) {
      return rejected(
        'invalid_geometry',
        `Tracked frame ${frame} falls outside the clip's ${input.durationSeconds}s duration.`,
        facts,
      );
    }
    const box = limited[index]!;
    for (const name of BOX_PROPERTIES) {
      keyframes.push({
        id: `${input.keyframePrefix}__${name}__${frame}`,
        property: name,
        time: Math.min(Math.max(time, 0), input.durationSeconds),
        value: box[name],
        easing: 'linear',
      });
    }
  }
  facts.push({ name: 'keyframeCount', value: keyframes.length });
  return { status: 'converted', keyframes, facts };
}
