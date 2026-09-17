/**
 * Per-project matte storage accounting and "Clean unused mattes" (plan 03, MD-4, BR4.6).
 *
 * Mattes are project-owned, so this is not the pack storage manager's LRU: nothing is evicted
 * automatically. The summary reports bytes per artifact and whether anything references it;
 * cleaning is an explicit action over the exact keys the editor confirmed, re-checked against
 * the project on disk at the moment of deletion. A matte or correction referenced by the saved
 * project (timeline or saved history) or by the open session's undo history is never removed.
 */
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
  existingRealDirectory,
  isMatteCacheKey,
  MATTE_INPUTS_STORE_DIR,
  MATTE_STAGING_DIR,
  MATTES_RELATIVE_DIR,
} from './matte-staging.js';
import { MATTE_RESULTS_DIR, readMatteRecord } from './matte-store.js';

const log = createLogger('desktop:capability-packs:matte-storage');

export interface MatteStorageArtifact {
  readonly key: string;
  readonly bytes: number;
  readonly referenced: boolean;
  readonly assetId?: string;
  readonly createdAt?: string;
}

export interface MatteStorageInput {
  readonly sha256: string;
  readonly bytes: number;
  readonly referenced: boolean;
}

export interface MatteStorageSummary {
  readonly totalBytes: number;
  readonly referencedBytes: number;
  /** What "Clean unused mattes" would free right now. */
  readonly unusedBytes: number;
  readonly stagingBytes: number;
  readonly artifacts: readonly MatteStorageArtifact[];
  readonly inputs: readonly MatteStorageInput[];
}

export interface MatteCleanResult {
  readonly removedKeys: readonly string[];
  /** Approved keys that are referenced now (or no longer exist) and were left alone. */
  readonly keptKeys: readonly string[];
  readonly freedBytes: number;
}

/**
 * Every matte artifact key and correction digest the project references, anywhere in its JSON:
 * clip and effect-layer mask stacks, and any saved history entries that embed masks.
 */
export function collectMatteReferences(project: unknown): { readonly artifacts: Set<string>; readonly inputs: Set<string> } {
  const artifacts = new Set<string>();
  const inputs = new Set<string>();
  const stack: unknown[] = [project];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    // Bounded walk: a project is a tree, but never trust that.
    if (++visited > 5_000_000) break;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.kind === 'matte' && typeof record.artifact === 'object' && record.artifact !== null) {
      const key = (record.artifact as Record<string, unknown>).key;
      if (isMatteCacheKey(key)) artifacts.add(key);
    }
    if ((record.kind === 'brush' || record.kind === 'lock') && isMatteCacheKey(record.sha256)) {
      inputs.add(record.sha256);
    }
    for (const child of Object.values(record)) {
      if (typeof child === 'object' && child !== null) stack.push(child);
    }
  }
  return { artifacts, inputs };
}

/** Most project files one folder scan reads, and the largest one it parses. */
export const FOLDER_SCAN_MAX_FILES = 500;
export const FOLDER_SCAN_MAX_BYTES = 64 * 1024 * 1024;

export class MatteReferenceScanError extends Error {
  public readonly code = 'references_incomplete';
  public constructor(message: string) {
    super(message);
    this.name = 'MatteReferenceScanError';
  }
}

/**
 * References from EVERY project file in the folder (BR4.12 M2).
 *
 * WHY: `.framepilot-derived` belongs to the folder, not to one project. Several `*.fp.json` files
 * can share a folder (the default projects folder does), and a pre-migration backup
 * (`<project>.v<N>.backup.fp.json`) still references the mattes and corrections of the version it
 * preserves. Cleaning against the open project alone would delete another project's work. A file
 * that cannot be read or is over the bound makes the scan incomplete, and an incomplete scan
 * refuses to clean anything.
 */
export async function collectFolderMatteReferences(
  projectDir: string,
): Promise<{ readonly artifacts: Set<string>; readonly inputs: Set<string> }> {
  const artifacts = new Set<string>();
  const inputs = new Set<string>();
  const names = (await readdir(path.resolve(projectDir))).filter((name) => name.endsWith('.fp.json'));
  if (names.length > FOLDER_SCAN_MAX_FILES) {
    throw new MatteReferenceScanError('This folder holds too many project files to check which mattes they use.');
  }
  for (const name of names) {
    const file = path.join(path.resolve(projectDir), name);
    const stat = await lstat(file);
    if (!stat.isFile()) continue;
    if (stat.size > FOLDER_SCAN_MAX_BYTES) {
      throw new MatteReferenceScanError('A project file in this folder is too large to check which mattes it uses.');
    }
    let document: unknown;
    try {
      document = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new MatteReferenceScanError('A project file in this folder could not be read to check which mattes it uses.');
    }
    const found = collectMatteReferences(document);
    for (const key of found.artifacts) artifacts.add(key);
    for (const sha of found.inputs) inputs.add(sha);
  }
  return { artifacts, inputs };
}

