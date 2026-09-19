/**
 * The host job that produces a transform-track artifact (MK7.1/MK7.2).
 *
 * It is the BR4 matte job's mechanism applied to a much smaller artifact, deliberately: one
 * staging directory the host creates, host-written bytes only, verification before the commit,
 * a single atomic rename into `.framepilot-derived/tracks/<key>/`, and a digest the mask pins.
 * Nothing about "it is only a small JSON file" makes a project-folder write safe, and a second
 * mechanism would be a second thing to review.
 *
 * What is new here is the measurement policy, and it lives entirely on this side of the
 * protocol (`editor-core/mask-track-solve.ts`):
 *
 * - **methods** are one measurement constrained four ways. Position, position+scale+rotation and
 *   perspective all ride `tracking.planar`, whose homography is fitted from up to 120
 *   RANSAC-filtered correspondences; a shape track rides `tracking.point` with the path's
 *   vertices as extra points, so the whole shape costs one decode.
 * - **directions** are frame ranges plus, for anything that runs backwards, the worker's
 *   `reverse` flag: a backward track's features have to be detected on the frame the mask was
 *   drawn on, which is the range's LAST frame. Whatever the worker anchored to, the artifact is
 *   re-anchored so the identity sits on the reference frame.
 *
 * The renderer states what to track, never where the media is: the media path comes from the
 * project main just read from disk (`tracking-request.ts`), so the worker client's realpath
 * sandbox stays a second line of defence rather than the only one.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  TRACK_ARTIFACT_MAX_BYTES,
  TRACK_MAX_POINTS,
  buildTrackArtifact,
  flaggedTrackRanges,
  modelQuad,
  normalizedToDisplayMatrix,
  parseTrackArtifact,
  serializeTrackArtifact,
  TrackSolveError,
  type MeasuredTrackFrame,
  type SourcePictureGeometry,
  type TrackArtifact,
  type TrackMethod,
  type TrackPoint,
} from '@framepilot/editor-core';
import type {
  CapabilityPackWorkerProgress,
  CapabilityPackWorkerResult,
} from '@framepilot/capability-packs';
import { createLogger, maskingEventPayload } from '@framepilot/shared-types';

import {
  commitMatteStaging,
  createMatteStaging,
  TRACKS_RELATIVE_DIR,
  type MatteStaging,
} from './matte-staging.js';

const log = createLogger('desktop:capability-packs:track-job');

/** The one file a track artifact is made of (`render/tracks.py` `TRACK_FILE`). */
export const TRACK_FILE = 'track.json';

/**
 * Bumped whenever the host's measurement policy changes in a way that would produce different
 * numbers from the same footage, so an old cached track is never reused under a new policy.
 */
export const TRACK_PIPELINE_VERSION = 1;

/** Which way a track runs from the reference frame (plan 10, "Tracking"). */
export type TrackDirection = 'forward' | 'backward' | 'one-frame' | 'to-clip-edge' | 'both';

/** What the editor asked for, in host terms. */
export interface TrackJobRequest {
  readonly jobId: string;
  readonly clipId: string;
  readonly maskId: string;
  readonly assetId: string;
  readonly method: TrackMethod;
  readonly direction: TrackDirection;
  /** Decode-order source frame the mask's geometry belongs to. */
  readonly referenceFrame: number;
  /** The clip's source range on the same frame grid, half-open. */
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  /** The mask's bounding box at the reference frame, display-corrected source pixels. */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The path's vertices at the reference frame; required for a `point-cloud` track. */
  readonly vertices?: readonly TrackPoint[];
  /** Coded size, PAR and rotation of the source (MK1.9) — the display correction. */
  readonly geometry: SourcePictureGeometry;
  /** Regions the tracker must ignore, display-corrected source pixels (MK7.4). */
  readonly exclusions?: readonly TrackExclusion[];
}

/**
 * A region the editor boxed as passing in front of the tracked surface (MK7.4, MK7.7):
 * display-corrected source pixels, on the frame it was drawn on. The worker follows the box's
 * content from the frame a measurement starts on, so a box belongs to the measurement that
 * starts on the frame it was drawn on; one with no `sourceTime` applies to every measurement.
 */
