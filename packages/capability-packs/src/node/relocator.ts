import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '@framepilot/shared-types';
import { CapabilityPackStorageIndexSchema } from '../install-contracts.js';
import { FileCapabilityPackStore } from './storage.js';

const TRANSIENT_ROOT_ENTRIES = new Set(['.index.lock', 'locks', 'staging']);
const log = createLogger('capability-packs:relocator');

export interface CapabilityPackRelocationProgress {
  readonly copiedBytes: number;
  readonly totalBytes: number;
  readonly currentRelativePath?: string;
}

export interface CapabilityPackRelocationRequest {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CapabilityPackRelocationProgress) => void;
  /** Current-process authority; required to observe live in-memory lease ownership. */
  readonly sourceStore?: FileCapabilityPackStore;
}

export interface PreparedCapabilityPackRelocation {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly copiedBytes: number;
  readonly recordCount: number;
}

export class CapabilityPackRelocationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_destination'
      | 'pack_leased'
      | 'relocation_cancelled'
      | 'relocation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackRelocationError';
  }
}

/**
 * Copy and validate a storage root without changing authority.
 * The caller atomically commits its root pointer only after this function succeeds.
 */
export async function prepareCapabilityPackRelocation(
  request: CapabilityPackRelocationRequest,
): Promise<PreparedCapabilityPackRelocation> {
  const sourceRoot = path.resolve(request.sourceRoot);
  const destinationRoot = path.resolve(request.destinationRoot);
  log.action('relocationPreparing', { sourceRoot, destinationRoot });
  if (sourceRoot === destinationRoot || isNested(sourceRoot, destinationRoot) || isNested(destinationRoot, sourceRoot)) {
    throw new CapabilityPackRelocationError(
      'invalid_destination',
      'Capability Pack destination must be separate from the current storage root.',
    );
  }
  const sourceStore = request.sourceStore ?? new FileCapabilityPackStore(sourceRoot);
  const records = await sourceStore.list();
  if (records.some((record) => record.activeLeaseCount > 0)) {
    throw new CapabilityPackRelocationError(
      'pack_leased',
      'Stop all Capability Pack workers before moving storage.',
    );
  }
  await assertEmptyOrMissing(destinationRoot);
  const destinationParent = path.dirname(destinationRoot);
  const stagingRoot = path.join(
    destinationParent,
    `.${path.basename(destinationRoot)}.relocating-${randomUUID()}`,
  );
  await mkdir(stagingRoot, { recursive: false });
  try {
    const files = await inventory(sourceRoot);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    let copiedBytes = 0;
    for (const file of files) {
      throwIfAborted(request.signal);
      const destination = resolveInside(stagingRoot, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(
        createReadStream(file.absolutePath),
        createWriteStream(destination, { flags: 'wx', mode: file.mode }),
        request.signal === undefined ? {} : { signal: request.signal },
      );
      copiedBytes += file.bytes;
      request.onProgress?.({ copiedBytes, totalBytes, currentRelativePath: file.relativePath });
    }
    const copiedRecords = await new FileCapabilityPackStore(stagingRoot).list();
    CapabilityPackStorageIndexSchema.parse({ schemaVersion: 1, records: copiedRecords });
    if (JSON.stringify(normalizeRecords(copiedRecords)) !== JSON.stringify(normalizeRecords(records))) {
      throw new CapabilityPackRelocationError(
        'relocation_failed',
        'Copied Capability Pack index does not match the source authority.',
      );
    }
    await rename(stagingRoot, destinationRoot);
    log.action('relocationPrepared', { destinationRoot, copiedBytes, recordCount: records.length });
    return {
      sourceRoot,
      destinationRoot,
      copiedBytes,
      recordCount: records.length,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (request.signal?.aborted === true || isAbortError(error)) {
      throw new CapabilityPackRelocationError(
        'relocation_cancelled',
        'Capability Pack storage move cancelled; the old location is still active.',
      );
    }
    if (error instanceof CapabilityPackRelocationError) throw error;
    throw new CapabilityPackRelocationError(
      'relocation_failed',
      `Capability Pack storage move failed: ${errorMessage(error)}`,
    );
  }
}

interface InventoryFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly mode: number;
}

async function inventory(root: string): Promise<readonly InventoryFile[]> {
  const files: InventoryFile[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (relativeDirectory === '' && TRANSIENT_ROOT_ENTRIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) {
        throw new CapabilityPackRelocationError(
          'relocation_failed',
          `Storage contains an unexpected symbolic link: ${relativePath}.`,
        );
      }
      if (details.isDirectory()) await walk(absolutePath, relativePath);
      else if (details.isFile()) {
        files.push({
          absolutePath,
          relativePath,
          bytes: details.size,
          mode: details.mode & 0o777,
        });
      } else {
        throw new CapabilityPackRelocationError(
          'relocation_failed',
          `Storage contains an unsupported filesystem entry: ${relativePath}.`,
        );
      }
    }
  };
  await walk(root, '');
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function assertEmptyOrMissing(destination: string): Promise<void> {
  try {
    const details = await stat(destination);
    if (!details.isDirectory() || (await readdir(destination)).length > 0) {
      throw new CapabilityPackRelocationError(
        'invalid_destination',
        'Capability Pack destination must be an empty folder.',
      );
    }
    await rm(destination, { recursive: false });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function normalizeRecords(records: Awaited<ReturnType<FileCapabilityPackStore['list']>>) {
  return [...records]
    .map((record) => ({ ...record, activeLeaseCount: 0 }))
    .sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
}

function identityKey(identity: { id: string; version: string; os: string; arch: string; artifactDigest: string }): string {
  return [identity.id, identity.version, identity.os, identity.arch, identity.artifactDigest].join('/');
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new CapabilityPackRelocationError('relocation_failed', 'Relocation path escaped staging.');
  }
  return resolved;
}

function isNested(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${path.sep}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CapabilityPackRelocationError('relocation_cancelled', 'Relocation cancelled.');
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
