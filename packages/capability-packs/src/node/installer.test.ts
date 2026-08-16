import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CapabilityPackArtifact,
  CapabilityPackRelease,
  CapabilityPackReleaseCore,
  CapabilityPackWorkerHandshake,
} from '../contracts.js';
import type {
  CapabilityPackInstallApproval,
  CapabilityPackInstallIdentity,
  CapabilityPackInstallProgress,
} from '../install-contracts.js';
import { releaseDigest } from './catalog-verifier.js';
import {
  CapabilityPackInstaller,
  cleanupAbandonedCapabilityPackStaging,
} from './installer.js';
import { CapabilityPackExecutableError } from './executable-verifier.js';
import { FileCapabilityPackStore } from './storage.js';
import { CapabilityPackHealthError } from './worker-health.js';

const roots: string[] = [];
const worker = Buffer.from('signed worker bytes');
const artifactDigest = createHash('sha256').update(worker).digest('hex');
const artifact: CapabilityPackArtifact = {
  os: 'darwin',
  arch: 'arm64',
  url: 'https://packs.framepilot.ai/subject-worker.raw',
  sha256: artifactDigest,
  sizeBytes: worker.byteLength,
  unpackedSizeBytes: worker.byteLength,
  format: 'raw',
  entrypoint: 'bin/subject-worker',
  maxFileCount: 1,
  files: ['bin/subject-worker'],
  executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
};
const releaseCore: CapabilityPackReleaseCore = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  displayName: 'Subject Intelligence',
  description: 'Face and segmentation analysis.',
  channel: 'stable',
  capabilities: ['tracking.face', 'tracking.segmentation'],
  licenses: [
    {
      spdx: 'MIT',
      name: 'MIT License',
      noticeUrl: 'https://framepilot.ai/licenses/subject-intelligence',
      redistribution: 'allowed',
    },
  ],
  privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Runs locally.' },
  compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
  artifacts: [artifact],
  dependencies: [],
  conflicts: [],
};
const release: CapabilityPackRelease = {
  ...releaseCore,
  releaseDigest: releaseDigest(releaseCore),
};
const identity: CapabilityPackInstallIdentity = {
  id: release.id,
  version: release.version,
  releaseDigest: release.releaseDigest,
  artifactDigest,
  os: 'darwin',
  arch: 'arm64',
};
const approval: CapabilityPackInstallApproval = {
  identity,
  approvedSizeBytes: worker.byteLength,
  approvedLicenseSpdx: ['MIT'],
  approvedMediaEgress: false,
  approvedAt: '2026-08-13T00:00:00.000Z',
};
const handshake: CapabilityPackWorkerHandshake = {
  type: 'handshake',
  protocolVersion: 1,
  pack: { id: identity.id, version: identity.version, releaseDigest: identity.releaseDigest },
  capabilities: release.capabilities,
  hardwareBackend: 'metal',
  modelDigests: { segmenter: 'd'.repeat(64) },
};

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-installer-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function response(): Response {
  return new Response(worker, {
    status: 200,
    headers: { etag: '"worker-v1"', 'content-length': String(worker.byteLength) },
  });
}

function installRequest(onProgress?: (progress: CapabilityPackInstallProgress) => void) {
  return {
    operationId: '51cdd51d-7de5-443c-82f3-1ddf605dc4ee',
    identity,
    release,
    artifact,
    catalogDigest: 'c'.repeat(64),
    approval,
    ...(onProgress === undefined ? {} : { onProgress }),
  };
}

function installer(
  root: string,
  fetchMock: typeof fetch,
  overrides: {
    verifyExecutable?: () => Promise<void>;
    healthCheck?: () => Promise<CapabilityPackWorkerHandshake>;
  } = {},
): CapabilityPackInstaller {
  return new CapabilityPackInstaller(root, {
    fetch: fetchMock,
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    dependencies: {
      verifyExecutable: overrides.verifyExecutable ?? (async () => undefined),
      healthCheck: overrides.healthCheck ?? (async () => handshake),
    },
  });
}

