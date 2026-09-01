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
import { CAPTION_ASSET_ID, punchInKeyframes, type Easing } from '@framepilot/editor-core';
import type { Keyframe, Timeline } from '@framepilot/timeline-schema';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool } from './tool-factories.js';
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
    if (clip.assetId === CAPTION_ASSET_ID) {
      throw new Error(
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
];
