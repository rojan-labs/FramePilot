/**
 * Main-process authority for background-removal jobs (`subject.matte`, plan 03, BR4.3).
 *
 * The renderer states what to matte (asset, source range, prompts, the revision it saw). This
 * service resolves everything else and owns the whole lifecycle:
 *
 *   validate intent → re-check revision → resolve asset + decoded timing → cache key
 *   → cache hit? (record + digests) → resolve the Smart Mask pack (proposal when missing)
 *   → staging dir + host-written inputs → worker (lease held, cancellable, progress)
 *   → host verification → revision re-check → atomic commit → record → result
 *
 * It returns an artifact descriptor, never a project mutation: turning it into an undoable
 * `add_mask` patch is editor-core's job. Nothing downloads without approval, and a job that
 * fails or is cancelled leaves no staging directory behind.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  MatteRunIntentSchema,
  type CapabilityPackInstallIdentity,
  type CapabilityPackWorkerProgress,
  type CapabilityPackWorkerRequest,
  type InstalledCapabilityPack,
  type MatteArtifactFileName,
  type MatteArtifactRecord,
  type MattePrompt,
  type MatteRunIntent,
} from '@framepilot/capability-packs';
import {
  CapabilityPackWorkerRuntimeError,
  killWorkerGroup,
  runCapabilityPackWorker,
  type CapabilityPackLease,
} from '@framepilot/capability-packs/node';
import { createLogger, maskingEventPayload, type CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { MatteInspectorError, type MatteMediaInspector, type MatteVideoTiming } from './matte-media-inspector.js';
import { estimateMatteBytes, freeDiskBytes } from './matte-disk.js';
import {
  processGroupFootprint,
  stagingBytes,
  watchdogLimits,
  WorkerWatchdog,
  type WatchdogBreach,
} from './worker-watchdog.js';
import { BRUSH_UNTOUCHED, encodeGrayPng, grayPixelSha256, type GrayPng } from './matte-png.js';
import {
  commitMatteStaging,
  createMatteStaging,
  existingRealDirectory,
  MATTES_RELATIVE_DIR,
  MatteStagingError,
  type MatteStaging,
} from './matte-staging.js';
import {
  MatteStoreError,
  readMatteInput,
  readMatteRecord,
  sourceContentFingerprint,
  writeMatteRecord,
} from './matte-store.js';
import {
  matteByteCeiling,
  MatteVerificationError,
  readMatteFrames,
  sha256File,
  verifyMatteStaging,
  type MatteFramesDocument,
  type MatteLockCheck,
  type SubjectMatteResult,
  type VerifiedMatteFile,
} from './matte-verify.js';
import { compareSemver, projectMediaPath, resolveInside } from './pack-paths.js';

const log = createLogger('desktop:capability-packs:matte');
/** Display rotations the monitor turns a decoded picture by (`Asset.media.rotation`). */
const MONITOR_ROTATIONS = [0, 90, 180, 270] as const;

export const SMART_MASK_PACK_ID = 'framepilot.smart-mask';
export const MATTE_CAPABILITIES = ['subject.matte', 'subject.segment_frame'] as const;
/** Bumped when the host's matte pipeline changes what an artifact means; part of the cache key. */
export const MATTE_PIPELINE_VERSION = 1;
/** Oldest Smart Mask release that speaks `subject.matte`. Older installs get an update proposal. */
export const MATTE_MIN_PACK_VERSION = '1.0.0';
/** Evenly spaced source frames hashed at commit, besides the exact first and last (BR4.10). */
export const MATTE_SOURCE_SAMPLES = 16;
const ENTRYPOINT = { darwin: 'bin/framepilot-smart-mask', win32: 'bin/framepilot-smart-mask.exe' } as const;
/** P17 per-job time limit: a base plus a generous per-frame budget (BR0: ~15 s/frame on CPU). */
const JOB_TIMEOUT_BASE_MS = 30 * 60 * 1_000;
const JOB_TIMEOUT_PER_FRAME_MS = 30_000;
const JOB_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1_000;
/** The frame shown at time t is the last whose pts is at or before t (engine `pts_reader`). */
const PTS_EPSILON_SECONDS = 1e-6;

export interface MattePackStore {
  list(): Promise<readonly InstalledCapabilityPack[]>;
  acquireLease(identity: CapabilityPackInstallIdentity): Promise<CapabilityPackLease>;
}

export interface MatteProgress {
  readonly requestId: string;
  readonly phase: CapabilityPackWorkerProgress['phase'];
  readonly completed: number;
  readonly total: number;
  readonly round?: number;
  readonly etaSeconds?: number;
}

/** What the renderer turns into an `add_mask` (`MatteArtifactSchema` shape). */
export interface MatteArtifactDescriptor {
  readonly key: string;
  readonly files: readonly { readonly name: MatteArtifactFileName; readonly sha256: string }[];
  readonly width: number;
  readonly height: number;
  readonly coverage: { readonly sourceStart: number; readonly sourceEnd: number };
  readonly packId: string;
  readonly packVersion: string;
  readonly modelDigests: readonly string[];
}

export type MatteFailureCode =
  | 'invalid_intent'
  | 'missing_asset'
  | 'unsupported_asset'
  | 'stale_revision'
  | 'job_running'
  | 'cancelled'
  | 'pack_unhealthy'
  | 'pack_incomplete'
  | 'media_rejected'
  | 'media_unreadable'
  | 'target_lost'
  | 'needs_box'
  | 'model_unavailable'
  | 'hardware_unsupported'
  | 'output_unwritable'
  | 'verification_failed'
  | 'worker_failed'
  | 'timed_out'
  | 'insufficient_disk'
  | 'correction_invalid'
  | 'candidate_unresolved'
  | 'resource_exhausted';

export type MatteRunOutcome =
  | {
      readonly status: 'completed';
      readonly artifact: MatteArtifactDescriptor;
      readonly summary: MatteArtifactRecord['summary'];
      readonly needsReview: MatteArtifactRecord['needsReview'];
      readonly executionProvider: MatteArtifactRecord['executionProvider'];
      readonly cacheHit: boolean;
      readonly projectRevision: number;
    }
  | { readonly status: 'pack_missing'; readonly proposal: CapabilityPackProposalResultWire }
  | { readonly status: 'needs_prompt' }
  | {
      readonly status: 'failed';
      readonly code: MatteFailureCode;
      readonly detail: string;
      readonly retryable: boolean;
      /** Set for `verification_failed`: which host check refused the artifact. */
      readonly verificationCode?: string;
      /** Set for `resource_exhausted`: which watchdog limit the job crossed. */
      readonly resourceLimit?: WatchdogBreach;
      /** Set for `insufficient_disk`: the estimate with headroom, and what is free. */
      readonly requiredBytes?: number;
      readonly freeBytes?: number;
    };

