/**
 * Build a worker tracking request from a renderer intent and the project authority.
 *
 * The renderer states *what* to track — an asset id, a frame range, a normalized
 * point/box/quad. It never states *where* the media is. Main resolves the path
 * from the project it just read from disk, so a compromised or buggy renderer
 * cannot aim a worker at an arbitrary file, and the worker client's realpath
 * sandbox becomes a second line of defence rather than the only one.
 *
 * Geometry is validated by the frozen protocol schema before anything spawns, so
 * pixel-shaped or out-of-frame coordinates fail here rather than inside a worker.
 */
import path from 'node:path';
import {
  CapabilityPackWorkerRequestSchema,
  type CapabilityPackWorkerRequest,
} from '@framepilot/capability-packs';
import type { Project } from '@framepilot/timeline-schema';

/** Renderer-supplied intent. Deliberately has no path and no source range. */
export interface TrackingRequestIntent {
  readonly requestId: string;
  readonly assetId: string;
  readonly capability: 'tracking.point' | 'tracking.region' | 'tracking.planar';
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly fps: number;
  readonly parameters: unknown;
}

export type TrackingRequestRejectionCode =
  | 'invalid_intent'
  | 'missing_asset'
  | 'wrong_asset_kind'
  | 'range_outside_media'
  | 'invalid_geometry';

export type TrackingRequestBuildResult =
  | {
      readonly status: 'built';
      readonly request: CapabilityPackWorkerRequest;
      /** Directory the worker client will constrain the media path to. */
      readonly mediaRoot: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: TrackingRequestRejectionCode;
      readonly detail: string;
    };

function rejected(
  code: TrackingRequestRejectionCode,
  detail: string,
): TrackingRequestBuildResult {
  return { status: 'rejected', code, detail };
}

function isIntent(value: unknown): value is TrackingRequestIntent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TrackingRequestIntent>;
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.assetId === 'string' &&
    typeof candidate.capability === 'string' &&
    typeof candidate.firstFrame === 'number' &&
    typeof candidate.lastFrameExclusive === 'number' &&
    typeof candidate.fps === 'number' &&
    candidate.parameters !== undefined
  );
}

export function buildTrackingWorkerRequest(
  project: Project,
  projectRevision: number,
  intent: unknown,
): TrackingRequestBuildResult {
  if (!isIntent(intent)) return rejected('invalid_intent', 'Tracking request is malformed.');
  if (
    !Number.isInteger(intent.firstFrame) ||
    !Number.isInteger(intent.lastFrameExclusive) ||
    intent.firstFrame < 0 ||
    intent.lastFrameExclusive <= intent.firstFrame ||
    !Number.isFinite(intent.fps) ||
    intent.fps <= 0
  ) {
    return rejected('invalid_intent', 'Tracking frame range and fps must be positive.');
  }
  const asset = project.assets?.find((candidate) => candidate.id === intent.assetId);
  if (asset === undefined) {
    return rejected('missing_asset', `Asset "${intent.assetId}" is not in this project.`);
  }
  if (asset.kind !== 'video') {
    return rejected('wrong_asset_kind', 'Only video assets can be tracked.');
  }
  if (!path.isAbsolute(asset.path)) {
    return rejected('missing_asset', 'The project asset has no resolved absolute media path.');
  }
  const sourceStartSeconds = intent.firstFrame / intent.fps;
  const sourceEndSeconds = intent.lastFrameExclusive / intent.fps;
  if (
    asset.durationSeconds !== undefined &&
    asset.durationSeconds > 0 &&
    sourceEndSeconds > asset.durationSeconds + 1 / intent.fps
  ) {
    return rejected(
      'range_outside_media',
      `The tracked range ends at ${sourceEndSeconds.toFixed(3)}s but the media is ${asset.durationSeconds}s long.`,
    );
  }
  const parsed = CapabilityPackWorkerRequestSchema.safeParse({
    type: 'request',
    protocolVersion: 1,
    requestId: intent.requestId,
    projectRevision,
    capability: intent.capability,
    media: {
      handleId: intent.requestId,
      assetId: asset.id,
      absolutePath: asset.path,
      sourceStartSeconds,
      sourceEndSeconds,
      fps: intent.fps,
      firstFrame: intent.firstFrame,
      lastFrameExclusive: intent.lastFrameExclusive,
    },
    parameters: intent.parameters,
  });
  if (!parsed.success) {
    return rejected(
      'invalid_geometry',
      parsed.error.issues[0]?.message ?? 'Tracking request failed protocol validation.',
    );
  }
  return { status: 'built', request: parsed.data, mediaRoot: path.dirname(asset.path) };
}
