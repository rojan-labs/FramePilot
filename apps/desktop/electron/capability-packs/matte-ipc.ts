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
  MatteCleanRequestSchema,
  MatteSaveCorrectionSchema,
  MatteStorageRequestSchema,
} from '@framepilot/capability-packs';
import {
  createLogger,
  type MatteCleanResultWire,
  type MatteStorageResultWire,
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
    const project = await dependencies.readProject(projectPath);
    const service = await dependencies.matte();
    await sweepOnce(path.dirname(projectPath), service);
    const outcome = await service.run(intent, {
      projectDir: path.dirname(projectPath),
      project,
      projectRevision: project.timeline.revision ?? 0,
      readCurrent: async () => {
        const current = await dependencies.readProject(projectPath);
        return { revision: current.timeline.revision ?? 0, project: current };
      },
      onProgress: (progress) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send(IpcChannels.capabilityPackMatteProgress, progress satisfies MatteProgressWire);
      },
    });
    return toWire(outcome);
  });

  ipcMain.on(IpcChannels.capabilityPackCancelMatte, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
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
      };
  }
}
