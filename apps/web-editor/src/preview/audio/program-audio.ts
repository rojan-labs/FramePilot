/**
 * The layered monitor's sound: every clip the export mixes, played on the engine's own audio
 * clock with the export's mix.
 *
 * Before this the layered engine scheduled footage sound flat, at unity, whatever the clip said:
 * a muted clip still spoke, a faded clip did not fade, a ducked bed did not duck, a soloed track
 * did not silence the rest, and a reversed or ramped clip was silent. Audio clips played from a
 * separate set of `<audio>` elements on their own clocks, drifting against the picture by up to
 * half a second and ignoring speed. Now one planner ({@link soundingClips}, {@link sourceReadOf},
 * {@link clipMix}) decides what the export would play, and every clip is a scheduled buffer on
 * the same clock the picture follows.
 *
 * Render-vs-preview (AGENTS.md invariant 4): this is playback of the export's own gain and time
 * maps; the render is still the engine's.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import type { AudioSegment } from '../clock/audio-clock.js';
import { clipMix, sampleClipMix, AUTOMATION_GRID_SECONDS } from './mix-envelope.js';
import {
  exportStereoWeights,
  resampleAlong,
  soundingClips,
  sourceReadOf,
  type SoundKind,
  type SourceRead,
} from './clip-audio.js';
import {
  CHANNEL_STRIP_PROCESSOR,
  normalizeGainDb,
  stripSettingsOf,
  type ChannelStripOptions,
  type StripProgram,
} from './channel-strip.js';

const log = createLogger('preview:program-audio');

/** MoviePy's audio reader rate: an audio clip's time mirror lags one sample of it. */
const AUDIO_READER_FPS = 44_100;

/**
 * Budget for resampled (reversed or ramped) clip sound. A clip's resampled sound is as long as
 * the clip, so this bounds the cache, not what can play: the least recently used entry goes.
 */
const MAX_RESAMPLED_BYTES = 256 * 1024 * 1024;

/** The footage side of a clip's sound: its decoded track and its video frame rate. */
export interface FootageSound {
  readonly buffer: AudioBuffer;
  readonly frameRate: number;
}

/** What the planner needs from the engine at play time. */
export interface ProgramAudioInput {
  readonly timeline: Timeline;
  readonly kindOf: (clip: Clip) => SoundKind;
  /** Tracks that are silent: persisted mutes folded through the monitor's solo. */
  readonly mutedTrackIds: ReadonlySet<string>;
  readonly footage: (assetId: string) => FootageSound | undefined;
}

interface LoadedFile {
  readonly url: string;
  readonly buffer: AudioBuffer | undefined;
}

/** A source as the export hears it: at most two channels, read at `inputGain`. */
interface HeardSource {
  readonly buffer: AudioBuffer;
  readonly inputGain: number;
}

/** Adds the channel-strip worklet to a context (`channel-strip-module.ts`). */
export type StripModuleLoader = (ctx: BaseAudioContext) => Promise<void>;

const loadStripModule: StripModuleLoader = async (ctx) => {
  const { loadChannelStripModule } = await import('./channel-strip-module.js');
  await loadChannelStripModule(ctx);
};

/** The clip's `audio_gain` params, where the channel strip is authored. */
function gainParams(clip: Clip): Readonly<Record<string, unknown>> {
  const effect = clip.effects.find((candidate) => candidate.type === 'audio_gain');
  return (effect?.params ?? {}) as Readonly<Record<string, unknown>>;
}

export class ProgramAudio {
  private readonly files = new Map<string, LoadedFile>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly resampled = new Map<string, { assetId: string; buffer: AudioBuffer }>();
  private resampledBytes = 0;
  private readonly normalizeGains = new Map<string, number>();
  /** Each decoded source as the export hears it (see {@link heard}). */
  private readonly heardSources = new WeakMap<AudioBuffer, HeardSource>();
  /** A stable id per decoded source, so a relinked file never reuses another's derived audio. */
  private readonly sourceIds = new WeakMap<AudioBuffer, number>();
  private nextSourceId = 0;
  /** The context the strip worklet is running in; `null` once loading it has failed there. */
  private stripContext: BaseAudioContext | null | undefined;

