/**
 * User memory state (Settings → Memory, K5.1b). A light hook over the localStorage store
 * ({@link userMemoryStorage}): the Settings panel edits the editorial defaults; the AI
 * sidebar reads {@link loadUserMemory} directly at run time to thread the scope into
 * context. No secrets, so no IPC — see the store doc.
 */
import { useState } from 'react';
import type { UserMemory, UserPreferenceKey } from '@framepilot/ai-sdk';
import { setFavoriteExportPlatforms, setUserPreference } from '@framepilot/ai-sdk';
import { loadUserMemory, persistUserMemory } from './userMemoryStorage.js';

/** The memory value plus mutators the Settings panel uses. */
export interface UserMemoryValue {
  readonly userMemory: UserMemory;
  /** Set one cross-project editorial preference (empty string clears it). */
  readonly setPreference: (key: UserPreferenceKey, value: string) => void;
  /** Replace the favourite export platforms. */
  readonly setPlatforms: (platforms: readonly string[]) => void;
}

/** Reactive user memory backed by localStorage. */
export function useUserMemory(): UserMemoryValue {
  const [userMemory, setUserMemory] = useState<UserMemory>(loadUserMemory);

  const setPreference = (key: UserPreferenceKey, value: string): void => {
    const next = setUserPreference(userMemory, key, value);
    persistUserMemory(next);
    setUserMemory(next);
  };

  const setPlatforms = (platforms: readonly string[]): void => {
    const next = setFavoriteExportPlatforms(userMemory, platforms);
    persistUserMemory(next);
    setUserMemory(next);
  };

  return { userMemory, setPreference, setPlatforms };
}
