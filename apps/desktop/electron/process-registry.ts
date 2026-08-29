/**
 * @framepilot/desktop/process-registry — one place that knows every child process
 * (plan/system-mission P5.3).
 *
 * ## Why this exists
 *
 * The app spawns real operating-system processes — the Python sidecar, and through it
 * ffmpeg and ffprobe — and until now each one was cleaned up by whichever module happened
 * to own it: `sidecar.stop()` on `will-quit`, `exportHub.abortAll()` on `before-quit`,
 * `killProcessGroup` inside the spawn helper. That works right up until a quit path is
 * added that forgets one, or a crash skips the handlers entirely, and then the user is
 * left with an ffmpeg holding four cores and a port that the next launch cannot bind.
 *
 * Two things follow from having a registry rather than N owners:
 *
 * - **Quit walks one list.** Adding a new kind of child cannot silently opt out of
 *   shutdown, because registering is how it becomes visible in the first place.
 * - **A crash is recoverable.** Every registered pid is written to a pidfile, so the NEXT
 *   launch can see what the previous one left behind and sweep it. Nothing else in the
 *   app can do that: the handlers that would have cleaned up did not run.
 *
 * Everything here takes its clock, its `kill`, and its file IO as arguments, so the
 * decisions are testable without spawning anything.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('desktop:process-registry');

/**
 * A child's lifecycle. `recovering` is distinct from `failed` on purpose: the sidecar
 * manager restarts an engine that dies mid-session (P5.5), and a reader of the registry
 * needs to tell "it is coming back" from "it is gone".
 */
export type ProcessState =
  | 'created'
  | 'ready'
  | 'running'
  | 'idle'
  | 'failed'
  | 'recovering'
  | 'terminated';

/** The states a child can no longer do work from. */
const FINAL_STATES: ReadonlySet<ProcessState> = new Set(['terminated']);

export interface ProcessEntry {
  readonly id: string;
  /** Which subsystem owns it — `sidecar`, `export`, `analysis`. */
  readonly owner: string;
  /** What it is for, in words a log reader can act on. */
  readonly purpose: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  /** How long it may run before shutdown considers it stuck; absent means no limit. */
  readonly timeoutMs?: number;
  readonly state: ProcessState;
}

export interface RegisterOptions {
  readonly owner: string;
  readonly purpose: string;
  readonly pid: number | undefined;
  readonly timeoutMs?: number;
  /** How to stop it. Defaults to killing its process group. */
  readonly cancel?: () => void;
}

/** File IO for the pidfile, injected so the registry can be tested without a disk. */
export interface PidFileIO {
  read(): string | null;
  write(contents: string): void;
  clear(): void;
}

export interface ProcessRegistryOptions {
  readonly now?: () => number;
  /** Stops one pid (and its group). Defaults to `killProcessGroup`. */
  readonly killGroup?: (pid: number | undefined) => void;
  /** True when a pid is still alive — `process.kill(pid, 0)` semantics. */
  readonly isAlive?: (pid: number) => boolean;
  readonly pidFile?: PidFileIO;
}

