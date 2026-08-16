/**
 * Public patch-builder surface.
 *
 * The historical implementation remains byte-for-byte in patch-builders-base.ts.
 * Overlay projection is wrapped only for WebCodecs change detection: the full overlay
 * object still reaches the preview engine, while JSON.stringify sees a compact token
 * keyed to the immutable source clip instead of serializing all styling payloads.
 */
export * from './patch-builders-base.js';

import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  overlayClips as baseOverlayClips,
  type OverlayClip,
} from './patch-builders-base.js';
import { withPreviewIdentity } from '../preview/semantic-signature.js';

export function overlayClips(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
): readonly OverlayClip[] {
  const clipById = new Map(
    timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
  );
  return baseOverlayClips(timeline, assetById).map((overlay) =>
    withPreviewIdentity(overlay, clipById.get(overlay.id) ?? overlay),
  );
}
