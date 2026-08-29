/**
 * Program monitor (plan/PLAN.md Phase 3.2 — "Preview player (HTML video + canvas
 * overlays, proxy media)").
 *
 * Render-vs-preview rule (AGENTS.md): preview is **HTML video**, never MoviePy.
 * The player shows the video clip active at the playhead (its proxy/source via
 * the asset path) and draws text/caption overlays active at the same time on top.
 * Which clips are active is the pure, tested `clipsActiveAt` projection; this
 * component is the thin DOM shell around it, plus a lightweight transport that
 * advances the playhead in real time (no engine render involved).
 *
 * **Smooth cuts (element pool).** A fast montage cuts between many video clips.
 * Mounting a fresh `<video>` at every cut — or re-seeking one element to the
 * next clip's in-point — stalls on fetch + keyframe decode: a visible freeze at
 * every cut. Instead the monitor keeps a small POOL of persistent video slots:
 * the FRONT slot plays the active clip; every other slot pre-loads and
 * pre-seeks one *upcoming* clip (same-asset trims included) so each cut is an
 * instant swap to an already-decoded element, never a remount. The pure
 * `nextPool` reducer decides which slot is front and what each must hold; this
 * component applies the assignments to the elements and rides the front slot's
 * clock.
 *
 * **Prepare-on-play.** Pressing play does not start the transport raw: a gate
 * holds the clock until the front element is actually playable (fetched,
 * decoded, seeked to its in-point) — showing a brief "Preparing preview…"
 * status instead of a stuttering cold start — with a hard timeout so play can
 * never hang on unresponsive media.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateKeyframes, resolveCaptionCue } from '@framepilot/editor-core';
import type {
  Asset,
  CaptionStyle,
  Clip,
  Effect,
  TranscriptWord,
} from '@framepilot/timeline-schema';
import { useFramePlayhead, type UseEditor } from '../editor/useEditor.js';
import { PreviewEffectOverlay } from './PreviewEffectOverlay.js';
import { previewMediaSrc } from '../editor/media.js';
import {
  EMPTY_POOL,
  IDENTITY_GRADE,
  PREVIEW_POOL_SIZE,
  activeClipsAt,
  audioSettings,
  clipBlendMode,
  clipKind,
  clipCropRect,
  FULL_FRAME_CROP,
  isFullFrameCrop,
  createPlaybackIndex,
  colorGradeCssFilter,
  colorGradeParams,
  dbToGain,
  effectiveMutedTrackIds,
  formatTime,
  isOverlayKind,
  isPictureKind,
  nextPool,
  prerollLead,
  prerollSeekTarget,
  shouldPreroll,
  timelineDuration,
  upcomingVideoFrom,
  effectLayersInApplyOrder,
} from '../editor/selectors.js';
import { useSettings } from '../editor/useSettings.js';
import { PreviewAudioMixer } from './PreviewAudioMixer.js';
import { MonitorHeaderPortal } from './MonitorHeaderPortal.js';
import { PreviewViewControls, type PreviewZoom } from './PreviewViewControls.js';
import {
  PreviewTransform,
  type ClipTransformValues,
  type TransformOverride,
} from './PreviewTransform.js';
import {
  type TextOverlayParams,
  readTextParams,
  setCaptionCuePatch,
  setCaptionStylePatch,
  setClipTransformPatch,
  setTextParamsPatch,
} from '../editor/patch-builders.js';
import { cropObjectPosition } from '../preview/crop-fill.js';
import { textOverlayStyle } from '../editor/textOverlay.js';
import {
  blurRadiusAt,
  offsetAt as transitionOffsetAt,
  opacityAt as transitionOpacityAt,
  scaleAt as transitionScaleAt,
  transitionActiveAt,
  transitionCounterpartId,
  transitionFromClip,
  wipeCssMask,
  wipeProgressAt,
} from '../preview/transition-envelope.js';
import { CaptionOverlay } from './CaptionOverlay.js';
import { PreviewTextEditor } from './PreviewTextEditor.js';
import { PreviewCaptionEditor } from './PreviewCaptionEditor.js';
import { Tooltip } from './Tooltip.js';
import { describeFrameFit } from '../preview/frame-fit.js';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  ICON_SIZE,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from './icons.js';

export interface PreviewPlayerProps {
  readonly editor: UseEditor;
  /** Project assets, used to resolve a clip's source media for `<video>`. */
  readonly assets: readonly Asset[];
  /** Project frame rate, for frame-accurate transport timecode + stepping. */
  readonly fps: number;
  /** Project aspect ratio (width / height) for letterboxing; defaults to 16:9. */
  readonly aspect?: number;
  /** Current project canvas, drives the orientation selector (H5). */
  readonly resolution?: { readonly width: number; readonly height: number };
  /** Change the project canvas to an orientation preset id (H5). */
  readonly onChangeOrientation?: (presetId: string) => void;
  /** Shared Source/Program header lane for monitor-specific view controls. */
  readonly headerControlsHost?: HTMLElement | null;
  /**
   * Track ids currently soloed for preview monitoring (H0.4 J2) — session-local
   * view state owned by the timeline (`useTrackLayout.ts`), never the project.
   * Overrides the persisted `muted` flag for playback only; empty = none.
   */
  readonly soloedTrackIds?: ReadonlySet<string>;
  /**
   * Force-silence this player's footage audio AND its `PreviewAudioMixer`
   * regardless of clip/track settings (AI review player side-by-side compare,
   * H1.5/J3): the BEFORE panel mounts a full `PreviewPlayer` next to AFTER's,
   * and only one side should be heard. Defaults to false everywhere else.
   */
  readonly muted?: boolean;
  /**
   * Word-level project transcript — the text source for caption clips
   * (template-based captions, schema v10). Absent = captions don't preview.
   */
  readonly transcript?: readonly TranscriptWord[];
}

/** Extract overlay text from a clip's effects (text overlays / captions). */
function overlayText(effects: readonly Effect[]): string[] {
  return effects
    .filter((effect) => effect.type === 'text' || effect.type === 'caption')
    .map((effect) => String((effect.params as { text?: unknown }).text ?? ''))
    .filter((text) => text.length > 0);
}

/**
 * Re-seek the element only for a mismatch this large (seconds). Frame-to-frame
 * the element *is* the clock, so its time already matches the playhead and we
 * leave it alone; this only catches a scrub or a cut to a discontinuous source.
 */
const RESYNC_THRESHOLD_SECONDS = 0.5;

/**
 * Drift (seconds) past which the clock pulls the element to a trimmed clip's
 * source in-point. Small enough to land on the right frame, large enough that a
 * frame of normal playback jitter never triggers a re-seek.
 */
const WINDOW_SEEK_EPSILON = 0.05;

/**
 * Upper bound (ms) on the prepare-on-play hold. Preparing the whole pipeline
 * (front + all warm slots) normally completes well under a second per element
 * (local media over `fp-media://`, loaded in parallel); the cap guarantees the
 * transport can never hang on media that refuses to signal readiness.
 */
