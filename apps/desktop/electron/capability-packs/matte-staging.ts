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
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
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
/**
 * Transform tracks (MK7.1) are project-owned artifacts under the same root, produced by the same
 * staging → verify → atomic-rename mechanism. There is one derived-artifact store, not two.
 */
export const TRACKS_RELATIVE_DIR = ['.framepilot-derived', 'tracks'] as const;
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
export async function ensureRealDirectory(
  base: string,
  segments: readonly string[],
): Promise<string> {
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
      throw new MatteStagingError(
        'unsafe_path',
        'The project matte store contains a link or a file where a folder belongs.',
      );
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
export async function existingRealDirectory(
  projectDir: string,
  segments: readonly string[],
): Promise<string | undefined> {
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
      throw new MatteStagingError(
        'unsafe_path',
        'The project matte store contains a link or a file where a folder belongs.',
      );
    }
  }
  await assertRealpathMatches(projectDir, segments, current);
  return current;
}

async function assertRealpathMatches(
  base: string,
  segments: readonly string[],
  current: string,
): Promise<void> {
  const [baseReal, currentReal] = await Promise.all([realpath(base), realpath(current)]);
  if (currentReal !== path.join(baseReal, ...segments)) {
    throw new MatteStagingError(
      'unsafe_path',
      'The project matte store resolves outside the project folder.',
    );
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
  clonePrevious(
    previousDirectory: string,
    names: readonly ('matte.mkv' | 'foreground.mkv' | 'frames.json')[],
  ): Promise<string[]>;
  outputHandle(allowedFiles: readonly MatteArtifactFileName[], maxBytes: number): MatteOutputHandle;
  inputHandle(files: readonly string[]): MatteInputHandle | undefined;
  /**
   * Create `scratch/tmp/` for the worker's temp files (TMPDIR, BR4.12 follow-up F3), so they
   * are inside the folder the watchdog measures and go with the staging directory.
   *
   * @returns The absolute directory.
   */
  temporaryDirectory(): Promise<string>;
  /**
   * Remove `scratch/tmp/`, and `scratch/` when nothing else is in it, after the worker exits.
   * A worker removes its own `scratch/`; this only takes away what the host made, so anything
   * else a worker left there is still refused by verification.
   */
  clearTemporaryDirectory(): Promise<void>;
  /** Remove the whole staging directory (failure, cancel, stale result). Never throws. */
  discard(): Promise<void>;
  /** Give up this job's staging lock (commit and discard do it). Never throws. */
  release(): Promise<void>;
}

/**
 * The worker's finished-window checkpoints inside a staging directory (BR3.14). They are the
 * only thing an orphaned staging directory keeps when its job is resumed.
 */
export const MATTE_WINDOWS_DIR = 'windows';

export interface MatteStagingOptions {
  /**
   * Reuse a staging directory this job id left behind when the app stopped mid-job (a crash, a
   * forced quit), keeping only the worker's `windows/` checkpoints so the re-run resumes from
   * its finished windows. Only a journaled job resumed after a restart passes it (BR4.12
   * follow-up F5); a new request refuses an existing directory. Either way the job must first
   * take `<jobId>.lock`, so a directory another live app instance is using is never adopted.
   */
  readonly adoptOrphan?: boolean;
  /**
   * What this job's result will be (BR4.12 follow-up F2): written to `inputs/staging.json`
   * (0400) when the directory is created, and compared on adoption. The worker's `windows/`
   * are kept only when the orphan's record is a regular, single-link file naming the same cache
   * key (which covers the media's content fingerprint) and pipeline version; anything else
   * empties the directory. Without it, adoption keeps nothing.
   */
  readonly identity?: MatteStagingIdentity;
  /** Test seam: whether a process id is running (`process.kill(pid, 0)`). */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface MatteStagingIdentity {
  readonly cacheKey: string;
  readonly pipelineVersion: number;
}

/** The host's record of what a staging directory is for, inside its host-owned `inputs/`. */
export const MATTE_STAGING_IDENTITY_FILE = 'staging.json';
const STAGING_IDENTITY_VERSION = 1;
const STAGING_IDENTITY_MAX_BYTES = 1024;

async function writeStagingIdentity(inputsDirectory: string, identity: MatteStagingIdentity): Promise<void> {
  const document = {
    version: STAGING_IDENTITY_VERSION,
    cacheKey: identity.cacheKey,
    pipelineVersion: identity.pipelineVersion,
  };
  await writeFile(path.join(inputsDirectory, MATTE_STAGING_IDENTITY_FILE), JSON.stringify(document), {
    flag: 'wx',
    mode: 0o400,
  });
}

/** True only when the orphan's record is the host's own file and names this identity. */
async function stagingIdentityMatches(directory: string, identity: MatteStagingIdentity | undefined): Promise<boolean> {
  if (identity === undefined) return false;
  const file = path.join(directory, 'inputs', MATTE_STAGING_IDENTITY_FILE);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > STAGING_IDENTITY_MAX_BYTES) return false;
    const document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    return (
      document.version === STAGING_IDENTITY_VERSION &&
      document.cacheKey === identity.cacheKey &&
      document.pipelineVersion === identity.pipelineVersion
    );
  } catch {
    return false;
  }
}

