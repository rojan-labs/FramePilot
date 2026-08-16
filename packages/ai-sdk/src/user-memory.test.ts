/**
 * Tests for the user memory scope (redesign §16.1, K5.1) — cross-project editorial
 * defaults, parsed defensively from a free-form profile record.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_USER_MEMORY,
  readUserMemory,
  setFavoriteExportPlatforms,
  setUserPreference,
  summarizeUserMemory,
  writeUserMemory,
} from './user-memory.js';

describe('user memory', () => {
  it('reads empty defaults from a fresh (undefined) profile', () => {
    expect(readUserMemory(undefined)).toEqual({ favoriteExportPlatforms: [] });
  });

  it('falls back to defaults when the profile is garbage (untrusted)', () => {
    expect(readUserMemory({ favoriteExportPlatforms: 'not-an-array' })).toEqual(EMPTY_USER_MEMORY);
    expect(readUserMemory('nonsense')).toEqual(EMPTY_USER_MEMORY);
  });

  it('round-trips preferences and platforms through write', () => {
    let memory = readUserMemory(undefined);
    memory = setUserPreference(memory, 'captionStyle', 'karaoke');
    memory = setUserPreference(memory, 'targetAudience', 'founders');
    memory = setFavoriteExportPlatforms(memory, ['reels', 'shorts']);

    const raw = writeUserMemory(memory);
    expect(readUserMemory(raw)).toEqual({
      captionStyle: 'karaoke',
      targetAudience: 'founders',
      favoriteExportPlatforms: ['reels', 'shorts'],
    });
  });

  it('does not mutate the input memory (pure)', () => {
    const memory = readUserMemory(undefined);
    setUserPreference(memory, 'brandStyle', 'bold');
    setFavoriteExportPlatforms(memory, ['x']);
    expect(memory).toEqual({ favoriteExportPlatforms: [] });
  });

  it('summarizes only the fields that are set', () => {
    let memory = readUserMemory(undefined);
    expect(summarizeUserMemory(memory)).toBe('');

    memory = setUserPreference(memory, 'targetAudience', 'founders');
    memory = setUserPreference(memory, 'brandStyle', 'bold');
    memory = setUserPreference(memory, 'captionStyle', 'karaoke');
    memory = setUserPreference(memory, 'preferredPacing', 'fast');
    memory = setFavoriteExportPlatforms(memory, ['reels', 'x']);
    const summary = summarizeUserMemory(memory);
    expect(summary).toContain('Target audience: founders');
    expect(summary).toContain('Brand style: bold');
    expect(summary).toContain('Caption style: karaoke');
    expect(summary).toContain('Preferred pacing: fast');
    expect(summary).toContain('Favourite export platforms: reels, x');
  });
});