const PREPARE_TIMEOUT_MS = 2500;

/**
 * `readyState` at which the element has a decoded frame at its current position
 * (HAVE_CURRENT_DATA). Named because jsdom lacks the HTMLMediaElement constants.
 */
const READY_STATE_HAS_FRAME = 2;

/** One frame in seconds, with a safe fallback for an unusable fps. */
const frameSeconds = (fps: number): number => (fps > 0 ? 1 / fps : 1 / 30);

/** Clamp a value into HTMLMediaElement's valid volume range [0, 1]. */
const clampVolume = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** No tracks soloed — the default when the caller doesn't pass any. */
const NO_SOLO: ReadonlySet<string> = new Set();

/** The pool slot indices, for rendering one persistent element per slot. */
const POOL_SLOTS: readonly number[] = Array.from({ length: PREVIEW_POOL_SIZE }, (_, i) => i);

/**
 * How far back from a clip's out-point the shot UNDER a transition ramp is parked.
 *
 * Its out-point is exclusive, so seeking exactly there lands on the first frame the clip does
 * not include (or past the end of a clip cut to its asset's edge, which decodes nothing at
 * all and paints black — the very thing the under-layer exists to prevent). One frame at a
 * conservative 24fps is inside every clip long enough to carry a transition.
 */
const UNDERLAY_EDGE_FRAME_SECONDS = 1 / 24;

/**
 * Where a slot should sit: its in-point normally, or its LAST frame when it is holding the
 * shot underneath a transition ramp.
 *
 * One definition, because two places move that element — the load handler and the warm-slot
 * alignment pass — and if they disagree the alignment pass wins and drags the under-layer back
 * to the start of the outgoing shot. That reads as the right shot at emphatically the wrong
 * moment, which is harder to spot than the black frame it replaced.
 */
function slotParkTime(clip: Clip, isUnderlay: boolean): number {
  if (!isUnderlay || clip.sourceEnd === undefined) return clip.sourceStart;
  return Math.max(clip.sourceStart, clip.sourceEnd - UNDERLAY_EDGE_FRAME_SECONDS);
}

