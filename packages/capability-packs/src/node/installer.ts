import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
  CapabilityPackArtifactSchema,
  CapabilityPackReleaseSchema,
  type CapabilityPackArtifact,
  type CapabilityPackRelease,
  type CapabilityPackWorkerHandshake,
} from '../contracts.js';
import {
  CapabilityPackInstallApprovalSchema,
  CapabilityPackInstallIdentitySchema,
  InstalledCapabilityPackSchema,
  type CapabilityPackInstallApproval,
  type CapabilityPackInstallIdentity,
  type CapabilityPackInstallProgress,
  type InstalledCapabilityPack,
} from '../install-contracts.js';
import {
  CapabilityPackDownloader,
  type CapabilityPackDownloaderOptions,
} from './downloader.js';
import {
  type ExtractedCapabilityPack,
  extractCapabilityPack,
} from './extractor.js';
import {
  verifyCapabilityPackExecutable,
  type BoundedCommandRunner,
} from './executable-verifier.js';
import { FileCapabilityPackStore, identityKey } from './storage.js';
import { healthCheckCapabilityPackWorker } from './worker-health.js';

const log = createLogger('capability-packs:installer');
const SHA256 = /^[0-9a-f]{64}$/u;
const LOCK_STALE_MS = 30 * 60 * 1_000;
const LOCK_HEARTBEAT_MS = 60_000;
const LOCK_POLL_MS = 200;
let lockOwnerWriteSequence = 0;

interface ArtifactLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly createdAt: string;
  readonly heartbeatAt: string;
}

export interface CapabilityPackInstallRequest {
  readonly operationId: string;
  readonly identity: CapabilityPackInstallIdentity;
  readonly release: CapabilityPackRelease;
  readonly artifact: CapabilityPackArtifact;
  readonly catalogDigest: string;
  readonly approval: CapabilityPackInstallApproval;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CapabilityPackInstallProgress) => void;
}

export interface CapabilityPackInstallerDependencies {
  readonly downloader?: CapabilityPackDownloader;
  readonly store?: FileCapabilityPackStore;
  readonly extract?: typeof extractCapabilityPack;
  readonly verifyExecutable?: typeof verifyCapabilityPackExecutable;
  readonly healthCheck?: typeof healthCheckCapabilityPackWorker;
  readonly commandRunner?: BoundedCommandRunner;
}

export interface CapabilityPackInstallerOptions extends CapabilityPackDownloaderOptions {
  readonly dependencies?: CapabilityPackInstallerDependencies;
}

export class CapabilityPackInstallError extends Error {
  constructor(
    public readonly code:
      | 'approval_required'
      | 'dependency_missing'
      | 'download_cancelled'
      | 'download_failed'
      | 'quarantined',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackInstallError';
  }
}

/** Production transaction coordinator for one immutable signed Capability Pack artifact. */
export class CapabilityPackInstaller {
  private readonly downloader: CapabilityPackDownloader;
  private readonly store: FileCapabilityPackStore;
  private readonly extract: typeof extractCapabilityPack;
  private readonly verifyExecutable: typeof verifyCapabilityPackExecutable;
  private readonly healthCheck: typeof healthCheckCapabilityPackWorker;
  private readonly commandRunner: BoundedCommandRunner | undefined;

  constructor(
    private readonly rootPath: string,
    options: CapabilityPackInstallerOptions = {},
  ) {
    this.downloader =
      options.dependencies?.downloader ??
      new CapabilityPackDownloader(path.join(rootPath, 'downloads'), options);
    this.store = options.dependencies?.store ?? new FileCapabilityPackStore(rootPath);
    this.extract = options.dependencies?.extract ?? extractCapabilityPack;
    this.verifyExecutable =
      options.dependencies?.verifyExecutable ?? verifyCapabilityPackExecutable;
    this.healthCheck = options.dependencies?.healthCheck ?? healthCheckCapabilityPackWorker;
    this.commandRunner = options.dependencies?.commandRunner;
  }

