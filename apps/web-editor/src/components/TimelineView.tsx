/**
 * Multi-track timeline (plan/PLAN.md Phase 3.2 + 3.4 premium pass) — the editor's
 * centrepiece. Clips are positioned by the pure `secondsToPx` projection; direct
 * manipulation (drag-move, edge-trim, razor split) and the draggable playhead all
 * resolve to a **single validated patch per gesture** committed through the same
 * `useEditor` store as the toolbar/keyboard. There is no second mutation path.
 *
 * All pixel↔time geometry, snapping, ruler ticks, trim clamping, and zoom targets
 * live in the pure, unit-tested `editor/selectors.ts`; this component is the thin
 * DOM/pointer shell over them. The accessible `<input type="range">` scrubber is
 * retained for deterministic seeking/tests alongside the pointer interactions.
 *
 * Drag state (ghosts, snap guides, razor cut-line) is **ephemeral local state** —
 * never an edit (PROMPT invariant 5); only the committed patch touches the timeline.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  buildTransitionBoundaryIndex,
  evaluateKeyframes,
  readAlignment,
  transitionEligibilityIn,
  type TransitionAlignment,
  type TransitionEligibility,
} from '@framepilot/editor-core';
import type { Asset, Clip, Effect, Timeline, Track } from '@framepilot/timeline-schema';
import { type UseEditor, useFramePlayhead } from '../editor/useEditor.js';
import { type EditPulseKind, useEditPulse } from '../editor/useEditPulse.js';
import { alignToDevicePixel } from '../editor/pixel-alignment.js';
import type { EditMode } from '../editor/useEditMode.js';
import type { Tool } from '../editor/shortcuts.js';
import {
  type ClipKind,
  type LaneRowBand,
  type PixelRect,
  type TimeDisplay,
  type TransitionPlacement,
  type ZoomTarget,
  assetKind,
  audioSettings,
  clampTrimEnd,
  clampTrimStart,
  assetDisplayName,
  clipKind,
  clipsIntersectingRect,
  compactDuration,
  compactTimeLabel,
  effectLayersIntersectingRect,
  findClip,
  findEffectLayer,
  formatTime,
  laneRenderWindow,
  layerKind,
  nextAutoScrollLeft,
  pxToSeconds,
  pxDeltaToSeconds,
  orderedClips,
  rollBounds,
  rulerTicks,
  secondsToPx,
  shouldAutoFollow,
  wheelIntent,
  magnetSnap,
  snap,
  spanInRenderWindow,
  snapTargets,
  timelineDuration,
  timelineTransitions,
  trackJunctions,
  type Junction,
  tracksCompatible,
  zoomToClip,
  zoomToFit,
} from '../editor/selectors.js';
import { ClipWaveform } from './ClipWaveform.js';
import { ClipFilmstrip, filmstripSlots } from './ClipFilmstrip.js';
import { TimelineMinimap } from './TimelineMinimap.js';
import { laneNames } from './timeline/lane-names.js';
import { useSettings } from '../editor/useSettings.js';
import {
  TRACK_HEIGHT_BOUNDS,
  type TrackViewState,
  type UseTrackLayout,
  effectiveTrackHeight,
  resolveSoloMutedTrackIds,
  useTrackLayout,
} from '../editor/useTrackLayout.js';
import {
  type TrackFlag,
  type TransitionKind,
  DEFAULT_TEXT_PARAMS,
  addClipPatch,
  addLayerPatch,
  addEffectLayerPatch,
  addTextOverlayPatch,
  duplicateEffectLayerPatch,
  moveEffectLayerPatch,
  removeEffectLayerPatch,
  setEffectLayerEnabledPatch,
  trimEffectLayerPatch,
  DEFAULT_TRANSITION_SECONDS,
  addTransitionPatch,
  addTransitionToAllCutsPatch,
  applyTransitionToClipsPatch,
  applyTransitionToCutsPatch,
  resetTransitionParamsPatch,
  setTransitionAlignmentPatch,
  removeTransitionPatch,
  duplicateClipAtPatch,
  duplicateClipsAtPatch,
  insertClipPatch,
  moveClipPatch,
  moveClipsPatch,
  moveLayerPatch,
  placeAssetPatch,
  rollEditPatch,
  setAudioPatch,
  setTrackFlagsPatch,
  setTransitionDurationPatch,
  moveKeyframesPatch,
  removeKeyframesPatch,
  setKeyframeAtPlayheadPatch,
  splitClipPatch,
  trimClipPatch,
} from '../editor/patch-builders.js';
import { ASSET_DND_TYPE } from './MediaBin.js';
import { TEXT_OVERLAY_DND_TYPE } from './OverlaysPanel.js';
import { TRANSITION_DND_TYPE } from './transition-catalog.js';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { EFFECT_DND_TYPE } from './EffectsPanel.js';
import { ClipKeyframeLanes } from './timeline/ClipKeyframeLanes.js';
import {
  isAnimated,
  keyframeKey,
  parseKeyframeKey,
  trackKeyframeLanesHeight,
} from './timeline/keyframe-lanes.js';
import { useKeyframeSelection } from './timeline/useKeyframeSelection.js';
import { EffectLayerChip } from './EffectLayerChip.js';
import { EffectLayerMenu } from './EffectLayerMenu.js';

/** DnD MIME carrying a track id while a lane is dragged to reorder the layer stack. */
const TRACK_DND_TYPE = 'application/x-framepilot-track';
import { TransitionBlock } from './timeline/TransitionBlock.js';
import { layoutTransitionBlocks } from './timeline/transition-blocks.js';
import { TransitionMenu } from './timeline/TransitionMenu.js';
import { ClipContextMenu, type ClipMenuTarget } from './ClipContextMenu.js';
import { TrackContextMenu, type TrackMenuTarget } from './TrackContextMenu.js';
import { TransitionPicker, type TransitionPickerTarget } from './TransitionPicker.js';
import { Tooltip, TooltipInfo } from './Tooltip.js';
import { Menu, MenuItem } from './Menu.js';
import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
  Headphones,
  ICON_SIZE,
  Image,
  Lock,
  LockOpen,
  type LucideIcon,
  MoreHorizontal,
  Diamond,
  Palette,
  Plus,
  Scan,
  Sparkles,
  Type,
  Volume2,
  VolumeX,
} from './icons.js';

export interface TimelineViewProps {
  readonly editor: UseEditor;
  /** Project assets, used to resolve a dropped asset id into a clip. */
  readonly assets?: readonly Asset[];
  /** Project frame rate, used for frame-accurate ruler/clip timecodes. */
  readonly fps?: number;
  /**
   * Placement mode (view state). `insert` pushes downstream same-lane clips right
   * when a clip is dropped; `overwrite` (default) keeps today's auto-layering drop.
   */
  readonly editMode?: EditMode;
  /**
   * Per-track view layout (height / collapse / solo) — view state only (M2b-2).
   * Injectable for tests; defaults to the `localStorage`-backed {@link useTrackLayout}.
   */
  readonly trackLayout?: UseTrackLayout;
  /**
   * Point-react-refine trigger (P13.3): forwarded to {@link ClipContextMenu}'s
   * "Ask AI about this clip" action, which selects the clip and opens the same
   * command palette ⌘K opens.
   */
  readonly onAskAiForClip?: (clipId: string) => void;
  /**
   * Show a clip's source footage in the media bin (UX-08) — forwarded to
   * {@link ClipContextMenu}'s "Reveal in bin". Absent means this host has no bin.
   */
  readonly onRevealAssetInBin?: (assetId: string) => void;
  /**
   * Switch the left rail to the transitions library. Offered by the on-cut
   * popover as its "there is more than this" escape hatch; absent means this
   * host has no such rail (the timeline is embedded in tests and in the AI
   * review player without one).
   */
  readonly onOpenTransitionLibrary?: () => void;
  /**
   * The selected effect LAYER (schema v13, ADR 0088), lifted to {@link Editor} so
   * the Inspector — this view's sibling — can render its controls.
   */
  readonly selectedEffectLayerIds?: readonly string[];
  readonly onSelectEffectLayers?: (ids: readonly string[]) => void;
  /** Lift selected keyframe identities into the turn-boundary interaction snapshot. */
  readonly onKeyframeSelectionChange?: (
    keyframes: readonly {
      readonly clipId: string;
      readonly property: string;
      readonly time: number;
    }[],
  ) => void;
  /**
   * The active timeline tool (Selection/Blade) — lifted to {@link Editor} so the
   * toolbar's Tools group and this view's click behavior share one source of
   * truth (TIMELINE-TOOLBAR-REORG). Defaults to `'select'`.
   */
  readonly tool?: Tool;
  /**
   * The user deliberately clicked a clip. Not "the selection changed" — see
   * `onClipClick`. Optional, so a surface that does not care omits it.
   */
  readonly onItemActivate?: (() => void) | undefined;
}

/** A non-zero lane width so an empty/short timeline is still visible. */
const MIN_LANE_SECONDS = 10;
/** Vertical gap (px) around each lane/header row — folded into the windowed row
 *  height so the absolutely-positioned lanes line up with the header column. */
const TRACK_ROW_GAP = 6;
/**
 * Half the gap — the inset each row is drawn at inside its virtualizer band, so
 * the gap reads as breathing room on BOTH sides of a lane.
 *
 * It is applied as an inline offset rather than a CSS `margin: 3px 0`, because
 * both columns are absolutely positioned at `top: 0` + `translateY(row.start)`:
 * a margin there silently shifts one column and collapses on the other, which is
 * how the lanes ended up sitting 3px below their own headers.
 */
const TRACK_ROW_INSET = TRACK_ROW_GAP / 2;
/** Extra lane rows mounted beyond the viewport so fast vertical scrolls don't flash. */
const TRACK_OVERSCAN = 4;
/**
 * Lane types whose clips a transition can join.
 *
 * A transition treats a cut between two MEDIA clips: `transitionEligibility` refuses a
 * caption or overlay clip outright ("caption and overlay clips cannot carry one"), and an
 * effect lane holds layers, not clips. Checking membership here means a caption lane's
 * hundreds of cues never enter the eligibility pass at all, instead of each one paying for
 * a full-timeline derivation only to be told no.
 */
const TRANSITIONABLE_TRACK_TYPES: ReadonlySet<Track['type']> = new Set(['video', 'audio']);

/** One abutting cut plus the already-decided answer to "can a transition go here?". */
interface JunctionAffordance {
  readonly junction: Junction;
  readonly eligibility: TransitionEligibility;
}
/**
 * Viewport height assumed when the vertical scroll container measures as 0 (jsdom,
 * and the first pre-layout paint). Without it the virtualizer would window down to
 * the first lane only. Mirrors {@link MediaBin}'s fallback: the virtualizer never
 * renders more than `count` rows, so in a real browser this matters only for the
 * single frame before the real height arrives; in jsdom it mounts every lane so
 * tests can query any track. A large-count test stubs a real height to assert
 * windowing actually mounts only the visible slice.
 */
const FALLBACK_LANE_VIEWPORT_PX = 100_000;
/** How long (ms) a manual scroll/wheel suspends auto-follow so it never fights it. */
const MANUAL_SCROLL_SUSPEND_MS = 1200;

/**
 * Wrap the virtual-core rect observer to substitute {@link FALLBACK_LANE_VIEWPORT_PX}
 * for a zero height (jsdom / first paint). See {@link FALLBACK_LANE_VIEWPORT_PX}.
 */
const observeLaneRectWithFallback: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) =>
    cb({ width: rect.width, height: rect.height || FALLBACK_LANE_VIEWPORT_PX }),
  );
/** Snap engages within this many pixels of a target (converted to seconds by zoom). */
const SNAP_PX = 8;
/**
 * How far (px) the pointer must pull to break a magnet's hold.
 *
 * Wider than {@link SNAP_PX} on purpose — the gap between capture and release IS
 * the resistance. Too small and the join has no weight; too large and an edge
 * cannot be placed near a cut without fighting it. 18px is roughly two
 * comfortable pointer tremors, and well inside the distance a deliberate
 * pull-away covers.
 */
const MAGNET_RELEASE_PX = 18;
/** Pointer travel (px) before a press becomes a drag rather than a click/select. */
const DRAG_THRESHOLD_PX = 3;
/**
 * Wheel-zoom sensitivity: with a modifier held, `pxPerSecond` is multiplied by
 * `exp(-deltaY * this)` per wheel tick — scroll up (deltaY < 0) zooms in, down
 * zooms out. Tuned so a single notch (~|deltaY| 100) is a comfortable ~15% step.
 */
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

/**
 * Glyph (Lucide) + lane class + label for each *clip kind* (Phase 2, ADR 0032).
 * Layers are type-agnostic: a layer's chrome derives from the kind of clips it
 * actually holds (its dominant {@link ClipKind}), and each clip is coloured by its
 * own kind — not by a fixed `track.type`.
 */
const KIND_META: Record<ClipKind, { icon: LucideIcon; cls: string; label: string }> = {
  video: { icon: Film, cls: 'is-video', label: 'Video' },
  image: { icon: Image, cls: 'is-image', label: 'Image' },
  audio: { icon: AudioLines, cls: 'is-audio', label: 'Audio' },
  text: { icon: Type, cls: 'is-overlay', label: 'Text' },
  caption: { icon: Captions, cls: 'is-caption', label: 'Caption' },
};

/**
 * The {@link ClipKind} a layer's advisory `track.type` implies when it is empty.
 *
 * `effect` is deliberately EXCLUDED (schema v13): an effect lane holds no clips,
 * so it has no clip kind to derive chrome from — it gets its own lane chrome via
 * {@link EFFECT_LANE_META}. Typing the exclusion rather than inventing a filler
 * entry is what keeps this map's exhaustiveness a real guarantee.
 */
const ADVISORY_KIND: Record<Exclude<Track['type'], 'effect'>, ClipKind> = {
  video: 'video',
  audio: 'audio',
  overlay: 'text',
  caption: 'caption',
};

/**
 * The lane roles offered by "Add track", in the order an editor reaches for them.
 *
 * Every member of `TrackType` is here — the menu used to offer only Video and
 * Audio, so caption, overlay and effect lanes were unreachable from the UI even
 * though the schema, the patch builder and the renderers all support them. The
 * icon matches the header glyph for that role so the new lane is recognisable
 * before it holds anything.
 *
 * The role stays **advisory** for the clip-bearing kinds (any clip may live on
 * any lane); `effect` is the one that genuinely changes the lane, since it holds
 * effect layers instead of clips.
 */
const ADD_TRACK_KINDS: readonly {
  readonly type: Track['type'];
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { type: 'video', label: 'Video', icon: Film },
  { type: 'audio', label: 'Audio', icon: AudioLines },
  { type: 'overlay', label: 'Text / overlay', icon: Type },
  { type: 'caption', label: 'Captions', icon: Captions },
  { type: 'effect', label: 'Effects (adjustment)', icon: Sparkles },
];

/** Lane chrome for an `effect` adjustment track (schema v13). */
const EFFECT_LANE_META = {
  icon: Sparkles,
  cls: 'is-effect',
  label: 'Effects',
} as const;

/**
 * Content-derived chrome for a *layer*: the meta of its dominant clip kind, or the
 * advisory-type meta when the layer is still empty. Drives the header icon/label and
 * the lane's colour class.
 */
function layerMeta(
  track: Track,
  assetById: ReadonlyMap<string, Asset>,
): { icon: LucideIcon; cls: string; label: string } {
  if (track.type === 'effect') return EFFECT_LANE_META;
  const kind = layerKind(track, assetById) ?? ADVISORY_KIND[track.type];
  return KIND_META[kind];
}

/**
 * A toggleable per-track header control (schema v4): a {@link TrackFlag} with the
 * icons/labels for its on/off states. The button shows the *action* it performs,
 * CapCut-style — a visible track shows the "Hide" eye, a hidden one the "Show"
 * crossed eye. Each control resolves to one reversible `set_track_flags` patch.
 */
interface FlagControl {
  readonly flag: TrackFlag;
  /** Icon + label shown when the flag is OFF (button action turns it ON). */
  readonly offIcon: LucideIcon;
  readonly offLabel: string;
  /** Icon + label shown when the flag is ON (button action turns it OFF). */
  readonly onIcon: LucideIcon;
  readonly onLabel: string;
}

const HIDE_CONTROL: FlagControl = {
  flag: 'hidden',
  offIcon: Eye,
  offLabel: 'Hide track',
  onIcon: EyeOff,
  onLabel: 'Show track',
};
const MUTE_CONTROL: FlagControl = {
  flag: 'muted',
  offIcon: Volume2,
  offLabel: 'Mute track',
  onIcon: VolumeX,
  onLabel: 'Unmute track',
};
const LOCK_CONTROL: FlagControl = {
  flag: 'locked',
  offIcon: LockOpen,
  offLabel: 'Lock track',
  onIcon: Lock,
  onLabel: 'Unlock track',
};

/**
 * Header controls every layer exposes (left rail). Since layers are type-agnostic
 * (Phase 2, ADR 0032) — any kind may live on any layer, including a mix — every
 * layer offers hide, mute, and lock; the render honours whichever apply to the
 * clips it holds (mute silences audio content; hide drops picture/overlay content).
 */
const LAYER_CONTROLS: readonly FlagControl[] = [HIDE_CONTROL, MUTE_CONTROL, LOCK_CONTROL];

/** Plain-language "what this actually does" tooltip text per header control —
 *  the button always describes the action it's about to perform, so the info
 *  line describes the state that action would leave the track in. */
const CONTROL_INFO: Record<TrackFlag, { readonly off: string; readonly on: string }> = {
  hidden: {
    off: 'Hides everything on this track from the preview and the final export, without deleting anything. Click again to bring it back.',
    on: 'This track is hidden from the preview and export right now. Click to make it visible again.',
  },
  muted: {
    off: "Silences this track's audio only — the rest of your project keeps playing normally.",
    on: "This track's audio is silenced right now. Click to hear it again.",
  },
  locked: {
    off: "Locks this track so its clips can't be moved, trimmed, or deleted by accident.",
    on: 'This track is locked and protected from edits right now. Click to unlock it.',
  },
};

/** Shown instead of the normal mute info when a track is silent only because
 *  another track is soloed — its own mute flag is still off. */
