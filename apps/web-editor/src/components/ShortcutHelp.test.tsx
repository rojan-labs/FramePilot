/**
 * Tests for the `?` keyboard help overlay (plan 3.4 Part 3): it renders from the
 * registry, filters on search, and closes via Esc / the close button.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShortcutHelp } from './ShortcutHelp.js';

describe('ShortcutHelp', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ShortcutHelp open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows grouped shortcuts generated from the registry', () => {
    render(<ShortcutHelp open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Transport' })).toBeDefined();
    expect(screen.getByText('Split at playhead')).toBeDefined();
  });

  it('filters the list by search query', () => {
    render(<ShortcutHelp open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search shortcuts'), { target: { value: 'ripple' } });
    expect(screen.getByText(/Ripple delete clip/)).toBeDefined();
    expect(screen.queryByText('Play / pause')).toBeNull();
  });

  it('reports when nothing matches the query', () => {
    render(<ShortcutHelp open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search shortcuts'), { target: { value: 'zzzznope' } });
    expect(screen.getByText(/No shortcuts match/)).toBeDefined();
  });

  it('closes on the close button and on Escape', () => {
    const onClose = vi.fn();
    render(<ShortcutHelp open onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog').parentElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
