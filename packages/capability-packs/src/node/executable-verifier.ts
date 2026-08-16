import { spawn } from 'node:child_process';
import type { CapabilityPackArtifact } from '../contracts.js';

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface BoundedCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type BoundedCommandRunner = (
  request: BoundedCommandRequest,
) => Promise<BoundedCommandResult>;

export class CapabilityPackExecutableError extends Error {
  constructor(
    public readonly code: 'executable_untrusted' | 'download_cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackExecutableError';
  }
}

/** Verify the OS signature and exact signer identity carried by the signed artifact record. */
export async function verifyCapabilityPackExecutable(
  entrypointPath: string,
  artifact: CapabilityPackArtifact,
  runCommand: BoundedCommandRunner = runBoundedCommand,
  signal?: AbortSignal,
): Promise<void> {
  if (artifact.os === 'darwin') {
    if (artifact.executableTrust.kind !== 'macos_codesign') {
      throw untrusted('Signed artifact does not contain a macOS trust identity.');
    }
    assertSuccess(
      await runCommand({
        executable: '/usr/bin/codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', entrypointPath],
        ...(signal === undefined ? {} : { signal }),
      }),
      'macOS code signature verification failed',
    );
    const details = await runCommand({
      executable: '/usr/bin/codesign',
      args: ['--display', '--verbose=4', entrypointPath],
      ...(signal === undefined ? {} : { signal }),
    });
    assertSuccess(details, 'macOS signer inspection failed');
    const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(`${details.stdout}\n${details.stderr}`)?.[1];
    if (teamIdentifier !== artifact.executableTrust.teamIdentifier) {
      throw untrusted(
        `macOS Team ID ${teamIdentifier ?? '<missing>'} does not match the signed catalog.`,
      );
    }
    assertSuccess(
      await runCommand({
        executable: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'execute', '--verbose=2', entrypointPath],
        ...(signal === undefined ? {} : { signal }),
      }),
      'macOS Gatekeeper assessment failed',
    );
    return;
  }

  if (artifact.executableTrust.kind !== 'windows_authenticode') {
    throw untrusted('Signed artifact does not contain a Windows trust identity.');
  }
  const script = [
    '$s=Get-AuthenticodeSignature -LiteralPath $env:FRAMEPILOT_PACK_ENTRYPOINT',
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){exit 3}",
    '$h=[System.Security.Cryptography.SHA256]::Create().ComputeHash($s.SignerCertificate.RawData)',
    '[Convert]::ToHexString($h).ToLowerInvariant()',
  ].join(';');
  const result = await runCommand({
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    env: { FRAMEPILOT_PACK_ENTRYPOINT: entrypointPath },
    ...(signal === undefined ? {} : { signal }),
  });
  assertSuccess(result, 'Windows Authenticode verification failed');
  if (result.stdout.trim() !== artifact.executableTrust.certificateSha256) {
    throw untrusted('Windows signer certificate does not match the signed catalog.');
  }
}

// Preserve only OS process-launch essentials so a wholesale-replaced `env` still lets the
// OS locate the executable (e.g. spawning bare `powershell.exe` needs PATH, or spawn fails
// ENOENT and every verification looks like a distrust failure rather than a launch failure).
function withProcessLaunchEssentials(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) merged[name] = value;
  }
  return { ...merged, ...env };
}

export async function runBoundedCommand(
  request: BoundedCommandRequest,
): Promise<BoundedCommandResult> {
  if (request.signal?.aborted === true) {
    throw new CapabilityPackExecutableError('download_cancelled', 'Executable verification cancelled.');
  }
  return await new Promise<BoundedCommandResult>((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      env: withProcessLaunchEssentials(request.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const terminate = (): void => {
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(terminate, COMMAND_TIMEOUT_MS);
    const abort = (): void => terminate();
    request.signal?.addEventListener('abort', abort, { once: true });
    const finish = (error?: unknown, result?: BoundedCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else if (request.signal?.aborted === true) {
        reject(new CapabilityPackExecutableError('download_cancelled', 'Executable verification cancelled.'));
      } else if (result !== undefined) resolve(result);
    };
    const append = (current: Buffer[], currentBytes: number, chunk: Buffer): number => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminate();
        finish(untrusted('Executable verification output exceeded its bound.'));
      }
      current.push(chunk);
      return nextBytes;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, stdoutBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, stderrBytes, chunk);
    });
    child.on('error', (error) => finish(untrusted(`Could not run verifier: ${error.message}`)));
    child.on('close', (exitCode) =>
      finish(undefined, {
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

function assertSuccess(result: BoundedCommandResult, context: string): void {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 2_000);
    throw untrusted(`${context}${detail.length === 0 ? '.' : `: ${detail}`}`);
  }
}

function untrusted(message: string): CapabilityPackExecutableError {
  return new CapabilityPackExecutableError('executable_untrusted', message);
}
