/**
 * E2E.7, the desktop half: open a moved project folder the way the desktop opens one.
 *
 *   node tests/e2e/scripts/masking-archive-open.mjs <project.fp.json>
 *
 * Checks, with the desktop's own modules (built `dist`):
 *  - the project file layer reads it (`readProjectFile`, migrating if it must);
 *  - it is self-contained: every asset path is RELATIVE and resolves to a file inside the
 *    project folder, and every mask's derived artifact (matte folder, `track.json`) is inside
 *    `.framepilot-derived/` with the digest the project pins;
 *  - the desktop's FULL matte validation (sha256 of every pinned file, ffprobe pixel format,
 *    frame count and size) finds nothing BROKEN or STALE.
 *
 * Prints one JSON line; exit 0 when the folder opens clean. The engine half (render, compare
 * with the reference the folder carries) is `engine/python/tests/masking_archive.py`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const load = (path) => import(pathToFileURL(join(repo, path)).href);

/** Whether `child` is `parent` or inside it. */
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Open `projectPath` as the desktop would and report what a moved folder is missing.
 *
 * @param {string} projectPath - Absolute path of `project.fp.json`.
 * @returns {Promise<{ok: boolean, problems: string[], masks: number, issues: unknown[]}>}
 */
export async function openArchive(projectPath) {
  const { readProjectFile } = await load('packages/timeline-schema/dist/project-file.js');
  const { masksOf } = await load('packages/timeline-schema/dist/index.js');
  const { validateProjectMattes } = await load(
    'apps/desktop/dist/capability-packs/matte-validation.js',
  );
  const { DesktopMatteMediaInspector } = await load(
    'apps/desktop/dist/capability-packs/matte-media-inspector.js',
  );
  const projectDir = dirname(projectPath);
  const problems = [];
  const project = await readProjectFile(projectPath);

  for (const asset of project.assets) {
    if (isAbsolute(asset.path) || /^[a-z]+:\/\//iu.test(asset.path)) {
      problems.push(`asset ${asset.id} is not stored relative to the project: ${asset.path}`);
      continue;
    }
    const file = resolve(projectDir, asset.path);
    if (!inside(projectDir, file)) problems.push(`asset ${asset.id} points outside the folder`);
    else if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push(`asset ${asset.id} is missing: ${asset.path}`);
    }
  }

  let masks = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      for (const mask of masksOf(clip)) {
        masks += 1;
        if (mask.kind === 'matte') {
          const folder = join(projectDir, '.framepilot-derived', 'mattes', mask.artifact.key);
          if (!existsSync(folder)) problems.push(`matte ${mask.id} has no artifact folder`);
        }
        if (mask.tracking !== undefined) {
          const file = join(
            projectDir,
            '.framepilot-derived',
            'tracks',
            mask.tracking.artifact.key,
            'track.json',
          );
          if (!existsSync(file)) {
            problems.push(`track of ${mask.id} is missing`);
          } else {
            const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
            if (sha256 !== mask.tracking.artifact.sha256) {
              problems.push(`track of ${mask.id} does not match its pinned digest`);
            }
          }
        }
      }
    }
  }

  const inspector = new DesktopMatteMediaInspector({
    ffprobe: process.env.FRAMEPILOT_FFPROBE ?? 'ffprobe',
    // Full validation probes files; it never asks the sidecar.
    sidecarBaseUrl: 'http://127.0.0.1:0',
    fetch: globalThis.fetch,
  });
  const issues = await validateProjectMattes(projectDir, project, { mode: 'full', inspector });
  for (const issue of issues) problems.push(`matte ${issue.maskId}: ${issue.code}`);
  return { ok: problems.length === 0, problems, masks, issues };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write(`usage: node masking-archive-open.mjs <project.fp.json>\n`);
    process.exit(2);
  }
  const report = await openArchive(resolve(target));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}
