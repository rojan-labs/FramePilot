/**
 * Build a FramePilot project from raw media files, headlessly, through the path a desktop
 * import takes (`docs/guides/agent-run-harness.md`, "A project from raw footage").
 *
 * The agent-run harness edits a COPY of an existing project. Verifying an edit on new
 * footage needs that project first, built the way the app builds one — proxies, peaks,
 * thumbnails, the brain row and the visual index — or the run measures a project no
 * editor could have. Per file, this mirrors:
 *
 *  1. `MediaBin.importFiles` → `materializeImportedMedia`: the bytes land at
 *     `media/<projectId>/<name>`, named by `safeFileName` + `dedupeName`. They are cloned
 *     (APFS copy-on-write) instead of chunk-uploaded: same bytes, same name rules.
 *  2. `probeMediaFile`: the duration. ffprobe reads it here; the renderer reads the
 *     `<video>` element's.
 *  3. `deriveEngineMedia` → main's `mediaImportAsset` → `importAssetViaSidecar` with a
 *     proxy and the brain ids.
 *  4. main's `enrolmentTargetFor` → the asset enroller: the visual-index loop with the
 *     tiers and credentials main uses (no capability-pack handles, as in the harness).
 *  5. `buildAsset` → the asset joins the bin. The project starts with an empty timeline,
 *     as a new project does, and is saved with `serializeProject`.
 *
 * Run: `tsx apps/desktop/scripts/import-project.ts --name "<name>" --media a.mp4
 *        --media b.mp4 --root <projects root> [--width 1920 --height 1080 --fps 30]`
 * The project file is `<root>/<projectId>.fp.json`; pass it to `agent-run.ts --project`.
 */
import { execFileSync } from 'node:child_process';
import { constants as fsConstants, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { engineBaseUrl, startHarnessSidecar, stopHarnessSidecar } from './harness-sidecar.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const DESKTOP_USER_DATA = path.join(homedir(), 'Library/Application Support/@framepilot/desktop');
const MEDIA_DIR = 'media';

const { loadDotEnvFile } = await import('../electron/env.js');
loadDotEnvFile(path.join(REPO_ROOT, '.env'));

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    media: { type: 'string', multiple: true },
    root: { type: 'string' },
    port: { type: 'string', default: '8813' },
    width: { type: 'string', default: '1920' },
    height: { type: 'string', default: '1080' },
    fps: { type: 'string', default: '30' },
  },
});

function required<T>(name: string, value: T | undefined): T {
  if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') {
    throw new Error(
      `--${name} is required. Usage: import-project.ts --name <name> --media <file>... --root <dir>`,
    );
  }
  return value;
}

const NAME = required('name', args.name);
const MEDIA_FILES = required('media', args.media).map((file) => path.resolve(file));
const ROOT = path.resolve(required('root', args.root));
const PORT = Number(args.port);
const ENGINE = engineBaseUrl(PORT);

function say(message: string, data?: Record<string, unknown>): void {
  process.stdout.write(
    `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`,
  );
}

