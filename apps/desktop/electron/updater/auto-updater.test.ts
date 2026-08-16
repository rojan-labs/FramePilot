/**
 * Tests for the electron-updater–backed UpdateProvider (plan Phase 8).
 */
import { describe, expect, it, vi } from 'vitest';
import { createAutoUpdaterProvider, type AutoUpdaterLike } from './auto-updater.js';

function fakeUpdater(version: string | null): AutoUpdaterLike {
  return {
    channel: null,
    autoDownload: true,
    checkForUpdates: vi.fn(async () => (version === null ? null : { updateInfo: { version } })),
  };
}

describe('createAutoUpdaterProvider', () => {
  it('disables silent auto-download (the user approves installs)', () => {
    const updater = fakeUpdater(null);
    createAutoUpdaterProvider(updater);
    expect(updater.autoDownload).toBe(false);
  });

  it('sets the requested channel and reports an available update', async () => {
    const updater = fakeUpdater('1.2.0');
    const provider = createAutoUpdaterProvider(updater);
    const result = await provider.checkForUpdates('beta');
    expect(updater.channel).toBe('beta');
    expect(result).toEqual({ channel: 'beta', updateAvailable: true, version: '1.2.0' });
  });

  it('reports no update when the feed returns nothing', async () => {
    const provider = createAutoUpdaterProvider(fakeUpdater(null));
    const result = await provider.checkForUpdates('stable');
    expect(result).toEqual({ channel: 'stable', updateAvailable: false, version: null });
  });
});
