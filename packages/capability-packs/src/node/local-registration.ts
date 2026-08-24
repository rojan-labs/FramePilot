/**
 * DEV-ONLY registration of a locally built Capability Pack worker.
 *
 * The production install path starts at a signed catalog: propose → approve →
 * download → verify → health-check → commit. None of that infrastructure exists
 * on a development machine, yet the desktop tracking authority only ever runs
 * packs that are installed and healthy in the store — so without a way to seed
 * the store locally, every worker-facing feature is untestable end to end.
 *
 * This module closes that gap WITHOUT opening a trust hole:
 *
 * - It is gated behind `FRAMEPILOT_DEV_PACK_REGISTRATION=1`, set per-process by
 *   the developer who runs it. A packaged app or CI build never has it set.
 * - The worker still passes the exact same isolated health check a signed
 *   install would run (`healthCheckCapabilityPackWorker`), so the handshake,
 *   protocol version, capability roster, and backend probe are all verified.
 * - The digests recorded in the store are real content digests of the local
 *   payload, not invented constants, so provenance lines stay meaningful.
 *
 * What it deliberately does NOT do: sign anything, touch any catalog, or mark
 * the record as catalog-acquired. The acquisition receipt names itself as a dev
 * registration so audits can tell the two apart.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import { canonicalJson } from '../canonical.js';
import type { InstalledCapabilityPack } from '../install-contracts.js';
import {
  identityKey,
  FileCapabilityPackStore,
} from './storage.js';
import {
  healthCheckCapabilityPackWorker,
  CapabilityPackHealthError,
} from './worker-health.js';
import type { BoundedCommandRunner } from './executable-verifier.js';

const log = createLogger('capability-packs:local-registration');

/** Environment flag that must equal '1' to allow any local registration. */
export const DEV_PACK_REGISTRATION_ENV = 'FRAMEPILOT_DEV_PACK_REGISTRATION';

export const RegisterLocalCapabilityPackInputSchema = z
  .object({
    packId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/),
    /** Absolute directory holding the built pack payload (venv, models, bin/…). */
    payloadRoot: z.string().min(1).max(4_096),
    /** Entrypoint relative to `payloadRoot`, e.g. `bin/framepilot-tracking-lite`. */
    entrypoint: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), 'must be relative')
      .refine((value) => !value.split(/[\\/]/u).includes('..'), 'path traversal is forbidden'),
    capabilities: z.array(z.string().min(1).max(160)).min(1).max(128),
    licenses: z.array(z.string().min(1).max(128)).min(1).max(32),
    os: z.enum(['darwin', 'win32']),
    arch: z.enum(['arm64', 'x64']),
  })
  .strict();

export type RegisterLocalCapabilityPackInput = z.infer<
  typeof RegisterLocalCapabilityPackInputSchema
>;

export interface LocalPackRegistrationResult {
  readonly record: InstalledCapabilityPack;
  readonly identityKey: string;
  readonly entrypointPath: string;
}

/** Dependencies injectable for tests; production defaults run the real checks. */
export interface RegisterLocalCapabilityPackDeps {
  readonly storeRoot?: string;
  readonly now?: () => Date;
  readonly runHealthCommand?: BoundedCommandRunner;
}

export class LocalRegistrationDisabledError extends Error {
  constructor() {
    super(
      `Local Capability Pack registration is disabled. Set ${DEV_PACK_REGISTRATION_ENV}=1 to allow it; never enable this in a packaged build.`,
    );
    this.name = 'LocalRegistrationDisabledError';
  }
}

/**
 * Health-check a locally built worker and register it as an installed pack.
 *
 * The payload is copied (never moved) into the store's canonical layout, so the
 * developer's build tree stays intact and the store keeps one self-contained
 * copy whose digests match what was actually checked.
 */
