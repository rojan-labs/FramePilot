/**
 * Running a mask track end to end in the main process (MK7.4).
 *
 * The renderer names a clip, a mask, a method and a direction. Everything else is derived HERE,
 * from the project main just read off disk: the media path, the source frame range, the mask's
 * bounding box and vertices at the reference frame, and the display correction of the source.
 * A renderer therefore cannot ask for a track of geometry the project does not contain, and the
 * worker client's realpath sandbox stays a second line of defence rather than the only one.
 *
 * A run is one or more worker measurements (a direction is up to two; a re-track from constraint
 * frames is one per constraint, outwards both ways), joined by `mergeTrackSegments` into the one
 * artifact both renderers read, then written through BR4's staging → verify → atomic rename.
 *
 * Time base: the artifact stores pts in MICROSECONDS (`timeBase` 1/1 000 000) rather than the
 * source stream's own tick, because a track is measured on the request's frame grid — `n / fps` —
 * and microseconds represent every grid instant of every rate this app supports exactly enough
 * for a nearest-frame lookup, without threading a rational frame rate through the protocol.
 */
import {
  anchorOnConstraint,
  assetDisplaySize,
  buildTrackArtifact,
  maskFrameBox,
  maskGeometryAt,
  mergeTrackSegments,
  retrackPlan,
  trackWarpAt,
  type MeasuredTrackFrame,
  type SourcePictureGeometry,
  type TrackArtifact,
  type TrackMethod,
  type TrackPoint,
  type TrackSegment,
} from '@framepilot/editor-core';
import {
  masksOf,
  type Asset,
  type Clip,
  type MaskLayer,
  type Project,
} from '@framepilot/timeline-schema';
import { createLogger } from '@framepilot/shared-types';

import {
  measuredFrames,
  trackCacheKey,
  trackParameters,
  trackRanges,
  validateTrackJob,
  writeTrackArtifact,
  type TrackDirection,
  type TrackExclusion,
  type TrackJobOutcome,
  type TrackJobRequest,
  type TrackingSamples,
} from './track-job.js';

const log = createLogger('desktop:capability-packs:track-run');

/** Ticks per second in a track artifact's `timeBase`. */
export const TRACK_TIME_BASE_HZ = 1_000_000;

/** What the renderer asked for, already parsed. */
export interface MaskTrackIntent {
  readonly requestId: string;
  readonly clipId: string;
  readonly maskId: string;
  readonly method: TrackMethod;
  readonly direction: TrackDirection;
  readonly referenceSourceTime: number;
  readonly featurePoints?: readonly TrackPoint[];
  readonly exclusions?: readonly TrackExclusion[];
  readonly fromConstraints?: boolean;
}

/** A box in display-corrected source pixels. */
interface PixelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type MaskTrackResolution =
  | { readonly status: 'resolved'; readonly resolved: ResolvedMaskTrack }
  | { readonly status: 'rejected'; readonly code: string; readonly detail: string };

/** Everything a run needs, all of it derived from the project. */
export interface ResolvedMaskTrack {
  readonly clip: Clip;
  readonly mask: MaskLayer;
  readonly asset: Asset;
  readonly geometry: SourcePictureGeometry;
  readonly fps: number;
  readonly referenceFrame: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly vertices: readonly TrackPoint[];
  readonly request: TrackJobRequest;
}

function rejected(code: string, detail: string): MaskTrackResolution {
  return { status: 'rejected', code, detail };
}

/**
 * Resolve an intent against the project.
 *
 * Every refusal names what the editor has to do about it and carries no varying magnitude, so a
 * repeated failure is the same guard key every time (the error-message-is-a-guard-key rule).
 */
