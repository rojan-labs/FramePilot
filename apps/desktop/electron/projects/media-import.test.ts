import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeMediaImportChunk } from '@framepilot/shared-types';
import { PathTraversalError } from '@framepilot/shared-types/safety';
import {
  type MediaImportIO,
  attachmentsRelativeDir,
  importMediaChunk,
  importMediaFile,
  nodeMediaImportIO,
  safeFileName,
  sweepUnreferencedAttachments,
  sweepUnreferencedAttachmentsOnce,
} from './media-import.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);

function fakeIO(existing: ReadonlySet<string> = new Set()): MediaImportIO & {
  readonly written: Map<string, Uint8Array>;
  readonly renamed: Array<[string, string]>;
  readonly mkdirs: string[];
  readonly unlinked: string[];
} {
  const present = new Set(existing);
  const written = new Map<string, Uint8Array>();
  const renamed: Array<[string, string]> = [];
  const mkdirs: string[] = [];
  const unlinked: string[] = [];
  return {
    written,
    renamed,
    mkdirs,
    unlinked,
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
    readdir: async (dir) =>
      [...present].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f)),
    unlink: async (file) => {
      present.delete(file);
      written.delete(file);
      unlinked.push(file);
    },
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

  it('gives two concurrent same-name uploads two distinct files', async () => {
    // The regression: `dedupeName` can only ask whether the FINAL file exists, and during a
    // chunked upload it does not — the bytes sit in a per-upload `.part` file. Both uploads
    // of `clip.mp4` therefore resolved to the same relative path and both renamed onto it:
    // two assets in the bin, one set of bytes, the other user's file silently gone.
    const io = fakeIO();
    const chunk = (uploadId: string, byte: number): Uint8Array =>
      new Uint8Array(
        encodeMediaImportChunk({ uploadId, offset: 0, final: false }, new Uint8Array([byte])),
      );
    const [a, b] = await Promise.all([
      importMediaFile(root, 'concurrent_demo', 'clip.mp4', chunk('u1', 1), io),
      importMediaFile(root, 'concurrent_demo', 'clip.mp4', chunk('u2', 2), io),
    ]);
    expect(new Set([a, b])).toEqual(
      new Set(['media/concurrent_demo/clip.mp4', 'media/concurrent_demo/clip_2.mp4']),
    );

    // And the reservation survives until the rename, so the finals land on both paths.
    const final = (uploadId: string, target: string, byte: number): Uint8Array =>
      new Uint8Array(
        encodeMediaImportChunk(
          { uploadId, offset: 1, final: true, targetPath: target },
          new Uint8Array([byte]),
        ),
      );
    await importMediaFile(root, 'concurrent_demo', 'clip.mp4', final('u1', a!, 3), io);
    await importMediaFile(root, 'concurrent_demo', 'clip.mp4', final('u2', b!, 4), io);
    expect(io.renamed.map(([, to]) => to).sort()).toEqual(
      [path.join(root, ...a!.split('/')), path.join(root, ...b!.split('/'))].sort(),
    );
  });

  it('releases the reserved name once the upload is renamed into place', async () => {
    // A held-forever reservation would push every later import of the same file to `_2`.
    const io = fakeIO();
    const whole = (uploadId: string): Uint8Array =>
      new Uint8Array(encodeMediaImportChunk({ uploadId, offset: 0, final: true }, BYTES));
    expect(await importMediaFile(root, 'release_demo', 'clip.mp4', whole('u1'), io)).toBe(
      'media/release_demo/clip.mp4',
    );
    // The real file now exists, so the SECOND import dedupes on disk (not on a stale
    // reservation) and still gets a distinct name rather than a third one.
    expect(await importMediaFile(root, 'release_demo', 'clip.mp4', whole('u2'), io)).toBe(
      'media/release_demo/clip_2.mp4',
    );
  });

  it("sweeps a previous session's abandoned .part fragment on the first import", async () => {
    // A crash mid-import of a camera file leaves multi-GB of `.part` the user cannot see:
    // no asset references it and `fp-media://` will not serve it. Nothing swept them.
    const dir = path.join(root, 'media', 'sweep_demo');
    const abandoned = path.join(dir, 'huge.mov.deadbeef.part');
    const io = fakeIO(new Set([abandoned, path.join(dir, 'keep.mp4')]));
    const first = new Uint8Array(
      encodeMediaImportChunk({ uploadId: 'u9', offset: 0, final: false }, new Uint8Array([1])),
    );
    await importMediaFile(root, 'sweep_demo', 'clip.mp4', first, io);
    expect(io.unlinked).toEqual([abandoned]);
    // Only fragments: a real media file in the same directory is untouched.
    expect(await io.exists(path.join(dir, 'keep.mp4'))).toBe(true);
  });

  it('never sweeps a .part this session is still writing', async () => {
    // The sweep runs on a project's FIRST import, which can be concurrent with another
    // upload's first chunk. Deleting that upload's fragment would lose a live import.
    const io = fakeIO();
    const first = (uploadId: string): Uint8Array =>
      new Uint8Array(
        encodeMediaImportChunk({ uploadId, offset: 0, final: false }, new Uint8Array([1])),
      );
    await Promise.all([
      importMediaFile(root, 'live_demo', 'a.mp4', first('ua'), io),
      importMediaFile(root, 'live_demo', 'b.mp4', first('ub'), io),
    ]);
    expect(io.unlinked).toEqual([]);
    expect([...io.written.keys()].every((f) => f.endsWith('.part'))).toBe(true);
  });

  it('rejects an out-of-order chunk without leaving the reservation unusable', async () => {
    // Exercises `importMediaChunk` directly (the typed production entry point).
    const io = fakeIO();
    const rel = await importMediaChunk(
      root,
      'direct_demo',
      'clip.mp4',
      { uploadId: 'u1', offset: 0, final: false },
      new Uint8Array([1, 2]),
      io,
    );
    expect(rel).toBe('media/direct_demo/clip.mp4');
    await expect(
      importMediaChunk(
        root,
        'direct_demo',
        'clip.mp4',
        { uploadId: 'u1', offset: 9, final: true, targetPath: rel },
        new Uint8Array([3]),
        io,
      ),
    ).rejects.toThrow('out of order');
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
    expect(nodeMediaImportIO.readdir).toBeTypeOf('function');
    expect(nodeMediaImportIO.unlink).toBeTypeOf('function');
  });
});

