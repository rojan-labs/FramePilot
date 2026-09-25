/**
 * Which clips the export mixes, and how each one reads its source over time.
 *
 * Mirrors the audio half of `compile_timeline` (`render/compiler.py`): footage on a visible,
 * unmuted track contributes its sound; an audio clip on an unmuted track contributes its sound
 * whether or not the track is hidden (hiding is a picture control); `_apply_speed` then decides
 * how the clip's timeline time reads its source — straight at a constant speed, not at all for
 * a freeze (`without_audio`), backwards for a reverse (`TimeMirror` then `MultiplySpeed`), and
 * through the ramp's time map (`ramped_time_map`) for a speed ramp.
 *
 * Pure: the layered engine turns these into Web Audio nodes, and the tests hold them to the
 * export's rules without a browser.
 */
import { hasSpeedRamp, integrateRate } from '@framepilot/editor-core';
import type { Clip, Timeline, Track } from '@framepilot/timeline-schema';

/** What a clip is, in the export's `clip_kind` terms, for the kinds that can carry sound. */
export type SoundKind = 'video' | 'audio' | 'other';

/** A clip whose sound reaches the export's mix. */
export interface SoundingClip {
  readonly track: Track;
  readonly clip: Clip;
  /** `video` is footage (its sound rides the picture's file); `audio` is an audio clip. */
  readonly kind: 'video' | 'audio';
}

/**
 * The clips the export mixes, in timeline order.
 *
 * @param timeline - The timeline being played.
 * @param kindOf - The clip's kind, as `clip_kind` derives it from its asset.
 * @param mutedTrackIds - Tracks that are silent: the persisted `muted` flag, folded through the
 *   monitor's solo (which the export ignores; see `effectiveMutedTrackIds`).
 */
export function soundingClips(
  timeline: Timeline,
  kindOf: (clip: Clip) => SoundKind,
  mutedTrackIds: ReadonlySet<string>,
): readonly SoundingClip[] {
  const sounding: SoundingClip[] = [];
  for (const track of timeline.tracks) {
    if (mutedTrackIds.has(track.id)) continue;
    for (const clip of track.clips) {
      const kind = kindOf(clip);
      if (kind === 'video' && track.hidden !== true) sounding.push({ track, clip, kind });
      else if (kind === 'audio') sounding.push({ track, clip, kind });
    }
  }
  return sounding;
}

/** How a clip's timeline time reads its source. */
export type SourceRead =
  /** A freeze: the export drops the clip's sound. */
  | { readonly kind: 'silent' }
  /** Forward at a constant speed: source = `sourceStart + local × rate`. */
  | { readonly kind: 'rate'; readonly rate: number }
  /**
   * Any other map, from clip-local timeline seconds to clip-local source seconds. The sound has
   * to be resampled along it ({@link resampleAlong}), because a buffer source only plays forward
   * at a rate.
   */
  | { readonly kind: 'mapped'; readonly sourceAt: (local: number) => number };

/** MoviePy's ramp table resolution: about 1 ms of source per step, at most 2^16 steps. */
const RAMP_TABLE_STEPS_PER_SECOND = 1000;
const RAMP_TABLE_MAX_STEPS = 1 << 16;

/**
 * `ramped_time_map`: the ramp's integral tabulated once over the source, then inverted by
 * linear interpolation (`np.interp`), clamped at both ends.
 */
function rampedSourceAt(clip: Clip): (local: number) => number {
  const ramp = clip.speedRamp ?? [];
  const maxSource = clip.sourceEnd - clip.sourceStart;
  const steps = Math.max(
    2,
    Math.min(RAMP_TABLE_MAX_STEPS, Math.ceil(maxSource * RAMP_TABLE_STEPS_PER_SECOND) + 1),
  );
  const sources = new Float64Array(steps);
  const timeline = new Float64Array(steps);
  const spacing = maxSource / (steps - 1);
  for (let i = 0; i < steps; i += 1) {
    sources[i] = i === steps - 1 ? maxSource : i * spacing;
    timeline[i] = integrateRate(ramp, 0, sources[i]!);
  }
  return (local: number): number => {
    if (local <= timeline[0]!) return sources[0]!;
    if (local >= timeline[steps - 1]!) return sources[steps - 1]!;
    let low = 0;
    let high = steps - 1;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (timeline[mid]! <= local) low = mid;
      else high = mid;
    }
    const span = timeline[high]! - timeline[low]!;
    if (span <= 0) return sources[low]!;
    return sources[low]! + ((local - timeline[low]!) / span) * (sources[high]! - sources[low]!);
  };
}

/**
 * How `clip` reads its source, as `_apply_speed` builds it.
 *
 * @param clip - The sounding clip.
 * @param sourceSeconds - The source's own length; a subclip that would run past it ends there,
 *   as `_subclipped_source` ends it.
 * @param mirrorFrameSeconds - One frame of the clip being mirrored (`1 / fps`): MoviePy's time
 *   mirror reads `duration − t − 1/fps`, so a reversed clip starts one frame before its end.
 *   Footage mirrors at the video's frame rate; an audio file at its reader's 44.1 kHz.
 */
export function sourceReadOf(
  clip: Clip,
  sourceSeconds: number,
  mirrorFrameSeconds: number,
): SourceRead {
  if (hasSpeedRamp(clip)) return { kind: 'mapped', sourceAt: rampedSourceAt(clip) };
  const speed = clip.speed ?? 1;
  if (speed === 0) return { kind: 'silent' };
  if (speed > 0) return { kind: 'rate', rate: speed };
  const end = Math.min(clip.sourceEnd, sourceSeconds);
  const duration = Math.max(0, end - clip.sourceStart);
  const magnitude = Math.abs(speed);
  return {
    kind: 'mapped',
    sourceAt: (local: number): number => duration - magnitude * local - mirrorFrameSeconds,
  };
}

/**
 * One channel of a clip's sound, resampled along a mapped read into timeline-rate samples.
 *
 * @param channel - The whole source's samples for one channel.
 * @param sampleRate - Samples per second, of both the source and the output.
 * @param sourceStart - The clip's `sourceStart`: clip-local source 0 in the file.
 * @param sourceAt - Clip-local timeline seconds → clip-local source seconds.
 * @param fromLocal - The clip-local timeline second the output starts at.
 * @param frames - Output length in samples.
 * @returns The resampled channel; a read outside the file is silence, as the reader returns.
 */
export function resampleAlong(
  channel: Float32Array,
  sampleRate: number,
  sourceStart: number,
  sourceAt: (local: number) => number,
  fromLocal: number,
  frames: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames);
  const last = channel.length - 1;
  for (let n = 0; n < frames; n += 1) {
    const position = (sourceStart + sourceAt(fromLocal + n / sampleRate)) * sampleRate;
    if (!(position >= 0) || position > last) continue;
    const index = Math.floor(position);
    const fraction = position - index;
    const here = channel[index]!;
    out[n] = fraction === 0 ? here : here + (channel[index + 1]! - here) * fraction;
  }
  return out;
}
