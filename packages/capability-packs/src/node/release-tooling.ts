import { createHash, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { z } from 'zod/v4';
import {
  CapabilityPackArtifactSchema,
  CapabilityPackCatalogSchema,
  CapabilityPackReleaseCoreSchema,
  CapabilityPackReleaseSchema,
  SignedCapabilityPackCatalogSchema,
  type CapabilityPackArtifact,
  type CapabilityPackCatalog,
  type CapabilityPackRelease,
  type CapabilityPackReleaseCore,
  type SignedCapabilityPackCatalog,
} from '../contracts.js';
import { canonicalJson } from '../canonical.js';
import { releaseDigest } from './catalog-verifier.js';

export interface CapabilityPackSbomFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CapabilityPackSbom {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly version: string;
  readonly licenses: readonly string[];
  readonly files: readonly CapabilityPackSbomFile[];
}

export const PreparePackArtifactInputSchema = z.object({
  packId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  payloadRoot: z.string().min(1),
  archivePath: z.string().min(1),
  url: z.string().url(),
  os: z.enum(['darwin', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  format: z.enum(['raw', 'zip']),
  entrypoint: z.string().min(1),
  executableTrust: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('macos_codesign'), teamIdentifier: z.string().min(1) }),
    z.object({ kind: z.literal('windows_authenticode'), certificateSha256: z.string().min(1) }),
  ]),
  licenses: z.array(z.string().min(1)).min(1),
  allowedLicenses: z.array(z.string().min(1)).min(1),
});

export type PreparePackArtifactInput = z.infer<typeof PreparePackArtifactInputSchema>;

export interface PreparedPackArtifact {
  readonly artifact: CapabilityPackArtifact;
  readonly sbom: CapabilityPackSbom;
}

export interface CatalogSigner {
  readonly keyId: string;
  readonly privateKeyPem: string;
}

