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
 * Mattes (BR5.1): a clip's `matte` layers are read at the SAME source frame its picture decodes
 * (`masks/matte-source.ts`), decoded on their own workers (PX5.3: `decode/matte-decode-pool.ts`,
 * never in the picture decoders' worker) and held in the same byte-bounded cache.
 * A frame not decoded yet holds the previous presentation like a missing picture; a frame the
 * artifact does not hold (still processing) leaves that layer out and the monitor says so.
 *
 * Clock: footage audio is the master (`AudioMasterClock`), exactly as before. When a frame is
 * not decoded in time the previous picture stays up and the tick is counted as missing; a
 * wrong picture is never shown.
 */
import {
  framePlanAt,
  resolveCaptionCue,
  type FramePlan,
  type FramePlanLayer,
  type TrackArtifact,
} from '@framepilot/editor-core';
import type {
  Asset,
  CaptionStyle,
  Clip,
  MaskLayer,
  Timeline,
  TranscriptWord,
} from '@framepilot/timeline-schema';
import { SHAPE_EFFECT_TYPE } from '@framepilot/timeline-schema';
import { createLogger, type PreviewTextRasterRequest } from '@framepilot/shared-types';
import { DecodeWorkerClient, type WorkerTraffic } from '../decode/worker-client.js';
import type { WorkerStageReport } from '../decode/decode-worker.js';
import { MatteDecodePool } from '../decode/matte-decode-pool.js';
import { rotateI420, type DecodedPicture } from '../decode/decoded-picture.js';
import { AudioMasterClock, type AudioSegment } from '../clock/audio-clock.js';
import { projectFrameTime } from '../clock/project-frame.js';
import type { FrameEffectInstance } from './gl/frame-effects.js';
import { LayerCompositor, type CompositeLayer, type LayerSource } from './layer-compositor.js';
import { pictureRasterStep, textRasterStep, type PixelSize } from './layer-raster.js';
import { withTrackMattes } from './track-mattes.js';
import {
  exportText,
  loadExportTextFont,
  rasterizeBaselineCaption,
  rasterizeTextOverlay,
  textOverlayLayout,
  type CaptionRaster,
  type TextRaster,
} from './text-raster.js';
import { parseCubeLut, type CubeLut } from './raster/cube-lut.js';
import { configureSwsUnscaledConverterFromHost } from './raster/sws-host.js';
import {
  configureLegacyMaskArithmeticFromHost,
  type MaskPreviewRefusal,
  type MatteMask,
  type MatteStackInputs,
} from '../masks/mask-stack.js';
import { MatteSource } from '../masks/matte-source.js';
import { TrackSource } from '../masks/track-source.js';
import { resolveTrackArtifactLocator } from '../masks/track-location.js';
import { resolveMatteArtifactLocator, resolveMatteTierLocator } from '../masks/matte-location.js';
import {
  alphaPlaneFits,
  matteAlphaTierable,
  planesFit,
  type MatteFrameData,
} from '../masks/matte-edges.js';
import { isFlaggedFrame, type MaskDebugView } from '../masks/mask-view.js';
import { FrameMaskRasterCache, effectLayerMaskStack } from '../masks/frame-masks.js';
import type { FlaggedRange, MatteLookup } from '../masks/matte-source.js';
import {
  EngineTextRasters,
  resolveTextRasterSource,
  textRasterKey,
} from './engine-text-rasters.js';
import { mediaSrc } from '../../editor/media.js';
import { clipKind, effectiveMutedTrackIds } from '../../editor/selectors.js';
import { ProgramAudio } from '../audio/program-audio.js';
import type {
  PresentedFrame,
  PresentedLayer,
  PreviewEngineCallbacks,
} from './webcodecs-preview-engine.js';

import { PreviewTelemetry, type PreviewTelemetrySnapshot } from './preview-telemetry.js';
import { StageTracker, type StageSnapshot } from './stage-tracker.js';

const log = createLogger('web-editor:preview:layer-engine');

/** Byte budget of decoded pictures held for presentation and decode-ahead. */
const CACHE_BUDGET_BYTES = 384 * 1024 * 1024;
/** Project frames of decode-ahead during playback. */
const LOOKAHEAD_FRAMES = 12;
/** Frames decoded per request during playback (one streaming window). */
const DECODE_WINDOW = 8;
const DEFAULT_FPS = 30;
/**
 * PX5.7: a stage (a decode window, a seek's mattes or texts) still waiting after this long is
 * logged with the decode worker's own report. A decode window takes 10-100 ms here and about a
 * second on CI's CPU GL; ten seconds is no slow machine, it is a promise that never settled.
 */
const STAGE_STUCK_MS = 10_000;
/** How long a hang report waits for the decode worker to say where it is. */
const WORKER_STAGES_TIMEOUT_MS = 2_000;
/**
 * PX2.8 load shedding. Playback lowers the resolution the plan is rasterised at before anything
 * else, one step at a time, and only then lets presentation frames drop (a frame not ready on a
 * tick keeps the previous picture). It never removes a layer, matte, effect or transition. A
 * paused frame (seek, scrub end, parity read) is always composited at full resolution.
 */
const RENDER_SCALES = [1, 0.75, 0.5] as const;
/** Composite time above this share of the frame interval counts as falling behind. */
const SLOW_SHARE = 0.75;
/** …and below this share, as having headroom to step back up. */
const FAST_SHARE = 0.35;
const SLOW_TICKS_TO_SHED = 8;
const FAST_TICKS_TO_RESTORE = 90;
const EMA_WEIGHT = 0.2;

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
  /** Burn caption tracks into the frame, as the export's "burn captions" setting does. */
  readonly burnCaptions?: boolean;
  /** Text clips not drawn into the frame (the selected one is edited in the DOM). */
  readonly hiddenOverlayIds?: ReadonlySet<string>;
}

interface VideoSource {
  readonly url: string;
  readonly frameCount: number;
  readonly frameRate: number;
  /** Variable-frame-rate sources: frame pts in seconds from the first frame (PX2.10). */
  readonly frameTimesSec: readonly number[] | null;
  readonly timestampsUs: readonly number[];
  readonly audioBuffer: AudioBuffer | undefined;
}

type CacheEntry =
  | {
      readonly kind: 'picture';
      readonly picture: DecodedPicture;
      readonly timestampUs: number;
      lastUsed: number;
    }
  | { readonly kind: 'matte'; readonly frame: MatteFrameData; lastUsed: number };

const entryBytes = (entry: CacheEntry): number =>
  entry.kind === 'picture'
    ? entry.picture.byteLength
    : (entry.frame.alpha?.byteLength ?? 0) +
      (entry.frame.foreground?.byteLength ?? 0) +
      (entry.frame.planes?.data.byteLength ?? 0) +
      (entry.frame.alphaPlane?.data.byteLength ?? 0);

