import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..', '..');
export const DESKTOP_DIR = join(REPO, 'apps', 'desktop');
export const FIXTURE_PROJECTS = join(REPO, 'tests', 'fixtures', 'mission', 'projects');

const require = createRequire(join(DESKTOP_DIR, 'package.json'));

export interface DesktopSession {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userDataDir: string;
  readonly sidecarPort: number;
  readonly mainPid: number;
}

export interface LaunchOptions {
  /** Fixture project id under tests/fixtures/mission/projects to open from the launch screen. */
  readonly projectId?: string;
  /** Sidecar port for this app instance (each instance spawns its own sidecar). */
  readonly sidecarPort?: number;
  readonly projectsRoot?: string;
  readonly extraEnv?: Record<string, string>;
  /**
   * Reuse an existing user-data dir instead of a throwaway one. This is how a relaunch is
   * tested: the second launch must see exactly what the crashed first launch left behind.
   */
  readonly userDataDir?: string;
}

/**
 * Launch the unpackaged desktop app the way `pnpm dev` does (renderer from Vite at :5173,
 * its own sidecar spawned via `uv run` in engine/python), against the mission fixtures as
 * the sandboxed projects root, with a throwaway user-data dir seeded so the fixture project
 * appears under Recent on the launch screen.
 */
/**
 * Configure the app's model provider the way a user would, before it starts.
 *
 * The desktop app reads its provider from `ai-config.json` in the app data dir and
 * defaults to `nvidia`; `FRAMEPILOT_AI_PROVIDER` is not consulted for the active
 * choice. So every AI e2e row launched with a mission provider in the environment
 * was still talking to whatever the default was — the failing runs reported
 * `nvidia API error 410` while the environment said `openai-compatible`. Seeding the
 * file is what "configured with a provider" actually means for this app.
 *
 * Does nothing when no provider is configured in the environment: the rows that need
 * one are gated on MISSION_AI anyway, and a fresh user-data dir with no file is the
 * right state for every other row.
 */
function seedProviderConfig(userDataDir: string, overrides: Record<string, string>): void {
  // `overrides` first: a row that puts a proxy in front of the provider passes the
  // proxy's URL as extraEnv, and seeding the real endpoint here would route straight
  // past it — the row would then test the provider being healthy.
  const env = { ...process.env, ...overrides };
  const baseUrl = env['FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL'];
  const apiKey = env['FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY'];
  const model = env['FRAMEPILOT_OPENAI_COMPATIBLE_MODEL'];
  if (!baseUrl || !apiKey) return;
  writeFileSync(
    join(userDataDir, 'ai-config.json'),
    JSON.stringify({
      activeProvider: 'openai-compatible',
      'openai-compatible': { baseUrl, apiKey, ...(model ? { model } : {}) },
    }),
  );
}

/**
 * Wait for `port` to be free, and say who is holding it when it never is.
 *
 * Each row gives its app instance its own sidecar port. When a previous row's app was
 * killed (or leaked), its engine could still be bound to that port, and the app launched
 * here then spends its whole restart budget failing to bind — with the visible symptom
 * that the project never opens. Every assertion after that describes a squatted port
 * rather than the product, so this fails first, with the pid to kill.
 */