const SOLO_MUTED_INFO =
  'Silenced because another track is soloed. Turn off solo there, or solo this track, to hear it.';

/** The kind of pointer gesture in flight on a clip. */
type GestureKind = 'move' | 'trim-l' | 'trim-r';

interface Gesture {
  readonly kind: GestureKind;
  readonly clip: Clip;
  readonly fromTrackId: string;
  readonly fromTrackType: Track['type'];
  readonly downX: number;
  readonly downSeconds: number;
  moved: boolean;
}

/** Live preview of a clip mid-gesture (where it will land), plus a snap guide. */
interface Ghost {
  readonly clipId: string;
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: GestureKind;
  /** Time the gesture snapped to, for the guide line; `null` when not snapped. */
  readonly snapTime: number | null;
  /** Cmd/Ctrl held during a move — drop a copy instead of relocating the original. */
  readonly duplicate?: boolean;
  /** Cmd/Ctrl held during a trim on a butt-joined cut — roll the edit against
   *  `rollWith` instead of trimming only the grabbed clip. */
  readonly rollWith?: string;
}

/**
 * Whole-clip duration label, honouring the active time-display mode.
 *
 * Compact, not full SMPTE. The badge sits inside the clip's own header, sharing a
 * row with the clip name: eleven characters of `00:00:06:00` there is not a
 * readout, it is a wall that pushes the name out at any ordinary clip width, and
 * ten of those characters are the same on every clip in the project. `0:06` says
 * the same thing and leaves the row to the name.
 */
const clipDurationLabel = (clip: Clip, fps: number, mode: TimeDisplay): string =>
  compactDuration(clip.end - clip.start, fps, mode);

/**
 * A clean, kind-aware label for a clip (master-prompt §3.11). Text clips show their
 * text, caption clips read "Caption", everything else uses the asset's display name —
 * never a raw UUID. Driven by the clip's derived {@link ClipKind} (Phase 2), so a
 * label is correct regardless of which layer the clip sits on.
 */
function clipLabel(kind: ClipKind, clip: Clip, asset: Asset | undefined): string {
  if (kind === 'text') {
    const text = clip.effects.find((e) => e.type === 'text')?.params?.text;
    return typeof text === 'string' && text.trim() !== '' ? text : 'Text';
  }
  if (kind === 'caption') return 'Caption';
  return assetDisplayName(asset, clip.id);
}

/** Below this clip width (px) the effect-badge cluster is hidden to avoid clutter
 *  (CapCut hides per-effect chrome on narrow clips). Transition + keyframe markers
 *  still render, since they convey junction/animation that must stay legible. */
const EFFECT_BADGE_MIN_CLIP_PX = 72;

/** Below this clip width (px) the filmstrip/waveform picture layers are hidden so
 *  slivers stay clean (the body would be too narrow to read a frame anyway). */
const PICTURE_LAYER_MIN_CLIP_PX = 24;

/** Longest fade an audio clip's corner handle can drag to (matches the Inspector's
 *  Audio panel ScrubNumber cap, H8). */
const FADE_MAX_SECONDS = 5;

/** Shift+Arrow step on a fade handle — the coarse move next to the frame nudge. */
const FADE_COARSE_STEP_SECONDS = 0.5;

/** Below this clip width (px) fade handles are hidden — too narrow to grab. */
const FADE_HANDLE_MIN_CLIP_PX = 20;

/**
 * Width-adaptive header density (master-prompt §3, "drop body → waveform → header"):
 * the header degrades gracefully on narrow clips instead of overflowing. Tiers, by
 * clip width (px):
 *   < {@link PICTURE_LAYER_MIN_CLIP_PX}  → sliver: no header at all (just the color block).
 *   ≥ {@link CLIP_HEADER_MIN_PX}         → show the header with the title.
 *   ≥ {@link CLIP_TIME_MIN_PX}           → also show the duration.
 *   ≥ {@link CLIP_MENU_MIN_PX}           → also show the `⋯` actions button.
 * Tiers are derived from clip width only (never the playhead), so the memoised lanes
 * are not rebuilt on playback ticks. The title always ellipsizes — text never clips.
 */
const CLIP_HEADER_MIN_PX = PICTURE_LAYER_MIN_CLIP_PX;
const CLIP_TIME_MIN_PX = 56;
const CLIP_MENU_MIN_PX = 96;

/** The header parts a clip of `widthPx` can show without crowding (see tier consts). */
interface ClipHeaderDensity {
  readonly showHeader: boolean;
  readonly showTime: boolean;
  readonly showMenu: boolean;
}

/** Resolve the {@link ClipHeaderDensity} for a clip body width (px). */
function clipHeaderDensity(widthPx: number): ClipHeaderDensity {
  return {
    showHeader: widthPx >= CLIP_HEADER_MIN_PX,
    showTime: widthPx >= CLIP_TIME_MIN_PX,
    showMenu: widthPx >= CLIP_MENU_MIN_PX,
  };
}

/** A keyframe marker placed along a clip, keyed by its clip-relative time. */
interface KeyframeMarker {
  readonly key: string;
  readonly time: number;
  readonly label: string;
}

/**
 * All keyframe markers for a clip, gathered from BOTH the clip's own keyframes and
 * any nested in its effects. Times are clip-relative; markers are deduplicated by
 * (rounded) time so co-located clip/effect keyframes collapse into one dot, and
 * only those within the clip's duration are kept so nothing renders past the edge.
 */
function clipKeyframeMarkers(clip: Clip): readonly KeyframeMarker[] {
  const duration = clip.end - clip.start;
  const sources = [clip.keyframes, ...clip.effects.map((e) => e.keyframes)];
  const byTime = new Map<number, KeyframeMarker>();
  for (const keyframes of sources) {
    for (const kf of keyframes) {
      if (kf.time < 0 || kf.time > duration) continue;
      const bucket = Math.round(kf.time * 1000); // ms precision dedup key
      if (byTime.has(bucket)) continue;
      byTime.set(bucket, {
        key: kf.id,
        time: kf.time,
        label: `${kf.property} @ ${kf.time}s`,
      });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** A corner badge advertising one non-transition, non-keyframe effect on a clip. */
interface EffectBadge {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly label: string;
}

/** Icon + human label for each effect kind shown as a clip badge. Transition and
 *  keyframes are intentionally absent — they have their own dedicated indicators. */
const EFFECT_BADGE_META: Record<string, { icon: LucideIcon; label: string }> = {
  text: { icon: Type, label: 'Text overlay' },
  caption: { icon: Captions, label: 'Caption' },
  mask: { icon: Scan, label: 'Mask' },
  color_grade: { icon: Palette, label: 'Color grade' },
  audio_gain: { icon: Volume2, label: 'Audio gain' },
};

/**
 * The badge cluster for a clip: one icon per distinct effect kind present that has
 * its own dedicated indicator-less representation (text/caption/mask/color_grade/
 * audio_gain). Each kind appears at most once even if applied multiple times.
 */
function clipEffectBadges(clip: Clip): readonly EffectBadge[] {
  const seen = new Set<string>();
  const badges: EffectBadge[] = [];
  for (const effect of clip.effects as readonly Effect[]) {
    const meta = EFFECT_BADGE_META[effect.type];
    if (!meta || seen.has(effect.type)) continue;
    seen.add(effect.type);
    badges.push({ key: effect.type, icon: meta.icon, label: meta.label });
  }
  return badges;
}

// ── Live-playhead nodes (perf slice 1b, plan Phase 12.1) ────────────────────
// These subscribe to the playhead clock via `usePlayhead`, so a seek re-renders
// only them — `TimelineView` itself is memoised out of the per-seek path. They
// take the ruler ticks (a memoised element) as children so tick nodes are reused.
type PlayheadPointerHandler = (event: React.PointerEvent) => void;
type TimeDisplayMode = NonNullable<Parameters<typeof formatTime>[2]>;

/** The grabbable playhead marker + live time bubble. */
function PlayheadMarker({
  editor,
  pxPerSecond,
  fps,
  timeDisplay,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  readonly editor: UseEditor;
  readonly pxPerSecond: number;
  readonly fps: number;
  readonly timeDisplay: TimeDisplayMode;
  readonly onPointerDown: PlayheadPointerHandler;
  readonly onPointerMove: PlayheadPointerHandler;
  readonly onPointerUp: PlayheadPointerHandler;
}): JSX.Element {
  const markerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const updatePosition = (): void => {
      const playhead = editor.getPlayhead();
      const x = alignToDevicePixel(secondsToPx(playhead, pxPerSecond), window.devicePixelRatio);
      if (markerRef.current) markerRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
      if (bubbleRef.current) bubbleRef.current.textContent = formatTime(playhead, fps, timeDisplay);
    };
    updatePosition();
    return editor.subscribePlayhead(updatePosition);
  }, [editor.getPlayhead, editor.subscribePlayhead, fps, pxPerSecond, timeDisplay]);
  const initialPlayhead = editor.getPlayhead();
  const initialX = alignToDevicePixel(
    secondsToPx(initialPlayhead, pxPerSecond),
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  );
  return (
    <div
      ref={markerRef}
      className="playhead"
      style={{ transform: `translate3d(${initialX}px, 0, 0)` }}
    >
      <button
        type="button"
        className="playhead-head"
        aria-label="playhead handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span ref={bubbleRef} className="playhead-bubble tabular" aria-hidden="true">
          {formatTime(initialPlayhead, fps, timeDisplay)}
        </span>
      </button>
      <div className="playhead-line" aria-hidden="true" />
    </div>
  );
}

/** sr-only deterministic scrub input + timecode output (keyboard/AT/test hook). */
function PlayheadScrubber({
  editor,
  laneSeconds,
  fps,
  timeDisplay,
}: {
  readonly editor: UseEditor;
  readonly laneSeconds: number;
  readonly fps: number;
  readonly timeDisplay: TimeDisplayMode;
}): JSX.Element {
  const playhead = useFramePlayhead(editor, fps);
  return (
    <div className="timeline-scrubber sr-only">
      <label htmlFor="playhead-range">Playhead</label>
      <input
        id="playhead-range"
        type="range"
        min={0}
        max={laneSeconds}
        step={0.01}
        value={playhead}
        aria-label="playhead"
        onChange={(event) => editor.seek(Number(event.target.value))}
      />
      <output className="tabular" aria-label="playhead time">
        {formatTime(playhead, fps, timeDisplay)}
      </output>
    </div>
  );
}

/** The ruler bar. Owns the live `aria-valuenow`, but takes its (memoised) tick
 *  elements as children so a seek updates only the attribute, not the ticks. */
function RulerBar({
  editor,
  laneSeconds,
  fps,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  children,
}: {
  readonly editor: UseEditor;
  readonly laneSeconds: number;
  readonly fps: number;
  readonly onPointerDown: PlayheadPointerHandler;
  readonly onPointerMove: PlayheadPointerHandler;
  readonly onPointerUp: PlayheadPointerHandler;
  readonly children: React.ReactNode;
}): JSX.Element {
  const playhead = useFramePlayhead(editor, fps);
  return (
    <div
      className="ruler"
      role="slider"
      tabIndex={-1}
      aria-label="timeline ruler"
      aria-valuenow={Math.round(playhead * 100) / 100}
      aria-valuemin={0}
      aria-valuemax={Math.round(laneSeconds * 100) / 100}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {children}
    </div>
  );
}

// One clip block on a lane. `memo`-wrapped (perf slice 1b/2, plan Phase 12.1) so a
// lane rebuild — e.g. every throttled frame of a drag, when the ghost moves — only
// re-renders the ONE clip whose props changed (the dragged clip); every other clip,
// on every layer, bails on identical props. Behaviour is identical to the previous
// inline render; the derived values (kind/badges/name/density) are computed here.
interface TimelineClipProps {
  readonly clip: Clip;
  readonly track: Track;
  readonly isGhost: boolean;
  readonly ghostKind: GestureKind | null;
  /** Cmd/Ctrl held while dragging — the drop will place a copy, not relocate. */
  readonly ghostDuplicate?: boolean;
  /** Cmd/Ctrl held while trimming a butt-joined cut — this is a roll edit. */
  readonly ghostRoll?: boolean;
  readonly start: number;
  readonly end: number;
  readonly pxPerSecond: number;
  readonly fps: number;
  readonly timeDisplay: TimeDisplayMode;
  readonly selected: boolean;
  /** Draw the filmstrip picture layer (Settings → Editing → timeline thumbnails). */
  readonly showThumbnails: boolean;
  /** This clip butt-joins the clip before it — the left edge is a cut, not an end. */
  readonly joinLeft?: boolean;
  /** This clip butt-joins the clip after it — the right edge is a cut, not an end. */
  readonly joinRight?: boolean;
  readonly assetById: ReadonlyMap<string, Asset>;
  readonly beginGesture: (
    event: React.PointerEvent,
    kind: GestureKind,
    clip: Clip,
    track: Track,
  ) => void;
  readonly onPointerMove: (event: React.PointerEvent) => void;
  readonly onPointerUp: (event: React.PointerEvent) => void;
  readonly onSelectClip: (event: React.MouseEvent, clip: Clip, track: Track) => void;
  readonly openClipMenu: (clipId: string, x: number, y: number) => void;
  /** Commit a fade-handle drag on an audio clip (one `setAudioPatch` per drop). */
  readonly onFadeCommit: (clipId: string, edge: 'in' | 'out', seconds: number) => void;
  /** Live edit pulse on THIS clip (`null` = none) — see `useEditPulse`. */
  readonly pulseKind?: EditPulseKind | null;
  /** The pulsing edit was committed by the AI (accent treatment). */
  readonly pulseAgent?: boolean;
  /** Restarts the overlay animation when the same clip pulses twice in a row. */
  readonly pulseToken?: number;
  /**
   * This clip holds the timeline's single clip tab stop (roving tabindex, the
   * pattern the bin / Sounds / Stock already use). Everything focusable *inside*
   * a clip is `-1` and is reached from the clip's own keydown.
   */
  readonly tabbable: boolean;
  /** Whether this clip's per-property keyframe lanes are open (Phase 6). */
  readonly lanesOpen?: boolean;
  /** Open/close the lanes. Absent = the surface does not offer them. */
  readonly onToggleLanes?: ((clipId: string) => void) | undefined;
}

const TimelineClip = memo(function TimelineClip({
  clip,
  track,
  isGhost,
  ghostKind,
  ghostDuplicate,
  ghostRoll,
  start,
  end,
  pxPerSecond,
  fps,
  timeDisplay,
  selected,
  showThumbnails,
  joinLeft,
  joinRight,
  assetById,
  beginGesture,
  onPointerMove,
  onPointerUp,
  onSelectClip,
  openClipMenu,
  onFadeCommit,
  tabbable,
  pulseKind = null,
  pulseAgent = false,
  pulseToken = 0,
  lanesOpen = false,
  onToggleLanes,
}: TimelineClipProps): JSX.Element {
  const blockRef = useRef<HTMLButtonElement>(null);
  const fadeInRef = useRef<HTMLSpanElement>(null);
  const fadeOutRef = useRef<HTMLSpanElement>(null);
  const clipWidthPx = secondsToPx(end - start, pxPerSecond);
  const keyframeMarkers = clipKeyframeMarkers(clip);
  // Colour/label each clip by its OWN kind (Phase 2), so a clip reads correctly on
  // any layer it is placed on.
  const kind = clipKind(clip, assetById);
  const effectBadges = clipWidthPx >= EFFECT_BADGE_MIN_CLIP_PX ? clipEffectBadges(clip) : [];
  const asset = assetById.get(clip.assetId);
  // Picture clips (video/image) show a filmstrip body; video clips also get a
  // waveform band along the bottom. Hidden on slivers for clarity.
  const showPicture = clipWidthPx >= PICTURE_LAYER_MIN_CLIP_PX;
  // Width-adaptive header: title always, duration + ⋯ only when there's room.
  const density = clipHeaderDensity(clipWidthPx);
  const name = clipLabel(kind, clip, asset);

  // Fade handles (audio clips only, H8). Dragged locally (no cross-track/patch
  // concerns like move/trim) — one `setAudioPatch` commits on release.
  const clipSeconds = end - start;
  const savedAudio = kind === 'audio' ? audioSettings(clip) : null;
  const [fadeDrag, setFadeDrag] = useState<{ edge: 'in' | 'out'; seconds: number } | null>(null);
  const fadeInSeconds =
    fadeDrag?.edge === 'in' ? fadeDrag.seconds : (savedAudio?.fadeInSeconds ?? 0);
  const fadeOutSeconds =
    fadeDrag?.edge === 'out' ? fadeDrag.seconds : (savedAudio?.fadeOutSeconds ?? 0);
  const fadeDragRef = useRef<{
    edge: 'in' | 'out';
    startX: number;
    startSeconds: number;
    current: number;
  } | null>(null);
  const beginFadeDrag = (event: React.PointerEvent, edge: 'in' | 'out'): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startSeconds = edge === 'in' ? fadeInSeconds : fadeOutSeconds;
    fadeDragRef.current = { edge, startX: event.clientX, startSeconds, current: startSeconds };
    setFadeDrag({ edge, seconds: startSeconds });
  };
  const onFadePointerMove = (event: React.PointerEvent): void => {
    const g = fadeDragRef.current;
    if (!g) return;
    // A signed DELTA, so it must not go through the position helper — that one
    // clamps to >= 0, which turned every leftward drag into no drag at all and
    // made a fade growable but never shrinkable.
    const deltaSeconds = pxDeltaToSeconds(event.clientX - g.startX, pxPerSecond);
    const raw = g.edge === 'in' ? g.startSeconds + deltaSeconds : g.startSeconds - deltaSeconds;
    const seconds = Math.min(FADE_MAX_SECONDS, Math.max(0, Math.min(raw, clipSeconds)));
    g.current = seconds;
    setFadeDrag({ edge: g.edge, seconds });
  };
  // Edit-pulse overlay (AI apply / undo / redo): a framer-motion glow that flares
  // over the touched clip and fades out. Keyed by `pulseToken` so back-to-back
  // edits on the same clip restart the flare; honours the OS reduced-motion
  // preference by fading opacity only (no scale).
  const reducedMotion = useReducedMotion();

  const onFadePointerUp = (event: React.PointerEvent): void => {
    const g = fadeDragRef.current;
    fadeDragRef.current = null;
    setFadeDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may already be lost (pointercancel); the drag still finalises. */
    }
    if (!g) return;
    onFadeCommit(clip.id, g.edge, g.current);
  };

  /**
   * Keyboard on the fade handles. They have announced themselves as `role="slider"`
   * with live aria values since H8 and did nothing at all — and once Tab stopped
   * being swallowed by `select.next`, the arrows fell straight through to the global
   * handler and moved the PLAYHEAD while the user believed they were adjusting a
   * fade. `stopPropagation` is what keeps them off that path, exactly as
   * `PreviewScrubBar` does for its own arrows.
   */
  const onFadeKeyDown = (event: React.KeyboardEvent, edge: 'in' | 'out'): void => {
    const current = edge === 'in' ? fadeInSeconds : fadeOutSeconds;
    const limit = Math.min(FADE_MAX_SECONDS, clipSeconds);
    const step = event.shiftKey ? FADE_COARSE_STEP_SECONDS : 1 / Math.max(fps, 1);
    // The out handle grows leftwards, the way its pointer drag does, so "towards
    // the middle of the clip" is a longer fade on both edges.
    const grow = edge === 'in' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'in' ? 'ArrowLeft' : 'ArrowRight';
    let next: number;
    switch (event.key) {
      case grow:
      case 'ArrowUp':
        next = current + step;
        break;
      case shrink:
      case 'ArrowDown':
        next = current - step;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = limit;
        break;
      case 'Escape':
        // Leave the handle rather than stranding the user on a control nothing
        // else in the tab ring points back to.
        event.preventDefault();
        event.stopPropagation();
        blockRef.current?.focus();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    onFadeCommit(clip.id, edge, Math.min(limit, Math.max(0, next)));
  };

  /** Which of the clip's own controls are actually on screen for this clip. */
  const hasFadeHandles = kind === 'audio' && clipWidthPx >= FADE_HANDLE_MIN_CLIP_PX;
  const hasLanesToggle =
    onToggleLanes !== undefined && clip.keyframes.length > 0 && density.showHeader;
  // Advertised only where the key does something. A clip that promises D and has
  // no lanes to open teaches the user the shortcut does not work.
  const keyShortcuts = [
    density.showMenu ? 'Shift+F10' : null,
    hasFadeHandles ? 'F' : null,
    hasLanesToggle ? 'D' : null,
  ]
    .filter((key): key is string => key !== null)
    .join(' ');

  /**
   * The clip is the timeline's single clip tab stop, so it is also the way in to
   * the controls it contains — all of which are `tabIndex={-1}` (G2). Every branch
   * stops propagation so the global registry never sees the key.
   */
  const onClipKeyDown = (event: React.KeyboardEvent): void => {
    const openMenuAtClip = (): void => {
      const rect = event.currentTarget.getBoundingClientRect();
      openClipMenu(clip.id, rect.left, rect.bottom);
    };
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      openMenuAtClip();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      const handle = event.shiftKey ? fadeOutRef.current : fadeInRef.current;
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      handle.focus();
      return;
    }
    if ((event.key === 'd' || event.key === 'D') && hasLanesToggle && onToggleLanes) {
      event.preventDefault();
      event.stopPropagation();
      onToggleLanes(clip.id);
    }
  };

  return (
    <button
      ref={blockRef}
      type="button"
      className={`clip-block ${KIND_META[kind].cls} ${isGhost && ghostKind ? `is-${ghostKind}` : ''}${
        isGhost && ghostDuplicate ? ' is-duplicate' : ''
      }${isGhost && ghostRoll ? ' is-roll' : ''}${joinLeft ? ' is-join-l' : ''}${
        joinRight ? ' is-join-r' : ''
      }`}
      // The id, not the name: every test in the repo and both e2e suites address
      // clips by it, and Playwright substring-matches where RTL exact-matches, so
      // changing this text breaks one suite or the other. The human name reaches
      // assistive technology through `aria-describedby` on the visible label below.
      aria-label={`clip ${clip.id}`}
      aria-describedby={density.showHeader ? `${clip.id}-label` : undefined}
      aria-pressed={selected}
      aria-keyshortcuts={keyShortcuts === '' ? undefined : keyShortcuts}
      tabIndex={tabbable ? 0 : -1}
      data-selected={selected}
      data-pulse={pulseKind ?? undefined}
      onKeyDown={onClipKeyDown}
      onPointerDown={(event) => beginGesture(event, 'move', clip, track)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(event) => onSelectClip(event, clip, track)}
      onContextMenu={(event) => {
        event.preventDefault();
        openClipMenu(clip.id, event.clientX, event.clientY);
      }}
      style={{
        left: `${secondsToPx(start, pxPerSecond)}px`,
        width: `${secondsToPx(end - start, pxPerSecond)}px`,
      }}
    >
      <span
        className="clip-trim clip-trim-l"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.stopPropagation();
          beginGesture(event, 'trim-l', clip, track);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {pulseKind && (
        <motion.span
          key={pulseToken}
          className={`clip-pulse is-${pulseKind}${pulseAgent ? ' is-agent' : ''}`}
          aria-hidden="true"
          initial={reducedMotion ? { opacity: 0.7 } : { opacity: 0.9, scale: 1.02 }}
          animate={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 1 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
        />
      )}
      {/* The filmstrip has no sliver cutoff: when thumbnails are on, even a very
          narrow clip shows at least one frame (filmstripSlots bottoms out at 1). */}
      {showThumbnails && (kind === 'video' || kind === 'image') && clipWidthPx > 0 && (
        <ClipFilmstrip
          asset={asset}
          sourceStart={clip.sourceStart}
          sourceEnd={clip.sourceEnd}
          slots={filmstripSlots(clipWidthPx)}
        />
      )}
      {showPicture && kind === 'video' && (
        <ClipWaveform
          assetId={clip.assetId}
          media={asset?.media ?? undefined}
          assetPath={asset?.path}
          sourceStart={clip.sourceStart}
          sourceEnd={clip.sourceEnd}
          variant="band"
        />
      )}
      {kind === 'audio' && (
        <ClipWaveform
          assetId={clip.assetId}
          media={asset?.media ?? undefined}
          assetPath={asset?.path}
          sourceStart={clip.sourceStart}
          sourceEnd={clip.sourceEnd}
        />
      )}
      {kind === 'audio' && clipWidthPx >= FADE_HANDLE_MIN_CLIP_PX && (
        <>
          <span
            className="clip-fade-overlay clip-fade-overlay-in"
            aria-hidden="true"
            style={{ width: `${secondsToPx(fadeInSeconds, pxPerSecond)}px` }}
          />
          <span
            ref={fadeInRef}
            className="clip-fade-handle clip-fade-handle-in"
            role="slider"
            aria-label="Fade in duration"
            aria-valuemin={0}
            aria-valuemax={FADE_MAX_SECONDS}
            aria-valuenow={Math.round(fadeInSeconds * 100) / 100}
            tabIndex={-1}
            style={{ left: `${secondsToPx(fadeInSeconds, pxPerSecond)}px` }}
            onPointerDown={(event) => beginFadeDrag(event, 'in')}
            onPointerMove={onFadePointerMove}
            onPointerUp={onFadePointerUp}
            onKeyDown={(event) => onFadeKeyDown(event, 'in')}
          />
          <span
            className="clip-fade-overlay clip-fade-overlay-out"
            aria-hidden="true"
            style={{ width: `${secondsToPx(fadeOutSeconds, pxPerSecond)}px` }}
          />
          <span
            ref={fadeOutRef}
            className="clip-fade-handle clip-fade-handle-out"
            role="slider"
            aria-label="Fade out duration"
            aria-valuemin={0}
            aria-valuemax={FADE_MAX_SECONDS}
            aria-valuenow={Math.round(fadeOutSeconds * 100) / 100}
            tabIndex={-1}
            style={{ right: `${secondsToPx(fadeOutSeconds, pxPerSecond)}px` }}
            onPointerDown={(event) => beginFadeDrag(event, 'out')}
            onPointerMove={onFadePointerMove}
            onPointerUp={onFadePointerUp}
            onKeyDown={(event) => onFadeKeyDown(event, 'out')}
          />
        </>
      )}
      {effectBadges.length > 0 && (
        <span className="clip-badges" aria-hidden="true">
          {effectBadges.map((badge) => {
            const BadgeIcon = badge.icon;
            return (
              <span key={badge.key} className="clip-badge" title={badge.label}>
                <BadgeIcon size={ICON_SIZE.sm} aria-hidden="true" />
              </span>
            );
          })}
        </span>
      )}
      {density.showHeader && (
        <div className="clip-header">
          <span className="clip-label" id={`${clip.id}-label`} title={name}>
            {name}
          </span>
          {density.showTime && (
            <span className="clip-time tabular">{clipDurationLabel(clip, fps, timeDisplay)}</span>
          )}
          {density.showMenu && (
            // A span, not a <button>: the clip itself is a <button>, and nested
            // buttons are invalid HTML. Out of the tab ring (roving tabindex, G2) —
            // 200 clips would otherwise be 200 extra stops; from the keyboard the
            // menu opens with Shift+F10 on the clip, the platform convention.
            <span
              role="button"
              tabIndex={-1}
              className="clip-menu-btn"
              aria-label="Clip actions"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                openClipMenu(clip.id, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openClipMenu(clip.id, rect.left, rect.bottom);
              }}
            >
              <MoreHorizontal size={ICON_SIZE.sm} aria-hidden="true" />
            </span>
          )}
        </div>
      )}
      {/*
        The at-a-glance "this clip is animated" strip. Still decorative and
        aria-hidden — it is a summary, and the REAL keyframe objects (selectable,
        draggable, deletable, announced) live in the lanes below the clip. Duplicating
        them in the accessibility tree would make a screen reader read every keyframe
        twice, once as noise and once as a control.
      */}
      {keyframeMarkers.length > 0 && (
        <span className="clip-keyframes" aria-hidden="true">
          {keyframeMarkers.map((kf) => (
            <span
              key={kf.key}
              className="clip-keyframe"
              title={kf.label}
              style={{ left: `${secondsToPx(kf.time, pxPerSecond)}px` }}
            />
          ))}
        </span>
      )}
      {/*
        Expand the per-property lanes. Only on animated clips — an expander that opens
        an empty drawer is a promise the clip cannot keep — and only when the clip is
        wide enough to have shown its header, since below that there is no room for a
        control the user could hit.
      */}
      {onToggleLanes !== undefined && clip.keyframes.length > 0 && density.showHeader && (
        <button
          type="button"
          className="clip-lanes-toggle"
          // Out of the tab ring for the same reason as the ⋯ span; D on the focused
          // clip toggles the lanes.
          tabIndex={-1}
          aria-label={`${lanesOpen ? 'Hide' : 'Show'} keyframes for ${name}`}
          aria-expanded={lanesOpen}
          title={lanesOpen ? 'Hide keyframe lanes' : 'Show keyframe lanes'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleLanes(clip.id);
          }}
        >
          <Diamond size={10} aria-hidden="true" />
        </button>
      )}
      <span
        className="clip-trim clip-trim-r"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.stopPropagation();
          beginGesture(event, 'trim-r', clip, track);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </button>
  );
});

