/**
 * Process-group control for pack workers (BR4.12 H1).
 *
 * WHY: a worker is untrusted native code. Killing only its pid leaves any children it started
 * running: they can keep writing into the staging directory after the host verified it, or hold
 * stdout open so the job never settles. On POSIX the worker is spawned `detached` (its own
 * process group, like the sidecar in `apps/desktop/electron/sidecar/spawn.ts`) and the whole group
 * is signalled with a negative pid.
 *
 * Windows: a Job Object with kill-on-close needs native code, and the app adds no native
 * dependency for this; `taskkill /T /F` ends the process tree instead. A descendant that
 * re-parents itself out of the tree before the kill is not covered there (recorded in ADR 0114).
 */
import { spawn } from 'node:child_process';

export type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface ProcessGroupDependencies {
  readonly kill?: SignalSender;
  readonly platform?: NodeJS.Platform;
  /** Windows tree kill; injectable for tests. */
  readonly killTree?: (pid: number) => void;
}

/** Spawn options that give the worker its own process group where the OS supports it. */
export function workerGroupSpawnOptions(platform: NodeJS.Platform = process.platform): { readonly detached: boolean } {
  return { detached: platform !== 'win32' };
}

/**
 * Kill the worker and everything in its group (POSIX) or tree (Windows). Never throws.
 *
 * @returns `group` when the group was signalled, `process` when only the pid was, `none`.
 */
export function killWorkerGroup(pid: number | undefined, dependencies: ProcessGroupDependencies = {}): 'group' | 'process' | 'none' {
  if (pid === undefined || pid <= 0) return 'none';
  const kill = dependencies.kill ?? ((target, signal) => process.kill(target, signal));
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    try {
      (dependencies.killTree ?? defaultKillTree)(pid);
      return 'group';
    } catch {
      // fall through to the process itself
    }
  } else {
    try {
      kill(-pid, 'SIGKILL');
      return 'group';
    } catch {
      // Not a group leader, or already gone: try the process itself.
    }
  }
  try {
    kill(pid, 'SIGKILL');
    return 'process';
  } catch {
    return 'none';
  }
}

/** Whether any process of the worker's group (POSIX) or the worker itself (Windows) is alive. */
export function isWorkerGroupAlive(pid: number | undefined, dependencies: ProcessGroupDependencies = {}): boolean {
  if (pid === undefined || pid <= 0) return false;
  const kill = dependencies.kill ?? ((target, signal) => process.kill(target, signal));
  const platform = dependencies.platform ?? process.platform;
  const probe = (target: number): boolean => {
    try {
      kill(target, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to someone else: still alive.
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
    }
  };
  return platform === 'win32' ? probe(pid) : probe(-pid) || probe(pid);
}

/**
 * Kill the group and wait until nothing in it is left.
 *
 * @returns true when the group is gone within `timeoutMs`.
 */
export async function ensureWorkerGroupGone(
  pid: number | undefined,
  timeoutMs = 2_000,
  dependencies: ProcessGroupDependencies = {},
): Promise<boolean> {
  if (!isWorkerGroupAlive(pid, dependencies)) return true;
  killWorkerGroup(pid, dependencies);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!isWorkerGroupAlive(pid, dependencies)) return true;
  }
  return !isWorkerGroupAlive(pid, dependencies);
}

function defaultKillTree(pid: number): void {
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => undefined);
}
