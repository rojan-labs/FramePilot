/**
 * Host watchdog for a running pack worker (BR4.12 H2, audit P17).
 *
 * A worker decodes untrusted media with native code, so the host bounds what one job may take
 * and ends it (the whole process group) when it takes more:
 *
 * - **Memory:** physical footprint of the worker's process group ≤ min(pack limit, 0.6 × RAM).
 *   Metric by platform, documented because they differ:
 *   - macOS: `top -l 1 -stats pid,mem` over every pid of the group (`ps -o pid= -g <pgid>`).
 *     `mem` is the physical footprint, which includes compressed and GPU-wired memory that RSS
 *     misses (BR0-FINDINGS memory incident 3: RSS read 4.6 GiB at a 16 GB footprint).
 *   - Linux: summed RSS of the group (`ps -o rss= -g <pgid>`).
 *   - Windows: working set of the worker process (`tasklist /FI "PID eq <pid>" /FO CSV /NH`);
 *     a Job Object memory limit needs native code (recorded in ADR 0114).
 * - **Stalled progress:** no progress message for 5 minutes.
 * - **Staging size:** bytes in the job's staging directory ≤ min(byte ceiling, free space at
 *   start − 1 GB), polled while the job runs rather than only checked afterwards.
 *
 * A breach calls `onBreach` once with its kind; the caller kills the group and reports
 * `resource_exhausted`. A sample the platform cannot take is skipped, never treated as a breach.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('desktop:capability-packs:worker-watchdog');

export type WatchdogBreach = 'memory' | 'stalled' | 'disk';

export const WATCHDOG_RAM_SHARE = 0.6;
export const WATCHDOG_STALL_MS = 5 * 60 * 1_000;
export const WATCHDOG_DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
export const WATCHDOG_INTERVAL_MS = 2_000;
/**
 * Per-pack memory limits. The release schema has no field for it yet, so the limit is declared
 * here, next to the host that runs the pack. Smart Mask: the 8 GB footprint cap BR0 measured with.
 */
export const PACK_MEMORY_LIMIT_BYTES: Readonly<Record<string, number>> = {
  'framepilot.smart-mask': 8 * 1024 * 1024 * 1024,
};

export interface WatchdogLimits {
  readonly memoryBytes: number;
  readonly stallMs: number;
  readonly stagingBytes: number;
}

export interface WatchdogProbes {
  /** Physical footprint of the process group, or `undefined` when it cannot be measured. */
  readonly footprintBytes: (pid: number) => Promise<number | undefined>;
  readonly directoryBytes: (directory: string) => Promise<number>;
  readonly now: () => number;
}

export function watchdogLimits(options: {
  readonly packId: string;
  readonly totalMemoryBytes: number;
  readonly byteCeiling: number;
  readonly freeBytesAtStart: number;
  readonly stallMs?: number;
}): WatchdogLimits {
  const packLimit = PACK_MEMORY_LIMIT_BYTES[options.packId] ?? Number.POSITIVE_INFINITY;
  return {
    memoryBytes: Math.min(packLimit, Math.floor(WATCHDOG_RAM_SHARE * options.totalMemoryBytes)),
    stallMs: options.stallMs ?? WATCHDOG_STALL_MS,
    stagingBytes: Math.max(0, Math.min(options.byteCeiling, options.freeBytesAtStart - WATCHDOG_DISK_RESERVE_BYTES)),
  };
}

export class WorkerWatchdog {
  private pid: number | undefined;
  private lastProgress: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private breached: WatchdogBreach | undefined;

  public constructor(
    private readonly limits: WatchdogLimits,
    private readonly probes: WatchdogProbes,
    private readonly options: {
      readonly stagingDirectory: string;
      readonly intervalMs?: number;
      readonly onBreach: (breach: WatchdogBreach) => void;
    },
  ) {
    this.lastProgress = probes.now();
  }

  public get breach(): WatchdogBreach | undefined {
    return this.breached;
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? WATCHDOG_INTERVAL_MS);
  }

  public attach(pid: number): void {
    this.pid = pid;
  }

  public progress(): void {
    this.lastProgress = this.probes.now();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sample. Public for tests; the interval calls it. */
  public async tick(): Promise<void> {
    if (this.ticking || this.breached !== undefined) return;
    this.ticking = true;
    try {
      if (this.probes.now() - this.lastProgress > this.limits.stallMs) return this.trip('stalled');
      const staged = await this.probes.directoryBytes(this.options.stagingDirectory).catch(() => 0);
      if (staged > this.limits.stagingBytes) return this.trip('disk');
      if (this.pid !== undefined) {
        const footprint = await this.probes.footprintBytes(this.pid).catch(() => undefined);
        if (footprint !== undefined && footprint > this.limits.memoryBytes) return this.trip('memory');
      }
    } finally {
      this.ticking = false;
    }
  }

  private trip(breach: WatchdogBreach): void {
    if (this.breached !== undefined) return;
    this.breached = breach;
    this.stop();
    log.action('workerWatchdogBreach', { breach });
    this.options.onBreach(breach);
  }
}

/** Bytes under a directory, never following links. */
export async function stagingBytes(directory: string): Promise<number> {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of await readdir(current).catch(() => [] as string[])) pending.push(path.join(current, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

type Exec = (file: string, args: readonly string[]) => Promise<string>;

const execText: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );
  });

/** The platform footprint sampler described at the top of this file. */
export function processGroupFootprint(
  platform: NodeJS.Platform = process.platform,
  exec: Exec = execText,
): (pid: number) => Promise<number | undefined> {
  return async (pid) => {
    if (platform === 'win32') {
      const line = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const match = /"([\d.,\s]+)\s*K"\s*$/mu.exec(line.trim());
      return match === null ? undefined : Number(match[1]!.replace(/[^\d]/gu, '')) * 1024;
    }
    const pids = (await exec('ps', ['-o', 'pid=', '-g', String(pid)]))
      .split(/\s+/u)
      .filter((value) => /^\d+$/u.test(value));
    if (pids.length === 0) return undefined;
    if (platform === 'darwin') {
      const args = ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((value) => ['-pid', value])];
      return parseTopMem(await exec('top', args), new Set(pids));
    }
    const rss = await exec('ps', ['-o', 'rss=', '-g', String(pid)]);
    return rss.split(/\s+/u).filter((value) => /^\d+$/u.test(value)).reduce((sum, kb) => sum + Number(kb) * 1024, 0);
  };
}

/** Sum the `mem` column of `top -l 1 -stats pid,mem` rows for `pids` ("123M", "1.2G", "512K", "40B"). */
export function parseTopMem(output: string, pids: ReadonlySet<string>): number | undefined {
  const units: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  let total = 0;
  let found = false;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/u.exec(line);
    if (match === null || !pids.has(match[1]!)) continue;
    total += Number(match[2]) * units[match[3]!]!;
    found = true;
  }
  return found ? Math.round(total) : undefined;
}
