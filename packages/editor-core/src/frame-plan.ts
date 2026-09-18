/**
 * What one exported frame is made of, derived from the timeline alone (PX1.2).
 *
 * The TypeScript twin of `engine/python/framepilot_engine/render/frame_plan.py`, which the
 * render compiler consumes. The export is the truth, so this module describes what
 * `compile_timeline` composites — including its quirks — rather than what a preview would
 * find convenient: layers back to front in TRACK order (text and captions included, not
 * painted on top), hidden tracks dropped, transition under-layers borrowed from the
 * neighbour's handle, the exact source time MoviePy reads for constant speed, freezes,
 * reverse and speed ramps, and the placement arithmetic of `_place_video_clip`.
 *
 * `tests/fixtures/frame-plan/*.json` holds plans the engine wrote; `frame-plan.test.ts`
 * requires this function to reproduce them field by field
 * (`plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`, PX1.3). Change both sides
 * together and regenerate with `pnpm frame-plan:vectors`.
 *
 * Pure: no DOM, no decoding, no mutation. Raster sizes of text/captions (font metrics) and
 * integer rounding of resized frames are pixel concerns for the PX4 oracle, not the plan.
 */
import {
  EDGE_STYLE_EFFECT_TYPE,
  EDGE_STYLE_KINDS,
  activeEffectLayersAt,
  clampEdgeStyleParams,
  edgeStyleParamsIssue,
  type Asset,
  type EdgeStyleKind,
  type Clip,
  type Effect,
  type EffectLayer,
  type Keyframe,
  type MaskLayer,
  masksOf,
  type Timeline,
  type Track,
  type TranscriptWord,
} from '@framepilot/timeline-schema';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { resolveCaptionCue } from './captions/cue.js';
import { assetDisplaySize } from './mask-geometry.js';
import { applyEasing, evaluateKeyframes } from './keyframes.js';
import { CAPTION_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from './operations.js';
import { hasSpeedRamp, sourceTimeAt } from './speed-curve.js';
import {
  readAlignment,
  TRANSITION_EFFECT_TYPE,
  TRANSITION_OUT_EFFECT_TYPE,
  transitionWindow,
  type TransitionAlignment,
} from './transitions.js';

// ---------------------------------------------------------------------------
// Plan shape (JSON-identical to `FramePlan.to_json()` in the engine)
// ---------------------------------------------------------------------------

export type FramePlanLayerKind = 'picture' | 'text' | 'caption' | 'solid';
export type FramePlanLayerRole = 'clip' | 'underlay';

export interface FramePlanSource {
  readonly assetId: string;
  readonly assetKind: 'video' | 'image';
  /** Source seconds MoviePy reads; `null` for a still, or when the mapping needs an unknown fps/duration. */
  readonly time: number | null;
  /** `int(fps * time + 1e-5)` — the frame MoviePy's ffmpeg reader decodes; `null` without a probed fps. */
  readonly frame: number | null;
}

export interface FramePlanGeometry {
  readonly baseScale: number;
  /** `baseScale` × authored scale × a geometry transition's zoom. */
  readonly scale: number;
  /** Where the layer's centre lands, in frame pixels. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Degrees, as authored. */
  readonly rotation: number;
  /** Top-left and displayed size; `null` for text/captions (raster size is a pixel concern). */
  readonly left: number | null;
  readonly top: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface FramePlanTransition {
  readonly role: 'in' | 'out';
  readonly kind: string;
  /** `legacy` = the pre-catalog envelope path; `catalog` = the per-frame transition passes. */
  readonly path: 'legacy' | 'catalog';
  /** The catalog render kind (`''` on the legacy path). */
  readonly renderKind: string;
  readonly progress: number;
  readonly eased: number;
}

export interface FramePlanLayer {
  readonly kind: FramePlanLayerKind;
  readonly role: FramePlanLayerRole;
  readonly trackId: string;
  readonly clipId: string | null;
  /** For an under-layer: the clip whose transition it sits under. */
  readonly forClipId: string | null;
  /** Seconds since the layer was placed. */
  readonly localTime: number;
  readonly source: FramePlanSource | null;
  readonly text: string | null;
  readonly crop: { x: number; y: number; width: number; height: number } | null;
  readonly geometry: FramePlanGeometry | null;
  readonly opacity: number;
  readonly blendMode: string;
  /** Per-clip picture effects in the order the export applies them (grade, then LUT). */
  readonly effects: readonly { type: string; params: Record<string, unknown> }[];
  /**
   * The clip's enabled mask stack (schema v22, ADR 0178), top first, and the ASSET source
   * second it is evaluated at; `null` when nothing is masked. The stack is referenced by
   * mask id (geometry stays on the clip), so the plan carries order, kind, mode, target and
   * feather model — what decides which pass draws it — without copying the geometry.
   */
  readonly mask: FramePlanMaskStack | null;
  readonly transitions: readonly FramePlanTransition[];
  /**
   * MK8.2: the layer is another clip's track matte — rendered for that clip's `layer` mask and
   * never composited itself (Premiere's Track Matte Key and CapCut's text-as-mask both hide the
   * matte). Present only when true, so plans without a track matte are unchanged.
   */
  readonly matteOnly?: true;
  /**
   * MK9.2: the clip's cut-out edge styles (outline, glow, shadow), bottom first, with clamped
   * params. Present only when the clip has one, so plans without edge styles are unchanged.
   */
  readonly edgeStyles?: readonly FramePlanEdgeStyle[];
}

/** One cut-out edge style as the renderers read it (`render/edge_styles.py`). */
export interface FramePlanEdgeStyle {
  readonly kind: EdgeStyleKind;
  readonly params: Readonly<Record<string, number>>;
}

export interface FramePlanMaskLayer {
  readonly id: string;
  readonly kind: MaskLayer['kind'];
  readonly mode: MaskLayer['mode'];
  readonly invert: boolean;
  readonly space: MaskLayer['space'];
  readonly featherModel: MaskLayer['featherModel'];
  readonly target: { kind: 'alpha' } | { kind: 'effect'; effectId: string };
  /** Matte layers only: the artifact, read at the picture's own decoded source frame (BR2). */
  readonly matte?: { readonly artifactKey: string; readonly sourceFrame: number | null };
  /** Track matte layers only (MK8.2): the clip or track it reads, and which channel. */
  readonly layer?: {
    readonly source: { kind: 'clip'; clipId: string } | { kind: 'track'; trackId: string };
    readonly channel: 'alpha' | 'luma' | 'inverted-alpha' | 'inverted-luma';
  };
}

export interface FramePlanMaskStack {
  /** Asset source seconds the stack is evaluated at (the continuous speed-stage clock). */
  readonly sourceTime: number;
  /** Enabled masks, top first. */
  readonly layers: readonly FramePlanMaskLayer[];
}

/** An effect layer's enabled frame-space mask stack at this instant (MK5.2). */
export interface FramePlanLayerMaskStack {
  /** Seconds from the layer's `start`: an adjustment lane's masks run on their own clock. */
  readonly localTime: number;
  /** Enabled masks, top first. Geometry is in output-frame pixels, so there is no crop. */
  readonly layers: readonly {
    readonly id: string;
    readonly kind: MaskLayer['kind'];
    readonly mode: MaskLayer['mode'];
    readonly invert: boolean;
    readonly featherModel: MaskLayer['featherModel'];
  }[];
}

export interface FramePlanFrameEffect {
  readonly trackId: string;
  readonly layerId: string;
  readonly kind: string;
  readonly effectId: string;
  readonly params: Record<string, number>;
  readonly intensity: number;
  /** Absent when the adjustment covers the whole frame. */
  readonly mask?: FramePlanLayerMaskStack;
}

export interface FramePlan {
  readonly time: number;
  readonly width: number;
  readonly height: number;
  readonly background: readonly [number, number, number];
  /** Back to front. */
  readonly layers: readonly FramePlanLayer[];
  /** Effect layers applied to the finished frame, in apply order. */
  readonly frameEffects: readonly FramePlanFrameEffect[];
}

export interface FramePlanOptions {
  /** Whether the export burns caption tracks in. Default `false`, as the export's. */
  readonly burnCaptions?: boolean;
  /** Probed source frame rate per asset id: frame numbers and reverse playback need it. */
  readonly sourceFps?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /**
   * Variable-frame-rate sources only: each frame's pts in seconds from the first frame, ascending.
   * Their frame numbers follow the export's pts-exact reader (`render/pts_reader.py`).
   */
  readonly sourceFrameTimes?:
    ReadonlyMap<string, readonly number[]> | Readonly<Record<string, readonly number[]>>;
  /** Project transcript, for caption clips without their own cue. */
  readonly transcript?: readonly TranscriptWord[];
}

/** A frame plan could not be derived. */
export class FramePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramePlanError';
  }
}