async function awaitFreePort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let holder = '';
    try {
      holder = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return; // lsof exits non-zero when nothing is listening: the port is free.
    }
    if (!holder) return;
    if (Date.now() > deadline) {
      throw new Error(
        `sidecar port ${String(port)} is still held after ${String(timeoutMs / 1000)}s, so the ` +
          `app launched here cannot start its engine and the project will never open:\n${holder}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * Click a project in Recent until the editor is actually up.
 *
 * The retry is not padding. The launch screen renders its Recent list from the on-disk
 * file and then re-renders it once the main process has answered about each entry, which
 * REPLACES the button node. A click that lands in that window hits an element React has
 * already discarded: Playwright reports a successful click, no error appears anywhere,
 * and the app simply stays on the launch screen — every later assertion in the row then
 * describes a project that was never opened. (Measured: clicking immediately after
 * `domcontentloaded` left the launch screen up for 60 s; a 3 s settle opened it in 2 s.)
 *
 * A broken open still fails this: the loop asserts the editor, not the click.
 */
async function openFromRecents(page: Page, projectId: string, attempts = 3): Promise<void> {
  const timeline = page.locator('section[aria-label="timeline"]');
  const card = recentProjectCard(page, projectId);
  for (let attempt = 1; ; attempt++) {
    // Wait for the card before clicking. The Recent list is read from disk on every
    // render, so straight after a reload it is briefly empty and a click that does not
    // wait fails on "no such button" rather than retrying.
    await card.waitFor({ state: 'visible', timeout: attempt === attempts ? 60_000 : 20_000 });
    await card.click();
    try {
      await expect(timeline).toBeVisible({ timeout: attempt === attempts ? 60_000 : 20_000 });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}

/**
 * The Recent-projects card for a project, matched by id OR by the name it displays.
 *
 * The list is seeded with `name: <projectId>` before launch, so the first open matches
 * on the id. Opening it makes the app rewrite that entry with the project's OWN name —
 * "Mission montage (raw camera + b-roll + music)" — so after a reload the card no longer
 * says the id at all, and a row that reopens a project waited out its timeout looking for
 * a label that only existed before the app had been told what the project is called.
 * Matching either is what the user sees: one card for one project, however it is
 * currently labelled.
 */
function recentProjectCard(page: Page, projectId: string): Locator {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let displayName = projectId;
  try {
    const raw = readFileSync(join(FIXTURE_PROJECTS, `${projectId}.fp.json`), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name !== '') displayName = parsed.name;
  } catch {
    // No fixture to read: fall back to the id, which is what a fresh seed uses.
  }
  return page
    .getByRole('button', { name: new RegExp(`${escape(projectId)}|${escape(displayName)}`) })
    .first();
}

/** Open a project from the home screen's Recent list, retrying the on-disk read. */
export async function openRecentProject(page: Page, projectId: string): Promise<void> {
  await openFromRecents(page, projectId);
}

export async function launchDesktop(options: LaunchOptions = {}): Promise<DesktopSession> {
  const sidecarPort = options.sidecarPort ?? 8798;
  await awaitFreePort(sidecarPort);
  const projectsRoot = options.projectsRoot ?? FIXTURE_PROJECTS;
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'framepilot-e2e-desktop-'));
  if (options.projectId) {
    const projectPath = join(projectsRoot, `${options.projectId}.fp.json`);
    writeFileSync(
      join(userDataDir, 'recent-projects.json'),
      JSON.stringify([{ path: projectPath, name: options.projectId, openedAt: Date.now() }]),
    );
  }
  seedProviderConfig(userDataDir, options.extraEnv ?? {});
  const electronPath = require('electron') as unknown as string;
  const app = await electron.launch({
    executablePath: electronPath,
    args: [DESKTOP_DIR, `--user-data-dir=${userDataDir}`],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      FRAMEPILOT_PROJECTS_ROOT: projectsRoot,
      FRAMEPILOT_ENGINE_DIR: join(REPO, 'engine', 'python'),
      FRAMEPILOT_PYTHON_API_URL: `http://127.0.0.1:${sidecarPort}`,
      FRAMEPILOT_LOG_LEVEL: process.env.FRAMEPILOT_LOG_LEVEL ?? 'warn',
      FRAMEPILOT_LICENSE_DEV_BYPASS: '1',
      ...options.extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const mainPid = await app.evaluate(() => process.pid);
  if (options.projectId) {
    try {
      await openFromRecents(page, options.projectId);
      await expect(page.getByLabel('project name')).not.toBeEmpty();
    } catch (error) {
      // A launch that fails here must not leave the app running. It used to: the throw
      // escaped before any caller had a session to close in its `finally`, so the app and
      // its engine survived the run and squatted the port — which made the NEXT row fail
      // for a reason that had nothing to do with it.
      await app.close().catch(() => undefined);
      throw error;
    }
  }
  return { app, page, userDataDir, sidecarPort, mainPid };
}

/** Processes descended from `rootPid` (sidecar, ffmpeg, ffprobe, helpers), from `ps`. */
export function descendants(
  rootPid: number,
): { pid: number; rssMb: number; cpu: number; cmd: string }[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssMb: Number(m[3]) / 1024,
      cpu: Number(m[4]),
      cmd: m[5],
    }));
  const out: typeof rows = [];
  const frontier = [rootPid];
  while (frontier.length) {
    const p = frontier.pop()!;
    for (const r of rows)
      if (r.ppid === p) {
        out.push(r);
        frontier.push(r.pid);
      }
  }
  return out.map(({ pid, rssMb, cpu, cmd }) => ({
    pid,
    rssMb: Number(rssMb.toFixed(1)),
    cpu,
    cmd: (cmd ?? '').slice(0, 80),
  }));
}

