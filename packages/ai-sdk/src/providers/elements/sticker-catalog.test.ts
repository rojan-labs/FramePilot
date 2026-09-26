/**
 * The sticker catalogue (plan/elements EL6a.1–2). The catalogue is what the panel shows and what
 * the desktop copies into a project, so it must describe exactly the files that ship: every
 * bundled sticker has its full file (with the recorded SHA-256) and its tile, nothing ships that
 * the catalogue does not list, the licence travels with the files, and every item was built from
 * a pinned upstream input. Search ranks the glyph, the name, then keywords.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STICKER_CATALOG_DATA } from './sticker-catalog.generated.js';
import {
  STICKER_ID_PATTERN,
  loadStickerCatalog,
  searchStickers,
  stickerSourceUrl,
} from './sticker-catalog.js';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const STICKERS = path.join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers');
const LOCK = JSON.parse(
  readFileSync(path.join(REPO, 'scripts', 'elements', 'fluent.lock.json'), 'utf8'),
) as { commit: string; inputs: Record<string, { sha256: string }> };
const COLLECTIONS = JSON.parse(
  readFileSync(path.join(REPO, 'scripts', 'elements', 'collections.json'), 'utf8'),
) as { collections: { id: string; glyphs: string[] }[] };

const catalog = STICKER_CATALOG_DATA;
const bundled = catalog.items.filter((item) => item.availability === 'bundled');

describe('the sticker catalogue and the files that ship', () => {
  it('lists every bundled file with its hash, and ships nothing else', () => {
    for (const item of bundled) {
      const full = readFileSync(path.join(STICKERS, item.file!));
      expect(createHash('sha256').update(full).digest('hex'), item.id).toBe(item.sha256);
      expect(full.length, item.id).toBe(item.bytes);
      expect(existsSync(path.join(STICKERS, item.thumb!)), item.id).toBe(true);
    }
    const listed = new Set(bundled.map((item) => `${item.id}.webp`));
    expect(readdirSync(path.join(STICKERS, 'full')).sort()).toEqual([...listed].sort());
    expect(readdirSync(path.join(STICKERS, 'thumbs')).sort()).toEqual([...listed].sort());
  });

  it('keeps the MIT licence beside the files', () => {
    const licence = readFileSync(path.join(STICKERS, 'LICENSE-fluent-emoji.txt'), 'utf8');
    expect(licence).toContain('MIT License');
    expect(licence).toContain('Microsoft');
    expect(catalog).toMatchObject({ license: 'mit', attributionRequired: false });
  });

  it('was built from pinned inputs at the locked commit', () => {
    expect(catalog.commit).toBe(LOCK.commit);
    for (const item of catalog.items) expect(LOCK.inputs[item.source], item.id).toBeDefined();
    expect(stickerSourceUrl(catalog, catalog.items[0]!)).toMatch(
      new RegExp(`^https://raw\\.githubusercontent\\.com/microsoft/fluentui-emoji/${LOCK.commit}/`),
    );
  });

  it('gives every sticker a safe unique id, and bundles exactly the curated collections', () => {
    const ids = catalog.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(STICKER_ID_PATTERN);
    expect(catalog.items).toHaveLength(1595);
    const curated = new Set(COLLECTIONS.collections.flatMap((c) => c.glyphs));
    expect(bundled).toHaveLength(curated.size);
    for (const item of bundled) {
      expect(item.collections.length, item.id).toBeGreaterThan(0);
      expect(item.width, item.id).toBeGreaterThan(item.sharpSize!);
    }
    for (const item of catalog.items.filter((i) => i.availability === 'packaged')) {
      expect(item.file, item.id).toBeUndefined();
    }
  });
});

describe('searchStickers', () => {
  it('finds a sticker by its glyph, its name, then its keywords', () => {
    expect(searchStickers(catalog, '🔥').items[0]?.id).toBe('fire');
    expect(searchStickers(catalog, 'fire').items[0]?.id).toBe('fire');
    expect(searchStickers(catalog, 'thumbs').items[0]?.id).toBe('thumbs_up');
    expect(searchStickers(catalog, '+1').items[0]?.id).toBe('thumbs_up');
    expect(searchStickers(catalog, '❤').items[0]?.id).toBe('red_heart');
    expect(searchStickers(catalog, 'zzzzq').total).toBe(0);
  });

  it('lists a collection in its curated order and keeps packaged stickers out unless asked', () => {
    const hearts = searchStickers(catalog, '', { collection: 'hearts' }).items.map((i) => i.glyph);
    expect(hearts.slice(0, 3).map((g) => g.replace(/️/g, ''))).toEqual(['❤', '🧡', '💛']);
    const everything = searchStickers(catalog, 'cat', { includePackaged: true });
    const shipped = searchStickers(catalog, 'cat');
    expect(everything.total).toBeGreaterThan(shipped.total);
    expect(shipped.items.every((item) => item.availability === 'bundled')).toBe(true);
    expect(searchStickers(catalog, '', { limit: 5 }).items).toHaveLength(5);
  });

  it('loads the catalogue once, with an id lookup', async () => {
    const loaded = await loadStickerCatalog();
    expect(loaded.byId.get('fire')?.glyph).toBe('🔥');
    expect(await loadStickerCatalog()).toBe(loaded);
  });
});
