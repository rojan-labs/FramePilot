import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_CHANNEL,
  UPDATE_CHANNEL_ENV,
  isUpdateChannel,
  noopUpdateProvider,
  resolveUpdateChannel,
} from './channel.js';

describe('update channel resolution', () => {
  it('defaults to the stable channel when unset', () => {
    expect(resolveUpdateChannel({})).toBe(DEFAULT_UPDATE_CHANNEL);
    expect(DEFAULT_UPDATE_CHANNEL).toBe('stable');
  });

  it('honours a recognised channel from the environment', () => {
    expect(resolveUpdateChannel({ [UPDATE_CHANNEL_ENV]: 'beta' })).toBe('beta');
  });

  it('falls back to the default for an unrecognised channel', () => {
    expect(resolveUpdateChannel({ [UPDATE_CHANNEL_ENV]: 'nightly' })).toBe(DEFAULT_UPDATE_CHANNEL);
  });

  it('validates channel strings', () => {
    expect(isUpdateChannel('stable')).toBe(true);
    expect(isUpdateChannel('beta')).toBe(true);
    expect(isUpdateChannel('nope')).toBe(false);
    expect(isUpdateChannel(undefined)).toBe(false);
  });
});

describe('noopUpdateProvider', () => {
  it('reports no update available on the requested channel', async () => {
    expect(await noopUpdateProvider.checkForUpdates('beta')).toEqual({
      channel: 'beta',
      updateAvailable: false,
      version: null,
    });
  });
});
