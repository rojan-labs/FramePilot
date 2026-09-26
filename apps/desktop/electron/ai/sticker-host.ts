/**
 * `add_sticker` in the trusted main process (plan/elements EL6a.7, 06 §3): copy the catalogue
 * sticker into the open project and hand back its asset — the `stock-host.ts` shape, editing
 * nothing. The orchestrator places the asset with `buildAddStickerOps`, the builder the Stickers
 * tab uses, so a sticker the agent adds and one added by hand are the same data.
 *
 * Failures come back as the model's sentence from `reliability/sourcing-notes.ts` (what happened
 * and what to do instead), never an error code and never a varying number: the agent's
 * repeated-failure guard keys on the text.
 */
import { stickerFailureNote, type HostToolOutcome } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';
import type { ElementMaterializeRequest, ElementMaterializeResult } from '../ipc/contract.js';

/** The slice of `ElementsLibrary` this host needs, so a test can supply it. */
export interface StickerHostIO {
  materialize(request: ElementMaterializeRequest): Promise<ElementMaterializeResult>;
}

/** Build the host function the sidecar executor calls for `add_sticker`. */
export function createStickerHost(
  io: StickerHostIO,
): (project: Project, args: { readonly elementId: string }) => Promise<HostToolOutcome> {
  return async (project, args) => {
    const result = await io.materialize({ projectId: project.id, elementId: args.elementId });
    if (!result.ok) return { status: 'failed', summary: stickerFailureNote(result.error) };
    const name = result.asset.source.remoteId.replace(/_/g, ' ');
    return {
      status: 'completed',
      summary: `Added the ${name} sticker to the project.`,
      data: { asset: result.asset },
    };
  };
}
