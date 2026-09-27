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
 *
 * Text never holds playback: a title, shape or caption raster the engine has not answered yet is
 * left out of that frame, and a styled caption whose frame has not arrived is drawn with the
 * nearest raster of the same cue (counted, `debugStats().textStale`). Caption frames are fetched
 * in windows ahead of the playhead ({@link TEXT_PREFETCH_HORIZON_SEC}). A paused frame is exact:
 * it waits for every raster, and pausing re-presents the frame that way.
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
import { projectFrameIndex, projectFrameTime } from '../clock/project-frame.js';
import type { FrameEffectInstance } from './gl/frame-effects.js';
import { LayerCompositor, type CompositeLayer, type LayerSource } from './layer-compositor.js';
import { pictureRasterStep, textRasterStep, type PixelSize } from './layer-raster.js';
import { withTrackMattes } from './track-mattes.js';
import {
  exportText,
  loadExportTextFont,
  rasterizeBaselineCaption,
  rasterizeTextOverlay,
  rotationSafe,
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
  type TextRasterLookupMode,
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
/**
 * How far ahead of the playhead text is fetched: titles and shapes once, styled captions as
 * windows of frames. Two seconds covers a cue's first window at the engine's speed (5-25 ms a
 * frame, two windows in flight) with room for a sidecar that is busy with something else.
 */
const TEXT_PREFETCH_HORIZON_SEC = 2;
/**
 * Frame plans kept: the look-ahead plans each project frame once, and the tick presents that
 * same plan when the frame comes up (`framePlanAt` is pure over the engine's inputs).
 */
const PLAN_CACHE_ENTRIES = 64;
/** How far ahead of the playhead a cut to another source starts decoding its first frames. */
const CUT_PREFETCH_HORIZON_SEC = 1.5;
/**
 * How long a paused frame waits for its text rasters. The engine answers in tens of
 * milliseconds; a sidecar busy exporting may take longer, and one that never answers must not
 * leave the monitor (and every seek queued behind it) on the previous frame. Past this the frame
 * is shown without the late text, and shown again exactly when it lands.
 */
const SEEK_TEXT_WAIT_MS = 1_500;
/**
 * Sound changes while playing (sources' tracks finishing decoding, an edit, a solo) are handed
 * over together after this long: each handover rebuilds the whole remaining mix on the main
 * thread, and a project's sources finish decoding within moments of each other.
 */
const SOUND_HANDOVER_COALESCE_MS = 150;

/** Whether `promise` settles (either way) within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

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
  /**
   * The source's sound, once decoded. Decoding a whole file's audio takes seconds for minutes of
   * media, so the picture does not wait for it: the source is shown first and the sound joins
   * playback when it is ready.
   */
  audioBuffer: AudioBuffer | undefined;
}

/** A caption clip the text prefetch fetches ahead: what the frame plan would draw for it. */
interface TextPrefetchCue {
  readonly clip: Clip;
  readonly trackId: string;
  readonly text: string;
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
  /** Caption requests without their frame time, per cue and size (see `captionRequestFor`). */
  private readonly captionRequests = new Map<string, PreviewTextRasterRequest>();
  private textFontReady = false;
  /** The engine's own Pillow rasters for text and captions (desktop; canvas fallback). */
  private readonly engineTexts: EngineTextRasters;

  /** Frame plans by render width and time (see {@link PLAN_CACHE_ENTRIES}). */
  private readonly planCache = new Map<string, FramePlan>();
  /** `sourceFps()` / `sourceFrameTimes()`, rebuilt only when the loaded sources change. */
  private sourceFpsCache: Map<string, number> | null = null;
  private sourceFrameTimesCache: Map<string, readonly number[]> | null = null;
  /** Burned caption cues by start, and titles and shapes by start (the text prefetch's index). */
  private textPrefetchCues: TextPrefetchCue[] = [];
  private textPrefetchOverlays: Clip[] = [];
  /** Picture clips by start: where upcoming cuts are (the cut prefetch's index). */
  private pictureClipStarts: { readonly start: number; readonly assetId: string }[] = [];
  /** The project frame the last playback tick presented, and whether it did. */
  private lastTickFrame: number | null = null;
  private lastTickWidth = 0;
  private lastTickPresented = false;
  /** Decodes in flight by picture key, so a seek waits on a window already asked for. */
  private readonly inFlightFrames = new Map<string, Promise<void>>();
  /** The latest paused seek not yet started, and the loop serving seeks one at a time. */
  private seekTarget: number | null = null;
  private seekLoop: Promise<void> | null = null;
  /** The newest project handed to {@link setProject}; an older queued one is skipped. */
  private latestProject: LayerEngineProject | null = null;
  /** A coalesced sound handover waiting to run (see {@link SOUND_HANDOVER_COALESCE_MS}). */
  private soundHandover: ReturnType<typeof setTimeout> | undefined;

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
    /** Playback frames a styled caption was drawn with a neighbouring frame's raster. */
    textStale: 0,
    /** Playback frames a text layer was left out of because its raster had not arrived. */
    textSkipped: 0,
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
   * new media is fetched, sources no clip references any more are released.
   *
   * Playback does not stop for it: the new media loads while the current project keeps playing,
   * then the project is swapped in one step and the sound is handed over from where the clock is
   * (an edit, an AI change or an asset update landing mid-play used to pause the monitor and
   * drag the playhead back to where playback began). Paused, it ends by presenting the current
   * time. A project replaced by a newer one while it waited in the queue is skipped.
   */
  setProject(project: LayerEngineProject): Promise<void> {
    this.latestProject = project;
    const run = this.loadQueue.then(() => this.setProjectSerialized(project));
    this.loadQueue = run.catch(() => undefined);
    return run;
  }

