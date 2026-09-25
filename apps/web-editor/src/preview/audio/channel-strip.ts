/**
 * A clip's channel strip — peak normalize, EQ, compressor — as the export runs it.
 *
 * The export builds the strip as an ffmpeg filtergraph (`audio/filters.py#build_clip_filter`):
 * `volume` for the normalize gain `volumedetect` measured, one biquad per EQ band
 * (`equalizer`, `lowshelf`, `highshelf`, `highpass`, `lowpass` with `width_type=q`), then
 * `acompressor`. This file ports the parts of those filters the graph uses — the biquad
 * designs of `af_biquads.c` in direct form I, and the feed-forward gain computer of
 * `af_sidechaincompress.c` with its default knee, RMS detection and averaged link — so the
 * monitor runs the same DSP. `tests/fixtures/audio-mix/strips.json` is ffmpeg's output for a
 * set of strips over a fixed signal (`pnpm audio-mix:vectors`), and `channel-strip.test.ts`
 * holds this file to it.
 *
 * Pure and allocation-free per block: the AudioWorklet (`channel-strip.worklet.ts`) runs it on
 * the audio thread, and the tests run it directly.
 */

/** One EQ band as `mix_clip_audio` authors it (`AudioEqBand`). */
export interface StripBand {
  readonly kind: string;
  readonly frequencyHz: number;
  readonly q?: number;
  readonly gainDb?: number;
}

/** Compressor settings as `mix_clip_audio` authors them (`AudioDynamicsSettings`). */
export interface StripDynamics {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly makeupGainDb?: number;
}

/** A clip's strip, in the export's terms. */
export interface StripSettings {
  /** Peak-normalize to -1 dBFS before the EQ (`params.normalize`). */
  readonly normalize: boolean;
  readonly bands: readonly StripBand[];
  readonly dynamics: StripDynamics | null;
}

/** The strip once its normalize gain is measured: what the worklet runs. */
export interface StripProgram {
  /** `volume=…dB` ahead of the filters, or 0 for none. */
  readonly normalizeGainDb: number;
  readonly bands: readonly StripBand[];
  readonly dynamics: StripDynamics | null;
}

/** The worklet processor's registered name (`channel-strip.worklet.ts`). */
export const CHANNEL_STRIP_PROCESSOR = 'framepilot-channel-strip';

/** What each worklet node is constructed with. */
export interface ChannelStripOptions {
  readonly program: StripProgram;
  readonly channels: number;
}

/** The engine's default Q (`build_clip_filter`: `q or 0.707`). */
const DEFAULT_Q = 0.707;

/** `peak_normalize_gain_db`'s target, in dBFS. */
const NORMALIZE_TARGET_DBFS = -1;

/** `acompressor`'s knee, detection and link defaults, which the export does not override. */
const COMPRESSOR_KNEE = 2.82843;

/**
 * The strip `clip`'s `audio_gain` params describe, or `null` when there is none — the export
 * then skips the filter pass entirely (`_apply_audio_effects`' `processors`).
 */
export function stripSettingsOf(params: Readonly<Record<string, unknown>>): StripSettings | null {
  const eq = params.eq;
  const rawBands =
    eq !== null && typeof eq === 'object' && Array.isArray((eq as { bands?: unknown }).bands)
      ? ((eq as { bands: unknown[] }).bands as unknown[])
      : [];
  const bands = rawBands.filter(
    (band): band is StripBand => band !== null && typeof band === 'object',
  );
  const dynamics =
    params.dynamics !== null && typeof params.dynamics === 'object'
      ? (params.dynamics as StripDynamics)
      : null;
  const normalize = Boolean(params.normalize);
  if (!normalize && bands.length === 0 && dynamics === null) return null;
  return { normalize, bands, dynamics };
}

// --- normalize ---------------------------------------------------------------------------------

/**
 * `peak_normalize_gain_db` over the samples the export measures.
 *
 * The export writes the clip through MoviePy's 16-bit writer (samples clamped to ±0.99 and
 * truncated to int16), and `volumedetect` reports the loudest of those as dB to one decimal.
 * The gain is -1 dBFS minus that figure; a silent clip gets none.
 *
 * @param channels - The clip's samples, per channel, as the export reads them.
 */
export function normalizeGainDb(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const clamped = Math.max(-0.99, Math.min(0.99, channel[i]!));
      const quantized = Math.abs(Math.trunc(32768 * clamped));
      if (quantized > peak) peak = quantized;
    }
  }
  if (peak === 0) return 0;
  const maxVolume = Number((20 * Math.log10(peak / 32768)).toFixed(1));
  return NORMALIZE_TARGET_DBFS - maxVolume;
}

// --- EQ ----------------------------------------------------------------------------------------

/** Normalized biquad coefficients: y = b0·x + b1·x1 + b2·x2 − a1·y1 − a2·y2. */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * `af_biquads.c`'s design for one band at `sampleRate`, or `null` where the export's graph has
 * no filter for it (an unknown kind, a non-positive frequency, or one ffmpeg bypasses).
 */
export function biquadFor(band: StripBand, sampleRate: number): Biquad | null {
  const frequency = Number(band.frequencyHz);
  if (!(frequency > 0)) return null;
  const q = Number(band.q) || DEFAULT_Q;
  const gain = Number(band.gainDb) || 0;
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  // ffmpeg passes a band above Nyquist, or with no width, straight through.
  if (w0 > Math.PI || q <= 0) return null;
  const A = 10 ** (gain / 40);
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const beta = 2 * Math.sqrt(A);
  let a0: number, a1: number, a2: number, b0: number, b1: number, b2: number;
  switch (band.kind) {
    case 'peaking':
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      break;
    case 'low-shelf':
      a0 = A + 1 + (A - 1) * cos + beta * alpha;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - beta * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + beta * alpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - beta * alpha);
      break;
    case 'high-shelf':
      a0 = A + 1 - (A - 1) * cos + beta * alpha;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - beta * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + beta * alpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - beta * alpha);
      break;
    case 'high-pass':
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      break;
    case 'low-pass':
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      break;
    default:
      return null;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// --- compressor --------------------------------------------------------------------------------

