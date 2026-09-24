/**
 * The pictures of one AI run, on the desktop host (EQ18).
 *
 * Two directions, one rule — image BYTES live in main and on disk, never on the wire:
 *
 * - IN: an image the editor attached reaches a model that reads images as the picture
 *   itself ({@link loadReferenceImages}), loaded from the imported copy by the engine.
 * - OUT: a picture a tool showed the model — a `get_frame` look — is written into the
 *   project's attachments and its event carries the path ({@link storeToolImages}), so
 *   the card can show exactly what the model judged without the bytes riding IPC, the
 *   run's WAL or the saved conversation.
 *
 * IO is injected, so this stays free of `electron` and `fs` like the rest of `ai/`.
 */
import type {
  AiEvent,
  ReferenceImage,
  ReferenceProfile,
  ToolResultImage,
} from '@framepilot/ai-sdk';
import type { AiStreamReferenceFile } from '@framepilot/shared-types';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('desktop:run-media');

/** Loads one image reference's picture (the engine's `/references/still`). */
export type ReferenceStillLoader = (
  file: { readonly referenceId: string; readonly path: string; readonly fileName: string },
  signal?: AbortSignal,
) => Promise<ReferenceImage>;

/** Stores one tool picture for a project and returns its projects-root-relative path. */
export type ToolImageSaver = (
  projectId: string,
  mediaType: string,
  bytes: Uint8Array,
) => Promise<string>;

/**
 * The pictures of the IMAGE references in force that have a file, for a model that reads
 * images. Best-effort per reference: one that fails to load costs the model that picture,
 * never the run — its measured profile still goes, which is what it had before.
 *
 * @param load - The still loader; absent (no sidecar) ⇒ no pictures.
 * @param references - The profiles in force this turn.
 * @param files - Where each reference's imported copy is.
 * @param canSee - Whether this run's model reads images. False ⇒ nothing is loaded at all:
 *   the orchestrator would withhold the pictures anyway, so loading them is wasted work.
 */
export async function loadReferenceImages(
  load: ReferenceStillLoader | undefined,
  references: readonly ReferenceProfile[] | undefined,
  files: readonly AiStreamReferenceFile[] | undefined,
  canSee: boolean,
  signal?: AbortSignal,
): Promise<readonly ReferenceImage[]> {
  if (!load || !canSee || !references || !files || files.length === 0) return [];
  const pathById = new Map(files.map((file) => [file.id, file.path]));
  const wanted = references.flatMap((profile) => {
    const path = profile.kind === 'image' ? pathById.get(profile.id) : undefined;
    return path === undefined
      ? []
      : [{ referenceId: profile.id, path, fileName: profile.fileName }];
  });
  const settled = await Promise.allSettled(wanted.map((file) => load(file, signal)));
  return settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [result.value];
    log.warn('reference picture not loaded; the model gets its measurements only', {
      referenceId: wanted[index]!.referenceId,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    return [];
  });
}

/**
 * Move a tool result's picture bytes to disk and hand the event on with their paths.
 *
 * A picture that fails to store is dropped from the EVENT (the card falls back to the
 * result facts it always had) — never sent inline, which would put the bytes back on the
 * channels this exists to keep them off. The model already has the picture either way:
 * it rides the next request from the orchestrator, not from this event.
 *
 * @returns The event unchanged unless it is a `tool_result` carrying inline image bytes.
 */
export async function storeToolImages(
  event: AiEvent,
  projectId: string,
  save: ToolImageSaver | undefined,
): Promise<AiEvent> {
  if (event.type !== 'tool_result' || !event.images || event.images.length === 0) return event;
  if (!save) return event;
  const stored: ToolResultImage[] = [];
  for (const image of event.images) {
    if (image.base64 === undefined) {
      if (image.path !== undefined) stored.push(image);
      continue;
    }
    try {
      const path = await save(projectId, image.mediaType, Buffer.from(image.base64, 'base64'));
      const { base64: _bytes, ...facts } = image;
      stored.push({ ...facts, path });
    } catch (error) {
      log.warn('tool picture not stored; its card shows the result facts instead', {
        toolCallId: event.toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const { images: _inline, ...rest } = event;
  return stored.length > 0 ? { ...rest, images: stored } : rest;
}
