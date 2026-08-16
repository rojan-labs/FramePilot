/**
 * Multi-clip WebCodecs program monitor (plan PREVIEW-WEBCODECS-COMPOSITOR.md,
 * P1 single-clip + P2 multi-clip continuity). Renders one `<canvas>` driven
 * by `WebCodecsPreviewEngine` as the proxy-backed program-monitor path:
 * play/pause/seek/scrub across cuts, gaps, and still
 * images, frame-exact at boundaries, gapless audio.
 *
 * Mounted by `Editor.tsx` when all video sources have bounded proxies. This component's
 * "time" is simply the
 * project's own timeline time — no per-clip source-time translation needed
 * (P1's single-clip version had to translate; P2's multi-clip EDL doesn't).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, CaptionStyle, TranscriptWord } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';
import { resolveCaptionCue } from '@framepilot/editor-core';
import { useFramePlayhead, type UseEditor } from '../editor/useEditor.js';
import { previewMediaSrc } from '../editor/media.js';
import {
  assetKind,
  canvasPreviewEligible,
  clipCompositing,
  clipKind,
  colorGradeCssFilter,
  IDENTITY_GRADE,
  pictureSegments,
  effectLayersInApplyOrder,
} from '../editor/selectors.js';
import {
  overlayClips,
  setCaptionCuePatch,
  setCaptionStylePatch,
  setClipTransformPatch,
  setTextParamsPatch,
  type TextOverlayParams,
} from '../editor/patch-builders.js';
import { useSettings } from '../editor/useSettings.js';
import { baseTransformOf, withBaseTransform } from '../preview/picture-transform.js';
import { activeTimedItemsAt, buildTemporalIndex } from '../preview/temporal-index.js';
import { textOverlayStyle } from '../editor/textOverlay.js';
import {
  WebCodecsPreviewEngine,
  type EngineSegment,
} from '../preview/engine/webcodecs-preview-engine.js';
import { CaptionOverlay } from './CaptionOverlay.js';
import { MonitorHeaderPortal } from './MonitorHeaderPortal.js';
import { PreviewAudioMixer } from './PreviewAudioMixer.js';
import { PreviewViewControls, type PreviewZoom } from './PreviewViewControls.js';
import { PreviewTransport } from './PreviewTransport.js';
import { PreviewTextEditor } from './PreviewTextEditor.js';
import { PreviewCaptionEditor } from './PreviewCaptionEditor.js';
import {
  PreviewTransform,
  type ClipTransformValues,
  type TransformOverride,
} from './PreviewTransform.js';

const log = createLogger('web-editor:webcodecs-preview');

/** No tracks soloed — the default when the caller doesn't pass any (mirrors PreviewPlayer). */
const NO_SOLO: ReadonlySet<string> = new Set();

export interface WebCodecsPreviewPlayerProps {
  readonly editor: UseEditor;
  readonly assets: readonly Asset[];
  readonly fps: number;
  readonly aspect?: number;
  /** Project canvas dimensions — drives the H4 transform px→frame conversion in
   * the canvas compositor (P3a). Defaults to 1280×720 when omitted. */
  readonly resolution?: { readonly width: number; readonly height: number };
  /** Change the project canvas from the shared monitor control. */
  readonly onChangeOrientation?: (presetId: string) => void;
  /** Shared Source/Program header lane for engine-independent monitor controls. */
  readonly headerControlsHost?: HTMLElement | null;
  /** Track ids currently soloed for preview monitoring (H0.4 J2); empty = none. */
  readonly soloedTrackIds?: ReadonlySet<string>;
  /**
   * Word-level project transcript — the text source for caption clips
   * (template-based captions, schema v10). Captions render as a DOM overlay on
   * top of the canvas (same `CaptionOverlay` as the video-pool player), never
   * inside the canvas compositor. Absent = captions don't preview.
   */
  readonly transcript?: readonly TranscriptWord[];
}

const DEFAULT_RESOLUTION = { width: 1280, height: 720 } as const;

/** Cap the canvas buffer's long edge — a 1080×1920 project would otherwise
 * allocate a 2MP buffer per frame; scaling to fit this keeps the buffer small
 * while preserving the exact project aspect (so letterboxing matches export). */
