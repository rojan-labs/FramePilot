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
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stickerCatalog, type StickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import { ElementsLibrary, bundledStickersRoot, nodeElementsLibraryIO } from './elements-library.js';

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
