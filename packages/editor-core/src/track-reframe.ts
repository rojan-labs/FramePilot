/**
 * Automatic reframe: keep a tracked subject in shot when the output aspect differs.
 *
 * Like {@link planTrackFollow}, this plans points for the existing
 * `animate_clip_property` compiler rather than inventing an operation, so a
 * reframed clip stays an ordinary animated clip through validate, invert, save,
 * reload and render.
 *
 * The maths mirrors the render compiler exactly rather than approximating it.
 * The engine fits a clip into the output with `base_scale = min(tw/cw, th/ch)`,
 * multiplies that by the clip's `scale`, centres the result, and then applies
 * `x`/`y` as pixel offsets from centre. So:
 *
 * - covering the output needs `scale = max(tw/cw, th/ch) / min(tw/cw, th/ch)`;
 * - putting a subject at normalized source position `p` in the centre of the
 *   output needs `x = renderedWidth * (0.5 - p)`;
 * - and the pan is clamped to `(rendered - target) / 2`, because panning further
 *   would expose empty frame beyond the edge of the picture.
 *
 * Getting this wrong is invisible in metadata and obvious on screen, which is
 * why the offsets are derived from the compiler's own formula.
 */
import type { Easing } from './keyframes.js';
import type { MotionFramePoint, MotionFrameRate } from './motion-commands.js';
import type { TrackFollowProperty, TrackFollowResolution } from './track-follow.js';
import type { TrackSample } from './track-samples.js';

/** Largest pan change per frame, in output pixels, before the move is damped. */
export const DEFAULT_MAX_PAN_PIXELS_PER_FRAME = 24;

export interface PlanAutomaticReframeInput {
  readonly samples: readonly TrackSample[];
  /** The clip's own pixel dimensions. */
  readonly source: TrackFollowResolution;
  /** The output/project pixel dimensions being reframed to. */
  readonly target: TrackFollowResolution;
  readonly rate: MotionFrameRate;
  readonly firstClipFrame: number;
  readonly maxPanPixelsPerFrame?: number;
  readonly easing?: Easing;
}

export type ReframeRejectionCode =
  | 'no_samples'
  | 'unusable_samples'
  | 'invalid_resolution'
  | 'no_reframe_needed';

export type AutomaticReframePlanResult =
  | {
      readonly status: 'planned';
      readonly points: Readonly<Record<TrackFollowProperty, readonly MotionFramePoint[]>>;
      readonly coverScale: number;
      readonly facts: readonly { readonly name: string; readonly value: number | string }[];
    }
  | {
      readonly status: 'rejected';
      readonly code: ReframeRejectionCode;
      readonly detail: string;
    };

function rejected(code: ReframeRejectionCode, detail: string): AutomaticReframePlanResult {
  return { status: 'rejected', code, detail };
}

function positive(resolution: TrackFollowResolution): boolean {
  return (
    Number.isFinite(resolution.width) &&
    Number.isFinite(resolution.height) &&
    resolution.width > 0 &&
    resolution.height > 0
  );
}

function clamp(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(Math.max(value, -limit), limit);
}

/** Plan cover-scale and pan points that keep a tracked subject framed. */
export function planAutomaticReframe(
  input: PlanAutomaticReframeInput,
): AutomaticReframePlanResult {
  if (!positive(input.source) || !positive(input.target)) {
    return rejected('invalid_resolution', 'Reframing needs positive source and target sizes.');
  }
  if (input.samples.length === 0) {
    return rejected('no_samples', 'There are no tracker samples to reframe from.');
  }
  const visible = input.samples.filter((sample) => !sample.occluded);
  if (visible.length === 0) {
    return rejected(
      'unusable_samples',
      'The subject was never actually visible, so there is nothing to keep in shot.',
    );
  }
  const fitScale = Math.min(
    input.target.width / input.source.width,
    input.target.height / input.source.height,
  );
  const coverScale =
    Math.max(input.target.width / input.source.width, input.target.height / input.source.height) /
    fitScale;
  if (Math.abs(coverScale - 1) < 1e-9) {
    return rejected(
      'no_reframe_needed',
      'The clip already matches the output aspect, so reframing would change nothing.',
    );
  }
  const renderedWidth = input.source.width * fitScale * coverScale;
  const renderedHeight = input.source.height * fitScale * coverScale;
  const panLimitX = (renderedWidth - input.target.width) / 2;
  const panLimitY = (renderedHeight - input.target.height) / 2;
  const easing: Easing = input.easing ?? 'linear';
  const maxStep = input.maxPanPixelsPerFrame ?? DEFAULT_MAX_PAN_PIXELS_PER_FRAME;

  const points: Record<TrackFollowProperty, MotionFramePoint[]> = { x: [], y: [], scale: [] };
  const firstFrame = visible[0]!.frame;
  let previous: { x: number; y: number } | undefined;
  let dampedFrames = 0;
  for (const sample of visible) {
    const frame = input.firstClipFrame + (sample.frame - firstFrame);
    const centreX = sample.box.x + sample.box.width / 2;
    const centreY = sample.box.y + sample.box.height / 2;
    let x = clamp(renderedWidth * (0.5 - centreX), panLimitX);
    let y = clamp(renderedHeight * (0.5 - centreY), panLimitY);
    if (previous !== undefined) {
      // Damping keeps a jittery track from producing a visibly nervous camera.
      const stepX = x - previous.x;
      const stepY = y - previous.y;
      if (Math.abs(stepX) > maxStep || Math.abs(stepY) > maxStep) dampedFrames += 1;
      if (Math.abs(stepX) > maxStep) x = previous.x + Math.sign(stepX) * maxStep;
      if (Math.abs(stepY) > maxStep) y = previous.y + Math.sign(stepY) * maxStep;
    }
    previous = { x, y };
    points.x.push({ domain: 'clip', frame, value: x, easing });
    points.y.push({ domain: 'clip', frame, value: y, easing });
    points.scale.push({ domain: 'clip', frame, value: coverScale, easing });
  }
  return {
    status: 'planned',
    points,
    coverScale,
    facts: [
      { name: 'coverScale', value: coverScale },
      { name: 'reframedFrameCount', value: visible.length },
      { name: 'skippedOccludedFrames', value: input.samples.length - visible.length },
      { name: 'dampedFrameCount', value: dampedFrames },
      { name: 'maximumPanPixels', value: Math.max(panLimitX, panLimitY) },
    ],
  };
}
