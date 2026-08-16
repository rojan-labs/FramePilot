/**
 * Tests for the dropdown Menu primitive: open/close, item selection, and
 * dismissal on Escape and outside-press.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Menu, MenuItem } from './Menu.js';

function Host(onPick: () => void): JSX.Element {
  return (
    <div>
      <button type="button">outside</button>
      <Menu label="File" trigger={<span>File</span>}>
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                onPick();
                close();
              }}
            >
              New project
            </MenuItem>
            <MenuItem disabled onSelect={onPick}>
              Disabled
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

describe('Menu', () => {
  it('opens, runs an item, and closes', () => {
    let picked = 0;
    render(Host(() => (picked += 1)));
    const trigger = screen.getByRole('button', { name: 'File' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    expect(picked).toBe(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not fire a disabled item', () => {
    let picked = 0;
    render(Host(() => (picked += 1)));
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }));
    expect(picked).toBe(0);
  });

  it('closes on Escape', () => {
    render(Host(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'New project' })).toBeNull();
  });

  it('closes on an outside pointer press', () => {
    render(Host(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menuitem', { name: 'New project' })).toBeNull();
  });
});