/** Host-resolved auto prompt (BR4.5). `undefined` means "ask the editor to click". */
export type MatteAutoPrompt = (context: {
  readonly requestId: string;
  readonly asset: Project['assets'][number];
  /** The clip's first in-range frame: decode-order index, its source seconds and pts. */
  readonly frame: { readonly index: number; readonly seconds: number; readonly pts: number };
  readonly fps: number;
  readonly projectRevision: number;
  readonly mediaRoot: string;
  readonly signal: AbortSignal;
}) => Promise<readonly MattePrompt[] | undefined>;

export interface CapabilityPackMatteServiceOptions {
  readonly storageRoot: string;
  readonly store: MattePackStore;
  readonly platform: { readonly os: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' };
  readonly propose: (capabilityId: string) => Promise<CapabilityPackProposalResultWire>;
  readonly inspector: MatteMediaInspector;
  readonly runWorker?: typeof runCapabilityPackWorker;
  readonly isFile?: (absolutePath: string) => Promise<boolean>;
  readonly autoPrompt?: MatteAutoPrompt;
  readonly now?: () => Date;
  /** Free bytes on the project's volume; injected for tests (BR4.10 preflight). */
  readonly freeDiskBytes?: (directory: string) => Promise<number>;
  /** Watchdog overrides; production uses the platform sampler, `os.totalmem()` and defaults. */
  readonly watchdog?: {
    readonly footprintBytes?: (pid: number) => Promise<number | undefined>;
    readonly totalMemoryBytes?: number;
    readonly stallMs?: number;
    readonly intervalMs?: number;
    readonly now?: () => number;
    readonly killGroup?: (pid: number | undefined) => void;
  };
  /** Receives one privacy-safe report per finished job (BR4.11 diagnostics). */
  readonly observer?: (report: MatteJobReport) => void;
}

/**
 * One job's observability record (BR4.11). An allow-list of outcome facts: status and codes,
 * execution provider, cache hit, flagged ratio, pack version, phase timings. Never paths,
 * media, frames, prompts or project/asset/clip ids.
 */
export interface MatteJobReport {
  readonly at: string;
  readonly status: MatteRunOutcome['status'];
  readonly code?: MatteFailureCode;
  readonly verificationCode?: string;
  readonly cacheHit?: boolean;
  readonly executionProvider?: 'coreml' | 'directml' | 'cpu';
  readonly packVersion?: string;
  readonly verifiedFrames?: number;
  readonly flaggedFrames?: number;
  readonly flaggedRatio?: number;
  readonly phasesMs: Readonly<Record<string, number>>;
  readonly totalMs: number;
}

export function matteJobReport(
  outcome: MatteRunOutcome,
  phases: Readonly<Record<string, number>>,
  totalMs: number,
  at: string,
): MatteJobReport {
  const base = { at, status: outcome.status, phasesMs: { ...phases }, totalMs };
  if (outcome.status === 'failed') {
    return { ...base, code: outcome.code, ...(outcome.verificationCode === undefined ? {} : { verificationCode: outcome.verificationCode }) };
  }
  if (outcome.status !== 'completed') return base;
  const { verifiedFrames, flaggedFrames } = outcome.summary;
  return {
    ...base,
    cacheHit: outcome.cacheHit,
    executionProvider: outcome.executionProvider,
    packVersion: outcome.artifact.packVersion,
    verifiedFrames,
    flaggedFrames,
    flaggedRatio: ratio(flaggedFrames, verifiedFrames + flaggedFrames),
  };
}

function addPhase(phases: Record<string, number>, name: string, elapsedMs: number): void {
  phases[name] = (phases[name] ?? 0) + Math.max(0, elapsedMs);
}

export interface MatteRunContext {
  /** The open project's folder: mattes live in `<projectDir>/.framepilot-derived/mattes`. */
  readonly projectDir: string;
  /** The project as main just read it from disk. */
  readonly project: Project;
  readonly projectRevision: number;
  /** Re-read the saved project when the job finishes (the revision may have moved). */
  readonly readCurrent: () => Promise<{ readonly revision: number; readonly project: Project }>;
  readonly onProgress?: (progress: MatteProgress) => void;
}

interface ResolvedMedia {
  readonly asset: Project['assets'][number];
  readonly timing: MatteVideoTiming;
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly fps: number;
  readonly displaySize?: { readonly width: number; readonly height: number };
  readonly fingerprint: string;
}

export class CapabilityPackMatteService {
  private readonly jobs = new Map<string, AbortController>();
  private readonly previousKeys = new Map<string, string>();
  /** PX5.9: monitor tiers being made in the background. */
  private readonly tierJobs = new Set<Promise<void>>();

  public constructor(private readonly options: CapabilityPackMatteServiceOptions) {}

  /** Job ids with a live run, so the startup/periodic sweep never removes their staging. */
  public activeJobIds(): ReadonlySet<string> {
    return new Set(this.jobs.keys());
  }

  /** Artifacts a running re-run is reading from; storage cleanup must leave them alone. */
  public busyArtifactKeys(): ReadonlySet<string> {
    return new Set(this.previousKeys.values());
  }

  public cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return;
    this.jobs.get(requestId)?.abort();
  }

  public async run(intentInput: unknown, context: MatteRunContext): Promise<MatteRunOutcome> {
    const parsed = MatteRunIntentSchema.safeParse(intentInput);
    if (!parsed.success) {
      return failed('invalid_intent', parsed.error.issues[0]?.message ?? 'Background removal request is malformed.', false);
    }
    const intent = parsed.data;
    if (this.jobs.has(intent.requestId)) {
      return failed('job_running', 'A background removal job with this id is already running.', false);
    }
    const controller = new AbortController();
    this.jobs.set(intent.requestId, controller);
    if (intent.previousArtifactKey !== undefined) this.previousKeys.set(intent.requestId, intent.previousArtifactKey);
    const started = Date.now();
    log.action('matteJobStart', maskingEventPayload('matteJobStart', { prompts: intent.prompts.length, rerun: intent.previousArtifactKey !== undefined }));
    // Phase timings: host phases are marked in runJob; worker phases from progress transitions.
    const phases: Record<string, number> = {};
    let workerPhase: { name: string; at: number } | undefined;
    const trackedContext: MatteRunContext = {
      ...context,
      onProgress: (progress) => {
        const now = Date.now();
        if (workerPhase?.name !== progress.phase) {
          if (workerPhase !== undefined) addPhase(phases, `worker.${workerPhase.name}`, now - workerPhase.at);
          workerPhase = { name: progress.phase, at: now };
        }
        context.onProgress?.(progress);
      },
    };
    try {
      const outcome = await this.runJob(intent, trackedContext, controller.signal, phases);
      if (workerPhase !== undefined) addPhase(phases, `worker.${workerPhase.name}`, Date.now() - workerPhase.at);
      const report = matteJobReport(outcome, phases, Date.now() - started, (this.options.now?.() ?? new Date()).toISOString());
      log.action('matteJobEnd', maskingEventPayload('matteJobEnd', report));
      try {
        this.options.observer?.(report);
      } catch (error) {
        log.warn('matteObserverFailed', { error: error instanceof Error ? error.name : 'unknown' });
      }
      return outcome;
    } finally {
      this.jobs.delete(intent.requestId);
      this.previousKeys.delete(intent.requestId);
    }
  }

