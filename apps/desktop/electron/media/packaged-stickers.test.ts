/**
 * The packaged sticker set's check (plan/elements EL6b.1): run by CI (`desktop-build`) against the
 * set `build:elements` wrote, so a packaged app can never list a sticker it cannot place.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { stickerCatalog, type StickerItem } from '@framepilot/ai-sdk';
import { PACKAGED_STICKERS_BUDGET_BYTES, packagedSetProblems } from './packaged-stickers.js';

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const ROCKET = Buffer.from('RIFF----WEBPVP8L rocket');

function packaged(id: string): StickerItem {
  return {
    id,
    name: id,
    glyph: '🚀',
    unicode: null,
    group: 'Travel & Places',
    collections: [],
    keywords: [],
    availability: 'packaged',
    source: `assets/${id}/3D/${id}_3d.png`,
  };
}

const catalog = (items: StickerItem[]) =>
  stickerCatalog({
    spec: 'test',
    library: 'fluent3d',
    provider: 'fluent-emoji',
    commit: 'abc',
    license: 'mit',
    licenseUrl: 'https://example.test/LICENSE',
    attribution: 'Fluent Emoji by Microsoft (MIT)',
    creator: 'Microsoft',
    attributionRequired: false,
    sourceBase: 'https://example.test/',
    collections: [],
    items,
  });

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fp-packaged-'));
  mkdirSync(path.join(root, 'full'));
  mkdirSync(path.join(root, 'thumbs'));
});

function write(entries: Record<string, Record<string, unknown>>, commit = 'abc'): void {
  for (const id of Object.keys(entries)) {
    writeFileSync(path.join(root, 'full', `${id}.webp`), ROCKET);
    writeFileSync(path.join(root, 'thumbs', `${id}.webp`), ROCKET);
  }
  writeFileSync(path.join(root, 'LICENSE-fluent-emoji.txt'), 'MIT');
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      commit,
      totalBytes: ROCKET.length * 2 * Object.keys(entries).length,
      items: Object.fromEntries(
        Object.entries(entries).map(([id, over]) => [
          id,
          {
            file: `full/${id}.webp`,
            thumb: `thumbs/${id}.webp`,
            sha256: sha(ROCKET),
            bytes: ROCKET.length,
            thumbBytes: ROCKET.length,
            width: 318,
            height: 318,
            sharpSize: 256,
            ...over,
          },
        ]),
      ),
    }),
  );
}

describe('packagedSetProblems', () => {
  it('passes a set that holds every packaged sticker, verified, with its licence', async () => {
    write({ rocket: {} });
    expect(await packagedSetProblems(catalog([packaged('rocket')]), root)).toEqual([]);
  });

  it('names each sticker the set lacks, damages or misfiles, and a set for another library', async () => {
    write({ rocket: { sha256: sha(Buffer.from('other')) }, ufo: { file: '../ufo.webp' } });
    const problems = await packagedSetProblems(
      catalog([packaged('rocket'), packaged('ufo'), packaged('comet')]),
      root,
    );
    expect(problems).toEqual([
      'rocket: the file does not match the manifest',
      'ufo: the manifest names a file that is not the sticker’s own',
      'comet: not in the packaged set',
      // And so the app, which refuses a manifest with an entry packaging could not have written.
      'the app would not use this set: rebuild it with pnpm build:elements',
    ]);
    write({ rocket: {} }, 'another-commit');
    expect(await packagedSetProblems(catalog([packaged('rocket')]), root)).toEqual([
      'the set was built for library commit another-commit, not abc: rebuild it',
    ]);
  });

  it('reads the set as the app will: a manifest the app would not use fails, whatever else holds', async () => {
    // Every file present and hashed, but one entry claims a size no sticker has: the app ignores
    // the whole set, so a packaged build would list none of it.
    write({ rocket: {}, ufo: { width: 0 } });
    expect(
      await packagedSetProblems(catalog([packaged('rocket'), packaged('ufo')]), root),
    ).toContain('the app would not use this set: rebuild it with pnpm build:elements');
  });

  it('places every sticker through the app’s own library, and names one it cannot', async () => {
    // The manifest is well formed and the full file hashes, but the tile is not the size the
    // manifest says: the app would list the sticker with no tile.
    write({ rocket: { thumbBytes: ROCKET.length + 1 } });
    expect(await packagedSetProblems(catalog([packaged('rocket')]), root)).toEqual([
      'rocket: the app would not show its tile',
    ]);
  });

  it('holds the set to its budget', async () => {
    write({ rocket: {} });
    const manifest = path.join(root, 'manifest.json');
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifest,
      JSON.stringify({ ...parsed, totalBytes: PACKAGED_STICKERS_BUDGET_BYTES + 1 }),
    );
    expect(await packagedSetProblems(catalog([packaged('rocket')]), root)).toContain(
      'the set is over its budget: raise it in the same change, with the reason',
    );
  });
});
