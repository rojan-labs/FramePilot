/**
 * The desktop host for the masking end-to-end specs: real main-process modules behind a
 * stand-in for Electron's IPC, so the real editor runs in desktop mode in real Chrome.
 *
 * What is REAL here (built `apps/desktop/dist`, the same code `main.ts` wires up):
 *  - `registerMatteIpc`: intent validation, scheduling, progress forwarding, `toWire`, and
 *    `matteSaveCorrection` (PNG validation, the project-owned input store).
 *  - `registerRelinkIpc`: `matteRecheckMedia` and `projectChooseRelinkFile`, with the real
 *    `DesktopMatteMediaInspector` (ffprobe for timing, the engine sidecar for decoded frame
 *    hashes).
 *  - `validateProjectMattes` on open (BROKEN), `readProjectFile({ backupBeforeMigration })` on open
 *    and `writeProjectFile` on save — the timeline-schema file layer the desktop uses.
 *  - The export: the engine's own `render()` on the saved file, validation included.
 *  - Text rasters for the monitor from the real engine sidecar (`/preview/text-raster`).
 *
 * What is SIMULATED, and why (listed for the RD3 release gate):
 *  - **Electron itself** (BrowserWindow, preload, contextBridge, native dialogs). This harness
 *    boots the web build in Chrome and installs `window.framepilot` from an init script that
 *    mirrors `preload.cts`'s channel mapping. Loading a packaged Electron app needs the
 *    maintainer's hardware (MO-9); CI builds the app but does not drive it.
 *  - **`fp-media://`.** Chrome cannot load a custom scheme, so asset paths are rewritten to
 *    same-origin URLs on open and back to project-relative paths on save; artifacts are served
 *    through the monitor's documented stand-in hooks (`__fpMatteArtifactUrl`,
 *    `__fpTrackArtifactUrl`), the same ones the PX4 oracle uses. An absolute path the relink
 *    dialog chose stays absolute (as on the desktop), and the page's `fetch` of its
 *    `fp-media://local/…` URL is answered from the same file through the same-origin route.
 *  - **Pack installation.** No signed Smart Mask / Tracking Lite release exists anywhere yet
 *    (MO-1..MO-5), so a "missing" pack carries a stand-in proposal and "installing" it flips the
 *    host's answer and fires `capabilityPackInstalled`, exactly the event a real install fires
 *    after its health check. Download, signature and health check are covered by
 *    `packages/capability-packs` tests, not here.
 *  - **Pack workers.** No model runs. A matte job writes a synthetic artifact to the pack's
 *    output contract (FFV1 matte + foreground + `frames.json`) with the engine helper; a track
 *    job writes a `track.json`. The host record (content fingerprint, decoded source samples) is
 *    made with the host's own functions and the real inspector. A spec can instead pass the REAL
 *    matte service over the scripted-model worker (`smart-mask-pack.ts`) and a job journal, which
 *    adds the real job scheduler, the Jobs panel channels and resume-on-open (E2E.6).
 *  - **The AI model.** A scripted policy (see the AI spec), as in the AM5 eval harness.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { IpcChannels } from '../../../../apps/desktop/dist/ipc/contract.js';
import {
  registerJobIpc,
  registerMatteIpc,
  resumeMatteJobs,
  type MatteIpcEvent,
} from '../../../../apps/desktop/dist/capability-packs/matte-ipc.js';
import {
  CapabilityPackJobScheduler,
  FileJobJournal,
} from '../../../../apps/desktop/dist/capability-packs/job-scheduler.js';
import { registerRelinkIpc } from '../../../../apps/desktop/dist/capability-packs/matte-relink-ipc.js';
import { DesktopMatteMediaInspector } from '../../../../apps/desktop/dist/capability-packs/matte-media-inspector.js';
import { validateProjectMattes } from '../../../../apps/desktop/dist/capability-packs/matte-validation.js';
import {
  frameRange,
  sampleSourcePts,
  type MatteRunOutcome,
} from '../../../../apps/desktop/dist/capability-packs/matte.js';
import {
  sourceContentFingerprint,
  writeMatteRecord,
} from '../../../../apps/desktop/dist/capability-packs/matte-store.js';
import {
  readProjectFile,
  writeProjectFile,
} from '../../../../packages/timeline-schema/dist/project-file.js';
import { parseProject, type Project } from '../../../../packages/timeline-schema/dist/index.js';
import { MEDIA_ROUTE, WORK_ROOT, type Rgb3, type Workspace } from './workspace.js';

/** Where a pack stands for one capability, as the host would answer `capabilityPackStatus`. */
export type PackState = 'ready' | 'missing' | 'catalog_unconfigured';

