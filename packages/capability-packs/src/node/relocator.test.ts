import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPackInstallIdentity, InstalledCapabilityPack } from '../install-contracts.js';
import { prepareCapabilityPackRelocation } from './relocator.js';
import { FileCapabilityPackStore } from './storage.js';

const roots: string[] = [];
const identity: CapabilityPackInstallIdentity = {
  id: 'framepilot.subject-intelligence',
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin',
  arch: 'arm64',
};

async function createRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `framepilot-${label}-`));
  roots.push(root);
  return root;
}

function record(): InstalledCapabilityPack {
  const timestamp = '2026-08-13T00:00:00.000Z';
  return {
    identity,
    state: 'installed',
    installRelativePath: `packs/${identity.id}/1.0.0/darwin-arm64/${identity.artifactDigest}`,
    installedBytes: 6,
    installedAt: timestamp,
    lastUsedAt: timestamp,
    pinnedProjectIds: ['project-1'],
    activeLeaseCount: 0,
    health: { checkedAt: timestamp, workerProtocolVersion: 1, status: 'healthy' },
    acquisition: {
      catalogDigest: 'c'.repeat(64),
      approvedAt: timestamp,
      licenseSpdx: ['MIT'],
      mediaEgressApproved: false,
    },
  };
}

async function seededSource(): Promise<{ root: string; store: FileCapabilityPackStore }> {
  const root = await createRoot('source');
  const store = new FileCapabilityPackStore(root);
  const installed = record();
  await mkdir(path.join(root, installed.installRelativePath, 'bin'), { recursive: true });
  await writeFile(path.join(root, installed.installRelativePath, 'bin/worker'), 'worker', 'utf8');
  await store.recordInstalled(installed);
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('prepareCapabilityPackRelocation', () => {
  it('copies and validates committed state while leaving the source authoritative', async () => {
    const source = await seededSource();
    const parent = await createRoot('destination-parent');
    const destination = path.join(parent, 'Capability Packs');

    const result = await prepareCapabilityPackRelocation({
      sourceRoot: source.root,
      destinationRoot: destination,
      sourceStore: source.store,
    });

    expect(result.recordCount).toBe(1);
    expect(await readFile(path.join(destination, record().installRelativePath, 'bin/worker'), 'utf8'))
      .toBe('worker');
    expect((await new FileCapabilityPackStore(destination).list())[0]?.pinnedProjectIds).toEqual([
      'project-1',
    ]);
    expect(await readFile(path.join(source.root, record().installRelativePath, 'bin/worker'), 'utf8'))
      .toBe('worker');
  });

  it('rejects active leases before copying any bytes', async () => {
    const source = await seededSource();
    const lease = await source.store.acquireLease(identity);
    const parent = await createRoot('destination-parent');
    const destination = path.join(parent, 'packs');

    await expect(
      prepareCapabilityPackRelocation({
        sourceRoot: source.root,
        destinationRoot: destination,
        sourceStore: source.store,
      }),
    ).rejects.toMatchObject({ code: 'pack_leased' });
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.release();
  });

  it('rejects nonempty, nested, and symlink-bearing destinations or sources', async () => {
    const source = await seededSource();
    const parent = await createRoot('destination-parent');
    const nonempty = path.join(parent, 'nonempty');
    await mkdir(nonempty);
    await writeFile(path.join(nonempty, 'mine.txt'), 'do not overwrite', 'utf8');
    await expect(
      prepareCapabilityPackRelocation({ sourceRoot: source.root, destinationRoot: nonempty, sourceStore: source.store }),
    ).rejects.toMatchObject({ code: 'invalid_destination' });
    expect(await readFile(path.join(nonempty, 'mine.txt'), 'utf8')).toBe('do not overwrite');

    await expect(
      prepareCapabilityPackRelocation({
        sourceRoot: source.root,
        destinationRoot: path.join(source.root, 'nested'),
        sourceStore: source.store,
      }),
    ).rejects.toMatchObject({ code: 'invalid_destination' });

    await symlink('/tmp', path.join(source.root, 'unexpected-link'));
    await expect(
      prepareCapabilityPackRelocation({
        sourceRoot: source.root,
        destinationRoot: path.join(parent, 'clean'),
        sourceStore: source.store,
      }),
    ).rejects.toMatchObject({ code: 'relocation_failed' });
    expect((await readdir(parent)).filter((name) => name.includes('.relocating-'))).toEqual([]);
  });

  it('cancels without committing a destination and keeps source bytes', async () => {
    const source = await seededSource();
    const parent = await createRoot('destination-parent');
    const destination = path.join(parent, 'packs');
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareCapabilityPackRelocation({
        sourceRoot: source.root,
        destinationRoot: destination,
        sourceStore: source.store,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'relocation_cancelled' });
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(source.root, record().installRelativePath, 'bin/worker'), 'utf8'))
      .toBe('worker');
  });
});
