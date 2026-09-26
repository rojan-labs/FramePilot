/**
 * The Elements library in main (plan/elements EL6a.3, 06 §1): a catalogue id in, a verified file
 * copied into the project out, and every failure a closed code with nothing half-written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stickerCatalog, type StickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import {
  ElementsLibrary,
  MAX_MATERIALIZE_PROJECT_ID_LENGTH,
  MAX_PACKAGED_MANIFEST_BYTES,
  MAX_PACKAGED_TILE_BYTES,
  MAX_THUMBNAILS_PER_REQUEST,
  bundledStickersRoot,
  materializeRequest,
  nodeElementsLibraryIO,
  packagedStickersRoot,
  thumbnailRequestIds,
  type ElementsLibraryIO,
} from './elements-library.js';

const FIRE = Buffer.from('RIFF----WEBPVP8L fire bytes');
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function item(id: string, overrides: Partial<StickerItem> = {}): StickerItem {
  return {
    id,
    name: id,
    glyph: '🔥',
    unicode: '1f525',
    group: 'Travel & Places',
    collections: ['reactions'],
    rank: 0,
    keywords: [],
    availability: 'bundled',
    source: `assets/${id}/3D/${id}_3d.png`,
    file: `full/${id}.webp`,
    thumb: `thumbs/${id}.webp`,
    sha256: sha(FIRE),
    bytes: FIRE.length,
    width: 318,
    height: 318,
    sharpSize: 256,
    ...overrides,
  };
}

function catalog(items: StickerItem[]): StickerCatalog {
  return stickerCatalog({
    spec: 'test',
    library: 'fluent3d',
    provider: 'fluent-emoji',
    commit: 'abc',
    license: 'mit',
    licenseUrl: 'https://github.com/microsoft/fluentui-emoji/blob/abc/LICENSE',
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    attributionRequired: false,
    sourceBase: 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/abc/',
    collections: [{ id: 'reactions', name: 'Reactions' }],
    items,
  });
}

let root: string;
let bundled: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fp-elements-'));
  bundled = path.join(root, 'bundled');
  mkdirSync(path.join(bundled, 'full'), { recursive: true });
  // The app creates the projects folder before anything writes into it.
  mkdirSync(path.join(root, 'projects'));
  writeFileSync(path.join(bundled, 'full', 'fire.webp'), FIRE);
});
afterEach(() => undefined);

function library(items: StickerItem[], io = nodeElementsLibraryIO): ElementsLibrary {
  return new ElementsLibrary({
    projectsRoot: path.join(root, 'projects'),
    bundledRoot: () => bundled,
    catalog: async () => catalog(items),
    io,
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  });
}

describe('ElementsLibrary.materialize', () => {
  it('copies the verified file into the project and returns the element asset', async () => {
    const result = await library([item('fire')]).materialize({
      projectId: 'p1',
      elementId: 'fire',
    });
    expect(result).toEqual({
      ok: true,
      asset: {
        id: 'element_fluent3d_fire',
        path: 'media/p1/elements/fluent3d/fire.webp',
        kind: 'image',
        media: { width: 318, height: 318 },
        sharpSize: 256,
        source: {
          provider: 'fluent-emoji',
          remoteId: 'fire',
          license: 'mit',
          licenseUrl: 'https://github.com/microsoft/fluentui-emoji/blob/abc/LICENSE',
          attributionRequired: false,
          attribution: 'Fluent Emoji by Microsoft (MIT)',
          creator: 'Microsoft',
          sourceUrl:
            'https://raw.githubusercontent.com/microsoft/fluentui-emoji/abc/assets/fire/3D/fire_3d.png',
          fetchedAt: '2026-09-26T00:00:00.000Z',
        },
        deduped: false,
      },
    });
    const written = path.join(root, 'projects', 'media', 'p1', 'elements', 'fluent3d', 'fire.webp');
    expect(readFileSync(written)).toEqual(FIRE);
    const again = await library([item('fire')]).materialize({ projectId: 'p1', elementId: 'fire' });
    expect(again.ok && again.asset.deduped).toBe(true);
  });

  it('refuses an id the catalogue lacks and any path-shaped id, writing nothing', async () => {
    const lib = library([item('fire')]);
    for (const elementId of ['rocket', '../fire', 'fire/../../x', 'FIRE', '', 'a'.repeat(97)]) {
      expect(await lib.materialize({ projectId: 'p1', elementId })).toEqual({
        ok: false,
        error: 'unknown_element',
      });
    }
    expect(existsSync(path.join(root, 'projects', 'media'))).toBe(false);
  });

  it('keeps a traversal-shaped project id inside the projects root', async () => {
    const result = await library([item('fire')]).materialize({
      projectId: '../../outside',
      elementId: 'fire',
    });
    expect(result.ok && result.asset.path).toBe('media/outside/elements/fluent3d/fire.webp');
    expect(existsSync(path.join(root, 'outside'))).toBe(false);
  });

  it('refuses a damaged or missing bundled file, and a sticker this build does not ship', async () => {
    const damaged = library([item('fire', { sha256: sha(Buffer.from('other')) })]);
    expect(await damaged.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'integrity_failed',
    });
    const missing = library([item('fire', { file: 'full/gone.webp' })]);
    expect(await missing.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'library_missing',
    });
    // A packaged item carries no bundled file or hash at all (exactOptionalPropertyTypes).
    const { file: _file, sha256: _sha256, ...unbundled } = item('fire');
    const packaged = library([{ ...unbundled, availability: 'packaged' }]);
    expect(await packaged.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'library_missing',
    });
  });

  it('says the disk is full, and leaves no temporary file behind', async () => {
    const full = library([item('fire')], {
      ...nodeElementsLibraryIO,
      writeFile: async (file, data) => {
        writeFileSync(file, data.subarray(0, 3));
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      },
    });
    expect(await full.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'disk_full',
    });
    const dir = path.join(root, 'projects', 'media', 'p1', 'elements', 'fluent3d');
    expect(readdirSync(dir)).toEqual([]);
    const broken = library([item('fire')], {
      ...nodeElementsLibraryIO,
      rename: async () => {
        throw new Error('EACCES');
      },
    });
    expect(await broken.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'io_failed',
      detail: 'fire.webp',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('answers a media folder that leads outside the projects root with a code, never a path', async () => {
    // media/p1 is a link to somewhere else (an external drive): the sandbox refuses it, and the
    // refusal must not reach the renderer or the model as a thrown error carrying its paths.
    const outside = mkdtempSync(path.join(tmpdir(), 'fp-elsewhere-'));
    mkdirSync(path.join(root, 'projects', 'media'), { recursive: true });
    symlinkSync(outside, path.join(root, 'projects', 'media', 'p1'), 'dir');
    const result = await library([item('fire')]).materialize({
      projectId: 'p1',
      elementId: 'fire',
    });
    expect(result).toEqual({ ok: false, error: 'io_failed' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a catalogue entry whose file is not the sticker’s own, reading nothing else', async () => {
    writeFileSync(path.join(root, 'secret.webp'), FIRE);
    const odd = library([item('fire', { file: '../secret.webp' })]);
    expect(await odd.materialize({ projectId: 'p1', elementId: 'fire' })).toEqual({
      ok: false,
      error: 'library_missing',
    });
  });

  it('replaces a copy in the project that is not the sticker any more', async () => {
    const dir = path.join(root, 'projects', 'media', 'p1', 'elements', 'fluent3d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'fire.webp'), Buffer.from('tampered, and not the same size'));
    let reads = 0;
    const lib = library([item('fire')], {
      ...nodeElementsLibraryIO,
      readFile: async (file) => {
        // The target is realpath-resolved (/private/var on macOS), so match on the folder's tail.
        if (file.includes(`${path.sep}elements${path.sep}fluent3d${path.sep}`)) reads += 1;
        return nodeElementsLibraryIO.readFile(file);
      },
    });
    const result = await lib.materialize({ projectId: 'p1', elementId: 'fire' });
    expect(result.ok && result.asset.deduped).toBe(false);
    expect(readFileSync(path.join(dir, 'fire.webp'))).toEqual(FIRE);
    // A copy of the wrong size is replaced without being read.
    expect(reads).toBe(0);
  });

  it('sweeps a temporary file an earlier, crashed copy left behind', async () => {
    const dir = path.join(root, 'projects', 'media', 'p1', 'elements', 'fluent3d');
    mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, `rocket.webp.${String(process.pid + 1)}.deadbeef.tmp`);
    writeFileSync(stale, Buffer.from('half'));
    await library([item('fire')]).materialize({ projectId: 'p1', elementId: 'fire' });
    expect(readdirSync(dir)).toEqual(['fire.webp']);
  });

  it('copies once when the same sticker is asked for twice at the same time', async () => {
    let writes = 0;
    const lib = library([item('fire')], {
      ...nodeElementsLibraryIO,
      writeFile: async (file, data) => {
        writes += 1;
        await nodeElementsLibraryIO.writeFile(file, data);
      },
    });
    const [a, b] = await Promise.all([
      lib.materialize({ projectId: 'p1', elementId: 'fire' }),
      lib.materialize({ projectId: 'p1', elementId: 'fire' }),
    ]);
    expect(a).toEqual(b);
    expect(writes).toBe(1);
  });
});

describe('ElementsLibrary telemetry', () => {
  it('reports how each request ended, and nothing about the project', async () => {
    const outcomes: unknown[] = [];
    const lib = new ElementsLibrary({
      projectsRoot: path.join(root, 'projects'),
      bundledRoot: () => bundled,
      catalog: async () => catalog([item('fire')]),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    await lib.materialize({ projectId: 'p1', elementId: 'fire' });
    await lib.materialize({ projectId: 'p1', elementId: 'fire' });
    await lib.materialize({ projectId: 'p1', elementId: 'nope' });
    expect(outcomes).toEqual([
      { ok: true, deduped: false },
      { ok: true, deduped: true },
      { ok: false, error: 'unknown_element' },
    ]);
  });
});

describe('ElementsLibrary.heal', () => {
  const stickerAsset = (projectId: string) => ({
    id: 'element_fluent3d_fire',
    path: `media/${projectId}/elements/fluent3d/fire.webp`,
    source: { provider: 'fluent-emoji', remoteId: 'fire' },
  });

  it('puts back a sticker file the project lost, at the path it records', async () => {
    const lib = library([item('fire')]);
    const result = await lib.heal({ id: 'p1', assets: [stickerAsset('p1')] });
    expect(result).toEqual({ healed: ['element_fluent3d_fire'], failed: [] });
    const restored = path.join(
      root,
      'projects',
      'media',
      'p1',
      'elements',
      'fluent3d',
      'fire.webp',
    );
    expect(readFileSync(restored)).toEqual(FIRE);
    // Present now: a second open copies nothing.
    expect(await lib.heal({ id: 'p1', assets: [stickerAsset('p1')] })).toEqual({
      healed: [],
      failed: [],
    });
  });

  it('leaves footage, other projects’ copies and unknown stickers alone, and says which failed', async () => {
    const lib = library([item('fire')]);
    const result = await lib.heal({
      id: 'p2',
      assets: [
        { id: 'talk', path: 'media/p2/talk.mp4' },
        stickerAsset('p1'),
        {
          id: 'element_fluent3d_ghost',
          path: 'media/p2/elements/fluent3d/ghost.webp',
          source: { provider: 'fluent-emoji', remoteId: 'ghost' },
        },
      ],
    });
    expect(result).toEqual({
      healed: [],
      failed: ['element_fluent3d_fire', 'element_fluent3d_ghost'],
    });
    // Another project's path is the user's to relink: nothing was copied into this one.
    expect(existsSync(path.join(root, 'projects', 'media', 'p2'))).toBe(false);
  });

  it('copies a sticker used by several assets once', async () => {
    let writes = 0;
    const lib = library([item('fire')], {
      ...nodeElementsLibraryIO,
      writeFile: async (file, data) => {
        writes += 1;
        await nodeElementsLibraryIO.writeFile(file, data);
      },
    });
    const twin = { ...stickerAsset('p1'), id: 'element_fluent3d_fire_copy' };
    const result = await lib.heal({ id: 'p1', assets: [stickerAsset('p1'), twin] });
    expect(result.healed).toEqual(['element_fluent3d_fire', 'element_fluent3d_fire_copy']);
    expect(writes).toBe(1);
  });

  it('never throws, so a sticker it cannot put back never stops a project opening', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'fp-elsewhere-'));
    mkdirSync(path.join(root, 'projects', 'media'), { recursive: true });
    symlinkSync(outside, path.join(root, 'projects', 'media', 'p1'), 'dir');
    const result = await library([item('fire')]).heal({ id: 'p1', assets: [stickerAsset('p1')] });
    expect(result).toEqual({ healed: [], failed: ['element_fluent3d_fire'] });
    const unreadable = new ElementsLibrary({
      projectsRoot: path.join(root, 'projects'),
      bundledRoot: () => bundled,
      catalog: async () => {
        throw new Error('the catalogue chunk did not load');
      },
    });
    expect(await unreadable.heal({ id: 'p1', assets: [stickerAsset('p1')] })).toEqual({
      healed: [],
      failed: ['element_fluent3d_fire'],
    });
  });
});

describe('bundledStickersRoot', () => {
  it('reads the packaged renderer in an installed app and web-editor/public in a dev tree', () => {
    const mainDir = path.join('/repo', 'apps', 'desktop', 'dist');
    expect(bundledStickersRoot(mainDir, true)).toBe(
      path.join('/repo', 'apps', 'desktop', 'renderer', 'elements', 'stickers'),
    );
    expect(bundledStickersRoot(mainDir, false)).toBe(
      path.join('/repo', 'apps', 'web-editor', 'public', 'elements', 'stickers'),
    );
  });
});

describe('the packaged set (plan/elements EL6b)', () => {
  const ROCKET = Buffer.from('RIFF----WEBPVP8L rocket bytes');
  const ROCKET_THUMB = Buffer.from('RIFF----WEBPVP8 rocket thumb');
  const packagedItem = (): StickerItem => {
    const { file: _file, thumb: _thumb, sha256: _sha, bytes: _bytes, ...rest } = item('rocket');
    return { ...rest, availability: 'packaged' };
  };
  let packaged: string;

  function writeSet(entry: Record<string, unknown> = {}, commit = 'abc'): void {
    mkdirSync(path.join(packaged, 'full'), { recursive: true });
    mkdirSync(path.join(packaged, 'thumbs'), { recursive: true });
    writeFileSync(path.join(packaged, 'full', 'rocket.webp'), ROCKET);
    writeFileSync(path.join(packaged, 'thumbs', 'rocket.webp'), ROCKET_THUMB);
    writeFileSync(
      path.join(packaged, 'manifest.json'),
      JSON.stringify({
        commit,
        items: {
          rocket: {
            file: 'full/rocket.webp',
            thumb: 'thumbs/rocket.webp',
            sha256: sha(ROCKET),
            bytes: ROCKET.length,
            thumbBytes: ROCKET_THUMB.length,
            width: 318,
            height: 318,
            sharpSize: 256,
            ...entry,
          },
        },
      }),
    );
  }

  function withPackaged(
    items: StickerItem[],
    set: string | null = packaged,
    io: ElementsLibraryIO = nodeElementsLibraryIO,
  ): ElementsLibrary {
    return new ElementsLibrary({
      projectsRoot: path.join(root, 'projects'),
      bundledRoot: () => bundled,
      packagedRoot: () => set,
      catalog: async () => catalog(items),
      io,
    });
  }

  /**
   * The node IO, except that the first read of a sticker file or tile (not the manifest) is
   * preceded by `link` becoming a link to `target`: another process winning the race between the
   * library's check of a path and its open.
   */
  function swapBeforeFirstRead(link: string, target: string): ElementsLibraryIO {
    let swapped = false;
    return {
      ...nodeElementsLibraryIO,
      readBounded: async (file, maxBytes) => {
        if (!swapped && path.basename(file) !== 'manifest.json') {
          swapped = true;
          rmSync(link);
          symlinkSync(target, link);
        }
        return nodeElementsLibraryIO.readBounded(file, maxBytes);
      },
    };
  }

  beforeEach(() => {
    packaged = path.join(root, 'packaged');
  });

  it('copies a packaged sticker, verified against the manifest the set ships with', async () => {
    writeSet();
    const result = await withPackaged([item('fire'), packagedItem()]).materialize({
      projectId: 'p1',
      elementId: 'rocket',
    });
    expect(result).toMatchObject({
      ok: true,
      asset: {
        id: 'element_fluent3d_rocket',
        path: 'media/p1/elements/fluent3d/rocket.webp',
        media: { width: 318, height: 318 },
        sharpSize: 256,
      },
    });
    expect(
      readFileSync(
        path.join(root, 'projects', 'media', 'p1', 'elements', 'fluent3d', 'rocket.webp'),
      ),
    ).toEqual(ROCKET);
  });

  it('refuses a packaged sticker the set lacks, a set built for another library, a tampered file and a stray path', async () => {
    const missing = await withPackaged([packagedItem()], null).materialize({
      projectId: 'p1',
      elementId: 'rocket',
    });
    expect(missing).toEqual({ ok: false, error: 'library_missing' });
    writeSet({}, 'another-commit');
    expect(
      await withPackaged([packagedItem()]).materialize({ projectId: 'p1', elementId: 'rocket' }),
    ).toEqual({ ok: false, error: 'library_missing' });
    writeSet({ sha256: sha(Buffer.from('something else')) });
    expect(
      await withPackaged([packagedItem()]).materialize({ projectId: 'p1', elementId: 'rocket' }),
    ).toEqual({ ok: false, error: 'integrity_failed' });
    writeSet({ file: '../../secret.webp' });
    expect(
      await withPackaged([packagedItem()]).materialize({ projectId: 'p1', elementId: 'rocket' }),
    ).toEqual({ ok: false, error: 'library_missing' });
  });

  it('serves packaged tiles, and says whether this build has the set at all', async () => {
    expect(await withPackaged([packagedItem()], null).thumbnails([])).toEqual({
      ok: true,
      packaged: false,
      thumbs: [],
    });
    writeSet();
    const lib = withPackaged([item('fire'), packagedItem()]);
    const answer = await lib.thumbnails(['rocket', 'fire', 'ghost', '../x']);
    expect(answer.ok && answer.packaged).toBe(true);
    // Only packaged stickers come over IPC; a bundled one is a same-origin file already.
    expect(answer.ok && answer.thumbs.map((t) => [t.elementId, Buffer.from(t.webp)])).toEqual([
      ['rocket', ROCKET_THUMB],
    ]);
  });

  it('refuses a whole manifest with a malformed entry, so nothing it says reaches a project', async () => {
    for (const bad of [
      { width: 'x' },
      { sharpSize: 1e308 },
      { height: 0 },
      { sha256: 'not-a-digest' },
      { bytes: -1 },
      { thumbBytes: 1.5 },
      { thumb: '../../x' },
    ]) {
      writeSet(bad);
      const lib = withPackaged([packagedItem()]);
      expect(
        await lib.materialize({ projectId: 'p1', elementId: 'rocket' }),
        JSON.stringify(bad),
      ).toEqual({ ok: false, error: 'library_missing' });
      expect(await lib.thumbnails([]), JSON.stringify(bad)).toEqual({
        ok: true,
        packaged: false,
        thumbs: [],
      });
    }
  });

  it('reads packaged files only as the regular, in-set files of the size the manifest says', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'fp-outside-'));
    writeFileSync(path.join(outside, 'secret'), ROCKET_THUMB);
    // A tile linked to a file outside the set is not served, even with the right size.
    writeSet();
    const tile = path.join(packaged, 'thumbs', 'rocket.webp');
    rmSync(tile);
    symlinkSync(path.join(outside, 'secret'), tile);
    expect(await withPackaged([packagedItem()]).thumbnails(['rocket'])).toEqual({
      ok: true,
      packaged: true,
      thumbs: [],
    });
    // A tile larger than the manifest says, or than any tile may be, is not read.
    writeSet();
    writeFileSync(tile, Buffer.alloc(MAX_PACKAGED_TILE_BYTES + 1));
    expect(await withPackaged([packagedItem()]).thumbnails(['rocket'])).toEqual({
      ok: true,
      packaged: true,
      thumbs: [],
    });
    // A full file linked outside the set is missing, not copied.
    writeSet();
    const full = path.join(packaged, 'full', 'rocket.webp');
    rmSync(full);
    writeFileSync(path.join(outside, 'rocket.webp'), ROCKET);
    symlinkSync(path.join(outside, 'rocket.webp'), full);
    expect(
      await withPackaged([packagedItem()]).materialize({ projectId: 'p1', elementId: 'rocket' }),
    ).toEqual({ ok: false, error: 'library_missing' });
  });

  it('opens a packaged file by the real path it checked, so a link swapped in after the check is not followed', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'fp-outside-'));
    // The same size as the real tile, so only where it is read from tells them apart.
    const secret = Buffer.from('RIFF----WEBPVP8 secret thumb');
    expect(secret.length).toBe(ROCKET_THUMB.length);
    writeFileSync(path.join(outside, 'secret'), secret);
    writeFileSync(path.join(outside, 'rocket.webp'), ROCKET);
    const tile = path.join(packaged, 'thumbs', 'rocket.webp');
    const full = path.join(packaged, 'full', 'rocket.webp');

    // The tile itself becomes a link out of the set after it was checked: not served.
    writeSet();
    const tileSwap = swapBeforeFirstRead(tile, path.join(outside, 'secret'));
    expect(await withPackaged([packagedItem()], packaged, tileSwap).thumbnails(['rocket'])).toEqual(
      { ok: true, packaged: true, thumbs: [] },
    );

    // A tile linked to another file in the set is still served, from the file checked, even when
    // the link is pointed out of the set after the check.
    writeSet();
    rmSync(tile);
    writeFileSync(path.join(packaged, 'thumbs', 'rocket-real.webp'), ROCKET_THUMB);
    symlinkSync(path.join(packaged, 'thumbs', 'rocket-real.webp'), tile);
    const linkSwap = swapBeforeFirstRead(tile, path.join(outside, 'secret'));
    const served = await withPackaged([packagedItem()], packaged, linkSwap).thumbnails(['rocket']);
    expect(served.ok && served.thumbs.map((t) => [t.elementId, Buffer.from(t.webp)])).toEqual([
      ['rocket', ROCKET_THUMB],
    ]);

    // The sticker file becomes a link out of the set after it was checked: missing, not copied,
    // even though the file it now leads to has the recorded bytes.
    writeSet();
    const fullSwap = swapBeforeFirstRead(full, path.join(outside, 'rocket.webp'));
    expect(
      await withPackaged([packagedItem()], packaged, fullSwap).materialize({
        projectId: 'p1',
        elementId: 'rocket',
      }),
    ).toEqual({ ok: false, error: 'library_missing' });
  });

  it('reads the manifest bounded, so an oversized manifest means no packaged set', async () => {
    writeSet();
    const manifest = path.join(packaged, 'manifest.json');
    // Still a valid manifest, padded past the limit with whitespace JSON allows.
    const padded = `${readFileSync(manifest, 'utf8')}${' '.repeat(MAX_PACKAGED_MANIFEST_BYTES)}`;
    writeFileSync(manifest, padded);
    const reads: string[] = [];
    const bounded: [string, number][] = [];
    const lib = withPackaged([packagedItem()], packaged, {
      ...nodeElementsLibraryIO,
      readFile: async (file) => {
        reads.push(path.basename(file));
        return nodeElementsLibraryIO.readFile(file);
      },
      readBounded: async (file, maxBytes) => {
        bounded.push([path.basename(file), maxBytes]);
        return nodeElementsLibraryIO.readBounded(file, maxBytes);
      },
    });
    expect(await lib.thumbnails([])).toEqual({ ok: true, packaged: false, thumbs: [] });
    expect(await lib.materialize({ projectId: 'p1', elementId: 'rocket' })).toEqual({
      ok: false,
      error: 'library_missing',
    });
    expect(reads).not.toContain('manifest.json');
    expect(bounded).toEqual([['manifest.json', MAX_PACKAGED_MANIFEST_BYTES]]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a manifest that is a pipe without waiting on it',
    async () => {
      writeSet();
      const manifest = path.join(packaged, 'manifest.json');
      rmSync(manifest);
      execFileSync('mkfifo', [manifest]);
      expect(await withPackaged([packagedItem()]).thumbnails([])).toEqual({
        ok: true,
        packaged: false,
        thumbs: [],
      });
    },
    5_000,
  );

  it('keeps a manifest’s __proto__ key an ordinary entry, so it cannot supply entries never checked', async () => {
    writeSet();
    const valid = {
      sha256: sha(ROCKET),
      bytes: ROCKET.length,
      thumbBytes: ROCKET_THUMB.length,
      width: 318,
      height: 318,
      sharpSize: 256,
    };
    // A well-formed entry for the id `__proto__`, carrying a rocket entry that is not: if the key
    // became the items' prototype, `rocket` would be found through it without being checked.
    const proto = {
      file: 'full/__proto__.webp',
      thumb: 'thumbs/__proto__.webp',
      ...valid,
      rocket: { file: 'full/rocket.webp', thumb: 'thumbs/rocket.webp', ...valid, width: 'x' },
    };
    // Written as text: an object literal's `__proto__` sets its prototype, not a key.
    writeFileSync(
      path.join(packaged, 'manifest.json'),
      `{"commit":"abc","items":{"__proto__":${JSON.stringify(proto)}}}`,
    );
    const lib = withPackaged([packagedItem()]);
    expect(await lib.materialize({ projectId: 'p1', elementId: 'rocket' })).toEqual({
      ok: false,
      error: 'library_missing',
    });
    expect(await lib.thumbnails(['rocket'])).toEqual({ ok: true, packaged: true, thumbs: [] });
  });

  it('reads the packaged set from the app’s resources, or the desktop app’s build folder in a dev tree', () => {
    const mainDir = path.join('/repo', 'apps', 'desktop', 'dist');
    expect(packagedStickersRoot(mainDir, true, '/App/Contents/Resources')).toBe(
      path.join('/App/Contents/Resources', 'elements', 'stickers'),
    );
    expect(packagedStickersRoot(mainDir, false, '/unused')).toBe(
      path.join('/repo', 'apps', 'desktop', 'elements-packaged'),
    );
  });
});

