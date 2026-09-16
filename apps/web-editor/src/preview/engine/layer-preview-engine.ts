/**
 * The frame-plan-driven program monitor engine (PX2, `09-PREVIEW-EXPORT-PARITY.md`).
 *
 * Replaces the flat-EDL `WebCodecsPreviewEngine` behind the RD2.1 flag. Every presented frame
 * is `framePlanAt(timeline, assets, t)` — the same description the export's compiler consumes —
 * rasterised by the {@link LayerCompositor}: all layers, back to front, in track order, with the
 * source frame the plan names. There is no eligibility question and no "front clip hides the
 * rest" relation: a stack is composited, not flattened.
 *
 * Time: the plan's source frame already integrates speed, freezes, reverse and ramps (PX2.5), so
 * the decode cache is indexed by (asset, source frame) and a retimed clip is a lookup, not a
 * special path.
 *
 * Decode: one worker, one streaming decoder session per source; frames arrive as planes
 * (`decoded-picture.ts`) and live in a byte-bounded cache shared by every layer (PX2.4: a
 * text-behind-subject stack decodes its frame once).
 *
 * Clock: footage audio is the master (`AudioMasterClock`), exactly as before. When a frame is
 * not decoded in time the previous picture stays up and the tick is counted as missing; a
 * wrong picture is never shown.
 */
import { framePlanAt, type FramePlan, type FramePlanLayer } from '@framepilot/editor-core';
import type { Asset, Clip, Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import { DecodeWorkerClient } from '../decode/worker-client.js';
import type { DecodedPicture } from '../decode/decoded-picture.js';
import { AudioMasterClock, type AudioSegment } from '../clock/audio-clock.js';
import { GlEffectChain, type TimedEffectLayer } from '../effects/gl-effect-chain.js';
import type { OverlayClip } from '../../editor/patch-builders.js';
import { paintTextOverlay } from './overlay-painter.js';
import { LayerCompositor, type CompositeLayer, type LayerSource } from './layer-compositor.js';
import { pictureRasterStep, type PixelSize } from './layer-raster.js';
import { parseCubeLut, type CubeLut } from './raster/cube-lut.js';
import { mediaSrc } from '../../editor/media.js';
import type {
  PresentedFrame,
  PresentedLayer,
  PreviewEngineCallbacks,
} from './webcodecs-preview-engine.js';

const log = createLogger('web-editor:preview:layer-engine');

/** Byte budget of decoded pictures held for presentation and decode-ahead. */
const CACHE_BUDGET_BYTES = 384 * 1024 * 1024;
/** Project frames of decode-ahead during playback. */
const LOOKAHEAD_FRAMES = 12;
/** Frames decoded per request during playback (one streaming window). */
const DECODE_WINDOW = 8;
const DEFAULT_FPS = 30;

/** What the engine composites: the timeline and everything the plan and decoders need. */
export interface LayerEngineProject {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  /** Media URL per asset id (the proxy when there is one). */
  readonly mediaUrls: ReadonlyMap<string, string>;
  /** The project's frame; transform offsets are authored in these pixels. */
  readonly projectResolution: PixelSize;
  /** The monitor canvas; the plan is rasterised at this size. */
  readonly canvasSize: PixelSize;
  readonly projectFps?: number;
  readonly transcript?: readonly TranscriptWord[];
  /** Text overlays by clip id (resolved params), for the interim canvas text raster. */
  readonly overlays?: readonly OverlayClip[];
  /** Text clips not drawn into the frame (the selected one is edited in the DOM). */
  readonly hiddenOverlayIds?: ReadonlySet<string>;
}

interface VideoSource {
  readonly url: string;
  readonly frameCount: number;
  readonly frameRate: number;
  readonly timestampsUs: readonly number[];
  readonly audioBuffer: AudioBuffer | undefined;
}

interface CachedPicture {
  readonly picture: DecodedPicture;
  readonly timestampUs: number;
  lastUsed: number;
}

/** A source frame some layer needs. */
interface FrameNeed {
  readonly assetId: string;
  readonly frame: number;
}

const pictureKey = (assetId: string, frame: number): string => `${assetId}@${frame}`;

/** Scale authored `x`/`y` keyframes from project pixels to canvas pixels. */
function timelineForCanvas(timeline: Timeline, ratio: number): Timeline {
  if (ratio === 1) return timeline;
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.keyframes.some((k) => k.property === 'x' || k.property === 'y')
          ? {
              ...clip,
              keyframes: clip.keyframes.map((k) =>
                k.property === 'x' || k.property === 'y' ? { ...k, value: k.value * ratio } : k,
              ),
            }
          : clip,
      ),
    })),
  };
}

