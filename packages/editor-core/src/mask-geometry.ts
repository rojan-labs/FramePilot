/**
 * Mask geometry helpers (schema v22, ADR 0178): the display-corrected source space masks
 * are drawn in, and the compact on-disk form of path keyframes.
 *
 * ## Display-corrected source space
 *
 * Mask geometry is stored in pixels of the source picture **as the editor sees it**:
 * after pixel-aspect-ratio correction and rotation metadata, before crop. Storing coded
 * (storage) pixels instead would draw an anamorphic or rotated phone clip's mask
 * distorted, and every typed value in the Inspector would disagree with the monitor.
 *
 * The functions here take the PAR and rotation explicitly. `Asset.media` records the probed
 * CODED width/height (schema v21) plus, since v22, `pixelAspectRatio` and `rotation` from
 * the ffprobe sample aspect ratio and display matrix; {@link assetDisplaySize} reads all
 * four. Media probed before v22 carries neither and is read as square and unrotated.
 *
 * ## Compact path keyframes
 *
 * A long rotoscope is thousands of keyframes of hundreds of vertices, so a path keyframe
 * is stored as a flat number array (`[x, y, inX, inY, outX, outY, …]`) plus a parallel
 * small-int vertex-type array rather than an object per vertex. {@link encodeMaskPath}
 * and {@link decodeMaskPath} are the only conversion between the two forms.
 */
import {
  MASK_VERTEX_TYPES,
  type MaskPathKeyframe,
  type MaskVertexType,
} from '@framepilot/timeline-schema';

/** Numbers stored per vertex in {@link MaskPathKeyframe.points}. */
export const MASK_PATH_STRIDE = 6;

/** A path vertex in the expanded, editable form. Tangents are offsets from the vertex. */
export interface MaskPathVertex {
  readonly x: number;
  readonly y: number;
  readonly inX: number;
  readonly inY: number;
  readonly outX: number;
  readonly outY: number;
  readonly type: MaskVertexType;
  /** Per-vertex feather, pixels. Absent ≡ the mask's own feather. */
  readonly featherPx?: number;
}

/** The storage part of a path keyframe (everything but id, time and easing). */
export type EncodedMaskPath = Pick<MaskPathKeyframe, 'points' | 'vertexTypes' | 'featherPx'>;

/** A stored path keyframe whose arrays do not describe whole vertices. */
export class MaskPathEncodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MaskPathEncodingError';
  }
}

/**
 * Pack vertices into the compact stored form.
 *
 * `featherPx` is written only when at least one vertex carries its own feather, so a plain
 * path costs nothing for the feature it does not use; vertices without one store `0`.
 *
 * @param vertices - The path's vertices, in path order.
 * @returns The flat `points`, parallel `vertexTypes`, and optional `featherPx`.
 */
export function encodeMaskPath(vertices: readonly MaskPathVertex[]): EncodedMaskPath {
  const points: number[] = [];
  const vertexTypes: number[] = [];
  const anyFeather = vertices.some((vertex) => vertex.featherPx !== undefined);
  const featherPx: number[] = [];
  for (const vertex of vertices) {
    points.push(vertex.x, vertex.y, vertex.inX, vertex.inY, vertex.outX, vertex.outY);
    vertexTypes.push(MASK_VERTEX_TYPES.indexOf(vertex.type));
    if (anyFeather) featherPx.push(vertex.featherPx ?? 0);
  }
  return anyFeather ? { points, vertexTypes, featherPx } : { points, vertexTypes };
}

/**
 * Unpack a stored path keyframe into editable vertices.
 *
 * @param path - A stored path keyframe (or its storage fields).
 * @returns One vertex per `vertexTypes` entry.
 * @throws {MaskPathEncodingError} When the arrays disagree about the vertex count.
 */
