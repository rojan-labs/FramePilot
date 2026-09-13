/**
 * Main-process authority for running media-intelligence Capability Pack workers.
 *
 * The renderer never resolves a pack, a media path, or an entrypoint. This
 * service decides which exact installed release answers a requested
 * capability — Tracking Lite for geometric tracking, Subject Intelligence for
 * detection and segmentation — holds a storage lease for the worker's whole
 * lifetime so the pack cannot be evicted mid-run, resolves the signed
 * entrypoint inside the installed root, and returns measurements only.
 *
 * It returns measurements, never a project mutation: converting samples,
 * detections, or mask runs into typed, validated, reversible timeline
 * operations is the controller's job, and workers have no project-write
 * authority at all.
 *
 * When no healthy pack is installed the answer is an explicit install proposal.
 * Work is never faked, and a missing pack never silently downloads.
 */
import { lstat } from 'node:fs/promises';
import {
  runCapabilityPackWorker,
  CapabilityPackWorkerRuntimeError,
  type CapabilityPackLease,
} from '@framepilot/capability-packs/node';
import type {
  CapabilityPackInstallIdentity,
  InstalledCapabilityPack,
} from '@framepilot/capability-packs';
import type {
  CapabilityPackWorkerProgress,
  CapabilityPackWorkerRequest,
  CapabilityPackWorkerResult,
} from '@framepilot/capability-packs';
import { createLogger, type CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import { compareSemver, resolveInside } from './pack-paths.js';

const log = createLogger('desktop:capability-packs:tracking');

/** The packs that provide media intelligence. Their rosters are fixed and health-verified. */
export const TRACKING_PACK_ID = 'framepilot.tracking-lite';
export const TRACKING_CAPABILITIES = [
  'tracking.point',
  'tracking.region',
  'tracking.planar',
] as const;
export type TrackingCapability = (typeof TRACKING_CAPABILITIES)[number];
export const SUBJECT_PACK_ID = 'framepilot.subject-intelligence';
export const SUBJECT_CAPABILITIES = ['subject.detect', 'subject.segment'] as const;
export type SubjectCapability = (typeof SUBJECT_CAPABILITIES)[number];
export type PackJobCapability = TrackingCapability | SubjectCapability;

interface PackJobBinding {
  readonly packId: string;
  readonly entrypointByPlatform: Readonly<Record<'darwin' | 'win32', string>>;
  /**
   * Weights-backed packs keep their models inside the install root; the worker
   * resolves `<FRAMEPILOT_CAPABILITY_PACK_ROOT>/models` itself.
   */
  readonly extraEnvironment?: (installRoot: string) => Readonly<Record<string, string>>;
}

const PACK_BY_CAPABILITY: Readonly<Record<PackJobCapability, PackJobBinding>> = {
  'tracking.point': { packId: TRACKING_PACK_ID, entrypointByPlatform: ENTRYPOINT('framepilot-tracking-lite') },
  'tracking.region': { packId: TRACKING_PACK_ID, entrypointByPlatform: ENTRYPOINT('framepilot-tracking-lite') },
  'tracking.planar': { packId: TRACKING_PACK_ID, entrypointByPlatform: ENTRYPOINT('framepilot-tracking-lite') },
  'subject.detect': {
    packId: SUBJECT_PACK_ID,
    entrypointByPlatform: ENTRYPOINT('framepilot-subject-intelligence'),
    extraEnvironment: (installRoot) => ({ FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot }),
  },
  'subject.segment': {
    packId: SUBJECT_PACK_ID,
    entrypointByPlatform: ENTRYPOINT('framepilot-subject-intelligence'),
    extraEnvironment: (installRoot) => ({ FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot }),
  },
};

function ENTRYPOINT(name: string): Readonly<Record<'darwin' | 'win32', string>> {
  return { darwin: `bin/${name}`, win32: `bin/${name}.exe` };
}

export interface TrackingPackStore {
  list(): Promise<readonly InstalledCapabilityPack[]>;
  acquireLease(identity: CapabilityPackInstallIdentity): Promise<CapabilityPackLease>;
}

export interface CapabilityPackTrackingServiceOptions {
  readonly storageRoot: string;
  readonly store: TrackingPackStore;
  readonly platform: { readonly os: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' };
  /** Typed install proposal for a capability the machine does not have yet. */
  readonly propose: (capabilityId: string) => Promise<CapabilityPackProposalResultWire>;
  readonly runWorker?: typeof runCapabilityPackWorker;
  readonly exists?: (absolutePath: string) => Promise<boolean>;
}

export interface TrackingRunOptions {
  /** The host's authoritative project revision at request time. */
  readonly projectRevision: number;
  /** Approved project media root; the worker client re-checks it through realpath. */
  readonly mediaRoot: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CapabilityPackWorkerProgress) => void;
}

export type TrackingRunOutcome =
  | {
      readonly status: 'completed';
      readonly identity: CapabilityPackInstallIdentity;
      readonly result: CapabilityPackWorkerResult;
    }
  | { readonly status: 'pack_missing'; readonly proposal: CapabilityPackProposalResultWire }
  | {
      readonly status: 'failed';
      readonly code: TrackingFailureCode;
      readonly detail: string;
      readonly retryable: boolean;
    };

export type TrackingFailureCode =
  | 'cancelled'
  | 'stale_revision'
  | 'pack_unhealthy'
  | 'pack_incomplete'
  | 'media_rejected'
  | 'worker_failed'
  | 'timed_out';

export class CapabilityPackTrackingService {
  private readonly options: CapabilityPackTrackingServiceOptions;

  public constructor(options: CapabilityPackTrackingServiceOptions) {
    this.options = options;
  }

  /**
   * Resolve the exact installed pack and run one tracking request in one process.
   *
   * The lease is held across the whole worker lifetime and released in `finally`,
   * so a crashed or cancelled worker can never strand a pack as un-evictable.
   */
  public async run(
    request: CapabilityPackWorkerRequest,
    options: TrackingRunOptions,
  ): Promise<TrackingRunOutcome> {
    const binding = PACK_BY_CAPABILITY[request.capability as PackJobCapability];
    if (binding === undefined) {
      return failed('worker_failed', `${request.capability} is not a pack-job capability.`, false);
    }
    // The host's revision is authoritative. A request compiled against an older
    // project must not silently produce a track for a timeline that has moved.
    if (request.projectRevision !== options.projectRevision) {
      return failed(
        'stale_revision',
        `Request was built for project revision ${request.projectRevision}, but the project is at ${options.projectRevision}.`,
        true,
      );
    }
    const installed = await this.options.store.list();
    const record = resolveInstalledPack(installed, binding.packId);
    if (record === undefined) {
      // Present but unusable is a different problem from absent, and repairing a
      // quarantined pack is not the same action as installing a missing one.
      const present = installed.some((candidate) => candidate.identity.id === binding.packId);
      if (present) {
        return failed(
          'pack_unhealthy',
          `The installed ${binding.packId} pack is quarantined, being removed, or failed its health check. Repair it in Settings › Storage.`,
          false,
        );
      }
      return { status: 'pack_missing', proposal: await this.options.propose(request.capability) };
    }
    let entrypoint: string;
    let installRoot: string;
    try {
      installRoot = this.installRoot(record);
      entrypoint = await this.resolveEntrypoint(record, binding);
    } catch (error) {
      return failed('pack_incomplete', errorMessage(error), false);
    }
    const lease = await this.options.store.acquireLease(record.identity);
    try {
      const runWorker = this.options.runWorker ?? runCapabilityPackWorker;
      const runOne = (
        chunk: CapabilityPackWorkerRequest,
        onProgress: ((progress: CapabilityPackWorkerProgress) => void) | undefined,
      ): Promise<CapabilityPackWorkerResult> =>
        runWorker({
          entrypoint,
          mediaRoot: options.mediaRoot,
          request: chunk,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(binding.extraEnvironment === undefined
            ? {}
            : { extraEnvironment: binding.extraEnvironment(installRoot) }),
          ...(onProgress === undefined ? {} : { onProgress }),
        });
      const result =
        request.capability === 'subject.segment'
          ? await runSegmentationInChunks(request, runOne, options.onProgress)
          : await runOne(request, options.onProgress);
      log.action('trackingComplete', {
        capability: request.capability,
        pack: record.identity.version,
        samples: 'samples' in result ? result.samples.length : 0,
        detections: 'detections' in result ? result.detections.length : 0,
        masks: 'masks' in result ? result.masks.length : 0,
      });
      return { status: 'completed', identity: record.identity, result };
    } catch (error) {
      return failed(...classify(error));
    } finally {
      await lease.release();
    }
  }

  private installRoot(record: InstalledCapabilityPack): string {
    return resolveInside(this.options.storageRoot, record.installRelativePath);
  }

  private async resolveEntrypoint(
    record: InstalledCapabilityPack,
    binding: PackJobBinding,
  ): Promise<string> {
    const entrypoint = resolveInside(
      this.installRoot(record),
      binding.entrypointByPlatform[this.options.platform.os],
    );
    const exists = this.options.exists ?? defaultExists;
    if (!(await exists(entrypoint))) {
      throw new Error(`The installed ${binding.packId} pack is missing its signed worker executable.`);
    }
    return entrypoint;
  }
}

/**
 * Longest frame span one `subject.segment` worker run may cover.
 *
 * The worker answers in ONE JSON line capped at 1 MiB, and each RLE silhouette
 * (≤512px long edge) costs roughly 5 KB — so ~200 frames overflowed and the
 * whole run failed. 150 frames keeps a full-detail run well under the cap.
 */
export const SEGMENT_CHUNK_FRAMES = 150;

type RunOneWorker = (
  request: CapabilityPackWorkerRequest,
  onProgress: ((progress: CapabilityPackWorkerProgress) => void) | undefined,
) => Promise<CapabilityPackWorkerResult>;

/**
 * Run a segmentation as consecutive ≤{@link SEGMENT_CHUNK_FRAMES} requests and
 * concatenate the masks. Each chunk is an exact sub-range of the approved
 * request (same id, revision, media handle), so the worker client's identity
 * checks still apply per run; progress is reported against the whole range.
 */
async function runSegmentationInChunks(
  request: Extract<CapabilityPackWorkerRequest, { capability: 'subject.segment' }>,
  runOne: RunOneWorker,
  onProgress: ((progress: CapabilityPackWorkerProgress) => void) | undefined,
): Promise<CapabilityPackWorkerResult> {
  const { media } = request;
  const totalFrames = media.lastFrameExclusive - media.firstFrame;
  if (totalFrames <= SEGMENT_CHUNK_FRAMES) return runOne(request, onProgress);
  const masks: Extract<CapabilityPackWorkerResult, { masks: unknown }>['masks'][number][] = [];
  let last: Extract<CapabilityPackWorkerResult, { masks: unknown }> | undefined;
  for (let first = media.firstFrame; first < media.lastFrameExclusive; first += SEGMENT_CHUNK_FRAMES) {
    const end = Math.min(first + SEGMENT_CHUNK_FRAMES, media.lastFrameExclusive);
    const done = first - media.firstFrame;
    const chunk: CapabilityPackWorkerRequest = {
      ...request,
      media: {
        ...media,
        firstFrame: first,
        lastFrameExclusive: end,
        sourceStartSeconds: media.sourceStartSeconds + done / media.fps,
        sourceEndSeconds: media.sourceStartSeconds + (end - media.firstFrame) / media.fps,
      },
    };
    const result = await runOne(
      chunk,
      onProgress === undefined
        ? undefined
        : (progress) =>
            onProgress({
              ...progress,
              completed: Math.min(totalFrames, done + progress.completed),
              total: totalFrames,
            }),
    );
    if (!('masks' in result)) return result;
    masks.push(...result.masks);
    last = result;
  }
  return { ...last!, masks };
}

/** The newest healthy, fully installed release of one pack. Quarantined or removing packs never run. */
function resolveInstalledPack(
  records: readonly InstalledCapabilityPack[],
  packId: string,
): InstalledCapabilityPack | undefined {
  return records
    .filter(
      (record) =>
        record.identity.id === packId &&
        record.state === 'installed' &&
        record.health.status === 'healthy',
    )
    .sort((left, right) => compareSemver(right.identity.version, left.identity.version))[0];
}

function classify(error: unknown): [TrackingFailureCode, string, boolean] {
  if (error instanceof CapabilityPackWorkerRuntimeError) {
    switch (error.code) {
      case 'cancelled':
        return ['cancelled', error.message, false];
      case 'timed_out':
        return ['timed_out', error.message, true];
      case 'media_escape':
        return ['media_rejected', error.message, false];
      default:
        // `target_lost`, `media_unreadable` and friends arrive as the worker's own
        // typed code; they are honest outcomes, not infrastructure faults.
        return ['worker_failed', workerDetail(error), isRetryableWorkerFault(error)];
    }
  }
  return ['worker_failed', errorMessage(error), false];
}

/**
 * An `internal_error` is retryable unless it is a size bound: the same request
 * over the same media produces the same oversized output every time, so
 * offering "retry" would only repeat the failure.
 */
function isRetryableWorkerFault(error: CapabilityPackWorkerRuntimeError): boolean {
  if (error.workerCode !== 'internal_error') return false;
  return !/exceeded its .*bound/i.test(error.message);
}

function workerDetail(error: CapabilityPackWorkerRuntimeError): string {
  return error.workerCode === undefined ? error.message : `${error.workerCode}: ${error.message}`;
}

function failed(
  code: TrackingFailureCode,
  detail: string,
  retryable: boolean,
): TrackingRunOutcome {
  return { status: 'failed', code, detail, retryable };
}

async function defaultExists(absolutePath: string): Promise<boolean> {
  try {
    return (await lstat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
