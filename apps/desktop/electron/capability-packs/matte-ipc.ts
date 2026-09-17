/**
 * The named IPC channels for pack status and background removal (plan 03, BR4.4).
 *
 * Exactly these channels, nothing broader: status for one capability id, the installed/removed
 * push event, run/cancel/progress for one matte job, and saving one correction input. Every
 * payload is parsed with a zod schema from `@framepilot/capability-packs` before it reaches the
 * service; main re-reads the project from disk and never takes a path from the renderer.
 */
import path from 'node:path';
import {
  CapabilityIdSchema,
  CapabilityPackJobActionSchema,
  MatteRunIntentSchema,
  MatteCleanRequestSchema,
  MatteSaveCorrectionSchema,
  MatteStorageRequestSchema,
} from '@framepilot/capability-packs';
import {
  createLogger,
  type MatteCleanResultWire,
  type MatteStorageResultWire,
  type CapabilityPackJobWire,
  type CapabilityPackStatusWire,
  type MatteProgressWire,
  type MatteRunResultWire,
  type MatteSaveCorrectionResultWire,
} from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { IpcChannels } from '../ipc/contract.js';
import type { CapabilityPackMatteService, MatteRunOutcome } from './matte.js';
import { readMatteRecord, saveMatteInput, MatteStoreError } from './matte-store.js';
import { MatteStagingError, sweepMatteStaging } from './matte-staging.js';
import {
  JobCancelledError,
  type CapabilityPackJobScheduler,
  type JobContext,
  type JobPriority,
} from './job-scheduler.js';
import { cleanUnusedMattes, matteStorageSummary } from './matte-storage.js';

const log = createLogger('desktop:capability-packs:matte-ipc');

/** The slice of `ipcMain` this module uses, so tests can drive it without Electron. */
export interface MatteIpcMain {
  handle(channel: string, listener: (event: MatteIpcEvent, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: MatteIpcEvent, ...args: unknown[]) => void): void;
}

export interface MatteIpcEvent {
  readonly sender: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
}

export interface MatteIpcDependencies {
  readonly ipcMain: MatteIpcMain;
  readonly requireLicense: () => void;
  readonly capabilityStatus: (capability: string) => Promise<CapabilityPackStatusWire>;
  readonly matte: () => Promise<CapabilityPackMatteService>;
  /** Path of the open project file, or null when none is open. */
  readonly activeProjectPath: () => Promise<string | null>;
  readonly readProject: (projectPath: string) => Promise<Project>;
  /** One GPU job at a time, priorities, pause during export (BR4.9). Absent → runs directly. */
  readonly scheduler?: CapabilityPackJobScheduler;
}

/**
 * Run one matte job through the scheduler (or directly without one).
 *
 * The job is one window: the worker protocol has no windows yet, so pre-emption, export pauses
 * and user pauses take effect before it starts. A job that finished before a restart is not
 * lost: its artifact is committed and the re-run is a cache hit.
 */
export async function scheduleMatteJob(
  dependencies: Pick<MatteIpcDependencies, 'matte' | 'readProject' | 'scheduler'>,
  projectPath: string,
  intent: unknown,
  priority: JobPriority,
  resumed: boolean,
  onProgress?: (progress: MatteProgressWire) => void,
): Promise<MatteRunOutcome> {
  const parsed = MatteRunIntentSchema.safeParse(intent);
  const run = await matteJobRunner(dependencies, projectPath, intent, onProgress);
  const scheduler = dependencies.scheduler;
  if (scheduler === undefined || !parsed.success) return run();
  try {
    return await scheduler.submit(
      {
        id: parsed.data.requestId,
        kind: 'matte',
        label: 'Remove background',
        ...(parsed.data.clipId === undefined ? {} : { clipId: parsed.data.clipId }),
        projectPath,
        payload: intent,
        finishedWindows: [],
      },
      priority,
      run,
      resumed,
    );
  } catch (error) {
    if (error instanceof JobCancelledError) {
      return { status: 'failed', code: 'cancelled', detail: 'Background removal cancelled.', retryable: false };
    }
    return { status: 'failed', code: 'job_running', detail: 'A background removal job with this id is already running.', retryable: false };
  }
}