describe('materializeRequest', () => {
  it('takes two strings, and answers anything else with the code it has always had', () => {
    expect(materializeRequest({ projectId: 'p1', elementId: 'fire', extra: 1 })).toEqual({
      ok: true,
      request: { projectId: 'p1', elementId: 'fire' },
    });
    for (const request of [
      null,
      'fire',
      {},
      { projectId: 'p1' },
      { projectId: 1, elementId: 'fire' },
      { projectId: 'p1', elementId: ['fire'] },
    ]) {
      expect(materializeRequest(request), JSON.stringify(request)).toEqual({
        ok: false,
        error: 'unknown_element',
        detail: 'invalid request',
      });
    }
  });

  it('refuses a project id past the cap before it reaches a path, as a folder it cannot write', () => {
    const longest = 'p'.repeat(MAX_MATERIALIZE_PROJECT_ID_LENGTH);
    expect(materializeRequest({ projectId: longest, elementId: 'fire' }).ok).toBe(true);
    expect(materializeRequest({ projectId: `${longest}p`, elementId: 'fire' })).toEqual({
      ok: false,
      error: 'io_failed',
    });
  });
});

describe('thumbnailRequestIds', () => {
  it('takes a list of at most one request’s ids, all strings, and refuses anything else whole', () => {
    expect(thumbnailRequestIds({ elementIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(thumbnailRequestIds({ elementIds: [] })).toEqual([]);
    for (const request of [
      null,
      'ids',
      {},
      { elementIds: 'a' },
      { elementIds: ['a', 2] },
      { elementIds: Array.from({ length: MAX_THUMBNAILS_PER_REQUEST + 1 }, () => 'a') },
    ]) {
      expect(thumbnailRequestIds(request), JSON.stringify(request)?.slice(0, 40)).toBeNull();
    }
  });
});
