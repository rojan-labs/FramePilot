/**
 * Projection between a footage asset's SOURCE seconds and the timeline (plan FI5.1a).
 *
 * WHY: footage understanding is asset-native — chapters carry each clip's own source
 * seconds, so the map reflects the footage rather than the current edit (a trimmed or
 * unplaced asset still shows its full structure). But once a clip IS on the timeline,
 * the panel wants to act on it: click a chapter to seek the playhead there, and light
 * up the chapter the playhead is currently inside. Those need the mapping between the
 * two time spaces, computed against the LIVE timeline — the "reference during edit"
 * behavior, kept out of the engine (which stays asset-only).
 *
 * Linear within a clip, so a speed-ramped clip (timeline extent ≠ source extent) maps
 * correctly through its own `[start,end]` ↔ `[sourceStart,sourceEnd]`. The FIRST clip
 * that windows the time wins (a source moment placed twice seeks to its first use).
 */
import type { Timeline } from '@framepilot/timeline-schema';

/** A point in an asset's own source time — what a footage-map chapter/highlight uses. */
export interface SourcePoint {
  readonly assetId: string;
  /** Seconds into the source asset. */
  readonly sourceSeconds: number;
}

/**
 * Timeline seconds for a source moment of `assetId`, or `undefined` when that asset is
 * not on the timeline (or the moment falls outside every placed range). `undefined`
 * means "not placed" — the caller disables seeking rather than jumping somewhere wrong.
 */
export function sourceToTimeline(point: SourcePoint, timeline: Timeline): number | undefined {
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId !== point.assetId) continue;
      const { sourceStart, sourceEnd, start, end } = clip;
      if (point.sourceSeconds < sourceStart || point.sourceSeconds >= sourceEnd) continue;
      const srcLen = sourceEnd - sourceStart;
      if (srcLen <= 0) continue;
      const frac = (point.sourceSeconds - sourceStart) / srcLen;
      return start + frac * (end - start);
    }
  }
  return undefined;
}

/**
 * The source moment under the timeline `playhead`, or `undefined` when no clip covers
 * it. Used to light up the chapter the edit is currently sitting inside. The first
 * covering clip wins (overlapping tracks resolve to the topmost declared).
 */
export function timelineToSource(playhead: number, timeline: Timeline): SourcePoint | undefined {
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const { start, end, sourceStart, sourceEnd } = clip;
      if (playhead < start || playhead >= end) continue;
      const tlLen = end - start;
      if (tlLen <= 0) continue;
      const frac = (playhead - start) / tlLen;
      return {
        assetId: clip.assetId,
        sourceSeconds: sourceStart + frac * (sourceEnd - sourceStart),
      };
    }
  }
  return undefined;
}
