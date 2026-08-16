import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  CapabilityPackReleaseCoreSchema,
  SignedCapabilityPackCatalogSchema,
  type CapabilityPackCatalog,
  type CapabilityPackRelease,
  type SignedCapabilityPackCatalog,
} from '../contracts.js';
import { canonicalJson } from '../canonical.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface TrustedCatalogKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export class CapabilityPackCatalogError extends Error {
  constructor(
    public readonly code:
      | 'catalog_invalid'
      | 'catalog_expired'
      | 'signature_invalid'
      | 'release_digest_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackCatalogError';
  }
}

export function releaseDigest(release: Omit<CapabilityPackRelease, 'releaseDigest'>): string {
  const core = CapabilityPackReleaseCoreSchema.parse(release);
  return createHash('sha256').update(canonicalJson(core)).digest('hex');
}

export function verifySignedCatalog(
  input: unknown,
  trustedKeys: readonly TrustedCatalogKey[],
  now: Date = new Date(),
): SignedCapabilityPackCatalog {
  const parsed = SignedCapabilityPackCatalogSchema.safeParse(input);
  if (!parsed.success) {
    throw new CapabilityPackCatalogError('catalog_invalid', parsed.error.message);
  }
  const envelope = parsed.data;
  const trusted = trustedKeys.find((key) => key.keyId === envelope.signature.keyId);
  if (!trusted) {
    throw new CapabilityPackCatalogError(
      'signature_invalid',
      `Catalog signature key ${envelope.signature.keyId} is not trusted.`,
    );
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(trusted.publicKeyPem);
  } catch (error) {
    throw new CapabilityPackCatalogError(
      'signature_invalid',
      `Trusted catalog key ${trusted.keyId} is malformed: ${errorMessage(error)}`,
    );
  }
  const signature = Buffer.from(envelope.signature.value, 'base64');
  const valid = verify(
    null,
    Buffer.from(canonicalJson(envelope.catalog), 'utf8'),
    publicKey,
    signature,
  );
  if (!valid) {
    throw new CapabilityPackCatalogError(
      'signature_invalid',
      `Catalog signature from ${trusted.keyId} did not verify.`,
    );
  }
  if (Date.parse(envelope.catalog.generatedAt) > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new CapabilityPackCatalogError(
      'catalog_invalid',
      `Catalog generation time ${envelope.catalog.generatedAt} is implausibly in the future.`,
    );
  }
  if (Date.parse(envelope.catalog.expiresAt) <= now.getTime()) {
    throw new CapabilityPackCatalogError(
      'catalog_expired',
      `Catalog expired at ${envelope.catalog.expiresAt}. Installed packs remain usable.`,
    );
  }
  verifyReleaseDigests(envelope.catalog);
  return envelope;
}

function verifyReleaseDigests(catalog: CapabilityPackCatalog): void {
  for (const release of catalog.releases) {
    const { releaseDigest: declared, ...core } = release;
    const actual = releaseDigest(core);
    if (declared !== actual) {
      throw new CapabilityPackCatalogError(
        'release_digest_invalid',
        `Release ${release.id}@${release.version} declares ${declared} but hashes to ${actual}.`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
