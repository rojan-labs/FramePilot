/**
 * `reframe_to_subject` (issue #137): keep a tracked subject in the frame when the clip's shape
 * differs from the output's (a 16:9 shot in a 9:16 reel).
 *
 * **Bake, don't link.** A clip transform that follows a track LIVE needs a schema field nobody has
 * approved (MO-14). This reads where the subject is at every instant once, off the mask's measured
 * track, and writes ordinary x/y/scale keyframes: validated, undoable in one step, rendered by the
 * same placement arithmetic as any keyframed clip, and re-runnable after the mask is re-tracked
 * (the keyframes it owns are replaced, as `reframe_pan` replaces them).
 *
 * The work is split across the trust boundary the other host-measured masking tools use:
 *
 * - {@link subjectSamplesFromTrack} runs in the DESKTOP host, which alone reads the digest-pinned
 *   `track.json`. It returns where the subject is (its centre as a fraction of the source picture)
 *   on a six-per-second grid of the clip, each sample the mean of the frames around it, so the
 *   payload stays small and tracker jitter is filtered before the planner sees it.
 * - {@link reframeToSubjectEdit} runs in the orchestrator: it re-checks the measurement against
 *   the project (same mask, same pinned track, same clip length) and feeds it to editor-core's
 *   `planAutomaticReframe`, which derives cover zoom and clamped pan from the render compiler's
 *   own placement formula and damps a nervous track.
 *
 * The subject's position is the mask's own geometry moved by the track (`T(t) · G(t)`), the
 * same composition both renderers draw and `track-run.ts` re-tracks from.
 */
import {
  DEFAULT_MAX_PAN_PIXELS_PER_FRAME,
  DEFAULT_TRACK_POLICY,
  maskFrameBox,
  maskGeometryAt,
  maskSourceTime,
  planAutomaticReframe,
  trackConfidenceAt,
  trackSourceSeconds,
  trackWarpAt,
  type DisplaySize,
  type Operation,
  type TrackArtifact,
  type TrackSample,
} from '@framepilot/editor-core';
import type { Clip, Keyframe, MaskLayer, Project } from '@framepilot/timeline-schema';
import { ToolRefusalError } from '../tool-refusal.js';
import { id } from '../domain-tools/tool-args.js';
import {
  ReframeToSubjectArgsSchema,
  type ReframeToSubjectMeasurement,
  type SubjectSample,
} from './contracts.js';
import { clipWithSize, maskOnClip } from './mask-builders.js';

/** Keyframes per second of clip: dense enough to follow a turn of the head, few enough to edit. */
export const SUBJECT_SAMPLES_PER_SECOND = 6;

/** Two aspect ratios this close are the same shape; the planner uses the same tolerance. */
const SAME_SHAPE_TOLERANCE = 1e-9;

const PERCENT = 100;

const REFUSE_NOT_TRACKED =
  'That mask is not tracked, so there is no subject movement to follow. Call track_mask for it ' +
  '(or create_mask with track:true), then call reframe_to_subject again.';

const REFUSE_CUTOUT =
  'A cut-out has no track to follow. Put a shape mask on the subject with create_mask ' +
  '(precision "shape", track:true), then call reframe_to_subject with that mask.';

const REFUSE_SAME_SHAPE =
  'The clip already has the frame’s shape, so there is no window to move: it shows the whole ' +
  'picture. For a push-in that follows the subject, use punch_in.';

const REFUSE_STALE_TRACK =
  'The mask was tracked again after this measurement, so nothing was applied. Call ' +
  'reframe_to_subject again.';

const REFUSE_STALE_CLIP =
  'The clip was trimmed after this measurement, so nothing was applied. Call ' +
  'reframe_to_subject again.';

const REFUSE_NEVER_SEEN =
  'The track never measured the subject on this clip with enough confidence to follow it, so ' +
  'nothing was changed. Tell the editor the track needs correcting in the Inspector’s Mask tab, ' +
  'or use reframe_pan to place the window by eye.';

/** What `reframe_to_subject` acts on, after every check that needs only the project. */
export interface SubjectReframeTarget {
  readonly clip: Clip;
  readonly mask: MaskLayer;
  readonly size: DisplaySize;
  readonly tracking: NonNullable<MaskLayer['tracking']>;
}

