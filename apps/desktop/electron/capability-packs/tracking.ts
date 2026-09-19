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
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { negotiatePackRequest } from '@framepilot/capability-packs';
import {
  runCapabilityPackWorker,
  CapabilityPackWorkerRuntimeError,
  killWorkerGroup,
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
import {
  createLogger,
  maskingEventPayload,
  type CapabilityPackProposalResultWire,
} from '@framepilot/shared-types';
import { freeDiskBytes } from './matte-disk.js';
import { compareSemver, resolveInside } from './pack-paths.js';
import { VISUAL_EMBED_PACK_ID } from './visual-packs.js';
import {
  processGroupFootprint,
  stagingBytes,
  watchdogLimits,
  WorkerWatchdog,
  type WatchdogBreach,
} from './worker-watchdog.js';

const log = createLogger('desktop:capability-packs:tracking');

/**
 * The most a tracking/detection/segmentation/embedding job's temp folder may hold. These packs
 * write no artifact (the host writes the track), so anything on disk is the worker's own temp
 * files; a job that needs more than this is misbehaving.
 */
export const PACK_JOB_TEMP_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

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
/**
 * Visual Embed run directly by the host — only for scoring detection crops against a text query
 * (AM2.5 colour re-ranking). Shot-ledger indexing still runs the pack through the engine.
 */
export const VISUAL_EMBED_CAPABILITIES = ['visual.embed', 'visual.text'] as const;
export type VisualEmbedCapability = (typeof VISUAL_EMBED_CAPABILITIES)[number];
export type PackJobCapability = TrackingCapability | SubjectCapability | VisualEmbedCapability;

interface PackJobBinding {
  readonly packId: string;
  readonly entrypointByPlatform: Readonly<Record<'darwin' | 'win32', string>>;
  /**
   * Weights-backed packs keep their models inside the install root; the worker
   * resolves `<FRAMEPILOT_CAPABILITY_PACK_ROOT>/models` itself.
   */
  readonly extraEnvironment?: (installRoot: string) => Readonly<Record<string, string>>;
  /**
   * The pack keeps derived data (Visual Embed: its prompt-bank vectors) in the host's per-release
   * cache folder, `FRAMEPILOT_CAPABILITY_PACK_CACHE` — the folder the engine's shot-ledger runs of
   * the same pack already get (`visual-packs.ts`). Without it every colour re-rank re-encoded the
   * 43-sentence bank, loading the text tower in a process that only embeds crops (AM2.6).
   */
  readonly derivedCache?: boolean;
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
  'visual.embed': {
    packId: VISUAL_EMBED_PACK_ID,
    entrypointByPlatform: ENTRYPOINT('framepilot-visual-embed'),
    extraEnvironment: (installRoot) => ({ FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot }),
    derivedCache: true,
  },
  'visual.text': {
    packId: VISUAL_EMBED_PACK_ID,
    entrypointByPlatform: ENTRYPOINT('framepilot-visual-embed'),
    extraEnvironment: (installRoot) => ({ FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot }),
    derivedCache: true,
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
  /** Writable parent of each pack release's derived cache (`<root>/<packId>/<version>`). */
  readonly cacheRoot?: string;
  readonly ensureDirectory?: (absolutePath: string) => Promise<void>;
  /**
   * Watchdog overrides (BR4.12 H2 for pack jobs; follow-up review). Production samples the
   * process group, uses `os.totalmem()` and a private temp folder under the OS temp directory.
   */
  readonly watchdog?: {
    readonly footprintBytes?: (pid: number) => Promise<number | undefined>;
    readonly totalMemoryBytes?: number;
    readonly stallMs?: number;
    readonly intervalMs?: number;
    readonly now?: () => number;
    readonly killGroup?: (pid: number | undefined) => void;
    readonly tempBudgetBytes?: number;
    readonly freeDiskBytes?: (directory: string) => Promise<number>;
    /** Where each job's private temp folder is made (default: the OS temp directory). */
    readonly temporaryRoot?: string;
  };
}

export interface TrackingRunOptions {
  /** The host's authoritative project revision at request time. */
  readonly projectRevision: number;
  /** Approved project media root; the worker client re-checks it through realpath. */
  readonly mediaRoot: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CapabilityPackWorkerProgress) => void;
  /**
   * What a missing pack means to this caller. `propose` (the default) builds the signed install
   * proposal for the editor. `skip` is for OPTIONAL evidence the editor never asked for — the
   * colour re-ranker — which answers `pack_absent` without touching the catalog.
   */
  readonly whenMissing?: 'propose' | 'skip';
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
  /** No such pack is installed, and the caller asked not to be offered one (`whenMissing`). */
  | 'pack_absent'
  | 'pack_incomplete'
  /** The installed release predates a request field the host needs (AM2.5 negotiation). */
  | 'pack_outdated'
  | 'media_rejected'
  | 'worker_failed'
  | 'timed_out'
  /** The host watchdog stopped the worker (memory, no progress, or its temp folder). */
  | 'resource_exhausted';

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
      if (options.whenMissing === 'skip') {
        return failed('pack_absent', `${binding.packId} is not installed.`, false);
      }
      return { status: 'pack_missing', proposal: await this.options.propose(request.capability) };
    }
    // Fit the request to THIS release: an older pack's strict parser refuses a field it
    // predates, so an enrichment is dropped and a requirement is refused before any spawn.
    const negotiated = negotiatePackRequest(request, record.identity.version);
    if (negotiated.status === 'pack_outdated') {
      return failed('pack_outdated', negotiated.detail, false);
    }
    if (negotiated.request !== request) {
      log.debug('requestNegotiated', {
        capability: request.capability,
        pack: record.identity.version,
      });
    }
    let entrypoint: string;
    let installRoot: string;
    try {
      installRoot = this.installRoot(record);
      entrypoint = await this.resolveEntrypoint(record, binding);
    } catch (error) {
      return failed('pack_incomplete', errorMessage(error), false);
    }
    const environment = await this.workerEnvironment(binding, record, installRoot);
    const lease = await this.options.store.acquireLease(record.identity);
    const started = Date.now();
    const guard = await this.startWatchdog(binding.packId, options.signal);
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
          signal: guard.signal,
          temporaryDirectory: guard.temporaryDirectory,
          onSpawn: guard.attach,
          onProgress: (progress) => {
            guard.watchdog.progress();
            onProgress?.(progress);
          },
          ...(environment === undefined ? {} : { extraEnvironment: environment }),
        });
      const sent = negotiated.request;
      const result =
        sent.capability === 'subject.segment'
          ? await runSegmentationInChunks(sent, runOne, options.onProgress)
          : await runOne(sent, options.onProgress);
      if (guard.watchdog.breach !== undefined) return resourceExhausted(guard.watchdog.breach);
      log.action(
        'trackingComplete',
        maskingEventPayload('trackingComplete', {
          capability: request.capability,
          pack: record.identity.version,
          samples: 'samples' in result ? result.samples.length : 0,
          detections: 'detections' in result ? result.detections.length : 0,
          masks: 'masks' in result ? result.masks.length : 0,
          elapsedMs: Date.now() - started,
        }),
      );
      return { status: 'completed', identity: record.identity, result };
    } catch (error) {
      if (guard.watchdog.breach !== undefined) return resourceExhausted(guard.watchdog.breach);
      return failed(...classify(error));
    } finally {
      await guard.stop();
      await lease.release();
    }
  }

  /**
   * The same host watchdog a matte job has (BR4.12 H2): the worker's process-group footprint
   * ≤ min(pack limit, 0.6 × RAM), no progress for 5 minutes, and its private temp folder (the
   * only place these packs write; TMPDIR/TEMP/TMP point there) ≤ min(budget, free − 1 GB). A
   * breach kills the group and the job answers `resource_exhausted`.
   */
  private async startWatchdog(
    packId: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<{
    readonly watchdog: WorkerWatchdog;
    readonly signal: AbortSignal;
    readonly temporaryDirectory: string;
    readonly attach: (pid: number) => void;
    readonly stop: () => Promise<void>;
  }> {
    const settings = this.options.watchdog ?? {};
    const temporaryDirectory = await mkdtemp(
      path.join(settings.temporaryRoot ?? tmpdir(), 'framepilot-pack-'),
    );
    const free = await (settings.freeDiskBytes ?? freeDiskBytes)(temporaryDirectory).catch(
      () => undefined,
    );
    const budget = settings.tempBudgetBytes ?? PACK_JOB_TEMP_BUDGET_BYTES;
    // Its own controller, so a breach ends the worker without looking like the caller's cancel.
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    callerSignal?.addEventListener('abort', forward, { once: true });
    if (callerSignal?.aborted === true) controller.abort();
    let workerPid: number | undefined;
    const watchdog = new WorkerWatchdog(
      watchdogLimits({
        packId,
        totalMemoryBytes: settings.totalMemoryBytes ?? totalmem(),
        byteCeiling: budget,
        freeBytesAtStart: free,
        stagingBudgetBytes: budget,
        ...(settings.stallMs === undefined ? {} : { stallMs: settings.stallMs }),
      }),
      {
        footprintBytes: settings.footprintBytes ?? processGroupFootprint(),
        directoryBytes: stagingBytes,
        now: settings.now ?? Date.now,
      },
      {
        stagingDirectory: temporaryDirectory,
        ...(settings.intervalMs === undefined ? {} : { intervalMs: settings.intervalMs }),
        onBreach: () => {
          (settings.killGroup ?? killWorkerGroup)(workerPid);
          controller.abort();
        },
      },
    );
    watchdog.start();
    return {
      watchdog,
      signal: controller.signal,
      temporaryDirectory,
      attach: (pid) => {
        workerPid = pid;
        watchdog.attach(pid);
        // A segmentation runs one process per chunk: each starts with a fresh stall window.
        watchdog.progress();
      },
      stop: async () => {
        watchdog.stop();
        callerSignal?.removeEventListener('abort', forward);
        try {
          await rm(temporaryDirectory, { recursive: true, force: true });
        } catch (error) {
          // Code only: the path is the user's temp folder.
          log.warn('packTempRemoveFailed', {
            code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown',
          });
        }
      },
    };
  }

  /** The binding's extras, plus the release's derived-cache folder when it keeps one. */
  private async workerEnvironment(
    binding: PackJobBinding,
    record: InstalledCapabilityPack,
    installRoot: string,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const extras = binding.extraEnvironment?.(installRoot);
    const { cacheRoot } = this.options;
    if (binding.derivedCache !== true || cacheRoot === undefined) return extras;
    const cache = path.join(cacheRoot, binding.packId, record.identity.version);
    try {
      await (this.options.ensureDirectory ?? defaultEnsureDirectory)(cache);
    } catch (error) {
      // A cache is an optimisation: without it the pack recomputes, it does not fail.
      // Error name only: fs messages carry the user's app-data path.
      log.warn('packCacheUnavailable', {
        pack: binding.packId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return extras;
    }
    return { ...extras, FRAMEPILOT_CAPABILITY_PACK_CACHE: cache };
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

const RESOURCE_REMEDIES: Readonly<Record<WatchdogBreach, string>> = {
  memory: 'The pack needed more memory than this computer can spare and was stopped. Close other apps or use a shorter range.',
  stalled: 'The pack stopped responding and was stopped. Try again.',
  disk: 'The pack was writing more temporary data than allowed and was stopped. Free up space and try again.',
};

function resourceExhausted(breach: WatchdogBreach): TrackingRunOutcome {
  return failed('resource_exhausted', RESOURCE_REMEDIES[breach], breach !== 'memory');
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
 *
 * A worker that refuses to emit an over-large result line reports the stable
 * `output_too_large` failure code (see `worker-protocol.ts`) — branch on that
 * directly rather than matching `detail` text. The message-text match below is
 * kept only as a fallback for packs installed before that code existed, which
 * still report the same overflow as a generic `internal_error`.
 */
function isRetryableWorkerFault(error: CapabilityPackWorkerRuntimeError): boolean {
  if (error.workerCode === 'output_too_large') return false;
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

async function defaultEnsureDirectory(absolutePath: string): Promise<void> {
  await mkdir(absolutePath, { recursive: true });
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