/** The packs the masking tools need, by capability. */
const PACKS = {
  'subject.matte': { id: 'framepilot.smart-mask', name: 'Smart Mask', bytes: 1_050_000_000 },
  'subject.detect': {
    id: 'framepilot.subject-intelligence',
    name: 'Subject Intelligence',
    bytes: 44_000_000,
  },
  'tracking.region': { id: 'framepilot.tracking-lite', name: 'Tracking Lite', bytes: 38_000_000 },
} as const;
type KnownCapability = keyof typeof PACKS;

const identityOf = (capability: KnownCapability) => ({
  id: PACKS[capability].id,
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin' as const,
  arch: 'arm64' as const,
});

/** A stand-in signed proposal: the shape a real catalog entry produces (see header). */
export function proposalFor(capability: KnownCapability) {
  return {
    proposalId: `proposal-${PACKS[capability].id}`,
    identity: identityOf(capability),
    capabilities: [capability],
    displayName: PACKS[capability].name,
    description: `${PACKS[capability].name} runs on this computer.`,
    downloadBytes: PACKS[capability].bytes,
    installedBytes: PACKS[capability].bytes * 2,
    licenses: [
      {
        spdx: 'Apache-2.0',
        name: 'Apache License 2.0',
        noticeUrl: 'https://example.invalid/notice',
      },
    ],
    privacy: {
      execution: 'local' as const,
      mediaLeavesDevice: false,
      disclosure: 'Media never leaves this computer.',
    },
  };
}

/** Bridge methods that map to a real `ipcMain.handle` channel registered below. */
const INVOKE_CHANNELS: Readonly<Record<string, string>> = {
  capabilityPackStatus: IpcChannels.capabilityPackStatus,
  capabilityPackMatte: IpcChannels.capabilityPackMatte,
  matteSaveCorrection: IpcChannels.matteSaveCorrection,
  matteRecheckMedia: IpcChannels.matteRecheckMedia,
  projectChooseRelinkFile: IpcChannels.projectChooseRelinkFile,
  // Registered only with a job journal (the real scheduler); otherwise answered below.
  capabilityPackJobs: IpcChannels.capabilityPackJobs,
  capabilityPackJobAction: IpcChannels.capabilityPackJobAction,
};
/** Bridge methods that map to a real `ipcMain.on` channel (fire and forget). */
const SEND_CHANNELS: Readonly<Record<string, string>> = {
  capabilityPackCancelMatte: IpcChannels.capabilityPackCancelMatte,
};
/** Main → renderer pushes, by channel, to the bridge subscription that receives them. */
const PUSH_SUBSCRIPTIONS: Readonly<Record<string, string>> = {
  [IpcChannels.capabilityPackMatteProgress]: 'onCapabilityPackMatteProgress',
  [IpcChannels.capabilityPackTrackProgress]: 'onCapabilityPackTrackProgress',
  [IpcChannels.capabilityPackJobsChanged]: 'onCapabilityPackJobsChanged',
};

/** Every bridge method the page stub defines (the rest read as absent, as optional ones are). */
const INVOKE_METHODS = [
  'ping',
  'licenseStatus',
  'licenseActivate',
  'licenseDeactivate',
  'sidecarStatus',
  'openProject',
  'openProjectDialog',
  'saveProject',
  'saveProjectDefault',
  'projectsDir',
  'revealProject',
  'recentProjects',
  'exportVideo',
  'exportVideoStart',
  'exportVideoCancel',
  'exportSaveAs',
  'importMedia',
  'importAsset',
  'transcribe',
  'aiChat',
  'aiPlan',
  'aiEdit',
  'aiProviders',
  'aiConfigGet',
  'aiConfigSet',
  'conversationsList',
  'conversationsLoad',
  'conversationsSave',
  'conversationsDelete',
  'aiStreamStart',
  'aiStreamAbort',
  'aiStreamAnswer',
  'previewTextRaster',
  'capabilityPackStatus',
  'capabilityPackPropose',
  'capabilityPackInstall',
  'capabilityPackCancel',
  'capabilityPackStorage',
  'capabilityPackJobs',
  'capabilityPackJobAction',
  'capabilityPackMatte',
  'capabilityPackCancelMatte',
  'capabilityPackTrackMask',
  'capabilityPackCancelTrack',
  'matteSaveCorrection',
  'matteRecheckMedia',
  'projectChooseRelinkFile',
] as const;
const SUBSCRIPTIONS = [
  'onExportProgress',
  'onProjectChanged',
  'onAiStreamEvent',
  'onCapabilityPackInstalled',
  'onCapabilityPackProgress',
  'onCapabilityPackMatteProgress',
  'onCapabilityPackTrackProgress',
  'onCapabilityPackJobsChanged',
  'onCapabilityPackRelocationProgress',
] as const;

type Handler = (event: MatteIpcEvent, ...args: unknown[]) => unknown;

