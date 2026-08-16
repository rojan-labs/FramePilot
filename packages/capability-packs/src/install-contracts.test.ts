import { describe, expect, it } from 'vitest';
import {
  CapabilityPackInstallProgressSchema,
  CapabilityPackStorageIndexSchema,
  InstalledCapabilityPackSchema,
  canAdvanceInstallPhase,
} from './install-contracts.js';

const identity = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin' as const,
  arch: 'arm64' as const,
};

const record = {
  identity,
  state: 'installed' as const,
  installRelativePath: 'framepilot.tracking-lite/1.0.0/darwin-arm64',
  installedBytes: 200,
  installedAt: '2026-08-13T00:00:00.000Z',
  lastUsedAt: '2026-08-13T00:00:00.000Z',
  pinnedProjectIds: ['project-a'],
  activeLeaseCount: 0,
  health: {
    checkedAt: '2026-08-13T00:00:00.000Z',
    workerProtocolVersion: 1,
    status: 'healthy' as const,
  },
  acquisition: {
    catalogDigest: 'c'.repeat(64),
    approvedAt: '2026-08-13T00:00:00.000Z',
    licenseSpdx: ['MIT'],
    mediaEgressApproved: false,
  },
};

describe('Capability Pack install contracts', () => {
  it('pins storage records to relative paths and immutable identities', () => {
    expect(InstalledCapabilityPackSchema.parse(record)).toEqual(record);
    expect(
      InstalledCapabilityPackSchema.safeParse({ ...record, installRelativePath: '../escape' }).success,
    ).toBe(false);
  });

  it('rejects removal while a worker still holds a lease', () => {
    expect(
      InstalledCapabilityPackSchema.safeParse({
        ...record,
        state: 'pending_removal',
        activeLeaseCount: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate installed identities in the atomic index', () => {
    expect(
      CapabilityPackStorageIndexSchema.safeParse({ schemaVersion: 1, records: [record, record] })
        .success,
    ).toBe(false);
  });

  it('bounds progress and requires typed failure details', () => {
    const base = {
      operationId: '7644e219-2314-4b7f-9f53-551a8f5e24ca',
      identity,
      phase: 'downloading',
      completedBytes: 50,
      totalBytes: 100,
    } as const;
    expect(CapabilityPackInstallProgressSchema.safeParse(base).success).toBe(true);
    expect(
      CapabilityPackInstallProgressSchema.safeParse({ ...base, completedBytes: 101 }).success,
    ).toBe(false);
    expect(
      CapabilityPackInstallProgressSchema.safeParse({ ...base, phase: 'failed' }).success,
    ).toBe(false);
  });

  it('allows only monotonic lifecycle transitions and seals terminal operations', () => {
    expect(canAdvanceInstallPhase('awaiting_approval', 'reserving_space')).toBe(true);
    expect(canAdvanceInstallPhase('downloading', 'verifying')).toBe(true);
    expect(canAdvanceInstallPhase('verifying', 'downloading')).toBe(false);
    expect(canAdvanceInstallPhase('installed', 'downloading')).toBe(false);
    expect(canAdvanceInstallPhase('cancelled', 'reserving_space')).toBe(false);
  });
});
