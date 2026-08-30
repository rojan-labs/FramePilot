/**
 * The attachments a sent message owns, rendered inside its own bubble.
 *
 * Read-only on purpose, and that is the whole distinction from {@link ReferenceTile}.
 * The composer's tile is a control surface — remove, re-analyze, change the role —
 * because the attachment there is still being decided. Once the message is sent the
 * decision is history: a bubble is a record of what was asked, and a record with an
 * X button on it is not a record. So this shows the thumbnail, the name and the role,
 * and offers nothing to change.
 *
 * Before this existed a message carried no attachments at all, so a bubble could only
 * ever show text and the editor had no way to see what a past turn had been given.
 * Attaching a reference and asking "make it feel like this" scrolled away into a
 * conversation that no longer remembered the "this".
 */
import { useMemo, useState, type JSX } from 'react';
import type { MessageAttachment } from '@framepilot/ai-sdk';
import type { Asset } from '@framepilot/timeline-schema';
import { useAssetThumbnail } from '../../editor/useAssetThumbnail.js';
import { Film, Image as ImageGlyph, Paperclip, X } from '../icons.js';

function AttachmentThumb({ attachment }: { attachment: MessageAttachment }): JSX.Element {
  const [broken, setBroken] = useState(false);
  // Stable per (id, path, kind) for the same reason the composer's tile is: the hook
  // keys its capture effect on the asset object, and a fresh one each render restarts
  // the video decode on every re-render of the conversation.
  const asset = useMemo<Asset | undefined>(() => {
    if (!attachment.path) return undefined;
    if (attachment.kind !== 'video' && attachment.kind !== 'image') return undefined;
    return { id: attachment.id, path: attachment.path, kind: attachment.kind };
  }, [attachment.id, attachment.path, attachment.kind]);
  const thumb = useAssetThumbnail(asset);

  if (thumb.status === 'ready' && !broken) {
    return (
      <img
        className="ai-msg-attachment-img"
        src={thumb.url}
        alt=""
        aria-hidden="true"
        onError={() => setBroken(true)}
      />
    );
  }
  const Glyph =
    attachment.kind === 'image' ? ImageGlyph : attachment.kind === 'video' ? Film : Paperclip;
  return <Glyph size={14} aria-hidden="true" className="ai-msg-attachment-glyph" />;
}

export function MessageAttachments({
  attachments,
  dismissedIds,
  onDismiss,
}: {
  readonly attachments: readonly MessageAttachment[];
  /** Ids the editor has taken out of force; still shown, marked as no longer used. */
  readonly dismissedIds?: readonly string[];
  /**
   * Stop using this reference on later turns.
   *
   * Not a contradiction of the read-only rule above: the record stands either way — the
   * bubble goes on saying this file was attached to this message. What changes is
   * whether the AI is still working under it, which is policy, and the tile is simply
   * where that policy is visible. Absent (in an export, say) the tiles are inert.
   */
  readonly onDismiss?: (attachmentId: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  const dismissed = new Set(dismissedIds ?? []);
  return (
    <ul
      className="ai-msg-attachments"
      aria-label={`${String(attachments.length)} attachment${attachments.length === 1 ? '' : 's'}`}
    >
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="ai-msg-attachment"
          data-kind={attachment.kind}
          data-dismissed={dismissed.has(attachment.id) ? '' : undefined}
        >
          <span className="ai-msg-attachment-thumb">
            <AttachmentThumb attachment={attachment} />
          </span>
          <span className="ai-msg-attachment-name" title={attachment.name}>
            {attachment.name}
          </span>
          {/* The role is what the model was told this reference was FOR, so it belongs on
              the record. Its absence is meaningful too — it means nothing was measured
              and the reference contributed nothing to that turn — so it is stated
              rather than left blank. */}
          <span className="ai-msg-attachment-role">
            {dismissed.has(attachment.id)
              ? 'no longer used'
              : attachment.profile
                ? (attachment.role ?? 'reference')
                : 'not analyzed'}
          </span>
          {onDismiss !== undefined &&
            attachment.profile !== undefined &&
            !dismissed.has(attachment.id) && (
              <button
                type="button"
                className="ai-msg-attachment-dismiss"
                onClick={() => onDismiss(attachment.id)}
                title={`Stop using ${attachment.name} as a reference`}
                aria-label={`Stop using ${attachment.name} as a reference`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
        </li>
      ))}
    </ul>
  );
}
