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
  evaluateKeyframes,
  evaluateSortedCurve,
  KEYFRAME_REPLACE_EPSILON,
  planAutomaticReframe,
  punchInKeyframes,
  syntheticClipKind,
  type Easing,
  type Operation,
} from '@framepilot/editor-core';
import type { Clip, Keyframe, Project, Timeline } from '@framepilot/timeline-schema';
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
/**
 * The smallest `scale` at which a clip's picture fills the frame, or `null` when that is not
 * how the clip fills it (a crop does the reframing) or the source was never measured. The
 * render compiler's fit-then-scale formula, as `planAutomaticReframe` derives it.
 */
function coverScaleOf(project: Project, clip: Clip): number | null {
  if (clip.crop != null) return null;
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const size = assetDisplaySize(asset?.media);
  if (size === null) return null;
  const { width, height } = project.resolution;
  const fit = Math.min(width / size.width, height / size.height);
  return Math.max(width / size.width, height / size.height) / fit;
}

/**
 * Compose a punch-in onto a clip's EXISTING scale curve: result(t) = existing(t) × punch(t).
 *
 * Issue #139. A reframe_pan's scale keyframes ARE the zoom that fills the frame (≈3.16 for
 * 16:9 in 9:16); a punch-in that wrote absolute 1.0 → 1.2 replaced it and the picture fell
 * back to a letterboxed fit, so run 4 of the travel brief stripped 22 pans by hand before it
 * could punch in. Multiplying instead makes a punch-in mean the same thing on every clip —
 * on an unanimated clip existing(t) ≡ 1 and this is exactly the plain punch.
 *
 * The punch curve holds `fromScale` before its window and `toScale` after it, as any keyframe
 * curve does, so every existing keyframe outside the window is rescaled by that held factor
 * (keeping its easing and handles — scaling a segment by a constant keeps its shape). Inside
 * the window the curve is sampled at the window edges and at each existing keyframe time
 * between them. With a constant existing zoom (every reframe_pan) the result is exact: two
 * keyframes on the punch's own easing. With existing keyframes inside the window the
 * interior segments are linear, and an eased segment the window edge cuts through keeps its
 * endpoints but not its exact curvature — the approximation this representation allows.
 * x/y are untouched, so a pan keeps panning underneath the push-in.
 */
function composePunchOnScale(
  existing: readonly Keyframe[],
  punch: readonly Keyframe[],
  idPrefix: string,
): Keyframe[] {
  const base = [...existing].sort((a, b) => a.time - b.time);
  const [first, last] = [punch[0]!, punch[punch.length - 1]!];
  const startTime = first.time;
  const endTime = last.time;
  const baseAt = (time: number): number => evaluateSortedCurve(base, time)!;
  const factorAt = (time: number): number => evaluateKeyframes(punch, first.property, time)!;
  const idAt = (time: number): string =>
    `${idPrefix}__${first.property}__${Math.round(time * 1000)}`;
  const outside = (keyframe: Keyframe): Keyframe => ({
    ...keyframe,
    value: keyframe.value * factorAt(keyframe.time),
  });
  const before = base.filter((k) => k.time < startTime - KEYFRAME_REPLACE_EPSILON);
  const after = base.filter((k) => k.time > endTime + KEYFRAME_REPLACE_EPSILON);
  const interior = base.filter(
    (k) =>
      k.time > startTime + KEYFRAME_REPLACE_EPSILON && k.time < endTime - KEYFRAME_REPLACE_EPSILON,
  );
  const windowEasing = interior.length === 0 ? first.easing : 'linear';
  // The keyframe at the window's end also starts the segment AFTER it, so it carries the
  // existing curve's easing there — the part of the old curve the punch does not own.
  const governingEnd = base.filter((k) => k.time <= endTime + KEYFRAME_REPLACE_EPSILON).at(-1);
  const sample = (time: number, easing: string): Keyframe => ({
    id: idAt(time),
    time,
    property: first.property,
    value: baseAt(time) * factorAt(time),
    easing: easing as Keyframe['easing'],
  });
  return [
    ...before.map(outside),
    sample(startTime, windowEasing),
    ...interior.map((k) => sample(k.time, 'linear')),
    sample(endTime, governingEnd?.easing ?? 'linear'),
    ...after.map(outside),
  ];
}

/**
 * Build `punch_in`'s operations. A clip with no scale animation gets the plain two-keyframe
 * punch (unchanged since the tool existed); one whose scale is already keyframed — a pan's
 * cover zoom, an earlier punch — gets the punch MULTIPLIED onto that curve (see
 * {@link composePunchOnScale}), written as clear-then-add so the patch inverts to the
 * clip's exact prior keyframes.
 */
function punchInOps(
  project: Project,
  clipId: string,
  punch: Keyframe[],
  idPrefix: string,
): Operation[] {
  const clip = project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  // `?? []`: hand-built projects (tests, older hosts) can omit a clip's keyframe list.
  const existing = (clip?.keyframes ?? []).filter((k) => k.property === 'scale');
  if (clip === undefined || existing.length === 0) {
    return [{ type: 'add_keyframes', clipId, keyframes: punch }];
  }
  const composed = composePunchOnScale(existing, punch, idPrefix);
  refuseZoomBelowCover(project, clip, existing, composed);
  return [
    { type: 'remove_keyframes', clipId, targets: [{ property: 'scale' }] },
    { type: 'add_keyframes', clipId, keyframes: composed },
  ];
}

/** Relative slack for "at the cover zoom" — the planner's own float arithmetic. */
const COVER_TOLERANCE = 1e-6;

/**
 * Refuse a punch whose factor drops below 1 far enough to shrink a picture that currently
 * fills the frame below the zoom that fills it — that is a letterbox, not a zoom. Checking
 * the written keyframes is enough: between two of them every named easing stays inside their
 * range. No magnitudes in the message: it is a repeated-failure guard key.
 */
function refuseZoomBelowCover(
  project: Project,
  clip: Clip,
  existing: readonly Keyframe[],
  composed: readonly Keyframe[],
): void {
  const cover = coverScaleOf(project, clip);
  if (cover === null || cover <= 1 + COVER_TOLERANCE) return;
  const floor = cover * (1 - COVER_TOLERANCE);
  const letterboxes = composed.some(
    (k) => k.value < floor && evaluateKeyframes(existing, 'scale', k.time)! >= floor,
  );
  if (!letterboxes) return;
  throw new ToolRefusalError(
    `punch_in would zoom ${clip.id} out below the zoom that makes it fill the frame, which ` +
      'shows black bars. Its scale is a reframe that fills the frame, and a punch on it ' +
      'multiplies that zoom — keep fromScale and toScale at 1 or above.',
  );
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
        "seconds from the clip's start. For a simple zoom, prefer punch_in. scaleX/scaleY " +
        'stretch or squash one axis (1 = none) — only when asked to stretch or squash; ' +
        'zooms use scale.',
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
        'the window defaults to the whole clip. The scales multiply any zoom the clip already ' +
        'has, so a punch on a reframe_pan clip pushes in on top of the pan and it keeps panning.',
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
      const idPrefix = id('punch', a.clipId);
      const keyframes = punchInKeyframes({
        idPrefix,
        startTime,
        endTime,
        fromScale: a.fromScale,
        toScale: a.toScale,
        easing: a.easing as Easing | undefined,
      });
      return punchInOps(ctx.project, a.clipId, keyframes, idPrefix);
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
        'keyframes, so pan first; a punch_in afterwards zooms in on top of the pan. Times ' +
        'are clip-relative; the window defaults to the whole clip.',
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
