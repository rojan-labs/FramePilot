import { z } from 'zod/v4';

export const CAPABILITY_PACK_CATALOG_VERSION = 1 as const;
export const CAPABILITY_PACK_WORKER_PROTOCOL_VERSION = 1 as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const SemanticVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'pack URLs must use HTTPS');
const RelativePackPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), 'path must be relative')
  .refine(
    (value) => !value.split(/[\\/]/u).includes('..'),
    'path traversal segments are forbidden',
  );

const ExecutableTrustSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('macos_codesign'),
    teamIdentifier: z.string().regex(/^[A-Z0-9]{10}$/),
  }),
  z.object({
    kind: z.literal('windows_authenticode'),
    certificateSha256: Sha256Schema,
  }),
]);

export const CapabilityPackPlatformSchema = z.object({
  os: z.enum(['darwin', 'win32']),
  arch: z.enum(['arm64', 'x64']),
});

export const CapabilityPackArtifactSchema = CapabilityPackPlatformSchema.extend({
  url: HttpsUrlSchema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024 * 1024),
  unpackedSizeBytes: z.number().int().positive().max(40 * 1024 * 1024 * 1024),
  format: z.enum(['raw', 'zip']),
  entrypoint: RelativePackPathSchema,
  maxFileCount: z.number().int().positive().max(100_000),
  files: z.array(RelativePackPathSchema).min(1).max(100_000),
  executableTrust: ExecutableTrustSchema,
}).superRefine((artifact, context) => {
  if (!artifact.files.includes(artifact.entrypoint)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entrypoint'],
      message: 'entrypoint must appear in the artifact file allowlist',
    });
  }
  if (new Set(artifact.files).size !== artifact.files.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: 'artifact file allowlist contains duplicates',
    });
  }
  if (artifact.unpackedSizeBytes < artifact.sizeBytes && artifact.format === 'raw') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unpackedSizeBytes'],
      message: 'a raw artifact cannot unpack smaller than its download',
    });
  }
  if (artifact.format === 'raw' && artifact.files.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: 'a raw artifact must contain exactly its one entrypoint file',
    });
  }
  if (artifact.os === 'darwin' && artifact.executableTrust.kind !== 'macos_codesign') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executableTrust'],
      message: 'a macOS artifact requires a macOS code-signing identity',
    });
  }
  if (artifact.os === 'win32' && artifact.executableTrust.kind !== 'windows_authenticode') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executableTrust'],
      message: 'a Windows artifact requires an Authenticode certificate identity',
    });
  }
});

export const CapabilityPackLicenseSchema = z.object({
  spdx: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  noticeUrl: HttpsUrlSchema,
  redistribution: z.enum(['allowed', 'restricted', 'forbidden']),
});

export const CapabilityPackReleaseCoreSchema = z.object({
  id: IdentifierSchema,
  version: SemanticVersionSchema,
  displayName: z.string().min(1).max(160),
  description: z.string().min(1).max(2_000),
  channel: z.enum(['stable', 'beta', 'nightly']),
  capabilities: z.array(IdentifierSchema).min(1).max(128),
  licenses: z.array(CapabilityPackLicenseSchema).min(1).max(32),
  privacy: z.object({
    execution: z.enum(['local', 'cloud', 'hybrid']),
    mediaLeavesDevice: z.boolean(),
    disclosure: z.string().min(1).max(2_000),
  }),
  compatibility: z.object({
    minAppVersion: SemanticVersionSchema,
    maxAppVersionExclusive: SemanticVersionSchema.optional(),
    workerProtocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
  }),
  artifacts: z.array(CapabilityPackArtifactSchema).min(1).max(16),
  dependencies: z
    .array(
      z.object({
        id: IdentifierSchema,
        version: SemanticVersionSchema,
        releaseDigest: Sha256Schema,
      }),
    )
    .max(32)
    .default([]),
  conflicts: z.array(IdentifierSchema).max(32).default([]),
}).superRefine((release, context) => {
  if (new Set(release.capabilities).size !== release.capabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilities'],
      message: 'release capabilities contain duplicates',
    });
  }
  const platformKeys = release.artifacts.map((artifact) => `${artifact.os}/${artifact.arch}`);
  if (new Set(platformKeys).size !== platformKeys.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['artifacts'],
      message: 'a release may publish only one artifact per platform and architecture',
    });
  }
  if (release.conflicts.includes(release.id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conflicts'],
      message: 'a release cannot conflict with itself',
    });
  }
});

