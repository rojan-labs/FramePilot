import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  type CapabilityPackCatalog,
  type CapabilityPackReleaseCore,
  type InstalledCapabilityPack,
} from '@framepilot/capability-packs';
import {
  FileCapabilityPackStore,
  releaseDigest,
} from '@framepilot/capability-packs/node';
import { CapabilityPackDesktopService } from './service.js';

const roots: string[] = [];
const now = new Date('2026-08-13T00:00:00.000Z');
const signer = generateKeyPairSync('ed25519');
const keyId = 'framepilot.offline.2026';
const trustedRootKeys = [
  {
    keyId,
    publicKeyPem: signer.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  },
];
const artifact = {
  os: 'darwin' as const,
  arch: 'arm64' as const,
  url: 'https://packs.framepilot.ai/subject.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  unpackedSizeBytes: 250,
  format: 'zip' as const,
  entrypoint: 'bin/worker',
  maxFileCount: 1,
  files: ['bin/worker'],
  executableTrust: { kind: 'macos_codesign' as const, teamIdentifier: 'ABCDE12345' },
};
const releaseCore: CapabilityPackReleaseCore = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  displayName: 'Subject Intelligence',
  description: 'Automatic face and subject tracking.',
  channel: 'stable',
  capabilities: ['tracking.face', 'tracking.segmentation'],
  licenses: [
    {
      spdx: 'MIT',
      name: 'MIT License',
      noticeUrl: 'https://framepilot.ai/licenses/subject',
      redistribution: 'allowed',
    },
  ],
  privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Runs locally.' },
  compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
  artifacts: [artifact],
  dependencies: [],
  conflicts: [],
};
const release = { ...releaseCore, releaseDigest: releaseDigest(releaseCore) };

function signedCatalog(): unknown {
  const catalog: CapabilityPackCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-08-12T00:00:00.000Z',
    expiresAt: '2026-09-12T00:00:00.000Z',
    releases: [structuredClone(release)],
    delegatedKeys: [],
  };
  return {
    catalog,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, Buffer.from(canonicalJson(catalog)), signer.privateKey).toString('base64'),
    },
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-desktop-packs-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function catalogFetch(input: unknown = signedCatalog()): typeof fetch {
  const body = JSON.stringify(input);
  return vi.fn<typeof fetch>().mockImplementation(async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) },
    }),
  );
}

function service(
  rootPath: string,
  overrides: Partial<ConstructorParameters<typeof CapabilityPackDesktopService>[0]> = {},
): CapabilityPackDesktopService {
  return new CapabilityPackDesktopService({
    rootPath,
    catalogUrl: 'https://packs.framepilot.ai/catalog.json',
    trustedRootKeys,
    appVersion: '1.0.0',
    platform: { os: 'darwin', arch: 'arm64' },
    fetch: catalogFetch(),
    now: () => now,
    onProgress: vi.fn(),
    ...overrides,
  });
}

