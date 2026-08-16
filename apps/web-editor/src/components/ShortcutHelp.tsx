/**
 * Keyboard cheat-sheet overlay (plan 3.4 Part 3, PROMPT §6). A thin modal shell
 * around the shared {@link ShortcutList}, which renders the searchable, grouped
 * list from the {@link SHORTCUTS} registry (so it can never drift from the keys
 * the handler honours). Opened with `?`; closed with Esc, the close button, or a
 * backdrop click.
 */
import { useEffect, useRef } from 'react';
import { ShortcutList } from './ShortcutList.js';
import { ICON_SIZE, X } from './icons.js';

export interface ShortcutHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ShortcutHelp({ open, onClose }: ShortcutHelpProps): JSX.Element | null {
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search field on open.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="overlay-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
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
