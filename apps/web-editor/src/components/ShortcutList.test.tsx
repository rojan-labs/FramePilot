/**
 * The cheat-sheet is generated from the registry, so the ONE way it can lie is by
 * omitting a group from {@link GROUP_ORDER} — which is exactly what happened to
 * 'Tools': A and B were declared, honoured by the handler, and invisible in both
 * the `?` overlay and Settings for as long as the Blade tool has existed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PANEL_KEYS, SHORTCUTS } from '../editor/shortcuts.js';
import { GROUP_ORDER, ShortcutList } from './ShortcutList.js';

describe('ShortcutList', () => {
  it('orders every group the registry declares (no shortcut can be invisible)', () => {
    const declared = new Set(SHORTCUTS.map((shortcut) => shortcut.group));
    const ordered = new Set(GROUP_ORDER);
    expect([...declared].filter((group) => !ordered.has(group))).toEqual([]);
  });

  it('renders the Tools group, so the Blade tool advertises its key', () => {
    render(<ShortcutList />);
    expect(screen.getByRole('region', { name: 'Tools' })).toBeDefined();
    expect(screen.getByText('Blade tool')).toBeDefined();
  });

  it('lists the Elements panel keys after the global ones, and none of them runs globally', () => {
    render(<ShortcutList />);
    const panel = screen.getByRole('region', { name: 'Elements panel' });
    expect(panel.textContent).toContain('Search shapes');
    expect(panel.textContent).toContain('Add the tile at the playhead');
    const global = new Set(SHORTCUTS.flatMap((shortcut) => shortcut.keys));
    expect(
      PANEL_KEYS.flatMap((key) => key.keys).filter((key) => key === '/' && global.has(key)),
    ).toEqual([]);
  });
});