  constructor(
    private readonly context: () => BaseAudioContext | undefined,
    private readonly fetchBytes: (url: string) => Promise<ArrayBuffer> = defaultFetchBytes,
    private readonly loadStrip: StripModuleLoader = loadStripModule,
  ) {}

  /**
   * Load the audio files `assets` the timeline places, and release the ones it no longer does.
   *
   * @param urls - Each asset's media URL, as the picture sources use.
   */
  async retain(timeline: Timeline, assets: readonly Asset[], urls: ReadonlyMap<string, string>) {
    const audioAssets = new Set(assets.filter((a) => a.kind === 'audio').map((a) => a.id));
    const wanted = new Map<string, string>();
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        const url = urls.get(clip.assetId);
        if (url && audioAssets.has(clip.assetId)) wanted.set(clip.assetId, url);
      }
    }
    for (const [assetId, file] of [...this.files]) {
      if (wanted.get(assetId) !== file.url) this.files.delete(assetId);
    }
    const placed = new Set(timeline.tracks.flatMap((track) => track.clips.map((c) => c.assetId)));
    for (const [key, entry] of [...this.resampled]) {
      if (placed.has(entry.assetId)) continue;
      this.resampled.delete(key);
      this.resampledBytes -= bytesOf(entry.buffer);
    }
    const needsStrip = timeline.tracks.some((track) =>
      track.clips.some((clip) => stripSettingsOf(gainParams(clip)) !== null),
    );
    await Promise.all([
      ...[...wanted].map(([assetId, url]) => this.load(assetId, url)),
      ...(needsStrip ? [this.ensureStrip()] : []),
    ]);
  }

  /**
   * The export's mix from `startSec` to the end, as buffer segments for the audio clock.
   *
   * @param input - The timeline and what the engine has decoded.
   * @param startSec - The timeline second playback starts at.
   */
  segmentsFrom(input: ProgramAudioInput, startSec: number): AudioSegment[] {
    const segments: AudioSegment[] = [];
    for (const { clip, kind } of soundingClips(input.timeline, input.kindOf, input.mutedTrackIds)) {
      const segStart = Math.max(clip.start, startSec);
      if (segStart >= clip.end) continue;
      const sound = this.soundOf(clip, kind, input);
      if (!sound) continue;
      const mix = clipMix(clip, input.timeline.tracks);
      if (mix.muted) continue;
      const read = sourceReadOf(clip, sound.buffer.duration, sound.mirrorFrameSeconds);
      if (read.kind === 'silent') continue;
      const buffer =
        read.kind === 'rate' ? sound.buffer : this.resampledSound(clip, sound, read.sourceAt);
      if (!buffer) continue;
      const strip = this.stripFor(clip, { buffer, inputGain: sound.inputGain }, read, sound.id);
      // The source's read level goes through the strip when there is one (its compressor and
      // normalize measure the level the export reads), and into the fader otherwise.
      const readGain = strip ? 1 : sound.inputGain;
      const local = segStart - clip.start;
      const timelineSeconds = clip.end - segStart;
      const gain = mix.varies
        ? {
            curve: scaled(
              sampleClipMix(mix, local, clip.end - clip.start, AUTOMATION_GRID_SECONDS),
              readGain,
            ),
          }
        : mix.gainAt(local) * readGain;
      const placed = { mediaStartUs: segStart * 1_000_000, gain, ...(strip ? { strip } : {}) };
      if (read.kind === 'rate') {
        segments.push({
          ...placed,
          buffer,
          offsetSec: clip.sourceStart + local * read.rate,
          durationSec: timelineSeconds * read.rate,
          ...(read.rate !== 1 ? { playbackRate: read.rate } : {}),
        });
        continue;
      }
      segments.push({ ...placed, buffer, offsetSec: local, durationSec: timelineSeconds });
    }
    return segments.sort((a, b) => a.mediaStartUs - b.mediaStartUs);
  }

  /** Drop every decoded file and resampled buffer. */
  dispose(): void {
    this.files.clear();
    this.resampled.clear();
    this.resampledBytes = 0;
    this.normalizeGains.clear();
  }

  /**
   * The node factory for `clip`'s channel strip, or none when it has no strip. A strip the
   * monitor cannot run (the worklet failed to load) plays unprocessed; the load failure says so.
   */
  private stripFor(
    clip: Clip,
    heard: HeardSource,
    read: SourceRead,
    sourceId: number,
  ): ((ctx: BaseAudioContext) => AudioNode) | undefined {
    const settings = stripSettingsOf(gainParams(clip));
    if (!settings || !this.stripContext) return undefined;
    const { buffer, inputGain } = heard;
    const program: StripProgram = {
      inputGain,
      normalizeGainDb: settings.normalize ? this.normalizeFor(clip, heard, read, sourceId) : 0,
      bands: settings.bands,
      dynamics: settings.dynamics,
    };
    const channels = buffer.numberOfChannels;
    const processorOptions: ChannelStripOptions = { program, channels };
    return (ctx) =>
      new AudioWorkletNode(ctx, CHANNEL_STRIP_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: channels,
        channelCountMode: 'explicit',
        outputChannelCount: [channels],
        processorOptions,
      });
  }

  /**
   * `peak_normalize_gain_db` over what the export measures: the clip's sound after its speed.
   * A forward clip is its source range; a resampled one is the buffer already built for it.
   */
  private normalizeFor(clip: Clip, heard: HeardSource, read: SourceRead, sourceId: number): number {
    const { buffer } = heard;
    const rate = buffer.sampleRate;
    const span = clip.end - clip.start;
    const from = read.kind === 'rate' ? Math.max(0, Math.round(clip.sourceStart * rate)) : 0;
    const to =
      read.kind === 'rate'
        ? Math.min(buffer.length, Math.round((clip.sourceStart + span * read.rate) * rate))
        : buffer.length;
    const key = JSON.stringify([
      sourceId,
      read.kind,
      from,
      to,
      clip.end - clip.start,
      clip.speed ?? 1,
      clip.speedRamp ?? null,
    ]);
    const cached = this.normalizeGains.get(key);
    if (cached !== undefined) return cached;
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel).subarray(from, Math.max(from, to)));
    }
    const gain = normalizeGainDb(channels, heard.inputGain);
    this.normalizeGains.set(key, gain);
    return gain;
  }

  private async ensureStrip(): Promise<void> {
    const ctx = this.context();
    if (!ctx || this.stripContext === ctx || this.stripContext === null) return;
    try {
      await this.loadStrip(ctx);
      this.stripContext = ctx;
    } catch (err) {
      this.stripContext = null;
      log.warn(
        'the channel strip cannot run in the monitor; EQ, compression and normalize are not heard',
        {
          message: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  private soundOf(
    clip: Clip,
    kind: 'video' | 'audio',
    input: ProgramAudioInput,
  ): (HeardSource & { id: number; mirrorFrameSeconds: number }) | undefined {
    let decoded: AudioBuffer | undefined;
    let mirrorFrameSeconds = 1 / AUDIO_READER_FPS;
    if (kind === 'video') {
      const footage = input.footage(clip.assetId);
      decoded = footage?.buffer;
      if (footage) mirrorFrameSeconds = 1 / footage.frameRate;
    } else {
      decoded = this.files.get(clip.assetId)?.buffer;
    }
    if (!decoded) return undefined;
    const heard = this.heard(decoded);
    if (!heard) return undefined;
    return { ...heard, id: this.sourceId(decoded), mirrorFrameSeconds };
  }

  /**
   * `decoded` as the export hears it (`exportStereoWeights`). Mono stays one channel read at -3 dB
   * (Web Audio duplicates it into both sides, as the matrix does); more than two channels fold
   * into a stereo buffer once, which is also smaller than the source.
   */
  private heard(decoded: AudioBuffer): HeardSource | undefined {
    const known = this.heardSources.get(decoded);
    if (known) return known;
    const channels = decoded.numberOfChannels;
    const weights = exportStereoWeights(channels);
    let heard: HeardSource;
    if (!weights || channels === 2) {
      heard = { buffer: decoded, inputGain: 1 };
    } else if (channels === 1) {
      heard = { buffer: decoded, inputGain: weights[0][0]! };
    } else {
      const ctx = this.context();
      if (!ctx) return undefined;
      const stereo = ctx.createBuffer(2, decoded.length, decoded.sampleRate);
      const sources = Array.from({ length: channels }, (_, c) => decoded.getChannelData(c));
      weights.forEach((row, side) => {
        const out = new Float32Array(decoded.length);
        row.forEach((weight, c) => {
          if (weight === 0) return;
          const source = sources[c]!;
          for (let n = 0; n < out.length; n += 1) out[n] = out[n]! + weight * source[n]!;
        });
        stereo.copyToChannel(out, side);
      });
      heard = { buffer: stereo, inputGain: 1 };
    }
    this.heardSources.set(decoded, heard);
    return heard;
  }

  private sourceId(decoded: AudioBuffer): number {
    let id = this.sourceIds.get(decoded);
    if (id === undefined) {
      id = this.nextSourceId++;
      this.sourceIds.set(decoded, id);
    }
    return id;
  }

  /** The whole clip's sound resampled along its time map, cached by what shapes it. */
  private resampledSound(
    clip: Clip,
    source: HeardSource & { id: number },
    sourceAt: (local: number) => number,
  ): AudioBuffer | undefined {
    const ctx = this.context();
    if (!ctx) return undefined;
    const key = JSON.stringify([
      source.id,
      clip.sourceStart,
      clip.sourceEnd,
      clip.end - clip.start,
      clip.speed ?? 1,
      clip.speedRamp ?? null,
    ]);
    const cached = this.resampled.get(key);
    if (cached) {
      this.resampled.delete(key);
      this.resampled.set(key, cached);
      return cached.buffer;
    }
    const { buffer: heard } = source;
    const frames = Math.max(1, Math.ceil((clip.end - clip.start) * heard.sampleRate));
    const buffer = ctx.createBuffer(heard.numberOfChannels, frames, heard.sampleRate);
    for (let channel = 0; channel < heard.numberOfChannels; channel += 1) {
      buffer.copyToChannel(
        resampleAlong(
          heard.getChannelData(channel),
          heard.sampleRate,
          clip.sourceStart,
          sourceAt,
          0,
          frames,
        ),
        channel,
      );
    }
    this.remember(key, clip.assetId, buffer);
    return buffer;
  }

  private remember(key: string, assetId: string, buffer: AudioBuffer): void {
    const bytes = bytesOf(buffer);
    for (const [oldest, entry] of this.resampled) {
      if (this.resampledBytes + bytes <= MAX_RESAMPLED_BYTES) break;
      this.resampled.delete(oldest);
      this.resampledBytes -= bytesOf(entry.buffer);
    }
    this.resampled.set(key, { assetId, buffer });
    this.resampledBytes += bytes;
  }

  private load(assetId: string, url: string): Promise<void> {
    if (this.files.get(assetId)?.url === url) return Promise.resolve();
    const key = `${assetId}|${url}`;
    const inFlight = this.loading.get(key);
    if (inFlight) return inFlight;
    const load = (async () => {
      const ctx = this.context();
      let buffer: AudioBuffer | undefined;
      try {
        buffer = ctx ? await ctx.decodeAudioData(await this.fetchBytes(url)) : undefined;
      } catch (err) {
        // An undecodable file plays as silence in the monitor; the export will say why.
        log.warn('audio clip could not be decoded for the monitor', {
          assetId,
          message: err instanceof Error ? err.message : String(err),
        });
        buffer = undefined;
      } finally {
        this.loading.delete(key);
      }
      this.files.set(assetId, { url, buffer });
    })();
    this.loading.set(key, load);
    return load;
  }
}

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load audio ${url}: ${response.status}`);
  return response.arrayBuffer();
}

function bytesOf(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function scaled(curve: Float32Array, factor: number): Float32Array {
  if (factor === 1) return curve;
  for (let i = 0; i < curve.length; i += 1) curve[i] = curve[i]! * factor;
  return curve;
}
