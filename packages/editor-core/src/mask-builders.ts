/**
 * Build and read v22 masks in the frame-fraction vocabulary tools and the Inspector speak.
 *
 * Tools, the web Inspector and the tracking commands all describe a box as fractions of the
 * picture (`{x, y, width, height}` in 0..1). Schema v22 stores display-corrected source
 * pixels (ADR 0178). These are the only two conversions between them, so the agent, the UI
 * and tracking cannot disagree about where a mask is.
 *
 * Both directions refuse — never guess — when the media has not been measured.
 */
import {
  MaskLayerSchema,
  masksOf,
  type Clip,
  type MaskLayer,
  type MaskScalarProperty,
} from '@framepilot/timeline-schema';
import { evaluateSortedCurve } from './keyframes.js';
import { encodeMaskPath, type DisplaySize } from './mask-geometry.js';
import type { MaskBounds, MaskShape } from './operations.js';

/** The remedy every "no media size" refusal carries, verbatim. */
export const MEASURE_MEDIA_FIRST =
  'Measure this media first: its picture size is unknown, and a mask is stored in source pixels.';

/** A mask described the way tools and the Inspector describe one. */
export interface FrameShapeMaskRequest {
  readonly id: string;
  readonly shape: MaskShape;
  /** Rectangle/ellipse box, fractions of the picture. Absent ⇒ the whole picture. */
  readonly bounds?: MaskBounds;
  /** Polygon vertices, fractions of the picture (at least three). */
  readonly points?: readonly (readonly [number, number])[];
  /** Edge feather as a fraction of the picture's smaller side. */
  readonly feather?: number;
  readonly opacity?: number;
  readonly invert?: boolean;
  readonly name?: string;
  /** Source instant a polygon's single path keyframe is anchored at (the clip's in-point). */
  readonly sourceTime: number;
}

export type FrameShapeMaskResult =
  | { readonly ok: true; readonly mask: MaskLayer }
  | {
      readonly ok: false;
      readonly code: 'needs_media_dimensions' | 'invalid_shape';
      readonly message: string;
    };

const FULL_FRAME: MaskBounds = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Convert a frame-fraction shape into a v22 mask on a picture of `size`.
 *
 * @param request - The shape, in fractions of the picture.
 * @param size - The clip media's display-corrected size, or `null` when unmeasured.
 * @returns The mask, or a typed refusal with a remedy.
 */
export function maskLayerFromFrameShape(
  request: FrameShapeMaskRequest,
  size: DisplaySize | null,
): FrameShapeMaskResult {
  if (size === null)
    return { ok: false, code: 'needs_media_dimensions', message: MEASURE_MEDIA_FIRST };
  const bounds = request.bounds ?? FULL_FRAME;
  const base = {
    id: request.id,
    ...(request.name === undefined ? {} : { name: request.name }),
    opacity: request.opacity ?? 1,
    invert: request.invert ?? false,
    featherOuterPx: Math.max(0, request.feather ?? 0) * Math.min(size.width, size.height),
  };
  let candidate: unknown;
  if (request.shape === 'polygon') {
    const points = request.points ?? [];
    if (points.length < 3) {
      return {
        ok: false,
        code: 'invalid_shape',
        message: 'A polygon mask needs at least three [x, y] points, as fractions of the frame.',
      };
    }
    candidate = {
      ...base,
      kind: 'path',
      pathKeyframes: [
        {
          id: `${request.id}__path__0`,
          sourceTime: Math.max(0, request.sourceTime),
          ...encodeMaskPath(
            points.map(([x, y]) => ({
              x: x * size.width,
              y: y * size.height,
              inX: 0,
              inY: 0,
              outX: 0,
              outY: 0,
              type: 'corner' as const,
            })),
          ),
        },
      ],
    };
  } else {
    const cx = (bounds.x + bounds.width / 2) * size.width;
    const cy = (bounds.y + bounds.height / 2) * size.height;
    const width = bounds.width * size.width;
    const height = bounds.height * size.height;
    candidate =
      request.shape === 'ellipse'
        ? { ...base, kind: 'ellipse', cx, cy, rx: width / 2, ry: height / 2 }
        : { ...base, kind: 'rectangle', cx, cy, width, height };
  }
  const parsed = MaskLayerSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_shape',
      message:
        'The mask shape is outside the allowed values. Keep fractions within 0..1 and sizes positive.',
    };
  }
  return { ok: true, mask: parsed.data };
}

/**
 * A mask id not yet used on `clip`: `<clip>__mask` first (the id v21 masks and every tracking
 * command already use), then `<clip>__mask_2`, `_3`, …
 */
export function nextMaskId(clip: Pick<Clip, 'id' | 'masks'>): string {
  const taken = new Set(masksOf(clip).map((mask) => mask.id));
  const first = `${clip.id}__mask`;
  if (!taken.has(first)) return first;
  let n = 2;
  while (taken.has(`${first}_${String(n)}`)) n += 1;
  return `${first}_${String(n)}`;
}

/**
 * A scalar mask property at a source instant: its keyframed value when animated, else the
 * stored static value, else `undefined` when the kind has no such field.
 */
export function maskScalarAt(
  mask: MaskLayer,
  property: MaskScalarProperty,
  sourceTime: number,
): number | undefined {
  const points = mask.keyframes
    .filter((keyframe) => keyframe.property === property)
    .map((keyframe) => ({ ...keyframe, time: keyframe.sourceTime }));
  const animated = evaluateSortedCurve(points, sourceTime);
  if (animated !== undefined) return animated;
  const value = (mask as unknown as Record<string, unknown>)[property];
  return typeof value === 'number' ? value : undefined;
}

/**
 * A rectangle or ellipse mask's box at a source instant, as fractions of the picture.
 *
 * `units: 'normalized'` masks (v21 masks on unmeasured media) already store fractions, so
 * they need no size; pixel masks need the media size and return `null` without one.
 */
export function maskFrameBox(
  mask: MaskLayer,
  size: DisplaySize | null,
  sourceTime: number,
): MaskBounds | null {
  if (mask.kind !== 'rectangle' && mask.kind !== 'ellipse') return null;
  const scale = mask.units === 'normalized' ? { width: 1, height: 1 } : size;
  if (scale === null) return null;
  const cx = maskScalarAt(mask, 'cx', sourceTime)!;
  const cy = maskScalarAt(mask, 'cy', sourceTime)!;
  const width =
    mask.kind === 'ellipse'
      ? maskScalarAt(mask, 'rx', sourceTime)! * 2
      : maskScalarAt(mask, 'width', sourceTime)!;
  const height =
    mask.kind === 'ellipse'
      ? maskScalarAt(mask, 'ry', sourceTime)! * 2
      : maskScalarAt(mask, 'height', sourceTime)!;
  return {
    x: (cx - width / 2) / scale.width,
    y: (cy - height / 2) / scale.height,
    width: width / scale.width,
    height: height / scale.height,
  };
}
