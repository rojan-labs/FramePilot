/** Safe one-shot runtime client for an installed Capability Pack worker. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
  CAPABILITY_PACK_OUTPUT_HANDLE_CAPABILITIES,
  CAPABILITY_PACK_WORKER_MAX_LINE_BYTES,
  CapabilityPackWorkerCancelSchema,
  CapabilityPackWorkerFailureSchema,
  CapabilityPackWorkerOutputSchema,
  CapabilityPackWorkerRequestSchema,
  CapabilityPackWorkerResultSchema,
  type CapabilityPackWorkerProgress,
  type CapabilityPackWorkerRequest,
  type CapabilityPackWorkerResult,
} from '../worker-protocol.js';
import { ensureWorkerGroupGone, killWorkerGroup, workerGroupSpawnOptions } from './process-group.js';
import { mergeExtraWorkerEnvironment } from './worker-env.js';

const log = createLogger('capability-packs:worker-client');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_STDERR_BYTES = 64 * 1024;
/** How long after `exit` the client waits for `close` before settling without it. */
const EXIT_GRACE_MS = 1_000;

export type CapabilityPackWorkerLauncher = (
  entrypoint: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => ChildProcessWithoutNullStreams;

export interface CapabilityPackWorkerRunOptions {
  readonly entrypoint: string;
  /** Project/media sandbox root already selected by the desktop authority. */
  readonly mediaRoot: string;
  /**
   * The host's matte staging root (`<project>/.framepilot-derived/mattes/.staging`). Required
   * for a capability that carries a write handle: its output and inputs directories must be
   * real (non-symlink) directories strictly inside this root (MD-3).
   */
  readonly outputRoot?: string;
  readonly request: CapabilityPackWorkerRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Additional FRAMEPILOT_-prefixed variables the pack's contract requires,
   * e.g. `FRAMEPILOT_CAPABILITY_PACK_ROOT` for packs that ship model weights
   * inside the install root. They are merged AFTER the environment scrub, so
   * nothing else from the desktop process can leak through this channel;
   * anything not FRAMEPILOT_-prefixed is dropped rather than passed, and the
   * host-owned protocol keys (network/runtime/identity) cannot be overridden.
   */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly onProgress?: (progress: CapabilityPackWorkerProgress) => void;
  /** The worker's pid (its process-group id on POSIX), for a host watchdog (BR4.12 H2). */
  readonly onSpawn?: (pid: number) => void;
  readonly launch?: CapabilityPackWorkerLauncher;
}

export class CapabilityPackWorkerRuntimeError extends Error {
  public constructor(
    public readonly code:
      | 'cancelled'
      | 'timed_out'
      | 'media_escape'
      | 'protocol_error'
      | 'worker_failed'
      | 'lingering_process',
    message: string,
    public readonly workerCode?: string,
  ) {
    super(message);
    this.name = 'CapabilityPackWorkerRuntimeError';
  }
}

function defaultLauncher(
  entrypoint: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): ChildProcessWithoutNullStreams {
  return spawn(entrypoint, [...args], {
    shell: false,
    windowsHide: true,
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so a timeout, abort or finish can end every descendant (BR4.12 H1).
    ...workerGroupSpawnOptions(),
  });
}

function safeRuntimeEnvironment(
  extraEnvironment?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = {
    FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'disabled',
    FRAMEPILOT_CAPABILITY_PACK_RUNTIME: '1',
  };
  // Preserve only OS process-launch essentials. Provider keys and the rest of the desktop
  // environment never cross into a local media worker.
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return mergeExtraWorkerEnvironment(base, extraEnvironment);
}

/**
 * The capabilities that legitimately carry NO media handle.
 *
 * Exhaustive and deliberately short: everything not named here must name media inside the
 * approved project root, and a capability added to the frozen union without a media handle
 * fails loudly rather than bypassing the sandbox. `CLAUDE.md` §5 lists broadening the path
 * sandbox as ask-first, and a property-name test broadens it by accident.
 */
const MEDIA_FREE_CAPABILITIES: ReadonlySet<string> = new Set(['visual.text']);

async function assertMediaInsideRoot(mediaRoot: string, mediaPath: string): Promise<void> {
  const [root, media] = await Promise.all([realpath(mediaRoot), realpath(mediaPath)]);
  const relative = path.relative(root, media);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new CapabilityPackWorkerRuntimeError(
    'media_escape',
    'Capability Pack media handle escapes the approved project root.',
  );
}

/**
 * A write handle (and its inputs handle) must name a real directory strictly inside the
 * host's staging root. Symlinked handle directories are refused outright: the host created
 * them, so a link means something else touched the tree.
 */
async function assertHandlesInsideOutputRoot(
  outputRoot: string | undefined,
  directories: readonly string[],
): Promise<void> {
  if (outputRoot === undefined) {
    throw new CapabilityPackWorkerRuntimeError(
      'media_escape',
      'A capability with a write handle needs the host staging root to check it against.',
    );
  }
  const root = await realpath(outputRoot);
  for (const directory of directories) {
    let resolved: string;
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
      resolved = await realpath(directory);
    } catch {
      throw new CapabilityPackWorkerRuntimeError(
        'media_escape',
        'Capability Pack write handle is not a host-created directory.',
      );
    }
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new CapabilityPackWorkerRuntimeError(
        'media_escape',
        'Capability Pack write handle escapes the host staging root.',
      );
    }
  }
}

