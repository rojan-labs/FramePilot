/**
 * The first tracked consumer: make a clip's transform follow a measured track.
 *
 * This deliberately introduces no new operation and no schema change. It plans
 * frame points for the existing `animate_clip_property` compiler, so a followed
 * overlay is an ordinary animated clip: it validates, inverts, saves, reloads and
 * renders through paths that already exist and are already proven.
 *
 * Following is expressed as motion *relative to the first tracked frame*. The
 * editor placed the overlay where they wanted it; following must preserve that
 * placement and add the subject's movement, not teleport the overlay onto the
 * tracker's idea of the subject centre.
 *
 * `x`/`y` are output-frame pixel offsets from centre (see the render compiler's
 * `position_at`), so normalized track motion is converted with the project
 * resolution rather than assumed to be in the same units.
 */
import type { Easing } from './keyframes.js';
import type { MotionFramePoint, MotionFrameRate } from './motion-commands.js';
import type { TrackSample } from './track-samples.js';

export type TrackFollowProperty = 'x' | 'y' | 'scale';

export interface TrackFollowResolution {
  readonly width: number;
  readonly height: number;
}

export interface PlanTrackFollowInput {
  readonly samples: readonly TrackSample[];
  readonly resolution: TrackFollowResolution;
  readonly rate: MotionFrameRate;
  /** Clip-relative frame of the first sample, so points land in clip time. */
  readonly firstClipFrame: number;
  /** Existing clip transform, preserved as the follow baseline. */
  readonly base: { readonly x: number; readonly y: number; readonly scale: number };
  /** Follow the subject's size as well as its position. */
  readonly followScale?: boolean;
  readonly easing?: Easing;
}

export type TrackFollowRejectionCode =
  | 'no_samples'
  | 'unusable_samples'
  | 'invalid_resolution'
  | 'degenerate_track';

export type TrackFollowPlanResult =
  | {
      readonly status: 'planned';
      readonly points: Readonly<Record<TrackFollowProperty, readonly MotionFramePoint[]>>;
      readonly facts: readonly { readonly name: string; readonly value: number | string }[];
    }
  | {
      readonly status: 'rejected';
      readonly code: TrackFollowRejectionCode;
      readonly detail: string;
    };

interface Centre {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

function rejected(code: TrackFollowRejectionCode, detail: string): TrackFollowPlanResult {
  return { status: 'rejected', code, detail };
}

/**
 * Plan transform points that make a clip follow a track.
 *
 * Occluded samples are skipped rather than followed: a held box is the tracker
 * saying "I cannot see it", and moving an overlay on that basis would animate
 * confidence the measurement does not have. Skipped frames simply have no
 * keyframe, so the existing linear interpolation carries the overlay through.
 */
export function planTrackFollow(input: PlanTrackFollowInput): TrackFollowPlanResult {
  const { width, height } = input.resolution;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return rejected('invalid_resolution', 'Track follow needs a positive output resolution.');
  }
  if (input.samples.length === 0) {
    return rejected('no_samples', 'There are no tracker samples to follow.');
  }
  const centres: Centre[] = input.samples
    .filter((sample) => !sample.occluded)
    .map((sample) => ({
      frame: sample.frame,
      x: sample.box.x + sample.box.width / 2,
      y: sample.box.y + sample.box.height / 2,
      width: sample.box.width,
    }));
  if (centres.length < 2) {
    return rejected(
      'unusable_samples',
      'Following needs at least two frames where the subject was actually visible.',
    );
  }
  const first = centres[0]!;
  if (first.width <= 0) {
    return rejected('degenerate_track', 'The first tracked box has no width to scale from.');
  }
  const easing: Easing = input.easing ?? 'linear';
  const firstFrame = first.frame;
  const points: Record<TrackFollowProperty, MotionFramePoint[]> = { x: [], y: [], scale: [] };
  for (const centre of centres) {
    const frame = input.firstClipFrame + (centre.frame - firstFrame);
    points.x.push({
      domain: 'clip',
      frame,
      value: input.base.x + (centre.x - first.x) * width,
      easing,
    });
    points.y.push({
      domain: 'clip',
      frame,
      value: input.base.y + (centre.y - first.y) * height,
      easing,
    });
    if (input.followScale === true) {
      points.scale.push({
        domain: 'clip',
        frame,
        value: input.base.scale * (centre.width / first.width),
        easing,
      });
    }
  }
  return {
    status: 'planned',
    points,
    facts: [
      { name: 'followedFrameCount', value: centres.length },
      { name: 'skippedOccludedFrames', value: input.samples.length - centres.length },
      { name: 'followsScale', value: input.followScale === true ? 'yes' : 'no' },
    ],
  };
}