/** The pidfile's shape: one run's live children, so the next launch can sweep them. */
interface PidFileContents {
  readonly startedAt: number;
  readonly children: { readonly pid: number; readonly owner: string; readonly purpose: string }[];
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProcessRegistry {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly cancels = new Map<string, () => void>();
  private readonly now: () => number;
  private readonly killGroup: (pid: number | undefined) => void;
  private readonly isAlive: (pid: number) => boolean;
  private readonly pidFile: PidFileIO | undefined;
  private nextId = 1;

  public constructor(options: ProcessRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.killGroup = options.killGroup ?? (() => undefined);
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.pidFile = options.pidFile;
  }

  /** Every child currently known, in registration order. */
  public list(): readonly ProcessEntry[] {
    return [...this.entries.values()];
  }

  public get(id: string): ProcessEntry | undefined {
    return this.entries.get(id);
  }

  /** Track a freshly spawned child. Returns its registry id. */
  public register(options: RegisterOptions): string {
    const id = `proc_${String(this.nextId++)}`;
    this.entries.set(id, {
      id,
      owner: options.owner,
      purpose: options.purpose,
      pid: options.pid,
      startedAt: this.now(),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      state: 'created',
    });
    this.cancels.set(id, options.cancel ?? (() => this.killGroup(options.pid)));
    log.action('registered', {
      id,
      owner: options.owner,
      purpose: options.purpose,
      pid: options.pid,
    });
    this.persist();
    return id;
  }

  /** Move a child to a new state. Terminated is final — nothing moves out of it. */
  public setState(id: string, state: ProcessState): void {
    const entry = this.entries.get(id);
    if (!entry || FINAL_STATES.has(entry.state)) return;
    this.entries.set(id, { ...entry, state });
    if (FINAL_STATES.has(state)) this.cancels.delete(id);
    this.persist();
  }

  /** Stop one child and mark it terminated. Safe to call twice. */
  public terminate(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || FINAL_STATES.has(entry.state)) return;
    const cancel = this.cancels.get(id);
    try {
      cancel?.();
    } catch (error) {
      log.warn('cancel threw', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.cancels.delete(id);
    this.entries.set(id, { ...entry, state: 'terminated' });
    log.action('terminated', { id, owner: entry.owner, pid: entry.pid });
    this.persist();
  }

  /**
   * Stop everything. Called from `will-quit`; one child throwing must not stop the rest
   * from being cleaned up, which is the whole reason this loop does not use `map`.
   */
  public terminateAll(): void {
    for (const entry of [...this.entries.values()]) this.terminate(entry.id);
    this.pidFile?.clear();
  }

  /**
   * Kill anything the PREVIOUS run left behind, and return what was swept.
   *
   * Only pids recorded by this app are considered, and each is checked for liveness
   * first — a pid is reused by the OS eventually, and killing a stranger's process
   * because it inherited a number would be far worse than leaving an orphan.
   */
  public sweepOrphans(): readonly { pid: number; owner: string; purpose: string }[] {
    if (!this.pidFile) return [];
    const raw = this.pidFile.read();
    if (raw === null) return [];
    let parsed: PidFileContents;
    try {
      parsed = JSON.parse(raw) as PidFileContents;
    } catch {
      log.warn('pidfile unreadable; ignoring it');
      this.pidFile.clear();
      return [];
    }
    const children = Array.isArray(parsed.children) ? parsed.children : [];
    const swept: { pid: number; owner: string; purpose: string }[] = [];
    for (const child of children) {
      if (typeof child?.pid !== 'number' || !this.isAlive(child.pid)) continue;
      this.killGroup(child.pid);
      swept.push({ pid: child.pid, owner: String(child.owner), purpose: String(child.purpose) });
    }
    if (swept.length > 0) log.action('swept orphans from a previous run', { count: swept.length });
    this.pidFile.clear();
    return swept;
  }

  /** Children that have outlived their declared timeout. */
  public overdue(): readonly ProcessEntry[] {
    const at = this.now();
    return this.list().filter(
      (e) =>
        e.timeoutMs !== undefined && !FINAL_STATES.has(e.state) && at - e.startedAt > e.timeoutMs,
    );
  }

  private persist(): void {
    if (!this.pidFile) return;
    const contents: PidFileContents = {
      startedAt: this.now(),
      children: this.list()
        .filter((e) => !FINAL_STATES.has(e.state) && typeof e.pid === 'number')
        .map((e) => ({ pid: e.pid as number, owner: e.owner, purpose: e.purpose })),
    };
    try {
      this.pidFile.write(JSON.stringify(contents));
    } catch (error) {
      // A pidfile we cannot write costs us the next launch's sweep, nothing more.
      log.debug('could not write the pidfile', { error: String(error) });
    }
  }
}