const CANVAS_MAX_EDGE = 1280;

/** The production compositor's required browser surface. An unavailable API is
 * an in-monitor error, never a reason to switch rendering engines. */
function webCodecsRuntimeAvailable(): boolean {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof Worker !== 'undefined'
  );
}

export function WebCodecsPreviewPlayer({
  editor,
  assets,
  fps,
  aspect = 16 / 9,
  resolution = DEFAULT_RESOLUTION,
  onChangeOrientation,
  headerControlsHost,
  soloedTrackIds = NO_SOLO,
  transcript,
}: WebCodecsPreviewPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const engineRef = useRef<WebCodecsPreviewEngine | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const lastReportedTimeRef = useRef(0);
  // The user's play/pause intent. A Play click can arrive BEFORE the async
  // load finishes (engine.play() then no-ops on empty segments — the click
  // would be silently dropped, freezing rapid-cut montages whose load is
  // slow). We record the intent and honor it when the load completes.
  const playIntentRef = useRef(false);
  const { settings, update } = useSettings();
  const [showGrade, setShowGrade] = useState(true);
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>('fit');
  const loopRef = useRef(settings.loopByDefault);
  loopRef.current = settings.loopByDefault;
  const durationRef = useRef(0);
  // Mute is a separate preference from level so un-muting restores the level the
  // user had, rather than jumping to unity — collapsed to one gain here.
  const monitorGain = settings.previewMuted ? 0 : settings.previewVolume;

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const monitor = previewRef.current?.closest<HTMLElement>('.stage-monitor');
    void (monitor ?? previewRef.current)?.requestFullscreen();
  };

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const eligible = canvasPreviewEligible(editor.state.timeline, assetById);
  const segments = useMemo(
    () => (eligible ? pictureSegments(editor.state.timeline, assetById) : []),
    [eligible, editor.state.timeline, assetById],
  );

  // --- On-canvas transform (revamp Phase 3) ---------------------------------
  // The handles act on the picture clip CURRENTLY SHOWN, so they can only appear
  // when the selected clip is that one — a box framing a clip the monitor is not
  // displaying would point at nothing.
  //
  // Read from `editor.state.playhead` (the reducer's committed position), NOT the
  // live clock: the clock deliberately bypasses React so the canvas owner is not
  // re-rendered every display frame, and subscribing here would undo that. The
  // committed playhead is stale only DURING playback, which is exactly when nobody
  // is dragging handles; any discrete seek updates it.
  const [transformOverride, setTransformOverride] = useState<TransformOverride>(null);
  const shownPicture = useMemo(() => {
    const at = editor.state.playhead;
    return (
      segments.find((seg) => seg.clip !== null && seg.start <= at && at < seg.end)?.clip ?? null
    );
  }, [segments, editor.state.playhead]);
  const selectedPicture =
    shownPicture && editor.state.selectedIds.includes(shownPicture.id) ? shownPicture : null;
  const transformSelected = selectedPicture !== null;
  const baseTransform = useMemo(
    () => baseTransformOf(selectedPicture?.keyframes ?? []),
    [selectedPicture],
  );
  const commitTransform = (values: ClipTransformValues): void => {
    if (!selectedPicture) return;
    const patch = setClipTransformPatch(editor.state.timeline, selectedPicture.id, {
      scale: values.scale,
      x: values.x,
      y: values.y,
      rotation: values.rotation ?? 0,
    });
    if (patch) editor.applyPatch(patch);
  };

  const edl: EngineSegment[] = useMemo(
    () =>
      segments.map((seg): EngineSegment => {
        // A missing asset (removed from the bin, reference gone stale) plays
        // as a gap rather than erroring the whole engine — the same
        // graceful-degradation posture as the asset-less clip case below.
        const asset = seg.clip ? assetById.get(seg.clip.assetId) : undefined;
        if (!seg.clip || !asset) {
          return { projectStart: seg.start, projectEnd: seg.end, sourceStart: 0, sourceEnd: 0 };
        }
        const kind = assetKind(asset) === 'image' ? ('image' as const) : ('video' as const);
        const base = clipCompositing(seg.clip);
        // A live canvas drag previews by overriding this clip's BASE keyframes —
        // the compositor draws from keyframes, not from a CSS transform the way the
        // retired DOM player did. Expressed exactly as `setClipTransformPatch` will
        // commit it, so the picture does not jump on release. Changing this changes
        // `compositingSignature`, which the existing in-place refresh effect turns
        // into an `applyCompositing` call — no decoder reload for a drag.
        const dragged =
          transformOverride !== null && seg.clip.id === selectedPicture?.id
            ? { ...base, keyframes: withBaseTransform(base.keyframes, transformOverride) }
            : base;
        const compositing = showGrade ? dragged : { ...dragged, grade: IDENTITY_GRADE };
        return {
          projectStart: seg.start,
          projectEnd: seg.end,
          sourceId: seg.clip.assetId,
          url: previewMediaSrc(asset),
          kind,
          sourceStart: seg.clip.sourceStart,
          sourceEnd: seg.clip.sourceEnd,
          // Transform/crop/grade/blend for the canvas pass (P3a). Refreshed in
          // place by the compositing effect below so an edit doesn't reload the
          // decoder (which the media-identity-keyed mount effect guards against).
          // Export parity: the render compiler defers transitions on stills
          // ("a still has no motion to transition"), so the preview skips them
          // on image segments too.
          compositing:
            kind === 'image' && compositing.transition !== null
              ? { ...compositing, transition: null }
              : compositing,
        };
      }),
    [segments, assetById, showGrade],
  );

  const isGraded = useMemo(
    () =>
      segments.some(
        (segment) =>
          segment.clip !== null &&
          colorGradeCssFilter(clipCompositing(segment.clip).grade) !== 'none',
      ),
    [segments],
  );

  // A stable signature of the EDL's media identity — the mount effect below
  // reloads the engine only when THIS changes, not on every unrelated patch
  // (undo/redo, an edit to a different clip) that changes `editor` identity.
  const edlSignature = useMemo(
    () =>
      JSON.stringify(
        edl.map((s) => [
          s.projectStart,
          s.projectEnd,
          s.sourceId,
          s.url,
          s.sourceStart,
          s.sourceEnd,
        ]),
      ),
    [edl],
  );

  // A signature of just the compositing (transform/crop/grade/blend) of every
  // segment — changes when the user tweaks a grade/transform but the media EDL
  // is unchanged. Drives an in-place refresh (below) that does NOT reload the
  // decoder, so adjusting a grade slider doesn't re-demux/re-decode the media.
  const compositingSignature = useMemo(
    () => JSON.stringify(edl.map((s) => s.compositing ?? null)),
    [edl],
  );

  // Text/caption overlays composited on top of the picture (P3b). Independent
  // of the media EDL — an overlay spans cuts/gaps freely and never touches the
  // decoder — so it's pushed via setOverlays and refreshed on its own signature.
  const overlays = useMemo(
    () => (eligible ? overlayClips(editor.state.timeline, assetById) : []),
    [eligible, editor.state.timeline, assetById],
  );
  const activeOverlays = useMemo(
    () =>
      overlays.filter(
        (overlay) => overlay.start <= editor.state.playhead && editor.state.playhead < overlay.end,
      ),
    [editor.state.playhead, overlays],
  );
  const selectedOverlay =
    [...activeOverlays]
      .reverse()
      .find((overlay) => editor.state.selectedIds.includes(overlay.id)) ?? null;
  // A selected text object moves from the canvas painter into the DOM editor.
  // Excluding it here prevents doubled glyphs while preserving pixel-identical
  // canvas rendering for every object that is not being manipulated.
  const canvasOverlays = useMemo(
    () => overlays.filter((overlay) => overlay.id !== selectedOverlay?.id),
    [overlays, selectedOverlay?.id],
  );
  const overlaySignature = useMemo(() => JSON.stringify(canvasOverlays), [canvasOverlays]);

  const commitTextParams = (clipId: string, params: Partial<TextOverlayParams>): void => {
    const patch = setTextParamsPatch(editor.state.timeline, clipId, params);
    if (patch) editor.applyPatch(patch);
  };

  // Effect layers (schema v13, ADR 0088), in APPLY order. The order comes from the
  // shared selector rather than being re-derived here — it is the same rule the
  // export engine walks, and two orders would make a stacked effect look different
  // in preview than in the file.
  const effectLayers = useMemo(
    () => effectLayersInApplyOrder(editor.state.timeline),
    [editor.state.timeline],
  );
  const effectSignature = useMemo(() => JSON.stringify(effectLayers), [effectLayers]);

  // Caption clips: rendered as a DOM `CaptionOverlay` on top of the canvas —
  // excluded from the canvas overlay compositor above. Text comes from the
  // SHARED `resolveCaptionCue` (ADR 0071): the clip's own cue when it has one,
  // otherwise derived from the transcript by overlap. No local derivation here —
  // that is exactly how the preview and the export used to disagree.
  const captionClips = useMemo(() => {
    if (!eligible) return [];
    const words = transcript ?? [];
    const clips: {
      clipId: string;
      start: number;
      end: number;
      style: (typeof editor.state.timeline.tracks)[number]['clips'][number]['captionStyle'];
      trackStyle: (typeof editor.state.timeline.tracks)[number]['captionStyle'];
      lines: readonly (readonly TranscriptWord[])[];
      text: string;
    }[] = [];
    for (const track of editor.state.timeline.tracks) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (clipKind(clip, assetById) !== 'caption') continue;
        const cue = resolveCaptionCue(clip, words);
        if (cue.lines.every((line) => line.length === 0)) continue;
        clips.push({
          clipId: clip.id,
          start: clip.start,
          end: clip.end,
          style: clip.captionStyle,
          trackStyle: track.captionStyle,
          lines: cue.lines,
          text: cue.text,
        });
      }
    }
    return clips;
  }, [eligible, editor.state.timeline, assetById, transcript]);

  // Canvas buffer dimensions: the project aspect (so non-16:9 projects aren't
  // distorted and letterboxing matches export), scaled so the long edge is at
  // most CANVAS_MAX_EDGE.
  const { canvasWidth, canvasHeight } = useMemo(() => {
    const scale = Math.min(1, CANVAS_MAX_EDGE / Math.max(resolution.width, resolution.height));
    return {
      canvasWidth: Math.max(1, Math.round(resolution.width * scale)),
      canvasHeight: Math.max(1, Math.round(resolution.height * scale)),
    };
  }, [resolution.width, resolution.height]);

  // Project time is authoritative even while media is still loading or when a
  // source fails and is represented as a gap. Basing transport duration on the
  // decoder made an unavailable source collapse every seek back to zero.
  const durationSec = useMemo(
    () => edl.reduce((duration, segment) => Math.max(duration, segment.projectEnd), 0),
    [edl],
  );
  durationRef.current = durationSec;
  const [error, setError] = useState<string | null>(null);

  // ONE persistent engine per mounted canvas. An EDL change streams through
  // engine.loadSegments below, which is INCREMENTAL (already-loaded sources,
  // decoder sessions, and decoded audio are reused; only new media loads) —
  // disposing/recreating the engine per edit used to re-fetch, re-demux, and
  // re-decode the audio of EVERY source on real desktop-sized projects, a
  // multi-second freeze after every cut/trim.
  const hasSegments = edl.length > 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasSegments) return;
    if (!webCodecsRuntimeAvailable()) {
      setError('WebCodecs preview is unavailable in this browser.');
      editorRef.current.setPlaying(false);
      return;
    }

    let engine: WebCodecsPreviewEngine;
    try {
      engine = new WebCodecsPreviewEngine(
        canvas,
        {
          onDurationChange: (duration) => {
            durationRef.current = duration;
          },
          onTimeUpdate: (timeSec) => {
            lastReportedTimeRef.current = timeSec;
            // The external playhead clock updates only its tiny subscribers. Do
            // not put live time in this component's React state: re-rendering the
            // canvas owner every display frame caused avoidable commit/paint work
            // around the imperative compositor.
            editorRef.current.seekTransient(timeSec);
          },
          onPlayingChange: (isPlaying) => {
            // Playback stopping (end of timeline, pause, tab-hidden) ends the
            // shared transport intent so every transport surface and the audio
            // mixer stop together. Engine playback is never a second authority.
            if (!isPlaying) {
              const currentEngine = engineRef.current;
              const ended =
                durationRef.current > 0 &&
                (currentEngine?.currentTimeSec ?? 0) >= durationRef.current - 1 / Math.max(1, fps);
              if (loopRef.current && ended && editorRef.current.state.playing && currentEngine) {
                void currentEngine.seek(0).then(() => currentEngine.play());
                return;
              }
              playIntentRef.current = false;
              const latestEditor = editorRef.current;
              if (latestEditor.state.playing) latestEditor.setPlaying(false);
            }
          },
          onError: (message) => {
            log.error('webcodecs preview engine error', { message });
            setError(message);
            // A fatal decoder error is shown in place. Switching to a renderer
            // with different effects semantics would make the monitor misleading.
            editorRef.current.setPlaying(false);
          },
        },
        resolution,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'WebCodecs preview failed to start.';
      log.error('webcodecs preview failed to start', { message });
      setError(message);
      editorRef.current.setPlaying(false);
      return;
    }
    engineRef.current = engine;
    // Debug/e2e hook: exposes the live engine so the jitter/perf spec can read
    // debugStats(). Harmless in production (just a reference); mirrors the
    // spike harness's window hook.
    (window as unknown as { __fpPreviewEngine?: WebCodecsPreviewEngine }).__fpPreviewEngine =
      engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
      // Release the debug hook too: it is a GC root, so leaving it set keeps the
      // disposed engine — and every decoded AudioBuffer still referenced by it —
      // alive until some later engine happens to overwrite the slot.
      const debugHost = window as unknown as { __fpPreviewEngine?: WebCodecsPreviewEngine };
      if (debugHost.__fpPreviewEngine === engine) delete debugHost.__fpPreviewEngine;
    };
    // Keyed on hasSegments only: the engine outlives every EDL/patch change
    // (loadSegments below is the update path) and is torn down only when the
    // timeline empties or the component unmounts. (The repo's lint baseline
    // has no react-hooks plugin, so this is documented rather than
    // suppressed.)
  }, [hasSegments]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || edl.length === 0) return;
    // Overlays are drawn on top of whatever the load's seek presents, so set
    // them BEFORE loadSegments' seek fires. Effects post-process that same
    // composite, so they go in at the same point for the same reason.
    engine.setOverlays(canvasOverlays);
    engine.setEffectLayers(effectLayers);
    void engine.loadSegments(edl).then(() => {
      if (engine.isPlaying || engine.isStarting) return;
      // Honor a Play pressed during the load (its engine.play() no-op'd on the
      // not-yet-loaded segments). Otherwise present the current playhead. Both
      // paths avoid the seek-vs-play race that used to freeze rapid-cut
      // montages, whose many-segment load is slow enough to lose it reliably.
      if (playIntentRef.current) {
        void engine.play();
      } else {
        void engine.seek(editor.getPlayhead());
      }
    });
    // Keyed on the EDL's media identity only (edlSignature) — `edl`/`editor`
    // identity churns on every patch (undo/redo, unrelated edits) and would
    // otherwise reload media mid-playback for no reason.
  }, [edlSignature, hasSegments]);

  // The editor transport is the single authority (keyboard, toolbar, monitor
  // button, tab-hidden stop). The engine follows it; a Play requested during
  // async media loading is retained and honored by loadSegments above.
  useEffect(() => {
    playIntentRef.current = editor.state.playing;
    const engine = engineRef.current;
    if (!engine) return;
    if (editor.state.playing) {
      void engine.play();
    } else {
      engine.pause();
    }
  }, [editor.state.playing, hasSegments]);

  // Refresh compositing in place when a grade/transform/crop/blend edit lands
  // (same media EDL). Keyed on the compositing signature only — never reloads
  // the decoder. The (re)mount effect below seeds the last-applied signature
  // because `loadSegments` already applied the current compositing, so the
  // apply-effect no-ops on mount and only fires on a genuine later change
  // (including a revert back to the mount baseline). Declaration order matters:
  // on a media reload both effects run and this one must seed the ref first.
  const appliedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    appliedSignatureRef.current = compositingSignature;
  }, [edlSignature]);
  useEffect(() => {
    if (appliedSignatureRef.current === compositingSignature) return;
    engineRef.current?.applyCompositing(edl);
    appliedSignatureRef.current = compositingSignature;
  }, [compositingSignature, edl]);

  // Refresh overlays in place when a text/caption edit lands (add, retext,
  // reposition, restyle). Same seed-on-mount pattern as compositing: the mount
  // effect already called setOverlays, so this fires only on a genuine later
  // change and never reloads the decoder.
  const appliedOverlaySignatureRef = useRef<string | null>(null);
  useEffect(() => {
    appliedOverlaySignatureRef.current = overlaySignature;
  }, [edlSignature]);
  useEffect(() => {
    if (appliedOverlaySignatureRef.current === overlaySignature) return;
    engineRef.current?.setOverlays(canvasOverlays);
    appliedOverlaySignatureRef.current = overlaySignature;
  }, [overlaySignature, canvasOverlays]);

  // Same signature-guarded pattern for effect layers: adding, moving, trimming,
  // retuning or bypassing one re-presents the current frame WITHOUT reloading a
  // decoder, which is what makes "the preview updates immediately while you
  // adjust" true rather than aspirational.
  const appliedEffectSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    appliedEffectSignatureRef.current = effectSignature;
  }, [edlSignature]);
  useEffect(() => {
    if (appliedEffectSignatureRef.current === effectSignature) return;
    engineRef.current?.setEffectLayers(effectLayers);
    appliedEffectSignatureRef.current = effectSignature;
  }, [effectSignature, effectLayers]);

  // Orientation change (project resolution) — the canvas buffer resizes via the
  // width/height attributes below (which clears it); tell the engine the new
  // resolution so the H4 transform math + letterbox aspect update and the frame
  // is re-presented. Skips the mount (the constructor already has it).
  const seededResolutionRef = useRef(false);
  useEffect(() => {
    if (!seededResolutionRef.current) {
      seededResolutionRef.current = true;
      return;
    }
    engineRef.current?.setResolution(resolution);
  }, [resolution.width, resolution.height]);

  // External seeks (timeline ruler, "at playhead" actions) while paused: move
  // the canvas to match. Guarded against our own onTimeUpdate echo by
  // comparing against the last value THIS component reported.
  useEffect(() => {
    if (edl.length === 0) return undefined;
    return editor.subscribePlayhead(() => {
      const engine = engineRef.current;
      // isStarting: play() is mid-startup (audio clock resuming) — isPlaying is
      // still false but a seek here would cancel the just-requested playback.
      if (!engine || engine.isPlaying || engine.isStarting) return;
      const projectTime = editor.getPlayhead();
      if (Math.abs(projectTime - lastReportedTimeRef.current) < 1 / Math.max(1, fps)) return;
      void engine.seek(projectTime);
    });
  }, [edl.length, editor, fps]);

  // Monitor volume/mute (revamp Phase 2). Pushed to the engine's master gain bus,
  // which applies to sources ALREADY playing — so the control works mid-playback
  // instead of only taking effect at the next seek. Safe before any media has
  // loaded: the engine retains the value until its audio bus exists.
  useEffect(() => {
    engineRef.current?.setVolume(monitorGain);
  }, [monitorGain, hasSegments]);

  // Tab-hidden pause (P4): a backgrounded tab throttles rAF and gains nothing
  // from decoding ahead, so pause playback when the document is hidden (the
  // pump only runs while playing, so this also stops decode). The user resumes
  // explicitly on return — we don't auto-resume.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden && engineRef.current?.isPlaying) {
        engineRef.current.pause();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <section
      className="preview"
      aria-label="preview"
      data-preview-engine="webcodecs"
      ref={previewRef}
    >
      {/* Audio-only tracks (music/VO/SFX) have no picture to ride, so the
          existing hidden mixer plays them in sync — it's driven entirely by
          the shared editor.state.playing/usePlayhead, which the engine above
          already keeps correct via setPlaying/seekTransient, so no engine
          changes were needed to wire this up (P2's "reuse PreviewAudioMixer
          for non-footage audio" per the plan). */}
      {/* The monitor's volume/mute governs BOTH audio paths: footage audio via the
          engine's master gain bus (setVolume, below) and audio-only clips via this
          mixer's monitor scale. One control, everything you hear. */}
      <PreviewAudioMixer
        editor={editor}
        assets={assets}
        soloedTrackIds={soloedTrackIds}
        monitorVolume={monitorGain}
      />
      <div className="preview-stage">
        <div
          className="preview-frame"
          style={{
            ['--aspect' as string]: String(aspect),
            transform: previewZoom === 'fit' ? undefined : `scale(${Number(previewZoom) / 100})`,
          }}
        >
          <div className="webcodecs-preview">
            <canvas
              ref={canvasRef}
              width={canvasWidth}
              height={canvasHeight}
              className="webcodecs-preview-canvas"
              aria-label="preview"
              role="img"
            />
            <WebCodecsCaptionLayer
              editor={editor}
              fps={fps}
              captionClips={captionClips}
              transcript={transcript ?? []}
            />
            {error && (
              <div className="webcodecs-preview-error" role="alert">
                {error}
              </div>
            )}
          </div>
          {/* On-canvas transform (revamp Phase 3). This monitor had NO canvas
              manipulation at all — select-hit and transform box lived on the
              retired `PreviewPlayer`, so when WebCodecs became the sole engine the
              affordance silently left the product. The coordinate math is
              unchanged from there: the canvas buffer carries the project aspect and
              fills `.preview-frame`, so the frame rect IS the project canvas area
              and a percent-based box needs no measuring. */}
          {/* Click the picture to select the clip that made it — the route into the
              handles for a user who has not touched the timeline. Keyed off the
              SHOWN clip, not the selected one: once selected, the transform box
              takes over this area and a hit-target behind it would fight it. */}
          {shownPicture && !transformSelected && (
            <button
              type="button"
              className="preview-select-hit"
              aria-label={`select clip ${shownPicture.id} in preview`}
              onClick={() => editor.select(shownPicture.id)}
            />
          )}
          {transformSelected && selectedPicture && (
            <PreviewTransform
              // Keyed by clip: switching selection starts a fresh gesture state
              // rather than carrying the previous clip's live override across.
              key={selectedPicture.id}
              value={baseTransform}
              resolution={resolution}
              snapping={settings.snapping}
              onPreview={setTransformOverride}
              onCommit={commitTransform}
            />
          )}
          {/* Selection is a UI layer, never baked into preview pixels. The canvas
              compositor owns ordinary text; the selected object is temporarily
              represented by the shared DOM editor so timeline selection has the
              same visible, reversible manipulation path as direct selection.

              Interaction follows NLE object isolation: a single click resolves
              to the background picture, while a double-click selects the topmost
              object under the pointer. Keyboard activation selects the object
              directly because there is no keyboard equivalent of double-click. */}
          <div className="preview-overlays" aria-label="preview objects">
            {activeOverlays.map((overlay) =>
              selectedOverlay?.id === overlay.id ? (
                <PreviewTextEditor
                  key={overlay.id}
                  params={overlay.params}
                  timeInClip={editor.state.playhead - overlay.start}
                  duration={overlay.end - overlay.start}
                  onCommit={(params) => commitTextParams(overlay.id, params)}
                />
              ) : (
                <p
                  key={overlay.id}
                  className="preview-overlay-object-hit"
                  style={{
                    ...textOverlayStyle(
                      overlay.params,
                      editor.state.playhead - overlay.start,
                      overlay.end - overlay.start,
                    ),
                    color: 'transparent',
                    background: 'transparent',
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`select text overlay ${overlay.id} in preview`}
                  onClick={(event) => {
                    event.stopPropagation();
                    editor.select(shownPicture?.id ?? null);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    editor.select(overlay.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    editor.select(overlay.id);
                  }}
                >
                  {overlay.params.text}
                </p>
              ),
            )}
          </div>
          {settings.gridByDefault && <div className="preview-grid" aria-hidden="true" />}
          {settings.safeAreaGuidesByDefault && (
            <div className="preview-safe-area" aria-hidden="true" />
          )}
        </div>
      </div>
      <PreviewTransport editor={editor} durationSec={durationSec} fps={fps} />
      <MonitorHeaderPortal host={headerControlsHost}>
        <PreviewViewControls
          resolution={resolution}
          {...(onChangeOrientation ? { onChangeOrientation } : {})}
          isGraded={isGraded}
          showGrade={showGrade}
          onToggleGrade={() => setShowGrade((visible) => !visible)}
          /* Loop is deliberately NOT passed: it lives in the transport now, with
             the rest of playback (revamp Phase 2, F3). Passing it here too would
             put two loop buttons in the same monitor. */
          showGrid={settings.gridByDefault}
          onToggleGrid={() => update({ gridByDefault: !settings.gridByDefault })}
          showSafeArea={settings.safeAreaGuidesByDefault}
          onToggleSafeArea={() =>
            update({ safeAreaGuidesByDefault: !settings.safeAreaGuidesByDefault })
          }
          zoom={previewZoom}
          onZoomChange={setPreviewZoom}
          onToggleFullscreen={toggleFullscreen}
        />
      </MonitorHeaderPortal>
    </section>
  );
}

