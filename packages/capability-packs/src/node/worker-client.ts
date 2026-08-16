/** Safe one-shot runtime client for an installed Capability Pack worker. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
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

const log = createLogger('capability-packs:worker-client');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_STDERR_BYTES = 64 * 1024;

export type CapabilityPackWorkerLauncher = (
  entrypoint: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => ChildProcessWithoutNullStreams;

export interface CapabilityPackWorkerRunOptions {
  readonly entrypoint: string;
  /** Project/media sandbox root already selected by the desktop authority. */
  readonly mediaRoot: string;
  readonly request: CapabilityPackWorkerRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: CapabilityPackWorkerProgress) => void;
  readonly launch?: CapabilityPackWorkerLauncher;
}

export class CapabilityPackWorkerRuntimeError extends Error {
  public constructor(
    public readonly code:
      | 'cancelled'
      | 'timed_out'
      | 'media_escape'
      | 'protocol_error'
      | 'worker_failed',
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
  });
}

function safeRuntimeEnvironment(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'disabled',
    FRAMEPILOT_CAPABILITY_PACK_RUNTIME: '1',
  };
  // Preserve only OS process-launch essentials. Provider keys and the rest of the desktop
  // environment never cross into a local media worker.
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function assertMediaInsideRoot(mediaRoot: string, mediaPath: string): Promise<void> {
  const [root, media] = await Promise.all([realpath(mediaRoot), realpath(mediaPath)]);
  const relative = path.relative(root, media);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new CapabilityPackWorkerRuntimeError(
    'media_escape',
    'Capability Pack media handle escapes the approved project root.',
  );
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
  await assertMediaInsideRoot(options.mediaRoot, request.media.absolutePath);
  if (options.signal?.aborted === true) {
    throw new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.');
  }
  const launch = options.launch ?? defaultLauncher;
  const child = launch(
    options.entrypoint,
    ['--framepilot-worker-runtime'],
    safeRuntimeEnvironment(),
  );
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
          log.warn('progressObserverFailed', { error: String(error) });
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
    child.on('close', (exitCode) => {
      if (settled) return;
      if (options.signal?.aborted === true) {
        finish(new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.'));
        return;
      }
      if (timedOut) {
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
      log.action('workerComplete', {
        requestId: request.requestId,
        capability: request.capability,
        samples:
          'samples' in terminal
            ? terminal.samples.length
            : 'detections' in terminal
              ? terminal.detections.length
              : terminal.masks.length,
      });
      finish(undefined, terminal);
    });
    // A worker that exits before reading stdin turns the write below into an EPIPE.
    // Without a listener here, that EPIPE is an uncaught 'error' event on the stream
    // and crashes the Electron main process instead of resolving this promise.
    child.stdin.on('error', (error) => {
      finish(protocolError(`Capability Pack worker stdin failed: ${error.message}`));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
