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
import { resampleAlong, soundingClips, sourceReadOf, type SoundKind } from './clip-audio.js';

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

export class ProgramAudio {
  private readonly files = new Map<string, LoadedFile>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly resampled = new Map<string, AudioBuffer>();
  private resampledBytes = 0;

  constructor(
    private readonly context: () => BaseAudioContext | undefined,
    private readonly fetchBytes: (url: string) => Promise<ArrayBuffer> = defaultFetchBytes,
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
    await Promise.all([...wanted].map(([assetId, url]) => this.load(assetId, url)));
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
      const local = segStart - clip.start;
      const timelineSeconds = clip.end - segStart;
      const gain = mix.varies
        ? {
            curve: sampleClipMix(mix, local, clip.end - clip.start, AUTOMATION_GRID_SECONDS),
          }
        : mix.gainAt(local);
      const placed = { mediaStartUs: segStart * 1_000_000, gain };
      if (read.kind === 'rate') {
        segments.push({
          ...placed,
          buffer: sound.buffer,
          offsetSec: clip.sourceStart + local * read.rate,
          durationSec: timelineSeconds * read.rate,
          ...(read.rate !== 1 ? { playbackRate: read.rate } : {}),
        });
        continue;
      }
      const buffer = this.resampledSound(clip, sound.buffer, read.sourceAt);
      if (!buffer) continue;
      segments.push({ ...placed, buffer, offsetSec: local, durationSec: timelineSeconds });
    }
    return segments.sort((a, b) => a.mediaStartUs - b.mediaStartUs);
  }

  /** Drop every decoded file and resampled buffer. */
  dispose(): void {
    this.files.clear();
    this.resampled.clear();
    this.resampledBytes = 0;
  }

  private soundOf(
    clip: Clip,
    kind: 'video' | 'audio',
    input: ProgramAudioInput,
  ): { buffer: AudioBuffer; mirrorFrameSeconds: number } | undefined {
    if (kind === 'video') {
      const footage = input.footage(clip.assetId);
      if (!footage) return undefined;
      return { buffer: footage.buffer, mirrorFrameSeconds: 1 / footage.frameRate };
    }
    const buffer = this.files.get(clip.assetId)?.buffer;
    return buffer ? { buffer, mirrorFrameSeconds: 1 / AUDIO_READER_FPS } : undefined;
  }

  /** The whole clip's sound resampled along its time map, cached by what shapes it. */
  private resampledSound(
    clip: Clip,
    source: AudioBuffer,
    sourceAt: (local: number) => number,
  ): AudioBuffer | undefined {
    const ctx = this.context();
    if (!ctx) return undefined;
    const key = JSON.stringify([
      clip.assetId,
      clip.sourceStart,
      clip.sourceEnd,
      clip.end - clip.start,
      clip.speed ?? 1,
      clip.speedRamp ?? null,
      source.sampleRate,
      source.length,
    ]);
    const cached = this.resampled.get(key);
    if (cached) {
      this.resampled.delete(key);
      this.resampled.set(key, cached);
      return cached;
    }
    const frames = Math.max(1, Math.ceil((clip.end - clip.start) * source.sampleRate));
    const buffer = ctx.createBuffer(source.numberOfChannels, frames, source.sampleRate);
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      buffer.copyToChannel(
        resampleAlong(
          source.getChannelData(channel),
          source.sampleRate,
          clip.sourceStart,
          sourceAt,
          0,
          frames,
        ),
        channel,
      );
    }
    this.remember(key, buffer);
    return buffer;
  }

  private remember(key: string, buffer: AudioBuffer): void {
    const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    for (const [oldest, entry] of this.resampled) {
      if (this.resampledBytes + bytes <= MAX_RESAMPLED_BYTES) break;
      this.resampled.delete(oldest);
      this.resampledBytes -= entry.length * entry.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    }
    this.resampled.set(key, buffer);
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
