/**
 * Per-project media import.
 *
 * Production desktop imports use the explicit typed chunk contract. Historical framed
 * and raw requests remain accepted through `importMediaFile` for bridge compatibility.
 */
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeMediaImportChunk, type MediaImportChunkHeader } from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';

const MEDIA_DIR = 'media';

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

/** Exported for the music download path — see {@link safeProjectId}. */
export async function dedupeName(
  dir: string,
  safeName: string,
  io: MediaImportIO,
): Promise<string> {
  if (!(await io.exists(path.join(dir, safeName)))) return safeName;
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}_${n}${ext}`;
    if (!(await io.exists(path.join(dir, candidate)))) return candidate;
  }
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
  const finalName = await dedupeName(absoluteDir, safeName, io);
  const relativePath = path.posix.join(relativeDir, finalName);
  const absolutePath = resolveWithin(projectsRoot, relativePath);
  const tempPath = `${absolutePath}.${process.pid}.tmp`;
  await io.writeFile(tempPath, data);
  await io.rename(tempPath, absolutePath);
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
      ? path.posix.join(relativeDir, await dedupeName(absoluteDir, safeName, io))
      : continuationPath(relativeDir, header.targetPath ?? '');
  const absolutePath = resolveWithin(projectsRoot, relativePath);
  const tempPath = `${absolutePath}.${header.uploadId}.part`;

  if (header.offset === 0) {
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

  if (header.final) await io.rename(tempPath, absolutePath);
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
