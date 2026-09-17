/**
 * The one write surface a matte job gets (MD-3), and the project-owned matte store (MD-4).
 *
 * Layout, all under the project directory so moving a project moves its mattes:
 *
 * ```
 * <project>/.framepilot-derived/mattes/
 *   <cacheKey>/            committed artifacts (64 hex), read by the engine and the preview
 *   .staging/<jobId>/      one empty directory per job, created here, verified, then renamed
 *     inputs/corrections/  host-written brush masks for this job (read-only to the worker)
 *     inputs/locked/       host-written locked alpha for this job
 *   .inputs/<sha256>.png   project-owned correction inputs (matteSaveCorrection)
 * ```
 *
 * Every directory on the way is created one segment at a time and checked with `lstat`, so a
 * symlink planted anywhere in `.framepilot-derived` makes the job refuse rather than write
 * through it. Commit is a single `rename` inside one filesystem, so a reader never sees a
 * half-written artifact under a cache key.
 */
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import {
  MatteInputFileSchema,
  type MatteArtifactFileName,
  type MatteInputHandle,
  type MatteOutputHandle,
} from '@framepilot/capability-packs';

const log = createLogger('desktop:capability-packs:matte-staging');

export const MATTES_RELATIVE_DIR = ['.framepilot-derived', 'mattes'] as const;
export const MATTE_STAGING_DIR = '.staging';
export const MATTE_INPUTS_STORE_DIR = '.inputs';
/** A staging directory untouched this long with no live job is an orphan (plan 03). */
export const MATTE_STAGING_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export class MatteStagingError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_job_id'
      | 'invalid_key'
      | 'unsafe_path'
      | 'staging_exists'
      | 'invalid_input'
      | 'changed_after_verify',
    message: string,
  ) {
    super(message);
    this.name = 'MatteStagingError';
  }
}

export function isMatteJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

export function isMatteCacheKey(value: unknown): value is string {
  return typeof value === 'string' && CACHE_KEY_PATTERN.test(value);
}

/**
 * Create (or accept) each segment under `base` as a REAL directory, never following a link.
 *
 * @returns The absolute directory.
 * @throws MatteStagingError `unsafe_path` when any segment exists as a symlink or a file.
 */
export async function ensureRealDirectory(base: string, segments: readonly string[]): Promise<string> {
  let current = path.resolve(base);
  const baseStat = await lstat(current);
  if (!baseStat.isDirectory()) {
    throw new MatteStagingError('unsafe_path', 'The project folder is not a directory.');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\/]/u.test(segment)) {
      throw new MatteStagingError('unsafe_path', 'Matte store path segment is invalid.');
    }
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MatteStagingError('unsafe_path', 'The project matte store contains a link or a file where a folder belongs.');
    }
  }
  await assertRealpathMatches(base, segments, current);
  return current;
}

/**
 * The existing directory `<projectDir>/<segments...>` as a chain of REAL directories, or
 * `undefined` when a segment does not exist (BR4.12 M1).
 *
 * Every segment is `lstat`-checked (a symlink or file anywhere refuses) and the final realpath must
 * equal the project's realpath joined with the segments, so a rename race that swaps a parent for a
 * link between the checks is caught too. Every reader and deleter of the matte store goes through
 * this; nothing lists, hashes or removes through a link.
 *
 * @throws MatteStagingError `unsafe_path`.
 */
export async function existingRealDirectory(projectDir: string, segments: readonly string[]): Promise<string | undefined> {
  let current = path.resolve(projectDir);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\/]/u.test(segment)) {
      throw new MatteStagingError('unsafe_path', 'Matte store path segment is invalid.');
    }
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MatteStagingError('unsafe_path', 'The project matte store contains a link or a file where a folder belongs.');
    }
  }
  await assertRealpathMatches(projectDir, segments, current);
  return current;
}

async function assertRealpathMatches(base: string, segments: readonly string[], current: string): Promise<void> {
  const [baseReal, currentReal] = await Promise.all([realpath(base), realpath(current)]);
  if (currentReal !== path.join(baseReal, ...segments)) {
    throw new MatteStagingError('unsafe_path', 'The project matte store resolves outside the project folder.');
  }
}

