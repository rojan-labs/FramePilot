/**
 * The Elements library in main (plan/elements EL6a.3, 06 §1): a catalogue id in, a verified file
 * copied into the project out, and every failure a closed code with nothing half-written.
 */
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  bundledStickersRoot,
  nodeElementsLibraryIO,
  packagedStickersRoot,
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
            width: 318,
            height: 318,
            sharpSize: 256,
            ...entry,
          },
        },
      }),
    );
  }

  function withPackaged(items: StickerItem[], set: string | null = packaged): ElementsLibrary {
    return new ElementsLibrary({
      projectsRoot: path.join(root, 'projects'),
      bundledRoot: () => bundled,
      packagedRoot: () => set,
      catalog: async () => catalog(items),
    });
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
