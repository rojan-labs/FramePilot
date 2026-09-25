/**
 * The monitor's channel strip, running as the shipped AudioWorklet in real Chromium, against
 * ffmpeg running the export's own filtergraph (`tests/fixtures/audio-mix/strips.json`, written
 * by `pnpm audio-mix:vectors`).
 *
 * `channel-strip.test.ts` already holds the DSP to those numbers in Node; this proves the part
 * Node cannot run: the worklet module loads through the app's own loader, receives its program
 * through `processorOptions`, maps channels, and processes a scheduled source to the end. An
 * `OfflineAudioContext` at the vectors' 44.1 kHz renders it faster than real time, and
 * deterministically.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRIPS = join(HERE, '..', '..', 'fixtures', 'audio-mix', 'strips.json');

interface StripVectors {
  readonly sampleRate: number;
  readonly frames: number;
  readonly cases: readonly {
    readonly name: string;
    readonly params: Record<string, unknown>;
    readonly normalizeGainDb: number | null;
    readonly frames: readonly number[];
    readonly left: readonly number[];
    readonly right: readonly number[];
  }[];
}

/** As `channel-strip.test.ts`: ffmpeg's float32 biquads against this float64 port. */
const TOLERANCE = 1e-4;

const vectors = JSON.parse(readFileSync(STRIPS, 'utf8')) as StripVectors;