/**
 * `<stagingRoot>/<jobId>.lock`: held by the app instance whose job uses `<jobId>/` (F5).
 *
 * Created exclusively (`wx`) holding the owner's pid. A lock whose pid is not running is stale
 * (the app died) and is taken over; so is one holding THIS process's pid, because one process
 * has one matte service, which already refuses a second live job with the same id — such a lock
 * is a run of this process that never returned. A lock of another running process refuses the
 * job (`staging_exists`); a reused pid therefore fails closed (the job can be run again). A lock
 * that is a link, not a regular file, hard-linked or unreadable refuses too.
 */
const LOCK_SUFFIX = '.lock';
const LOCK_MAX_BYTES = 256;

async function acquireStagingLock(
  lockPath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    const holder = await readLockHolder(lockPath);
    if (holder === 'gone') continue;
    if (holder !== process.pid && isProcessAlive(holder)) {
      throw new MatteStagingError('staging_exists', 'Another FramePilot window is running this job.');
    }
    log.action('matteStagingStaleLock', { ownProcess: holder === process.pid });
    try {
      await unlink(lockPath);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }
  throw new MatteStagingError('staging_exists', 'Another FramePilot window is running this job.');
}

/** The lock's pid, `'gone'` when it vanished, or a refusal when it is not a lock the host wrote. */
async function readLockHolder(lockPath: string): Promise<number | 'gone'> {
  let stat;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 'gone';
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > LOCK_MAX_BYTES) {
    throw new MatteStagingError('unsafe_path', 'The staging lock is a link or not a lock file.');
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }).pid;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 'gone';
    // Empty or half-written: its owner may be writing it right now. Refuse rather than guess.
    throw new MatteStagingError('staging_exists', 'Another FramePilot window is running this job.');
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new MatteStagingError('staging_exists', 'Another FramePilot window is running this job.');
  }
  return pid;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, which is still "running".
    return !isCode(error, 'ESRCH');
  }
}

async function releaseStagingLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) log.warn('matteStagingUnlockFailed', { code: errorCode(error) });
  }
}

/** Create `<project>/.framepilot-derived/mattes/.staging/<jobId>/` empty, plus its inputs folders. */
export async function createMatteStaging(
  projectDir: string,
  jobId: string,
  /** Which derived-artifact store to stage in; tracks use the same mechanism (MK7.1). */
  relativeDir: readonly string[] = MATTES_RELATIVE_DIR,
  options: MatteStagingOptions = {},
): Promise<MatteStaging> {
  if (!isMatteJobId(jobId)) {
    throw new MatteStagingError(
      'invalid_job_id',
      'Matte job id must be 1-64 letters, digits, "-" or "_".',
    );
  }
  const stagingRoot = await ensureRealDirectory(projectDir, [...relativeDir, MATTE_STAGING_DIR]);
  const directory = path.join(stagingRoot, jobId);
  const lockPath = path.join(stagingRoot, `${jobId}${LOCK_SUFFIX}`);
  await acquireStagingLock(lockPath, options.isProcessAlive ?? defaultIsProcessAlive);
  const inputsDirectory = path.join(directory, 'inputs');
  try {
    try {
      // Not recursive: an existing directory for this id is refused unless it is being adopted.
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      if (options.adoptOrphan !== true) {
        throw new MatteStagingError('staging_exists', 'A matte job with this id is already staged.');
      }
      await adoptOrphanedStaging(stagingRoot, jobId, options.identity);
    }
    await mkdir(path.join(inputsDirectory, 'corrections'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(inputsDirectory, 'locked'), { recursive: true, mode: 0o700 });
    if (options.identity !== undefined) await writeStagingIdentity(inputsDirectory, options.identity);
  } catch (error) {
    await releaseStagingLock(lockPath);
    throw error;
  }
  return {
    jobId,
    stagingRoot,
    directory,
    inputsDirectory,
    async writeInput(file, bytes) {
      if (!MatteInputFileSchema.safeParse(file).success) {
        throw new MatteStagingError(
          'invalid_input',
          'Matte input names are corrections/<pts>.png or locked/<pts>.png.',
        );
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
          throw new MatteStagingError(
            'unsafe_path',
            'The previous matte holds a link or folder where a file belongs.',
          );
        }
        await copyFile(
          source,
          path.join(target, name),
          fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
        );
        cloned.push(`previous/${name}`);
      }
      return cloned;
    },
    outputHandle(allowedFiles, maxBytes) {
      return {
        handleId: `matte-out:${jobId}`,
        absolutePath: directory,
        allowedFiles: [...allowedFiles],
        maxBytes,
      };
    },
    inputHandle(files) {
      if (files.length === 0) return undefined;
      return { handleId: `matte-in:${jobId}`, absolutePath: inputsDirectory, files: [...files] };
    },
    async temporaryDirectory() {
      const scratch = await realSubdirectory(directory, MATTE_SCRATCH_DIR);
      return await realSubdirectory(scratch, MATTE_TEMP_DIR);
    },
    async clearTemporaryDirectory() {
      const scratch = path.join(directory, MATTE_SCRATCH_DIR);
      await rm(path.join(scratch, MATTE_TEMP_DIR), { recursive: true, force: true });
      try {
        // Not recursive: only an EMPTY scratch folder is the host's to remove.
        await rmdir(scratch);
      } catch (error) {
        if (!isCode(error, 'ENOENT') && !isCode(error, 'ENOTEMPTY') && !isCode(error, 'ENOTDIR')) throw error;
      }
    },
    async discard() {
      await removeQuietly(directory, 'discard');
      await releaseStagingLock(lockPath);
    },
    async release() {
      await releaseStagingLock(lockPath);
    },
  };
}