export interface CapabilityPackPublicationPlan {
  readonly catalogObjectKey: string;
  readonly catalogDigest: string;
  readonly immutableArtifacts: readonly {
    readonly objectKey: string;
    readonly url: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
}

/** Derive signed artifact facts and a deterministic file-level SBOM from staged payload bytes. */
export async function preparePackArtifact(
  inputValue: PreparePackArtifactInput,
): Promise<PreparedPackArtifact> {
  const input = PreparePackArtifactInputSchema.parse(inputValue);
  const licenses = [...new Set(input.licenses)].sort();
  if (licenses.length === 0) throw new Error('A Capability Pack must declare at least one license.');
  const allowed = new Set(input.allowedLicenses);
  const denied = licenses.filter((license) => !allowed.has(license));
  if (denied.length > 0) throw new Error(`Capability Pack contains disallowed licenses: ${denied.join(', ')}.`);
  const root = path.resolve(input.payloadRoot);
  const files = await inventoryPayload(root);
  if (!files.some((file) => file.path === normalizeRelative(input.entrypoint))) {
    throw new Error('Capability Pack entrypoint is missing from the staged payload.');
  }
  const archive = await stat(input.archivePath);
  if (!archive.isFile()) throw new Error('Capability Pack archive is not a regular file.');
  const artifact = CapabilityPackArtifactSchema.parse({
    os: input.os,
    arch: input.arch,
    url: input.url,
    sha256: await sha256File(input.archivePath),
    sizeBytes: archive.size,
    unpackedSizeBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    format: input.format,
    entrypoint: normalizeRelative(input.entrypoint),
    maxFileCount: files.length,
    files: files.map((file) => file.path),
    executableTrust: input.executableTrust,
  });
  return {
    artifact,
    sbom: {
      schemaVersion: 1,
      packId: input.packId,
      version: input.version,
      licenses,
      files,
    },
  };
}

/** Sign one complete catalog envelope with an offline root or delegated Ed25519 key. */
export function signCatalog(
  catalogInput: CapabilityPackCatalog,
  signer: CatalogSigner,
): SignedCapabilityPackCatalog {
  const catalog = CapabilityPackCatalogSchema.parse(catalogInput);
  for (const release of catalog.releases) {
    const { releaseDigest: declared, ...core } = release;
    const actual = releaseDigest(core);
    if (declared !== actual) {
      throw new Error(
        `Refusing to sign ${release.id}@${release.version}: declared release digest ${declared} does not match ${actual}.`,
      );
    }
  }
  const value = sign(
    null,
    Buffer.from(canonicalJson(catalog)),
    signer.privateKeyPem,
  ).toString('base64');
  return SignedCapabilityPackCatalogSchema.parse({
    catalog,
    signature: { algorithm: 'ed25519', keyId: signer.keyId, value },
  });
}

/** Produce immutable CDN object keys; publication code uploads these before switching latest. */
export function publicationPlan(
  envelopeInput: SignedCapabilityPackCatalog,
): CapabilityPackPublicationPlan {
  const envelope = SignedCapabilityPackCatalogSchema.parse(envelopeInput);
  const catalogDigest = createHash('sha256').update(canonicalJson(envelope)).digest('hex');
  const immutableArtifacts = envelope.catalog.releases
    .flatMap((release) => release.artifacts)
    .map((artifact) => {
      const url = new URL(artifact.url);
      const objectKey = url.pathname.replace(/^\/+/, '');
      if (!objectKey.includes(artifact.sha256)) {
        throw new Error(`Artifact URL must include its immutable digest: ${artifact.url}.`);
      }
      return { objectKey, url: artifact.url, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes };
    })
    .sort((left, right) => compareCanonicalPath(left.objectKey, right.objectKey));
  return {
    catalogObjectKey: `catalogs/${catalogDigest}.json`,
    catalogDigest,
    immutableArtifacts,
  };
}

/** Create a newer signed catalog omitting specified bad immutable releases. */
export function rollbackCatalog(
  currentInput: SignedCapabilityPackCatalog,
  releaseDigests: readonly string[],
  generatedAt: string,
  expiresAt: string,
  signer: CatalogSigner,
): SignedCapabilityPackCatalog {
  const current = SignedCapabilityPackCatalogSchema.parse(currentInput);
  if (Date.parse(generatedAt) <= Date.parse(current.catalog.generatedAt)) {
    throw new Error('Rollback catalog generation time must advance monotonically.');
  }
  const remove = new Set(releaseDigests);
  if (remove.size !== releaseDigests.length) throw new Error('Rollback release digests must be unique.');
  const releases = current.catalog.releases.filter((release) => !remove.has(release.releaseDigest));
  if (releases.length === current.catalog.releases.length) {
    throw new Error('Rollback did not match any published release.');
  }
  return signCatalog({ ...current.catalog, generatedAt, expiresAt, releases }, signer);
}

export function validateReleaseForPublication(release: CapabilityPackRelease): CapabilityPackRelease {
  return CapabilityPackReleaseSchema.parse(release);
}

/** Validate a complete cross-platform release core and derive its immutable logical identity. */
export function prepareReleaseForPublication(
  releaseInput: CapabilityPackReleaseCore,
): CapabilityPackRelease {
  const core = CapabilityPackReleaseCoreSchema.parse(releaseInput);
  return CapabilityPackReleaseSchema.parse({ ...core, releaseDigest: releaseDigest(core) });
}

async function inventoryPayload(root: string): Promise<CapabilityPackSbomFile[]> {
  const output: CapabilityPackSbomFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const details = await lstat(absolute);
      const relative = normalizeRelative(path.relative(root, absolute));
      if (details.isSymbolicLink()) throw new Error(`Capability Pack payload contains a symlink: ${relative}.`);
      if (details.isDirectory()) await walk(absolute);
      else if (details.isFile()) output.push({ path: relative, bytes: details.size, sha256: await sha256File(absolute) });
      else throw new Error(`Capability Pack payload contains an unsupported entry: ${relative}.`);
    }
  };
  await walk(root);
  if (output.length === 0) throw new Error('Capability Pack payload is empty.');
  return output.sort((left, right) => compareCanonicalPath(left.path, right.path));
}

function compareCanonicalPath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Capability Pack path is unsafe: ${value}.`);
  }
  return normalized;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done();
      },
    }),
  );
  return hash.digest('hex');
}
