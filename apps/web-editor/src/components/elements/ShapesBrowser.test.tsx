/**
 * The Shapes sub-tab (plan/elements EL4a): six named tiles, a click adds that preset, and a
 * refusal is said, not swallowed.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShapesBrowser } from './ShapesBrowser.js';

describe('ShapesBrowser', () => {
  it('lists the six presets by name, each a button', () => {
    render(<ShapesBrowser onAddShape={() => null} />);
    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Add Highlight box',
      'Add Filled box',
      'Add Ellipse',
      'Add Marker',
      'Add Arrow',
      'Add Underline',
    ]);
    expect(screen.getByRole('list', { name: 'Shapes' })).toBeDefined();
  });

  it('adds the preset clicked', () => {
    const onAddShape = vi.fn(() => null);
    render(<ShapesBrowser onAddShape={onAddShape} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Arrow' }));
    expect(onAddShape).toHaveBeenCalledWith('line-arrow/red');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says why a shape could not be added', () => {
    render(<ShapesBrowser onAddShape={() => 'That spot is locked.'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Marker' }));
    expect(screen.getByRole('status').textContent).toBe('That spot is locked.');
  });
});