  private async runJob(
    intent: MatteRunIntent,
    context: MatteRunContext,
    signal: AbortSignal,
    phases: Record<string, number>,
  ): Promise<MatteRunOutcome> {
    if (intent.timelineRevision !== context.projectRevision) {
      return failed('stale_revision', 'The project changed before background removal started. Try again.', true);
    }
    if (intent.prompts.some((prompt) => prompt.kind === 'candidate')) {
      return failed('candidate_unresolved', 'Pick the subject on the monitor; AI candidates are not available yet.', false);
    }
    const tMedia = Date.now();
    const media = await this.resolveMedia(intent, context, signal);
    addPhase(phases, 'media', Date.now() - tMedia);
    if ('status' in media) return media;

    const pack = await this.resolvePack();
    if (pack.status !== 'ready') return pack.outcome;

    let prompts: MattePrompt[];
    let inputSha: Map<string, readonly string[]>;
    try {
      ({ prompts, inputSha } = this.workerPrompts(intent, media));
    } catch (error) {
      return failed('invalid_intent', errorMessage(error), false);
    }
    if (prompts.length === 0 && intent.previousArtifactKey === undefined) {
      const tAuto = Date.now();
      const auto = await this.options.autoPrompt?.({
        requestId: intent.requestId,
        asset: media.asset,
        frame: {
          index: media.firstFrame,
          seconds: relativeSeconds(media.timing, media.firstFrame),
          pts: media.timing.pts[media.firstFrame]!,
        },
        fps: media.fps,
        projectRevision: context.projectRevision,
        mediaRoot: path.dirname(media.asset.path),
        signal,
      });
      addPhase(phases, 'autoPrompt', Date.now() - tAuto);
      log.action('matteAutoPrompt', { found: auto !== undefined && auto.length > 0, elapsedMs: Date.now() - tAuto });
      if (signal.aborted) return failed('cancelled', 'Background removal cancelled.', false);
      if (auto === undefined || auto.length === 0) return { status: 'needs_prompt' };
      prompts = [...auto];
    }

    const key = matteCacheKey({
      fingerprint: media.fingerprint,
      firstPts: media.timing.pts[media.firstFrame]!,
      lastPts: media.timing.pts[media.firstFrame + media.frameCount - 1]!,
      prompts: canonicalPrompts(prompts, inputSha),
      packId: pack.record.identity.id,
      packVersion: pack.record.identity.version,
      releaseDigest: pack.record.identity.releaseDigest,
      foreground: intent.foreground,
      previewHeight: intent.previewHeight,
    });
    const tCache = Date.now();
    const hit = await this.cacheHit(context.projectDir, key, signal);
    addPhase(phases, 'cache', Date.now() - tCache);
    if (hit !== undefined) {
      log.action('matteCacheHit', {});
      // A hit made before PX5.9 (or whose tier failed) gets its tier now; a current one is cheap.
      this.requestMonitorTier(context.projectDir, hit, media);
      return completed(hit, true, context.projectRevision);
    }

    const preflight = await this.diskPreflight(context.projectDir, media, intent.foreground);
    if (preflight !== undefined) return preflight;

    const tStage = Date.now();
    let staging: MatteStaging;
    try {
      // No live job owns this id (checked in `run`), so a directory it left is an orphan of an
      // app that stopped mid-job: adopt it, keeping the worker's finished windows (BR3.14).
      staging = await createMatteStaging(context.projectDir, intent.requestId, MATTES_RELATIVE_DIR, {
        adoptOrphan: true,
      });
    } catch (error) {
      if (error instanceof MatteStagingError && error.code === 'staging_exists') {
        return failed('job_running', 'A background removal job with this id is already staged.', false);
      }
      return failed('output_unwritable', 'The project folder is not writable. Check the disk and folder permissions.', true);
    }
    let committed = false;
    try {
      const inputs = await this.stageInputs(intent, media, prompts, inputSha, staging, context.projectDir);
      if ('status' in inputs) return inputs;
      const allowedFiles: MatteArtifactFileName[] = [
        'matte.mkv',
        'frames.json',
        'report.json',
        'preview.webm',
        ...(intent.foreground ? (['foreground.mkv', 'foreground.preview.webm'] as const) : []),
      ];
      const size = media.displaySize ?? { width: 8192, height: 8192 };
      const maxBytes = matteByteCeiling(size.width, size.height, media.frameCount, intent.foreground);
      const request = this.buildRequest(intent, context, media, prompts, staging, inputs.files, allowedFiles, maxBytes);
      if ('status' in request) return request;
      addPhase(phases, 'stage', Date.now() - tStage);

      const tWorker = Date.now();
      const result = await this.runWorker(pack.record, request, staging, media, intent.requestId, signal, context.onProgress, {
        projectDir: context.projectDir,
        byteCeiling: maxBytes,
      });
      addPhase(phases, 'worker', Date.now() - tWorker);
      if ('status' in result) return result;

      const tVerify = Date.now();
      context.onProgress?.({ requestId: intent.requestId, phase: 'verify', completed: 0, total: 1 });
      const verified = await verifyMatteStaging({
        directory: staging.directory,
        result,
        allowedFiles,
        maxBytes,
        ...(media.displaySize === undefined ? {} : { expectedSize: media.displaySize }),
        source: { timing: media.timing, firstFrame: media.firstFrame, frameCount: media.frameCount },
        locks: inputs.locks,
        ...(inputs.previous === undefined ? {} : { previous: inputs.previous }),
        inspector: this.options.inspector,
        signal,
      });
      context.onProgress?.({ requestId: intent.requestId, phase: 'verify', completed: 1, total: 1 });
      addPhase(phases, 'verify', Date.now() - tVerify);

      // The project moved while the job ran. The verified artifact is content-addressed and
      // stays valid for this media, so it is kept when the asset still exists (the retry is a
      // cache hit); the RESULT is discarded either way, never applied to a newer timeline.
      const current = await context.readCurrent();
      if (current.revision !== context.projectRevision) {
        if (
          current.project.assets.some(
            (asset) => projectMediaPath(context.projectDir, asset.path) === media.asset.path && asset.id === intent.assetId,
          )
        ) {
          await this.commit(context.projectDir, staging, key, intent, media, pack.record, result, prompts, verified.files, signal);
          committed = true;
        }
        return failed('stale_revision', 'The project changed while background removal ran. Run it again to apply it.', true);
      }
      const tCommit = Date.now();
      const record = await this.commit(context.projectDir, staging, key, intent, media, pack.record, result, prompts, verified.files, signal);
      committed = true;
      addPhase(phases, 'commit', Date.now() - tCommit);
      this.requestMonitorTier(context.projectDir, record, media);
      return completed(record, false, context.projectRevision);
    } catch (error) {
      return classifyFailure(error, signal);
    } finally {
      if (!committed) await staging.discard();
    }
  }