/** The worker's scratch folder, and the temp folder the host makes inside it (F3). */
export const MATTE_SCRATCH_DIR = 'scratch';
export const MATTE_TEMP_DIR = 'tmp';

/** `parent/name` as a real directory (created 0700 when missing); a link or file refuses. */
async function realSubdirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MatteStagingError('unsafe_path', 'A staging folder is a link or a file.');
  }
  return target;
}

/**
 * How deep and how wide a checkpoint tree may be for resume to keep it (F6). The worker writes
 * `windows/<index>/<file>` (depth 2), and a 3-hour 60 fps clip is ~2 200 windows of a few files.
 */
const CHECKPOINT_MAX_DEPTH = 6;
const CHECKPOINT_MAX_ENTRIES = 50_000;

/**
 * True when `root` and everything under it are real directories and regular files with one
 * link each (no symlinks, no hard-link aliases of files elsewhere), within the depth and entry
 * bounds. Anything else, including a read failure, is false: the tree is then removed.
 */
async function linkFree(root: string): Promise<boolean> {
  let entries = 0;
  const walk = async (current: string, depth: number): Promise<boolean> => {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory()) return stat.isFile() && stat.nlink === 1;
    if (depth >= CHECKPOINT_MAX_DEPTH) return false;
    for (const entry of await readdir(current)) {
      entries += 1;
      if (entries > CHECKPOINT_MAX_ENTRIES) return false;
      if (!(await walk(path.join(current, entry), depth + 1))) return false;
    }
    return true;
  };
  return await walk(root, 0).catch(() => false);
}

/**
 * Empty an orphaned staging directory except the worker's window checkpoints, so a resumed job
 * starts from its finished windows (the worker re-checks each checkpoint's request and pipeline
 * fingerprint and recomputes any that do not match). A checkpoint tree holding a link anywhere
 * is removed too: resume is an optimisation, never a reason to follow a planted link.
 */
async function adoptOrphanedStaging(
  stagingRoot: string,
  jobId: string,
  identity: MatteStagingIdentity | undefined,
): Promise<void> {
  const directory = path.join(stagingRoot, jobId);
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MatteStagingError('unsafe_path', 'The staging folder is a link or a file.');
  }
  await assertStagingDirectoryReal(stagingRoot, jobId);
  // Read before `inputs/` goes: a different job's (or different media's) windows never survive.
  const sameJob = await stagingIdentityMatches(directory, identity);
  let keptWindows = false;
  for (const entry of await readdir(directory)) {
    const entryPath = path.join(directory, entry);
    if (sameJob && entry === MATTE_WINDOWS_DIR && (await linkFree(entryPath))) {
      keptWindows = (await lstat(entryPath)).isDirectory();
      if (keptWindows) continue;
    }
    await rm(entryPath, { recursive: true, force: true });
  }
  // Nothing moved the folder while it was being emptied (F6).
  await assertStagingDirectoryReal(stagingRoot, jobId);
  log.action('matteStagingAdopted', { keptWindows, sameJob });
}