/** The scheduler runner for one matte job; also used to resume journaled jobs after a restart. */
export async function matteJobRunner(
  dependencies: Pick<MatteIpcDependencies, 'matte' | 'readProject'>,
  projectPath: string,
  intent: unknown,
  onProgress?: (progress: MatteProgressWire) => void,
): Promise<(context?: JobContext) => Promise<MatteRunOutcome>> {
  const parsed = MatteRunIntentSchema.safeParse(intent);
  const service = await dependencies.matte();
  return async (context?: JobContext): Promise<MatteRunOutcome> => {
    await context?.checkpoint();
    // Re-read at start: a queued job must see the project as it is when it runs.
    const project = await dependencies.readProject(projectPath);
    const abort = (): void => {
      if (parsed.success) service.cancel(parsed.data.requestId);
    };
    context?.signal.addEventListener('abort', abort, { once: true });
    try {
      const outcome = await service.run(intent, {
        projectDir: path.dirname(projectPath),
        project,
        projectRevision: project.timeline.revision ?? 0,
        readCurrent: async () => {
          const current = await dependencies.readProject(projectPath);
          return { revision: current.timeline.revision ?? 0, project: current };
        },
        onProgress: (progress) => {
          context?.progress(progress);
          onProgress?.(progress);
        },
      });
      if (outcome.status === 'completed') context?.finishWindow(0);
      return outcome;
    } finally {
      context?.signal.removeEventListener('abort', abort);
    }
  };
}

/** The jobs panel channels (BR4.9): list, push on change, pause/resume/cancel. */
export function registerJobIpc(dependencies: {
  readonly ipcMain: MatteIpcMain;
  readonly scheduler: CapabilityPackJobScheduler;
  /** Also stop the matte worker process when its job is cancelled. */
  readonly cancelMatte: (jobId: string) => void;
}): void {
  const { ipcMain, scheduler } = dependencies;
  ipcMain.handle(IpcChannels.capabilityPackJobs, async (): Promise<readonly CapabilityPackJobWire[]> => scheduler.snapshot());
  ipcMain.handle(IpcChannels.capabilityPackJobAction, async (_event, input: unknown): Promise<boolean> => {
    const parsed = CapabilityPackJobActionSchema.safeParse(input);
    if (!parsed.success) return false;
    const { jobId, action } = parsed.data;
    if (action === 'pause') return scheduler.pause(jobId);
    if (action === 'resume') return scheduler.resume(jobId);
    const cancelled = scheduler.cancel(jobId);
    if (cancelled) dependencies.cancelMatte(jobId);
    return cancelled;
  });
}

export function registerMatteIpc(dependencies: MatteIpcDependencies): void {
  const { ipcMain } = dependencies;
  // Staging lives inside each project, so the orphan sweep runs the first time a session
  // touches a project's matte store rather than once at app start. Never fatal.
  const swept = new Set<string>();
  const sweepOnce = async (projectDir: string, service: CapabilityPackMatteService): Promise<void> => {
    if (swept.has(projectDir)) return;
    swept.add(projectDir);
    try {
      await sweepMatteStaging(projectDir, { now: new Date(), activeJobIds: service.activeJobIds() });
    } catch (error) {
      log.warn('matteStagingSweepFailed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  };

  ipcMain.handle(IpcChannels.capabilityPackStatus, async (_event, capability: unknown): Promise<CapabilityPackStatusWire> => {
    const parsed = CapabilityIdSchema.safeParse(capability);
    if (!parsed.success) {
      return { state: 'invalid', capability: String(capability).slice(0, 128), error: 'Capability id is invalid.' };
    }
    return dependencies.capabilityStatus(parsed.data);
  });

  ipcMain.handle(IpcChannels.capabilityPackMatte, async (event, intent: unknown): Promise<MatteRunResultWire> => {
    dependencies.requireLicense();
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.', retryable: false };
    const service = await dependencies.matte();
    await sweepOnce(path.dirname(projectPath), service);
    const outcome = await scheduleMatteJob(dependencies, projectPath, intent, 'focused', false, (progress) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(IpcChannels.capabilityPackMatteProgress, progress satisfies MatteProgressWire);
    });
    return toWire(outcome);
  });

  ipcMain.on(IpcChannels.capabilityPackCancelMatte, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
    dependencies.scheduler?.cancel(requestId);
    void dependencies.matte().then((service) => service.cancel(requestId));
  });

  ipcMain.handle(IpcChannels.matteSaveCorrection, async (_event, input: unknown): Promise<MatteSaveCorrectionResultWire> => {
    dependencies.requireLicense();
    const parsed = MatteSaveCorrectionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: 'invalid_correction', error: parsed.error.issues[0]?.message ?? 'Correction is malformed.' };
    }
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.' };
    const projectDir = path.dirname(projectPath);
    const correction = parsed.data;
    const record = await readMatteRecord(projectDir, correction.artifactKey);
    if (record === undefined) {
      return { ok: false, code: 'artifact_missing', error: 'The background removal this fix belongs to is missing.' };
    }
    if (correction.sourceTime < record.coverage.sourceStart || correction.sourceTime > record.coverage.sourceEnd) {
      return { ok: false, code: 'out_of_coverage', error: 'The fix is outside the range background removal covers.' };
    }
    try {
      const saved = await saveMatteInput(projectDir, correction.png, {
        width: record.width,
        height: record.height,
        kind: correction.kind,
      });
      log.action('matteCorrectionSaved', { kind: correction.kind, bytes: saved.bytes });
      return { ok: true, reference: { kind: correction.kind, sourceTime: correction.sourceTime, sha256: saved.sha256 } };
    } catch (error) {
      if (error instanceof MatteStoreError) return { ok: false, code: error.code, error: error.message };
      if (error instanceof MatteStagingError) return { ok: false, code: error.code, error: error.message };
      log.error('matteCorrectionSaveFailed', { error: error instanceof Error ? error.name : 'unknown' });
      return { ok: false, code: 'output_unwritable', error: 'Disk full or folder not writable. Free up space and try again.' };
    }
  });
}