export interface TrackExclusion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sourceTime?: number;
}

export type TrackJobFailureCode =
  | 'invalid_request'
  | 'unsupported_method'
  | 'no_frames'
  | 'measurement_failed'
  | 'verification_failed';

export type TrackJobOutcome =
  | {
      readonly status: 'completed';
      readonly key: string;
      readonly sha256: string;
      /** Ranges the editor should look at, source seconds (MK7.3). */
      readonly flagged: readonly { readonly start: number; readonly end: number }[];
      readonly frames: number;
      /** The worst model residual over the track, display-corrected source pixels. */
      readonly worstResidualPx: number;
    }
  | { readonly status: 'failed'; readonly code: TrackJobFailureCode; readonly detail: string };

/** The frame range, and which way to walk it, that answers a direction. */
export interface TrackRange {
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly reverse: boolean;
}

/**
 * The ranges one job runs, in order.
 *
 * `both` is two runs sharing a reference frame, not one long range: the worker always measures
 * away from the frame its features were detected on, so tracking outwards in both directions is
 * two measurements the host joins, and each keeps the accuracy of a short run.
 *
 * @throws RangeError when the reference frame is outside the clip's source range.
 */
export function trackRanges(request: {
  readonly direction: TrackDirection;
  readonly referenceFrame: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
}): readonly TrackRange[] {
  const { referenceFrame: reference, firstFrame, lastFrameExclusive } = request;
  if (
    !Number.isInteger(reference) ||
    reference < firstFrame ||
    reference >= lastFrameExclusive ||
    lastFrameExclusive <= firstFrame
  ) {
    throw new RangeError('The frame the mask was drawn on is outside the clip.');
  }
  const forward: TrackRange = {
    firstFrame: reference,
    lastFrameExclusive,
    reverse: false,
  };
  const backward: TrackRange = {
    firstFrame,
    lastFrameExclusive: reference + 1,
    reverse: true,
  };
  switch (request.direction) {
    case 'forward':
    case 'to-clip-edge':
      return [forward];
    case 'backward':
      return backward.lastFrameExclusive - backward.firstFrame > 1 ? [backward] : [];
    case 'one-frame':
      return [
        {
          firstFrame: reference,
          lastFrameExclusive: Math.min(reference + 2, lastFrameExclusive),
          reverse: false,
        },
      ];
    case 'both':
      return backward.lastFrameExclusive - backward.firstFrame > 1
        ? [forward, backward]
        : [forward];
  }
}

/**
 * The worker parameters for a method: the plane for the first three, the path's vertices for a
 * shape track. Geometry crosses the protocol normalized to the CODED frame, because that is
 * what the worker decodes; the display correction is applied to the answer, not the question.
 */
export function trackParameters(
  request: Pick<TrackJobRequest, 'method' | 'bounds' | 'vertices' | 'geometry' | 'exclusions'>,
  reverse: boolean,
): { readonly capability: 'tracking.planar' | 'tracking.point'; readonly parameters: unknown } {
  const { geometry } = request;
  const exclusions = (request.exclusions ?? [])
    .map((box) => normalizedBox(box, geometry))
    .filter((box) => box !== null);
  const excluded = exclusions.length > 0 ? { exclusions } : {};
  const toNormalized = (point: TrackPoint): { x: number; y: number } => {
    const coded = displayToCodedPoint(point, geometry);
    return {
      x: clampUnit(coded.x / geometry.codedWidth),
      y: clampUnit(coded.y / geometry.codedHeight),
    };
  };
  if (request.method === 'point-cloud') {
    const vertices = request.vertices ?? [];
    const centre = {
      x: request.bounds.x + request.bounds.width / 2,
      y: request.bounds.y + request.bounds.height / 2,
    };
    return {
      capability: 'tracking.point',
      parameters: {
        point: toNormalized(centre),
        points: vertices.map(toNormalized),
        reverse,
        ...excluded,
      },
    };
  }
  const [a, b, c, d] = modelQuad(request.bounds) as readonly TrackPoint[];
  return {
    capability: 'tracking.planar',
    parameters: {
      corners: [toNormalized(a!), toNormalized(b!), toNormalized(c!), toNormalized(d!)],
      reverse,
      ...excluded,
    },
  };
}

