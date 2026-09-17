/**
 * A clip's schema-v22 mask stack in the preview: the TypeScript twin of
 * `engine/python/framepilot_engine/render/mask_stack.py` (MK3.2, ADR 0178).
 *
 * WHY: `Clip.masks` is the one alpha model, and the export draws it exactly (shape rasteriser,
 * `mask-raster.ts`) or, for masks migrated from v21, with the v21 Pillow path
 * (`legacy-mask.ts`). The monitor has to show the same pixels, so this module evaluates the
 * stack the same way, step for step:
 *
 * - scalar and whole-path keyframes on the ASSET source clock (`maskSourceTime`), a keyframe
 *   instant returning its stored value exactly;
 * - geometry in display-corrected source pixels mapped through the clip's crop onto the frame
 *   the layer is masked at (`raster_frame`);
 * - `gaussian-legacy` masks resolved back to their v21 frame fractions (`_legacy_spec`,
 *   including the ulp-exact fraction recovery);
 * - combine top to bottom, quantise once; a stack of exactly one `add` legacy mask keeps the
 *   v21 float alpha.
 *
 * - `matte` layers (BR5.1) from their decoded artifact frame through `matte-edges.ts` (edge
 *   shift, clean levels, distance feather on the matte's own contour, the decoded size and
 *   crop), then the same invert/opacity/mode rules. A matte frame the artifact does not hold yet
 *   (a job still processing) leaves that layer out, exactly as if it were disabled, and the
 *   monitor says "Processing"; it is never answered with a neighbouring frame.
 *
 * What the export refuses before rendering, the preview refuses too, and says so
 * ({@link MaskPreviewRefusal}); it never silently draws a clip unmasked.
 *
 * `stack-clips.json` pins every float64 byte of this against the engine (`mask-stack.test.ts`).
 */
import {
  assetDisplaySize,
  evaluateSortedCurve,
  maskSourceTime,
  segmentProgress,
  trackFrameIndexAt,
  trackMatrixAt,
  trackPointDelta,
  trackWarpPoint,
  type DisplaySize,
  type TrackArtifact,
} from '@framepilot/editor-core';
import { masksOf, type Asset, type Clip, type MaskLayer } from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';

import {
  legacyMaskAlpha,
  legacyMaskPixels,
  setPillowFloatContraction,
  type LegacyMaskSpec,
} from './legacy-mask.js';
import {
  MaskRasterError,
  applyLayerAlpha,
  combineInto,
  ellipsePath,
  flattenPath,
  pathFromPoints,
  quantizeAlpha,
  rectanglePath,
  scaleFeathers,
  shapeAlpha,
  toRaster,
  type BezierPath,
  type MaskCombineMode,
} from './mask-raster.js';
import { TRACK_REMEDIES } from './track-source.js';
import { previewIdentity } from '../semantic-signature.js';
import { cleanLevels, matteFrameAlpha, type MatteFrameData } from './matte-edges.js';

const log = createLogger('web-editor:preview:mask-stack');

/** How many ulps either side of an inverted value the legacy recovery searches. */
const RECOVERY_ULPS = 8;
/** Rasterised stacks kept for static and repeated masks. */
const RASTER_CACHE_ENTRIES = 48;

type ShapeMask = Extract<MaskLayer, { kind: 'rectangle' | 'ellipse' | 'path' }>;
type PathMask = Extract<MaskLayer, { kind: 'path' }>;
export type MatteMask = Extract<MaskLayer, { kind: 'matte' }>;
/** A mask kind the preview draws. */
export type DrawnMask = ShapeMask | MatteMask;

/**
 * What a stack with `matte` layers needs at one instant: the size the source was decoded at
 * (before its crop) and, per matte mask id, its decoded frame or `null` when the artifact does
 * not hold that frame yet (the layer is left out, as a disabled one).
 */
export interface MatteStackInputs {
  readonly decodedWidth: number;
  readonly decodedHeight: number;
  readonly frames: ReadonlyMap<string, MatteFrameData | null>;
}

/** Why the monitor cannot draw a clip's mask stack (the export refuses the same stack). */
export interface MaskPreviewRefusal {
  readonly clipId: string;
  readonly maskId: string;
  /** The plan task that ships the renderer, or `null` when the project itself needs a fix. */
  readonly task: 'MK6' | 'MK7' | 'MK8' | 'MK9' | null;
  /** One sentence with the remedy; no varying numbers. */
  readonly message: string;
}

