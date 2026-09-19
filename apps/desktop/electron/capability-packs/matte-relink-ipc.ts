/**
 * Relink or replace an asset's file, then re-check its mattes (BR4.14, audit P9).
 *
 * Two named channels, split so the edit itself stays a typed, undoable `relink_asset` patch the
 * renderer commits through the normal project authority:
 *
 * 1. `projectChooseRelinkFile(assetId)`: main shows the native file dialog for an asset of the
 *    open project and returns the chosen regular file. The renderer never supplies a path here.
 * 2. `matteRecheckMedia({ assetIds })`: main re-reads the project and compares every matte on
 *    those assets against the frames recorded when it was made. For an asset whose file main
 *    just chose, the check uses that file even if the renderer's commit has not reached disk
 *    yet. Changed media comes back STALE with the export's own sentence, and an artifact that
 *    fails the quick file check (deleted, resized, unparseable) comes back BROKEN with its own:
 *    this channel is the only way the Inspector and the export dialog learn either.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { MatteRecheckRequestSchema, RelinkAssetIdSchema } from '@framepilot/capability-packs';
import {
  createLogger,
  type MatteRecheckResultWire,
  type RelinkFileChoiceWire,
} from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { IpcChannels } from '../ipc/contract.js';
import type { MatteIpcMain } from './matte-ipc.js';
import type { MatteMediaInspector } from './matte-media-inspector.js';
import { recheckProjectMatteMedia } from './matte-media-recheck.js';
import { matteMasksOf, validateProjectMattes, type MatteValidationIssue } from './matte-validation.js';

const log = createLogger('desktop:capability-packs:matte-relink');

export interface RelinkIpcDependencies {
  readonly ipcMain: MatteIpcMain;
  readonly requireLicense: () => void;
  readonly activeProjectPath: () => Promise<string | null>;
  readonly readProject: (projectPath: string) => Promise<Project>;
  /** Native open-file dialog; resolves `undefined` when the editor cancels. */
  readonly chooseFile: (assetName: string) => Promise<string | undefined>;
  readonly inspector: () => Promise<MatteMediaInspector>;
}

export function registerRelinkIpc(dependencies: RelinkIpcDependencies): void {
  const { ipcMain } = dependencies;
  /** `${projectPath}\0${assetId}` → the file main chose for it this session. */
  const chosen = new Map<string, string>();

  ipcMain.handle(IpcChannels.projectChooseRelinkFile, async (_event, assetIdInput: unknown): Promise<RelinkFileChoiceWire> => {
    dependencies.requireLicense();
    const parsed = RelinkAssetIdSchema.safeParse(assetIdInput);
    if (!parsed.success) return { ok: false, code: 'missing_asset', error: 'That media is not in this project.' };
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.' };
    const project = await dependencies.readProject(projectPath);
    const asset = project.assets.find((candidate) => candidate.id === parsed.data);
    if (asset === undefined) return { ok: false, code: 'missing_asset', error: 'That media is not in this project.' };
    const file = await dependencies.chooseFile(path.basename(asset.path));
    if (file === undefined) return { ok: false, code: 'cancelled', error: 'Relink cancelled.' };
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || !path.isAbsolute(file)) throw new Error('not a file');
    } catch {
      return { ok: false, code: 'not_a_file', error: 'Choose a media file, not a folder or link.' };
    }
    chosen.set(`${projectPath}\0${asset.id}`, file);
    log.action('relinkFileChosen', {});
    return { ok: true, assetId: asset.id, path: file };
  });

  ipcMain.handle(IpcChannels.matteRecheckMedia, async (_event, input: unknown): Promise<MatteRecheckResultWire> => {
    const parsed = MatteRecheckRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_request', error: 'Re-check request is malformed.' };
    const projectPath = await dependencies.activeProjectPath();
    if (projectPath === null) return { ok: false, code: 'no_project', error: 'No project is open.' };
    const saved = await dependencies.readProject(projectPath);
    const project = {
      ...saved,
      assets: saved.assets.map((asset) => {
        const file = chosen.get(`${projectPath}\0${asset.id}`);
        return file === undefined ? asset : { ...asset, path: file };
      }),
    };
    // A choice covers only the re-check that follows it; after that (an undo, a later edit) the
    // saved project is the authority again.
    for (const assetId of parsed.data.assetIds) chosen.delete(`${projectPath}\0${assetId}`);
    const projectDir = path.dirname(projectPath);
    const broken = await artifactIssues(projectDir, project, parsed.data.assetIds);
    const changed = await recheckProjectMatteMedia(projectDir, project, await dependencies.inspector(), {
      assetIds: parsed.data.assetIds,
    });
    // A mask whose artifact is already unusable reports that first and only: the remedy is the
    // same re-run, and the file problem is the one the export refuses with.
    const reported = new Set(broken.map((issue) => `${issue.clipId}|${issue.maskId}`));
    return { ok: true, issues: [...broken, ...changed.filter((issue) => !reported.has(`${issue.clipId}|${issue.maskId}`))] };
  });
}

/**
 * The quick file check the project got on open (missing, resized or unparseable artifact), for
 * the matte masks on `assetIds` only.
 */
async function artifactIssues(
  projectDir: string,
  project: Project,
  assetIds: readonly string[],
): Promise<MatteValidationIssue[]> {
  const wanted = new Set(assetIds);
  const scoped = new Set(
    matteMasksOf(project)
      .filter((mask) => mask.assetId !== undefined && wanted.has(mask.assetId))
      .map((mask) => `${mask.clipId}|${mask.maskId}`),
  );
  if (scoped.size === 0) return [];
  const issues = await validateProjectMattes(projectDir, project, { mode: 'quick' });
  return issues.filter((issue) => scoped.has(`${issue.clipId}|${issue.maskId}`));
}