export async function registerLocalCapabilityPack(
  env: Readonly<Record<string, string | undefined>>,
  rawInput: unknown,
  deps: RegisterLocalCapabilityPackDeps = {},
): Promise<LocalPackRegistrationResult> {
  if (env[DEV_PACK_REGISTRATION_ENV] !== '1') {
    throw new LocalRegistrationDisabledError();
  }
  const input = RegisterLocalCapabilityPackInputSchema.parse(rawInput);

  const payloadRoot = await realpathExistingDirectory(input.payloadRoot);
  const entrypointPath = resolveInside(payloadRoot, input.entrypoint);
  if (!(await isFile(entrypointPath))) {
    throw new Error(
      `Entrypoint '${input.entrypoint}' does not exist inside '${payloadRoot}' or is not a file.`,
    );
  }

  const storeRoot = path.resolve(deps.storeRoot ?? throwStoreRootRequired());
  const artifactDigest = await hashPayloadTree(payloadRoot);
  // Content-derived dev identity: same bytes ⇒ same identity key, changed bytes
  // ⇒ a distinct record instead of silently shadowing a stale healthy one.
  const releaseDigest = sha256Hex(
    canonicalJson({ capabilities: [...input.capabilities].sort(), id: input.packId, version: input.version }),
  );

  const installRelativePath = path.posix.join(
    'packs',
    input.packId,
    input.version,
    releaseDigest,
    `${input.os}-${input.arch}`,
    artifactDigest,
  );
  const destinationRoot = path.join(storeRoot, ...installRelativePath.split('/'));
  await cp(payloadRoot, destinationRoot, { recursive: true, dereference: false, force: true });
  const stagedEntrypoint = resolveInside(destinationRoot, input.entrypoint);

  const identity = {
    id: input.packId,
    version: input.version,
    releaseDigest,
    artifactDigest,
    os: input.os,
    arch: input.arch,
  } as const;

  let handshakeBackend: string;
  try {
    const handshake = await healthCheckCapabilityPackWorker(
      stagedEntrypoint,
      identity,
      input.capabilities,
      deps.runHealthCommand,
      undefined,
      // The staged copy mirrors the installed layout, so a weights-backed pack
      // finds its models exactly where the runtime service will point it later.
      { FRAMEPILOT_CAPABILITY_PACK_ROOT: destinationRoot },
    );
    handshakeBackend = handshake.hardwareBackend;
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    if (error instanceof CapabilityPackHealthError) throw error;
    throw new CapabilityPackHealthError(
      'health_check_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const installedBytes = await measureTreeBytes(destinationRoot);
  const record: InstalledCapabilityPack = {
    identity,
    state: 'installed',
    installRelativePath,
    installedBytes,
    installedAt: now,
    lastUsedAt: now,
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: {
      checkedAt: now,
      workerProtocolVersion: 1,
      status: 'healthy',
      detail: `${handshakeBackend}; registered by ${DEV_PACK_REGISTRATION_ENV}`,
    },
    acquisition: {
      catalogDigest: sha256Hex(
        canonicalJson({ dev: true, artifactDigest, packId: input.packId, version: input.version }),
      ),
      approvedAt: now,
      licenseSpdx: [...input.licenses],
      mediaEgressApproved: false,
    },
  };
  await new FileCapabilityPackStore(storeRoot).recordInstalled(record);
  log.action('localPackRegistered', { pack: identityKey(identity), bytes: installedBytes });
  return { record, identityKey: identityKey(identity), entrypointPath: stagedEntrypoint };
}

function throwStoreRootRequired(): string {
  throw new Error('A capability-pack storage root is required to register a local pack.');
}

async function realpathExistingDirectory(candidate: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(candidate));
  } catch {
    throw new Error(`Payload root '${candidate}' does not exist.`);
  }
  if (!(await lstat(resolved)).isDirectory()) {
    throw new Error(`Payload root '${candidate}' is not a directory.`);
  }
  return resolved;
}

function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSeparator)) {
    throw new Error(`'${relative}' escapes the payload root.`);
  }
  return resolved;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isFile();
  } catch {
    return false;
  }
}

interface TreeEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'symlink';
  readonly digestInput: string;
  readonly size: number;
}

async function collectTree(root: string): Promise<readonly TreeEntry[]> {
  const files: TreeEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute);
        const size = Buffer.byteLength(target);
        files.push({
          relativePath: relative,
          kind: 'symlink',
          digestInput: `link:${target}`,
          size,
        });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = (await lstat(absolute)).size;
      files.push({
        relativePath: relative,
        kind: 'file',
        digestInput: await streamSha256(createReadStream(absolute)),
        size,
      });
    }
  };
  await walk(root);
  return files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
}

async function streamSha256(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function hashPayloadTree(payloadRoot: string): Promise<string> {
  const entries = await collectTree(payloadRoot);
  if (entries.length === 0) {
    throw new Error('The payload root contains no files to register.');
  }
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.relativePath}\0${entry.digestInput}\n`);
  }
  return hash.digest('hex');
}

async function measureTreeBytes(root: string): Promise<number> {
  const entries = await collectTree(root);
  return entries.reduce((total, entry) => total + entry.size, 0);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