export function decodeMaskPath(path: EncodedMaskPath): MaskPathVertex[] {
  const count = path.vertexTypes.length;
  if (path.points.length !== count * MASK_PATH_STRIDE) {
    throw new MaskPathEncodingError(
      'A mask path keyframe stores six numbers per vertex (x, y, inX, inY, outX, outY). ' +
        'Rewrite the keyframe with set_mask_path.',
    );
  }
  if (path.featherPx !== undefined && path.featherPx.length !== count) {
    throw new MaskPathEncodingError(
      'A mask path keyframe stores one per-vertex feather for every vertex. ' +
        'Rewrite the keyframe with set_mask_path.',
    );
  }
  const vertices: MaskPathVertex[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * MASK_PATH_STRIDE;
    const type = MASK_VERTEX_TYPES[path.vertexTypes[index]!];
    if (type === undefined) {
      throw new MaskPathEncodingError(
        'A mask path vertex type must be 0 (corner), 1 (smooth) or 2 (broken).',
      );
    }
    const feather = path.featherPx?.[index];
    vertices.push({
      x: path.points[base]!,
      y: path.points[base + 1]!,
      inX: path.points[base + 2]!,
      inY: path.points[base + 3]!,
      outX: path.points[base + 4]!,
      outY: path.points[base + 5]!,
      type,
      ...(feather === undefined ? {} : { featherPx: feather }),
    });
  }
  return vertices;
}

/** Number of vertices a stored path keyframe holds (its `vertexTypes` length). */
export const maskPathVertexCount = (path: Pick<MaskPathKeyframe, 'vertexTypes'>): number =>
  path.vertexTypes.length;

/** Clockwise display rotation in quarter turns. */
export type QuarterTurn = 0 | 90 | 180 | 270;

/** What turns stored (coded) pixels into the picture the editor sees. */
export interface SourcePictureGeometry {
  /** Coded (storage) width, pixels — what ffprobe reports as `width`. */
  readonly codedWidth: number;
  /** Coded (storage) height, pixels. */
  readonly codedHeight: number;
  /** Pixel aspect ratio (sample aspect ratio). Absent ≡ 1 (square pixels). */
  readonly pixelAspectRatio?: number;
  /**
   * Clockwise rotation applied for display, degrees. Any multiple of 90 is accepted and
   * normalised; absent ≡ 0.
   */
  readonly rotationDegrees?: number;
}

/** A size in display-corrected source pixels. */
export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

/** A point in some pixel space. */
export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

/** Geometry the helpers cannot honour (non-quarter rotation, non-positive size or PAR). */
export class SourceGeometryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SourceGeometryError';
  }
}

/**
 * Normalise a rotation to a clockwise quarter turn.
 *
 * @throws {SourceGeometryError} For a rotation that is not a multiple of 90 degrees.
 */
export function normalizeQuarterTurn(degrees: number | undefined): QuarterTurn {
  const value = degrees ?? 0;
  if (!Number.isFinite(value) || value % 90 !== 0) {
    throw new SourceGeometryError(
      'Source rotation metadata must be a multiple of 90 degrees. Re-probe the media.',
    );
  }
  return (((value % 360) + 360) % 360) as QuarterTurn;
}

function validated(geometry: SourcePictureGeometry): {
  readonly width: number;
  readonly height: number;
  readonly par: number;
  readonly turn: QuarterTurn;
} {
  const par = geometry.pixelAspectRatio ?? 1;
  if (
    !(geometry.codedWidth > 0) ||
    !(geometry.codedHeight > 0) ||
    !Number.isFinite(geometry.codedWidth) ||
    !Number.isFinite(geometry.codedHeight) ||
    !(par > 0) ||
    !Number.isFinite(par)
  ) {
    throw new SourceGeometryError(
      'Source dimensions and pixel aspect ratio must be positive. Measure this media first.',
    );
  }
  return {
    width: geometry.codedWidth * par,
    height: geometry.codedHeight,
    par,
    turn: normalizeQuarterTurn(geometry.rotationDegrees),
  };
}

/**
 * The display-corrected size: coded width stretched by the PAR, then rotated.
 *
 * @param geometry - Coded size, PAR and rotation.
 * @returns Width and height in display-corrected source pixels.
 */
