/**
 * Per-project media import.
 *
 * Production desktop imports use the explicit typed chunk contract. Historical framed
 * and raw requests remain accepted through `importMediaFile` for bridge compatibility.
 */
import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createLogger,
  decodeMediaImportChunk,
  type MediaImportChunkHeader,
} from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';

const log = createLogger('desktop:media-import');

const MEDIA_DIR = 'media';

/** Suffix of an upload's in-progress file, before it is renamed into place. */
const PART_SUFFIX = '.part';

/**
 * Final absolute paths claimed by an upload that has not been renamed into place yet.
 *
 * WHY this exists in memory rather than on disk: `dedupeName` can only ask whether the
 * FINAL file exists, and during a chunked upload it does not — the bytes are in a
 * `.<uploadId>.part` file whose name no other upload can see. So two concurrent imports of
 * `clip.mp4` both resolved to `media/<project>/clip.mp4`, wrote separate `.part` files, and
 * both renamed onto the same path: two assets in the bin, one set of bytes, the other
 * file's content silently gone. A disk placeholder cannot fix it either — both uploads
 * `await` the existence check before either could create one, so they would still collide.
 * An in-memory set claimed in the same synchronous step as the decision is what makes the
 * reservation race-free.
 *
 * Released only on the successful final rename, never on error: a failed or abandoned
 * upload may still deliver its final chunk, and letting a later import take the name it
 * would rename onto is the very data loss this prevents. The cost of holding it is one
 * `_2` suffix for the rest of the session.
 */
const reservedFinalPaths = new Set<string>();

/**
 * `.part` paths of uploads still receiving chunks, so the sweep never deletes live bytes.
 */
const activeUploadParts = new Set<string>();

/**
 * Media directories already swept for abandoned `.part` fragments this session.
 *
 * Swept lazily on a project's first import rather than at startup — the same shape
 * `StockService.sweepPartialDownloads` uses: it needs no new IPC, cannot delay app launch,
 * and a project that never imports has nothing to sweep.
 */
const sweptMediaDirs = new Set<string>();

/** The project-relative media directory. One definition, every writer. */
export function mediaRelativeDir(projectId: string): string {
  return path.posix.join(MEDIA_DIR, safeProjectId(projectId));
}

export interface MediaImportIO {
  mkdirp(dir: string): Promise<void>;
  writeFile(file: string, data: Uint8Array): Promise<void>;
  appendFile(file: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  size(file: string): Promise<number>;
  /** Directory listing for the abandoned-`.part` sweep; `[]` when the directory is absent. */
  readdir(dir: string): Promise<string[]>;
  /** Best-effort delete for the sweep; never throws for a file that is already gone. */
  unlink(file: string): Promise<void>;
}

export const nodeMediaImportIO: MediaImportIO = {
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (file, data) => {
    await writeFile(file, data);
  },
  appendFile: async (file, data) => {
    await appendFile(file, data);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  exists: async (file) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  },
  size: async (file) => {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  },
  readdir: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      // No media directory yet — nothing imported, nothing to sweep.
      return [];
    }
  },
  unlink: async (file) => {
    try {
      await unlink(file);
    } catch {
      // Held open by another window, or already gone. Losing a sweep costs disk;
      // failing an import over it would cost the user their file.
    }
  },
};

export function safeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/\\/g, '_').trim();
  const ext = path.extname(base);
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  const safeExt = ext.replace(/[^a-zA-Z0-9.]+/g, '');
  return `${stem || 'media'}${safeExt}`;
}

/**
 * Exported so the music download path lands files in exactly the directory
 * imported ones do. Downloaded media is not special: `fp-media://` and the
 * render engine must resolve it with no change, which means it must not get its
 * own directory scheme (`plan/3rd-party-sourcing/PHASE-3-download-and-place.md`).
 */
export function safeProjectId(projectId: string): string {
  const safe = path
    .basename(projectId)
    .replace(/\\/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return safe || 'untitled';
}

/**
 * Find `safeName`, `stem_2`, `stem_3`… — the first that is neither on disk nor reserved —
 * and optionally claim it.
 *
 * The reservation check is repeated AFTER the `exists` await and the claim is made in the
 * same synchronous step as that second check. That adjacency is the whole mechanism: an
 * `await` between deciding a name and claiming it is exactly the window two concurrent
 * imports of `clip.mp4` used to race through, and a claim that is not adjacent to its
 * check is not a claim at all.
 *
 * @param claim - Called synchronously with the winning absolute path, or `null` to only ask.
 */
async function pickFreeName(
  dir: string,
  safeName: string,
  io: MediaImportIO,
  reserved: ReadonlySet<string>,
  claim: ((absolutePath: string) => void) | null,
): Promise<string> {
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? safeName : `${stem}_${String(n)}${ext}`;
    const candidate = path.join(dir, name);
    if (reserved.has(candidate)) continue;
    if (await io.exists(candidate)) continue;
    if (reserved.has(candidate)) continue;
    claim?.(candidate);
    return name;
  }
}

/**
 * Exported for the music download path — see {@link safeProjectId}.
 *
 * A candidate is free only when it is neither on disk NOR reserved by an upload that is
 * still streaming (see {@link reservedFinalPaths}); an in-flight upload's final file does
 * not exist yet, so disk alone cannot answer the question.
 */
export async function dedupeName(
  dir: string,
  safeName: string,
  io: MediaImportIO,
  reserved: ReadonlySet<string> = reservedFinalPaths,
): Promise<string> {
  return pickFreeName(dir, safeName, io, reserved, null);
}

