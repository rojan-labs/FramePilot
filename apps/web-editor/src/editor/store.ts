/**
 * Editor state model (plan/PLAN.md Phase 3.2 — "Undo/redo wired to patch engine").
 *
 * A pure, framework-agnostic store that holds the working timeline and its
 * undo/redo history and routes **every** manual edit through the same
 * patch-engine pipeline the AI layer will use: `validate → apply → record`.
 * This enforces AGENTS.md invariant 3 ("every operation is validated before it
 * is applied") for user edits, not just agent edits — there is no second,
 * unchecked path that mutates the timeline.
 *
 * Keeping this free of React makes the core editor logic unit-testable; the
 * `useEditor` hook is a thin `useReducer` adapter over these functions.
 */
import type {
  Asset,
  Folder,
  Marker,
  Project,
  Timeline,
  TranscriptWord,
} from '@framepilot/timeline-schema';
import {
  type EditHistory,
  type HistoryEntry,
  type Patch,
  type ValidationIssue,
  canRedo,
  canUndo,
  commitProjectPatch,
  emptyHistory,
  fromPersistedHistory,
  gotoProject,
  PatchError,
  redoProject,
  undoProject,
  validatePatch,
} from '@framepilot/editor-core';
import { findClip } from './selectors.js';

/** Default timeline zoom, in pixels per second. */
export const DEFAULT_PX_PER_SECOND = 40;
/** Zoom bounds keep clips visible without letting a drag explode the layout. */
export const MIN_PX_PER_SECOND = 4;
export const MAX_PX_PER_SECOND = 240;

/** Immutable snapshot of the editor's working state. */
export interface EditorState {
  readonly timeline: Timeline;
  readonly history: EditHistory;
  /**
   * Media-bin assets (schema v3). The source of truth for the bin; folder/asset
   * edits run through the same validate→apply→record pipeline as timeline edits,
   * so they are undoable too.
   */
  readonly assets: readonly Asset[];
  /** Media-bin folder tree (schema v3). */
  readonly folders: readonly Folder[];
  /**
   * Permissive allow-list of asset ids used to validate `add_clip` references.
   * Superset of `assets` ids plus any ids registered without a full asset object
   * (kept for back-compat with timeline-only callers/tests).
   */
  readonly assetIds: readonly string[];
  /**
   * Issues from the most recently *rejected* edit. Empty after an accepted
   * edit or an undo/redo — the UI surfaces this to explain why a patch failed.
   */
  readonly issues: readonly ValidationIssue[];
  /**
   * Primary selected clip id (the last one touched), or `null` when nothing is
   * selected. Back-compat handle for single-select consumers; it is always a
   * member of {@link selectedIds} (or `null` when the set is empty).
   */
  readonly selection: string | null;
  /**
   * The full multi-selection (M2a). The primary {@link selection} is one of these
   * (the most-recently added). Order is insertion order; `[]` means nothing is
   * selected. Single-select is just the one-element case.
   */
  readonly selectedIds: readonly string[];
  /** Playhead position, in seconds (never negative). */
  readonly playhead: number;
  /** Timeline zoom, in pixels per second. */
  readonly pxPerSecond: number;
  /**
   * Project-level markers/chapters (schema v9). Real, persisted `Project.markers`
   * state — edited only through `add_marker`/`remove_marker` patches (see
   * `patch-builders.ts#toggleMarkerPatch`) so add/remove is undoable via the same
   * validate→apply→record pipeline as every other edit.
   */
  readonly markers: readonly Marker[];
  /** Word-level transcript, edited through the reversible `set_transcript` op. */
  readonly transcript: readonly TranscriptWord[];
  /** Whether the program monitor transport is playing (drives the preview clock). */
  readonly playing: boolean;
}

