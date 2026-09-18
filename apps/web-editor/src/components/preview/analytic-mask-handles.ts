/**
 * On-canvas handles for the analytic mask kinds (MK8.1): split (`linear`), mirror (`band`) and
 * gradient.
 *
 * WHY a module of its own: these kinds have no outline and no transform box. A split is a line
 * across the picture, a mirror is two parallel lines, a gradient is a start and an end, so the
 * shape tools' vocabulary (`MaskGeometry`, `outlineVertices`) does not describe them. This file
 * is the pure half: where each handle sits, what a drag on it changes, and the guide lines the
 * monitor draws. `MaskCanvasTools` owns the pointer and commits ONE `set_mask_properties` on
 * release, exactly as a shape drag commits one `set_mask_geometry`.
 *
 * Coordinates are display-corrected SOURCE pixels, the units the mask stores, like every other
 * mask tool. Angles are degrees clockwise (y down); the kept side of a split is on the LEFT of
 * the line's direction of travel (`AnalyticMaskGeometry` in editor-core).
 */
import { maskScalarAt, type AnalyticMaskGeometry, type PixelPoint } from '@framepilot/editor-core';
import type { MaskLayer } from '@framepilot/timeline-schema';

/** An analytic mask layer. */
export type AnalyticMaskLayer = Extract<MaskLayer, { kind: 'linear' | 'band' | 'gradient' }>;

/** The handles an analytic mask shows when selected. */
export type AnalyticHandle =
  'origin' | 'rotate' | 'edge-near' | 'edge-far' | 'softness' | 'start' | 'end' | 'body';

/** The animatable numbers an analytic mask is edited through, by schema property name. */
export type AnalyticValues = Readonly<Record<string, number>>;

/** Degrees per step when Shift constrains a rotation. */
export const ANGLE_SNAP_DEGREES = 15;

const LINE_FIELDS = ['originX', 'originY', 'angle', 'softnessPx'] as const;
const BAND_FIELDS = [...LINE_FIELDS, 'widthPx'] as const;
const GRADIENT_FIELDS = ['startX', 'startY', 'endX', 'endY'] as const;

/** Whether a mask is one of the analytic kinds. */
export const isAnalyticLayer = (mask: MaskLayer): mask is AnalyticMaskLayer =>
  mask.kind === 'linear' || mask.kind === 'band' || mask.kind === 'gradient';

/** The fields a kind is dragged through. */
export function analyticFields(kind: AnalyticMaskLayer['kind']): readonly string[] {
  if (kind === 'gradient') return GRADIENT_FIELDS;
  return kind === 'band' ? BAND_FIELDS : LINE_FIELDS;
}

/**
 * The mask's values at a source instant, with a drag in progress laid over them.
 *
 * @param live - Values of an uncommitted drag for this mask, or `null`.
 */
