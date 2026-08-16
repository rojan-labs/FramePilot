import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
  CapabilityPackStorageIndexSchema,
  InstalledCapabilityPackSchema,
  CapabilityPackProjectPinSchema,
  type CapabilityPackInstallIdentity,
  type CapabilityPackStorageIndex,
  type InstalledCapabilityPack,
  type CapabilityPackProjectDependencyStatus,
  type CapabilityPackProjectPin,
} from '../install-contracts.js';

const log = createLogger('capability-packs:storage');
const INDEX_FILE = 'index.json';
const INDEX_LOCK = '.index.lock';
const INDEX_LOCK_STALE_MS = 30_000;
const INDEX_LOCK_POLL_MS = 25;

export class CapabilityPackStorageError extends Error {
  constructor(
    public readonly code:
      | 'index_corrupt'
      | 'invalid_state'
      | 'pack_not_found'
      | 'pack_pinned'
      | 'pack_leased',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackStorageError';
  }
}

export interface CapabilityPackLease {
  readonly identity: CapabilityPackInstallIdentity;
  readonly installPath: string;
  release(): Promise<void>;
}

/**
 * Crash-safe authority for installed Capability Pack records.
 *
 * Mutations serialize through one in-process promise lane plus the filesystem index lock and
 * atomically rename the complete validated index. Active leases are persisted and never reset
 * merely because another process starts: doing so could let process B remove a pack while a
 * live worker in process A still owns it. A crash can therefore leave a conservative stale
 * lease count, which blocks removal instead of risking deletion under a live reader.
 */
export class FileCapabilityPackStore {
  private readonly indexPath: string;
  private mutationLane: Promise<void> = Promise.resolve();
  private loaded: CapabilityPackStorageIndex | undefined;

  constructor(private readonly rootPath: string) {
    this.indexPath = path.join(rootPath, INDEX_FILE);
  }

  async list(): Promise<readonly InstalledCapabilityPack[]> {
    return [...(await this.load()).records];
  }

  /** Reload disk authority after another process may have completed an install. */
  async refresh(): Promise<void> {
    await this.mutationLane;
    this.loaded = undefined;
    await this.load();
  }

  async recordInstalled(recordInput: InstalledCapabilityPack): Promise<void> {
    const record = InstalledCapabilityPackSchema.parse(recordInput);
    await this.mutate((index) => {
      const records = index.records.filter(
        (candidate) => identityKey(candidate.identity) !== identityKey(record.identity),
      );
      records.push(record);
      return { schemaVersion: 1, records };
    });
    log.action('recordInstalled', { pack: identityKey(record.identity) });
  }

  async pin(identity: CapabilityPackInstallIdentity, projectId: string): Promise<void> {
    await this.updateRecord(identity, (record) => ({
      ...record,
      pinnedProjectIds: [...new Set([...record.pinnedProjectIds, projectId])],
      lastUsedAt: new Date().toISOString(),
    }));
  }

  async unpin(identity: CapabilityPackInstallIdentity, projectId: string): Promise<void> {
    await this.updateRecord(identity, (record) => ({
      ...record,
      pinnedProjectIds: record.pinnedProjectIds.filter((candidate) => candidate !== projectId),
    }));
  }