/** How many items a terminal result carried, for the completion log line only. */
function terminalSampleCount(terminal: CapabilityPackWorkerResult): number {
  if ('artifact' in terminal) return terminal.artifact.frameCount;
  if ('maskPng' in terminal) return 1;
  if ('samples' in terminal) return terminal.samples.length;
  if ('detections' in terminal) return terminal.detections.length;
  if ('masks' in terminal) return terminal.masks.length;
  if ('shots' in terminal) return terminal.shots.length;
  return terminal.vectors.length;
}

function protocolError(message: string): CapabilityPackWorkerRuntimeError {
  return new CapabilityPackWorkerRuntimeError('protocol_error', message);
}

/**
 * Run one request in one isolated process. Abort first sends the typed cancel message, then kills
 * the process after a short grace period. No output is accepted unless request id, revision and
 * capability exactly match the request.
 */
export async function runCapabilityPackWorker(
  options: CapabilityPackWorkerRunOptions,
): Promise<CapabilityPackWorkerResult> {
  const request = CapabilityPackWorkerRequestSchema.parse(options.request);
  // THE SANDBOX EXEMPTION IS A CLOSED LIST, NOT A PROPERTY TEST.
  //
  // `visual.text` embeds a query string and carries no media handle at all, so there is
  // nothing to sandbox-check; every other capability must name media inside the root. That
  // used to be written as `if ('media' in request)`, which made the path-sandbox invariant
  // conditional on a PROPERTY NAME: a future request type carrying a path under any other
  // key — `mediaPath`, `source`, `frames` — would have skipped the check silently, with no
  // compile error and no failing test. Naming the exempt capabilities instead means a new
  // capability is checked by default and the type system objects when the union grows.
  if (!MEDIA_FREE_CAPABILITIES.has(request.capability)) {
    if (!('media' in request)) {
      throw new CapabilityPackWorkerRuntimeError(
        'media_escape',
        `Capability "${request.capability}" carries no media handle to sandbox-check. Add it ` +
          'to MEDIA_FREE_CAPABILITIES only if it genuinely reads no path.',
      );
    }
    await assertMediaInsideRoot(options.mediaRoot, request.media.absolutePath);
  }
  if (CAPABILITY_PACK_OUTPUT_HANDLE_CAPABILITIES.has(request.capability)) {
    if (request.capability !== 'subject.matte') {
      throw new CapabilityPackWorkerRuntimeError(
        'media_escape',
        `Capability "${request.capability}" has no write-handle check.`,
      );
    }
    const { output, inputs } = request.parameters;
    await assertHandlesInsideOutputRoot(options.outputRoot, [
      output.absolutePath,
      ...(inputs === undefined ? [] : [inputs.absolutePath]),
    ]);
  }
  if (options.signal?.aborted === true) {
    throw new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.');
  }
  const launch = options.launch ?? defaultLauncher;
  const child = launch(
    options.entrypoint,
    ['--framepilot-worker-runtime'],
    safeRuntimeEnvironment(options.extraEnvironment),
  );
  if (child.pid !== undefined) {
    try {
      options.onSpawn?.(child.pid);
    } catch (error) {
      log.warn('spawnObserverFailed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<CapabilityPackWorkerResult>((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let terminal: CapabilityPackWorkerResult | undefined;
    let timedOut = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: unknown, result?: CapabilityPackWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortKillTimer !== undefined) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const terminate = (): void => {
      killWorkerGroup(child.pid);
      child.kill('SIGKILL');
    };
    const abort = (): void => {
      try {
        const cancel = CapabilityPackWorkerCancelSchema.parse({
          type: 'cancel',
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
        });
        child.stdin.write(`${JSON.stringify(cancel)}\n`);
      } finally {
        abortKillTimer = setTimeout(terminate, 250);
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const acceptLine = (line: Buffer): void => {
      if (line.byteLength === 0) return;
      if (line.byteLength > CAPABILITY_PACK_WORKER_MAX_LINE_BYTES) {
        terminate();
        finish(protocolError('Capability Pack worker output line exceeded its bound.'));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line.toString('utf8'));
      } catch {
        terminate();
        finish(protocolError('Capability Pack worker emitted malformed JSON.'));
        return;
      }
      const parsed = CapabilityPackWorkerOutputSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type === 'handshake') {
        terminate();
        finish(protocolError('Capability Pack worker emitted an invalid runtime message.'));
        return;
      }
      if (parsed.data.requestId !== request.requestId) {
        terminate();
        finish(protocolError('Capability Pack worker response request id does not match.'));
        return;
      }
      if (parsed.data.type === 'progress') {
        try {
          options.onProgress?.(parsed.data);
        } catch (error) {
          log.warn('progressObserverFailed', { error: error instanceof Error ? error.name : 'unknown' });
        }
        return;
      }
      if (parsed.data.type === 'failure') {
        const failure = CapabilityPackWorkerFailureSchema.parse(parsed.data);
        terminate();
        finish(
          new CapabilityPackWorkerRuntimeError(
            failure.code === 'cancelled' ? 'cancelled' : 'worker_failed',
            failure.detail,
            failure.code,
          ),
        );
        return;
      }
      const result = CapabilityPackWorkerResultSchema.parse(parsed.data);
      if (
        result.projectRevision !== request.projectRevision ||
        result.capability !== request.capability
      ) {
        terminate();
        finish(protocolError('Capability Pack worker result does not match the request contract.'));
        return;
      }
      if (terminal !== undefined) {
        terminate();
        finish(protocolError('Capability Pack worker emitted more than one terminal result.'));
        return;
      }
      terminal = result;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      while (true) {
        const newline = stdout.indexOf(10);
        if (newline < 0) break;
        const line = stdout.subarray(0, newline);
        stdout = stdout.subarray(newline + 1);
        acceptLine(line);
        if (settled) return;
      }
      if (stdout.byteLength > CAPABILITY_PACK_WORKER_MAX_LINE_BYTES) {
        terminate();
        finish(protocolError('Capability Pack worker output line exceeded its bound.'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.byteLength >= MAX_STDERR_BYTES) return;
      stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_STDERR_BYTES);
    });
    child.on('error', (error) => finish(protocolError(`Capability Pack worker failed to start: ${error.message}`)));
    // Settle on `exit` + a grace period, not only `close`: a descendant that inherited stdout
    // would otherwise keep `close` from ever firing and the job would never settle (BR4.12 H1).
    let ended = false;
    let exitGrace: ReturnType<typeof setTimeout> | undefined;
    const onEnded = (exitCode: number | null): void => {
      if (settled || ended) return;
      ended = true;
      if (exitGrace !== undefined) clearTimeout(exitGrace);
      if (options.signal?.aborted === true) {
        terminate();
        finish(new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.'));
        return;
      }
      if (timedOut) {
        terminate();
        finish(
          new CapabilityPackWorkerRuntimeError(
            'timed_out',
            `Capability Pack worker timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }
      if (stdout.byteLength > 0) acceptLine(stdout);
      if (settled) return;
      if (exitCode !== 0 || terminal === undefined) {
        terminate();
        const detail = stderr.toString('utf8').trim().slice(0, 2_000);
        finish(
          protocolError(
            `Capability Pack worker exited ${String(exitCode)} without a valid result${
              detail === '' ? '.' : `: ${detail}`
            }`,
          ),
        );
        return;
      }
      const result = terminal;
      // Nothing the worker started may outlive the job: the host verifies the staging
      // directory next, and a live descendant could still be writing into it.
      void ensureWorkerGroupGone(child.pid).then((gone) => {
        child.stdout.destroy();
        child.stderr.destroy();
        if (!gone) {
          finish(
            new CapabilityPackWorkerRuntimeError(
              'lingering_process',
              'A process started by the Capability Pack worker would not stop.',
            ),
          );
          return;
        }
        log.action('workerComplete', {
          requestId: request.requestId,
          capability: request.capability,
          samples: terminalSampleCount(result),
        });
        finish(undefined, result);
      });
    };
    child.on('exit', (exitCode) => {
      if (settled || ended) return;
      exitGrace = setTimeout(() => onEnded(exitCode), EXIT_GRACE_MS);
    });
    child.on('close', (exitCode) => onEnded(exitCode));
    // A worker that exits before reading stdin turns the write below into an EPIPE.
    // Without a listener here, that EPIPE is an uncaught 'error' event on the stream
    // and crashes the Electron main process instead of resolving this promise.
    child.stdin.on('error', (error) => {
      finish(protocolError(`Capability Pack worker stdin failed: ${error.message}`));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