describe('CapabilityPackInstaller', () => {
  it('commits a healthy pack and receipt atomically after every verification stage', async () => {
    const root = await createRoot();
    const progress: CapabilityPackInstallProgress[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const subject = installer(root, fetchMock);

    const record = await subject.install(installRequest((event) => progress.push(event)));

    const installedPath = path.join(root, record.installRelativePath);
    expect(record.state).toBe('installed');
    expect(record.health.status).toBe('healthy');
    expect(await readFile(path.join(installedPath, artifact.entrypoint))).toEqual(worker);
    expect(JSON.parse(await readFile(path.join(installedPath, '.framepilot-install.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, record: { identity, state: 'installed' } });
    expect((await new FileCapabilityPackStore(root).list())[0]).toEqual(record);
    expect(progress.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        'reserving_space',
        'downloading',
        'verifying',
        'extracting',
        'checking_executable',
        'health_checking',
        'committing',
        'installed',
      ]),
    );

    expect(await subject.install(installRequest())).toEqual(record);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects stale approval before network or filesystem mutation', async () => {
    const root = await createRoot();
    const fetchMock = vi.fn<typeof fetch>();
    const subject = installer(root, fetchMock);
    const staleApproval = { ...approval, approvedLicenseSpdx: ['Apache-2.0'] };

    await expect(
      subject.install({ ...installRequest(), approval: staleApproval }),
    ).rejects.toMatchObject({ code: 'approval_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a presentation-only progress observer break the install transaction', async () => {
    const root = await createRoot();
    const subject = installer(root, vi.fn<typeof fetch>().mockResolvedValue(response()));

    const record = await subject.install(
      installRequest(() => {
        throw new Error('renderer closed');
      }),
    );

    expect(record.state).toBe('installed');
    expect((await new FileCapabilityPackStore(root).list())[0]?.state).toBe('installed');
  });

  it('quarantines extracted bytes when the worker fails its health contract', async () => {
    const root = await createRoot();
    const subject = installer(root, vi.fn<typeof fetch>().mockResolvedValue(response()), {
      healthCheck: async () => {
        throw new CapabilityPackHealthError('protocol_mismatch', 'wrong release identity');
      },
    });

    await expect(subject.install(installRequest())).rejects.toMatchObject({ code: 'quarantined' });

    const [record] = await new FileCapabilityPackStore(root).list();
    expect(record).toMatchObject({ state: 'quarantined', health: { status: 'unhealthy' } });
    expect(await readFile(path.join(root, record!.installRelativePath, artifact.entrypoint))).toEqual(
      worker,
    );
    await expect(
      stat(path.join(root, 'packs', identity.id, identity.version)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the filesystem lock and disk refresh to deduplicate separate installer instances', async () => {
    const root = await createRoot();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    let releaseVerifier: (() => void) | undefined;
    const verifierEntered = vi.fn();
    const first = installer(root, fetchMock, {
      verifyExecutable: async () => {
        verifierEntered();
        await new Promise<void>((resolve) => {
          releaseVerifier = resolve;
        });
      },
    });
    const second = installer(root, fetchMock);

    const firstInstall = first.install(installRequest());
    await vi.waitFor(() => expect(verifierEntered).toHaveBeenCalledOnce());
    const secondInstall = second.install(installRequest());
    releaseVerifier?.();

    expect(await secondInstall).toEqual(await firstInstall);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers a committed receipt after a crash between directory and index commits', async () => {
    const root = await createRoot();
    await installer(root, vi.fn<typeof fetch>().mockResolvedValue(response())).install(installRequest());
    await rm(path.join(root, 'index.json'));
    const fetchMock = vi.fn<typeof fetch>();
    const verifier = vi.fn(async () => undefined);
    const recoveredBy = installer(root, fetchMock, { verifyExecutable: verifier });

    const recovered = await recoveredBy.install(installRequest());

    expect(recovered.health.detail).toContain('Recovered after interrupted index commit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledOnce();
    expect((await new FileCapabilityPackStore(root).list())[0]?.state).toBe('installed');
  });

  it('cleans staging on cancellation without creating installed or quarantined state', async () => {
    const root = await createRoot();
    const subject = installer(root, vi.fn<typeof fetch>().mockResolvedValue(response()), {
      verifyExecutable: async () => {
        throw new CapabilityPackExecutableError('download_cancelled', 'cancelled');
      },
    });

    await expect(subject.install(installRequest())).rejects.toMatchObject({
      code: 'download_cancelled',
    });
    expect(await new FileCapabilityPackStore(root).list()).toEqual([]);
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
  });
});

describe('cleanupAbandonedCapabilityPackStaging', () => {
  it('removes only old disposable staging paths', async () => {
    const root = await createRoot();
    const staging = path.join(root, 'staging');
    const oldPath = path.join(staging, '.staging-old');
    const freshPath = path.join(staging, '.staging-fresh');
    const unrelated = path.join(staging, 'keep-me');
    await Promise.all([
      mkdir(oldPath, { recursive: true }),
      mkdir(freshPath, { recursive: true }),
      mkdir(unrelated, { recursive: true }),
    ]);
    const now = Date.now();
    await utimes(oldPath, new Date(now - 10_000), new Date(now - 10_000));

    expect(await cleanupAbandonedCapabilityPackStaging(root, 5_000, now)).toEqual([oldPath]);
    expect(await readdir(staging)).toEqual(expect.arrayContaining(['.staging-fresh', 'keep-me']));
  });
});
