/**
 * Focus and keyboard contract for the app's modal dialogs (plan P8.5).
 *
 * Three properties, asserted per dialog because each one had a different gap:
 *  - Escape closes it from ANY focus inside it, not only from the one control whose
 *    React handler happened to carry the key;
 *  - Tab cannot walk out of the dialog into the page behind it;
 *  - closing returns focus to the control that opened it, so a keyboard user is not
 *    dropped back at the top of the document.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewProjectDialog } from './NewProjectDialog.js';
import { ShortcutHelp } from './ShortcutHelp.js';
import { CommandPalette } from './CommandPalette.js';

/** A trigger button that owns focus before the dialog opens, as a real one would. */
function withTrigger(dialog: (onClose: () => void) => JSX.Element): {
  trigger: HTMLElement;
  close: () => void;
} {
  const onClose = vi.fn();
  // Mount the trigger and give it focus FIRST — the dialog captures whatever was
  // focused at its own mount, which is the whole point of the return.
  const view = render(<button type="button">Open</button>);
  const trigger = screen.getByRole('button', { name: 'Open' });
  trigger.focus();
  view.rerender(
    <>
      <button type="button">Open</button>
      {dialog(onClose)}
    </>,
  );
  return { trigger, close: () => view.rerender(<button type="button">Open</button>) };
}

describe('modal dialog focus and keyboard contract', () => {
  it('NewProjectDialog closes on Escape pressed from the Cancel button', () => {
    const onClose = vi.fn();
    render(<NewProjectDialog open onConfirm={() => {}} onClose={onClose} />);
    // Escape used to live on the name input alone, so tabbing to a footer button left
    // the dialog with no keyboard way out.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('NewProjectDialog keeps Tab inside the dialog', () => {
    render(<NewProjectDialog open onConfirm={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    const create = screen.getByRole('button', { name: 'Create' });
    // Tab from the LAST focusable wraps to the first rather than reaching the page.
    create.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('ShortcutHelp closes on Escape after focus has left the search field', () => {
    const onClose = vi.fn();
    render(<ShortcutHelp open onClose={onClose} />);
    screen.getByRole('button', { name: 'Close' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('ShortcutHelp returns focus to the trigger when it closes', () => {
    const { trigger, close } = withTrigger((onClose) => <ShortcutHelp open onClose={onClose} />);
    expect(trigger).not.toBe(document.activeElement);
    close();
    expect(document.activeElement).toBe(trigger);
  });

  it('CommandPalette closes on Escape pressed from a command row', () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        hasSelection={false}
        selectionLabel=""
        onSubmitScopedEdit={() => {}}
        onOpenAiSidebar={() => {}}
      />,
    );
    screen.getAllByRole('option')[0]!.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('CommandPalette names the highlighted row for assistive tech', () => {
    render(
      <CommandPalette
        open
        onClose={() => {}}
        hasSelection={false}
        selectionLabel=""
        onSubmitScopedEdit={() => {}}
        onOpenAiSidebar={() => {}}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Command palette input' });
    const options = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);

    // Arrow keys move a highlight the input owns, so the pointer has to move with it —
    // otherwise pressing Down announces nothing at all.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('CommandPalette returns focus to the trigger when it closes', () => {
    const { trigger, close } = withTrigger((onClose) => (
      <CommandPalette
        open
        onClose={onClose}
        hasSelection={false}
        selectionLabel=""
        onSubmitScopedEdit={() => {}}
        onOpenAiSidebar={() => {}}
      />
    ));
    close();
    expect(document.activeElement).toBe(trigger);
  });
});