// ---------------------------------------------------------------------------
// Constants mirrored from the engine
// ---------------------------------------------------------------------------

/** How close two clips must sit to count as one cut (ADR 0146). */
export const CUT_ADJACENCY_TOLERANCE = 1e-3;
/** How much of a neighbour's handle an under-layer may borrow, as a multiple of the ramp. */
export const UNDERLAY_HANDLE_SLACK = 1.05;
/** MoviePy's frame-number nudge: `int(fps * t + 1e-5)`. */
export const FRAME_NUMBER_EPSILON = 0.00001;
/** Slack when matching a source time to a variable-rate frame's pts (`FRAME_PTS_EPSILON`). */
export const FRAME_PTS_EPSILON = 1e-6;
/** The export composites on black. */
export const FRAME_PLAN_BACKGROUND: readonly [number, number, number] = [0, 0, 0];
/** Per-clip picture effects the export applies, in order. */
const PICTURE_EFFECT_ORDER = ['color_grade', 'lut'] as const;

const LEGACY_KINDS = new Set([
  'cut',
  'fade',
  'cross-dissolve',
  'push',
  'slide',
  'zoom',
  'blur',
  'wipe',
]);
const OPACITY_KINDS = new Set(['fade', 'cross-dissolve']);
const GEOMETRY_KINDS = new Set(['push', 'zoom', 'slide']);
const ZOOM_FROM = 1.6;
const DEFAULT_DIRECTIONS: Readonly<Record<string, string>> = {
  push: 'left',
  slide: 'up',
  wipe: 'right',
  zoom: 'in',
};
const DIRECTIONS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  push: ['left', 'right', 'up', 'down'],
  slide: ['left', 'right', 'up', 'down'],
  wipe: ['left', 'right', 'up', 'down'],
  zoom: ['in', 'out'],
};
const TRAVEL: Readonly<Record<string, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

// ---------------------------------------------------------------------------
// Transition resolution (mirrors render/transitions.py)
// ---------------------------------------------------------------------------

