import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeMediaImportChunk } from '@framepilot/shared-types';
import { PathTraversalError } from '@framepilot/shared-types/safety';
import {
  type MediaImportIO,
  importMediaFile,
  nodeMediaImportIO,
  safeFileName,
} from './media-import.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);

function fakeIO(existing: ReadonlySet<string> = new Set()): MediaImportIO & {
  readonly written: Map<string, Uint8Array>;
  readonly renamed: Array<[string, string]>;
  readonly mkdirs: string[];
} {
  const present = new Set(existing);
  const written = new Map<string, Uint8Array>();
  const renamed: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  return {
    written,
    renamed,
    mkdirs,
    mkdirp: async (dir) => {
      mkdirs.push(dir);
    },
    writeFile: async (file, data) => {
      written.set(file, new Uint8Array(data));
      present.add(file);
    },
    appendFile: async (file, data) => {
      const current = written.get(file) ?? new Uint8Array();
      const next = new Uint8Array(current.length + data.length);
      next.set(current);
      next.set(data, current.length);
      written.set(file, next);
      present.add(file);
    },
    rename: async (from, to) => {
      renamed.push([from, to]);
      present.delete(from);
      present.add(to);
    },
    exists: async (file) => present.has(file),
    size: async (file) => written.get(file)?.byteLength ?? 0,
  };
}

describe('safeFileName', () => {
  it('strips directory components but keeps the extension', () => {
    expect(safeFileName('clip.mp4')).toBe('clip.mp4');
    expect(safeFileName('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(safeFileName('a\\b\\evil.mov')).toBe('a_b_evil.mov');
  });

  it('sanitises unsafe characters and falls back for an empty stem', () => {
    expect(safeFileName('my cool clip!.mp4')).toBe('my_cool_clip.mp4');
    expect(safeFileName('///')).toBe('media');
  });
});

describe('importMediaFile', () => {
  let root: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'fp-media-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the legacy atomic whole-file path for older renderers', async () => {
    const io = fakeIO();
    const rel = await importMediaFile(root, 'project_demo', 'clip.mp4', BYTES, io);
    expect(rel).toBe('media/project_demo/clip.mp4');
    expect(io.renamed).toHaveLength(1);
    expect(io.renamed[0]![0].endsWith('.tmp')).toBe(true);
  });

  it('streams bounded chunks into one temp file and renames only on the final chunk', async () => {
    const io = fakeIO();
    const first = new Uint8Array(
      encodeMediaImportChunk({ uploadId: 'u1', offset: 0, final: false }, new Uint8Array([1, 2])),
    );
    const target = await importMediaFile(root, 'project_demo', 'clip.mp4', first, io);
    expect(target).toBe('media/project_demo/clip.mp4');
    expect(io.renamed).toHaveLength(0);

    const second = new Uint8Array(
      encodeMediaImportChunk(
        { uploadId: 'u1', offset: 2, final: true, targetPath: target },
        new Uint8Array([3, 4]),
      ),
    );
    await importMediaFile(root, 'project_demo', 'clip.mp4', second, io);
    expect(io.renamed).toHaveLength(1);
    expect([...io.written.values()][0]).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('rejects duplicate or out-of-order continuation chunks', async () => {
    const io = fakeIO();
    const first = new Uint8Array(
      encodeMediaImportChunk({ uploadId: 'u1', offset: 0, final: false }, new Uint8Array([1, 2])),
    );
    const target = await importMediaFile(root, 'project_demo', 'clip.mp4', first, io);
    const wrong = new Uint8Array(
      encodeMediaImportChunk(
        { uploadId: 'u1', offset: 1, final: true, targetPath: target },
        new Uint8Array([3]),
      ),
    );
    await expect(importMediaFile(root, 'project_demo', 'clip.mp4', wrong, io)).rejects.toThrow(
      'out of order',
    );
  });

  it('rejects a continuation target outside this project media directory', async () => {
    const io = fakeIO();
    const framed = new Uint8Array(
      encodeMediaImportChunk(
        { uploadId: 'u1', offset: 1, final: true, targetPath: 'media/other/clip.mp4' },
        new Uint8Array([2]),
      ),
    );
    await expect(importMediaFile(root, 'project_demo', 'clip.mp4', framed, io)).rejects.toThrow(
      'outside its project media directory',
    );
  });

  it('dedupes the first chunk against existing files', async () => {
    const dir = path.join(root, 'media', 'project_demo');
    const io = fakeIO(new Set([path.join(dir, 'clip.mp4'), path.join(dir, 'clip_2.mp4')]));
    const framed = new Uint8Array(
      encodeMediaImportChunk({ uploadId: 'u2', offset: 0, final: true }, BYTES),
    );
    await expect(importMediaFile(root, 'project_demo', 'clip.mp4', framed, io)).resolves.toBe(
      'media/project_demo/clip_3.mp4',
    );
  });

  it('sanitises project/file traversal inputs before resolving the sandbox path', async () => {
    const io = fakeIO();
    await expect(importMediaFile(root, '..', '../../../../evil.mp4', BYTES, io)).resolves.toBe(
      'media/untitled/evil.mp4',
    );
    expect(PathTraversalError).toBeTypeOf('function');
  });

  it('exposes streaming-capable node IO', () => {
    expect(nodeMediaImportIO.mkdirp).toBeTypeOf('function');
    expect(nodeMediaImportIO.writeFile).toBeTypeOf('function');
    expect(nodeMediaImportIO.appendFile).toBeTypeOf('function');
    expect(nodeMediaImportIO.rename).toBeTypeOf('function');
    expect(nodeMediaImportIO.exists).toBeTypeOf('function');
    expect(nodeMediaImportIO.size).toBeTypeOf('function');
  });
});
