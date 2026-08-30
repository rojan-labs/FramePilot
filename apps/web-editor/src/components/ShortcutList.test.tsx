/**
 * The cheat-sheet is generated from the registry, so the ONE way it can lie is by
 * omitting a group from {@link GROUP_ORDER} — which is exactly what happened to
 * 'Tools': A and B were declared, honoured by the handler, and invisible in both
 * the `?` overlay and Settings for as long as the Blade tool has existed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SHORTCUTS } from '../editor/shortcuts.js';
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
});
