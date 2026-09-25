/**
 * The gain the export multiplies one clip's sound by, as a function of clip-local time.
 *
 * The TypeScript twin of the time-domain half of `compiler._apply_audio_effects`
 * (`engine/python/framepilot_engine/render/compiler.py`): the fader, or the `gainDb`
 * automation lane that supersedes it, times the fades (`fade_gain_at`) times the duck
 * (`duck_gain_at`); a muted clip is silent throughout. The channel strip that runs before it
 * (normalize, EQ, compression) is `channel-strip.ts`.
 *
 * Both preview paths read this: the layered engine schedules it as a Web Audio gain curve on
 * the clip's own source node, and the legacy mixer sets an element's volume from it. A monitor
 * that plays a different mix from the file is worse than one that plays none. A bed that is
 * ducked in the export but flat in the monitor reads as "the music drowns my voice", and the
 * fix a person (or the agent) then makes damages an edit that was already right.
 *
 * `tests/fixtures/audio-mix/envelopes.json` is the export's own output for a set of mixes,
 * written by `pnpm audio-mix:vectors`, and `mix-envelope.test.ts` holds this file to it.
 */
import { segmentProgress } from '@framepilot/editor-core';
import type { Clip, Keyframe, Track } from '@framepilot/timeline-schema';

/** The engine's lane resolution (`AUTOMATION_GRID_SECONDS`): a lane is sampled on this grid. */
export const AUTOMATION_GRID_SECONDS = 0.001;

/** The engine's duck attack and release (`duck_gain_at`'s `ramp`), in seconds. */
const DUCK_RAMP_SECONDS = 0.15;

/** The engine's default duck depth when a clip names a sidechain but no amount. */
const DEFAULT_DUCK_DB = -12;

/** The only property an audio automation lane animates today. */
const GAIN_LANE_PROPERTY = 'gainDb';

/** One clip's mix, evaluated at clip-local seconds. */
export interface ClipMix {
  /** The clip contributes no sound at all (its `audio_gain` is muted). */
  readonly muted: boolean;
  /** The gain changes across the clip: a fade, a duck or an automation lane. */
  readonly varies: boolean;
  /** The linear gain at clip-local `local` seconds. */
  gainAt(local: number): number;
}

/** Linear amplitude for a decibel gain, as the engine's `db_to_gain`. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Python's `float(params.get(key, fallback))` for a validated project value. */
function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `fade_gain_at` at one instant. An unknown curve name shapes nothing, as in the engine. */
function fadeGain(
  local: number,
  fadeIn: number,
  fadeOut: number,
  duration: number,
  curve: string,
): number {
  let gain = 1;
  if (fadeIn > 0) gain = Math.min(gain, clamp01(local / fadeIn));
  if (fadeOut > 0) gain = Math.min(gain, clamp01((duration - local) / fadeOut));
  if (curve === 'equal-power') return Math.sin(gain * (Math.PI / 2));
  if (curve === 'smooth') return gain * gain * (3 - 2 * gain);
  return gain;
}

/**
 * A duck's sidechain spans in clip-local seconds, sorted by start, with the latest end reached
 * by any span up to each index. A long bed under a busy dialogue track is sampled at a thousand
 * points a second, so the lookup must not visit every span for every point.
 */
interface DuckSpans {
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  readonly reach: Float64Array;
}

function duckSpans(spans: readonly (readonly [number, number])[]): DuckSpans {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const starts = new Float64Array(sorted.length);
  const ends = new Float64Array(sorted.length);
  const reach = new Float64Array(sorted.length);
  sorted.forEach(([start, end], index) => {
    starts[index] = start;
    ends[index] = end;
    reach[index] = index === 0 ? end : Math.max(reach[index - 1]!, end);
  });
  return { starts, ends, reach };
}

/**
 * `duck_gain_at` at one instant. The engine takes the minimum over every span; a span whose ramp
 * does not reach `local` contributes exactly 1, so skipping it leaves that minimum unchanged.
 */
function duckGain(local: number, duck: DuckSpans, reduced: number): number {
  let gain = 1;
  let index = firstAtOrAfter(duck.starts, local + DUCK_RAMP_SECONDS + Number.EPSILON) - 1;
  for (
    ;
    index >= 0 && duck.reach[index]! + DUCK_RAMP_SECONDS >= local - Number.EPSILON;
    index -= 1
  ) {
    const attack = clamp01((local - (duck.starts[index]! - DUCK_RAMP_SECONDS)) / DUCK_RAMP_SECONDS);
    const release = clamp01((duck.ends[index]! + DUCK_RAMP_SECONDS - local) / DUCK_RAMP_SECONDS);
    gain = Math.min(gain, 1 - clamp01(Math.min(attack, release)) * (1 - reduced));
  }
  return gain;
}

/** A lane sampled as `automation_envelope` samples it: linear gains on a uniform grid. */
interface SampledLane {
  readonly step: number;
  readonly times: Float64Array;
  readonly gains: Float64Array;
}

/**
 * `automation_envelope(keyframes, "gainDb", duration)`: the lane's dB value on the engine's 1 ms
 * grid, by keyframe segment, converted to linear gain. The segment loop matches
 * `_automation_values` exactly, including which segment owns a time two segments share.
 */
