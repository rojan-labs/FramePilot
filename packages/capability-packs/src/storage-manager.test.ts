import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityPackInstallIdentity,
  InstalledCapabilityPack,
} from './install-contracts.js';
import {
  CapabilityPackStorageManager,
  capabilityPackIdentityKey,
  type CapabilityPackStorageAuthority,
} from './storage-manager.js';

const timestamp = '2026-08-13T00:00:00.000Z';

function identity(id: string, digestCharacter: string): CapabilityPackInstallIdentity {
  return {
    id,
    version: '1.0.0',
    releaseDigest: 'a'.repeat(64),
    artifactDigest: digestCharacter.repeat(64),
    os: 'darwin',
    arch: 'arm64',
  };
}

function record(
  id: string,
  digestCharacter: string,
  overrides: Partial<InstalledCapabilityPack> = {},
): InstalledCapabilityPack {
  const packIdentity = identity(id, digestCharacter);
  return {
    identity: packIdentity,
    state: 'installed',
    installRelativePath: `packs/${id}/1.0.0/darwin-arm64/${digestCharacter.repeat(8)}`,
    installedBytes: 100,
    installedAt: timestamp,
    lastUsedAt: timestamp,
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: timestamp, workerProtocolVersion: 1, status: 'healthy' },
    acquisition: {
      catalogDigest: 'c'.repeat(64),
      approvedAt: timestamp,
      licenseSpdx: ['MIT'],
      mediaEgressApproved: false,
    },
    ...overrides,
  };
}

class MemoryStore implements CapabilityPackStorageAuthority {
  constructor(public records: InstalledCapabilityPack[]) {}

  async list(): Promise<readonly InstalledCapabilityPack[]> {
    return this.records;
  }

  async requestRemoval(packIdentity: CapabilityPackInstallIdentity): Promise<string> {
    const target = this.records.find(
      (candidate) => capabilityPackIdentityKey(candidate.identity) === capabilityPackIdentityKey(packIdentity),
    );
    if (target === undefined) throw new Error('missing');
    if (target.pinnedProjectIds.length > 0 || target.activeLeaseCount > 0) throw new Error('blocked');
    target.state = 'pending_removal';
    return `/pack-root/${target.installRelativePath}`;
  }

  async completeRemoval(packIdentity: CapabilityPackInstallIdentity): Promise<void> {
    this.records = this.records.filter(
      (candidate) => capabilityPackIdentityKey(candidate.identity) !== capabilityPackIdentityKey(packIdentity),
    );
  }
}

describe('CapabilityPackStorageManager', () => {
  it('reports state totals, reclaimable bytes, and shared per-project usage', async () => {
    const store = new MemoryStore([
      record('framepilot.tracking-lite', 'b', {
        installedBytes: 200,
        pinnedProjectIds: ['project-a', 'project-b'],
      }),
      record('framepilot.subject-intelligence', 'd', {
        state: 'quarantined',
        installedBytes: 300,
      }),
      record('framepilot.speech', 'e', {
        state: 'pending_removal',
        installedBytes: 50,
      }),
    ]);

    expect(await new CapabilityPackStorageManager(store, async () => undefined).summary()).toEqual({
      totalBytes: 550,
      installedBytes: 200,
      quarantinedBytes: 300,
      pendingRemovalBytes: 50,
      reclaimableBytes: 350,
      recordCount: 3,
      projectUsage: { 'project-a': 200, 'project-b': 200 },
    });
  });

  it('reports affected projects and live leases before removal', async () => {
    const target = record('framepilot.subject-intelligence', 'd', {
      pinnedProjectIds: ['documentary'],
      activeLeaseCount: 2,
    });
    const manager = new CapabilityPackStorageManager(new MemoryStore([target]), async () => undefined);

    expect(await manager.impact(target.identity)).toEqual({
      identity: target.identity,
      installedBytes: 100,
      affectedProjectIds: ['documentary'],
      activeLeaseCount: 2,
      removable: false,
    });
  });

  it('proposes quarantined bytes first, then least-recently-used unpinned packs', async () => {
    const store = new MemoryStore([
      record('framepilot.new', 'b', { installedBytes: 100, lastUsedAt: '2026-08-12T00:00:00Z' }),
      record('framepilot.old', 'c', { installedBytes: 100, lastUsedAt: '2026-08-01T00:00:00Z' }),
      record('framepilot.bad', 'd', { state: 'quarantined', installedBytes: 50 }),
      record('framepilot.pinned', 'e', { installedBytes: 1_000, pinnedProjectIds: ['project'] }),
      record('framepilot.leased', 'f', { installedBytes: 1_000, activeLeaseCount: 1 }),
    ]);

    const plan = await new CapabilityPackStorageManager(store, async () => undefined).planEviction(120);

    expect(plan.sufficient).toBe(true);
    expect(plan.reclaimableBytes).toBe(150);
    expect(plan.candidates.map((candidate) => candidate.identity.id)).toEqual([
      'framepilot.bad',
      'framepilot.old',
    ]);
  });

  it('removes only the exact identities explicitly approved from the displayed plan', async () => {
    const first = record('framepilot.first', 'b', { installedBytes: 100 });
    const second = record('framepilot.second', 'c', { installedBytes: 100 });
    const store = new MemoryStore([first, second]);
    const removeDirectory = vi.fn(async () => undefined);
    const manager = new CapabilityPackStorageManager(store, removeDirectory);
    const plan = await manager.planEviction(150);

    await expect(
      manager.executeEviction(plan, [capabilityPackIdentityKey(first.identity)]),
    ).rejects.toThrow('does not exactly match');
    expect(store.records).toHaveLength(2);

    const approved = plan.candidates.map((candidate) => capabilityPackIdentityKey(candidate.identity));
    expect(await manager.executeEviction(plan, approved)).toBe(200);
    expect(store.records).toEqual([]);
    expect(removeDirectory).toHaveBeenCalledTimes(2);
  });

  it('reports an insufficient plan without deleting anything', async () => {
    const store = new MemoryStore([record('framepilot.small', 'b', { installedBytes: 10 })]);
    const manager = new CapabilityPackStorageManager(store, async () => undefined);

    expect(await manager.planEviction(100)).toMatchObject({
      requestedBytes: 100,
      reclaimableBytes: 10,
      sufficient: false,
    });
    expect(store.records).toHaveLength(1);
  });
});