type CaptionPreviewClip = {
  readonly clipId: string;
  readonly start: number;
  readonly end: number;
  readonly style: NonNullable<Parameters<typeof CaptionOverlay>[0]>['style'];
  readonly trackStyle: NonNullable<Parameters<typeof CaptionOverlay>[0]>['trackStyle'];
  readonly lines: readonly (readonly TranscriptWord[])[];
  readonly text: string;
};

/** The only React subtree that updates on each live tick. Keeping it separate
 * leaves the imperative canvas node completely outside the 60 fps React path. */
function WebCodecsCaptionLayer({
  editor,
  fps,
  captionClips,
  transcript,
}: {
  readonly editor: UseEditor;
  readonly fps: number;
  readonly captionClips: readonly CaptionPreviewClip[];
  readonly transcript: readonly TranscriptWord[];
}): JSX.Element {
  const currentTimeSec = useFramePlayhead(editor, fps);
  // Caption data changes at edit cadence, while this component renders at
  // project-frame cadence. Index once per authored change so an hour-long,
  // 7,000-cue movie does not scan all captions 30–60 times every second.
  const captionIndex = useMemo(() => buildTemporalIndex(captionClips), [captionClips]);
  const active = activeTimedItemsAt(captionIndex, currentTimeSec);
  return (
    <>
      {active.map((caption) => (
        <div key={caption.clipId} className="preview-caption-object">
          <CaptionOverlay
            style={caption.style}
            trackStyle={caption.trackStyle}
            lines={caption.lines}
            time={currentTimeSec}
          />
          <PreviewCaptionEditor
            clipId={caption.clipId}
            style={caption.style}
            trackStyle={caption.trackStyle}
            text={caption.text}
            selected={editor.state.selectedIds.includes(caption.clipId)}
            onSelect={() => editor.select(caption.clipId)}
            onStyleCommit={(stylePatch: Partial<CaptionStyle>) => {
              const patch = setCaptionStylePatch(editor.state.timeline, caption.clipId, {
                ...(caption.style ?? {}),
                ...stylePatch,
              });
              if (patch) editor.applyPatch(patch);
            }}
            onTextCommit={(text) => {
              const patch = setCaptionCuePatch(
                editor.state.timeline,
                caption.clipId,
                text,
                transcript,
              );
              if (patch) editor.applyPatch(patch);
            }}
          />
        </div>
      ))}
    </>
  );
}

/* The monitor's own transport was replaced by the shared `PreviewTransport`
   (revamp Phase 2): it adds prev/next edit point, loop, volume/mute and a real
   pointer-accurate scrub bar with the project's cut ticks, in place of the plain
   stepped `<input type=range>` this component used to render. Keeping a second
   copy here would have been two control sets to keep in step. */
