import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityPackInstallIdentity,
  InstalledCapabilityPack,
} from '../install-contracts.js';
import {
  CapabilityPackStorageError,
  FileCapabilityPackStore,
  removeCommittedPackDirectory,
} from './storage.js';

const roots: string[] = [];
const identity: CapabilityPackInstallIdentity = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin',
  arch: 'arm64',
};

function installedRecord(overrides: Partial<InstalledCapabilityPack> = {}): InstalledCapabilityPack {
  const timestamp = '2026-08-13T00:00:00.000Z';
  return {
    identity,
    state: 'installed',
    installRelativePath: 'packs/framepilot.tracking-lite/1.0.0/darwin-arm64/bbbbbbbb',
    installedBytes: 1_024,
    installedAt: timestamp,
    lastUsedAt: timestamp,
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: {
      checkedAt: timestamp,
      workerProtocolVersion: 1,
      status: 'healthy',
    },
    acquisition: {
      catalogDigest: 'c'.repeat(64),
      approvedAt: timestamp,
      licenseSpdx: ['MIT'],
      mediaEgressApproved: false,
    },
    ...overrides,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-capability-packs-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileCapabilityPackStore', () => {
  it('atomically reconciles ready, missing, and unhealthy logical project pins', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    const healthy = installedRecord();
    const unhealthy = installedRecord({
      identity: { ...identity, id: 'framepilot.unhealthy' },
      health: {
        checkedAt: '2026-08-13T00:00:00.000Z',
        workerProtocolVersion: 1,
        status: 'unhealthy',
        detail: 'worker crashed',
      },
    });
    await store.recordInstalled(healthy);
    await store.recordInstalled(unhealthy);
    const pin = (id: string, version = identity.version, releaseDigest = identity.releaseDigest) => ({
      id,
      version,
      releaseDigest,
      capabilities: ['tracking.face'],
      requiredFor: 'analysis' as const,
    });

    const first = await store.reconcileProjectPins('project-1', [
      pin(identity.id),
      pin('framepilot.unhealthy'),
      pin('framepilot.missing'),
    ]);

    expect(first.map(({ status }) => status)).toEqual(['ready', 'unhealthy', 'missing']);
    expect((await store.list()).find((record) => record.identity.id === identity.id)?.pinnedProjectIds)
      .toEqual(['project-1']);
    expect((await store.list()).find((record) => record.identity.id === 'framepilot.unhealthy')?.pinnedProjectIds)
      .toEqual(['project-1']);

    expect(await store.reconcileProjectPins('project-1', [])).toEqual([]);
    expect((await store.list()).every((record) => record.pinnedProjectIds.length === 0)).toBe(true);
  });

  it('matches a project pin by immutable release identity, not id alone', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    await store.recordInstalled(installedRecord());
    const [status] = await store.reconcileProjectPins('project-1', [{
      id: identity.id,
      version: '2.0.0',
      releaseDigest: 'f'.repeat(64),
      capabilities: ['tracking.face'],
      requiredFor: 'render',
    }]);
    expect(status?.status).toBe('missing');
    expect((await store.list())[0]?.pinnedProjectIds).toEqual([]);
  });

  it('persists an installed record and reloads it from a new authority instance', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);

    expect(await store.list()).toEqual([]);
    await store.recordInstalled(installedRecord());

    expect(await new FileCapabilityPackStore(root).list()).toEqual([installedRecord()]);
  });

  it('blocks removal while pinned or leased, then performs two-phase removal', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    const record = installedRecord();
    const installedPath = path.join(root, record.installRelativePath);
    await mkdir(installedPath, { recursive: true });
    await writeFile(path.join(installedPath, 'worker'), 'binary', 'utf8');
    await store.recordInstalled(record);

    await store.pin(identity, 'project-1');
    await expect(store.requestRemoval(identity)).rejects.toMatchObject({ code: 'pack_pinned' });
    await store.unpin(identity, 'project-1');

    const lease = await store.acquireLease(identity);
    expect(lease.installPath).toBe(installedPath);
    await expect(store.requestRemoval(identity)).rejects.toMatchObject({ code: 'pack_leased' });
    await lease.release();
    await lease.release();

    const removablePath = await store.requestRemoval(identity);
    await expect(store.acquireLease(identity)).rejects.toMatchObject({ code: 'pack_not_found' });
    await removeCommittedPackDirectory(removablePath);
    await store.completeRemoval(identity);

    expect(await store.list()).toEqual([]);
    await expect(readFile(path.join(installedPath, 'worker'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a stale lease count across a fresh store instance instead of resetting it', async () => {
    // A crashed process cannot be told apart, from disk alone, from another live process that
    // still owns this lease. Resetting on every new `FileCapabilityPackStore` (i.e. on every
    // process start) could let process B remove a pack while a live worker in process A still
    // holds it — so a stale count is left in place, conservatively blocking removal, rather
    // than reset to 0 on read.
    const root = await createRoot();
    await writeFile(
      path.join(root, 'index.json'),
      `${JSON.stringify({ schemaVersion: 1, records: [installedRecord({ activeLeaseCount: 3 })] })}\n`,
      'utf8',
    );

    const [record] = await new FileCapabilityPackStore(root).list();
    expect(record?.activeLeaseCount).toBe(3);
    expect(JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'))).toMatchObject({
      records: [{ activeLeaseCount: 3 }],
    });
  });

  it('quarantines a corrupt index and never trusts an escaping install path', async () => {
    const root = await createRoot();
    const malicious = installedRecord({ installRelativePath: '../outside' });
    await writeFile(
      path.join(root, 'index.json'),
      `${JSON.stringify({ schemaVersion: 1, records: [malicious] })}\n`,
      'utf8',
    );
    const store = new FileCapabilityPackStore(root);

    await expect(store.list()).rejects.toBeInstanceOf(CapabilityPackStorageError);
    expect((await readdir(root)).some((name) => name.startsWith('index.json.corrupt-'))).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it('serializes concurrent mutations without dropping project pins', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    await store.recordInstalled(installedRecord());

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.pin(identity, `project-${index}`)));

    const [record] = await store.list();
    expect(record?.pinnedProjectIds).toHaveLength(25);
    expect(new Set(record?.pinnedProjectIds).size).toBe(25);
  });

  it('merges concurrent mutations from separate process-style store instances', async () => {
    const root = await createRoot();
    const otherIdentity: CapabilityPackInstallIdentity = {
      ...identity,
      id: 'framepilot.subject-intelligence',
      artifactDigest: 'd'.repeat(64),
    };
    const first = new FileCapabilityPackStore(root);
    const second = new FileCapabilityPackStore(root);

    await Promise.all([
      first.recordInstalled(installedRecord()),
      second.recordInstalled(
        installedRecord({
          identity: otherIdentity,
          installRelativePath: 'packs/framepilot.subject-intelligence/1.0.0/darwin-arm64/dddddddd',
        }),
      ),
    ]);

    expect((await new FileCapabilityPackStore(root).list()).map((record) => record.identity.id).sort())
      .toEqual(['framepilot.subject-intelligence', 'framepilot.tracking-lite']);
  });

  it('rejects completing removal before the record is sealed', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    await store.recordInstalled(installedRecord());

    await expect(store.completeRemoval(identity)).rejects.toMatchObject({ code: 'invalid_state' });
  });
});