export function PreviewPlayer({
  editor,
  assets,
  fps,
  aspect = 16 / 9,
  resolution,
  onChangeOrientation,
  headerControlsHost,
  soloedTrackIds = NO_SOLO,
  muted = false,
  transcript,
}: PreviewPlayerProps): JSX.Element {
  const { timeline, playing } = editor.state;
  // The media transport still advances the live clock at display/media cadence,
  // while React-visible DOM composition changes only on real project frames.
  // A 120/144 Hz display therefore cannot schedule multiple heavy preview commits
  // for one 24/30 fps project frame.
  const playhead = useFramePlayhead(editor, fps);
  const { settings, update } = useSettings();
  // Loop + composition grid are persisted preferences, so the monitor buttons and
  // the Settings dialog drive one shared value (no transient local copy to drift).
  const showGrid = settings.gridByDefault;
  const showSafeArea = settings.safeAreaGuidesByDefault;
  const loop = settings.loopByDefault;
  // Before/after compare: when off, the monitor drops the grade approximation so
  // the user can eyeball the ungraded source. View-only (invariant 5).
  const [showGrade, setShowGrade] = useState(true);
  // Preview zoom (reference: the "Fit" dropdown) — scales the letterboxed frame
  // within the stage; the stage scrolls when the frame is scaled past its bounds.
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>('fit');
  /**
   * Fullscreen target: the WHOLE monitor, picture plus transport — not the stage
   * alone. Fullscreening just the stage left the user in a bare picture with no
   * play button, no timecode, and no scrub (the timeline dock is hidden too), so
   * fullscreen was a dead end you could only leave by guessing at Escape.
   */
  const previewRef = useRef<HTMLElement>(null);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      const monitor = previewRef.current?.closest<HTMLElement>('.stage-monitor');
      void (monitor ?? previewRef.current)?.requestFullscreen();
    }
  };
  // Image-transition gate (H3): when cutting video → still image, the departed
  // video frame is held until the <img> has actually decoded — an unloaded image
  // painted immediately reads as a white/black flash at the cut.
  const [imageReady, setImageReady] = useState(false);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  // Resolve any clip id a buffer slot holds (active *or* pre-warmed next) back to
  // its clip so the slot's <video src> + seek target can be derived declaratively.
  const clipById = useMemo(
    () => new Map(timeline.tracks.flatMap((t) => t.clips).map((c) => [c.id, c] as const)),
    [timeline],
  );
  const duration = timelineDuration(timeline);
  // Playback index (H3/H8): built once per timeline change so the per-frame
  // active/upcoming lookups below are O(log n), not an O(all clips) walk — the
  // difference between steady 60fps and creeping CPU on an hour-long project.
  const playbackIndex = useMemo(
    () => createPlaybackIndex(timeline, assetById),
    [timeline, assetById],
  );
  const loopRef = useRef(loop);
  loopRef.current = loop;

  /** Step the playhead by whole frames, clamped to the timeline (pauses first). */
  const stepFrames = (count: number): void => {
    editor.setPlaying(false);
    const next = playhead + count * frameSeconds(fps);
    editor.seek(Math.min(duration, Math.max(0, next)));
  };

  const active = activeClipsAt(playbackIndex, playhead);
  // Pick the topmost (index 0 = front) picture clip by its derived kind, across ALL
  // non-hidden layers — never by the layer's advisory `type` (Phase 2, ADR 0032).
  // A hidden track contributes no picture/overlays (mirrors the render); audio
  // muting is a render concern handled by the mixer, not the picture path.
  const videoLocation = active.find(
    (l) => !l.track.hidden && isPictureKind(clipKind(l.clip, assetById)),
  );
  const videoClip = videoLocation?.clip ?? null;
  const videoAsset = videoClip ? assetById.get(videoClip.assetId) : undefined;
  // UX-14 — see `describeFrameFit`. Null whenever there is nothing to say: an
  // exact fit, no picture clip, or a source the engine has not probed.
  const frameFit = useMemo(
    () =>
      videoAsset
        ? describeFrameFit(
            videoAsset.media,
            { width: resolution?.width ?? 1920, height: resolution?.height ?? 1080 },
            videoClip?.crop,
          )
        : null,
    [videoAsset, videoClip, resolution],
  );
  // Footage audio honors the same flags as the render: a muted picture layer
  // (schema v4) or a clip whose `audio_gain` is muted silences the element; the
  // clip's gain scales its volume. Audio-only tracks are handled by the mixer.
  // The picture layer's mute is folded through solo (H0.4 J2): a monitoring-only
  // override of the persisted flag, never the render (which ignores solo).
  const effectiveMuted = useMemo(
    () => effectiveMutedTrackIds(timeline.tracks, soloedTrackIds, assetById),
    [timeline.tracks, soloedTrackIds, assetById],
  );
  const videoAudio = videoClip ? audioSettings(videoClip) : null;
  const videoMuted =
    (videoLocation ? effectiveMuted.has(videoLocation.track.id) : false) ||
    (videoAudio?.muted ?? false);
  const videoVolume = videoAudio ? dbToGain(videoAudio.gainDb) : 1;
  // An image is a still picture, not a playable element: it has no media clock to
  // ride. We mount it as an <img> and let the wall-clock advance the playhead
  // through its duration — riding a non-existent <video> clock would freeze the
  // playhead the moment it reached the still (the element never plays or "ends").
  const isImageClip = videoClip ? clipKind(videoClip, assetById) === 'image' : false;
  const isVideoElement = videoClip !== null && !isImageClip;
  const imageAssetId = isImageClip ? (videoAsset?.id ?? null) : null;
  useEffect(() => {
    setImageReady(false);
  }, [imageAssetId]);
  // Where inside the source media the playhead currently sits (source time, not
  // timeline time): the offset into the clip plus the clip's source in-point.
  // Only meaningful for a playable <video>; a still image has no source clock.
  const sourceTime =
    videoClip && isVideoElement ? videoClip.sourceStart + (playhead - videoClip.start) : null;

  // The clips the preview will cut to next (strictly after the current clip, or
  // after the playhead in a gap). Each is pre-warmed in its OWN pool slot so the
  // browser fetches, decodes and pre-seeks it *before* the cut — the swap then
  // lands on ready media instead of stalling on a cold load or an in-file seek
  // (what reads as the 100-200ms freeze). Same-asset trims are warmed too: they
  // need their own element pre-seeked to their in-point just as much.
  const upcomingIds = upcomingVideoFrom(
    playbackIndex,
    videoClip ? videoClip.start : playhead,
    PREVIEW_POOL_SIZE - 1,
  ).map((l) => l.clip.id);

  // --- Element-pool state ------------------------------------------------------
  const [pool, setPool] = useState(EMPTY_POOL);
  const slotEls = useRef<(HTMLVideoElement | null)[]>(
    Array.from({ length: PREVIEW_POOL_SIZE }, () => null),
  );

  // Which clip each slot has a DECODED, SEEKED frame for (readiness, tracked per
  // slot from the elements' media events). Distinct from `pool.loaded` — a load
  // command that was issued vs a frame that can actually be painted. Everything
  // visual gates on this: the visible-slot swap, and the prepare-on-play hold.
  const [readySlots, setReadySlots] = useState<readonly (string | null)[]>(EMPTY_POOL.loaded);
  const markSlotFrame = (slot: number, id: string | null): void => {
    setReadySlots((prev) => (prev[slot] === id ? prev : prev.map((v, i) => (i === slot ? id : v))));
  };

  // The slot the monitor is SHOWING. It lags the front slot on purpose: at a cut
  // it only advances once the new front has a ready frame, holding the departed
  // clip's last frame for the few ms in between — a held frame is invisible at
  // 30fps, a black flash is not. This is what makes the swap flicker-free.
  const [visibleSlot, setVisibleSlot] = useState(0);
  /**
   * The clip a transition on the ACTIVE clip is transitioning from, if any.
   *
   * Read here rather than beside the live envelope below because the warm-slot alignment pass
   * needs it: that pass re-seeks every non-front slot to its in-point, which would drag the
   * under-layer back to the start of the outgoing shot.
   */
  const transitionCounterpartClipId = videoClip ? transitionCounterpartId(videoClip) : null;
  /** The still-image element, when the playhead sits on an image clip. */
  const imageElRef = useRef<HTMLImageElement | null>(null);

  // --- Effect layers (schema v13, ADR 0088) ---------------------------------
  //
  // The overlay samples whichever element is currently showing the picture. Both
  // getters are refs-backed and read at frame time rather than captured, because
  // the pool swaps slots at every cut and the playhead moves ~60x a second — a
  // captured value would freeze the effect on the frame it mounted.
  const effectLayers = useMemo(
    () => effectLayersInApplyOrder(editor.state.timeline),
    [editor.state.timeline],
  );
  const visibleSlotRef = useRef(visibleSlot);
  visibleSlotRef.current = visibleSlot;
  const getEffectSource = useCallback(
    (): HTMLVideoElement | HTMLImageElement | null =>
      imageElRef.current ?? slotEls.current[visibleSlotRef.current] ?? null,
    [],
  );
  const getEffectTime = useCallback((): number => editor.getPlayhead(), [editor]);

  const activePictureId = isVideoElement ? (videoClip?.id ?? null) : null;
  // The front slot drives the master clock only once it actually holds the active
  // clip (after a swap / cold load); during a load bridge we fall to the wall clock.
  const frontHoldsActive = activePictureId !== null && pool.loaded[pool.front] === activePictureId;
  // The front slot can be painted: it holds the active clip AND has a ready frame.
  const frontReady = frontHoldsActive && readySlots[pool.front] === activePictureId;

  // Advance the visible slot only when the front is actually paintable.
  useEffect(() => {
    if (frontReady) setVisibleSlot(pool.front);
  }, [frontReady, pool.front]);

  // Assign slots whenever the active or upcoming clips change. `nextPool` is
  // deterministic (a fixed point once stable), so the changed-guard stops the
  // effect from looping even though `upcomingIds` is a fresh array per render.
  // The visible slot is protected from warm-recycling mid-bridge (see nextPool).
  useEffect(() => {
    const next = nextPool(pool, activePictureId, upcomingIds, visibleSlot);
    const changed =
      next.front !== pool.front || next.loaded.some((id, slot) => id !== pool.loaded[slot]);
    if (changed) setPool(next);
  }, [pool, activePictureId, upcomingIds, visibleSlot]);

  // The element the master clock rides: the front slot when it holds the active
  // clip, else null (image / gap / mid-load → wall clock). Updated every render;
  // the clock reads it live at tick time (established ref-latch pattern below).
  const frontElRef = useRef<HTMLVideoElement | null>(null);
  frontElRef.current = frontHoldsActive ? (slotEls.current[pool.front] ?? null) : null;

  // The playback loop reads the latest render values through refs so it can stay
  // subscribed across the per-frame re-renders `seek` causes (the editor object's
  // identity changes every render; its actions are stable).
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const frameRef = useRef({ videoClip, duration, rideVideo: frontHoldsActive });
  frameRef.current = { videoClip, duration, rideVideo: frontHoldsActive };

  // The immediate on-deck clip (the very next cut) and the slot pre-warming it,
  // for the clock's pre-roll: it starts that slot playing just before the cut so
  // the swap lands on an already-progressing element, not a paused one (see
  // `shouldPreroll`). Read live from the clock through a ref, like `frameRef`.
  const onDeckId = upcomingIds[0] ?? null;
  const onDeckSlot = onDeckId ? pool.loaded.indexOf(onDeckId) : -1;
  const onDeckClip = onDeckId ? (clipById.get(onDeckId) ?? null) : null;
  const onDeckReady = onDeckSlot >= 0 && readySlots[onDeckSlot] === onDeckId;
  const onDeckRef = useRef<{ slot: number; clip: Clip; ready: boolean } | null>(null);
  onDeckRef.current =
    onDeckClip && onDeckSlot >= 0
      ? { slot: onDeckSlot, clip: onDeckClip, ready: onDeckReady }
      : null;
  // The clip id already pre-rolled (dedupe: one start per on-deck window) and the
  // slot it plays in (so the warm-alignment reseek below leaves it alone).
  const prerolledClipRef = useRef<string | null>(null);
  const prerolledSlotRef = useRef<number>(-1);

  // --- Prepare-on-play gate ----------------------------------------------------
  // Pressing play does not start the transport raw: the gate holds the clock
  // until the WHOLE pipeline is prepared — the front element AND every warmed
  // upcoming slot have decoded, seeked frames — so playback opens flawlessly and
  // the first cuts land on ready media, instead of stuttering through cold
  // loads. Pausing re-arms the gate, so a play after a scrub prepares the new
  // position too. A hard cap bounds the hold — play can never hang on media
  // that refuses to signal readiness.
  const pipelinePrepared =
    frontReady && pool.loaded.every((id, slot) => id === null || readySlots[slot] === id);
  const [prepared, setPrepared] = useState(false);
  /* v8 ignore start -- readiness needs a real media pipeline: verified in e2e. */
  useEffect(() => {
    if (!playing) {
      setPrepared(false);
      return;
    }
    if (prepared) return;
    // Nothing to decode under the playhead (gap / still image): start at once.
    if (!isVideoElement || pipelinePrepared) {
      setPrepared(true);
      return;
    }
    const cap = window.setTimeout(() => setPrepared(true), PREPARE_TIMEOUT_MS);
    return () => window.clearTimeout(cap);
  }, [playing, prepared, isVideoElement, pipelinePrepared]);
  /* v8 ignore stop */

  // --- Master playback clock -------------------------------------------------
  // When a video clip sits under the playhead, the FRONT <video> element *is* the
  // clock: we read its `currentTime` and map it back to timeline time, so the
  // picture and the playhead never fight (writing `currentTime` every frame was
  // the source of the flicker). Sections with no video to ride (gaps, audio-only,
  // overlay-only, still images, or a mid-load swap) advance on a wall-clock tick.
  // The clock only starts once the prepare gate opens.
  /* v8 ignore start -- rAF + HTMLMediaElement clock: jsdom has neither, so this
     is verified manually / in e2e, not in the unit suite. */
  useEffect(() => {
    if (!playing || !prepared) return;
    let raf = 0;
    let lastWall = performance.now();
    // Re-arm pre-roll for this playback run: a fresh play (or a play after a
    // scrub) must be free to pre-roll the new on-deck clip from scratch.
    prerolledClipRef.current = null;
    prerolledSlotRef.current = -1;
    const tick = (now: number): void => {
      const ed = editorRef.current;
      const { videoClip: clip, duration: end, rideVideo } = frameRef.current;
      const video = frontElRef.current;
      const dt = (now - lastWall) / 1000;
      lastWall = now;

      // Pre-roll the on-deck slot so the next cut swaps to an already-playing
      // element (no play()-startup freeze). Only while a video clip is under the
      // playhead — during a gap the on-deck cut is not imminent and a pre-rolled
      // element would overshoot its in-point before it ever became front.
      const onDeck = onDeckRef.current;
      if (rideVideo && onDeck && onDeck.ready && prerolledClipRef.current !== onDeck.clip.id) {
        const lead = prerollLead(onDeck.clip);
        if (shouldPreroll(onDeck.clip.start - ed.getPlayhead(), lead)) {
          const el = slotEls.current[onDeck.slot];
          if (el) {
            try {
              el.currentTime = prerollSeekTarget(onDeck.clip);
              const started = el.play() as unknown as Promise<void> | undefined;
              started?.catch?.(() => {
                /* autoplay can be blocked until a gesture; the swap still works. */
              });
            } catch {
              /* jsdom / unsupported media: the transport effect is authoritative. */
            }
          }
          prerolledClipRef.current = onDeck.clip.id;
          prerolledSlotRef.current = onDeck.slot;
        }
      }

      let next: number;
      // Only ride the front <video> clock for a real playable clip it holds. A
      // still image (or a gap / audio-only / mid-load section) has no element to
      // ride, so it advances on the wall clock below.
      if (clip && rideVideo && video && !video.ended) {
        const sourceIn = clip.sourceStart;
        const ct = video.currentTime;
        // Ride the element's own clock ONLY while it is genuinely progressing
        // (playing, not seeking, past its in-point). At a cut the freshly-swapped
        // slot sits paused at its in-point and takes a frame or two to actually
        // start; pinning the playhead to it during that spin-up FREEZES the
        // playhead for those milliseconds — the micro-stutter felt against steady
        // music. Instead, bridge every not-yet-progressing moment with the wall
        // clock so motion is seamless, then hand back to the element once it is
        // truly advancing (their times agree to sub-frame, so no visible jump).
        const progressing =
          !video.paused &&
          !video.seeking &&
          Number.isFinite(ct) &&
          ct > sourceIn + WINDOW_SEEK_EPSILON;
        if (ct < sourceIn - WINDOW_SEEK_EPSILON) {
          // The element is still inside the trimmed-off head (e.g. a clip whose
          // source in-point is > 0, freshly mounted at currentTime 0). Pull it to
          // the clip's in-point; the wall clock keeps the playhead moving so the
          // cut stays seamless while the element seeks into place. (This correction
          // must live in the clock, not a playhead-keyed effect: with the playhead
          // advancing on the wall clock its deps change every frame, but the seek
          // target is derived here where the element's live time is known.)
          try {
            video.currentTime = sourceIn + (ed.getPlayhead() - clip.start);
          } catch {
            /* jsdom / unsupported media: the seek effect is authoritative. */
          }
          next = ed.getPlayhead() + dt;
        } else if (progressing) {
          // In (or just past) the source window and actually advancing: ride the
          // element's own clock — smooth, no per-frame writes. Past the out-point
          // this yields next ≥ clip.end, advancing into the next clip / the end.
          next = clip.start + (ct - sourceIn);
        } else {
          // Starting / seeking / sitting at the in-point right after a swap: bridge
          // with the wall clock so the cut is seamless while the slot spins up.
          next = ed.getPlayhead() + dt;
        }
      } else {
        next = ed.getPlayhead() + dt; // no video to ride (gap / audio / image / load)
      }

      if (next >= end) {
        if (loopRef.current) {
          ed.seek(0);
          raf = requestAnimationFrame(tick);
          return;
        }
        ed.seek(end);
        ed.setPlaying(false);
        return;
      }
      // Per-frame advance moves ONLY the playhead clock — no reducer dispatch, so
      // the editor tree is not re-rendered 60×/s. `setPlaying(false)` (pause) and
      // the discrete seeks above commit the final position into the reducer.
      ed.seekTransient(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, prepared]);

  // --- Footage audio gain: scale the front element volume by the clip's gain --
  useEffect(() => {
    const front = slotEls.current[pool.front];
    if (front) front.volume = clampVolume(videoVolume);
  }, [videoVolume, pool.front]);

  // --- Element transport: play the FRONT slot, keep every other slot paused ---
  // The front only starts once the prepare gate opens; warm slots are silent
  // pre-buffers and must never play.
  useEffect(() => {
    for (const slot of POOL_SLOTS) {
      const el = slotEls.current[slot];
      if (!el) continue;
      try {
        if (slot === pool.front && playing && prepared && frontHoldsActive) {
          const started = el.play() as unknown as Promise<void> | undefined;
          if (started && typeof started.catch === 'function') {
            started.catch(() => {
              /* autoplay can be blocked until a user gesture; transport still runs. */
            });
          }
        } else {
          el.pause();
        }
      } catch {
        /* jsdom / unsupported media: ignore; the playhead clock is authoritative. */
      }
    }
  }, [playing, prepared, pool.front, frontHoldsActive]);

  // --- Element seek: align the FRONT picture *without* interrupting playback --
  // While paused, snap exactly to the playhead so scrubbing updates the frame.
  // While playing, only correct a gross mismatch (a scrub mid-play); a smooth
  // play has delta ≈ 0, so the element is never touched and never flickers. The
  // playhead-held case (element still in a trimmed clip's cut-off head) is handled
  // in the clock itself — see the master playback loop — because this effect is
  // keyed on the playhead and would never fire while the playhead is held.
  useEffect(() => {
    const front = slotEls.current[pool.front];
    if (!front || sourceTime === null || !frontHoldsActive) return;
    try {
      const delta = Math.abs(front.currentTime - sourceTime);
      if (!playing) {
        if (delta > 0.001) front.currentTime = sourceTime;
      } else if (delta > RESYNC_THRESHOLD_SECONDS) {
        front.currentTime = sourceTime;
      }
    } catch {
      /* jsdom has no media clock. */
    }
  }, [sourceTime, playing, pool.front, frontHoldsActive]);

  // --- Warm-slot alignment: pre-seek a slot whose CLIP changed but whose SRC
  // did not. Two clips trimmed from the same asset reuse the same file, so
  // `onLoadedMetadata` never re-fires for the reassignment — yet the slot must
  // still land on the new clip's in-point ahead of the cut, or the cut stalls
  // on an in-file seek (the exact freeze the pool exists to remove).
  useEffect(() => {
    for (const slot of POOL_SLOTS) {
      if (slot === pool.front) continue; // the live front-seek effect above owns it
      // A slot mid-pre-roll is deliberately advancing past its in-point toward the
      // cut; re-seeking it back to the in-point here would re-freeze the swap.
      if (slot === prerolledSlotRef.current) continue;
      const el = slotEls.current[slot];
      const id = pool.loaded[slot];
      // readyState 0 = no metadata yet (a fresh src): onLoadedMetadata will seek.
      if (!el || !id || el.readyState < 1) continue;
      const clip = clipById.get(id);
      if (!clip) continue;
      try {
        const target = slotParkTime(clip, id === transitionCounterpartClipId);
        if (Math.abs(el.currentTime - target) > WINDOW_SEEK_EPSILON) {
          el.currentTime = target;
        }
      } catch {
        /* jsdom has no media clock. */
      }
    }
  }, [pool, clipById, transitionCounterpartClipId]);
  /* v8 ignore stop */

  // Active caption clips render via the template-based CaptionOverlay
  // (schema v10, ADR 0069): their words come from the project transcript and
  // their look from the resolved caption template — never the text-overlay
  // params path below.
  const captions = active
    .filter((l) => !l.track.hidden && clipKind(l.clip, assetById) === 'caption')
    .map((l) => {
      const cue = resolveCaptionCue(l.clip, transcript ?? []);
      return {
        clipId: l.clip.id,
        style: l.clip.captionStyle,
        trackStyle: l.track.captionStyle,
        lines: cue.lines,
        text: cue.text,
      };
    })
    .filter((c) => c.lines.some((line) => line.length > 0));

  // Active text overlays, each with its resolved styling params and the
  // current time within the clip (drives the in/out animation).
  const overlays = active
    .filter(
      (l) =>
        !l.track.hidden &&
        isOverlayKind(clipKind(l.clip, assetById)) &&
        clipKind(l.clip, assetById) !== 'caption',
    )
    .map((l) => {
      const params = readTextParams(l.clip);
      const texts = overlayText(l.clip.effects);
      const text = params.text || texts[0] || '';
      return {
        clipId: l.clip.id,
        text,
        params,
        timeInClip: Math.max(0, playhead - l.clip.start),
        duration: l.clip.end - l.clip.start,
      };
    })
    .filter((o) => o.text.length > 0);

  // --- On-canvas transform (H4) ---------------------------------------------
  // The active picture clip's transform, honoring keyframed animation at the
  // playhead; the drag override wins while a handle gesture is in flight.
  const [transformOverride, setTransformOverride] = useState<TransformOverride>(null);
  const clipTime = videoClip ? Math.max(0, playhead - videoClip.start) : 0;
  const evaluatedTransform: ClipTransformValues = videoClip
    ? {
        scale: evaluateKeyframes(videoClip.keyframes, 'scale', clipTime) ?? 1,
        x: evaluateKeyframes(videoClip.keyframes, 'x', clipTime) ?? 0,
        y: evaluateKeyframes(videoClip.keyframes, 'y', clipTime) ?? 0,
      }
    : { scale: 1, x: 0, y: 0 };
  const liveTransform = transformOverride ?? evaluatedTransform;
  // The clip's BASE transform (time 0) — what the handles edit and commit.
  const baseTransform: ClipTransformValues = videoClip
    ? {
        scale: evaluateKeyframes(videoClip.keyframes, 'scale', 0) ?? 1,
        x: evaluateKeyframes(videoClip.keyframes, 'x', 0) ?? 0,
        y: evaluateKeyframes(videoClip.keyframes, 'y', 0) ?? 0,
      }
    : { scale: 1, x: 0, y: 0 };
  const identityTransform =
    liveTransform.scale === 1 && liveTransform.x === 0 && liveTransform.y === 0;
  // Percent-based CSS: the media element fills the frame, so translate% of its
  // own size equals the canvas fraction — no measuring, resolution optional.
  const cssTransform =
    !identityTransform && resolution
      ? `translate(${(liveTransform.x / resolution.width) * 100}%, ${(liveTransform.y / resolution.height) * 100}%) scale(${liveTransform.scale})`
      : undefined;
  const transformSelected = Boolean(
    videoClip && resolution && editor.state.selectedIds.includes(videoClip.id),
  );
  const commitTransform = (values: ClipTransformValues): void => {
    if (!videoClip) return;
    const patch = setClipTransformPatch(timeline, videoClip.id, values);
    if (patch) editor.applyPatch(patch);
  };

  /** Commit an on-canvas text-overlay edit (move/resize/inline text) reversibly. */
  const commitTextParams = (clipId: string, patch: Partial<TextOverlayParams>): void => {
    const built = setTextParamsPatch(timeline, clipId, patch);
    if (built) editor.applyPatch(built);
  };

  // Approximate live color preview of the active video clip's grade (the exact
  // result is the Python render; CSS filters can't reproduce it per-channel).
  const grade = videoClip ? colorGradeParams(videoClip) : IDENTITY_GRADE;
  const gradeFilter = showGrade ? colorGradeCssFilter(grade) : 'none';
  const isGraded = colorGradeCssFilter(grade) !== 'none';

  // `mixBlendMode` is CSS's direct analog of the engine's blend modes. Speed has no preview
  // hookup yet: the master clock above maps the front element's own currentTime 1:1 to
  // timeline time, and making that speed-aware is deferred (documented in plan/PLAN.md
  // H1.2h) — the committed patch and the real render are unaffected.
  // CROP FILLS THE FRAME, as the export does (`crop-fill.ts` explains the arithmetic and the
  // divergence it closes). `object-fit: cover` plus an `object-position` derived from the crop
  // shows the cropped column edge to edge; the old `clip-path` masked it in place over a
  // letterboxed full frame, so the monitor showed a small picture floating in black while the
  // export was full-bleed — and the agent wrote compensating zoom into the project to correct
  // a picture that was already right.
  const crop = videoClip ? clipCropRect(videoClip) : FULL_FRAME_CROP;
  const cropped = videoClip !== null && !isFullFrameCrop(crop);
  const [cropX, cropY] = cropObjectPosition(crop);
  const blendMode = videoClip ? clipBlendMode(videoClip) : 'normal';

  // Live transition envelope (same math the export uses — see
  // preview/transition-envelope.ts). Stills skip transitions here for export
  // parity: the compiler defers them on image clips.
  const transitionEnvelope = videoClip && !isImageClip ? transitionFromClip(videoClip) : null;
  const transition =
    transitionEnvelope && transitionActiveAt(transitionEnvelope, clipTime)
      ? transitionEnvelope
      : null;
  // The slot element fills the frame box, so a translate in % of its own size
  // equals the same fraction of the frame — resolution-independent offsets.
  const [transitionDxPct, transitionDyPct] = transition
    ? transitionOffsetAt(transition, clipTime, 100, 100)
    : [0, 0];
  const transitionScale = transition ? transitionScaleAt(transition, clipTime) : 1;
  const transitionBlurPx = transition
    ? blurRadiusAt(
        transition,
        clipTime,
        resolution ? Math.min(resolution.width, resolution.height) : 720,
      )
    : 0;
  const transitionWipeProgress = transition ? wipeProgressAt(transition, clipTime) : 1;
  // Compose translate → base transform → scale so the envelope's frame-space
  // offset is not distorted by the zoom's scale factor.
  const transitionTransformParts = [
    transitionDxPct !== 0 || transitionDyPct !== 0
      ? `translate(${transitionDxPct}%, ${transitionDyPct}%)`
      : '',
    cssTransform ?? '',
    transitionScale !== 1 ? `scale(${transitionScale})` : '',
  ].filter((part) => part.length > 0);
  const visibleTransform =
    transitionTransformParts.length > 0 ? transitionTransformParts.join(' ') : undefined;
  const visibleFilter =
    transitionBlurPx > 0
      ? `${gradeFilter === 'none' ? '' : `${gradeFilter} `}blur(${transitionBlurPx}px)`
      : gradeFilter;
  // Soft-edged directional reveal — the CSS analog of the engine's wipe mask.
  const wipeMask = transition ? wipeCssMask(transition, transitionWipeProgress) : undefined;

  // THE SHOT UNDERNEATH THE RAMP. A transition sits on butt-joined clips, so while the
  // incoming clip eases in the outgoing one has already ended — and every other slot is
  // painted at opacity 0. The reveal therefore happened over the empty monitor: a dissolve
  // from black, a whip pan over black, at every cut. The export had the same defect for the
  // same reason (see the render compiler's transition under-layer), and the perceptual
  // reviewer reported it as unexpected black frames on a real run.
  //
  // The pool usually still holds the outgoing clip on a warm slot, so it is shown at full
  // opacity beneath the ramping front. It is parked on that clip's LAST frame rather than
  // playing its handle (see `slotSeekTarget`) — a held frame under a sub-second ramp reads as
  // continuous, and the deterministic render remains the authority for the exact frames.
  const underlayClipId = transition ? transitionCounterpartClipId : null;
  const underlaySlot = underlayClipId
    ? POOL_SLOTS.find((slot) => slot !== visibleSlot && pool.loaded[slot] === underlayClipId)
    : undefined;

  // Video slots are only mounted once there is video to show or pre-warm; a
  // still-image or empty timeline needs no <video> at all (keeps the DOM honest).
  const showBuffers = isVideoElement || pool.loaded.some((id) => id !== null);

  /** The clip + asset a pool slot currently holds (for src, label, seek). */
  const slotContent = (slot: number): { clip: Clip | null; asset: Asset | undefined } => {
    const id = pool.loaded[slot];
    const clip = id ? (clipById.get(id) ?? null) : null;
    const asset = clip ? assetById.get(clip.assetId) : undefined;
    return { clip, asset };
  };

  /** The currentTime a freshly-loaded slot element should seek to. */
  const slotSeekTarget = (slot: number, clip: Clip | null): number => {
    if (!clip) return 0;
    // Front slot showing the active clip → the live source time; any other slot
    // (a pre-warmed upcoming clip) → its own in-point, decoded and ready to swap.
    if (slot === pool.front && frontHoldsActive && sourceTime !== null) return sourceTime;
    // The slot showing the shot UNDER a transition ramp is the exception: what belongs on
    // screen there is where that shot left off, not where it began.
    return slotParkTime(clip, pool.loaded[slot] === transitionCounterpartClipId);
  };

  /* v8 ignore start -- media events need a real pipeline: verified in e2e. */
  /** Record that a slot has a decoded frame for the clip it was told to hold. */
  const confirmSlotFrame = (slot: number): void => {
    const el = slotEls.current[slot];
    if (el && !el.seeking && el.readyState >= READY_STATE_HAS_FRAME) {
      markSlotFrame(slot, pool.loaded[slot] ?? null);
    }
  };
  /* v8 ignore stop */

  return (
    <section
      className="preview"
      aria-label="preview"
      data-preview-engine="streaming"
      ref={previewRef}
    >
      {/* Audio-only tracks (music/VO/SFX) have no picture element to ride, so a
          hidden mixer plays them in sync — the monitor's <video> only carries
          its own footage audio. */}
      <PreviewAudioMixer
        editor={editor}
        assets={assets}
        soloedTrackIds={soloedTrackIds}
        muted={muted}
      />
      <div className="preview-stage">
        {/* UX-14: how the picture on screen meets the frame. The render CONTAINS a
            clip, so a mismatched source ships with bars, and until now the monitor
            said nothing — the fit was only discoverable by exporting. Indication,
            not correction: filling the frame is a crop the user or the agent
            chooses. */}
        {frameFit && (
          <Tooltip label={frameFit.detail}>
            <span className="preview-fit-chip" data-fit={frameFit.kind} role="status">
              {frameFit.label}
            </span>
          </Tooltip>
        )}
        {/* --aspect drives the pure-CSS contain sizing (see .preview-frame); the
            frame reflows correctly on any resize and bounds the video exactly.
            previewZoom (Fit dropdown) scales the frame beyond its natural
            contain size; the stage scrolls when zoomed past its bounds. */}
        <div
          className="preview-frame"
          style={{
            ['--aspect' as string]: String(aspect),
            transform: previewZoom === 'fit' ? undefined : `scale(${Number(previewZoom) / 100})`,
          }}
        >
          {showBuffers && (
            <div className="preview-buffers">
              {POOL_SLOTS.map((slot) => {
                const { clip, asset } = slotContent(slot);
                const isFront = slot === pool.front;
                // Visibility follows the VISIBLE slot, not the front: at a cut
                // the departed clip's last frame stays up until the new front
                // has a decoded frame (a held frame reads as seamless; a
                // not-yet-painted element reads as a black flicker).
                const isVisible = slot === visibleSlot;
                // Painted beneath the ramping front slot (a lower stacking order), at full
                // opacity and with its OWN crop — it is a different shot, framed its own way.
                const isUnderlay = slot === underlaySlot;
                // Prefer the engine-generated low-res proxy (H3): decodes/seeks far
                // cheaper than the original, so scrubbing and cuts stay smooth on
                // heavy footage. Export still renders from the original.
                const src = asset ? previewMediaSrc(asset) : undefined;
                return (
                  <video
                    // Stable key per slot: the element is NEVER remounted — only
                    // its src changes (off-screen, on a warm slot), so the cut
                    // is a swap of already-decoded media, not a fresh mount.
                    key={`buffer-${slot}`}
                    ref={(el) => {
                      slotEls.current[slot] = el;
                    }}
                    className="preview-video preview-slot"
                    style={{
                      filter: isVisible ? visibleFilter : 'none',
                      // Visible slot paints unless: the playhead sits in a GAP
                      // (empty state must show, not a stale frame) or a still
                      // image has finished decoding and takes over (H3). A
                      // ramping fade/dissolve envelope scales that opacity.
                      opacity:
                        isVisible && videoClip !== null && !(isImageClip && imageReady)
                          ? // The ramp belongs to the clip that CARRIES the transition, so it
                            // only modulates the slot actually holding that clip. When the
                            // incoming slot has no decoded frame yet the monitor keeps showing
                            // the outgoing shot (the anti-flicker hold) — fading THAT down was
                            // the same dissolve-to-black defect from the other side.
                            transition && pool.loaded[slot] === activePictureId
                            ? transitionOpacityAt(transition, clipTime)
                            : 1
                          : isUnderlay
                            ? 1
                            : 0,
                      ...(isUnderlay ? { zIndex: 0 } : isVisible ? { zIndex: 1 } : {}),
                      ...(isUnderlay && clip && !isFullFrameCrop(clipCropRect(clip))
                        ? (() => {
                            const [ux, uy] = cropObjectPosition(clipCropRect(clip));
                            return {
                              objectFit: 'cover' as const,
                              objectPosition: `${String(ux)}% ${String(uy)}%`,
                            };
                          })()
                        : {}),
                      // Live clip transform (H4) composed with the transition
                      // envelope's translate/scale ramp at the playhead.
                      ...(isVisible && visibleTransform ? { transform: visibleTransform } : {}),
                      ...(isVisible && wipeMask
                        ? { maskImage: wipeMask, WebkitMaskImage: wipeMask }
                        : {}),
                      // Crop fills the frame (see the note where `crop` is derived).
                      ...(isVisible && cropped
                        ? {
                            objectFit: 'cover' as const,
                            objectPosition: `${String(cropX)}% ${String(cropY)}%`,
                          }
                        : {}),
                      ...(isVisible && blendMode !== 'normal' ? { mixBlendMode: blendMode } : {}),
                    }}
                    {...(asset ? { 'aria-label': `preview ${asset.id}` } : { 'aria-hidden': true })}
                    src={src}
                    preload="auto"
                    playsInline
                    muted={isFront ? muted || videoMuted : true}
                    controls={false}
                    /* v8 ignore start -- media callbacks need a real media load (e2e). */
                    onLoadedMetadata={() => {
                      const el = slotEls.current[slot];
                      if (el) {
                        try {
                          el.currentTime = slotSeekTarget(slot, clip);
                        } catch {
                          /* jsdom / unsupported media. */
                        }
                      }
                    }}
                    // Readiness: a decoded frame exists at the element's current
                    // position (fresh load → loadeddata; in-point / warm re-seek
                    // → seeked). Everything visual gates on these marks.
                    onLoadedData={() => confirmSlotFrame(slot)}
                    onSeeked={() => confirmSlotFrame(slot)}
                    /* v8 ignore stop */
                  />
                );
              })}
            </div>
          )}
          {videoAsset && isImageClip ? (
            // A still image: shown as a plain <img>, not a media element. The
            // playhead is advanced by the wall clock so it never freezes here.
            <img
              key={videoAsset.id}
              ref={imageElRef}
              className="preview-video preview-slot preview-image"
              alt={`preview ${videoAsset.id}`}
              aria-label={`preview ${videoAsset.id}`}
              src={previewMediaSrc(videoAsset)}
              style={{
                filter: gradeFilter,
                opacity: imageReady ? 1 : 0,
                ...(cssTransform ? { transform: cssTransform } : {}),
                ...(cropped
                  ? {
                      objectFit: 'cover' as const,
                      objectPosition: `${String(cropX)}% ${String(cropY)}%`,
                    }
                  : {}),
                ...(blendMode !== 'normal' ? { mixBlendMode: blendMode } : {}),
              }}
              onLoad={() => setImageReady(true)}
            />
          ) : !videoClip ? (
            // Two different situations with two different ways out: an empty
            // project needs media, whereas a gap in a real edit just needs the
            // playhead moved. One shared "No clip at playhead." told the user
            // nothing actionable in either case.
            <div className="preview-empty">
              <Film size={28} aria-hidden="true" />
              {duration === 0 ? (
                <>
                  <p className="preview-empty-text">Nothing on the timeline yet</p>
                  <p className="preview-empty-hint">
                    Add a clip from the Assets rail to see it here.
                  </p>
                </>
              ) : (
                <>
                  <p className="preview-empty-text">No clip at the playhead</p>
                  <p className="preview-empty-hint">Move the playhead over a clip to preview it.</p>
                </>
              )}
            </div>
          ) : null}
          {playing && !prepared && (
            // The prepare gate is holding the transport: tell the user playback
            // is being made smooth instead of leaving a frozen first frame.
            <div className="preview-preparing" role="status">
              <span className="preview-preparing-dot" aria-hidden="true" />
              Preparing preview…
            </div>
          )}
          {/* Click the stage to select the clip under the playhead (H4); the
              selected clip shows draggable transform controls. */}
          {videoClip && !transformSelected && (
            <button
              type="button"
              className="preview-select-hit"
              aria-label={`select clip ${videoClip.id} in preview`}
              onClick={() => editor.select(videoClip.id)}
            />
          )}
          {transformSelected && videoClip && resolution && (
            <PreviewTransform
              key={videoClip.id}
              value={baseTransform}
              resolution={resolution}
              onPreview={setTransformOverride}
              onCommit={commitTransform}
            />
          )}
          {/* Effect layers (schema v13, ADR 0088). Sits above the picture and
              BELOW the DOM overlays — see PreviewEffectOverlay for why captions
              are not covered in this preview path. */}
          <PreviewEffectOverlay
            layers={effectLayers}
            getSource={getEffectSource}
            getTime={getEffectTime}
            playing={playing}
          />

          <div className="preview-overlays" aria-label="overlays">
            {captions.map((c) => (
              <div key={c.clipId} className="preview-caption-object">
                <CaptionOverlay
                  style={c.style}
                  trackStyle={c.trackStyle}
                  lines={c.lines}
                  time={playhead}
                />
                <PreviewCaptionEditor
                  clipId={c.clipId}
                  style={c.style}
                  trackStyle={c.trackStyle}
                  text={c.text}
                  selected={editor.state.selectedIds.includes(c.clipId)}
                  onSelect={() => editor.select(c.clipId)}
                  onStyleCommit={(stylePatch: Partial<CaptionStyle>) => {
                    const patch = setCaptionStylePatch(editor.state.timeline, c.clipId, {
                      ...(c.style ?? {}),
                      ...stylePatch,
                    });
                    if (patch) editor.applyPatch(patch);
                  }}
                  onTextCommit={(text) => {
                    const patch = setCaptionCuePatch(
                      editor.state.timeline,
                      c.clipId,
                      text,
                      transcript ?? [],
                    );
                    if (patch) editor.applyPatch(patch);
                  }}
                />
              </div>
            ))}
            {overlays.map((o) =>
              editor.state.selectedIds.includes(o.clipId) ? (
                // The selected text overlay is editable on the canvas: move, resize
                // its wrap box, and double-click to edit — committed as reversible
                // set_effect_params edits (#5).
                <PreviewTextEditor
                  key={o.clipId}
                  params={o.params}
                  timeInClip={o.timeInClip}
                  duration={o.duration}
                  onCommit={(patch) => commitTextParams(o.clipId, patch)}
                />
              ) : (
                // Click the text to select THAT overlay (not the background clip) so it
                // becomes editable/resizable on the canvas. `stopPropagation` keeps the
                // click off the full-frame select-hit behind it.
                <p
                  key={o.clipId}
                  className="preview-overlay-text"
                  style={textOverlayStyle(o.params, o.timeInClip, o.duration)}
                  role="button"
                  tabIndex={0}
                  aria-label={`select text overlay ${o.clipId} in preview`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    editor.select(o.clipId);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      editor.select(o.clipId);
                    }
                  }}
                >
                  {o.text}
                </p>
              ),
            )}
          </div>
          {showGrid && <div className="preview-grid" aria-hidden="true" />}
          {showSafeArea && <div className="preview-safe-area" aria-hidden="true" />}
        </div>
      </div>

      <div className="transport" role="group" aria-label="transport">
        {/* Three zones — playback, position, view — each a group that wraps as a
            unit. Flat, they were eleven equally-weighted controls in one
            non-wrapping row that overflowed a narrow center column. */}
        <div className="transport-nav">
          <Tooltip label="Go to start" shortcut="Home">
            <button
              type="button"
              className="transport-btn"
              aria-label="go to start"
              onClick={() => {
                editor.setPlaying(false);
                editor.seek(0);
              }}
            >
              <SkipBack size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Step back one frame" shortcut="←">
            <button
              type="button"
              className="transport-btn"
              aria-label="step back one frame"
              onClick={() => stepFrames(-1)}
            >
              <ChevronLeft size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Play / Pause" shortcut="Space">
            <button
              type="button"
              className="transport-play"
              aria-label={playing ? 'pause' : 'play'}
              aria-pressed={playing}
              onClick={() => editor.setPlaying(!playing)}
            >
              {playing ? (
                <Pause size={ICON_SIZE.lg} aria-hidden="true" />
              ) : (
                <Play size={ICON_SIZE.lg} aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Step forward one frame" shortcut="→">
            <button
              type="button"
              className="transport-btn"
              aria-label="step forward one frame"
              onClick={() => stepFrames(1)}
            >
              <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Go to end" shortcut="End">
            <button
              type="button"
              className="transport-btn"
              aria-label="go to end"
              onClick={() => {
                editor.setPlaying(false);
                editor.seek(duration);
              }}
            >
              <SkipForward size={ICON_SIZE.md} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <span className="transport-time tabular">
          <span aria-label="current time">{formatTime(playhead, fps, settings.timeDisplay)}</span>
          <span className="transport-sep" aria-hidden="true">
            /
          </span>
          <span className="transport-total" aria-label="total time">
            {formatTime(duration, fps, settings.timeDisplay)}
          </span>
        </span>
        <MonitorHeaderPortal host={headerControlsHost}>
          <PreviewViewControls
            {...(resolution ? { resolution } : {})}
            {...(onChangeOrientation ? { onChangeOrientation } : {})}
            isGraded={isGraded}
            showGrade={showGrade}
            onToggleGrade={() => setShowGrade((on) => !on)}
            loop={loop}
            onToggleLoop={() => update({ loopByDefault: !loop })}
            showGrid={showGrid}
            onToggleGrid={() => update({ gridByDefault: !showGrid })}
            showSafeArea={showSafeArea}
            onToggleSafeArea={() => update({ safeAreaGuidesByDefault: !showSafeArea })}
            zoom={previewZoom}
            onZoomChange={setPreviewZoom}
            onToggleFullscreen={toggleFullscreen}
          />
        </MonitorHeaderPortal>
      </div>
    </section>
  );
}
