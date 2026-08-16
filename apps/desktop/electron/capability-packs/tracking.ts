/**
 * Main-process authority for running the Tracking Lite Capability Pack worker.
 *
 * The renderer never resolves a pack, a media path, or an entrypoint. This
 * service decides which exact installed release answers a tracking capability,
 * holds a storage lease for the worker's whole lifetime so the pack cannot be
 * evicted mid-track, resolves the signed entrypoint inside the installed root,
 * and returns measurements only.
 *
 * It returns measurements, never a project mutation: converting samples into a
 * typed, validated, reversible timeline operation is the controller's job, and
 * the worker has no project-write authority at all.
 *
 * When no healthy pack is installed the answer is an explicit install proposal.
 * Tracking is never faked, and a missing pack never silently downloads.
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

/** The pack that provides automatic tracking. Its roster is fixed and health-verified. */
export const TRACKING_PACK_ID = 'framepilot.tracking-lite';
export const TRACKING_CAPABILITIES = [
  'tracking.point',
  'tracking.region',
  'tracking.planar',
] as const;
export type TrackingCapability = (typeof TRACKING_CAPABILITIES)[number];

const ENTRYPOINT_BY_PLATFORM: Readonly<Record<'darwin' | 'win32', string>> = {
  darwin: 'bin/framepilot-tracking-lite',
  win32: 'bin/framepilot-tracking-lite.exe',
};

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
    if (!isTrackingCapability(request.capability)) {
      return failed('worker_failed', `${request.capability} is not a tracking capability.`, false);
    }
    // The host's revision is authoritative. A request compiled against an older
    // project must not silently produce a track for a timeline that has moved.
    if (request.projectRevision !== options.projectRevision) {
      return failed(
        'stale_revision',
        `Tracking request was built for project revision ${request.projectRevision}, but the project is at ${options.projectRevision}.`,
        true,
      );
    }
    const installed = await this.options.store.list();
    const record = resolveInstalledPack(installed);
    if (record === undefined) {
      // Present but unusable is a different problem from absent, and repairing a
      // quarantined pack is not the same action as installing a missing one.
      const present = installed.some((candidate) => candidate.identity.id === TRACKING_PACK_ID);
      if (present) {
        return failed(
          'pack_unhealthy',
          'The installed Tracking Lite pack is quarantined, being removed, or failed its health check. Repair it in Settings › Storage.',
          false,
        );
      }
      return { status: 'pack_missing', proposal: await this.options.propose(request.capability) };
    }
    let entrypoint: string;
    try {
      entrypoint = await this.resolveEntrypoint(record);
    } catch (error) {
      return failed('pack_incomplete', errorMessage(error), false);
    }
    const lease = await this.options.store.acquireLease(record.identity);
    try {
      const runWorker = this.options.runWorker ?? runCapabilityPackWorker;
      const result = await runWorker({
        entrypoint,
        mediaRoot: options.mediaRoot,
        request,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      log.action('trackingComplete', {
        capability: request.capability,
        pack: record.identity.version,
        samples: 'samples' in result ? result.samples.length : 0,
      });
      return { status: 'completed', identity: record.identity, result };
    } catch (error) {
      return failed(...classify(error));
    } finally {
      await lease.release();
    }
  }

  private async resolveEntrypoint(record: InstalledCapabilityPack): Promise<string> {
    const installRoot = resolveInside(this.options.storageRoot, record.installRelativePath);
    const entrypoint = resolveInside(installRoot, ENTRYPOINT_BY_PLATFORM[this.options.platform.os]);
    const exists = this.options.exists ?? defaultExists;
    if (!(await exists(entrypoint))) {
      throw new Error('The installed Tracking Lite pack is missing its signed worker executable.');
    }
    return entrypoint;
  }
}

/** The newest healthy, fully installed release. Quarantined or removing packs never run. */
function resolveInstalledPack(
  records: readonly InstalledCapabilityPack[],
): InstalledCapabilityPack | undefined {
  return records
    .filter(
      (record) =>
        record.identity.id === TRACKING_PACK_ID &&
        record.state === 'installed' &&
        record.health.status === 'healthy',
    )
    .sort((left, right) => compareSemver(right.identity.version, left.identity.version))[0];
}

function isTrackingCapability(capability: string): capability is TrackingCapability {
  return (TRACKING_CAPABILITIES as readonly string[]).includes(capability);
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
        return ['worker_failed', workerDetail(error), error.workerCode === 'internal_error'];
    }
  }
  return ['worker_failed', errorMessage(error), false];
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
