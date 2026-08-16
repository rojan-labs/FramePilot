import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@framepilot/ui';
import { ICON_SIZE, X } from './icons.js';

export interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onConfirm: (name: string) => void;
  readonly onClose: () => void;
}

export function NewProjectDialog({
  open,
  onConfirm,
  onClose,
}: NewProjectDialogProps): JSX.Element | null {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      // Focus and select placeholder text on next tick so the dialog is mounted first.
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      }, 0);
    }
  }, [open]);

  const submit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  }, [name, onConfirm, onClose]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') onClose();
    },
    [submit, onClose],
  );

  if (!open) return null;

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-project-dialog-head">
          <h2>New project</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X size={ICON_SIZE.md} aria-hidden="true" />
          </button>
        </header>

        <div className="new-project-dialog-body">
          <label htmlFor="new-project-name">Project name</label>
          <input
            id="new-project-name"
            ref={inputRef}
            type="text"
            placeholder="My project"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
          />
        </div>

        <footer className="new-project-dialog-foot">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="button" disabled={!name.trim()} onClick={submit}>
            Create
          </Button>
        </footer>
      </div>
    </div>
  );
}