export class LayerPreviewEngine {
  private readonly client = new DecodeWorkerClient();
  private readonly ctx2d: CanvasRenderingContext2D;
  private compositor: LayerCompositor | null = null;
  private project: LayerEngineProject | null = null;
  private planTimeline: Timeline | null = null;
  private clipsById = new Map<string, Clip>();
  private assetsById = new Map<string, Asset>();
  private overlaysById = new Map<string, OverlayClip>();
  private readonly sources = new Map<string, VideoSource>();
  private readonly loadingSources = new Map<string, Promise<void>>();
  private readonly images = new Map<string, ImageBitmap>();
  /** `.cube` tables by the `lut` effect's stored path. */
  private readonly luts = new Map<string, CubeLut>();
  private readonly cache = new Map<string, CachedPicture>();
  private cacheBytes = 0;
  private useCounter = 0;
  private readonly decoding = new Set<string>();
  private textCanvas: HTMLCanvasElement | null = null;
  private glEffects: GlEffectChain | null = null;

  private durationSec = 0;
  private audioCtx: AudioContext | undefined;
  private audioClock: AudioMasterClock | undefined;
  private monitorGain = 1;
  private playing = false;
  private starting = false;
  private pausedAtSec = 0;
  private rafHandle: number | undefined;
  private disposed = false;
  private generation = 0;
  private loadQueue: Promise<unknown> = Promise.resolve();
  private presented: PresentedFrame = { projectTimeSec: 0, layers: [] };
  private lastPresentedSignature = '';
  private dbg = {
    ticks: 0,
    presented: 0,
    missing: 0,
    maxSeekMs: 0,
    maxDecodeMs: 0,
    sourceDraws: 0,
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly callbacks: PreviewEngineCallbacks = {},
  ) {
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx2d = ctx;
    // Created up front: a monitor that cannot composite should say so now, not on first seek.
    this.compositor = new LayerCompositor();
  }

  get durationSeconds(): number {
    return this.durationSec;
  }

