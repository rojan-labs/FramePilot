/**
 * Headless, desktop-equivalent agent run (`docs/guides/agent-run-harness.md`).
 *
 * Sends ONE agent-mode prompt through the same main-process path the Electron app uses when
 * the editor presses Enter in Agent mode — durable run start (`RunIpcHub`), `AiStreamHub`
 * with the durable hooks, the host auto-commit of every proposed patch
 * (`ProjectCommandService.commitPatch` + the auto-accept memory write), the sidecar tool
 * executor with the desktop's host hooks, the tracking/masking executors and the temporal
 * evidence acquirer — and records what happened.
 *
 * Run: `tsx apps/desktop/scripts/agent-run.ts --project <p.fp.json> --prompt-file <txt> --out <dir>`
 *
 * SUBSTITUTIONS vs `apps/desktop/electron/main.ts` (everything else is the desktop's own module):
 *  1. `electronFetch` (Chromium net stack) → Node's global `fetch`. Only the sidecar (localhost)
 *     and the stock/music providers are reached this way; the model provider brings its own HTTP.
 *  2. `app.getPath('userData')` → `<out>/state/` for everything the run WRITES (run WAL, project
 *     revisions, stock quota, pack store). `ai-config.json` is READ from the real userData dir
 *     (read-only; `AiConfigStore` writes only on `applyUpdate`, which is never called). The
 *     stock-quota file is copied in so `requestsLeftThisMonth` matches the app.
 *  3. The projects root → `<out>/projects/`. The project JSON is rewritten there as the baseline
 *     (see `--timeline`), and the project's media folder, its brain dir
 *     (`.framepilot-derived/<projectId>/`) and the proxy/thumbnail dirs its assets reference are
 *     APFS-CLONED (copy-on-write), not symlinked: the engine's `resolve_within` realpaths every
 *     path and would reject a symlink that leaves the sandbox. Nothing is ever written under the
 *     source projects root.
 *  4. The sidecar is this script's own `uv run framepilot serve` on `--port` (default 8812) with
 *     `FRAMEPILOT_PROJECTS_ROOT=<out>/projects`, spawned exactly as `sidecar/spawn.ts` does in dev
 *     (own process group, parent pid, the repo `.env` merged under the process env).
 *  5. Capability packs: `CapabilityPackDesktopService` runs over an EMPTY store under
 *     `<out>/state/capability-packs/`, so tracking/masking/detect_subjects answer exactly what the
 *     desktop answers when no pack is installed (a real "unavailable"/install-proposal result,
 *     never a faked success), and no visual pack handles are sent (the app sends the installed
 *     visual-embed/visual-describe handles). The local-whisper runtime env is therefore empty too.
 *  6. The renderer is replaced by what it sends and what it does with the reply:
 *     `projectSnapshotForAiRun` (no live editor state), `captureEditorInteractionContext` at
 *     playhead 0 with no selection, `userMemory` = the SDK's empty scope (the app's localStorage
 *     holds none), the agent options from Settings (`--max-usd`/`--max-minutes`/`--plan-first`),
 *     `provider` = the active provider. Events are appended to a conversation exactly as
 *     `AiSidebar` does (user_message first, stream events as published, a failure card on a
 *     thrown run) and exported with the app's own `toMarkdown`. The usage chip and "no edits"
 *     notices the sidebar adds from its own settings are not reproduced.
 *  7. Host-only side effects with no headless consumer are dropped: the project file watcher,
 *     recovery snapshot, active-project pointer file, `projectChanged` IPC push, telemetry, the
 *     license gate. The active project is fixed to the scratch copy, so `decideCommitTarget`
 *     always allows the commit.
 *  8. `ask_user`: nobody can click. The durable question gate is answered through the SAME
 *     durable `answer` command the renderer sends, with `--ask-policy` (default: the first
 *     offered option, else a fixed "decide yourself" sentence). Every ask is listed in
 *     summary.json.
 *  9. The session warm-up the app fires on project open is awaited before the prompt is sent
 *     (the app's project had been open for a while; the cloned brain makes it cache hits).
 * 10. The Claude Code session variables (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`,
 *     `CLAUDE_EFFORT`) are removed from this process before anything spawns, so the
 *     `claude-agent-sdk` provider's `claude` child behaves as it does under the desktop app.
 *
 * A watchdog kills the whole process tree when its RSS passes `--max-rss-gb` (default 10) or
 * system swap grows by more than `--max-swap-growth-gb` (default 1.5).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------------------------
// Environment first: nothing below may spawn before the agent-session variables are gone.
// ---------------------------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
/** Where `main.ts` runs from in dev (`apps/desktop/dist`) — the sticker roots hang off it. */
const DESKTOP_MAIN_DIR = path.join(REPO_ROOT, 'apps/desktop/dist');
const DESKTOP_USER_DATA = path.join(homedir(), 'Library/Application Support/@framepilot/desktop');
const AGENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/;

for (const key of Object.keys(process.env)) {
  if (AGENT_SESSION_ENV.test(key)) delete process.env[key];
}

const { loadDotEnvFile } = await import('../electron/env.js');
// Same call, same precedence as main.ts: the repo `.env` fills gaps, the process env wins.
loadDotEnvFile(path.join(REPO_ROOT, '.env'));

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' },
    'prompt-file': { type: 'string' },
    out: { type: 'string' },
    history: { type: 'string' },
    'conversation-id': { type: 'string' },
    port: { type: 'string', default: '8812' },
    timeline: { type: 'string', default: 'empty' },
    'max-usd': { type: 'string' },
    'max-minutes': { type: 'string' },
    'plan-first': { type: 'boolean', default: false },
    provider: { type: 'string' },
    'ask-policy': { type: 'string', default: 'first-option' },
    'max-rss-gb': { type: 'string', default: '10' },
    'max-swap-growth-gb': { type: 'string', default: '1.5' },
    'skip-memory-check': { type: 'boolean', default: false },
  },
});

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(
      `--${name} is required. Usage: agent-run.ts --project <p.fp.json> --prompt-file <txt> --out <dir>`,
    );
  }
  return value;
}

const SOURCE_PROJECT = path.resolve(required('project', args.project));
const PROMPT_FILE = path.resolve(required('prompt-file', args['prompt-file']));
const OUT = path.resolve(required('out', args.out));
const PORT = Number(args.port);
const TIMELINE_MODE = args.timeline === 'keep' ? 'keep' : 'empty';
const ASK_POLICY = args['ask-policy'] ?? 'first-option';
const MAX_RSS_BYTES = Number(args['max-rss-gb']) * 1024 ** 3;
const MAX_SWAP_GROWTH_MB = Number(args['max-swap-growth-gb']) * 1024;
const MIN_FREE_MEMORY_PERCENT = 40;
const WATCHDOG_INTERVAL_MS = 5_000;
const SIDECAR_BOOT_TIMEOUT_MS = 180_000;
/** Files are cloned below this size is irrelevant — clonefile costs nothing either way. */
const ENGINE_BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const PROJECTS_ROOT = path.join(OUT, 'projects');
const STATE_DIR = path.join(OUT, 'state');
const EVENTS_PATH = path.join(OUT, 'events.jsonl');
const HARNESS_LOG = path.join(OUT, 'harness.log');

