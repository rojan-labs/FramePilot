/**
 * Geometry the monitor mask tools draw and hit-test with (MK4.1), in source pixels.
 *
 * Rectangles and ellipses are edited through their own fields (centre, size, rotation), paths
 * through their vertices; both are DRAWN as Bezier outlines, generated here with the same
 * construction the rasteriser uses (`preview/masks/mask-raster.ts`), so the outline on screen is
 * the edge the export cuts.
 */
import {
  rotateOffset,
  transformPoint,
  transformVertices,
  type AnchorTransform,
  type MaskGeometry,
  type MaskPathVertex,
  type PixelPoint,
} from '@framepilot/editor-core';
import { ellipsePath, rectanglePath, type BezierPath } from '../../preview/masks/mask-raster.js';

/** Bezier vertices of any editable geometry. */
export function outlineVertices(geometry: MaskGeometry): readonly MaskPathVertex[] {
  if (geometry.kind === 'path') return geometry.vertices;
  const path: BezierPath =
    geometry.kind === 'rectangle'
      ? rectanglePath(
          geometry.cx,
          geometry.cy,
          geometry.width,
          geometry.height,
          geometry.rotation,
          geometry.roundness,
        )
      : ellipsePath(geometry.cx, geometry.cy, geometry.rx, geometry.ry, geometry.rotation);
  return path.vertices.map((vertex) => ({
    x: vertex.x,
    y: vertex.y,
    inX: vertex.inX,
    inY: vertex.inY,
    outX: vertex.outX,
    outY: vertex.outY,
    type: 'corner' as const,
  }));
}

/** SVG path data for a closed Bezier outline. */
export function outlinePathData(vertices: readonly MaskPathVertex[]): string {
  if (vertices.length === 0) return '';
  const parts: string[] = [`M${vertices[0]!.x} ${vertices[0]!.y}`];
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    parts.push(`C${a.x + a.outX} ${a.y + a.outY} ${b.x + b.inX} ${b.y + b.inY} ${b.x} ${b.y}`);
  }
  parts.push('Z');
  return parts.join('');
}

/** SVG path data for an open polyline (a freehand stroke, a pen path being drawn). */
export function polylinePathData(points: readonly PixelPoint[], close = false): string {
  if (points.length === 0) return '';
  return (
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('') +
    (close ? 'Z' : '')
  );
}

/** Square handles of side `size` centred on each point, as one path. */
export function squaresPathData(points: readonly PixelPoint[], size: number): string {
  const half = size / 2;
  return points
    .map((point) => `M${point.x - half} ${point.y - half}h${size}v${size}h${-size}Z`)
    .join('');
}

const SAMPLES_PER_SEGMENT = 12;

/** The outline flattened into a polygon for inside tests and offsets. */
export function flattenOutline(vertices: readonly MaskPathVertex[]): PixelPoint[] {
  const points: PixelPoint[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    const p1x = a.x + a.outX;
    const p1y = a.y + a.outY;
    const p2x = b.x + b.inX;
    const p2y = b.y + b.inY;
    for (let step = 0; step < SAMPLES_PER_SEGMENT; step += 1) {
      const t = step / SAMPLES_PER_SEGMENT;
      const u = 1 - t;
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * b.y,
      });
    }
  }
  return points;
}

/** Even-odd inside test against a flattened outline. */
export function pointInPolygon(polygon: readonly PixelPoint[], point: PixelPoint): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The polygon pushed out (positive) or in (negative) by `distance` along its vertex normals:
 * the dashed feather and expansion guides. Display only; the rasteriser measures exact distance.
 */
export function offsetPolygon(polygon: readonly PixelPoint[], distance: number): PixelPoint[] {
  if (distance === 0 || polygon.length < 3) return [...polygon];
  const orientation = signedArea(polygon) >= 0 ? 1 : -1;
  return polygon.map((point, index) => {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const tx = next.x - previous.x;
    const ty = next.y - previous.y;
    const length = Math.sqrt(tx * tx + ty * ty) || 1;
    // For a clockwise-on-screen (positive area in y-down) polygon the outward normal is (ty, −tx).
    const nx = (ty / length) * orientation;
    const ny = (-tx / length) * orientation;
    return { x: point.x + nx * distance, y: point.y + ny * distance };
  });
}

function signedArea(polygon: readonly PixelPoint[]): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    area += (polygon[j]!.x * polygon[i]!.y - polygon[i]!.x * polygon[j]!.y) / 2;
  }
  return area;
}