  /** Atomically make one project's durable pins exactly match its logical dependencies. */
  async reconcileProjectPins(
    projectIdInput: string,
    pinsInput: readonly CapabilityPackProjectPin[],
  ): Promise<readonly CapabilityPackProjectDependencyStatus[]> {
    const projectId = requireProjectId(projectIdInput);
    const pins = pinsInput.map((pin) => CapabilityPackProjectPinSchema.parse(pin));
    const duplicate = pins.find(
      (pin, index) => pins.findIndex((candidate) => candidate.id === pin.id) !== index,
    );
    if (duplicate !== undefined) {
      throw new CapabilityPackStorageError(
        'invalid_state',
        `Project has duplicate pack pin ${duplicate.id}.`,
      );
    }
    let statuses: readonly CapabilityPackProjectDependencyStatus[] = [];
    await this.mutate((index) => {
      const now = new Date().toISOString();
      statuses = pins.map((pin) => dependencyStatus(pin, index.records));
      const presentKeys = new Set(
        statuses.flatMap((status) =>
          status.identity !== undefined ? [identityKey(status.identity)] : [],
        ),
      );
      return {
        schemaVersion: 1,
        records: index.records.map((record) => {
          const shouldPin = presentKeys.has(identityKey(record.identity));
          const pinnedProjectIds = shouldPin
            ? [...new Set([...record.pinnedProjectIds, projectId])]
            : record.pinnedProjectIds.filter((candidate) => candidate !== projectId);
          return {
            ...record,
            pinnedProjectIds,
            ...(shouldPin ? { lastUsedAt: now } : {}),
          };
        }),
      };
    });
    log.action('projectPinsReconciled', {
      projectId,
      ready: statuses.filter((status) => status.status === 'ready').length,
      unavailable: statuses.filter((status) => status.status !== 'ready').length,
    });
    return statuses;
  }

  async acquireLease(identity: CapabilityPackInstallIdentity): Promise<CapabilityPackLease> {
    let installPath = '';
    await this.updateRecord(identity, (record) => {
      if (record.state !== 'installed' || record.health.status !== 'healthy') {
        throw new CapabilityPackStorageError(
          'pack_not_found',
          `Pack ${identityKey(identity)} is not healthy and installed.`,
        );
      }
      installPath = resolveInsideRoot(this.rootPath, record.installRelativePath);
      return {
        ...record,
        activeLeaseCount: record.activeLeaseCount + 1,
        lastUsedAt: new Date().toISOString(),
      };
    });
    let released = false;
    return {
      identity,
      installPath,
      release: async () => {
        if (released) return;
        released = true;
        await this.updateRecord(identity, (record) => ({
          ...record,
          activeLeaseCount: Math.max(0, record.activeLeaseCount - 1),
        }));
      },
    };
  }

  async requestRemoval(identity: CapabilityPackInstallIdentity): Promise<string> {
    let relativePath = '';
    await this.updateRecord(identity, (record) => {
      if (record.pinnedProjectIds.length > 0) {
        throw new CapabilityPackStorageError(
          'pack_pinned',
          `Pack ${identityKey(identity)} is pinned by ${record.pinnedProjectIds.length} project(s).`,
        );
      }
      if (record.activeLeaseCount > 0) {
        throw new CapabilityPackStorageError(
          'pack_leased',
          `Pack ${identityKey(identity)} has ${record.activeLeaseCount} active lease(s).`,
        );
      }
      relativePath = record.installRelativePath;
      return { ...record, state: 'pending_removal' };
    });
    return resolveInsideRoot(this.rootPath, relativePath);
  }

  async completeRemoval(identity: CapabilityPackInstallIdentity): Promise<void> {
    await this.mutate((index) => {
      const record = findRecord(index, identity);
      if (record.state !== 'pending_removal') {
        throw new CapabilityPackStorageError(
          'invalid_state',
          `Pack ${identityKey(identity)} was not prepared for removal.`,
        );
      }
      return {
        schemaVersion: 1,
        records: index.records.filter(
          (candidate) => identityKey(candidate.identity) !== identityKey(identity),
        ),
      };
    });
  }

  private async updateRecord(
    identity: CapabilityPackInstallIdentity,
    update: (record: InstalledCapabilityPack) => InstalledCapabilityPack,
  ): Promise<void> {
    await this.mutate((index) => {
      const targetKey = identityKey(identity);
      let found = false;
      const records = index.records.map((record) => {
        if (identityKey(record.identity) !== targetKey) return record;
        found = true;
        return InstalledCapabilityPackSchema.parse(update(record));
      });
      if (!found) {
        throw new CapabilityPackStorageError(
          'pack_not_found',
          `Pack ${targetKey} is not installed.`,
        );
      }
      return { schemaVersion: 1, records };
    });
  }