/** The slice of `ipcMain` the host modules register on. */
class FakeIpcMain {
  public readonly handlers = new Map<string, Handler>();
  public readonly listeners = new Map<string, Handler>();
  public handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }
  public on(channel: string, listener: Handler): void {
    this.listeners.set(channel, listener);
  }
}

/** The context a scripted matte job gets: the real `service.run` context plus the workspace. */
export interface MatteJobContext {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly projectRevision: number;
  readonly onProgress: (progress: {
    phase: string;
    completed: number;
    total: number;
    round?: number;
    etaSeconds?: number;
  }) => void;
  readonly desktop: FakeDesktop;
}

/** A scripted pack job: what the worker would have produced for this intent. */
export type MatteJobScript = (
  intent: Record<string, unknown>,
  context: MatteJobContext,
) => Promise<MatteRunOutcome>;

export type TrackJobScript = (
  intent: Record<string, unknown>,
  desktop: FakeDesktop,
) => Promise<unknown>;

/** The AI half: a scripted run the host executes when the sidebar starts a stream. */
export type AiStreamScript = (
  request: Record<string, unknown>,
  emit: (event: unknown) => Promise<void>,
  desktop: FakeDesktop,
) => Promise<void>;

export interface FakeDesktopOptions {
  readonly workspace: Workspace;
  /** The engine sidecar (text rasters, decoded frame hashes). */
  readonly sidecarUrl: string;
  readonly packs?: Partial<Record<KnownCapability, PackState>>;
  readonly matteJob?: MatteJobScript;
  readonly trackJob?: TrackJobScript;
  readonly aiStream?: AiStreamScript;
  /** The file the relink dialog "picks" (absolute). */
  readonly relinkTo?: string;
  /**
   * The REAL matte service to run background removal with (see `smart-mask-pack.ts`) instead of
   * the scripted `matteJob`.
   */
  readonly matteService?: (desktop: FakeDesktop) => Promise<unknown>;
  /**
   * A job journal file: the host then runs the real job scheduler over it (one job at a time,
   * the Jobs panel channels) and resumes the open project's journaled jobs on open, as `main.ts`
   * does. Two hosts on one journal are one app before and after a restart.
   */
  readonly jobJournal?: string;
}

/** One call the page made, for assertions on what crossed the bridge. */
export interface BridgeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class FakeDesktop {
  public readonly calls: BridgeCall[] = [];
  /** What each call answered, in completion order (a thrown call records its message). */
  public readonly results: { readonly method: string; readonly result: unknown }[] = [];
  /** Every project document the renderer saved, in order (asset paths as stored on disk). */
  public readonly saves: Project[] = [];
  /** Export results the dialog was sent, in order. */
  public readonly exports: { requestId: string; result: Record<string, unknown> }[] = [];
  public readonly packs: Record<KnownCapability, PackState>;
  public readonly inspector: DesktopMatteMediaInspector;
  private readonly ipc = new FakeIpcMain();
  private page: Page | null = null;
  private origin = '';
  private opened = false;
  private revision = 1;
  private readonly aiRuns = new Map<string, AbortController>();
  /** The real job scheduler, when the spec gave a journal. */
  public readonly scheduler: CapabilityPackJobScheduler | undefined;
  private readonly matteDependencies: Record<string, unknown>;

  public constructor(public readonly options: FakeDesktopOptions) {
    this.packs = {
      'subject.matte': options.packs?.['subject.matte'] ?? 'ready',
      'subject.detect': options.packs?.['subject.detect'] ?? 'ready',
      'tracking.region': options.packs?.['tracking.region'] ?? 'ready',
    };
    this.inspector = new DesktopMatteMediaInspector({
      ffprobe: process.env.FRAMEPILOT_FFPROBE ?? 'ffprobe',
      sidecarBaseUrl: options.sidecarUrl,
      fetch: globalThis.fetch,
    });
    const scripted = {
      run: async (
        intent: unknown,
        context: {
          project: Project;
          projectRevision: number;
          onProgress: MatteJobContext['onProgress'];
        },
      ) => {
        if (options.matteJob === undefined) throw new Error('This spec scripts no matte job.');
        return options.matteJob(intent as Record<string, unknown>, {
          workspace: options.workspace,
          project: context.project,
          projectRevision: context.projectRevision,
          onProgress: context.onProgress,
          desktop: this,
        });
      },
      cancel: () => undefined,
      activeJobIds: () => [],
      busyArtifactKeys: () => [],
    };
    const activeProjectPath = async (): Promise<string | null> =>
      this.opened ? options.workspace.projectPath : null;
    this.scheduler =
      options.jobJournal === undefined
        ? undefined
        : new CapabilityPackJobScheduler({
            journal: new FileJobJournal(options.jobJournal),
            onChange: (jobs: unknown) => void this.emit('onCapabilityPackJobsChanged', jobs),
          });
    const service = options.matteService;
    const matte = service === undefined ? async () => scripted : () => service(this);
    this.matteDependencies = {
      ipcMain: this.ipc,
      requireLicense: () => undefined,
      capabilityStatus: async (capability: string) => this.statusOf(capability),
      matte,
      activeProjectPath,
      readProject: (path: string) => readProjectFile(path),
      ...(this.scheduler === undefined ? {} : { scheduler: this.scheduler }),
    };
    registerMatteIpc(this.matteDependencies as never);
    if (this.scheduler !== undefined) {
      registerJobIpc({
        ipcMain: this.ipc,
        scheduler: this.scheduler,
        cancelMatte: (jobId: string) =>
          void matte().then((service) => (service as { cancel(id: string): void }).cancel(jobId)),
      } as never);
    }
    registerRelinkIpc({
      ipcMain: this.ipc,
      requireLicense: () => undefined,
      activeProjectPath,
      readProject: (path: string) => readProjectFile(path),
      chooseFile: async () => options.relinkTo,
      inspector: async () => this.inspector,
    } as never);
  }

