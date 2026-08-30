/**
 * Real multi-clip WebCodecs preview engine (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md, P1 single-clip + P2 multi-clip
 * continuity) — NOT spike code. Drives one `<canvas>` from an ordered EDL of
 * segments (video/image clips and gaps): play/pause/seek/scrub parity with
 * the DOM `<video>`-pool `PreviewPlayer`, on the audio-master clock (footage
 * audio via WebAudio, never a sidecar `<video>`), frame-exact swaps at cut
 * boundaries, gaps handled (nothing drawn), gapless audio scheduling across
 * cuts.
 *
 * Scope boundary (the caller decides eligibility via `canvasPreviewEligible`
 * before ever constructing this): P3a composites per-clip transform (keyframed
 * scale/x/y), crop, grade and blend mode in the canvas pass (see
 * `drawSource`), plus the transition entering a clip (opacity/geometry/blur/
 * wipe envelopes shared with the export via `transition-envelope.ts`);
 * P3b composites text/caption overlays on top (see
 * `setOverlays`/`drawOverlays`). Still no overlapping picture clips and no
 * speed ramps (P4) — one picture segment active at a time. Still image clips
 * are drawn from a decoded `<img>` rather than `VideoDecoder`.
 *
 * Reuses the P0 spike's verified building blocks: `DecodeWorkerClient`
 * (worker protocol + frame accounting, one long-lived decoder session per
 * unique source, reused across every segment referencing it), `FrameRing`
 * (bounded decode-ahead jitter buffer), `AudioMasterClock` (real
 * `AudioContext`-driven clock, video frame selection slaved to it — never
 * rAF-only timekeeping). The windowed, ring-paced pump is the exact design
 * the P0 A/V-sync gate proved out for a multi-segment, multi-source EDL;
 * this productionizes it against the real timeline instead of a synthetic one.
 */
import { NO_TRANSITION, pictureTransformAt } from '../picture-transform.js';
import { DecodeWorkerClient } from '../decode/worker-client.js';
import { FrameRing, type Closable } from '../decode/frame-ring.js';
import { presentationIndexAtOrBefore } from '../demux/mp4-demuxer.js';
import { AudioMasterClock } from '../clock/audio-clock.js';
import { GlEffectChain } from '../effects/gl-effect-chain.js';
import type { TimedEffectLayer } from '../effects/gl-effect-chain.js';
import { cropFillPlacement } from '../crop-fill.js';
import { heldFrameIsPreviousSegment } from '../held-frame.js';
import {
  type ClipCompositing,
  colorGradeCssFilter,
  isFullFrameCrop,
  isIdentityCompositing,
  isIdentityGrade,
} from '../../editor/selectors.js';
import type { OverlayClip } from '../../editor/patch-builders.js';
import {
  blurRadiusAt,
  offsetAt,
  opacityAt,
  scaleAt as transitionScaleAt,
  transitionActiveAt,
  wipeAxis,
  wipeEdge,
  wipeProgressAt,
  wipeSoftness,
  type TransitionEnvelope,
} from '../transition-envelope.js';
import { sharedTransitionChain } from '../transitions/gl-transition-chain.js';
import type { ResolvedTransition } from '../transitions/transition-engine.js';
import { transitionProgressAt } from '@framepilot/editor-core';
import { paintTextOverlay } from './overlay-painter.js';
import { activeTimedItemsAt, buildTemporalIndex, type TemporalIndex } from '../temporal-index.js';

/** Project canvas dimensions, for the transform px→frame-fraction conversion
 * (H4 transforms author `x`/`y` in project-canvas pixels). */
export interface Resolution {
  readonly width: number;
  readonly height: number;
}

const DEFAULT_RESOLUTION: Resolution = { width: 1280, height: 720 };

/** Intrinsic pixel size of a picture source (a decoded `VideoFrame` or a
 * still `<img>`), for the letterbox `contain` fit. */
function sourceDims(source: CanvasImageSource): { w: number; h: number } {
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { w: source.displayWidth, h: source.displayHeight };
  }
  const s = source as {
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  return { w: s.naturalWidth ?? s.width ?? 0, h: s.naturalHeight ?? s.height ?? 0 };
}

export interface PreviewEngineCallbacks {
  onTimeUpdate?(currentTimeSec: number): void;
  onDurationChange?(durationSec: number): void;
  onPlayingChange?(playing: boolean): void;
  onError?(message: string): void;
}

/** One span of the engine's input EDL, in PROJECT-timeline seconds.
 * `sourceId`/`url` absent = a gap (nothing drawn, silence). `kind: 'image'`
 * sources are fetched as an `<img>`, never demuxed/decoded via WebCodecs. */
export interface EngineSegment {
  readonly projectStart: number;
  readonly projectEnd: number;
  readonly sourceId?: string;
  readonly url?: string;
  readonly kind?: 'video' | 'image';
  /** Source-time in-point (seconds) this segment plays from — ignored for gaps/images. */
  readonly sourceStart: number;
  /** Source-time out-point (seconds) — ignored for gaps/images. */
  readonly sourceEnd: number;
  /** Per-clip compositing for the canvas pass (P3a): transform/crop/grade/
   * blend. Absent on gaps; when absent (or identity) the frame is drawn
   * plain, full-frame. Transform keyframes are evaluated against clip-relative
   * time = projectTime − projectStart (a picture segment spans exactly one
   * clip, so its `projectStart` is that clip's start). */
  readonly compositing?: ClipCompositing;
}

interface TaggedFrame extends Closable {
  videoFrame: VideoFrame;
  chunkIndex: number;
  /** Which EDL segment this frame was decoded for — lets the presentation
   * loop tell "the frame active now" from a stale frame left over from the
   * previous segment (the jitter signal). */
  segmentIndex: number;
}

interface SourceInfo {
  frameCount: number;
  /** Typical frame duration (µs) — a display-step fallback only; exact
   * per-frame times live in `timestampsUs`. */
  frameDurationUs: number;
  /** Exact presentation-order timestamps (µs) from the demuxed sample table.
   * All time↔frame mapping goes through these (binary search), never through
   * CFR division — real user footage is VFR and/or B-frame reordered. */
  timestampsUs: readonly number[];
  audioBuffer: AudioBuffer | undefined;
}

/** `EngineSegment` after resolving source metadata (frame counts/durations) —
 * project-time span plus the exact inclusive chunk-index range within its
 * source this segment covers. */
interface ResolvedSegment {
  projectStart: number;
  projectEnd: number;
  kind: 'video' | 'image' | 'gap';
  sourceId: string | undefined;
  /** Inclusive chunk-index range within the source (video segments only). */
  fromChunk: number;
  toChunk: number;
  image: HTMLImageElement | undefined;
  compositing: ClipCompositing | undefined;
}