  /**
   * PX5.9 (ADR 0181): ask the sidecar to make the committed artifact's monitor tier at the size
   * the monitor decodes the asset's proxy at, in the background. The tier is an accelerator: it
   * never delays or fails the job, and without it the monitor decodes the masters. Skipped for
   * an asset without a proxy (the monitor's decode size is then the canvas's, not one file's) and
   * for an artifact without a foreground (a tier is made from the foreground too).
   */
  private requestMonitorTier(projectDir: string, record: MatteArtifactRecord, media: ResolvedMedia): void {
    const derive = this.options.inspector.deriveMonitorTier?.bind(this.options.inspector);
    const proxyPath = media.asset.media?.proxyPath;
    if (derive === undefined || media.asset.kind !== 'video' || proxyPath == null || proxyPath === '') return;
    if (!record.files.some((file) => file.name === 'foreground.mkv')) return;
    const rotation = MONITOR_ROTATIONS.find((value) => value === (media.asset.media?.rotation ?? 0)) ?? 0;
    const started = Date.now();
    const job = derive({
      projectDir,
      artifact: {
        key: record.key,
        files: record.files.map((file) => ({ name: file.name, sha256: file.sha256 })),
        width: record.width,
        height: record.height,
      },
      proxyPath,
      rotation,
      frameCount: media.frameCount,
    })
      .then((tier) => {
        log.action(
          'matteMonitorTier',
          maskingEventPayload('matteMonitorTier', {
            status: tier.status,
            width: tier.width,
            height: tier.height,
            alpha: tier.alpha,
            elapsedMs: Date.now() - started,
          }),
        );
      })
      .catch((error: unknown) => {
        // Codes only: a message could carry a path.
        log.warn(
          'matteMonitorTierFailed',
          maskingEventPayload('matteMonitorTierFailed', {
            code: error instanceof MatteInspectorError ? error.code : 'error',
            elapsedMs: Date.now() - started,
          }),
        );
      })
      .finally(() => this.tierJobs.delete(job));
    this.tierJobs.add(job);
  }

  /** Wait for every monitor tier this service started (tests, and an orderly shutdown). */
  public async settleMonitorTiers(): Promise<void> {
    await Promise.all([...this.tierJobs]);
  }

  /** Refuse to start when the estimate (BR0 storage per minute × 1.2) exceeds free space. */
  private async diskPreflight(
    projectDir: string,
    media: ResolvedMedia,
    foreground: boolean,
  ): Promise<Extract<MatteRunOutcome, { status: 'failed' }> | undefined> {
    const size = media.displaySize ?? { width: 3840, height: 2160 };
    const estimate = estimateMatteBytes(size.width, size.height, media.frameCount, foreground);
    let free: number;
    try {
      free = await (this.options.freeDiskBytes ?? freeDiskBytes)(projectDir);
    } catch {
      // A volume that cannot report free space is not a reason to refuse; the job still
      // fails cleanly as output_unwritable if it runs out.
      return undefined;
    }
    if (free >= estimate.requiredBytes) return undefined;
    log.action('matteDiskPreflightRefused', maskingEventPayload('matteDiskPreflightRefused', { requiredBytes: estimate.requiredBytes, freeBytes: free }));
    return {
      status: 'failed',
      code: 'insufficient_disk',
      // Stable text; the sizes travel as fields for the UI's "Needs about {size}; {free} free".
      detail: 'Not enough free disk space for background removal. Free up space and try again.',
      retryable: true,
      requiredBytes: estimate.requiredBytes,
      freeBytes: free,
    };
  }

  private async resolveMedia(
    intent: MatteRunIntent,
    context: MatteRunContext,
    signal: AbortSignal,
  ): Promise<ResolvedMedia | Extract<MatteRunOutcome, { status: 'failed' }>> {
    const found = context.project.assets.find((candidate) => candidate.id === intent.assetId);
    if (found === undefined) return failed('missing_asset', 'That media is no longer in this project.', false);
    // Imported media is stored relative to the project file; read the file the export reads.
    const asset = { ...found, path: projectMediaPath(context.projectDir, found.path) };
    if (asset.kind !== 'video' && asset.kind !== 'image') {
      return failed('unsupported_asset', 'Background removal works on video and image clips.', false);
    }
    if (!path.isAbsolute(asset.path)) return failed('missing_asset', 'The media file could not be located.', false);
    // Without the probed display size (PAR and rotation applied) the host cannot check that the
    // matte matches the picture, so it refuses rather than skip the check (BR4.12 L3).
    if (displaySizeOf(asset) === undefined) {
      return failed('media_unreadable', 'This media has not been measured yet. Wait for the import to finish, or re-import it.', true);
    }
    let timing: MatteVideoTiming;
    let fingerprint: string;
    try {
      timing = await this.options.inspector.videoTiming(asset.path, signal);
      fingerprint = await sourceContentFingerprint(asset.path, timing);
    } catch (error) {
      if (error instanceof MatteInspectorError && error.code === 'cancelled') return failed('cancelled', 'Background removal cancelled.', false);
      return failed('media_unreadable', 'The media file could not be read. Relink it and try again.', false);
    }
    const range = frameRange(timing, intent.sourceStart, intent.sourceEnd);
    if (range === undefined) return failed('invalid_intent', 'The requested range is outside the media.', false);
    return {
      asset,
      timing,
      firstFrame: range.firstFrame,
      frameCount: range.frameCount,
      fps: averageFps(timing),
      ...(displaySizeOf(asset) === undefined ? {} : { displaySize: displaySizeOf(asset)! }),
      fingerprint,
    };
  }

