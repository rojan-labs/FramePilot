/**
 * A warm Capability Pack worker for interactive `subject.segment_frame` (BR6.11, plan 03).
 *
 * Hover highlight asks "what object is under the pointer" many times a second. Spawning a worker
 * per request would reload the SAM graphs (seconds) every time, so the host keeps ONE process
 * alive in `--framepilot-worker-warm` mode, which caches each frame's image embedding (BR3.13).
 * Everything the one-shot client guarantees still holds per request:
 *
 * - the request is parsed with the frozen worker schema, and only `subject.segment_frame` is
 *   accepted (it has no write handle; nothing this session sends can make the worker write);
 * - the media path is realpath-checked against the approved project root on EVERY request;
 * - the environment is the scrubbed one, and the process runs in its own group;
 * - an output line over the bound, malformed JSON, a handshake, a mismatched request id,
 *   revision or capability, or a second terminal line kills the process;
 * - an abort sends the typed cancel and kills the process if no terminal line follows.
 *
 * Requests run one at a time. The process is ended after `idleMs` without a request, so the
 * multi-gigabyte model is not resident while nobody is hovering.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger, maskingEventPayload } from '@framepilot/shared-types';
import {
  CAPABILITY_PACK_WORKER_MAX_LINE_BYTES,
  CapabilityPackWorkerCancelSchema,
  CapabilityPackWorkerFailureSchema,
  CapabilityPackWorkerOutputSchema,
  CapabilityPackWorkerRequestSchema,
  CapabilityPackWorkerResultSchema,
  type CapabilityPackWorkerRequest,
  type CapabilityPackWorkerResult,
} from '../worker-protocol.js';
import { killWorkerGroup } from './process-group.js';
import {
  assertMediaInsideRoot,
  CapabilityPackWorkerRuntimeError,
  defaultLauncher,
  safeRuntimeEnvironment,
  type CapabilityPackWorkerLauncher,
} from './worker-client.js';

const log = createLogger('capability-packs:warm-worker');
/** Without a request for this long, the warm process is ended (its models are gigabytes). */
export const WARM_WORKER_DEFAULT_IDLE_MS = 60_000;
/** The first request loads the graphs and encodes a frame; later ones take milliseconds. */
export const WARM_WORKER_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** How long an aborted request may take to answer its cancel before the process is killed. */
const CANCEL_GRACE_MS = 1_000;
const WARM_FLAG = '--framepilot-worker-warm';

export type SegmentFrameWorkerResult = Extract<
  CapabilityPackWorkerResult,
  { readonly capability: 'subject.segment_frame' }
>;

export interface CapabilityPackWarmWorkerOptions {
  readonly entrypoint: string;
  /** FRAMEPILOT_-prefixed extras (e.g. `FRAMEPILOT_CAPABILITY_PACK_ROOT`), merged after the scrub. */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly launch?: CapabilityPackWorkerLauncher;
  readonly idleMs?: number;
  readonly requestTimeoutMs?: number;
  /** The worker's pid (its process group on POSIX), for a host watchdog. */
  readonly onSpawn?: (pid: number) => void;
}

interface Pending {
  readonly request: CapabilityPackWorkerRequest;
  readonly resolve: (result: SegmentFrameWorkerResult) => void;
  readonly reject: (error: unknown) => void;
}

