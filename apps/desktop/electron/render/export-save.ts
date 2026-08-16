/**
 * Save an exported render to a user-chosen location ("Save As"), copying it out
 * of the sandboxed `exports/` folder the sidecar rendered into.
 *
 * WHY this exists: the render engine sandboxes every output path to the
 * project's folder (`resolve_within`, engine/python `pipeline.py`), so it can
 * never write directly to an arbitrary user-chosen path — and `main.ts` is
 * intentionally thin, untested glue (see its header comment). This module owns
 * the actual logic (sandbox re-check + native dialog + copy) with the dialog
 * and copy functions injected, so it is unit-testable without an Electron
 * runtime, mirroring `render/export-client.ts`'s injectable-`fetch` pattern.
 */
import type { ExportSaveAsResult } from '@framepilot/shared-types';
import { sandboxProjectPath } from '../ipc/sandbox.js';

/** Minimal shape of the fields we use from Electron's `dialog.showSaveDialog` result. */
export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export type ShowSaveDialogFn = (options: {
  title: string;
  defaultPath?: string;
}) => Promise<SaveDialogResult>;

export type CopyFileFn = (source: string, destination: string) => Promise<void>;

/**
 * Re-validate `sourcePath` against the projects sandbox, prompt the user for a
 * destination, then copy the file there.
 *
 * @param projectsDir - The sandbox root (the default projects folder).
 * @param sourcePath - The renderer-supplied render output to copy.
 * @param defaultPath - Suggested full path (folder + file name) for the dialog.
 * @param showSaveDialog - Injectable `dialog.showSaveDialog`.
 * @param copyFile - Injectable file copy (`fs/promises.copyFile`).
 */
export async function saveExportAs(
  projectsDir: string,
  sourcePath: unknown,
  defaultPath: string | undefined,
  showSaveDialog: ShowSaveDialogFn,
  copyFile: CopyFileFn,
): Promise<ExportSaveAsResult> {
  const guard = sandboxProjectPath(projectsDir, sourcePath);
  if (!guard.ok) return guard;

  const { canceled, filePath } = await showSaveDialog({
    title: 'Save exported video',
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (canceled || !filePath) {
    return { ok: false, error: 'cancelled' };
  }

  try {
    await copyFile(guard.path, filePath);
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