  private async setProjectSerialized(project: LayerEngineProject): Promise<void> {
    if (this.disposed || project !== this.latestProject) return;
    if (!this.audioCtx) {
      const audioCtx = new AudioContext();
      this.audioCtx = audioCtx;
      this.audioClock = new AudioMasterClock(audioCtx);
      this.audioClock.setGain(this.monitorGain);
      // A context the OS suspends or interrupts (an output device change, a call) stops the
      // clock the picture follows; the monitor then pauses rather than looking frozen.
      audioCtx.onstatechange = () => {
        if (!this.playing || audioCtx.state === 'running') return;
        log.warn('audio output stopped; pausing the monitor', { state: audioCtx.state });
        this.pause();
      };
    }
    const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
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
        const asset = assetsById.get(clip.assetId);
        const url = project.mediaUrls.get(clip.assetId);
        if (!asset || !url) continue;
        if (asset.kind === 'video') wantedVideo.set(asset.id, url);
        else if (asset.kind === 'image') wantedImages.add(url);
      }
    }
    // The picture first: sources (demuxed, registered), stills, LUTs and the text font. What is
    // already loaded costs nothing; the project on screen keeps presenting meanwhile.
    await Promise.all([
      ...[...wantedVideo].map(([assetId, url]) => this.loadVideo(assetId, url)),
      ...[...wantedImages].map((url) => this.loadImage(url)),
      ...[...wantedLuts].map((path) => this.loadLut(path)),
      loadExportTextFont().then((ready) => {
        this.textFontReady = ready;
      }),
    ]);
    if (this.disposed || project !== this.latestProject) return;
    this.swapProject(project, assetsById, wantedVideo, wantedImages);
    // The sound joins when it is decoded; the picture does not wait for minutes of audio.
    void this.programAudio
      .retain(project.timeline, project.assets, project.mediaUrls)
      .then(() => this.soundChanged())
      .catch((err: unknown) => {
        log.warn('program audio unavailable', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    if (this.playing && this.audioClock) {
      const nowSec = this.audioClock.nowMediaUs() / 1_000_000;
      if (nowSec >= this.durationSec) {
        this.pause();
        this.callbacks.onTimeUpdate?.(this.durationSec);
        return;
      }
      this.soundChanged();
      return;
    }
    await this.seek(Math.min(this.pausedAtSec, this.durationSec));
  }

  /** Make `project` the one composited, in one step, and release what it no longer uses. */
  private swapProject(
    project: LayerEngineProject,
    assetsById: Map<string, Asset>,
    wantedVideo: ReadonlyMap<string, string>,
    wantedImages: ReadonlySet<string>,
  ): void {
    this.project = project;
    this.planInputs.clear();
    this.invalidatePlans();
    this.assetsById = assetsById;
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
    this.engineTexts.setFrameRate(project.projectFps ?? DEFAULT_FPS);
    // Keyed by cue and size only: a restyled or retimed cue must not keep its old request.
    this.captionRequests.clear();
    this.indexPrefetch(project);
    this.lastPresentedSignature = '';
    this.lastTickFrame = null;
    for (const [assetId, source] of [...this.sources]) {
      if (wantedVideo.get(assetId) === source.url) continue;
      this.sources.delete(assetId);
      this.dropCachedAsset(assetId);
      this.invalidatePlans();
      void this.client.unloadSource(assetId).catch(() => undefined);
    }
    for (const [url, bitmap] of [...this.images]) {
      if (wantedImages.has(url)) continue;
      bitmap.close();
      this.images.delete(url);
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
    this.compositor?.setLuts(this.luts);
  }

  /**
   * What the text and cut prefetches read: caption cues the plan would burn (visible caption
   * tracks, non-empty cue text), titles and shapes, and picture clips, each by start.
   */
  private indexPrefetch(project: LayerEngineProject): void {
    const cues: TextPrefetchCue[] = [];
    const overlays: Clip[] = [];
    const pictures: { start: number; assetId: string }[] = [];
    const transcript = project.transcript ?? [];
    for (const track of project.timeline.tracks) {
      if (track.hidden === true) continue;
      for (const clip of track.clips) {
        if (track.type === 'caption') {
          if (project.burnCaptions !== true) continue;
          const text = resolveCaptionCue(clip, transcript).text;
          if (text.trim() !== '') cues.push({ clip, trackId: track.id, text });
          continue;
        }
        if (clip.effects.some((e) => e.type === 'text' || e.type === SHAPE_EFFECT_TYPE)) {
          overlays.push(clip);
          continue;
        }
        const asset = this.assetsById.get(clip.assetId);
        if (asset?.kind === 'video') pictures.push({ start: clip.start, assetId: asset.id });
      }
    }
    this.textPrefetchCues = cues.sort((a, b) => a.clip.start - b.clip.start);
    this.textPrefetchOverlays = overlays.sort((a, b) => a.start - b.start);
    this.pictureClipStarts = pictures.sort((a, b) => a.start - b.start);
  }

  /** Forget cached plans: an input they were computed from changed. */
  private invalidatePlans(): void {
    this.planCache.clear();
    this.sourceFpsCache = null;
    this.sourceFrameTimesCache = null;
  }

  /**
   * A source's sound arrived (or the mix changed): while playing, hand the sound over from where
   * the clock is, without a seam.
   */
  private soundChanged(): void {
    if (this.disposed || !this.playing || this.soundHandover !== undefined) return;
    this.soundHandover = setTimeout(() => {
      this.soundHandover = undefined;
      if (this.disposed || !this.playing || !this.audioClock) return;
      this.audioClock.rescheduleContinuous((mediaStartUs) =>
        this.audioSegmentsFrom(mediaStartUs / 1_000_000),
      );
    }, SOUND_HANDOVER_COALESCE_MS);
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
        const source: VideoSource = {
          url,
          frameCount: loaded.frameCount,
          frameRate: loaded.frameRate > 0 ? loaded.frameRate : 1_000_000 / loaded.frameDurationUs,
          frameTimesSec: loaded.frameTimesSec ?? null,
          timestampsUs: loaded.presentationTimestampsUs,
          audioBuffer: undefined,
        };
        this.sources.set(assetId, source);
        this.invalidatePlans();
        if (audioCtx && loaded.fileBytes.byteLength > 0) {
          void this.decodeSourceAudio(audioCtx, assetId, source, loaded.fileBytes);
        }
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

  /** Decode a source's sound after its picture is up; playing sound picks it up when ready. */
  private async decodeSourceAudio(
    audioCtx: AudioContext,
    assetId: string,
    source: VideoSource,
    fileBytes: ArrayBuffer,
  ): Promise<void> {
    const started = performance.now();
    try {
      const buffer = await audioCtx.decodeAudioData(fileBytes);
      if (this.disposed || this.sources.get(assetId) !== source) return;
      source.audioBuffer = buffer;
      log.debug('source sound decoded', {
        assetId,
        seconds: Math.round(buffer.duration),
        ms: Math.round(performance.now() - started),
      });
      this.soundChanged();
    } catch {
      // No decodable sound track (a silent or video-only file): the picture plays silent.
    }
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
    if (this.sourceFpsCache) return this.sourceFpsCache;
    const fps = new Map<string, number>();
    for (const [assetId, source] of this.sources) fps.set(assetId, source.frameRate);
    this.sourceFpsCache = fps;
    return fps;
  }

  /** Frame pts of the variable-rate sources, so the plan numbers their frames as the export. */
  private sourceFrameTimes(): Map<string, readonly number[]> {
    if (this.sourceFrameTimesCache) return this.sourceFrameTimesCache;
    const times = new Map<string, readonly number[]>();
    for (const [assetId, source] of this.sources) {
      if (source.frameTimesSec) times.set(assetId, source.frameTimesSec);
    }
    this.sourceFrameTimesCache = times;
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

  /**
   * The frame plan at `timeSec` for a `size` frame, from the plan cache when it has one: the
   * look-ahead plans each project frame once and the tick then presents that same plan.
   */
  private planAt(timeSec: number, size?: PixelSize): FramePlan | null {
    const project = this.project;
    const frame = size ?? project?.canvasSize;
    const inputs = frame ? this.inputsFor(frame) : null;
    if (!project || !inputs || !frame) return null;
    this.clipsById = inputs.clipsById;
    const key = `${frame.width}x${frame.height}@${timeSec}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;
    const plan = framePlanAt(inputs.timeline, project.assets, timeSec, frame, {
      sourceFps: this.sourceFps(),
      sourceFrameTimes: this.sourceFrameTimes(),
      burnCaptions: project.burnCaptions === true,
      ...(project.transcript ? { transcript: project.transcript } : {}),
    });
    if (this.planCache.size >= PLAN_CACHE_ENTRIES) {
      const oldest = this.planCache.keys().next().value;
      if (oldest !== undefined) this.planCache.delete(oldest);
    }
    this.planCache.set(key, plan);
    return plan;
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

  /**
   * Decode every missing frame of `needs`, contiguous runs per source. A frame a decode already in
   * flight will deliver (the look-ahead's window, another seek's) is waited for, not asked again:
   * the worker serves a source's calls in order, so a second ask queues a second keyframe seek.
   */
  private async ensureFrames(needs: readonly FrameNeed[]): Promise<void> {
    const waits = new Set<Promise<void>>();
    for (const need of needs) {
      const key = pictureKey(need.assetId, need.frame);
      if (this.cache.has(key)) continue;
      const pending = this.inFlightFrames.get(key);
      if (pending) waits.add(pending);
    }
    if (waits.size > 0) await Promise.all([...waits].map((wait) => wait.catch(() => undefined)));
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

  private decodeRun(assetId: string, from: number, to: number): Promise<void> {
    const run = this.decodeRunNow(assetId, from, to);
    const keys: string[] = [];
    for (let frame = from; frame <= to; frame++) {
      const key = pictureKey(assetId, frame);
      if (this.inFlightFrames.has(key)) continue;
      this.inFlightFrames.set(key, run);
      keys.push(key);
    }
    const settle = (): void => {
      for (const key of keys)
        if (this.inFlightFrames.get(key) === run) this.inFlightFrames.delete(key);
    };
    run.then(settle, settle);
    return run;
  }

  /**
   * The quarter turns a source's decoded planes need to stand upright: the asset's rotation for
   * the original file, none for its proxy. ffmpeg autorotates while it writes the proxy
   * (`media/derive.py` passes no `-noautorotate`), so turning the proxy's planes again showed
   * rotated phone footage sideways on the monitor while the export (the original, autorotated
   * by ffmpeg) was upright.
   */
  private decodedRotation(assetId: string): number {
    const asset = this.assetsById.get(assetId);
    const rotation = asset?.media?.rotation ?? 0;
    if (rotation === 0) return 0;
    const proxy = asset?.media?.proxyPath;
    const url = this.sources.get(assetId)?.url;
    return proxy && url === mediaSrc(proxy) ? 0 : rotation;
  }

  private async decodeRunNow(assetId: string, from: number, to: number): Promise<void> {
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
      const rotation = this.decodedRotation(assetId);
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
  private captionLayer(
    layer: FramePlanLayer,
    size: PixelSize,
    mode: TextRasterLookupMode,
  ): CompositeLayer | null | 'pending' {
    const request = this.captionRequest(layer, size);
    if (request === null || layer.text === null) return null;
    const engine = this.engineTexts.lookup(request, mode);
    if (engine.state === 'pending') return 'pending';
    if (engine.state === 'ready') {
      if (engine.stale === true) this.dbg.textStale++;
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

  /**
   * A title's edge-style lengths are frame pixels at the project's own size (EL2b): raster pixels
   * per project pixel at this render size, as `_title_edge_size` makes the export's scale.
   */
  private titleFrameScale(size: PixelSize): { readonly frameScale: number } {
    const project = this.project?.projectResolution ?? size;
    const factor = Math.min(
      Math.max(1, project.width) / size.width,
      Math.max(1, project.height) / size.height,
    );
    return { frameScale: 1 / factor };
  }

  /** A text clip as the export rasterises and places it (PX2.3). */
  private textLayer(
    layer: FramePlanLayer,
    size: PixelSize,
    mode: TextRasterLookupMode,
  ): CompositeLayer | null | 'pending' {
    const request = this.textRequest(layer, size);
    if (request === null || layer.clipId === null) return null;
    const clip = this.clipsById.get(layer.clipId)!;
    const effect = clip.effects.find((candidate) => candidate.type === 'text')!;
    const engine = this.engineTexts.lookup(request, mode);
    if (engine.state === 'pending') return 'pending';
    if (engine.state === 'ready') {
      const raster = engine.raster;
      const layout = textOverlayLayout(effect.params, size.width, size.height);
      const step = textRasterStep(
        layer,
        clip,
        raster,
        { x: layout.centreX, y: layout.centreY },
        this.titleFrameScale(size),
      );
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
    const rotates = clip.keyframes.some((keyframe) => keyframe.property === 'rotation');
    const key = `${size.width}x${size.height}|${String(rotates)}|${JSON.stringify(effect.params)}`;
    let raster = this.textRasters.get(key);
    if (raster === undefined) {
      const drawn = rasterizeTextOverlay(effect.params, size.width, size.height);
      raster = drawn !== null && rotates ? rotationSafe(drawn) : drawn;
      if (this.textRasters.size > 64) this.textRasters.clear();
      this.textRasters.set(key, raster);
    }
    if (raster === null) return null;
    const step = textRasterStep(
      layer,
      clip,
      raster,
      { x: raster.layout.centreX, y: raster.layout.centreY },
      this.titleFrameScale(size),
    );
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
  private shapeLayer(
    layer: FramePlanLayer,
    size: PixelSize,
    mode: TextRasterLookupMode,
  ): CompositeLayer | null | 'pending' {
    const request = this.shapeRequest(layer, size);
    if (request === null || layer.clipId === null || layer.shape === undefined) return null;
    const engine = this.engineTexts.lookup(request, mode);
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
    return clip ? this.shapeRequestFor(clip, size) : null;
  }

  private shapeRequestFor(clip: Clip, size: PixelSize): PreviewTextRasterRequest | null {
    const effect = clip.effects.find((candidate) => candidate.type === SHAPE_EFFECT_TYPE);
    if (!effect) return null;
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
    const clip = this.clipsById.get(layer.clipId);
    return clip ? this.textRequestFor(clip, size) : null;
  }

  private textRequestFor(clip: Clip, size: PixelSize): PreviewTextRasterRequest | null {
    if (this.project?.hiddenOverlayIds?.has(clip.id)) return null;
    const effect = clip.effects.find((candidate) => candidate.type === 'text');
    if (!effect || exportText(effect.params) === null) return null;
    return {
      kind: 'text',
      params: effect.params,
      // EL2b.4: a turning title is drawn in the rotation-safe square the export turns it inside.
      ...(clip.keyframes.some((keyframe) => keyframe.property === 'rotation')
        ? { rotates: true }
        : {}),
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
    const clip = this.clipsById.get(layer.clipId);
    return this.captionRequestFor(
      clip,
      layer.trackId,
      layer.text,
      size,
      clip === undefined ? undefined : clip.start + layer.localTime,
    );
  }

  /**
   * A caption cue's request at `frameTime` (the frame plan's layer time, or any time for the
   * prefetch, which only reads the cue's static half). Built once per cue and size: the cue's
   * words are resolved from the transcript, which is linear in its length.
   */
  private captionRequestFor(
    clip: Clip | undefined,
    trackId: string,
    text: string,
    size: PixelSize,
    frameTime: number | undefined,
  ): PreviewTextRasterRequest | null {
    if (text.trim() === '') return null;
    const cacheKey = `${clip?.id ?? ''}|${trackId}|${size.width}x${size.height}|${text}`;
    let base = this.captionRequests.get(cacheKey);
    if (base === undefined) {
      base = { kind: 'caption', text, frameWidth: size.width, frameHeight: size.height };
      const trackStyle = this.captionTrackStyles.get(trackId);
      const clipStyle = clip?.captionStyle;
      if (clip !== undefined && (trackStyle !== undefined || clipStyle !== undefined)) {
        const cue = resolveCaptionCue(clip, this.project?.transcript ?? []);
        base = {
          ...base,
          ...(trackStyle === undefined ? {} : { trackStyle }),
          ...(clipStyle === undefined ? {} : { clipStyle }),
          words: cue.words.map(({ word, start, end }) => ({ word, start, end })),
          clipStart: clip.start,
          clipEnd: clip.end,
        };
      }
      if (this.captionRequests.size > 512) this.captionRequests.clear();
      this.captionRequests.set(cacheKey, base);
    }
    const styled = base.trackStyle !== undefined || base.clipStyle !== undefined;
    return styled && frameTime !== undefined ? { ...base, frameTime } : base;
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
    mode: TextRasterLookupMode = 'exact',
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
            ? this.captionLayer(layer, size, mode)
            : layer.kind === 'shape'
              ? this.shapeLayer(layer, size, mode)
              : this.textLayer(layer, size, mode);
        if (raster === 'pending') {
          // A paused frame waits for its raster (keep the previous presentation, as for a
          // frame). Playback never does: the picture moves on and the text joins when it lands.
          if (mode === 'exact') return null;
          this.dbg.textSkipped++;
          continue;
        }
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
  /**
   * @param exact - A paused frame: full resolution, read back exactly.
   * @param textMode - Whether text rasters are waited for (`exact`) or left out until they land
   *   (`playback`); defaults to follow `exact`.
   */
  private present(
    plan: FramePlan,
    timeSec: number,
    force: boolean,
    exact = false,
    textMode: TextRasterLookupMode = exact ? 'exact' : 'playback',
  ): boolean {
    const compositor = this.compositor;
    const project = this.project;
    if (!compositor || !project) return false;
    const composed = this.compose(plan, textMode);
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
      composed.layers.map((l) =>
        l.kind === 'picture' ? (l.flagged ?? false) : l.kind === 'raster' ? l.key : null,
      ),
      composed.layers.map((l) =>
        l.kind === 'picture' && l.source.kind === 'image' ? l.source.key : null,
      ),
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

  /**
   * Show `projectTimeSec`. Paused, the frame is composited exactly (full resolution, every text
   * raster waited for). Seeks are served one at a time and the latest wins: a scrub sends one
   * per pointer move, and each used to queue its own keyframe decode behind the last, so nothing
   * was drawn until the drag ended. While playing, playback continues from the new time.
   *
   * @returns Once the latest requested time is on the monitor (or superseded by playback).
   */
  seek(projectTimeSec: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const clamped = Math.min(this.durationSec, Math.max(0, projectTimeSec));
    if (this.playing) {
      this.reposition(clamped);
      return Promise.resolve();
    }
    // The latest REQUESTED time, recorded before any await: a project reload that re-presents
    // `pausedAtSec` while this seek is still waiting on media must land here, not on the time
    // before the seek (which then echoed back and dragged the editor's playhead to it).
    this.pausedAtSec = clamped;
    this.seekTarget = clamped;
    this.seekLoop ??= this.serveSeeks();
    return this.seekLoop;
  }

  /** Serve {@link seekTarget} until none is left; the newest target replaces a waiting one. */
  private async serveSeeks(): Promise<void> {
    try {
      for (;;) {
        const target = this.seekTarget;
        // Cleared in the same turn the last target is read, so a seek arriving after this loop
        // has returned starts a new one instead of joining a loop that has finished.
        if (target === null || this.disposed) return;
        this.seekTarget = null;
        if (this.playing) {
          this.reposition(target);
          return;
        }
        await this.seekNow(target);
      }
    } finally {
      this.seekLoop = null;
    }
  }

  /** Move playback to `timeSec` without stopping it (a transport seek or scrub while playing). */
  private reposition(timeSec: number): void {
    if (!this.audioClock) return;
    if (timeSec >= this.durationSec) {
      // To the very end: stop there, as reaching it does.
      this.pause();
      void this.seek(this.durationSec);
      return;
    }
    const startSec = timeSec;
    this.generation++;
    this.audioClock.scheduleSegments(this.audioSegmentsFrom(startSec), startSec * 1_000_000);
    this.lastTickFrame = null;
    const fps = this.project?.projectFps ?? DEFAULT_FPS;
    const frameSec = projectFrameTime(startSec, fps);
    this.pumpAhead(frameSec);
    this.prefetchText(frameSec);
    this.callbacks.onTimeUpdate?.(startSec);
  }

  /** One paused seek, start to presented frame (the loop in {@link seek} serves them in turn). */
  private async seekNow(clamped: number): Promise<void> {
    if (this.disposed) return;
    const myGeneration = ++this.generation;
    const seekStarted = performance.now();
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
        const texts = this.stages.track(
          'seek.texts',
          `seek ${clamped}`,
          this.engineTexts.ensure(this.textRequestsOf(current)),
        );
        let textsLate = false;
        await Promise.all([
          this.ensureFrames(this.needsOf(current)),
          settlesWithin(texts, SEEK_TEXT_WAIT_MS).then((inTime) => {
            textsLate = !inTime;
          }),
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
        // The window this paused frame sits in, so pressing play is smooth from the first frame.
        this.prefetchText(projectFrameTime(clamped, this.project?.projectFps ?? DEFAULT_FPS));
        // Superseded seeks returned above, so a sample is always a seek that reached the monitor.
        const compositeStarted = performance.now();
        if (this.present(current, clamped, true, true, textsLate ? 'playback' : 'exact')) {
          const presentedAt = performance.now();
          this.telemetry.record('exactComposite', presentedAt - compositeStarted);
          this.telemetry.record('seekToPresent', presentedAt - seekStarted);
        }
        if (textsLate) {
          log.warn('paused frame shown before its text arrived; it is redrawn when it does', {
            atSec: clamped,
            waitedMs: SEEK_TEXT_WAIT_MS,
          });
          void texts.then(() => {
            if (this.disposed || this.playing || this.generation !== myGeneration) return;
            this.present(current, clamped, true, true);
          });
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
    // A newer seek waiting behind this one owns the paused time and the playhead.
    if (this.seekTarget !== null) return;
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
    this.soundChanged();
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
    // A paused seek still waiting is where the user asked to be: play from there.
    if (this.seekTarget !== null) {
      this.pausedAtSec = this.seekTarget;
      this.seekTarget = null;
    }
    this.generation++;
    this.playing = true;
    this.starting = false;
    this.callbacks.onPlayingChange?.(true);
    this.dbg = {
      ticks: 0,
      presented: 0,
      missing: 0,
      maxSeekMs: 0,
      maxDecodeMs: 0,
      sourceDraws: 0,
      textStale: 0,
      textSkipped: 0,
    };
    this.telemetry.playbackStarted(this.project.projectFps ?? DEFAULT_FPS);
    this.lastTickAtMs = null;
    this.lastTickFrame = null;
    const startSec = this.pausedAtSec >= this.durationSec ? 0 : this.pausedAtSec;
    this.audioClock.scheduleSegments(this.audioSegmentsFrom(startSec), startSec * 1_000_000);
    this.prefetchText(projectFrameTime(startSec, this.project.projectFps ?? DEFAULT_FPS));

    const tick = (): void => {
      if (!this.playing || !this.audioClock) return;
      const nowSec = this.audioClock.nowMediaUs() / 1_000_000;
      if (nowSec >= this.durationSec) {
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
      const fps = this.project?.projectFps ?? DEFAULT_FPS;
      const frameIndex = projectFrameIndex(nowSec, fps);
      const size = this.renderSize();
      // A display refresh inside a project frame already on the monitor (a 120 Hz panel shows
      // each 30 fps frame four times): nothing to plan, composite or fetch.
      if (
        frameIndex === this.lastTickFrame &&
        size.width === this.lastTickWidth &&
        this.lastTickPresented
      ) {
        this.telemetry.tick(nowSec, true);
        this.callbacks.onTimeUpdate?.(nowSec);
        this.rafHandle = requestAnimationFrame(tick);
        return;
      }
      const newFrame = frameIndex !== this.lastTickFrame;
      // PX5.5: the frame the export shows now, at the instant the export composites it, so
      // the monitor presents the export's source frames and a project frame is composited
      // once however many display refreshes it spans (`clock/project-frame.ts`).
      const frameSec = projectFrameTime(nowSec, fps);
      const plan = this.planAt(frameSec, size);
      let presented = false;
      if (plan) {
        const started = performance.now();
        const drawsBefore = this.dbg.sourceDraws;
        presented = this.present(plan, frameSec, false);
        if (presented) {
          this.dbg.presented++;
          // Only a frame that was composited measures the compositor; an unchanged one did no work.
          if (this.dbg.sourceDraws !== drawsBefore) {
            const compositeMs = performance.now() - started;
            this.telemetry.record('composite', compositeMs);
            this.adaptRenderScale(compositeMs);
          }
        } else {
          this.dbg.missing++;
        }
        this.telemetry.tick(nowSec, presented);
        // A retry of a missing frame changes nothing ahead; a new frame moves the windows on.
        if (newFrame) {
          this.pumpAhead(frameSec);
          this.prefetchText(frameSec);
        }
      }
      this.lastTickFrame = frameIndex;
      this.lastTickWidth = size.width;
      this.lastTickPresented = presented;
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
    // Text rasters are drawn for the frame size, so the new size needs its own: ask now rather
    // than at the next project frame, since until they land that text is left out of playback.
    if (this.audioClock) {
      this.prefetchText(projectFrameTime(this.audioClock.nowMediaUs() / 1_000_000, fps));
    }
  }

  /**
   * Decode ahead of the playhead: the frames the next project frames will ask for, nearest
   * first per source, and the first frames of cuts to other sources a little further out.
   */
  private pumpAhead(nowSec: number): void {
    const fps = this.project?.projectFps ?? DEFAULT_FPS;
    const size = this.renderSize();
    /** Per source, the frames the window needs and does not hold, in the order they are shown. */
    const wanted = new Map<string, number[]>();
    const pinned = new Set<string>();
    const windowMattes: MatteNeed[] = [];
    /** Per source, the frame the window's last plan shows (a clip that runs past the window). */
    const lastShown = new Map<string, number>();
    let windowEndSec = nowSec;
    for (let k = 0; k <= LOOKAHEAD_FRAMES; k++) {
      const t = nowSec + k / fps;
      if (t >= this.durationSec) break;
      const plan = this.planAt(t, size);
      if (!plan) break;
      windowEndSec = t;
      const matteNeeds = this.matteNeedsOf(plan);
      for (const need of matteNeeds) for (const key of this.matteKeysOf(need)) pinned.add(key);
      windowMattes.push(...matteNeeds);
      const needs = this.needsOf(plan);
      if (k === LOOKAHEAD_FRAMES) for (const need of needs) lastShown.set(need.assetId, need.frame);
      for (const need of needs) {
        const key = pictureKey(need.assetId, need.frame);
        pinned.add(key);
        if (this.cache.has(key) || this.inFlightFrames.has(key)) continue;
        const frames = wanted.get(need.assetId) ?? [];
        if (!frames.includes(need.frame)) frames.push(need.frame);
        wanted.set(need.assetId, frames);
      }
    }
    // Cuts to another source just past the window: its first frames start decoding now, on that
    // source's own decoder, so the cut does not wait on a keyframe seek (a camera original's GOP
    // can take longer than the window to reach). Same-source cuts are left to the window: the
    // source's one decoder is busy with the clip on screen.
    for (const cut of this.upcomingCuts(windowEndSec, nowSec + CUT_PREFETCH_HORIZON_SEC)) {
      if (wanted.has(cut.assetId) || lastShown.has(cut.assetId)) continue;
      // The first export frame the incoming clip is on screen for.
      const plan = this.planAt(Math.ceil(cut.start * fps - 1e-6) / fps, size);
      for (const need of plan ? this.needsOf(plan) : []) {
        if (need.assetId !== cut.assetId) continue;
        const key = pictureKey(need.assetId, need.frame);
        pinned.add(key);
        if (this.cache.has(key) || this.inFlightFrames.has(key)) continue;
        wanted.set(need.assetId, [need.frame]);
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
      const info = this.sources.get(assetId);
      if (!info) continue;
      // The nearest frame first, not the lowest index: after a same-source cut the lowest is the
      // clip leaving the screen. The run follows the frames shown next while they move forward,
      // and continues past the window only when the clip does.
      const first = frames[0]!;
      let runEnd = first;
      for (const frame of frames.slice(1)) {
        if (frame <= runEnd || frame - runEnd > DECODE_WINDOW) break;
        runEnd = frame;
      }
      const continues = lastShown.get(assetId) === runEnd;
      const last = Math.min(
        info.frameCount - 1,
        first + DECODE_WINDOW - 1,
        continues ? Number.POSITIVE_INFINITY : Math.max(first, runEnd),
      );
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

  /** Picture clips starting in `(fromSec, toSec]`, by start (from the prefetch index). */
  private upcomingCuts(fromSec: number, toSec: number): { start: number; assetId: string }[] {
    const starts = this.pictureClipStarts;
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]!.start <= fromSec) lo = mid + 1;
      else hi = mid;
    }
    const cuts: { start: number; assetId: string }[] = [];
    for (let i = lo; i < starts.length && starts[i]!.start <= toSec; i++) cuts.push(starts[i]!);
    return cuts;
  }

  /**
   * Fetch ahead what text playback will draw in the next {@link TEXT_PREFETCH_HORIZON_SEC}:
   * each title and shape once, and each styled caption cue as windows of its frames (at the
   * render size playback composites at).
   */
  private prefetchText(nowSec: number): void {
    const project = this.project;
    if (!project) return;
    const fps = project.projectFps ?? DEFAULT_FPS;
    const size = this.renderSize();
    const horizonSec = nowSec + TEXT_PREFETCH_HORIZON_SEC;
    const playheadFrame = projectFrameIndex(nowSec, fps);
    const singles: PreviewTextRasterRequest[] = [];
    for (const clip of this.textPrefetchOverlays) {
      if (clip.start > horizonSec) break;
      if (clip.end <= nowSec) continue;
      const request = this.textRequestFor(clip, size) ?? this.shapeRequestFor(clip, size);
      if (request !== null) singles.push(request);
    }
    for (const cue of this.textPrefetchCues) {
      const { clip } = cue;
      if (clip.start > horizonSec) break;
      if (clip.end <= nowSec) continue;
      const request = this.captionRequestFor(clip, cue.trackId, cue.text, size, clip.start);
      if (request === null) continue;
      if (request.frameTime === undefined) {
        singles.push(request);
        continue;
      }
      // The export frames `k / fps` the cue is on screen for, from the playhead to the horizon.
      const from = Math.max(playheadFrame, Math.ceil(clip.start * fps - 1e-6));
      const to = Math.min(
        Math.floor(horizonSec * fps + 1e-6),
        Math.ceil(clip.end * fps - 1e-6) - 1,
      );
      if (to < from) continue;
      const frames: number[] = [];
      for (let frame = from; frame <= to; frame++) frames.push(frame);
      this.engineTexts.prefetch(request, frames, playheadFrame);
    }
    if (singles.length > 0) void this.engineTexts.ensure(singles);
  }

  /** The cache key a matte need occupies, once its artifact's index is known. */
  private matteKeysOf(need: MatteNeed): string[] {
    const key = this.mattes.cacheKeyFor(need.mask, need.sourceFrame);
    return key === null ? [] : [key];
  }

  pause(): void {
    if (!this.playing) return;
    // Where playback actually stopped: the next play, seek or project reload starts from here
    // (it used to be left at the time play began, so resuming jumped back).
    if (this.audioClock) {
      const stoppedAt = this.audioClock.nowMediaUs() / 1_000_000;
      this.pausedAtSec = Math.min(this.durationSec, Math.max(0, stoppedAt));
    }
    this.playing = false;
    if (this.soundHandover !== undefined) {
      clearTimeout(this.soundHandover);
      this.soundHandover = undefined;
    }
    this.telemetry.playbackStopped();
    this.audioClock?.clear();
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    log.debug('playback paused', {
      atSec: Math.round(this.pausedAtSec * 1000) / 1000,
      ticks: this.dbg.ticks,
      presented: this.dbg.presented,
      missing: this.dbg.missing,
      textStale: this.dbg.textStale,
      textSkipped: this.dbg.textSkipped,
    });
    this.callbacks.onPlayingChange?.(false);
    // The paused frame is exact: full resolution, and the text rasters of this very frame
    // (playback may have drawn it smaller, or with a neighbouring frame's caption).
    if (!this.disposed) void this.seek(this.pausedAtSec);
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
    // Disposed first, so pausing does not start re-presenting the paused frame.
    this.disposed = true;
    this.pause();
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
