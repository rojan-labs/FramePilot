/**
 * `add_sticker` in the trusted main process (plan/elements EL6a.7, 06 §3): copy the catalogue
 * sticker into the open project and hand back its asset — the `stock-host.ts` shape, editing
 * nothing. The orchestrator places the asset with `buildAddStickerOps`, the builder the Stickers
 * tab uses, so a sticker the agent adds and one added by hand are the same data.
 *
 * Failures come back as the sentence the panel would show (02 §8) plus what to do instead, never
 * an error code, and with no varying numbers: the agent's repeated-failure guard keys on the text.
 */
import type { HostToolOutcome } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type {
  ElementErrorCodeWire,
  ElementMaterializeRequest,
  ElementMaterializeResult,
} from '../ipc/contract.js';

/** The slice of `ElementsLibrary` this host needs, so a test can supply it. */
export interface StickerHostIO {
  materialize(request: ElementMaterializeRequest): Promise<ElementMaterializeResult>;
}

/** Why a sticker could not be added, and what the agent does instead. */
const FAILURE: Readonly<Record<ElementErrorCodeWire, string>> = {
  unknown_element:
    'That sticker id is not in the library. Find one with search_elements (kind: sticker) and ' +
    'use its elementId.',
  library_missing:
    "This sticker's file is missing from this install of FramePilot. Pick another sticker, or " +
    'tell the editor that reinstalling fixes it.',
  integrity_failed:
    "This sticker's file in this install of FramePilot is damaged. Pick another sticker, or " +
    'tell the editor that reinstalling fixes it.',
  disk_full:
    "Couldn't add the sticker: there isn't enough disk space. Tell the editor to free some " +
    'space; do not retry.',
  io_failed:
    "Couldn't copy the sticker into the project folder. Tell the editor to check the project " +
    'folder can be written to; do not retry.',
};

/** Build the host function the sidecar executor calls for `add_sticker`. */
export function createStickerHost(
  io: StickerHostIO,
): (project: Project, args: { readonly elementId: string }) => Promise<HostToolOutcome> {
  return async (project, args) => {
    const result = await io.materialize({ projectId: project.id, elementId: args.elementId });
    if (!result.ok) return { status: 'failed', summary: FAILURE[result.error] };
    const name = result.asset.source.remoteId.replace(/_/g, ' ');
    return {
      status: 'completed',
      summary: `Added the ${name} sticker to the project.`,
      data: { asset: result.asset },
    };
  };
}