export function analyticValuesAt(
  mask: AnalyticMaskLayer,
  sourceTime: number,
  live: AnalyticValues | null,
): AnalyticValues {
  const values: Record<string, number> = {};
  for (const field of analyticFields(mask.kind)) {
    values[field] =
      live?.[field] ??
      maskScalarAt(mask, field as Parameters<typeof maskScalarAt>[1], sourceTime) ??
      0;
  }
  return values;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** The line's unit direction and the unit normal pointing to the side it CUTS AWAY. */
export function lineFrame(angle: number): {
  readonly dx: number;
  readonly dy: number;
  readonly nx: number;
  readonly ny: number;
} {
  const dx = Math.cos(radians(angle));
  const dy = Math.sin(radians(angle));
  return { dx, dy, nx: -dy, ny: dx };
}

/**
 * Where each handle of the selected mask sits.
 *
 * @param stalk - Distance from the origin to the rotation handle, source pixels (the caller
 *   converts a constant screen distance, so the handle is reachable at any zoom).
 */
export function analyticHandlePoints(
  kind: AnalyticMaskLayer['kind'],
  values: AnalyticValues,
  stalk: number,
): { readonly handle: AnalyticHandle; readonly point: PixelPoint; readonly label: string }[] {
  if (kind === 'gradient') {
    return [
      { handle: 'start', point: { x: values.startX!, y: values.startY! }, label: 'Gradient start' },
      { handle: 'end', point: { x: values.endX!, y: values.endY! }, label: 'Gradient end' },
    ];
  }
  const origin = { x: values.originX!, y: values.originY! };
  const { dx, dy, nx, ny } = lineFrame(values.angle!);
  const half = kind === 'band' ? Math.max(values.widthPx!, 0) / 2 : 0;
  const soft = Math.max(values.softnessPx!, 0) / 2;
  const handles: { handle: AnalyticHandle; point: PixelPoint; label: string }[] = [
    { handle: 'origin', point: origin, label: kind === 'band' ? 'Band centre' : 'Split position' },
    {
      handle: 'rotate',
      point: { x: origin.x + dx * stalk, y: origin.y + dy * stalk },
      label: 'Angle',
    },
  ];
  if (kind === 'band') {
    handles.push(
      {
        handle: 'edge-near',
        point: { x: origin.x - nx * half, y: origin.y - ny * half },
        label: 'Band width',
      },
      {
        handle: 'edge-far',
        point: { x: origin.x + nx * half, y: origin.y + ny * half },
        label: 'Band width',
      },
    );
  }
  // The softness knob sits a stalk's length along the line, out on the cut-away side by half the
  // softness (plus the band's half width), so it moves exactly as the soft edge it controls.
  const along = -stalk;
  handles.push({
    handle: 'softness',
    point: {
      x: origin.x + dx * along + nx * (half + soft),
      y: origin.y + dy * along + ny * (half + soft),
    },
    label: 'Softness',
  });
  return handles;
}

/** Round an angle to the nearest {@link ANGLE_SNAP_DEGREES}. */
const snapAngle = (angle: number): number =>
  Math.round(angle / ANGLE_SNAP_DEGREES) * ANGLE_SNAP_DEGREES;

/** `atan2` in degrees, clockwise with y down. */
export const angleOf = (from: PixelPoint, to: PixelPoint): number =>
  (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

/**
 * The values a drag on `handle` produces.
 *
 * @param base - The values when the drag began.
 * @param start - Where the pointer went down, source pixels.
 * @param point - Where it is now.
 * @param constrain - Shift: angles snap to 15°.
 * @returns Only the fields the drag changes.
 */
export function dragAnalyticHandle(
  kind: AnalyticMaskLayer['kind'],
  handle: AnalyticHandle,
  base: AnalyticValues,
  start: PixelPoint,
  point: PixelPoint,
  constrain: boolean,
): Record<string, number> {
  const moveX = point.x - start.x;
  const moveY = point.y - start.y;
  switch (handle) {
    case 'start':
      return { startX: base.startX! + moveX, startY: base.startY! + moveY };
    case 'end':
      return { endX: base.endX! + moveX, endY: base.endY! + moveY };
    case 'origin':
      return { originX: base.originX! + moveX, originY: base.originY! + moveY };
    case 'body':
      if (kind === 'gradient') {
        return {
          startX: base.startX! + moveX,
          startY: base.startY! + moveY,
          endX: base.endX! + moveX,
          endY: base.endY! + moveY,
        };
      }
      return { originX: base.originX! + moveX, originY: base.originY! + moveY };
    case 'rotate': {
      const angle = angleOf({ x: base.originX!, y: base.originY! }, point);
      return { angle: constrain ? snapAngle(angle) : angle };
    }
    case 'edge-near':
    case 'edge-far': {
      const { nx, ny } = lineFrame(base.angle!);
      const offset = (point.x - base.originX!) * nx + (point.y - base.originY!) * ny;
      return { widthPx: Math.max(Math.abs(offset) * 2, 0) };
    }
    case 'softness': {
      const { nx, ny } = lineFrame(base.angle!);
      const offset = (point.x - base.originX!) * nx + (point.y - base.originY!) * ny;
      const half = kind === 'band' ? Math.max(base.widthPx!, 0) / 2 : 0;
      return { softnessPx: Math.max((offset - half) * 2, 0) };
    }
  }
}

/** A straight guide line the monitor draws, source pixels. */
export interface GuideLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly role: 'edge' | 'soft' | 'axis';
}

/** A line through `point` along `(dx, dy)`, long enough to cross the whole picture. */
function crossing(
  point: PixelPoint,
  dx: number,
  dy: number,
  reach: number,
  role: GuideLine['role'],
): GuideLine {
  return {
    x1: point.x - dx * reach,
    y1: point.y - dy * reach,
    x2: point.x + dx * reach,
    y2: point.y + dy * reach,
    role,
  };
}

/**
 * The guides an analytic mask is drawn with: the split line (or the band's two edges), dashed
 * softness bounds, and a gradient's axis; a radial gradient adds its radius circle.
 *
 * @param reach - Half-length of a line across the picture, source pixels (its diagonal is enough).
 */
export function analyticGuides(
  kind: AnalyticMaskLayer['kind'],
  values: AnalyticValues,
  reach: number,
  radial: boolean,
): { readonly lines: GuideLine[]; readonly circle: { cx: number; cy: number; r: number } | null } {
  if (kind === 'gradient') {
    const line: GuideLine = {
      x1: values.startX!,
      y1: values.startY!,
      x2: values.endX!,
      y2: values.endY!,
      role: 'axis',
    };
    const r = Math.hypot(values.endX! - values.startX!, values.endY! - values.startY!);
    return {
      lines: [line],
      circle: radial ? { cx: values.startX!, cy: values.startY!, r } : null,
    };
  }
  const origin = { x: values.originX!, y: values.originY! };
  const { dx, dy, nx, ny } = lineFrame(values.angle!);
  const half = kind === 'band' ? Math.max(values.widthPx!, 0) / 2 : 0;
  const soft = Math.max(values.softnessPx!, 0) / 2;
  const at = (offset: number): PixelPoint => ({
    x: origin.x + nx * offset,
    y: origin.y + ny * offset,
  });
  const lines: GuideLine[] =
    kind === 'band'
      ? [crossing(at(-half), dx, dy, reach, 'edge'), crossing(at(half), dx, dy, reach, 'edge')]
      : [crossing(origin, dx, dy, reach, 'edge')];
  if (soft > 0) {
    const edges = kind === 'band' ? [-half, half] : [0];
    for (const edge of edges) {
      const outward = edge < 0 ? -1 : 1;
      lines.push(crossing(at(edge + outward * soft), dx, dy, reach, 'soft'));
      lines.push(crossing(at(edge - outward * soft), dx, dy, reach, 'soft'));
    }
  }
  return { lines, circle: null };
}

/** Distance from `point` to the segment `a`–`b`. */
function segmentDistance(point: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Whether `point` is within `tolerance` of a mask's line(s) or gradient axis: a click selects it. */
export function hitsAnalyticMask(
  kind: AnalyticMaskLayer['kind'],
  values: AnalyticValues,
  point: PixelPoint,
  tolerance: number,
  reach: number,
): boolean {
  if (kind === 'gradient') {
    return (
      segmentDistance(
        point,
        { x: values.startX!, y: values.startY! },
        { x: values.endX!, y: values.endY! },
      ) <= tolerance
    );
  }
  const { lines } = analyticGuides(kind, values, reach, false);
  return lines
    .filter((line) => line.role === 'edge')
    .some(
      (line) =>
        segmentDistance(point, { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }) <= tolerance,
    );
}

/** Below this drag length (source pixels) a split or mirror press keeps its default angle. */
const MIN_DIRECTION_DRAG = 2;

/**
 * The geometry a split, mirror or gradient tool draws from a press at `start` dragged to `end`.
 *
 * A split or mirror line runs from the press along the drag (a click alone lays it level); a
 * mirror band starts a quarter of the picture's smaller side wide. A gradient runs from the press
 * (opaque) to the release (clear), radial when `radial` is set; it returns `null` for a click,
 * because a gradient with no length would draw nothing.
 */
export function analyticDrawGeometry(
  tool: 'split' | 'mirror' | 'gradient',
  start: PixelPoint,
  end: PixelPoint,
  picture: { readonly width: number; readonly height: number },
  options: { readonly constrain: boolean; readonly radial: boolean },
): AnalyticMaskGeometry | null {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (tool === 'gradient') {
    if (length < MIN_DIRECTION_DRAG) return null;
    return {
      kind: 'gradient',
      shape: options.radial ? 'radial' : 'linear',
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      curve: 'smooth',
    };
  }
  const raw = length < MIN_DIRECTION_DRAG ? 0 : angleOf(start, end);
  const angle = options.constrain ? snapAngle(raw) : raw;
  if (tool === 'split') {
    return { kind: 'linear', originX: start.x, originY: start.y, angle, softnessPx: 0 };
  }
  return {
    kind: 'band',
    originX: start.x,
    originY: start.y,
    angle,
    widthPx: Math.max(1, Math.min(picture.width, picture.height) / 4),
    softnessPx: 0,
  };
}