/** A clip's enabled masks split by target, ready to evaluate per frame. */
export interface ClipMaskStack {
  readonly clip: Clip;
  /** Display-corrected source size, `null` when the media was never measured. */
  readonly size: DisplaySize | null;
  readonly alpha: readonly DrawnMask[];
  readonly byEffect: ReadonlyMap<string, readonly DrawnMask[]>;
  /** Every enabled matte layer, alpha target first (the decontamination order is its reverse). */
  readonly mattes: readonly MatteMask[];
  /** Set when the stack cannot be previewed; `alpha`/`byEffect` are then empty. */
  readonly refusal: MaskPreviewRefusal | null;
  /**
   * Per tracked mask id, the transform track that drives it (MK7.1). Absent for a stack built
   * before tracks are loaded and for owners that cannot be tracked.
   */
  readonly tracks?: ReadonlyMap<string, TrackArtifact>;
}

/** Which stack of a clip to draw. */
export type MaskStackTarget =
  { readonly kind: 'alpha' } | { readonly kind: 'effect'; readonly effectId: string };

const KIND_REFUSALS: Partial<
  Record<MaskLayer['kind'], { task: MaskPreviewRefusal['task']; what: string }>
> = {
  key: { task: 'MK6', what: 'colour key masks preview once the key renderer ships' },
  linear: { task: 'MK8', what: 'split masks preview once the analytic mask renderer ships' },
  band: { task: 'MK8', what: 'band masks preview once the analytic mask renderer ships' },
  gradient: { task: 'MK8', what: 'gradient masks preview once the analytic mask renderer ships' },
  layer: { task: 'MK8', what: 'track matte masks preview once the layer mask renderer ships' },
};

function refusal(
  clip: Clip,
  mask: MaskLayer,
  task: MaskPreviewRefusal['task'],
  message: string,
): MaskPreviewRefusal {
  return { clipId: clip.id, maskId: mask.id, task, message };
}

const isLegacy = (mask: MaskLayer): boolean => mask.featherModel === 'gaussian-legacy';

/**
 * Mask kinds a transform track can move (`_TRACKABLE_KINDS` of the engine): the track warps
 * CONTROL POINTS, and only these have any. A matte or a key follows its own pixels.
 */
const TRACKABLE_KINDS: ReadonlySet<MaskLayer['kind']> = new Set(['rectangle', 'ellipse', 'path']);

/** `_assert_legacy_drawable`: the v21 blur only draws a v21 shape. */
function legacyDrawable(mask: ShapeMask): boolean {
  const rotation = 'rotation' in mask ? mask.rotation : 0;
  const roundness = 'roundness' in mask ? mask.roundness : 0;
  let drawable =
    mask.expansionPx === 0 &&
    mask.featherInnerPx === 0 &&
    rotation === 0 &&
    roundness === 0 &&
    !mask.keyframes.some((keyframe) =>
      ['expansionPx', 'featherInnerPx', 'rotation', 'roundness'].includes(keyframe.property),
    );
  if (mask.kind === 'path') {
    drawable =
      drawable &&
      mask.pathKeyframes.every(
        (frame) =>
          frame.points.every((value, index) => index % 6 < 2 || value === 0) &&
          !(frame.featherPx ?? []).some((value) => value !== 0),
      );
  }
  return drawable;
}

/** `assert_renderable` for one enabled mask; `null` when the preview can draw it. */
function refusalFor(
  clip: Clip,
  mask: MaskLayer,
  size: DisplaySize | null,
): MaskPreviewRefusal | null {
  const kind = KIND_REFUSALS[mask.kind];
  if (kind !== undefined)
    return refusal(clip, mask, kind.task, `Mask not previewed yet: ${kind.what}.`);
  if (mask.tracking !== undefined && !TRACKABLE_KINDS.has(mask.kind)) {
    return refusal(
      clip,
      mask,
      null,
      'Only shape masks can be tracked. Clear the track or change the mask kind.',
    );
  }
  if (mask.space !== 'source') {
    return refusal(
      clip,
      mask,
      'MK9',
      'Mask not previewed yet: frame-space masks preview once they ship.',
    );
  }
  if (mask.target.kind === 'effect') {
    const effectId = mask.target.effectId;
    if (!clip.effects.some((effect) => effect.id === effectId)) {
      return refusal(
        clip,
        mask,
        null,
        'A mask limits an effect that is not on the clip. Retarget the mask or remove it.',
      );
    }
  }
  if (mask.kind === 'matte') {
    const matte = matteRefusal(clip, mask);
    if (matte !== null) return matte;
  }
  const shape = mask as ShapeMask;
  if (isLegacy(mask) && mask.tracking !== undefined) {
    return refusal(
      clip,
      mask,
      null,
      "A mask with the legacy blur feather cannot be tracked. Switch the mask's feather model to Distance.",
    );
  }
  if (isLegacy(mask) && !legacyDrawable(shape)) {
    return refusal(
      clip,
      mask,
      null,
      "A mask uses the legacy blur feather with geometry it cannot blur. Switch the mask's feather model to Distance.",
    );
  }
  if (mask.kind === 'path' && !pathVertexCountsMatch(mask)) {
    return refusal(
      clip,
      mask,
      null,
      'A path mask has keyframes with different vertex counts. Insert or remove the vertex on every keyframe.',
    );
  }
  if (mask.units !== 'normalized' && size === null) {
    return refusal(
      clip,
      mask,
      null,
      'A mask is stored in source pixels but the media size is unknown. Measure this media first.',
    );
  }
  return null;
}

