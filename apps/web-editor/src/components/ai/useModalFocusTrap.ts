/**
 * Focus trap for a modal dialog (D3b, ORCHESTRATOR-GAP-CLOSURE.md).
 *
 * Every modal in this app (`ToolDetailsModal`, `DiffPreviewModal`, `SettingsDialog`,
 * `NewProjectDialog`, `CommandPalette`, …) already closes on Escape, but none of
 * them trap focus: Tab can walk out of the dialog into the page behind it, and
 * closing never returns focus to whatever triggered the dialog. There is no shared
 * `Dialog`/focus-trap primitive in `packages/ui` or elsewhere in the app to reuse
 * (checked before adding this) — this is the first, and both AI-sidebar modals
 * that need one share it rather than each hand-rolling their own.
 */
import { useEffect, useRef } from 'react';

/** Elements a keyboard user can land on, in DOM (tab) order. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Attach to a modal's outermost element (give it `tabIndex={-1}` so it is a valid
 * fallback focus target when it has no focusable children yet). On mount: moves
 * focus to the first focusable element inside (or the container itself). While
 * mounted: Tab from the last focusable element wraps to the first, and Shift+Tab
 * from the first wraps to the last — focus never escapes to the page behind the
 * modal. On unmount: returns focus to whatever element was focused right before
 * the modal opened (the triggering button, typically).
 *
 * `active` exists for the dialogs that render `null` while closed from INSIDE one
 * component rather than through a gate + content pair: their ref is null at mount, so
 * a trap keyed on mount alone would install nothing and silently do no work. Passing
 * the open flag makes the trap install and tear down with the dialog it guards.
 */
export function useModalFocusTrap<T extends HTMLElement>(active = true): React.RefObject<T> {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const first = focusableElements(container)[0];
    (first ?? container).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusableElements(container);
      if (items.length === 0) {
        // Nothing to tab between — keep focus pinned on the container itself.
        event.preventDefault();
        container.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      const atEdge = !active || !container.contains(active);
      if (event.shiftKey) {
        if (atEdge || active === firstItem) {
          event.preventDefault();
          lastItem.focus();
        }
      } else if (atEdge || active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active]);

  return containerRef;
}
