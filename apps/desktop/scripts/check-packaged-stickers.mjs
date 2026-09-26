#!/usr/bin/env node
/**
 * Check the packaged sticker set `pnpm build:elements` wrote (plan/elements EL6b.1): every
 * catalogued packaged sticker present and verified, its licence beside it, the set within budget.
 * CI (`desktop-build`) runs it after `build:elements`, so a packaged app can never list a sticker
 * it cannot place. Needs the desktop's compiled `dist/` (`pnpm build`).
 *
 * Usage: node scripts/check-packaged-stickers.mjs [dir]   (default: elements-packaged)
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadStickerCatalog } from '@framepilot/ai-sdk';
import { packagedSetProblems } from '../dist/media/packaged-stickers.js';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktopDir, process.argv[2] ?? 'elements-packaged');
const catalog = await loadStickerCatalog();
const problems = await packagedSetProblems(catalog, root);
const packaged = catalog.items.filter((item) => item.availability === 'packaged').length;
if (problems.length > 0) {
  process.stderr.write(
    `check-packaged-stickers: ${String(problems.length)} problem(s) in ${root}:\n` +
      problems.map((line) => `  ${line}\n`).join(''),
  );
  process.exit(1);
}
process.stdout.write(
  `check-packaged-stickers: all ${String(packaged)} packaged stickers placeable\n`,
);
