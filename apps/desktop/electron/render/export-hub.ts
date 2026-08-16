/**
 * Main-process async export lifecycle (H1.3b).
 *
 * `exportViaSidecar` (`./export-client.js`) is the pure core: given a base URL,
 * an `ExportRequest`, and a `signal`/`onProgress`, it submits the render and
 * polls the sidecar's job-status route until the job is terminal. `ExportHub`
 * owns the per-run bookkeeping so the renderer can watch progress and cancel a
 * specific export — the same shape as `AiStreamHub`
 * (`apps/desktop/electron/ai/ai-stream.ts`): unguessable ids, sender-scoped
 * cancel, and destroy-cleanup, mirrored here for full (non-preview) exports so
 * `main.ts` reads as one consistent pattern for every "long invoke, live
 * progress push, cancel-by-id" flow instead of inventing a second shape.
 */
import { randomUUID } from 'node:crypto';
import { exportViaSidecar, type RenderJobStatus } from './export-client.js';
import type { ExportRequest, ExportResult } from '../ipc/contract.js';

/** One push over the export-progress channel, scoped by `requestId`. */
export interface ExportProgressMessage {
  readonly requestId: string;
  /** Present once the sidecar has accepted the job (i.e. on every push here). */
  readonly jobId?: string;
  /** The most recently observed queue-level status. */
  readonly status?: RenderJobStatus;
  /** Set exactly once, on the terminal push. */
  readonly result?: ExportResult;
}

/** The minimal `WebContents` surface the hub needs (testable without Electron). */
export interface ExportSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, message: ExportProgressMessage): void;
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
}

interface HubOptions {
  /** The push channel name (`framepilot:render:export-progress`). */
  readonly progressChannel: string;
  /** Sidecar base URL resolver (a function so a re-resolved URL still works). */
  readonly baseUrl: () => string;
  /** Injectable `fetch` (Electron's `net`-backed fetch in production). */
  readonly fetchFn: typeof fetch;
  /** Id generator (injectable for tests); defaults to `randomUUID`. */
  readonly newId?: () => string;
  /** Poll interval override, threaded to `exportViaSidecar` (tests only). */
  readonly pollIntervalMs?: number;
  /** Injectable poll delay, threaded to `exportViaSidecar` (tests only). */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

interface ActiveExport {
  readonly controller: AbortController;
  /** The id of the `WebContents` that started the export — cancel is scoped to it. */
  readonly senderId: number;
}

/**
 * Manages the lifecycle of full (non-preview) exports: starts the submit+poll
 * loop, scopes progress + cancel by `requestId` AND owning sender, and
 * guarantees cleanup on completion, cancel, or sender destruction.
 */
export class ExportHub {
  private readonly runs = new Map<string, ActiveExport>();
  private readonly newId: () => string;

  public constructor(private readonly options: HubOptions) {
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Start an export for `sender`; returns the (possibly caller-supplied)
   * `requestId` immediately. `requestId` can be minted by the caller ahead of
   * time (e.g. so an early, pre-sidecar failure like a sandbox-path rejection
   * can still be reported over the same progress channel under one id).
   */
  public start(sender: ExportSender, req: ExportRequest, requestId: string = this.newId()): string {
    const controller = new AbortController();
    this.runs.set(requestId, { controller, senderId: sender.id });

    let lastJobId: string | undefined;
    let lastStatus: RenderJobStatus | undefined;
    const push = (message: {
      jobId?: string | undefined;
      status?: RenderJobStatus | undefined;
      result?: ExportResult | undefined;
    }): void => {
      if (message.jobId) lastJobId = message.jobId;
      if (message.status) lastStatus = message.status;
      if (!sender.isDestroyed()) {
        sender.send(this.options.progressChannel, {
          requestId,
          ...(message.jobId !== undefined ? { jobId: message.jobId } : {}),
          ...(message.status !== undefined ? { status: message.status } : {}),
          ...(message.result !== undefined ? { result: message.result } : {}),
        });
      }
    };
    const onDestroyed = (): void => controller.abort();
    sender.once('destroyed', onDestroyed);

    void (async () => {
      try {
        const result = await exportViaSidecar(this.options.baseUrl(), req, this.options.fetchFn, {
          signal: controller.signal,
          ...(this.options.pollIntervalMs !== undefined
            ? { pollIntervalMs: this.options.pollIntervalMs }
            : {}),
          ...(this.options.sleepFn ? { sleepFn: this.options.sleepFn } : {}),
          onProgress: (progress) => push({ jobId: progress.jobId, status: progress.status }),
        });
        push({ jobId: lastJobId, status: lastStatus, result });
      } catch (error) {
        push({
          jobId: lastJobId,
          status: 'failed',
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        sender.removeListener('destroyed', onDestroyed);
        this.runs.delete(requestId);
      }
    })();

    return requestId;
  }

  /**
   * Report an immediately-terminal failure without starting a sidecar submit
   * (e.g. a request that failed license/sandbox validation before it could be
   * sent) — still delivered over the same progress channel/shape as a normal
   * run, so the renderer needs only one code path.
   */
  public reportImmediateFailure(sender: ExportSender, requestId: string, result: ExportResult): void {
    if (!sender.isDestroyed()) {
      sender.send(this.options.progressChannel, { requestId, status: 'failed', result });
    }
  }

  /** Mint a fresh, unguessable request id (for the immediate-failure path above). */
  public mintId(): string {
    return this.newId();
  }

  /** Cancel a run — only if `sender` is the one that started it. */
  public cancel(sender: ExportSender, requestId: unknown): void {
    const run = this.runs.get(String(requestId));
    if (run && run.senderId === sender.id) run.controller.abort();
  }

  /** Abort every in-flight export (app shutdown). */
  public abortAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  /** Number of in-flight exports (diagnostics/tests). */
  public activeCount(): number {
    return this.runs.size;
  }
}