// The decode-ahead ring holds GPU-backed VideoFrames, so its capacity is
// bounded by Chromium's output-frame pool (P0 gate #5: ≤24 held is safe).
const RING_CAPACITY = 24;
const WINDOW_FRAMES = 8;
// Decode this many frames AHEAD of the playhead — deliberately BELOW capacity.
// FrameRing.push evicts the oldest (== the frame the playhead needs now, after
// evictBefore keeps it at the front) once over capacity; a multi-frame window
// push near capacity would therefore evict the CURRENT frame (→ a missing-frame
// stutter, seen as ~48% drops on multi-source short clips). Keeping the target
// a full window below capacity guarantees push never reaches the current frame.
const LOOKAHEAD_TARGET = RING_CAPACITY - WINDOW_FRAMES - 2; // 14
const FALLBACK_FRAME_DURATION_US = 33_333;

export class WebCodecsPreviewEngine {
  private readonly client = new DecodeWorkerClient();
  private readonly ctx2d: CanvasRenderingContext2D;
  private ring = new FrameRing<TaggedFrame>(RING_CAPACITY);

  private segments: ResolvedSegment[] = [];
  /**
   * The last frame painted for the PREVIOUS picture segment, kept so a transition has the
   * shot it is transitioning from underneath it.
   *
   * A transition is stamped on butt-joined clips: while the incoming clip eases in, the
   * outgoing one has already ended and this engine draws exactly one source per frame. The
   * reveal therefore composited against the cleared canvas — a dissolve up from black, a whip
   * pan over black, at every cut. The export had the same defect for the same reason (see the
   * render compiler's transition under-layer), and a real run's perceptual review reported it
   * as unexpected black frames at all seven of its cuts.
   *
   * One held frame, snapshotted at the cut, is what the DOM monitor shows and what the
   * compiler falls back to when a clip has no handle left. The deterministic render remains
   * the authority for the exact frames inside the ramp.
   */
  private heldFrame: { canvas: HTMLCanvasElement; forSegmentStart: number } | null = null;
  /** Which segment the canvas last painted, so a cut can be noticed as it happens. */
  private lastPaintedSegmentStart: number | null = null;
  /** Text/caption overlays composited on top of every picture draw (P3b),
   * ordered back-to-front. Independent of the picture EDL — an overlay can
   * span cuts and gaps — so refreshed via `setOverlays`, never reloaded. */
  private overlays: readonly OverlayClip[] = [];
  private overlayIndex: TemporalIndex<OverlayClip> = buildTemporalIndex([]);
  /** Effect layers in APPLY order (schema v13). Refreshed via `setEffectLayers`. */
  private effectLayers: readonly TimedEffectLayer[] = [];
  private effectLayerIndex: TemporalIndex<TimedEffectLayer> = buildTemporalIndex([]);
  /** Lazily created — a project without effect layers never touches WebGL. */
  private glEffects: GlEffectChain | null = null;
  private sources = new Map<string, SourceInfo>();
  /** Decoded still images keyed by URL — cached across `loadSegments` calls so
   * an edit doesn't re-decode every photo on the timeline. */
  private images = new Map<string, HTMLImageElement>();
  private durationSec = 0;
  private audioClock: AudioMasterClock | undefined;
  private audioCtx: AudioContext | undefined;
  /**
   * Desired monitor gain, held here because the audio clock is created LAZILY on
   * the first `loadSegments`. Without this the volume the user set before any
   * media loaded would be silently discarded on the first load.
   */
  private monitorGain = 1;

