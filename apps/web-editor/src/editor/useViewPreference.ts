/**
 * One small hook for the editor's "minor things" — the layout knobs a person sets once
 * and expects to stay set.
 *
 * ## Why this exists
 *
 * The workspace already persists its big levers: rail widths and the timeline dock height
 * (`@framepilot/ui`'s `useRailLayout` / `useDockHeight`), footage thumbnail size
 * (`useMediaBinView`), track lane heights (`useTrackLayout`), edit mode (`useEditMode`).
 * Each was written as its own module because each carries its own shape.
 *
 * The smaller knobs got nothing, because a whole module per boolean is absurd — so
 * `useState` was the default and every one of them reset on reload. Which panel each rail
 * was showing, which Inspector tab, which History filter: an e2e reload proved the rails
 * came back on Assets and AI no matter where you left them. That is the difference between
 * a tool and a demo, and it is entirely a plumbing gap rather than a design decision.
 *
 * ## Why it is this small
 *
 * A drop-in `useState` replacement, and deliberately nothing more:
 *
 * - **No context and no provider.** A shared store would re-render every consumer when any
 *   one preference changed; each of these belongs to exactly one component.
 * - **No module-level cache.** A `Map` of every preference ever read is a leak that grows
 *   with the session for no benefit — `localStorage` is already the cache, and reading a
 *   short string once per mount is not a cost worth holding memory to avoid.
 * - **No subscription, no polling, no `storage` listener.** Nothing else writes these keys.
 *
 * So the steady-state cost is one string in `localStorage` and one `useState` cell that
 * would have existed anyway. Writes happen on change — a click, not a keystroke — so there
 * is nothing to debounce.
 *
 * ## What belongs here
 *
 * View state only, never project state (AGENTS.md invariant 5). These describe how a person
 * likes to look at their work; nothing here can change a frame of the output.
 */
import { useCallback, useState } from 'react';

/** Namespace for every key this hook owns, so the editor's storage stays legible. */
const PREFIX = 'framepilot.view.';

/**
 * Build a validator for a fixed set of values — the shape almost every one of these takes.
 *
 * Validation is not ceremony here: `localStorage` is user-writable and survives across app
 * versions, so a value that was legal in a previous build (a renamed tab id, say) must fall
 * back rather than put the UI in a state it can no longer render.
 */
export function oneOf<T extends string>(values: readonly T[]): (raw: unknown) => T | undefined {
  const allowed: ReadonlySet<string> = new Set(values);
  return (raw) => (typeof raw === 'string' && allowed.has(raw) ? (raw as T) : undefined);
}

/** Read one preference, tolerating absence, corruption, and a disabled store. */
function load<T>(key: string, coerce: (raw: unknown) => T | undefined): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
    return coerce(JSON.parse(raw) as unknown);
  } catch {
    // Absent, corrupt, or storage denied (private mode). The caller's fallback stands.
    return undefined;
  }
}

/** Write one preference; a storage failure degrades to in-session-only, never throws. */
function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the preference still works for this session */
  }
}

/**
 * `useState` for a view preference, persisted under `framepilot.view.<key>`.
 *
 * @param key - Stable name for this preference. Changing it resets everyone's setting, so
 *   treat it as the migration boundary it is.
 * @param fallback - The value to use when nothing valid is stored. This must reproduce the
 *   current shipped default exactly: an un-configured editor must look like it always did.
 * @param coerce - Narrows untrusted parsed JSON, returning `undefined` to reject it. Use
 *   {@link oneOf} for a fixed set.
 * @returns The current value and a setter, which accepts an updater like `useState`.
 */
export function useViewPreference<T>(
  key: string,
  fallback: T,
  coerce: (raw: unknown) => T | undefined,
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => load(key, coerce) ?? fallback);

  const set = useCallback(
    (next: T | ((current: T) => T)): void => {
      setValue((current) => {
        const resolved =
          typeof next === 'function' ? (next as (c: T) => T)(current) : next;
        // Write inside the updater so the stored value always matches what rendered,
        // including when several updates are batched into one commit.
        if (!Object.is(resolved, current)) save(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}
