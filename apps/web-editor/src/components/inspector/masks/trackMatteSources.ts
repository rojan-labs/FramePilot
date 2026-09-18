/**
 * What a clip can use as its track matte (MK8.2): other clips on video tracks that play while it
 * does — a title (text as a mask), a graphic, another shot — and whole video tracks.
 *
 * The choice is a picker value (`clip:<id>` / `track:<id>`) so one select can hold both kinds; the
 * command receives the typed source ({@link parseTrackMatteSource}).
 */
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
 * Sources `clip` can read: clips on OTHER video tracks overlapping it in time (a matte that never
 * plays while the clip does would draw nothing), then the other video tracks.
 */
export function trackMatteOptions(timeline: Timeline, clip: Clip): TrackMatteOption[] {
  const clips: TrackMatteOption[] = [];
  const tracks: TrackMatteOption[] = [];
  for (const track of timeline.tracks) {
    if (track.type !== 'video' || track.id === clip.trackId) continue;
    const trackName = `track ${track.id}`;
    for (const candidate of track.clips) {
      if (candidate.id === clip.id) continue;
      if (candidate.end <= clip.start || candidate.start >= clip.end) continue;
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
