/**
 * How far a sticker is drawn beyond its own pixels (plan/elements 03 §2.2, 05 §3).
 *
 * Stickers ship at one size (the art is 256 px inside a 318 px file). Drawn larger, the export
 * scales the file up and the sticker goes soft; above 1.5× the Inspector says so rather than
 * letting a soft sticker export silently. The size is the frame plan's — what both renderers
 * draw — at the export resolution, at the clip's largest: its start, its end, and every keyframe
 * in between (an eased segment peaks at one of its keys; a custom curve that overshoots them can
 * go a little past this reading).
 */
import { framePlanAt } from '@framepilot/editor-core';
import type { Asset, Timeline } from '@framepilot/timeline-schema';

/** Above this many times its own pixels, a sticker reads as soft (03 §2.2). */
export const STICKER_SOFT_ENLARGEMENT = 1.5;

/** A hair inside the clip's end, where the frame plan still draws it. */
const END_INSET_SECONDS = 1e-3;

/**
 * The largest enlargement of clip `clipId`'s still over the clip, or `null` when it is not a
 * still of known size on the timeline.
 */
export function stickerEnlargement(
  project: {
    readonly timeline: Timeline;
    readonly assets: readonly Asset[];
    readonly resolution: { readonly width: number; readonly height: number };
  },
  clipId: string,
): number | null {
  const clip = project.timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
  const asset = project.assets.find((candidate) => candidate.id === clip?.assetId);
  const fileHeight = asset?.kind === 'image' ? asset.media?.height : undefined;
  if (clip === undefined || typeof fileHeight !== 'number' || !(fileHeight > 0)) return null;
  const end = Math.max(clip.start, clip.end - END_INSET_SECONDS);
  const times = new Set([
    clip.start,
    end,
    ...clip.keyframes.map((keyframe) => Math.min(end, clip.start + keyframe.time)),
  ]);
  let largest: number | null = null;
  for (const time of times) {
    const plan = framePlanAt(project.timeline, project.assets, time, project.resolution);
    const layer = plan.layers.find((entry) => entry.clipId === clipId && entry.role === 'clip');
    const drawn = layer?.geometry?.height;
    if (drawn === null || drawn === undefined) continue;
    largest = Math.max(largest ?? 0, drawn / fileHeight);
  }
  return largest;
}