if (OUT.startsWith(path.dirname(SOURCE_PROJECT) + path.sep) || OUT === path.dirname(SOURCE_PROJECT)) {
  throw new Error('--out must not be inside the source projects root.');
}
mkdirSync(PROJECTS_ROOT, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(EVENTS_PATH, '');

/** Harness progress line, timestamped, to stdout and `<out>/harness.log`. */
function say(message: string, data?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ''}`;
  appendFileSync(HARNESS_LOG, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------------------------
// Memory guard (16 GB machine): refuse to start under pressure, kill the tree if it balloons.
// ---------------------------------------------------------------------------------------------

function freeMemoryPercent(): number {
  const text = execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8' });
  const match = /free percentage:\s*(\d+)%/.exec(text);
  return match ? Number(match[1]) : 0;
}

function swapUsedMb(): number {
  const text = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const match = /used = ([\d.]+)M/.exec(text);
  return match ? Number(match[1]) : 0;
}

/** Every descendant pid of `root` (inclusive), with its RSS in bytes. */
function processTree(root: number): Map<number, number> {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    if (pid === undefined || ppid === undefined) continue;
    rss.set(pid, (kb ?? 0) * 1024);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = new Map<number, number>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (tree.has(pid)) continue;
    tree.set(pid, rss.get(pid) ?? 0);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function killTree(signal: NodeJS.Signals): void {
  for (const pid of processTree(process.pid).keys()) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

let peakTreeRssBytes = 0;
function startWatchdog(onTrip: (reason: string) => void): NodeJS.Timeout {
  const swapAtStart = swapUsedMb();
  const timer = setInterval(() => {
    try {
      const treeRss = [...processTree(process.pid).values()].reduce((sum, bytes) => sum + bytes, 0);
      peakTreeRssBytes = Math.max(peakTreeRssBytes, treeRss);
      const swapGrowth = swapUsedMb() - swapAtStart;
      if (treeRss > MAX_RSS_BYTES) {
        onTrip(`process tree RSS ${(treeRss / 1024 ** 3).toFixed(2)} GB > ${String(args['max-rss-gb'])} GB`);
      } else if (swapGrowth > MAX_SWAP_GROWTH_MB) {
        onTrip(`swap grew ${(swapGrowth / 1024).toFixed(2)} GB > ${String(args['max-swap-growth-gb'])} GB`);
      }
    } catch (error) {
      say('watchdog sample failed', { error: String(error) });
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------------------------
// Scratch projects root: baseline project + cloned media/brain. Never writes to the source.
// ---------------------------------------------------------------------------------------------

/** Copy-on-write clone (APFS `clonefile`), falling back to a byte copy on another volume. */
function cloneFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  if (existsSync(to)) return;
  copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
}

function cloneTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  let files = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) files += cloneTree(source, target);
    else if (entry.isFile()) {
      cloneFile(source, target);
      files += 1;
    }
  }
  return files;
}

interface RawAsset {
  readonly path?: string;
  readonly media?: { readonly proxyPath?: string; readonly thumbnailPaths?: readonly string[] };
}

/**
 * Build the scratch projects root the sidecar is sandboxed to, and write the baseline project.
 *
 * @returns The scratch project path.
 */
function prepareProjectsRoot(): string {
  const sourceRoot = path.dirname(SOURCE_PROJECT);
  const raw = JSON.parse(readFileSync(SOURCE_PROJECT, 'utf8')) as Record<string, unknown> & {
    id: string;
    assets: RawAsset[];
    timeline: Record<string, unknown>;
  };
  const projectId = raw.id;
  const cloned = {
    media: cloneTree(path.join(sourceRoot, 'media', projectId), path.join(PROJECTS_ROOT, 'media', projectId)),
    brain: cloneTree(
      path.join(sourceRoot, '.framepilot-derived', projectId),
      path.join(PROJECTS_ROOT, '.framepilot-derived', projectId),
    ),
    derived: 0,
    assetFiles: 0,
  };
  const derivedDirs = new Set<string>();
  for (const asset of raw.assets) {
    // An asset stored outside the project's media folder is cloned on its own.
    if (asset.path && !path.isAbsolute(asset.path) && existsSync(path.join(sourceRoot, asset.path))) {
      const target = path.join(PROJECTS_ROOT, asset.path);
      if (!existsSync(target)) {
        cloneFile(path.join(sourceRoot, asset.path), target);
        cloned.assetFiles += 1;
      }
    }
    for (const derived of [asset.media?.proxyPath, ...(asset.media?.thumbnailPaths ?? [])]) {
      const parts = derived?.split('/') ?? [];
      if (parts[0] === '.framepilot-derived' && parts[1]) derivedDirs.add(parts[1]);
    }
  }
  for (const dir of derivedDirs) {
    cloned.derived += cloneTree(
      path.join(sourceRoot, '.framepilot-derived', dir),
      path.join(PROJECTS_ROOT, '.framepilot-derived', dir),
    );
  }
  // Baseline: a fresh project's timeline (`newProject` in apps/web-editor: `tracks: []`), no
  // history, everything else — assets, folders, fps, resolution, aiMemory — as it is.
  const baseline =
    TIMELINE_MODE === 'empty' ? { ...raw, timeline: { tracks: [] }, history: [] } : { ...raw };
  const scratchProject = path.join(PROJECTS_ROOT, path.basename(SOURCE_PROJECT));
  writeFileSync(scratchProject, JSON.stringify(baseline, null, 2));
  say('scratch projects root ready', { projectsRoot: PROJECTS_ROOT, timeline: TIMELINE_MODE, cloned });
  return scratchProject;
}

// ---------------------------------------------------------------------------------------------
// Sidecar: `sidecar/spawn.ts`'s dev branch, on our own port and root.
// ---------------------------------------------------------------------------------------------

async function isEngineUp(): Promise<boolean> {
  try {
    const response = await fetch(`${ENGINE_BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startSidecar(): Promise<ChildProcess> {
  if (await isEngineUp()) {
    throw new Error(`Something already answers on ${ENGINE_BASE_URL}; pick another --port.`);
  }
  const logFd = openSync(path.join(OUT, 'sidecar.log'), 'a');
  const child = spawn('uv', ['run', 'framepilot', 'serve', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: path.join(REPO_ROOT, 'engine/python'),
    env: {
      ...process.env,
      FRAMEPILOT_PROJECTS_ROOT: PROJECTS_ROOT,
      ...(process.env.FRAMEPILOT_PARENT_PID ? {} : { FRAMEPILOT_PARENT_PID: String(process.pid) }),
    },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + SIDECAR_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Sidecar exited with ${String(child.exitCode)}; see sidecar.log.`);
    if (await isEngineUp()) {
      say('sidecar healthy', { pid: child.pid, url: ENGINE_BASE_URL });
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Sidecar did not become healthy in time; see sidecar.log.');
}

function stopSidecar(child: ChildProcess | undefined): void {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const startedAt = Date.now();
let sidecar: ChildProcess | undefined;
let watchdogReason: string | undefined;
const abortRun = new AbortController();

async function main(): Promise<void> {
  if (!args['skip-memory-check']) {
    const free = freeMemoryPercent();
    if (free < MIN_FREE_MEMORY_PERCENT) {
      throw new Error(
        `Only ${String(free)}% memory free (need ${String(MIN_FREE_MEMORY_PERCENT)}%). Close something or pass --skip-memory-check.`,
      );
    }
    say('memory ok', { freePercent: free, swapUsedMb: swapUsedMb() });
  }
  startWatchdog((reason) => {
    if (watchdogReason !== undefined) return;
    watchdogReason = reason;
    say('WATCHDOG TRIPPED — killing the process tree', { reason });
    abortRun.abort();
    killTree('SIGKILL');
    process.exitCode = 137;
    setTimeout(() => process.exit(137), 2_000).unref();
  });

  const scratchProjectPath = prepareProjectsRoot();
  sidecar = await startSidecar();
  await runTurn(scratchProjectPath);
}

/**
 * Everything `registerIpcHandlers` builds for an agent run, then one `aiStreamStart`.
 */
async function runTurn(scratchProjectPath: string): Promise<void> {
  const ai = await import('@framepilot/ai-sdk');
  const { parseProject } = await import('@framepilot/timeline-schema');
  const { readProjectFile, serializeProject, writeProjectFile } = await import(
    '@framepilot/timeline-schema/file'
  );
  const { resolveWithin } = await import('@framepilot/shared-types/safety');
  const { AiConfigStore } = await import('../electron/ai/ai-config.js');
  const { AiStreamHub, parseAiStreamRequest, prepareAiEventForTransport } = await import(
    '../electron/ai/ai-stream.js'
  );
  const { shouldAutoCommitAiDiff } = await import('../electron/ai/patch-settlement.js');
  const { decideCommitTarget } = await import('../electron/ai/commit-target.js');
  const { describeUnresolvableAssets, unresolvableAddedAssets } = await import(
    '../electron/ai/asset-paths.js'
  );
  const { recordAutoAcceptedMemory } = await import('../electron/ai/auto-accept-memory.js');
  const { RunStore, FileRunStoreIO } = await import('../electron/ai/run-store.js');
  const { RunCoordinator, RunGateway } = await import('../electron/ai/run-coordinator.js');
  const { RunIpcHub } = await import('../electron/ai/run-ipc.js');
  const { describeEffectResult, describeRuntimeEffect } = await import('../electron/ai/effect-record.js');
  const { DurableRunControls } = await import('../electron/ai/durable-run-controls.js');
  const { createAutomaticTrackingExecutor } = await import(
    '../electron/ai/automatic-tracking-executor.js'
  );
  const { createMaskingExecutor, MASKING_EXECUTOR_TOOLS } = await import(
    '../electron/ai/masking-executor.js'
  );
  const { createEngineCropColourSource } = await import('../electron/ai/crop-colour-client.js');
  const { createCropReranker } = await import('../electron/ai/crop-reranker.js');
  const { desktopAiMaskingDisabledTools } = await import('../electron/ai/ai-masking-switch.js');
  const { createAssetEnroller, stockEnrolmentTargetFor } = await import(
    '../electron/ai/asset-enrolment.js'
  );
  const { createStockHost } = await import('../electron/ai/stock-host.js');
  const { createStickerHost } = await import('../electron/ai/sticker-host.js');
  const { ProjectCommandService } = await import('../electron/projects/project-command-service.js');
  const { mergeLiveProjectForHost } = await import('../electron/projects/project-transport.js');
  const { writeToolImageAttachment } = await import('../electron/projects/media-import.js');
  const { mediaContentType } = await import('../electron/security/media-protocol.js');
  const { cacheDerivedMedia, sidecarDerive } = await import('../electron/media/derived-media-cache.js');
  const { MusicService } = await import('../electron/media/music-service.js');
  const { StockService } = await import('../electron/media/stock-service.js');
  const { StockQuotaStore } = await import('../electron/media/stock-quota.js');
  const { ElementsLibrary, bundledStickersRoot, packagedStickersRoot } = await import(
    '../electron/media/elements-library.js'
  );
  const { CapabilityPackDesktopService } = await import('../electron/capability-packs/service.js');
  const { autoEnrolmentTiers } = await import('../electron/capability-packs/visual-packs.js');
  const { loadCapabilityPackRootKeys } = await import('../electron/capability-packs/config.js');
  const { CapabilityPackJobScheduler, FileJobJournal } = await import(
    '../electron/capability-packs/job-scheduler.js'
  );
  const { DesktopMatteMediaInspector, resolveMatteFfprobe } = await import(
    '../electron/capability-packs/matte-media-inspector.js'
  );
  const { createConversation, appendEvents } = await import('../../web-editor/src/ai/conversation.js');
  const { toMarkdown } = await import('../../web-editor/src/ai/conversationExport.js');

  type Project = import('@framepilot/timeline-schema').Project;
  type AiEvent = import('@framepilot/ai-sdk').AiEvent;
  type HostToolOutcome = import('@framepilot/ai-sdk').HostToolOutcome;
  type HostToolExecutor = import('@framepilot/ai-sdk').HostToolExecutor;
  type AiProviderName = import('../electron/ipc/contract.js').AiProviderName;
  type EffectRuntimeObserver = import('@framepilot/ai-sdk').EffectRuntimeObserver;
  type RuntimeEffect = import('@framepilot/ai-sdk').RuntimeEffect;
  type JsonValue = import('@framepilot/ai-sdk').JsonValue;

  const fetchFn: typeof fetch = globalThis.fetch.bind(globalThis);
  const noop = (): void => undefined;

  // ---- configuration + host stores (userData → <out>/state) --------------------------------
  const aiConfig = new AiConfigStore(path.join(DESKTOP_USER_DATA, 'ai-config.json'));
  const stockQuotaSource = path.join(DESKTOP_USER_DATA, 'stock-quota.json');
  if (existsSync(stockQuotaSource)) cloneFile(stockQuotaSource, path.join(STATE_DIR, 'stock-quota.json'));
  const fileIO = (file: string) => ({
    read: async (): Promise<string | null> => {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    write: async (contents: string): Promise<void> => {
      await writeFile(`${file}.tmp`, contents, 'utf8');
      await rename(`${file}.tmp`, file);
    },
  });
  const projectCommands = new ProjectCommandService(
    serializeProject,
    fileIO(path.join(STATE_DIR, 'project-revisions.json')),
  );
  const project0 = await readProjectFile(scratchProjectPath, { backupBeforeMigration: true });
  await writeProjectFile(scratchProjectPath, project0);
  projectCommands.observe(project0);
  const activePointer = { path: scratchProjectPath, projectId: project0.id, updatedAt: Date.now() };
  const activeProject = { current: async () => activePointer };

  // ---- capability packs: the desktop service over an EMPTY store (substitution 5) -----------
  const matteMediaInspector = new DesktopMatteMediaInspector({
    ffprobe: resolveMatteFfprobe({
      env: process.env,
      isPackaged: false,
      resourcesPath: '',
      platform: process.platform,
      fileExists: existsSync,
    }),
    sidecarBaseUrl: ENGINE_BASE_URL,
    fetch: fetchFn,
  });
  const desktopVersion = (
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const capabilityPackService = Promise.resolve(
    new CapabilityPackDesktopService({
      rootPath: path.join(STATE_DIR, 'capability-packs'),
      ...(process.env.FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL === undefined
        ? {}
        : { catalogUrl: process.env.FRAMEPILOT_CAPABILITY_PACK_CATALOG_URL }),
      trustedRootKeys: await loadCapabilityPackRootKeys(process.env.FRAMEPILOT_CAPABILITY_PACK_ROOT_KEYS_PATH),
      appVersion: desktopVersion,
      runtimeCacheRoot: path.join(STATE_DIR, 'capability-pack-cache'),
      matteMediaInspector,
      matteObserver: noop,
      onStoreChanged: noop,
      fetch: fetchFn,
      onProgress: noop,
    }),
  );
  const packJobScheduler = new CapabilityPackJobScheduler({
    journal: new FileJobJournal(path.join(STATE_DIR, 'capability-pack-jobs.json')),
    onChange: noop,
  });

  // ---- visual credentials (main.ts `visualIndexCredentials`, no pack handles) -------------
  const visualIndexCredentials = () => {
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

  // ---- transcription (main.ts `hostTranscribe`) --------------------------------------------
  const HOSTED_ASR_CHUNK_SECONDS = 30;
  const hostTranscribe = async (
    project: Project,
    assetId: string | undefined,
    signal?: AbortSignal,
  ): Promise<HostToolOutcome | null> => {
    const providerName = aiConfig.resolveAsrProvider();
    if (providerName === 'whisper-cli') return null;
    if (typeof assetId !== 'string' || assetId.trim() === '') {
      return {
        status: 'failed',
        summary:
          'transcribe needs an assetId. Call list_assets to see the project’s media and ' +
          'their ids, then transcribe one of the audio or video assets.',
      };
    }
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      return {
        status: 'failed',
        summary:
          `Asset "${assetId}" is not in this project, so there was nothing to transcribe. ` +
          'Call list_assets to see the ids that do exist and transcribe one of those.',
      };
    }
    if (asset.kind !== 'audio' && asset.kind !== 'video') {
      return {
        status: 'failed',
        summary:
          `Asset "${assetId}" is ${asset.kind === 'image' ? 'an image' : `a ${asset.kind} asset`}, ` +
          'and only audio and video carry speech. Call list_assets to find an audio or ' +
          'video asset and transcribe that one instead.',
      };
    }
    const active = await activeProject.current();
    const toOutcome = (words: readonly object[]): HostToolOutcome =>
      words.length === 0
        ? { status: 'failed', summary: ai.unusableHostPayload('transcribe') }
        : {
            status: 'completed',
            summary: `Transcribed ${words.length} timed word${words.length === 1 ? '' : 's'}`,
            data: { assetId: asset.id, words: words.map((word) => ({ ...word, assetId: asset.id })) },
          };
    try {
      if (providerName === 'twelvelabs') {
        const apiKey = aiConfig.resolveTwelveLabsKey();
        if (!apiKey) {
          return {
            status: 'failed',
            summary: ai.hostedTranscriptionUnavailable(
              'Add a TwelveLabs API key in Settings → AI → Media intelligence.',
            ),
          };
        }
        const indexed = await ai.runVisualIndexLoop({
          client: new ai.VisualIndexClient({ baseUrl: ENGINE_BASE_URL, fetchFn }),
          request: { projectId: project.id, projectPath: active.path, assetIds: [assetId], twelveLabsKey: apiKey },
          ...(signal ? { signal } : {}),
        });
        if (indexed.status !== 'done') {
          return {
            status: 'failed',
            summary: ai.hostedTranscriptionUnavailable(
              indexed.last?.reason ??
                `TwelveLabs indexing did not complete (${indexed.status.replaceAll('-', ' ')}).`,
            ),
          };
        }
        const provider = ai.createAsrProvider('twelvelabs', { apiKey, baseUrl: ENGINE_BASE_URL }, fetchFn);
        if (provider.name !== 'twelvelabs') {
          return { status: 'failed', summary: ai.hostedTranscriptionUnavailable('TwelveLabs transcription is unavailable.') };
        }
        const result = await provider.transcribe({ projectPath: active.path, projectId: project.id, assetId }, signal);
        if (!result.available) return { status: 'failed', summary: ai.hostedTranscriptionUnavailable(result.reason) };
        return toOutcome(result.words);
      }
      const apiKey = aiConfig.resolveAsrApiKey();
      const asrModel = aiConfig.resolveAsrModel();
      const provider = ai.createAsrProvider(
        providerName,
        { ...(apiKey !== undefined ? { apiKey } : {}), ...(asrModel !== undefined ? { model: asrModel } : {}) },
        fetchFn,
      );
      if (provider.name === 'whisper-cli') return null;
      if (provider.name === 'twelvelabs') {
        return {
          status: 'failed',
          summary: ai.hostedTranscriptionUnavailable('FramePilot routed this to the wrong speech-to-text provider.'),
        };
      }
      const bytes = new Uint8Array(
        await readFile(resolveWithin(PROJECTS_ROOT, path.resolve(path.dirname(active.path), asset.path))),
      );
      // Narrowed to the hosted (byte-taking) arm, exactly the branch main.ts reaches here.
      const hosted = provider as unknown as import('@framepilot/ai-sdk').ChunkTranscriber;
      let chunked: import('@framepilot/ai-sdk').AsrResult | undefined;
      if (asset.durationSeconds !== undefined && asset.durationSeconds > HOSTED_ASR_CHUNK_SECONDS) {
        const response = await fetchFn(`${ENGINE_BASE_URL}/asr/prepare-audio`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project, asset_id: asset.id }),
        }).catch(() => undefined);
        if (response?.ok) {
          chunked = await ai.transcribeWavInChunks(hosted, new Uint8Array(await response.arrayBuffer()), {
            chunkSeconds: HOSTED_ASR_CHUNK_SECONDS,
            filenameBase: path.basename(asset.path),
          });
        }
      }
      const result = chunked ?? await hosted.transcribe({
        bytes,
        filename: path.basename(asset.path),
        mimeType: mediaContentType(asset.path),
      });
      if (!result.available) return { status: 'failed', summary: ai.hostedTranscriptionUnavailable(result.reason) };
      return toOutcome(result.words);
    } catch (error) {
      return { status: 'failed', summary: ai.hostedTranscriptionUnavailable(error instanceof Error ? error.message : String(error)) };
    }
  };

  // ---- music / stock / stickers: the app's own services on the scratch root ----------------
  const cachedDerive = (request: { thumbnails: number; proxy: boolean }) =>
    cacheDerivedMedia(sidecarDerive({ baseUrl: ENGINE_BASE_URL, request, fetchFn }), {
      projectsRoot: PROJECTS_ROOT,
    });
  const musicService = new MusicService({
    projectsRoot: PROJECTS_ROOT,
    fetchImpl: fetchFn,
    deriveAssetMedia: cachedDerive({ thumbnails: 0, proxy: false }),
    onProgress: noop,
  });
  const stockQuota = new StockQuotaStore({
    filePath: path.join(STATE_DIR, 'stock-quota.json'),
    isKeyConfigured: () => aiConfig.resolvePexelsApiKey() !== undefined,
  });
  const stockService = new StockService({
    projectsRoot: PROJECTS_ROOT,
    resolveApiKey: () => aiConfig.resolvePexelsApiKey(),
    quota: stockQuota,
    fetchImpl: fetchFn,
    deriveAssetMedia: cachedDerive({ thumbnails: 5, proxy: true }),
    onProgress: noop,
  });
  const elementsLibrary = new ElementsLibrary({
    projectsRoot: PROJECTS_ROOT,
    bundledRoot: () => bundledStickersRoot(DESKTOP_MAIN_DIR, false),
    packagedRoot: () => {
      const root = packagedStickersRoot(DESKTOP_MAIN_DIR, false, '');
      return existsSync(root) ? root : null;
    },
    catalog: ai.loadStickerCatalog,
    onOutcome: noop,
  });
  const stickerAnswer = await elementsLibrary.thumbnails([]);
  const packagedStickers = stickerAnswer.ok && stickerAnswer.packaged;

  const hostMusicSearch = async (query: string, limit: number | undefined, signal?: AbortSignal): Promise<HostToolOutcome> => {
    if (query.trim() === '') return { status: 'failed', summary: 'search_music needs something to search for.' };
    const result = await musicService.search(query, limit, { supersedePrevious: false, ...(signal ? { signal } : {}) });
    if (!result.ok) return { status: 'failed', summary: ai.sourcingFailureNote('search_music', result.error, result.detail) };
    if (result.tracks.length === 0) {
      return {
        status: 'warning',
        summary:
          `No tracks matched "${query}", including a retry on its strongest words. This ` +
          'library may not carry this mood — call search_music once with a different mood ' +
          'word, or continue without a music bed and tell the editor nothing matched.',
        data: { tracks: [] },
      };
    }
    const matched =
      result.matchedQuery === undefined
        ? `"${query}".`
        : `"${result.matchedQuery}" — this library matches short phrases, so only the ` +
          `opening words of a longer query are used. Search two or three words.`;
    return {
      status: 'completed',
      summary:
        `Found ${result.tracks.length} track${result.tracks.length === 1 ? '' : 's'} for ${matched} ` +
        'No tempo or structure is published for any of them — to know a track’s rhythm, ' +
        'add_music it and run detect_beats.',
      data: { tracks: result.tracks },
    };
  };
  const hostAddMusic = async (
    project: Project,
    input: { readonly remoteId: string; readonly atSeconds?: number; readonly duckUnderTrackId?: string },
  ): Promise<HostToolOutcome> => {
    const { remoteId, atSeconds, duckUnderTrackId } = input;
    if (remoteId.trim() === '') return { status: 'failed', summary: 'add_music needs the remoteId of a track from search_music.' };
    const localRefusal = ai.localMusicAssetRefusal(project.assets, remoteId);
    if (localRefusal) return { status: 'failed', summary: localRefusal };
    const result = await musicService.download({ projectId: project.id, remoteId, operationId: `agent_${remoteId}_${Date.now()}` });
    if (!result.ok) return { status: 'failed', summary: ai.sourcingFailureNote('add_music', result.error, result.detail) };
    const { asset } = result;
    return {
      status: 'completed',
      summary: `Downloaded "${asset.relativePath}".`,
      data: {
        asset: {
          id: `music_${asset.source.provider}_${asset.source.remoteId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          path: asset.relativePath,
          kind: 'audio',
          ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
          ...(asset.media ? { media: asset.media } : {}),
          source: asset.source,
        },
        ...(atSeconds === undefined ? {} : { atSeconds }),
        ...(duckUnderTrackId === undefined ? {} : { duckUnderTrackId }),
      },
    };
  };
  const hostStockSearch = async (
    input: {
      readonly query: string;
      readonly kind: 'photo' | 'video';
      readonly limit?: number;
      readonly orientation?: 'landscape' | 'portrait' | 'square';
    },
    signal?: AbortSignal,
  ): Promise<HostToolOutcome> => {
    if (input.query.trim() === '') return { status: 'failed', summary: 'search_stock needs something to search for.' };
    const result = await stockService.search(
      {
        text: input.query,
        kind: input.kind,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
      },
      { supersedePrevious: false, ...(signal ? { signal } : {}) },
    );
    if (!result.ok) return { status: 'failed', summary: ai.sourcingFailureNote('search_stock', result.error, result.detail) };
    if (result.items.length === 0) {
      return {
        status: 'warning',
        summary:
          `Nothing matched "${input.query}". Call search_stock once with a broader subject ` +
          'word; if that is empty too, build from the footage the project already holds ' +
          '(list_assets shows it) and tell the editor stock had nothing for this subject.',
        data: { items: [] },
      };
    }
    const quota = stockQuota.snapshot();
    return {
      status: 'completed',
      summary: `Found ${result.items.length} ${input.kind === 'video' ? 'clip' : 'photo'}${result.items.length === 1 ? '' : 's'} for "${input.query}".`,
      data: {
        items: result.items,
        ...(quota.kind === 'measured' ? { requestsLeftThisMonth: quota.monthly.remaining } : {}),
      },
    };
  };

  // ---- enrolment + shot ledger (main.ts, pack handles = none) ------------------------------
  const enrolmentShutdown = new AbortController();
  const shotLedgerClient = new ai.LedgerClient({ baseUrl: ENGINE_BASE_URL, fetchFn });
  const assetEnroller = createAssetEnroller({
    signal: enrolmentShutdown.signal,
    enrol: async ({ projectId, assetIds, signal }) => {
      const result = await ai.runVisualIndexLoop({
        client: new ai.VisualIndexClient({ baseUrl: ENGINE_BASE_URL, fetchFn }),
        request: {
          projectId,
          assetIds: [...assetIds],
          tiers: autoEnrolmentTiers({
            hostedLabelsConfigured:
              aiConfig.resolveEmbeddingsKeys() !== undefined || aiConfig.resolveTwelveLabsKey() !== undefined,
            handles: {},
          }),
          ...visualIndexCredentials(),
        },
        signal,
      });
      const nothingIndexed = result.last !== undefined && result.last.failed > 0 && result.last.indexed === 0;
      if (result.status !== 'done' || nothingIndexed) {
        throw new Error(
          nothingIndexed
            ? `visual index indexed nothing: ${String(result.last?.failed)} asset(s) failed`
            : `visual index did not complete: ${result.status}`,
        );
      }
      shotLedgerClient.invalidate(projectId, assetIds);
    },
  });
  const hostAddStock = createStockHost({
    unresolvableReason: (remoteId) => stockService.unresolvableReason(remoteId),
    knownItem: (remoteId) => stockService.knownItem(remoteId),
    download: async (request) => {
      const result = await stockService.download(request);
      const target = stockEnrolmentTargetFor(request, result);
      if (target) assetEnroller.request(target.projectId, target.assetId);
      return result;
    },
  });
  const hostAddSticker = createStickerHost(elementsLibrary);

  // ---- the tool executor (main.ts `toolExecutor`) ------------------------------------------
  const sidecarToolExecutor = ai.createSidecarExecutor({
    baseUrl: ENGINE_BASE_URL,
    fetchFn,
    visualIndexCredentials,
    hostTranscribe,
    hostMusicSearch,
    hostAddMusic,
    hostStockSearch,
    hostAddStock,
    hostAddSticker,
  });
  const automaticTrackingExecutor = createAutomaticTrackingExecutor({
    tracking: async () => (await capabilityPackService).tracking(),
  });
  const identityClient = new ai.IdentityClient({ baseUrl: ENGINE_BASE_URL, fetchFn });
  const maskingExecutor = createMaskingExecutor({
    tracking: async () => (await capabilityPackService).tracking(),
    matte: async () => (await capabilityPackService).matte(),
    scheduler: packJobScheduler,
    activeProjectPath: async () => (await activeProject.current()).path,
    evidence: {
      faceRecognitionConsent: async (project) => (await identityClient.state(project.id)).consent,
      rerank: createCropReranker({
        tracking: async () => (await capabilityPackService).tracking(),
        measure: createEngineCropColourSource({ baseUrl: ENGINE_BASE_URL, fetchFn }),
      }),
    },
  });
  const aiMaskingOff = (): readonly string[] =>
    desktopAiMaskingDisabledTools({ env: process.env, packaged: false });
  const toolExecutor: HostToolExecutor = {
    async run(call, ctx, signal) {
      if (call.name === ai.AUTOMATIC_TRACKING_TOOL_NAME || call.name === ai.DETECT_SUBJECTS_TOOL_NAME) {
        return automaticTrackingExecutor.run(call, ctx, signal);
      }
      if (MASKING_EXECUTOR_TOOLS.has(call.name) && !aiMaskingOff().includes(call.name)) {
        return maskingExecutor.run(call, ctx, signal);
      }
      const outcome = await sidecarToolExecutor.run(call, ctx, signal);
      const describedAsset = (call.arguments as { readonly assetId?: unknown }).assetId;
      if (call.name === 'describe_footage' && outcome.status === 'completed' && typeof describedAsset === 'string') {
        shotLedgerClient.invalidate(ctx.project.id, [describedAsset]);
      }
      return outcome;
    },
    unroutableTools: () => sidecarToolExecutor.unroutableTools?.() ?? new Set<string>(),
  };
  const temporalEvidence = ai.createTemporalEvidenceAcquirer({ baseUrl: ENGINE_BASE_URL, fetchFn });

  // ---- orchestrator (main.ts `getOrchestrator` + `buildTierProviders`) ---------------------
  const buildTierProviders = (name: AiProviderName) => {
    let configs: Partial<Record<import('@framepilot/ai-sdk').ModelTier, import('@framepilot/ai-sdk').ProviderConfig>>;
    try {
      configs = aiConfig.resolveTierConfigs(name);
    } catch (error) {
      say('tier provider config invalid — every tier uses the active provider', { error: String(error) });
      return {};
    }
    const tierProviders: Partial<Record<string, import('@framepilot/ai-sdk').AiProvider>> = {};
    for (const [tier, config] of Object.entries(configs)) {
      if (!config) continue;
      try {
        tierProviders[tier] = ai.withResilience(ai.createProviderFromConfig(config));
        say('tier provider selected', { tier, provider: config.name, model: config.model });
      } catch (error) {
        say('tier provider unavailable — falling back', { tier, provider: config.name, error: String(error) });
      }
    }
    return Object.keys(tierProviders).length === 0 ? {} : { tierProviders };
  };
  const getOrchestrator = (requested?: AiProviderName, effectObserver?: EffectRuntimeObserver) => {
    const name: AiProviderName = requested ?? aiConfig.activeProvider();
    const resolved = aiConfig.resolveConfig(name);
    say('getOrchestrator — provider selected', { provider: name, model: resolved.model, hasKey: Boolean(resolved.apiKey) });
    const orchestratorOptions = {
      executor: toolExecutor,
      disabledTools: aiMaskingOff,
      ...(packagedStickers ? { packagedStickers } : {}),
      ...(effectObserver === undefined ? {} : { effectObserver }),
      ...(name === 'mock' ? {} : buildTierProviders(name)),
    };
    if (name !== 'mock') {
      return new ai.Orchestrator(ai.withResilience(ai.createProviderFromConfig(resolved)), orchestratorOptions);
    }
    return new ai.Orchestrator(ai.withResilience(new ai.MockProvider()), orchestratorOptions);
  };

  // ---- durable run plumbing (main.ts, stored under <out>/state/orchestration) --------------
  const runStore = new RunStore(new FileRunStoreIO(path.join(STATE_DIR, 'orchestration')));
  const runGatewayCoordinator = new RunCoordinator(runStore);
  const runIpcHub = new RunIpcHub(new RunGateway(runGatewayCoordinator), 'framepilot:run:event');
  const RECORDED_KEY_CHARS = ai.MAX_IDENTITY_KEY_CHARS - ai.KEY_DIGEST_CHARS - 4;
  const createDurableEffectObserver = (runId: string, projectId: string): EffectRuntimeObserver => {
    const legacyIds = new WeakMap<object, string>();
    const identity = (effect: RuntimeEffect) => {
      if (effect.kind !== 'host_tool' && effect.kind !== 'model' && effect.kind !== 'model_stream') {
        return {
          effectId: effect.control.effectId,
          taskId: effect.control.taskId,
          idempotencyKey: ai.boundedKeySegment(effect.control.idempotencyKey, RECORDED_KEY_CHARS),
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
        idempotencyKey: ai.boundedKeySegment(ai.idempotencyKeyFor(effect) ?? effectId, RECORDED_KEY_CHARS),
      };
    };
    const record = async (effect: RuntimeEffect, phase: 'requested' | 'settled' | 'failed', value: JsonValue) => {
      await runGatewayCoordinator.recordRuntimeEffect({
        runId,
        projectId,
        ...identity(effect),
        effectKind: effect.kind,
        phase,
        ...(phase === 'requested'
          ? { detail: ai.toJsonValue(value) }
          : { outcome: ai.toJsonValue(value) }),
      });
    };
    return {
      onRequested: (effect) => record(effect, 'requested', describeRuntimeEffect(effect)),
      onSettled: (effect, result) => record(effect, 'settled', describeEffectResult(result)),
      onFailed: (effect, error) =>
        record(effect, 'failed', {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        }),
    };
  };
  const indexProjectBrain = (projectId: string, projectPath: string): void => {
    void fetchFn(`${ENGINE_BASE_URL}/brain/index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, project_path: projectPath }),
    }).catch(noop);
  };

  // ---- the hub (main.ts `new AiStreamHub(getOrchestrator, {...})`) -------------------------
  const desktopVisualIndex = new ai.VisualIndexClient({ baseUrl: ENGINE_BASE_URL, fetchFn });
  const loadReferenceStill = ai.createReferenceStillLoader({ baseUrl: ENGINE_BASE_URL, fetchFn });
  const aiStreamHub = new AiStreamHub(getOrchestrator, {
    eventChannel: 'framepilot:ai:stream-event',
    temporalEvidence,
    media: {
      referenceStill: async (file, signal) =>
        loadReferenceStill(
          { referenceId: file.referenceId, inputPath: resolveWithin(PROJECTS_ROOT, file.path), fileName: file.fileName },
          signal,
        ),
      saveToolImage: async (projectId, mediaType, bytes) =>
        writeToolImageAttachment(PROJECTS_ROOT, projectId, mediaType, bytes),
    },
    visualStatusFor: ai.createVisualStatusDigester({ baseUrl: ENGINE_BASE_URL, fetchFn }),
    footageMapFor: async (project) =>
      ai.summarizeFootageMap(
        await desktopVisualIndex.footageMap({
          projectId: project.id,
          project: project as unknown as Record<string, unknown>,
          cachedOnly: true,
          ...visualIndexCredentials(),
        }),
      ),
    shotLedgerFor: async (project) => {
      const inBin = new Set(project.assets.map((asset) => asset.id));
      const assetIds = [
        ...new Set(
          project.timeline.tracks.flatMap((track) =>
            track.clips.map((clip) => clip.assetId).filter((id): id is string => Boolean(id) && inBin.has(id as string)),
          ),
        ),
      ];
      if (assetIds.length === 0) return undefined;
      return (await shotLedgerClient.snapshot({ projectId: project.id, assetIds })) ?? undefined;
    },
    refreshShotLedgerFor: async (project, assetIds) => {
      const inBin = new Set([...project.assets.map((asset) => asset.id), ...assetIds]);
      const wanted = [...new Set(assetIds.filter((id) => inBin.has(id)))];
      if (wanted.length === 0) return undefined;
      return (
        (await shotLedgerClient.snapshot({ projectId: project.id, assetIds: [...inBin], refresh: wanted })) ??
        undefined
      );
    },
    sessionContextFor: ai.createSessionContextDigester({ baseUrl: ENGINE_BASE_URL, fetchFn }),
    carriedForwardFor: (conversationId, projectId) =>
      runGatewayCoordinator.latestWorkingStateFor(conversationId, projectId),
    rememberDecision: (projectId, note) => {
      if (projectId === '') return;
      void ai.createMemoryRecorder({ baseUrl: ENGINE_BASE_URL, fetchFn })({
        projectId,
        tier: 'decisions',
        title: note.title,
        body: note.body,
      });
    },
  });

  // ---- session warm-up the app fires on project open (substitution 9) -----------------------
  const warmup = await ai.runSessionWarmup({
    baseUrl: ENGINE_BASE_URL,
    projectId: project0.id,
    projectPath: scratchProjectPath,
    fetchFn,
    signal: abortRun.signal,
  });
  say('session warmup settled', { status: warmup.status, analysed: warmup.analysed, total: warmup.total });

  // ---- what the renderer sends (AiSidebar `runInputFor` + DesktopAiSession.run) ------------
  const userPrompt = readFileSync(PROMPT_FILE, 'utf8');
  const conversationId = args['conversation-id'] ?? randomUUID();
  const turnId = randomUUID();
  const history = await loadHistory(args.history);
  const provider = (args.provider ?? aiConfig.activeProvider()) as AiProviderName;
  const maxUsd = Number(args['max-usd'] ?? ai.DEFAULT_MAX_RUN_USD);
  const maxMinutes = Number(args['max-minutes'] ?? ai.DEFAULT_MAX_RUN_MINUTES);
  const planFirst = args['plan-first'] === true;
  const agentOptions = { planFirst, requirePlanApproval: planFirst, maxUsd, maxMinutes };
  const projectRevision = projectCommands.revision(project0.id) ?? 0;
  const projectSnapshot: Project = { ...project0 };
  const interaction = ai.captureEditorInteractionContext({
    project: projectSnapshot,
    projectRevision,
    playheadSeconds: 0,
    selectedClipIds: [],
    selectedEffectLayerIds: [],
    selectedKeyframes: [],
  });

  const sender = {
    id: 1,
    isDestroyed: () => false,
    once: noop,
    removeListener: noop,
    send: noop as (channel: string, message: unknown) => void,
  };
  const turnEmitter = ai.createTurnEmitter({ conversationId, turnId });
  const userMessage = turnEmitter.userMessage(userPrompt, []);
  let conversation = appendEvents(
    createConversation({
      id: conversationId,
      projectId: project0.id,
      model: aiConfig.resolveConfig(provider).model ?? provider,
      mode: 'agent',
      now: userMessage.ts,
    }),
    [userMessage],
  );
  const published: AiEvent[] = [];
  const asks: { toolCallId: string; question: string; answer: string }[] = [];
  let projectChangedPushes = 0;

  const durable = await runIpcHub.start(sender, {
    projectId: project0.id,
    projectRevision,
    userPrompt,
    mode: 'auto',
    agentOptions,
    patchPolicy: 'auto_commit',
  });
  const durableRunId = durable.snapshot.runId;
  say('durable run started', { runId: durableRunId, conversationId, turnId, provider, agentOptions });

  // ---- main.ts `aiStreamStart` ---------------------------------------------------------------
  const request = parseAiStreamRequest({
    mode: 'auto',
    projectId: project0.id,
    projectRevision,
    project: projectSnapshot,
    userPrompt,
    conversationId,
    turnId,
    durableRunId,
    provider,
    ...(history.length > 0 ? { history } : {}),
    interaction,
    userMemory: ai.EMPTY_USER_MEMORY,
    agentOptions,
  });
  const suppliedProject = parseProject(request.project);
  const hostProject = projectCommands.project(project0.id);
  const currentRevision = projectCommands.revision(project0.id) ?? 0;
  const project = mergeLiveProjectForHost(suppliedProject, hostProject);
  if (!projectCommands.refresh(project, currentRevision)) {
    throw new Error('AI run project revision conflict while refreshing the live editor state.');
  }
  const hydratedRequest = { ...request, project };
  const durableSnapshot = await runIpcHub.snapshot(sender, { runId: durableRunId, projectId: project.id });
  if (durableSnapshot === null) throw new Error('The durable AI run could not be restored.');
  if (shouldAutoCommitAiDiff(durableSnapshot.patchPolicy, undefined)) {
    const target = decideCommitTarget(await activeProject.current(), project.id);
    if (!target.ok) throw new Error(target.reason);
  }
  const commitLedger = new ai.InMemoryPatchCommitLedger();
  let autoExpectedRevision = currentRevision;
  let autoCommitted = false;
  const lifecycleWrites: Promise<unknown>[] = [];
  const durableControls = await DurableRunControls.create(runGatewayCoordinator, durableRunId, project.id, () =>
    aiStreamHub.abortDurable(durableRunId),
  );
  let settle!: (settlement: unknown) => void;
  const settled = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  let terminal: { error?: string; done?: boolean } = {};
  let finishStream!: () => void;
  const streamFinished = new Promise<void>((resolve) => {
    finishStream = resolve;
  });

  const answerAsk = async (event: Extract<AiEvent, { type: 'ask' }>): Promise<void> => {
    const answer =
      ASK_POLICY === 'first-option' && event.options && event.options.length > 0
        ? event.options[0]!.label
        : ASK_POLICY.startsWith('text:')
          ? ASK_POLICY.slice('text:'.length)
          : 'The editor is not available to answer right now. Decide yourself, say what you chose, and continue.';
    asks.push({ toolCallId: event.toolCallId, question: event.question, answer });
    say('ask_user answered by --ask-policy', { toolCallId: event.toolCallId, answer });
    await runIpcHub.command(sender, {
      runId: durableRunId,
      projectId: project.id,
      kind: 'answer',
      payload: { toolCallId: event.toolCallId, answer },
    });
  };

  sender.send = (_channel: string, message: unknown) => {
    const { event, error, done } = message as { event?: AiEvent; error?: string; done?: boolean };
    if (event) {
      published.push(event);
      appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`);
      conversation = appendEvents(conversation, [event]);
      if (event.type === 'status' || event.type === 'diff' || event.type === 'error') {
        say(`event ${event.type}`, {
          ...(event.type === 'status' ? { status: event.status } : {}),
          ...(event.type === 'diff'
            ? { ops: event.edit.patch.operations.length, commit: (event as { commit?: unknown }).commit }
            : {}),
          ...(event.type === 'error' ? { message: event.message } : {}),
        });
      }
      if (event.type === 'tool_call' && event.status !== 'running') {
        say(`tool ${event.toolName} ${event.status}`, { runtimeMs: event.runtimeMs });
      }
      if (event.type === 'ask') void answerAsk(event);
    }
    if (error !== undefined || done) {
      terminal = { ...(error === undefined ? {} : { error }), ...(done ? { done } : {}) };
      finishStream();
    }
  };

  abortRun.signal.addEventListener('abort', () => aiStreamHub.abortDurable(durableRunId));

  aiStreamHub.start(sender, hydratedRequest, {
    durableRunId,
    commitLedger,
    controls: durableControls.controls,
    effectObserver: createDurableEffectObserver(durableRunId, project.id),
    onLifecycleEvent: (stageEvent) => {
      lifecycleWrites.push(
        runGatewayCoordinator
          .recordEditorLifecycle({ runId: durableRunId, projectId: project.id, event: stageEvent })
          .catch(noop),
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
        if (shouldAutoCommitAiDiff(durableSnapshot.patchPolicy, transportEvent.verification)) {
          const target = decideCommitTarget(await activeProject.current(), project.id);
          if (!target.ok) {
            commitLedger.record(patch.patchId, { state: 'stale', reason: target.reason });
            const staleEvent = { ...transportEvent, commit: { state: 'stale' as const, reason: target.reason } };
            await runGatewayCoordinator.recordPatchLifecycle({
              runId: durableRunId,
              projectId: project.id,
              patchId: patch.patchId,
              state: 'stale',
              reason: target.reason,
            });
            const durableEvent = await runGatewayCoordinator.recordStreamEvent({
              runId: durableRunId,
              projectId: project.id,
              event: ai.toJsonValue(staleEvent),
            });
            aiStreamHub.failDurable(durableRunId);
            return { event: staleEvent, durableSequence: durableEvent.sequence };
          }
          const unresolvable = unresolvableAddedAssets(patch, target.path, PROJECTS_ROOT, { exists: existsSync });
          if (unresolvable.length > 0) {
            const reason = describeUnresolvableAssets(unresolvable);
            commitLedger.record(patch.patchId, { state: 'stale', reason });
            await runGatewayCoordinator.recordPatchLifecycle({
              runId: durableRunId,
              projectId: project.id,
              patchId: patch.patchId,
              state: 'stale',
              reason,
            });
            const refusedEvent = { ...transportEvent, commit: { state: 'stale' as const, reason } };
            const durableEvent = await runGatewayCoordinator.recordStreamEvent({
              runId: durableRunId,
              projectId: project.id,
              event: ai.toJsonValue(refusedEvent),
            });
            return { event: refusedEvent, durableSequence: durableEvent.sequence };
          }
          let committedProject: Project | undefined;
          const committed = await projectCommands.commitPatch(
            project.id,
            autoExpectedRevision,
            patch,
            async (nextProject) => {
              committedProject = nextProject;
              await writeProjectFile(target.path, nextProject);
            },
            durableRunId,
          );
          if (!committed.ok) {
            const problem = committed.issues
              ?.filter((issue) => issue.severity === 'error')
              .map((issue) => issue.message)
              .join('; ');
            const reason =
              committed.code === 'revision_conflict'
                ? 'The project changed and this edit overlaps newer work. Replan from the current revision.'
                : (problem ?? 'The proposed edit failed authoritative validation.');
            commitLedger.record(patch.patchId, { state: 'stale', reason });
            await runGatewayCoordinator.recordPatchLifecycle({
              runId: durableRunId,
              projectId: project.id,
              patchId: patch.patchId,
              state: 'stale',
              ...(committed.currentRevision === undefined ? {} : { projectRevision: committed.currentRevision }),
              reason,
            });
            const staleEvent = {
              ...transportEvent,
              commit: {
                state: 'stale' as const,
                ...(committed.currentRevision === undefined ? {} : { revision: committed.currentRevision }),
                reason,
              },
            };
            const durableEvent = await runGatewayCoordinator.recordStreamEvent({
              runId: durableRunId,
              projectId: project.id,
              event: ai.toJsonValue(staleEvent),
            });
            aiStreamHub.failDurable(durableRunId);
            return { event: staleEvent, durableSequence: durableEvent.sequence };
          }
          commitLedger.record(patch.patchId, { state: 'committed', revision: committed.revision });
          autoExpectedRevision = committed.revision;
          autoCommitted = true;
          await runGatewayCoordinator.recordPatchLifecycle({
            runId: durableRunId,
            projectId: project.id,
            patchId: patch.patchId,
            state: committed.rebased ? 'rebased' : 'committed',
            projectRevision: committed.revision,
          });
          let finalRevision = committed.revision;
          if (committedProject) {
            const withMemory = recordAutoAcceptedMemory(committedProject, patch);
            const memoryWrite = await projectCommands.write(withMemory, committed.revision, async () => {
              await writeProjectFile(target.path, withMemory);
            });
            if (memoryWrite.ok) {
              finalRevision = memoryWrite.revision;
              autoExpectedRevision = memoryWrite.revision;
            } else {
              say('AI memory write for an auto-applied accept failed; the edit stands', { patchId: patch.patchId });
            }
          }
          indexProjectBrain(project.id, target.path);
          projectChangedPushes += 1;
          const committedEvent = {
            ...transportEvent,
            commit: { state: 'committed' as const, revision: finalRevision, rebased: committed.rebased },
          };
          const durableEvent = await runGatewayCoordinator.recordStreamEvent({
            runId: durableRunId,
            projectId: project.id,
            event: ai.toJsonValue(committedEvent),
          });
          return { event: committedEvent, durableSequence: durableEvent.sequence };
        }
      }
      if (transportEvent.type === 'diff') {
        const patchId = transportEvent.edit.patch.patchId;
        if (commitLedger.outcomeFor(patchId) === undefined) commitLedger.record(patchId, { state: 'deferred' });
      }
      const durableEvent = await runGatewayCoordinator.recordStreamEvent({
        runId: durableRunId,
        projectId: project.id,
        event: ai.toJsonValue(transportEvent),
      });
      return { event: transportEvent, durableSequence: durableEvent.sequence };
    },
    onSettled: async (settlement) => {
      await Promise.all(lifecycleWrites);
      durableControls.close();
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
      settle(settlement);
    },
  });

  await streamFinished;
  const settlement = await settled;
  enrolmentShutdown.abort();
  runIpcHub.close();

  // AiSidebar: a run that THROWS (not an in-stream error) gets a failure card + failed status.
  if (terminal.error !== undefined) {
    conversation = appendEvents(conversation, [
      turnEmitter.error(terminal.error, { retryable: true }),
      turnEmitter.status('failed'),
    ]);
  }

  // ---- outputs -----------------------------------------------------------------------------
  const finalProject = await readProjectFile(scratchProjectPath);
  writeFileSync(path.join(OUT, 'final-project.fp.json'), serializeProject(finalProject));
  writeFileSync(path.join(OUT, 'conversation.json'), JSON.stringify(conversation));
  writeFileSync(path.join(OUT, 'run.md'), toMarkdown(conversation));
  const summary = summarize(published as unknown as Record<string, unknown>[], {
    settlement,
    terminal,
    asks,
    projectChangedPushes,
    conversationId,
    turnId,
    durableRunId,
    provider,
    model: aiConfig.resolveConfig(provider).model,
    agentOptions,
    finalRevision: projectCommands.revision(project.id),
  });
  writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  say('run finished', {
    status: summary.finalStatus,
    wallSeconds: summary.wallSeconds,
    diffs: summary.diffs.length,
    operations: summary.operationsApplied,
    modelCalls: summary.usage?.modelCalls,
  });
}

/** `--history`: an `AiMessage[]` JSON, or a saved conversation (projected like the sidebar). */
async function loadHistory(file: string | undefined): Promise<{ role: string; content: string }[]> {
  if (file === undefined) return [];
  const parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as unknown;
  if (Array.isArray(parsed)) return parsed as { role: string; content: string }[];
  const events = (parsed as { events?: unknown[] }).events;
  if (!Array.isArray(events)) throw new Error('--history must be an AiMessage[] or a conversation JSON.');
  // `historyFromEvents` (apps/web-editor/src/editor/ai.ts): per turn, the user's message and
  // the LAST assistant message. Re-stated here because that module pulls the browser bridge.
  const messages: { role: string; content: string }[] = [];
  const assistantAt = new Map<string, number>();
  for (const raw of events) {
    const event = raw as { type?: string; text?: string; turnId?: string };
    if (event.type === 'user_message' && event.text?.trim()) messages.push({ role: 'user', content: event.text });
    else if (event.type === 'assistant_message' && event.text?.trim() && event.turnId) {
      const at = assistantAt.get(event.turnId);
      if (at === undefined) {
        assistantAt.set(event.turnId, messages.length);
        messages.push({ role: 'assistant', content: event.text });
      } else messages[at] = { role: 'assistant', content: event.text };
    }
  }
  return messages;
}

interface SummaryContext {
  readonly settlement: unknown;
  readonly terminal: { error?: string; done?: boolean };
  readonly asks: readonly unknown[];
  readonly projectChangedPushes: number;
  readonly conversationId: string;
  readonly turnId: string;
  readonly durableRunId: string;
  readonly provider: string;
  readonly model: string | undefined;
  readonly agentOptions: unknown;
  readonly finalRevision: number | undefined;
}

/** What happened, counted from the published events (the same stream the sidebar renders). */
function summarize(events: readonly Record<string, unknown>[] & readonly unknown[], context: SummaryContext) {
  const list = events as unknown as ({ type: string; ts: number; id: string } & Record<string, unknown>)[];
  const toolCalls = new Map<string, { name: string; status: string; runtimeMs?: number }>();
  for (const event of list.filter((candidate) => candidate.type === 'tool_call')) {
    toolCalls.set(event.id, {
      name: String(event['toolName']),
      status: String(event['status']),
      ...(typeof event['runtimeMs'] === 'number' ? { runtimeMs: event['runtimeMs'] } : {}),
    });
  }
  const byName: Record<string, Record<string, number>> = {};
  for (const call of toolCalls.values()) {
    byName[call.name] ??= {};
    const counts = byName[call.name]!;
    counts[call.status] = (counts[call.status] ?? 0) + 1;
  }
  const diffs = list
    .filter((event) => event.type === 'diff')
    .map((event) => {
      const edit = event['edit'] as { patch: { patchId: string; operations: { type: string }[] } };
      return {
        patchId: edit.patch.patchId,
        operations: edit.patch.operations.length,
        operationTypes: edit.patch.operations.reduce<Record<string, number>>((counts, op) => {
          counts[op.type] = (counts[op.type] ?? 0) + 1;
          return counts;
        }, {}),
        commit: event['commit'],
      };
    });
  const committed = diffs.filter((diff) => (diff.commit as { state?: string } | undefined)?.state === 'committed');
  const usageEvents = list.filter((event) => event.type === 'usage');
  const lastUsage = usageEvents.at(-1);
  const statuses = list.filter((event) => event.type === 'status').map((event) => String(event['status']));
  const assistantMessages = list
    .filter((event) => event.type === 'assistant_message')
    .map((event) => String(event['text']));
  const first = list[0]?.ts ?? startedAt;
  const last = list.at(-1)?.ts ?? Date.now();
  return {
    conversationId: context.conversationId,
    turnId: context.turnId,
    durableRunId: context.durableRunId,
    provider: context.provider,
    model: context.model,
    agentOptions: context.agentOptions,
    finalStatus:
      context.terminal.error !== undefined
        ? 'failed'
        : ([...statuses].reverse().find((status) => ['completed', 'failed', 'cancelled'].includes(status)) ??
          'unknown'),
    settlement: context.settlement,
    streamError: context.terminal.error,
    watchdog: watchdogReason ?? null,
    wallSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    runSeconds: Math.round((last - first) / 100) / 10,
    peakTreeRssGb: Math.round((peakTreeRssBytes / 1024 ** 3) * 100) / 100,
    statusSequence: statuses,
    usage: lastUsage
      ? { tokens: lastUsage['tokens'], usd: lastUsage['usd'], modelCalls: lastUsage['modelCalls'] }
      : null,
    contextUsageEvents: list.filter((event) => event.type === 'context_usage').length,
    toolCalls: { total: toolCalls.size, byName },
    diffs,
    steps: committed.length,
    operationsApplied: committed.reduce((sum, diff) => sum + diff.operations, 0),
    timelineActions: list.filter((event) => event.type === 'timeline_action').length,
    finalProjectRevision: context.finalRevision ?? null,
    projectChangedPushes: context.projectChangedPushes,
    notices: list
      .filter((event) => event.type === 'notification')
      .map((event) => ({ text: event['text'], reason: event['reason'] })),
    errors: list
      .filter((event) => event.type === 'error')
      .map((event) => ({ message: event['message'], detail: event['detail'] })),
    asks: context.asks,
    lastAssistantMessages: assistantMessages.slice(-2),
    eventCounts: list.reduce<Record<string, number>>((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

try {
  await main();
} catch (error) {
  say('HARNESS FAILED', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 1;
} finally {
  stopSidecar(sidecar);
  // The provider's warm `claude` child and any sidecar worker must not outlive the harness.
  setTimeout(() => {
    killTree('SIGKILL');
    process.exit(process.exitCode ?? 0);
  }, 3_000).unref();
}