  // --- wiring into the page ----------------------------------------------------------------------

  /**
   * Install the bridge and the artifact routes on `page`. Call before the first navigation.
   *
   * @returns The page origin the media are served from.
   */
  public async install(page: Page, baseURL: string): Promise<void> {
    this.page = page;
    this.origin = new URL(baseURL).origin;
    // As main does at startup: journaled jobs load dormant until their project opens.
    await this.scheduler?.loadDormant();
    await page.route(`**${MEDIA_ROUTE}**`, (route) => this.serve(route));
    await page.exposeFunction('__fpE2EInvoke', async (method: string, args: unknown[]) => {
      this.calls.push({ method, args });
      try {
        const result = await this.invoke(method, args);
        this.results.push({ method, result });
        return result;
      } catch (error) {
        this.results.push({ method, result: { thrown: String(error) } });
        throw error;
      }
    });
    await page.addInitScript(
      ({ invoke, subscriptions, prefix, root, workRoot }) => {
        const listeners = new Map<string, Set<(payload: unknown) => void>>();
        const missing = new Set<string>();
        const host = window as unknown as Record<string, unknown>;
        // Looked up per call: the binding is installed by `exposeFunction`, not by this script.
        const call = (method: string, args: unknown[]): Promise<unknown> =>
          (host.__fpE2EInvoke as (m: string, a: unknown[]) => Promise<unknown>)(method, args);
        const toBase64 = (bytes: Uint8Array): string => {
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return btoa(binary);
        };
        const fromBase64 = (text: string): Uint8Array => {
          const binary = atob(text);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes;
        };
        const base: Record<string, unknown> = {};
        for (const method of invoke) {
          base[method] = (...args: unknown[]) => {
            // Bytes cross as base64 (the page ↔ harness channel carries JSON).
            const wire = args.map((arg) =>
              arg !== null &&
              typeof arg === 'object' &&
              'png' in arg &&
              (arg as { png: unknown }).png instanceof Uint8Array
                ? {
                    ...(arg as object),
                    png: { base64: toBase64((arg as { png: Uint8Array }).png) },
                  }
                : arg,
            );
            return call(method, wire).then((result) => {
              if (
                method === 'previewTextRaster' &&
                result !== null &&
                typeof result === 'object' &&
                'rgbaBase64' in result
              ) {
                const { rgbaBase64, ...rest } = result as { rgbaBase64: string };
                return { ...rest, rgba: fromBase64(rgbaBase64) };
              }
              return result;
            });
          };
        }
        for (const name of subscriptions) {
          base[name] = (listener: (payload: unknown) => void) => {
            const set = listeners.get(name) ?? new Set();
            listeners.set(name, set);
            set.add(listener);
            return () => set.delete(listener);
          };
        }
        host.__fpE2EEmit = (name: string, payload: unknown) => {
          for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
        };
        host.__fpE2EListenerCount = (name: string) => listeners.get(name)?.size ?? 0;
        host.__fpE2EMissing = missing;
        host.__fpE2EBoot = Math.random().toString(36).slice(2);
        host.framepilot = new Proxy(base, {
          get(target, key) {
            if (typeof key === 'string' && !(key in target)) missing.add(key);
            return (target as Record<string | symbol, unknown>)[key];
          },
        });
        // Artifacts, as the desktop monitor reads them from the project folder (fp-media).
        host.__fpMatteArtifactUrl = (key: string, name: string) =>
          `${location.origin}${prefix}${root}/.framepilot-derived/mattes/${key}/${name}`;
        host.__fpMatteTierUrl = () => null;
        host.__fpTrackArtifactUrl = (key: string) =>
          `${location.origin}${prefix}${root}/.framepilot-derived/tracks/${key}/track.json`;
        // fp-media://local/<absolute path>, stood in for the files under the workspace root: an
        // asset relinked to an absolute path (the native dialog's answer) is read from the same
        // file through the same-origin route, as the desktop's protocol handler would serve it.
        const local = 'fp-media://local/';
        const served = (url: string): string => {
          if (!url.startsWith(local)) return url;
          const absolute = decodeURIComponent(url.slice(local.length));
          return absolute.startsWith(`${workRoot}/`)
            ? `${location.origin}${prefix}${absolute.slice(workRoot.length + 1)}`
            : url;
        };
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
          typeof input === 'string' ? nativeFetch(served(input), init) : nativeFetch(input, init);
        // The decode workers fetch the URLs they are sent, and a worker has its own `fetch`: the
        // URL is mapped on its way in instead (plain objects and arrays only; buffers untouched).
        const rewrite = (value: unknown): unknown => {
          if (typeof value === 'string') return served(value);
          if (Array.isArray(value)) return value.map(rewrite);
          if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
          }
          return value;
        };
        const nativePost = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
          return (nativePost as (...args: unknown[]) => void).call(this, rewrite(message), ...rest);
        } as typeof Worker.prototype.postMessage;
      },
      {
        invoke: [...INVOKE_METHODS],
        subscriptions: [...SUBSCRIPTIONS],
        prefix: MEDIA_ROUTE,
        root: relative(WORK_ROOT, this.options.workspace.projectDir).split(sep).join('/'),
        workRoot: WORK_ROOT.split(sep).join('/'),
      },
    );
  }

  /**
   * Wait for the next `matteRecheckMedia` answer after `since` answers were recorded, and return
   * its issues. The Inspector and the export dialog render exactly these.
   */
  public async recheckAfter(since: number, timeoutMs = 30_000): Promise<unknown[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.results
        .slice(since)
        .find((entry) => entry.method === 'matteRecheckMedia');
      if (found !== undefined) {
        const answer = found.result as { ok?: boolean; issues?: unknown[] };
        if (answer.ok !== true) throw new Error(`matteRecheckMedia failed: ${JSON.stringify(answer)}`);
        return answer.issues ?? [];
      }
      if (Date.now() > deadline) throw new Error('No matteRecheckMedia answer arrived.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Push a main → renderer event to a bridge subscription. */
  public async emit(subscription: string, payload: unknown): Promise<void> {
    if (this.page === null || this.page.isClosed()) return;
    await this.page.evaluate(
      ([name, value]) =>
        (window as unknown as { __fpE2EEmit: (n: string, v: unknown) => void }).__fpE2EEmit(
          name as string,
          value,
        ),
      [subscription, payload] as const,
    );
  }

  /** Bridge members the app read that this host does not define (diagnosis only). */
  public async missingMembers(): Promise<string[]> {
    if (this.page === null || this.page.isClosed()) return [];
    return this.page.evaluate(() => [
      ...((window as unknown as { __fpE2EMissing: Set<string> }).__fpE2EMissing ?? []),
    ]);
  }

  private async serve(route: Route): Promise<void> {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(WORK_ROOT, pathname.slice(MEDIA_ROUTE.length));
    if (!file.startsWith(WORK_ROOT) || !existsSync(file)) return route.fulfill({ status: 404 });
    const type = file.endsWith('.mp4')
      ? 'video/mp4'
      : file.endsWith('.json')
        ? 'application/json'
        : file.endsWith('.mkv')
          ? 'video/x-matroska'
          : file.endsWith('.webm')
            ? 'video/webm'
            : 'application/octet-stream';
    return route.fulfill({ path: file, headers: { 'content-type': type } });
  }

  // --- the project on disk ↔ the renderer's copy --------------------------------------------------

  /** Asset paths as the renderer sees them: same-origin URLs for files in the project folder. */
  private toRenderer(project: Project): Project {
    const dir = this.options.workspace.projectDir;
    const url = (stored: string): string => {
      const absolute = isAbsolute(stored) ? stored : join(dir, stored);
      return `${this.origin}${this.options.workspace.urlPath(absolute)}`;
    };
    return {
      ...project,
      assets: project.assets.map((asset) => ({
        ...asset,
        path: url(asset.path),
        ...(asset.media?.proxyPath
          ? { media: { ...asset.media, proxyPath: url(asset.media.proxyPath) } }
          : {}),
      })),
    } as Project;
  }

  /**
   * The renderer's live project as the host holds it (paths as stored on disk): what `main.ts`
   * hands an AI run as its working project.
   */
  public diskProject(project: unknown): Project {
    return this.toDisk(project);
  }

  /** Back to what the desktop stores: paths relative to the project file. */
  private toDisk(project: unknown): Project {
    const dir = this.options.workspace.projectDir;
    const prefix = `${this.origin}${MEDIA_ROUTE}`;
    const stored = (path: string): string => {
      if (!path.startsWith(prefix)) return path;
      const absolute = join(WORK_ROOT, decodeURIComponent(path.slice(prefix.length)));
      return relative(dir, absolute).split(sep).join('/');
    };
    const parsed = parseProject(project);
    return {
      ...parsed,
      assets: parsed.assets.map((asset) => ({
        ...asset,
        path: stored(asset.path),
        ...(asset.media?.proxyPath
          ? { media: { ...asset.media, proxyPath: stored(asset.media.proxyPath) } }
          : {}),
      })),
    } as Project;
  }

  /** Open the workspace project as main does: read (migrating, with a backup), then check mattes. */
  private async open(): Promise<Record<string, unknown>> {
    const path = this.options.workspace.projectPath;
    try {
      const project = await readProjectFile(path, { backupBeforeMigration: true });
      this.opened = true;
      if (this.scheduler !== undefined) {
        // `resumeJobsForProject` in main.ts: this project's journaled jobs wake now.
        void resumeMatteJobs(
          { ...this.matteDependencies, scheduler: this.scheduler } as never,
          path,
        );
      }
      const mattes = await validateProjectMattes(dirname(path), project, { mode: 'quick' });
      return {
        ok: true,
        path,
        project: this.toRenderer(project),
        revision: this.revision,
        mattes,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async save(project: unknown): Promise<Record<string, unknown>> {
    try {
      const document = this.toDisk(project);
      await writeProjectFile(this.options.workspace.projectPath, document);
      this.saves.push(document);
      this.revision += 1;
      return { ok: true, path: this.options.workspace.projectPath, revision: this.revision };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- packs ---------------------------------------------------------------------------------------

  private statusOf(capability: string): Record<string, unknown> {
    const known = capability in PACKS ? (capability as KnownCapability) : null;
    if (known === null) return { state: 'catalog_unconfigured', capability };
    const state = this.packs[known];
    if (state === 'ready') return { state: 'ready', capability, pack: identityOf(known) };
    if (state === 'missing') {
      return { state: 'missing', capability, proposal: { ok: true, proposal: proposalFor(known) } };
    }
    return { state: 'catalog_unconfigured', capability };
  }

  private async installPack(approval: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entry = (Object.keys(PACKS) as KnownCapability[]).find(
      (capability) => proposalFor(capability).proposalId === approval.proposalId,
    );
    if (entry === undefined)
      return { ok: false, code: 'proposal_stale', error: 'The install offer changed.' };
    const operationId = `install-${randomUUID().slice(0, 8)}`;
    const identity = identityOf(entry);
    const total = PACKS[entry].bytes;
    // The phases a real install reports, then the event every surface re-checks on.
    void (async () => {
      for (const [phase, completed] of [
        ['downloading', 0],
        ['downloading', total / 2],
        ['verifying', total],
        ['health_checking', total],
      ] as const) {
        await this.emit('onCapabilityPackProgress', {
          operationId,
          identity,
          phase,
          completedBytes: completed,
          totalBytes: total,
        });
      }
      for (const capability of Object.keys(PACKS) as KnownCapability[]) {
        if (PACKS[capability].id === identity.id) this.packs[capability] = 'ready';
      }
      await this.emit('onCapabilityPackProgress', {
        operationId,
        identity,
        phase: 'installed',
        completedBytes: total,
        totalBytes: total,
      });
      await this.emit('onCapabilityPackInstalled', { kind: 'installed', identity });
    })();
    return { ok: true, operationId };
  }

  // --- export --------------------------------------------------------------------------------------

  private exportStart(request: Record<string, unknown>): string {
    const requestId = `export-${randomUUID().slice(0, 8)}`;
    void (async () => {
      await this.emit('onExportProgress', {
        requestId,
        status: 'running',
        stage: 'rendering_frames',
        progress: 0.1,
      });
      const done = await this.options.workspace.export(
        `${requestId}.mp4`,
        (request.settings as Record<string, unknown> | undefined) ?? {},
      );
      const result =
        done.state === 'completed' && done.outputPath !== null
          ? { ok: true, outputPath: done.outputPath, state: done.state }
          : {
              ok: false,
              error: done.error ?? 'The export failed.',
              ...(done.errorDetail ? { detail: done.errorDetail } : {}),
            };
      this.exports.push({ requestId, result: { ...result, engine: done } });
      await this.emit('onExportProgress', {
        requestId,
        status: result.ok ? 'completed' : 'failed',
        result,
      });
    })();
    return requestId;
  }

  // --- dispatch ------------------------------------------------------------------------------------

  private sender(): MatteIpcEvent['sender'] {
    return {
      isDestroyed: () => this.page === null || this.page.isClosed(),
      send: (channel: string, payload: unknown) => {
        const subscription = PUSH_SUBSCRIPTIONS[channel];
        if (subscription !== undefined) void this.emit(subscription, payload);
      },
    };
  }

  private async invoke(method: string, rawArgs: unknown[]): Promise<unknown> {
    // Bytes arrive as base64 (see the page stub); the host modules want Uint8Array.
    const args = rawArgs.map((arg) =>
      arg !== null &&
      typeof arg === 'object' &&
      'png' in arg &&
      typeof (arg as { png: unknown }).png === 'object'
        ? {
            ...(arg as object),
            png: new Uint8Array(
              Buffer.from((arg as { png: { base64: string } }).png.base64, 'base64'),
            ),
          }
        : arg,
    );
    const channel = INVOKE_CHANNELS[method];
    const handler = channel === undefined ? undefined : this.ipc.handlers.get(channel);
    if (handler !== undefined) {
      return handler({ sender: this.sender() }, ...args);
    }
    if (
      channel !== undefined &&
      !['capabilityPackJobs', 'capabilityPackJobAction'].includes(method)
    ) {
      throw new Error(`No handler registered for ${channel}`);
    }
    const send = SEND_CHANNELS[method];
    if (send !== undefined) {
      this.ipc.listeners.get(send)?.({ sender: this.sender() }, ...args);
      return undefined;
    }
    switch (method) {
      case 'ping':
        return 'pong';
      case 'licenseStatus':
        return { status: 'valid', licensed: true, expiresAt: null };
      case 'sidecarStatus':
        return { phase: 'running', baseUrl: this.options.sidecarUrl, detail: null };
      case 'openProject':
      case 'openProjectDialog':
        return this.open();
      case 'saveProject':
        return this.save(args[1]);
      case 'saveProjectDefault':
        return this.save(args[0]);
      case 'projectsDir':
        return this.options.workspace.root;
      case 'revealProject':
        return { ok: true };
      case 'recentProjects':
      case 'conversationsList':
      case 'capabilityPackJobs':
        return [];
      case 'conversationsLoad':
        return null;
      case 'conversationsSave':
      case 'conversationsDelete':
        return undefined;
      case 'aiProviders':
        return [{ name: 'mock', label: 'Offline mock', model: 'mock', ready: true }];
      case 'aiConfigGet':
        return {
          activeProvider: 'mock',
          providers: [{ name: 'mock', label: 'Offline mock', model: 'mock', ready: true }],
        };
      case 'aiConfigSet':
        return undefined;
      case 'exportVideoStart':
        return this.exportStart(args[0] as Record<string, unknown>);
      case 'capabilityPackJobAction':
        return false;
      case 'exportVideoCancel':
      case 'capabilityPackCancel':
      case 'capabilityPackCancelTrack':
        return undefined;
      case 'exportSaveAs':
        // The native Save As dialog, dismissed: the render stays in the project's exports folder.
        return { ok: false, error: 'cancelled' };
      case 'capabilityPackPropose': {
        const capability = String(args[0]);
        return capability in PACKS
          ? { ok: true, proposal: proposalFor(capability as KnownCapability) }
          : { ok: false, code: 'catalog_unconfigured', error: 'No catalog.' };
      }
      case 'capabilityPackInstall':
        return this.installPack(args[0] as Record<string, unknown>);
      case 'capabilityPackTrackMask':
        if (this.options.trackJob === undefined) throw new Error('This spec scripts no track job.');
        return this.options.trackJob(args[0] as Record<string, unknown>, this);
      case 'previewTextRaster':
        return this.textRaster(args[0] as Record<string, unknown>);
      case 'aiStreamStart':
        return this.aiStart(args[0] as Record<string, unknown>);
      case 'aiStreamAbort':
        this.aiRuns.get(String(args[0]))?.abort();
        return undefined;
      case 'aiStreamAnswer':
        return undefined;
      default:
        throw new Error(`The masking e2e desktop host does not implement ${method}.`);
    }
  }

  private async textRaster(req: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.options.sidecarUrl}/preview/text-raster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: req.kind,
        ...(req.kind === 'text' ? { params: req.params } : { text: req.text }),
        frame_width: req.frameWidth,
        frame_height: req.frameHeight,
      }),
    });
    if (!response.ok) return { ok: false, error: `sidecar ${response.status}` };
    const wire = (await response.json()) as {
      width: number;
      height: number;
      rgba_base64: string;
      x: number | null;
      y: number | null;
    };
    return {
      ok: true,
      width: wire.width,
      height: wire.height,
      rgbaBase64: wire.rgba_base64,
      x: wire.x,
      y: wire.y,
    };
  }

  private aiStart(request: Record<string, unknown>): string {
    const requestId = `ai-${randomUUID().slice(0, 8)}`;
    const script = this.options.aiStream;
    const controller = new AbortController();
    this.aiRuns.set(requestId, controller);
    void (async () => {
      try {
        if (script === undefined) throw new Error('This spec scripts no AI run.');
        await script(
          request,
          async (event) => this.emit('onAiStreamEvent', { requestId, event }),
          this,
        );
        await this.emit('onAiStreamEvent', { requestId, done: true });
      } catch (error) {
        await this.emit('onAiStreamEvent', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.aiRuns.delete(requestId);
      }
    })();
    return requestId;
  }

  // --- a pack job's output, made with the host's own functions ------------------------------------

  /**
   * What a finished Smart Mask job leaves behind for `intent`: a synthetic artifact over the
   * host's frame range for the requested coverage, and the host record (content fingerprint and
   * decoded source samples, measured by the real inspector through the sidecar).
   */
  public async synthesiseMatte(
    intent: Record<string, unknown>,
    project: Project,
    options: {
      readonly shape?: 'ramp' | 'disc';
      readonly foreground: Rgb3;
      readonly variant?: string;
      readonly needsReview?: readonly { start: number; end: number; reason: string }[];
      readonly projectRevision: number;
    },
  ): Promise<MatteRunOutcome> {
    const asset = project.assets.find((candidate) => candidate.id === intent.assetId);
    if (asset === undefined) throw new Error(`No asset ${String(intent.assetId)}`);
    const width = asset.media?.width;
    const height = asset.media?.height;
    if (typeof width !== 'number' || typeof height !== 'number') {
      throw new Error('The asset is not measured.');
    }
    const file = join(this.options.workspace.projectDir, asset.path);
    const timing = await this.inspector.videoTiming(file);
    const range = frameRange(timing, Number(intent.sourceStart), Number(intent.sourceEnd));
    if (range === undefined) throw new Error('The coverage is outside the media.');
    const fps = timing.timeBase[1] / timing.timeBase[0] / (timing.pts[1]! - timing.pts[0]! || 1);
    const written = await this.options.workspace.matte({
      assetPath: asset.path,
      fps,
      width,
      height,
      foreground: options.foreground,
      shape: options.shape ?? 'ramp',
      variant: options.variant ?? String(intent.requestId),
      firstFrame: range.firstFrame,
      lastFrame: range.firstFrame + range.frameCount - 1,
    });
    const samples = sampleSourcePts(timing, range.firstFrame, range.frameCount, 16);
    const hashes = await this.inspector.frameHashesByPts(file, samples);
    const needsReview = [...(options.needsReview ?? [])];
    const record = {
      version: 1 as const,
      key: written.key,
      assetId: asset.id,
      files: await Promise.all(
        written.files.map(async (entry) => ({
          name: entry.name,
          sha256: entry.sha256,
          bytes: (
            await import('node:fs/promises').then((fs) =>
              fs.stat(
                join(
                  this.options.workspace.projectDir,
                  '.framepilot-derived',
                  'mattes',
                  written.key,
                  entry.name,
                ),
              ),
            )
          ).size,
        })),
      ),
      width: written.width,
      height: written.height,
      coverage: written.coverage,
      packId: PACKS['subject.matte'].id,
      packVersion: '1.0.0',
      modelDigests: [],
      executionProvider: 'cpu' as const,
      summary: {
        verifiedFrames: range.frameCount,
        flaggedFrames: needsReview.length,
        lockedFrames: 0,
        selfCorrectionRounds: 0,
      },
      needsReview,
      lockedPts: [],
      contentFingerprint: await sourceContentFingerprint(file, timing),
      sourceSamples: samples.map((pts, index) => ({ pts, sha256: hashes[index]! })),
      createdAt: '2026-09-18T00:00:00.000Z',
    };
    await writeMatteRecord(this.options.workspace.projectDir, record as never);
    return {
      status: 'completed',
      artifact: {
        key: record.key,
        files: record.files.map(({ name, sha256 }) => ({ name, sha256 })),
        width: record.width,
        height: record.height,
        coverage: record.coverage,
        packId: record.packId,
        packVersion: record.packVersion,
        modelDigests: [],
      },
      summary: record.summary,
      needsReview: record.needsReview,
      executionProvider: 'cpu',
      cacheHit: false,
      projectRevision: options.projectRevision,
    } as MatteRunOutcome;
  }

  /** Write a `track.json` artifact (MK7.1 format) and return its pin. */
  public async writeTrack(
    document: Record<string, unknown>,
  ): Promise<{ key: string; sha256: string }> {
    const text = `${JSON.stringify(document)}\n`;
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(text).digest('hex');
    const key = createHash('sha256').update(`track:${sha256}`).digest('hex');
    const dir = join(this.options.workspace.projectDir, '.framepilot-derived', 'tracks', key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'track.json'), text);
    return { key, sha256 };
  }
}
