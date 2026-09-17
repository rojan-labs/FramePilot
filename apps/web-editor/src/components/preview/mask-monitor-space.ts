/**
 * Where a clip's source pixels land on the program monitor (MK4.1).
 *
 * Masks are stored in display-corrected source pixels, before crop (ADR 0178). The monitor shows
 * the clip cropped, fitted into the project frame, moved, scaled and rotated. The monitor tools
 * draw and hit-test in source pixels, so they need the exact affine map from source pixels to
 * project-frame pixels, and its inverse for the pointer.
 *
 * The map is read from the frame plan (`framePlanAt`), the same description the layer compositor
 * and the export draw from, so a handle sits exactly on the edge the picture shows.
 */
import { framePlanAt, type PixelPoint } from '@framepilot/editor-core';
import type { Asset, Timeline } from '@framepilot/timeline-schema';

/** A 2D affine map `(x, y) → (a·x + c·y + e, b·x + d·y + f)`, the SVG `matrix()` order. */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface MonitorPictureSpace {
  /** Source pixels → project-frame pixels. */
  readonly toFrame: Affine;
  /** Project-frame pixels → source pixels. */
  readonly toSource: Affine;
  /** Project-frame pixels per source pixel (uniform: the fit and the clip scale). */
  readonly scale: number;
  /** The visible (cropped) part of the source, source pixels. */
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The display-corrected source size. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** Apply an affine map to a point. */
export function applyAffine(map: Affine, point: PixelPoint): PixelPoint {
  return {
    x: map.a * point.x + map.c * point.y + map.e,
    y: map.b * point.x + map.d * point.y + map.f,
  };
}

/** Invert an affine map, or `null` when it is singular. */
export function invertAffine(map: Affine): Affine | null {
  const determinant = map.a * map.d - map.b * map.c;
  if (determinant === 0 || !Number.isFinite(determinant)) return null;
  return {
    a: map.d / determinant,
    b: -map.b / determinant,
    c: -map.c / determinant,
    d: map.a / determinant,
    e: (map.c * map.f - map.d * map.e) / determinant,
    f: (map.b * map.e - map.a * map.f) / determinant,
  };
}

/** The SVG `transform` attribute for a map. */
export const affineAttribute = (map: Affine): string =>
  `matrix(${map.a} ${map.b} ${map.c} ${map.d} ${map.e} ${map.f})`;

/**
 * The map for `clipId` at a project time, or `null` when the clip draws no picture there (not
 * on screen, media unmeasured, or a degenerate size).
 *
 * @param resolution - The project frame the monitor shows.
 */
export function monitorPictureSpace(
  timeline: Timeline,
  assets: readonly Asset[],
  projectTime: number,
  resolution: { readonly width: number; readonly height: number },
  clipId: string,
): MonitorPictureSpace | null {
  let plan;
  try {
    plan = framePlanAt(timeline, assets, projectTime, resolution);
  } catch {
    return null;
  }
  const layer = plan.layers.find(
    (candidate) =>
      candidate.kind === 'picture' && candidate.role === 'clip' && candidate.clipId === clipId,
  );
  const geometry = layer?.geometry;
  if (layer === undefined || geometry === null || geometry === undefined) return null;
  if (geometry.left === null || geometry.top === null || !(geometry.scale > 0)) return null;
  const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const croppedWidth = (geometry.width ?? 0) / geometry.scale;
  const croppedHeight = (geometry.height ?? 0) / geometry.scale;
  const sourceWidth = croppedWidth / crop.width;
  const sourceHeight = croppedHeight / crop.height;
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) return null;
  const cropX = crop.x * sourceWidth;
  const cropY = crop.y * sourceHeight;
  // The plan's rotation is anticlockwise-positive (the clip transform convention); on a y-down
  // screen that is a clockwise turn of −rotation.
  const radians = (-geometry.rotation * Math.PI) / 180;
  const cos = geometry.rotation === 0 ? 1 : Math.cos(radians);
  const sin = geometry.rotation === 0 ? 0 : Math.sin(radians);
  const s = geometry.scale;
  const x0 = geometry.left - s * cropX - geometry.anchorX;
  const y0 = geometry.top - s * cropY - geometry.anchorY;
  const toFrame: Affine = {
    a: s * cos,
    b: s * sin,
    c: -s * sin,
    d: s * cos,
    e: geometry.anchorX + cos * x0 - sin * y0,
    f: geometry.anchorY + sin * x0 + cos * y0,
  };
  const toSource = invertAffine(toFrame);
  if (toSource === null) return null;
  return {
    toFrame,
    toSource,
    scale: s,
    crop: { x: cropX, y: cropY, width: croppedWidth, height: croppedHeight },
    sourceWidth,
    sourceHeight,
  };
}
