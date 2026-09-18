/**
 * The `exportJobEnd` event (RD2.2): what an export cost and how much masking it carried, so the
 * maintainer's dashboard can compare milliseconds per frame with and without mattes (the P13
 * export-time ratio in the field). Counts and a duration only: no ids, paths or names.
 */
import { maskingEventPayload, type MaskingEventPayload } from '@framepilot/shared-types';
import { masksOf, type Timeline } from '@framepilot/timeline-schema';

/** How much masking a timeline carries, counted over every clip's stack. */
export interface ExportMaskProfile {
  readonly maskedClips: number;
  readonly mattes: number;
  readonly keys: number;
  readonly shapes: number;
  readonly trackMattes: number;
  readonly frameSpaceMasks: number;
}

/**
 * Count the masks an export will render.
 *
 * @param timeline - The timeline being exported; absent ⇒ all zero.
 * @returns The counts, never the masks.
 */
export function exportMaskProfile(timeline: Timeline | undefined): ExportMaskProfile {
  let maskedClips = 0;
  let mattes = 0;
  let keys = 0;
  let shapes = 0;
  let trackMattes = 0;
  let frameSpaceMasks = 0;
  for (const track of timeline?.tracks ?? []) {
    for (const clip of track.clips) {
      const masks = masksOf(clip).filter((mask) => mask.enabled);
      if (masks.length > 0) maskedClips += 1;
      for (const mask of masks) {
        if (mask.kind === 'matte') mattes += 1;
        else if (mask.kind === 'key') keys += 1;
        else if (mask.kind === 'layer') trackMattes += 1;
        else shapes += 1;
        if (mask.space === 'frame') frameSpaceMasks += 1;
      }
    }
  }
  return { maskedClips, mattes, keys, shapes, trackMattes, frameSpaceMasks };
}

/**
 * The allow-listed `exportJobEnd` payload.
 *
 * @param outcome - How the export ended.
 * @param elapsedMs - Wall time from the render request to its result.
 * @param frames - Frames the export renders (duration × output rate, rounded).
 * @param resolution - The dialog's resolution choice (`1080p`, …).
 * @param timeline - The exported timeline, counted by {@link exportMaskProfile}.
 */
export function exportJobEndPayload(
  outcome: 'completed' | 'failed' | 'cancelled',
  elapsedMs: number,
  frames: number,
  resolution: string,
  timeline: Timeline | undefined,
): MaskingEventPayload<'exportJobEnd'> {
  return maskingEventPayload('exportJobEnd', {
    status: outcome,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    frames: Math.max(0, Math.round(frames)),
    resolution,
    ...exportMaskProfile(timeline),
  });
}