test.describe('channel strip: monitor worklet vs export filtergraph', () => {
  test('every strip renders as ffmpeg renders it', async ({ page }) => {
    // Any document on the dev server's origin: a secure context whose module graph resolves.
    await page.goto('/src/preview/audio/channel-strip.ts');
    const results = await page.evaluate(async (doc: StripVectors) => {
      const load = new Function('path', 'return import(path)') as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const strip = await load('/src/preview/audio/channel-strip.ts');
      const loader = await load('/src/preview/audio/channel-strip-module.ts');
      const stripSettingsOf = strip.stripSettingsOf as (p: unknown) => {
        normalize: boolean;
        bands: unknown[];
        dynamics: unknown;
      } | null;
      const normalizeGainDb = strip.normalizeGainDb as (channels: Float32Array[]) => number;
      const processor = strip.CHANNEL_STRIP_PROCESSOR as string;
      const loadModule = loader.loadChannelStripModule as (ctx: BaseAudioContext) => Promise<void>;

      // `audio_strip_vectors.test_signal()`, then MoviePy's 16-bit writer.
      const signal = [new Float32Array(doc.frames), new Float32Array(doc.frames)];
      let state = 12345;
      for (let i = 0; i < doc.frames; i += 1) {
        const t = i / doc.sampleRate;
        const level = t < 0.2 ? 0.25 : t < 0.45 ? 0.55 : t < 0.7 ? 0.05 : t < 0.8 ? 0 : 0.4;
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const noise = (state / 4294967296) * 2 - 1;
        signal[0]![i] =
          level * (0.7 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 3100 * t));
        signal[1]![i] = level * (0.6 * Math.sin(2 * Math.PI * 90 * t) + 0.4 * noise);
      }
      const written = signal.map((channel) =>
        channel.map((x) => Math.trunc(32768 * Math.max(-0.99, Math.min(0.99, x))) / 32768),
      );

      const out: { name: string; worst: number; moved: number; error?: string }[] = [];
      for (const testCase of doc.cases) {
        try {
          const ctx = new OfflineAudioContext({
            numberOfChannels: 2,
            length: doc.frames,
            sampleRate: doc.sampleRate,
          });
          await loadModule(ctx);
          const settings = stripSettingsOf(testCase.params)!;
          const program = {
            normalizeGainDb: settings.normalize ? normalizeGainDb(signal) : 0,
            bands: settings.bands,
            dynamics: settings.dynamics,
          };
          const buffer = ctx.createBuffer(2, doc.frames, doc.sampleRate);
          buffer.copyToChannel(written[0]!, 0);
          buffer.copyToChannel(written[1]!, 1);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const node = new AudioWorkletNode(ctx, processor, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 2,
            channelCountMode: 'explicit',
            outputChannelCount: [2],
            processorOptions: { program, channels: 2 },
          });
          source.connect(node).connect(ctx.destination);
          source.start(0);
          const rendered = await ctx.startRendering();
          const left = rendered.getChannelData(0);
          const right = rendered.getChannelData(1);
          let worst = 0;
          let moved = 0;
          testCase.frames.forEach((frame, index) => {
            worst = Math.max(
              worst,
              Math.abs(left[frame]! - testCase.left[index]!),
              Math.abs(right[frame]! - testCase.right[index]!),
            );
            moved = Math.max(moved, Math.abs(left[frame]! - written[0]![frame]!));
          });
          out.push({ name: testCase.name, worst, moved });
        } catch (err) {
          out.push({ name: testCase.name, worst: Infinity, moved: 0, error: String(err) });
        }
      }
      return out;
    }, vectors);

    for (const result of results) {
      expect(result.error, result.name).toBeUndefined();
      expect(result.worst, result.name).toBeLessThanOrEqual(TOLERANCE);
      // Negative control: the worklet did process (a pass-through would fail the gate above
      // for every strip, but say so plainly).
      expect(result.moved, result.name).toBeGreaterThan(1e-3);
    }
    expect(results.map((result) => result.name)).toEqual(vectors.cases.map((c) => c.name));
  });

  test('the audio clock plays each clip’s mix at its place on the timeline', async ({ page }) => {
    await page.goto('/src/preview/audio/channel-strip.ts');
    const worst = await page.evaluate(async () => {
      const load = new Function('path', 'return import(path)') as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { ProgramAudio } = (await load('/src/preview/audio/program-audio.ts')) as {
        ProgramAudio: new (ctx: () => BaseAudioContext) => {
          segmentsFrom(input: unknown, startSec: number): unknown[];
        };
      };
      const { AudioMasterClock } = (await load('/src/preview/clock/audio-clock.ts')) as {
        AudioMasterClock: new (ctx: BaseAudioContext) => {
          scheduleSegments(segments: unknown[], mediaStartUs: number, leadSec: number): void;
        };
      };
      const { clipMix } = (await load('/src/preview/audio/mix-envelope.ts')) as {
        clipMix: (clip: unknown, tracks: unknown) => { gainAt(local: number): number };
      };
      const rate = 8000;
      const seconds = 4;
      const ctx = new OfflineAudioContext({
        numberOfChannels: 1,
        length: rate * seconds,
        sampleRate: rate,
      });
      const level = 0.5;
      const source = ctx.createBuffer(1, rate * seconds, rate);
      source.getChannelData(0).fill(level);
      const shot = {
        id: 'shot',
        assetId: 'cam',
        trackId: 'v',
        start: 0.5,
        end: 3.5,
        sourceStart: 0,
        sourceEnd: 3,
        keyframes: [],
        effects: [
          {
            id: 'mix',
            type: 'audio_gain',
            keyframes: [],
            params: {
              gainDb: -3,
              fadeInSeconds: 0.5,
              fadeOutSeconds: 1,
              fadeCurve: 'equal-power',
              duckUnderTrackId: 'vo',
              duckAmountDb: -12,
            },
          },
        ],
      };
      const line = {
        ...shot,
        id: 'line',
        assetId: 'narration',
        trackId: 'vo',
        start: 1.5,
        end: 2,
        effects: [],
      };
      const timeline = {
        tracks: [
          { id: 'v', type: 'video', clips: [shot] },
          { id: 'vo', type: 'audio', clips: [line] },
        ],
      };
      const planned = new ProgramAudio(() => ctx).segmentsFrom(
        {
          timeline,
          kindOf: (clip: { assetId: string }) => (clip.assetId === 'cam' ? 'video' : 'audio'),
          mutedTrackIds: new Set(),
          footage: () => ({ buffer: source, frameRate: 30 }),
        },
        0,
      );
      new AudioMasterClock(ctx).scheduleSegments(planned, 0, 0);
      const rendered = (await ctx.startRendering()).getChannelData(0);
      const mix = clipMix(shot, timeline.tracks);
      let error = 0;
      for (let n = 0; n < rendered.length; n += 7) {
        const t = n / rate;
        // The source is mono, which the export reads as two channels at -3 dB each.
        const heard = level * Math.SQRT1_2;
        const expected = t >= shot.start && t < shot.end ? heard * mix.gainAt(t - shot.start) : 0;
        error = Math.max(error, Math.abs(rendered[n]! - expected));
      }
      return error;
    });
    // A 1 ms value curve against the exact envelope, in float32: 1e-3 is -60 dBFS of a
    // -6 dBFS signal. A curve placed one lead (50 ms) late misses by 0.1 on the fade.
    expect(worst).toBeLessThanOrEqual(1e-3);
  });
});
