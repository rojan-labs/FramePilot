/**
 * The preview's channel strip against ffmpeg running the export's own filtergraph
 * (`tests/fixtures/audio-mix/strips.json`, written by `pnpm audio-mix:vectors`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChannelStrip,
  biquadFor,
  normalizeGainDb,
  stripSettingsOf,
  type StripBand,
  type StripProgram,
} from './channel-strip.js';

interface StripCase {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly normalizeGainDb: number | null;
  readonly frames: readonly number[];
  readonly left: readonly number[];
  readonly right: readonly number[];
}

interface StripDocument {
  readonly sampleRate: number;
  readonly frames: number;
  readonly cases: readonly StripCase[];
  readonly impulses: readonly {
    readonly band: StripBand;
    readonly filter: string;
    readonly response: readonly number[];
  }[];
}

const REPO = path.resolve(__dirname, '../../../../..');
const DOC = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'audio-mix', 'strips.json'), 'utf8'),
) as StripDocument;

/** Web Audio's render quantum: the worklet sees the signal in blocks this long. */
const RENDER_QUANTUM = 128;

/**
 * The export's filtergraph reads a float WAV, so ffmpeg runs its biquads in float32; this port
 * runs them in float64. A low shelf at 120 Hz has its poles so close to 1 that ffmpeg's own
 * rounding moves its output by about 3e-5, while the design itself agrees to 1e-9 (the impulse
 * test below). 1e-4 is -80 dBFS: inaudible, and two orders of magnitude below what a design
 * mistake does to these signals (a wrong Q, gain or knee moves them by 1e-2 or more).
 */
const TOLERANCE = 1e-4;

/** Double precision on both sides: the filter designs are the same numbers. */
const DESIGN_TOLERANCE = 1e-9;

/** `audio_strip_vectors.test_signal()`, sample for sample. */
function testSignal(frames: number, sampleRate: number): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let state = 12345;
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const level = t < 0.2 ? 0.25 : t < 0.45 ? 0.55 : t < 0.7 ? 0.05 : t < 0.8 ? 0 : 0.4;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = (state / 4294967296) * 2 - 1;
    left[i] =
      level * (0.7 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 3100 * t));
    right[i] = level * (0.6 * Math.sin(2 * Math.PI * 90 * t) + 0.4 * noise);
  }
  return [left, right];
}

/** MoviePy's 16-bit writer, read back as float: what the export's filters are given. */
function asWritten(channel: Float32Array): Float32Array {
  return channel.map((x) => Math.trunc(32768 * Math.max(-0.99, Math.min(0.99, x))) / 32768);
}

function run(program: StripProgram, input: readonly Float32Array[]): Float32Array[] {
  const strip = new ChannelStrip(program, DOC.sampleRate, input.length);
  const output = input.map((channel) => new Float32Array(channel.length));
  for (let start = 0; start < DOC.frames; start += RENDER_QUANTUM) {
    const end = Math.min(DOC.frames, start + RENDER_QUANTUM);
    strip.process(
      input.map((channel) => channel.subarray(start, end)),
      output.map((channel) => channel.subarray(start, end)),
      end - start,
    );
  }
  return output;
}

const signal = testSignal(DOC.frames, DOC.sampleRate);
const written = signal.map(asWritten);

describe('the channel strip matches ffmpeg running the export’s filtergraph', () => {
  it.each(DOC.cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_n, testCase) => {
    const settings = stripSettingsOf(testCase.params);
    expect(settings).not.toBeNull();
    const measured = settings!.normalize ? normalizeGainDb(signal) : 0;
    expect(measured).toBeCloseTo(testCase.normalizeGainDb ?? 0, 9);
    const [left, right] = run(
      { normalizeGainDb: measured, bands: settings!.bands, dynamics: settings!.dynamics },
      written,
    );
    let worst = 0;
    testCase.frames.forEach((frame, index) => {
      worst = Math.max(
        worst,
        Math.abs(left![frame]! - testCase.left[index]!),
        Math.abs(right![frame]! - testCase.right[index]!),
      );
    });
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('is not vacuous: every strip really changes the signal', () => {
    for (const testCase of DOC.cases) {
      const moved = testCase.frames.some(
        (frame, index) => Math.abs(testCase.left[index]! - written[0]![frame]!) > 1e-3,
      );
      expect(moved, testCase.name).toBe(true);
    }
  });
});

describe('every EQ band is ffmpeg’s design', () => {
  it.each(DOC.impulses.map((entry) => [entry.filter, entry] as const))('%s', (_filter, entry) => {
    const biquad = biquadFor(entry.band, DOC.sampleRate)!;
    const { b0, b1, b2, a1, a2 } = biquad;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let worst = 0;
    entry.response.forEach((expected, n) => {
      const x = n === 0 ? 1 : 0;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      worst = Math.max(worst, Math.abs(y - expected));
    });
    expect(worst).toBeLessThanOrEqual(DESIGN_TOLERANCE);
  });
});

describe('stripSettingsOf', () => {
  it('reads no strip from a plain fader, as the export skips the filter pass', () => {
    expect(stripSettingsOf({ gainDb: -3, fadeInSeconds: 1 })).toBeNull();
    expect(stripSettingsOf({ eq: { bands: [] } })).toBeNull();
  });
});

describe('biquadFor', () => {
  it('passes what ffmpeg passes: unknown kinds, no frequency, above Nyquist', () => {
    expect(biquadFor({ kind: 'notch', frequencyHz: 1000 }, 48000)).toBeNull();
    expect(biquadFor({ kind: 'peaking', frequencyHz: 0, gainDb: 3 }, 48000)).toBeNull();
    expect(biquadFor({ kind: 'peaking', frequencyHz: 30000, gainDb: 3 }, 48000)).toBeNull();
  });
});

describe('normalizeGainDb', () => {
  it('reads a silent clip as needing no gain', () => {
    expect(normalizeGainDb([new Float32Array(64)])).toBe(0);
  });
});
