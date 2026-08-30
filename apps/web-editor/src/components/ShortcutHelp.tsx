/**
 * Keyboard cheat-sheet overlay (plan 3.4 Part 3, PROMPT §6). A thin modal shell
 * around the shared {@link ShortcutList}, which renders the searchable, grouped
 * list from the {@link SHORTCUTS} registry (so it can never drift from the keys
 * the handler honours). Opened with `?`; closed with Esc, the close button, or a
 * backdrop click.
 */
import { useEffect, useRef } from 'react';
import { ShortcutList } from './ShortcutList.js';
import { useModalFocusTrap } from './ai/useModalFocusTrap.js';
import { ICON_SIZE, X } from './icons.js';

export interface ShortcutHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ShortcutHelp({ open, onClose }: ShortcutHelpProps): JSX.Element | null {
  // Gate before the content so the trap's mount effect runs when the dialog actually
  // appears — a hook called above an `open` guard sees a null ref and installs nothing.
  if (!open) return null;
  return <ShortcutHelpContent onClose={onClose} />;
}

function ShortcutHelpContent({ onClose }: { readonly onClose: () => void }): JSX.Element {
  // Declared before the search-focus effect below so that effect runs last and wins:
  // the trap's job here is Tab containment and returning focus to whatever opened it.
  const dialogRef = useModalFocusTrap<HTMLDivElement>();
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search field on open.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Escape on `document`, not on the backdrop: a React `onKeyDown` up there only sees
  // keys pressed inside the overlay, so Escape died the moment focus left it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shortcut-help-head">
          <h2>Keyboard shortcuts</h2>
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

        <ShortcutList searchRef={searchRef} />
      </div>
    </div>
  );
}
