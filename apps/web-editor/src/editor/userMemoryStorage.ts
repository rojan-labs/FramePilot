/**
 * Cross-project memory persistence (K5.1b) — the **user** scope.
 *
 * Unlike the AI config (which holds API keys and therefore lives in the desktop main
 * process), user memory holds no secrets: editorial defaults ("I caption karaoke-style",
 * "I export to Reels"). So it persists in the renderer's `localStorage`, which Electron
 * keeps per-origin — meaning **one store works for both the browser build and the desktop
 * renderer with no new IPC surface**.
 *
 * The parse/serialise logic is the pure ai-sdk store (`readUserMemory`/`writeUserMemory`);
 * this module only owns the browser I/O and tolerates absent/corrupt storage (private
 * mode, hand-edited blob) by falling back to the empty scope rather than throwing.
 */
import {
  EMPTY_USER_MEMORY,
  type UserMemory,
  readUserMemory,
  writeUserMemory,
} from '@framepilot/ai-sdk';

const USER_MEMORY_KEY = 'framepilot.userMemory';

/** Read the user memory scope, tolerating absent/corrupt storage. */
export function loadUserMemory(): UserMemory {
  try {
    const raw = localStorage.getItem(USER_MEMORY_KEY);
    return raw ? readUserMemory(JSON.parse(raw)) : { ...EMPTY_USER_MEMORY };
  } catch {
    return { ...EMPTY_USER_MEMORY };
  }
}

/** Persist the user memory scope (no-op if storage is unavailable). */
export function persistUserMemory(memory: UserMemory): void {
  try {
    localStorage.setItem(USER_MEMORY_KEY, JSON.stringify(writeUserMemory(memory)));
  } catch {
    /* storage unavailable (private mode) — stays in-session only */
  }
}
