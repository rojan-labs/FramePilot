/**
 * Tests for the ⌘K command palette (plan P12.2/P13.3): open/close, selection-scoped
 * submit vs. the no-selection fallback, slash-command filtering, and arrow-key
 * navigation.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from './CommandPalette.js';

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <CommandPalette
        open={false}
        onClose={vi.fn()}
        hasSelection={false}
        onSubmitScopedEdit={vi.fn()}
        onOpenAiSidebar={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('closes on Escape and on an outside click', () => {
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        hasSelection={false}
        onSubmitScopedEdit={vi.fn()}
        onOpenAiSidebar={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('with a selection: shows the scoped hint and Enter sends the typed text', () => {
    const onSubmitScopedEdit = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        hasSelection
        selectionLabel="2 clips, 12.0–18.0s"
        onSubmitScopedEdit={onSubmitScopedEdit}
        onOpenAiSidebar={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 clips, 12\.0–18\.0s/)).toBeTruthy();
    const input = screen.getByLabelText('Command palette input');
    fireEvent.change(input, { target: { value: 'brighten this clip' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitScopedEdit).toHaveBeenCalledWith('brighten this clip');
    expect(onClose).toHaveBeenCalled();
  });

  it('without a selection: shows the fallback hint and the primary action opens the AI sidebar', () => {
    const onOpenAiSidebar = vi.fn();
    const onSubmitScopedEdit = vi.fn();
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        hasSelection={false}
        onSubmitScopedEdit={onSubmitScopedEdit}
        onOpenAiSidebar={onOpenAiSidebar}
      />,
    );
    expect(screen.getByText(/Select a clip to scope your edit/)).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Open AI sidebar/ }));
    expect(onOpenAiSidebar).toHaveBeenCalledTimes(1);
    expect(onSubmitScopedEdit).not.toHaveBeenCalled();
  });

  it('filters the slash-command list by typed text', () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        hasSelection={false}
        onSubmitScopedEdit={vi.fn()}
        onOpenAiSidebar={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Command palette input');
    fireEvent.change(input, { target: { value: 'caption' } });
    expect(screen.getByText('/add-captions')).toBeTruthy();
    expect(screen.queryByText('/remove-silence')).toBeNull();
  });

  it('ArrowDown/ArrowUp move the active row (wrap-around) and Enter runs the highlighted one', () => {
    const onSubmitScopedEdit = vi.fn();
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        hasSelection
        selectionLabel="1 clip, 0.0–4.0s"
        onSubmitScopedEdit={onSubmitScopedEdit}
        onOpenAiSidebar={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('Command palette input');
    fireEvent.change(input, { target: { value: 'caption' } });
    // Row 0 is the primary Send action; ArrowDown moves to the first filtered command.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const captionOption = screen.getByRole('option', { name: /add-captions/ });
    expect(captionOption.getAttribute('aria-selected')).toBe('true');
    // Wrap back up to the primary row.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitScopedEdit).toHaveBeenCalledWith('caption');
  });
});
