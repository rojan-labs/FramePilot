/**
 * The one message waiting behind a live run.
 *
 * Sending while the agent works used to clear the composer and then do nothing: `runTurn`
 * refuses a second run, so the text was simply gone. The sidebar now parks it here
 * instead, and sends it as the next turn when the run finishes. There is exactly one
 * slot — a stack of follow-ups written against a timeline the run is still changing
 * would each be stale by the time it went out, and one visible, editable message is
 * something a reviewer can actually keep track of.
 *
 * Editing happens in place rather than by pulling the text back into the composer: the
 * composer may already hold the next thing the reviewer is typing, and swapping the two
 * would either overwrite it or force a merge. While the edit is open the parent holds
 * the send (see `editing`), so a run that finishes mid-edit never sends the old text.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { Pencil, X } from '../icons.js';

export interface QueuedMessageProps {
  readonly text: string;
  /** References that will travel with the message. */
  readonly attachmentCount: number;
  /** Whether a run is still live — decides what the hint promises. */
  readonly running: boolean;
  /** The edit field is open. Owned by the parent, which holds the send while it is. */
  readonly editing: boolean;
  readonly onStartEdit: () => void;
  /** Commit an edit. An empty result removes the message. */
  readonly onSaveEdit: (text: string) => void;
  readonly onCancelEdit: () => void;
  readonly onRemove: () => void;
}

export function QueuedMessage(props: QueuedMessageProps): JSX.Element {
  const { text, editing } = props;
  const [editDraft, setEditDraft] = useState(text);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Every edit starts from what is actually queued, not from an abandoned earlier edit.
  useEffect(() => {
    if (!editing) return;
    setEditDraft(text);
    const field = editRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing, text]);

  const save = (): void => props.onSaveEdit(editDraft.trim());

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onCancelEdit();
    }
  };

  const hint = editing
    ? props.running
      ? 'Sends when the run finishes'
      : 'Sends when you finish editing'
    : 'Sends when the run finishes';

  return (
    <div className="ai-queued" role="group" aria-label="Queued message" data-testid="ai-queued">
      <div className="ai-queued-head">
        <span className="ai-queued-label">Queued</span>
        <span className="ai-queued-hint">{hint}</span>
        {!editing && (
          <span className="ai-queued-actions">
            <button
              type="button"
              className="ai-queued-icon"
              aria-label="Edit queued message"
              title="Edit"
              onClick={props.onStartEdit}
            >
              <Pencil size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ai-queued-icon"
              aria-label="Remove queued message"
              title="Remove"
              onClick={props.onRemove}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="ai-queued-edit">
          <textarea
            ref={editRef}
            className="ai-queued-input"
            aria-label="Queued message text"
            rows={2}
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="ai-queued-edit-actions">
            <button type="button" className="ai-queued-button" onClick={props.onCancelEdit}>
              Cancel
            </button>
            <button
              type="button"
              className="ai-queued-button"
              data-variant="primary"
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="ai-queued-text">{text}</p>
      )}
      {props.attachmentCount > 0 && (
        <p className="ai-queued-meta">
          {props.attachmentCount === 1
            ? '1 reference attached'
            : `${props.attachmentCount} references attached`}
        </p>
      )}
    </div>
  );
}
