import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProviderHealth,
  lastProviderSuccess,
  recordProviderSuccess,
} from './providerHealth.js';

describe('providerHealth (UX-11)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('knows nothing until a provider has actually answered', () => {
    expect(lastProviderSuccess('deepseek')).toBeUndefined();
    recordProviderSuccess('deepseek', new Date('2026-08-29T10:00:00Z'));
    expect(lastProviderSuccess('deepseek')?.toISOString()).toBe('2026-08-29T10:00:00.000Z');
    // One provider answering says nothing about another.
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
  });

  it('keeps the most recent success per provider and forgets on clear', () => {
    recordProviderSuccess('nvidia', new Date('2026-08-29T09:00:00Z'));
    recordProviderSuccess('nvidia', new Date('2026-08-29T11:00:00Z'));
    expect(lastProviderSuccess('nvidia')?.toISOString()).toBe('2026-08-29T11:00:00.000Z');
    clearProviderHealth();
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
  });

  it('treats unusable storage as "never answered" rather than throwing', () => {
    localStorage.setItem('framepilot.providerHealth', 'not json');
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
    localStorage.setItem('framepilot.providerHealth', '["array"]');
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
    localStorage.setItem('framepilot.providerHealth', '{"nvidia":123}');
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
    localStorage.setItem('framepilot.providerHealth', '{"nvidia":"not a date"}');
    expect(lastProviderSuccess('nvidia')).toBeUndefined();
  });

  it('never throws when storage refuses a write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => recordProviderSuccess('nvidia')).not.toThrow();
    setItem.mockRestore();
  });

  it('ignores an empty provider name', () => {
    recordProviderSuccess('');
    expect(lastProviderSuccess('')).toBeUndefined();
  });
});
