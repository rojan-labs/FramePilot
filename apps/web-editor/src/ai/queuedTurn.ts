/**
 * The message a reviewer sends while a run is still live.
 *
 * `runTurn` refuses to start a second run, so a send during one used to empty the composer
 * and go nowhere. The sidebar holds it here instead — one slot — and sends it as the next
 * turn when the run finishes. When the reviewer ends the run themselves (Stop, a cancelled
 * plan, a conversation switch) it is handed back to a composer rather than sent, and these
 * helpers do that without overwriting whatever is already in the box.
 */
import type { MessageAttachment } from '@framepilot/ai-sdk';
import type { Attachment } from './conversation.js';

/** A message sent during a run, waiting to become the next turn. */
export interface QueuedTurn {
  readonly text: string;
  /** Frozen at queue time, the same way a normal send freezes them. */
  readonly attachments: readonly MessageAttachment[];
}

/** Separates two drafts that end up in one composer, so neither runs into the other. */
const DRAFT_SEPARATOR = '\n\n';

/**
 * Put two drafts in one composer without losing either.
 *
 * @param first - The text that reads first.
 * @param second - The text that follows it.
 * @returns Both, blank parts dropped, joined by a blank line.
 */
export function joinDrafts(first: string, second: string): string {
  return [first.trim(), second.trim()].filter((part) => part.length > 0).join(DRAFT_SEPARATOR);
}

/**
 * The composer's attachments after a queued message's references come back to it.
 *
 * They come back `ready`: they were frozen onto the message and already measured (or
 * travel without a profile, as any sent message's do), so nothing is re-analyzed. A
 * reference the composer already holds is not added twice.
 *
 * @param returned - The queued message's attachments.
 * @param live - What the composer holds now.
 * @returns The returned references first, then the live ones.
 */
export function returnAttachments(
  returned: readonly MessageAttachment[],
  live: readonly Attachment[],
): readonly Attachment[] {
  const held = new Set(live.map((attachment) => attachment.id));
  const restored = returned
    .filter((attachment) => !held.has(attachment.id))
    .map((attachment): Attachment => ({ ...attachment, status: 'ready' }));
  return restored.length === 0 ? live : [...restored, ...live];
}
