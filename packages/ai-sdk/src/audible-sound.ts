/**
 * @framepilot/ai-sdk/audible-sound — where on the timeline something can be heard, read off the
 * waveform peaks every imported asset already carries. No render, no sidecar.
 *
 * ## Why this exists
 *
 * The dead-air check counted WORDS. On run x59-1 (NASA's X-59 first-flight B-roll cut into a
 * 101 s film) it reported "Dead air: 226 frames (7.54s) after the last word … ripple_delete
 * the head/tail range". That tail is the music bed fading out and the crowd greeting the pilot,
 * at -22 to -12 dBFS. Following the advice would have cut the ending. A stretch with no words
 * is dead air only when nothing worth hearing plays there either, and that can be read from
 * data the project already holds: `asset.media.peaks`, the max |sample| per bucket at
 * `peaksPerSecond` (`engine/python/.../media/waveform.py#compute_peaks`).
 *
 * The level is each clip's peak through its own fader, the way the render mixes it: clip and
 * track mute (`clipIsAudible`), a picture track that is hidden (the compiler skips that clip's
 * sound too), static gain or its automation lane, and fades with their curve
 * (`audio/mixing.py#fade_gain_at`). Ducking and peak-normalize are not modelled. Ducking can
 * only lower a bed, so leaving it out errs towards "something is playing". Normalize depends on
 * the clip's own peak.
 */
import {
  buildTimelineMap,
  spanIsFrozen,
  spanSequenceToSource,
  type ClipSpan,
} from '@framepilot/editor-core';
import type { Asset, Clip, Project, Track } from '@framepilot/timeline-schema';
import { evaluateKeyframes } from '@framepilot/timeline-schema/keyframe-curves';

/** Which frames of a window carry measured sound at or above a floor. */
export interface AudibleFrames {
  /** One entry per frame of the window, `true` where a measured clip reaches the floor. */
  readonly audible: readonly boolean[];
  /**
   * Whether anything in the window was measured: a heard clip with waveform peaks, or a clip
   * known to be silent (muted, on a hidden picture track, frozen). `false` means `audible` is
   * all `false` for want of evidence (media never probed), not because the window is silent.
   */
  readonly measured: boolean;
}

/** A frame range, `[startFrame, endFrame)`. */
export interface FrameWindow {
  readonly startFrame: number;
  readonly endFrame: number;
}

interface GainSettings {
  readonly gainDb: number;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  readonly fadeCurve: string;
  readonly lane: Clip['keyframes'];
}

const dbToAmplitude = (db: number): number => 10 ** (db / 20);

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function gainSettings(clip: Clip): GainSettings {
  const effect = clip.effects?.find((candidate) => candidate.type === 'audio_gain');
  const params = (effect?.params ?? {}) as Record<string, unknown>;
  return {
    gainDb: finiteOr(params.gainDb, 0),
    fadeInSeconds: Math.max(0, finiteOr(params.fadeInSeconds, 0)),
    fadeOutSeconds: Math.max(0, finiteOr(params.fadeOutSeconds, 0)),
    fadeCurve: typeof params.fadeCurve === 'string' ? params.fadeCurve : 'linear',
    lane: (effect?.keyframes ?? []).filter((keyframe) => keyframe.property === 'gainDb'),
  };
}

/** `audio/mixing.py#fade_gain_at`, at one clip-local instant. */
function fadeGain(settings: GainSettings, local: number, duration: number): number {
  let gain = 1;
  if (settings.fadeInSeconds > 0) {
    gain = Math.min(gain, Math.min(1, Math.max(0, local / settings.fadeInSeconds)));
  }
  if (settings.fadeOutSeconds > 0) {
    gain = Math.min(gain, Math.min(1, Math.max(0, (duration - local) / settings.fadeOutSeconds)));
  }
  if (settings.fadeCurve === 'equal-power') return Math.sin((gain * Math.PI) / 2);
  if (settings.fadeCurve === 'smooth') return gain * gain * (3 - 2 * gain);
  return gain;
}