/**
 * The attachment half of the media directory (D2).
 *
 * The defect these cover: an AI-sidebar attachment was copied into the SAME folder as the
 * media bin's assets and then referenced by nothing the app could enumerate, so every
 * attach, retry and duplicate left a camera-sized file behind permanently. The fix is a
 * folder nothing else writes into plus a project-wide reachability sweep, and the
 * property that matters most is the one asserted first: the sweep cannot reach bin media.
 */
describe('reference attachments', () => {
  let root: string;
  /** Unique per test — the session-scoped live/swept sets are module state by design. */
  let projectId: string;
  let sequence = 0;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'fp-attach-')));
    sequence += 1;
    projectId = `attach_project_${String(sequence)}`;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const importAttachment = async (
    io: MediaImportIO,
    fileName: string,
    uploadId = 'u1',
  ): Promise<string> =>
    importMediaChunk(
      root,
      projectId,
      fileName,
      { uploadId, offset: 0, final: true, destination: 'attachments' },
      BYTES,
      io,
    );

  it('lands an attachment in its own folder and a bin import in the media root', async () => {
    const io = fakeIO();
    expect(await importAttachment(io, 'mood.mp4')).toBe(`media/${projectId}/attachments/mood.mp4`);
    expect(
      await importMediaChunk(
        root,
        projectId,
        'mood.mp4',
        { uploadId: 'u2', offset: 0, final: true },
        BYTES,
        io,
      ),
    ).toBe(`media/${projectId}/mood.mp4`);
  });

  it('never touches media outside the attachments folder, whatever the reference set says', async () => {
    const io = fakeIO();
    // The user's footage, in the media root — including a file with the SAME name as the
    // attachment, which is the case a name-based rule would have destroyed.
    const binDir = path.join(root, 'media', projectId);
    await io.writeFile(path.join(binDir, 'camera_a001.mov'), BYTES);
    await io.writeFile(path.join(binDir, 'mood.mp4'), BYTES);
    await io.writeFile(path.join(binDir, 'sources.json'), BYTES);
    await importAttachment(io, 'mood.mp4');

    // An empty reference set: as unreachable as the rule can ever conclude.
    expect(await sweepUnreferencedAttachments(root, projectId, [], io)).toBe(0);
    expect(io.unlinked).toEqual([]);
    expect(await io.exists(path.join(binDir, 'camera_a001.mov'))).toBe(true);
    expect(await io.exists(path.join(binDir, 'mood.mp4'))).toBe(true);
  });

  it('keeps a file this session imported even before any conversation names it', async () => {
    const io = fakeIO();
    // The chip is on screen and its conversation has not been saved yet — the exact
    // window `liveAttachmentPaths` exists to cover.
    const rel = await importAttachment(io, 'mood.mp4');
    expect(await sweepUnreferencedAttachments(root, projectId, [], io)).toBe(0);
    expect(await io.exists(path.join(root, rel))).toBe(true);
  });

  it('reclaims an attachment nothing references, with its analysis cache', async () => {
    const io = fakeIO();
    const dir = path.join(root, 'media', projectId, 'attachments');
    // Written directly, i.e. imported by a PREVIOUS session: no live claim protects it.
    await io.writeFile(path.join(dir, 'stale.mp4'), BYTES);
    await io.writeFile(path.join(dir, 'stale.mp4.reference.json'), BYTES);
    await io.writeFile(path.join(dir, 'kept.mp4'), BYTES);
    await io.writeFile(path.join(dir, 'kept.mp4.reference.json'), BYTES);

    expect(
      await sweepUnreferencedAttachments(
        root,
        projectId,
        [`media/${projectId}/attachments/kept.mp4`],
        io,
      ),
    ).toBe(2);
    expect(await io.exists(path.join(dir, 'stale.mp4'))).toBe(false);
    expect(await io.exists(path.join(dir, 'stale.mp4.reference.json'))).toBe(false);
    expect(await io.exists(path.join(dir, 'kept.mp4'))).toBe(true);
    expect(await io.exists(path.join(dir, 'kept.mp4.reference.json'))).toBe(true);
  });

  it('keeps a file one message still shows when another conversation dropped it', async () => {
    const io = fakeIO();
    const dir = path.join(root, 'media', projectId, 'attachments');
    await io.writeFile(path.join(dir, 'shared.mp4'), BYTES);
    // The union over the project is the rule: one surviving reference is enough.
    expect(
      await sweepUnreferencedAttachments(
        root,
        projectId,
        [`media/${projectId}/attachments/shared.mp4`],
        io,
      ),
    ).toBe(0);
    expect(await io.exists(path.join(dir, 'shared.mp4'))).toBe(true);
  });

  it('reclaims nothing when the reference set could not be established', async () => {
    const io = fakeIO();
    const dir = path.join(root, 'media', projectId, 'attachments');
    await io.writeFile(path.join(dir, 'stale.mp4'), BYTES);
    // `null` is "I could not read every conversation", which must never read as
    // "nothing references it".
    expect(await sweepUnreferencedAttachments(root, projectId, null, io)).toBe(0);
    expect(await io.exists(path.join(dir, 'stale.mp4'))).toBe(true);
  });

  it('leaves a .part fragment to the upload sweep that knows if it is live', async () => {
    const io = fakeIO();
    const dir = path.join(root, 'media', projectId, 'attachments');
    await io.writeFile(path.join(dir, 'huge.mp4.u9.part'), BYTES);
    expect(await sweepUnreferencedAttachments(root, projectId, [], io)).toBe(0);
    expect(await io.exists(path.join(dir, 'huge.mp4.u9.part'))).toBe(true);
  });

  it('sweeps a project once per session and then stops asking', async () => {
    const io = fakeIO();
    const dir = path.join(root, 'media', projectId, 'attachments');
    await io.writeFile(path.join(dir, 'stale.mp4'), BYTES);
    let loads = 0;
    const load = async (): Promise<string[]> => {
      loads += 1;
      return [];
    };
    expect(await sweepUnreferencedAttachmentsOnce(root, projectId, load, io)).toBe(1);
    await io.writeFile(path.join(dir, 'stale2.mp4'), BYTES);
    expect(await sweepUnreferencedAttachmentsOnce(root, projectId, load, io)).toBe(0);
    // The reference set is not even read the second time — the guard is the cheap path.
    expect(loads).toBe(1);
    expect(await io.exists(path.join(dir, 'stale2.mp4'))).toBe(true);
  });

  it('names the attachments directory relative to the projects root', () => {
    expect(attachmentsRelativeDir('Project Demo')).toBe('media/project_demo/attachments');
  });
});