/** Finesse controls the matte renderer draws (`_DRAWN_FINESSE`). */
const DRAWN_FINESSE = new Set(['cleanBlack', 'cleanWhite']);
const DEFAULT_FINESSE: Readonly<Record<string, number>> = {
  denoise: 0,
  morphOpenPx: 0,
  morphClosePx: 0,
  shrinkGrowPx: 0,
  blurPx: 0,
  inOutRatio: 0,
  cleanBlack: 0,
  cleanWhite: 1,
};

/** `_assert_matte_drawable`: edge shift, clean levels, expansion and distance feather only. */
function matteRefusal(clip: Clip, mask: MatteMask): MaskPreviewRefusal | null {
  const finesse = mask.finesse as unknown as Record<string, number>;
  const undrawn = Object.keys(DEFAULT_FINESSE).some(
    (name) => !DRAWN_FINESSE.has(name) && finesse[name] !== DEFAULT_FINESSE[name],
  );
  if (undrawn) {
    return refusal(
      clip,
      mask,
      'MK6',
      'Mask not previewed yet: matte finesse other than clean black and clean white previews once the matte finesse renderer ships.',
    );
  }
  if (isLegacy(mask)) {
    return refusal(
      clip,
      mask,
      null,
      "A matte uses the legacy blur feather, which only shapes migrated from older projects have. Switch the mask's feather model to Distance.",
    );
  }
  return null;
}

function pathVertexCountsMatch(mask: PathMask): boolean {
  const first = mask.pathKeyframes[0];
  if (first === undefined) return false;
  return mask.pathKeyframes.every((frame) => frame.points.length === first.points.length);
}

/**
 * A clip's enabled mask stacks (`clip_mask_stacks`), or `null` when nothing is masked.
 *
 * @param clip - The clip.
 * @param media - Its asset's measured media (masks are stored in display-corrected pixels).
 */
export function clipMaskStack(
  clip: Clip,
  media: Asset['media'] | null | undefined,
  tracks: ReadonlyMap<string, TrackArtifact> = new Map(),
): ClipMaskStack | null {
  const enabled = masksOf(clip).filter((mask) => mask.enabled);
  if (enabled.length === 0) return null;
  const size = assetDisplaySize(media);
  const refuse = (refused: MaskPreviewRefusal): ClipMaskStack => ({
    clip,
    size,
    alpha: [],
    byEffect: new Map(),
    mattes: [],
    refusal: refused,
    tracks,
  });
  for (const mask of enabled) {
    const refused = refusalFor(clip, mask, size);
    if (refused !== null) return refuse(refused);
    // A tracked mask is drawn only once its (small, digest-checked) artifact is in hand: the
    // export refuses the same mask when its track is missing or changed, and drawing it
    // untracked in the meantime would put the mask visibly in the wrong place.
    if (mask.tracking !== undefined && !tracks.has(mask.id)) {
      return refuse(refusal(clip, mask, 'MK7', TRACK_REMEDIES.track_missing));
    }
  }
  const shapes = enabled as DrawnMask[];
  const byEffect = new Map<string, DrawnMask[]>();
  for (const mask of shapes) {
    if (mask.target.kind !== 'effect') continue;
    const list = byEffect.get(mask.target.effectId) ?? [];
    list.push(mask);
    byEffect.set(mask.target.effectId, list);
  }
  return {
    clip,
    size,
    alpha: shapes.filter((mask) => mask.target.kind === 'alpha'),
    byEffect,
    mattes: [
      ...shapes.filter((mask) => mask.target.kind === 'alpha'),
      ...[...byEffect.values()].flat(),
    ].filter((mask): mask is MatteMask => mask.kind === 'matte'),
    refusal: null,
    tracks,
  };
}