interface ResolvedTransition {
  readonly kind: string;
  readonly duration: number;
  readonly direction: string;
  readonly intensity: number;
  readonly easing: string;
  readonly alignment: TransitionAlignment;
  readonly renderKind: string;
  readonly isCut: boolean;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Python's `float(value)` with a fallback for anything unconvertible or non-finite. */
function asFloat(value: unknown, fallback: number): number {
  let coerced: number;
  if (typeof value === 'boolean') coerced = value ? 1 : 0;
  else if (typeof value === 'number') coerced = value;
  else if (typeof value === 'string' && value.trim() !== '') coerced = Number(value);
  else return fallback;
  return Number.isFinite(coerced) ? coerced : fallback;
}

function paramOr(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : fallback;
}

function effectOfType(clip: Clip, type: string): Effect | undefined {
  return clip.effects.find((effect) => effect.type === type);
}

/** `transition_from_clip`: the pre-catalog parse of the incoming effect. */
function legacyParse(clip: Clip): ResolvedTransition | null {
  const effect = effectOfType(clip, TRANSITION_EFFECT_TYPE);
  if (effect === undefined) return null;
  const params = effect.params;
  return {
    kind: String(paramOr(params, 'kind', 'cut')),
    duration: asFloat(paramOr(params, 'durationSeconds', 0.5), 0),
    direction: String(paramOr(params, 'direction', '')),
    intensity: clamp01(asFloat(paramOr(params, 'intensity', 1), 1)),
    easing: String(paramOr(params, 'easing', 'linear')),
    alignment: 'start',
    renderKind: '',
    isCut: false,
  };
}

/** `resolve_transition`: stored params read against the catalog. */
function catalogResolve(params: Readonly<Record<string, unknown>>): ResolvedTransition | null {
  const kind = String(paramOr(params, 'kind', 'cross-dissolve'));
  const entry = getTransition(kind);
  if (entry === undefined) return null;
  const defaultIntensity = entry.intensity ?? 1;
  const entryEasing = entry.easing !== undefined && entry.easing !== '' ? entry.easing : 'linear';
  return {
    kind,
    duration: Math.max(0, asFloat(paramOr(params, 'durationSeconds', entry.defaultDuration), 0)),
    direction: '',
    intensity: clamp01(asFloat(paramOr(params, 'intensity', defaultIntensity), defaultIntensity)),
    easing: String(paramOr(params, 'easing', entryEasing)),
    alignment: readAlignment(params),
    renderKind: entry.renderKind,
    isCut: entry.isCut === true || Boolean(params.disabled),
  };
}

function resolveFromClip(clip: Clip, role: 'in' | 'out'): ResolvedTransition | null {
  const effect = effectOfType(
    clip,
    role === 'in' ? TRANSITION_EFFECT_TYPE : TRANSITION_OUT_EFFECT_TYPE,
  );
  return effect === undefined ? null : catalogResolve(effect.params);
}

function usesLegacyTransitionPath(clip: Clip): boolean {
  const effect = effectOfType(clip, TRANSITION_EFFECT_TYPE);
  if (effect === undefined || effect.params.disabled === true) return false;
  const kind = String(paramOr(effect.params, 'kind', ''));
  return LEGACY_KINDS.has(kind) && readAlignment(effect.params) === 'start';
}

function legacyTransition(clip: Clip): ResolvedTransition | null {
  return usesLegacyTransitionPath(clip) ? legacyParse(clip) : null;
}

function resolvedDirection(tr: ResolvedTransition): string {
  const allowed = DIRECTIONS_BY_KIND[tr.kind] ?? [];
  if (allowed.includes(tr.direction)) return tr.direction;
  return DEFAULT_DIRECTIONS[tr.kind] ?? '';
}

function linearProgress(t: number, duration: number): number {
  if (duration <= 0) return 1;
  if (t <= 0) return 0;
  if (t >= duration) return 1;
  return t / duration;
}

function easedProgress(tr: ResolvedTransition, t: number): number {
  return applyEasing(tr.easing, linearProgress(t, tr.duration));
}

function transitionOpacityAt(tr: ResolvedTransition, t: number): number {
  if (!OPACITY_KINDS.has(tr.kind)) return 1;
  const floor = 1 - tr.intensity;
  return floor + (1 - floor) * easedProgress(tr, t);
}

function transitionScaleAt(tr: ResolvedTransition, t: number): number {
  if (tr.kind !== 'zoom') return 1;
  const magnitude = 1 + (ZOOM_FROM - 1) * tr.intensity;
  const start = resolvedDirection(tr) === 'out' ? 1 / magnitude : magnitude;
  return start + (1 - start) * easedProgress(tr, t);
}

function transitionOffsetAt(
  tr: ResolvedTransition,
  t: number,
  frameWidth: number,
  frameHeight: number,
): readonly [number, number] {
  if (tr.kind !== 'push' && tr.kind !== 'slide') return [0, 0];
  const [travelX, travelY] = TRAVEL[resolvedDirection(tr)] ?? [0, 0];
  const remaining = (1 - easedProgress(tr, t)) * tr.intensity;
  return [-travelX * frameWidth * remaining, -travelY * frameHeight * remaining];
}

function catalogProgressAt(
  role: 'in' | 'out',
  t: number,
  tr: ResolvedTransition,
  clipDuration: number,
): number | null {
  if (tr.duration <= 0) return null;
  const { inSeconds, outSeconds } = transitionWindow(tr.alignment, tr.duration);
  if (role === 'in') {
    if (inSeconds <= 0 || t < 0 || t >= inSeconds) return null;
    return (outSeconds + t) / tr.duration;
  }
  if (outSeconds <= 0) return null;
  const start = clipDuration - outSeconds;
  if (t < start || t >= clipDuration) return null;
  return (t - start) / tr.duration;
}

function liveCatalogTransitions(
  clip: Clip,
  useLegacy: boolean,
): readonly (readonly ['in' | 'out', ResolvedTransition])[] {
  const incoming = useLegacy ? null : resolveFromClip(clip, 'in');
  const outgoing = resolveFromClip(clip, 'out');
  const live: (readonly ['in' | 'out', ResolvedTransition])[] = [];
  for (const [role, tr] of [
    ['out', outgoing],
    ['in', incoming],
  ] as const) {
    if (tr !== null && !tr.isCut && tr.duration > 0) live.push([role, tr]);
  }
  return live;
}

// ---------------------------------------------------------------------------
// Shared decisions (mirrors frame_plan.py)
// ---------------------------------------------------------------------------

type RenderKind = 'video' | 'image' | 'audio' | 'text' | 'caption';

function clipKindOf(clip: Clip, assetKinds: ReadonlyMap<string, string>): RenderKind {
  if (clip.assetId === TEXT_OVERLAY_ASSET_ID) return 'text';
  if (clip.assetId === CAPTION_ASSET_ID) return 'caption';
  const kind = assetKinds.get(clip.assetId);
  if (kind === 'audio') return 'audio';
  if (kind === 'image') return 'image';
  return 'video';
}

/** MoviePy's `is_playing` for a layer placed at `start` for `end - start` seconds. */
function layerIsActive(start: number, end: number, t: number): boolean {
  return start <= t && t < start + (end - start);
}

interface ClipTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly opacity: number;
}