/** `realpath(<stagingRoot>/<jobId>)` must be the staging root's realpath plus the id. */
async function assertStagingDirectoryReal(stagingRoot: string, jobId: string): Promise<void> {
  const [rootReal, directoryReal] = await Promise.all([
    realpath(stagingRoot),
    realpath(path.join(stagingRoot, jobId)),
  ]);
  if (directoryReal !== path.join(rootReal, jobId)) {
    throw new MatteStagingError('unsafe_path', 'The staging folder resolves outside the staging root.');
  }
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
  staging: Pick<MatteStaging, 'directory' | 'inputsDirectory'> & Partial<Pick<MatteStaging, 'release'>>,
  key: string,
  /**
   * The files verification accepted. Re-checked immediately before the rename: exactly these
   * names, regular files with one link each (no hard-link alias into the committed store) and the
   * verified sizes (BR4.12 H1). Omit only in tests of the rename itself.
   */
  verifiedFiles?: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly ino?: number;
    readonly mtimeMs?: number;
  }[],
  /** Which derived-artifact store to commit into; tracks use the same mechanism (MK7.1). */
  relativeDir: readonly string[] = MATTES_RELATIVE_DIR,
): Promise<MatteCommitOutcome> {
  if (!isMatteCacheKey(key))
    throw new MatteStagingError('invalid_key', 'Matte cache key is malformed.');
  const target = path.join(path.resolve(projectDir), ...relativeDir, key);
  const mattesRoot = await ensureRealDirectory(projectDir, [...relativeDir]);
  if (path.dirname(path.dirname(staging.directory)) !== mattesRoot) {
    throw new MatteStagingError(
      'unsafe_path',
      'Staging directory is not inside this project’s matte store.',
    );
  }
  await rm(staging.inputsDirectory, { recursive: true, force: true });
  if (verifiedFiles !== undefined) await assertStagingUnchanged(staging.directory, verifiedFiles);
  if (await exists(target)) {
    await removeQuietly(staging.directory, 'duplicate');
    await staging.release?.();
    return 'already_present';
  }
  try {
    await rename(staging.directory, target);
  } catch (error) {
    // A concurrent commit of the same key landed between the check and the rename.
    if ((isCode(error, 'ENOTEMPTY') || isCode(error, 'EEXIST')) && (await exists(target))) {
      await removeQuietly(staging.directory, 'duplicate');
      await staging.release?.();
      return 'already_present';
    }
    throw error;
  }
  await staging.release?.();
  return 'committed';
}

async function assertStagingUnchanged(
  directory: string,
  verifiedFiles: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly ino?: number;
    readonly mtimeMs?: number;
  }[],
): Promise<void> {
  const changed = (): MatteStagingError =>
    new MatteStagingError(
      'changed_after_verify',
      'The background removal files changed after they were checked.',
    );
  const self = await lstat(directory);
  if (!self.isDirectory() || self.isSymbolicLink()) throw changed();
  const expected = new Map(verifiedFiles.map((file) => [file.name, file]));
  const entries = await readdir(directory);
  if (entries.length !== expected.size) throw changed();
  for (const name of entries) {
    const file = expected.get(name);
    if (file === undefined) throw changed();
    const stat = await lstat(path.join(directory, name));
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes) throw changed();
    // Same inode and mtime as when verified: a same-size rewrite or replacement is refused too.
    if (
      (file.ino !== undefined && stat.ino !== file.ino) ||
      (file.mtimeMs !== undefined && stat.mtimeMs !== file.mtimeMs)
    ) {
      throw changed();
    }
  }
}

export interface MatteStagingSweepOptions {
  readonly now: Date;
  readonly activeJobIds: ReadonlySet<string>;
  readonly maxAgeMs?: number;
  /** Test seam, as for `createMatteStaging`. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** True when the job's lock names another running process (a link or junk lock is not a holder). */
async function heldByAnotherProcess(lockPath: string, isProcessAlive: (pid: number) => boolean): Promise<boolean> {
  let holder: number | 'gone';
  try {
    holder = await readLockHolder(lockPath);
  } catch {
    return false;
  }
  return holder !== 'gone' && holder !== process.pid && isProcessAlive(holder);
}

/**
 * Remove staging directories no live job owns and nobody touched for 24 h (startup sweep).
 *
 * Links and stray files in `.staging` are removed without being followed. Returns how many
 * entries went.
 */
export async function sweepMatteStaging(
  projectDir: string,
  options: MatteStagingSweepOptions,
): Promise<number> {
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
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  for (const entry of await readdir(root)) {
    const jobId = entry.endsWith(LOCK_SUFFIX) ? entry.slice(0, -LOCK_SUFFIX.length) : entry;
    // A live job keeps its directory and its lock, however old.
    if (options.activeJobIds.has(jobId)) continue;
    const entryPath = path.join(root, entry);
    let stat;
    try {
      stat = await lstat(entryPath);
    } catch {
      continue;
    }
    if (options.now.getTime() - stat.mtimeMs < maxAge) continue;
    // Another running app instance's job is not an orphan (F5); its lock says so.
    if (await heldByAnotherProcess(path.join(root, `${jobId}${LOCK_SUFFIX}`), isProcessAlive)) continue;
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
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
