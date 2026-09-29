/**
 * What a clip can use as its track matte (MK8.2): other clips on picture lanes (video and overlay)
 * that play while it does — a title (text as a mask), a shape, another shot — and those whole
 * lanes. The validator and the export accept exactly these (AL31a).
 *
 * The choice is a picker value (`clip:<id>` / `track:<id>`) so one select can hold both kinds; the
 * command receives the typed source ({@link parseTrackMatteSource}).
 */
import { PICTURE_LANE_TYPES, clipRenderKind, isDrawnClipKind } from '@framepilot/editor-core';
import type { Clip, Timeline } from '@framepilot/timeline-schema';

/** A `layer` mask's source, as the schema stores it. */
export type TrackMatteSource =
  | { readonly kind: 'clip'; readonly clipId: string }
  | { readonly kind: 'track'; readonly trackId: string };

export interface TrackMatteOption {
  readonly value: string;
  readonly label: string;
}

/** The picker value of a source. */
export const trackMatteValue = (source: TrackMatteSource): string =>
  source.kind === 'clip' ? `clip:${source.clipId}` : `track:${source.trackId}`;

/** The source a picker value names, or `null` for anything else. */
export function parseTrackMatteSource(value: string): TrackMatteSource | null {
  if (value.startsWith('clip:') && value.length > 5)
    return { kind: 'clip', clipId: value.slice(5) };
  if (value.startsWith('track:') && value.length > 6) {
    return { kind: 'track', trackId: value.slice(6) };
  }
  return null;
}

/** A clip's short name: a title's text, else its id. */
function clipName(clip: Clip): string {
  const text = clip.effects.find((effect) => effect.type === 'text')?.params.text;
  if (typeof text === 'string' && text.trim() !== '') {
    const trimmed = text.trim();
    return `Text “${trimmed.length > 24 ? `${trimmed.slice(0, 23)}…` : trimmed}”`;
  }
  return `Clip ${clip.id}`;
}

/**
 * Sources `clip` can read: drawn clips on OTHER picture lanes overlapping it in time (a matte that
 * never plays while the clip does would draw nothing), then those other lanes. A caption cue is
 * burned by its own pass, never drawn in its lane, so it is not offered even on a picture lane.
 */
export function trackMatteOptions(timeline: Timeline, clip: Clip): TrackMatteOption[] {
  const clips: TrackMatteOption[] = [];
  const tracks: TrackMatteOption[] = [];
  for (const track of timeline.tracks) {
    if (!PICTURE_LANE_TYPES.has(track.type) || track.id === clip.trackId) continue;
    const trackName = `track ${track.id}`;
    for (const candidate of track.clips) {
      if (candidate.id === clip.id) continue;
      if (candidate.end <= clip.start || candidate.start >= clip.end) continue;
      // No asset table here: a media id reads as picture, as the renderer draws it.
      if (!isDrawnClipKind(clipRenderKind(candidate.assetId, undefined))) continue;
      clips.push({
        value: trackMatteValue({ kind: 'clip', clipId: candidate.id }),
        label: `${clipName(candidate)} (${trackName})`,
      });
    }
    tracks.push({
      value: trackMatteValue({ kind: 'track', trackId: track.id }),
      label: `All of ${trackName}`,
    });
  }
  return [...clips, ...tracks];
}

/** The four channels, with the words the picker shows. */
export const TRACK_MATTE_CHANNELS = ['alpha', 'luma', 'inverted-alpha', 'inverted-luma'] as const;
export const TRACK_MATTE_CHANNEL_LABELS = [
  'Alpha',
  'Luma',
  'Alpha, inverted',
  'Luma, inverted',
] as const;