  /**
   * The installed, healthy Smart Mask worker, for the interactive warm session (BR6.11): the same
   * pack resolution a job uses (newest healthy install, minimum version, signed entrypoint
   * present), so hover never runs a pack a job would refuse.
   */
  public async resolveWorker(): Promise<
    | { readonly status: 'ready'; readonly entrypoint: string; readonly installRoot: string; readonly packVersion: string }
    | { readonly status: 'blocked'; readonly outcome: MatteRunOutcome }
  > {
    const pack = await this.resolvePack();
    if (pack.status !== 'ready') return pack;
    const installRoot = resolveInside(this.options.storageRoot, pack.record.installRelativePath);
    return {
      status: 'ready',
      entrypoint: resolveInside(installRoot, ENTRYPOINT[this.options.platform.os]),
      installRoot,
      packVersion: pack.record.identity.version,
    };
  }

  private async resolvePack(): Promise<
    | { readonly status: 'ready'; readonly record: InstalledCapabilityPack }
    | { readonly status: 'blocked'; readonly outcome: MatteRunOutcome }
  > {
    const installed = await this.options.store.list();
    const record = newestHealthy(installed, SMART_MASK_PACK_ID);
    if (record === undefined) {
      if (installed.some((candidate) => candidate.identity.id === SMART_MASK_PACK_ID)) {
        return {
          status: 'blocked',
          outcome: failed('pack_unhealthy', 'The Smart Mask pack is installed but failed its health check. Reinstall it in Settings › Storage.', false),
        };
      }
      return { status: 'blocked', outcome: { status: 'pack_missing', proposal: await this.options.propose('subject.matte') } };
    }
    // Additive negotiation: a release older than the capability cannot answer it. Offer the
    // update the same way a missing pack is offered, never a crash.
    if (compareSemver(record.identity.version, MATTE_MIN_PACK_VERSION) < 0) {
      return { status: 'blocked', outcome: { status: 'pack_missing', proposal: await this.options.propose('subject.matte') } };
    }
    try {
      const entrypoint = resolveInside(resolveInside(this.options.storageRoot, record.installRelativePath), ENTRYPOINT[this.options.platform.os]);
      if (!(await (this.options.isFile ?? defaultIsFile)(entrypoint))) throw new Error('missing');
    } catch {
      return {
        status: 'blocked',
        outcome: failed('pack_incomplete', 'The Smart Mask pack is missing its signed worker. Reinstall it in Settings › Storage.', false),
      };
    }
    return { status: 'ready', record };
  }

  /**
   * Convert intent prompts (source seconds) into worker prompts (source pts), and remember which
   * stored PNGs each brush or lock file comes from (`corrections/<pts>.png` → sha256s).
   *
   * A second brush fix on the same frame is the normal way to refine a fix ("≤ 3 actions", plan
   * 06), so brushes on one frame are LAYERED in the order they were applied: one staged PNG where a
   * later stroke wins wherever it says something (not untouched). Two locks on one frame are still
   * refused: a lock is the frame's final alpha, and two of them contradict each other.
   */
  private workerPrompts(intent: MatteRunIntent, media: ResolvedMedia): { prompts: MattePrompt[]; inputSha: Map<string, readonly string[]> } {
    const prompts: MattePrompt[] = [];
    const inputSha = new Map<string, string[]>();
    for (const prompt of intent.prompts) {
      if (prompt.kind === 'candidate') continue;
      const pts = ptsInRange(media, prompt.sourceTime);
      if (prompt.kind === 'points') prompts.push({ kind: 'points', pts, points: prompt.points });
      else if (prompt.kind === 'box') prompts.push({ kind: 'box', pts, box: prompt.box });
      else {
        const file = `${prompt.kind === 'brush' ? 'corrections' : 'locked'}/${pts}.png`;
        const layers = inputSha.get(file);
        if (layers !== undefined) {
          if (prompt.kind === 'lock') throw new Error('Two locks target one frame.');
          layers.push(prompt.sha256);
          continue;
        }
        inputSha.set(file, [prompt.sha256]);
        prompts.push({ kind: prompt.kind, pts, file });
      }
    }
    return { prompts, inputSha };
  }