/** Absolute committed-artifact directory for `key`, or `undefined` for a malformed key. */
export function matteArtifactDirectory(projectDir: string, key: string): string | undefined {
  if (!isMatteCacheKey(key)) return undefined;
  return path.join(path.resolve(projectDir), ...MATTES_RELATIVE_DIR, key);
}

export function matteStagingRoot(projectDir: string): string {
  return path.join(path.resolve(projectDir), ...MATTES_RELATIVE_DIR, MATTE_STAGING_DIR);
}

export interface MatteStaging {
  readonly jobId: string;
  readonly stagingRoot: string;
  readonly directory: string;
  readonly inputsDirectory: string;
  /** Write one host-owned input (`corrections/<pts>.png` or `locked/<pts>.png`). */
  writeInput(file: string, bytes: Uint8Array): Promise<void>;
  /**
   * Clone the previous artifact's alpha and frames into `inputs/previous/` for a partial
   * re-run. Copy-on-write where the filesystem supports it (APFS, ReFS, btrfs), so no bytes
   * are duplicated, and the committed original can never be written through the copy.
   *
   * @returns The input names the worker may read (`previous/...`).
   */
  clonePrevious(previousDirectory: string, names: readonly ('matte.mkv' | 'foreground.mkv' | 'frames.json')[]): Promise<string[]>;
  outputHandle(allowedFiles: readonly MatteArtifactFileName[], maxBytes: number): MatteOutputHandle;
  inputHandle(files: readonly string[]): MatteInputHandle | undefined;
  /** Remove the whole staging directory (failure, cancel, stale result). Never throws. */
  discard(): Promise<void>;
}

