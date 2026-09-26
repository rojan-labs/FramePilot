/**
 * Where an element is on the frame (plan/elements EL8.1, 07 §4).
 *
 * The rectangle a sticker's art or a shape covers at a time, read from the frame plan — the one
 * both renderers draw from — so a check built on it judges what the export shows. The agent's
 * placement refusal (an element off the frame the whole time renders as nothing) and the
 * critic's advisories (faces, the caption band, a busy frame, a soft sticker) all read it, and
 * the Inspector's sharpness note reads {@link stickerEnlargement}.
 *
 * Rectangles are fractions of the frame (0..1 on each axis, origin top-left), axis-aligned: a
 * turned element is judged by the box it is turned from, which is what the checks need.
 */
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { elementArtFraction, isElementAsset } from './element-assets.js';
import { framePlanAt } from './frame-plan.js';
import { syntheticClipKind } from './synthetic-assets.js';

export type ElementKind = 'sticker' | 'shape';

export interface FrameRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The parts of a project an element's placement depends on. */
export interface ElementProject {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly resolution: { readonly width: number; readonly height: number };
}

/** Above this many times its own pixels a sticker reads as soft (plan/elements 03 §2.2). */
export const STICKER_SOFT_ENLARGEMENT = 1.5;

/** A hair inside a clip's end, where the frame plan still draws it (end-exclusive). */
const END_INSET_SECONDS = 1e-3;

/** A sticker (an element asset) or a shape, or `null` for anything else. */
export function elementKindOf(clip: Clip, assets: readonly Asset[]): ElementKind | null {
  if (syntheticClipKind(clip.assetId) === 'shape') return 'shape';
  return isElementAsset(assets.find((asset) => asset.id === clip.assetId)) ? 'sticker' : null;
}

/** Every element clip on the timeline, with its kind. */
export function elementClips(
  project: ElementProject,
): readonly { readonly clip: Clip; readonly kind: ElementKind }[] {
  return project.timeline.tracks.flatMap((track) =>
    track.clips.flatMap((clip) => {
      const kind = elementKindOf(clip, project.assets);
      return kind === null ? [] : [{ clip, kind }];
    }),
  );
}

function findClip(timeline: Timeline, clipId: string): Clip | undefined {
  return timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
}

/**
 * The frame rectangle element `clipId` covers at timeline `time`, or `null` when it is not on the
 * timeline then (or draws nothing). A sticker is measured by its art, without the transparent
 * margin every library sticker is padded with.
 */
export function elementRectAt(
  project: ElementProject,
  clipId: string,
  time: number,
): FrameRect | null {
  const clip = findClip(project.timeline, clipId);
  if (clip === undefined || time < clip.start || time >= clip.end) return null;
  const plan = framePlanAt(project.timeline, project.assets, time, project.resolution);
  const geometry = plan.layers.find(
    (layer) => layer.clipId === clipId && layer.role === 'clip',
  )?.geometry;
  if (
    geometry === null ||
    geometry === undefined ||
    geometry.left === null ||
    geometry.top === null ||
    geometry.width === null ||
    geometry.height === null
  ) {
    return null;
  }
  const kind = elementKindOf(clip, project.assets);
  const art =
    kind === 'sticker'
      ? elementArtFraction(project.assets.find((asset) => asset.id === clip.assetId))
      : 1;
  const width = geometry.width * art;
  const height = geometry.height * art;
  const left = geometry.left + (geometry.width - width) / 2;
  const top = geometry.top + (geometry.height - height) / 2;
  const { width: frameWidth, height: frameHeight } = project.resolution;
  return {
    x: left / frameWidth,
    y: top / frameHeight,
    width: width / frameWidth,
    height: height / frameHeight,
  };
}

/**
 * The moments an element is judged at: its start, its quarters, a hair before its end, and each
 * of its keyframes (motion peaks at one of them), in order.
 */
export function elementSampleTimes(clip: Clip): readonly number[] {
  const end = Math.max(clip.start, clip.end - END_INSET_SECONDS);
  const span = end - clip.start;
  const times = new Set<number>([clip.start, end]);
  for (const share of [0.25, 0.5, 0.75]) times.add(clip.start + span * share);
  for (const keyframe of clip.keyframes) times.add(Math.min(end, clip.start + keyframe.time));
  return [...times].sort((a, b) => a - b);
}

/** Whether two frame rectangles share any area. */
export function rectsOverlap(a: FrameRect, b: FrameRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const WHOLE_FRAME: FrameRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Whether element `clipId` shows on the frame at any of its sample times. `false` means the edit
 * renders as nothing: the element is off the frame for as long as it is on the timeline.
 */
export function elementEverOnFrame(project: ElementProject, clipId: string): boolean {
  const clip = findClip(project.timeline, clipId);
  if (clip === undefined) return false;
  return elementSampleTimes(clip).some((time) => {
    const rect = elementRectAt(project, clipId, time);
    return rect !== null && rect.width > 0 && rect.height > 0 && rectsOverlap(rect, WHOLE_FRAME);
  });
}

/**
 * The largest enlargement of sticker `clipId` over its clip at the export resolution — its drawn
 * height over its file's pixel height — or `null` when it is not a still of known size. Stickers
 * ship at one size, so above {@link STICKER_SOFT_ENLARGEMENT} the export draws them soft.
 */
export function stickerEnlargement(project: ElementProject, clipId: string): number | null {
  const clip = findClip(project.timeline, clipId);
  const asset = project.assets.find((candidate) => candidate.id === clip?.assetId);
  const fileHeight = asset?.kind === 'image' ? asset.media?.height : undefined;
  if (clip === undefined || typeof fileHeight !== 'number' || !(fileHeight > 0)) return null;
  let largest: number | null = null;
  for (const time of elementSampleTimes(clip)) {
    const plan = framePlanAt(project.timeline, project.assets, time, project.resolution);
    const drawn = plan.layers.find((layer) => layer.clipId === clipId && layer.role === 'clip')
      ?.geometry?.height;
    if (drawn === null || drawn === undefined) continue;
    largest = Math.max(largest ?? 0, drawn / fileHeight);
  }
  return largest;
}