export function resolveMaskTrack(
  project: Project,
  intent: MaskTrackIntent,
  projectFps: number,
): MaskTrackResolution {
  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === intent.clipId);
  if (clip === undefined) return rejected('missing_clip', 'That clip is no longer in the project.');
  const mask = masksOf(clip).find((candidate) => candidate.id === intent.maskId);
  if (mask === undefined) return rejected('missing_mask', 'That mask is no longer on the clip.');
  if (mask.locked) return rejected('mask_locked', 'This mask is locked. Unlock it to track it.');
  if (mask.kind !== 'rectangle' && mask.kind !== 'ellipse' && mask.kind !== 'path') {
    return rejected('unsupported_kind', 'Only shape masks can be tracked.');
  }
  if (intent.method === 'point-cloud' && mask.kind !== 'path') {
    return rejected(
      'unsupported_kind',
      'A shape track follows a path’s vertices. Draw a path mask, or choose another method.',
    );
  }
  const asset = project.assets?.find((candidate) => candidate.id === clip.assetId);
  if (asset === undefined || asset.kind !== 'video') {
    return rejected('wrong_asset_kind', 'Only video clips can be tracked.');
  }
  const media = asset.media;
  const size = assetDisplaySize(media);
  if (size === null || media === null || media === undefined) {
    return rejected('needs_media_dimensions', 'Measure this media first.');
  }
  const par = media.pixelAspectRatio;
  const rotation = media.rotation;
  const geometry: SourcePictureGeometry = {
    codedWidth: media.width ?? 0,
    codedHeight: media.height ?? 0,
    ...(par === undefined || par === null ? {} : { pixelAspectRatio: par }),
    ...(rotation === undefined || rotation === null ? {} : { rotationDegrees: rotation }),
  };
  if (!(geometry.codedWidth > 0) || !(geometry.codedHeight > 0)) {
    return rejected('needs_media_dimensions', 'Measure this media first.');
  }
  const fps = Number.isFinite(projectFps) && projectFps > 0 ? projectFps : 30;
  const frame = (seconds: number): number => Math.round(seconds * fps);
  const firstFrame = Math.max(0, frame(clip.sourceStart));
  const lastFrameExclusive = Math.max(firstFrame + 1, frame(clip.sourceEnd));
  const referenceFrame = Math.min(
    Math.max(frame(intent.referenceSourceTime), firstFrame),
    lastFrameExclusive - 1,
  );
  const box = maskFrameBox(mask, size, intent.referenceSourceTime);
  if (box === null) {
    return rejected('needs_media_dimensions', 'Measure this media first.');
  }
  const bounds = {
    x: box.x * size.width,
    y: box.y * size.height,
    width: box.width * size.width,
    height: box.height * size.height,
  };
  const geometryAt = maskGeometryAt(mask, intent.referenceSourceTime);
  const vertices: readonly TrackPoint[] =
    geometryAt !== null && geometryAt.kind === 'path'
      ? geometryAt.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }))
      : [];
  const request: TrackJobRequest = {
    jobId: intent.requestId,
    clipId: clip.id,
    maskId: mask.id,
    assetId: asset.id,
    method: intent.method,
    direction: intent.direction,
    referenceFrame,
    firstFrame,
    lastFrameExclusive,
    fps,
    bounds,
    geometry,
    ...(vertices.length > 0 ? { vertices } : {}),
    ...(intent.exclusions === undefined ? {} : { exclusions: intent.exclusions }),
  };
  const invalid = validateTrackJob(request);
  if (invalid !== null) return rejected('invalid_request', invalid);
  return {
    status: 'resolved',
    resolved: {
      clip,
      mask,
      asset,
      geometry,
      fps,
      referenceFrame,
      firstFrame,
      lastFrameExclusive,
      bounds,
      vertices,
      request,
    },
  };
}

/** One measurement a run performs, with the reference frame its artifact is anchored on. */
export interface MaskTrackMeasurement {
  readonly referenceFrame: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly reverse: boolean;
  /** The source instant the measurement starts from: the playhead, or a constraint. */
  readonly sourceTime: number;
  /** Where the mask is ON SCREEN there — what the worker is asked to follow. */
  readonly bounds: PixelBounds;
  readonly vertices: readonly TrackPoint[];
  /**
   * A re-track from a correction (MK7.7): the track it continues. The measurement is composed
   * with that track's transform on its reference frame (`anchorOnConstraint`), because the
   * editor's correction there is stored relative to it.
   */
  readonly continues?: TrackArtifact;
}

/**
 * The measurements a run performs.
 *
 * Without constraints this is the direction's ranges. With them (`fromConstraints`), it is the
 * re-track plan: only the stretches that are still under the confidence floor, each measured
 * outwards from the constraint nearest to it, so fixing one frame does not re-track the clip.
 */