  private playing = false;
  /** See {@link isStarting} — true only during play()'s async startup window. */
  private starting = false;
  private pausedAtSec = 0;
  private rafHandle: number | undefined;
  private pumping = false;
  /** Index into `segments` the pump has decoded through, and the next
   * not-yet-requested chunk index within that segment. */
  private pumpSegmentIndex = 0;
  private pumpChunkCursor = 0;
  private disposed = false;
  /** Last picture already resident on the canvas. A display may refresh at
   * 120 Hz while the project/source is 24/30/60 fps; repainting an identical
   * full-resolution frame on every refresh wastes the presentation budget. */
  private lastPaintedSegmentIndex = -1;
  private lastPaintedFrameTimestamp = Number.NaN;
  /** Serializes {@link loadSegments} calls — see there. */
  private loadQueue: Promise<unknown> = Promise.resolve();
  /** Playback-quality counters (jitter diagnosis / P4 perf guard), sampled per
   * presentation tick while inside a video segment. `wrongSegment` + `missing`
   * are the jitter signal: a frame drawn that isn't the one active now, or no
   * frame available at all. */
  private dbg = {
    ticks: 0,
    presented: 0,
    missing: 0,
    wrongSegment: 0,
    maxLagUs: 0,
    maxSeekMs: 0,
    maxDecodeMs: 0,
    sourceDraws: 0,
    reusedFrames: 0,
  };
  /** Bumped on every seek/play. Every `decodeRange` call resets+reconfigures
   * the decoder (see decode-worker.ts), so a seek legitimately aborts
   * whatever decode-ahead `pump()` call was in flight for the previous
   * position — a superseded call only treats its own catch as a real
   * failure if no newer seek/play has happened since it began. */
  private generation = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly callbacks: PreviewEngineCallbacks = {},
    /** Project canvas dimensions for the H4 transform px→frame conversion and
     * the letterbox aspect. Mutable via {@link setResolution} on an orientation
     * change (P3c) so the engine isn't reloaded just to reshape the frame. */
    private resolution: Resolution = DEFAULT_RESOLUTION,
  ) {
    // Fix the context to sRGB (P3c): a `display-p3` canvas would preview wider
    // than the sRGB export path can reproduce — the "preview ≠ export" gamut
    // bug class. Keep the default GPU-backed canvas path: `willReadFrequently`
    // is useful for test/analysis readback but can force a software backing
    // store, turning every full-frame preview draw into avoidable CPU work.
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx2d = ctx;
  }

  get durationSeconds(): number {
    return this.durationSec;
  }

  /** Current project time, including the exact terminal value while the engine
   * reports a natural stop. Used by the shared monitor loop control. */
  get currentTimeSec(): number {
    return this.playing && this.audioClock
      ? this.audioClock.nowMediaUs() / 1_000_000
      : this.pausedAtSec;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** True from the synchronous start of {@link play} until the audio clock is
   * running and `playing` is set — a window in which `isPlaying` is still
   * false but an external `seek()` would wrongly cancel the just-requested
   * playback. Callers gating on "is the engine live" must OR this with
   * {@link isPlaying}. */
  get isStarting(): boolean {
    return this.starting;
  }

  /**
   * (Re)load the EDL, reusing everything already loaded. INCREMENTAL by
   * design: sources (demuxed tables + decoder sessions in the worker, decoded
   * audio + timestamps here) and still images persist across calls, so an
   * edit that changes the EDL only loads media that is NEW to the timeline —
   * on a real project a trim/cut re-resolves segments in microseconds instead
   * of re-fetching and re-decoding every source (the "editor freezes after
   * every edit" failure mode on desktop-sized media). Sources that left the
   * timeline are pruned (worker decoder slot + memory freed). Ends by
   * presenting the frame at the current paused position (clamped).
   */
  loadSegments(edl: readonly EngineSegment[]): Promise<void> {
    // Serialized: two rapid EDL changes must not interleave their phases (the
    // second call's resolve/prune racing the first's loads) — the last call's
    // EDL always lands last.
    const run = this.loadQueue.then(() => this.loadSegmentsSerialized(edl));
    this.loadQueue = run.catch(() => undefined);
    return run;
  }

  private async loadSegmentsSerialized(edl: readonly EngineSegment[]): Promise<void> {
    try {
      if (this.disposed) return;
      if (this.playing) this.pause();
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
        this.audioClock = new AudioMasterClock(this.audioCtx);
        // Seed the freshly-created bus with the gain already requested — see
        // `monitorGain`. A volume set before any media loaded still applies.
        this.audioClock.setGain(this.monitorGain);
      }
      const audioCtx = this.audioCtx;
      // Supersede any in-flight decode-ahead for the OLD segments; a load is
      // never aborted by a later generation bump (an external seek during the
      // load must not cancel the EDL update itself).
      this.generation++;

      // Phase 1 — load everything MISSING, in parallel, one fetch per source
      // (the worker demuxes and transfers the same bytes back for the audio
      // decode; the file is read exactly once).
      const missingVideo = new Map<string, string>();
      const missingImages = new Set<string>();
      for (const seg of edl) {
        if (!seg.sourceId || !seg.url) continue;
        if (seg.kind === 'image') {
          if (!this.images.has(seg.url)) missingImages.add(seg.url);
        } else if (!this.sources.has(seg.sourceId)) {
          missingVideo.set(seg.sourceId, seg.url);
        }
      }
      // A source that cannot be loaded must not collapse the whole project EDL.
      // Keep resolving the remaining sources and represent the failed source as
      // a timed gap below. The monitor still surfaces the decoder error, but
      // transport, captions, effects and edits retain project-time semantics.
      await Promise.all([
        ...[...missingVideo].map(async ([sourceId, url]) => {
          try {
            const loaded = await this.client.loadSource(sourceId, url);
            if (this.disposed) return;
            let audioBuffer: AudioBuffer | undefined;
            try {
              audioBuffer = await audioCtx.decodeAudioData(loaded.fileBytes);
            } catch {
              audioBuffer = undefined; // e.g. a video-only source with no audio track
            }
            if (this.disposed) return;
            this.sources.set(sourceId, {
              frameCount: loaded.frameCount,
              frameDurationUs: loaded.frameDurationUs,
              timestampsUs: loaded.presentationTimestampsUs,
              audioBuffer,
            });
          } catch (err) {
            if (!this.disposed) {
              this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
            }
          }
        }),
        ...[...missingImages].map(async (url) => {
          try {
            const image = await this.loadImage(url);
            if (!this.disposed) this.images.set(url, image);
          } catch (err) {
            if (!this.disposed) {
              this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
            }
          }
        }),
      ]);
      if (this.disposed) return;

      // Phase 2 — resolve segments (pure, instant).
      const resolved: ResolvedSegment[] = edl.map((seg): ResolvedSegment => {
        const base = {
          projectStart: seg.projectStart,
          projectEnd: seg.projectEnd,
          compositing: seg.compositing,
        };
        const info = seg.sourceId ? this.sources.get(seg.sourceId) : undefined;
        if (!seg.sourceId || !seg.url) {
          return {
            ...base,
            kind: 'gap',
            sourceId: undefined,
            fromChunk: 0,
            toChunk: -1,
            image: undefined,
            compositing: undefined,
          };
        }
        if (seg.kind === 'image') {
          return {
            ...base,
            kind: 'image',
            sourceId: seg.sourceId,
            fromChunk: 0,
            toChunk: -1,
            image: this.images.get(seg.url),
          };
        }
        if (!info) {
          // Load failed silently? loadSource errors reject Promise.all above,
          // so this only happens on a disposed/raced load — play it as a gap.
          return {
            ...base,
            kind: 'gap',
            sourceId: undefined,
            fromChunk: 0,
            toChunk: -1,
            image: undefined,
            compositing: undefined,
          };
        }
        // In/out points via the exact sample timestamps (VFR-correct). The
        // half-frame nudge keeps an in-point that lands a hair before its
        // frame's timestamp (float rounding in clip times) on THAT frame, and
        // the out-point maps to the last frame strictly inside [start, end).
        const halfFrameUs = info.frameDurationUs / 2;
        const fromChunk = Math.max(
          0,
          presentationIndexAtOrBefore(info.timestampsUs, seg.sourceStart * 1_000_000 + halfFrameUs),
        );
        const toChunk = Math.min(
          info.frameCount - 1,
          presentationIndexAtOrBefore(info.timestampsUs, seg.sourceEnd * 1_000_000 - halfFrameUs),
        );
        return {
          ...base,
          kind: 'video',
          sourceId: seg.sourceId,
          fromChunk,
          toChunk: Math.max(fromChunk, toChunk),
          image: undefined,
        };
      });

      // Phase 3 — prune sources/images the new EDL no longer references
      // (frees the worker's decoder slot + demux tables + decoded audio).
      const liveSourceIds = new Set(edl.filter((s) => s.kind !== 'image').map((s) => s.sourceId));
      const liveImageUrls = new Set(edl.filter((s) => s.kind === 'image').map((s) => s.url));
      for (const sourceId of [...this.sources.keys()]) {
        if (liveSourceIds.has(sourceId)) continue;
        this.sources.delete(sourceId);
        void this.client.unloadSource(sourceId).catch(() => undefined);
      }
      for (const url of [...this.images.keys()]) {
        if (!liveImageUrls.has(url)) this.images.delete(url);
      }

      this.ring.clear();
      this.segments = resolved;
      this.durationSec = resolved.length > 0 ? Math.max(...resolved.map((s) => s.projectEnd)) : 0;
      this.callbacks.onDurationChange?.(this.durationSec);
      await this.seek(Math.min(this.pausedAtSec, this.durationSec));
    } catch (err) {
      if (this.disposed) return;
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Refresh per-segment compositing in place (a grade/transform/crop/blend
   * edit) WITHOUT reloading decoders or rescheduling audio — the media EDL is
   * unchanged, only how each frame is drawn. Segments are matched by index:
   * both this and `edl` derive from the same `pictureSegments` ordering, and
   * the caller only invokes this while the media identity (decoder EDL) is
   * unchanged, so counts and order line up. While paused, re-presents the
   * current frame so the edit is visible immediately; while playing, the
   * running tick already reads the updated compositing every frame.
   */
  applyCompositing(edl: readonly EngineSegment[]): void {
    if (this.disposed || this.segments.length === 0) return;
    for (let i = 0; i < this.segments.length && i < edl.length; i++) {
      const seg = this.segments[i];
      const next = edl[i];
      if (seg && next) seg.compositing = next.compositing;
    }
    this.lastPaintedSegmentIndex = -1;
    this.lastPaintedFrameTimestamp = Number.NaN;
    if (!this.playing) void this.seek(this.pausedAtSec);
  }

  /**
   * Update the project resolution on an orientation change (P3c) WITHOUT
   * reloading decoders — only the transform px→frame conversion and the
   * letterbox aspect depend on it. The caller resizes the canvas buffer
   * (which clears it), so this re-presents the current frame while paused.
   */
  setResolution(resolution: Resolution): void {
    this.resolution = resolution;
    this.lastPaintedSegmentIndex = -1;
    this.lastPaintedFrameTimestamp = Number.NaN;
    if (!this.disposed && !this.playing && this.segments.length > 0)
      void this.seek(this.pausedAtSec);
  }

  /**
   * Set the MONITOR volume (0 = silent, 1 = unity) for footage audio.
   *
   * Monitoring only: this is how loud the editor's speakers are, not a property
   * of the edit — it never reaches the project file, a patch, or the render
   * (AGENTS.md invariant 5). Safe to call before any media has loaded; the value
   * is retained and applied when the audio bus is created (see `monitorGain`).
   */
  setVolume(gain: number): void {
    this.monitorGain = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
    this.audioClock?.setGain(this.monitorGain);
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image ${url}`));
      img.src = url;
    });
  }

  private segmentIndexAt(projectTimeSec: number): number {
    // Segments are ordered and contiguous. A binary lookup keeps every
    // playback tick O(log clips) instead of walking from the movie's start.
    let low = 0;
    let high = this.segments.length - 1;
    let candidate = high;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = this.segments[middle];
      if (segment && segment.projectStart <= projectTimeSec) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return candidate;
  }

  private frameDurationUsFor(sourceId: string | undefined): number {
    if (!sourceId) return FALLBACK_FRAME_DURATION_US;
    return this.sources.get(sourceId)?.frameDurationUs ?? FALLBACK_FRAME_DURATION_US;
  }

  /** The frame index (presentation order) within `segment`'s source that
   * `projectTimeSec` maps to — the last frame whose exact source timestamp is
   * at-or-before that moment (display semantics; VFR-correct). */
  private chunkIndexForProjectTime(segment: ResolvedSegment, projectTimeSec: number): number {
    const info = segment.sourceId ? this.sources.get(segment.sourceId) : undefined;
    if (!info) return segment.fromChunk;
    const fromTimestampUs = info.timestampsUs[segment.fromChunk] ?? 0;
    const sourceTimeUs = fromTimestampUs + (projectTimeSec - segment.projectStart) * 1_000_000;
    const index = presentationIndexAtOrBefore(info.timestampsUs, sourceTimeUs);
    return Math.min(segment.toChunk, Math.max(segment.fromChunk, index));
  }

  /** The media-clock time (µs) at which `chunkIndex` of `segment` is
   * presented — the segment's project start plus the frame's exact source-time
   * offset from the segment's first frame. */
  private mediaTimeUsForChunk(segment: ResolvedSegment, chunkIndex: number): number {
    const info = segment.sourceId ? this.sources.get(segment.sourceId) : undefined;
    const timestampUs = info?.timestampsUs[chunkIndex];
    const fromTimestampUs = info?.timestampsUs[segment.fromChunk];
    if (timestampUs === undefined || fromTimestampUs === undefined) {
      return Math.round(
        segment.projectStart * 1_000_000 +
          (chunkIndex - segment.fromChunk) * this.frameDurationUsFor(segment.sourceId),
      );
    }
    return Math.round(segment.projectStart * 1_000_000 + (timestampUs - fromTimestampUs));
  }

  /**
   * Replace the active overlay set (a text edit, reposition, or a caption
   * track change) WITHOUT reloading decoders — overlays are drawn on top of
   * whatever picture is already decoded. Re-presents the current frame while
   * paused so the edit shows immediately.
   */
  setOverlays(overlays: readonly OverlayClip[]): void {
    this.overlays = overlays;
    this.overlayIndex = buildTemporalIndex(overlays);
    this.lastPaintedSegmentIndex = -1;
    this.lastPaintedFrameTimestamp = Number.NaN;
    if (!this.disposed && !this.playing && this.segments.length > 0)
      void this.seek(this.pausedAtSec);
  }

  /**
   * Replace the active effect-layer set (schema v13, ADR 0088).
   *
   * Same contract as {@link setOverlays}: no decoder reload, and a re-present
   * while paused so applying or retuning an effect shows immediately — which is
   * the "preview updates as you adjust" requirement.
   *
   * `layers` must already be in APPLY order (lowest effect track first), because
   * that ordering is shared with the render engine — see `activeEffectLayersAt`.
   * Resolving it here would duplicate the rule and let the two drift.
   */
  setEffectLayers(layers: readonly TimedEffectLayer[]): void {
    this.effectLayers = layers;
    this.effectLayerIndex = buildTemporalIndex(layers);
    this.lastPaintedSegmentIndex = -1;
    this.lastPaintedFrameTimestamp = Number.NaN;
    if (!this.disposed && !this.playing && this.segments.length > 0)
      void this.seek(this.pausedAtSec);
  }

  /**
   * Post-process the finished composite with every effect layer live at
   * `projectTimeSec`.
   *
   * Runs AFTER {@link drawOverlays} on purpose: the export compiler wraps its
   * effect stage after burned captions too, so an effect covers overlay text in
   * both. Getting this order wrong would be a preview/render mismatch that only
   * shows up on projects that have both.
   *
   * Everything here is a no-op when the project has no effects, so a pre-v13
   * project pays nothing and never creates a GL context.
   */
  private applyEffectLayers(projectTimeSec: number): void {
    if (this.effectLayers.length === 0) return;
    const live = activeTimedItemsAt(this.effectLayerIndex, projectTimeSec).filter(
      (layer) => layer.disabled !== true,
    );
    if (live.length === 0) return;

    // Created on first use, not in the constructor: a project without effects
    // must never allocate a GL context or compile a shader.
    this.glEffects ??= new GlEffectChain(() => document.createElement('canvas'));
    const processed = this.glEffects.process(this.ctx2d.canvas, live, projectTimeSec);
    if (processed === null) return;
    // Draw the GPU result back over the 2D canvas. `filter`/`globalAlpha` are
    // reset first because `drawSource` leaves them set for the picture layer, and
    // a stale grade filter would be applied a SECOND time to the finished frame.
    this.ctx2d.save();
    this.ctx2d.filter = 'none';
    this.ctx2d.globalAlpha = 1;
    this.ctx2d.globalCompositeOperation = 'copy';
    this.ctx2d.drawImage(processed as CanvasImageSource, 0, 0);
    this.ctx2d.restore();
  }

  /** Draw every overlay active at `projectTimeSec` on top of the current
   * picture, back-to-front (track order). */
  private drawOverlays(projectTimeSec: number): void {
    if (this.overlays.length === 0) return;
    const cw = this.ctx2d.canvas.width;
    const ch = this.ctx2d.canvas.height;
    for (const overlay of activeTimedItemsAt(this.overlayIndex, projectTimeSec)) {
      paintTextOverlay(
        this.ctx2d,
        overlay.params,
        projectTimeSec - overlay.start,
        overlay.end - overlay.start,
        cw,
        ch,
      );
    }
  }

  private clearCanvas(): void {
    this.ctx2d.clearRect(0, 0, this.ctx2d.canvas.width, this.ctx2d.canvas.height);
  }

  /** A still source frame must be repainted only when a visual layer changes
   * continuously between media-frame timestamps. Static crop/grade/transform
   * state remains resident on the canvas and is safe to reuse. */
  private requiresContinuousPaint(segment: ResolvedSegment, projectTimeSec: number): boolean {
    if (activeTimedItemsAt(this.overlayIndex, projectTimeSec).length > 0) {
      return true;
    }
    const compositing = segment.compositing;
    if (!compositing) return false;
    if (compositing.keyframes.length > 0) return true;
    const transition = compositing.transition;
    return (
      transition !== null && transitionActiveAt(transition, projectTimeSec - segment.projectStart)
    );
  }

  /** `mix-blend-mode` names equal the canvas composite-op names for the 11
   * non-normal blend modes the engine supports; `normal` is `source-over`. */
  private static blendCompositeOp(mode: ClipCompositing['blendMode']): GlobalCompositeOperation {
    return mode === 'normal' ? 'source-over' : (mode as GlobalCompositeOperation);
  }

  /**
   * Draw `source` letterboxed (`object-fit: contain`) inside the box
   * `(bx,by,bw,bh)`, matching the DOM `.preview-video` — the frame box is the
   * project-aspect canvas, so a source of a different aspect gets pillar/letter
   * bars (cleared area) exactly as the export does. Falls back to a plain
   * stretch when the source has no measurable intrinsic size.
   */
  private drawContain(
    source: CanvasImageSource,
    bx: number,
    by: number,
    bw: number,
    bh: number,
  ): void {
    const { w: sw, h: sh } = sourceDims(source);
    if (sw <= 0 || sh <= 0) {
      this.ctx2d.drawImage(source, bx, by, bw, bh);
      return;
    }
    const scale = Math.min(bw / sw, bh / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    this.ctx2d.drawImage(source, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  }

  /** Copy what is on the canvas now, as the held frame belonging to `forSegmentStart`. */
  private holdCurrentFrame(forSegmentStart: number, width: number, height: number): void {
    const canvas = this.heldFrame?.canvas ?? document.createElement('canvas');
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const held = canvas.getContext('2d');
    /* v8 ignore next -- a 2d context on a fresh canvas is only null when the browser refuses
       one entirely (no GPU, no software fallback), in which case the engine never started. */
    if (!held) return;
    held.clearRect(0, 0, width, height);
    held.drawImage(this.ctx2d.canvas, 0, 0);
    this.heldFrame = { canvas, forSegmentStart };
  }

  /**
   * Blit the held frame of the segment immediately BEFORE `segmentStartSec`, if that is what
   * is held.
   *
   * The identity check matters after a seek: a held frame from an unrelated part of the
   * timeline is not the shot this cut is coming from, and painting it would be a worse lie
   * than the black it replaces.
   */
  private drawHeldFrame(segmentStartSec: number, width: number, height: number): void {
    const held = this.heldFrame;
    if (!heldFrameIsPreviousSegment(this.segments, segmentStartSec, held?.forSegmentStart)) return;
    this.ctx2d.drawImage(held!.canvas, 0, 0, width, height);
  }

  /**
   * Clear the canvas and draw one picture source (decoded `VideoFrame` or a
   * still `<img>`) composited exactly as the DOM `PreviewPlayer` does via CSS:
   * a centered transform (keyframed scale/x/y at `projectTimeSec`), a crop that FILLS the
   * frame exactly as the export's does (`crop-fill.ts`), an approximate grade
   * (`ctx.filter`), and the clip's blend mode (`globalCompositeOperation`). An uncropped
   * source is letterboxed (`contain`) within the frame box, matching the DOM path.
   * Identity compositing (or none) takes the cheap no-transform path.
   */
  private drawSource(
    source: CanvasImageSource,
    compositing: ClipCompositing | undefined,
    projectTimeSec: number,
    segmentStartSec: number,
  ): void {
    const ctx = this.ctx2d;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    // At a cut, the canvas still holds the outgoing shot's last painted frame. Keep it before
    // clearing: a transition on the incoming clip needs that picture underneath it (see
    // `heldFrame`), and this is the only moment it exists.
    if (this.lastPaintedSegmentStart !== null && this.lastPaintedSegmentStart !== segmentStartSec) {
      this.holdCurrentFrame(this.lastPaintedSegmentStart, cw, ch);
    }
    this.lastPaintedSegmentStart = segmentStartSec;
    ctx.clearRect(0, 0, cw, ch);

    const clipTime = Math.max(0, projectTimeSec - segmentStartSec);

    // A CATALOG transition runs its real shader — the same pass the export
    // mirrors in numpy — and hands back an RGBA frame this method then draws
    // exactly as it would draw the picture. Legacy kinds fall through to the
    // envelope path below, unchanged.
    const catalog = compositing?.catalogTransition ?? null;
    let picture2d = source;
    let eraseWith: CanvasImageSource | null = null;
    if (catalog !== null) {
      const incoming = this.shadeTransition(
        source,
        catalog.incoming,
        'in',
        clipTime,
        catalog.clipDuration,
      );
      if (incoming !== null) picture2d = incoming;
      // The outgoing half contributes ALPHA ONLY, as the compiler's does: the
      // old shot keeps its own picture and takes the complement of the reveal.
      eraseWith = this.shadeTransition(
        source,
        catalog.outgoing,
        'out',
        clipTime,
        catalog.clipDuration,
      );
    }

    // The transition entering this clip, kept only while it still ramps —
    // identity/expired envelopes fall through to the cheap path so steady-state
    // playback pays nothing (mirrors the export compiler's no-op guards).
    const envelope = compositing?.transition ?? null;
    const transition: TransitionEnvelope | null =
      envelope !== null && transitionActiveAt(envelope, clipTime) ? envelope : null;

    // The shot being transitioned FROM, under the ramp. Drawn before the picture so the
    // reveal happens over it — without this the ramp composited against the cleared canvas,
    // which is a dissolve from black rather than from the previous shot.
    const rampingNow = transition !== null || catalog !== null;
    if (rampingNow) this.drawHeldFrame(segmentStartSec, cw, ch);

    if (
      (!compositing || isIdentityCompositing(compositing)) &&
      transition === null &&
      eraseWith === null
    ) {
      this.drawContain(picture2d, 0, 0, cw, ch);
      return;
    }

    // ROTATION and OPACITY used to be missing here while the export has rendered
    // both since Phase 5 (`_place_video_clip`'s `rotated()` and `_attach_mask`'s
    // opacity). A clip with rotation keyframes therefore exported rotated but
    // previewed flat — the render-vs-preview rule inverted, and in the worse
    // direction: the monitor was hiding a capability the render has, so what you
    // saw was not what you got. The parity-critical arithmetic (rotation sign,
    // alpha product, px unit conversion) now lives in `pictureTransformAt`, where
    // jsdom can assert it — the canvas itself is only checkable in a browser.
    // (Revamp Phase 3.)
    const keyframes = compositing?.keyframes ?? [];
    const picture = pictureTransformAt(
      keyframes,
      clipTime,
      { width: cw, height: ch },
      this.resolution,
      transition
        ? {
            scale: transitionScaleAt(transition, clipTime),
            offsetPx: offsetAt(transition, clipTime, cw, ch),
            opacity: opacityAt(transition, clipTime),
          }
        : NO_TRANSITION,
    );

    ctx.save();
    if (compositing) {
      ctx.globalCompositeOperation = WebCodecsPreviewEngine.blendCompositeOp(compositing.blendMode);
    }
    // Grade and transition blur share `ctx.filter` (a space-separated list).
    const gradeFilter =
      compositing && !isIdentityGrade(compositing.grade)
        ? colorGradeCssFilter(compositing.grade)
        : '';
    const blurPx = transition ? blurRadiusAt(transition, clipTime, Math.min(cw, ch)) : 0;
    const blurFilter = blurPx > 0.5 ? `blur(${blurPx.toFixed(2)}px)` : '';
    const filter = [gradeFilter, blurFilter].filter((f) => f.length > 0).join(' ');
    ctx.filter = filter.length > 0 ? filter : 'none';
    if (picture.alpha < 1) ctx.globalAlpha = picture.alpha;
    // Centered transform, matching the DOM's `transform-origin: center`. Crop and
    // drawImage both run in this transformed space, so the crop scales/rotates
    // WITH the picture, exactly as `clip-path` on a CSS-transformed element does.
    //
    // Declaration order translate → rotate → scale takes a source point through
    // scale, then rotate, then position (canvas applies the matrix in reverse of
    // declaration) — which is the export's resize → rotate(expand=False) →
    // position pipeline. `rotationRad` is already in the canvas's
    // clockwise-positive convention; see `pictureTransformAt` for why that matters.
    ctx.translate(cw / 2 + picture.dxPx, ch / 2 + picture.dyPx);
    if (picture.rotationRad !== 0) ctx.rotate(picture.rotationRad);
    ctx.scale(picture.scale, picture.scale);
    // CROP FILLS, as it does in the export: the cropped region is scaled up to the frame,
    // not masked in place over a letterboxed full frame. Masking is what made a 9:16 slice of
    // 16:9 footage read as a small picture floating in black on the monitor while exporting
    // edge to edge — and what made the agent write compensating zoom into the project to
    // "fix" a picture that was already correct. See `crop-fill.ts`.
    if (compositing && !isFullFrameCrop(compositing.crop)) {
      const { w: srcW, h: srcH } = sourceDims(picture2d);
      const { source, destination } = cropFillPlacement(srcW, srcH, cw, ch, compositing.crop);
      ctx.drawImage(
        picture2d,
        source.x,
        source.y,
        source.width,
        source.height,
        -cw / 2 + destination.x,
        -ch / 2 + destination.y,
        destination.width,
        destination.height,
      );
    } else {
      this.drawContain(picture2d, -cw / 2, -ch / 2, cw, ch);
    }
    ctx.restore();
    if (transition?.kind === 'wipe') {
      this.applyWipeMask(transition, wipeProgressAt(transition, clipTime));
    }
    if (eraseWith !== null) {
      // `destination-out` erases in proportion to the source's alpha, so drawing
      // the reveal over the picture leaves exactly its complement — one operation
      // for "the old shot goes away in the shape the new one arrives in".
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.filter = 'none';
      ctx.drawImage(eraseWith, 0, 0, cw, ch);
      ctx.restore();
    }
  }

  /**
   * Run one half of a catalog transition, or `null` when it is not live now.
   *
   * Returns the chain's canvas, which is REUSED between calls. That is safe here
   * because the two halves can never be live at the same moment: the validator
   * caps a transition at the shorter clip's length, so the incoming window
   * `[0, d/2)` and the outgoing window `[len − d/2, len)` cannot overlap. A half
   * that is not live returns before touching the chain at all.
   */
  private shadeTransition(
    source: CanvasImageSource,
    transition: ResolvedTransition | null,
    role: 'in' | 'out',
    clipTime: number,
    clipDuration: number,
  ): CanvasImageSource | null {
    if (transition === null || transition.isCut || transition.disabled) return null;
    const progress = transitionProgressAt(
      role,
      clipTime,
      { durationSeconds: transition.duration, alignment: transition.alignment },
      clipDuration,
    );
    if (progress === null) return null;
    const shaded = sharedTransitionChain().process(source as TexImageSource, transition, progress);
    return (shaded as CanvasImageSource | null) ?? null;
  }

  /**
   * Erase the not-yet-revealed part of a wiping picture: a `destination-out`
   * pass whose alpha is the complement of the engine's `wipe_alpha` — a soft band
   * ramping from keep (at `edge − softness`) to erase (at `edge`), then fully
   * erased beyond the edge. Runs right after the picture drew on a cleared canvas
   * and before overlays paint, so only the picture layer is masked.
   *
   * The gradient spans the **whole** sweep axis with its stops placed at the band,
   * rather than a band-sized gradient plus a fill rectangle. Canvas extends the
   * first and last stop colours outwards, so one fill expresses keep-before /
   * ramp / erase-after — and that is what makes the four directions one code path
   * instead of four rectangles with different signs.
   */
  private applyWipeMask(transition: TransitionEnvelope, progress: number): void {
    const ctx = this.ctx2d;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const softness = wipeSoftness(transition);
    const edge = wipeEdge(progress, softness);
    if (edge - softness >= 1) return; // fully revealed — nothing to erase
    const [axis, inverted] = wipeAxis(transition);
    // Endpoints of the fraction axis in canvas space: `inverted` mirrors the axis,
    // which is exactly how a right→left wipe reuses the left→right formula.
    const extent = axis === 'x' ? cw : ch;
    const start = inverted ? extent : 0;
    const end = inverted ? 0 : extent;
    const gradient =
      axis === 'x'
        ? ctx.createLinearGradient(start, 0, end, 0)
        : ctx.createLinearGradient(0, start, 0, end);
    const keepUntil = Math.min(1, Math.max(0, edge - softness));
    // Nudged apart when both clamp to the same offset: two stops at one offset is
    // a hard edge, which shimmers at frame rate.
    const eraseFrom = Math.min(1, Math.max(keepUntil + 1e-6, edge));
    gradient.addColorStop(keepUntil, 'rgba(0,0,0,0)');
    gradient.addColorStop(eraseFrom, 'rgba(0,0,0,1)');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  /** Seek while paused (or during a scrub drag): present exactly one frame —
   * decode one chunk (video), draw a still (image), or clear the canvas
   * (gap). Pauses playback first if it was running. */
  async seek(projectTimeSec: number): Promise<void> {
    if (this.disposed) return;
    if (this.playing) this.pause();
    const myGeneration = ++this.generation;
    const clamped = Math.min(this.durationSec, Math.max(0, projectTimeSec));
    const segment = this.segments[this.segmentIndexAt(clamped)];

    try {
      // Overlays are only repainted when the picture layer was (re)drawn this
      // pass — `drawSource`/`clearCanvas` reset the canvas first, so overlays
      // never stack. If nothing painted (e.g. a decode returned no frame) the
      // previous full composite stays untouched.
      let painted = true;
      if (!segment || segment.kind === 'gap') {
        this.clearCanvas();
      } else if (segment.kind === 'image') {
        if (segment.image) {
          this.drawSource(segment.image, segment.compositing, clamped, segment.projectStart);
        } else {
          painted = false;
        }
      } else if (segment.sourceId) {
        const chunkIndex = this.chunkIndexForProjectTime(segment, clamped);
        const seekStartedMs = performance.now();
        const { frames } = await this.client.decodeRange(segment.sourceId, chunkIndex, chunkIndex);
        this.dbg.maxSeekMs = Math.max(this.dbg.maxSeekMs, performance.now() - seekStartedMs);
        if (this.disposed || this.generation !== myGeneration) {
          // Superseded mid-decode — but these frames are ours now, and returning
          // without closing them leaks one per superseded seek. Two of the three
          // seeks a project update triggers (overlays, effect layers, then the
          // load) are superseded by construction, and a scrub supersedes at
          // pointer rate. `pump()` already handles this; `seek` did not.
          for (const frameMsg of frames) this.client.closeFrame(frameMsg.frame);
          return;
        }
        painted = frames.length > 0;
        for (const frameMsg of frames) {
          this.drawSource(frameMsg.frame, segment.compositing, clamped, segment.projectStart);
          this.client.closeFrame(frameMsg.frame);
        }
      } else {
        painted = false;
      }
      if (painted) {
        this.drawOverlays(clamped);
        this.applyEffectLayers(clamped);
      }
    } catch (err) {
      if (this.disposed || this.generation !== myGeneration) return;
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }
    if (this.disposed || this.generation !== myGeneration) return;
    this.pausedAtSec = clamped;
    this.callbacks.onTimeUpdate?.(clamped);
  }

  /** Start playback from the current paused position. */
  async play(): Promise<void> {
    if (this.playing || this.starting || !this.audioClock || this.segments.length === 0) return;
    // Set synchronously, BEFORE the first await, so an external seek() racing in
    // during audio-clock startup sees the engine is going live and stands down
    // (isPlaying is still false here) instead of cancelling this playback.
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
    this.generation++; // supersede any still-in-flight seek's pending decode

    this.playing = true;
    this.starting = false;
    this.callbacks.onPlayingChange?.(true);
    this.dbg = {
      ticks: 0,
      presented: 0,
      missing: 0,
      wrongSegment: 0,
      maxLagUs: 0,
      maxSeekMs: 0,
      maxDecodeMs: 0,
      sourceDraws: 0,
      reusedFrames: 0,
    };
    this.lastPaintedSegmentIndex = -1;
    this.lastPaintedFrameTimestamp = Number.NaN;

    const startSec = this.pausedAtSec >= this.durationSec ? 0 : this.pausedAtSec;
    const startSegmentIndex = this.segmentIndexAt(startSec);
    this.pumpSegmentIndex = startSegmentIndex;
    const startSegment = this.segments[startSegmentIndex];
    this.pumpChunkCursor = startSegment ? this.chunkIndexForProjectTime(startSegment, startSec) : 0;
    this.ring.clear();

    // Schedule footage audio at its REAL project offsets. The continuous
    // AudioContext anchor advances through video-only clips, images and gaps;
    // filtering absent buffers here must never compact those spans out of time.
    const audioSegments = this.segments
      .slice(startSegmentIndex)
      .filter((s) => s.kind === 'video' && s.sourceId)
      .map((s) => {
        const info = s.sourceId ? this.sources.get(s.sourceId) : undefined;
        const segStartSec = Math.max(s.projectStart, startSec);
        // The segment's first frame's EXACT source timestamp anchors the audio
        // offset (VFR-correct), with the CFR estimate as a fallback.
        const fromTimestampUs =
          info?.timestampsUs[s.fromChunk] ?? s.fromChunk * this.frameDurationUsFor(s.sourceId);
        const sourceOffsetSec = segStartSec - s.projectStart + fromTimestampUs / 1_000_000;
        const durationSec = s.projectEnd - segStartSec;
        return {
          mediaStartUs: segStartSec * 1_000_000,
          buffer: info?.audioBuffer,
          offsetSec: sourceOffsetSec,
          durationSec,
        };
      })
      .filter(
        (
          s,
        ): s is {
          mediaStartUs: number;
          buffer: AudioBuffer;
          offsetSec: number;
          durationSec: number;
        } => Boolean(s.buffer) && s.durationSec > 0,
      );
    this.audioClock.scheduleSegments(audioSegments, startSec * 1_000_000);

    await this.pump();
    const tick = () => {
      if (!this.playing || !this.audioClock) return;
      const nowMediaUs = this.audioClock.nowMediaUs();
      const nowSec = nowMediaUs / 1_000_000;
      if (nowSec >= this.durationSec) {
        this.pausedAtSec = this.durationSec;
        this.pause();
        this.callbacks.onTimeUpdate?.(this.durationSec);
        return;
      }
      const segment = this.segments[this.segmentIndexAt(nowSec)];
      // Repaint overlays only when the picture layer was (re)drawn this tick —
      // otherwise (a not-yet-decoded frame) the last full composite stays and
      // overlays must not be painted again on top of themselves.
      let painted = true;
      if (!segment || segment.kind === 'gap') {
        this.clearCanvas();
      } else if (segment.kind === 'image') {
        if (segment.image) {
          const segmentIndex = this.segmentIndexAt(nowSec);
          if (
            this.lastPaintedSegmentIndex !== segmentIndex ||
            this.requiresContinuousPaint(segment, nowSec)
          ) {
            this.drawSource(segment.image, segment.compositing, nowSec, segment.projectStart);
            this.lastPaintedSegmentIndex = segmentIndex;
            this.lastPaintedFrameTimestamp = Number.NaN;
            this.dbg.sourceDraws++;
          } else {
            this.dbg.reusedFrames++;
            painted = false;
          }
        } else {
          painted = false;
        }
      } else {
        this.ring.evictBefore(nowMediaUs);
        void this.pump();
        const current = this.ring.frameAt(nowMediaUs);
        const activeSegmentIndex = this.segmentIndexAt(nowSec);
        this.dbg.ticks++;
        if (current && current.segmentIndex === activeSegmentIndex) {
          const frameChanged =
            this.lastPaintedSegmentIndex !== activeSegmentIndex ||
            this.lastPaintedFrameTimestamp !== current.timestamp;
          if (frameChanged || this.requiresContinuousPaint(segment, nowSec)) {
            this.drawSource(current.videoFrame, segment.compositing, nowSec, segment.projectStart);
            this.lastPaintedSegmentIndex = activeSegmentIndex;
            this.lastPaintedFrameTimestamp = current.timestamp;
            this.dbg.sourceDraws++;
          } else {
            this.dbg.reusedFrames++;
            painted = false;
          }
          this.dbg.presented++;
          const lag = nowMediaUs - current.timestamp;
          if (lag > this.dbg.maxLagUs) this.dbg.maxLagUs = lag;
        } else {
          if (current) this.dbg.wrongSegment++;
          this.dbg.missing++;
          painted = false;
        }
      }
      if (painted) {
        this.drawOverlays(nowSec);
        this.applyEffectLayers(nowSec);
      }
      this.callbacks.onTimeUpdate?.(nowSec);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
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

  /** Windowed, ring-paced decode-ahead across VIDEO segments only (gaps/
   * images need no decode) — the same jitter-buffer design the P0 A/V-sync
   * gate verified, generalized from one continuous source to a multi-segment,
   * multi-source EDL. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const myGeneration = this.generation;
    try {
      // Fill to LOOKAHEAD_TARGET (below capacity): a deep-enough cushion
      // (~0.45s at 30fps) to absorb a transient decode-behind, while leaving
      // headroom so a window push can never evict the current frame. Called
      // every tick, so it tops the ring straight back up as playback consumes.
      while (this.generation === myGeneration && this.ring.size < LOOKAHEAD_TARGET) {
        // Advance past any gap/image segments and finished video segments.
        while (
          this.pumpSegmentIndex < this.segments.length &&
          (this.segments[this.pumpSegmentIndex]?.kind !== 'video' ||
            this.pumpChunkCursor > (this.segments[this.pumpSegmentIndex]?.toChunk ?? -1))
        ) {
          this.pumpSegmentIndex++;
          const nextSegment = this.segments[this.pumpSegmentIndex];
          this.pumpChunkCursor = nextSegment?.fromChunk ?? 0;
        }
        const segment = this.segments[this.pumpSegmentIndex];
        if (!segment || segment.kind !== 'video' || !segment.sourceId) break;

        const from = this.pumpChunkCursor;
        const to = Math.min(segment.toChunk, from + WINDOW_FRAMES - 1);
        const { frames, decodeDurationMs } = await this.client.decodeRange(
          segment.sourceId,
          from,
          to,
        );
        this.dbg.maxDecodeMs = Math.max(this.dbg.maxDecodeMs, decodeDurationMs);
        if (this.disposed || this.generation !== myGeneration) {
          for (const frameMsg of frames) this.client.closeFrame(frameMsg.frame);
          return;
        }
        for (const frameMsg of frames) {
          this.ring.push({
            timestamp: this.mediaTimeUsForChunk(segment, frameMsg.chunkIndex),
            videoFrame: frameMsg.frame,
            chunkIndex: frameMsg.chunkIndex,
            segmentIndex: this.pumpSegmentIndex,
            close: () => this.client.closeFrame(frameMsg.frame),
          });
        }
        this.pumpChunkCursor = to + 1;
      }
    } catch (err) {
      if (this.disposed || this.generation !== myGeneration) return;
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.pumping = false;
    }
  }

  /** Playback-quality snapshot for the jitter/perf e2e (and future perf guard).
   * `wrongSegment` + `missing` over `ticks` is the jitter rate. */
  debugStats(): Record<string, number> {
    return { ...this.dbg, durationSec: this.durationSec, segCount: this.segments.length };
  }

  dispose(): void {
    this.pause();
    this.ring.clear();
    this.client.dispose();
    // Textures, framebuffers and compiled programs are GPU allocations that the
    // JS GC does not reclaim, so an undisposed chain leaks VRAM for the life of
    // the tab across every project switch.
    this.glEffects?.dispose();
    this.glEffects = null;
    // Every source's whole audio track was decoded into this context and held as
    // PCM (`duration x 48000 x channels x 4` bytes — a 10-minute stereo source is
    // ~230 MB), and the browser reclaims none of it while the context is alive.
    // The engine is rebuilt whenever WebCodecs eligibility flips, which an
    // ordinary AI edit can do (a speed ramp is enough), so an unclosed context is
    // not a once-per-session cost.
    this.sources.clear();
    // Decoded stills and the held cut frame are full-resolution pixel buffers,
    // and `heldFrame.canvas` is a detached `<canvas>` — exactly the retention
    // the P6.1 heap-snapshot criterion looks for. They survive dispose whenever
    // anything still points at the engine: the `loadQueue` chain, an in-flight
    // `decodeAudioData`, or a stale `engineRef` on a component React has not
    // yet collected. Releasing them here makes the engine cheap to hold onto
    // rather than relying on nobody holding it.
    this.images.clear();
    this.heldFrame = null;
    this.segments = [];
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = undefined;
    this.disposed = true;
  }
}
