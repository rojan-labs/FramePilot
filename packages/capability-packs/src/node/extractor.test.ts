import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import type { CapabilityPackArtifact } from '../contracts.js';
import { CapabilityPackExtractionError, extractCapabilityPack } from './extractor.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-extractor-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createZip(
  root: string,
  entries: readonly { name: string; bytes: Buffer; mode?: number }[],
): Promise<string> {
  const filePath = path.join(root, `artifact-${Math.random().toString(16).slice(2)}.zip`);
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(entry.bytes, entry.name, {
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      mtime: new Date('2026-08-13T00:00:00.000Z'),
    });
  }
  const output = createWriteStream(filePath, { flags: 'wx' });
  zip.outputStream.pipe(output);
  zip.end();
  await finished(output);
  return filePath;
}

async function zipArtifact(
  filePath: string,
  files: readonly string[],
  unpackedSizeBytes: number,
  overrides: Partial<CapabilityPackArtifact> = {},
): Promise<CapabilityPackArtifact> {
  const archive = await readFile(filePath);
  return {
    os: 'darwin',
    arch: 'arm64',
    url: 'https://packs.framepilot.ai/worker.zip',
    sha256: createHash('sha256').update(archive).digest('hex'),
    sizeBytes: archive.byteLength,
    unpackedSizeBytes,
    format: 'zip',
    entrypoint: 'bin/worker',
    maxFileCount: files.length,
    files: [...files],
    executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
    ...overrides,
  };
}

describe('extractCapabilityPack', () => {
  it('copies one raw entrypoint into a new staging directory without overwrite', async () => {
    const root = await createRoot();
    const source = path.join(root, 'worker.raw');
    const worker = Buffer.from('worker bytes');
    await writeFile(source, worker);
    const artifact: CapabilityPackArtifact = {
      os: 'darwin',
      arch: 'arm64',
      url: 'https://packs.framepilot.ai/worker.raw',
      sha256: createHash('sha256').update(worker).digest('hex'),
      sizeBytes: worker.byteLength,
      unpackedSizeBytes: worker.byteLength,
      format: 'raw',
      entrypoint: 'bin/worker',
      maxFileCount: 1,
      files: ['bin/worker'],
      executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
    };

    const result = await extractCapabilityPack(root, { artifact, downloadedFilePath: source });

    expect(await readFile(result.entrypointPath)).toEqual(worker);
    expect(result.fileCount).toBe(1);
    expect((await stat(result.entrypointPath)).mode & 0o111).not.toBe(0);
  });

  it('extracts exactly the signed ZIP allowlist and accounts for unpacked bytes', async () => {
    const root = await createRoot();
    const worker = Buffer.from('worker');
    const notice = Buffer.from('MIT');
    const archive = await createZip(root, [
      { name: 'bin/worker', bytes: worker },
      { name: 'NOTICE.txt', bytes: notice },
    ]);
    const artifact = await zipArtifact(
      archive,
      ['bin/worker', 'NOTICE.txt'],
      worker.byteLength + notice.byteLength,
    );

    const result = await extractCapabilityPack(root, {
      artifact,
      downloadedFilePath: archive,
    });

    expect(await readFile(result.entrypointPath)).toEqual(worker);
    expect(result.installedBytes).toBe(worker.byteLength + notice.byteLength);
    expect(result.fileCount).toBe(2);
  });

  it('rejects unsigned extras and removes all staging output', async () => {
    const root = await createRoot();
    const archive = await createZip(root, [
      { name: 'bin/worker', bytes: Buffer.from('worker') },
      { name: 'payload.exe', bytes: Buffer.from('bad') },
    ]);
    const artifact = await zipArtifact(archive, ['bin/worker'], 6, { maxFileCount: 1 });

    await expect(
      extractCapabilityPack(root, { artifact, downloadedFilePath: archive }),
    ).rejects.toMatchObject({ code: 'archive_unsafe' });
    expect((await readdir(root)).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });

  it('rejects missing files and incorrect signed expansion totals', async () => {
    const root = await createRoot();
    const archive = await createZip(root, [{ name: 'bin/worker', bytes: Buffer.from('worker') }]);
    const missing = await zipArtifact(archive, ['bin/worker', 'NOTICE.txt'], 6);
    await expect(
      extractCapabilityPack(root, { artifact: missing, downloadedFilePath: archive }),
    ).rejects.toBeInstanceOf(CapabilityPackExtractionError);

    const wrongSize = await zipArtifact(archive, ['bin/worker'], 7);
    await expect(
      extractCapabilityPack(root, { artifact: wrongSize, downloadedFilePath: archive }),
    ).rejects.toMatchObject({ code: 'archive_unsafe' });
  });

  it('rejects ZIP symbolic links even when their path appears in the allowlist', async () => {
    const root = await createRoot();
    const archive = await createZip(root, [
      { name: 'bin/worker', bytes: Buffer.from('../outside'), mode: 0o120777 },
    ]);
    const artifact = await zipArtifact(archive, ['bin/worker'], 10);

    await expect(
      extractCapabilityPack(root, { artifact, downloadedFilePath: archive }),
    ).rejects.toMatchObject({ code: 'archive_unsafe' });
  });

  it('rejects a traversal name before it can be compared with the signed allowlist', async () => {
    const root = await createRoot();
    const safeArchive = await createZip(root, [
      { name: 'aa/worker', bytes: Buffer.from('worker') },
    ]);
    const maliciousArchive = path.join(root, 'traversal.zip');
    const patched = Buffer.from(await readFile(safeArchive));
    const safeName = Buffer.from('aa/worker');
    const unsafeName = Buffer.from('../worker');
    let replacements = 0;
    for (let index = 0; index <= patched.length - safeName.length; index += 1) {
      if (patched.subarray(index, index + safeName.length).equals(safeName)) {
        unsafeName.copy(patched, index);
        replacements += 1;
      }
    }
    expect(replacements).toBeGreaterThanOrEqual(2);
    await writeFile(maliciousArchive, patched);
    const artifact = await zipArtifact(maliciousArchive, ['bin/worker'], 6);

    await expect(
      extractCapabilityPack(root, { artifact, downloadedFilePath: maliciousArchive }),
    ).rejects.toMatchObject({ code: 'archive_unsafe' });
    await expect(stat(path.resolve(root, '../worker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects signed expansion claims beyond the bounded ratio', async () => {
    const root = await createRoot();
    const source = path.join(root, 'tiny.raw');
    await writeFile(source, 'x');
    const artifact: CapabilityPackArtifact = {
      os: 'darwin',
      arch: 'arm64',
      url: 'https://packs.framepilot.ai/tiny.raw',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      unpackedSizeBytes: 201,
      format: 'raw',
      entrypoint: 'worker',
      maxFileCount: 1,
      files: ['worker'],
      executableTrust: { kind: 'macos_codesign', teamIdentifier: 'ABCDE12345' },
    };

    await expect(
      extractCapabilityPack(root, { artifact, downloadedFilePath: source }),
    ).rejects.toMatchObject({ code: 'archive_unsafe' });
  });
});
