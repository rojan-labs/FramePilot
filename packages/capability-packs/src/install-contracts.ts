import { z } from 'zod/v4';
import { CapabilityPackPlatformSchema } from './contracts.js';

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
const RelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), 'path must be relative')
  .refine((value) => !value.split(/[\\/]/u).includes('..'), 'path traversal is forbidden');

export const CapabilityPackInstallPhaseSchema = z.enum([
  'awaiting_approval',
  'reserving_space',
  'downloading',
  'verifying',
  'extracting',
  'checking_executable',
  'health_checking',
  'committing',
  'installed',
  'cancelled',
  'failed',
]);

export const CapabilityPackInstallIdentitySchema = CapabilityPackPlatformSchema.extend({
  id: IdentifierSchema,
  version: SemanticVersionSchema,
  releaseDigest: Sha256Schema,
  artifactDigest: Sha256Schema,
});

export const CapabilityPackInstallApprovalSchema = z.object({
  identity: CapabilityPackInstallIdentitySchema,
  approvedSizeBytes: z.number().int().positive(),
  approvedLicenseSpdx: z.array(z.string().min(1).max(128)).min(1).max(32),
  approvedMediaEgress: z.boolean(),
  approvedAt: z.string().datetime(),
});

export const CapabilityPackInstallProgressSchema = z.object({
  operationId: z.string().uuid(),
  identity: CapabilityPackInstallIdentitySchema,
  phase: CapabilityPackInstallPhaseSchema,
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  detail: z.string().max(1_000).optional(),
  errorCode: z.string().max(128).optional(),
}).superRefine((progress, context) => {
  if (progress.completedBytes > progress.totalBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedBytes'],
      message: 'completed bytes cannot exceed total bytes',
    });
  }
  if (progress.phase === 'failed' && progress.errorCode === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'failed progress requires a typed error code',
    });
  }
});

export const InstalledCapabilityPackSchema = z.object({
  identity: CapabilityPackInstallIdentitySchema,
  state: z.enum(['installed', 'quarantined', 'pending_removal']),
  installRelativePath: RelativePathSchema,
  installedBytes: z.number().int().positive(),
  installedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  pinnedProjectIds: z.array(z.string().min(1).max(256)).max(10_000),
  activeLeaseCount: z.number().int().nonnegative(),
  health: z.object({
    checkedAt: z.string().datetime(),
    workerProtocolVersion: z.number().int().positive(),
    status: z.enum(['healthy', 'unhealthy']),
    detail: z.string().max(2_000).optional(),
  }),
  acquisition: z.object({
    catalogDigest: Sha256Schema,
    approvedAt: z.string().datetime(),
    licenseSpdx: z.array(z.string().min(1).max(128)).min(1).max(32),
    mediaEgressApproved: z.boolean(),
  }),
}).superRefine((record, context) => {
  if (new Set(record.pinnedProjectIds).size !== record.pinnedProjectIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pinnedProjectIds'],
      message: 'project pins contain duplicates',
    });
  }
  if (record.state === 'pending_removal' && record.activeLeaseCount > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeLeaseCount'],
      message: 'a leased pack cannot enter pending removal',
    });
  }
});

export const CapabilityPackStorageIndexSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(InstalledCapabilityPackSchema).max(10_000),
}).superRefine((index, context) => {
  const identities = index.records.map((record) => {
    const identity = record.identity;
    return [
      identity.id,
      identity.version,
      identity.releaseDigest,
      identity.os,
      identity.arch,
      identity.artifactDigest,
    ].join('/');
  });
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['records'],
      message: 'storage index contains duplicate installed release identities',
    });
  }
});

/** Platform-neutral project dependency used to reconcile durable storage pins. */
export const CapabilityPackProjectPinSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  version: z.string().min(1).max(64).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/),
  releaseDigest: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.array(z.string().min(1).max(160)).min(1).max(64),
  requiredFor: z.enum(['render', 'edit', 'analysis']),
}).strict();

export const CapabilityPackProjectDependencyStatusSchema = z.object({
  pin: CapabilityPackProjectPinSchema,
  status: z.enum(['ready', 'missing', 'unhealthy']),
  identity: CapabilityPackInstallIdentitySchema.optional(),
  detail: z.string().max(1_000).optional(),
}).strict();

const TERMINAL_PHASES = new Set(['installed', 'cancelled', 'failed']);
const NEXT_PHASES: Readonly<Record<string, readonly string[]>> = {
  awaiting_approval: ['reserving_space', 'cancelled'],
  reserving_space: ['downloading', 'failed', 'cancelled'],
  downloading: ['verifying', 'failed', 'cancelled'],
  verifying: ['extracting', 'checking_executable', 'failed', 'cancelled'],
  extracting: ['checking_executable', 'failed', 'cancelled'],
  checking_executable: ['health_checking', 'failed', 'cancelled'],
  health_checking: ['committing', 'failed', 'cancelled'],
  committing: ['installed', 'failed'],
};

/** Monotonic install lifecycle. A terminal operation can never restart under the same id. */
export function canAdvanceInstallPhase(
  current: z.infer<typeof CapabilityPackInstallPhaseSchema>,
  next: z.infer<typeof CapabilityPackInstallPhaseSchema>,
): boolean {
  if (TERMINAL_PHASES.has(current)) return false;
  return NEXT_PHASES[current]?.includes(next) ?? false;
}

export type CapabilityPackInstallIdentity = z.infer<typeof CapabilityPackInstallIdentitySchema>;
export type CapabilityPackInstallApproval = z.infer<typeof CapabilityPackInstallApprovalSchema>;
export type CapabilityPackInstallProgress = z.infer<typeof CapabilityPackInstallProgressSchema>;
export type InstalledCapabilityPack = z.infer<typeof InstalledCapabilityPackSchema>;
export type CapabilityPackStorageIndex = z.infer<typeof CapabilityPackStorageIndexSchema>;
export type CapabilityPackProjectPin = z.infer<typeof CapabilityPackProjectPinSchema>;
export type CapabilityPackProjectDependencyStatus = z.infer<typeof CapabilityPackProjectDependencyStatusSchema>;