/** Optional initial view state when opening a project. */
export interface EditorStateOptions {
  readonly assetIds?: readonly string[];
  /** Full bin assets (preferred over `assetIds`; folder edits need real objects). */
  readonly assets?: readonly Asset[];
  /** Bin folder tree. */
  readonly folders?: readonly Folder[];
  readonly playhead?: number;
  readonly pxPerSecond?: number;
  /** Project-level markers/chapters (schema v9), e.g. `project.markers` on open. */
  readonly markers?: readonly Marker[];
  /** Initial word-level transcript from the open project. */
  readonly transcript?: readonly TranscriptWord[];
  /**
   * Persisted edit history (`project.history`) to restore on open, so the undo
   * stack and the history panel survive a reload. Entries are treated as fully
   * applied (cursor = length), matching {@link fromPersistedHistory}. Omit for a
   * fresh, empty history.
   */
  readonly history?: readonly HistoryEntry[];
}

/**
 * Placeholder project metadata for the project-scoped patch engine. The engine's
 * apply/invert/validate only read `timeline`/`assets`/`folders`/`markers`, so
 * these fields are never observed — they exist only to satisfy the
 * {@link Project} type while the store keeps just the editable slices.
 */
const PLACEHOLDER_META: Omit<
  Project,
  'timeline' | 'assets' | 'folders' | 'markers' | 'transcript'
> = {
  id: '_editor',
  name: '_editor',
  version: 1,
  fps: 30,
  resolution: { width: 1, height: 1 },
  angleGroups: [],
  aiMemory: {},
  history: [],
};

/** Build a {@link Project} view of the editable state for the patch engine. */
const toProject = (state: EditorState): Project => ({
  ...PLACEHOLDER_META,
  timeline: state.timeline,
  assets: [...state.assets],
  folders: [...state.folders],
  markers: [...state.markers],
  transcript: [...state.transcript],
});

/** Recompute the add_clip allow-list: bin asset ids ∪ loose registered ids. */
const mergeAssetIds = (
  assets: readonly Asset[],
  looseIds: readonly string[],
): readonly string[] => [...new Set([...assets.map((a) => a.id), ...looseIds])];

/** Ids in `assetIds` not backed by a full asset object (e.g. test/registered ids). */
const looseIdsOf = (state: EditorState): readonly string[] =>
  state.assetIds.filter((id) => !state.assets.some((a) => a.id === id));

const clampZoom = (px: number): number =>
  Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, px));

/** Create the initial editor state for a freshly-opened project. */
export function createEditorState(
  timeline: Timeline,
  options: readonly string[] | EditorStateOptions = {},
): EditorState {
  // Back-compat: an array argument is the old `assetIds` positional form.
  const opts: EditorStateOptions = Array.isArray(options)
    ? { assetIds: options as readonly string[] }
    : (options as EditorStateOptions);
  const assets = opts.assets ?? [];
  return {
    timeline,
    history: opts.history ? fromPersistedHistory(opts.history) : emptyHistory(),
    assets,
    folders: opts.folders ?? [],
    assetIds: mergeAssetIds(assets, opts.assetIds ?? []),
    issues: [],
    selection: null,
    selectedIds: [],
    playhead: opts.playhead ?? 0,
    pxPerSecond: clampZoom(opts.pxPerSecond ?? DEFAULT_PX_PER_SECOND),
    markers: opts.markers ?? [],
    transcript: opts.transcript ?? [],
    playing: false,
  };
}

/**
 * Replace the editable project slices from an authoritative host snapshot without
 * remounting the editor. Session-only view state (playhead, zoom, transport) stays
 * intact; persisted history and media/timeline data come from the host. This is the
 * desktop agent/MCP reconciliation path, so no unvalidated mutation occurs here —
 * the host has already validated and committed the project before publishing it.
 */
export function replaceAuthoritativeProject(state: EditorState, project: Project): EditorState {
  const selectedIds = state.selectedIds.filter((id) => findClip(project.timeline, id) !== null);
  const selection =
    state.selection && selectedIds.includes(state.selection)
      ? state.selection
      : (selectedIds[selectedIds.length - 1] ?? null);

  return {
    ...state,
    timeline: project.timeline,
    history: fromPersistedHistory(project.history as readonly HistoryEntry[]),
    assets: project.assets,
    folders: project.folders,
    assetIds: mergeAssetIds(project.assets, []),
    markers: project.markers,
    transcript: project.transcript,
    issues: [],
    selection,
    selectedIds,
  };
}