export function displayCorrectedSize(geometry: SourcePictureGeometry): DisplaySize {
  const { width, height, turn } = validated(geometry);
  return turn === 90 || turn === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Map a coded-pixel point into display-corrected source pixels.
 *
 * @param point - A point in coded (storage) pixels.
 * @param geometry - Coded size, PAR and rotation.
 * @returns The same picture point in display-corrected source pixels.
 */
export function codedToDisplay(point: PixelPoint, geometry: SourcePictureGeometry): PixelPoint {
  const { width, height, par, turn } = validated(geometry);
  const x = point.x * par;
  const { y } = point;
  switch (turn) {
    case 0:
      return { x, y };
    case 90:
      return { x: height - y, y: x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: y, y: width - x };
  }
}

/**
 * Map a display-corrected source point back to coded pixels — the exact inverse of
 * {@link codedToDisplay}.
 *
 * @param point - A point in display-corrected source pixels.
 * @param geometry - Coded size, PAR and rotation.
 * @returns The same picture point in coded (storage) pixels.
 */
export function displayToCoded(point: PixelPoint, geometry: SourcePictureGeometry): PixelPoint {
  const { width, height, par, turn } = validated(geometry);
  let x: number;
  let y: number;
  switch (turn) {
    case 0:
      ({ x, y } = point);
      break;
    case 90:
      x = point.y;
      y = height - point.x;
      break;
    case 180:
      x = width - point.x;
      y = height - point.y;
      break;
    case 270:
      x = width - point.y;
      y = point.x;
      break;
  }
  return { x: x / par, y };
}

/**
 * Normalised frame coordinates (0..1 of the display-corrected picture) → pixels.
 *
 * This is how a fraction-based caller (an AI tool's box, a pasted mask from another
 * clip) becomes the pixel geometry the schema stores.
 */
export function normalizedToDisplayPx(point: PixelPoint, size: DisplaySize): PixelPoint {
  return { x: point.x * size.width, y: point.y * size.height };
}

/** Pixels in the display-corrected picture → normalised 0..1 coordinates. */
export function displayPxToNormalized(point: PixelPoint, size: DisplaySize): PixelPoint {
  return { x: point.x / size.width, y: point.y / size.height };
}

/** The `Asset.media` fields that decide the display-corrected picture. */
export interface AssetPictureMedia {
  readonly width?: number | null | undefined;
  readonly height?: number | null | undefined;
  /** Schema v22. Absent ≡ square pixels. */
  readonly pixelAspectRatio?: number | null | undefined;
  /** Schema v22, clockwise. Absent ≡ 0. */
  readonly rotation?: number | null | undefined;
}

/**
 * The display geometry an asset records, or `null` when its size has not been measured.
 *
 * Use with {@link codedToDisplay} / {@link displayToCoded} when a caller holds coded-pixel
 * data (a tracker running on decoded storage frames) and must store display-corrected
 * mask geometry.
 */
export function assetPictureGeometry(
  media: AssetPictureMedia | null | undefined,
): SourcePictureGeometry | null {
  const width = media?.width;
  const height = media?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) {
    return null;
  }
  return {
    codedWidth: width,
    codedHeight: height,
    ...(typeof media?.pixelAspectRatio === 'number'
      ? { pixelAspectRatio: media.pixelAspectRatio }
      : {}),
    ...(typeof media?.rotation === 'number' ? { rotationDegrees: media.rotation } : {}),
  };
}

/**
 * The display-corrected source size of an asset from what the project records, or `null`
 * when the media has not been measured (the caller then refuses with "Measure this media
 * first" rather than guessing a size).
 *
 * An anamorphic 1440x1080 SAR 4:3 asset is 1920x1080 here; a 1920x1080 phone clip with a
 * clockwise 90° rotation is 1080x1920.
 *
 * @throws {SourceGeometryError} When the recorded PAR or rotation is invalid (the schema
 *   rejects both, so only an unvalidated object reaches this).
 */
export function assetDisplaySize(media: AssetPictureMedia | null | undefined): DisplaySize | null {
  const geometry = assetPictureGeometry(media);
  return geometry === null ? null : displayCorrectedSize(geometry);
}
