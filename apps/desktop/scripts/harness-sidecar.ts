/**
 * The engine sidecar the headless scripts start for themselves (`agent-run.ts`,
 * `import-project.ts`), spawned the way `electron/sidecar/spawn.ts` does it in dev: its own
 * process group, the parent pid, the repo `.env` already merged into `process.env`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';

/** A cold `uv run` can resolve the environment before it serves; three minutes covers it. */
const SIDECAR_BOOT_TIMEOUT_MS = 180_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const HEALTH_POLL_MS = 1_000;

export interface HarnessSidecarOptions {
  readonly repoRoot: string;
  readonly port: number;
  /** `FRAMEPILOT_PROJECTS_ROOT`: the only tree the engine may read or write. */
  readonly projectsRoot: string;
  readonly logPath: string;
  readonly onHealthy?: (info: { readonly pid: number | undefined; readonly url: string }) => void;
}

export function engineBaseUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

async function isEngineUp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start the sidecar and wait until it answers `/health`.
 *
 * @throws When something already answers on the port, the process exits, or it never
 *   becomes healthy.
 */
export async function startHarnessSidecar(options: HarnessSidecarOptions): Promise<ChildProcess> {
  const baseUrl = engineBaseUrl(options.port);
  if (await isEngineUp(baseUrl)) {
    throw new Error(`Something already answers on ${baseUrl}; pick another --port.`);
  }
  const logFd = openSync(options.logPath, 'a');
  const child = spawn(
    'uv',
    ['run', 'framepilot', 'serve', '--host', '127.0.0.1', '--port', String(options.port)],
    {
      cwd: path.join(options.repoRoot, 'engine/python'),
      env: {
        ...process.env,
        FRAMEPILOT_PROJECTS_ROOT: options.projectsRoot,
        ...(process.env.FRAMEPILOT_PARENT_PID
          ? {}
          : { FRAMEPILOT_PARENT_PID: String(process.pid) }),
      },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    },
  );
  const deadline = Date.now() + SIDECAR_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Sidecar exited with ${String(child.exitCode)}; see ${options.logPath}.`);
    }
    if (await isEngineUp(baseUrl)) {
      options.onHealthy?.({ pid: child.pid, url: baseUrl });
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`Sidecar did not become healthy in time; see ${options.logPath}.`);
}

/** Stop the sidecar's whole process group. Safe to call twice. */
export function stopHarnessSidecar(child: ChildProcess | undefined): void {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