/**
 * Validate and apply a user (or agent) patch.
 *
 * The patch is validated against the current timeline first; if it has any
 * `error`-severity issues it is **rejected** and the timeline is left untouched
 * (the issues are returned for display). Only a valid patch is committed to the
 * undo/redo history.
 *
 * @returns The next state. On rejection, `timeline`/`history` are unchanged and
 *   `issues` describes why.
 * @param now - Commit timestamp (epoch ms) recorded on the history entry so the
 *   history panel can show "2m ago". Defaults to the wall clock; tests pass a
 *   fixed value for determinism.
 */
export function applyUserPatch(
  state: EditorState,
  patch: Patch,
  now: number = Date.now(),
): EditorState {
  const result = validatePatch(state.timeline, patch, {
    assetIds: state.assetIds,
    folders: state.folders,
    markers: state.markers,
  });
  if (!result.valid) {
    return { ...state, issues: result.issues };
  }

  try {
    const loose = looseIdsOf(state);
    const step = commitProjectPatch(toProject(state), state.history, patch, now);
    const { timeline, assets, folders, markers, transcript } = step.project;
    // Drop any selected clips the edit removed (e.g. a batch delete/ripple), so
    // the selection never dangles past the clips it points at.
    const selectedIds = state.selectedIds.filter((id) => findClip(timeline, id) !== null);
    const selection =
      state.selection && selectedIds.includes(state.selection)
        ? state.selection
        : (selectedIds[selectedIds.length - 1] ?? null);
    return {
      ...state,
      timeline,
      assets,
      folders,
      markers,
      transcript,
      assetIds: mergeAssetIds(assets, loose),
      history: step.history,
      issues: [],
      selection,
      selectedIds,
    };
    /* v8 ignore start -- defense-in-depth: validatePatch already replays
       applyOperation, so a patch that passes validation cannot throw here today.
       The guard exists only to keep a future validator/applier divergence from
       leaking a half-applied state; apply is transactional, so `state` is
       intact. Unreachable via valid patches, hence excluded from coverage. */
  } catch (error) {
    const message = error instanceof PatchError ? error.message : String(error);
    return {
      ...state,
      issues: [{ code: 'unsupported_operation', severity: 'error', message }],
    };
  }
  /* v8 ignore stop */
}

/** Undo the most recent edit. No-op when there is nothing to undo. */
export function undoEdit(state: EditorState): EditorState {
  const loose = looseIdsOf(state);
  const step = undoProject(toProject(state), state.history);
  const { timeline, assets, folders, markers, transcript } = step.project;
  return {
    ...state,
    timeline,
    assets,
    folders,
    markers,
    transcript,
    assetIds: mergeAssetIds(assets, loose),
    history: step.history,
    issues: [],
  };
}

/** Redo the next undone edit. No-op when there is nothing to redo. */
export function redoEdit(state: EditorState): EditorState {
  const loose = looseIdsOf(state);
  const step = redoProject(toProject(state), state.history);
  const { timeline, assets, folders, markers, transcript } = step.project;
  return {
    ...state,
    timeline,
    assets,
    folders,
    markers,
    transcript,
    assetIds: mergeAssetIds(assets, loose),
    history: step.history,
    issues: [],
  };
}

/**
 * Jump to an arbitrary point in history (the history panel's time-travel). Folds
 * undo/redo to move the cursor to `targetCursor`; a no-op when already there.
 * Selection is reconciled to the resulting timeline so it never dangles past a
 * clip a jump removed.
 */
