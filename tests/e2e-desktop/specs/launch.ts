import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
export async function launchDesktop(options: LaunchOptions = {}): Promise<DesktopSession> {
  const sidecarPort = options.sidecarPort ?? 8798;
  const projectsRoot = options.projectsRoot ?? FIXTURE_PROJECTS;
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'framepilot-e2e-desktop-'));
  if (options.projectId) {
    const projectPath = join(projectsRoot, `${options.projectId}.fp.json`);
    writeFileSync(
      join(userDataDir, 'recent-projects.json'),
      JSON.stringify([{ path: projectPath, name: options.projectId, openedAt: Date.now() }]),
    );
  }
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
    await page.getByRole('button', { name: options.projectId }).first().click();
    await expect(page.locator('section[aria-label="timeline"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('project name')).not.toBeEmpty();
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