  get currentTimeSec(): number {
    return this.playing && this.audioClock
      ? this.audioClock.nowMediaUs() / 1_000_000
      : this.pausedAtSec;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isStarting(): boolean {
    return this.starting;
  }

  /**
   * Replace what the engine composites. Incremental: sources already loaded stay loaded, only
   * new media is fetched, sources no clip references any more are released. Ends by presenting
   * the current paused time.
   */
  setProject(project: LayerEngineProject): Promise<void> {
    const run = this.loadQueue.then(() => this.setProjectSerialized(project));
    this.loadQueue = run.catch(() => undefined);
    return run;
  }

  private async setProjectSerialized(project: LayerEngineProject): Promise<void> {
    if (this.disposed) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.project = project;
    this.planTimeline = timelineForCanvas(
      project.timeline,
      project.canvasSize.width / Math.max(1, project.projectResolution.width),
    );
    this.clipsById = new Map(
      this.planTimeline.tracks.flatMap((track) =>
        track.clips.map((clip) => [clip.id, clip] as const),
      ),
    );
    this.assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    this.overlaysById = new Map((project.overlays ?? []).map((overlay) => [overlay.id, overlay]));
    this.durationSec = project.timeline.tracks.reduce(
      (end, track) => track.clips.reduce((clipEnd, clip) => Math.max(clipEnd, clip.end), end),
      0,
    );
    this.callbacks.onDurationChange?.(this.durationSec);
    this.lastPresentedSignature = '';

    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.audioClock = new AudioMasterClock(this.audioCtx);
      this.audioClock.setGain(this.monitorGain);
    }

    const wantedVideo = new Map<string, string>();
    const wantedImages = new Set<string>();
    const wantedLuts = new Set<string>();
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        for (const effect of clip.effects) {
          if (effect.type === 'lut' && typeof effect.params.path === 'string') {
            wantedLuts.add(effect.params.path);
          }
        }
        const asset = this.assetsById.get(clip.assetId);
        const url = project.mediaUrls.get(clip.assetId);
        if (!asset || !url) continue;
        if (asset.kind === 'video') wantedVideo.set(asset.id, url);
        else if (asset.kind === 'image') wantedImages.add(url);
      }
    }
    for (const [assetId, source] of [...this.sources]) {
      if (wantedVideo.get(assetId) === source.url) continue;
      this.sources.delete(assetId);
      this.dropCachedAsset(assetId);
      void this.client.unloadSource(assetId).catch(() => undefined);
    }
    for (const [url, bitmap] of [...this.images]) {
      if (wantedImages.has(url)) continue;
      bitmap.close();
      this.images.delete(url);
    }
    await Promise.all([
      ...[...wantedVideo].map(([assetId, url]) => this.loadVideo(assetId, url)),
      ...[...wantedImages].map((url) => this.loadImage(url)),
      ...[...wantedLuts].map((path) => this.loadLut(path)),
    ]);
    this.compositor?.setLuts(this.luts);
    if (this.disposed) return;
    await this.seek(Math.min(this.pausedAtSec, this.durationSec));
  }

  private loadVideo(assetId: string, url: string): Promise<void> {
    if (this.sources.get(assetId)?.url === url) return Promise.resolve();
    const inFlight = this.loadingSources.get(`${assetId}|${url}`);
    if (inFlight) return inFlight;
    const audioCtx = this.audioCtx;
    const load = (async () => {
      try {
        const loaded = await this.client.loadSource(assetId, url);
        if (this.disposed) return;
        let audioBuffer: AudioBuffer | undefined;
        try {
          audioBuffer = audioCtx ? await audioCtx.decodeAudioData(loaded.fileBytes) : undefined;
        } catch {
          audioBuffer = undefined;
        }
        if (this.disposed) return;
        this.sources.set(assetId, {
          url,
          frameCount: loaded.frameCount,
          frameRate: loaded.frameRate > 0 ? loaded.frameRate : 1_000_000 / loaded.frameDurationUs,
          timestampsUs: loaded.presentationTimestampsUs,
          audioBuffer,
        });
      } catch (err) {
        if (!this.disposed) {
          this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
        }
      } finally {
        this.loadingSources.delete(`${assetId}|${url}`);
      }
    })();
    this.loadingSources.set(`${assetId}|${url}`, load);
    return load;
  }

  private async loadImage(url: string): Promise<void> {
    if (this.images.has(url)) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load image ${url}: ${response.status}`);
      const blob = await response.blob();
      // Straight alpha and the file's own values, as the export's imageio read gives them.
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.images.set(url, bitmap);
    } catch (err) {
      if (!this.disposed)
        this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  private async loadLut(path: string): Promise<void> {
    if (this.luts.has(path)) return;
    try {
      // A project-relative path is served through fp-media:// on the desktop; a URL passes through.
      const url = mediaSrc(path);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load LUT ${path}: ${response.status}`);
      const table = parseCubeLut(await response.text());
      if (!this.disposed) this.luts.set(path, table);
    } catch (err) {
      if (!this.disposed)
        this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  setVolume(gain: number): void {
    this.monitorGain = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
    this.audioClock?.setGain(this.monitorGain);
  }

  // --- planning ------------------------------------------------------------------------------

  private sourceFps(): Map<string, number> {
    const fps = new Map<string, number>();
    for (const [assetId, source] of this.sources) fps.set(assetId, source.frameRate);
    return fps;
  }

  private planAt(timeSec: number): FramePlan | null {
    const project = this.project;
    const timeline = this.planTimeline;
    if (!project || !timeline) return null;
    return framePlanAt(timeline, project.assets, timeSec, project.canvasSize, {
      sourceFps: this.sourceFps(),
      ...(project.transcript ? { transcript: project.transcript } : {}),
    });
  }

  /** Clamp a plan frame to what the decoder has (MoviePy holds the last frame past the end). */
  private frameIndexFor(layer: FramePlanLayer): number | null {
    const source = layer.source;
    if (!source || source.assetKind !== 'video' || source.frame === null) return null;
    const info = this.sources.get(source.assetId);
    if (!info) return null;
    return Math.min(Math.max(0, source.frame), Math.max(0, info.frameCount - 1));
  }

  private needsOf(plan: FramePlan): FrameNeed[] {
    const needs: FrameNeed[] = [];
    for (const layer of plan.layers) {
      if (layer.kind !== 'picture') continue;
      const frame = this.frameIndexFor(layer);
      if (frame !== null && layer.source) needs.push({ assetId: layer.source.assetId, frame });
    }
    return needs;
  }

  // --- decoding ------------------------------------------------------------------------------

  private dropCachedAsset(assetId: string): void {
    for (const [key, entry] of [...this.cache]) {
      if (!key.startsWith(`${assetId}@`)) continue;
      this.releaseEntry(key, entry);
    }
  }

  private releaseEntry(key: string, entry: CachedPicture): void {
    this.cache.delete(key);
    this.cacheBytes -= entry.picture.byteLength;
    if (entry.picture.kind === 'frame') this.client.closeFrame(entry.picture.frame);
  }

  private evict(pinned: ReadonlySet<string>): void {
    if (this.cacheBytes <= CACHE_BUDGET_BYTES) return;
    const entries = [...this.cache].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of entries) {
      if (this.cacheBytes <= CACHE_BUDGET_BYTES) break;
      if (pinned.has(key)) continue;
      this.releaseEntry(key, entry);
    }
  }

  /** Decode every missing frame of `needs`, contiguous runs per source. */
  private async ensureFrames(needs: readonly FrameNeed[]): Promise<void> {
    const byAsset = new Map<string, number[]>();
    for (const need of needs) {
      if (this.cache.has(pictureKey(need.assetId, need.frame))) continue;
      const frames = byAsset.get(need.assetId) ?? [];
      frames.push(need.frame);
      byAsset.set(need.assetId, frames);
    }
    await Promise.all(
      [...byAsset].map(async ([assetId, frames]) => {
        const sorted = [...new Set(frames)].sort((a, b) => a - b);
        let runStart = sorted[0]!;
        let previous = runStart;
        const runs: [number, number][] = [];
        for (const frame of sorted.slice(1)) {
          if (frame !== previous + 1) {
            runs.push([runStart, previous]);
            runStart = frame;
          }
          previous = frame;
        }
        runs.push([runStart, previous]);
        for (const [from, to] of runs) await this.decodeRun(assetId, from, to);
      }),
    );
  }

  private async decodeRun(assetId: string, from: number, to: number): Promise<void> {
    const started = performance.now();
    const { pictures } = await this.client.decodePictures(assetId, from, to);
    this.dbg.maxDecodeMs = Math.max(this.dbg.maxDecodeMs, performance.now() - started);
    for (const message of pictures) {
      const key = pictureKey(assetId, message.chunkIndex);
      if (this.disposed || !this.sources.has(assetId) || this.cache.has(key)) {
        this.client.releasePicture(message);
        continue;
      }
      this.cache.set(key, {
        picture: message.picture,
        timestampUs: message.timestampUs,
        lastUsed: ++this.useCounter,
      });
      this.cacheBytes += message.picture.byteLength;
    }
  }

  // --- presentation --------------------------------------------------------------------------

  private textRaster(layer: FramePlanLayer, size: PixelSize): CompositeLayer | null {
    if (layer.clipId === null) return null;
    if (this.project?.hiddenOverlayIds?.has(layer.clipId)) return null;
    const overlay = this.overlaysById.get(layer.clipId);
    if (!overlay) return null;
    this.textCanvas ??= document.createElement('canvas');
    const canvas = this.textCanvas;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, size.width, size.height);
    paintTextOverlay(
      ctx,
      overlay.params,
      layer.localTime,
      overlay.end - overlay.start,
      size.width,
      size.height,
    );
    return {
      kind: 'raster',
      key: `text:${layer.clipId}`,
      image: canvas,
      width: size.width,
      height: size.height,
      x: 0,
      y: 0,
    };
  }

  /**
   * Build the composite for `plan` from what is decoded. Returns `null` when a picture layer's
   * frame is not available (the caller keeps the previous presentation).
   */
  private compose(
    plan: FramePlan,
  ): { layers: CompositeLayer[]; presented: PresentedLayer[] } | null {
    const project = this.project;
    if (!project) return null;
    const size = project.canvasSize;
    const layers: CompositeLayer[] = [];
    const presented: PresentedLayer[] = [];
    for (const layer of plan.layers) {
      if (layer.kind === 'text') {
        const raster = this.textRaster(layer, size);
        if (raster) layers.push(raster);
        continue;
      }
      if (layer.kind !== 'picture' || !layer.source || layer.clipId === null) continue;
      const clip = this.clipsById.get(layer.clipId);
      const asset = this.assetsById.get(layer.source.assetId);
      if (!clip || !asset) continue;
      if (layer.source.assetKind === 'image') {
        const url = project.mediaUrls.get(asset.id);
        const bitmap = url ? this.images.get(url) : undefined;
        if (!bitmap) return null;
        const step = pictureRasterStep(layer, clip, asset, size, {
          width: bitmap.width,
          height: bitmap.height,
        });
        if (!step) continue;
        const source: LayerSource = {
          kind: 'image',
          key: `image:${url}`,
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
        };
        layers.push({ kind: 'picture', step, source });
        presented.push({
          role: layer.role === 'underlay' ? 'held' : 'clip',
          sourceId: asset.id,
          kind: 'image',
          timestampUs: null,
        });
        continue;
      }
      if (!this.sources.has(asset.id)) {
        // Still loading: wait for it. Failed to load: the monitor already shows the error, and
        // the rest of the frame is still worth drawing.
        if ([...this.loadingSources.keys()].some((key) => key.startsWith(`${asset.id}|`))) {
          return null;
        }
        continue;
      }
      const frame = this.frameIndexFor(layer);
      if (frame === null) continue;
      const key = pictureKey(asset.id, frame);
      const cached = this.cache.get(key);
      if (!cached) return null;
      cached.lastUsed = ++this.useCounter;
      const step = pictureRasterStep(layer, clip, asset, size, {
        width: cached.picture.width,
        height: cached.picture.height,
      });
      if (!step) continue;
      layers.push({
        kind: 'picture',
        step: { ...step, frame },
        source: { kind: 'decoded', key, picture: cached.picture },
      });
      presented.push({
        role: layer.role === 'underlay' ? 'held' : 'clip',
        sourceId: asset.id,
        kind: 'video',
        timestampUs: cached.timestampUs,
      });
    }
    return { layers, presented };
  }

  /** Composite and show `plan`. Returns false when a needed frame was missing. */
  private present(plan: FramePlan, timeSec: number, force: boolean): boolean {
    const compositor = this.compositor;
    const project = this.project;
    if (!compositor || !project) return false;
    const composed = this.compose(plan);
    if (!composed) return false;
    const signature = JSON.stringify([
      composed.presented,
      plan.layers.map((l) => [l.clipId, l.localTime, l.opacity, l.geometry]),
      plan.frameEffects.length > 0 ? timeSec : null,
    ]);
    if (!force && signature === this.lastPresentedSignature) {
      this.presented = { projectTimeSec: timeSec, layers: composed.presented };
      return true;
    }
    const size = project.canvasSize;
    compositor.render(size, composed.layers);
    const ctx = this.ctx2d;
    if (ctx.canvas.width !== size.width) ctx.canvas.width = size.width;
    if (ctx.canvas.height !== size.height) ctx.canvas.height = size.height;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.drawImage(compositor.canvas, 0, 0);
    ctx.restore();
    this.applyFrameEffects(plan, timeSec);
    this.lastPresentedSignature = signature;
    this.presented = { projectTimeSec: timeSec, layers: composed.presented };
    this.dbg.sourceDraws++;
    return true;
  }

  /** Effect layers apply to the finished frame (schema v13), as the export's last stage. */
  private applyFrameEffects(plan: FramePlan, timeSec: number): void {
    if (plan.frameEffects.length === 0) return;
    const live: TimedEffectLayer[] = plan.frameEffects.map((effect) => ({
      kind: effect.kind as TimedEffectLayer['kind'],
      start: timeSec,
      end: timeSec + 1,
      params: effect.params,
      intensity: effect.intensity,
    }));
    this.glEffects ??= new GlEffectChain(() => document.createElement('canvas'));
    const processed = this.glEffects.process(this.ctx2d.canvas, live, timeSec);
    if (processed === null) return;
    this.ctx2d.save();
    this.ctx2d.globalCompositeOperation = 'copy';
    this.ctx2d.drawImage(processed as CanvasImageSource, 0, 0);
    this.ctx2d.restore();
  }

  async seek(projectTimeSec: number): Promise<void> {
    if (this.disposed) return;
    if (this.playing) this.pause();
    const myGeneration = ++this.generation;
    const clamped = Math.min(this.durationSec, Math.max(0, projectTimeSec));
    try {
      const plan = this.planAt(clamped);
      if (plan) {
        const needs = this.needsOf(plan);
        const started = performance.now();
        await this.ensureFrames(needs);
        this.dbg.maxSeekMs = Math.max(this.dbg.maxSeekMs, performance.now() - started);
        if (this.disposed || this.generation !== myGeneration) return;
        // Re-plan: a source that finished loading meanwhile may have changed frame numbers.
        const current = this.planAt(clamped) ?? plan;
        await this.ensureFrames(this.needsOf(current));
        if (this.disposed || this.generation !== myGeneration) return;
        this.present(current, clamped, true);
        this.evict(new Set(this.needsOf(current).map((n) => pictureKey(n.assetId, n.frame))));
      }
    } catch (err) {
      if (this.disposed || this.generation !== myGeneration) return;
      log.error('seek failed', { message: err instanceof Error ? err.message : String(err) });
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
    if (this.disposed || this.generation !== myGeneration) return;
    this.pausedAtSec = clamped;
    this.callbacks.onTimeUpdate?.(clamped);
  }

  private audioSegmentsFrom(startSec: number): AudioSegment[] {
    const project = this.project;
    if (!project) return [];
    const segments: AudioSegment[] = [];
    for (const track of project.timeline.tracks) {
      if (track.muted === true || track.hidden === true) continue;
      for (const clip of track.clips) {
        const asset = this.assetsById.get(clip.assetId);
        if (asset?.kind !== 'video') continue;
        const buffer = this.sources.get(clip.assetId)?.audioBuffer;
        if (!buffer) continue;
        // Retimed audio (speed, reverse, ramps) is not scheduled yet; the picture still is.
        if ((clip.speed ?? 1) !== 1 || (clip.speedRamp?.length ?? 0) > 0) continue;
        const segStart = Math.max(clip.start, startSec);
        if (segStart >= clip.end) continue;
        segments.push({
          mediaStartUs: segStart * 1_000_000,
          buffer,
          offsetSec: clip.sourceStart + (segStart - clip.start),
          durationSec: clip.end - segStart,
        });
      }
    }
    return segments.sort((a, b) => a.mediaStartUs - b.mediaStartUs);
  }

  async play(): Promise<void> {
    if (this.playing || this.starting || !this.audioClock || !this.project) return;
    this.starting = true;
    try {
      await this.audioClock.start();
    } catch (err) {
      this.starting = false;
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.disposed) {
      this.starting = false;
      return;
    }
    this.generation++;
    this.playing = true;
    this.starting = false;
    this.callbacks.onPlayingChange?.(true);
    this.dbg = { ticks: 0, presented: 0, missing: 0, maxSeekMs: 0, maxDecodeMs: 0, sourceDraws: 0 };
    const startSec = this.pausedAtSec >= this.durationSec ? 0 : this.pausedAtSec;
    this.audioClock.scheduleSegments(this.audioSegmentsFrom(startSec), startSec * 1_000_000);

    const tick = (): void => {
      if (!this.playing || !this.audioClock) return;
      const nowSec = this.audioClock.nowMediaUs() / 1_000_000;
      if (nowSec >= this.durationSec) {
        this.pausedAtSec = this.durationSec;
        this.pause();
        this.callbacks.onTimeUpdate?.(this.durationSec);
        return;
      }
      this.dbg.ticks++;
      const plan = this.planAt(nowSec);
      if (plan) {
        if (this.present(plan, nowSec, false)) this.dbg.presented++;
        else this.dbg.missing++;
        this.pumpAhead(nowSec);
      }
      this.callbacks.onTimeUpdate?.(nowSec);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Decode ahead of the playhead: the frames the next project frames will ask for. */
  private pumpAhead(nowSec: number): void {
    const fps = this.project?.projectFps ?? DEFAULT_FPS;
    const wanted = new Map<string, number[]>();
    const pinned = new Set<string>();
    for (let k = 0; k <= LOOKAHEAD_FRAMES; k++) {
      const t = nowSec + k / fps;
      if (t >= this.durationSec) break;
      const plan = this.planAt(t);
      if (!plan) break;
      for (const need of this.needsOf(plan)) {
        const key = pictureKey(need.assetId, need.frame);
        pinned.add(key);
        if (this.cache.has(key)) continue;
        const frames = wanted.get(need.assetId) ?? [];
        frames.push(need.frame);
        wanted.set(need.assetId, frames);
      }
    }
    this.evict(pinned);
    const generation = this.generation;
    for (const [assetId, frames] of wanted) {
      if (this.decoding.has(assetId)) continue;
      const first = Math.min(...frames);
      const info = this.sources.get(assetId);
      if (!info) continue;
      const last = Math.min(info.frameCount - 1, first + DECODE_WINDOW - 1);
      this.decoding.add(assetId);
      void this.decodeRun(assetId, first, Math.max(first, last))
        .catch((err: unknown) => {
          if (this.disposed || this.generation !== generation) return;
          log.warn('decode-ahead failed', {
            assetId,
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => this.decoding.delete(assetId));
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.audioClock?.clear();
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    this.callbacks.onPlayingChange?.(false);
  }

  /** Playback counters; `segCount` > 0 once a project with clips is loaded (e2e readiness). */
  debugStats(): Record<string, number> {
    const clipCount = this.project
      ? this.project.timeline.tracks.reduce((n, track) => n + track.clips.length, 0)
      : 0;
    return {
      ...this.dbg,
      durationSec: this.durationSec,
      segCount: clipCount,
      cachedFrames: this.cache.size,
      cacheBytes: this.cacheBytes,
    };
  }

  /** The last presented picture layers, back to front (the PX4 oracle's frame identity). */
  debugPresentedFrame(): PresentedFrame {
    return this.presented;
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    for (const [key, entry] of [...this.cache]) this.releaseEntry(key, entry);
    this.client.dispose();
    this.compositor?.dispose();
    this.compositor = null;
    this.glEffects?.dispose();
    this.glEffects = null;
    for (const bitmap of this.images.values()) bitmap.close();
    this.images.clear();
    this.sources.clear();
    this.project = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = undefined;
  }
}
