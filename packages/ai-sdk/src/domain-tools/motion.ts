/**
 * Motion tools — animating a clip's own properties over time.
 *
 * `punch_in` is `add_keyframes` with the arithmetic done for you, which is why
 * they belong together: the default window, the fallback when a clip is unknown,
 * and the shared easing vocabulary are one subject, and a change to any of them
 * that reaches only one of the two is a bug the model surfaces as "the zoom is
 * the wrong length".
 *
 * The resolver-backed `professional_motion` lives in `professional-motion.ts`.
 */
import { z } from 'zod/v4';
import {
  assetDisplaySize,
  planAutomaticReframe,
  punchInKeyframes,
  syntheticClipKind,
  type Easing,
  type Operation,
} from '@framepilot/editor-core';
import type { Keyframe, Timeline } from '@framepilot/timeline-schema';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool } from './tool-factories.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { id, numeric, seconds } from './tool-args.js';

const easingEnum = z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'bezier']);
/** Default punch-in window when the AI gives no end time and the clip is unknown. */
const DEFAULT_PUNCH_IN_SECONDS = 1.5;
const clipDurationById = (timeline: Timeline, clipId: string): number | undefined => {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip.end - clip.start;
  }
  return undefined;
};

/**
 * Refuse a keyframe on a caption clip, and say where the motion actually lives.
 *
 * Text overlays animate: the compiler applies a clip's transform to them (see
 * `render/compiler.py::_compile_text_clip`). Captions do not — their movement comes from
 * the caption template's own per-word animation, and a transform keyframe on one lands in
 * the timeline, validates, and renders as nothing. That silent no-op is what this refuses:
 * an edit reported as applied that no viewer will ever see is worse than a rejection the
 * model can act on.
 */
function refuseCaptionKeyframes(timeline: Timeline, clipId: string): void {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    if (syntheticClipKind(clip.assetId) === 'caption') {
      throw new ToolRefusalError(
        `"${clipId}" is a caption clip, and captions do not read transform keyframes — ` +
          'their motion comes from the caption style. Use set_track_caption_style (or ' +
          'set_caption_style for one cue) to change how the words animate. Text overlays ' +
          'added with add_text_layer do accept a punch-in.',
      );
    }
    return;
  }
}
const keyframeSchema = z.object({
  time: seconds,
  property: z.string(),
  value: numeric(z.number()),
  easing: easingEnum.optional(),
});