/** The clip's fader over a clip-local interval, at its louder end. */
function faderAmplitude(
  settings: GainSettings,
  fromLocal: number,
  toLocal: number,
  duration: number,
): number {
  const levelAt = (local: number): number =>
    dbToAmplitude(
      settings.lane.length > 0
        ? (evaluateKeyframes(settings.lane, 'gainDb', local) ?? settings.gainDb)
        : settings.gainDb,
    ) * fadeGain(settings, local, duration);
  return Math.max(levelAt(fromLocal), levelAt(toLocal));
}

/** The loudest waveform bucket a source interval touches, or 0 past the measured audio. */
function peakOver(peaks: readonly number[], perSecond: number, from: number, to: number): number {
  const first = Math.max(0, Math.floor(Math.min(from, to) * perSecond));
  const last = Math.min(peaks.length - 1, Math.ceil(Math.max(from, to) * perSecond) - 1);
  let peak = 0;
  for (let bucket = first; bucket <= Math.max(first, last) && bucket < peaks.length; bucket += 1) {
    peak = Math.max(peak, peaks[bucket] ?? 0);
  }
  return peak;
}

/** Whether a span's sound reaches the mix as the render plays it. */
function spanIsHeard(span: ClipSpan, track: Track | undefined, asset: Asset | undefined): boolean {
  if (span.audible === false || spanIsFrozen(span)) return false;
  // The compiler skips a picture clip on a hidden track before it opens its sound
  // (`render/compiler.py#compile_timeline`), so hiding a video track silences it too.
  return !(track?.hidden === true && asset?.kind === 'video');
}

/**
 * Which frames of `window` carry sound at or above `floorDbfs` (peak), from waveform peaks.
 *
 * A frame is audible when any heard clip playing there has a waveform bucket in that frame's
 * source interval loud enough after its fader. Clips without peaks are skipped. If none in the
 * window had any, `measured` is `false` and the caller must not read the silence as evidence.
 *
 * @param project - The project as reviewed.
 * @param window - The frames to measure, `[startFrame, endFrame)`.
 * @param fps - The sequence rate the frames are counted at.
 * @param floorDbfs - The peak level a frame must reach to count as audible.
 * @returns One flag per frame of the window, plus whether anything was measured.
 */
export function audibleFrames(
  project: Project,
  window: FrameWindow,
  fps: number,
  floorDbfs: number,
): AudibleFrames {
  const length = Math.max(0, window.endFrame - window.startFrame);
  const audible = new Array<boolean>(length).fill(false);
  const floor = dbToAmplitude(floorDbfs);
  const windowStart = window.startFrame / fps;
  const windowEnd = window.endFrame / fps;
  const tracks = new Map(project.timeline.tracks.map((track) => [track.id, track]));
  const clips = new Map(
    project.timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
  );
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  let measured = false;
  for (const span of buildTimelineMap(project.timeline).spans) {
    if (span.end <= windowStart || span.start >= windowEnd) continue;
    const asset = assets.get(span.assetId);
    const clip = clips.get(span.clipId);
    if (clip === undefined) continue;
    if (!spanIsHeard(span, tracks.get(span.trackId), asset)) {
      // Known to add nothing to the mix: that is evidence of silence, not a want of it.
      measured = true;
      continue;
    }
    const peaks = asset?.media?.peaks;
    const perSecond = asset?.media?.peaksPerSecond;
    if (!peaks || peaks.length === 0 || !perSecond) continue;
    measured = true;
    const settings = gainSettings(clip);
    const duration = span.end - span.start;
    const firstFrame = Math.max(window.startFrame, Math.floor(span.start * fps));
    const lastFrame = Math.min(window.endFrame, Math.ceil(span.end * fps));
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      if (audible[frame - window.startFrame]) continue;
      const from = Math.max(frame / fps, span.start);
      const to = Math.min((frame + 1) / fps, span.end);
      if (to <= from) continue;
      const peak = peakOver(
        peaks,
        perSecond,
        spanSequenceToSource(span, from),
        spanSequenceToSource(span, to),
      );
      const level = peak * faderAmplitude(settings, from - span.start, to - span.start, duration);
      if (level >= floor) audible[frame - window.startFrame] = true;
    }
  }
  return { audible, measured };
}