export async function matteStorageSummary(
  projectDir: string,
  project: unknown,
  protectedKeys: readonly string[] = [],
): Promise<MatteStorageSummary> {
  const references = collectMatteReferences(project);
  const folder = await collectFolderMatteReferences(projectDir);
  for (const key of folder.artifacts) references.artifacts.add(key);
  for (const sha of folder.inputs) references.inputs.add(sha);
  const guard = new Set(protectedKeys);
  // A link anywhere in `.framepilot-derived/mattes` refuses the whole summary (BR4.12 M1).
  const root = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR]);
  if (root === undefined) {
    return { totalBytes: 0, referencedBytes: 0, unusedBytes: 0, stagingBytes: 0, artifacts: [], inputs: [] };
  }
  const artifacts: MatteStorageArtifact[] = [];
  for (const key of await listKeys(root)) {
    // Only real directories are artifacts; a link or file named like a key is ignored.
    if (!(await isRealDirectory(path.join(root, key)))) continue;
    const record = await readMatteRecord(projectDir, key);
    artifacts.push({
      key,
      bytes: await directoryBytes(path.join(root, key)),
      referenced: references.artifacts.has(key) || guard.has(key),
      ...(record === undefined ? {} : { assetId: record.assetId, createdAt: record.createdAt }),
    });
  }
  const inputs: MatteStorageInput[] = [];
  const inputsRoot = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_INPUTS_STORE_DIR]);
  for (const entry of inputsRoot === undefined ? [] : await safeReaddir(inputsRoot)) {
    const sha256 = entry.endsWith('.png') ? entry.slice(0, -4) : '';
    if (!isMatteCacheKey(sha256)) continue;
    const bytes = await regularFileBytes(path.join(inputsRoot!, entry));
    if (bytes === undefined) continue;
    inputs.push({ sha256, bytes, referenced: references.inputs.has(sha256) || guard.has(sha256) });
  }
  const stagingRoot = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_STAGING_DIR]);
  const stagingBytes = stagingRoot === undefined ? 0 : await directoryBytes(stagingRoot);
  const artifactBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
  const inputBytes = inputs.reduce((sum, item) => sum + item.bytes, 0);
  const referencedBytes =
    artifacts.filter((item) => item.referenced).reduce((sum, item) => sum + item.bytes, 0) +
    inputs.filter((item) => item.referenced).reduce((sum, item) => sum + item.bytes, 0);
  return {
    totalBytes: artifactBytes + inputBytes + stagingBytes,
    referencedBytes,
    unusedBytes: artifactBytes + inputBytes - referencedBytes,
    stagingBytes,
    artifacts,
    inputs,
  };
}

/**
 * Remove exactly the approved, currently unreferenced artifacts and correction inputs.
 *
 * @param project - The project as main just re-read it from disk, not the renderer's copy.
 */
export async function cleanUnusedMattes(
  projectDir: string,
  project: unknown,
  approvedKeys: readonly string[],
  protectedKeys: readonly string[] = [],
): Promise<MatteCleanResult> {
  const summary = await matteStorageSummary(projectDir, project, protectedKeys);
  const unusedArtifacts = new Map(summary.artifacts.filter((item) => !item.referenced).map((item) => [item.key, item]));
  const unusedInputs = new Map(summary.inputs.filter((item) => !item.referenced).map((item) => [item.sha256, item]));
  const removedKeys: string[] = [];
  const keptKeys: string[] = [];
  let freedBytes = 0;
  for (const key of new Set(approvedKeys)) {
    if (!isMatteCacheKey(key)) continue;
    const artifact = unusedArtifacts.get(key);
    const input = unusedInputs.get(key);
    if (artifact === undefined && input === undefined) {
      keptKeys.push(key);
      continue;
    }
    // Re-assert the chain right before each deletion: the tree may have changed since the summary.
    const root = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR]);
    if (root === undefined) break;
    if (artifact !== undefined && (await isRealDirectory(path.join(root, key)))) {
      await rm(path.join(root, key), { recursive: true, force: true });
      const results = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_RESULTS_DIR]);
      if (results !== undefined) await rm(path.join(results, `${key}.json`), { force: true });
      freedBytes += artifact.bytes;
    }
    if (input !== undefined) {
      const inputsRoot = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_INPUTS_STORE_DIR]);
      if (inputsRoot !== undefined && (await regularFileBytes(path.join(inputsRoot, `${key}.png`))) !== undefined) {
        await rm(path.join(inputsRoot, `${key}.png`), { force: true });
        freedBytes += input.bytes;
      }
    }
    removedKeys.push(key);
  }
  log.action('matteCleanUnused', { removed: removedKeys.length, kept: keptKeys.length, freedBytes });
  return { removedKeys, keptKeys, freedBytes };
}

async function listKeys(root: string): Promise<string[]> {
  return (await safeReaddir(root)).filter((name) => isMatteCacheKey(name));
}

async function safeReaddir(directory: string): Promise<string[]> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) return [];
    return await readdir(directory);
  } catch {
    return [];
  }
}

/** Bytes under a directory, never following links (a link counts as its own small size). */
async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of await safeReaddir(current)) pending.push(path.join(current, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

/** Size of a regular file, or `undefined` for a link, folder or missing entry. */
async function regularFileBytes(file: string): Promise<number | undefined> {
  try {
    const stat = await lstat(file);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

async function isRealDirectory(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