export function openFileCount(pid: number): number {
  try {
    return (
      execFileSync('lsof', ['-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n').length - 2
    );
  } catch {
    return -1;
  }
}

export interface ResourceSnapshot {
  readonly label: string;
  readonly atMs: number;
  readonly main: { rssMb: number; heapUsedMb: number; externalMb: number; openFiles: number };
  readonly renderer: {
    jsHeapUsedMb: number;
    jsHeapTotalMb: number;
    nodes: number;
    listeners: number;
    documents: number;
    frames: number;
    layoutCount: number;
  };
  readonly children: ReturnType<typeof descendants>;
  readonly childRssMb: number;
  readonly ffmpegCount: number;
}

/** One resource sample across main, renderer and every child process. */
export async function snapshot(
  session: DesktopSession,
  label: string,
  startedAt: number,
): Promise<ResourceSnapshot> {
  const main = await session.app.evaluate(() => {
    const m = process.memoryUsage();
    return {
      rssMb: m.rss / 1048576,
      heapUsedMb: m.heapUsed / 1048576,
      externalMb: m.external / 1048576,
    };
  });
  const cdp = await session.page.context().newCDPSession(session.page);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const metric = (name: string) => metrics.find((x) => x.name === name)?.value ?? -1;
  const children = descendants(session.mainPid);
  return {
    label,
    atMs: Date.now() - startedAt,
    main: {
      rssMb: r1(main.rssMb),
      heapUsedMb: r1(main.heapUsedMb),
      externalMb: r1(main.externalMb),
      openFiles: openFileCount(session.mainPid),
    },
    renderer: {
      jsHeapUsedMb: r1(metric('JSHeapUsedSize') / 1048576),
      jsHeapTotalMb: r1(metric('JSHeapTotalSize') / 1048576),
      nodes: metric('Nodes'),
      listeners: metric('JSEventListeners'),
      documents: metric('Documents'),
      frames: metric('Frames'),
      layoutCount: metric('LayoutCount'),
    },
    children,
    childRssMb: r1(children.reduce((s, c) => s + c.rssMb, 0)),
    ffmpegCount: children.filter((c) => /ffmpeg|ffprobe/.test(c.cmd)).length,
  };
}

const r1 = (n: number): number => Number(n.toFixed(1));

/**
 * Replace the native Save-As modal with a cancel.
 *
 * A native dialog blocks the main process until a human dismisses it, so it cannot be
 * driven from a test. Cancelling is the honest stand-in rather than a fabricated path:
 * the finished render stays in the project's sandboxed `exports/` folder, and that is
 * exactly the path the export history entry and "Reveal in folder" then point at.
 */
export async function cancelNativeSaveDialog(session: DesktopSession): Promise<void> {
  await session.app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (async () => ({
      canceled: true,
      filePath: '',
    })) as typeof dialog.showSaveDialog;
  });
}

/**
 * Record what "Reveal in folder" hands to the OS, instead of opening Finder mid-run.
 *
 * @returns a reader for the paths `shell.showItemInFolder` has been called with.
 */
export async function recordReveals(session: DesktopSession): Promise<() => Promise<string[]>> {
  await session.app.evaluate(({ shell }) => {
    const sink = globalThis as unknown as { __fpReveals?: string[] };
    sink.__fpReveals = [];
    shell.showItemInFolder = (fullPath: string): void => {
      sink.__fpReveals?.push(fullPath);
    };
  });
  return () =>
    session.app.evaluate(
      () => ((globalThis as unknown as { __fpReveals?: string[] }).__fpReveals ?? []) as string[],
    );
}

export interface DialogExportChoice {
  /** Matched against the option label's start, so "1080p (upscaled …)" still hits. */
  readonly resolution?: string;
  readonly quality?: 'Low' | 'Recommended' | 'High';
  readonly container?: 'MP4' | 'MOV';
}

/** Pick one option from the editor's custom combobox (not a native `<select>`). */
/**
 * Pick an option from one of the dialog's selects.
 *
 * The COMBOBOX is inside the dialog; the OPTIONS are not. `Select` renders its
 * listbox through `createPortal` into `document.body` so a dropdown is never
 * clipped by an overflow-hidden panel, which puts the options outside the
 * dialog's subtree entirely. Searching for them within `scope` therefore times
 * out no matter how long it waits — the element is on the page, just not there.
 * The combobox is still scoped, so two dialogs cannot be confused.
 */
async function choose(scope: Locator, label: string, option: string): Promise<void> {
  const combobox = scope.getByRole('combobox', { name: label });
  await combobox.click();
  const pattern = new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  await combobox.page().getByRole('option', { name: pattern }).first().click();
}

/**
 * Run a real export through the export popover — the path the user actually takes —
 * and return the finished file's path as the app itself reports it in Recent exports.
 */
export async function exportThroughDialog(
  session: DesktopSession,
  choice: DialogExportChoice = {},
  timeoutMs = 20 * 60_000,
): Promise<string> {
  const { page } = session;
  await cancelNativeSaveDialog(session);
  await page.getByRole('button', { name: 'Export video' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video' });
  await expect(dialog).toBeVisible();
  if (choice.resolution) await choose(dialog, 'Resolution', choice.resolution);
  if (choice.quality) await choose(dialog, 'Quality', choice.quality);
  if (choice.container) await choose(dialog, 'Format', choice.container);
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();

  // The one live status line in the footer resolves to exactly one of these.
  await expect(dialog.getByText(/Exported\.|Saved to/).first()).toBeVisible({
    timeout: timeoutMs,
  });
  const path = await dialog.locator('.export-history-name').first().getAttribute('title');
  expect(path, 'a finished export should appear in Recent exports with its path').toBeTruthy();
  return path!;
}