export function maskTrackMeasurements(
  resolved: ResolvedMaskTrack,
  intent: MaskTrackIntent,
  previous: TrackArtifact | undefined,
): readonly MaskTrackMeasurement[] {
  const constraints = resolved.mask.tracking?.constraints ?? [];
  if (intent.fromConstraints === true && previous !== undefined && constraints.length > 0) {
    return retrackPlan({
      artifact: previous,
      constraints,
      firstFrame: resolved.firstFrame,
      lastFrameExclusive: resolved.lastFrameExclusive,
    }).map((segment) => ({
      referenceFrame: segment.referenceFrame,
      firstFrame: segment.firstFrame,
      lastFrameExclusive: segment.lastFrameExclusive,
      reverse: segment.reverse,
      sourceTime: segment.sourceTime,
      ...onScreen(resolved, segment.sourceTime, previous),
      continues: previous,
    }));
  }
  return trackRanges({
    direction: resolved.request.direction,
    referenceFrame: resolved.referenceFrame,
    firstFrame: resolved.firstFrame,
    lastFrameExclusive: resolved.lastFrameExclusive,
  }).map((range: { firstFrame: number; lastFrameExclusive: number; reverse: boolean }) => ({
    ...range,
    referenceFrame: resolved.referenceFrame,
    sourceTime: intent.referenceSourceTime,
    bounds: resolved.bounds,
    vertices: resolved.vertices,
  }));
}

/**
 * Where a tracked mask is on the screen at `sourceTime`: its own geometry there, moved by the
 * track (`T(t) · G(t)`, what both renderers draw). After a correction that is exactly what the
 * editor put there, and it is what a re-track from that frame must follow.
 */
function onScreen(
  resolved: ResolvedMaskTrack,
  sourceTime: number,
  track: TrackArtifact,
): { readonly bounds: PixelBounds; readonly vertices: readonly TrackPoint[] } {
  const warp = trackWarpAt(track, sourceTime);
  const size = assetDisplaySize(resolved.asset.media);
  const box = size === null ? null : maskFrameBox(resolved.mask, size, sourceTime);
  const own =
    box === null || size === null
      ? resolved.bounds
      : {
          x: box.x * size.width,
          y: box.y * size.height,
          width: box.width * size.width,
          height: box.height * size.height,
        };
  const corners = [
    warp(own.x, own.y, -1),
    warp(own.x + own.width, own.y, -1),
    warp(own.x + own.width, own.y + own.height, -1),
    warp(own.x, own.y + own.height, -1),
  ];
  const geometry = maskGeometryAt(resolved.mask, sourceTime);
  const vertices =
    geometry !== null && geometry.kind === 'path'
      ? geometry.vertices.map((vertex, index) => {
          const [x, y] = warp(vertex.x, vertex.y, index);
          return { x, y };
        })
      : [];
  // A shape track follows the vertices; its box is theirs, as on the reference frame.
  const outline = vertices.length > 0 ? vertices : corners.map(([x, y]) => ({ x, y }));
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    bounds: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
    vertices,
  };
}

/**
 * The exclusions a measurement carries: the ones drawn on the frame it starts from (the worker
 * follows each box's content from there), and any drawn without a frame.
 */
export function exclusionsFor(
  exclusions: readonly TrackExclusion[] | undefined,
  sourceTime: number,
  fps: number,
): readonly TrackExclusion[] {
  const halfFrame = fps > 0 ? 0.5 / fps : 0;
  return (exclusions ?? []).filter(
    (box) => box.sourceTime === undefined || Math.abs(box.sourceTime - sourceTime) <= halfFrame,
  );
}

/** The worker intent for one measurement, in the shape `buildTrackingWorkerRequest` takes. */
export function measurementIntent(
  resolved: ResolvedMaskTrack,
  measurement: MaskTrackMeasurement,
  intent: MaskTrackIntent,
  index: number,
): {
  readonly requestId: string;
  readonly assetId: string;
  readonly capability: 'tracking.point' | 'tracking.planar';
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  readonly parameters: unknown;
} {
  const built = trackParameters(
    {
      method: resolved.request.method,
      bounds: measurement.bounds,
      geometry: resolved.geometry,
      // Feature points the editor added ride with the path's own vertices: they are extra
      // texture the tracker should follow, and a shape track keeps only the vertices.
      ...(resolved.request.method === 'point-cloud'
        ? { vertices: measurement.vertices }
        : { vertices: [...measurement.vertices, ...(intent.featurePoints ?? [])] }),
      exclusions: exclusionsFor(intent.exclusions, measurement.sourceTime, resolved.fps),
    },
    measurement.reverse,
  );
  return {
    requestId: `${intent.requestId}-${index}`,
    assetId: resolved.asset.id,
    capability: built.capability,
    firstFrame: measurement.firstFrame,
    lastFrameExclusive: measurement.lastFrameExclusive,
    fps: resolved.fps,
    parameters: built.parameters,
  };
}

/** Microsecond pts of a frame on the request's grid. */
export function ptsOf(frame: number, fps: number): number {
  return Math.round((frame / fps) * TRACK_TIME_BASE_HZ);
}