/** The centre of any editable geometry (rect/ellipse centre; a path's anchor-point bounds centre). */
export function geometryCentre(geometry: MaskGeometry): PixelPoint {
  if (geometry.kind !== 'path') return { x: geometry.cx, y: geometry.cy };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const vertex of geometry.vertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Apply an anchor transform to a whole geometry. A rectangle/ellipse keeps its kind: the centre
 * moves, sizes scale in the shape's own frame, and rotation adds.
 */
export function transformGeometry(
  geometry: MaskGeometry,
  transform: AnchorTransform,
): MaskGeometry {
  if (geometry.kind === 'path') {
    return { kind: 'path', vertices: transformVertices(geometry.vertices, null, transform) };
  }
  const centre = transformPoint({ x: geometry.cx, y: geometry.cy }, transform);
  const sx = Math.abs(transform.scaleX);
  const sy = Math.abs(transform.scaleY);
  if (geometry.kind === 'rectangle') {
    return {
      ...geometry,
      cx: centre.x,
      cy: centre.y,
      width: geometry.width * sx,
      height: geometry.height * sy,
      rotation: geometry.rotation + transform.rotation,
    };
  }
  return {
    ...geometry,
    cx: centre.x,
    cy: centre.y,
    rx: geometry.rx * sx,
    ry: geometry.ry * sy,
    rotation: geometry.rotation + transform.rotation,
  };
}

/** A geometry moved by an offset. */
export function translateGeometry(geometry: MaskGeometry, dx: number, dy: number): MaskGeometry {
  if (geometry.kind === 'path') {
    return {
      kind: 'path',
      vertices: geometry.vertices.map((vertex) => ({
        ...vertex,
        x: vertex.x + dx,
        y: vertex.y + dy,
      })),
    };
  }
  return { ...geometry, cx: geometry.cx + dx, cy: geometry.cy + dy };
}

/** The oriented box a rectangle/ellipse is edited through: centre, half extents, rotation. */
export interface OrientedBox {
  readonly cx: number;
  readonly cy: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Degrees, clockwise on screen. */
  readonly rotation: number;
}

export function boxOf(geometry: Exclude<MaskGeometry, { kind: 'path' }>): OrientedBox {
  return geometry.kind === 'rectangle'
    ? {
        cx: geometry.cx,
        cy: geometry.cy,
        halfWidth: geometry.width / 2,
        halfHeight: geometry.height / 2,
        rotation: geometry.rotation,
      }
    : {
        cx: geometry.cx,
        cy: geometry.cy,
        halfWidth: geometry.rx,
        halfHeight: geometry.ry,
        rotation: geometry.rotation,
      };
}

/** A box written back into its geometry kind. */
export function withBox(
  geometry: Exclude<MaskGeometry, { kind: 'path' }>,
  box: OrientedBox,
): Exclude<MaskGeometry, { kind: 'path' }> {
  return geometry.kind === 'rectangle'
    ? {
        ...geometry,
        cx: box.cx,
        cy: box.cy,
        width: box.halfWidth * 2,
        height: box.halfHeight * 2,
        rotation: box.rotation,
      }
    : {
        ...geometry,
        cx: box.cx,
        cy: box.cy,
        rx: box.halfWidth,
        ry: box.halfHeight,
        rotation: box.rotation,
      };
}

/** The eight resize handles of a box and the rotation handle position, clockwise from top-left. */
export const BOX_HANDLES = [
  { id: 'nw', ux: -1, uy: -1 },
  { id: 'n', ux: 0, uy: -1 },
  { id: 'ne', ux: 1, uy: -1 },
  { id: 'e', ux: 1, uy: 0 },
  { id: 'se', ux: 1, uy: 1 },
  { id: 's', ux: 0, uy: 1 },
  { id: 'sw', ux: -1, uy: 1 },
  { id: 'w', ux: -1, uy: 0 },
] as const;

export type BoxHandleId = (typeof BOX_HANDLES)[number]['id'];

/** A box handle's position in source pixels. */
export function boxHandlePoint(box: OrientedBox, ux: number, uy: number): PixelPoint {
  const offset = rotateOffset(ux * box.halfWidth, uy * box.halfHeight, box.rotation);
  return { x: box.cx + offset.x, y: box.cy + offset.y };
}

/** A point in the box's own (unrotated, centred) frame. */
export function toBoxLocal(box: OrientedBox, point: PixelPoint): PixelPoint {
  return rotateOffset(point.x - box.cx, point.y - box.cy, -box.rotation);
}

/**
 * Resize a box by dragging handle (`ux`, `uy`) to `pointer`.
 *
 * The opposite handle stays put, or the centre with `fromCentre` (Alt). `keepAspect` (Shift)
 * scales both extents by the same factor. Edge handles change one extent only.
 */
export function resizeBox(
  box: OrientedBox,
  ux: number,
  uy: number,
  pointer: PixelPoint,
  options: { readonly fromCentre?: boolean; readonly keepAspect?: boolean } = {},
): OrientedBox {
  const local = toBoxLocal(box, pointer);
  const fromCentre = options.fromCentre === true;
  let halfWidth = box.halfWidth;
  let halfHeight = box.halfHeight;
  let shiftX = 0;
  let shiftY = 0;
  if (ux !== 0) {
    if (fromCentre) halfWidth = Math.abs(local.x);
    else {
      const anchor = -ux * box.halfWidth;
      halfWidth = Math.abs(local.x - anchor) / 2;
      shiftX = (local.x + anchor) / 2;
    }
  }
  if (uy !== 0) {
    if (fromCentre) halfHeight = Math.abs(local.y);
    else {
      const anchor = -uy * box.halfHeight;
      halfHeight = Math.abs(local.y - anchor) / 2;
      shiftY = (local.y + anchor) / 2;
    }
  }
  if (
    options.keepAspect === true &&
    ux !== 0 &&
    uy !== 0 &&
    box.halfWidth > 0 &&
    box.halfHeight > 0
  ) {
    const factor = Math.max(halfWidth / box.halfWidth, halfHeight / box.halfHeight);
    halfWidth = box.halfWidth * factor;
    halfHeight = box.halfHeight * factor;
    if (!fromCentre) {
      // The opposite corner stays: the centre sits one new half extent in from it.
      shiftX = ux * (halfWidth - box.halfWidth);
      shiftY = uy * (halfHeight - box.halfHeight);
    }
  }
  const moved = rotateOffset(shiftX, shiftY, box.rotation);
  return { ...box, cx: box.cx + moved.x, cy: box.cy + moved.y, halfWidth, halfHeight };
}
