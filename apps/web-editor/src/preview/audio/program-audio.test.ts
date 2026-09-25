/**
 * The layered monitor's sound plan: what it schedules for each clip, against the export's rules.
 * jsdom has no Web Audio, so buffers and the context are small stand-ins.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { ProgramAudio, type ProgramAudioInput } from './program-audio.js';
import type { SoundKind } from './clip-audio.js';

const RATE = 1000;

class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    fill: (index: number) => number = () => 0,
  ) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () =>
      Float32Array.from({ length }, (_, index) => fill(index)),
    );
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel]!;
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel]!.set(source);
  }
}

const fakeContext = {
  createBuffer: (channels: number, length: number, rate: number) =>
    new FakeBuffer(channels, length, rate),
  decodeAudioData: vi.fn(async () => new FakeBuffer(2, 10 * RATE, RATE, () => 0.5)),
} as unknown as BaseAudioContext;

const asBuffer = (buffer: FakeBuffer): AudioBuffer => buffer as unknown as AudioBuffer;

function clip(id: string, assetId: string, fields: Partial<Clip> = {}): Clip {
  return {
    id,
    assetId,
    trackId: 't',
    start: 0,
    end: 4,
    sourceStart: 1,
    sourceEnd: 5,
    effects: [],
    keyframes: [],
    ...fields,
  } as Clip;
}

const gain = (params: Record<string, unknown>): Clip['effects'] => [
  { id: 'mix', type: 'audio_gain', params, keyframes: [] },
];

const KINDS: Record<string, SoundKind> = { cam: 'video', song: 'audio' };
const footage = asBuffer(new FakeBuffer(2, 10 * RATE, RATE, (index) => index / (10 * RATE)));

function input(timeline: Timeline, muted: string[] = []): ProgramAudioInput {
  return {
    timeline,
    kindOf: (candidate) => KINDS[candidate.assetId] ?? 'other',
    mutedTrackIds: new Set(muted),
    footage: (assetId) => (assetId === 'cam' ? { buffer: footage, frameRate: 25 } : undefined),
  };
}

const timelineOf = (...tracks: Timeline['tracks']): Timeline => ({ tracks }) as Timeline;

describe('ProgramAudio.segmentsFrom', () => {
  it('plays footage at the clip’s fader and not at all when the clip is muted', () => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf({
      id: 'v',
      type: 'video',
      clips: [
        clip('loud', 'cam', { effects: gain({ gainDb: -6 }) }),
        clip('off', 'cam', { start: 4, end: 8, effects: gain({ muted: true }) }),
      ],
    } as Timeline['tracks'][number]);
    const segments = audio.segmentsFrom(input(timeline), 0);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ offsetSec: 1, durationSec: 4, mediaStartUs: 0 });
    expect(segments[0]!.gain).toBeCloseTo(10 ** (-6 / 20), 12);
  });

  it('gives a fading clip a gain curve that starts where playback does', () => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf({
      id: 'v',
      type: 'video',
      clips: [clip('faded', 'cam', { effects: gain({ fadeInSeconds: 2 }) })],
    } as Timeline['tracks'][number]);
    const [segment] = audio.segmentsFrom(input(timeline), 1);
    expect(segment).toMatchObject({ mediaStartUs: 1_000_000, offsetSec: 2, durationSec: 3 });
    const curve = (segment!.gain as { curve: Float32Array }).curve;
    expect(curve[0]).toBeCloseTo(0.5, 6);
    expect(curve[curve.length - 1]).toBe(1);
  });

  it('follows the export’s track rules, with solo folded into the muted set', () => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf(
      ...([
        { id: 'hidden', type: 'video', hidden: true, clips: [clip('a', 'cam')] },
        { id: 'soloed-out', type: 'video', clips: [clip('b', 'cam')] },
        { id: 'kept', type: 'video', clips: [clip('c', 'cam')] },
      ] as unknown as Timeline['tracks']),
    );
    const segments = audio.segmentsFrom(input(timeline, ['soloed-out']), 0);
    expect(segments).toHaveLength(1);
  });

  it('resamples a reversed clip into its own buffer, read backwards from one frame early', () => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf({
      id: 'v',
      type: 'video',
      clips: [clip('back', 'cam', { speed: -1 })],
    } as Timeline['tracks'][number]);
    const [segment] = audio.segmentsFrom(input(timeline), 0);
    expect(segment!.buffer).not.toBe(footage);
    expect(segment!.playbackRate).toBeUndefined();
    const first = segment!.buffer.getChannelData(0)[0]!;
    // Source second 5 − 1/25 is sample 4960 of a ramp that rises 1/10 000 per sample.
    expect(first).toBeCloseTo(4960 / (10 * RATE), 5);
    // The same clip played again reuses the resampled buffer.
    expect(audio.segmentsFrom(input(timeline), 0)[0]!.buffer).toBe(segment!.buffer);
  });

  it('drops a freeze’s sound and plays a sped-up clip at its rate', () => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf({
      id: 'v',
      type: 'video',
      clips: [
        clip('frozen', 'cam', { speed: 0 }),
        clip('fast', 'cam', { start: 4, end: 6, speed: 2 }),
      ],
    } as Timeline['tracks'][number]);
    const segments = audio.segmentsFrom(input(timeline), 0);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ playbackRate: 2, offsetSec: 1, durationSec: 4 });
  });
});

describe('ProgramAudio hears a source as the export reads it', () => {
  const heardThrough = (source: FakeBuffer) => {
    const audio = new ProgramAudio(() => fakeContext);
    const timeline = timelineOf({
      id: 'v',
      type: 'video',
      clips: [clip('shot', 'cam')],
    } as Timeline['tracks'][number]);
    return audio.segmentsFrom(
      { ...input(timeline), footage: () => ({ buffer: asBuffer(source), frameRate: 25 }) },
      0,
    )[0]!;
  };

  it('reads a mono source at -3 dB, as ffmpeg splits it into two channels', () => {
    const segment = heardThrough(new FakeBuffer(1, 10 * RATE, RATE, () => 0.5));
    expect(segment.buffer.numberOfChannels).toBe(1);
    expect(segment.gain).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('folds 5.1 to stereo with ffmpeg’s normalized matrix, dropping the LFE', () => {
    // Channel c carries c + 1: FL 1, FR 2, FC 3, LFE 4, BL 5, BR 6.
    const source = new FakeBuffer(6, 10 * RATE, RATE);
    for (let c = 0; c < 6; c += 1) source.getChannelData(c).fill(c + 1);
    const segment = heardThrough(source);
    const scale = 1 + 2 * Math.SQRT1_2;
    expect(segment.buffer.numberOfChannels).toBe(2);
    expect(segment.gain).toBe(1);
    expect(segment.buffer.getChannelData(0)[0]).toBeCloseTo(
      (1 + Math.SQRT1_2 * (3 + 5)) / scale,
      5,
    );
    expect(segment.buffer.getChannelData(1)[0]).toBeCloseTo(
      (2 + Math.SQRT1_2 * (3 + 6)) / scale,
      5,
    );
  });
});

describe('ProgramAudio.retain', () => {
  const assets = [
    { id: 'song', kind: 'audio', path: 'song.wav' },
    { id: 'cam', kind: 'video', path: 'cam.mp4' },
  ] as unknown as Asset[];
  const urls = new Map([
    ['song', 'fp-media://song.wav'],
    ['cam', 'fp-media://cam.mp4'],
  ]);
  const fetchBytes = vi.fn(async () => new ArrayBuffer(8));

  it('decodes placed audio files and plays them, on a hidden track too', async () => {
    const audio = new ProgramAudio(
      () => fakeContext,
      fetchBytes,
      vi.fn(async () => undefined),
    );
    const timeline = timelineOf({
      id: 'music',
      type: 'audio',
      hidden: true,
      clips: [clip('bed', 'song')],
    } as Timeline['tracks'][number]);
    await audio.retain(timeline, assets, urls);
    expect(fetchBytes).toHaveBeenCalledWith('fp-media://song.wav');
    const [segment] = audio.segmentsFrom(input(timeline), 0);
    expect(segment?.buffer.duration).toBe(10);
  });

  it('builds a strip node for a clip with EQ once the worklet is loaded', async () => {
    const loadStrip = vi.fn(async () => undefined);
    const audio = new ProgramAudio(() => fakeContext, fetchBytes, loadStrip);
    const timeline = timelineOf({
      id: 'music',
      type: 'audio',
      clips: [
        clip('bed', 'song', {
          effects: gain({
            normalize: true,
            eq: { bands: [{ kind: 'peaking', frequencyHz: 100, gainDb: 3 }] },
          }),
        }),
      ],
    } as Timeline['tracks'][number]);
    await audio.retain(timeline, assets, urls);
    expect(loadStrip).toHaveBeenCalledOnce();
    const [segment] = audio.segmentsFrom(input(timeline), 0);
    expect(typeof segment?.strip).toBe('function');
  });

  it('plays a strip it cannot run unprocessed rather than not at all', async () => {
    const audio = new ProgramAudio(
      () => fakeContext,
      fetchBytes,
      vi.fn(async () => Promise.reject(new Error('no audioWorklet'))),
    );
    const timeline = timelineOf({
      id: 'music',
      type: 'audio',
      clips: [clip('bed', 'song', { effects: gain({ normalize: true }) })],
    } as Timeline['tracks'][number]);
    await audio.retain(timeline, assets, urls);
    const [segment] = audio.segmentsFrom(input(timeline), 0);
    expect(segment).toBeDefined();
    expect(segment?.strip).toBeUndefined();
  });
});
