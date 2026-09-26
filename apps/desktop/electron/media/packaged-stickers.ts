/**
 * The packaged sticker set's check (plan/elements EL6b.1, 06 §4).
 *
 * `pnpm build:elements` encodes every sticker the renderer does not ship into the desktop
 * installer's resources, with a manifest of what it encoded. This reads that set back against the
 * catalogue the app lists from: every packaged sticker present, its file the one the manifest
 * names and hashes, the licence beside it, the whole within its budget — and then through the
 * app's own `ElementsLibrary`, which is stricter about the manifest than packaging need be: every
 * tile served and every sticker placed into a scratch project. CI (`desktop-build`) runs it
 * (`scripts/check-packaged-stickers.mjs`), so a packaged app can never list a sticker it cannot
 * place.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StickerCatalog } from '@framepilot/ai-sdk';
import { ElementsLibrary, MAX_THUMBNAILS_PER_REQUEST } from './elements-library.js';

/** What the packaged set may weigh (MD-E1); `build_library.py` holds it to the same number. */
export const PACKAGED_STICKERS_BUDGET_BYTES = 40_000_000;

interface ManifestEntry {
  readonly file?: unknown;
  readonly thumb?: unknown;
  readonly sha256?: unknown;
}

/**
 * Everything wrong with the packaged set at `root` for `catalog`, one line each; empty when a
 * packaged app built with it can place every sticker it lists.
 */
export async function packagedSetProblems(
  catalog: StickerCatalog,
  root: string,
): Promise<readonly string[]> {
  let manifest: { commit?: unknown; totalBytes?: unknown; items?: Record<string, ManifestEntry> };
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, 'manifest.json'), 'utf8'),
    ) as typeof manifest;
  } catch {
    return ['there is no packaged set here: run pnpm build:elements'];
  }
  if (manifest.commit !== catalog.commit) {
    return [
      `the set was built for library commit ${String(manifest.commit)}, not ${catalog.commit}: rebuild it`,
    ];
  }
  const problems: string[] = [];
  if (!existsSync(path.join(root, 'LICENSE-fluent-emoji.txt'))) {
    problems.push('the licence file is missing beside the stickers');
  }
  if (
    typeof manifest.totalBytes !== 'number' ||
    manifest.totalBytes > PACKAGED_STICKERS_BUDGET_BYTES
  ) {
    problems.push('the set is over its budget: raise it in the same change, with the reason');
  }
  const items = manifest.items ?? {};
  for (const item of catalog.items) {
    if (item.availability !== 'packaged') continue;
    const entry = items[item.id];
    if (entry === undefined) {
      problems.push(`${item.id}: not in the packaged set`);
      continue;
    }
    if (entry.file !== `full/${item.id}.webp` || entry.thumb !== `thumbs/${item.id}.webp`) {
      problems.push(`${item.id}: the manifest names a file that is not the sticker’s own`);
      continue;
    }
    try {
      const bytes = await readFile(path.join(root, entry.file));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        problems.push(`${item.id}: the file does not match the manifest`);
      } else if (!existsSync(path.join(root, entry.thumb))) {
        problems.push(`${item.id}: its tile is missing`);
      }
    } catch {
      problems.push(`${item.id}: the file is missing`);
    }
  }
  return [...problems, ...(await problemsThroughTheApp(catalog, root))];
}

/** What the app's own library makes of the set: it must use it, show every tile, place each. */
async function problemsThroughTheApp(
  catalog: StickerCatalog,
  root: string,
): Promise<readonly string[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fp-packaged-check-'));
  try {
    const library = new ElementsLibrary({
      projectsRoot: scratch,
      bundledRoot: () => scratch,
      packagedRoot: () => root,
      catalog: async () => catalog,
    });
    const presence = await library.thumbnails([]);
    if (!presence.ok || !presence.packaged) {
      return ['the app would not use this set: rebuild it with pnpm build:elements'];
    }
    const problems: string[] = [];
    const ids = catalog.items.filter((item) => item.availability === 'packaged').map((i) => i.id);
    for (let start = 0; start < ids.length; start += MAX_THUMBNAILS_PER_REQUEST) {
      const batch = ids.slice(start, start + MAX_THUMBNAILS_PER_REQUEST);
      const answer = await library.thumbnails(batch);
      const served = new Set(answer.ok ? answer.thumbs.map((thumb) => thumb.elementId) : []);
      for (const id of batch) {
        if (!served.has(id)) problems.push(`${id}: the app would not show its tile`);
      }
    }
    for (const id of ids) {
      const placed = await library.materialize({ projectId: 'packaged-check', elementId: id });
      if (!placed.ok) problems.push(`${id}: the app could not place it (${placed.error})`);
    }
    return problems;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