export const CapabilityPackReleaseSchema = CapabilityPackReleaseCoreSchema.and(
  z.object({ releaseDigest: Sha256Schema }),
);

export const DelegatedCatalogKeySchema = z.object({
  keyId: IdentifierSchema,
  publicKeyPem: z.string().min(64).max(8_192),
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
});

export const CapabilityPackCatalogSchema = z.object({
  schemaVersion: z.literal(CAPABILITY_PACK_CATALOG_VERSION),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  releases: z.array(CapabilityPackReleaseSchema).max(10_000),
  delegatedKeys: z.array(DelegatedCatalogKeySchema).max(16).default([]),
}).superRefine((catalog, context) => {
  if (Date.parse(catalog.expiresAt) <= Date.parse(catalog.generatedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'catalog must expire after it was generated',
    });
  }
  const identities = catalog.releases.map((release) => `${release.id}@${release.version}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['releases'],
      message: 'catalog contains a duplicate pack release identity',
    });
  }
  const delegatedIds = catalog.delegatedKeys.map((key) => key.keyId);
  if (new Set(delegatedIds).size !== delegatedIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['delegatedKeys'],
      message: 'catalog contains duplicate delegated key ids',
    });
  }
  catalog.delegatedKeys.forEach((key, index) => {
    if (Date.parse(key.validUntil) <= Date.parse(key.validFrom)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delegatedKeys', index, 'validUntil'],
        message: 'delegated key must expire after it becomes valid',
      });
    }
  });
});

export const SignedCapabilityPackCatalogSchema = z.object({
  catalog: CapabilityPackCatalogSchema,
  signature: z.object({
    algorithm: z.literal('ed25519'),
    keyId: IdentifierSchema,
    value: z.string().base64().max(256),
  }),
});

export const CapabilityPackWorkerHandshakeSchema = z.object({
  type: z.literal('handshake'),
  protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
  pack: z.object({
    id: IdentifierSchema,
    version: SemanticVersionSchema,
    releaseDigest: Sha256Schema,
  }),
  capabilities: z.array(IdentifierSchema).min(1).max(128),
  hardwareBackend: z.string().min(1).max(128),
  modelDigests: z.record(z.string().min(1).max(160), Sha256Schema).default({}),
});

export const CapabilityPackErrorCodeSchema = z.enum([
  'catalog_invalid',
  'catalog_expired',
  'signature_invalid',
  'release_digest_invalid',
  'platform_unsupported',
  'app_incompatible',
  'approval_required',
  'insufficient_space',
  'download_failed',
  'download_cancelled',
  'artifact_corrupt',
  'archive_unsafe',
  'executable_untrusted',
  'health_check_failed',
  'dependency_missing',
  'dependency_conflict',
  'pack_pinned',
  'pack_leased',
  'protocol_mismatch',
  'quarantined',
]);

export type CapabilityPackPlatform = z.infer<typeof CapabilityPackPlatformSchema>;
export type CapabilityPackArtifact = z.infer<typeof CapabilityPackArtifactSchema>;
export type CapabilityPackReleaseCore = z.infer<typeof CapabilityPackReleaseCoreSchema>;
export type CapabilityPackRelease = z.infer<typeof CapabilityPackReleaseSchema>;
export type CapabilityPackCatalog = z.infer<typeof CapabilityPackCatalogSchema>;
export type SignedCapabilityPackCatalog = z.infer<typeof SignedCapabilityPackCatalogSchema>;
export type CapabilityPackWorkerHandshake = z.infer<typeof CapabilityPackWorkerHandshakeSchema>;
export type CapabilityPackErrorCode = z.infer<typeof CapabilityPackErrorCodeSchema>;
