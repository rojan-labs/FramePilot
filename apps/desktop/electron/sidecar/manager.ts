/**
 * Python render sidecar lifecycle manager (PRD §9.2; plan Phase 3.1).
 *
 * The desktop shell owns the lifetime of the deterministic Python render engine
 * (the FastAPI service in `engine/python`). This module encapsulates the
 * spawn → health-poll → ready → shutdown state machine with **all** side effects
 * injected (process spawning, the HTTP health probe, and the retry delay), so it
 * is fully unit-testable and never imports `electron` or `child_process`
 * directly. `main.ts` wires the real implementations.
 *
 * WHY a health poll rather than "assume up": uvicorn binds its port
 * asynchronously, so the renderer must not issue render calls until `/health`
 * answers. We bound the wait (PRD §9 — renders must be reliable, not hang).
 */
import type { SidecarStatus } from '../ipc/contract.js';

/** A handle to the spawned sidecar process — the slice of it this module needs. */
export interface SidecarProcess {
  /** OS process id, when available. */
  readonly pid: number | undefined;
  /** Terminate the process (idempotent at the OS layer). */
  kill(): void;
  /** Register a listener fired once when the process exits. */
  onExit(listener: (code: number | null) => void): void;
  /**
   * Register a listener fired once if the process could not be spawned at all
   * (e.g. `ENOENT` because `uv` isn't on `PATH`). Node emits this as an async
   * `error` event rather than throwing, so without a listener it becomes an
   * uncaught exception that crashes the whole Electron main process.
   */
  onError(listener: (error: Error) => void): void;
}

/** Starts the sidecar process. Injected so tests need no real Python. */
export type SpawnSidecar = () => SidecarProcess;

/** Resolves true when the engine answers a health check at `baseUrl`. */
export type HealthProbe = (baseUrl: string) => Promise<boolean>;

/** Awaitable delay between health probes. Injected for deterministic tests. */
export type Sleep = (ms: number) => Promise<void>;

/** Configuration + injected effects for {@link SidecarManager}. */
export interface SidecarManagerOptions {
  spawn: SpawnSidecar;
  probe: HealthProbe;
  sleep?: Sleep;
  host?: string;
  port?: number;
  /** Total time to wait for the engine to become ready before failing. */
  startupTimeoutMs?: number;
  /** Delay between successive health probes. */
  probeIntervalMs?: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_INTERVAL_MS = 200;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns the Python sidecar process and exposes its current {@link SidecarStatus}.
 *
 * Lifecycle: `stopped → starting → ready`, or `→ failed` if the process exits or
 * the engine never answers within {@link SidecarManagerOptions.startupTimeoutMs}.
 */
export class SidecarManager {
  private readonly spawn: SpawnSidecar;
  private readonly probe: HealthProbe;
  private readonly sleep: Sleep;
  private readonly host: string;
  private readonly port: number;
  private readonly startupTimeoutMs: number;
  private readonly probeIntervalMs: number;

  private process: SidecarProcess | null = null;
  private phase: SidecarStatus['phase'] = 'stopped';
  private detail: string | null = null;
  /** Set when the process exits, so a startup poll can fail fast. */
  private exited = false;

  constructor(options: SidecarManagerOptions) {
    this.spawn = options.spawn;
    this.probe = options.probe;
    this.sleep = options.sleep ?? realSleep;
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  }

  /** The base URL the engine is reachable at once ready. */
  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** A snapshot of the current lifecycle state for {@link IpcChannels.sidecarStatus}. */
  get status(): SidecarStatus {
    return {
      phase: this.phase,
      baseUrl: this.phase === 'ready' ? this.baseUrl : null,
      detail: this.detail,
    };
  }

  /**
   * Spawn the sidecar (if not already running) and poll `/health` until it
   * answers or the startup budget is exhausted.
   *
   * @returns The terminal {@link SidecarStatus} (`ready` or `failed`). Calling
   *   `start` while already `ready`/`starting` is a no-op that returns the
   *   current status.
   */
  async start(): Promise<SidecarStatus> {
    if (this.phase === 'ready' || this.phase === 'starting') {
      return this.status;
    }

    this.phase = 'starting';
    this.detail = null;
    this.exited = false;
    const process = this.spawn();
    this.process = process;
    // `onExit`/`onError` fire asynchronously and this manager has no way to
    // unregister them, so a killed-but-not-yet-exited process's callback can
    // still land after stop()+start() has already installed a new process.
    // Guard by identity: only the still-current process may mutate state.
    process.onExit((code) => {
      if (this.process !== process) return;
      this.exited = true;
      // An exit while still starting/ready is a failure; an exit after an
      // intentional stop() has already moved us to 'stopped'.
      if (this.phase === 'starting' || this.phase === 'ready') {
        this.phase = 'failed';
        this.detail = `Sidecar process exited (code ${code ?? 'null'}).`;
      }
    });
    process.onError((error) => {
      if (this.process !== process) return;
      this.exited = true;
      if (this.phase === 'starting' || this.phase === 'ready') {
        this.phase = 'failed';
        this.detail = `Sidecar failed to start: ${error.message}`;
      }
    });

    return this.pollUntilReady();
  }

  /** Terminate the sidecar and return to `stopped`. Idempotent. */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.phase = 'stopped';
    this.detail = null;
  }

  /** Probe `/health` on a fixed cadence until ready, the process dies, or timeout. */
  private async pollUntilReady(): Promise<SidecarStatus> {
    const attempts = Math.max(1, Math.ceil(this.startupTimeoutMs / this.probeIntervalMs));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.exited) {
        return this.status; // onExit already set phase='failed' with detail.
      }
      if (await this.healthy()) {
        this.phase = 'ready';
        this.detail = null;
        return this.status;
      }
      await this.sleep(this.probeIntervalMs);
    }

    this.fail(`Sidecar did not become ready within ${this.startupTimeoutMs}ms.`);
    return this.status;
  }

  /** True if the engine answers a health check; a thrown probe counts as not-ready. */
  private async healthy(): Promise<boolean> {
    try {
      return await this.probe(this.baseUrl);
    } catch {
      return false;
    }
  }

  /** Move to `failed`, recording why, and tear down any live process. */
  private fail(detail: string): void {
    this.phase = 'failed';
    this.detail = detail;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