/** The masks of `target`, top first (empty when the target is unmasked). */
export function stackMasks(stack: ClipMaskStack, target: MaskStackTarget): readonly DrawnMask[] {
  return target.kind === 'alpha' ? stack.alpha : (stack.byEffect.get(target.effectId) ?? []);
}

/**
 * The masks `target` draws at this instant: a matte whose frame is not in the artifact (still
 * processing) is left out, as a disabled mask is.
 *
 * @throws MaskRasterError when a matte layer's frame was not supplied at all (a caller bug: the
 *   compositor only draws a stack once every matte frame is decoded or known missing).
 */
export function drawnMasks(
  stack: ClipMaskStack,
  target: MaskStackTarget,
  mattes: MatteStackInputs | null,
): readonly DrawnMask[] {
  const masks = stackMasks(stack, target);
  if (!masks.some((mask) => mask.kind === 'matte')) return masks;
  return masks.filter((mask) => {
    if (mask.kind !== 'matte') return true;
    const frame = mattes?.frames.get(mask.id);
    if (frame === undefined) {
      throw new MaskRasterError('A matte frame was not decoded before its stack was drawn.');
    }
    return frame !== null;
  });
}

// --- Keyframes --------------------------------------------------------------------------------

/** `mask_scalar_at`: keyframed value (a keyframe instant is exact), else the stored field. */
export function maskScalar(mask: MaskLayer, name: string, sourceTime: number): number {
  const points = mask.keyframes.filter((keyframe) => keyframe.property === name);
  if (points.length > 0) {
    for (const point of points) if (point.sourceTime === sourceTime) return point.value;
    const sorted = points
      .map((keyframe) => ({
        time: keyframe.sourceTime,
        value: keyframe.value,
        easing: keyframe.easing,
        handles: keyframe.handles,
      }))
      .sort((a, b) => a.time - b.time);
    const animated = evaluateSortedCurve(sorted, sourceTime);
    if (animated !== undefined) return animated;
  }
  const value = (mask as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : 0;
}

/** `path_keyframe_at`: flat points and per-vertex feather at a source instant. */
export function pathKeyframeAt(
  mask: PathMask,
  sourceTime: number,
): { points: number[]; feathers: number[] | null } {
  const frames = [...mask.pathKeyframes].sort((a, b) => a.sourceTime - b.sourceTime);
  const first = frames[0];
  if (first === undefined)
    throw new MaskRasterError('A path mask has no path keyframes. Redraw the path.');
  const feathersOf = (frame: PathMask['pathKeyframes'][number]): number[] | null =>
    frame.featherPx === undefined ? null : [...frame.featherPx];
  if (sourceTime <= first.sourceTime)
    return { points: [...first.points], feathers: feathersOf(first) };
  const last = frames[frames.length - 1]!;
  if (sourceTime >= last.sourceTime)
    return { points: [...last.points], feathers: feathersOf(last) };
  for (let index = 0; index + 1 < frames.length; index += 1) {
    const left = frames[index]!;
    const right = frames[index + 1]!;
    if (!(left.sourceTime <= sourceTime && sourceTime <= right.sourceTime)) continue;
    const local = (sourceTime - left.sourceTime) / (right.sourceTime - left.sourceTime);
    const progress = segmentProgress(left, right, local);
    const points = left.points.map((a, i) => a + (right.points[i]! - a) * progress);
    const count = left.points.length / 6;
    const fa = feathersOf(left);
    const fb = feathersOf(right);
    if (fa === null && fb === null) return { points, feathers: null };
    const from = fa ?? new Array<number>(count).fill(0);
    const to = fb ?? new Array<number>(count).fill(0);
    return { points, feathers: from.map((a, i) => a + (to[i]! - a) * progress) };
  }
  return { points: [...last.points], feathers: feathersOf(last) };
}

/** `matte_alpha`: one matte layer's float alpha (after invert and opacity) on the frame. */
function matteAlpha(
  mask: MatteMask,
  stack: ClipMaskStack,
  width: number,
  height: number,
  s: number,
  mattes: MatteStackInputs,
): Float64Array {
  const frame = mattes.frames.get(mask.id);
  if (frame === undefined || frame === null) {
    throw new MaskRasterError('A matte frame was not decoded before its stack was drawn.');
  }
  const alpha = matteFrameAlpha(
    frame,
    cleanLevels(mask),
    maskScalar(mask, 'edgeShiftPx', s),
    {
      expansion: maskScalar(mask, 'expansionPx', s),
      featherInner: Math.max(maskScalar(mask, 'featherInnerPx', s), 0.0),
      featherOuter: Math.max(maskScalar(mask, 'featherOuterPx', s), 0.0),
      falloff: mask.falloff,
    },
    stack.clip.crop,
    width,
    height,
    mattes.decodedWidth,
    mattes.decodedHeight,
  );
  return applyLayerAlpha(alpha, mask.invert, maskScalar(mask, 'opacity', s));
}

/** `mask_path_at`: a shape mask as a closed Bezier path in its stored units. */
function maskPathAt(mask: ShapeMask, s: number): BezierPath {
  const value = (name: string): number => maskScalar(mask, name, s);
  if (mask.kind === 'rectangle') {
    return rectanglePath(
      value('cx'),
      value('cy'),
      value('width'),
      value('height'),
      value('rotation'),
      value('roundness'),
    );
  }
  if (mask.kind === 'ellipse') {
    return ellipsePath(value('cx'), value('cy'), value('rx'), value('ry'), value('rotation'));
  }
  const { points, feathers } = pathKeyframeAt(mask, s);
  return pathFromPoints(points, feathers, Math.trunc(mask.firstVertex));
}

// --- The legacy spec ------------------------------------------------------------------------------

const FLOAT_VIEW = new DataView(new ArrayBuffer(8));

/** `math.nextafter(value, ±inf)` for a finite double. */
function nextAfter(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  FLOAT_VIEW.setFloat64(0, value);
  let bits = FLOAT_VIEW.getBigUint64(0);
  bits = value > 0 === direction > 0 ? bits + 1n : bits - 1n;
  FLOAT_VIEW.setBigUint64(0, bits);
  return FLOAT_VIEW.getFloat64(0);
}

/** `len(repr(value))` for a finite Python float (shortest round-trip digits). */
export function pythonReprLength(value: number): number {
  if (value === 0) return Object.is(value, -0) ? 4 : 3;
  const [mantissa = '', exponentText = '0'] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  const sign = value < 0 ? 1 : 0;
  const decpt = exponent + 1;
  if (decpt <= -4 || decpt > 16) {
    const exponentDigits = Math.max(2, String(Math.abs(exponent)).length);
    return sign + digits.length + (digits.length > 1 ? 1 : 0) + 2 + exponentDigits;
  }
  if (decpt <= 0) return sign + 2 - decpt + digits.length;
  if (decpt >= digits.length) return sign + decpt + 2;
  return sign + digits.length + 1;
}

/** `_recover_fraction`: the v21 fraction the migration turned into `stored`, exactly when possible. */
function recoverFraction(
  estimate: number,
  forward: (value: number) => number,
  stored: number,
): number {
  const candidates = [estimate];
  let below = estimate;
  let above = estimate;
  for (let i = 0; i < RECOVERY_ULPS; i += 1) {
    below = nextAfter(below, -1);
    above = nextAfter(above, 1);
    candidates.push(below, above);
  }
  let best: number | null = null;
  let bestLength = 0;
  for (const value of candidates) {
    if (forward(value) !== stored) continue;
    const length = pythonReprLength(value);
    if (
      best === null ||
      length < bestLength ||
      (length === bestLength && Math.abs(value - estimate) < Math.abs(best - estimate))
    ) {
      best = value;
      bestLength = length;
    }
  }
  return best ?? estimate;
}

/** `_legacy_spec`: the v21 frame-fraction spec a legacy mask is, at source `s`. */
export function legacySpec(
  mask: ShapeMask,
  clip: Clip,
  size: DisplaySize | null,
  s: number,
): LegacyMaskSpec {
  const normalized = mask.units === 'normalized';
  const scaleW = normalized ? 1.0 : size!.width;
  const scaleH = normalized ? 1.0 : size!.height;
  const crop = clip.crop;
  const cropX = crop?.x ?? 0.0;
  const cropY = crop?.y ?? 0.0;
  const cropW = crop?.width ?? 1.0;
  const cropH = crop?.height ?? 1.0;
  const cropWidth = cropW * scaleW;
  const cropHeight = cropH * scaleH;
  const featherScale = normalized ? 1.0 : Math.min(cropWidth, cropHeight);
  const toX = (f: number): number => (normalized ? f : (cropX + f * cropW) * scaleW);
  const toY = (f: number): number => (normalized ? f : (cropY + f * cropH) * scaleH);
  const fromX = (px: number): number => (normalized ? px : (px / scaleW - cropX) / cropW);
  const fromY = (py: number): number => (normalized ? py : (py / scaleH - cropY) / cropH);
  const scalar = (name: string): number => maskScalar(mask, name, s);
  const recover = (name: string, estimate: number, forward: (f: number) => number): number =>
    recoverFraction(estimate, forward, scalar(name));

  const storedFeather = scalar('featherOuterPx');
  let feather = featherScale > 0 ? storedFeather / featherScale : 0.0;
  if (featherScale > 0) {
    feather = recover('featherOuterPx', feather, (f) => (normalized ? f : f * featherScale));
  }
  const common = { feather, opacity: scalar('opacity'), invert: mask.invert };
  if (mask.kind === 'path') {
    const { points } = pathKeyframeAt(mask, s);
    const polygon: [number, number][] = [];
    for (let i = 0; i < points.length; i += 6) {
      polygon.push([
        recoverFraction(fromX(points[i]!), toX, points[i]!),
        recoverFraction(fromY(points[i + 1]!), toY, points[i + 1]!),
      ]);
    }
    return { shape: 'polygon', x: 0, y: 0, width: 1, height: 1, ...common, points: polygon };
  }
  const ellipse = mask.kind === 'ellipse';
  const sizeW = ellipse ? 'rx' : 'width';
  const sizeH = ellipse ? 'ry' : 'height';
  const storedW = scalar(sizeW);
  const storedH = scalar(sizeH);
  const boxW = ellipse ? storedW * 2.0 : storedW;
  const boxH = ellipse ? storedH * 2.0 : storedH;
  const half = ellipse ? 0.5 : 1.0;
  const fw = recover(sizeW, boxW / scaleW / cropW, (f) => (normalized ? f : f * cropWidth) * half);
  const fh = recover(sizeH, boxH / scaleH / cropH, (f) => (normalized ? f : f * cropHeight) * half);
  const cx = scalar('cx');
  const cy = scalar('cy');
  const fx = recoverFraction(fromX(cx) - fw / 2, (f) => toX(f + fw / 2), cx);
  const fy = recoverFraction(fromY(cy) - fh / 2, (f) => toY(f + fh / 2), cy);
  return { shape: mask.kind, x: fx, y: fy, width: fw, height: fh, ...common, points: [] };
}

/**
 * `warp_path`: move a Bezier path's control points by the track, BEFORE it is flattened.
 *
 * Tangents are stored as offsets from their vertex, so each one is warped at its absolute
 * position and turned back into an offset: a perspective track has to bend the tangents, not
 * just carry them along, or a tracked curve would flatten out as the plane turns. A
 * `point-cloud` track moves vertex `i` — and both of its tangent ends — by its own measured
 * displacement, which is exact for a non-rigid shape.
 */
function warpPath(track: TrackArtifact, path: BezierPath, sourceTime: number): BezierPath {
  const index = trackFrameIndexAt(track, sourceTime);
  const matrix = trackMatrixAt(track, index);
  const shape = track.method === 'point-cloud' && track.points !== undefined;
  const vertices = path.vertices.map((vertex, order) => {
    if (shape) {
      const [dx, dy] = trackPointDelta(track, index, order);
      return { ...vertex, x: vertex.x + dx, y: vertex.y + dy };
    }
    const [x, y] = trackWarpPoint(matrix, vertex.x, vertex.y);
    const [inX, inY] = trackWarpPoint(matrix, vertex.x + vertex.inX, vertex.y + vertex.inY);
    const [outX, outY] = trackWarpPoint(matrix, vertex.x + vertex.outX, vertex.y + vertex.outY);
    return { ...vertex, x, y, inX: inX - x, inY: inY - y, outX: outX - x, outY: outY - y };
  });
  return { vertices, firstVertex: path.firstVertex };
}

// --- One mask, the stack ----------------------------------------------------------------------------

/** `mask_alpha`: one mask's float alpha (after invert and opacity) on a `width`×`height` frame. */
function maskAlpha(
  drawn: DrawnMask,
  stack: ClipMaskStack,
  width: number,
  height: number,
  s: number,
  mattes: MatteStackInputs | null,
): Float64Array {
  if (drawn.kind === 'matte') {
    if (mattes === null) {
      throw new MaskRasterError('A matte frame was not decoded before its stack was drawn.');
    }
    return matteAlpha(drawn, stack, width, height, s, mattes);
  }
  const mask = drawn;
  const { clip, size } = stack;
  if (isLegacy(mask)) return legacyMaskAlpha(legacySpec(mask, clip, size, s), width, height);
  const crop = clip.crop;
  const normalized = mask.units === 'normalized';
  const sourceW = normalized ? 1.0 : size!.width;
  const sourceH = normalized ? 1.0 : size!.height;
  const scaleX = width / ((crop?.width ?? 1.0) * sourceW);
  const scaleY = height / ((crop?.height ?? 1.0) * sourceH);
  const offsetX = -((crop?.x ?? 0.0) * sourceW) * scaleX;
  const offsetY = -((crop?.y ?? 0.0) * sourceH) * scaleY;
  const distance = Math.min(scaleX, scaleY);
  const track = stack.tracks?.get(mask.id);
  const path = track === undefined ? maskPathAt(mask, s) : warpPath(track, maskPathAt(mask, s), s);
  const polyline = scaleFeathers(
    toRaster(flattenPath(path), scaleX, scaleY, offsetX, offsetY),
    distance,
  );
  const alpha = shapeAlpha(
    {
      polyline,
      expansion: maskScalar(mask, 'expansionPx', s) * distance,
      featherInner: Math.max(maskScalar(mask, 'featherInnerPx', s), 0.0) * distance,
      featherOuter: Math.max(maskScalar(mask, 'featherOuterPx', s), 0.0) * distance,
      falloff: mask.falloff,
    },
    width,
    height,
  );
  return applyLayerAlpha(alpha, mask.invert, maskScalar(mask, 'opacity', s));
}

/** Whether a single `add` legacy mask keeps its v21 float alpha (no quantisation). */
function isLegacyPassthrough(masks: readonly DrawnMask[]): masks is readonly [ShapeMask] {
  return masks.length === 1 && isLegacy(masks[0]!) && masks[0]!.mode === 'add';
}

/**
 * `stack_alpha` at clip-relative `clipTime`: the exact float64 alpha the export attaches, or
 * `null` when `target` is unmasked.
 */
export function stackAlphaAt(
  stack: ClipMaskStack,
  target: MaskStackTarget,
  width: number,
  height: number,
  clipTime: number,
  mattes: MatteStackInputs | null = null,
): Float64Array | null {
  if (stack.refusal !== null) return null;
  const masks = drawnMasks(stack, target, mattes);
  if (masks.length === 0) return null;
  const s = maskSourceTime(stack.clip, clipTime);
  if (isLegacyPassthrough(masks)) return maskAlpha(masks[0], stack, width, height, s, mattes);
  const accumulated = new Float64Array(width * height);
  for (const mask of masks) {
    combineInto(
      accumulated,
      maskAlpha(mask, stack, width, height, s, mattes),
      mask.mode as MaskCombineMode,
    );
  }
  const quantized = quantizeAlpha(accumulated);
  for (let i = 0; i < accumulated.length; i += 1) accumulated[i] = quantized[i]! / 255.0;
  return accumulated;
}

/**
 * A stack as 8-bit coverage plus a float factor, what the compositor uploads: a quantised
 * stack is its own bytes (`scale` 1); a lone legacy mask is its Pillow bytes (inverted when the
 * mask inverts) scaled by the mask's clamped opacity, as the export's float alpha is.
 */
export interface MaskStackRaster {
  readonly width: number;
  readonly height: number;
  readonly alpha8: Uint8Array;
  readonly scale: number;
}

function isAnimated(masks: readonly DrawnMask[]): boolean {
  return masks.some(
    (mask) =>
      mask.kind === 'matte' ||
      // A track gives a mask a new transform on every source frame.
      mask.tracking !== undefined ||
      mask.keyframes.length > 0 ||
      (mask.kind === 'path' && mask.pathKeyframes.length > 1),
  );
}

/** Which matte frames and decode geometry a raster depends on. */
function matteKey(masks: readonly DrawnMask[], mattes: MatteStackInputs | null): string {
  if (mattes === null || !masks.some((mask) => mask.kind === 'matte')) return '';
  const frames = masks
    .filter((mask) => mask.kind === 'matte')
    .map((mask) => `${mask.id}=${mattes.frames.get(mask.id)?.id ?? 'none'}`);
  return `decoded:${mattes.decodedWidth}x${mattes.decodedHeight}|${frames.join(',')}`;
}

/** Rasterised stacks by semantic signature; static masks are drawn once per size. */
export class MaskStackRasterCache {
  private readonly entries = new Map<string, MaskStackRaster>();

  constructor(private readonly capacity = RASTER_CACHE_ENTRIES) {}

  /**
   * The 8-bit raster of `target` at clip-relative `clipTime`, or `null` when unmasked.
   *
   * @param stack - From {@link clipMaskStack} (must not be refused).
   * @param target - Alpha or one effect's stack.
   * @param width - Frame width the layer is masked at (the cropped decoded picture).
   * @param height - Frame height.
   * @param clipTime - Seconds from the clip's start.
   * @param mattes - Decoded matte frames and decode size, when the stack has matte layers.
   */
  raster(
    stack: ClipMaskStack,
    target: MaskStackTarget,
    width: number,
    height: number,
    clipTime: number,
    mattes: MatteStackInputs | null = null,
  ): MaskStackRaster | null {
    if (stack.refusal !== null || width <= 0 || height <= 0) return null;
    const masks = drawnMasks(stack, target, mattes);
    if (masks.length === 0) return null;
    const s = maskSourceTime(stack.clip, clipTime);
    const key = [
      previewIdentity(stack.clip),
      target.kind === 'alpha' ? 'alpha' : `effect:${target.effectId}`,
      `${width}x${height}`,
      stack.size === null ? 'unsized' : `${stack.size.width}x${stack.size.height}`,
      isAnimated(masks) ? String(s) : 'static',
      matteKey(masks, mattes),
    ].join('|');
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const raster = this.draw(stack, masks, width, height, s, mattes);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, raster);
    return raster;
  }

  private draw(
    stack: ClipMaskStack,
    masks: readonly DrawnMask[],
    width: number,
    height: number,
    s: number,
    mattes: MatteStackInputs | null,
  ): MaskStackRaster {
    const started = performance.now();
    let raster: MaskStackRaster;
    if (isLegacyPassthrough(masks)) {
      const mask = masks[0];
      const spec = legacySpec(mask, stack.clip, stack.size, s);
      const alpha8 = legacyMaskPixels(spec, width, height);
      if (spec.invert) for (let i = 0; i < alpha8.length; i += 1) alpha8[i] = 255 - alpha8[i]!;
      const opacity = spec.opacity <= 0 ? 0 : spec.opacity >= 1 ? 1 : spec.opacity;
      raster = { width, height, alpha8, scale: opacity };
    } else {
      const accumulated = new Float64Array(width * height);
      for (const mask of masks) {
        combineInto(
          accumulated,
          maskAlpha(mask, stack, width, height, s, mattes),
          mask.mode as MaskCombineMode,
        );
      }
      raster = { width, height, alpha8: quantizeAlpha(accumulated), scale: 1 };
    }
    const elapsed = performance.now() - started;
    if (elapsed > 16) {
      log.debug('mask stack raster exceeded a frame', {
        clipId: stack.clip.id,
        masks: masks.length,
        width,
        height,
        ms: Math.round(elapsed),
      });
    }
    return raster;
  }
}

/**
 * Match the host's Pillow float arithmetic (see `legacy-mask.ts`): its macOS arm64 wheels fuse
 * multiply-add. Resolved once from the browser's high-entropy client hints; until then (and
 * where hints are unavailable) the two-step arithmetic of every other platform is used.
 */
export async function configureLegacyMaskArithmeticFromHost(): Promise<void> {
  type UaData = {
    getHighEntropyValues?: (
      hints: string[],
    ) => Promise<{ platform?: string; architecture?: string }>;
  };
  const uaData = (globalThis.navigator as (Navigator & { userAgentData?: UaData }) | undefined)
    ?.userAgentData;
  if (uaData?.getHighEntropyValues === undefined) return;
  try {
    const hints = await uaData.getHighEntropyValues(['architecture', 'platform']);
    const fused = hints.platform === 'macOS' && hints.architecture === 'arm';
    setPillowFloatContraction(fused);
    log.debug('legacy mask float arithmetic', { fused });
  } catch (error) {
    log.warn('client hints unavailable; legacy masks use two-step float arithmetic', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