  async install(requestInput: CapabilityPackInstallRequest): Promise<InstalledCapabilityPack> {
    const request = validateInstallRequest(requestInput);
    const existing = await findInstalled(this.store, request.identity);
    if (existing?.state === 'installed' && existing.health.status === 'healthy') return existing;

    return await withArtifactLock(this.rootPath, request.identity, request.signal, async () => {
      await this.store.refresh();
      const afterWait = await findInstalled(this.store, request.identity);
      if (afterWait?.state === 'installed' && afterWait.health.status === 'healthy') return afterWait;
      const recovered = await this.recoverCommittedInstall(request);
      if (recovered !== undefined) return recovered;
      return await this.installLocked(request);
    });
  }

  private async recoverCommittedInstall(
    request: CapabilityPackInstallRequest,
  ): Promise<InstalledCapabilityPack | undefined> {
    const installRelativePath = installedRelativePath(request.identity);
    const committedPath = resolveInstallPath(this.rootPath, installRelativePath);
    let raw: string;
    try {
      raw = await readFile(path.join(committedPath, '.framepilot-install.json'), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let receipt: InstalledCapabilityPack;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('record' in parsed)) {
        throw new Error('receipt has no record');
      }
      receipt = InstalledCapabilityPackSchema.parse(parsed.record);
    } catch (error) {
      throw new CapabilityPackInstallError(
        'download_failed',
        `Committed Capability Pack receipt is corrupt: ${errorMessage(error)}`,
      );
    }
    if (
      identityKey(receipt.identity) !== identityKey(request.identity) ||
      receipt.installRelativePath !== installRelativePath ||
      receipt.state !== 'installed'
    ) {
      throw new CapabilityPackInstallError(
        'download_failed',
        'Committed Capability Pack receipt does not match its immutable install path.',
      );
    }
    const entrypointPath = resolveInstallPath(committedPath, request.artifact.entrypoint);
    try {
      await this.verifyExecutable(
        entrypointPath,
        request.artifact,
        this.commandRunner,
        request.signal,
      );
      const handshake = await this.healthCheck(
        entrypointPath,
        request.identity,
        request.release.capabilities,
        this.commandRunner,
        request.signal,
      );
      const now = new Date().toISOString();
      const recovered = InstalledCapabilityPackSchema.parse({
        ...receipt,
        lastUsedAt: now,
        health: {
          checkedAt: now,
          workerProtocolVersion: handshake.protocolVersion,
          status: 'healthy',
          detail: `Recovered after interrupted index commit; ${handshake.hardwareBackend}`,
        },
      });
      await this.store.recordInstalled(recovered);
      log.action('installRecovered', { pack: identityKey(request.identity) });
      return recovered;
    } catch (error) {
      if (isCancellation(error, request.signal)) throw error;
      throw new CapabilityPackInstallError(
        'download_failed',
        `Committed Capability Pack failed recovery verification: ${errorMessage(error)}`,
      );
    }
  }

