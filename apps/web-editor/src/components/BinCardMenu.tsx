/**
 * A media-bin card's **More actions** menu: the card's secondary actions (Relink, Remove) as a
 * small menu, so a narrow card keeps a single row of 24 px buttons and Relink has a keyboard path
 * (Shift+F10 or the context-menu key on the focused card opens it).
 *
 * Rendered into `document.body` at a fixed position under the card's corner: the bin's rows are
 * placed with a transform (which would make a fixed child relative to the row) and its thumbnails
 * clip what overflows them. A portal still bubbles through React to the card, so clicks stop here
 * — the card's own click opens the asset in Source.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

/** One row of the menu. */
export interface BinCardMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface BinCardMenuProps {
  /** The menu's accessible name, e.g. "More actions for logo.png". */
  readonly label: string;
  /** The card's thumbnail on screen; the menu opens under its top-right corner. */
  readonly anchor: DOMRect;
  readonly items: readonly BinCardMenuItem[];
  /** Close the menu; `returnFocus` puts the keyboard back on the card. */
  readonly onClose: (returnFocus: boolean) => void;
}

/** Below the card's 24 px button row (and its 4 px inset), so the menu never covers it. */
const MENU_OFFSET_PX = 30;
/** Room kept below the menu, so a card at the bottom of the window opens it on screen. */
const VIEWPORT_MARGIN_PX = 8;
/** Roughly two rows' height: enough to decide whether the menu fits below the card. */
const MENU_ESTIMATED_HEIGHT_PX = 80;

export function BinCardMenu({ label, anchor, items, onClose }: BinCardMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // The keyboard lands on the first action, as a menu opened from the keyboard should.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  // A press anywhere else closes it; focus goes wherever that press put it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const focusRow = (index: number): void => rows[(index + rows.length) % rows.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        focusRow(at + 1);
        break;
      case 'ArrowUp':
        focusRow(at - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      case 'Escape':
        onClose(true);
        break;
      case 'Tab':
        // Tab leaves the menu for the next control, as it does any menu.
        onClose(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const top = Math.min(
    anchor.top + MENU_OFFSET_PX,
    window.innerHeight - VIEWPORT_MARGIN_PX - MENU_ESTIMATED_HEIGHT_PX,
  );

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="context-menu bin-card-menu"
      style={{ top: Math.max(VIEWPORT_MARGIN_PX, top), right: window.innerWidth - anchor.right }}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose(true);
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