/** Storage summary and "Clean unused mattes" for the open project (BR4.6). */
export function registerMatteStorageIpc(dependencies: MatteIpcDependencies): void {
  const { ipcMain } = dependencies;
  const busyKeys = async (): Promise<string[]> => [...(await dependencies.matte()).busyArtifactKeys()];

  ipcMain.handle(IpcChannels.matteStorage, async (_event, input: unknown): Promise<MatteStorageResultWire> => {
    const parsed = MatteStorageRequestSchema.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, code: 'invalid_request', error: 'Storage request is malformed.' };
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.' };
    const project = await dependencies.readProject(projectPath);
    const summary = await matteStorageSummary(path.dirname(projectPath), project, [
      ...parsed.data.protectedKeys,
      ...(await busyKeys()),
    ]);
    return { ok: true, ...summary };
  });

  ipcMain.handle(IpcChannels.matteCleanUnused, async (_event, input: unknown): Promise<MatteCleanResultWire> => {
    dependencies.requireLicense();
    const parsed = MatteCleanRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_request', error: 'Cleanup request is malformed.' };
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.' };
    // Re-read at the moment of deletion: the project on disk is the authority, not the
    // summary the dialog showed a minute ago.
    const project = await dependencies.readProject(projectPath);
    const result = await cleanUnusedMattes(path.dirname(projectPath), project, parsed.data.approvedKeys, [
      ...parsed.data.protectedKeys,
      ...(await busyKeys()),
    ]);
    return { ok: true, ...result };
  });
}

export function toWire(outcome: MatteRunOutcome): MatteRunResultWire {
  switch (outcome.status) {
    case 'completed':
      return {
        ok: true,
        artifact: outcome.artifact,
        summary: outcome.summary,
        needsReview: outcome.needsReview,
        executionProvider: outcome.executionProvider,
        cacheHit: outcome.cacheHit,
        projectRevision: outcome.projectRevision,
      };
    case 'pack_missing':
      return { ok: false, code: 'pack_missing', proposal: outcome.proposal };
    case 'needs_prompt':
      return { ok: false, code: 'needs_prompt' };
    default:
      return {
        ok: false,
        code: outcome.code,
        error: outcome.detail,
        retryable: outcome.retryable,
        ...(outcome.verificationCode === undefined ? {} : { verificationCode: outcome.verificationCode }),
        ...(outcome.requiredBytes === undefined ? {} : { requiredBytes: outcome.requiredBytes }),
        ...(outcome.freeBytes === undefined ? {} : { freeBytes: outcome.freeBytes }),
        ...(outcome.resourceLimit === undefined ? {} : { resourceLimit: outcome.resourceLimit }),
      };
  }
}
