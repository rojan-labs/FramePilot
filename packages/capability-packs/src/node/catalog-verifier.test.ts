import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical.js';
import type { CapabilityPackCatalog, CapabilityPackReleaseCore } from '../contracts.js';
import {
  CapabilityPackCatalogError,
  releaseDigest,
  verifySignedCatalog,
} from './catalog-verifier.js';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();

const releaseCore: CapabilityPackReleaseCore = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  displayName: 'Tracking Lite',
  description: 'Point, region, and planar tracking.',
  channel: 'stable',
  capabilities: ['tracking.point', 'tracking.region', 'tracking.planar'],
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
      url: 'https://packs.framepilot.ai/tracking-lite/1.0.0/darwin-arm64.zip',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      unpackedSizeBytes: 200,
      format: 'zip',
      entrypoint: 'bin/tracking-worker',
      maxFileCount: 10,
      files: ['bin/tracking-worker', 'NOTICE.txt'],
      executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
    },
  ],
  dependencies: [],
  conflicts: [],
};

const catalog = (): CapabilityPackCatalog => ({
  schemaVersion: 1,
  generatedAt: '2026-08-13T00:00:00.000Z',
  expiresAt: '2026-09-13T00:00:00.000Z',
  releases: [{ ...releaseCore, releaseDigest: releaseDigest(releaseCore) }],
  delegatedKeys: [],
});

function envelope(input: CapabilityPackCatalog = catalog()) {
  return {
    catalog: input,
    signature: {
      algorithm: 'ed25519',
      keyId: 'framepilot.release.2026',
      value: sign(null, Buffer.from(canonicalJson(input)), keys.privateKey).toString('base64'),
    },
  };
}

const trusted = [{ keyId: 'framepilot.release.2026', publicKeyPem }];

describe('verifySignedCatalog', () => {
  it('verifies the Ed25519 envelope and every logical release digest', () => {
    const verified = verifySignedCatalog(envelope(), trusted, new Date('2026-08-14T00:00:00Z'));
    expect(verified.catalog.releases[0]?.id).toBe('framepilot.tracking-lite');
  });

  it('rejects a catalog changed after it was signed', () => {
    const signed = envelope();
    signed.catalog.releases[0]!.displayName = 'Tampered';
    expect(() => verifySignedCatalog(signed, trusted, new Date('2026-08-14T00:00:00Z'))).toThrow(
      expect.objectContaining({ code: 'signature_invalid' }),
    );
  });

  it('rejects a correctly signed catalog whose release digest lies', () => {
    const bad = catalog();
    bad.releases[0]!.releaseDigest = 'f'.repeat(64);
    expect(() => verifySignedCatalog(envelope(bad), trusted, new Date('2026-08-14T00:00:00Z'))).toThrow(
      expect.objectContaining({ code: 'release_digest_invalid' }),
    );
  });

  it('rejects expired catalogs without disabling already installed packs', () => {
    expect(() => verifySignedCatalog(envelope(), trusted, new Date('2026-10-01T00:00:00Z'))).toThrow(
      expect.objectContaining({ code: 'catalog_expired' }),
    );
  });

  it('rejects a signed future-dated catalog before it can freeze rollback state', () => {
    const future = catalog();
    future.generatedAt = '2026-09-01T00:00:00.000Z';
    expect(() =>
      verifySignedCatalog(envelope(future), trusted, new Date('2026-08-14T00:00:00Z')),
    ).toThrow(expect.objectContaining({ code: 'catalog_invalid' }));
  });

  it('rejects an unknown key and a malformed trusted key with typed errors', () => {
    expect(() => verifySignedCatalog(envelope(), [], new Date('2026-08-14T00:00:00Z'))).toThrow(
      expect.objectContaining({ code: 'signature_invalid' }),
    );
    expect(() =>
      verifySignedCatalog(
        envelope(),
        [{ keyId: 'framepilot.release.2026', publicKeyPem: 'not a key' }],
        new Date('2026-08-14T00:00:00Z'),
      ),
    ).toThrow(CapabilityPackCatalogError);
  });
});