/** A matte layer some presented picture needs, at that picture's source frame. */
interface MatteNeed {
  readonly mask: MatteMask;
  readonly sourceFrame: number;
}

/**
 * What one matte layer resolved to on the last composite, for the PX4 oracle's diagnostic
 * (BR5.4). Facts only: no verdict is taken from it, and nothing but a failing sample reads it.
 */
interface MatteDebugState {
  readonly clipId: string;
  readonly maskId: string;
  readonly artifact: string;
  readonly sourceFrame: number;
  readonly pictureSeconds: number;
  readonly state: MatteLookup['state'];
  readonly code: string | null;
  readonly frameIndex: number | null;
  /** PX5.3: the artifact's monitor tier size when one matched, else `null`. */
  readonly tier: string | null;
  /** PX5.3: whether this frame's decontamination was drawn from the tier's planes. */
  readonly fromTier: boolean;
  /** PX5.8: whether this frame's alpha was drawn from the tier's alpha plane. */
  readonly alphaFromTier: boolean;
  readonly loaded: boolean;
  readonly refusal: string | null;
  readonly firstFrame: number | null;
  readonly frameCount: number | null;
  readonly stage: string | null;
  readonly cause: string | null;
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
  /** PX5.7: every asynchronous stage a seek or decode-ahead waits on, for a hang report. */
  private readonly stages = new StageTracker({
    stuckAfterMs: STAGE_STUCK_MS,
    onStuck: (stuck) => this.reportStuck(stuck),
  });
  /** PX5.3: matte artifact files decode here, off the picture decoders' worker. */
  private readonly matteDecoders = new MatteDecodePool();
  private readonly ctx2d: CanvasRenderingContext2D;
  private compositor: LayerCompositor | null = null;
  private project: LayerEngineProject | null = null;
  /** Plan inputs per rasterised width: transform offsets are scaled to the frame they land in. */
  private readonly planInputs = new Map<
    number,
    { readonly timeline: Timeline; readonly clipsById: Map<string, Clip> }
  >();
  private clipsById = new Map<string, Clip>();
  /** MK5.2: frame-space mask rasters for masked adjustment lanes, cached by size and instant. */
  private readonly frameMaskRasters = new FrameMaskRasterCache();
  private renderScaleIndex = 0;
  private renderMsEma = 0;
  private slowTicks = 0;
  private fastTicks = 0;
  private assetsById = new Map<string, Asset>();
  private readonly sources = new Map<string, VideoSource>();
  private readonly loadingSources = new Map<string, Promise<void>>();
  private readonly images = new Map<string, ImageBitmap>();
  /** `.cube` tables by the `lut` effect's stored path. */
  private readonly luts = new Map<string, CubeLut>();
  private readonly cache = new Map<string, CacheEntry>();
  /** BR5.1: matte artifact frames, decoded on the matte pool into the same cache. */
  private readonly mattes: MatteSource;
  /**
   * MK7.1: tracked masks' transform tracks (small, digest-checked `track.json`s). The locator
   * is resolved per key, because the project folder it reads from changes with the project.
   */
  private readonly trackArtifacts = new TrackSource(
    (key) => resolveTrackArtifactLocator()?.(key) ?? null,
  );
  private lastMatteProcessing = false;
  /** BR5.2: review ranges per artifact key (`undefined` while `report.json` is being read). */
  private readonly flaggedRanges = new Map<string, readonly FlaggedRange[] | null>();
  private cacheBytes = 0;
  private useCounter = 0;
  private readonly decoding = new Set<string>();
  private readonly textRasters = new Map<string, TextRaster | null>();
  private readonly captionRasters = new Map<string, CaptionRaster | null>();
  /** Each caption track's default style, by track id: a styled cue is drawn by the engine. */
  private captionTrackStyles = new Map<string, CaptionStyle | undefined>();
  private textFontReady = false;
  /** The engine's own Pillow rasters for text and captions (desktop; canvas fallback). */
  private readonly engineTexts: EngineTextRasters;

