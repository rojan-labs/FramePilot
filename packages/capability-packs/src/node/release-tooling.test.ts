import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical.js';
import type {
  CapabilityPackCatalog,
  CapabilityPackRelease,
  CapabilityPackReleaseCore,
} from '../contracts.js';
import { releaseDigest, verifySignedCatalog } from './catalog-verifier.js';
import {
  preparePackArtifact,
  prepareReleaseForPublication,
  publicationPlan,
  rollbackCatalog,
  signCatalog,
} from './release-tooling.js';

const signingKeys = generateKeyPairSync('ed25519');
const signer = {
  keyId: 'framepilot.release.2026',
  privateKeyPem: signingKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const trustedKeys = [
  {
    keyId: signer.keyId,
    publicKeyPem: signingKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  },
];

function releaseCore(
  id: string,
  artifactDigest: string,
  version = '1.0.0',
): CapabilityPackReleaseCore {
  return {
    id,
    version,
    displayName: id,
    description: `Release for ${id}.`,
    channel: 'stable',
    capabilities: [`${id}.run`],
    licenses: [
      {
        spdx: 'MIT',
        name: 'MIT License',
        noticeUrl: 'https://framepilot.ai/licenses/mit',
        redistribution: 'allowed',
      },
    ],
    privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Runs locally.' },
    compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
    artifacts: [
      {
        os: 'darwin',
        arch: 'arm64',
        url: `https://packs.framepilot.ai/artifacts/${artifactDigest}/worker.zip`,
        sha256: artifactDigest,
        sizeBytes: 10,
        unpackedSizeBytes: 20,
        format: 'zip',
        entrypoint: 'bin/worker',
        maxFileCount: 2,
        files: ['NOTICE.txt', 'bin/worker'],
        executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
      },
    ],
    dependencies: [],
    conflicts: [],
  };
}

function release(id: string, digit: string): CapabilityPackRelease {
  const core = releaseCore(id, digit.repeat(64));
  return { ...core, releaseDigest: releaseDigest(core) };
}

function catalog(releases = [release('framepilot.tracking-lite', 'a')]): CapabilityPackCatalog {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-09-13T00:00:00.000Z',
    releases,
    delegatedKeys: [],
  };
}

describe('preparePackArtifact', () => {
  it('derives the signed artifact allowlist and deterministic file-level SBOM from bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'framepilot-pack-release-'));
    const payload = path.join(root, 'payload');
    const archive = path.join(root, 'worker.zip');
    await mkdir(path.join(payload, 'bin'), { recursive: true });
    await writeFile(path.join(payload, 'bin', 'worker'), 'worker bytes');
    await writeFile(path.join(payload, 'NOTICE.txt'), 'MIT');
    await writeFile(archive, 'archive bytes');
    const archiveDigest = createHash('sha256').update('archive bytes').digest('hex');

    const prepared = await preparePackArtifact({
      packId: 'framepilot.tracking-lite',
      version: '1.0.0',
      payloadRoot: payload,
      archivePath: archive,
      url: `https://packs.framepilot.ai/artifacts/${archiveDigest}/worker.zip`,
      os: 'darwin',
      arch: 'arm64',
      format: 'zip',
      entrypoint: 'bin/worker',
      executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
      licenses: ['MIT', 'MIT'],
      allowedLicenses: ['MIT'],
    });

    expect(prepared.artifact.sha256).toBe(archiveDigest);
    expect(prepared.artifact.files).toEqual(['NOTICE.txt', 'bin/worker']);
    expect(prepared.artifact.maxFileCount).toBe(2);
    expect(prepared.sbom.licenses).toEqual(['MIT']);
    expect(prepared.sbom.files.map((file) => file.path)).toEqual([
      'NOTICE.txt',
      'bin/worker',
    ]);
    expect(prepared.sbom.files[1]?.sha256).toBe(
      createHash('sha256').update('worker bytes').digest('hex'),
    );
  });

  it('rejects disallowed licenses and symlinks before publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'framepilot-pack-unsafe-'));
    const payload = path.join(root, 'payload');
    const archive = path.join(root, 'worker.zip');
    await mkdir(path.join(payload, 'bin'), { recursive: true });
    await writeFile(path.join(payload, 'bin', 'worker'), 'worker');
    await symlink(path.join(payload, 'bin', 'worker'), path.join(payload, 'worker-link'));
    await writeFile(archive, 'archive');
    const common = {
      packId: 'framepilot.tracking-lite',
      version: '1.0.0',
      payloadRoot: payload,
      archivePath: archive,
      url: `https://packs.framepilot.ai/artifacts/${'a'.repeat(64)}/worker.zip`,
      os: 'darwin' as const,
      arch: 'arm64' as const,
      format: 'zip' as const,
      entrypoint: 'bin/worker',
      executableTrust: { kind: 'macos_codesign' as const, teamIdentifier: 'ABCDE12345' },
    };

    await expect(
      preparePackArtifact({
        ...common,
        licenses: ['Proprietary'],
        allowedLicenses: ['MIT'],
      }),
    ).rejects.toThrow('disallowed licenses');
    await expect(
      preparePackArtifact({ ...common, licenses: ['MIT'], allowedLicenses: ['MIT'] }),
    ).rejects.toThrow('contains a symlink');
  });
});