/**
 * Pick a deduped name and reserve it, uninterrupted — see {@link pickFreeName}.
 *
 * Keyed by `path.join(dir, name)`, which is the same string `resolveWithin` produces for
 * that file (it resolves the candidate against the already-resolved directory), so the
 * caller can release the reservation using its sandbox-resolved absolute path.
 *
 * @returns The claimed file name, whose absolute path is now in {@link reservedFinalPaths}.
 */
async function claimName(dir: string, safeName: string, io: MediaImportIO): Promise<string> {
  return pickFreeName(dir, safeName, io, reservedFinalPaths, (claimed) =>
    reservedFinalPaths.add(claimed),
  );
}

/**
 * Delete `.part` fragments a previous session abandoned in a project's media directory.
 *
 * A chunked import writes to `<file>.<uploadId>.part` and renames only on the final chunk.
 * A crash, a closed window, or a renderer that simply stops sending leaves that fragment
 * behind forever: it is invisible to the media bin (no asset references it) and to
 * `fp-media://`, while a half-imported camera file can be several GB of disk the user
 * cannot see or reclaim. Nothing swept them.
 *
 * Best-effort by construction, and never touches a `.part` this session is still writing.
 *
 * @returns How many fragments were removed.
 */
async function sweepAbandonedUploads(absoluteDir: string, io: MediaImportIO): Promise<number> {
  let removed = 0;
  for (const entry of await io.readdir(absoluteDir)) {
    if (!entry.endsWith(PART_SUFFIX)) continue;
    const fragment = path.join(absoluteDir, entry);
    if (activeUploadParts.has(fragment)) continue;
    await io.unlink(fragment);
    removed += 1;
  }
  if (removed > 0) log.action('swept abandoned media uploads', { dir: absoluteDir, removed });
  return removed;
}

function continuationPath(relativeDir: string, targetPath: string): string {
  const normalized = path.posix.normalize(targetPath);
  if (normalized !== targetPath || path.posix.dirname(normalized) !== relativeDir) {
    throw new Error('Media import continuation target is outside its project media directory.');
  }
  return normalized;
}

async function importLegacyWholeFile(
  projectsRoot: string,
  relativeDir: string,
  safeName: string,
  data: Uint8Array,
  io: MediaImportIO,
): Promise<string> {
  const absoluteDir = resolveWithin(projectsRoot, relativeDir);
  await io.mkdirp(absoluteDir);
  // Reserved like a chunked import: this path also awaits between deciding a name and
  // creating the file, so two whole-file imports of `clip.mp4` could otherwise collide.
  const finalName = await claimName(absoluteDir, safeName, io);
  const relativePath = path.posix.join(relativeDir, finalName);
  const absolutePath = resolveWithin(projectsRoot, relativePath);
  const tempPath = `${absolutePath}.${String(process.pid)}.tmp`;
  try {
    await io.writeFile(tempPath, data);
    await io.rename(tempPath, absolutePath);
  } finally {
    reservedFinalPaths.delete(absolutePath);
  }
  return relativePath;
}

/** Persist one validated bounded chunk under the project media sandbox. */
export async function importMediaChunk(
  projectsRoot: string,
  projectId: string,
  fileName: string,
  header: MediaImportChunkHeader,
  payload: Uint8Array,
  io: MediaImportIO = nodeMediaImportIO,
): Promise<string> {
  const safeId = safeProjectId(projectId);
  const safeName = safeFileName(fileName);
  const relativeDir = path.posix.join(MEDIA_DIR, safeId);
  const absoluteDir = resolveWithin(projectsRoot, relativeDir);
  await io.mkdirp(absoluteDir);

  const relativePath =
    header.offset === 0
      ? path.posix.join(relativeDir, await claimName(absoluteDir, safeName, io))
      : continuationPath(relativeDir, header.targetPath ?? '');
  const absolutePath = resolveWithin(projectsRoot, relativePath);
  const tempPath = `${absolutePath}.${header.uploadId}${PART_SUFFIX}`;

  if (header.offset === 0) {
    // Registered before the sweep runs, so a concurrent first chunk cannot delete it.
    activeUploadParts.add(tempPath);
    // Claimed synchronously, so concurrent first chunks sweep this directory exactly once.
    if (!sweptMediaDirs.has(absoluteDir)) {
      sweptMediaDirs.add(absoluteDir);
      await sweepAbandonedUploads(absoluteDir, io);
    }
    await io.writeFile(tempPath, payload);
  } else {
    const currentSize = await io.size(tempPath);
    if (currentSize !== header.offset) {
      throw new Error(
        `Media import chunk is out of order: expected offset ${currentSize}, received ${header.offset}.`,
      );
    }
    await io.appendFile(tempPath, payload);
  }

  if (header.final) {
    await io.rename(tempPath, absolutePath);
    // The file now exists, so `dedupeName`'s on-disk check answers for it from here on.
    activeUploadParts.delete(tempPath);
    reservedFinalPaths.delete(absolutePath);
  }
  return relativePath;
}

/** Compatibility entry point for the historical media-import channel. */
export async function importMediaFile(
  projectsRoot: string,
  projectId: string,
  fileName: string,
  data: Uint8Array,
  io: MediaImportIO = nodeMediaImportIO,
): Promise<string> {
  const safeId = safeProjectId(projectId);
  const safeName = safeFileName(fileName);
  const relativeDir = path.posix.join(MEDIA_DIR, safeId);
  const decoded = decodeMediaImportChunk(data);
  if (decoded === null) {
    return importLegacyWholeFile(projectsRoot, relativeDir, safeName, data, io);
  }
  return importMediaChunk(projectsRoot, projectId, fileName, decoded.header, decoded.payload, io);
}
