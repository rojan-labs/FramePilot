/**
 * The left rail's remembered tab: a renamed tab (`stock` → `elements`) lands on its
 * replacement, and a desktop-only tab is never restored in a browser build.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({ value: true }));

vi.mock('../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editor/bridge.js')>()),
  isDesktop: () => desktop.value,
}));

import { coerceLeftTab } from './Editor.js';

describe('coerceLeftTab', () => {
  beforeEach(() => {
    desktop.value = true;
  });

  it('opens Elements for someone who left the rail on the old Stock tab', () => {
    expect(coerceLeftTab('stock')).toBe('elements');
  });

  it('restores Elements itself', () => {
    expect(coerceLeftTab('elements')).toBe('elements');
  });

  it('never restores a desktop-only tab in a browser build', () => {
    desktop.value = false;
    expect(coerceLeftTab('stock')).toBeUndefined();
    expect(coerceLeftTab('elements')).toBeUndefined();
    expect(coerceLeftTab('effects')).toBe('effects');
  });

  it('rejects anything that was never a tab', () => {
    expect(coerceLeftTab('nope')).toBeUndefined();
    expect(coerceLeftTab(3)).toBeUndefined();
  });
});