describe('signed publication and rollback', () => {
  it('derives the logical release digest from a validated cross-platform core', () => {
    const core = releaseCore('framepilot.tracking-lite', 'a'.repeat(64));
    expect(prepareReleaseForPublication(core)).toEqual({
      ...core,
      releaseDigest: releaseDigest(core),
    });
  });

  it('signs only truthful releases and creates digest-addressed publication objects', () => {
    const envelope = signCatalog(catalog(), signer);
    expect(
      verifySignedCatalog(envelope, trustedKeys, new Date('2026-08-14T00:00:00.000Z')),
    ).toEqual(envelope);
    const plan = publicationPlan(envelope);
    expect(plan.catalogDigest).toBe(
      createHash('sha256').update(canonicalJson(envelope)).digest('hex'),
    );
    expect(plan.catalogObjectKey).toBe(`catalogs/${plan.catalogDigest}.json`);
    expect(plan.immutableArtifacts[0]?.objectKey).toContain('a'.repeat(64));

    const lying = catalog();
    lying.releases[0]!.releaseDigest = 'f'.repeat(64);
    expect(() => signCatalog(lying, signer)).toThrow('Refusing to sign');
  });

  it('publishes a newer signed rollback catalog while retaining immutable bytes', () => {
    const good = release('framepilot.tracking-lite', 'a');
    const bad = release('framepilot.subject-model', 'b');
    const current = signCatalog(catalog([good, bad]), signer);
    const rollback = rollbackCatalog(
      current,
      [bad.releaseDigest],
      '2026-08-14T00:00:00.000Z',
      '2026-09-14T00:00:00.000Z',
      signer,
    );

    expect(rollback.catalog.releases).toEqual([good]);
    expect(
      verifySignedCatalog(rollback, trustedKeys, new Date('2026-08-15T00:00:00.000Z')),
    ).toEqual(rollback);
    expect(() =>
      rollbackCatalog(
        current,
        [bad.releaseDigest],
        current.catalog.generatedAt,
        '2026-09-14T00:00:00.000Z',
        signer,
      ),
    ).toThrow('advance monotonically');
    expect(() =>
      rollbackCatalog(
        current,
        ['c'.repeat(64)],
        '2026-08-14T00:00:00.000Z',
        '2026-09-14T00:00:00.000Z',
        signer,
      ),
    ).toThrow('did not match');
  });

  it('rejects mutable-looking artifact URLs', () => {
    const mutable = releaseCore('framepilot.tracking-lite', 'a'.repeat(64));
    mutable.artifacts[0]!.url = 'https://packs.framepilot.ai/latest/worker.zip';
    const releaseWithMutableUrl = { ...mutable, releaseDigest: releaseDigest(mutable) };
    const envelope = signCatalog(catalog([releaseWithMutableUrl]), signer);
    expect(() => publicationPlan(envelope)).toThrow('must include its immutable digest');
  });
});