export const MOTION_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'add_keyframes',
      description:
        'Animate a clip property (e.g. scale, opacity, x, y) with keyframes; times are ' +
        "seconds from the clip's start. For a simple zoom, prefer punch_in.",
    },
    z.object({ clipId: z.string(), keyframes: z.array(keyframeSchema).min(1) }).strict(),
    (a, ctx) => {
      refuseCaptionKeyframes(ctx.project.timeline, a.clipId);
      const keyframes: Keyframe[] = a.keyframes.map((k) => ({
        id: id('kf', a.clipId, k.property, k.time),
        time: k.time,
        property: k.property,
        value: k.value,
        easing: k.easing ?? 'linear',
      }));
      return [{ type: 'add_keyframes', clipId: a.clipId, keyframes }];
    },
  ),
  mutateTool(
    {
      name: 'remove_keyframes',
      description:
        'Take animation OFF a clip: clear one property entirely, or remove a single ' +
        'keyframe at a time. Name the clip and the properties — `{property: "scale"}` ' +
        'clears every scale keyframe, `{property: "scale", time: 2}` removes just the ' +
        'one two seconds into the clip. This is how a punch-in or a move is undone; ' +
        'add_keyframes can only ever add more, so without this a clip the editor asked ' +
        'you to "stop zooming" could not be fixed. Times are seconds from the clip\'s ' +
        'start, the same clock add_keyframes uses. Removing something that is not ' +
        'there changes nothing rather than failing.',
    },
    z
      .object({
        clipId: z.string(),
        targets: z
          .array(z.object({ property: z.string(), time: seconds.optional() }).strict())
          .min(1),
      })
      .strict(),
    (a) => [
      {
        type: 'remove_keyframes',
        clipId: a.clipId,
        targets: a.targets.map((target) =>
          target.time === undefined
            ? { property: target.property }
            : { property: target.property, time: target.time },
        ),
      },
    ],
  ),
  mutateTool(
    {
      name: 'punch_in',
      description:
        'Add a zoom/punch-in (animated scale) to a clip. Times are clip-relative; ' +
        'the window defaults to the whole clip.',
    },
    z
      .object({
        clipId: z.string(),
        fromScale: numeric(z.number().positive()).optional(),
        toScale: numeric(z.number().positive()).optional(),
        easing: easingEnum.optional(),
        startTime: seconds.optional(),
        endTime: seconds.optional(),
      })
      .strict(),
    (a, ctx) => {
      refuseCaptionKeyframes(ctx.project.timeline, a.clipId);
      const startTime = a.startTime ?? 0;
      const clipDuration = clipDurationById(ctx.project.timeline, a.clipId);
      const fallbackEnd = startTime + DEFAULT_PUNCH_IN_SECONDS;
      // Default to the full clip; if the clip is unknown or the window collapses,
      // fall back to a sensible span (a missing clip is then rejected by the
      // patch validator, not faked here).
      let endTime =
        a.endTime ?? (clipDuration !== undefined ? startTime + clipDuration : fallbackEnd);
      if (endTime <= startTime) endTime = fallbackEnd;
      const keyframes = punchInKeyframes({
        idPrefix: id('punch', a.clipId),
        startTime,
        endTime,
        fromScale: a.fromScale,
        toScale: a.toScale,
        easing: a.easing as Easing | undefined,
      });
      return [{ type: 'add_keyframes', clipId: a.clipId, keyframes }];
    },
  ),
  mutateTool(
    {
      // Reframing that MOVES. `set_clip_crop` is a fixed rectangle, and nothing else could
      // express "a slow pan across the 16:9 frame inside the 9:16 window" without the model
      // reconstructing the compiler's cover arithmetic from nothing. Run `6cb12e30`'s brief
      // asked for exactly that on every aerial, and for the window to follow its subjects;
      // the run delivered static centre crops. The arithmetic is `planAutomaticReframe`'s —
      // derived from the render compiler's own placement formula — fed two positions.
      name: 'reframe_pan',
      description:
        'Reframe a clip whose shape differs from the frame (16:9 into 9:16) by where the ' +
        'frame sits in the SOURCE: from = the window centre as a fraction of the source ' +
        '(x: 0 left … 1 right, y: 0 top … 1 bottom, default 0.5), to = where it ends, for a ' +
        'slow eased pan across the shot; omit to to hold on that spot. Choose the positions ' +
        'by looking at the source first with get_frame { assetId }. Fills the frame at the ' +
        'smallest zoom that covers it, and replaces the clip crop and any x/y/scale ' +
        'keyframes. Times are clip-relative; the window defaults to the whole clip.',
    },
    z
      .object({
        clipId: z.string().min(1),
        from: z
          .object({
            x: numeric(z.number().min(0).max(1)),
            y: numeric(z.number().min(0).max(1)).optional(),
          })
          .strict(),
        to: z
          .object({
            x: numeric(z.number().min(0).max(1)),
            y: numeric(z.number().min(0).max(1)).optional(),
          })
          .strict()
          .optional(),
        easing: easingEnum.optional(),
        startTime: seconds.optional(),
        endTime: seconds.optional(),
      })
      .strict(),
    (a, ctx) => {
      const clip = ctx.project.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === a.clipId);
      if (clip === undefined) {
        throw new Error(`Clip not found: ${a.clipId}. get_clips lists the real ids.`);
      }
      const asset = ctx.project.assets.find((candidate) => candidate.id === clip.assetId);
      const size = assetDisplaySize(asset?.media);
      if (size === null) {
        throw new ToolRefusalError(
          `The source size of ${a.clipId} has not been measured, so a pan cannot be placed ` +
            'on it. Use set_clip_crop for a fixed reframe instead.',
        );
      }
      const fps = ctx.project.fps;
      const clipSeconds = clip.end - clip.start;
      const startTime = Math.min(a.startTime ?? 0, clipSeconds);
      const endTime = Math.min(a.endTime ?? clipSeconds, clipSeconds);
      const firstFrame = Math.round(startTime * fps);
      const lastFrame = Math.max(firstFrame, Math.round(endTime * fps));
      const at = (point: { x: number; y?: number | undefined }, frame: number) => ({
        frame,
        box: { x: point.x, y: point.y ?? 0.5, width: 0, height: 0 },
        confidence: 1,
        occluded: false,
      });
      const end = a.to ?? a.from;
      const plan = planAutomaticReframe({
        samples:
          lastFrame > firstFrame
            ? [at(a.from, firstFrame), at(end, lastFrame)]
            : [at(a.from, firstFrame)],
        source: size,
        target: ctx.project.resolution,
        rate: { numerator: fps, denominator: 1 },
        firstClipFrame: firstFrame,
        // Two positions, not a jittery track: nothing to damp, and damping between two
        // samples a clip apart would cut the pan short.
        maxPanPixelsPerFrame: Number.POSITIVE_INFINITY,
        easing: (a.easing ?? 'ease-in-out') as Easing,
      });
      if (plan.status !== 'planned') {
        throw new ToolRefusalError(
          plan.code === 'no_reframe_needed'
            ? `${a.clipId} already has the frame's shape, so there is nothing to pan across.`
            : plan.detail,
        );
      }
      const ops: Operation[] = [];
      if (clip.crop !== undefined) ops.push({ type: 'set_clip_crop', clipId: clip.id, crop: null });
      const owned = ['x', 'y', 'scale'] as const;
      const existing = owned.filter((property) =>
        clip.keyframes.some((keyframe) => keyframe.property === property),
      );
      if (existing.length > 0) {
        ops.push({
          type: 'remove_keyframes',
          clipId: clip.id,
          targets: existing.map((property) => ({ property })),
        });
      }
      const keyframes: Keyframe[] = owned.flatMap((property) =>
        plan.points[property].map((point) => ({
          id: id('reframe', clip.id, property, point.frame),
          time: point.frame / fps,
          property,
          value: point.value,
          easing: point.easing,
        })),
      );
      ops.push({ type: 'add_keyframes', clipId: clip.id, keyframes });
      return ops;
    },
  ),
];
