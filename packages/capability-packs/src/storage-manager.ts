import type {
  CapabilityPackInstallIdentity,
  InstalledCapabilityPack,
} from './install-contracts.js';

export interface CapabilityPackStorageSummary {
  readonly totalBytes: number;
  readonly installedBytes: number;
  readonly quarantinedBytes: number;
  readonly pendingRemovalBytes: number;
  readonly reclaimableBytes: number;
  readonly recordCount: number;
  readonly projectUsage: Readonly<Record<string, number>>;
}

export interface CapabilityPackRemovalImpact {
  readonly identity: CapabilityPackInstallIdentity;
  readonly installedBytes: number;
  readonly affectedProjectIds: readonly string[];
  readonly activeLeaseCount: number;
  readonly removable: boolean;
}

export interface CapabilityPackEvictionPlan {
  readonly requestedBytes: number;
  readonly reclaimableBytes: number;
  readonly sufficient: boolean;
  readonly candidates: readonly CapabilityPackRemovalImpact[];
}

export interface CapabilityPackStorageAuthority {
  list(): Promise<readonly InstalledCapabilityPack[]>;
  requestRemoval(identity: CapabilityPackInstallIdentity): Promise<string>;
  completeRemoval(identity: CapabilityPackInstallIdentity): Promise<void>;
}

export type CapabilityPackDirectoryRemover = (packPath: string) => Promise<void>;

/** Host-neutral accounting and explicit removal policy for the Storage Manager workflow. */
export class CapabilityPackStorageManager {
  constructor(
    private readonly store: CapabilityPackStorageAuthority,
    private readonly removeDirectory: CapabilityPackDirectoryRemover,
  ) {}

  async summary(): Promise<CapabilityPackStorageSummary> {
    const records = await this.store.list();
    const projectUsage: Record<string, number> = {};
    let installedBytes = 0;
    let quarantinedBytes = 0;
    let pendingRemovalBytes = 0;
    let reclaimableBytes = 0;
    for (const record of records) {
      if (record.state === 'installed') installedBytes += record.installedBytes;
      else if (record.state === 'quarantined') quarantinedBytes += record.installedBytes;
      else pendingRemovalBytes += record.installedBytes;
      if (record.pinnedProjectIds.length === 0 && record.activeLeaseCount === 0) {
        reclaimableBytes += record.installedBytes;
      }
      for (const projectId of record.pinnedProjectIds) {
        projectUsage[projectId] = (projectUsage[projectId] ?? 0) + record.installedBytes;
      }
    }
    return {
      totalBytes: installedBytes + quarantinedBytes + pendingRemovalBytes,
      installedBytes,
      quarantinedBytes,
      pendingRemovalBytes,
      reclaimableBytes,
      recordCount: records.length,
      projectUsage,
    };
  }

  async impact(identity: CapabilityPackInstallIdentity): Promise<CapabilityPackRemovalImpact | undefined> {
    const record = (await this.store.list()).find(
      (candidate) => identityKey(candidate.identity) === identityKey(identity),
    );
    return record === undefined ? undefined : removalImpact(record);
  }

  /** Build an LRU proposal only; callers must display and explicitly approve its exact identities. */
  async planEviction(requestedBytes: number): Promise<CapabilityPackEvictionPlan> {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      throw new RangeError('requestedBytes must be a positive safe integer');
    }
    const candidates = (await this.store.list())
      .filter(
        (record) =>
          record.state !== 'pending_removal' &&
          record.pinnedProjectIds.length === 0 &&
          record.activeLeaseCount === 0,
      )
      .sort((left, right) => {
        if (left.state === 'quarantined' && right.state !== 'quarantined') return -1;
        if (right.state === 'quarantined' && left.state !== 'quarantined') return 1;
        return Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt);
      });
    const selected: CapabilityPackRemovalImpact[] = [];
    let reclaimableBytes = 0;
    for (const record of candidates) {
      if (reclaimableBytes >= requestedBytes) break;
      selected.push(removalImpact(record));
      reclaimableBytes += record.installedBytes;
    }
    return {
      requestedBytes,
      reclaimableBytes,
      sufficient: reclaimableBytes >= requestedBytes,
      candidates: selected,
    };
  }

  /** Execute only the exact plan the user approved; store guards recheck pins and leases. */
  async executeEviction(
    plan: CapabilityPackEvictionPlan,
    approvedIdentityKeys: readonly string[],
  ): Promise<number> {
    const plannedKeys = plan.candidates.map((candidate) => identityKey(candidate.identity));
    if (
      new Set(approvedIdentityKeys).size !== approvedIdentityKeys.length ||
      JSON.stringify([...approvedIdentityKeys].sort()) !== JSON.stringify([...plannedKeys].sort())
    ) {
      throw new Error('Eviction approval does not exactly match the displayed plan.');
    }
    let removedBytes = 0;
    for (const candidate of plan.candidates) {
      const path = await this.store.requestRemoval(candidate.identity);
      await this.removeDirectory(path);
      await this.store.completeRemoval(candidate.identity);
      removedBytes += candidate.installedBytes;
    }
    return removedBytes;
  }
}

export function capabilityPackIdentityKey(identity: CapabilityPackInstallIdentity): string {
  return identityKey(identity);
}

function removalImpact(record: InstalledCapabilityPack): CapabilityPackRemovalImpact {
  return {
    identity: record.identity,
    installedBytes: record.installedBytes,
    affectedProjectIds: [...record.pinnedProjectIds],
    activeLeaseCount: record.activeLeaseCount,
    removable: record.pinnedProjectIds.length === 0 && record.activeLeaseCount === 0,
  };
}

function identityKey(identity: CapabilityPackInstallIdentity): string {
  return [
    identity.id,
    identity.version,
    identity.os,
    identity.arch,
    identity.artifactDigest,
  ].join('/');
}