/** `hermite.h`'s cubic Hermite interpolation, which shapes `acompressor`'s soft knee. */
function hermite(
  x: number,
  x0: number,
  x1: number,
  p0: number,
  p1: number,
  m0: number,
  m1: number,
) {
  const width = x1 - x0;
  const t = (x - x0) / width;
  const t2 = t * t;
  const t3 = t2 * t;
  const scaledM0 = m0 * width;
  const scaledM1 = m1 * width;
  const ct2 = -3 * p0 - 2 * scaledM0 + 3 * p1 - scaledM1;
  const ct3 = 2 * p0 + scaledM0 - 2 * p1 + scaledM1;
  return ct3 * t3 + ct2 * t2 + scaledM0 * t + p0;
}

/** `acompressor`'s gain computer, precomputed for one setting at one sample rate. */
class Compressor {
  private slope = 0;
  private readonly thres: number;
  private readonly ratio: number;
  private readonly kneeStart: number;
  private readonly kneeStop: number;
  private readonly compressedKneeStop: number;
  private readonly detectAbove: number;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private readonly makeup: number;

  constructor(settings: StripDynamics, sampleRate: number) {
    const threshold = 10 ** (Number(settings.thresholdDb) / 20);
    this.ratio = Math.max(1, Number(settings.ratio));
    this.thres = Math.log(threshold);
    const linKneeStart = threshold / Math.sqrt(COMPRESSOR_KNEE);
    const linKneeStop = threshold * Math.sqrt(COMPRESSOR_KNEE);
    // RMS detection compares the squared level with the squared knee start.
    this.detectAbove = linKneeStart * linKneeStart;
    this.kneeStart = Math.log(linKneeStart);
    this.kneeStop = Math.log(linKneeStop);
    this.compressedKneeStop = (this.kneeStop - this.thres) / this.ratio + this.thres;
    this.attackCoeff = Math.min(1, 1 / ((Number(settings.attackMs) * sampleRate) / 4000));
    this.releaseCoeff = Math.min(1, 1 / ((Number(settings.releaseMs) * sampleRate) / 4000));
    this.makeup = 10 ** ((Number(settings.makeupGainDb) || 0) / 20);
  }

  /** The gain for the next frame, whose channels' mean absolute level is `level`. */
  next(level: number): number {
    const squared = level * level;
    this.slope +=
      (squared - this.slope) * (squared > this.slope ? this.attackCoeff : this.releaseCoeff);
    let gain = 1;
    if (this.slope > 0 && this.slope > this.detectAbove) {
      const slope = Math.log(this.slope) * 0.5;
      let out = (slope - this.thres) / this.ratio + this.thres;
      if (slope < this.kneeStop) {
        out = hermite(
          slope,
          this.kneeStart,
          this.kneeStop,
          this.kneeStart,
          this.compressedKneeStop,
          1,
          1 / this.ratio,
        );
      }
      gain = Math.exp(out - slope);
    }
    return gain * this.makeup;
  }
}

// --- the strip ---------------------------------------------------------------------------------

/**
 * A running channel strip: stateful across blocks, as the export's filtergraph is across its
 * file. One instance per clip playback.
 */
export class ChannelStrip {
  private readonly level: number;
  private readonly biquads: readonly Biquad[];
  /** Per band, per channel: x1, x2, y1, y2. */
  private readonly history: Float64Array;
  private readonly compressor: Compressor | null;

  constructor(
    program: StripProgram,
    sampleRate: number,
    private readonly channelCount: number,
  ) {
    this.level = 10 ** (program.normalizeGainDb / 20);
    this.biquads = program.bands
      .map((band) => biquadFor(band, sampleRate))
      .filter((biquad): biquad is Biquad => biquad !== null);
    this.history = new Float64Array(this.biquads.length * channelCount * 4);
    this.compressor = program.dynamics ? new Compressor(program.dynamics, sampleRate) : null;
  }

  /**
   * Run `frames` samples of every channel from `input` into `output` (which may be the same
   * arrays). Missing input channels read as silence.
   */
  process(
    input: readonly (Float32Array | undefined)[],
    output: readonly Float32Array[],
    frames: number,
  ): void {
    const channels = Math.min(this.channelCount, output.length);
    for (let c = 0; c < channels; c += 1) {
      const source = input[c];
      const target = output[c]!;
      for (let n = 0; n < frames; n += 1) {
        let sample = (source?.[n] ?? 0) * this.level;
        for (let b = 0; b < this.biquads.length; b += 1) {
          const { b0, b1, b2, a1, a2 } = this.biquads[b]!;
          const at = (b * this.channelCount + c) * 4;
          const h = this.history;
          const y = b0 * sample + b1 * h[at]! + b2 * h[at + 1]! - a1 * h[at + 2]! - a2 * h[at + 3]!;
          h[at + 1] = h[at]!;
          h[at] = sample;
          h[at + 3] = h[at + 2]!;
          h[at + 2] = y;
          sample = y;
        }
        target[n] = sample;
      }
    }
    if (!this.compressor) return;
    for (let n = 0; n < frames; n += 1) {
      let level = 0;
      for (let c = 0; c < channels; c += 1) level += Math.abs(output[c]![n]!);
      const gain = this.compressor.next(level / channels);
      for (let c = 0; c < channels; c += 1) output[c]![n] = output[c]![n]! * gain;
    }
  }
}
