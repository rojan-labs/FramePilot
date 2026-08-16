/**
 * Renderer bridge façade with compact authoritative-project reconstruction.
 */
export * from './bridge-base.js';

import { safeParseProject, type Project } from '@framepilot/timeline-schema';
import type {
  ActiveTranscriptionRequest,
  AiStreamRequest,
  FramePilotBridge,
  ProjectChangedEvent,
  ProjectOpenResult,
  ProjectPatchCommitRequest,
  ProjectPatchCommitResult,
  ProjectSaveResult,
  ProjectSnapshotBridge,
  TranscriptionResult,
} from '@framepilot/shared-types';
import { isActiveTranscriptionRequest, isProjectPatchTransport } from '@framepilot/shared-types';
import {
  getBridge as baseGetBridge,
  openProject as baseOpenProject,
  openProjectDialog as baseOpenProjectDialog,
  onProjectChanged as baseOnProjectChanged,
  transcribeAsset as baseTranscribeAsset,
  type ExternalProjectChange,
  type OpenProjectResult,
  type RendererBridge,
} from './bridge-base.js';
import { applyAuthoritativePatchTransport } from './authoritative-patch.js';

interface CachedProject {
  readonly project: Project;
  readonly revision: number;
  readonly path?: string;
}

type SnapshotCapableBridge = FramePilotBridge & Partial<ProjectSnapshotBridge>;

export const PROJECT_CACHE_LIMIT = 2;
const projectCache = new Map<string, CachedProject>();
const wrappedBridges = new WeakMap<FramePilotBridge, FramePilotBridge>();

function trimProjectCache(): void {
  while (projectCache.size > PROJECT_CACHE_LIMIT) {
    const oldest = projectCache.keys().next();
    if (oldest.done) return;
    projectCache.delete(oldest.value);
  }
}

function remember(project: Project, revision: number, path?: string): void {
  projectCache.delete(project.id);
  projectCache.set(project.id, {
    project,
    revision,
    ...(path === undefined ? {} : { path }),
  });
  trimProjectCache();
}

function rememberUnknown(value: unknown, revision: number, path?: string): Project | null {
  const parsed = safeParseProject(value);
  if (!parsed.success) return null;
  remember(parsed.data, revision, path);
  return parsed.data;
}

function rememberLiveRequest(request: AiStreamRequest): void {
  if (
    request.projectId === undefined ||
    request.projectRevision === undefined ||
    request.project === undefined
  ) return;
  const parsed = safeParseProject(request.project);
  if (!parsed.success || parsed.data.id !== request.projectId) return;
  const cached = projectCache.get(request.projectId);
  if (cached && request.projectRevision < cached.revision) return;
  const withRecoveryHistory = cached
    ? safeParseProject({ ...parsed.data, history: cached.project.history })
    : parsed;
  if (!withRecoveryHistory.success) return;
  remember(withRecoveryHistory.data, request.projectRevision, cached?.path);
}

async function recoverFullProject(
  rawBridge: FramePilotBridge,
  projectId: string,
  authoritativeRevision: number,
  pathHint?: string,
): Promise<CachedProject | null> {
  const raw = rawBridge as SnapshotCapableBridge;
  const cached = projectCache.get(projectId);
  const path = pathHint ?? cached?.path;
  const opened = raw.projectSnapshot
    ? await raw.projectSnapshot(projectId)
    : path
      ? await raw.openProject(path)
      : null;
  if (!opened?.ok) return null;
  const project = rememberUnknown(opened.project, authoritativeRevision, opened.path);
  return project ? projectCache.get(project.id) ?? null : null;
}

function reconstructFromCache(value: unknown): Project | null {
  if (!isProjectPatchTransport(value)) return null;
  const cached = projectCache.get(value.id);
  if (!cached || cached.revision !== value.baseRevision) return null;
  const project = applyAuthoritativePatchTransport(cached.project, value);
  if (!project) return null;
  remember(project, value.revision, cached.path);
  return project;
}

