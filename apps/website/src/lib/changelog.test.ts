import { describe, expect, it } from 'vitest';
import { getChangelogEntries, formatChangelogDate, CHANGE_TAGS } from './changelog';

describe('changelog', () => {
  it('reads the seed entries, newest first, with content', () => {
    const entries = getChangelogEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // Sorted descending by date.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].date >= entries[i].date).toBe(true);
    }
    expect(entries[0].title).toBeTruthy();
    expect(entries[0].summary).toBeTruthy();
    expect(entries[0].content.length).toBeGreaterThan(0);
  });

  it('only uses known change tags', () => {
    for (const entry of getChangelogEntries()) {
      for (const tag of entry.tags ?? []) {
        expect(CHANGE_TAGS).toContain(tag);
      }
    }
  });

  it('formats dates in UTC', () => {
    expect(formatChangelogDate('2026-07-04')).toBe('July 4, 2026');
  });
});
