import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './useSettings.js';

describe('web editor theme settings', () => {
  it('defaults new and incomplete settings to the minimal light theme', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('light');
    expect(mergeSettings({}).theme).toBe('light');
    expect(mergeSettings({ theme: 'sepia' }).theme).toBe('light');
  });

  it('preserves every explicit supported theme choice', () => {
    expect(mergeSettings({ theme: 'light' }).theme).toBe('light');
    expect(mergeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(mergeSettings({ theme: 'system' }).theme).toBe('system');
  });
});