export function createProjectAwareBridge(raw: FramePilotBridge): FramePilotBridge {
  const existing = wrappedBridges.get(raw);
  if (existing) return existing;
  const overrides: Partial<FramePilotBridge> = (() => {
    const target = raw;
    return {
      openProject: async (path: string): Promise<ProjectOpenResult> => {
        const result = await target.openProject(path);
        if (result.ok) rememberUnknown(result.project, result.revision ?? 0, result.path);
        return result;
      },
      openProjectDialog: async (): Promise<ProjectOpenResult> => {
        const result = await target.openProjectDialog();
        if (result.ok) rememberUnknown(result.project, result.revision ?? 0, result.path);
        return result;
      },
      saveProject: async (
        path: string,
        project: unknown,
        expectedRevision?: number,
      ): Promise<ProjectSaveResult> => {
        const result = await target.saveProject(path, project, expectedRevision);
        if (result.ok) rememberUnknown(project, result.revision ?? expectedRevision ?? 0, result.path);
        return result;
      },
      saveProjectDefault: async (
        project: unknown,
        expectedRevision?: number,
      ): Promise<ProjectSaveResult> => {
        const result = await target.saveProjectDefault(project, expectedRevision);
        if (result.ok) rememberUnknown(project, result.revision ?? expectedRevision ?? 0, result.path);
        return result;
      },
      aiStreamStart: async (request: AiStreamRequest): Promise<string> => {
        rememberLiveRequest(request);
        return target.aiStreamStart(request);
      },
      onProjectChanged: (listener: (event: ProjectChangedEvent) => void): (() => void) =>
        target.onProjectChanged((event) => {
          if (!isProjectPatchTransport(event.project)) {
            rememberUnknown(event.project, event.revision ?? 0, event.path);
            listener(event);
            return;
          }
          const reconstructed = reconstructFromCache(event.project);
          if (reconstructed) {
            listener({ ...event, project: reconstructed });
            return;
          }
          const revision = event.revision ?? event.project.revision;
          void recoverFullProject(target, event.project.id, revision, event.path).then((recovered) => {
            if (recovered) listener({ ...event, project: recovered.project, revision });
          });
        }),
      ...(target.commitProjectPatch === undefined
        ? {}
        : {
            commitProjectPatch: async (
              request: ProjectPatchCommitRequest,
            ): Promise<ProjectPatchCommitResult> => {
              const result = await target.commitProjectPatch!(request);
              if (!result.ok || !isProjectPatchTransport(result.project)) return result;
              const reconstructed = reconstructFromCache(result.project);
              if (reconstructed) return { ...result, project: reconstructed };
              const recovered = await recoverFullProject(target, request.projectId, result.revision);
              if (recovered) return { ...result, project: recovered.project };
              return {
                ok: false,
                error:
                  'The authoritative patch committed, but the renderer could not reconstruct its project snapshot.',
                code: 'revision_conflict',
                currentRevision: result.revision,
              };
            },
          }),
    };
  })();
  const wrapped = Object.assign(
    Object.create(Object.getPrototypeOf(raw) as object | null) as FramePilotBridge,
    raw,
    overrides,
  );
  wrappedBridges.set(raw, wrapped);
  return wrapped;
}

export function resetProjectBridgeCacheForTests(): void {
  projectCache.clear();
}
export function projectBridgeCacheSizeForTests(): number {
  return projectCache.size;
}

export function getBridge(): RendererBridge | null {
  const raw = baseGetBridge();
  return raw ? (createProjectAwareBridge(raw) as RendererBridge) : null;
}
export const isDesktop = (): boolean => getBridge() !== null;

export function openProject(
  path: string,
  bridge: RendererBridge | null = getBridge(),
): Promise<OpenProjectResult> {
  return baseOpenProject(path, bridge);
}
export function openProjectDialog(
  bridge: RendererBridge | null = getBridge(),
): Promise<OpenProjectResult> {
  return baseOpenProjectDialog(bridge);
}
export function onProjectChanged(
  callback: (change: ExternalProjectChange) => void,
  bridge: RendererBridge | null = getBridge(),
): () => void {
  return baseOnProjectChanged(callback, bridge);
}

/**
 * New product requests are limited to Local/TwelveLabs. Legacy Groq/NVIDIA values are
 * migration inputs only and cannot cross the renderer→host transcription boundary.
 */
export async function transcribeAsset(
  request: ActiveTranscriptionRequest,
  bridge: RendererBridge | null = getBridge(),
): Promise<TranscriptionResult> {
  if (!isActiveTranscriptionRequest(request)) {
    return {
      ok: false,
      error: 'Unsupported transcription provider. Choose Local or TwelveLabs.',
      unavailable: true,
    };
  }
  return baseTranscribeAsset(request, bridge);
}
