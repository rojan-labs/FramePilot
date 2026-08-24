/**
 * FramePilot Electron main process (plan/PLAN.md Phase 3.1).
 *
 * Thin glue that composes the unit-tested main-process modules:
 *  - {@link SidecarManager} owns the Python render engine's lifecycle.
 *  - {@link RecentFilesStore} / {@link RecoveryStore} persist recents + the last
 *    valid project for crash recovery.
 *  - The {@link IpcChannels} handlers are the only surface the renderer can call.
 *
 * Security posture (AGENTS.md §6): `contextIsolation: true`, `nodeIntegration:
 * false`, `sandbox: true`, IPC exclusively through the preload bridge.
 *
 * This file is intentionally not unit-tested — it requires an Electron runtime
 * and only wires the modules above (which are tested). Keep logic out of here.
 */
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  watch as fsWatch,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import {
  readProjectFile,
  serializeProject,
  writeProjectFile,
} from '@framepilot/timeline-schema/file';

const aiLog = createLogger('desktop:main');
import {
  Orchestrator,
  MockProvider,
  createProviderFromConfig,
  withResilience,
  createSidecarExecutor,
  createVisualStatusDigester,
  createMemoryRecorder,
  createSessionContextDigester,
  summarizeFootageMap,
  createTemporalEvidenceAcquirer,
  createAsrProvider,
  transcribeWavInChunks,
  isAsrProviderName,
  runVisualIndexLoop,
  runSessionWarmup,
  VisualIndexClient,
  JsonValueSchema,
  boundedKeySegment,
  idempotencyKeyFor,
  KEY_DIGEST_CHARS,
  MAX_IDENTITY_KEY_CHARS,
  type EffectRuntimeObserver,
  type RuntimeEffect,
  type EffectResult,
  type JsonValue,
  type HostToolOutcome,
  type HostToolExecutor,
  AUTOMATIC_TRACKING_TOOL_NAME,
  DETECT_SUBJECTS_TOOL_NAME,
  type ChunkTranscriber,
  type AsrResult,
  type VisualIndexRequestInput,
} from '@framepilot/ai-sdk';
import { createAutomaticTrackingExecutor } from './ai/automatic-tracking-executor.js';
import {
  IpcChannels,
  type AiConfig,
  type AiConfigUpdate,
  type AiEditResult,
  type AiProviderInfo,
  type AiProviderName,
  type AiRequest,
  type AiTextResult,
  type AiStreamRequest,
  type DurableRunAccepted,
  type TrackingProgressWire,
  type TrackingRunResultWire,
  type DurableRunSnapshot,
  type DurableRunSubscription,
  type LicenseStatus,
  type LicenseActivateRequest,
  type ExportRequest,
  type ExportResult,
  type ExportSaveAsRequest,
  type ExportSaveAsResult,
  type MediaImportRequest,
  type MediaImportResult,
  type ImportAssetRequest,
  type ImportAssetResult,
  type MusicSearchResult,
  type MusicPreviewResult,
  type MusicDownloadResult,
  type MusicDownloadRequest,
  type TranscriptionRequest,
  type TranscriptionResult,
  type ConversationSaveResult,
  type ConversationSummary,
  type ProjectChangedEvent,
  type ProjectOpenResult,
  type ProjectSaveResult,
  type ProjectPatchCommitRequest,
  type ProjectPatchCommitResult,
  type RevealResult,
  type VisualIndexRequest,
  type VisualIndexResult,
  type CapabilityPackActionResultWire,
  type CapabilityPackEvictionPlanResultWire,
  type CapabilityPackInstallStartResultWire,
  type CapabilityPackProposalResultWire,
  type CapabilityPackStorageSnapshotWire,
  type CapabilityPackRelocationResultWire,
  type CapabilityPackProjectResolutionWire,
} from './ipc/contract.js';
import { SidecarManager, type SidecarProcess } from './sidecar/manager.js';
import { resolveSidecarCommand } from './sidecar/spawn.js';
import { RecentFilesStore, type RecentFilesIO } from './projects/recent-files.js';
import { ConversationStore, type ConversationStoreIO } from './ai/conversation-store.js';
import { AiStreamHub, parseAiStreamRequest, prepareAiEventForTransport } from './ai/ai-stream.js';
import { shouldAutoCommitAiDiff } from './ai/patch-settlement.js';
import { RunStore, FileRunStoreIO } from './ai/run-store.js';
import { RunCoordinator, RunGateway } from './ai/run-coordinator.js';
import { RunIpcHub } from './ai/run-ipc.js';
import { describeEffectResult, describeRuntimeEffect } from './ai/effect-record.js';
import { DurableRunControls } from './ai/durable-run-controls.js';
import { CapabilityPackDesktopService } from './capability-packs/service.js';
import { loadCapabilityPackRootKeys } from './capability-packs/config.js';
import { FileCapabilityPackLocation } from './capability-packs/location.js';
import { buildTrackingWorkerRequest } from './capability-packs/tracking-request.js';
import type { CapabilityPackWorkerProgress } from '@framepilot/capability-packs';
import { AiConfigStore } from './ai/ai-config.js';
import { LicenseStore, type LicenseCrypto } from './license/license-store.js';
import { LicenseService } from './license/license-service.js';
import { RecoveryStore, type RecoveryIO } from './projects/recovery.js';
import { ActiveProjectStore, type ActiveProjectIO } from './projects/active-project.js';
import { ProjectFileWatcher } from './projects/project-watcher.js';
import { ProjectCommandService } from './projects/project-command-service.js';
import { mergeLiveProjectForHost } from './projects/project-transport.js';
import { defaultProjectPath, resolveProjectsDir } from './projects/projects-dir.js';
import { importMediaFile } from './projects/media-import.js';
import { activePointerPath } from '@framepilot/shared-types/projects-root';
import { sandboxProjectPath } from './ipc/sandbox.js';
import {
  FP_MEDIA_SCHEME,
  buildCsp,
  mediaContentType,
  parseByteRange,
  pathFromMediaUrl,
} from './security/media-protocol.js';
import { resolveWithin } from '@framepilot/shared-types/safety';
import { exportViaSidecar } from './render/export-client.js';
import { ExportHub } from './render/export-hub.js';
import { saveExportAs } from './render/export-save.js';
import { importAssetViaSidecar } from './media/asset-media-client.js';
import { MusicService } from './media/music-service.js';
import { musicErrorMessage } from '@framepilot/ai-sdk';
import { LocalTelemetry, telemetryEnabledFromEnv } from './telemetry/telemetry.js';
import { resolveUpdateChannel } from './updater/channel.js';
import { createAutoUpdaterProvider, type AutoUpdaterLike } from './updater/auto-updater.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = 'http://localhost:5173';
const DEFAULT_ENGINE_HOST = '127.0.0.1';
const DEFAULT_ENGINE_PORT = 8765;

/**
 * Load `.env` from the monorepo root into `process.env` for dev mode.
 * Uses no external deps — plain Node.js file read + line parsing.
 *
 * WHY `.env` OVERRIDES inherited shell vars: the local `.env` is gitignored and
 * is the developer's explicit, intentional configuration. Honouring an inherited
 * value instead would let a stray export (e.g. `FRAMEPILOT_AI_PROVIDER=mock`
 * lingering in the shell that launched the app) silently defeat the `.env`
 * provider choice — the app would fall back to canned mock output even though
 * `.env` selects a real provider. Packaged builds ship no `.env` (the read
 * throws and is caught), so real production environment config is unaffected.
 */
function loadDotEnv(): void {
  try {
    // main.ts compiles to dist/main.js — three dirs up is the monorepo root.
    const envPath = path.resolve(dirname, '../../../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key) process.env[key] = val;
    }
  } catch {
    // .env absent or unreadable — silently skip (production build has real env).
  }
}

loadDotEnv();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parsePatchCommitRequest = (value: unknown): ProjectPatchCommitRequest & { patch: Patch } => {
  if (typeof value !== 'object' || !value) throw new TypeError('Patch commit request is required.');
  const request = value as Record<string, unknown>;
  const patch = request['patch'];
  if (
    typeof request['projectId'] !== 'string' ||
    (request['runId'] !== undefined &&
      (typeof request['runId'] !== 'string' || request['runId'].trim().length === 0)) ||
    !Number.isSafeInteger(request['expectedRevision']) ||
    (request['expectedRevision'] as number) < 0 ||
    typeof patch !== 'object' ||
    !patch
  ) {
    throw new TypeError('Patch commit request has invalid project/revision/patch fields.');
  }
  const envelope = patch as Record<string, unknown>;
  if (
    typeof envelope['patchId'] !== 'string' ||
    (envelope['createdBy'] !== 'user' && envelope['createdBy'] !== 'agent') ||
    typeof envelope['reason'] !== 'string' ||
    !Array.isArray(envelope['operations']) ||
    !envelope['operations'].every(
      (operation) =>
        typeof operation === 'object' &&
        operation !== null &&
        typeof (operation as Record<string, unknown>)['type'] === 'string',
    )
  ) {
    throw new TypeError('Patch envelope is malformed.');
  }
  return request as unknown as ProjectPatchCommitRequest & { patch: Patch };
};

/** Derive the engine host/port from `FRAMEPILOT_PYTHON_API_URL`, else defaults. */
function resolveEngineEndpoint(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const configured = env.FRAMEPILOT_PYTHON_API_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      return {
        host: url.hostname || DEFAULT_ENGINE_HOST,
        port: Number(url.port) || DEFAULT_ENGINE_PORT,
      };
    } catch {
      // Fall through to defaults on a malformed URL.
    }
  }
  return { host: DEFAULT_ENGINE_HOST, port: DEFAULT_ENGINE_PORT };
}

/**
 * Spawn the Python render sidecar: the bundled PyInstaller binary in packaged
 * builds, `uv run framepilot serve` from source in dev (sidecar/spawn.ts).
 */
let capabilityPackRuntimeEnvironment: Readonly<Record<string, string>> = {};

function spawnSidecar(host: string, port: number): SidecarProcess {
  const resolved = resolveSidecarCommand(host, port, {
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    moduleDir: dirname,
    fileExists: existsSync,
  });
  aiLog.action('sidecar:spawn', {
    source: resolved.source,
    command: resolved.command,
    env: Object.keys(resolved.env),
  });
  const child = spawn(resolved.command, [...resolved.args], {
    cwd: resolved.cwd,
    env: { ...process.env, ...resolved.env, ...capabilityPackRuntimeEnvironment },
    stdio: 'inherit',
  });
  // Without this, a failed spawn (e.g. ENOENT because `uv` isn't on PATH for
  // a GUI-launched app) surfaces only as Node's 'error' event; unhandled,
  // that becomes an uncaught exception that crashes the whole main process.
  child.on('error', (error) => {
    aiLog.error('sidecar:spawn-error', {
      source: resolved.source,
      command: resolved.command,
      error,
    });
  });
  return {
    pid: child.pid,
    kill: () => {
      child.kill();
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener(code));
    },
    onError: (listener) => {
      child.on('error', (error) => listener(error));
    },
  };
}