function evaluateClipTransform(keyframes: readonly Keyframe[], t: number): ClipTransform {
  const value = (property: string, fallback: number): number =>
    evaluateKeyframes(keyframes, property, t) ?? fallback;
  const opacity = value('opacity', 1);
  return {
    scale: value('scale', 1),
    x: value('x', 0),
    y: value('y', 0),
    rotation: value('rotation', 0),
    opacity: opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity,
  };
}

function layerScaleAt(
  keyframes: readonly Keyframe[],
  t: number,
  tr: ResolvedTransition | null,
): number {
  let scale = evaluateClipTransform(keyframes, t).scale;
  if (tr !== null && GEOMETRY_KINDS.has(tr.kind)) scale *= transitionScaleAt(tr, t);
  return scale;
}

function layerOpacityAt(clip: Clip, t: number, tr: ResolvedTransition | null): number {
  let opacity = evaluateClipTransform(clip.keyframes, t).opacity;
  if (tr !== null && OPACITY_KINDS.has(tr.kind)) opacity *= transitionOpacityAt(tr, t);
  return opacity;
}

interface Underlay {
  readonly role: 'in' | 'out';
  readonly neighbour: Clip;
  readonly window: readonly [number, number];
}

function underlayWindow(
  clip: Clip,
  neighbour: Clip,
  role: 'in' | 'out',
): readonly [number, number] | null {
  const tr = resolveFromClip(clip, role);
  if (tr === null || tr.isCut || tr.duration <= 0) return null;
  const { inSeconds, outSeconds } = transitionWindow(tr.alignment, tr.duration);
  const span = role === 'in' ? inSeconds : outSeconds;
  if (span <= 0) return null;
  if (role === 'in') {
    if (Math.abs(neighbour.end - clip.start) > CUT_ADJACENCY_TOLERANCE) return null;
    return [clip.start, Math.min(clip.end, clip.start + span)];
  }
  if (Math.abs(clip.end - neighbour.start) > CUT_ADJACENCY_TOLERANCE) return null;
  return [Math.max(clip.start, clip.end - span), clip.end];
}

function transitionUnderlays(
  clip: Clip,
  position: number,
  ordered: readonly Clip[],
  assetKinds: ReadonlyMap<string, string>,
): readonly Underlay[] {
  const byId = new Map(ordered.map((entry) => [entry.id, entry]));
  const found: Underlay[] = [];
  const adjacent: readonly (readonly ['in' | 'out', Clip | undefined])[] = [
    ['in', position > 0 ? ordered[position - 1] : undefined],
    ['out', position + 1 < ordered.length ? ordered[position + 1] : undefined],
  ];
  for (const [role, beside] of adjacent) {
    const effect = effectOfType(
      clip,
      role === 'in' ? TRANSITION_EFFECT_TYPE : TRANSITION_OUT_EFFECT_TYPE,
    );
    if (effect === undefined) continue;
    const named = effect.params[role === 'in' ? 'fromClipId' : 'toClipId'];
    const neighbour = typeof named === 'string' && byId.has(named) ? byId.get(named) : beside;
    if (neighbour === undefined || clipKindOf(neighbour, assetKinds) !== 'video') continue;
    const window = underlayWindow(clip, neighbour, role);
    if (window === null) continue;
    found.push({ role, neighbour, window });
  }
  return found;
}

