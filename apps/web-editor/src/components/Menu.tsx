/**
 * A minimal accessible dropdown menu (plan 3.4 Part 6 — the topbar File menu).
 *
 * A trigger button toggles a popover of {@link MenuItem}s. The menu closes on
 * Escape, on an outside pointer press, and (by default) after an item runs.
 * Trigger and popover carry the WAI-ARIA menu-button roles so it is operable by
 * keyboard and screen readers. This is presentational only — the items decide
 * what they do.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { hintFor } from '../editor/shortcuts.js';
import { ChevronDown, ICON_SIZE } from './icons.js';

export interface MenuProps {
  /** Visible trigger content (label and/or icon). */
  readonly trigger: ReactNode;
  /** Accessible name for the trigger button. */
  readonly label: string;
  /** Render the menu items; `close` dismisses the popover. */
  readonly children: (close: () => void) => ReactNode;
  readonly className?: string;
}

export function Menu({ trigger, label, children, className }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  // Dismiss on an outside press or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`menu ${className ?? ''}`} ref={rootRef}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
        <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" className="menu-caret" />
      </button>
      {open && (
        <div id={menuId} role="menu" className="menu-popover" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/**
 * The chord a menu row advertises, read from the shortcut registry rather than
 * typed into the markup — the same source the `?` overlay renders from, so it is
 * right on Windows and Linux too. Renders nothing when the id is unknown.
 *
 * Shared by {@link MenuItem} and the timeline's context menus so there is one
 * rendering of a menu shortcut in the app.
 */
export function MenuShortcut({ shortcutId }: { readonly shortcutId: string }): JSX.Element | null {
  const hint = hintFor(shortcutId);
  if (hint === null) return null;
  return <kbd className="menu-item-kbd">{hint}</kbd>;
}

export interface MenuItemProps {
  readonly onSelect: () => void;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  /** Registry id of the shortcut that runs this same action, shown on the row. */
  readonly shortcutId?: string;
}

/** A single actionable row inside a {@link Menu}. */
export function MenuItem({
  onSelect,
  icon,
  children,
  disabled,
  shortcutId,
}: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      {icon && (
        <span className="menu-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="menu-item-label">{children}</span>
      {shortcutId !== undefined && <MenuShortcut shortcutId={shortcutId} />}
    </button>
  );
}