  private async stageInputs(
    intent: MatteRunIntent,
    media: ResolvedMedia,
    prompts: readonly MattePrompt[],
    inputSha: ReadonlyMap<string, readonly string[]>,
    staging: MatteStaging,
    projectDir: string,
  ): Promise<
    | {
        readonly files: string[];
        readonly locks: MatteLockCheck[];
        readonly previous?: { directory: string; frames: MatteFramesDocument; lockedPts: number[] };
      }
    | Extract<MatteRunOutcome, { status: 'failed' }>
  > {
    const files: string[] = [];
    const locks: MatteLockCheck[] = [];
    for (const prompt of prompts) {
      if (prompt.kind !== 'brush' && prompt.kind !== 'lock') continue;
      const shas = inputSha.get(prompt.file)!;
      try {
        const layers = await Promise.all(shas.map((sha) => readMatteInput(projectDir, sha)));
        const input = layers.length === 1 ? layers[0]! : layeredBrush(layers.map((layer) => layer.image));
        if (
          media.displaySize !== undefined &&
          (input.image.width !== media.displaySize.width || input.image.height !== media.displaySize.height)
        ) {
          return failed('correction_invalid', 'A saved correction does not match the media size.', false);
        }
        await staging.writeInput(prompt.file, input.bytes);
        files.push(prompt.file);
        if (prompt.kind === 'lock') locks.push({ pts: prompt.pts, pixelSha256: grayPixelSha256(input.image) });
      } catch (error) {
        if (error instanceof MatteStoreError) return failed('correction_invalid', error.message, false);
        throw error;
      }
    }
    if (intent.previousArtifactKey === undefined) return { files, locks };
    const directory = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, intent.previousArtifactKey]).catch(() => undefined);
    if (directory === undefined) {
      return failed('invalid_intent', 'The background removal to update is missing or was changed. Run it from scratch.', false);
    }
    const record = await readMatteRecord(projectDir, intent.previousArtifactKey);
    if (record === undefined || record.assetId !== intent.assetId || !(await verifyRecordDigests(directory, record))) {
      return failed('invalid_intent', 'The background removal to update is missing or was changed. Run it from scratch.', false);
    }
    const names = record.files
      .map((file) => file.name)
      .filter((name): name is 'matte.mkv' | 'foreground.mkv' | 'frames.json' =>
        name === 'matte.mkv' || name === 'foreground.mkv' || name === 'frames.json',
      );
    files.push(...(await staging.clonePrevious(directory, names)));
    const frames = await readMatteFrames(directory);
    return {
      files,
      locks,
      // Frames locked when the previous artifact was made must come back bit for bit.
      previous: { directory, frames, lockedPts: [...record.lockedPts] },
    };
  }

  private buildRequest(
    intent: MatteRunIntent,
    context: MatteRunContext,
    media: ResolvedMedia,
    prompts: readonly MattePrompt[],
    staging: MatteStaging,
    inputFiles: readonly string[],
    allowedFiles: readonly MatteArtifactFileName[],
    maxBytes: number,
  ): CapabilityPackWorkerRequest | Extract<MatteRunOutcome, { status: 'failed' }> {
    const inputs = staging.inputHandle(inputFiles);
    const request = {
      type: 'request' as const,
      protocolVersion: 1 as const,
      requestId: intent.requestId,
      projectRevision: context.projectRevision,
      capability: 'subject.matte' as const,
      media: {
        handleId: `media:${intent.requestId}`,
        assetId: media.asset.id,
        absolutePath: media.asset.path,
        sourceStartSeconds: intent.sourceStart,
        sourceEndSeconds: intent.sourceEnd,
        fps: media.fps,
        firstFrame: media.firstFrame,
        lastFrameExclusive: media.firstFrame + media.frameCount,
      },
      parameters: {
        output: staging.outputHandle(allowedFiles, maxBytes),
        ...(inputs === undefined ? {} : { inputs }),
        prompts: [...prompts],
        ...(intent.previousArtifactKey === undefined ? {} : { previousArtifact: intent.previousArtifactKey }),
        previewHeight: intent.previewHeight,
      },
    };
    return request;
  }

  private async runWorker(
    record: InstalledCapabilityPack,
    request: CapabilityPackWorkerRequest,
    staging: MatteStaging,
    media: ResolvedMedia,
    requestId: string,
    signal: AbortSignal,
    onProgress: MatteRunContext['onProgress'],
    context: { readonly projectDir: string; readonly byteCeiling: number },
  ): Promise<SubjectMatteResult | Extract<MatteRunOutcome, { status: 'failed' }>> {
    const installRoot = resolveInside(this.options.storageRoot, record.installRelativePath);
    const entrypoint = resolveInside(installRoot, ENTRYPOINT[this.options.platform.os]);
    const lease = await this.options.store.acquireLease(record.identity);
    const startedAt = Date.now();
    // The watchdog's own controller, so a breach ends the worker without looking like a user cancel.
    const workerController = new AbortController();
    const forwardAbort = (): void => workerController.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    let workerPid: number | undefined;
    const settings = this.options.watchdog ?? {};
    const freeAtStart = await (this.options.freeDiskBytes ?? freeDiskBytes)(context.projectDir).catch(() => Number.MAX_SAFE_INTEGER);
    const watchdog = new WorkerWatchdog(
      watchdogLimits({
        packId: record.identity.id,
        totalMemoryBytes: settings.totalMemoryBytes ?? totalmem(),
        byteCeiling: context.byteCeiling,
        freeBytesAtStart: freeAtStart,
        ...(settings.stallMs === undefined ? {} : { stallMs: settings.stallMs }),
      }),
      {
        footprintBytes: settings.footprintBytes ?? processGroupFootprint(),
        directoryBytes: stagingBytes,
        now: settings.now ?? Date.now,
      },
      {
        stagingDirectory: staging.directory,
        ...(settings.intervalMs === undefined ? {} : { intervalMs: settings.intervalMs }),
        onBreach: () => {
          (settings.killGroup ?? killWorkerGroup)(workerPid);
          workerController.abort();
        },
      },
    );
    watchdog.start();
    try {
      const result = await (this.options.runWorker ?? runCapabilityPackWorker)({
        entrypoint,
        mediaRoot: path.dirname(media.asset.path),
        outputRoot: staging.stagingRoot,
        request,
        signal: workerController.signal,
        timeoutMs: Math.min(JOB_TIMEOUT_MAX_MS, JOB_TIMEOUT_BASE_MS + media.frameCount * JOB_TIMEOUT_PER_FRAME_MS),
        extraEnvironment: { FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot },
        onSpawn: (pid) => {
          workerPid = pid;
          watchdog.attach(pid);
        },
        onProgress: (progress) => {
          watchdog.progress();
          onProgress?.(withEta(requestId, progress, startedAt));
        },
      });
      if (watchdog.breach !== undefined) return resourceExhausted(watchdog.breach);
      if (result.capability !== 'subject.matte') {
        return failed('worker_failed', 'The Smart Mask pack returned an unexpected result.', false);
      }
      return result;
    } catch (error) {
      if (watchdog.breach !== undefined) return resourceExhausted(watchdog.breach);
      throw error;
    } finally {
      watchdog.stop();
      signal.removeEventListener('abort', forwardAbort);
      await lease.release();
    }
  }

  private async commit(
    projectDir: string,
    staging: MatteStaging,
    key: string,
    intent: MatteRunIntent,
    media: ResolvedMedia,
    pack: InstalledCapabilityPack,
    result: SubjectMatteResult,
    requestPrompts: readonly MattePrompt[],
    files: readonly VerifiedMatteFile[],
    signal: AbortSignal,
  ): Promise<MatteArtifactRecord> {
    const record: MatteArtifactRecord = {
      version: 1,
      key,
      assetId: intent.assetId,
      files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
      width: result.artifact.width,
      height: result.artifact.height,
      coverage: { sourceStart: intent.sourceStart, sourceEnd: intent.sourceEnd },
      packId: pack.identity.id,
      packVersion: pack.identity.version,
      modelDigests: [...new Set(Object.values(result.modelDigests))].sort(),
      executionProvider: result.executionProvider,
      summary: result.summary,
      lockedPts: lockedPtsOf(requestPrompts),
      needsReview: result.needsReview.map((range) => ({
        start: Math.max(0, ptsToSeconds(media.timing, range.startPts)),
        end: Math.max(0, ptsToSeconds(media.timing, range.endPts)),
        reason: range.reason,
      })),
      contentFingerprint: media.fingerprint,
      sourceSamples: await this.sampleSource(media, signal),
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    const outcome = await commitMatteStaging(projectDir, staging, key, files);
    if (outcome === 'already_present' && (await readMatteRecord(projectDir, key)) !== undefined) {
      return (await readMatteRecord(projectDir, key))!;
    }
    await writeMatteRecord(projectDir, record);
    return record;
  }

  private async sampleSource(media: ResolvedMedia, signal: AbortSignal): Promise<MatteArtifactRecord['sourceSamples']> {
    const pts = sampleSourcePts(media.timing, media.firstFrame, media.frameCount, MATTE_SOURCE_SAMPLES);
    try {
      const hashes = await this.options.inspector.frameHashesByPts(media.asset.path, pts, signal);
      return pts.flatMap((value, index) => (hashes[index] === undefined ? [] : [{ pts: value, sha256: hashes[index]! }]));
    } catch (error) {
      // No ffmpeg (or a decode failure) leaves the re-check unable to prove "unchanged", which
      // it reports as unverified rather than guessing either way.
      log.warn('matteSourceSamplesUnavailable', { code: error instanceof MatteInspectorError ? error.code : 'error' });
      return [];
    }
  }

  private async cacheHit(projectDir: string, key: string, signal: AbortSignal): Promise<MatteArtifactRecord | undefined> {
    const directory = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, key]).catch(() => undefined);
    if (directory === undefined) return undefined;
    const record = await readMatteRecord(projectDir, key);
    if (record === undefined) return undefined;
    return (await verifyRecordDigests(directory, record, signal)) ? record : undefined;
  }
}