/** Which source second an under-layer shows at its local time (`underlay_material`). */
function underlaySourceTime(underlay: Underlay, local: number, sourceDuration: number): number {
  const { neighbour, role, window } = underlay;
  const span = window[1] - window[0];
  const borrow = span * UNDERLAY_HANDLE_SLACK;
  let handleStart: number;
  let available: number;
  let edgeTime: number;
  if (role === 'in') {
    handleStart = neighbour.sourceEnd;
    available = Math.max(0, sourceDuration - handleStart);
    edgeTime = Math.max(0, Math.min(handleStart, sourceDuration - CUT_ADJACENCY_TOLERANCE));
  } else {
    handleStart = Math.max(0, neighbour.sourceStart - borrow);
    available = neighbour.sourceStart - handleStart;
    edgeTime = Math.max(
      0,
      Math.min(neighbour.sourceStart, sourceDuration - CUT_ADJACENCY_TOLERANCE),
    );
  }
  return available >= span ? local + handleStart : edgeTime;
}

/**
 * The source second MoviePy reads for a video clip at clip-local `local`, operation for
 * operation as the compiler's `_subclipped_source` → `_apply_speed` chain computes it.
 */
export function videoSourceTime(
  clip: Pick<Clip, 'sourceStart' | 'sourceEnd' | 'speed' | 'speedRamp'>,
  local: number,
  sourceFps: number | null,
  assetDuration: number | null,
): number | null {
  const start = clip.sourceStart;
  if (hasSpeedRamp(clip)) {
    return sourceTimeAt(clip.speedRamp ?? [], 0, local, clip.sourceEnd - start) + start;
  }
  const speed = clip.speed;
  if (speed === undefined || speed === 1) return local + start;
  if (speed === 0) return 0 + start;
  if (speed > 0) return speed * local + start;
  if (sourceFps === null) return null;
  let end: number | null = clip.sourceEnd;
  if (assetDuration !== null && end >= assetDuration) end = null;
  if (end === null) {
    if (assetDuration === null) return null;
    end = assetDuration;
  }
  const subclipDuration = end - start;
  const magnitude = Math.abs(speed);
  const mirroredAt = magnitude === 1 ? local : magnitude * local;
  return subclipDuration - mirroredAt - 1 / sourceFps + start;
}

/**
 * The frame the export's reader decodes for `sourceTime`: with `frameTimes` (a variable-rate
 * source) the last frame whose pts is at or before it, else MoviePy's `int(fps * t + 1e-5)`.
 */
export function sourceFrameIndex(
  sourceTime: number | null,
  sourceFps: number | null,
  frameTimes?: readonly number[],
): number | null {
  if (sourceTime === null) return null;
  if (frameTimes !== undefined && frameTimes.length > 0) {
    // `bisect_right(times, t + eps) - 1`, clamped.
    const needle = sourceTime + FRAME_PTS_EPSILON;
    let lo = 0;
    let hi = frameTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (needle < frameTimes[mid]!) hi = mid;
      else lo = mid + 1;
    }
    return Math.min(Math.max(lo - 1, 0), frameTimes.length - 1);
  }
  if (sourceFps === null) return null;
  return Math.trunc(sourceFps * sourceTime + FRAME_NUMBER_EPSILON);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface Context {
  readonly t: number;
  readonly width: number;
  readonly height: number;
  readonly assetKinds: ReadonlyMap<string, string>;
  readonly assetSizes: ReadonlyMap<string, readonly [number, number]>;
  readonly assetDurations: ReadonlyMap<string, number>;
  readonly sourceFps: ReadonlyMap<string, number>;
  readonly sourceFrameTimes: ReadonlyMap<string, readonly number[]>;
  readonly transcript: readonly TranscriptWord[];
  readonly matteSources: LayerMatteSources;
}

/**
 * What enabled track mattes consume (`LayerMatteSources`, MK8.2): clips and whole tracks drawn
 * ONLY as another clip's matte. Only video clips on visible video tracks draw a stack.
 */
export interface LayerMatteSources {
  readonly clipIds: ReadonlySet<string>;
  readonly trackIds: ReadonlySet<string>;
}

/** `layer_matte_sources`: the clips and tracks consumed by enabled `layer` masks. */
export function layerMatteSources(
  timeline: Timeline,
  assetKinds: ReadonlyMap<string, string>,
): LayerMatteSources {
  const clipIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.type !== 'video' || track.hidden === true) continue;
    for (const clip of track.clips) {
      if (clipKindOf(clip, assetKinds) !== 'video') continue;
      for (const mask of masksOf(clip)) {
        if (!mask.enabled || mask.kind !== 'layer') continue;
        if (mask.source.kind === 'clip') clipIds.add(mask.source.clipId);
        else trackIds.add(mask.source.trackId);
      }
    }
  }
  return { clipIds, trackIds };
}

/** `LayerMatteSources.consumes`: a clip's own layer, or an under-layer for one, is a matte. */
function consumedAsMatte(sources: LayerMatteSources, layer: FramePlanLayer): boolean {
  if (sources.trackIds.has(layer.trackId)) return true;
  if (layer.forClipId !== null) return sources.clipIds.has(layer.forClipId);
  return layer.clipId !== null && sources.clipIds.has(layer.clipId);
}