export function gotoEdit(state: EditorState, targetCursor: number): EditorState {
  const loose = looseIdsOf(state);
  const step = gotoProject(toProject(state), state.history, targetCursor);
  const { timeline, assets, folders, markers, transcript } = step.project;
  const selectedIds = state.selectedIds.filter((id) => findClip(timeline, id) !== null);
  const selection =
    state.selection && selectedIds.includes(state.selection)
      ? state.selection
      : (selectedIds[selectedIds.length - 1] ?? null);
  return {
    ...state,
    timeline,
    assets,
    folders,
    markers,
    transcript,
    assetIds: mergeAssetIds(assets, loose),
    history: step.history,
    issues: [],
    selection,
    selectedIds,
  };
}

/**
 * How a {@link selectClip} call combines with the current selection (M2a):
 * - `replace` (default) — single-select: the clip becomes the only selection.
 * - `toggle` — Cmd/Ctrl+click: add the clip if absent, else remove it.
 * - `add` — Shift+click: add the clip to the selection (no-op if already in).
 */
export type SelectMode = 'replace' | 'toggle' | 'add';

/**
 * Select a clip under the given {@link SelectMode}, or clear the selection by
 * passing `null` (always a full clear regardless of mode). The primary
 * {@link EditorState.selection} tracks the most-recently touched clip and stays
 * a member of {@link EditorState.selectedIds}.
 */
export function selectClip(
  state: EditorState,
  clipId: string | null,
  mode: SelectMode = 'replace',
): EditorState {
  if (clipId === null) {
    return clearSelection(state);
  }
  if (mode === 'replace') {
    return { ...state, selection: clipId, selectedIds: [clipId] };
  }
  const present = state.selectedIds.includes(clipId);
  if (mode === 'toggle' && present) {
    // Remove it; the primary falls back to the new last id (or null when empty).
    const selectedIds = state.selectedIds.filter((id) => id !== clipId);
    const selection =
      state.selection === clipId ? (selectedIds[selectedIds.length - 1] ?? null) : state.selection;
    return { ...state, selection, selectedIds };
  }
  if (present) {
    // `add` on an already-selected clip just promotes it to primary.
    return { ...state, selection: clipId };
  }
  return { ...state, selection: clipId, selectedIds: [...state.selectedIds, clipId] };
}

/** Replace the whole selection with `ids` (used by marquee release). The last
 *  id becomes the primary; an empty array clears the selection. */
export function selectMany(state: EditorState, ids: readonly string[]): EditorState {
  const deduped = [...new Set(ids)];
  return { ...state, selection: deduped[deduped.length - 1] ?? null, selectedIds: deduped };
}

/** Clear the selection entirely (Esc / empty-lane click). */
export function clearSelection(state: EditorState): EditorState {
  if (state.selection === null && state.selectedIds.length === 0) {
    return state;
  }
  return { ...state, selection: null, selectedIds: [] };
}

/**
 * Register newly imported asset ids so subsequent `add_clip` patches that
 * reference them pass validation. Idempotent — already-known ids are ignored.
 */
export function registerAssets(state: EditorState, ids: readonly string[]): EditorState {
  const merged = new Set([...state.assetIds, ...ids]);
  if (merged.size === state.assetIds.length) {
    return state;
  }
  return { ...state, assetIds: [...merged] };
}

/** Move the playhead to `time` seconds (clamped to ≥ 0). */
export function seek(state: EditorState, time: number): EditorState {
  return { ...state, playhead: time < 0 ? 0 : time };
}

/** Set the transport play/pause flag. No-op (same reference) when unchanged. */
export function setPlaying(state: EditorState, playing: boolean): EditorState {
  if (state.playing === playing) {
    return state;
  }
  return { ...state, playing };
}

/** Set the timeline zoom (pixels per second), clamped to the supported range. */
export function setZoom(state: EditorState, pxPerSecond: number): EditorState {
  return { ...state, pxPerSecond: clampZoom(pxPerSecond) };
}

/** Whether an undo is currently available (for enabling toolbar controls). */
export const selectCanUndo = (state: EditorState): boolean => canUndo(state.history);

/** Whether a redo is currently available. */
export const selectCanRedo = (state: EditorState): boolean => canRedo(state.history);

/** The full edit history (entries + cursor) for the history panel to render. */
export const selectHistory = (state: EditorState): EditHistory => state.history;