/**
 * A display-pixel box as the worker reads it: normalized to the CODED frame and clipped to it.
 * A rotated or anamorphic source turns the box into another axis-aligned box (a quarter turn
 * swaps its sides), so its corners are carried over and their bounds taken.
 */
function normalizedBox(
  box: TrackExclusion,
  geometry: SourcePictureGeometry,
): { x: number; y: number; width: number; height: number } | null {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((corner) => displayToCodedPoint(corner, geometry));
  const left = clampUnit(Math.min(...corners.map((corner) => corner.x)) / geometry.codedWidth);
  const right = clampUnit(Math.max(...corners.map((corner) => corner.x)) / geometry.codedWidth);
  const top = clampUnit(Math.min(...corners.map((corner) => corner.y)) / geometry.codedHeight);
  const bottom = clampUnit(Math.max(...corners.map((corner) => corner.y)) / geometry.codedHeight);
  if (!(right > left) || !(bottom > top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `displayToCoded` as a point, without pulling the whole geometry module's types through. */
function displayToCodedPoint(point: TrackPoint, geometry: SourcePictureGeometry): TrackPoint {
  const par = geometry.pixelAspectRatio ?? 1;
  const width = geometry.codedWidth * par;
  const height = geometry.codedHeight;
  const turn = (((geometry.rotationDegrees ?? 0) % 360) + 360) % 360;
  switch (turn) {
    case 90:
      return { x: point.y / par, y: height - point.x };
    case 180:
      return { x: (width - point.x) / par, y: height - point.y };
    case 270:
      return { x: (width - point.y) / par, y: point.x };
    default:
      return { x: point.x / par, y: point.y };
  }
}

/** The cache key: content, range, method, geometry, exact pack, pipeline version (plan 03). */
export function trackCacheKey(parts: {
  readonly fingerprint: string;
  readonly method: TrackMethod;
  readonly direction: TrackDirection;
  readonly referenceFrame: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly bounds: TrackJobRequest['bounds'];
  readonly vertices?: readonly TrackPoint[];
  readonly exclusions?: TrackJobRequest['exclusions'];
  /** A re-track (MK7.7): the track it continues and the constraints it was measured from. */
  readonly continues?: { readonly sha256: string; readonly constraints: readonly number[] };
  readonly packId: string;
  readonly packVersion: string;
  readonly releaseDigest: string;
}): string {
  const round = (value: number): number => Math.round(value * 1e4) / 1e4;
  return createHash('sha256')
    .update(
      JSON.stringify({
        pipeline: TRACK_PIPELINE_VERSION,
        content: parts.fingerprint,
        method: parts.method,
        direction: parts.direction,
        referenceFrame: parts.referenceFrame,
        firstFrame: parts.firstFrame,
        lastFrameExclusive: parts.lastFrameExclusive,
        bounds: [
          round(parts.bounds.x),
          round(parts.bounds.y),
          round(parts.bounds.width),
          round(parts.bounds.height),
        ],
        vertices: (parts.vertices ?? []).map((point) => [round(point.x), round(point.y)]),
        exclusions: (parts.exclusions ?? []).map((box) => [
          round(box.x),
          round(box.y),
          round(box.width),
          round(box.height),
        ]),
        pack: `${parts.packId}@${parts.packVersion}`,
        releaseDigest: parts.releaseDigest,
        // Only present on a re-track, so a fresh track keeps the key it always had.
        ...(parts.continues === undefined
          ? {}
          : {
              continues: parts.continues.sha256,
              constraints: parts.continues.constraints.map(round),
            }),
      }),
    )
    .digest('hex');
}

/** One worker run's samples, as the host received them. */
export type TrackingSamples = Extract<CapabilityPackWorkerResult, { samples: unknown }>['samples'];

/**
 * Samples → measured frames in display-corrected source pixels.
 *
 * A sample with no `transform` is one a pack built before mask tracking produced, or a point
 * track: the plane is then unknown and the frame is left out rather than guessed at from the
 * box, which cannot carry rotation. A shape track needs no transform — its points ARE the
 * measurement — so its frames pass through with the identity.
 *
 * Exclusion regions are the WORKER's (MK7.7): it follows each one's content and leaves its pixels
 * out of registration and of the confidence it reports. They used to be applied here, by
 * dropping every sample whose measured box centre fell inside one — which threw away exactly
 * the frames the editor was trying to rescue, and never kept the occluder out of the fit.
 */
export function measuredFrames(
  samples: TrackingSamples,
  request: Pick<TrackJobRequest, 'method' | 'geometry'>,
  ptsOf: (frame: number) => number,
): readonly MeasuredTrackFrame[] {
  const frames: MeasuredTrackFrame[] = [];
  const { geometry } = request;
  for (const sample of samples) {
    let homography = [1, 0, 0, 0, 1, 0, 0, 0, 1] as readonly number[];
    if (request.method !== 'point-cloud') {
      if (sample.transform === undefined) continue;
      const display = normalizedToDisplayMatrix(sample.transform, geometry);
      if (display === undefined) continue;
      homography = display;
    }
    frames.push({
      frame: sample.frame,
      pts: ptsOf(sample.frame),
      homography,
      confidence: sample.confidence,
      ...(sample.points === undefined
        ? {}
        : {
            points: sample.points.map((point) =>
              codedToDisplayPoint(
                { x: point.x * geometry.codedWidth, y: point.y * geometry.codedHeight },
                geometry,
              ),
            ),
          }),
    });
  }
  return frames;
}

function codedToDisplayPoint(point: TrackPoint, geometry: SourcePictureGeometry): TrackPoint {
  const par = geometry.pixelAspectRatio ?? 1;
  const width = geometry.codedWidth * par;
  const height = geometry.codedHeight;
  const x = point.x * par;
  const turn = (((geometry.rotationDegrees ?? 0) % 360) + 360) % 360;
  switch (turn) {
    case 90:
      return { x: height - point.y, y: x };
    case 180:
      return { x: width - x, y: height - point.y };
    case 270:
      return { x: point.y, y: width - x };
    default:
      return { x, y: point.y };
  }
}

export interface WriteTrackInput {
  readonly projectDir: string;
  readonly jobId: string;
  readonly key: string;
  readonly request: TrackJobRequest;
  readonly frames: readonly MeasuredTrackFrame[];
  readonly timeBase: readonly [number, number];
  readonly originPts: number;
  /**
   * An artifact already built and joined (a re-track, MK7.7): written as it is. Building it again
   * from its own transforms would re-anchor every frame on the request's reference frame and
   * penalise each confidence by the model residual a second time.
   */
  readonly built?: { readonly artifact: TrackArtifact; readonly residualPx: readonly number[] };
  /** Test seam; the real one is `createMatteStaging` in the tracks store. */
  readonly createStaging?: (projectDir: string, jobId: string) => Promise<MatteStaging>;
}

/**
 * Build the artifact, write it into a host-created staging directory, verify what landed, and
 * commit it with one rename.
 *
 * Verification re-reads the file from disk and parses it with the SAME parser the export uses,
 * so a track that the renderers would refuse can never reach a cache key; the digest is taken
 * from those re-read bytes, not from the string that was written.
 */
export async function writeTrackArtifact(input: WriteTrackInput): Promise<TrackJobOutcome> {
  const { request } = input;
  let built = input.built;
  if (built === undefined) {
    try {
      built = buildTrackArtifact({
        method: request.method,
        timeBase: input.timeBase,
        originPts: input.originPts,
        frames: input.frames,
        referenceFrame: request.referenceFrame,
        quad: modelQuad(request.bounds),
        ...(request.method === 'point-cloud' ? { referencePoints: request.vertices ?? [] } : {}),
      });
    } catch (error) {
      if (error instanceof TrackSolveError) {
        return {
          status: 'failed',
          code: error.code === 'no_frames' ? 'no_frames' : 'measurement_failed',
          detail: error.message,
        };
      }
      throw error;
    }
  }
  const staging = await (input.createStaging ?? defaultStaging)(input.projectDir, input.jobId);
  try {
    const file = path.join(staging.directory, TRACK_FILE);
    await writeFile(file, serializeTrackArtifact(built.artifact), { flag: 'wx', mode: 0o400 });
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) {
      return {
        status: 'failed',
        code: 'verification_failed',
        detail: 'The tracking file changed while it was being written.',
      };
    }
    const bytes = await readFile(file);
    try {
      parseTrackArtifact(JSON.parse(bytes.toString('utf-8')));
    } catch (error) {
      return {
        status: 'failed',
        code: 'verification_failed',
        detail:
          error instanceof Error ? error.message : 'The tracking file could not be read back.',
      };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await commitMatteStaging(
      input.projectDir,
      staging,
      input.key,
      [{ name: TRACK_FILE, bytes: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs }],
      TRACKS_RELATIVE_DIR,
    );
    const worst = built.residualPx.reduce((left, right) => (right > left ? right : left), 0);
    const flagged = flaggedTrackRanges(built.artifact);
    // No clip or mask id: catalogued events carry no ids (RD2.2).
    log.action(
      'trackCommitted',
      maskingEventPayload('trackCommitted', {
        method: request.method,
        frames: built.artifact.pts.length,
        flaggedRanges: flagged.length,
        worstResidualPx: worst,
      }),
    );
    return {
      status: 'completed',
      key: input.key,
      sha256,
      flagged,
      frames: built.artifact.pts.length,
      worstResidualPx: worst,
    };
  } catch (error) {
    await staging.discard();
    throw error;
  }
}

/** Artifact keys are SHA-256 hex; anything else never reaches a path. */
const TRACK_KEY = /^[0-9a-f]{64}$/;

export class TrackArtifactReadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TrackArtifactReadError';
  }
}

/**
 * The committed track a mask pins, read back and verified (MK7.7): a re-track continues from it.
 *
 * The same checks the export makes before it trusts one: the key names a directory under the
 * project's tracks store, the file there is a regular file within the size bound, and its bytes
 * hash to the digest the mask pinned — a track changed outside FramePilot is refused, never
 * re-tracked from.
 *
 * @throws TrackArtifactReadError with a remedy-shaped message and no varying magnitude.
 */
export async function readTrackArtifact(
  projectDir: string,
  pin: { readonly key: string; readonly sha256: string },
): Promise<TrackArtifact> {
  const unreadable = 'The track this mask uses is missing or changed. Track the mask again.';
  if (!TRACK_KEY.test(pin.key)) throw new TrackArtifactReadError(unreadable);
  const file = path.join(projectDir, ...TRACKS_RELATIVE_DIR, pin.key, TRACK_FILE);
  let bytes: Buffer;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > TRACK_ARTIFACT_MAX_BYTES) {
      throw new TrackArtifactReadError(unreadable);
    }
    bytes = await readFile(file);
  } catch (error) {
    if (error instanceof TrackArtifactReadError) throw error;
    throw new TrackArtifactReadError(unreadable);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new TrackArtifactReadError(unreadable);
  }
  try {
    return parseTrackArtifact(JSON.parse(bytes.toString('utf-8')));
  } catch {
    throw new TrackArtifactReadError(unreadable);
  }
}

async function defaultStaging(projectDir: string, jobId: string): Promise<MatteStaging> {
  return createMatteStaging(projectDir, jobId, TRACKS_RELATIVE_DIR);
}

/** A request the host will not even send to a worker. */
export function validateTrackJob(request: TrackJobRequest): string | null {
  if (request.method === 'point-cloud') {
    const vertices = request.vertices ?? [];
    if (vertices.length === 0) {
      return 'A shape track follows a path’s vertices. Draw a path mask, or choose another method.';
    }
    if (vertices.length > TRACK_MAX_POINTS) {
      return 'A shape track follows more points than one mask may carry. Simplify the path, or track it with the perspective method.';
    }
  }
  if (!(request.bounds.width > 0) || !(request.bounds.height > 0)) {
    return 'The mask has no area on the frame it was drawn on. Draw the mask, then track it.';
  }
  if (!(request.fps > 0)) return 'The clip has no frame rate. Measure this media first.';
  return null;
}

/** Progress a track job reports, in the shape the jobs panel already speaks. */
export type TrackProgress = CapabilityPackWorkerProgress;