describe('CapabilityPackDesktopService', () => {
  it('returns typed blocking policy while reconciling exact project pins', async () => {
    const root = await createRoot();
    const subject = service(root);
    const result = await subject.reconcileProject('project-1', [
      {
        id: release.id,
        version: release.version,
        releaseDigest: release.releaseDigest,
        capabilities: ['tracking.face'],
        requiredFor: 'render',
      },
      {
        id: 'framepilot.edit-runtime',
        version: '1.0.0',
        releaseDigest: 'f'.repeat(64),
        capabilities: ['edit.semantic'],
        requiredFor: 'edit',
      },
    ]);

    expect(result.dependencies.map(({ status }) => status)).toEqual(['missing', 'missing']);
    expect(result).toMatchObject({ renderBlocked: true, editBlocked: true });
  });

  it('exposes only a healthy signed local Whisper runtime to the sidecar', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    const timestamp = now.toISOString();
    const installRelativePath = `packs/framepilot.local-whisper/1.0.0/darwin-arm64/${artifact.sha256}`;
    await mkdir(path.join(root, installRelativePath, 'bin'), { recursive: true });
    await mkdir(path.join(root, installRelativePath, 'models'), { recursive: true });
    await writeFile(path.join(root, installRelativePath, 'bin/whisper-cli'), 'signed worker', 'utf8');
    await store.recordInstalled({
      identity: {
        id: 'framepilot.local-whisper',
        version: '1.0.0',
        releaseDigest: release.releaseDigest,
        artifactDigest: artifact.sha256,
        os: 'darwin',
        arch: 'arm64',
      },
      state: 'installed',
      installRelativePath,
      installedBytes: 574_041_195,
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
    });

    expect(await service(root).runtimeEnvironment()).toEqual({
      FRAMEPILOT_WHISPER_CLI: path.join(root, installRelativePath, 'bin/whisper-cli'),
      FRAMEPILOT_ASR_MODEL_DIR: path.join(root, installRelativePath, 'models'),
    });
  });

  it('proposes only the project-pinned release and pins it after explicit install', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    const timestamp = now.toISOString();
    const installed: InstalledCapabilityPack = {
      identity: {
        id: release.id,
        version: release.version,
        releaseDigest: release.releaseDigest,
        artifactDigest: artifact.sha256,
        os: 'darwin',
        arch: 'arm64',
      },
      state: 'installed',
      installRelativePath: `packs/${release.id}/${release.version}/darwin-arm64/${artifact.sha256}`,
      installedBytes: 250,
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
    };
    const installer = {
      install: vi.fn(async () => {
        await mkdir(path.join(root, installed.installRelativePath), { recursive: true });
        await store.recordInstalled(installed);
        return installed;
      }),
    };
    const subject = service(root, { installer });
    const proposalResult = await subject.proposeProjectDependency('project-1', {
      id: release.id,
      version: release.version,
      releaseDigest: release.releaseDigest,
      capabilities: ['tracking.face'],
      requiredFor: 'analysis',
    });
    expect(proposalResult.ok).toBe(true);
    if (!proposalResult.ok) return;
    const proposal = proposalResult.proposal;
    const started = subject.startInstall({
      proposalId: proposal.proposalId,
      identity: proposal.identity,
      approvedSizeBytes: proposal.downloadBytes,
      approvedLicenseSpdx: proposal.licenses.map(({ spdx }) => spdx),
      approvedMediaEgress: proposal.privacy.mediaLeavesDevice,
      approvedAt: timestamp,
    });
    expect(started.ok).toBe(true);
    await vi.waitFor(async () => {
      await store.refresh();
      expect((await store.list())[0]?.pinnedProjectIds).toEqual(['project-1']);
    });

    expect(await subject.proposeProjectDependency('project-1', {
      id: release.id,
      version: '9.0.0',
      releaseDigest: 'f'.repeat(64),
      capabilities: ['tracking.face'],
      requiredFor: 'analysis',
    })).toMatchObject({ ok: false, code: 'dependency_missing' });
  });

  it('returns only main-verified signed proposal facts for one capability id', async () => {
    const root = await createRoot();
    const result = await service(root).propose('tracking.face');

    expect(result).toMatchObject({
      ok: true,
      proposal: {
        identity: {
          id: release.id,
          version: release.version,
          releaseDigest: release.releaseDigest,
          artifactDigest: artifact.sha256,
          os: 'darwin',
          arch: 'arm64',
        },
        downloadBytes: 100,
        installedBytes: 250,
        licenses: [{ spdx: 'MIT' }],
        privacy: { mediaLeavesDevice: false },
      },
    });
  });

  it('fails closed for a tampered catalog or a renderer-supplied invalid capability id', async () => {
    const root = await createRoot();
    const tampered = signedCatalog() as {
      catalog: CapabilityPackCatalog;
      signature: { algorithm: 'ed25519'; keyId: string; value: string };
    };
    tampered.catalog.releases[0]!.displayName = 'Tampered';
    const subject = service(root, { fetch: catalogFetch(tampered) });

    expect(await subject.propose('tracking.face')).toMatchObject({ ok: false, code: 'signature_invalid' });
    expect(await subject.propose('../tracking.face')).toMatchObject({ ok: false });
  });

  it('starts only an exact unexpired approval and keeps cancellation in main', async () => {
    const root = await createRoot();
    let installRequest: Parameters<NonNullable<ConstructorParameters<typeof CapabilityPackDesktopService>[0]['installer']>['install']>[0] | undefined;
    const installer = {
      install: vi.fn(async (request) => {
        installRequest = request;
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw Object.assign(new Error('cancelled'), { code: 'download_cancelled' });
      }),
    };
    const progress = vi.fn();
    const subject = service(root, { installer, onProgress: progress });
    const proposalResult = await subject.propose('tracking.face');
    if (!proposalResult.ok) throw new Error(JSON.stringify(proposalResult));
    expect(proposalResult).toMatchObject({ ok: true });
    const proposal = proposalResult.proposal;

    const stale = subject.startInstall({
      proposalId: proposal.proposalId,
      identity: proposal.identity,
      approvedSizeBytes: proposal.downloadBytes,
      approvedLicenseSpdx: ['Apache-2.0'],
      approvedMediaEgress: proposal.privacy.mediaLeavesDevice,
      approvedAt: now.toISOString(),
    });
    expect(stale).toMatchObject({ ok: false, code: 'approval_required' });
    expect(installer.install).not.toHaveBeenCalled();

    const started = subject.startInstall({
      proposalId: proposal.proposalId,
      identity: proposal.identity,
      approvedSizeBytes: proposal.downloadBytes,
      approvedLicenseSpdx: proposal.licenses.map((license) => license.spdx),
      approvedMediaEgress: proposal.privacy.mediaLeavesDevice,
      approvedAt: now.toISOString(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(installRequest?.signal?.aborted).toBe(false);
    subject.cancel(started.operationId);
    expect(installRequest?.signal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'cancelled' })),
    );
  });

  it('reports storage and executes only the exact unexpired cleanup plan', async () => {
    const root = await createRoot();
    const store = new FileCapabilityPackStore(root);
    const timestamp = now.toISOString();
    const record: InstalledCapabilityPack = {
      identity: {
        id: release.id,
        version: release.version,
        releaseDigest: release.releaseDigest,
        artifactDigest: artifact.sha256,
        os: 'darwin',
        arch: 'arm64',
      },
      state: 'installed',
      installRelativePath: `packs/${release.id}/${release.version}/darwin-arm64/${artifact.sha256}`,
      installedBytes: 250,
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
    };
    await mkdir(path.join(root, record.installRelativePath), { recursive: true });
    await store.recordInstalled(record);
    const subject = service(root);

    expect(await subject.storage()).toMatchObject({ totalBytes: 250, reclaimableBytes: 250 });
    const planned = await subject.planEviction(200);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      await subject.executeEviction({ planId: planned.plan.planId, approvedIdentityKeys: [] }),
    ).toMatchObject({ ok: false });

    const approvedKeys = planned.plan.candidates.map((candidate) =>
      [
        candidate.identity.id,
        candidate.identity.version,
        candidate.identity.os,
        candidate.identity.arch,
        candidate.identity.artifactDigest,
      ].join('/'),
    );
    const result = await subject.executeEviction({
      planId: planned.plan.planId,
      approvedIdentityKeys: approvedKeys,
    });
    expect(result).toMatchObject({ ok: false, code: 'approval_required' });
    // A mismatched approval consumes the stale plan so it cannot be replayed with broader authority.
    expect(await stat(path.join(root, record.installRelativePath))).toBeDefined();

    const replanned = await subject.planEviction(200);
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) return;
    const exactKeys = replanned.plan.candidates.map((candidate) =>
      [
        candidate.identity.id,
        candidate.identity.version,
        candidate.identity.os,
        candidate.identity.arch,
        candidate.identity.artifactDigest,
      ].join('/'),
    );
    expect(
      await subject.executeEviction({
        planId: replanned.plan.planId,
        approvedIdentityKeys: exactKeys,
      }),
    ).toMatchObject({ ok: true, storage: { totalBytes: 0 } });
    await expect(stat(path.join(root, record.installRelativePath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps the old root authoritative until a validated relocation is committed', async () => {
    const source = await createRoot();
    const destinationParent = await createRoot();
    const destination = path.join(destinationParent, 'custom-packs');
    const store = new FileCapabilityPackStore(source);
    const timestamp = now.toISOString();
    const installed: InstalledCapabilityPack = {
      identity: {
        id: release.id,
        version: release.version,
        releaseDigest: release.releaseDigest,
        artifactDigest: artifact.sha256,
        os: 'darwin',
        arch: 'arm64',
      },
      state: 'installed',
      installRelativePath: `packs/${release.id}/${release.version}/darwin-arm64/${artifact.sha256}`,
      installedBytes: 6,
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
    };
    await mkdir(path.join(source, installed.installRelativePath), { recursive: true });
    await store.recordInstalled(installed);
    const subject = service(source);
    let committed = false;

    await subject.relocateStorage(destination, async () => {
      expect(subject.startInstall({})).toMatchObject({ ok: false, code: 'relocation_in_progress' });
      expect((await new FileCapabilityPackStore(destination).list())).toHaveLength(1);
      committed = true;
    });

    expect(committed).toBe(true);
    expect(subject.storageRoot).toBe(source);
    expect((await new FileCapabilityPackStore(source).list())).toHaveLength(1);
  });

  it('reports catalog setup as unavailable instead of trusting renderer data', async () => {
    const root = await createRoot();
    const subject = service(root, { catalogUrl: undefined, trustedRootKeys: [] });
    expect(await subject.propose('tracking.face')).toMatchObject({ ok: false });
  });
});