  private async mutate(
    update: (index: CapabilityPackStorageIndex) => CapabilityPackStorageIndex,
  ): Promise<void> {
    const next = this.mutationLane.then(async () => {
      await withIndexLock(this.rootPath, async () => {
        this.loaded = undefined;
        const current = await this.load();
        const updated = CapabilityPackStorageIndexSchema.parse(update(current));
        await this.write(updated);
        this.loaded = updated;
      });
    });
    this.mutationLane = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<CapabilityPackStorageIndex> {
    if (this.loaded !== undefined) return this.loaded;
    await mkdir(this.rootPath, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        this.loaded = { schemaVersion: 1, records: [] };
        return this.loaded;
      }
      throw error;
    }

    let parsed: CapabilityPackStorageIndex;
    try {
      parsed = CapabilityPackStorageIndexSchema.parse(JSON.parse(raw));
    } catch (error) {
      const quarantine = `${this.indexPath}.corrupt-${Date.now()}`;
      await rename(this.indexPath, quarantine).catch(() => undefined);
      throw new CapabilityPackStorageError(
        'index_corrupt',
        `Capability Pack index was quarantined at ${quarantine}: ${errorMessage(error)}`,
      );
    }

    this.loaded = parsed;
    return parsed;
  }

  private async write(index: CapabilityPackStorageIndex): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    const temp = `${this.indexPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    await rename(temp, this.indexPath);
  }
}

function dependencyStatus(
  pin: CapabilityPackProjectPin,
  records: readonly InstalledCapabilityPack[],
): CapabilityPackProjectDependencyStatus {
  const record = records.find(
    (candidate) =>
      candidate.identity.id === pin.id &&
      candidate.identity.version === pin.version &&
      candidate.identity.releaseDigest === pin.releaseDigest,
  );
  if (record === undefined) return { pin, status: 'missing' };
  if (record.state !== 'installed' || record.health.status !== 'healthy') {
    return {
      pin,
      status: 'unhealthy',
      identity: record.identity,
      detail: record.health.detail ?? `Pack is ${record.state}.`,
    };
  }
  return { pin, status: 'ready', identity: record.identity };
}

function requireProjectId(input: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 200) {
    throw new CapabilityPackStorageError('invalid_state', 'Project id is invalid.');
  }
  return input;
}

async function withIndexLock(rootPath: string, work: () => Promise<void>): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  const lockPath = path.join(rootPath, INDEX_LOCK);
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > INDEX_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (hasCode(statError, 'ENOENT')) continue;
        throw statError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, INDEX_LOCK_POLL_MS));
    }
  }
  try {
    await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/** Remove a committed pack directory after `requestRemoval` has sealed new leases. */
export async function removeCommittedPackDirectory(packPath: string): Promise<void> {
  await rm(packPath, { recursive: true, force: true });
}

/** Canonical logical release identity. */
export function identityKey(identity: CapabilityPackInstallIdentity): string {
  return [
    identity.id,
    identity.version,
    identity.releaseDigest,
    identity.os,
    identity.arch,
    identity.artifactDigest,
  ].join('/');
}

/** Physical artifact key for work that is safe to deduplicate purely by immutable bytes. */
export function artifactIdentityKey(identity: CapabilityPackInstallIdentity): string {
  return [identity.os, identity.arch, identity.artifactDigest].join('/');
}

function findRecord(
  index: CapabilityPackStorageIndex,
  identity: CapabilityPackInstallIdentity,
): InstalledCapabilityPack {
  const record = index.records.find(
    (candidate) => identityKey(candidate.identity) === identityKey(identity),
  );
  if (record === undefined) {
    throw new CapabilityPackStorageError(
      'pack_not_found',
      `Pack ${identityKey(identity)} is not installed.`,
    );
  }
  return record;
}

function resolveInsideRoot(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CapabilityPackStorageError(
      'index_corrupt',
      `Pack path ${relativePath} escapes storage root.`,
    );
  }
  return resolved;
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