/**
 * Resolve and check the clip and mask a call names. Run before the host reads any file (the
 * orchestrator's preflight) and again by the host, so a refusal never costs a read.
 *
 * @throws ToolRefusalError with the remedy, for every state the edit cannot be made from.
 */
export function reframeToSubjectTarget(project: Project, rawArgs: unknown): SubjectReframeTarget {
  const args = ReframeToSubjectArgsSchema.parse(rawArgs);
  const { clip, size } = clipWithSize(project, args.clipId);
  const mask = maskOnClip(clip, args.maskId);
  if (mask.kind === 'matte') throw new ToolRefusalError(REFUSE_CUTOUT);
  if (mask.tracking === undefined) throw new ToolRefusalError(REFUSE_NOT_TRACKED);
  const { width, height } = project.resolution;
  const widthRatio = width / size.width;
  const heightRatio = height / size.height;
  if (
    Math.abs(Math.max(widthRatio, heightRatio) / Math.min(widthRatio, heightRatio) - 1) <
    SAME_SHAPE_TOLERANCE
  ) {
    throw new ToolRefusalError(REFUSE_SAME_SHAPE);
  }
  return { clip, mask, size, tracking: mask.tracking };
}

/** Frames between two samples at the project rate: six a second, at least one. */
export function subjectSampleStride(fps: number): number {
  return Math.max(1, Math.round(fps / SUBJECT_SAMPLES_PER_SECOND));
}

/** A clip's drawn frames: a layer is not drawn at the instant its clip ends. */
function clipFrameCount(clip: Clip, fps: number): number {
  return Math.max(1, Math.round((clip.end - clip.start) * fps));
}

/**
 * The subject's centre at asset source second `sourceTime`, as a fraction of the source picture,
 * or `null` when the mask has no geometry to place (a normalized path).
 */
function subjectCentreAt(
  mask: MaskLayer,
  artifact: TrackArtifact,
  size: DisplaySize,
  sourceTime: number,
): { readonly x: number; readonly y: number } | null {
  const warp = trackWarpAt(artifact, sourceTime);
  const geometry = maskGeometryAt(mask, sourceTime);
  let points: (readonly [number, number])[];
  if (geometry !== null && geometry.kind === 'path') {
    points = geometry.vertices.map((vertex, index) => warp(vertex.x, vertex.y, index));
  } else {
    const box = maskFrameBox(mask, size, sourceTime);
    if (box === null) return null;
    const left = box.x * size.width;
    const top = box.y * size.height;
    const right = left + box.width * size.width;
    const bottom = top + box.height * size.height;
    points = [
      warp(left, top, -1),
      warp(right, top, -1),
      warp(right, bottom, -1),
      warp(left, bottom, -1),
    ];
  }
  if (points.length === 0) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2 / size.width,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 / size.height,
  };
}