/** The cache key (plan 03): content, coverage, canonical prompts, exact pack, pipeline version. */
export function matteCacheKey(parts: {
  readonly fingerprint: string;
  readonly firstPts: number;
  readonly lastPts: number;
  readonly prompts: readonly unknown[];
  readonly packId: string;
  readonly packVersion: string;
  /** Pins the signed artifact, and with it every model the pack ships (stands in for modelDigests). */
  readonly releaseDigest: string;
  readonly foreground: boolean;
  readonly previewHeight: number;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        pipeline: MATTE_PIPELINE_VERSION,
        content: parts.fingerprint,
        firstPts: parts.firstPts,
        lastPts: parts.lastPts,
        prompts: parts.prompts,
        pack: `${parts.packId}@${parts.packVersion}`,
        releaseDigest: parts.releaseDigest,
        foreground: parts.foreground,
        previewHeight: parts.previewHeight,
      }),
    )
    .digest('hex');
}

/** Prompts sorted and rounded to 1e-4; brushes and locks by the sha256 of their PNG. */
function canonicalPrompts(prompts: readonly MattePrompt[], inputSha: ReadonlyMap<string, readonly string[]>): unknown[] {
  const round = (value: number): number => Math.round(value * 10_000) / 10_000;
  return prompts
    .map((prompt) => {
      switch (prompt.kind) {
        case 'points':
          return { kind: 'points', pts: prompt.pts, points: prompt.points.map((p) => ({ x: round(p.x), y: round(p.y), label: p.label })) };
        case 'box':
          return {
            kind: 'box',
            pts: prompt.pts,
            box: { x: round(prompt.box.x), y: round(prompt.box.y), width: round(prompt.box.width), height: round(prompt.box.height) },
          };
        default:
          // One sha for a single fix (the key every earlier artifact was cached under); the layered
          // fixes of one frame in the order they were applied.
          return { kind: prompt.kind, pts: prompt.pts, sha256: inputSha.get(prompt.file)?.join('+') ?? null };
      }
    })
    .map((prompt) => canonicalJson(prompt))
    .sort()
    .map((text) => JSON.parse(text) as unknown);
}

/**
 * Layer several brush fixes for one frame into the one PNG the worker reads: later fixes win
 * wherever they mark keep, remove or edge; untouched pixels let earlier fixes show through.
 *
 * @throws MatteStoreError `correction_invalid`-mapped when the layers differ in size.
 */
export function layeredBrush(images: readonly GrayPng[]): { readonly bytes: Buffer; readonly image: GrayPng } {
  const [first, ...rest] = images;
  if (first === undefined) throw new MatteStoreError('input_missing', 'No brush fix to layer.');
  const pixels = Buffer.from(first.pixels);
  for (const image of rest) {
    if (image.width !== first.width || image.height !== first.height) {
      throw new MatteStoreError('wrong_size', 'Brush fixes on one frame are different sizes.');
    }
    for (let index = 0; index < pixels.length; index += 1) {
      const value = image.pixels[index]!;
      if (value !== BRUSH_UNTOUCHED) pixels[index] = value;
    }
  }
  const image: GrayPng = { width: first.width, height: first.height, pixels };
  return { bytes: encodeGrayPng(first.width, first.height, pixels), image };
}

/** Decode-order frames covering `[start, end)` source seconds, or `undefined` outside the media. */
export function frameRange(
  timing: MatteVideoTiming,
  start: number,
  end: number,
): { readonly firstFrame: number; readonly frameCount: number } | undefined {
  const firstFrame = frameAt(timing, start);
  if (firstFrame === undefined) return undefined;
  const lastFrame = frameAt(timing, Math.max(start, end - PTS_EPSILON_SECONDS * 2)) ?? firstFrame;
  if (start > relativeSeconds(timing, timing.pts.length - 1) + frameDuration(timing)) return undefined;
  return { firstFrame, frameCount: lastFrame - firstFrame + 1 };
}