/** Health probe: the engine is ready when `GET /health` answers 2xx. */
async function probeHealth(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/health`);
  return response.ok;
}

/**
 * A process-unique temp path for an atomic write (temp file + rename). The pid alone
 * is NOT unique per write: two overlapping writes to the same target — e.g. rapid
 * conversation-index saves during an agent stream — would share one temp file, so the
 * first rename consumes it and the second fails with ENOENT. A monotonic counter gives
 * each in-flight write its own temp file; the final rename is still atomic (last wins).
 */
let atomicWriteSeq = 0;
function tempPathFor(target: string): string {
  atomicWriteSeq += 1;
  return `${target}.${process.pid}.${atomicWriteSeq}.tmp`;
}

/** Atomic JSON file IO under the app's user-data dir (temp file + rename). */
function userDataFileIO(fileName: string): RecentFilesIO & RecoveryIO {
  const filePath = path.join(app.getPath('userData'), fileName);
  return {
    read: async () => {
      try {
        return await readFile(filePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    write: async (contents: string) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = tempPathFor(filePath);
      await writeFile(tempPath, contents, 'utf-8');
      await rename(tempPath, filePath);
    },
    clear: async () => {
      await rm(filePath, { force: true });
    },
  };
}

/**
 * Atomic file IO for the AI-sidebar conversations directory under user-data
 * (`<userData>/conversations/`). The {@link ConversationStore} sanitizes ids before
 * they reach here, so joining `<id>.json` is safe; we still keep writes atomic
 * (temp + rename) like the project/recents stores.
 */
function conversationDirIO(): ConversationStoreIO {
  const dir = path.join(app.getPath('userData'), 'conversations');
  const fileFor = (name: string): string => path.join(dir, name);
  const readText = async (filePath: string): Promise<string | null> => {
    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const writeText = async (filePath: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const tempPath = tempPathFor(filePath);
    await writeFile(tempPath, contents, 'utf-8');
    await rename(tempPath, filePath);
  };
  return {
    readIndex: () => readText(fileFor('index.json')),
    writeIndex: (contents) => writeText(fileFor('index.json'), contents),
    readConversation: (id) => readText(fileFor(`${id}.json`)),
    writeConversation: (id, contents) => writeText(fileFor(`${id}.json`), contents),
    deleteConversation: async (id) => {
      await rm(fileFor(`${id}.json`), { force: true });
    },
  };
}

const engine = resolveEngineEndpoint(process.env);
const sidecar = new SidecarManager({
  spawn: () => spawnSidecar(engine.host, engine.port),
  probe: probeHealth,
  host: engine.host,
  port: engine.port,
  startupTimeoutMs: Number(process.env.FRAMEPILOT_SIDECAR_TIMEOUT_MS) || 15_000,
});
const recentFiles = new RecentFilesStore(userDataFileIO('recent-projects.json'));
const recovery = new RecoveryStore(userDataFileIO('recovery-snapshot.json'));
const conversations = new ConversationStore(conversationDirIO());

/**
 * Atomic JSON IO for the active-project pointer. Unlike recents/recovery (which
 * live in `userData`), this writes to `<projectsRoot>/.framepilot-active.json`
 * so the separate MCP-server process can read which project the GUI has open.
 * The target dir is resolved lazily so we never touch disk before the first save.
 */
function activeProjectIO(): ActiveProjectIO {
  const filePath = async (): Promise<string> => activePointerPath(await ensureProjectsDir());
  return {
    read: async () => {
      try {
        return await readFile(await filePath(), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    write: async (contents: string) => {
      const target = await filePath();
      const tempPath = tempPathFor(target);
      await writeFile(tempPath, contents, 'utf-8');
      await rename(tempPath, target);
    },
    clear: async () => {
      await rm(await filePath(), { force: true });
    },
  };
}

const activeProject = new ActiveProjectStore(activeProjectIO());

/**
 * The renderer window, captured so the project watcher can push live external
 * changes into it (`webContents.send`). Reassigned whenever a window is created.
 */
let mainWindow: BrowserWindow | null = null;
const projectCommands = new ProjectCommandService(
  serializeProject,
  userDataFileIO('project-revisions.json'),
);

/**
 * Watches the open project file for **external** edits (e.g. an MCP agent) and
 * pushes the fresh, validated project to the renderer so the UI updates live
 * without re-opening (ADR 0030). Self-writes are suppressed via `markSelfWrite`
 * on every save below. The fs watch is on the *directory*, filtered to the file
 * name, because an atomic save (temp-write + rename) replaces the inode and a
 * per-file watch would go deaf after the first save.
 */
const projectWatcher = new ProjectFileWatcher({
  watch: (target, onChange) => {
    const dir = path.dirname(target);
    const name = path.basename(target);
    const watcher = fsWatch(dir, (_eventType, changed) => {
      // `changed` is null on some platforms — fall back to notifying.
      if (changed === null || changed === name) onChange();
    });
    // A transient watch error (e.g. the dir is briefly unavailable) must never
    // crash the main process; the next open re-establishes the watch.
    watcher.on('error', (error) =>
      aiLog.error('project watch error', { error: errorMessage(error) }),
    );
    return () => watcher.close();
  },
  read: readProjectFile,
  serialize: serializeProject,
  emit: ({ path: changedPath, project }) => {
    const { revision } = projectCommands.observe(project);
    mainWindow?.webContents.send(IpcChannels.projectChanged, {
      path: changedPath,
      project,
      revision,
    } satisfies ProjectChangedEvent);
  },
  onError: (error) => aiLog.error('project watch read failed', { error: errorMessage(error) }),
});

/** Engine base URL the main process uses to reach the render sidecar. */
const engineBaseUrl = `http://${engine.host}:${engine.port}`;

/**
 * Resolve and create the default projects folder. Created lazily (not at
 * startup) so a read-only environment that never autosaves never touches disk.
 */
async function ensureProjectsDir(): Promise<string> {
  const dir = resolveProjectsDir(process.env, app.getPath('documents'));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Register the closed set of IPC handlers the renderer may invoke. */
function registerIpcHandlers(): void {
  // electron.net.fetch is the Electron-idiomatic HTTP client (honours proxy +
  // certificates); the global `fetch` in the main process can silently fail.
  // Declared up front so both the render-export and AI handlers can use it.
  const electronFetch = net.fetch.bind(net) as typeof globalThis.fetch;

  // Keep the project brain's full-text index in lockstep with every save
  // (plan B2.1): fire-and-forget — indexing is a derived-cache refresh, so a
  // down sidecar or FTS5-less build must never delay or fail the save itself.
  const indexProjectBrain = (projectId: string, projectPath: string): void => {
    void electronFetch(`${engineBaseUrl}/brain/index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, project_path: projectPath }),
    })
      .then(async (response) => {
        const body = (await response.json()) as { available?: boolean; reason?: string };
        if (body.available === false) {
          aiLog.debug('brain index unavailable after save', { projectId, reason: body.reason });
        }
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        aiLog.debug('brain index request failed after save', { projectId, reason });
      });
  };

  // Session-start warmup (plan B5.6): on project open, fire-and-forget a quick
  // analysis pass over the bin so the brain is warm before the first AI request —
  // the first "find where I said X" no longer pays the full ffmpeg/probe cost
  // mid-conversation. Desktop-only (this is the main process); cancellable (opening
  // another project aborts the previous run so a stale warmup can't keep burning
  // ffmpeg); never awaited, so it never blocks the open. Already-analysed assets
  // are cache hits, so a re-open is cheap.
  let warmupController: AbortController | null = null;
  const warmSessionAnalysis = (projectId: string, projectPath: string): void => {
    warmupController?.abort();
    const controller = new AbortController();
    warmupController = controller;
    void runSessionWarmup({
      baseUrl: engineBaseUrl,
      projectId,
      projectPath,
      fetchFn: electronFetch,
      signal: controller.signal,
    })
      .then((result) => {
        aiLog.debug('session warmup settled', {
          projectId,
          status: result.status,
          analysed: result.analysed,
          total: result.total,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        aiLog.debug('session warmup threw', { projectId, reason });
      });
  };

  // License gate (100%-paid app). The service holds the key + install token in the
  // main process; only a safe status projection ever crosses the bridge. Enforcement
  // is active only when a Freemius product id is configured (else dev/unconfigured
  // builds run freely — see LicenseService). The activate/validate endpoints are
  // public and need only the product id, so no secret ships in the app.
  const licenseProductId =
    process.env.FRAMEPILOT_FREEMIUS_PRODUCT_ID ?? process.env.FREEMIUS_PRODUCT_ID ?? undefined;
  // OS-keychain-backed encryption for license.json (anti-crack). `safeStorage`
  // uses Keychain (macOS) / DPAPI (Windows) / libsecret (Linux); where no keyring
  // is available it reports unavailable and the store degrades to plaintext
  // rather than bricking. Ciphertext is base64 for JSON-safe on-disk storage.
  const licenseCrypto: LicenseCrypto = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (token) => safeStorage.decryptString(Buffer.from(token, 'base64')),
  };
  const licenseService = new LicenseService({
    store: new LicenseStore(
      path.join(app.getPath('userData'), 'license.json'),
      undefined,
      undefined,
      undefined,
      licenseCrypto,
    ),
    productId: licenseProductId,
    fetchFn: electronFetch,
    devBypass: process.env.FRAMEPILOT_LICENSE_DEV_BYPASS === '1',
  });
  // Defense-in-depth guard for heavy/abusable handlers: even though the renderer
  // gate blocks the UI when unlicensed, a tampered renderer must not reach these.
  const requireLicense = (): void => {
    if (!licenseService.isLicensedCached()) {
      throw new Error('A valid FramePilot license is required.');
    }
  };

  const capabilityPackRootKeyPath =
    process.env.FRAMEPILOT_CAPABILITY_PACK_ROOT_KEYS_PATH ??
    (app.isPackaged
      ? path.join(process.resourcesPath, 'capability-pack-root-keys.json')
      : undefined);
  const capabilityPackLocation = new FileCapabilityPackLocation(
    path.join(app.getPath('userData'), 'capability-pack-location.json'),
    path.join(app.getPath('userData'), 'capability-packs'),
  );
  const capabilityPackRootKeys = loadCapabilityPackRootKeys(capabilityPackRootKeyPath).catch(
    (error: unknown) => {
      aiLog.error('capability pack root keys unavailable', { error: errorMessage(error) });
      return [];
    },
  );
  /** In-flight tracking jobs, so the renderer can cancel one by request id. */
  const trackingRuns = new Map<string, AbortController>();
  let capabilityPackService: Promise<CapabilityPackDesktopService>;
  const createCapabilityPackService = async (
    rootPath: string,
  ): Promise<CapabilityPackDesktopService> =>
    new CapabilityPackDesktopService({
      rootPath,
      ...(process.env.FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL === undefined
        ? {}
        : { catalogUrl: process.env.FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL }),
      trustedRootKeys: await capabilityPackRootKeys,
      appVersion: app.getVersion(),
      fetch: electronFetch,
      onProgress: (progress) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.capabilityPackProgress, progress);
        }
      },
      onInstalled: async (identity) => {
        if (identity.id !== 'framepilot.local-whisper') return;
        const service = await capabilityPackService;
        capabilityPackRuntimeEnvironment = await service.runtimeEnvironment();
        sidecar.stop();
        await sidecar.start();
      },
    });
  /**
   * Music sourcing lives entirely in main.
   *
   * The renderer's CSP cannot reach a provider host, and this does not change
   * it: main fetches, and audition bytes reach the renderer over IPC as a
   * `blob:` URL, which `media-src` already permits. The renderer is never handed
   * a provider URL, so the guarantee is structural rather than a convention.
   */
  const musicService = new MusicService({
    projectsRoot: resolveProjectsDir(process.env, app.getPath('documents')),
    fetchImpl: electronFetch,
    deriveAssetMedia: async (absolutePath) => {
      // Reuses the existing /asset-media route — no new engine surface. A
      // failure is non-fatal: a missing waveform is a degraded timeline row, a
      // missing asset is a lost download.
      const derived = await importAssetViaSidecar(
        engineBaseUrl,
        { inputPath: absolutePath, thumbnails: 0, proxy: false },
        electronFetch,
      );
      return derived.ok ? derived : null;
    },
    onProgress: (progress) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.musicDownloadProgress, progress);
      }
    },
  });

  capabilityPackService = capabilityPackLocation
    .resolve()
    .then(({ activeRoot }) => createCapabilityPackService(activeRoot));
  void capabilityPackService
    .then(async (service) => {
      capabilityPackRuntimeEnvironment = await service.runtimeEnvironment();
    })
    .catch((error: unknown) => {
      aiLog.error('capability pack runtime environment unavailable', {
        error: errorMessage(error),
      });
    })
    .finally(() => sidecar.start());
  const reconcileCapabilityPacks = async (
    project: Project,
  ): Promise<CapabilityPackProjectResolutionWire> => {
    try {
      return await (
        await capabilityPackService
      ).reconcileProject(project.id, project.capabilityPacks ?? []);
    } catch (error) {
      aiLog.error('capability pack project reconciliation failed', {
        projectId: project.id,
        error: errorMessage(error),
      });
      const dependencies = (project.capabilityPacks ?? []).map((pin) => ({
        pin,
        status: 'missing' as const,
        detail: 'Capability Pack storage is unavailable.',
      }));
      return {
        dependencies,
        renderBlocked: dependencies.some(({ pin }) => pin.requiredFor === 'render'),
        editBlocked: dependencies.some(({ pin }) => pin.requiredFor === 'edit'),
      };
    }
  };

  ipcMain.handle(IpcChannels.ping, () => 'pong');
  ipcMain.handle(
    IpcChannels.licenseStatus,
    (): Promise<LicenseStatus> => licenseService.getStatus(),
  );
  ipcMain.handle(
    IpcChannels.licenseActivate,
    (_event, req: unknown): Promise<LicenseStatus> =>
      licenseService.activate((req as LicenseActivateRequest)?.licenseKey ?? ''),
  );
  ipcMain.handle(
    IpcChannels.licenseDeactivate,
    (): Promise<LicenseStatus> => licenseService.deactivate(),
  );
  ipcMain.handle(IpcChannels.sidecarStatus, () => sidecar.status);
  ipcMain.handle(
    IpcChannels.capabilityPackStorage,
    async (): Promise<CapabilityPackStorageSnapshotWire> =>
      await (await capabilityPackService).storage(),
  );
  ipcMain.handle(
    IpcChannels.capabilityPackRelocate,
    async (): Promise<CapabilityPackRelocationResultWire> => {
      requireLicense();
      const pickerOptions: OpenDialogOptions = {
        title: 'Move Capability Pack Storage',
        buttonLabel: 'Move Here',
        properties: ['openDirectory', 'createDirectory'],
      };
      const selected =
        mainWindow === null
          ? await dialog.showOpenDialog(pickerOptions)
          : await dialog.showOpenDialog(mainWindow, pickerOptions);
      const destinationRoot = selected.filePaths[0];
      if (selected.canceled || destinationRoot === undefined) {
        return { ok: false, code: 'cancelled', error: 'Storage move cancelled.' };
      }
      try {
        const current = await capabilityPackService;
        const previousRoot = current.storageRoot;
        let replacement: CapabilityPackDesktopService | undefined;
        await current.relocateStorage(
          destinationRoot,
          async (prepared) => {
            replacement = await createCapabilityPackService(prepared.destinationRoot);
            await replacement.storage();
            await capabilityPackLocation.commit(prepared.destinationRoot, prepared.sourceRoot);
            capabilityPackService = Promise.resolve(replacement);
            capabilityPackRuntimeEnvironment = await replacement.runtimeEnvironment();
            sidecar.stop();
            await sidecar.start();
          },
          (progress) => {
            if (mainWindow !== null && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IpcChannels.capabilityPackRelocationProgress, progress);
            }
          },
        );
        if (replacement === undefined)
          throw new Error('Capability Pack storage authority did not switch.');
        return { ok: true, storage: await replacement.storage(), previousRoot };
      } catch (error) {
        aiLog.error('capability pack relocation failed', { error: errorMessage(error) });
        return { ok: false, code: 'relocation_failed', error: errorMessage(error) };
      }
    },
  );
  ipcMain.handle(
    IpcChannels.capabilityPackPropose,
    async (_event, capabilityId: unknown): Promise<CapabilityPackProposalResultWire> => {
      requireLicense();
      return await (await capabilityPackService).propose(capabilityId);
    },
  );
  ipcMain.handle(
    IpcChannels.capabilityPackProposeProjectDependency,
    async (
      _event,
      projectId: unknown,
      packId: unknown,
    ): Promise<CapabilityPackProposalResultWire> => {
      requireLicense();
      if (typeof projectId !== 'string' || typeof packId !== 'string') {
        return {
          ok: false,
          code: 'catalog_invalid',
          error: 'Project dependency request is invalid.',
        };
      }
      const active = await activeProject.current();
      if (active === null || active.projectId !== projectId) {
        return { ok: false, code: 'approval_required', error: 'The project is no longer active.' };
      }
      try {
        const project = await readProjectFile(active.path);
        const pin = project.capabilityPacks?.find((candidate) => candidate.id === packId);
        if (pin === undefined) {
          return {
            ok: false,
            code: 'dependency_missing',
            error: 'The project no longer pins this pack.',
          };
        }
        return await (await capabilityPackService).proposeProjectDependency(project.id, pin);
      } catch (error) {
        return { ok: false, code: 'dependency_missing', error: errorMessage(error) };
      }
    },
  );
  ipcMain.handle(
    IpcChannels.capabilityPackProjectStatus,
    async (_event, projectId: unknown): Promise<CapabilityPackProjectResolutionWire> => {
      if (typeof projectId !== 'string') {
        throw new Error('Project dependency request is invalid.');
      }
      const active = await activeProject.current();
      if (active === null || active.projectId !== projectId) {
        throw new Error('The project is no longer active.');
      }
      const project = await readProjectFile(active.path);
      return await reconcileCapabilityPacks(project);
    },
  );
  ipcMain.handle(
    IpcChannels.capabilityPackTrack,
    async (event, intent: unknown): Promise<TrackingRunResultWire> => {
      requireLicense();
      const active = await activeProject.current();
      if (active === null) {
        return { ok: false, code: 'no_project', error: 'No project is open.', retryable: false };
      }
      // Main re-reads the project from disk: the renderer's view of the asset
      // list and the revision is never the authority for what gets tracked.
      const project = await readProjectFile(active.path);
      const revision = project.timeline.revision ?? 0;
      const built = buildTrackingWorkerRequest(project, revision, intent);
      if (built.status === 'rejected') {
        return { ok: false, code: built.code, error: built.detail, retryable: false };
      }
      const requestId = built.request.requestId;
      const controller = new AbortController();
      trackingRuns.set(requestId, controller);
      try {
        const outcome = await (await capabilityPackService).tracking().run(built.request, {
          projectRevision: revision,
          mediaRoot: built.mediaRoot,
          signal: controller.signal,
          onProgress: (progress: CapabilityPackWorkerProgress) => {
            if (event.sender.isDestroyed()) return;
            event.sender.send(IpcChannels.capabilityPackTrackProgress, {
              requestId,
              phase: progress.phase,
              completed: progress.completed,
              total: progress.total,
            } satisfies TrackingProgressWire);
          },
        });
        if (outcome.status === 'pack_missing') {
          return { ok: false, code: 'pack_missing', proposal: outcome.proposal };
        }
        if (outcome.status === 'failed') {
          return {
            ok: false,
            code: outcome.code,
            error: outcome.detail,
            retryable: outcome.retryable,
          };
        }
        const result = outcome.result;
        // The measurement payload mirrors the requested capability: tracking
        // samples steer masks, detections are evidence, mask runs feed the
        // silhouette-follow conversion host-side.
        if ('samples' in result) {
          return {
            ok: true,
            kind: 'tracking',
            samples: result.samples,
            engine: `${outcome.identity.id}@${outcome.identity.version}`,
            backend: result.backend,
            projectRevision: revision,
          };
        }
        if ('detections' in result) {
          return {
            ok: true,
            kind: 'detect',
            detections: result.detections,
            engine: `${outcome.identity.id}@${outcome.identity.version}`,
            backend: result.backend,
            projectRevision: revision,
          };
        }
        if ('masks' in result) {
          return {
            ok: true,
            kind: 'segment',
            masks: result.masks,
            engine: `${outcome.identity.id}@${outcome.identity.version}`,
            backend: result.backend,
            projectRevision: revision,
          };
        }
        return {
          ok: false,
          code: 'worker_failed',
          error: 'The worker returned a result that matches none of its capabilities.',
          retryable: false,
        };
      } finally {
        trackingRuns.delete(requestId);
      }
    },
  );
  ipcMain.on(IpcChannels.capabilityPackCancelTrack, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return;
    trackingRuns.get(requestId)?.abort();
  });
  ipcMain.handle(
    IpcChannels.capabilityPackInstall,
    async (_event, approval: unknown): Promise<CapabilityPackInstallStartResultWire> => {
      requireLicense();
      return (await capabilityPackService).startInstall(approval);
    },
  );
  ipcMain.on(IpcChannels.capabilityPackCancel, (_event, operationId: unknown) => {
    void capabilityPackService.then((service) => service.cancel(operationId));
  });
  ipcMain.handle(
    IpcChannels.capabilityPackPlanEviction,
    async (_event, requestedBytes: unknown): Promise<CapabilityPackEvictionPlanResultWire> => {
      requireLicense();
      return await (await capabilityPackService).planEviction(requestedBytes);
    },
  );
  ipcMain.handle(
    IpcChannels.capabilityPackExecuteEviction,
    async (_event, approval: unknown): Promise<CapabilityPackActionResultWire> => {
      requireLicense();
      return await (await capabilityPackService).executeEviction(approval);
    },
  );
  // Music sourcing. Every argument is renderer-supplied and therefore untrusted:
  // narrowed here, then acted on by `remoteId` against tracks THIS process
  // fetched. The renderer cannot name a URL for main to go and get.
  ipcMain.handle(
    IpcChannels.musicSearch,
    async (_event, query: unknown, limit: unknown): Promise<MusicSearchResult> => {
      requireLicense();
      if (typeof query !== 'string') {
        return { ok: false, error: 'provider_unavailable', detail: 'invalid query' };
      }
      return await musicService.search(
        query,
        typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined,
      );
    },
  );
  ipcMain.handle(
    IpcChannels.musicPreview,
    async (_event, remoteId: unknown): Promise<MusicPreviewResult> => {
      requireLicense();
      if (typeof remoteId !== 'string') {
        return { ok: false, error: 'provider_unavailable', detail: 'invalid track id' };
      }
      return await musicService.preview(remoteId);
    },
  );
  ipcMain.handle(
    IpcChannels.musicDownload,
    async (_event, request: unknown): Promise<MusicDownloadResult> => {
      requireLicense();
      const req = request as MusicDownloadRequest | null;
      if (
        typeof req?.projectId !== 'string' ||
        typeof req.remoteId !== 'string' ||
        typeof req.operationId !== 'string'
      ) {
        return { ok: false, error: 'download_failed', detail: 'invalid download request' };
      }
      return await musicService.download(req);
    },
  );
  ipcMain.on(IpcChannels.musicDownloadCancel, (_event, operationId: unknown) => {
    if (typeof operationId !== 'string') return;
    musicService.cancelDownload(operationId);
  });

  ipcMain.handle(IpcChannels.projectRecent, () => recentFiles.list());

  ipcMain.handle(
    IpcChannels.projectOpen,
    async (_event, projectPath: unknown): Promise<ProjectOpenResult> => {
      // Sandbox the renderer-supplied path to the projects folder (audit 1.1).
      const guard = sandboxProjectPath(await ensureProjectsDir(), projectPath);
      if (!guard.ok) return guard;
      try {
        const project = await readProjectFile(guard.path);
        await recentFiles.add({ path: guard.path, name: project.name, openedAt: Date.now() });
        // Publish the open project so the MCP server edits this same file.
        await activeProject.record({
          path: guard.path,
          projectId: project.id,
          updatedAt: Date.now(),
        });
        // Follow this file for external (e.g. MCP-agent) edits, pushing them live.
        await projectWatcher.watch(guard.path);
        // Warm the brain in the background so the first AI request isn't cold (B5.6).
        warmSessionAnalysis(project.id, guard.path);
        const { revision } = projectCommands.observe(project);
        const capabilityPacks = await reconcileCapabilityPacks(project);
        return { ok: true, path: guard.path, project, revision, capabilityPacks };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // Native file picker — the user explicitly picks the file, so no sandbox
  // restriction applies (the main process owns the dialog, not the renderer).
  ipcMain.handle(IpcChannels.projectOpenDialog, async (_event): Promise<ProjectOpenResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Open Project',
      filters: [{ name: 'FramePilot Project', extensions: ['fp.json', 'json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    const selectedPath = filePaths[0]!;
    try {
      const project = await readProjectFile(selectedPath);
      await recentFiles.add({ path: selectedPath, name: project.name, openedAt: Date.now() });
      // A file picked from outside the projects folder is still recorded; the
      // MCP server sandbox-rejects it safely if it later tries to open it.
      await activeProject.record({
        path: selectedPath,
        projectId: project.id,
        updatedAt: Date.now(),
      });
      // A file picked from outside the projects folder is watched all the same;
      // the MCP server's sandbox is the only thing that gates *its* edits.
      await projectWatcher.watch(selectedPath);
      // Warm the brain in the background so the first AI request isn't cold (B5.6).
      warmSessionAnalysis(project.id, selectedPath);
      const { revision } = projectCommands.observe(project);
      const capabilityPacks = await reconcileCapabilityPacks(project);
      return { ok: true, path: selectedPath, project, revision, capabilityPacks };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IpcChannels.projectSave,
    async (
      _event,
      projectPath: unknown,
      payload: unknown,
      expectedRevision: unknown,
    ): Promise<ProjectSaveResult> => {
      const guard = sandboxProjectPath(await ensureProjectsDir(), projectPath);
      if (!guard.ok) return guard;
      try {
        // Validate before persisting — never write an unvalidated document
        // (AGENTS.md invariant 3). `parseProject` throws on a bad shape.
        const project = parseProject(payload);
        const expected =
          typeof expectedRevision === 'number' &&
          Number.isSafeInteger(expectedRevision) &&
          expectedRevision >= 0
            ? expectedRevision
            : undefined;
        if (expectedRevision !== undefined && expected === undefined) {
          return { ok: false, error: 'Expected project revision must be a safe integer.' };
        }
        const committed = await projectCommands.write(project, expected, async () => {
          // Declare our own write *before* it lands so the watcher recognises the
          // resulting fs event as a self-write and does not echo it to the renderer.
          projectWatcher.markSelfWrite(guard.path, project);
          await writeProjectFile(guard.path, project);
          await projectWatcher.watch(guard.path);
          // The freshly-saved, validated project becomes the recovery point.
          await recovery.snapshot({ path: guard.path, project, savedAt: Date.now() });
          // …and the active project the MCP server targets.
          await activeProject.record({
            path: guard.path,
            projectId: project.id,
            updatedAt: Date.now(),
          });
        });
        if (!committed.ok) {
          return {
            ok: false,
            error: `Project changed at revision ${committed.currentRevision}; expected ${committed.expectedRevision}.`,
            code: committed.code,
            expectedRevision: committed.expectedRevision,
            currentRevision: committed.currentRevision,
          };
        }
        indexProjectBrain(project.id, guard.path);
        await reconcileCapabilityPacks(project);
        return { ok: true, path: guard.path, revision: committed.revision };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // Autosave a path-less project: derive a stable file name from the project id
  // and write it under the (sandboxed) default projects folder, so the user
  // never has to pick a location before the first save.
  ipcMain.handle(
    IpcChannels.projectSaveDefault,
    async (_event, payload: unknown, expectedRevision: unknown): Promise<ProjectSaveResult> => {
      try {
        const project = parseProject(payload);
        const dir = await ensureProjectsDir();
        const target = defaultProjectPath(dir, project.id);
        const expected =
          typeof expectedRevision === 'number' &&
          Number.isSafeInteger(expectedRevision) &&
          expectedRevision >= 0
            ? expectedRevision
            : undefined;
        if (expectedRevision !== undefined && expected === undefined) {
          return { ok: false, error: 'Expected project revision must be a safe integer.' };
        }
        const committed = await projectCommands.write(project, expected, async () => {
          projectWatcher.markSelfWrite(target, project);
          await writeProjectFile(target, project);
          await projectWatcher.watch(target);
          await recovery.snapshot({ path: target, project, savedAt: Date.now() });
          await recentFiles.add({ path: target, name: project.name, openedAt: Date.now() });
          await activeProject.record({
            path: target,
            projectId: project.id,
            updatedAt: Date.now(),
          });
        });
        if (!committed.ok) {
          return {
            ok: false,
            error: `Project changed at revision ${committed.currentRevision}; expected ${committed.expectedRevision}.`,
            code: committed.code,
            expectedRevision: committed.expectedRevision,
            currentRevision: committed.currentRevision,
          };
        }
        indexProjectBrain(project.id, target);
        await reconcileCapabilityPacks(project);
        return { ok: true, path: target, revision: committed.revision };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.projectCommitPatch,
    async (_event, payload: unknown): Promise<ProjectPatchCommitResult> => {
      try {
        const request = parsePatchCommitRequest(payload);
        const active = await activeProject.current();
        if (!active || active.projectId !== request.projectId) {
          return {
            ok: false,
            error: 'The requested project is not the active authoritative project.',
            code: 'project_not_open',
            conflictKind: 'authority_required',
          };
        }
        if (request.runId !== undefined) {
          const run = await runGatewayCoordinator.snapshot(request.runId);
          if (run === null || run.projectId !== request.projectId) {
            return {
              ok: false,
              error: 'The patch run is not authoritative for this project.',
              code: 'project_not_open',
              conflictKind: 'authority_required',
            };
          }
        }
        // `committed.project` may be a transport-compaction envelope rather than a
        // full Project (project-command-service.ts strips it to save IPC payload
        // size on same-revision commits), so capture the real committed Project
        // from the write callback for anything that needs to parse it below.
        let committedProject: Project | undefined;
        const committed = await projectCommands.commitPatch(
          request.projectId,
          request.expectedRevision,
          request.patch,
          async (project) => {
            committedProject = project;
            projectWatcher.markSelfWrite(active.path, project);
            await writeProjectFile(active.path, project);
            await projectWatcher.watch(active.path);
            await recovery.snapshot({ path: active.path, project, savedAt: Date.now() });
            await activeProject.record({
              path: active.path,
              projectId: project.id,
              updatedAt: Date.now(),
            });
          },
          request.runId,
        );
        if (!committed.ok) {
          if (request.runId !== undefined && committed.code === 'revision_conflict') {
            await runGatewayCoordinator.recordPatchLifecycle({
              runId: request.runId,
              projectId: request.projectId,
              patchId: request.patch.patchId,
              state: 'stale',
              ...(committed.currentRevision === undefined
                ? {}
                : { projectRevision: committed.currentRevision }),
              reason: 'The authoritative project changed and the patch overlaps newer edits.',
            });
          }
          const problem = committed.issues
            ?.filter((issue) => issue.severity === 'error')
            .map((issue) => issue.message)
            .join('; ');
          return {
            ok: false,
            error:
              problem ??
              (committed.code === 'revision_conflict'
                ? 'The project changed and this patch no longer applies cleanly.'
                : 'The patch could not be committed.'),
            code: committed.code,
            ...(committed.conflictKind === undefined
              ? {}
              : { conflictKind: committed.conflictKind }),
            ...(committed.currentRevision === undefined
              ? {}
              : { currentRevision: committed.currentRevision }),
            ...(committed.issues === undefined ? {} : { issues: committed.issues }),
          };
        }
        if (request.runId !== undefined) {
          await runGatewayCoordinator.recordPatchLifecycle({
            runId: request.runId,
            projectId: request.projectId,
            patchId: request.patch.patchId,
            state: committed.rebased ? 'rebased' : 'committed',
            projectRevision: committed.revision,
          });
        }
        indexProjectBrain(committed.project.id, active.path);
        // `committedProject` is set whenever the write callback ran (a fresh, non-
        // rebased, non-replayed commit) — that's the only case where `committed.project`
        // is the transport envelope instead of a full Project.
        await reconcileCapabilityPacks(
          parseProject(committedProject ?? (committed.project as Project)),
        );
        return {
          ok: true,
          project: committed.project,
          revision: committed.revision,
          rebased: committed.rebased,
          ...(committed.conflictKind === undefined ? {} : { conflictKind: committed.conflictKind }),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error), code: 'invalid_patch' };
      }
    },
  );

  ipcMain.handle(IpcChannels.projectsDir, () => ensureProjectsDir());

  // Reveal a saved file (or the projects folder when no path yet) in Finder/
  // Explorer. `showItemInFolder` selects the file; `openPath` opens the folder.
  ipcMain.handle(
    IpcChannels.projectReveal,
    async (_event, target: unknown): Promise<RevealResult> => {
      try {
        if (typeof target === 'string' && target.trim() !== '') {
          // Only reveal paths inside the projects folder (audit 1.1).
          const guard = sandboxProjectPath(await ensureProjectsDir(), target);
          if (!guard.ok) return guard;
          shell.showItemInFolder(guard.path);
        } else {
          const error = await shell.openPath(await ensureProjectsDir());
          if (error) {
            return { ok: false, error };
          }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // Export: the renderer hands us a saved project path; we delegate the actual
  // MoviePy/FFmpeg render to the Python sidecar and report the validated output.
  ipcMain.handle(IpcChannels.renderExport, async (_event, req: unknown): Promise<ExportResult> => {
    try {
      requireLicense();
      const request = req as ExportRequest;
      // The sidecar renders the project from disk — sandbox the path first (audit 1.1).
      const guard = sandboxProjectPath(await ensureProjectsDir(), request?.projectPath);
      if (!guard.ok) return guard;
      return await exportViaSidecar(
        engineBaseUrl,
        { ...request, projectPath: guard.path },
        electronFetch,
      );
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // Async full export (H1.3b): the sidecar's `/render` is itself async (submit
  // + poll, H1.3a) — the hub mints a requestId, submits/polls in the
  // background, and pushes live status to the renderer instead of the handler
  // blocking on the whole render. Sandbox/license failures are reported over
  // the same progress channel (under a freshly minted id) so the renderer only
  // needs one code path to learn how its export finished.
  const exportHub = new ExportHub({
    progressChannel: IpcChannels.renderExportProgress,
    baseUrl: () => engineBaseUrl,
    fetchFn: electronFetch,
  });
  ipcMain.handle(IpcChannels.renderExportStart, async (event, req: unknown): Promise<string> => {
    const requestId = exportHub.mintId();
    try {
      requireLicense();
      const request = req as ExportRequest;
      const guard = sandboxProjectPath(await ensureProjectsDir(), request?.projectPath);
      if (!guard.ok) {
        exportHub.reportImmediateFailure(event.sender, requestId, guard);
        return requestId;
      }
      return exportHub.start(event.sender, { ...request, projectPath: guard.path }, requestId);
    } catch (error) {
      exportHub.reportImmediateFailure(event.sender, requestId, {
        ok: false,
        error: errorMessage(error),
      });
      return requestId;
    }
  });
  ipcMain.on(IpcChannels.renderExportCancel, (event, requestId: unknown) =>
    exportHub.cancel(event.sender, requestId),
  );
  app.on('before-quit', () => exportHub.abortAll());

  // Save As: copy an already-exported render (sandboxed under exports/) to a
  // user-chosen location. A native dialog picks the destination — the render
  // engine itself never writes outside the projects sandbox (ipc/sandbox.ts).
  ipcMain.handle(
    IpcChannels.exportSaveAs,
    async (_event, req: unknown): Promise<ExportSaveAsResult> => {
      const { sourcePath, suggestedName } = (req ?? {}) as Partial<ExportSaveAsRequest>;
      const defaultPath = suggestedName
        ? path.join(app.getPath('downloads'), suggestedName)
        : undefined;
      return saveExportAs(
        await ensureProjectsDir(),
        sourcePath,
        defaultPath,
        (options) => dialog.showSaveDialog(options),
        copyFile,
      );
    },
  );

  // Import: copy renderer-supplied media bytes into the per-project media folder
  // so the render engine and the fp-media:// preview both resolve the same disk
  // file. The project id and file name are untrusted — the helper sanitises them
  // and re-checks containment against the projects root (audit 1.1).
  ipcMain.handle(
    IpcChannels.mediaImport,
    async (_event, req: unknown): Promise<MediaImportResult> => {
      try {
        const { projectId, fileName, data } = req as MediaImportRequest;
        const projectsRoot = await ensureProjectsDir();
        const path = await importMediaFile(projectsRoot, projectId, fileName, new Uint8Array(data));
        return { ok: true, path };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // Derive engine media (waveform peaks + thumbnails) for an already-on-disk
  // media file via the sidecar, so the timeline draws real waveforms/filmstrip
  // frames. The renderer-supplied path is untrusted — sandbox it under the
  // projects root before the sidecar is hit (audit 1.1; the engine sandboxes too,
  // defense in depth). A sidecar/engine failure is reported as `{ ok: false }`
  // and is non-fatal upstream (the import still succeeds, without media).
  ipcMain.handle(
    IpcChannels.mediaImportAsset,
    async (_event, req: unknown): Promise<ImportAssetResult> => {
      try {
        const request = req as ImportAssetRequest;
        const guard = sandboxProjectPath(await ensureProjectsDir(), request?.inputPath);
        if (!guard.ok) return guard;
        return await importAssetViaSidecar(
          engineBaseUrl,
          { ...request, inputPath: guard.path },
          electronFetch,
        );
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // Transcription is host-owned: validate the provider and project/asset ids,
  // sandbox every on-disk path, keep hosted credentials in main, and never
  // report an empty provider response as a successful transcript.
  ipcMain.handle(
    IpcChannels.transcribe,
    async (_event, req: unknown): Promise<TranscriptionResult> => {
      try {
        requireLicense();
        const request = (req ?? {}) as Partial<TranscriptionRequest>;
        if (!request.provider || !isAsrProviderName(request.provider)) {
          return { ok: false, error: 'Unknown speech-to-text provider.' };
        }
        if (typeof request.assetId !== 'string' || request.assetId.trim() === '') {
          return { ok: false, error: 'Choose a media asset to transcribe.' };
        }

        const projectsRoot = await ensureProjectsDir();
        const projectGuard = sandboxProjectPath(projectsRoot, request.projectPath);
        if (!projectGuard.ok) return projectGuard;
        const project = await readProjectFile(projectGuard.path);
        const asset = project.assets.find((candidate) => candidate.id === request.assetId);
        if (!asset) {
          return { ok: false, error: `Asset "${request.assetId}" was not found in the project.` };
        }
        if (asset.kind !== 'audio' && asset.kind !== 'video') {
          return { ok: false, error: 'Only audio and video assets can be transcribed.' };
        }

        const result =
          request.provider === 'twelvelabs'
            ? await transcribeTwelveLabs(project, projectGuard.path, asset.id)
            : await (async (): Promise<AsrResult> => {
                const apiKey = aiConfig.resolveAsrApiKey();
                const asrModel = aiConfig.resolveAsrModel();
                const provider = createAsrProvider(
                  request.provider,
                  {
                    ...(apiKey !== undefined ? { apiKey } : {}),
                    ...(request.provider !== 'whisper-cli' && asrModel !== undefined
                      ? { model: asrModel }
                      : {}),
                    ...(request.provider === 'whisper-cli' ? { baseUrl: engineBaseUrl } : {}),
                  },
                  electronFetch,
                );
                if (provider.name === 'whisper-cli') {
                  return provider.transcribe({
                    projectPath: projectGuard.path,
                    assetId: asset.id,
                  });
                }
                if (provider.name === 'twelvelabs') {
                  return { available: false, reason: 'TwelveLabs routing failed.' };
                }
                return transcribeHostedMaybeChunked({
                  provider,
                  bytes: new Uint8Array(
                    await readFile(
                      resolveWithin(
                        projectsRoot,
                        path.resolve(path.dirname(projectGuard.path), asset.path),
                      ),
                    ),
                  ),
                  filename: path.basename(asset.path),
                  mimeType: mediaContentType(asset.path),
                  durationSeconds: asset.durationSeconds,
                  project,
                  assetId: asset.id,
                });
              })();

        if (!result.available) {
          return { ok: false, error: result.reason, unavailable: true };
        }
        if (result.words.length === 0) {
          return {
            ok: false,
            error:
              'The speech-to-text provider returned no words. The existing transcript was kept.',
          };
        }
        aiLog.action('transcription completed', {
          provider: request.provider,
          assetId: asset.id,
          words: result.words.length,
        });
        return { ok: true, assetId: asset.id, words: result.words };
      } catch (error) {
        aiLog.error('transcription failed', { error: errorMessage(error) });
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // AI handlers run in the main process using the shared `electronFetch` above.
  // The provider is chosen per call: an explicit UI selection (validated) wins, else
  // the configured `FRAMEPILOT_AI_PROVIDER` default. A provider whose key is missing
  // still constructs (the provider throws at call time with an actionable message).
  // API keys + the active provider/model come from Settings → AI, persisted to a
  // plaintext `ai-config.json` in the app data dir (env vars remain a fallback). The
  // key stays here — the renderer sets it write-only and never reads it back.
  const aiConfig = new AiConfigStore(path.join(app.getPath('userData'), 'ai-config.json'));
  // Analysis/action tools (analyze_silence, detect_scenes, detect_beats) execute
  // against the local render sidecar — truthful host execution, never fabricated
  // (plan AGENT-NATIVE-UX T3). Shared across providers; the sidecar is per-app.
  const visualIndexCredentials = (): Pick<
    VisualIndexRequestInput,
    'nvidiaKeys' | 'twelveLabsKey' | 'captionProvider'
  > => {
    const providerName = aiConfig.visualCaptionProvider();
    const provider = aiConfig.resolveConfig(providerName);
    const defaults: Partial<Record<AiProviderName, string>> = {
      nvidia: 'https://integrate.api.nvidia.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      'vercel-gateway': 'https://ai-gateway.vercel.sh/v1',
      groq: 'https://api.groq.com/openai/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta/openai',
      ollama: 'http://127.0.0.1:11434/v1',
      deepseek: 'https://api.deepseek.com/v1',
    };
    const baseUrl = provider.baseUrl ?? defaults[providerName];
    const captionProvider =
      providerName === 'mock' || (providerName !== 'ollama' && !provider.apiKey)
        ? undefined
        : {
            kind: providerName === 'anthropic' ? ('anthropic' as const) : ('openai' as const),
            model: provider.model ?? 'vision-model',
            apiKey: provider.apiKey ?? '',
            ...(baseUrl !== undefined ? { baseUrl } : {}),
          };
    const nvidiaKeys = aiConfig.resolveEmbeddingsKeys();
    const twelveLabsKey = aiConfig.resolveTwelveLabsKey();
    return {
      ...(nvidiaKeys !== undefined ? { nvidiaKeys } : {}),
      ...(twelveLabsKey !== undefined ? { twelveLabsKey } : {}),
      ...(captionProvider !== undefined ? { captionProvider } : {}),
    };
  };
  // Hosted-ASR request window: clips longer than this are decoded to a mono-16k WAV
  // and split into ≤30s chunks before upload, so a minutes-long file is never POSTed
  // to the hosted API in one huge request (plan H0.1). ≤30s is sent whole.
  const HOSTED_ASR_CHUNK_SECONDS = 30;
  // Decode an asset's audio to a mono-16k PCM WAV via the engine so long clips can be
  // chunked before upload. Returns null (caller falls back to a single whole-file
  // request) when the engine can't prepare it — transcription still works for short files.
  const fetchPreparedWav = async (
    project: Project,
    assetId: string,
  ): Promise<Uint8Array | null> => {
    try {
      const response = await electronFetch(`${engineBaseUrl}/asr/prepare-audio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, asset_id: assetId }),
      });
      if (!response.ok) {
        aiLog.warn('asr prepare-audio non-ok; sending whole file', { status: response.status });
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      aiLog.warn('asr prepare-audio failed; sending whole file', { error: errorMessage(error) });
      return null;
    }
  };
  // Transcribe with a hosted provider, chunking into 30s windows when the clip is
  // longer than one window. The provider's own comma-separated key failover runs
  // inside each `transcribe` call (per chunk). Falls back to a single whole-file
  // request for short clips or when the engine can't prepare the audio.
  const transcribeHostedMaybeChunked = async (args: {
    provider: ChunkTranscriber;
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    durationSeconds: number | undefined;
    project: Project;
    assetId: string;
  }): Promise<AsrResult> => {
    if (args.durationSeconds !== undefined && args.durationSeconds > HOSTED_ASR_CHUNK_SECONDS) {
      const wav = await fetchPreparedWav(args.project, args.assetId);
      if (wav) {
        return transcribeWavInChunks(args.provider, wav, {
          chunkSeconds: HOSTED_ASR_CHUNK_SECONDS,
          filenameBase: args.filename,
        });
      }
    }
    return args.provider.transcribe({
      bytes: args.bytes,
      filename: args.filename,
      mimeType: args.mimeType,
    });
  };

  /**
   * Ensure one asset is indexed by TwelveLabs, then read its native word-level
   * transcript. This is shared by the manual and agent paths so provider choice,
   * indexing, errors, and timing behavior cannot drift between the two surfaces.
   */
  const transcribeTwelveLabs = async (
    project: Project,
    projectPath: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<AsrResult> => {
    const apiKey = aiConfig.resolveTwelveLabsKey();
    if (!apiKey) {
      return {
        available: false,
        reason: 'Add a TwelveLabs API key in Settings → AI → Media intelligence.',
      };
    }
    const indexClient = new VisualIndexClient({ baseUrl: engineBaseUrl, fetchFn: electronFetch });
    const indexed = await runVisualIndexLoop({
      client: indexClient,
      request: {
        projectId: project.id,
        projectPath,
        assetIds: [assetId],
        twelveLabsKey: apiKey,
      },
      ...(signal ? { signal } : {}),
    });
    if (indexed.status !== 'done') {
      return {
        available: false,
        reason:
          indexed.last?.reason ??
          `TwelveLabs indexing did not complete (${indexed.status.replaceAll('-', ' ')}).`,
      };
    }
    const provider = createAsrProvider(
      'twelvelabs',
      { apiKey, baseUrl: engineBaseUrl },
      electronFetch,
    );
    if (provider.name !== 'twelvelabs') {
      return { available: false, reason: 'TwelveLabs transcription is unavailable.' };
    }
    return provider.transcribe({ projectPath, projectId: project.id, assetId }, signal);
  };
  // Route the AI agent's `transcribe` to the user-selected ASR provider. Local
  // whisper-cli runs in the Python sidecar (return null → sidecar `/transcribe`
  // route), but the hosted providers (groq/nvidia) run here: they hold the
  // off-device API key and read audio bytes from disk. WHY here and not the
  // sidecar — hosted ASR credentials and the raw audio never leave the trusted
  // host (plan H0.1 / invariant 11). This mirrors the IPC `transcribe` handler so
  // the agent path honors the same Provider choice the manual button does.
  const hostTranscribe = async (
    project: Project,
    assetId: string | undefined,
    signal?: AbortSignal,
  ): Promise<HostToolOutcome | null> => {
    const providerName = aiConfig.resolveAsrProvider();
    if (providerName === 'whisper-cli') return null;
    if (typeof assetId !== 'string' || assetId.trim() === '') {
      return { status: 'failed', summary: 'transcribe needs an asset to work on.' };
    }
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      return { status: 'failed', summary: `Asset "${assetId}" was not found in the project.` };
    }
    if (asset.kind !== 'audio' && asset.kind !== 'video') {
      return { status: 'failed', summary: 'Only audio and video assets can be transcribed.' };
    }
    const active = await activeProject.current();
    if (!active || active.projectId !== project.id) {
      return {
        status: 'failed',
        summary: 'Hosted transcription needs the active on-disk project to read the audio.',
      };
    }
    try {
      const projectsRoot = await ensureProjectsDir();
      if (providerName === 'twelvelabs') {
        const result = await transcribeTwelveLabs(project, active.path, asset.id, signal);
        if (!result.available) return { status: 'failed', summary: result.reason };
        if (result.words.length === 0) {
          return {
            status: 'failed',
            summary: 'TwelveLabs returned no timed words; the existing transcript was preserved.',
          };
        }
        return {
          status: 'completed',
          summary: `Transcribed ${result.words.length} timed word${result.words.length === 1 ? '' : 's'}`,
          data: { words: result.words },
        };
      }
      const apiKey = aiConfig.resolveAsrApiKey();
      const asrModel = aiConfig.resolveAsrModel();
      const provider = createAsrProvider(
        providerName,
        {
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(asrModel !== undefined ? { model: asrModel } : {}),
        },
        electronFetch,
      );
      // whisper-cli is handled above; a hosted provider takes audio bytes in.
      if (provider.name === 'whisper-cli') return null;
      if (provider.name === 'twelvelabs') {
        return { status: 'failed', summary: 'TwelveLabs routing failed.' };
      }
      const bytes = new Uint8Array(
        await readFile(
          resolveWithin(projectsRoot, path.resolve(path.dirname(active.path), asset.path)),
        ),
      );
      const result = await transcribeHostedMaybeChunked({
        provider,
        bytes,
        filename: path.basename(asset.path),
        mimeType: mediaContentType(asset.path),
        durationSeconds: asset.durationSeconds,
        project,
        assetId: asset.id,
      });
      if (!result.available) return { status: 'failed', summary: result.reason };
      if (result.words.length === 0) {
        return {
          status: 'failed',
          summary: '"transcribe" returned no timed words; the existing transcript was preserved.',
        };
      }
      aiLog.action('agent transcription completed', {
        provider: providerName,
        assetId: asset.id,
        words: result.words.length,
      });
      const n = result.words.length;
      return {
        status: 'completed',
        summary: `Transcribed ${n} timed word${n === 1 ? '' : 's'}`,
        data: { words: result.words },
      };
    } catch (error) {
      return { status: 'failed', summary: `transcribe failed: ${errorMessage(error)}` };
    }
  };
  /**
   * `search_music` for the agent — the same main-process service the Sounds
   * panel uses, so a track the agent finds is a track a person could have found.
   */
  const hostMusicSearch = async (
    query: string,
    limit: number | undefined,
  ): Promise<HostToolOutcome> => {
    if (query.trim() === '') {
      return { status: 'failed', summary: 'search_music needs something to search for.' };
    }
    const result = await musicService.search(query, limit);
    if (!result.ok) {
      // The provider's own reason, verbatim. "Something went wrong" would leave
      // the model unable to tell a rate limit from an outage, and it would
      // retry the one case where retrying is exactly wrong.
      return { status: 'failed', summary: musicErrorMessage(result.error, result.detail) };
    }
    if (result.tracks.length === 0) {
      // Nothing matched is not a failure, but it is also NOT a success the model
      // should build on — `warning` is the arm that says "ran, nothing to do".
      return {
        status: 'warning',
        summary: `No tracks matched "${query}". Try a broader mood word.`,
        data: { tracks: [] },
      };
    }
    return {
      status: 'completed',
      summary: `Found ${result.tracks.length} track${result.tracks.length === 1 ? '' : 's'} for "${query}".`,
      data: { tracks: result.tracks },
    };
  };

  /**
   * `add_music` for the agent — download and materialize; the ORCHESTRATOR turns
   * the returned asset into operations. This function deliberately produces no
   * timeline change of its own (AGENTS.md invariant 5).
   */
  const hostAddMusic = async (
    project: Project,
    args: {
      readonly remoteId: string;
      readonly atSeconds?: number;
      readonly duckUnderTrackId?: string;
    },
    _signal?: AbortSignal,
  ): Promise<HostToolOutcome> => {
    const { remoteId, atSeconds, duckUnderTrackId } = args;
    if (remoteId.trim() === '') {
      return {
        status: 'failed',
        summary: 'add_music needs the remoteId of a track from search_music.',
      };
    }
    const result = await musicService.download({
      projectId: project.id,
      remoteId,
      operationId: `agent_${remoteId}_${Date.now()}`,
    });
    if (!result.ok) {
      return { status: 'failed', summary: musicErrorMessage(result.error, result.detail) };
    }
    const { asset } = result;
    return {
      status: 'completed',
      summary: `Downloaded "${asset.relativePath}".`,
      data: {
        asset: {
          id: `music_${asset.source.provider}_${asset.source.remoteId}`.replace(
            /[^a-zA-Z0-9_]/g,
            '_',
          ),
          path: asset.relativePath,
          kind: 'audio',
          ...(asset.durationSeconds === undefined
            ? {}
            : { durationSeconds: asset.durationSeconds }),
          ...(asset.media ? { media: asset.media } : {}),
          source: asset.source,
        },
        // Echoed back so the ORCHESTRATOR owns the placement decision; this
        // function still produces no timeline change of its own.
        ...(atSeconds === undefined ? {} : { atSeconds }),
        ...(duckUnderTrackId === undefined ? {} : { duckUnderTrackId }),
      },
    };
  };

  const sidecarToolExecutor = createSidecarExecutor({
    baseUrl: engineBaseUrl,
    fetchFn: electronFetch,
    visualIndexCredentials,
    hostTranscribe,
    hostMusicSearch,
    hostAddMusic,
  });
  // The agent's route into the Capability Pack tracking worker. Same authority
  // the renderer IPC path uses — one hub, leases and install proposals included.
  const automaticTrackingExecutor = createAutomaticTrackingExecutor({
    tracking: async () => (await capabilityPackService).tracking(),
  });
  const toolExecutor: HostToolExecutor = {
    async run(call, ctx, signal) {
      if (
        call.name === AUTOMATIC_TRACKING_TOOL_NAME ||
        call.name === DETECT_SUBJECTS_TOOL_NAME
      ) {
        return automaticTrackingExecutor.run(call, ctx, signal);
      }
      return sidecarToolExecutor.run(call, ctx, signal);
    },
  };
  const temporalEvidence = createTemporalEvidenceAcquirer({
    baseUrl: engineBaseUrl,
    fetchFn: electronFetch,
  });
  const getOrchestrator = (
    requested?: AiProviderName,
    effectObserver?: EffectRuntimeObserver,
  ): Orchestrator => {
    const name: AiProviderName = requested ?? aiConfig.activeProvider();
    // Diagnostic: prove which provider each AI call actually uses (terminal-visible).
    const resolved = aiConfig.resolveConfig(name);
    aiLog.action('getOrchestrator — provider selected', {
      provider: name,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      hasKey: Boolean(resolved.apiKey),
    });
    // Wrap every provider in the shared reliability policy (retry/backoff/timeout)
    // so the desktop hub inherits the same resilience as the browser + MCP surfaces
    // (invariant 6, R1).
    const orchestratorOptions = {
      executor: toolExecutor,
      ...(effectObserver === undefined ? {} : { effectObserver }),
    };
    // Every hosted provider is a LangChain adapter behind one seam (ADR 0105). This used
    // to be a seven-branch chain constructing native adapter classes directly, each handed
    // `electronFetch` (Chromium's net stack, so system proxy and enterprise root CAs
    // applied). The LangChain clients bring their own HTTP, so that injection is gone —
    // recorded as a known consequence in ADR 0105, not an oversight.
    if (name !== 'mock') {
      return new Orchestrator(
        withResilience(createProviderFromConfig(aiConfig.resolveConfig(name))),
        orchestratorOptions,
      );
    }
    return new Orchestrator(withResilience(new MockProvider()), orchestratorOptions);
  };

  // Report the selectable providers + their model/ready state to the sidebar picker.
  // `ready` reflects whether the provider's API key is configured; the KEY ITSELF is
  // never returned — only names, labels, model ids, and the boolean. Mock is always ready.
  ipcMain.handle(IpcChannels.aiProviders, (): AiProviderInfo[] => [
    ...aiConfig.toAiConfig().providers,
  ]);
  ipcMain.handle(IpcChannels.aiConfigGet, (): AiConfig => aiConfig.toAiConfig());
  ipcMain.handle(
    IpcChannels.aiConfigSet,
    (_event, update: unknown): AiConfig => aiConfig.applyUpdate((update ?? {}) as AiConfigUpdate),
  );
  const desktopVisualIndex = new VisualIndexClient({
    baseUrl: engineBaseUrl,
    fetchFn: electronFetch,
  });
  ipcMain.handle(
    IpcChannels.visualIndex,
    async (_event, request: VisualIndexRequest): Promise<VisualIndexResult | undefined> => {
      return desktopVisualIndex.index({ ...request, ...visualIndexCredentials() });
    },
  );

  ipcMain.handle(IpcChannels.aiChat, async (_event, req: unknown): Promise<AiTextResult> => {
    try {
      requireLicense();
      const { project, userPrompt } = req as AiRequest;
      const result = await getOrchestrator().chat({ project: parseProject(project), userPrompt });
      return { ok: true, text: result.text };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IpcChannels.aiPlan, async (_event, req: unknown): Promise<AiTextResult> => {
    try {
      requireLicense();
      const { project, userPrompt } = req as AiRequest;
      const result = await getOrchestrator().plan({ project: parseProject(project), userPrompt });
      return { ok: true, text: result.text };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IpcChannels.aiEdit, async (_event, req: unknown): Promise<AiEditResult> => {
    try {
      requireLicense();
      const { project, userPrompt } = req as AiRequest;
      const result = await getOrchestrator().edit({ project: parseProject(project), userPrompt });
      return {
        ok: true,
        patch: result.patch,
        validation: result.validation,
        diff: result.diff,
        text: result.text,
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // AI-sidebar conversation persistence (Phase 11 M2, ADR 0033). A separate JSON
  // store under user-data; the store sanitizes ids (no path traversal).
  ipcMain.handle(
    IpcChannels.conversationsList,
    (): Promise<ConversationSummary[]> => conversations.list(),
  );
  ipcMain.handle(
    IpcChannels.conversationsLoad,
    (_event, id: unknown): Promise<unknown | null> => conversations.load(id),
  );
  ipcMain.handle(
    IpcChannels.conversationsSave,
    (_event, record: unknown): Promise<ConversationSaveResult> => conversations.save(record),
  );
  ipcMain.handle(
    IpcChannels.conversationsDelete,
    (_event, id: unknown): Promise<ConversationSaveResult> => conversations.delete(id),
  );

  // Streaming AI sidebar (Phase 11 M3, ADR 0033). Fetch runs here (no sandbox); the
  // hub mints an unguessable requestId, scopes events + aborts to the owning sender,
  // re-validates the request, bounds the run with a timeout, and aborts on a destroyed
  // window. No secret crosses the bridge; only AiEvents do. (security review, M3 gate)
  const aiStreamHub = new AiStreamHub(getOrchestrator, {
    eventChannel: IpcChannels.aiStreamEvent,
    temporalEvidence,
    // Tell every run what it can SEE. The SDK has had a context block for this since the
    // visual index landed, and nothing ever filled it — so runs asked about on-screen
    // content while carrying no idea whether the footage was indexed, and reasoned from
    // the timeline summary instead of searching. Reads the sidecar once per run and
    // degrades to no block when it cannot.
    visualStatusFor: createVisualStatusDigester({
      baseUrl: engineBaseUrl,
      fetchFn: electronFetch,
    }),
    // The structure of what is IN the footage, in time order. `cachedOnly` is the whole
    // point: this runs before EVERY run, and a cache miss that reached for Pegasus would
    // stall the run on a slow generative round-trip and bill for it. A cold project
    // simply gets no map block until the understanding panel or a `map_footage` call
    // warms it.
    footageMapFor: async (projectId) =>
      summarizeFootageMap(
        await desktopVisualIndex.footageMap({
          projectId,
          cachedOnly: true,
          ...visualIndexCredentials(),
        }),
      ),
    // What this project has LEARNED — the bin digest, the latest session note, and the
    // corrections/decisions tiers (which is where an answer the editor gave the model
    // lives). The digester has existed since the memory tiers landed and nothing called
    // it, so every run started amnesiac about its own project: in a captured session the
    // editor answered the model's own framing question, and the next run re-cut the
    // montage with no crop at all because that answer died with the run that asked.
    sessionContextFor: createSessionContextDigester({
      baseUrl: engineBaseUrl,
      fetchFn: electronFetch,
    }),
    // The other half of that memory: something has to WRITE what the editor tells a run,
    // or the digest above has nothing new to report. Fire-and-forget, like the review
    // decisions recorded on Accept/Reject.
    rememberDecision: (projectId, note) => {
      if (projectId === '') return;
      void createMemoryRecorder({ baseUrl: engineBaseUrl, fetchFn: electronFetch })({
        projectId,
        tier: 'decisions',
        title: note.title,
        body: note.body,
      });
    },
  });
  ipcMain.handle(IpcChannels.aiStreamStart, async (event, req: unknown): Promise<string> => {
    requireLicense();
    const request = parseAiStreamRequest(req);
    const suppliedProject =
      request.project === undefined ? undefined : parseProject(request.project);
    let project =
      request.projectId === undefined ? undefined : projectCommands.project(request.projectId);
    if (
      (project !== undefined &&
        request.projectId !== undefined &&
        project.id !== request.projectId) ||
      (suppliedProject !== undefined &&
        request.projectId !== undefined &&
        suppliedProject.id !== request.projectId)
    ) {
      throw new Error('The requested AI project is not open in the authoritative host.');
    }
    const hostProject = project ?? suppliedProject;
    if (!hostProject) {
      throw new Error('The requested AI project is not open in the authoritative host.');
    }
    const currentRevision = projectCommands.revision(hostProject.id) ?? 0;
    if (
      request.projectRevision !== undefined &&
      request.projectRevision !== 0 &&
      request.projectRevision !== currentRevision
    ) {
      throw new Error(
        `AI run project revision conflict: expected ${request.projectRevision}, current ${currentRevision}.`,
      );
    }
    // The renderer's editor store is the live working document. Autosave is deliberately
    // debounced, so the host may otherwise inspect a stale project immediately after an
    // import and tell the agent that the visible media bin is empty. The supplied document
    // has already passed schema validation; refresh authority only AFTER the optimistic
    // revision check so an old renderer cannot overwrite newer host work.
    if (suppliedProject !== undefined) {
      project = mergeLiveProjectForHost(suppliedProject, project);
      if (projectCommands.revision(project.id) === undefined) {
        projectCommands.observe(project);
      } else if (!projectCommands.refresh(project, currentRevision)) {
        throw new Error('AI run project revision conflict while refreshing the live editor state.');
      }
    } else {
      project = hostProject;
    }
    const hydratedRequest: AiStreamRequest = { ...request, project };
    if (request.durableRunId === undefined) {
      return aiStreamHub.start(event.sender, hydratedRequest);
    }
    const durableRunId = request.durableRunId;
    const durableSnapshot = await runIpcHub.snapshot(event.sender, {
      runId: durableRunId,
      projectId: project.id,
    });
    if (durableSnapshot === null) {
      throw new Error('The durable AI run could not be restored.');
    }
    let autoExpectedRevision = currentRevision;
    let autoCommitted = false;
    let lifecycleWriteError: unknown;
    const lifecycleWrites: Promise<unknown>[] = [];
    const durableControls = await DurableRunControls.create(
      runGatewayCoordinator,
      durableRunId,
      project.id,
      () => aiStreamHub.abortDurable(durableRunId),
    );
    return aiStreamHub.start(event.sender, hydratedRequest, {
      durableRunId,
      controls: durableControls.controls,
      effectObserver: createDurableEffectObserver(durableRunId, project.id),
      onLifecycleEvent: (stageEvent) => {
        lifecycleWrites.push(
          runGatewayCoordinator
            .recordEditorLifecycle({
              runId: durableRunId,
              projectId: project.id,
              event: stageEvent,
            })
            .catch((error: unknown) => {
              lifecycleWriteError ??= error;
            }),
        );
      },
      beforePublish: async (aiEvent) => {
        const transportEvent = prepareAiEventForTransport(aiEvent);
        if (transportEvent.type === 'diff') {
          const patch = transportEvent.edit.patch;
          await runGatewayCoordinator.recordPatchLifecycle({
            runId: durableRunId,
            projectId: project.id,
            patchId: patch.patchId,
            state: 'proposed',
            projectRevision: projectCommands.revision(project.id) ?? currentRevision,
          });
          // Committed as it arrives, on validation alone. Perceptual review runs against the
          // committed result and reports findings; it does not decide whether the edit may be
          // written, which is what used to hold every edit behind a multi-minute render.
          if (shouldAutoCommitAiDiff(durableSnapshot.patchPolicy, transportEvent.verification)) {
            const active = await activeProject.current();
            if (!active || active.projectId !== project.id) {
              const staleEvent = {
                ...transportEvent,
                commit: {
                  state: 'stale' as const,
                  reason: 'The project is no longer the active authoritative project.',
                },
              };
              await runGatewayCoordinator.recordPatchLifecycle({
                runId: durableRunId,
                projectId: project.id,
                patchId: patch.patchId,
                state: 'stale',
                reason: staleEvent.commit.reason,
              });
              const durableEvent = await runGatewayCoordinator.recordStreamEvent({
                runId: durableRunId,
                projectId: project.id,
                event: JsonValueSchema.parse(staleEvent),
              });
              aiStreamHub.failDurable(durableRunId);
              return { event: staleEvent, durableSequence: durableEvent.sequence };
            }
            const committed = await projectCommands.commitPatch(
              project.id,
              autoExpectedRevision,
              patch,
              async (nextProject) => {
                projectWatcher.markSelfWrite(active.path, nextProject);
                await writeProjectFile(active.path, nextProject);
                await projectWatcher.watch(active.path);
                await recovery.snapshot({
                  path: active.path,
                  project: nextProject,
                  savedAt: Date.now(),
                });
                await activeProject.record({
                  path: active.path,
                  projectId: nextProject.id,
                  updatedAt: Date.now(),
                });
              },
              durableRunId,
            );
            if (!committed.ok) {
              const reason =
                committed.code === 'revision_conflict'
                  ? 'The project changed and this edit overlaps newer work. Replan from the current revision.'
                  : 'The proposed edit failed authoritative validation.';
              await runGatewayCoordinator.recordPatchLifecycle({
                runId: durableRunId,
                projectId: project.id,
                patchId: patch.patchId,
                state: 'stale',
                ...(committed.currentRevision === undefined
                  ? {}
                  : { projectRevision: committed.currentRevision }),
                reason,
              });
              const staleEvent = {
                ...transportEvent,
                commit: {
                  state: 'stale' as const,
                  ...(committed.currentRevision === undefined
                    ? {}
                    : { revision: committed.currentRevision }),
                  reason,
                },
              };
              const durableEvent = await runGatewayCoordinator.recordStreamEvent({
                runId: durableRunId,
                projectId: project.id,
                event: JsonValueSchema.parse(staleEvent),
              });
              aiStreamHub.failDurable(durableRunId);
              return { event: staleEvent, durableSequence: durableEvent.sequence };
            }
            autoExpectedRevision = committed.revision;
            autoCommitted = true;
            await runGatewayCoordinator.recordPatchLifecycle({
              runId: durableRunId,
              projectId: project.id,
              patchId: patch.patchId,
              state: committed.rebased ? 'rebased' : 'committed',
              projectRevision: committed.revision,
            });
            indexProjectBrain(committed.project.id, active.path);
            event.sender.send(IpcChannels.projectChanged, {
              path: active.path,
              project: committed.project,
              revision: committed.revision,
            } satisfies ProjectChangedEvent);
            const committedEvent = {
              ...transportEvent,
              commit: {
                state: 'committed' as const,
                revision: committed.revision,
                rebased: committed.rebased,
              },
            };
            const durableEvent = await runGatewayCoordinator.recordStreamEvent({
              runId: durableRunId,
              projectId: project.id,
              event: JsonValueSchema.parse(committedEvent),
            });
            return { event: committedEvent, durableSequence: durableEvent.sequence };
          }
        }
        const durableEvent = await runGatewayCoordinator.recordStreamEvent({
          runId: durableRunId,
          projectId: project.id,
          event: JsonValueSchema.parse(transportEvent),
        });
        return { event: transportEvent, durableSequence: durableEvent.sequence };
      },
      onSettled: async (settlement) => {
        await Promise.all(lifecycleWrites);
        durableControls.close();
        // A failed lifecycle write is an audit gap, not a reason to leave the run
        // alive. Throwing here skipped `complete`, and the hub only logs what
        // `onSettled` throws — so one failed `recordEditorLifecycle` left a finished
        // run non-terminal, to be picked up again by `reconcileInterruptedRuns` on
        // the next launch and presented to the user as interrupted work. Record the
        // gap and settle the run, which is the state that is actually true.
        if (lifecycleWriteError !== undefined) {
          aiLog.error('editor lifecycle write failed; settling the run regardless', {
            runId: durableRunId,
            error:
              lifecycleWriteError instanceof Error
                ? lifecycleWriteError.message
                : String(lifecycleWriteError),
          });
        }
        await runGatewayCoordinator.complete({
          runId: durableRunId,
          projectId: project.id,
          status: settlement.status,
          outcome: {
            kind:
              settlement.status === 'completed'
                ? autoCommitted
                  ? 'completed_with_changes'
                  : 'completed_no_changes'
                : settlement.kind === 'completed'
                  ? 'failed'
                  : settlement.kind,
            source: settlement.source,
            changed: autoCommitted,
            warnings: [],
            ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
          },
        });
      },
    });
  });
  ipcMain.on(IpcChannels.aiStreamAbort, (event, requestId: unknown) =>
    aiStreamHub.abort(event.sender, requestId),
  );
  ipcMain.on(IpcChannels.aiStreamAnswer, (event, requestId: unknown, answer: unknown) =>
    aiStreamHub.answer(event.sender, requestId, answer),
  );

  // Durable orchestration protocol v1. The run gateway is authoritative for
  // commands, snapshots, replay, and live publication; renderer state is only a
  // projection. Storage stays under Electron userData, separate from project media.
  const runStore = new RunStore(
    new FileRunStoreIO(path.join(app.getPath('userData'), 'orchestration')),
  );
  const runGatewayCoordinator = new RunCoordinator(runStore);
  const runGateway = new RunGateway(runGatewayCoordinator);
  const runIpcHub = new RunIpcHub(runGateway, IpcChannels.runEvent);
  // Close out any run left "in progress" by a previous session that crashed, was
  // hard-killed, or quit before its durable settlement landed. Without this a
  // renderer that recovers such a run re-subscribes to a producer that no longer
  // exists and hangs on "Stop" forever. Fire-and-forget: the terminal event it
  // writes is published, so a recovery subscription started before OR after this
  // completes still receives it. A failure here must never block startup.
  void runGatewayCoordinator
    .reconcileInterruptedRuns()
    // Retention runs only AFTER reconciliation, so nothing still open can be deleted.
    // Without it the run log grows for the life of the install and every startup pays
    // to enumerate it; a failure here is housekeeping, never a reason to block launch.
    .then(() => runStore.prune())
    .catch((error: unknown) => {
      aiLog.warn('startup run reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Readable head kept in a recorded key; the contract's cap is `MAX_IDENTITY_KEY_CHARS`
  // (`run-contracts.ts`'s `identityKeySchema`). 4 fewer than `MAX_IDENTITY_KEY_CHARS -
  // KEY_DIGEST_CHARS` on purpose: this is the last-resort safety net regardless of what
  // upstream producers' own sub-budgets chose, so it stays conservative rather than
  // exact.
  const RECORDED_KEY_CHARS = MAX_IDENTITY_KEY_CHARS - KEY_DIGEST_CHARS - 4;
  const createDurableEffectObserver = (runId: string, projectId: string): EffectRuntimeObserver => {
    const legacyIds = new WeakMap<object, string>();
    // The run contract caps a recorded key at 256 characters, and a snapshot that
    // breaches it fails to parse — which fails the run after its edits have applied.
    // Producers bound their own keys; this is the boundary that the cap is actually
    // enforced at, so it holds the line for every future producer too.
    const recordedKey = (key: string): string => boundedKeySegment(key, RECORDED_KEY_CHARS);
    const identity = (
      effect: RuntimeEffect,
    ): { effectId: string; taskId: string; idempotencyKey: string } => {
      if (
        effect.kind !== 'host_tool' &&
        effect.kind !== 'model' &&
        effect.kind !== 'model_stream'
      ) {
        return {
          effectId: effect.control.effectId,
          taskId: effect.control.taskId,
          idempotencyKey: recordedKey(effect.control.idempotencyKey),
        };
      }
      let effectId = legacyIds.get(effect);
      if (effectId === undefined) {
        effectId = effect.kind === 'host_tool' ? effect.call.id : randomUUID();
        legacyIds.set(effect, effectId);
      }
      return {
        effectId,
        taskId: 'compatibility-stream',
        idempotencyKey: recordedKey(idempotencyKeyFor(effect) ?? effectId),
      };
    };
    // `JsonValueSchema.parse` walks a recursive lazy union over EVERY node, so it must
    // only ever see a value that is already bounded — see `effect-record.ts` for the
    // 34 MB-per-tool-call blow-up that recording raw effects/results used to cause.
    const asJson = (value: JsonValue) => JsonValueSchema.parse(value);
    const record = async (
      effect: RuntimeEffect,
      phase: 'requested' | 'settled' | 'failed',
      value: JsonValue,
    ): Promise<void> => {
      const ids = identity(effect);
      await runGatewayCoordinator.recordRuntimeEffect({
        runId,
        projectId,
        ...ids,
        effectKind: effect.kind,
        phase,
        ...(phase === 'requested' ? { detail: asJson(value) } : { outcome: asJson(value) }),
      });
    };
    return {
      onRequested: (effect) => record(effect, 'requested', describeRuntimeEffect(effect)),
      onSettled: (effect, result: EffectResult) =>
        record(effect, 'settled', describeEffectResult(result)),
      onFailed: (effect, error) =>
        record(effect, 'failed', {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        }),
    };
  };
  ipcMain.handle(IpcChannels.runStart, (event, request: unknown): Promise<DurableRunAccepted> => {
    requireLicense();
    return runIpcHub.start(event.sender, request);
  });
  ipcMain.handle(IpcChannels.runCommand, (event, request: unknown): Promise<DurableRunAccepted> => {
    requireLicense();
    return runIpcHub.command(event.sender, request);
  });
  ipcMain.handle(
    IpcChannels.runSnapshot,
    (event, request: unknown): Promise<DurableRunSnapshot | null> => {
      requireLicense();
      return runIpcHub.snapshot(event.sender, request);
    },
  );
  ipcMain.handle(
    IpcChannels.runSubscribe,
    (event, request: unknown): Promise<DurableRunSubscription> => {
      requireLicense();
      return runIpcHub.subscribe(event.sender, request);
    },
  );
  ipcMain.on(IpcChannels.runUnsubscribe, (event, subscriptionId: unknown) =>
    runIpcHub.unsubscribe(event.sender, subscriptionId),
  );
  ipcMain.on(IpcChannels.runAck, (event, request: unknown) =>
    runIpcHub.acknowledge(event.sender, request),
  );
  app.on('before-quit', () => {
    aiStreamHub.abortAll();
    runIpcHub.close();
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // Floor for the workspace shell's rail-clamp math (packages/ui/src/WorkspaceShell/
    // useRailLayout.ts's MIN_STAGE_WIDTH + both rails' min widths + splitter): below
    // this the layout has no more slack to give and the stage would get crushed.
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e12',
    // Startup polish (H15): keep the window hidden until the renderer has
    // painted its first frame, so launch shows one composed dark frame —
    // never an empty window that later pops to content.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // CommonJS preload (`preload.cjs`) — required because `sandbox: true`
      // cannot load an ES-module preload. See electron/preload.cts.
      preload: path.join(dirname, 'preload.cjs'),
    },
  });

  window.once('ready-to-show', () => window.show());

  // Diagnostic: if the preload bridge fails to load (e.g. an ESM/sandbox
  // mismatch), `window.framepilot` is never exposed and the renderer silently
  // falls back to its in-browser mock AI provider. Surface that failure loudly.
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    aiLog.error('preload failed to load', { preloadPath, error: errorMessage(error) });
  });

  // Renderer `<a target="_blank">` links (e.g. pricing, docs) have no default
  // destination in a sandboxed BrowserWindow — deny the in-app popup and hand
  // https links to the OS browser instead, so external links actually navigate
  // anywhere. Anything not https is denied outright (no window, no external open).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (app.isPackaged) {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  } else {
    void window.loadURL(DEV_SERVER_URL);
  }

  // The watcher pushes live external changes to this window; clear the reference
  // when it closes so a stale `webContents.send` is never attempted.
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

// The custom media scheme must be registered as privileged BEFORE `app` is ready
// (Electron requirement) so it supports streaming/range requests for <video>.
protocol.registerSchemesAsPrivileged([
  {
    scheme: FP_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Harden the renderer session (Phase 8 audit finding 3.2):
 *  - serve a strict CSP header on every renderer response, and
 *  - register the `fp-media://` handler that resolves each request inside the
 *    projects sandbox before streaming the file (so the renderer can never read
 *    media outside the projects folder, and `file://` is no longer used).
 */
function hardenRendererSession(): void {
  const csp = buildCsp(engineBaseUrl, app.isPackaged ? undefined : DEV_SERVER_URL);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  const projectsRoot = resolveProjectsDir(process.env, app.getPath('documents'));
  protocol.handle(FP_MEDIA_SCHEME, async (request) => {
    try {
      const requested = pathFromMediaUrl(request.url);
      // Containment: reject any media path outside the projects sandbox.
      const safePath = resolveWithin(projectsRoot, requested);
      const { size } = await stat(safePath);
      const contentType = mediaContentType(safePath);
      // Honour Range requests so the renderer's <video>/<audio> can stream and
      // seek instead of stalling after its initial buffer (~2s in). A ranged
      // request gets a 206 over just the requested byte slice; otherwise the
      // whole file streams with 200, both advertising `Accept-Ranges: bytes`.
      const range = parseByteRange(request.headers.get('Range'), size);
      if (range) {
        const { start, end } = range;
        const body = Readable.toWeb(
          createReadStream(safePath, { start, end }),
        ) as ReadableStream<Uint8Array>;
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }
      const body = Readable.toWeb(createReadStream(safePath)) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (error) {
      aiLog.error('fp-media request denied', { error: errorMessage(error) });
      return new Response('Forbidden', { status: 403 });
    }
  });
}

/**
 * Wire opt-in, local-first crash telemetry (plan Phase 8). Disabled unless
 * `FRAMEPILOT_TELEMETRY=1`; when enabled, crash records are appended as JSON
 * lines to `telemetry.log` under the app's userData dir. No network, ever.
 */
function setupTelemetry(): void {
  const enabled = telemetryEnabledFromEnv(process.env);
  const logPath = path.join(app.getPath('userData'), 'telemetry.log');
  const telemetry = new LocalTelemetry({
    enabled,
    now: () => Date.now(),
    sink: (line) => appendFileSync(logPath, `${line}\n`),
  });
  if (!enabled) return;
  process.on('uncaughtException', (error) => telemetry.recordCrash(error));
  process.on('unhandledRejection', (reason) => telemetry.recordCrash(reason));
  app.on('render-process-gone', (_event, _wc, details) =>
    telemetry.recordEvent('render_process_gone', { reason: details.reason }),
  );
  telemetry.recordEvent('app_started');
}

/**
 * In packaged builds, check the update feed (configured in electron-builder.yml)
 * via electron-updater. Dynamically imported so the dependency is only loaded in
 * the packaged app, never in dev/tests. Failures are logged, never fatal.
 */
async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  const channel = resolveUpdateChannel(process.env);
  try {
    const { autoUpdater } = await import('electron-updater');
    const provider = createAutoUpdaterProvider(autoUpdater as unknown as AutoUpdaterLike);
    const result = await provider.checkForUpdates(channel);
    aiLog.action('update check', {
      channel,
      updateAvailable: result.updateAvailable,
      version: result.updateAvailable ? result.version : undefined,
    });
  } catch (error) {
    aiLog.error('update check failed', { error: errorMessage(error) });
  }
}

void app.whenReady().then(async () => {
  aiLog.action('startup', {
    updateChannel: resolveUpdateChannel(process.env),
    aiProvider: process.env.FRAMEPILOT_AI_PROVIDER ?? 'mock',
  });

  setupTelemetry();
  hardenRendererSession();
  await projectCommands.restore();
  registerIpcHandlers();
  createWindow();
  // Capability Pack initialization starts the sidecar after resolving optional runtime paths.
  // Check for updates in the background (packaged builds only).
  void checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  sidecar.stop();
  projectWatcher.stop();
  // A clean quit clears the recovery snapshot; a crash leaves it for next launch.
  void recovery.clear();
});
