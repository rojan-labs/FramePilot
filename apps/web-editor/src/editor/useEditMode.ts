/**
 * Timeline edit-mode + ripple-on-delete view state (plan/TIMELINE-REVAMP.md §4
 * "Edit modes", §7 M2b-1). Like the side-rail layout and the Settings prefs,
 * these are **view/session state**, not project state (invariant 5): they
 * describe how this person likes placement/deletion to behave, never anything
 * about the edit itself. They live in `localStorage` and are **not** part of the
 * undo history or the saved project file.
 *
 * - `editMode` — how a placed/dropped clip lands on a lane:
 *   - `overwrite` (default) — today's behaviour: the clip lands where it is
 *     dropped (the existing auto-layering-on-overlap path, ADR 0031/0032).
 *   - `insert` — placing a clip pushes the downstream same-lane clips right by
 *     the inserted clip's duration (no overlap, no new layer), as ONE patch.
 * - `rippleOnDelete` — when ON, Delete ripples by default (closes the gap) and
 *   Shift *inverts* to a lift; when OFF (default), Delete lifts and Shift ripples.
 *
 * The pure load/normalise helpers are unit-tested; the hook is the thin React +
 * storage shell around them (mirrors {@link useRailLayout}).
 */
import { useCallback, useState } from 'react';

/** How a placed/dropped clip lands on a lane. */
export type EditMode = 'overwrite' | 'insert';

/** Persisted edit-mode preferences. */
export interface EditModeState {
  /** Placement mode for adds/drops (defaults to `overwrite`). */
  readonly editMode: EditMode;
  /** When true, Delete ripples by default and Shift inverts (defaults to false). */
  readonly rippleOnDelete: boolean;
}

/** Factory defaults: classic Overwrite placement, ripple-on-delete off. */
export const DEFAULT_EDIT_MODE: EditModeState = {
  editMode: 'overwrite',
  rippleOnDelete: false,
};

const STORAGE_KEY = 'framepilot.editMode';

/** Coerce arbitrary parsed JSON to a valid {@link EditModeState}. */
function normalize(parsed: Partial<EditModeState> | null | undefined): EditModeState {
  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_EDIT_MODE;
  }
  return {
    editMode: parsed.editMode === 'insert' ? 'insert' : 'overwrite',
    rippleOnDelete: parsed.rippleOnDelete === true,
  };
}

/** Read persisted edit-mode state, falling back to defaults (tolerating bad data). */
export function loadEditMode(): EditModeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EDIT_MODE;
    return normalize(JSON.parse(raw) as Partial<EditModeState>);
  } catch {
    return DEFAULT_EDIT_MODE;
  }
}

function saveEditMode(state: EditModeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable (private mode); mode still works in-session. */
  }
}

/** The edit-mode API exposed to the editor chrome. */
export interface UseEditMode extends EditModeState {
  /** Set the placement mode (Insert / Overwrite). */
  readonly setEditMode: (mode: EditMode) => void;
  /** Toggle ripple-on-delete on/off. */
  readonly toggleRippleOnDelete: () => void;
}

/** Manage edit-mode + ripple-on-delete, persisted to `localStorage`. */
export function useEditMode(): UseEditMode {
  const [state, setState] = useState<EditModeState>(() => loadEditMode());

  const update = useCallback((next: EditModeState): void => {
    saveEditMode(next);
    setState(next);
  }, []);

  const setEditMode = useCallback(
    (editMode: EditMode): void => update({ ...loadEditMode(), editMode }),
    [update],
  );

  const toggleRippleOnDelete = useCallback((): void => {
    const current = loadEditMode();
    update({ ...current, rippleOnDelete: !current.rippleOnDelete });
  }, [update]);

  return { ...state, setEditMode, toggleRippleOnDelete };
}