/** Index of the frame shown at `seconds` (last pts at or before it), or `undefined` before zero. */
export function frameAt(timing: MatteVideoTiming, seconds: number): number | undefined {
  if (seconds < -PTS_EPSILON_SECONDS) return undefined;
  let low = 0;
  let high = timing.pts.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (relativeSeconds(timing, middle) <= seconds + PTS_EPSILON_SECONDS) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function relativeSeconds(timing: MatteVideoTiming, index: number): number {
  return ((timing.pts[index]! - timing.pts[0]!) * timing.timeBase[0]) / timing.timeBase[1];
}

function ptsToSeconds(timing: MatteVideoTiming, pts: number): number {
  return ((pts - timing.pts[0]!) * timing.timeBase[0]) / timing.timeBase[1];
}

function frameDuration(timing: MatteVideoTiming): number {
  if (timing.pts.length < 2) return 1 / 30;
  return relativeSeconds(timing, timing.pts.length - 1) / (timing.pts.length - 1);
}

function averageFps(timing: MatteVideoTiming): number {
  const duration = frameDuration(timing);
  return Math.min(240, Math.max(1e-3, duration > 0 ? 1 / duration : 30));
}

function ptsInRange(media: ResolvedMedia, sourceTime: number): number {
  const index = frameAt(media.timing, sourceTime);
  if (index === undefined || index < media.firstFrame || index >= media.firstFrame + media.frameCount) {
    throw new Error('A prompt is outside the range being processed.');
  }
  return media.timing.pts[index]!;
}

/** First and last frame exactly, plus `samples` evenly spaced frames in between. */
export function sampleSourcePts(timing: MatteVideoTiming, firstFrame: number, frameCount: number, samples: number): number[] {
  const indexes = new Set<number>([firstFrame, firstFrame + frameCount - 1]);
  for (let step = 1; step <= samples; step += 1) {
    indexes.add(firstFrame + Math.floor((step * (frameCount - 1)) / (samples + 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => timing.pts[index]!);
}

function lockedPtsOf(prompts: readonly MattePrompt[]): number[] {
  return [...new Set(prompts.flatMap((prompt) => (prompt.kind === 'lock' ? [prompt.pts] : [])))].sort((a, b) => a - b);
}

/** The picture size the monitor shows (pixel aspect and quarter-turn rotation applied). */
export function displaySizeOf(asset: Project['assets'][number]): { width: number; height: number } | undefined {
  const width = asset.media?.width;
  const height = asset.media?.height;
  if (width == null || height == null) return undefined;
  const stretched = width * (asset.media?.pixelAspectRatio ?? 1);
  const quarterTurn = asset.media?.rotation === 90 || asset.media?.rotation === 270;
  const round = (value: number): number => Math.floor(value + 0.5);
  return quarterTurn ? { width: round(height), height: round(stretched) } : { width: round(stretched), height: round(height) };
}

export async function verifyRecordDigests(
  directory: string,
  record: MatteArtifactRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    for (const file of record.files) {
      const target = path.join(directory, file.name);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size !== file.bytes) return false;
      if ((await sha256File(target, signal)) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function newestHealthy(records: readonly InstalledCapabilityPack[], packId: string): InstalledCapabilityPack | undefined {
  return records
    .filter((record) => record.identity.id === packId && record.state === 'installed' && record.health.status === 'healthy')
    .sort((left, right) => compareSemver(right.identity.version, left.identity.version))[0];
}

function withEta(requestId: string, progress: CapabilityPackWorkerProgress, startedAt: number): MatteProgress {
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const etaSeconds =
    progress.completed > 0 && progress.completed < progress.total
      ? Math.round((elapsedSeconds / progress.completed) * (progress.total - progress.completed))
      : undefined;
  return {
    requestId,
    phase: progress.phase,
    completed: progress.completed,
    total: progress.total,
    ...(progress.round === undefined ? {} : { round: progress.round }),
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
  };
}

function completed(record: MatteArtifactRecord, cacheHit: boolean, projectRevision: number): MatteRunOutcome {
  return {
    status: 'completed',
    artifact: {
      key: record.key,
      files: record.files.map((file) => ({ name: file.name, sha256: file.sha256 })),
      width: record.width,
      height: record.height,
      coverage: record.coverage,
      packId: record.packId,
      packVersion: record.packVersion,
      modelDigests: record.modelDigests,
    },
    summary: record.summary,
    needsReview: record.needsReview,
    executionProvider: record.executionProvider,
    cacheHit,
    projectRevision,
  };
}

/** Worker codes the host passes through, each with the one remedy sentence the editor reads. */
const WORKER_FAILURES: Readonly<Record<string, readonly [MatteFailureCode, string, boolean]>> = {
  cancelled: ['cancelled', 'Background removal cancelled.', false],
  media_unreadable: ['media_unreadable', 'The media file could not be decoded. Relink or re-import it.', false],
  target_lost: ['target_lost', 'The subject could not be followed. Click the subject on another frame and try again.', false],
  // BR7.5: the pack asks instead of guessing where a subject cut by the frame ends.
  needs_box: ['needs_box', 'One click cannot tell where this subject ends: it runs off the edge of the picture. With AI Object, drag a box around the subject on the monitor, then run again.', false],
  model_unavailable: ['model_unavailable', 'The Smart Mask pack’s models are unavailable. Reinstall it in Settings › Storage.', false],
  hardware_unsupported: ['hardware_unsupported', 'This computer cannot run the Smart Mask pack.', false],
  output_unwritable: ['output_unwritable', 'Disk full or folder not writable. Free up space and try again.', true],
  invalid_request: ['worker_failed', 'The installed Smart Mask pack does not support this request. Update it in Settings › Storage.', false],
};

function classifyFailure(error: unknown, signal: AbortSignal): Extract<MatteRunOutcome, { status: 'failed' }> {
  if (signal.aborted) return failed('cancelled', 'Background removal cancelled.', false);
  if (error instanceof MatteVerificationError) {
    return {
      status: 'failed',
      code: 'verification_failed',
      detail: 'The background removal result failed FramePilot’s checks and was discarded. Try again.',
      retryable: error.code !== 'verification_unavailable',
      verificationCode: error.code,
    };
  }
  if (error instanceof CapabilityPackWorkerRuntimeError) {
    if (error.code === 'cancelled') return failed('cancelled', 'Background removal cancelled.', false);
    if (error.code === 'timed_out') return failed('timed_out', 'Background removal took longer than its time limit and was stopped.', true);
    if (error.code === 'media_escape') return failed('media_rejected', 'The media or output folder is outside the project’s allowed folders.', false);
    if (error.code === 'lingering_process') {
      return failed('worker_failed', 'The Smart Mask pack left a process running and its result was discarded.', false);
    }
    const mapped = error.workerCode === undefined ? undefined : WORKER_FAILURES[error.workerCode];
    if (mapped !== undefined) return failed(...mapped);
    return failed('worker_failed', 'The Smart Mask pack stopped unexpectedly. Try again.', true);
  }
  if (error instanceof MatteStoreError) return failed('correction_invalid', error.message, false);
  if (error instanceof MatteStagingError && error.code === 'changed_after_verify') {
    return {
      status: 'failed',
      code: 'verification_failed',
      detail: 'The background removal result failed FramePilot’s checks and was discarded. Try again.',
      retryable: true,
      verificationCode: 'changed_after_verify',
    };
  }
  if (isNodeCode(error, 'ENOSPC') || isNodeCode(error, 'EACCES') || isNodeCode(error, 'EROFS')) {
    return failed('output_unwritable', 'Disk full or folder not writable. Free up space and try again.', true);
  }
  // The error NAME and code only: messages from fs and child processes carry paths.
  log.error('matteJobUnexpected', {
    error: error instanceof Error ? error.name : 'unknown',
    ...(typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
  });
  return failed('worker_failed', 'Background removal failed unexpectedly. Try again.', true);
}

const RESOURCE_REMEDIES: Readonly<Record<WatchdogBreach, string>> = {
  memory: 'Background removal needed more memory than this computer can spare and was stopped. Close other apps or use a shorter range.',
  stalled: 'The Smart Mask pack stopped responding and was stopped. Try again.',
  disk: 'Background removal was about to fill the disk and was stopped. Free up space and try again.',
};

function resourceExhausted(breach: WatchdogBreach): Extract<MatteRunOutcome, { status: 'failed' }> {
  return { status: 'failed', code: 'resource_exhausted', detail: RESOURCE_REMEDIES[breach], retryable: breach !== 'memory', resourceLimit: breach };
}

function failed(code: MatteFailureCode, detail: string, retryable: boolean): Extract<MatteRunOutcome, { status: 'failed' }> {
  return { status: 'failed', code, detail, retryable };
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1_000) / 1_000;
}

function isNodeCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function defaultIsFile(absolutePath: string): Promise<boolean> {
  try {
    return (await lstat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
