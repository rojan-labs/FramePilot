/**
 * How far a zoom magnifies the SOURCE, said in the result of the tools that zoom.
 *
 * ## Why a zoom reports it
 *
 * A zoom's `scale` is relative to the fit, not to the source's pixels, so it hides how much
 * detail the frame is really showing. `reframe_pan` fills a 9:16 frame from a 16:9 source at
 * a ~3.16× cover zoom, and since 370f04f9 a `punch_in` multiplies that zoom — so a "1.3×
 * punch" on a panned 1080p clip draws each source pixel more than two output pixels wide.
 * Harness run 8's road shot at 17 s was visibly soft for exactly that reason, and nothing
 * the model read had told it. The number is not refused: a soft push-in can be a choice.
 * It is stated, so the model can choose a smaller zoom if it did not mean one.
 *
 * The geometry is `framePlanAt`'s — the render compiler's own placement arithmetic, crop,
 * fit, keyframed scale and stretch included — read at the project resolution.
 */
import { assetDisplaySize, framePlanAt } from '@framepilot/editor-core';
import type { Clip, Project } from '@framepilot/timeline-schema';

/**
 * Output pixels per source pixel above which the picture is upscaled: past one, the
 * renderer interpolates detail the source never recorded, which is what reads as soft.
 */
export const SOFT_UPSCALE_THRESHOLD = 1;

/** The zoom tools whose result states the magnification. */
const ZOOM_TOOLS: ReadonlySet<string> = new Set(['punch_in', 'reframe_pan']);

/** The properties that decide how large a picture is drawn. */
const SIZE_PROPERTIES = ['scale', 'scaleX', 'scaleY'] as const;

/** Magnification is reported to two decimals; comparing the rounded value keeps float residue out. */
const MAGNIFICATION_DECIMALS = 100;

export interface PeakMagnification {
  /** Output pixels per source pixel on the more magnified axis, at the peak. */
  readonly magnification: number;
  /** Clip-relative seconds of the peak. */
  readonly clipSeconds: number;
  /** The measured (display-corrected) source size the magnification is relative to. */
  readonly source: { readonly width: number; readonly height: number };
}

function findClip(project: Project, clipId: string): Clip | undefined {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return clip;
  }
  return undefined;
}

/**
 * Clip-relative instants that can hold the largest size: the clip's edges and every size
 * keyframe. Between two keyframes every named easing stays inside their values, so the peak
 * of the curve is at one of them. The end is pulled in half a frame, because a layer is not
 * drawn at the instant its clip ends.
 */
function candidateTimes(clip: Clip, fps: number): number[] {
  const duration = clip.end - clip.start;
  const last = Math.max(0, duration - 0.5 / fps);
  const times = [0, last];
  // `?? []`: hand-built projects (tests, older hosts) can omit a clip's keyframe list.
  for (const keyframe of clip.keyframes ?? []) {
    if ((SIZE_PROPERTIES as readonly string[]).includes(keyframe.property)) {
      times.push(Math.min(Math.max(keyframe.time, 0), last));
    }
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

function roundMagnification(value: number): number {
  return Math.round(value * MAGNIFICATION_DECIMALS) / MAGNIFICATION_DECIMALS;
}

/**
 * The most a clip's picture is magnified over its duration, from the export's own geometry.
 *
 * @param project - The project to read (pre- or post-edit).
 * @param clipId - The clip to measure.
 * @returns The peak, or `null` when the clip is gone, is not a picture, or its source was
 *   never measured — there is no honest number to give then.
 */
export function peakMagnification(project: Project, clipId: string): PeakMagnification | null {
  const clip = findClip(project, clipId);
  if (clip === undefined) return null;
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const source = assetDisplaySize(asset?.media);
  if (source === null) return null;
  let peak: PeakMagnification | null = null;
  for (const clipSeconds of candidateTimes(clip, project.fps)) {
    const plan = framePlanAt(
      project.timeline,
      project.assets,
      clip.start + clipSeconds,
      project.resolution,
    );
    const layer = plan.layers.find(
      (candidate) =>
        candidate.clipId === clip.id && candidate.role === 'clip' && candidate.kind === 'picture',
    );
    const geometry = layer?.geometry;
    if (geometry === null || geometry === undefined) continue;
    const magnification = roundMagnification(
      geometry.scale * Math.max(geometry.stretchX ?? 1, geometry.stretchY ?? 1),
    );
    if (peak === null || magnification > peak.magnification) {
      peak = { magnification, clipSeconds, source };
    }
  }
  return peak;
}

function describePeak(peak: PeakMagnification, project: Project): string {
  const { width, height } = project.resolution;
  return (
    `at its peak (${peak.clipSeconds.toFixed(2)} s into the clip) each source pixel is drawn ` +
    `${String(peak.magnification)} output pixels wide — the ${String(peak.source.width)}×` +
    `${String(peak.source.height)} source magnified ${String(peak.magnification)}× in the ` +
    `${String(width)}×${String(height)} frame`
  );
}

/**
 * What the next step can do about an upscale. A punch that took a sharp picture past the
 * threshold can simply be smaller; a picture that was already upscaled before the punch
 * stays soft at any punch, and saying so saves the model hunting for a zoom that works.
 */
function upscaleAdvice(toolName: string, before: PeakMagnification | null): string {
  if (toolName === 'reframe_pan') {
    return (
      'The pan already uses the smallest zoom that fills the frame, so any punch_in on top ' +
      'magnifies it further.'
    );
  }
  if (before !== null && before.magnification > SOFT_UPSCALE_THRESHOLD) {
    return (
      `Before this punch it was already ${String(before.magnification)}×, so the source is ` +
      'soft at any punch on this clip; a smaller toScale softens it less.'
    );
  }
  return 'A smaller toScale keeps it sharper.';
}

/**
 * The magnification sentence for a zoom tool's result, or `''` for any other tool or when
 * the source size is unknown.
 *
 * @param toolName - The tool whose operations were applied.
 * @param before - The working copy the tool decided from (pre-patch).
 * @param applied - The working copy after the patch — the state the number describes.
 * @param rawArgs - The call's arguments; only `clipId` is read.
 * @returns ` · magnification: …`, naming an upscale plainly when there is one.
 */
export function magnificationNote(
  toolName: string,
  before: Project,
  applied: Project,
  rawArgs: unknown,
): string {
  if (!ZOOM_TOOLS.has(toolName)) return '';
  const clipId = (rawArgs as { clipId?: unknown } | null | undefined)?.clipId;
  if (typeof clipId !== 'string') return '';
  const peak = peakMagnification(applied, clipId);
  if (peak === null) return '';
  const described = describePeak(peak, applied);
  if (peak.magnification <= SOFT_UPSCALE_THRESHOLD) {
    return ` · magnification: ${described}; no upscale, the picture keeps its detail.`;
  }
  const previous = toolName === 'punch_in' ? peakMagnification(before, clipId) : null;
  return (
    ` · magnification: ${described}. That is an upscale: the picture shows fewer source ` +
    `pixels than the frame has and will look soft. ${upscaleAdvice(toolName, previous)}`
  );
}