  private async installLocked(request: CapabilityPackInstallRequest): Promise<InstalledCapabilityPack> {
    let extracted: ExtractedCapabilityPack | undefined;
    let committedPath: string | undefined;
    try {
      const downloaded = await this.downloader.download({
        operationId: request.operationId,
        identity: request.identity,
        artifact: request.artifact,
        approval: request.approval,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      });
      emitProgress(request, 'extracting', downloaded.bytes, 'Extracting signed files into staging.');
      await mkdir(path.join(this.rootPath, 'staging'), { recursive: true });
      extracted = await this.extract(path.join(this.rootPath, 'staging'), {
        artifact: request.artifact,
        downloadedFilePath: downloaded.filePath,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      emitProgress(request, 'checking_executable', downloaded.bytes, 'Verifying platform signature.');
      await this.verifyExecutable(
        extracted.entrypointPath,
        request.artifact,
        this.commandRunner,
        request.signal,
      );
      emitProgress(request, 'health_checking', downloaded.bytes, 'Checking worker identity and models.');
      const handshake = await this.healthCheck(
        extracted.entrypointPath,
        request.identity,
        request.release.capabilities,
        this.commandRunner,
        request.signal,
      );
      emitProgress(request, 'committing', downloaded.bytes, 'Committing immutable install.');
      const record = healthyRecord(request, extracted, handshake);
      await writeReceipt(extracted.stagingPath, record);
      const destination = resolveInstallPath(this.rootPath, record.installRelativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(extracted.stagingPath, destination);
      committedPath = destination;
      extracted = undefined;
      await this.store.recordInstalled(record);
      emitProgress(request, 'installed', downloaded.bytes, 'Capability Pack installed.');
      log.action('installComplete', { pack: identityKey(request.identity), path: committedPath });
      return record;
    } catch (error) {
      if (isCancellation(error, request.signal)) {
        if (extracted !== undefined) await rm(extracted.stagingPath, { recursive: true, force: true });
        throw new CapabilityPackInstallError('download_cancelled', 'Capability Pack install cancelled.');
      }
      if (extracted !== undefined && isTrustOrHealthFailure(error)) {
        const quarantine = await this.quarantine(request, extracted, error);
        throw new CapabilityPackInstallError(
          'quarantined',
          `Capability Pack failed trust or health checks and was quarantined at ${quarantine}.`,
        );
      }
      if (committedPath !== undefined) {
        throw new CapabilityPackInstallError(
          'download_failed',
          `Capability Pack bytes were committed but the index update failed; recovery is required at ${committedPath}: ${errorMessage(error)}`,
        );
      }
      if (extracted !== undefined) await rm(extracted.stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async quarantine(
    request: CapabilityPackInstallRequest,
    extracted: ExtractedCapabilityPack,
    error: unknown,
  ): Promise<string> {
    const relativePath = path.join(
      'quarantine',
      request.identity.id,
      request.identity.version,
      request.identity.releaseDigest,
      `${request.identity.os}-${request.identity.arch}`,
      request.identity.artifactDigest,
    );
    const quarantinePath = resolveInstallPath(this.rootPath, relativePath);
    await mkdir(path.dirname(quarantinePath), { recursive: true });
    await rm(quarantinePath, { recursive: true, force: true });
    await rename(extracted.stagingPath, quarantinePath);
    const now = new Date().toISOString();
    await this.store.recordInstalled({
      identity: request.identity,
      state: 'quarantined',
      installRelativePath: relativePath,
      installedBytes: extracted.installedBytes,
      installedAt: now,
      lastUsedAt: now,
      pinnedProjectIds: [],
      activeLeaseCount: 0,
      health: {
        checkedAt: now,
        workerProtocolVersion: request.release.compatibility.workerProtocolVersion,
        status: 'unhealthy',
        detail: errorMessage(error).slice(0, 2_000),
      },
      acquisition: acquisitionReceipt(request),
    });
    return quarantinePath;
  }
}

function validateInstallRequest(request: CapabilityPackInstallRequest): CapabilityPackInstallRequest {
  const identity = CapabilityPackInstallIdentitySchema.parse(request.identity);
  const release = CapabilityPackReleaseSchema.parse(request.release);
  const artifact = CapabilityPackArtifactSchema.parse(request.artifact);
  const approval = CapabilityPackInstallApprovalSchema.parse(request.approval);
  if (!SHA256.test(request.catalogDigest)) {
    throw new CapabilityPackInstallError('approval_required', 'Catalog digest is invalid.');
  }
  if (
    identity.releaseDigest !== release.releaseDigest ||
    identity.artifactDigest !== artifact.sha256 ||
    identity.os !== artifact.os ||
    identity.arch !== artifact.arch ||
    release.id !== identity.id ||
    release.version !== identity.version ||
    !release.artifacts.some((candidate) => candidate.sha256 === artifact.sha256)
  ) {
    throw new CapabilityPackInstallError(
      'approval_required',
      'Install identity, release, and platform artifact do not form one signed selection.',
    );
  }
  const approvedLicenses = [...approval.approvedLicenseSpdx].sort();
  const releaseLicenses = release.licenses.map((license) => license.spdx).sort();
  if (
    identityKey(approval.identity) !== identityKey(identity) ||
    approval.approvedSizeBytes !== artifact.sizeBytes ||
    approval.approvedMediaEgress !== release.privacy.mediaLeavesDevice ||
    JSON.stringify(approvedLicenses) !== JSON.stringify(releaseLicenses)
  ) {
    throw new CapabilityPackInstallError(
      'approval_required',
      'Install approval does not exactly match size, licenses, privacy, and immutable identity.',
    );
  }
  if (release.dependencies.length > 0) {
    throw new CapabilityPackInstallError(
      'dependency_missing',
      'Dependency installation must be resolved before installing this pack.',
    );
  }
  return { ...request, identity, release, artifact, approval };
}

function healthyRecord(
  request: CapabilityPackInstallRequest,
  extracted: ExtractedCapabilityPack,
  handshake: CapabilityPackWorkerHandshake,
): InstalledCapabilityPack {
  const now = new Date().toISOString();
  const installRelativePath = installedRelativePath(request.identity);
  return InstalledCapabilityPackSchema.parse({
    identity: request.identity,
    state: 'installed',
    installRelativePath,
    installedBytes: extracted.installedBytes,
    installedAt: now,
    lastUsedAt: now,
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: {
      checkedAt: now,
      workerProtocolVersion: handshake.protocolVersion,
      status: 'healthy',
      detail: `${handshake.hardwareBackend}; ${Object.keys(handshake.modelDigests).length} model(s)`,
    },
    acquisition: acquisitionReceipt(request),
  });
}

function acquisitionReceipt(request: CapabilityPackInstallRequest): InstalledCapabilityPack['acquisition'] {
  return {
    catalogDigest: request.catalogDigest,
    approvedAt: request.approval.approvedAt,
    licenseSpdx: request.approval.approvedLicenseSpdx,
    mediaEgressApproved: request.approval.approvedMediaEgress,
  };
}

async function writeReceipt(stagingPath: string, record: InstalledCapabilityPack): Promise<void> {
  await writeFile(
    path.join(stagingPath, '.framepilot-install.json'),
    `${JSON.stringify({ schemaVersion: 1, record }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

/** Remove only stale disposable extraction directories; committed or quarantined bytes are untouched. */
export async function cleanupAbandonedCapabilityPackStaging(
  rootPath: string,
  olderThanMs = 24 * 60 * 60 * 1_000,
  now = Date.now(),
): Promise<readonly string[]> {
  const stagingRoot = path.join(rootPath, 'staging');
  let names: string[];
  try {
    names = await readdir(stagingRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith('.staging-')) continue;
    const candidate = path.join(stagingRoot, name);
    const details = await lstat(candidate);
    if (now - details.mtimeMs < olderThanMs) continue;
    await rm(candidate, { recursive: details.isDirectory() && !details.isSymbolicLink(), force: true });
    removed.push(candidate);
  }
  return removed;
}

/** Serialize physical work for one immutable artifact while proving a live owner stays live. */
async function withArtifactLock<T>(
  rootPath: string,
  identity: CapabilityPackInstallIdentity,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const locksRoot = path.join(rootPath, 'locks');
  await mkdir(locksRoot, { recursive: true });
  const lockPath = path.join(locksRoot, identity.artifactDigest);
  const ownerPath = path.join(lockPath, 'owner.json');
  const createdAt = new Date().toISOString();

  while (true) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLock(lockPath, ownerPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await waitForLock(signal);
      continue;
    }

    try {
      await writeLockOwner(ownerPath, createdAt);
      break;
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }

  const heartbeat = setInterval(() => {
    void writeLockOwner(ownerPath, createdAt).catch((error: unknown) => {
      log.warn('installLockHeartbeatFailed', {
        pack: identity.artifactDigest.slice(0, 12),
        error: errorMessage(error),
      });
    });
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

/** @internal Exported for the install-lock concurrency regression tests. */
export async function writeLockOwner(ownerPath: string, createdAt: string): Promise<void> {
  const owner: ArtifactLockOwner = {
    pid: process.pid,
    host: hostname(),
    createdAt,
    heartbeatAt: new Date().toISOString(),
  };
  const sequence = lockOwnerWriteSequence++;
  const temp = `${ownerPath}.${String(process.pid)}.${String(sequence)}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    // Make the new owner record durable before the atomic name swap. The lock is a crash-safety
    // authority, so publishing bytes that are only in userspace/page cache is not sufficient.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, ownerPath);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** @internal Exported for the install-lock concurrency regression tests. */
export async function isStaleLock(lockPath: string, ownerPath: string): Promise<boolean> {
  let owner: ArtifactLockOwner | undefined;
  try {
    const raw: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'pid' in raw &&
      Number.isInteger((raw as { pid?: unknown }).pid) &&
      'host' in raw &&
      typeof (raw as { host?: unknown }).host === 'string' &&
      'createdAt' in raw &&
      typeof (raw as { createdAt?: unknown }).createdAt === 'string' &&
      'heartbeatAt' in raw &&
      typeof (raw as { heartbeatAt?: unknown }).heartbeatAt === 'string'
    ) {
      owner = raw as ArtifactLockOwner;
    }
  } catch (error) {
    if (!isMissing(error)) {
      log.warn('installLockOwnerUnreadable', { error: errorMessage(error) });
    }
  }

  if (owner !== undefined) {
    const heartbeatAt = Date.parse(owner.heartbeatAt);
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= LOCK_STALE_MS) return false;
    if (owner.host === hostname() && processAlive(owner.pid)) return false;
    return true;
  }

  // Fail closed on unreadable/malformed ownership. A heartbeat is atomically renamed now, but
  // filesystem faults can still make the record unreadable. Only the owner FILE's age is evidence
  // that ownership has not refreshed; the lock directory mtime is unrelated to heartbeats.
  try {
    return Date.now() - (await stat(ownerPath)).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (!isMissing(error)) {
      log.warn('installLockOwnerStatFailed', { error: errorMessage(error) });
      return false;
    }
  }

  // owner.json can be absent only in the tiny interval after mkdir and before the first atomic
  // publication, or after a crash in that interval. Reclaim only when the directory itself has
  // remained abandoned for the full stale threshold.
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    return isMissing(error);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(complete, LOCK_POLL_MS);
    const abort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new CapabilityPackInstallError('download_cancelled', 'Capability Pack install cancelled.'));
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function findInstalled(
  store: FileCapabilityPackStore,
  identity: CapabilityPackInstallIdentity,
): Promise<InstalledCapabilityPack | undefined> {
  return (await store.list()).find((record) => identityKey(record.identity) === identityKey(identity));
}

function resolveInstallPath(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new CapabilityPackInstallError('download_failed', 'Install destination escapes pack root.');
  }
  return resolved;
}

function installedRelativePath(identity: CapabilityPackInstallIdentity): string {
  return path.join(
    'packs',
    identity.id,
    identity.version,
    identity.releaseDigest,
    `${identity.os}-${identity.arch}`,
    identity.artifactDigest,
  );
}

function emitProgress(
  request: CapabilityPackInstallRequest,
  phase: CapabilityPackInstallProgress['phase'],
  completedBytes: number,
  detail: string,
): void {
  try {
    request.onProgress?.({
      operationId: request.operationId,
      identity: request.identity,
      phase,
      completedBytes,
      totalBytes: request.artifact.sizeBytes,
      detail,
    });
  } catch (error) {
    log.warn('progressObserverFailed', { error: errorMessage(error) });
  }
}

function isTrustOrHealthFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'executable_untrusted' ||
      (error as { code?: unknown }).code === 'health_check_failed' ||
      (error as { code?: unknown }).code === 'protocol_mismatch')
  );
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'download_cancelled')
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CapabilityPackInstallError('download_cancelled', 'Capability Pack install cancelled.');
  }
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, 'EEXIST');
}

function isMissing(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