  private durationSec = 0;
  private audioCtx: AudioContext | undefined;
  private audioClock: AudioMasterClock | undefined;
  private monitorGain = 1;
  /** Every clip's sound, as the export mixes it, on the audio clock. */
  private readonly programAudio = new ProgramAudio(() => this.audioCtx);
  /** Tracks soloed for monitoring (session-only; the export ignores solo). */
  private soloedTrackIds: ReadonlySet<string> = new Set();
  private playing = false;
  private starting = false;
  private pausedAtSec = 0;
  private rafHandle: number | undefined;
  private disposed = false;
  private generation = 0;
  private loadQueue: Promise<unknown> = Promise.resolve();
  /** NaN until something is presented: a read at t=0 must not match the empty initial state. */
  private presented: PresentedFrame = { projectTimeSec: Number.NaN, layers: [] };
  private lastPresentedSignature = '';
  private lastMaskRefusalKey = '';
  /** MK3.3: the mask debug view and the clip it applies to (the selected clip). */
  private maskView: MaskDebugView = 'off';
  private maskViewClipId: string | null = null;
  private lastBitmap: ImageBitmap | null = null;
  private lastPictureKeys: string[] = [];
  /** BR5.4: how every matte layer of the last composite resolved (oracle diagnostic only). */
  private lastMatteStates: MatteDebugState[] = [];
  /** PX5.1: the engine's own frame-time, dropped-frame, seek and memory numbers. */
  readonly telemetry = new PreviewTelemetry();
  private lastTickAtMs: number | null = null;
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
    this.engineTexts = new EngineTextRasters(resolveTextRasterSource(), (approximate) =>
      this.callbacks.onTextApproximateChange?.(approximate),
    );
    this.mattes = new MatteSource(
      this.matteDecoders,
      resolveMatteArtifactLocator,
      {
        get: (key) => {
          const entry = this.cache.get(key);
          if (entry?.kind !== 'matte') return undefined;
          entry.lastUsed = ++this.useCounter;
          return entry.frame;
        },
        put: (key, frame) => {
          const previous = this.cache.get(key);
          if (previous !== undefined) this.releaseEntry(key, previous);
          const entry: CacheEntry = { kind: 'matte', frame, lastUsed: ++this.useCounter };
          this.cache.set(key, entry);
          this.cacheBytes += entryBytes(entry);
          this.telemetry.gauge('pictureCacheBytes', this.cacheBytes);
        },
      },
      undefined,
      {
        onFrameDecoded: (ms) => this.telemetry.record('matteDecode', ms),
        locateTier: resolveMatteTierLocator,
      },
    );
    // Created up front: a monitor that cannot composite should say so now, not on first seek.
    this.compositor = new LayerCompositor();
    this.compositor.setTelemetry(this.telemetry);
    // Legacy (v21) masks follow the host Pillow's float arithmetic (`masks/legacy-mask.ts`).
    void configureLegacyMaskArithmeticFromHost();
    // Same-size decodes follow the host ffmpeg's unscaled converter (`raster/sws-host.ts`).
    void configureSwsUnscaledConverterFromHost();
  }

  /**
   * Show a mask debug view for one clip (MK3.3), re-presenting the paused frame. `off`, or no
   * clip, restores the program picture.
   */
  setMaskView(view: MaskDebugView, clipId: string | null): void {
    const next = clipId === null ? 'off' : view;
    if (next === this.maskView && clipId === this.maskViewClipId) return;
    this.maskView = next;
    this.maskViewClipId = clipId;
    this.lastPresentedSignature = '';
    if (!this.playing && this.project !== null) void this.seek(this.pausedAtSec);
  }

  /** Tell the monitor whether a presented clip's mask stack is refused (first one wins). */
  private reportMaskRefusal(layers: readonly CompositeLayer[]): void {
    let refusal: MaskPreviewRefusal | null = null;
    for (const layer of layers) {
      if (layer.kind === 'picture' && layer.step.maskRefusal !== null) {
        refusal = layer.step.maskRefusal;
        break;
      }
    }
    const key = refusal === null ? '' : `${refusal.clipId}|${refusal.maskId}|${refusal.message}`;
    if (key === this.lastMaskRefusalKey) return;
    this.lastMaskRefusalKey = key;
    if (refusal !== null) {
      log.warn('mask stack not previewed', {
        clipId: refusal.clipId,
        maskId: refusal.maskId,
        task: refusal.task,
      });
    }
    this.callbacks.onMaskRefusalChange?.(refusal);
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
    this.planInputs.clear();
    this.assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
    this.captionTrackStyles = new Map(
      project.timeline.tracks
        .filter((track) => track.type === 'caption')
        .map((track) => [track.id, track.captionStyle] as const),
    );
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
    const matteMasks = project.timeline.tracks.flatMap((track) =>
      track.clips.flatMap((clip) =>
        (clip.masks ?? []).filter((mask): mask is MatteMask => mask.kind === 'matte'),
      ),
    );
    this.mattes.retain(new Set(matteMasks.map((mask) => mask.artifact.key)));
    // MK7.1: start every tracked mask's track now; a seek awaits whichever are still loading.
    void this.trackArtifacts.ensure(
      project.timeline.tracks.flatMap((track) =>
        track.clips.flatMap((clip) => (clip.masks ?? []).filter((mask) => mask.enabled)),
      ),
    );
    // PX5.3: open every artifact (and its monitor tier) now, as the pictures' sources are, not
    // on the first seek that needs it.
    this.mattes.prepare(matteMasks.filter((mask) => mask.enabled));
    for (const [url, bitmap] of [...this.images]) {
      if (wantedImages.has(url)) continue;
      bitmap.close();
      this.images.delete(url);
    }
    await Promise.all([
      ...[...wantedVideo].map(([assetId, url]) => this.loadVideo(assetId, url)),
      ...[...wantedImages].map((url) => this.loadImage(url)),
      ...[...wantedLuts].map((path) => this.loadLut(path)),
      this.programAudio.retain(project.timeline, project.assets, project.mediaUrls),
      loadExportTextFont().then((ready) => {
        this.textFontReady = ready;
      }),
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
          frameTimesSec: loaded.frameTimesSec ?? null,
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

  /** Frame pts of the variable-rate sources, so the plan numbers their frames as the export. */
  private sourceFrameTimes(): Map<string, readonly number[]> {
    const times = new Map<string, readonly number[]>();
    for (const [assetId, source] of this.sources) {
      if (source.frameTimesSec) times.set(assetId, source.frameTimesSec);
    }
    return times;
  }

  /** The frame playback rasterises at now (the canvas, or a shed step below it). */
  private renderSize(): PixelSize {
    const canvas = this.project?.canvasSize ?? { width: 1, height: 1 };
    const scale = RENDER_SCALES[this.renderScaleIndex] ?? 1;
    if (scale === 1) return canvas;
    const even = (value: number): number => Math.max(2, Math.round((value * scale) / 2) * 2);
    return { width: even(canvas.width), height: even(canvas.height) };
  }

  private inputsFor(size: PixelSize): { timeline: Timeline; clipsById: Map<string, Clip> } | null {
    const project = this.project;
    if (!project) return null;
    const cached = this.planInputs.get(size.width);
    if (cached) return cached;
    const timeline = timelineForCanvas(
      project.timeline,
      size.width / Math.max(1, project.projectResolution.width),
    );
    const inputs = {
      timeline,
      clipsById: new Map(
        timeline.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)),
      ),
    };
    this.planInputs.set(size.width, inputs);
    return inputs;
  }

  private planAt(timeSec: number, size?: PixelSize): FramePlan | null {
    const project = this.project;
    const frame = size ?? project?.canvasSize;
    const inputs = frame ? this.inputsFor(frame) : null;
    if (!project || !inputs || !frame) return null;
    this.clipsById = inputs.clipsById;
    return framePlanAt(inputs.timeline, project.assets, timeSec, frame, {
      sourceFps: this.sourceFps(),
      sourceFrameTimes: this.sourceFrameTimes(),
      burnCaptions: project.burnCaptions === true,
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

  /** The matte layers the plan's clips draw, each at its picture's decoded source frame. */
  private matteNeedsOf(plan: FramePlan): MatteNeed[] {
    const needs: MatteNeed[] = [];
    for (const layer of plan.layers) {
      if (layer.kind !== 'picture' || layer.role !== 'clip' || layer.clipId === null) continue;
      if (!layer.mask?.layers.some((planned) => planned.kind === 'matte')) continue;
      const frame = this.frameIndexFor(layer);
      const clip = this.clipsById.get(layer.clipId);
      if (frame === null || clip === undefined) continue;
      for (const mask of clip.masks ?? []) {
        if (mask.enabled && mask.kind === 'matte') needs.push({ mask, sourceFrame: frame });
      }
    }
    return needs;
  }

  /** The enabled tracked masks of the clips `plan` draws (MK7.1). */
  private trackedMasksOf(plan: FramePlan): MaskLayer[] {
    const masks: MaskLayer[] = [];
    for (const layer of plan.layers) {
      if (layer.kind !== 'picture' || layer.role !== 'clip' || layer.clipId === null) continue;
      const clip = this.clipsById.get(layer.clipId);
      for (const mask of clip?.masks ?? []) {
        if (mask.enabled && mask.tracking !== undefined) masks.push(mask);
      }
    }
    return masks;
  }

  /**
   * The loaded track of each tracked mask on `clip`, by mask id, or `pending` while one loads.
   * A refused track is left out: the stack then refuses that mask with a remedy, as the export
   * refuses it (`render/tracks.py`).
   */
  private tracksOf(clip: Clip): ReadonlyMap<string, TrackArtifact> | 'pending' {
    const tracks = new Map<string, TrackArtifact>();
    for (const mask of clip.masks ?? []) {
      if (!mask.enabled || mask.tracking === undefined) continue;
      const found = this.trackArtifacts.lookup(mask);
      if (found.state === 'pending') return 'pending';
      if (found.state === 'ready') tracks.set(mask.id, found.artifact);
    }
    return tracks;
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

  private releaseEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cacheBytes -= entryBytes(entry);
    this.telemetry.gauge('pictureCacheBytes', this.cacheBytes);
    if (entry.kind === 'picture' && entry.picture.kind === 'frame') {
      this.client.closeFrame(entry.picture.frame);
    }
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
    const { pictures } = await this.stages.track(
      'decode',
      `${assetId} ${from}-${to}`,
      this.client.decodePictures(assetId, from, to),
    );
    const decodeMs = performance.now() - started;
    this.dbg.maxDecodeMs = Math.max(this.dbg.maxDecodeMs, decodeMs);
    this.telemetry.record('decode', decodeMs);
    for (const message of pictures) {
      const key = pictureKey(assetId, message.chunkIndex);
      if (this.disposed || !this.sources.has(assetId) || this.cache.has(key)) {
        this.client.releasePicture(message);
        continue;
      }
      const rotation = this.assetsById.get(assetId)?.media?.rotation ?? 0;
      const picture =
        message.picture.kind === 'i420' && rotation !== 0
          ? rotateI420(message.picture, rotation)
          : message.picture;
      this.cache.set(key, {
        kind: 'picture',
        picture,
        timestampUs: message.timestampUs,
        lastUsed: ++this.useCounter,
      });
      this.cacheBytes += picture.byteLength;
    }
    this.telemetry.gauge('pictureCacheBytes', this.cacheBytes);
  }

  // --- presentation --------------------------------------------------------------------------

  /**
   * A burned caption as the export draws it: the engine's own raster (styled cues through the
   * compiler's caption layer, at this frame's time), composited over the frame effects in the
   * clip's blend mode, with a frosted chip's blur. Without an engine, the baseline canvas raster
   * stands in and the monitor says the text is approximate.
   */
  private captionLayer(layer: FramePlanLayer, size: PixelSize): CompositeLayer | null | 'pending' {
    const request = this.captionRequest(layer, size);
    if (request === null || layer.text === null) return null;
    const engine = this.engineTexts.lookup(request);
    if (engine.state === 'pending') return 'pending';
    if (engine.state === 'ready') {
      const raster = engine.raster;
      return {
        kind: 'raster',
        key: `caption:${textRasterKey(request)}`,
        image: raster.image,
        width: raster.width,
        height: raster.height,
        x: raster.x ?? 0,
        y: raster.y ?? 0,
        blendMode: layer.blendMode,
        aboveEffects: true,
        ...(raster.backdrop === null
          ? {}
          : { frost: { coverage: raster.backdrop.coverage, sigmaPx: raster.backdrop.sigmaPx } }),
      };
    }
    if (!this.textFontReady) return null;
    const key = `${size.width}x${size.height}|${layer.text}`;
    let raster = this.captionRasters.get(key);
    if (raster === undefined) {
      raster = rasterizeBaselineCaption(layer.text, size.width, size.height);
      if (this.captionRasters.size > 256) this.captionRasters.clear();
      this.captionRasters.set(key, raster);
    }
    if (raster === null) return null;
    return {
      kind: 'raster',
      key: `caption:${key}`,
      image: raster.image,
      width: raster.width,
      height: raster.height,
      x: raster.x,
      y: raster.y,
      blendMode: layer.blendMode,
      aboveEffects: true,
    };
  }

  /** A text clip as the export rasterises and places it (PX2.3). */
  private textLayer(layer: FramePlanLayer, size: PixelSize): CompositeLayer | null | 'pending' {
    const request = this.textRequest(layer, size);
    if (request === null || layer.clipId === null) return null;
    const clip = this.clipsById.get(layer.clipId)!;
    const effect = clip.effects.find((candidate) => candidate.type === 'text')!;
    const engine = this.engineTexts.lookup(request);
    if (engine.state === 'pending') return 'pending';
    if (engine.state === 'ready') {
      const raster = engine.raster;
      const layout = textOverlayLayout(effect.params, size.width, size.height);
      const step = textRasterStep(layer, clip, raster, { x: layout.centreX, y: layout.centreY });
      if (step === null) return null;
      return {
        kind: 'picture',
        step,
        source: {
          kind: 'image',
          key: `text:${textRasterKey(request)}`,
          image: raster.image,
          width: raster.width,
          height: raster.height,
        },
      };
    }
    if (!this.textFontReady) return null;
    const key = `${size.width}x${size.height}|${JSON.stringify(effect.params)}`;
    let raster = this.textRasters.get(key);
    if (raster === undefined) {
      raster = rasterizeTextOverlay(effect.params, size.width, size.height);
      if (this.textRasters.size > 64) this.textRasters.clear();
      this.textRasters.set(key, raster);
    }
    if (raster === null) return null;
    const step = textRasterStep(layer, clip, raster, {
      x: raster.layout.centreX,
      y: raster.layout.centreY,
    });
    if (step === null) return null;
    return {
      kind: 'picture',
      step,
      source: {
        kind: 'image',
        key: `text:${key}`,
        image: raster.image,
        width: raster.width,
        height: raster.height,
      },
    };
  }

  /**
   * A shape as the export composites it (plan/elements EL4a, ADR 0190): the engine draws the
   * raster, the plan's bounds place it, and the title's placement step transforms it. There is no
   * canvas fallback: without an engine the shape is not drawn and the monitor says it is
   * approximate (the browser build's labelled approximation is EL11).
   */
  private shapeLayer(layer: FramePlanLayer, size: PixelSize): CompositeLayer | null | 'pending' {
    const request = this.shapeRequest(layer, size);
    if (request === null || layer.clipId === null || layer.shape === undefined) return null;
    const engine = this.engineTexts.lookup(request);
    if (engine.state === 'pending') return 'pending';
    if (engine.state !== 'ready') return null;
    const clip = this.clipsById.get(layer.clipId)!;
    const raster = engine.raster;
    const bounds = layer.shape;
    const step = textRasterStep(layer, clip, raster, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
    if (step === null) return null;
    return {
      kind: 'picture',
      step,
      source: {
        kind: 'image',
        key: `shape:${textRasterKey(request)}`,
        image: raster.image,
        width: raster.width,
        height: raster.height,
      },
    };
  }

  /** The engine raster request for a shape layer, or `null` when it has no shape effect. */
  private shapeRequest(layer: FramePlanLayer, size: PixelSize): PreviewTextRasterRequest | null {
    if (layer.kind !== 'shape' || layer.clipId === null) return null;
    const clip = this.clipsById.get(layer.clipId);
    const effect = clip?.effects.find((candidate) => candidate.type === SHAPE_EFFECT_TYPE);
    if (!clip || !effect) return null;
    return {
      kind: 'shape',
      params: effect.params,
      rotates: clip.keyframes.some((keyframe) => keyframe.property === 'rotation'),
      frameWidth: size.width,
      frameHeight: size.height,
    };
  }

  /** The engine raster request for a text layer, or `null` when it draws nothing. */
  private textRequest(layer: FramePlanLayer, size: PixelSize): PreviewTextRasterRequest | null {
    if (layer.kind !== 'text' || layer.clipId === null) return null;
    if (this.project?.hiddenOverlayIds?.has(layer.clipId)) return null;
    const clip = this.clipsById.get(layer.clipId);
    const effect = clip?.effects.find((candidate) => candidate.type === 'text');
    if (!clip || !effect || exportText(effect.params) === null) return null;
    return {
      kind: 'text',
      params: effect.params,
      frameWidth: size.width,
      frameHeight: size.height,
    };
  }

  /**
   * The engine raster request for a burned caption, or `null`. A styled cue carries what the
   * compiler's caption layer is built from — the track and cue styles as stored, the cue's timed
   * words, its span — and the time of this frame, because its entrance, per-word states and loops
   * move with it.
   */
  private captionRequest(layer: FramePlanLayer, size: PixelSize): PreviewTextRasterRequest | null {
    if (layer.kind !== 'caption' || layer.text === null || layer.clipId === null) return null;
    if (layer.text.trim() === '') return null;
    const baseline: PreviewTextRasterRequest = {
      kind: 'caption',
      text: layer.text,
      frameWidth: size.width,
      frameHeight: size.height,
    };
    const clip = this.clipsById.get(layer.clipId);
    const trackStyle = this.captionTrackStyles.get(layer.trackId);
    const clipStyle = clip?.captionStyle;
    if (clip === undefined || (trackStyle === undefined && clipStyle === undefined))
      return baseline;
    const cue = resolveCaptionCue(clip, this.project?.transcript ?? []);
    return {
      ...baseline,
      ...(trackStyle === undefined ? {} : { trackStyle }),
      ...(clipStyle === undefined ? {} : { clipStyle }),
      words: cue.words.map(({ word, start, end }) => ({ word, start, end })),
      clipStart: clip.start,
      clipEnd: clip.end,
      frameTime: clip.start + layer.localTime,
    };
  }

  private textRequestsOf(plan: FramePlan): PreviewTextRasterRequest[] {
    const size = { width: plan.width, height: plan.height };
    return plan.layers.flatMap((layer) => {
      const request =
        layer.kind === 'text'
          ? this.textRequest(layer, size)
          : layer.kind === 'caption'
            ? this.captionRequest(layer, size)
            : layer.kind === 'shape'
              ? this.shapeRequest(layer, size)
              : null;
      return request === null ? [] : [request];
    });
  }

  /**
   * Build the composite for `plan` from what is decoded. Returns `null` when a picture layer's
   * frame is not available (the caller keeps the previous presentation).
   */
  private compose(
    plan: FramePlan,
  ): { layers: CompositeLayer[]; presented: PresentedLayer[]; processing: boolean } | null {
    const project = this.project;
    if (!project) return null;
    const size = { width: plan.width, height: plan.height };
    const layers: CompositeLayer[] = [];
    // MK8.2: the plan layer each composite layer came from, so track mattes can be resolved.
    const origins: FramePlanLayer[] = [];
    const presented: PresentedLayer[] = [];
    // Filled in place, so an abandoned composite (a frame still decoding) still leaves the
    // states it reached behind for the diagnostic.
    const matteStates: MatteDebugState[] = [];
    this.lastMatteStates = matteStates;
    let processing = false;
    for (const layer of plan.layers) {
      if (layer.kind === 'caption' || layer.kind === 'text' || layer.kind === 'shape') {
        const raster =
          layer.kind === 'caption'
            ? this.captionLayer(layer, size)
            : layer.kind === 'shape'
              ? this.shapeLayer(layer, size)
              : this.textLayer(layer, size);
        // An engine raster still on its way: keep the previous presentation, as for a frame.
        if (raster === 'pending') return null;
        if (raster) {
          layers.push(raster);
          origins.push(layer);
        }
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
        origins.push(layer);
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
      if (cached?.kind !== 'picture') return null;
      cached.lastUsed = ++this.useCounter;
      const tracks = this.tracksOf(clip);
      // A track still loading: keep the previous presentation, as for a matte frame.
      if (tracks === 'pending') return null;
      let step = pictureRasterStep(
        layer,
        clip,
        asset,
        size,
        { width: cached.picture.width, height: cached.picture.height },
        tracks,
      );
      if (!step) continue;
      let mattes: MatteStackInputs | null = null;
      if (step.mask !== null && step.mask.stack.mattes.length > 0) {
        const frames = new Map<string, MatteFrameData | null>();
        const decoded =
          step.decode.kind === 'scaled'
            ? step.decode
            : { width: cached.picture.width, height: cached.picture.height };
        for (const mask of step.mask.stack.mattes) {
          const pictureSeconds = cached.timestampUs / 1_000_000;
          const found = this.mattes.lookup(mask, frame, pictureSeconds, decoded);
          matteStates.push({
            clipId: clip.id,
            maskId: mask.id,
            artifact: mask.artifact.key.slice(0, 12),
            sourceFrame: frame,
            pictureSeconds,
            state: found.state,
            code: found.state === 'refused' ? found.code : null,
            frameIndex: this.mattes.frameIndexFor(mask, frame),
            // The compositor takes the tier's planes whenever they fit, foreground or not, so
            // one frame is always drawn one way.
            fromTier:
              found.state === 'ready' &&
              mask.decontaminate &&
              planesFit(found.frame, decoded.width, decoded.height),
            // The compositor takes the alpha plane wherever it fits and the chain qualifies
            // (a keyframed control is judged per instant; its frames rarely carry a plane).
            alphaFromTier:
              found.state === 'ready' &&
              matteAlphaTierable(mask) &&
              alphaPlaneFits(found.frame, decoded.width, decoded.height),
            ...this.mattes.debugState(mask),
          });
          if (found.state === 'pending') return null;
          if (found.state === 'refused') {
            // The export refuses this clip; the monitor draws it unmasked and says why.
            step = {
              ...step,
              mask: null,
              maskRefusal: { clipId: clip.id, maskId: mask.id, task: null, message: found.message },
            };
            break;
          }
          if (found.state === 'unprocessed') processing = true;
          frames.set(mask.id, found.state === 'ready' ? found.frame : null);
        }
        if (step.mask !== null) {
          mattes = { decodedWidth: decoded.width, decodedHeight: decoded.height, frames };
        }
      }
      const viewed =
        layer.role === 'clip' && layer.clipId === this.maskViewClipId && step.mask !== null;
      const flagged =
        viewed && this.maskView === 'flagged' && step.mask !== null
          ? this.isFlagged(step.mask.stack.mattes, frame, layer.mask?.sourceTime ?? null)
          : false;
      layers.push({
        kind: 'picture',
        step: { ...step, frame },
        source: { kind: 'decoded', key, picture: cached.picture },
        ...(mattes !== null ? { mattes } : {}),
        ...(flagged ? { flagged } : {}),
        ...(layer.role === 'clip' && layer.clipId === this.maskViewClipId && step.mask !== null
          ? { maskView: this.maskView }
          : {}),
      });
      origins.push(layer);
      presented.push({
        role: layer.role === 'underlay' ? 'held' : 'clip',
        sourceId: asset.id,
        kind: 'video',
        timestampUs: cached.timestampUs,
      });
    }
    return { layers: withTrackMattes(origins, layers), presented, processing };
  }

  /**
   * BR5.2: whether a matte frame at source frame `sourceFrame` needs review: in the pack's
   * `report.json` flags (read once per artifact, digest-verified) or the mask's own review
   * ranges, and not approved. The report arrives asynchronously; the paused frame is presented
   * again when it does.
   */
  private isFlagged(
    mattes: readonly MatteMask[],
    sourceFrame: number,
    sourceTime: number | null,
  ): boolean {
    for (const mask of mattes) {
      const approved =
        sourceTime !== null &&
        mask.review.approved.some((r) => sourceTime >= r.start && sourceTime <= r.end);
      if (approved) continue;
      if (
        sourceTime !== null &&
        mask.review.flagged.some((r) => sourceTime >= r.start && sourceTime <= r.end)
      ) {
        return true;
      }
      const key = mask.artifact.key;
      if (!this.flaggedRanges.has(key)) {
        this.flaggedRanges.set(key, null);
        void this.mattes.flaggedRanges(mask).then((ranges) => {
          if (this.disposed) return;
          this.flaggedRanges.set(key, ranges);
          this.lastPresentedSignature = '';
          if (!this.playing && this.maskView === 'flagged') void this.seek(this.pausedAtSec);
        });
      }
      const ranges = this.flaggedRanges.get(key);
      const index = this.mattes.frameIndexFor(mask, sourceFrame);
      if (ranges && index !== null && isFlaggedFrame(ranges, index)) return true;
    }
    return false;
  }

  /** Tell the monitor whether a presented matte is still being processed (BR5.1). */
  private reportMatteProcessing(processing: boolean): void {
    if (processing === this.lastMatteProcessing) return;
    this.lastMatteProcessing = processing;
    if (processing) log.debug('presenting a frame whose matte is still processing');
    this.callbacks.onMatteProcessingChange?.(processing);
  }

  /** Composite and show `plan`. Returns false when a needed frame was missing. */
  private present(plan: FramePlan, timeSec: number, force: boolean, exact = false): boolean {
    const compositor = this.compositor;
    const project = this.project;
    if (!compositor || !project) return false;
    const composed = this.compose(plan);
    if (!composed) return false;
    this.reportMaskRefusal(composed.layers);
    this.reportMatteProcessing(composed.processing);
    this.lastPictureKeys = composed.layers.flatMap((layer) =>
      layer.kind === 'picture' && layer.source.kind === 'decoded' ? [layer.source.key] : [],
    );
    const signature = JSON.stringify([
      composed.presented,
      plan.layers.map((l) => [l.clipId, l.localTime, l.opacity, l.geometry]),
      plan.frameEffects.length > 0 ? timeSec : null,
      this.maskView,
      this.maskViewClipId,
      composed.layers.map((l) => (l.kind === 'picture' ? (l.flagged ?? false) : null)),
      composed.layers.map((l) =>
        l.kind === 'picture' && l.mattes
          ? [...l.mattes.frames].map(([id, f]) => `${id}=${f?.id ?? '-'}`)
          : null,
      ),
    ]);
    if (!force && signature === this.lastPresentedSignature) {
      this.presented = { projectTimeSec: timeSec, layers: composed.presented };
      return true;
    }
    const size = { width: plan.width, height: plan.height };
    const canvas = project.canvasSize;
    const frame = compositor.render(
      size,
      composed.layers,
      exact ? 'pixels' : 'bitmap',
      this.frameEffectsAt(plan, timeSec),
    );
    const ctx = this.ctx2d;
    if (ctx.canvas.width !== canvas.width) ctx.canvas.width = canvas.width;
    if (ctx.canvas.height !== canvas.height) ctx.canvas.height = canvas.height;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    const reduced = size.width !== canvas.width || size.height !== canvas.height;
    ctx.imageSmoothingEnabled = reduced;
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    if (frame instanceof ImageData) {
      ctx.putImageData(frame, 0, 0);
    } else {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
    // Closed on the NEXT present, not now: the 2D canvas may record the draw and rasterise it
    // later (at the next read or composite), and a closed bitmap then draws nothing.
    this.lastBitmap?.close();
    this.lastBitmap =
      typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap ? frame : null;
    this.lastPresentedSignature = signature;
    this.presented = { projectTimeSec: timeSec, layers: composed.presented };
    this.dbg.sourceDraws++;
    return true;
  }

  /** Live effect layers with their layer-relative clocks (schema v13; applied last, in order). */
  private frameEffectsAt(plan: FramePlan, timeSec: number): FrameEffectInstance[] {
    if (plan.frameEffects.length === 0) return [];
    const layers = new Map(
      (this.project?.timeline.tracks ?? []).flatMap((track) =>
        (track.effectLayers ?? []).map((layer) => [layer.id, layer] as const),
      ),
    );
    return plan.frameEffects.map((effect) => {
      const layer = layers.get(effect.layerId);
      const localTime = Math.max(0, timeSec - (layer?.start ?? timeSec));
      // MK5.2: a masked adjustment lane is limited to its stack's alpha, in output-frame
      // pixels, exactly as `apply_effect_layers` limits it on export.
      const stack = layer === undefined ? null : effectLayerMaskStack(layer);
      return {
        kind: effect.kind as FrameEffectInstance['kind'],
        params: effect.params,
        intensity: effect.intensity,
        localTime,
        duration: Math.max(0, (layer?.end ?? timeSec) - (layer?.start ?? timeSec)),
        mask:
          stack === null
            ? null
            : this.frameMaskRasters.raster(stack, plan.width, plan.height, localTime),
      };
    });
  }

  async seek(projectTimeSec: number): Promise<void> {
    if (this.disposed) return;
    if (this.playing) this.pause();
    const myGeneration = ++this.generation;
    const seekStarted = performance.now();
    const clamped = Math.min(this.durationSec, Math.max(0, projectTimeSec));
    // The latest REQUESTED time, recorded before any await: a project reload that re-presents
    // `pausedAtSec` while this seek is still waiting on media must land here, not on the time
    // before the seek (which then echoed back and dragged the editor's playhead to it).
    this.pausedAtSec = clamped;
    try {
      const plan = this.planAt(clamped);
      if (plan) {
        // PX5.3: this seek's matte frames replace whatever was waiting to decode (a superseded
        // seek's, or the decode-ahead window's when playback paused), so they are next - and
        // they start now, on the matte workers, while the pictures decode, not after them. The
        // re-plan below asks again, so a frame number that changes meanwhile is still covered.
        const matteNeeds = this.matteNeedsOf(plan);
        this.mattes.want(matteNeeds);
        if (matteNeeds.length > 0) {
          void this.stages.track(
            'matte.prefetch',
            `seek ${clamped}`,
            this.mattes.ensure(matteNeeds),
          );
        }
        const needs = this.needsOf(plan);
        const started = performance.now();
        await this.ensureFrames(needs);
        this.dbg.maxSeekMs = Math.max(this.dbg.maxSeekMs, performance.now() - started);
        if (this.disposed || this.generation !== myGeneration) return;
        // Re-plan: a source that finished loading meanwhile may have changed frame numbers.
        const current = this.planAt(clamped) ?? plan;
        this.mattes.want(this.matteNeedsOf(current));
        await Promise.all([
          this.ensureFrames(this.needsOf(current)),
          this.stages.track(
            'seek.texts',
            `seek ${clamped}`,
            this.engineTexts.ensure(this.textRequestsOf(current)),
          ),
          this.stages.track(
            'seek.mattes',
            `seek ${clamped}`,
            this.mattes.ensure(this.matteNeedsOf(current)),
          ),
          this.stages.track(
            'seek.tracks',
            `seek ${clamped}`,
            this.trackArtifacts.ensure(this.trackedMasksOf(current)),
          ),
        ]);
        if (this.disposed || this.generation !== myGeneration) return;
        // Superseded seeks returned above, so a sample is always a seek that reached the monitor.
        const compositeStarted = performance.now();
        if (this.present(current, clamped, true, true)) {
          const presentedAt = performance.now();
          this.telemetry.record('exactComposite', presentedAt - compositeStarted);
          this.telemetry.record('seekToPresent', presentedAt - seekStarted);
        }
        this.evict(
          new Set([
            ...this.needsOf(current).map((n) => pictureKey(n.assetId, n.frame)),
            ...this.matteNeedsOf(current).flatMap((n) => this.matteKeysOf(n)),
          ]),
        );
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
    const tracks = project.timeline.tracks;
    return this.programAudio.segmentsFrom(
      {
        timeline: project.timeline,
        kindOf: (clip) => {
          const kind = clipKind(clip, this.assetsById);
          return kind === 'video' || kind === 'audio' ? kind : 'other';
        },
        mutedTrackIds: effectiveMutedTrackIds(tracks, this.soloedTrackIds, this.assetsById),
        footage: (assetId) => {
          const source = this.sources.get(assetId);
          return source?.audioBuffer
            ? { buffer: source.audioBuffer, frameRate: source.frameRate }
            : undefined;
        },
      },
      startSec,
    );
  }

  /**
   * Monitor solo (H0.4 J2): soloed tracks sound and the other sound-bearing tracks fall silent.
   * Session-only, never the project; playing sound is rescheduled from where the clock is.
   */
  setSoloedTracks(trackIds: ReadonlySet<string>): void {
    const unchanged =
      trackIds.size === this.soloedTrackIds.size &&
      [...trackIds].every((id) => this.soloedTrackIds.has(id));
    if (unchanged) return;
    this.soloedTrackIds = new Set(trackIds);
    if (!this.playing || !this.audioClock) return;
    const nowUs = this.audioClock.nowMediaUs();
    this.audioClock.scheduleSegments(this.audioSegmentsFrom(nowUs / 1_000_000), nowUs);
  }

  async play(): Promise<void> {
    if (this.playing || this.starting || !this.audioClock || !this.project) return;
    this.starting = true;
    try {
      await this.stages.track(
        'play.audio',
        `context ${this.audioClock.contextState}`,
        this.audioClock.start(),
      );
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
    this.telemetry.playbackStarted(this.project.projectFps ?? DEFAULT_FPS);
    this.lastTickAtMs = null;
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
      const tickAtMs = performance.now();
      if (this.lastTickAtMs !== null) {
        this.telemetry.record('frameInterval', tickAtMs - this.lastTickAtMs);
      }
      this.lastTickAtMs = tickAtMs;
      // PX5.5: the frame the export shows now, at the instant the export composites it, so
      // the monitor presents the export's source frames and a project frame is composited
      // once however many display refreshes it spans (`clock/project-frame.ts`).
      const frameSec = projectFrameTime(nowSec, this.project?.projectFps ?? DEFAULT_FPS);
      const plan = this.planAt(frameSec, this.renderSize());
      if (plan) {
        const started = performance.now();
        const drawsBefore = this.dbg.sourceDraws;
        const presented = this.present(plan, frameSec, false);
        if (presented) {
          const compositeMs = performance.now() - started;
          this.dbg.presented++;
          if (this.dbg.sourceDraws !== drawsBefore) this.telemetry.record('composite', compositeMs);
          this.adaptRenderScale(compositeMs);
        } else {
          this.dbg.missing++;
        }
        this.telemetry.tick(nowSec, presented);
        this.pumpAhead(frameSec);
      }
      this.callbacks.onTimeUpdate?.(nowSec);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Step the playback render scale from the measured composite time (PX2.8). */
  private adaptRenderScale(compositeMs: number): void {
    const fps = this.project?.projectFps ?? DEFAULT_FPS;
    const budgetMs = 1000 / Math.max(1, fps);
    this.renderMsEma =
      this.renderMsEma === 0
        ? compositeMs
        : this.renderMsEma + (compositeMs - this.renderMsEma) * EMA_WEIGHT;
    this.slowTicks = this.renderMsEma > budgetMs * SLOW_SHARE ? this.slowTicks + 1 : 0;
    this.fastTicks = this.renderMsEma < budgetMs * FAST_SHARE ? this.fastTicks + 1 : 0;
    let next = this.renderScaleIndex;
    if (this.slowTicks >= SLOW_TICKS_TO_SHED && next < RENDER_SCALES.length - 1) next++;
    else if (this.fastTicks >= FAST_TICKS_TO_RESTORE && next > 0) next--;
    if (next === this.renderScaleIndex) return;
    this.renderScaleIndex = next;
    this.slowTicks = 0;
    this.fastTicks = 0;
    this.renderMsEma = 0;
    this.lastPresentedSignature = '';
    log.action('preview render scale changed', {
      scale: RENDER_SCALES[next],
      compositeMs: Math.round(compositeMs * 10) / 10,
      budgetMs: Math.round(budgetMs * 10) / 10,
    });
    this.telemetry.renderScaleChanged(RENDER_SCALES[next] ?? 1);
    this.callbacks.onRenderScaleChange?.(RENDER_SCALES[next] ?? 1);
  }

  /** Decode ahead of the playhead: the frames the next project frames will ask for. */
  private pumpAhead(nowSec: number): void {
    const fps = this.project?.projectFps ?? DEFAULT_FPS;
    const wanted = new Map<string, number[]>();
    const pinned = new Set<string>();
    const windowMattes: MatteNeed[] = [];
    for (let k = 0; k <= LOOKAHEAD_FRAMES; k++) {
      const t = nowSec + k / fps;
      if (t >= this.durationSec) break;
      const plan = this.planAt(t, this.renderSize());
      if (!plan) break;
      // Every frame of the window: an animated caption is one raster per frame. A title or a
      // still caption resolves to one cached raster, so asking again costs a map lookup.
      void this.engineTexts.ensure(this.textRequestsOf(plan));
      const matteNeeds = this.matteNeedsOf(plan);
      for (const need of matteNeeds) for (const key of this.matteKeysOf(need)) pinned.add(key);
      windowMattes.push(...matteNeeds);
      for (const need of this.needsOf(plan)) {
        const key = pictureKey(need.assetId, need.frame);
        pinned.add(key);
        if (this.cache.has(key)) continue;
        const frames = wanted.get(need.assetId) ?? [];
        frames.push(need.frame);
        wanted.set(need.assetId, frames);
      }
    }
    // PX5.3: the window, nearest frame first, replaces what the matte workers should decode;
    // a frame the playhead has passed is dropped while it waits instead of decoded late.
    this.mattes.want(windowMattes);
    if (windowMattes.length > 0) void this.mattes.ensure(windowMattes);
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

  /** The cache key a matte need occupies, once its artifact's index is known. */
  private matteKeysOf(need: MatteNeed): string[] {
    const key = this.mattes.cacheKeyFor(need.mask, need.sourceFrame);
    return key === null ? [] : [key];
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.telemetry.playbackStopped();
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
      renderScale: RENDER_SCALES[this.renderScaleIndex] ?? 1,
      cachedFrames: this.cache.size,
      cacheBytes: this.cacheBytes,
    };
  }

  /**
   * PX5.1: the engine's telemetry, with the decode worker's live-decoder count read fresh (the
   * pool lives in the worker, so it is asked rather than mirrored).
   */
  async debugTelemetry(): Promise<PreviewTelemetrySnapshot> {
    try {
      const pool = await this.stages.track(
        'telemetry.poolStats',
        '',
        this.client.decoderPoolStats(),
      );
      this.telemetry.gauge('liveDecoders', pool.peakLiveDecoders);
      this.telemetry.gauge('liveDecoders', pool.liveDecoders);
    } catch (err) {
      log.debug('decoder pool stats unavailable', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return this.telemetry.snapshot();
  }

  /**
   * PX5.7: what the monitor is waiting on right now — its own open stages, oldest first, and
   * the decode worker's report of each source's call (`null` when the worker did not answer).
   * Read by a hang report; nothing draws from it.
   */
  async debugInFlight(): Promise<{
    stages: StageSnapshot[];
    worker: WorkerStageReport[] | null;
    traffic: WorkerTraffic;
  }> {
    const traffic = this.client.debugTraffic();
    return {
      stages: this.stages.inFlight(),
      worker: await this.client.debugStages(WORKER_STAGES_TIMEOUT_MS),
      traffic,
    };
  }

  /** A stage passed {@link STAGE_STUCK_MS}: say which, and where the decode worker is. */
  private reportStuck(stuck: readonly StageSnapshot[]): void {
    const named = stuck.map((s) => `${s.stage} [${s.detail}] ${Math.round(s.ageMs)} ms`);
    const silentForMs = this.client.debugTraffic().silentForMs;
    log.warn('preview stage stuck', {
      stages: named,
      workerSilentForMs: silentForMs === null ? null : Math.round(silentForMs),
    });
    void this.client
      .debugStages(WORKER_STAGES_TIMEOUT_MS)
      .then((sessions) => {
        log.warn('decode worker at a stuck preview stage', {
          sessions:
            sessions === null
              ? 'worker did not answer'
              : sessions.map(
                  (w) =>
                    `${w.sourceId} ${w.stage} ${Math.round(w.ageMs)} ms [${w.from}-${w.to}] ` +
                    `decoder ${w.decoderState} queue ${w.decodeQueueSize} out ${w.lastOutputPresentation} ` +
                    `feed ${w.feedCursor} copies ${w.pendingCopies} waiting ${w.queuedCalls}`,
                ),
        });
      })
      .catch(() => undefined);
  }

  /** The last presented picture layers, back to front (the PX4 oracle's frame identity). */
  debugPresentedFrame(): PresentedFrame {
    return this.presented;
  }

  /** BR5.4 test hook: how each matte layer of the last composite resolved (parity triage). */
  debugPresentedMattes(): Record<string, unknown>[] {
    return this.lastMatteStates.map((state) => ({ ...state }));
  }

  /** Test hook: plane means of the decoded pictures the last composite read (readback triage). */
  debugPresentedPictures(): Record<string, unknown>[] {
    const mean = (plane: Uint8Array): number => {
      let sum = 0;
      for (let i = 0; i < plane.length; i += 97) sum += plane[i]!;
      return Math.round((sum / Math.max(1, Math.ceil(plane.length / 97))) * 10) / 10;
    };
    return this.lastPictureKeys.map((key) => {
      const entry = this.cache.get(key);
      if (!entry) return { key, cached: false };
      if (entry.kind !== 'picture') return { key, kind: 'matte' };
      const picture = entry.picture;
      if (picture.kind !== 'i420') return { key, kind: picture.kind };
      return {
        key,
        size: `${picture.width}x${picture.height}`,
        y: mean(picture.y),
        u: mean(picture.u),
        v: mean(picture.v),
        ts: entry.timestampUs,
      };
    });
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    this.stages.dispose();
    for (const [key, entry] of [...this.cache]) this.releaseEntry(key, entry);
    this.client.dispose();
    this.matteDecoders.dispose();
    this.compositor?.dispose();
    this.compositor = null;
    this.lastBitmap?.close();
    this.lastBitmap = null;
    for (const bitmap of this.images.values()) bitmap.close();
    this.images.clear();
    this.sources.clear();
    this.programAudio.dispose();
    this.project = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = undefined;
  }
}
