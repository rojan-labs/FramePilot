import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical.js';
import type {
  CapabilityPackCatalog,
  CapabilityPackReleaseCore,
} from '../contracts.js';
import { releaseDigest } from './catalog-verifier.js';
import { FileCapabilityPackCatalogTrust } from './catalog-trust.js';

const roots: string[] = [];
const offline = generateKeyPairSync('ed25519');
const online = generateKeyPairSync('ed25519');
const child = generateKeyPairSync('ed25519');
const offlineKeyId = 'framepilot.offline.2026';
const onlineKeyId = 'framepilot.online.2026';
const childKeyId = 'framepilot.child.2026';
const publicPem = (key: KeyObject): string =>
  key.export({ format: 'pem', type: 'spki' }).toString();
const trustedRoots = [{ keyId: offlineKeyId, publicKeyPem: publicPem(offline.publicKey) }];

const releaseCore: CapabilityPackReleaseCore = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  displayName: 'Tracking Lite',
  description: 'Tracking analysis.',
  channel: 'stable',
  capabilities: ['tracking.point'],
  licenses: [
    {
      spdx: 'MIT',
      name: 'MIT License',
      noticeUrl: 'https://framepilot.ai/licenses/tracking-lite',
      redistribution: 'allowed',
    },
  ],
  privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Runs locally.' },
  compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
  artifacts: [
    {
      os: 'darwin',
      arch: 'arm64',
      url: 'https://packs.framepilot.ai/tracking-lite.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      unpackedSizeBytes: 200,
      format: 'zip',
      entrypoint: 'bin/worker',
      maxFileCount: 1,
      files: ['bin/worker'],
      executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
    },
  ],
  dependencies: [],
  conflicts: [],
};

const onlineDelegation = {
  keyId: onlineKeyId,
  publicKeyPem: publicPem(online.publicKey),
  validFrom: '2026-08-01T00:00:00.000Z',
  validUntil: '2026-10-01T00:00:00.000Z',
};

function catalog(
  generatedAt: string,
  delegatedKeys: CapabilityPackCatalog['delegatedKeys'] = [],
): CapabilityPackCatalog {
  return {
    schemaVersion: 1,
    generatedAt,
    expiresAt: '2026-09-30T00:00:00.000Z',
    releases: [{ ...releaseCore, releaseDigest: releaseDigest(releaseCore) }],
    delegatedKeys,
  };
}

function envelope(input: CapabilityPackCatalog, keyId: string, privateKey: KeyObject) {
  return {
    catalog: input,
    signature: {
      algorithm: 'ed25519' as const,
      keyId,
      value: sign(null, Buffer.from(canonicalJson(input)), privateKey).toString('base64'),
    },
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-catalog-trust-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileCapabilityPackCatalogTrust', () => {
  it('accepts a root-authorized time-bounded online key on the next catalog', async () => {
    const root = await createRoot();
    const trust = new FileCapabilityPackCatalogTrust(root, trustedRoots);
    await trust.verifyAndAdvance(
      envelope(catalog('2026-08-10T00:00:00.000Z', [onlineDelegation]), offlineKeyId, offline.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );

    const verified = await trust.verifyAndAdvance(
      envelope(catalog('2026-08-11T00:00:00.000Z'), onlineKeyId, online.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );

    expect(verified.signature.keyId).toBe(onlineKeyId);
  });

  it('does not allow an online key to delegate trust transitively', async () => {
    const root = await createRoot();
    const trust = new FileCapabilityPackCatalogTrust(root, trustedRoots);
    await trust.verifyAndAdvance(
      envelope(catalog('2026-08-10T00:00:00.000Z', [onlineDelegation]), offlineKeyId, offline.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );
    const childDelegation = {
      keyId: childKeyId,
      publicKeyPem: publicPem(child.publicKey),
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-10-01T00:00:00.000Z',
    };

    await expect(
      trust.verifyAndAdvance(
        envelope(catalog('2026-08-11T00:00:00.000Z', [childDelegation]), onlineKeyId, online.privateKey),
        new Date('2026-08-13T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('enforces delegated validity and root-signed revocation', async () => {
    const root = await createRoot();
    const trust = new FileCapabilityPackCatalogTrust(root, trustedRoots);
    await trust.verifyAndAdvance(
      envelope(catalog('2026-08-10T00:00:00.000Z', [onlineDelegation]), offlineKeyId, offline.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );
    await expect(
      trust.verifyAndAdvance(
        envelope(catalog('2026-09-29T00:00:00.000Z'), onlineKeyId, online.privateKey),
        new Date('2026-10-02T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'signature_invalid' });

    await trust.verifyAndAdvance(
      envelope(catalog('2026-08-12T00:00:00.000Z'), offlineKeyId, offline.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );
    await expect(
      trust.verifyAndAdvance(
        envelope(catalog('2026-08-13T00:00:00.000Z'), onlineKeyId, online.privateKey),
        new Date('2026-08-13T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('rejects older catalogs and a conflicting catalog with the same generation time', async () => {
    const root = await createRoot();
    const trust = new FileCapabilityPackCatalogTrust(root, trustedRoots);
    await trust.verifyAndAdvance(
      envelope(catalog('2026-08-12T00:00:00.000Z'), offlineKeyId, offline.privateKey),
      new Date('2026-08-13T00:00:00Z'),
    );
    await expect(
      trust.verifyAndAdvance(
        envelope(catalog('2026-08-11T00:00:00.000Z'), offlineKeyId, offline.privateKey),
        new Date('2026-08-13T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'catalog_invalid' });

    const conflicting = catalog('2026-08-12T00:00:00.000Z');
    conflicting.releases[0]!.displayName = 'Conflicting catalog';
    const { releaseDigest: _ignored, ...conflictingCore } = conflicting.releases[0]!;
    conflicting.releases[0]!.releaseDigest = releaseDigest(conflictingCore);
    await expect(
      trust.verifyAndAdvance(envelope(conflicting, offlineKeyId, offline.privateKey), new Date('2026-08-13T00:00:00Z')),
    ).rejects.toMatchObject({ code: 'catalog_invalid' });
  });

  it('quarantines corrupt durable trust state instead of resetting trust', async () => {
    const root = await createRoot();
    await writeFile(path.join(root, 'catalog-trust.json'), '{broken', 'utf8');
    const trust = new FileCapabilityPackCatalogTrust(root, trustedRoots);

    await expect(
      trust.verifyAndAdvance(
        envelope(catalog('2026-08-12T00:00:00.000Z'), offlineKeyId, offline.privateKey),
        new Date('2026-08-13T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'catalog_invalid' });
    expect((await readdir(root)).some((name) => name.startsWith('catalog-trust.json.corrupt-'))).toBe(
      true,
    );
  });
});