/** A measured segment and the model residual of each of its frames. */
export interface MeasuredSegment extends TrackSegment {
  readonly residualPx: readonly number[];
}

/**
 * Turn one measurement's samples into an anchored segment.
 *
 * A re-track from a correction is continued from the track it replaces there
 * (`anchorOnConstraint`); any other measurement is the identity on its reference frame.
 *
 * @returns The segment, or `null` when the measurement produced nothing usable (the pack never
 *   reported a plane) — the caller then has fewer segments, and fails honestly if none is left
 *   rather than committing a track of one frame.
 */
export function segmentFromSamples(
  resolved: ResolvedMaskTrack,
  measurement: MaskTrackMeasurement,
  samples: TrackingSamples,
): MeasuredSegment | null {
  const frames: readonly MeasuredTrackFrame[] = measuredFrames(
    samples,
    { method: resolved.request.method, geometry: resolved.geometry },
    (frame) => ptsOf(frame, resolved.fps),
  );
  if (frames.length === 0) return null;
  const { bounds } = measurement;
  try {
    const built = buildTrackArtifact({
      method: resolved.request.method,
      timeBase: [1, TRACK_TIME_BASE_HZ],
      originPts: 0,
      frames,
      referenceFrame: measurement.referenceFrame,
      quad: [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height },
      ],
      ...(resolved.request.method === 'point-cloud'
        ? { referencePoints: measurement.vertices }
        : {}),
    });
    const artifact =
      measurement.continues === undefined
        ? built.artifact
        : anchorOnConstraint(built.artifact, measurement.continues, measurement.referenceFrame);
    return { artifact, referenceFrame: measurement.referenceFrame, residualPx: built.residualPx };
  } catch (error) {
    log.warn('trackSegmentUnusable', {
      clipId: resolved.clip.id,
      maskId: resolved.mask.id,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

export interface CommitMaskTrackInput {
  readonly projectDir: string;
  readonly resolved: ResolvedMaskTrack;
  readonly segments: readonly MeasuredSegment[];
  readonly fingerprint: string;
  readonly pack: { readonly id: string; readonly version: string; readonly releaseDigest: string };
  /** The track a re-track replaces, with the digest it was pinned by. */
  readonly previous?: { readonly artifact: TrackArtifact; readonly sha256: string };
  /** The constraints the re-track was measured from, source seconds. */
  readonly constraints?: readonly number[];
}

/** Join the measurements and commit the artifact. */
export async function commitMaskTrack(input: CommitMaskTrackInput): Promise<TrackJobOutcome> {
  const { resolved, previous } = input;
  if (input.segments.length === 0) {
    return {
      status: 'failed',
      code: 'no_frames',
      detail:
        'The tracker could not measure this mask. Move the playhead to a clearer frame and track again.',
    };
  }
  const all: TrackSegment[] = [...input.segments];
  // A re-track replaces only what it measured: the frames the previous track already got right
  // are kept, so one fixed frame never costs the rest of the track — and a frame it did
  // re-measure is never taken back from the old track (`fallback`).
  if (previous !== undefined) {
    all.push({
      artifact: previous.artifact,
      referenceFrame: resolved.referenceFrame,
      fallback: true,
    });
  }
  const merged = mergeTrackSegments(all);
  const residualPx = input.segments.flatMap((segment) => segment.residualPx);
  const key = trackCacheKey({
    fingerprint: input.fingerprint,
    method: resolved.request.method,
    direction: resolved.request.direction,
    referenceFrame: resolved.referenceFrame,
    firstFrame: resolved.firstFrame,
    lastFrameExclusive: resolved.lastFrameExclusive,
    bounds: resolved.bounds,
    vertices: resolved.vertices,
    ...(resolved.request.exclusions === undefined
      ? {}
      : { exclusions: resolved.request.exclusions }),
    ...(previous === undefined
      ? {}
      : { continues: { sha256: previous.sha256, constraints: input.constraints ?? [] } }),
    packId: input.pack.id,
    packVersion: input.pack.version,
    releaseDigest: input.pack.releaseDigest,
  });
  return writeTrackArtifact({
    projectDir: input.projectDir,
    jobId: resolved.request.jobId,
    key,
    request: resolved.request,
    frames: [],
    // Already built and joined: written as it is (see `WriteTrackInput.built`).
    built: { artifact: merged, residualPx },
    timeBase: [1, TRACK_TIME_BASE_HZ],
    originPts: 0,
  });
}