interface MeasuredCentre {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

/**
 * Where the tracked subject is across a clip, on the {@link subjectSampleStride} grid.
 *
 * Each sample is the mean centre of the confidently tracked frames within half a stride of a
 * grid point, stamped at their mean frame.
 * A frame outside the tracked range is unmeasured, not held: the track's nearest-end hold is right
 * for a MASK (it must not jump) but would invent a position for the camera to chase. A sample
 * with no measured frame carries confidence 0, which the planner skips.
 *
 * @param input.fps - The project rate: samples are clip frames at it.
 */
export function subjectSamplesFromTrack(input: {
  readonly clip: Clip;
  readonly mask: MaskLayer;
  readonly artifact: TrackArtifact;
  readonly size: DisplaySize;
  readonly fps: number;
}): SubjectSample[] {
  const { clip, mask, artifact, size, fps } = input;
  const frameCount = clipFrameCount(clip, fps);
  const stride = subjectSampleStride(fps);
  const reach = Math.floor(stride / 2);
  const lastTracked = artifact.pts.length - 1;
  // Half a frame of slack either side: a track measured on the frame grid starts ON a frame.
  const slack = 0.5 / fps;
  const trackedFrom = trackSourceSeconds(artifact, 0) - slack;
  const trackedTo = trackSourceSeconds(artifact, lastTracked) + slack;
  const measured = (frame: number): MeasuredCentre | null => {
    const sourceTime = maskSourceTime(clip, frame / fps);
    if (sourceTime < trackedFrom || sourceTime > trackedTo) return null;
    const confidence = trackConfidenceAt(artifact, sourceTime);
    if (confidence < DEFAULT_TRACK_POLICY.minimumConfidence) return null;
    const centre = subjectCentreAt(mask, artifact, size, sourceTime);
    return centre === null ? null : { ...centre, confidence, frame };
  };
  const anchors: number[] = [];
  for (let frame = 0; frame < frameCount; frame += stride) anchors.push(frame);
  if (anchors.at(-1) !== frameCount - 1) anchors.push(frameCount - 1);
  const samples: SubjectSample[] = [];
  for (const anchor of anchors) {
    const seen: MeasuredCentre[] = [];
    const first = Math.max(0, anchor - reach);
    const last = Math.min(frameCount - 1, anchor + reach);
    for (let frame = first; frame <= last; frame += 1) {
      const value = measured(frame);
      if (value !== null) seen.push(value);
    }
    if (seen.length === 0) {
      samples.push({ frame: anchor, x: 0.5, y: 0.5, confidence: 0 });
      continue;
    }
    const mean = (pick: (value: MeasuredCentre) => number): number =>
      seen.reduce((total, value) => total + pick(value), 0) / seen.length;
    // The mean position belongs to the mean INSTANT of the frames it came from. At the clip's
    // edges and at the ends of the track the window is one-sided, and stamping the mean on the
    // anchor would put the camera a frame or two behind the subject there.
    const frame = Math.round(mean((value) => value.frame));
    if (samples.at(-1)?.frame === frame) continue;
    samples.push({
      frame,
      x: mean((value) => value.x),
      y: mean((value) => value.y),
      confidence: mean((value) => value.confidence),
    });
  }
  return samples;
}

/** A baked subject reframe, ready for the orchestrator to validate and propose. */
export interface SubjectReframeEdit {
  readonly operations: Operation[];
  /** The result sentence the model reads. */
  readonly note: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const TRANSFORM_PROPERTIES = ['x', 'y', 'scale'] as const;

/**
 * Clear what a reframe owns — the crop and the x/y/scale keyframes — and write the new ones.
 * `reframe_pan`'s tail, for the same reason: a crop and a cover zoom would reframe twice.
 */
function replaceReframeOps(clip: Clip, keyframes: Keyframe[]): Operation[] {
  const ops: Operation[] = [];
  if (clip.crop !== undefined) ops.push({ type: 'set_clip_crop', clipId: clip.id, crop: null });
  const owned = TRANSFORM_PROPERTIES.filter((property) =>
    clip.keyframes.some((keyframe) => keyframe.property === property),
  );
  if (owned.length > 0) {
    ops.push({
      type: 'remove_keyframes',
      clipId: clip.id,
      targets: owned.map((property) => ({ property })),
    });
  }
  ops.push({ type: 'add_keyframes', clipId: clip.id, keyframes });
  return ops;
}

/** One keyframe for a property that never changes; every planned point otherwise. */
function keyframesFor(
  clip: Clip,
  property: (typeof TRANSFORM_PROPERTIES)[number],
  points: readonly {
    readonly frame: number;
    readonly value: number;
    readonly easing?: Keyframe['easing'];
  }[],
  fps: number,
): Keyframe[] {
  const constant = points.every(
    (point) => Math.abs(point.value - points[0]!.value) < SAME_SHAPE_TOLERANCE,
  );
  return (constant ? points.slice(0, 1) : points).map((point) => ({
    id: id('subject_reframe', clip.id, property, point.frame),
    time: point.frame / fps,
    property,
    value: point.value,
    easing: point.easing ?? 'linear',
  }));
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const seconds = (frame: number, fps: number): string => `${round1(frame / fps)} s`;

/**
 * The host's measurement → the reframe keyframes, re-checked against the project.
 *
 * @throws ToolRefusalError for a measurement that no longer describes the project, or a track
 *   that never saw the subject.
 */
export function reframeToSubjectEdit(
  project: Project,
  rawArgs: unknown,
  measurement: ReframeToSubjectMeasurement,
): SubjectReframeEdit {
  const target = reframeToSubjectTarget(project, rawArgs);
  const { clip, mask, size, tracking } = target;
  if (measurement.clipId !== clip.id || measurement.maskId !== mask.id) {
    throw new ToolRefusalError('The measurement is for a different mask, so nothing was applied.');
  }
  if (
    measurement.artifact.key !== tracking.artifact.key ||
    measurement.artifact.sha256 !== tracking.artifact.sha256
  ) {
    throw new ToolRefusalError(REFUSE_STALE_TRACK);
  }
  const fps = Number(project.fps);
  const frameCount = clipFrameCount(clip, fps);
  if (measurement.samples.some((sample) => sample.frame >= frameCount)) {
    throw new ToolRefusalError(REFUSE_STALE_CLIP);
  }
  const samples: TrackSample[] = [...measurement.samples]
    .sort((a, b) => a.frame - b.frame)
    .map((sample) => ({
      frame: sample.frame,
      box: { x: sample.x, y: sample.y, width: 0, height: 0 },
      confidence: sample.confidence,
      occluded: sample.confidence < DEFAULT_TRACK_POLICY.minimumConfidence,
    }));
  const visible = samples.filter((sample) => !sample.occluded);
  if (visible.length === 0) throw new ToolRefusalError(REFUSE_NEVER_SEEN);
  const stride = subjectSampleStride(fps);
  const plan = planAutomaticReframe({
    samples,
    source: size,
    target: project.resolution,
    rate: { numerator: fps, denominator: 1 },
    // Samples carry clip frames already; starting at the first visible one keeps them there.
    firstClipFrame: visible[0]!.frame,
    // The planner damps per SAMPLE step, and samples sit a stride apart.
    maxPanPixelsPerFrame: DEFAULT_MAX_PAN_PIXELS_PER_FRAME * stride,
    // Dense points: an ease on every short segment would make the camera stutter.
    easing: 'linear',
  });
  if (plan.status !== 'planned') throw new ToolRefusalError(plan.detail);
  const keyframes = TRANSFORM_PROPERTIES.flatMap((property) =>
    keyframesFor(clip, property, plan.points[property], fps),
  );
  const operations = replaceReframeOps(clip, keyframes);

  // What the window does, in the source's own terms: its centre as a share of the picture.
  const { width, height } = project.resolution;
  const fit = Math.min(width / size.width, height / size.height);
  const rendered = {
    width: size.width * fit * plan.coverScale,
    height: size.height * fit * plan.coverScale,
  };
  const horizontal = rendered.width - width >= rendered.height - height;
  const axis = horizontal ? 'x' : 'y';
  const centres = plan.points[axis].map(
    (point) => PERCENT * (0.5 - point.value / (horizontal ? rendered.width : rendered.height)),
  );
  const panFrom = Math.round(Math.min(...centres));
  const panTo = Math.round(Math.max(...centres));
  const panKeyframes = keyframes.filter((keyframe) => keyframe.property === axis).length;
  const damped = Number(plan.facts.find((fact) => fact.name === 'dampedFrameCount')?.value ?? 0);
  const firstFrame = visible[0]!.frame;
  const lastFrame = visible.at(-1)!.frame;
  const partial = firstFrame > stride || lastFrame < frameCount - 1 - stride;
  const note = [
    `Reframed ${clip.id} to follow mask ${mask.id}: ${panKeyframes} ${axis} keyframes from ` +
      `${seconds(firstFrame, fps)} to ${seconds(lastFrame, fps)}, at a ${round1(plan.coverScale)}× zoom ` +
      `that fills the frame. The window's centre moves between ${panFrom}% and ${panTo}% of the ` +
      `source's ${horizontal ? 'width' : 'height'}.`,
    partial ? 'Outside that span the track did not see the subject, so the frame holds.' : '',
    damped > 0
      ? `${damped} of the steps were slowed so the camera does not jerk; the subject may lead the frame there.`
      : '',
    'The clip crop and its x/y/scale keyframes were replaced; after re-tracking, call it again. ' +
      'Look at it with get_frame at a few moments.',
  ]
    .filter((sentence) => sentence !== '')
    .join(' ');
  return {
    operations,
    note,
    data: {
      kind: 'subject_reframe',
      clipId: clip.id,
      maskId: mask.id,
      keyframes: panKeyframes,
      coverScale: plan.coverScale,
      axis,
      windowCentrePercent: { from: panFrom, to: panTo },
      followedSeconds: { start: firstFrame / fps, end: lastFrame / fps },
      dampedSteps: damped,
    },
  };
}