export class CapabilityPackWarmWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending | undefined;
  private buffer = Buffer.alloc(0);
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Request ids whose cancel we sent; their late `cancelled` failure line is expected. */
  private readonly cancelled = new Set<string>();

  public constructor(private readonly options: CapabilityPackWarmWorkerOptions) {}

  /** Whether a warm process is alive right now. */
  public get running(): boolean {
    return this.child !== undefined;
  }

  /**
   * Segment one frame. Requests are queued and answered in order; an aborted request that has
   * not started never reaches the worker.
   */
  public segmentFrame(options: {
    readonly request: CapabilityPackWorkerRequest;
    readonly mediaRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<SegmentFrameWorkerResult> {
    const run = this.tail.then(
      () => this.runOne(options),
      () => this.runOne(options),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** End the warm process now (app quit, pack removed, project closed). */
  public close(): void {
    this.clearIdle();
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.failPending(
      new CapabilityPackWorkerRuntimeError('cancelled', 'The interactive worker was closed.'),
    );
    try {
      child.stdin.end();
    } catch {
      // already gone
    }
    killWorkerGroup(child.pid);
    child.kill('SIGKILL');
  }

  private async runOne(options: {
    readonly request: CapabilityPackWorkerRequest;
    readonly mediaRoot: string;
    readonly signal?: AbortSignal;
  }): Promise<SegmentFrameWorkerResult> {
    const request = CapabilityPackWorkerRequestSchema.parse(options.request);
    if (request.capability !== 'subject.segment_frame') {
      throw new CapabilityPackWorkerRuntimeError(
        'protocol_error',
        'The warm worker serves subject.segment_frame only.',
      );
    }
    if (options.signal?.aborted === true) {
      throw new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.');
    }
    await assertMediaInsideRoot(options.mediaRoot, request.media.absolutePath);
    this.clearIdle();
    const child = this.ensureProcess();
    return await new Promise<SegmentFrameWorkerResult>((resolve, reject) => {
      let settled = false;
      let cancelKill: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        this.kill('timed out');
        settle(
          new CapabilityPackWorkerRuntimeError(
            'timed_out',
            `The interactive worker did not answer within ${String(this.requestTimeoutMs())}ms.`,
          ),
        );
      }, this.requestTimeoutMs());
      const onAbort = (): void => {
        this.cancelled.add(request.requestId);
        try {
          const cancel = CapabilityPackWorkerCancelSchema.parse({
            type: 'cancel',
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
          });
          child.stdin.write(`${JSON.stringify(cancel)}\n`);
        } catch {
          // stdin closed: the exit handler settles
        }
        cancelKill = setTimeout(() => {
          this.kill('cancel not answered');
          settle(
            new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.'),
          );
        }, CANCEL_GRACE_MS);
      };
      const settle = (error?: unknown, result?: SegmentFrameWorkerResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancelKill !== undefined) clearTimeout(cancelKill);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.pending?.request.requestId === request.requestId) this.pending = undefined;
        this.armIdle();
        if (result !== undefined) resolve(result);
        else reject(error);
      };
      this.pending = {
        request,
        resolve: (result) => settle(undefined, result),
        reject: (error) => settle(error),
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        this.kill('stdin failed');
        settle(
          new CapabilityPackWorkerRuntimeError(
            'protocol_error',
            `Interactive worker stdin failed: ${String(error)}`,
          ),
        );
      }
    });
  }

  private requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? WARM_WORKER_DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child;
    const launch = this.options.launch ?? defaultLauncher;
    const child = launch(
      this.options.entrypoint,
      [WARM_FLAG],
      safeRuntimeEnvironment(this.options.extraEnvironment),
    );
    this.child = child;
    this.buffer = Buffer.alloc(0);
    if (child.pid !== undefined) {
      try {
        this.options.onSpawn?.(child.pid);
      } catch (error) {
        log.warn('spawnObserverFailed', { error: error instanceof Error ? error.name : 'unknown' });
      }
    }
    log.action('warmWorkerStarted', {});
    child.stdout.on('data', (chunk: Buffer) => this.onData(child, chunk));
    // stderr is drained and dropped: it may carry paths, and nothing reads it.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => this.kill('stdin error'));
    child.on('error', () => this.onExit(child));
    child.on('exit', () => this.onExit(child));
    return child;
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.acceptLine(line);
      if (child !== this.child) return;
    }
    if (this.buffer.byteLength > CAPABILITY_PACK_WORKER_MAX_LINE_BYTES) {
      this.protocolFailure('Interactive worker output line exceeded its bound.');
    }
  }

  private acceptLine(line: Buffer): void {
    if (line.byteLength === 0) return;
    if (line.byteLength > CAPABILITY_PACK_WORKER_MAX_LINE_BYTES) {
      this.protocolFailure('Interactive worker output line exceeded its bound.');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString('utf8'));
    } catch {
      this.protocolFailure('Interactive worker emitted malformed JSON.');
      return;
    }
    const parsed = CapabilityPackWorkerOutputSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type === 'handshake') {
      this.protocolFailure('Interactive worker emitted an invalid runtime message.');
      return;
    }
    const message = parsed.data;
    const pending = this.pending;
    if (pending === undefined || message.requestId !== pending.request.requestId) {
      // The only line allowed to arrive for a request nobody is waiting on is the `cancelled`
      // answer to a cancel we sent after its caller gave up.
      if (message.type === 'failure' && this.cancelled.delete(message.requestId)) return;
      this.protocolFailure('Interactive worker answered a request nobody asked.');
      return;
    }
    if (message.type === 'progress') return;
    if (message.type === 'failure') {
      const failure = CapabilityPackWorkerFailureSchema.parse(message);
      this.cancelled.delete(failure.requestId);
      pending.reject(
        new CapabilityPackWorkerRuntimeError(
          failure.code === 'cancelled' ? 'cancelled' : 'worker_failed',
          failure.detail,
          failure.code,
        ),
      );
      return;
    }
    const result = CapabilityPackWorkerResultSchema.parse(message);
    if (
      result.capability !== 'subject.segment_frame' ||
      result.projectRevision !== pending.request.projectRevision ||
      (pending.request.capability === 'subject.segment_frame' &&
        result.pts !== pending.request.parameters.pts)
    ) {
      this.protocolFailure('Interactive worker result does not match the request contract.');
      return;
    }
    this.cancelled.delete(result.requestId);
    pending.resolve(result);
  }

  private protocolFailure(message: string): void {
    const pending = this.pending;
    this.kill('protocol error');
    pending?.reject(new CapabilityPackWorkerRuntimeError('protocol_error', message));
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.clearIdle();
    this.failPending(
      new CapabilityPackWorkerRuntimeError('worker_failed', 'The interactive worker exited.'),
    );
  }

  private failPending(error: CapabilityPackWorkerRuntimeError): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private kill(reason: string): void {
    const child = this.child;
    if (child === undefined) return;
    log.warn('warmWorkerKilled', maskingEventPayload('warmWorkerKilled', { reason }));
    this.child = undefined;
    this.clearIdle();
    killWorkerGroup(child.pid);
    child.kill('SIGKILL');
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.child === undefined) return;
    this.idleTimer = setTimeout(() => {
      log.action('warmWorkerIdleClosed', {});
      this.close();
    }, this.options.idleMs ?? WARM_WORKER_DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