/** Create `<project>/.framepilot-derived/mattes/.staging/<jobId>/` empty, plus its inputs folders. */
export async function createMatteStaging(projectDir: string, jobId: string): Promise<MatteStaging> {
  if (!isMatteJobId(jobId)) {
    throw new MatteStagingError('invalid_job_id', 'Matte job id must be 1-64 letters, digits, "-" or "_".');
  }
  const stagingRoot = await ensureRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_STAGING_DIR]);
  const directory = path.join(stagingRoot, jobId);
  try {
    // Not recursive: an existing directory for this id is refused, never reused.
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (isCode(error, 'EEXIST')) {
      throw new MatteStagingError('staging_exists', 'A matte job with this id is already staged.');
    }
    throw error;
  }
  const inputsDirectory = path.join(directory, 'inputs');
  await mkdir(path.join(inputsDirectory, 'corrections'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(inputsDirectory, 'locked'), { recursive: true, mode: 0o700 });
  return {
    jobId,
    stagingRoot,
    directory,
    inputsDirectory,
    async writeInput(file, bytes) {
      if (!MatteInputFileSchema.safeParse(file).success) {
        throw new MatteStagingError('invalid_input', 'Matte input names are corrections/<pts>.png or locked/<pts>.png.');
      }
      const [folder, name] = file.split('/') as [string, string];
      await writeFile(path.join(inputsDirectory, folder, name), bytes, { flag: 'wx', mode: 0o400 });
    },
    async clonePrevious(previousDirectory, names) {
      const target = path.join(inputsDirectory, 'previous');
      await mkdir(target, { mode: 0o700 });
      const cloned: string[] = [];
      for (const name of names) {
        const source = path.join(previousDirectory, name);
        const stat = await lstat(source);
        if (!stat.isFile()) {
          throw new MatteStagingError('unsafe_path', 'The previous matte holds a link or folder where a file belongs.');
        }
        await copyFile(source, path.join(target, name), fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
        cloned.push(`previous/${name}`);
      }
      return cloned;
    },
    outputHandle(allowedFiles, maxBytes) {
      return { handleId: `matte-out:${jobId}`, absolutePath: directory, allowedFiles: [...allowedFiles], maxBytes };
    },
    inputHandle(files) {
      if (files.length === 0) return undefined;
      return { handleId: `matte-in:${jobId}`, absolutePath: inputsDirectory, files: [...files] };
    },
    async discard() {
      await removeQuietly(directory, 'discard');
    },
  };
}

export type MatteCommitOutcome = 'committed' | 'already_present';

/**
 * Move a VERIFIED staging directory to `mattes/<key>/` in one rename.
 *
 * The job's `inputs/` copies are dropped first: the project-owned originals live in
 * `.inputs/`, and an artifact directory holds only the files its mask pins. If another job
 * committed the same key first, that artifact wins and this staging directory is discarded.
 */
export async function commitMatteStaging(
  projectDir: string,
  staging: Pick<MatteStaging, 'directory' | 'inputsDirectory'>,
  key: string,
  /**
   * The files verification accepted. Re-checked immediately before the rename: exactly these
   * names, regular files with one link each (no hard-link alias into the committed store) and the
   * verified sizes (BR4.12 H1). Omit only in tests of the rename itself.
   */
  verifiedFiles?: readonly { readonly name: string; readonly bytes: number }[],
): Promise<MatteCommitOutcome> {
  const target = matteArtifactDirectory(projectDir, key);
  if (target === undefined) throw new MatteStagingError('invalid_key', 'Matte cache key is malformed.');
  const mattesRoot = await ensureRealDirectory(projectDir, [...MATTES_RELATIVE_DIR]);
  if (path.dirname(path.dirname(staging.directory)) !== mattesRoot) {
    throw new MatteStagingError('unsafe_path', 'Staging directory is not inside this project’s matte store.');
  }
  await rm(staging.inputsDirectory, { recursive: true, force: true });
  if (verifiedFiles !== undefined) await assertStagingUnchanged(staging.directory, verifiedFiles);
  if (await exists(target)) {
    await removeQuietly(staging.directory, 'duplicate');
    return 'already_present';
  }
  try {
    await rename(staging.directory, target);
  } catch (error) {
    // A concurrent commit of the same key landed between the check and the rename.
    if ((isCode(error, 'ENOTEMPTY') || isCode(error, 'EEXIST')) && (await exists(target))) {
      await removeQuietly(staging.directory, 'duplicate');
      return 'already_present';
    }
    throw error;
  }
  return 'committed';
}

async function assertStagingUnchanged(
  directory: string,
  verifiedFiles: readonly { readonly name: string; readonly bytes: number }[],
): Promise<void> {
  const changed = (): MatteStagingError =>
    new MatteStagingError('changed_after_verify', 'The background removal files changed after they were checked.');
  const self = await lstat(directory);
  if (!self.isDirectory() || self.isSymbolicLink()) throw changed();
  const expected = new Map(verifiedFiles.map((file) => [file.name, file.bytes]));
  const entries = await readdir(directory);
  if (entries.length !== expected.size) throw changed();
  for (const name of entries) {
    const bytes = expected.get(name);
    if (bytes === undefined) throw changed();
    const stat = await lstat(path.join(directory, name));
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes) throw changed();
  }
}

export interface MatteStagingSweepOptions {
  readonly now: Date;
  readonly activeJobIds: ReadonlySet<string>;
  readonly maxAgeMs?: number;
}

/**
 * Remove staging directories no live job owns and nobody touched for 24 h (startup sweep).
 *
 * Links and stray files in `.staging` are removed without being followed. Returns how many
 * entries went.
 */
export async function sweepMatteStaging(projectDir: string, options: MatteStagingSweepOptions): Promise<number> {
  let root: string | undefined;
  try {
    root = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_STAGING_DIR]);
  } catch (error) {
    if (error instanceof MatteStagingError) {
      log.warn('matteStagingRootUnsafe', {});
      return 0;
    }
    throw error;
  }
  if (root === undefined) return 0;
  const maxAge = options.maxAgeMs ?? MATTE_STAGING_ORPHAN_AGE_MS;
  let removed = 0;
  for (const entry of await readdir(root)) {
    if (options.activeJobIds.has(entry)) continue;
    const entryPath = path.join(root, entry);
    let stat;
    try {
      stat = await lstat(entryPath);
    } catch {
      continue;
    }
    if (options.now.getTime() - stat.mtimeMs < maxAge) continue;
    await rm(entryPath, { recursive: true, force: true });
    removed += 1;
  }
  if (removed > 0) log.action('matteStagingSwept', { removed });
  return removed;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function removeQuietly(directory: string, reason: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn('matteStagingRemoveFailed', { reason, code: errorCode(error) });
  }
}

function isCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