/** The container duration, as the `<video>` element would report it. */
function probeDurationSeconds(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  ).trim();
  const seconds = Number(out);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe reported no duration for ${file}: "${out}"`);
  }
  return seconds;
}

async function main(): Promise<void> {
  const ai = await import('@framepilot/ai-sdk');
  const { parseProject, serializeProject } = await import('@framepilot/timeline-schema');
  const { safeFileName, dedupeName, nodeMediaImportIO, safeProjectId } =
    await import('../electron/projects/media-import.js');
  const { importAssetViaSidecar } = await import('../electron/media/asset-media-client.js');
  const { createAssetEnroller, enrolmentTargetFor } =
    await import('../electron/ai/asset-enrolment.js');
  const { autoEnrolmentTiers } = await import('../electron/capability-packs/visual-packs.js');
  const { AiConfigStore } = await import('../electron/ai/ai-config.js');
  const { visualIndexCredentialsFor } = await import('../electron/ai/visual-index-credentials.js');
  // The renderer's own id and asset builders, so ids and shapes match an app import.
  const { assetIdFor, buildAsset, kindOf } = await import('../../web-editor/src/editor/import.js');
  const { newProject, uniqueProjectId } = await import('../../web-editor/src/editor/project.js');

  const projectId = safeProjectId(uniqueProjectId(NAME));
  const project0 = newProject(NAME, {
    id: projectId,
    fps: Number(args.fps),
    resolution: { width: Number(args.width), height: Number(args.height) },
  });
  const mediaDir = path.join(ROOT, MEDIA_DIR, projectId);
  mkdirSync(mediaDir, { recursive: true });

  const aiConfig = new AiConfigStore(path.join(DESKTOP_USER_DATA, 'ai-config.json'));
  const sidecar = await startHarnessSidecar({
    repoRoot: REPO_ROOT,
    port: PORT,
    projectsRoot: ROOT,
    logPath: path.join(ROOT, `import-${projectId}-sidecar.log`),
    onHealthy: (info) => say('sidecar healthy', info),
  });
  const shutdown = new AbortController();
  const enrolmentFailures: string[] = [];
  const enroller = createAssetEnroller({
    signal: shutdown.signal,
    enrol: async ({ projectId: pid, assetIds, signal }) => {
      say('visual index: enrolling', { assetIds });
      const result = await ai.runVisualIndexLoop({
        client: new ai.VisualIndexClient({ baseUrl: ENGINE }),
        request: {
          projectId: pid,
          assetIds: [...assetIds],
          tiers: autoEnrolmentTiers({
            hostedLabelsConfigured:
              aiConfig.resolveEmbeddingsKeys() !== undefined ||
              aiConfig.resolveTwelveLabsKey() !== undefined,
            handles: {},
          }),
          ...visualIndexCredentialsFor(aiConfig),
        },
        signal,
      });
      say('visual index: settled', { status: result.status, last: result.last });
      if (result.status !== 'done') {
        enrolmentFailures.push(`${assetIds.join(', ')}: ${result.status}`);
        throw new Error(`visual index did not complete: ${result.status}`);
      }
    },
  });

  try {
    let project = project0;
    for (const source of MEDIA_FILES) {
      const fileName = path.basename(source);
      const name = await dedupeName(mediaDir, safeFileName(fileName), nodeMediaImportIO);
      const onDisk = path.join(mediaDir, name);
      copyFileSync(source, onDisk, fsConstants.COPYFILE_FICLONE);
      const relativePath = path.posix.join(MEDIA_DIR, projectId, name);
      const durationSeconds = probeDurationSeconds(onDisk);
      const assetId = assetIdFor(
        name,
        project.assets.map((asset) => asset.id),
      );
      say('importing', {
        file: fileName,
        bytes: statSync(onDisk).size,
        durationSeconds,
        assetId,
      });
      const request = { inputPath: onDisk, proxy: true, projectId, assetId };
      const derived = await importAssetViaSidecar(ENGINE, request);
      if (!derived.ok) throw new Error(`asset-media failed for ${fileName}: ${derived.error}`);
      const { width, height, pixelAspectRatio, rotation, peaks, peaksPerSecond } = derived.media;
      const { thumbnailPaths, proxyPath } = derived.media;
      const media = {
        ...(width !== undefined && height !== undefined
          ? {
              width,
              height,
              ...(pixelAspectRatio !== undefined ? { pixelAspectRatio } : {}),
              ...(rotation !== undefined ? { rotation } : {}),
            }
          : {}),
        ...(peaks !== undefined ? { peaks } : {}),
        ...(peaksPerSecond !== undefined ? { peaksPerSecond } : {}),
        ...(thumbnailPaths !== undefined ? { thumbnailPaths } : {}),
        ...(proxyPath !== undefined ? { proxyPath } : {}),
      };
      const asset = buildAsset(
        { path: relativePath, fileName: name, durationSeconds, kind: kindOf(`${derived.kind}/`) },
        project.assets.map((a) => a.id),
        Object.keys(media).length > 0 ? media : undefined,
      );
      project = parseProject({ ...project, assets: [...project.assets, asset] });
      say('imported', { assetId: asset.id, kind: asset.kind, proxy: proxyPath ?? null });
      const target = enrolmentTargetFor(request, derived);
      if (target) enroller.request(target.projectId, target.assetId);
    }
    const projectPath = path.join(ROOT, `${projectId}.fp.json`);
    await writeFile(projectPath, serializeProject(project));
    say('project written; waiting for the visual index', { projectPath });
    await enroller.settled();
    if (enrolmentFailures.length > 0) {
      throw new Error(`visual index enrolment failed: ${enrolmentFailures.join('; ')}`);
    }
    say('done', { projectPath, assets: project.assets.length });
  } finally {
    shutdown.abort();
    stopHarnessSidecar(sidecar);
  }
}

await main();