function pictureGeometry(
  ctx: Context,
  clip: Clip,
  keyframes: readonly Keyframe[],
  local: number,
  honourCrop: boolean,
  tr: ResolvedTransition | null,
): FramePlanGeometry | null {
  const size = ctx.assetSizes.get(clip.assetId);
  if (size === undefined) return null;
  const crop = honourCrop ? clip.crop : undefined;
  const sourceW = crop === undefined ? size[0] : crop.width * size[0];
  const sourceH = crop === undefined ? size[1] : crop.height * size[1];
  const base = Math.min(ctx.width / sourceW, ctx.height / sourceH);
  const scale = base * layerScaleAt(keyframes, local, tr);
  const transform = evaluateClipTransform(keyframes, local);
  const width = sourceW * scale;
  const height = sourceH * scale;
  const [dx, dy] =
    tr !== null && GEOMETRY_KINDS.has(tr.kind)
      ? transitionOffsetAt(tr, local, ctx.width, ctx.height)
      : [0, 0];
  const left = ctx.width / 2 - width / 2 + transform.x + dx;
  const top = ctx.height / 2 - height / 2 + transform.y + dy;
  return {
    baseScale: base,
    scale,
    anchorX: left + width / 2,
    anchorY: top + height / 2,
    rotation: transform.rotation,
    left,
    top,
    width,
    height,
  };
}

