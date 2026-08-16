import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { CapabilityPackArtifactSchema, type CapabilityPackArtifact } from '../contracts.js';

const MAX_EXPANSION_RATIO = 200;

export interface CapabilityPackExtractionRequest {
  readonly artifact: CapabilityPackArtifact;
  readonly downloadedFilePath: string;
  readonly signal?: AbortSignal;
}

export interface ExtractedCapabilityPack {
  readonly stagingPath: string;
  readonly entrypointPath: string;
  readonly installedBytes: number;
  readonly fileCount: number;
}

export class CapabilityPackExtractionError extends Error {
  constructor(
    public readonly code: 'archive_unsafe' | 'download_cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityPackExtractionError';
  }
}

/** Extract an already verified artifact into a new, disposable staging directory. */
export async function extractCapabilityPack(
  stagingRoot: string,
  requestInput: CapabilityPackExtractionRequest,
): Promise<ExtractedCapabilityPack> {
  const artifact = CapabilityPackArtifactSchema.parse(requestInput.artifact);
  const stagingPath = path.join(stagingRoot, `.staging-${randomUUID()}`);
  await mkdir(stagingPath, { recursive: false });
  try {
    throwIfAborted(requestInput.signal);
    if (artifact.unpackedSizeBytes / artifact.sizeBytes > MAX_EXPANSION_RATIO) {
      throw new CapabilityPackExtractionError(
        'archive_unsafe',
        `Signed unpacked size exceeds the ${MAX_EXPANSION_RATIO}:1 expansion limit.`,
      );
    }
    const extracted =
      artifact.format === 'raw'
        ? await extractRaw(stagingPath, artifact, requestInput.downloadedFilePath)
        : await extractZip(stagingPath, artifact, requestInput.downloadedFilePath, requestInput.signal);
    if (artifact.os === 'darwin') await chmod(extracted.entrypointPath, 0o755);
    return { stagingPath, ...extracted };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    if (error instanceof CapabilityPackExtractionError) throw error;
    throw new CapabilityPackExtractionError(
      'archive_unsafe',
      `Capability Pack extraction failed: ${errorMessage(error)}`,
    );
  }
}

async function extractRaw(
  stagingPath: string,
  artifact: CapabilityPackArtifact,
  downloadedFilePath: string,
): Promise<Omit<ExtractedCapabilityPack, 'stagingPath'>> {
  const source = await stat(downloadedFilePath);
  if (!source.isFile() || source.size !== artifact.unpackedSizeBytes) {
    throw new CapabilityPackExtractionError(
      'archive_unsafe',
      'Raw Capability Pack artifact does not match its signed unpacked size.',
    );
  }
  const entrypointPath = resolveEntryPath(stagingPath, artifact.entrypoint);
  await mkdir(path.dirname(entrypointPath), { recursive: true });
  await copyFile(downloadedFilePath, entrypointPath, constants.COPYFILE_EXCL);
  return { entrypointPath, installedBytes: source.size, fileCount: 1 };
}

async function extractZip(
  stagingPath: string,
  artifact: CapabilityPackArtifact,
  downloadedFilePath: string,
  signal?: AbortSignal,
): Promise<Omit<ExtractedCapabilityPack, 'stagingPath'>> {
  const allowed = new Set(artifact.files);
  // Directory validation used to scan the complete signed file list for every directory
  // entry. Large, legitimate packs therefore paid O(entries × files) before writing bytes.
  // Derive every allowed ancestor once so each archive directory is one Set lookup.
  const allowedDirectories = buildAllowedDirectories(allowed);
  const seen = new Set<string>();
  let installedBytes = 0;
  let entryCount = 0;
  const zipFile = await openZip(downloadedFilePath);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error);
      };
      zipFile.on('error', finish);
      zipFile.on('end', () => finish());
      zipFile.on('entry', (entry: Entry) => {
        void processEntry(entry).catch(finish);
      });

      const processEntry = async (entry: Entry): Promise<void> => {
        throwIfAborted(signal);
        entryCount += 1;
        if (entryCount > artifact.maxFileCount * 2 + 100) {
          throw unsafe('Archive contains too many directory or file entries.');
        }
        const name = validateEntryName(entry.fileName);
        const isDirectory = name.endsWith('/');
        if (isSymlink(entry)) throw unsafe(`Archive entry ${name} is a symbolic link.`);
        if (isDirectory) {
          if (!allowedDirectories.has(name)) {
            throw unsafe(`Archive directory ${name} is outside the signed file allowlist.`);
          }
          await mkdir(resolveEntryPath(stagingPath, name), { recursive: true });
          zipFile.readEntry();
          return;
        }
        if (!allowed.has(name)) throw unsafe(`Archive file ${name} is not in the signed allowlist.`);
        if (seen.has(name)) throw unsafe(`Archive contains duplicate file ${name}.`);
        if (seen.size >= artifact.maxFileCount) throw unsafe('Archive exceeds its signed file count.');
        if (installedBytes + entry.uncompressedSize > artifact.unpackedSizeBytes) {
          throw unsafe('Archive expands beyond its signed unpacked size.');
        }
        seen.add(name);
        installedBytes += entry.uncompressedSize;
        const destination = resolveEntryPath(stagingPath, name);
        await mkdir(path.dirname(destination), { recursive: true });
        const input = await openEntry(zipFile, entry);
        await pipeline(input, createWriteStream(destination, { flags: 'wx', mode: 0o644 }), {
          ...(signal === undefined ? {} : { signal }),
        });
        zipFile.readEntry();
      };

      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  const missing = [...allowed].filter((name) => !seen.has(name));
  if (missing.length > 0) throw unsafe(`Archive is missing signed file(s): ${missing.join(', ')}.`);
  if (installedBytes !== artifact.unpackedSizeBytes) {
    throw unsafe(
      `Archive unpacked to ${installedBytes} bytes; expected ${artifact.unpackedSizeBytes}.`,
    );
  }
  return {
    entrypointPath: resolveEntryPath(stagingPath, artifact.entrypoint),
    installedBytes,
    fileCount: seen.size,
  };
}

function buildAllowedDirectories(allowed: ReadonlySet<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of allowed) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join('/')}/`);
    }
  }
  return directories;
}

async function openZip(filePath: string): Promise<ZipFile> {
  return await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error !== null) reject(error);
        else if (zipFile === undefined) reject(new Error('ZIP reader returned no archive.'));
        else resolve(zipFile);
      },
    );
  });
}

async function openEntry(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(error);
      else if (stream === undefined) reject(new Error(`ZIP entry ${entry.fileName} had no stream.`));
      else resolve(stream);
    });
  });
}

function validateEntryName(fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName.startsWith('/') ||
    /^[A-Za-z]:/u.test(fileName)
  ) {
    throw unsafe(`Archive entry has an unsafe path: ${fileName}.`);
  }
  const parts = fileName.replace(/\/$/u, '').split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw unsafe(`Archive entry has traversal segments: ${fileName}.`);
  }
  return fileName;
}

function resolveEntryPath(root: string, entryName: string): string {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, entryName);
  if (resolved === rootPath || !resolved.startsWith(`${rootPath}${path.sep}`)) {
    throw unsafe(`Archive entry escapes staging: ${entryName}.`);
  }
  return resolved;
}

function isSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function unsafe(message: string): CapabilityPackExtractionError {
  return new CapabilityPackExtractionError('archive_unsafe', message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new CapabilityPackExtractionError('download_cancelled', 'Capability Pack extraction cancelled.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
