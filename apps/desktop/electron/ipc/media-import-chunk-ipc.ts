import { app } from 'electron';
import { isMediaImportChunkRequest, type MediaImportChunkResult } from '@framepilot/shared-types';
import { resolveProjectsDir } from '../projects/projects-dir.js';
import { importMediaChunk } from '../projects/media-import.js';

/** Lazy implementation behind the lightweight deferred IPC registry. */
export async function handleMediaImportChunk(value: unknown): Promise<MediaImportChunkResult> {
  if (!isMediaImportChunkRequest(value)) {
    return { ok: false, error: 'Invalid media import chunk request.' };
  }
  try {
    const projectsRoot = resolveProjectsDir(process.env, app.getPath('documents'));
    const path = await importMediaChunk(
      projectsRoot,
      value.projectId,
      value.fileName,
      {
        uploadId: value.uploadId,
        offset: value.offset,
        final: value.final,
        ...(value.targetPath === undefined ? {} : { targetPath: value.targetPath }),
        // Validated by `isMediaImportChunkRequest` to be the one allowed literal, so the
        // destination the renderer asked for cannot name a directory of its own.
        ...(value.destination === undefined ? {} : { destination: value.destination }),
      },
      new Uint8Array(value.data),
    );
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
