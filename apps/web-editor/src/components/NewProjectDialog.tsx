import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@framepilot/ui';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';
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
  // Gate before the content so the focus trap's mount effect runs when the dialog
  // actually appears — a hook called above an `open` guard sees a null ref.
  if (!open) return null;
  return <NewProjectDialogContent onConfirm={onConfirm} onClose={onClose} />;
}

function NewProjectDialogContent({
  onConfirm,
  onClose,
}: Omit<NewProjectDialogProps, 'open'>): JSX.Element {
  const [name, setName] = useState('');
  const dialogRef = useModalFocusTrap<HTMLDivElement>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus and select placeholder text on the next tick, AFTER the trap has put focus
    // on the first control — the name field is where a new project actually starts.
    const timer = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Escape on `document`: it used to live on the name input alone, so tabbing to
  // Cancel or Create left the dialog with no keyboard way out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onClose();
  }, [name, onConfirm, onClose]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') submit();
    },
    [submit],
  );

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        tabIndex={-1}
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