export function TimelineView({
  editor,
  assets = [],
  fps = 30,
  editMode = 'overwrite',
  trackLayout: trackLayoutProp,
  onAskAiForClip,
  onRevealAssetInBin,
  onOpenTransitionLibrary,
  tool = 'select',
  onItemActivate,
  selectedEffectLayerIds = [],
  // Defaulted to a no-op so the component still works standalone in tests that do
  // not exercise effect selection.
  onSelectEffectLayers: onSelectEffectLayersProp = () => {},
  onKeyframeSelectionChange,
}: TimelineViewProps): JSX.Element {
  // `playhead` is intentionally NOT read here (perf slice 1b): the live-playhead
  // nodes (PlayheadMarker/PlayheadScrubber/RulerBar) subscribe to it directly, and
  // handlers read `editor.getPlayhead()`, so TimelineView can be memoised out of
  // the per-seek render path.
  const { timeline, pxPerSecond, markers, selection, selectedIds, playing } = editor.state;
  const { settings } = useSettings();
  // Per-track view layout (height / collapse / solo) — session state, never the
  // project (invariant 5). The hook is always called (rules of hooks); a prop may
  // override it in tests. Reading individual track views does not touch the memo
  // deps unless a height/collapse actually changes (the hook's identity is stable).
  const ownTrackLayout = useTrackLayout();
  const trackLayout = trackLayoutProp ?? ownTrackLayout;
  // Keyframe lanes (revamp Phase 6): which clips are expanded and which keyframes
  // are selected. VIEW state, never the project — expanding a clip is not an edit,
  // and undo after it must undo the user's last edit, not collapse a lane.
  const keyframes = useKeyframeSelection();
  const selectedKeyframeRefs = useMemo(
    () =>
      [...keyframes.keys]
        .map((key) => parseKeyframeKey(key))
        .filter((reference): reference is NonNullable<typeof reference> => reference !== null),
    [keyframes.keys],
  );
  useEffect(() => {
    onKeyframeSelectionChange?.(selectedKeyframeRefs);
  }, [onKeyframeSelectionChange, selectedKeyframeRefs]);
  const timeDisplay = settings.timeDisplay;
  const showTimelineThumbnails = settings.showTimelineThumbnails;
  // Memoised so a per-frame seek (which re-renders this component) doesn't re-walk
  // every clip; only a timeline edit recomputes it. Perf slice 3 (plan Phase 12.1).
  const duration = useMemo(() => timelineDuration(timeline), [timeline]);
  const laneSeconds = Math.max(duration, MIN_LANE_SECONDS);
  const laneWidth = secondsToPx(laneSeconds, pxPerSecond);
  // Resolve a clip's asset to draw a real waveform from engine-derived peaks.
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  // CapCut-style: hide pre-seeded empty tracks; only show a track when it has
  // clips OR was explicitly created by the user (IDs from the patch engine start
  // with "layer_"; pre-seeded tracks use "video_1", "audio_1", etc.).
  // Every track in the project is a row (UX-05).
  //
  // Empty tracks used to be filtered out unless they were `layer_*` or effect lanes,
  // which meant a project's own empty audio track — the obvious place to drop music —
  // did not exist as far as the editor was concerned, and "Add track" was the only way
  // to discover a lane at all. A track in the timeline is a track the user or the AI
  // declared; hiding it hides a drop target, and an empty row is exactly what every
  // NLE shows there. Effect lanes (schema v13, ADR 0088) carry `effectLayers` and never
  // clips, so they were the exception that first proved the filter wrong.
  const visibleTracks = timeline.tracks;
  // Transient highlight over the clips the last committed edit touched (AI apply,
  // undo, redo — manual edits too). Derived purely from the edit history; while a
  // pulse is live the root gains `is-edit-pulse`, which turns on left/width
  // transitions so ripple shifts glide instead of snapping (never during drags —
  // gestures don't commit history until release, so no pulse is active mid-drag).
  const pulse = useEditPulse(editor.state.history);

  const lanesRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLOListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The vertical scroll viewport (wraps both the header column and the lanes) —
   *  the element the lane virtualizer measures so many tracks window vertically. */
  const vScrollRef = useRef<HTMLDivElement>(null);
  // The editor object's identity changes every render; a ref lets the long-lived
  // wheel listener read the latest store state/actions without re-subscribing.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const gestureRef = useRef<Gesture | null>(null);
  /** Set when a real drag just finished, so the trailing click does not also select. */
  const justDraggedRef = useRef(false);
  const playheadDragRef = useRef(false);
  // The playhead advances ~60×/s during playback. Gesture handlers only need it as
  // a *snap target* (and only while dragging, when the playhead is parked), so they
  // read it through this ref instead of closing over the value — keeping their
  // identity stable across playback frames so the memoised lanes below are not
  // rebuilt 60×/s just because the playhead moved.
  // Auto-scroll (playhead-follow) reads these through refs in an rAF loop so the
  // loop never re-subscribes and the lanes never re-render per tick. `playing` and
  // the `autoFollow` preference gate the follow; `userScrollUntil` is a timestamp
  // (ms) set on manual horizontal scroll/wheel that suspends follow briefly so
  // auto-scroll never fights a manual pan.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const autoFollowRef = useRef(settings.autoFollow);
  autoFollowRef.current = settings.autoFollow;
  const userScrollUntilRef = useRef(0);
  // True for the brief window around a *programmatic* scrollLeft write (auto-follow,
  // minimap, zoom centring) so the resulting `scroll` event is not misread as a
  // manual pan that would suspend auto-follow against itself.
  const programmaticScrollRef = useRef(false);
  const pxPerSecondRef = useRef(pxPerSecond);
  pxPerSecondRef.current = pxPerSecond;
  // The editor *actions* are referentially stable (useEditor memoises them), unlike
  // the `editor` wrapper object; destructure them so the memoised lanes can depend
  // on the actions without depending on the per-render wrapper.
  const { select, selectMany, clearSelection, applyPatch } = editor;
  // The selection set is read inside stable gesture callbacks; a ref keeps those
  // callbacks' identity fixed (so the memoised lanes are not rebuilt) while still
  // letting them see the latest selection at gesture time.
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  // Membership lookup for the lanes' `data-selected`; a Set keeps the per-clip
  // check O(1) and only changes identity when the selection actually changes.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Roving tabindex over the clips — the pattern the bin, Sounds and Stock already
  // use. The timeline is ONE tab stop, not one per clip: a 200-cut montage would
  // otherwise sit 200 stops deep between the panel above it and the one below.
  // The stop rides the selection, falling back to the first clip so a timeline that
  // has never been clicked is still reachable from the keyboard.
  const tabbableClipId = useMemo(
    () => selection ?? orderedClips(timeline)[0]?.clip.id ?? null,
    [selection, timeline],
  );
  // --- Effect layers (schema v13, ADR 0088) --------------------------------
  //
  // The selection itself is lifted to `Editor` (see its props) because the
  // Inspector renders the selected layer's controls and is this view's sibling.
  // Aliased up here (not next to the effect-layer handlers below) because the
  // marquee — which selects layers as well as clips — is declared earlier.
  const setSelectedEffectLayerIds = onSelectEffectLayersProp;
  // Read inside the marquee's stable gesture callbacks, for the same reason
  // `selectedIdsRef` exists: see the latest set without re-creating them.
  const selectedEffectLayerIdsRef = useRef(selectedEffectLayerIds);
  selectedEffectLayerIdsRef.current = selectedEffectLayerIds;

  // --- Per-track view layout (height / collapse / solo) ---------------------
  // A plain map of trackId → view state for the visible tracks. Its identity
  // changes only when a height/collapse actually changes, so the memoised lanes
  // are not rebuilt on playback (the layout hook never reads the playhead).
  const trackViews = useMemo<ReadonlyMap<string, TrackViewState>>(
    () => new Map(visibleTracks.map((t) => [t.id, trackLayout.get(t.id)])),
    [visibleTracks, trackLayout],
  );
  /**
   * Track ids muted by an active solo — a derived, transient PREVIEW state, not a
   * schema change (no `set_track_flags`, never touches `Track.muted`). Surfaced so
   * the header mute control reads "muted by solo" and so a future preview audio mix
   * can consume it; with no solo active the set is empty and the real flags stand.
   */
  const soloMutedIds = useMemo(
    () => resolveSoloMutedTrackIds(visibleTracks, trackLayout.soloedIds, assetById),
    [visibleTracks, trackLayout.soloedIds, assetById],
  );

  // --- Vertical virtualization of the lane list (M2b-2) ---------------------
  // Once tracks can exceed the viewport, window the lanes so only the rows on
  // screen mount (the clip subtree is the heavy part). The header column renders
  // the same windowed slice at the same offsets, so the two grid columns stay
  // aligned. Row size = the lane's effective (collapsed-aware) height + the gap,
  // so absolute offsets match. The virtualizer's range never depends on the
  // playhead, so the memoised lanes are not rebuilt on playback.
  const rowSize = useCallback(
    (index: number): number => {
      const track = visibleTracks[index];
      const view = track ? trackViews.get(track.id) : undefined;
      // `track.type` matters: an effect lane renders at EFFECT_TRACK_HEIGHT, and
      // omitting the type here made the virtualizer reserve a full 56px row for a
      // 20px lane — the empty band under every effect lane.
      //
      // Expanded keyframe lanes grow the row (Phase 6). This MUST agree with the
      // height the lane element is given below, or the virtualizer's offsets drift
      // and every track after an expanded one is drawn in the wrong place.
      return (
        (view ? effectiveTrackHeight(view, track?.type) : TRACK_HEIGHT_BOUNDS.default) +
        (track ? trackKeyframeLanesHeight(track, keyframes.expanded) : 0) +
        TRACK_ROW_GAP
      );
    },
    [visibleTracks, trackViews, keyframes.expanded],
  );
  const laneVirtualizer = useVirtualizer({
    count: visibleTracks.length,
    getScrollElement: () => vScrollRef.current,
    estimateSize: rowSize,
    overscan: TRACK_OVERSCAN,
    observeElementRect: observeLaneRectWithFallback,
  });
  /**
   * Re-measure when a row's height actually changes.
   *
   * WHY this is needed: TanStack Virtual memoises its measurements on
   * `count` (+ its internal size cache) — `estimateSize` is deliberately NOT one
   * of those dependencies. So handing it a new `rowSize` closure does nothing on
   * its own: collapsing a lane, reordering the stack, or expanding keyframe lanes
   * changed the heights we compute while the virtualizer kept laying every row
   * out at the sizes it captured the first time the track count changed. That is
   * exactly the reported bug — dead whitespace under short lanes and overlapping
   * lanes after a reorder. `measure()` clears that cache so the offsets are
   * rebuilt from the current heights.
   *
   * The signature (not the raw deps) is what gates it: identities like
   * `visibleTracks` churn far more often than the geometry does, and `measure()`
   * forces a re-render, so we call it only when a height genuinely moved. It
   * never reads the playhead, so playback still costs nothing here.
   */
  const rowHeightSignature = useMemo(
    () => visibleTracks.map((_track, index) => rowSize(index)).join(','),
    [visibleTracks, rowSize],
  );
  useLayoutEffect(() => {
    laneVirtualizer.measure();
  }, [laneVirtualizer, rowHeightSignature]);

  const virtualRows = laneVirtualizer.getVirtualItems();
  const totalLaneHeight = laneVirtualizer.getTotalSize();

  const visibleTrackIds = useMemo(() => visibleTracks.map((t) => t.id), [visibleTracks]);

  /**
   * The vertical band each lane row occupies, built from the SAME `rowSize` the
   * virtualizer lays the rows out with — so a marquee hit-tests against where the
   * lanes actually are. Rows tile the whole strip (each band includes its trailing
   * gap), leaving no dead pixels between lanes for a band to fall into.
   *
   * Every row is included, not just the mounted (windowed) ones: the marquee
   * selects from the timeline model, so a band dragged across an off-screen row
   * must still catch its clips.
   */
  const laneRowBands = useMemo<readonly LaneRowBand[]>(() => {
    let top = 0;
    return visibleTracks.map((track, index) => {
      const height = rowSize(index);
      const band = { trackId: track.id, top, height };
      top += height;
      return band;
    });
  }, [visibleTracks, rowSize]);

  // --- Minimap viewport mirror ----------------------------------------------
  // The lane scroll metrics drive the minimap's draggable window. We mirror them
  // into state on scroll/resize so the window tracks the viewport; this is the
  // ONLY place scroll updates a render, and it touches just the minimap (the heavy
  // lanes are memoised off `pxPerSecond`/content, never `scrollLeft`).
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });
  const syncViewport = useCallback((): void => {
    const sc = scrollRef.current;
    if (!sc) return;
    setViewport((prev) =>
      prev.scrollLeft === sc.scrollLeft && prev.clientWidth === sc.clientWidth
        ? prev
        : { scrollLeft: sc.scrollLeft, clientWidth: sc.clientWidth },
    );
  }, []);
  useEffect(() => {
    syncViewport();
    const sc = scrollRef.current;
    if (!sc || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncViewport);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [syncViewport, laneWidth]);
  /** Pan the lane viewport to a `scrollLeft` (px) — the minimap's only side effect. */
  const scrollLaneTo = useCallback((scrollLeft: number): void => {
    const sc = scrollRef.current;
    if (sc) sc.scrollLeft = scrollLeft;
  }, []);

  // --- Horizontal render window (film-scale timelines) -----------------------
  // The quantized slice of the lanes worth mounting (viewport + one viewport of
  // overscan each side). Destructured to PRIMITIVES so the heavy lanes memo can
  // depend on them: `viewport` changes identity on every scrolled pixel (the
  // minimap needs that), but these numbers only change when scrolling crosses a
  // whole bucket — so lanes rebuild a handful of times across a long pan, not
  // per scroll event. `null`/unmeasured (first paint, jsdom) mounts everything.
  const renderWindow = laneRenderWindow(viewport.scrollLeft, viewport.clientWidth);
  const windowStartPx = renderWindow?.startPx ?? null;
  const windowEndPx = renderWindow?.endPx ?? null;

  const [ghost, setGhost] = useState<Ghost | null>(null);
  // Leading-edge rAF throttle for the drag ghost (perf slice 3, plan Phase 12.1).
  // `ghost` is a dep of the heavy `trackLanes` memo, so a raw `setGhost` on every
  // pointermove (trackpads fire many per frame) rebuilds every lane per event. The
  // FIRST move of a frame renders immediately (so a single move — and the interaction
  // tests — observe the ghost synchronously), further moves within the frame coalesce,
  // and the latest is flushed once on the next frame. `latestGhostRef` always holds the
  // exact current ghost so the commit on pointer-up is frame-accurate regardless.
  const latestGhostRef = useRef<Ghost | null>(null);
  const ghostRafRef = useRef(0);
  const pendingGhostRef = useRef<{ has: boolean; value: Ghost | null }>({
    has: false,
    value: null,
  });
  const commitGhost = useCallback((next: Ghost | null): void => {
    latestGhostRef.current = next;
    if (ghostRafRef.current === 0) {
      setGhost(next); // leading edge — render this move now
      ghostRafRef.current = requestAnimationFrame(() => {
        ghostRafRef.current = 0;
        if (pendingGhostRef.current.has) {
          pendingGhostRef.current = { has: false, value: null };
          setGhost(latestGhostRef.current);
        }
      });
    } else {
      pendingGhostRef.current = { has: true, value: next }; // trailing — coalesce
    }
  }, []);
  const clearGhost = useCallback((): void => {
    if (ghostRafRef.current !== 0) {
      cancelAnimationFrame(ghostRafRef.current);
      ghostRafRef.current = 0;
    }
    pendingGhostRef.current = { has: false, value: null };
    latestGhostRef.current = null;
    setGhost(null);
  }, []);
  // Blade tool is lifted state (Editor.tsx), shared with the toolbar's Tools
  // group (TIMELINE-TOOLBAR-REORG) — this view only derives its local `razor`
  // click-to-cut behavior from it.
  const razor = tool === 'blade';
  const [razorTime, setRazorTime] = useState<number | null>(null);
  const [menu, setMenu] = useState<ClipMenuTarget | null>(null);
  /** The track-header right-click menu (add above/below, delete lane). */
  const [trackMenu, setTrackMenu] = useState<TrackMenuTarget | null>(null);
  // The on-cut "+" transition picker (#8): which cut it is anchored to and where.
  const [transitionPicker, setTransitionPicker] = useState<TransitionPickerTarget | null>(null);
  const openTransitionPicker = useCallback((fromClipId: string, x: number, y: number): void => {
    setTransitionPicker({ fromClipId, x, y });
  }, []);
  // The on-cut block's actions (revamp Phase 8). Keyed by the INCOMING clip id,
  /**
   * The transition on the clipboard, named by its incoming clip.
   *
   * A ref, not state: nothing renders differently because something was copied
   * except the Paste item, and that is read at menu-open time. Making it state
   * would re-render every lane on a copy.
   */
  const transitionClipboard = useRef<string | null>(null);
  /**
   * Edit points the user has multi-selected, named by their incoming clips.
   *
   * A separate selection from the clip selection on purpose: "these three cuts"
   * and "these three shots" are different intents, and a bulk transition apply
   * that silently used the clip selection would treat "I selected the whole
   * sequence" as "put a transition on everything".
   */
  const [selectedCuts, setSelectedCuts] = useState<readonly string[]>([]);
  const toggleCutSelection = useCallback((toClipId: string, additive: boolean): void => {
    setSelectedCuts((current) => {
      if (!additive) return current.length === 1 && current[0] === toClipId ? [] : [toClipId];
      return current.includes(toClipId)
        ? current.filter((id) => id !== toClipId)
        : [...current, toClipId];
    });
  }, []);

  // which is where the transition effect lives and how every transition builder
  // addresses it.
  const [transitionMenu, setTransitionMenu] = useState<{
    readonly placement: TransitionPlacement;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  // Carries the whole placement, not just an id: the menu needs the current
  // duration (to mark the active preset) and the clamp (to omit presets this cut
  // cannot hold), and re-deriving those from the id would duplicate
  // `timelineTransitions`' work at the moment the menu opens.
  const openTransitionMenu = useCallback(
    (placement: TransitionPlacement, x: number, y: number): void => {
      setTransitionMenu({ placement, x, y });
    },
    [],
  );
  // Ephemeral marquee (rubber-band) state — never an edit (PROMPT invariant 5):
  // only the selection it resolves to on pointerup touches the store. `origin`
  // and the live `rect` are lanes-relative px; `additive` records whether Shift
  // was held at press (so the release extends rather than replaces the selection).
  const [marquee, setMarquee] = useState<PixelRect | null>(null);
  const marqueeRef = useRef<{
    readonly originX: number;
    readonly originY: number;
    readonly additive: boolean;
    moved: boolean;
  } | null>(null);

  /** Select a clip and open its actions menu at a viewport point — the single path
   *  shared by right-click and the header's ⋯ button (same {@link ClipMenuTarget}). */
  const openClipMenu = useCallback(
    (clipId: string, x: number, y: number): void => {
      select(clipId);
      setMenu({ clipId, x, y });
    },
    [select],
  );

  /** Convert an absolute pointer X to a timeline time (seconds), lane-relative. */
  const xToSeconds = useCallback(
    (clientX: number): number => {
      const left = lanesRef.current?.getBoundingClientRect().left ?? 0;
      return pxToSeconds(clientX - left, pxPerSecond);
    },
    [pxPerSecond],
  );

  /**
   * Whether snapping is off for this gesture. The Settings default sets the base
   * behaviour; holding Alt always *inverts* it — so Alt disables snapping when the
   * default is on, and enables it when the default is off.
   */
  const snapDisabled = useCallback(
    (altKey: boolean): boolean => (settings.snapping ? altKey : !altKey),
    [settings.snapping],
  );

  /**
   * The edge the current gesture's magnet is holding, if any.
   *
   * Gesture-scoped memory rather than state: it changes on every pointer move and
   * nothing renders from it directly, so putting it in state would re-render the
   * timeline at pointer frequency to store a number the DOM never reads.
   */
  const magnetHeldRef = useRef<number | null>(null);

  /**
   * Snap a raw time to nearby edges/markers/playhead unless snapping is disabled.
   *
   * A magnet, not a nearest-neighbour lookup: an edge is captured within
   * {@link SNAP_PX} and then keeps hold until the pointer drags past
   * {@link MAGNET_RELEASE_PX}. That gap is what a user feels as two clips joining
   * and then being pulled apart — and it is also what stops an edge parked exactly
   * on the threshold from flickering in and out of alignment with every tremor.
   * Holding Alt still bypasses the whole thing (see `snapDisabled`), which is the
   * escape hatch for placing an edge somewhere a magnet would refuse to leave.
   */
  const snapValue = useCallback(
    (raw: number, disable: boolean): { value: number; snapped: boolean } => {
      const clamped = Math.max(0, raw);
      if (disable) {
        magnetHeldRef.current = null;
        return { value: clamped, snapped: false };
      }
      const targets = snapTargets(timeline, [...markers.map((m) => m.time), editor.getPlayhead()]);
      const { value, held } = magnetSnap(
        clamped,
        targets,
        SNAP_PX / pxPerSecond,
        MAGNET_RELEASE_PX / pxPerSecond,
        magnetHeldRef.current,
      );
      magnetHeldRef.current = held;
      return { value, snapped: held !== null };
    },
    [timeline, markers, pxPerSecond],
  );

  // --- Clip gestures (move / trim) ------------------------------------------
  // These handlers are stable (useCallback) so the memoised lanes below keep the
  // same element tree across playback frames — they only change identity when a
  // real dependency (timeline, drag ghost, razor mode) changes, never on a seek.
  const beginGesture = useCallback(
    (event: React.PointerEvent, kind: GestureKind, clip: Clip, track: Track): void => {
      if (track.locked) return; // a locked lane ignores move/trim gestures
      if (razor) return; // razor mode handles the press as a split, not a drag
      event.currentTarget.setPointerCapture(event.pointerId);
      // A fresh gesture starts unmagnetised: a hold left over from the last drag
      // would silently stick this one to an edge the user never approached.
      magnetHeldRef.current = null;
      gestureRef.current = {
        kind,
        clip,
        fromTrackId: track.id,
        fromTrackType: track.type,
        downX: event.clientX,
        downSeconds: xToSeconds(event.clientX),
        moved: false,
      };
    },
    [razor, xToSeconds],
  );

  const onClipPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      const g = gestureRef.current;
      if (!g) return;
      if (!g.moved && Math.abs(event.clientX - g.downX) <= DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const cursor = xToSeconds(event.clientX);
      const span = g.clip.end - g.clip.start;

      if (g.kind === 'move') {
        const { value: start, snapped } = snapValue(
          g.clip.start + (cursor - g.downSeconds),
          snapDisabled(event.altKey),
        );
        let trackId = g.fromTrackId;
        const overLane = document
          .elementFromPoint?.(event.clientX, event.clientY)
          ?.closest?.('[data-track-id]') as HTMLElement | null;
        const overType = overLane?.dataset.trackType as Track['type'] | undefined;
        if (overLane && overType && tracksCompatible(g.fromTrackType, overType)) {
          trackId = overLane.dataset.trackId ?? trackId;
        }
        commitGhost({
          clipId: g.clip.id,
          trackId,
          start,
          end: start + span,
          kind: g.kind,
          snapTime: snapped ? start : null,
          duplicate: event.metaKey || event.ctrlKey,
        });
        return;
      }

      // Cmd/Ctrl on a butt-joined cut rolls the edit point against the
      // neighbouring clip instead of trimming only the grabbed clip.
      const track = findClip(timeline, g.clip.id)?.track;
      const junction =
        (event.metaKey || event.ctrlKey) && track
          ? trackJunctions(track).find(
              (j) => j.touching && (g.kind === 'trim-l' ? j.toClipId : j.fromClipId) === g.clip.id,
            )
          : undefined;
      const neighbor =
        junction &&
        findClip(timeline, g.kind === 'trim-l' ? junction.fromClipId : junction.toClipId)?.clip;

      if (g.kind === 'trim-l') {
        const { value, snapped } = snapValue(cursor, snapDisabled(event.altKey));
        const bounds = neighbor ? rollBounds(neighbor, g.clip) : null;
        const start = bounds
          ? Math.min(bounds.max, Math.max(bounds.min, value))
          : clampTrimStart(g.clip, value);
        commitGhost({
          clipId: g.clip.id,
          trackId: g.fromTrackId,
          start,
          end: g.clip.end,
          kind: g.kind,
          snapTime: snapped ? start : null,
          ...(bounds && neighbor ? { rollWith: neighbor.id } : {}),
        });
        return;
      }

      const { value, snapped } = snapValue(cursor, snapDisabled(event.altKey));
      const bounds = neighbor ? rollBounds(g.clip, neighbor) : null;
      const end = bounds
        ? Math.min(bounds.max, Math.max(bounds.min, value))
        : clampTrimEnd(g.clip, value);
      commitGhost({
        clipId: g.clip.id,
        trackId: g.fromTrackId,
        start: g.clip.start,
        end,
        kind: g.kind,
        snapTime: snapped ? end : null,
        ...(bounds && neighbor ? { rollWith: neighbor.id } : {}),
      });
    },
    [timeline, snapValue, snapDisabled, xToSeconds, commitGhost],
  );

  const onClipPointerUp = useCallback(
    (event: React.PointerEvent): void => {
      const g = gestureRef.current;
      gestureRef.current = null;
      // Release the magnet with the gesture. Clearing it only in `beginGesture`
      // left the last hold alive between drags, and `snapValue` is shared with
      // consumers that are NOT gestures — the asset-drop path and the effect-layer
      // chips. A stale hold within the release radius would then pull an unrelated
      // drop onto the cut the previous trim happened to end on.
      magnetHeldRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* capture may already be lost (pointercancel); the gesture still finalises. */
      }
      // Use the exact latest ghost (the throttled `ghost` state may lag by a frame).
      const g0 = latestGhostRef.current;
      clearGhost();
      if (!g || !g.moved || !g0) return;
      justDraggedRef.current = true;

      // Trimming stays single-clip, unless a roll neighbour was resolved
      // (Cmd/Ctrl on a butt-joined cut) — then both edges move as one patch.
      if (g.kind !== 'move') {
        const patch = g0.rollWith
          ? rollEditPatch(
              timeline,
              g.kind === 'trim-l' ? g0.rollWith : g.clip.id,
              g.kind === 'trim-l' ? g.clip.id : g0.rollWith,
              g.kind === 'trim-l' ? g0.start : g0.end,
            )
          : g.kind === 'trim-l'
            ? trimClipPatch(timeline, g.clip.id, g0.start, g.clip.end)
            : trimClipPatch(timeline, g.clip.id, g.clip.start, g0.end);
        if (patch) applyPatch(patch);
        return;
      }

      // A move of a clip that is part of a multi-selection moves the WHOLE
      // selection by the same time delta as the dragged (primary) clip — one
      // patch, N move ops. The primary may change track (it followed the pointer);
      // the others keep their own track and just shift in time. Snapping already
      // resolved the primary's landing (g0.start), so the delta is taken from it.
      const ids = selectedIdsRef.current;
      const isBatch = ids.length > 1 && ids.includes(g.clip.id);
      if (isBatch) {
        const delta = g0.start - g.clip.start;
        const moves = ids.flatMap((id) => {
          const loc = findClip(timeline, id);
          if (!loc) return [];
          // The dragged clip uses the resolved track + start; the rest shift in time.
          const toTrackId = id === g.clip.id ? g0.trackId : loc.track.id;
          const toStart = id === g.clip.id ? g0.start : Math.max(0, loc.clip.start + delta);
          return [{ clipId: id, toTrackId, toStart }];
        });
        // Order ops in the direction of travel so no op transiently overlaps a
        // sibling that has not moved yet: moving right (delta > 0) relocates the
        // rightmost clip first; moving left, the leftmost first. The whole batch
        // is still ONE patch — only the op order within it changes.
        moves.sort((a, b) => (delta >= 0 ? b.toStart - a.toStart : a.toStart - b.toStart));
        const patch = g0.duplicate
          ? duplicateClipsAtPatch(timeline, moves)
          : moveClipsPatch(timeline, moves);
        if (patch) applyPatch(patch);
        return;
      }

      const patch = g0.duplicate
        ? duplicateClipAtPatch(timeline, g.clip.id, g0.trackId, g0.start)
        : moveClipPatch(timeline, g.clip.id, g0.start, g0.trackId);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch, clearGhost],
  );

  // --- Clip click: select (with modifiers), or razor-split in razor mode ----
  // Shift+click extends the selection (`add`); Cmd/Ctrl+click toggles the clip in
  // or out (`toggle`); a plain click replaces it (single-select). Modifiers work
  // for keyboard activation too, since React maps the activating key's modifiers
  // onto the synthetic click event.
  const onClipClick = useCallback(
    (event: React.MouseEvent, clip: Clip, track: Track): void => {
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      if (razor) {
        if (track.locked) return; // never split a clip on a locked lane
        const patch = splitClipPatch(timeline, clip.id, xToSeconds(event.clientX));
        if (patch) applyPatch(patch);
        return;
      }
      const mode = event.shiftKey ? 'add' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace';
      select(clip.id, mode); // selection is still allowed on a locked lane
      // A plain click means "this clip and nothing else", so a previously
      // selected effect layer drops out — otherwise Delete would still take the
      // layer down with the clip (they delete together now).
      if (mode === 'replace') setSelectedEffectLayerIds([]);
      // A DELIBERATE click on a clip, distinct from selection changing for any
      // other reason. The "open the Inspector when I click something" preference
      // hangs off this rather than off `state.selection`, so a selection the AI
      // makes mid-run — or a marquee, or an undo restoring one — never yanks the
      // rail out from under the user.
      onItemActivate?.();
    },
    [razor, timeline, xToSeconds, applyPatch, select, setSelectedEffectLayerIds, onItemActivate],
  );

  // --- Marquee (rubber-band) selection on empty lane area (M2a) -------------
  // A press that lands on empty timeline space (not a clip/ruler/playhead) begins
  // a marquee. We draw an ephemeral rectangle while dragging and, on release,
  // select every clip whose time-span × track-row the rectangle covers (additive
  // when Shift is held). Coordinates are relative to the tracks <ol>, so row 0 is
  // the first lane.
  //
  // The gesture lives on `.lane-scroll` (the full-width lane viewport), NOT the
  // tracks <ol>: a real project packs clips wall-to-wall and the <ol> is only as
  // wide as its content, so the natural empty regions to band-select from — right
  // of the last clip, below the last track, empty lanes — fall OUTSIDE the <ol>.
  // Anchoring here makes every empty pixel of the timeline a valid marquee origin.
  const pointFromTracks = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = tracksRef.current?.getBoundingClientRect();
      return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    },
    [],
  );

  const onLanesPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      // Only empty lane space starts a marquee; a primary-button press only, and
      // never in razor mode. Clips own their move/trim press, the ruler & playhead
      // own seeking, and the on-cut transition affordances own their own clicks —
      // bail on any of those so their gestures still work.
      if (razor || event.button !== 0) return;
      if (
        (event.target as HTMLElement).closest(
          '.clip-block, .ruler, .playhead, .clip-transition-add, .clip-transition-pill',
        )
      )
        return;
      const { x, y } = pointFromTracks(event.clientX, event.clientY);
      marqueeRef.current = { originX: x, originY: y, additive: event.shiftKey, moved: false };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom / lost capture — the gesture still finalises on pointerup. */
      }
    },
    [razor, pointFromTracks],
  );

  const onLanesPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      const m = marqueeRef.current;
      if (!m) return;
      const { x, y } = pointFromTracks(event.clientX, event.clientY);
      // Normalise direction so width/height stay non-negative regardless of drag dir.
      const left = Math.min(m.originX, x);
      const top = Math.min(m.originY, y);
      const width = Math.abs(x - m.originX);
      const height = Math.abs(y - m.originY);
      if (!m.moved && width <= DRAG_THRESHOLD_PX && height <= DRAG_THRESHOLD_PX) return;
      m.moved = true;
      setMarquee({ x: left, y: top, width, height });
    },
    [pointFromTracks],
  );

  const onLanesPointerUp = useCallback(
    (event: React.PointerEvent): void => {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore lost capture */
      }
      const rect = marquee;
      setMarquee(null);
      if (!m) return;
      // A press with no drag on empty space clears the selection (CapCut/Premiere)
      // — including the effect layers, or a chip stays lit (and Delete keeps
      // targeting it) after the user has visibly deselected everything.
      if (!m.moved || !rect) {
        if (!m.additive) {
          clearSelection();
          setSelectedEffectLayerIds([]);
        }
        return;
      }
      // Map the rectangle to covered clips AND effect layers via the pure
      // selectors, hit-testing against the real (non-uniform) lane row bands.
      const hits = clipsIntersectingRect(timeline, rect, laneRowBands, pxPerSecond);
      const layerHits = effectLayersIntersectingRect(timeline, rect, laneRowBands, pxPerSecond);
      if (m.additive) {
        // Extend the current selection with the marquee hits (union).
        selectMany([...new Set([...selectedIdsRef.current, ...hits])]);
        setSelectedEffectLayerIds([
          ...new Set([...selectedEffectLayerIdsRef.current, ...layerHits]),
        ]);
      } else {
        selectMany(hits);
        setSelectedEffectLayerIds(layerHits);
      }
    },
    [
      marquee,
      timeline,
      laneRowBands,
      pxPerSecond,
      selectMany,
      clearSelection,
      setSelectedEffectLayerIds,
    ],
  );

  // --- Playhead: click-to-seek and drag on the ruler ------------------------
  const onRulerPointerDown = (event: React.PointerEvent): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    playheadDragRef.current = true;
    editor.seek(xToSeconds(event.clientX));
  };
  const onRulerPointerMove = (event: React.PointerEvent): void => {
    if (playheadDragRef.current) editor.seek(xToSeconds(event.clientX));
  };
  const onRulerPointerUp = (event: React.PointerEvent): void => {
    playheadDragRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore lost capture */
    }
  };

  // --- Zoom to fit / selection (also driven by keyboard via a window event) -
  const applyZoom = useCallback(
    (target: ZoomTarget | null): void => {
      if (!target) return;
      editor.setZoom(target.pxPerSecond);
      /* v8 ignore start -- rAF + scroll centring needs layout jsdom does not do;
         verified manually / in e2e. The zoom math itself is tested via selectors. */
      // Centre the view after the zoom commits; the store clamps the zoom, so we
      // read the resulting width on the next frame rather than assume it.
      requestAnimationFrame(() => {
        const sc = scrollRef.current;
        if (!sc) return;
        sc.scrollLeft =
          secondsToPx(target.centerSeconds, editor.state.pxPerSecond) - sc.clientWidth / 2;
      });
      /* v8 ignore stop */
    },
    [editor],
  );
  const fit = useCallback((): void => {
    applyZoom(zoomToFit(laneSeconds, scrollRef.current?.clientWidth ?? 0));
  }, [applyZoom, laneSeconds]);
  const fitSelection = useCallback((): void => {
    const loc = selection ? findClip(timeline, selection) : null;
    if (loc) applyZoom(zoomToClip(loc.clip, scrollRef.current?.clientWidth ?? 0));
  }, [applyZoom, selection, timeline]);

  useEffect(() => {
    const onZoom = (event: Event): void => {
      const mode = (event as CustomEvent<'fit' | 'selection'>).detail;
      if (mode === 'fit') fit();
      else if (mode === 'selection') fitSelection();
    };
    window.addEventListener('framepilot:zoom', onZoom);
    return () => window.removeEventListener('framepilot:zoom', onZoom);
  }, [fit, fitSelection]);

  // --- Cmd/Ctrl + wheel: zoom the timeline around the cursor -----------------
  // Attached imperatively (not via React's onWheel) so the listener is
  // non-passive and can `preventDefault` the browser's pinch/scroll-zoom. The
  // time under the pointer is held fixed by re-deriving scrollLeft from the
  // clamped zoom the store actually applied.
  /* v8 ignore start -- real wheel + layout geometry; covered by e2e, not jsdom. */
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    // Coalesce a wheel/pinch BURST (trackpads fire many events per frame) into ONE
    // store `setZoom` per animation frame. Each event only accumulates the zoom
    // factor and records the latest cursor anchor; the rAF applies the combined
    // zoom once and re-derives scrollLeft so the time under the cursor stays fixed.
    // Without this, a single pinch dispatched N store updates → N whole-Editor
    // re-renders + N lane rebuilds. Perf slice 3 (plan Phase 12.1).
    let raf = 0;
    let pendingFactor = 1;
    let anchorSeconds = 0;
    let anchorOffsetPx = 0;
    const flush = (): void => {
      raf = 0;
      const ed = editorRef.current;
      const factor = pendingFactor;
      pendingFactor = 1;
      ed.setZoom(ed.state.pxPerSecond * factor);
      requestAnimationFrame(() => {
        const applied = editorRef.current.state.pxPerSecond; // store clamps the zoom
        sc.scrollLeft = secondsToPx(anchorSeconds, applied) - anchorOffsetPx;
      });
    };
    const onWheel = (event: WheelEvent): void => {
      const intent = wheelIntent({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        zoomModifier: event.metaKey || event.ctrlKey,
        shiftKey: event.shiftKey,
        canScrollVertically: sc.scrollHeight - sc.clientHeight > 1,
      });
      if (intent === 'browser') return;
      if (intent === 'scroll-horizontal') {
        // UX-06: the bare wheel moves along the timeline, the axis it actually has.
        // Counts as a manual scroll, so playback follow stands down exactly as it does
        // for a drag of the scrollbar — otherwise the two fight for `scrollLeft`.
        event.preventDefault();
        userScrollUntilRef.current = performance.now() + MANUAL_SCROLL_SUSPEND_MS;
        sc.scrollLeft += event.deltaY;
        return;
      }
      event.preventDefault();
      const ed = editorRef.current;
      const rect = sc.getBoundingClientRect();
      anchorOffsetPx = event.clientX - rect.left; // px from the viewport's left
      anchorSeconds = pxToSeconds(anchorOffsetPx + sc.scrollLeft, ed.state.pxPerSecond);
      pendingFactor *= Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY);
      if (raf === 0) raf = requestAnimationFrame(flush);
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      sc.removeEventListener('wheel', onWheel);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);
  /* v8 ignore stop */

  // --- Seek follow: a playhead you moved is a playhead you can see (UX-07) ---
  //
  // The follow loop below runs only during playback, so a discrete seek — the ruler,
  // a keyboard nudge, "Show on timeline", a jump from the transcript — could park the
  // playhead outside the viewport and leave it there. The view then showed one part of
  // the cut while every edit applied at another, which is the coupling the walkthrough
  // caught. Scrolls ONLY when the playhead is actually out of view (`nextAutoScrollLeft`
  // returns `null` inside the dead-band), never during playback (the loop owns it then)
  // and never while scrubbing (the drag owns it).
  /* v8 ignore start -- real scroll geometry; jsdom has no layout. The decision
     (`nextAutoScrollLeft`) is unit-tested in selectors.test.ts. */
  useEffect(() => {
    if (editor.state.playing || playheadDragRef.current) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const playheadPx = secondsToPx(editor.state.playhead, editor.state.pxPerSecond);
    const next = nextAutoScrollLeft(playheadPx, sc.scrollLeft, sc.clientWidth, sc.scrollWidth);
    if (next === null) return;
    programmaticScrollRef.current = true;
    sc.scrollLeft = next;
  }, [editor.state.playhead, editor.state.pxPerSecond, editor.state.playing]);
  /* v8 ignore stop */

  // --- Auto-scroll / playhead-follow on playback (M2b-2) --------------------
  // A single rAF loop keeps the playhead in view while playing. It reads the
  // playhead/zoom/playing/preference through refs and writes `scrollLeft`
  // imperatively — it NEVER triggers a React render, so the memoised lanes are
  // untouched per tick (the 60fps invariant). The pure `shouldAutoFollow` decides
  // whether to act this frame (suspended while scrubbing or just after a manual
  // scroll), and `nextAutoScrollLeft` returns the new offset or `null` (no write).
  /* v8 ignore start -- rAF + real scroll geometry; jsdom has no layout. The pure
     decision (`shouldAutoFollow`) and geometry (`nextAutoScrollLeft`) are unit-tested. */
  useEffect(() => {
    // Discrete seeks update the marker directly. Polling an idle timeline at
    // display rate only burns CPU, so the follow loop exists during playback.
    if (!editor.state.playing) return undefined;
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const sc = scrollRef.current;
      if (!sc) return;
      const follow = shouldAutoFollow({
        enabled: autoFollowRef.current,
        playing: playingRef.current,
        scrubbing: playheadDragRef.current,
        userScrolling: performance.now() < userScrollUntilRef.current,
      });
      if (!follow) return;
      const playheadPx = secondsToPx(editor.getPlayhead(), pxPerSecondRef.current);
      const next = nextAutoScrollLeft(playheadPx, sc.scrollLeft, sc.clientWidth, sc.scrollWidth);
      if (next !== null) {
        programmaticScrollRef.current = true;
        sc.scrollLeft = next;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [editor.state.playing]);
  /* v8 ignore stop */

  /** On a lane scroll: suspend auto-follow briefly (manual only) and mirror metrics
   *  to the minimap. A programmatic write (auto-follow/minimap/zoom) is not a manual
   *  pan, so it never suspends auto-follow against itself. */
  const onLaneScroll = useCallback((): void => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
    } else {
      userScrollUntilRef.current = performance.now() + MANUAL_SCROLL_SUSPEND_MS;
    }
    syncViewport();
  }, [syncViewport]);

  // --- Track height resize (view-only, persisted) ---------------------------
  // Dragging the header's bottom grip sets the lane height. The in-flight drag is
  /** Flip a track's `locked`/`hidden`/`muted` flag via one reversible patch. */
  const toggleFlag = (track: Track, flag: TrackFlag): void => {
    const patch = setTrackFlagsPatch(timeline, track.id, flag, !track[flag]);
    if (patch) editor.applyPatch(patch);
  };

  /**
   * Add an empty layer at the front (index 0 = visual top) — Phase 2. The layer's
   * role is advisory; any clip kind may be placed on it. Track scope belongs with
   * the tracks, so this lives in the track-header gutter, not the toolbar
   * (TIMELINE-TOOLBAR-REORG) — the caller picks the role from {@link ADD_TRACK_KINDS}.
   *
   * Accepts the full `Track['type']` rather than just video/audio: caption,
   * overlay and effect are all real, first-class lane roles the schema has always
   * allowed, and an effect lane in particular could only be obtained by accident
   * before (there was no way to make one from the UI at all).
   */
  const addLayer = (layerType: Track['type']): void => {
    editor.applyPatch(addLayerPatch(timeline, layerType, 0));
  };

  /** Reorder a layer by one slot toward the front (`-1`) or back (`+1`). */
  // --- Drag-to-reorder track layers ----------------------------------------
  // The header is a drag handle: grabbing a lane and dropping it above/below
  // another reorders the layer stack (one `move_layer` patch), replacing the old
  // up/down nudge chevrons.
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  /** An asset is hovering the open area below the lane stack (drop → new lane). */
  const [assetOverUnderspace, setAssetOverUnderspace] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ overId: string; after: boolean } | null>(null);

  const clearTrackDrag = (): void => {
    setDragTrackId(null);
    setDropTarget(null);
  };

  const reorderTrackTo = (draggedId: string, overId: string, after: boolean): void => {
    if (draggedId === overId) return;
    const from = timeline.tracks.findIndex((t) => t.id === draggedId);
    let to = timeline.tracks.findIndex((t) => t.id === overId);
    if (from < 0 || to < 0) return;
    if (after) to += 1;
    if (from < to) to -= 1; // account for the removal shifting later indices left
    const patch = moveLayerPatch(timeline, draggedId, to);
    if (patch) editor.applyPatch(patch);
  };

  const onDropAsset = useCallback(
    (track: Track, assetId: string, atSeconds: number): void => {
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) return;
      const start = Math.max(0, atSeconds);
      // Insert mode: push the downstream same-lane clips right by the dropped
      // clip's duration (one patch), instead of placing/auto-layering on overlap.
      if (editMode === 'insert' && !track.locked) {
        const patch = insertClipPatch(timeline, track.id, asset, start);
        if (patch) applyPatch(patch);
        return;
      }
      const kind = assetKind(asset);
      // CapCut-style auto-layering (Phase 2, ADR 0032): if the dropped lane is
      // unlocked, holds the same kind (or is empty), and has room at the cursor, honor
      // it — the user aimed there. Otherwise let `placeAssetPatch` find a compatible
      // layer or spawn a new one at the front (index 0). Layers are type-agnostic, so
      // a different kind no longer "falls back" to a fixed lane; it stacks on top.
      const laneKind = layerKind(track, assetById);
      const overlaps = track.clips.some(
        (c) => c.start < start + (asset.durationSeconds ?? 5) && c.end > start,
      );
      const droppedLaneFits =
        !track.locked && (laneKind === null || laneKind === kind) && !overlaps;
      const patch = droppedLaneFits
        ? addClipPatch(timeline, track.id, asset, start)
        : placeAssetPatch(timeline, assetById, asset, start);
      if (patch) applyPatch(patch);
    },
    [assets, assetById, timeline, applyPatch, editMode],
  );

  /** Create a text overlay where a "Text" chip was dropped from the Overlays panel. */
  // --- Effect layers (schema v13, ADR 0088) --------------------------------
  // (`setSelectedEffectLayerIds` is aliased near the clip selection above — the
  // marquee needs it before this point.)
  const [effectMenu, setEffectMenu] = useState<{
    readonly layerId: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);

  /**
   * Snap helper in the shape `EffectLayerChip` wants (seconds → seconds).
   *
   * Deliberately NOT `snapValue`: that one is the clip gesture's magnet and carries
   * a hold across pointer moves. An effect chip runs its own drag, and a drop is a
   * single isolated question, so sharing the gesture's memory let one surface's
   * hold decide another surface's answer. This is the plain, stateless snap.
   */
  const snapSeconds = useCallback(
    (seconds: number, disabled: boolean): number => {
      const clamped = Math.max(0, seconds);
      if (disabled) return clamped;
      const targets = snapTargets(timeline, [...markers.map((m) => m.time), editor.getPlayhead()]);
      return snap(clamped, targets, SNAP_PX / pxPerSecond);
    },
    [timeline, markers, pxPerSecond, editor],
  );

  const onSelectEffectLayer = useCallback(
    (layerId: string, additive: boolean): void => {
      if (!additive) {
        setSelectedEffectLayerIds([layerId]);
        // Mirror of the clip path above: a plain click on a chip means "this
        // layer only", so any clip selection drops out.
        clearSelection();
        return;
      }
      // Shift/⌘ click toggles within the set, matching the clip multi-select.
      setSelectedEffectLayerIds(
        selectedEffectLayerIds.includes(layerId)
          ? selectedEffectLayerIds.filter((id) => id !== layerId)
          : [...selectedEffectLayerIds, layerId],
      );
    },
    [selectedEffectLayerIds, setSelectedEffectLayerIds, clearSelection],
  );

  const onDropEffect = useCallback(
    (track: Track, effectId: string, atSeconds: number): void => {
      if (track.locked) return;
      const patch = addEffectLayerPatch(timeline, effectId, Math.max(0, atSeconds), {
        trackId: track.id,
      });
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );

  const onMoveEffectLayer = useCallback(
    (layerId: string, toStart: number): void => {
      const patch = moveEffectLayerPatch(timeline, layerId, toStart);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );

  const onTrimEffectLayer = useCallback(
    (layerId: string, start: number, end: number): void => {
      const patch = trimEffectLayerPatch(timeline, layerId, start, end);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );

  const openEffectMenu = useCallback(
    (layerId: string, x: number, y: number): void => {
      // A right-click on a layer OUTSIDE the current selection replaces it; on one
      // inside it, the selection is kept so the menu acts on the whole set.
      if (!selectedEffectLayerIds.includes(layerId)) setSelectedEffectLayerIds([layerId]);
      setEffectMenu({ layerId, x, y });
    },
    [selectedEffectLayerIds, setSelectedEffectLayerIds],
  );

  const runEffectMenuAction = useCallback(
    (action: 'duplicate' | 'toggle' | 'remove'): void => {
      const layerId = effectMenu?.layerId;
      setEffectMenu(null);
      if (layerId === undefined) return;
      const found = findEffectLayer(timeline, layerId);
      if (!found) return;
      const patch =
        action === 'duplicate'
          ? duplicateEffectLayerPatch(timeline, layerId)
          : action === 'toggle'
            ? setEffectLayerEnabledPatch(timeline, layerId, found.layer.disabled === true)
            : removeEffectLayerPatch(timeline, layerId);
      if (patch) applyPatch(patch);
      // Selection follows the layer, so removing it must clear the Inspector too.
      if (action === 'remove') setSelectedEffectLayerIds([]);
    },
    [effectMenu, timeline, applyPatch, setSelectedEffectLayerIds],
  );

  const onDropTextOverlay = useCallback(
    (track: Track, atSeconds: number): void => {
      if (track.locked) return;
      const start = Math.max(0, atSeconds);
      const patch = addTextOverlayPatch(
        timeline,
        track.id,
        DEFAULT_TEXT_PARAMS.text,
        start,
        start + settings.defaultOverlaySeconds,
      );
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch, settings.defaultOverlaySeconds],
  );

  // --- On-cut transitions (M3b) ---------------------------------------------
  // Selecting a pill selects its incoming clip, so the inspector's Transition
  // section acts on the same clip; resize/add each commit one validated patch.
  const onSelectTransition = useCallback(
    (toClipId: string, additive = false, preserveSelection = false): void => {
      // Selecting a transition also selects its incoming clip, so the Inspector's
      // Transition section has something to render. The CUT selection is separate
      // and only grows with the modifier — see `selectedCuts`.
      select(toClipId);
      if (preserveSelection) {
        setSelectedCuts((current) => (current.includes(toClipId) ? current : [toClipId]));
        return;
      }
      toggleCutSelection(toClipId, additive);
    },
    [select, toggleCutSelection],
  );
  const onResizeTransition = useCallback(
    (toClipId: string, durationSeconds: number): void => {
      const patch = setTransitionDurationPatch(timeline, toClipId, durationSeconds);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );
  // --- Keyframe lanes (revamp Phase 6) --------------------------------------

  /**
   * Commit a keyframe drag. One patch for the whole selection, so a group drag is a
   * single undo press — and the selection is re-keyed to the new times, or the
   * keyframes the user just dragged would deselect themselves.
   */
  const onKeyframeMove = useCallback(
    (grabbedKey: string, delta: number): void => {
      const grabbed = parseKeyframeKey(grabbedKey);
      if (grabbed === null) return;
      // Grabbing an UNSELECTED keyframe moves only it: dragging a whole selection
      // from a point outside it would move things the user is not pointing at.
      const group = keyframes.keys.has(grabbedKey)
        ? [...keyframes.keys]
            .map(parseKeyframeKey)
            .filter((k): k is NonNullable<typeof k> => k !== null)
        : [grabbed];
      const patch = moveKeyframesPatch(
        timeline,
        group.map((k) => ({
          clipId: k.clipId,
          property: k.property,
          fromTime: k.time,
          toTime: k.time + delta,
        })),
      );
      if (!patch) return;
      applyPatch(patch);
      if (keyframes.keys.has(grabbedKey)) keyframes.shiftSelectionBy(delta);
      else keyframes.setKeys([keyframeKey(grabbed.clipId, grabbed.property, grabbed.time + delta)]);
    },
    [timeline, applyPatch, keyframes],
  );

  /**
   * Add a keyframe on a lane (double-click), pinning the value the curve already has
   * there — so dropping a keyframe never moves the picture, it only records it.
   */
  const onKeyframeAdd = useCallback(
    (clipId: string, property: string, clipTime: number): void => {
      const found = findClip(timeline, clipId);
      if (!found) return;
      const value = evaluateKeyframes(found.clip.keyframes, property, clipTime);
      if (value === undefined) return;
      const patch = setKeyframeAtPlayheadPatch(timeline, clipId, property, value, clipTime);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );

  /** Delete every selected keyframe in one patch. */
  const onKeyframeDelete = useCallback((): void => {
    const refs = [...keyframes.keys]
      .map(parseKeyframeKey)
      .filter((k): k is NonNullable<typeof k> => k !== null);
    if (refs.length === 0) return;
    const patch = removeKeyframesPatch(timeline, refs);
    if (patch) {
      applyPatch(patch);
      keyframes.clear();
    }
  }, [timeline, applyPatch, keyframes]);

  /** Commit a fade-handle drag (H8) — one `setAudioPatch`, preserving the clip's
   *  other audio settings (gain/mute/normalize/duck). */
  const onFadeCommit = useCallback(
    (clipId: string, edge: 'in' | 'out', seconds: number): void => {
      const found = findClip(timeline, clipId);
      if (!found) return;
      const current = audioSettings(found.clip);
      const patch = setAudioPatch(timeline, clipId, {
        ...current,
        ...(edge === 'in' ? { fadeInSeconds: seconds } : { fadeOutSeconds: seconds }),
      });
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );
  /** Add a transition at a cut from the earlier (outgoing) clip — shared by the
   *  double-click affordance and a drop from the transitions browser. */
  const addTransitionAt = useCallback(
    (fromClipId: string, kind: TransitionKind, durationSeconds?: number): void => {
      const patch = addTransitionPatch(timeline, fromClipId, kind, durationSeconds);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );
  /** Apply one kind to every eligible cut in the project, as ONE undo step. */
  const addTransitionEverywhere = useCallback(
    (kind: TransitionKind, durationSeconds?: number): void => {
      const patch = addTransitionToAllCutsPatch(timeline, kind, durationSeconds);
      if (patch) applyPatch(patch);
    },
    [timeline, applyPatch],
  );

  // On-cut transitions grouped by lane, recomputed only when the timeline changes
  // (not on the 60fps playhead tick) so the memoised lanes stay stable. Each
  // placement carries its clamp limit for the resize gesture.
  const transitionsByTrack = useMemo(() => {
    const map = new Map<string, ReturnType<typeof timelineTransitions>[number][]>();
    for (const placement of timelineTransitions(timeline)) {
      const list = map.get(placement.trackId);
      if (list) list.push(placement);
      else map.set(placement.trackId, [placement]);
    }
    return map;
  }, [timeline]);

  /**
   * The junctions that can carry a transition, with their eligibility already decided —
   * rebuilt only when the TIMELINE changes.
   *
   * WHY this is not computed inline in the lane render (where it used to be): deciding
   * one junction's eligibility derives the whole timeline's cut structure, so asking it
   * per junction is O(cuts × clips). A caption track from `add_caption_layer` is one
   * butt-joined clip per cue — 150+ on a few minutes of speech — and the lane subtree
   * rebuilds on every horizontal scroll, zoom, selection change and drag frame. That is
   * the timeline lag on a caption-heavy project: hundreds of full-timeline walks per
   * interaction, all to draw affordances on cuts that, on a caption lane, can never take
   * a transition anyway.
   *
   * Two bounds, in order of how much they save:
   *  1. Only lanes whose clips a transition can actually join are considered at all
   *     (`TRANSITIONABLE_TRACK_TYPES`) — a caption/overlay/effect lane costs nothing.
   *  2. The remaining lanes share ONE `TransitionBoundaryIndex` instead of each junction
   *     building its own.
   */
  const junctionsByTrack = useMemo(() => {
    const eligible = visibleTracks.filter(
      (track) => !track.locked && TRANSITIONABLE_TRACK_TYPES.has(track.type),
    );
    const map = new Map<string, readonly JunctionAffordance[]>();
    if (eligible.length === 0) return map;
    const index = buildTransitionBoundaryIndex(timeline);
    for (const track of eligible) {
      const affordances = trackJunctions(track)
        .filter((j) => j.touching)
        .map((j) => ({
          junction: j,
          eligibility: transitionEligibilityIn(index, {
            fromClipId: j.fromClipId,
            toClipId: j.toClipId,
            durationSeconds: DEFAULT_TRANSITION_SECONDS,
          }),
        }));
      if (affordances.length > 0) map.set(track.id, affordances);
    }
    return map;
  }, [timeline, visibleTracks]);

  // Adaptive ruler ticks depend only on span/zoom/fps — never the playhead — so
  // memoise them out of the per-seek render path (perf slice 3, plan Phase 12.1).
  const ticks = useMemo(
    () => rulerTicks(laneSeconds, pxPerSecond, fps),
    [laneSeconds, pxPerSecond, fps],
  );
  // Memoise the tick ELEMENTS (not just the tick data) and pass them as children
  // of the subscribing <RulerBar>, so a seek that updates the ruler's aria-valuenow
  // never re-creates the (potentially many) tick nodes. Perf slice 1b.
  const tickElements = useMemo(() => {
    // Ruler ticks are windowed like the lanes: a film-length timeline zoomed in
    // otherwise mounts tens of thousands of tick nodes across the full lane
    // width, most of them offscreen.
    const win =
      windowStartPx === null || windowEndPx === null
        ? null
        : { startPx: windowStartPx, endPx: windowEndPx };
    const visible = (t: number): boolean => spanInRenderWindow(t, t, win, pxPerSecond);
    return (
      <>
        {ticks.minor.filter(visible).map((t) => (
          <span
            key={`m${t}`}
            className="ruler-tick is-minor"
            style={{ left: `${secondsToPx(t, pxPerSecond)}px` }}
          />
        ))}
        {ticks.major.filter(visible).map((t) => (
          <span
            key={t}
            className="ruler-tick is-major tabular"
            style={{ left: `${secondsToPx(t, pxPerSecond)}px` }}
          >
            {/* Compact, scale-aware — see `compactTimeLabel`. The ruler targets
                ~72px between labels; the full `HH:MM:SS:FF` readout is wider than
                that, so it used to collide with its neighbour and have its first
                character clipped by the lane origin. */}
            {compactTimeLabel(t, fps, ticks.stepSeconds, laneSeconds, timeDisplay)}
          </span>
        ))}
      </>
    );
  }, [ticks, pxPerSecond, fps, timeDisplay, laneSeconds, windowStartPx, windowEndPx]);

  /**
   * Short lane names (`V1`, `A2`) for the track headers, and the pixel pitch of the
   * lanes' vertical time grid.
   *
   * The grid is deliberately NOT a set of elements. One rule per labelled tick,
   * across every lane, is thousands of nodes on a zoomed-in sequence and they all
   * live under the clips, which is the subtree horizontal culling exists to keep
   * cheap. A repeating background gradient sized by this one custom property costs
   * a single paint and stays exact, because it is driven by the same
   * `stepSeconds × pxPerSecond` the ruler's own labels are.
   */
  // The pitch is taken from the ticks the ruler ACTUALLY drew, not from the
  // interval it asked for.
  //
  // `rulerTicks` quantises every major tick to a whole frame, so at a fractional
  // frame rate the two differ: at 29.97fps a requested 1s step becomes 30 frames,
  // which is 1.001s. A 0.1% error is invisible for one tick and cumulative for a
  // gradient — by ten minutes the grid would sit half a pitch off the ruler it is
  // documented to be locked to. Measuring the real spacing between the first two
  // majors keeps them identical by construction at any frame rate.
  //
  // Clamped: a repeating gradient whose period is 0 (or NaN) is an invalid value
  // the whole background declaration is dropped for, so the lanes would silently
  // lose their grid rather than fail loudly. 8px is below any pitch the tick
  // selector can actually choose, so the clamp never alters a real zoom.
  const majorStepSeconds =
    ticks.major.length >= 2
      ? (ticks.major[1] as number) - (ticks.major[0] as number)
      : ticks.stepSeconds;
  const gridPitchPx = Math.max(8, majorStepSeconds * pxPerSecond || 0);
  /**
   * Whether the overview strip has anything to navigate.
   *
   * `clientWidth` is 0 until the lane viewport has been measured (first paint,
   * jsdom), and a 0-width viewport would report every sequence as overflowing —
   * so an unmeasured viewport shows no strip rather than a wrong one.
   */
  const overviewNeeded = viewport.clientWidth > 0 && laneWidth > viewport.clientWidth + 1;
  const trackNames = useMemo(
    () =>
      laneNames(visibleTracks, (track) =>
        // Same resolution `layerMeta` uses for the glyph, so the name and the icon
        // can never disagree: the kind of clip the lane actually holds, falling
        // back to what its advisory type implies while it is still empty. Without
        // the fallback a new, empty caption lane was named `L1` — the generic
        // last-resort prefix — while its glyph already said "captions".
        track.type === 'effect'
          ? undefined
          : (layerKind(track, assetById) ?? ADVISORY_KIND[track.type]),
      ),
    [visibleTracks, assetById],
  );

  /**
   * Which clips are butt-joined to a neighbour, per lane.
   *
   * A cut is not a gap, and it should not look like one. Two adjacent clips each
   * drew their own full rounded outline, so a hard cut — the most common thing on
   * a timeline — rendered as two separate boxes with a dark notch between them,
   * visually identical to a real gap of a few frames. Squaring the joined corners
   * and dropping the doubled edge makes a run of cuts read as one strip divided by
   * hairlines, and leaves an actual gap looking like one.
   *
   * `trackJunctions` is memoised per immutable Track, so this is a walk over
   * already-computed junctions rather than a re-derivation.
   */
  const joinsByTrack = useMemo(() => {
    const map = new Map<
      string,
      { readonly left: ReadonlySet<string>; readonly right: ReadonlySet<string> }
    >();
    for (const track of visibleTracks) {
      const left = new Set<string>();
      const right = new Set<string>();
      for (const junction of trackJunctions(track)) {
        if (!junction.touching) continue;
        left.add(junction.toClipId);
        right.add(junction.fromClipId);
      }
      if (left.size > 0 || right.size > 0) map.set(track.id, { left, right });
    }
    return map;
  }, [visibleTracks]);

  // The track lanes are the timeline's heavy subtree (every clip, waveform, badge
  // and keyframe). They do NOT depend on the playhead, so we memoise them: during
  // playback the playhead advances ~60×/s and the parent re-renders, but this cached
  // element tree is reused untouched (all deps are stable while only the playhead
  // moves), so React reconciles nothing here. The deps are exactly the inputs that
  // can actually change the lanes — timeline content, the active drag ghost, razor
  // mode, selection, zoom, and the (stable) gesture handlers — never `playhead`.
  const trackLanes = useMemo(() => {
    // Rebuild the window object from its primitive deps (see the render-window
    // comment above) — `null` mounts everything (unmeasured viewport / jsdom).
    const win =
      windowStartPx === null || windowEndPx === null
        ? null
        : { startPx: windowStartPx, endPx: windowEndPx };
    return virtualRows.map((row) => {
      const track = visibleTracks[row.index];
      if (!track) return null;
      const view = trackViews.get(track.id) ?? {
        heightPx: TRACK_HEIGHT_BOUNDS.default,
        collapsed: false,
        soloed: false,
      };
      // Must match `rowSize` exactly (see its note) or the virtualizer's offsets
      // drift under every track below an expanded one.
      const keyframeLanesPx = trackKeyframeLanesHeight(track, keyframes.expanded);
      const laneHeight = effectiveTrackHeight(view, track.type) + keyframeLanesPx;
      return (
        <li
          className="track"
          key={track.id}
          aria-label={`track ${track.id}`}
          // Absolutely positioned at the virtualizer's offset so only the windowed
          // lanes mount while the spacer below reserves the full scroll height.
          style={{
            position: 'absolute',
            top: `${TRACK_ROW_INSET}px`,
            left: 0,
            transform: `translateY(${row.start}px)`,
            height: `${laneHeight}px`,
            margin: 0,
          }}
        >
          <div
            className={`track-lane ${layerMeta(track, assetById).cls} ${
              ghost?.kind === 'move' && ghost.trackId === track.id ? 'is-drop-target' : ''
            }${track.locked ? ' is-locked' : ''}${track.hidden ? ' is-hidden' : ''}${
              view.collapsed ? ' is-collapsed' : ''
            }`}
            data-track-id={track.id}
            data-track-type={track.type}
            // `--kf-lanes-h` reserves the strip at the bottom of the lane: the clips
            // shrink by it (CSS), so the lanes sit BELOW the clip bodies rather than
            // over them.
            style={{
              width: `${laneWidth}px`,
              height: `${laneHeight}px`,
              ['--kf-lanes-h' as string]: `${keyframeLanesPx}px`,
            }}
            onPointerMove={(event) => {
              if (razor) setRazorTime(xToSeconds(event.clientX));
            }}
            onPointerLeave={() => {
              if (razor) setRazorTime(null);
            }}
            onDragOver={(event) => {
              const types = event.dataTransfer.types;
              if (types.includes(EFFECT_DND_TYPE)) {
                // Effects land only on an effect lane — dropping one on a video
                // lane would silently do nothing, so it must not read as a valid
                // target.
                if (track.type === 'effect') {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }
                return;
              }
              if (types.includes(ASSET_DND_TYPE) || types.includes(TEXT_OVERLAY_DND_TYPE)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(event) => {
              // Use the lane-relative cursor (clientX − lane left), not the
              // event's offsetX — offsetX is relative to whatever child took
              // the drop (often an existing clip), which mis-places the clip.
              // A drop is one isolated question, so it uses the stateless snap —
              // the gesture magnet's hold belongs to the drag that created it.
              const value = snapSeconds(xToSeconds(event.clientX), snapDisabled(event.altKey));
              // An effect dragged from the library lands as a new layer at the
              // drop position on this lane (schema v13).
              if (event.dataTransfer.types.includes(EFFECT_DND_TYPE)) {
                const effectId = event.dataTransfer.getData(EFFECT_DND_TYPE);
                if (effectId && track.type === 'effect') {
                  event.preventDefault();
                  onDropEffect(track, effectId, value);
                }
                return;
              }
              // A "Text" chip dragged from the Overlays panel creates a text
              // overlay at the drop position (#5).
              if (event.dataTransfer.types.includes(TEXT_OVERLAY_DND_TYPE)) {
                event.preventDefault();
                onDropTextOverlay(track, value);
                return;
              }
              const assetId =
                event.dataTransfer.getData(ASSET_DND_TYPE) ||
                event.dataTransfer.getData('text/plain');
              if (!assetId) return;
              event.preventDefault();
              onDropAsset(track, assetId, value);
            }}
          >
            {track.type === 'effect' &&
              (track.effectLayers ?? []).map((layer) => (
                <EffectLayerChip
                  key={layer.id}
                  layer={layer}
                  trackId={track.id}
                  pxPerSecond={pxPerSecond}
                  selected={selectedEffectLayerIds.includes(layer.id)}
                  onSelect={onSelectEffectLayer}
                  onMove={onMoveEffectLayer}
                  onTrim={onTrimEffectLayer}
                  onContextMenu={openEffectMenu}
                  snap={snapSeconds}
                />
              ))}
            {track.clips.map((clip) => {
              const isGhost = ghost?.clipId === clip.id;
              const joins = joinsByTrack.get(track.id);
              // Horizontal windowing: only clips intersecting the render
              // window mount. The gestured (ghost) clip always mounts — it
              // holds pointer capture and may be dragged past the window.
              if (!isGhost && !spanInRenderWindow(clip.start, clip.end, win, pxPerSecond)) {
                return null;
              }
              return (
                <TimelineClip
                  key={clip.id}
                  clip={clip}
                  track={track}
                  isGhost={isGhost}
                  ghostKind={isGhost ? ghost.kind : null}
                  ghostDuplicate={isGhost ? Boolean(ghost.duplicate) : false}
                  ghostRoll={isGhost ? Boolean(ghost.rollWith) : false}
                  start={isGhost ? ghost.start : clip.start}
                  end={isGhost ? ghost.end : clip.end}
                  pxPerSecond={pxPerSecond}
                  fps={fps}
                  timeDisplay={timeDisplay}
                  selected={selectedSet.has(clip.id)}
                  showThumbnails={showTimelineThumbnails}
                  // A dragged clip is lifted out of the run, so it keeps its own
                  // full outline even where it started butt-joined.
                  joinLeft={!isGhost && joins?.left.has(clip.id) === true}
                  joinRight={!isGhost && joins?.right.has(clip.id) === true}
                  assetById={assetById}
                  beginGesture={beginGesture}
                  onPointerMove={onClipPointerMove}
                  onPointerUp={onClipPointerUp}
                  onSelectClip={onClipClick}
                  openClipMenu={openClipMenu}
                  onFadeCommit={onFadeCommit}
                  tabbable={tabbableClipId === clip.id}
                  pulseKind={pulse?.clipIds.has(clip.id) ? pulse.kind : null}
                  pulseAgent={pulse?.author === 'agent'}
                  pulseToken={pulse?.token ?? 0}
                  lanesOpen={keyframes.expanded.has(clip.id)}
                  onToggleLanes={keyframes.toggleExpanded}
                />
              );
            })}
            {/*
             * Keyframe lanes (revamp Phase 6, F4). Siblings of the clips, not
             * children: they sit in the strip `--kf-lanes-h` reserves at the bottom
             * of the track, and being outside the clip element means a lane gesture
             * cannot reach the clip-drag handler at all — belt as well as the braces
             * of each lane's own stopPropagation.
             */}
            {track.clips
              .filter((clip) => keyframes.expanded.has(clip.id) && isAnimated(clip))
              .map((clip) => (
                <ClipKeyframeLanes
                  key={`kf-lanes-${clip.id}`}
                  editor={editor}
                  clip={clip}
                  pxPerSecond={pxPerSecond}
                  fps={fps}
                  markers={markers}
                  selectedKeys={keyframes.keys}
                  snapEnabled={settings.snapping}
                  onSelect={keyframes.select}
                  onMove={onKeyframeMove}
                  onAddAt={onKeyframeAdd}
                  onDelete={onKeyframeDelete}
                  onClearSelection={keyframes.clear}
                />
              ))}
            {/*
             * On-cut transition layer (M3b). Pills straddle existing cuts and own
             * their resize gesture; empty butt-joined cuts on an unlocked lane get
             * a thin affordance that adds a default cross-dissolve on double-click
             * or on a drop from the transitions browser. Both routes commit one
             * validated patch — no second mutation path.
             */}
            {/* Laid out as a SET, not one at a time: at low zoom a minimum hit
                target makes adjacent blocks overlap even though the transitions do
                not overlap in time, and a click would land on whichever happened to
                be later in the DOM. See `transition-blocks.ts`. */}
            {layoutTransitionBlocks(transitionsByTrack.get(track.id) ?? [], pxPerSecond)
              .filter((box) =>
                spanInRenderWindow(box.placement.cutTime, box.placement.cutTime, win, pxPerSecond),
              )
              .map((box) => (
                <TransitionBlock
                  multiSelected={selectedCuts.includes(box.placement.toClipId)}
                  key={box.placement.effectId}
                  box={box}
                  pxPerSecond={pxPerSecond}
                  selected={selectedSet.has(box.placement.toClipId)}
                  onSelect={onSelectTransition}
                  onResize={onResizeTransition}
                  onContextMenu={(_, x, y) => openTransitionMenu(box.placement, x, y)}
                />
              ))}
            {/*
             * The insertion target at every abutting cut. Revamp Phase 8 surfaces
             * the REASON an ineligible cut is refused rather than just omitting the
             * affordance: the eligibility check already computes a human sentence
             * for each rejection, and a control that silently is not there teaches
             * the user nothing about why. The decision itself is made ONCE per
             * timeline in `junctionsByTrack` (see its note) — deriving it here, per
             * junction, per re-render, was the caption-heavy timeline's lag.
             */}
            {(junctionsByTrack.get(track.id) ?? [])
              .filter(
                ({ junction: j }) =>
                  spanInRenderWindow(j.cutTime, j.cutTime, win, pxPerSecond) &&
                  !(transitionsByTrack.get(track.id) ?? []).some((p) => p.toClipId === j.toClipId),
              )
              .map(({ junction: j, eligibility }) => {
                return (
                  <span
                    key={`junction-${j.toClipId}`}
                    className="clip-transition-add"
                    role="button"
                    tabIndex={0}
                    data-ineligible={eligibility.ok ? undefined : 'true'}
                    aria-disabled={eligibility.ok ? undefined : true}
                    aria-label={
                      eligibility.ok
                        ? `Add transition at cut before ${j.toClipId}`
                        : `Cannot add a transition here: ${eligibility.detail}`
                    }
                    title={eligibility.ok ? 'Add a transition' : eligibility.detail}
                    style={{ left: `${secondsToPx(j.cutTime, pxPerSecond)}px` }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      // Open the picker so the user chooses which transition to
                      // add, instead of silently inserting a default (#8).
                      event.stopPropagation();
                      if (!eligibility.ok) return;
                      openTransitionPicker(j.fromClipId, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (!eligibility.ok) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      openTransitionPicker(j.fromClipId, rect.left, rect.bottom);
                    }}
                    onDragOver={(event) => {
                      if (!eligibility.ok) return;
                      if (!event.dataTransfer.types.includes(TRANSITION_DND_TYPE)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                    }}
                    onDrop={(event) => {
                      if (!eligibility.ok) return;
                      const kind = event.dataTransfer.getData(TRANSITION_DND_TYPE);
                      if (!kind) return;
                      event.preventDefault();
                      event.stopPropagation();
                      // The entry's OWN default length, not one global number:
                      // a whip pan wants 0.28s and a soft dissolve wants 1.2s,
                      // and the catalog is where that judgement lives.
                      addTransitionAt(j.fromClipId, kind, getTransition(kind)?.defaultDuration);
                    }}
                  />
                );
              })}
          </div>
        </li>
      );
    });
  }, [
    virtualRows,
    visibleTracks,
    trackViews,
    windowStartPx,
    windowEndPx,
    ghost,
    razor,
    selectedSet,
    pxPerSecond,
    laneWidth,
    assetById,
    fps,
    timeDisplay,
    showTimelineThumbnails,
    beginGesture,
    onClipPointerMove,
    onClipPointerUp,
    onClipClick,
    onDropAsset,
    snapValue,
    snapDisabled,
    xToSeconds,
    onDropTextOverlay,
    select,
    openClipMenu,
    transitionsByTrack,
    junctionsByTrack,
    onSelectTransition,
    onResizeTransition,
    addTransitionAt,
    openTransitionPicker,
    onFadeCommit,
    pulse,
    // Effect layers (schema v13). Without these the memoised lane subtree renders
    // stale chips: selecting one updated the state but never repainted, because
    // this cache had no reason to recompute.
    selectedEffectLayerIds,
    onSelectEffectLayer,
    onMoveEffectLayer,
    onTrimEffectLayer,
    openEffectMenu,
    snapSeconds,
    // Keyframe lanes (Phase 6). Without these the memoised subtree keeps a stale
    // lane: expanding a clip would change the row height and draw nothing in it.
    keyframes,
    markers,
    onKeyframeMove,
    onKeyframeAdd,
    onKeyframeDelete,
    editor,
    settings.snapping,
  ]);

  return (
    <section className={`timeline${pulse ? ' is-edit-pulse' : ''}`} aria-label="timeline">
      {/*
       * The visible scrub affordance is the ruler (click/drag) and the
       * authoritative time readout is the transport's `current / total`. This
       * range input + its `<output>` are kept as the deterministic seek and
       * screen-reader hooks (the keyboard, the test suite, and AT depend on
       * them), but pulled out of the visible chrome via `sr-only` so there is
       * no duplicate "Playhead" widget / second timecode that can disagree.
       */}
      <PlayheadScrubber
        editor={editor}
        laneSeconds={laneSeconds}
        fps={fps}
        timeDisplay={timeDisplay}
      />

      {/* Vertical scroll viewport — the element the lane virtualizer measures.
          Both grid columns scroll together so windowed header rows and lanes stay
          aligned; the ruler/header-tools row is sticky so it stays visible. */}
      <div className="timeline-vscroll" ref={vScrollRef}>
        <div className="timeline-grid">
          {/* Header column — one row per track, aligned with the lanes. Track
            scope belongs with the tracks, so Add track lives here — the only
            control in this corner cell (blade/zoom-to-fit moved to the toolbar,
            TIMELINE-TOOLBAR-REORG). */}
          <ol className="track-heads">
            <li className="ruler-spacer">
              <div className="timeline-tools" role="group" aria-label="timeline view">
                <Menu
                  label="Add track"
                  className="add-track-menu"
                  trigger={
                    <>
                      <Plus size={ICON_SIZE.sm} aria-hidden="true" />
                      Add track
                    </>
                  }
                >
                  {(close) => (
                    <>
                      {ADD_TRACK_KINDS.map((kind) => (
                        <MenuItem
                          key={kind.type}
                          icon={<kind.icon size={ICON_SIZE.sm} />}
                          onSelect={() => {
                            addLayer(kind.type);
                            close();
                          }}
                        >
                          {kind.label}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </Menu>
              </div>
            </li>
            {visibleTracks.length === 0 && <li className="track-head-empty" />}
            {/* Windowed header rows, absolutely positioned at the same virtualizer
              offsets as the lanes so the two grid columns stay row-aligned. The
              container reserves the full stack height. */}
            <div
              className="track-heads-window"
              style={{ position: 'relative', height: `${totalLaneHeight}px` }}
            >
              {virtualRows.map((row) => {
                const track = visibleTracks[row.index];
                if (!track) return null;
                const meta = layerMeta(track, assetById);
                const view = trackViews.get(track.id) ?? {
                  heightPx: TRACK_HEIGHT_BOUNDS.default,
                  collapsed: false,
                  soloed: false,
                };
                // Same height as the lane body — INCLUDING any expanded keyframe
                // lanes — so the header strip spans exactly its lane's band. Only
                // counting the clip height left the header divider stopping short
                // under an expanded track, which read as a broken row boundary.
                // The keyframe strip is added as bottom padding instead of extra
                // content space so the glyph/controls stay centred on the clip
                // body, where they belong, rather than drifting down the row.
                const headKeyframeLanesPx = trackKeyframeLanesHeight(track, keyframes.expanded);
                const headHeight = effectiveTrackHeight(view, track.type) + headKeyframeLanesPx;
                const soloMuted = soloMutedIds.has(track.id);
                return (
                  <li
                    key={track.id}
                    draggable
                    // NOT `data-track-id`: that attribute is how the lane column
                    // identifies a drop target — `elementFromPoint(...).closest(
                    // '[data-track-id]')` is the cross-lane move hit test — and the
                    // header column comes first in the DOM, so sharing the name
                    // would let a header answer for its lane and make a clip
                    // "move" onto a lane by hovering its title.
                    data-track-head={track.id}
                    className={`track-head ${meta.cls}${track.locked ? ' is-locked' : ''}${
                      track.hidden ? ' is-hidden' : ''
                    }${track.muted || soloMuted ? ' is-muted' : ''}${
                      view.collapsed ? ' is-collapsed' : ''
                    }${view.soloed ? ' is-soloed' : ''}${
                      dragTrackId === track.id ? ' is-dragging' : ''
                    }${
                      dropTarget?.overId === track.id
                        ? dropTarget.after
                          ? ' is-drop-after'
                          : ' is-drop-before'
                        : ''
                    }`}
                    style={{
                      position: 'absolute',
                      top: `${TRACK_ROW_INSET}px`,
                      left: 0,
                      right: 0,
                      transform: `translateY(${row.start}px)`,
                      height: `${headHeight}px`,
                      paddingBottom: `${headKeyframeLanesPx}px`,
                      margin: 0,
                    }}
                    // Track-scope actions live on the header, which is the only
                    // part of the row that IS the track rather than its contents
                    // (right-clicking the lane opens the clip menu instead).
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setTrackMenu({ trackId: track.id, x: event.clientX, y: event.clientY });
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(TRACK_DND_TYPE, track.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragTrackId(track.id);
                    }}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(TRACK_DND_TYPE)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY > rect.top + rect.height / 2;
                      setDropTarget({ overId: track.id, after });
                    }}
                    onDrop={(event) => {
                      const draggedId = event.dataTransfer.getData(TRACK_DND_TYPE);
                      if (!draggedId) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY > rect.top + rect.height / 2;
                      reorderTrackTo(draggedId, track.id, after);
                      clearTrackDrag();
                    }}
                    onDragEnd={clearTrackDrag}
                  >
                    <button
                      type="button"
                      className="track-collapse"
                      // Named by the LANE, not the raw track id: "Collapse track
                      // t_video_1" announces a database key. The lane name is what
                      // the header shows and what the user calls it.
                      aria-label={
                        view.collapsed
                          ? `Expand lane ${trackNames.get(track.id) ?? track.id}`
                          : `Collapse lane ${trackNames.get(track.id) ?? track.id}`
                      }
                      aria-expanded={!view.collapsed}
                      title={view.collapsed ? 'Expand lane' : 'Collapse lane'}
                      onClick={() => trackLayout.toggleCollapsed(track.id)}
                    >
                      {view.collapsed ? (
                        <ChevronRight size={12} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={12} aria-hidden="true" />
                      )}
                    </button>
                    {/* Type glyph — coloured icon showing the dominant clip kind */}
                    <span className="track-glyph" aria-hidden="true">
                      <meta.icon size={14} />
                    </span>
                    {/*
                      The lane's name (`V1`, `A2`). Not decoration: it is what the
                      user, the shortcuts and the AI all call this lane, and it is
                      the only thing left in the header once the flag controls
                      recede at rest. `aria-hidden` because the row already carries
                      the full accessible name; a screen reader reading "V1" after
                      "track V1" is noise.
                    */}
                    <span className="track-name tabular" aria-hidden="true">
                      {trackNames.get(track.id) ?? ''}
                    </span>
                    <span className="track-controls">
                      {LAYER_CONTROLS.map((control) => {
                        const active = Boolean(track[control.flag]);
                        const ControlIcon = active ? control.onIcon : control.offIcon;
                        const label = active ? control.onLabel : control.offLabel;
                        // Surface the derived solo-mute on the mute control without
                        // touching the schema flag: a solo elsewhere shows this lane as
                        // (preview) muted even when its real `muted` flag is off.
                        const showMuted = control.flag === 'muted' ? active || soloMuted : active;
                        const MutedAwareIcon =
                          control.flag === 'muted' && showMuted ? control.onIcon : ControlIcon;
                        const isSoloMuted = control.flag === 'muted' && soloMuted && !active;
                        return (
                          <Tooltip
                            key={control.flag}
                            label={
                              <TooltipInfo term={isSoloMuted ? 'Muted by solo' : label}>
                                {isSoloMuted
                                  ? SOLO_MUTED_INFO
                                  : CONTROL_INFO[control.flag][active ? 'on' : 'off']}
                              </TooltipInfo>
                            }
                          >
                            <button
                              type="button"
                              className={`track-control${showMuted ? ' is-active' : ''}${
                                isSoloMuted ? ' is-solo-muted' : ''
                              }`}
                              aria-label={label}
                              aria-pressed={active}
                              onClick={() => toggleFlag(track, control.flag)}
                            >
                              <MutedAwareIcon size={14} aria-hidden="true" />
                            </button>
                          </Tooltip>
                        );
                      })}
                      {/* Solo (audio) — derived PREVIEW monitoring state, not a patch
                      (invariant 5). Toggling it solo-mutes the other audio lanes. */}
                      <Tooltip
                        label={
                          <TooltipInfo term={view.soloed ? 'Unsolo track' : 'Solo track (preview)'}>
                            {view.soloed
                              ? 'Turns off solo so every track plays back normally again.'
                              : "Plays only this track's audio in preview, muting every other track temporarily — a quick way to check how just this one sounds. It doesn't change your actual mix or export."}
                          </TooltipInfo>
                        }
                      >
                        <button
                          type="button"
                          className={`track-control track-solo${view.soloed ? ' is-active' : ''}`}
                          aria-label={view.soloed ? 'Unsolo track' : 'Solo track'}
                          aria-pressed={view.soloed}
                          onClick={() => trackLayout.toggleSolo(track.id)}
                        >
                          <Headphones size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </span>
                  </li>
                );
              })}
            </div>
          </ol>

          {/* Lane area — scrolls horizontally; playhead/markers share its origin.
            A manual scroll briefly suspends auto-follow (see the rAF loop). */}
          <div
            className="lane-scroll"
            ref={scrollRef}
            onScroll={onLaneScroll}
            onPointerDown={onLanesPointerDown}
            onPointerMove={onLanesPointerMove}
            onPointerUp={onLanesPointerUp}
          >
            <div
              className={`timeline-lanes ${razor ? 'is-razor' : ''}`}
              ref={lanesRef}
              style={{
                position: 'relative',
                width: `${laneWidth}px`,
                // Pitch of the lanes' vertical time grid — see `gridPitchPx`.
                ['--tl-grid-pitch' as string]: `${gridPitchPx}px`,
              }}
            >
              <RulerBar
                editor={editor}
                laneSeconds={laneSeconds}
                fps={fps}
                onPointerDown={onRulerPointerDown}
                onPointerMove={onRulerPointerMove}
                onPointerUp={onRulerPointerUp}
              >
                {tickElements}
              </RulerBar>
              {/* Playhead: a grabbable head (with a live time bubble) atop a crisp
                full-height line. The head shares the ruler's seek handlers, so it
                can be dragged to scrub just like the ruler. */}
              <PlayheadMarker
                editor={editor}
                pxPerSecond={pxPerSecond}
                fps={fps}
                timeDisplay={timeDisplay}
                onPointerDown={onRulerPointerDown}
                onPointerMove={onRulerPointerMove}
                onPointerUp={onRulerPointerUp}
              />
              {ghost?.snapTime != null && (
                <div
                  className="snap-guide"
                  aria-hidden="true"
                  style={{ left: `${secondsToPx(ghost.snapTime, pxPerSecond)}px` }}
                />
              )}
              {razor && razorTime != null && (
                <div
                  className="razor-guide"
                  aria-hidden="true"
                  style={{ left: `${secondsToPx(razorTime, pxPerSecond)}px` }}
                />
              )}
              {/* Real, persisted `project.markers` (schema v9) — added/removed via
                  "M" through `toggleMarkerPatch`, so this is undoable. A labeled
                  marker ("chapter") shows its title as a tooltip; a dedicated
                  click-to-rename affordance is deferred (plan/PLAN.md H1.2 note) —
                  today's acceptance bar is persistence + display, not a chapter
                  editor. */}
              {markers.map((marker) => (
                <div
                  key={marker.id}
                  className="marker-tick"
                  aria-label={
                    marker.label
                      ? `marker "${marker.label}" at ${marker.time}s`
                      : `marker at ${marker.time}s`
                  }
                  {...(marker.label ? { title: marker.label } : {})}
                  style={{
                    left: `${secondsToPx(marker.time, pxPerSecond)}px`,
                    ...(marker.color ? { background: marker.color } : {}),
                  }}
                />
              ))}
              <ol
                className="tracks"
                ref={tracksRef}
                // Reserve the full windowed stack height so only the visible lanes
                // mount while the scroll range stays correct (vertical virtualization).
                // Marquee pointer handlers live on the `.lane-scroll` ancestor so the
                // empty regions beyond this <ol> can start a band-select too.
                style={{ height: `${totalLaneHeight}px` }}
              >
                {visibleTracks.length === 0 && (
                  <li
                    className="timeline-empty-state"
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                      }
                    }}
                    onDrop={(e) => {
                      const assetId =
                        e.dataTransfer.getData(ASSET_DND_TYPE) ||
                        e.dataTransfer.getData('text/plain');
                      if (!assetId) return;
                      e.preventDefault();
                      const asset = assets.find((a) => a.id === assetId);
                      if (!asset) return;
                      const patch = placeAssetPatch(timeline, assetById, asset, 0);
                      if (patch) applyPatch(patch);
                    }}
                  >
                    {/* Names the thing and the two real ways to make one. The old
                        label was a tracked, upper-cased "DROP MEDIA HERE TO START",
                        which shouts an instruction without saying where media comes
                        from or that the gutter's Add track does the same job. */}
                    <span className="timeline-empty-label">
                      Drag a clip from Assets to start, or use Add track
                    </span>
                  </li>
                )}
                {trackLanes}
                {marquee && (
                  <div
                    className="marquee"
                    aria-hidden="true"
                    style={{
                      left: `${marquee.x}px`,
                      top: `${marquee.y}px`,
                      width: `${marquee.width}px`,
                      height: `${marquee.height}px`,
                    }}
                  />
                )}
              </ol>
            </div>
          </div>
        </div>
      </div>

      {/*
        The space below the stack.

        The lane stack hugs the top of the dock, so whatever the user has left the
        divider at shows up as one open area underneath. It used to be exactly that
        — an empty area — and a large panel of nothing between the last lane and the
        overview strip reads as a broken layout rather than as room.

        It is the obvious place to drop something, so it accepts a drop, through the
        same `placeAssetPatch` the empty timeline uses: the clip lands at the time
        under the cursor, on the frontmost lane of its kind that has room there, or
        on a new lane when none does. Purely additive — clicking it does nothing, it
        takes no focus, and it disappears when the lanes fill the dock.
      */}
      <div
        className={`timeline-underspace${assetOverUnderspace ? ' is-drop-target' : ''}`}
        aria-hidden="true"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(ASSET_DND_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setAssetOverUnderspace(true);
        }}
        onDragLeave={() => setAssetOverUnderspace(false)}
        onDrop={(event) => {
          setAssetOverUnderspace(false);
          const assetId =
            event.dataTransfer.getData(ASSET_DND_TYPE) || event.dataTransfer.getData('text/plain');
          if (!assetId) return;
          event.preventDefault();
          const asset = assets.find((a) => a.id === assetId);
          if (!asset) return;
          const patch = placeAssetPatch(timeline, assetById, asset, xToSeconds(event.clientX));
          if (patch) applyPatch(patch);
        }}
      >
        {visibleTracks.length > 0 && (
          <span className="timeline-underspace-hint">Drop media here to place it</span>
        )}
      </div>

      {/* Minimap / overview strip — compressed full-sequence navigation, LAST so it
          sits at the foot of the dock with the open area above pushing it there.
          Pure chrome: dragging it only pans the lane viewport (see TimelineMinimap).

          Mounted ONLY when the sequence is wider than its viewport, which is the
          contract TimelineMinimap has always documented and this parent never
          honoured. With everything already on screen the viewport window covers
          the whole strip, so the map rendered as a solid accent slab that hid the
          very clip blocks it exists to show — an overview of "you can see all of
          it" that also cost the lanes 22px of height. */}
      {overviewNeeded && (
        <TimelineMinimap
          timeline={timeline}
          trackOrder={visibleTrackIds}
          pxPerSecond={pxPerSecond}
          contentWidth={laneWidth}
          scrollLeft={viewport.scrollLeft}
          clientWidth={viewport.clientWidth}
          onScrollTo={scrollLaneTo}
        />
      )}

      {menu && (
        <ClipContextMenu
          editor={editor}
          target={menu}
          onClose={() => setMenu(null)}
          {...(onAskAiForClip ? { onAskAi: onAskAiForClip } : {})}
          onAddTransition={(fromClipId, x, y) => setTransitionPicker({ fromClipId, x, y })}
          {...(onRevealAssetInBin ? { onRevealInBin: onRevealAssetInBin } : {})}
        />
      )}
      {trackMenu && (
        <TrackContextMenu editor={editor} target={trackMenu} onClose={() => setTrackMenu(null)} />
      )}
      {transitionPicker && (
        <TransitionPicker
          target={transitionPicker}
          onPick={addTransitionAt}
          onPickAll={addTransitionEverywhere}
          {...(onOpenTransitionLibrary ? { onOpenLibrary: onOpenTransitionLibrary } : {})}
          onClose={() => setTransitionPicker(null)}
        />
      )}
      {effectMenu && (
        <EffectLayerMenu
          x={effectMenu.x}
          y={effectMenu.y}
          disabled={findEffectLayer(timeline, effectMenu.layerId)?.layer.disabled === true}
          onAction={runEffectMenuAction}
          onClose={() => setEffectMenu(null)}
        />
      )}
      {transitionMenu && (
        <TransitionMenu
          x={transitionMenu.x}
          y={transitionMenu.y}
          kind={transitionMenu.placement.kind}
          durationSeconds={transitionMenu.placement.durationSeconds}
          maxDurationSeconds={transitionMenu.placement.maxDurationSeconds}
          alignment={transitionAlignmentOf(timeline, transitionMenu.placement.toClipId)}
          canPaste={transitionClipboard.current !== null}
          similarCount={similarCuts(timeline, transitionMenu.placement).length}
          selectedCount={
            // Excludes the cut being right-clicked: "apply to 1 selected cut"
            // when that one cut is this one is an action with nothing to do.
            selectedCuts.filter((id) => id !== transitionMenu.placement.toClipId).length
          }
          onPreview={() => {
            // Land a beat before the cut so the transition plays INTO view rather
            // than starting mid-ramp — "preview" means "watch it happen".
            const lead = Math.max(0.4, transitionMenu.placement.durationSeconds);
            editor.seek(Math.max(0, transitionMenu.placement.cutTime - lead));
            setTransitionMenu(null);
          }}
          onSetAlignment={(alignment) => {
            const patch = setTransitionAlignmentPatch(
              timeline,
              transitionMenu.placement.toClipId,
              alignment,
            );
            if (patch) applyPatch(patch);
          }}
          onCopy={() => {
            transitionClipboard.current = transitionMenu.placement.toClipId;
          }}
          onPaste={() => {
            const source = transitionClipboard.current;
            if (source === null || source === transitionMenu.placement.toClipId) return;
            const patch = applyTransitionToClipsPatch(timeline, source, [
              transitionMenu.placement.toClipId,
            ]);
            if (patch) applyPatch(patch);
          }}
          onReset={() => {
            const patch = resetTransitionParamsPatch(timeline, transitionMenu.placement.toClipId);
            if (patch) applyPatch(patch);
          }}
          onApplyToSelected={() => {
            const patch = applyTransitionToClipsPatch(
              timeline,
              transitionMenu.placement.toClipId,
              selectedCuts.filter((id) => id !== transitionMenu.placement.toClipId),
            );
            if (patch) applyPatch(patch);
          }}
          onApplyToSimilar={() => {
            const targets = similarCuts(timeline, transitionMenu.placement);
            const { patch } = applyTransitionToCutsPatch(
              timeline,
              targets,
              transitionMenu.placement.kind,
              transitionMenu.placement.durationSeconds,
            );
            if (patch) applyPatch(patch);
          }}
          onApplyToAll={() => {
            const patch = addTransitionToAllCutsPatch(
              timeline,
              transitionMenu.placement.kind,
              transitionMenu.placement.durationSeconds,
            );
            if (patch) applyPatch(patch);
          }}
          onReplace={() => {
            // Replace routes through the SAME picker the `+` affordance opens, so
            // one place knows what kinds exist. The picker is addressed by the
            // OUTGOING clip; the block knows the incoming one, so it is resolved
            // from the placement.
            const { fromClipId } = transitionMenu.placement;
            const { x, y } = transitionMenu;
            setTransitionMenu(null);
            openTransitionPicker(fromClipId, x, y);
          }}
          onSetDuration={(seconds) => {
            const patch = setTransitionDurationPatch(
              timeline,
              transitionMenu.placement.toClipId,
              seconds,
            );
            setTransitionMenu(null);
            if (patch) applyPatch(patch);
          }}
          onRemove={() => {
            const patch = removeTransitionPatch(timeline, transitionMenu.placement.toClipId);
            setTransitionMenu(null);
            if (patch) applyPatch(patch);
          }}
          onClose={() => setTransitionMenu(null)}
        />
      )}
    </section>
  );
}

/**
 * The alignment stored on the transition entering `toClipId`.
 *
 * Read from the effect rather than threaded through `TransitionPlacement`,
 * because the placement is recomputed for every lane on every timeline change and
 * a field only the context menu reads does not belong in that hot structure.
 */
function transitionAlignmentOf(timeline: Timeline, toClipId: string): TransitionAlignment {
  const found = findClip(timeline, toClipId);
  const effect = found?.clip.effects.find((e) => e.type === 'transition');
  return effect ? readAlignment(effect.params ?? {}) : 'start';
}

/**
 * The cuts "apply to similar" would touch: every OTHER cut on the same lane that
 * carries no transition yet.
 *
 * "Similar" is deliberately about the lane and not about the shots. Judging shot
 * similarity would need analysis this action does not have and would make the
 * result unpredictable; "the rest of the cuts in this sequence, the ones you have
 * not already treated" is a rule the user can hold in their head, and it is what
 * they mean when they treat one cut and reach for the menu.
 */
function similarCuts(timeline: Timeline, placement: TransitionPlacement): readonly string[] {
  const track = timeline.tracks.find((t) => t.id === placement.trackId);
  if (track === undefined) return [];
  const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
  const targets: string[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const clip = ordered[i]!;
    if (clip.id === placement.toClipId) continue;
    if (clip.effects.some((e) => e.type === 'transition')) continue;
    // Butt-joined only: a gap is not a cut. One frame at 60fps is the slack.
    if (Math.abs(clip.start - ordered[i - 1]!.end) > 1 / 60) continue;
    targets.push(clip.id);
  }
  return targets;
}
