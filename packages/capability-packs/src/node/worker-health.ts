import {
  CapabilityPackWorkerHandshakeSchema,
  type CapabilityPackWorkerHandshake,
} from '../contracts.js';
import type { CapabilityPackInstallIdentity } from '../install-contracts.js';
import {
  CapabilityPackExecutableError,
  runBoundedCommand,
  type BoundedCommandResult,
  type BoundedCommandRunner,
} from './executable-verifier.js';
import { mergeExtraWorkerEnvironment } from './worker-env.js';

/**
 * Wall-clock bound for a worker's health handshake.
 *
 * WHY IT IS MUCH LARGER THAN A PROBE'S: a weights-backed pack proves it is healthy by
 * hashing every pinned artifact and opening a real inference session. Visual Embed reads
 * ~1.5 GiB and lets CoreML compile two SigLIP towers — measured at ~48 s on a cold cache
 * and ~21 s warm on an M-series laptop; Visual Describe hashes ~2.6 GiB. Under the 15 s
 * probe bound both were SIGKILLed mid-verification and reported as `exited null`, which
 * reads as a broken pack rather than a bound being hit. The verification is the security
 * property, so the budget has to cover it.
 */
const HEALTH_CHECK_TIMEOUT_MS = 180_000;

export class CapabilityPackHealthError extends Error {
  constructor(
    public readonly code: 'health_check_failed' | 'protocol_mismatch' | 'download_cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackHealthError';
  }
}

/** Start an isolated worker in health-only mode and verify its signed identity/capability contract. */
export async function healthCheckCapabilityPackWorker(
  entrypointPath: string,
  identity: CapabilityPackInstallIdentity,
  expectedCapabilities: readonly string[],
  runCommand: BoundedCommandRunner = runBoundedCommand,
  signal?: AbortSignal,
  /**
   * FRAMEPILOT_-prefixed extras the pack's contract requires — same rules as
   * the runtime client's `extraEnvironment` (weights-backed packs need
   * `FRAMEPILOT_CAPABILITY_PACK_ROOT`). Non-prefixed names are dropped and the
   * host-owned protocol keys cannot be overridden.
   */
  extraEnvironment?: Readonly<Record<string, string>>,
): Promise<CapabilityPackWorkerHandshake> {
  let result: BoundedCommandResult;
  const env = mergeExtraWorkerEnvironment(
    {
      FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK: '1',
      FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'disabled',
      FRAMEPILOT_CAPABILITY_PACK_ID: identity.id,
      FRAMEPILOT_CAPABILITY_PACK_VERSION: identity.version,
      FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST: identity.releaseDigest,
      FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES: JSON.stringify([...expectedCapabilities].sort()),
    },
    extraEnvironment,
  );
  try {
    result = await runCommand({
      executable: entrypointPath,
      args: ['--framepilot-health-check'],
      env,
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof CapabilityPackExecutableError && error.code === 'download_cancelled') {
      throw new CapabilityPackHealthError('download_cancelled', 'Worker health check cancelled.');
    }
    throw new CapabilityPackHealthError(
      'health_check_failed',
      `Capability Pack worker could not start: ${errorMessage(error)}`,
    );
  }
  if (result.exitCode !== 0) {
    // A null exit code means the process was killed rather than exiting — the bound above,
    // or the caller's abort. Saying so is the difference between a diagnosable message and
    // "exited null", which sent one debugging session looking for a crash that never was.
    const outcome =
      result.exitCode === null
        ? `was killed before it answered (bound: ${HEALTH_CHECK_TIMEOUT_MS / 1_000}s)`
        : `exited ${result.exitCode}`;
    throw new CapabilityPackHealthError(
      'health_check_failed',
      `Capability Pack worker health check ${outcome}: ${result.stderr.trim().slice(0, 2_000)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout.trim());
  } catch {
    throw new CapabilityPackHealthError(
      'health_check_failed',
      'Capability Pack worker did not return one JSON handshake.',
    );
  }
  const parsed = CapabilityPackWorkerHandshakeSchema.safeParse(raw);
  if (!parsed.success) {
    const protocolIssue = parsed.error.issues.some((issue) => issue.path[0] === 'protocolVersion');
    throw new CapabilityPackHealthError(
      protocolIssue ? 'protocol_mismatch' : 'health_check_failed',
      `Capability Pack worker handshake is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  const handshake = parsed.data;
  if (
    handshake.pack.id !== identity.id ||
    handshake.pack.version !== identity.version ||
    handshake.pack.releaseDigest !== identity.releaseDigest
  ) {
    throw new CapabilityPackHealthError(
      'protocol_mismatch',
      'Capability Pack worker identity does not match the approved signed release.',
    );
  }
  const actualCapabilities = [...handshake.capabilities].sort();
  const signedCapabilities = [...expectedCapabilities].sort();
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(signedCapabilities)) {
    throw new CapabilityPackHealthError(
      'protocol_mismatch',
      'Capability Pack worker capabilities do not exactly match the signed release.',
    );
  }
  return handshake;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