function sampleLane(keyframes: readonly Keyframe[], duration: number): SampledLane | null {
  if (duration <= 0) return null;
  const points = keyframes
    .filter((keyframe) => keyframe.property === GAIN_LANE_PROPERTY)
    .sort((a, b) => a.time - b.time);
  if (points.length === 0) return null;
  const count = Math.max(2, Math.ceil(duration / AUTOMATION_GRID_SECONDS) + 1);
  const step = duration / (count - 1);
  const times = new Float64Array(count);
  for (let i = 0; i < count; i += 1) times[i] = i * step;
  times[count - 1] = duration;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const values = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = times[i]!;
    if (t <= first.time) values[i] = first.value;
    if (t >= last.time) values[i] = last.value;
  }
  for (let k = 0; k < points.length - 1; k += 1) {
    const left = points[k]!;
    const right = points[k + 1]!;
    const span = right.time - left.time;
    for (let i = firstAtOrAfter(times, left.time); i < count && times[i]! <= right.time; i += 1) {
      if (span <= 0) {
        values[i] = right.value;
        continue;
      }
      const eased = segmentProgress(left, right, clamp01((times[i]! - left.time) / span));
      values[i] = left.value + (right.value - left.value) * eased;
    }
  }
  const gains = new Float64Array(count);
  for (let i = 0; i < count; i += 1) gains[i] = 10 ** (values[i]! / 20);
  return { step, times, gains };
}

/** The first index whose time is at or after `time` (the grid is sorted). */
function firstAtOrAfter(times: Float64Array, time: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid]! < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** `np.interp(local, lane.times, lane.gains)`, including its clamping and exact-knot rule. */
function laneGain(lane: SampledLane, local: number): number {
  const { times, gains } = lane;
  const lastIndex = times.length - 1;
  if (local <= times[0]!) return gains[0]!;
  if (local >= times[lastIndex]!) return gains[lastIndex]!;
  let j = Math.min(lastIndex - 1, Math.floor(local / lane.step));
  while (j > 0 && times[j]! > local) j -= 1;
  while (j < lastIndex - 1 && times[j + 1]! <= local) j += 1;
  if (local === times[j]) return gains[j]!;
  const slope = (gains[j + 1]! - gains[j]!) / (times[j + 1]! - times[j]!);
  return slope * (local - times[j]!) + gains[j]!;
}

const SILENT: ClipMix = { muted: true, varies: false, gainAt: () => 0 };

/**
 * The export's mix for `clip`: what `_apply_audio_effects` multiplies its sound by.
 *
 * @param clip - A clip that carries sound (footage or an audio clip).
 * @param tracks - The timeline's tracks; the duck's sidechain is looked up among them.
 * @returns The clip's mix, evaluated at clip-local seconds.
 */
export function clipMix(clip: Clip, tracks: readonly Track[]): ClipMix {
  const effect = clip.effects.find((candidate) => candidate.type === 'audio_gain');
  const params = (effect?.params ?? {}) as Record<string, unknown>;
  if (params.muted) return SILENT;
  const duration = clip.end - clip.start;
  const level = effect === undefined ? 1 : dbToGain(numberParam(params, 'gainDb', 0));
  const lane = effect === undefined ? null : sampleLane(effect.keyframes ?? [], duration);
  const fadeIn = numberParam(params, 'fadeInSeconds', 0);
  const fadeOut = numberParam(params, 'fadeOutSeconds', 0);
  const curve = typeof params.fadeCurve === 'string' && params.fadeCurve ? params.fadeCurve : '';
  const sidechainId = params.duckUnderTrackId;
  const sidechain =
    typeof sidechainId === 'string' && sidechainId
      ? tracks.find((track) => track.id === sidechainId)
      : undefined;
  const duck = duckSpans(
    (sidechain?.clips ?? []).map(
      (other) => [other.start - clip.start, other.end - clip.start] as const,
    ),
  );
  const reduced = dbToGain(numberParam(params, 'duckAmountDb', DEFAULT_DUCK_DB));
  const varies = fadeIn > 0 || fadeOut > 0 || duck.starts.length > 0 || lane !== null;
  return {
    muted: false,
    varies,
    gainAt(local: number): number {
      if (!varies) return level;
      const base = lane === null ? level : laneGain(lane, local);
      return (
        base * fadeGain(local, fadeIn, fadeOut, duration, curve) * duckGain(local, duck, reduced)
      );
    },
  };
}

/**
 * The mix sampled every `stepSec` from clip-local `fromLocal` to the clip's end, for a Web Audio
 * value curve (which interpolates linearly between its points, as the engine's lane does
 * between its grid points).
 *
 * @returns At least two points; the last lands on the clip's end.
 */
export function sampleClipMix(
  mix: ClipMix,
  fromLocal: number,
  toLocal: number,
  stepSec: number,
): Float32Array {
  const span = Math.max(0, toLocal - fromLocal);
  const count = Math.max(2, Math.ceil(span / stepSec) + 1);
  const curve = new Float32Array(count);
  const spacing = span / (count - 1);
  for (let i = 0; i < count; i += 1) curve[i] = mix.gainAt(fromLocal + i * spacing);
  return curve;
}
