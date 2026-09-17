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
  runCapabilityPackWorker,
  type CapabilityPackLease,
} from '@framepilot/capability-packs/node';
import { createLogger, type CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { MatteInspectorError, type MatteMediaInspector, type MatteVideoTiming } from './matte-media-inspector.js';
import { grayPixelSha256 } from './matte-png.js';
import {
  commitMatteStaging,
  createMatteStaging,
  matteArtifactDirectory,
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
} from './matte-verify.js';
import { compareSemver, resolveInside } from './pack-paths.js';

const log = createLogger('desktop:capability-packs:matte');

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
  | 'model_unavailable'
  | 'hardware_unsupported'
  | 'output_unwritable'
  | 'verification_failed'
  | 'worker_failed'
  | 'timed_out'
  | 'insufficient_disk'
  | 'correction_invalid'
  | 'candidate_unresolved';

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
    };

/** Host-resolved auto prompt (BR4.5). `undefined` means "ask the editor to click". */
export type MatteAutoPrompt = (context: {
  readonly asset: Project['assets'][number];
  readonly firstFrameSeconds: number;
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

  public constructor(private readonly options: CapabilityPackMatteServiceOptions) {}

  /** Job ids with a live run, so the startup/periodic sweep never removes their staging. */
  public activeJobIds(): ReadonlySet<string> {
    return new Set(this.jobs.keys());
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
    const started = Date.now();
    log.action('matteJobStart', { prompts: intent.prompts.length, rerun: intent.previousArtifactKey !== undefined });
    try {
      const outcome = await this.runJob(intent, context, controller.signal);
      log.action('matteJobEnd', {
        status: outcome.status,
        ...(outcome.status === 'failed' ? { code: outcome.code, verificationCode: outcome.verificationCode } : {}),
        ...(outcome.status === 'completed'
          ? {
              cacheHit: outcome.cacheHit,
              executionProvider: outcome.executionProvider,
              flaggedRatio: ratio(outcome.summary.flaggedFrames, outcome.summary.verifiedFrames + outcome.summary.flaggedFrames),
            }
          : {}),
        elapsedMs: Date.now() - started,
      });
      return outcome;
    } finally {
      this.jobs.delete(intent.requestId);
    }
  }

  private async runJob(intent: MatteRunIntent, context: MatteRunContext, signal: AbortSignal): Promise<MatteRunOutcome> {
    if (intent.timelineRevision !== context.projectRevision) {
      return failed('stale_revision', 'The project changed before background removal started. Try again.', true);
    }
    if (intent.prompts.some((prompt) => prompt.kind === 'candidate')) {
      return failed('candidate_unresolved', 'Pick the subject on the monitor; AI candidates are not available yet.', false);
    }
    const media = await this.resolveMedia(intent, context, signal);
    if ('status' in media) return media;

    const pack = await this.resolvePack();
    if (pack.status !== 'ready') return pack.outcome;

    let prompts: MattePrompt[];
    let inputSha: Map<string, string>;
    try {
      ({ prompts, inputSha } = this.workerPrompts(intent, media));
    } catch (error) {
      return failed('invalid_intent', errorMessage(error), false);
    }
    if (prompts.length === 0 && intent.previousArtifactKey === undefined) {
      const auto = await this.options.autoPrompt?.({
        asset: media.asset,
        firstFrameSeconds: relativeSeconds(media.timing, media.firstFrame),
        projectRevision: context.projectRevision,
        mediaRoot: path.dirname(media.asset.path),
        signal,
      });
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
    const hit = await this.cacheHit(context.projectDir, key, signal);
    if (hit !== undefined) {
      log.action('matteCacheHit', {});
      return completed(hit, true, context.projectRevision);
    }

    const tStage = Date.now();
    let staging: MatteStaging;
    try {
      staging = await createMatteStaging(context.projectDir, intent.requestId);
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
      log.debug('matteStaged', { elapsedMs: Date.now() - tStage });

      const tWorker = Date.now();
      const result = await this.runWorker(pack.record, request, staging, media, intent.requestId, signal, context.onProgress);
      if ('status' in result) return result;
      log.action('matteWorkerDone', { elapsedMs: Date.now() - tWorker, executionProvider: result.executionProvider });

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
      log.action('matteVerified', { elapsedMs: Date.now() - tVerify, bytes: verified.matteBytes });

      // The project moved while the job ran. The verified artifact is content-addressed and
      // stays valid for this media, so it is kept when the asset still exists (the retry is a
      // cache hit); the RESULT is discarded either way, never applied to a newer timeline.
      const current = await context.readCurrent();
      if (current.revision !== context.projectRevision) {
        if (current.project.assets.some((asset) => asset.path === media.asset.path && asset.id === intent.assetId)) {
          await this.commit(context.projectDir, staging, key, intent, media, pack.record, result, prompts, verified.files, signal);
          committed = true;
        }
        return failed('stale_revision', 'The project changed while background removal ran. Run it again to apply it.', true);
      }
      const record = await this.commit(context.projectDir, staging, key, intent, media, pack.record, result, prompts, verified.files, signal);
      committed = true;
      return completed(record, false, context.projectRevision);
    } catch (error) {
      return classifyFailure(error, signal);
    } finally {
      if (!committed) await staging.discard();
    }
  }

  private async resolveMedia(
    intent: MatteRunIntent,
    context: MatteRunContext,
    signal: AbortSignal,
  ): Promise<ResolvedMedia | Extract<MatteRunOutcome, { status: 'failed' }>> {
    const asset = context.project.assets.find((candidate) => candidate.id === intent.assetId);
    if (asset === undefined) return failed('missing_asset', 'That media is no longer in this project.', false);
    if (asset.kind !== 'video' && asset.kind !== 'image') {
      return failed('unsupported_asset', 'Background removal works on video and image clips.', false);
    }
    if (!path.isAbsolute(asset.path)) return failed('missing_asset', 'The media file could not be located.', false);
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
   * stored PNG each brush or lock file comes from (`corrections/<pts>.png` → sha256).
   */
  private workerPrompts(intent: MatteRunIntent, media: ResolvedMedia): { prompts: MattePrompt[]; inputSha: Map<string, string> } {
    const prompts: MattePrompt[] = [];
    const inputSha = new Map<string, string>();
    for (const prompt of intent.prompts) {
      if (prompt.kind === 'candidate') continue;
      const pts = ptsInRange(media, prompt.sourceTime);
      if (prompt.kind === 'points') prompts.push({ kind: 'points', pts, points: prompt.points });
      else if (prompt.kind === 'box') prompts.push({ kind: 'box', pts, box: prompt.box });
      else {
        const file = `${prompt.kind === 'brush' ? 'corrections' : 'locked'}/${pts}.png`;
        if (inputSha.has(file)) throw new Error('Two corrections of the same kind target one frame.');
        inputSha.set(file, prompt.sha256);
        prompts.push({ kind: prompt.kind, pts, file });
      }
    }
    return { prompts, inputSha };
  }

  private async stageInputs(
    intent: MatteRunIntent,
    media: ResolvedMedia,
    prompts: readonly MattePrompt[],
    inputSha: ReadonlyMap<string, string>,
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
      const sha = inputSha.get(prompt.file)!;
      try {
        const input = await readMatteInput(projectDir, sha);
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
    const directory = matteArtifactDirectory(projectDir, intent.previousArtifactKey)!;
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
  ): Promise<SubjectMatteResult | Extract<MatteRunOutcome, { status: 'failed' }>> {
    const installRoot = resolveInside(this.options.storageRoot, record.installRelativePath);
    const entrypoint = resolveInside(installRoot, ENTRYPOINT[this.options.platform.os]);
    const lease = await this.options.store.acquireLease(record.identity);
    const startedAt = Date.now();
    try {
      const result = await (this.options.runWorker ?? runCapabilityPackWorker)({
        entrypoint,
        mediaRoot: path.dirname(media.asset.path),
        outputRoot: staging.stagingRoot,
        request,
        signal,
        timeoutMs: Math.min(JOB_TIMEOUT_MAX_MS, JOB_TIMEOUT_BASE_MS + media.frameCount * JOB_TIMEOUT_PER_FRAME_MS),
        extraEnvironment: { FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot },
        onProgress: (progress) => onProgress?.(withEta(requestId, progress, startedAt)),
      });
      if (result.capability !== 'subject.matte') {
        return failed('worker_failed', 'The Smart Mask pack returned an unexpected result.', false);
      }
      return result;
    } finally {
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
    files: readonly MatteArtifactRecord['files'][number][],
    signal: AbortSignal,
  ): Promise<MatteArtifactRecord> {
    const record: MatteArtifactRecord = {
      version: 1,
      key,
      assetId: intent.assetId,
      files: [...files],
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
    const outcome = await commitMatteStaging(projectDir, staging, key);
    if (outcome === 'already_present' && (await readMatteRecord(projectDir, key)) !== undefined) {
      return (await readMatteRecord(projectDir, key))!;
    }
    await writeMatteRecord(projectDir, record);
    return record;
  }

  private async sampleSource(media: ResolvedMedia, signal: AbortSignal): Promise<MatteArtifactRecord['sourceSamples']> {
    const pts = sampleSourcePts(media.timing, media.firstFrame, media.frameCount, MATTE_SOURCE_SAMPLES);
    try {
      const hashes = await this.options.inspector.frameHashesByPts(media.asset.path, media.timing, pts, signal);
      return pts.flatMap((value, index) => (hashes[index] === undefined ? [] : [{ pts: value, sha256: hashes[index]! }]));
    } catch (error) {
      // No ffmpeg (or a decode failure) leaves the re-check unable to prove "unchanged", which
      // it reports as unverified rather than guessing either way.
      log.warn('matteSourceSamplesUnavailable', { code: error instanceof MatteInspectorError ? error.code : 'error' });
      return [];
    }
  }

  private async cacheHit(projectDir: string, key: string, signal: AbortSignal): Promise<MatteArtifactRecord | undefined> {
    const directory = matteArtifactDirectory(projectDir, key);
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
function canonicalPrompts(prompts: readonly MattePrompt[], inputSha: ReadonlyMap<string, string>): unknown[] {
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
          return { kind: prompt.kind, pts: prompt.pts, sha256: inputSha.get(prompt.file) ?? null };
      }
    })
    .map((prompt) => canonicalJson(prompt))
    .sort()
    .map((text) => JSON.parse(text) as unknown);
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

function displaySizeOf(asset: Project['assets'][number]): { width: number; height: number } | undefined {
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
    const mapped = error.workerCode === undefined ? undefined : WORKER_FAILURES[error.workerCode];
    if (mapped !== undefined) return failed(...mapped);
    return failed('worker_failed', 'The Smart Mask pack stopped unexpectedly. Try again.', true);
  }
  if (error instanceof MatteStoreError) return failed('correction_invalid', error.message, false);
  if (isNodeCode(error, 'ENOSPC') || isNodeCode(error, 'EACCES') || isNodeCode(error, 'EROFS')) {
    return failed('output_unwritable', 'Disk full or folder not writable. Free up space and try again.', true);
  }
  log.error('matteJobUnexpected', { error: errorMessage(error) });
  return failed('worker_failed', 'Background removal failed unexpectedly. Try again.', true);
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