function cropJson(clip: Clip): FramePlanLayer['crop'] {
  const crop = clip.crop;
  return crop === undefined
    ? null
    : { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

function effectsJson(clip: Clip): FramePlanLayer['effects'] {
  const found: { type: string; params: Record<string, unknown> }[] = [];
  for (const type of PICTURE_EFFECT_ORDER) {
    const effect = effectOfType(clip, type);
    if (effect !== undefined) found.push({ type: effect.type, params: { ...effect.params } });
  }
  return found;
}

function transitionStates(clip: Clip, local: number): readonly FramePlanTransition[] {
  const useLegacy = usesLegacyTransitionPath(clip);
  const states: FramePlanTransition[] = [];
  const legacy = legacyTransition(clip);
  if (legacy !== null && legacy.duration > 0 && local >= 0 && local < legacy.duration) {
    states.push({
      role: 'in',
      kind: legacy.kind,
      path: 'legacy',
      renderKind: '',
      progress: linearProgress(local, legacy.duration),
      eased: easedProgress(legacy, local),
    });
  }
  const duration = clip.end - clip.start;
  for (const [role, tr] of liveCatalogTransitions(clip, useLegacy)) {
    const progress = catalogProgressAt(role, local, tr, duration);
    if (progress === null) continue;
    states.push({
      role,
      kind: tr.kind,
      path: 'catalog',
      renderKind: tr.renderKind,
      progress,
      eased: applyEasing(tr.easing, Math.min(1, Math.max(0, progress))),
    });
  }
  return states;
}

function baseLayer(
  kind: FramePlanLayerKind,
  trackId: string,
  clipId: string | null,
  localTime: number,
): FramePlanLayer {
  return {
    kind,
    role: 'clip',
    trackId,
    clipId,
    forClipId: null,
    localTime,
    source: null,
    text: null,
    crop: null,
    geometry: null,
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    mask: null,
    transitions: [],
  };
}

/**
 * The ASSET source second a clip's mask stack is evaluated at, clip-local `local`: the
 * continuous speed-stage clock (ramp, freeze, forward, reverse). Mirrors the engine's
 * `mask_source_time`; unlike {@link videoSourceTime} it needs no probed fps.
 */
export function maskSourceTime(
  clip: Pick<Clip, 'sourceStart' | 'sourceEnd' | 'speed' | 'speedRamp'>,
  local: number,
): number {
  const start = clip.sourceStart;
  const end = clip.sourceEnd;
  if (hasSpeedRamp(clip)) {
    return start + sourceTimeAt(clip.speedRamp ?? [], 0, local, Math.max(0, end - start));
  }
  const speed = clip.speed ?? 1;
  if (speed === 0) return start;
  if (speed < 0) return end + local * speed;
  return start + local * speed;
}

/** `_layer_mask_plan_json`: an effect layer's frame-space stack, or nothing when unmasked. */
function layerMaskPlan(
  layer: EffectLayer,
  projectTime: number,
): { mask?: FramePlanLayerMaskStack } {
  const masks = masksOf(layer).filter((mask) => mask.enabled);
  if (masks.length === 0) return {};
  return {
    mask: {
      localTime: Math.max(0, projectTime - layer.start),
      layers: masks.map((mask) => ({
        id: mask.id,
        kind: mask.kind,
        mode: mask.mode,
        invert: mask.invert,
        featherModel: mask.featherModel,
      })),
    },
  };
}

function maskPlan(
  clip: Clip,
  local: number,
  sourceFrame: number | null,
): FramePlanMaskStack | null {
  const enabled = masksOf(clip).filter((mask) => mask.enabled);
  if (enabled.length === 0) return null;
  return {
    sourceTime: maskSourceTime(clip, local),
    layers: enabled.map((mask) => ({
      id: mask.id,
      kind: mask.kind,
      mode: mask.mode,
      invert: mask.invert,
      space: mask.space,
      featherModel: mask.featherModel,
      target:
        mask.target.kind === 'effect'
          ? { kind: 'effect', effectId: mask.target.effectId }
          : { kind: 'alpha' },
      ...(mask.kind === 'matte' ? { matte: { artifactKey: mask.artifact.key, sourceFrame } } : {}),
      ...(mask.kind === 'layer'
        ? {
            layer: {
              source:
                mask.source.kind === 'clip'
                  ? { kind: 'clip' as const, clipId: mask.source.clipId }
                  : { kind: 'track' as const, trackId: mask.source.trackId },
              channel: mask.channel,
            },
          }
        : {}),
    })),
  };
}

function videoLayer(ctx: Context, track: Track, clip: Clip): FramePlanLayer {
  const local = ctx.t - clip.start;
  const fps = ctx.sourceFps.get(clip.assetId) ?? null;
  const time = videoSourceTime(clip, local, fps, ctx.assetDurations.get(clip.assetId) ?? null);
  const frame = sourceFrameIndex(time, fps, ctx.sourceFrameTimes.get(clip.assetId));
  const tr = legacyTransition(clip);
  return {
    ...baseLayer('picture', track.id, clip.id, local),
    source: { assetId: clip.assetId, assetKind: 'video', time, frame },
    crop: cropJson(clip),
    geometry: pictureGeometry(ctx, clip, clip.keyframes, local, true, tr),
    opacity: layerOpacityAt(clip, local, tr),
    blendMode: clip.blendMode ?? 'normal',
    effects: effectsJson(clip),
    mask: maskPlan(clip, local, frame),
    transitions: transitionStates(clip, local),
    ...edgeStylesPlan(clip),
  };
}

/**
 * `_edge_styles_json`: the first edge style of each kind, bottom first, params clamped. A
 * malformed one is left out here (the validator and the export refuse it).
 */
function edgeStylesPlan(clip: Clip): { edgeStyles?: readonly FramePlanEdgeStyle[] } {
  const byKind = new Map<EdgeStyleKind, FramePlanEdgeStyle>();
  for (const effect of clip.effects) {
    if (effect.type !== EDGE_STYLE_EFFECT_TYPE) continue;
    if (edgeStyleParamsIssue(effect.params) !== null) return {};
    const kind = effect.params.kind as EdgeStyleKind;
    if (!byKind.has(kind))
      byKind.set(kind, { kind, params: clampEdgeStyleParams(kind, effect.params) });
  }
  const styles = EDGE_STYLE_KINDS.flatMap((kind) => {
    const style = byKind.get(kind);
    return style === undefined ? [] : [style];
  });
  return styles.length === 0 ? {} : { edgeStyles: styles };
}

function imageLayer(ctx: Context, track: Track, clip: Clip): FramePlanLayer {
  const local = ctx.t - clip.start;
  return {
    ...baseLayer('picture', track.id, clip.id, local),
    source: { assetId: clip.assetId, assetKind: 'image', time: null, frame: null },
    // The export places a still without its crop, mask, opacity or transition.
    geometry: pictureGeometry(ctx, clip, clip.keyframes, local, false, null),
    blendMode: clip.blendMode ?? 'normal',
    effects: effectsJson(clip),
  };
}

function underlayLayer(ctx: Context, track: Track, clip: Clip, underlay: Underlay): FramePlanLayer {
  const { neighbour } = underlay;
  const local = ctx.t - underlay.window[0];
  const duration = ctx.assetDurations.get(neighbour.assetId);
  const fps = ctx.sourceFps.get(neighbour.assetId) ?? null;
  const time = duration === undefined ? null : underlaySourceTime(underlay, local, duration);
  return {
    ...baseLayer('picture', track.id, neighbour.id, local),
    role: 'underlay',
    forClipId: clip.id,
    source: {
      assetId: neighbour.assetId,
      assetKind: 'video',
      time,
      frame: sourceFrameIndex(time, fps, ctx.sourceFrameTimes.get(neighbour.assetId)),
    },
    crop: cropJson(neighbour),
    // Plain picture: the neighbour's framing without its keyframes or its own transition.
    geometry: pictureGeometry(ctx, neighbour, [], local, true, null),
    blendMode: neighbour.blendMode ?? 'normal',
    effects: effectsJson(neighbour),
  };
}

function textPercent(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function textOverlayText(clip: Clip): readonly [string, Readonly<Record<string, unknown>>] | null {
  const effect = effectOfType(clip, 'text');
  // Python's `str(params.get("text", ""))`: whatever is stored is stringified.
  const text = effect === undefined ? '' : String(paramOr(effect.params, 'text', ''));
  if (text.trim() === '') return null;
  return [text, effect?.params ?? {}];
}

function textLayer(ctx: Context, track: Track, clip: Clip): FramePlanLayer | null {
  const content = textOverlayText(clip);
  if (content === null) return null;
  const [text, params] = content;
  const local = ctx.t - clip.start;
  const transform = evaluateClipTransform(clip.keyframes, local);
  return {
    ...baseLayer('text', track.id, clip.id, local),
    text,
    geometry: {
      baseScale: 1,
      scale: layerScaleAt(clip.keyframes, local, null),
      anchorX: (ctx.width * textPercent(params.xPercent, 50)) / 100 + transform.x,
      anchorY: (ctx.height * textPercent(params.yPercent, 50)) / 100 + transform.y,
      rotation: transform.rotation,
      left: null,
      top: null,
      width: null,
      height: null,
    },
    blendMode: clip.blendMode ?? 'normal',
  };
}

/** One track's active layers in the compiler's placement order, track mattes marked (MK8.2). */
function trackLayers(ctx: Context, track: Track): FramePlanLayer[] {
  return placedTrackLayers(ctx, track).map((layer) =>
    consumedAsMatte(ctx.matteSources, layer) ? { ...layer, matteOnly: true as const } : layer,
  );
}

function placedTrackLayers(ctx: Context, track: Track): FramePlanLayer[] {
  if (track.hidden === true) return [];
  const ordered = [...track.clips].sort((a, b) => a.start - b.start);
  const layers: FramePlanLayer[] = [];
  ordered.forEach((clip, position) => {
    const kind = clipKindOf(clip, ctx.assetKinds);
    if (kind === 'image') {
      if (layerIsActive(clip.start, clip.end, ctx.t)) layers.push(imageLayer(ctx, track, clip));
    } else if (kind === 'video') {
      for (const underlay of transitionUnderlays(clip, position, ordered, ctx.assetKinds)) {
        if (layerIsActive(underlay.window[0], underlay.window[1], ctx.t)) {
          layers.push(underlayLayer(ctx, track, clip, underlay));
        }
      }
      if (layerIsActive(clip.start, clip.end, ctx.t)) layers.push(videoLayer(ctx, track, clip));
    } else if (kind === 'text' && layerIsActive(clip.start, clip.end, ctx.t)) {
      const layer = textLayer(ctx, track, clip);
      if (layer !== null) layers.push(layer);
    }
  });
  return layers;
}

function hasPictureAnywhere(timeline: Timeline, assetKinds: ReadonlyMap<string, string>): boolean {
  return timeline.tracks.some(
    (track) =>
      track.hidden !== true &&
      track.clips.some((clip) => {
        const kind = clipKindOf(clip, assetKinds);
        return (
          kind === 'video' ||
          kind === 'image' ||
          (kind === 'text' && textOverlayText(clip) !== null)
        );
      }),
  );
}

function hasAudioAnywhere(timeline: Timeline, assetKinds: ReadonlyMap<string, string>): boolean {
  return timeline.tracks.some(
    (track) =>
      track.muted !== true && track.clips.some((clip) => clipKindOf(clip, assetKinds) === 'audio'),
  );
}

function captionLayers(ctx: Context, timeline: Timeline): FramePlanLayer[] {
  const layers: FramePlanLayer[] = [];
  for (const track of timeline.tracks) {
    if (track.type !== 'caption' || track.hidden === true) continue;
    for (const clip of track.clips) {
      const cue = resolveCaptionCue(clip, ctx.transcript);
      if (cue.text.trim() === '' || !layerIsActive(clip.start, clip.end, ctx.t)) continue;
      layers.push({
        ...baseLayer('caption', track.id, clip.id, ctx.t - clip.start),
        text: cue.text,
        blendMode: clip.blendMode ?? 'normal',
      });
    }
  }
  return layers;
}

function toMap<T>(
  source: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined,
): ReadonlyMap<string, T> {
  if (source === undefined) return new Map();
  if (source instanceof Map) return source;
  return new Map(Object.entries(source as Readonly<Record<string, T>>));
}

/**
 * Describe the exported frame at `projectTime`, back to front.
 *
 * @param timeline - The timeline to describe.
 * @param assets - Project assets; probed `media.width/height` drive picture geometry.
 * @param projectTime - Sequence seconds.
 * @param resolution - The output frame (the project resolution for the preview).
 * @param options - Caption burn-in, probed source fps, transcript.
 * @returns The plan; never mutates its inputs.
 * @throws FramePlanError when `projectTime` is not finite.
 */
export function framePlanAt(
  timeline: Timeline,
  assets: readonly Asset[],
  projectTime: number,
  resolution: { readonly width: number; readonly height: number },
  options: FramePlanOptions = {},
): FramePlan {
  if (!Number.isFinite(projectTime)) {
    throw new FramePlanError(`Frame plan time must be finite, got ${String(projectTime)}.`);
  }
  const assetSizes = new Map<string, readonly [number, number]>();
  const assetDurations = new Map<string, number>();
  for (const asset of assets) {
    // Display-corrected (PAR + rotation, PX2.9): the size the compiler decodes and fits.
    const display = assetDisplaySize(asset.media);
    if (display !== null) assetSizes.set(asset.id, [display.width, display.height]);
    if (asset.durationSeconds !== undefined) assetDurations.set(asset.id, asset.durationSeconds);
  }
  const assetKinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const ctx: Context = {
    t: projectTime,
    width: resolution.width,
    height: resolution.height,
    assetKinds,
    assetSizes,
    assetDurations,
    sourceFps: toMap(options.sourceFps),
    sourceFrameTimes: toMap(options.sourceFrameTimes),
    transcript: options.transcript ?? [],
    matteSources: layerMatteSources(timeline, assetKinds),
  };

  const layers: FramePlanLayer[] = [];
  // `tracks[0]` is the visual front, so tracks composite in reverse list order.
  const perTrack = timeline.tracks.map((track) => trackLayers(ctx, track));
  for (let i = perTrack.length - 1; i >= 0; i -= 1) layers.push(...(perTrack[i] ?? []));

  let timelineEnd = 0;
  for (const track of timeline.tracks)
    for (const clip of track.clips) timelineEnd = Math.max(timelineEnd, clip.end);
  if (
    !hasPictureAnywhere(timeline, ctx.assetKinds) &&
    hasAudioAnywhere(timeline, ctx.assetKinds) &&
    layerIsActive(0, timelineEnd, projectTime)
  ) {
    // The compiler's black stand-in for an audio-only timeline, as long as the timeline.
    layers.push(baseLayer('solid', '', null, projectTime));
  }
  if (options.burnCaptions === true) layers.push(...captionLayers(ctx, timeline));

  const frameEffects = activeEffectLayersAt(timeline, projectTime).map(({ track, layer }) => ({
    trackId: track.id,
    layerId: layer.id,
    kind: layer.kind,
    effectId: layer.effectId,
    params: { ...layer.params },
    intensity: layer.intensity ?? 1,
    ...layerMaskPlan(layer, projectTime),
  }));

  return {
    time: projectTime,
    width: resolution.width,
    height: resolution.height,
    background: FRAME_PLAN_BACKGROUND,
    layers,
    frameEffects,
  };
}
