import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { canonicalJson } from '../canonical.js';
import { DelegatedCatalogKeySchema, type SignedCapabilityPackCatalog } from '../contracts.js';
import {
  CapabilityPackCatalogError,
  verifySignedCatalog,
  type TrustedCatalogKey,
} from './catalog-verifier.js';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const CatalogTrustStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastGeneratedAt: z.string().datetime().optional(),
  lastCatalogDigest: Sha256Schema.optional(),
  delegatedKeys: z.array(DelegatedCatalogKeySchema).max(16),
});

type CatalogTrustState = z.infer<typeof CatalogTrustStateSchema>;

/** Durable trust/rollback authority rooted only in public keys embedded in the application. */
export class FileCapabilityPackCatalogTrust {
  private readonly statePath: string;

  constructor(
    rootPath: string,
    private readonly embeddedRootKeys: readonly TrustedCatalogKey[],
  ) {
    this.statePath = path.join(rootPath, 'catalog-trust.json');
  }

  async verifyAndAdvance(
    input: unknown,
    now: Date = new Date(),
  ): Promise<SignedCapabilityPackCatalog> {
    const state = await this.load();
    const candidate = envelopeIdentity(input);
    const rootSigner = this.embeddedRootKeys.some((key) => key.keyId === candidate.keyId);
    const activeDelegates = state.delegatedKeys
      .filter(
        (key) => Date.parse(key.validFrom) <= now.getTime() && now.getTime() < Date.parse(key.validUntil),
      )
      .map((key) => ({ keyId: key.keyId, publicKeyPem: key.publicKeyPem }));
    const verified = verifySignedCatalog(
      input,
      rootSigner ? this.embeddedRootKeys : activeDelegates,
      now,
    );
    if (
      rootSigner &&
      verified.catalog.delegatedKeys.some((delegated) =>
        this.embeddedRootKeys.some((root) => root.keyId === delegated.keyId),
      )
    ) {
      throw new CapabilityPackCatalogError(
        'signature_invalid',
        'A delegated key id cannot shadow an embedded root key.',
      );
    }
    if (!rootSigner && verified.catalog.delegatedKeys.length > 0) {
      throw new CapabilityPackCatalogError(
        'signature_invalid',
        'A delegated catalog signer cannot authorize another signing key.',
      );
    }
    const digest = catalogDigest(verified);
    assertNotRollback(state, verified.catalog.generatedAt, digest);
    const nextState: CatalogTrustState = {
      schemaVersion: 1,
      lastGeneratedAt: verified.catalog.generatedAt,
      lastCatalogDigest: digest,
      delegatedKeys: rootSigner ? verified.catalog.delegatedKeys : state.delegatedKeys,
    };
    await this.write(nextState);
    return verified;
  }

  private async load(): Promise<CatalogTrustState> {
    try {
      return CatalogTrustStateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, delegatedKeys: [] };
      const quarantine = `${this.statePath}.corrupt-${Date.now()}`;
      await rename(this.statePath, quarantine).catch(() => undefined);
      throw new CapabilityPackCatalogError(
        'catalog_invalid',
        `Capability Pack trust state was quarantined at ${quarantine}: ${errorMessage(error)}`,
      );
    }
  }

  private async write(state: CatalogTrustState): Promise<void> {
    const validated = CatalogTrustStateSchema.parse(state);
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(temporary, this.statePath);
  }
}

function envelopeIdentity(input: unknown): { keyId: string } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('signature' in input) ||
    typeof input.signature !== 'object' ||
    input.signature === null ||
    !('keyId' in input.signature) ||
    typeof input.signature.keyId !== 'string'
  ) {
    throw new CapabilityPackCatalogError('catalog_invalid', 'Catalog envelope has no signature key.');
  }
  return { keyId: input.signature.keyId };
}

function catalogDigest(envelope: SignedCapabilityPackCatalog): string {
  return createHash('sha256').update(canonicalJson(envelope.catalog)).digest('hex');
}

function assertNotRollback(
  state: CatalogTrustState,
  generatedAt: string,
  digest: string,
): void {
  if (state.lastGeneratedAt === undefined) return;
  const order = Date.parse(generatedAt) - Date.parse(state.lastGeneratedAt);
  if (order < 0 || (order === 0 && state.lastCatalogDigest !== digest)) {
    throw new CapabilityPackCatalogError(
      'catalog_invalid',
      'Catalog is older than, or conflicts with, the last trusted catalog.',
    );
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
