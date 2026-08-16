/**
 * Stage the built web-editor renderer into `apps/desktop/renderer/` for packaging.
 *
 * WHY: `electron-builder.yml` packages `renderer/**` into the app (and
 * `electron/main.ts` loads `../renderer/index.html` in packaged builds), but the
 * renderer is built by `@framepilot/web-editor` into that package's `dist/`.
 * This script is the missing bridge. It deliberately does NOT rebuild the
 * web-editor — build ordering belongs to the workspace (`pnpm build`); a stale
 * or missing build fails loudly here instead of silently packaging an old UI.
 *
 * Usage: node scripts/copy-renderer.mjs   (cwd: apps/desktop)
 */
import { cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webEditorDist = path.resolve(desktopDir, '../web-editor/dist');
const rendererDir = path.join(desktopDir, 'renderer');

async function main() {
  const indexHtml = path.join(webEditorDist, 'index.html');
  try {
    await stat(indexHtml);
  } catch {
    console.error(
      `copy-renderer: no web-editor build at ${webEditorDist}.\n` +
        'Run `pnpm --filter @framepilot/web-editor build` (or root `pnpm build`) first.',
    );
    process.exit(1);
  }
  await rm(rendererDir, { recursive: true, force: true });
  await cp(webEditorDist, rendererDir, { recursive: true });
  console.log(`copy-renderer: staged ${webEditorDist} -> ${rendererDir}`);
}

await main();
