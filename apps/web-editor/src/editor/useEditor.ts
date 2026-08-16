/**
 * React adapter over the pure {@link EditorState} store (plan Phase 3.2).
 *
 * A thin `useReducer` wrapper: all editing logic lives in `store.ts` (and is
 * unit-tested there); this only marshals actions and memoises the dispatchers.
 */
import { useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import {
  validatePatch,
  type EditHistory,
  type Patch,
  type ValidationIssue,
} from '@framepilot/editor-core';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { type PlayheadClock, createPlayheadClock } from './playhead-clock.js';
import { toggleMarkerPatch } from './patch-builders.js';
import {
  type EditorState,
  type EditorStateOptions,
  type SelectMode,
  applyUserPatch,
  clearSelection,
  createEditorState,
  gotoEdit,
  redoEdit,
  replaceAuthoritativeProject,
  registerAssets,
  seek,
  selectCanRedo,
  selectCanUndo,
  selectClip,
  selectMany,
  setPlaying,
  setZoom,
  undoEdit,
} from './store.js';

type EditorAction =
  | { readonly type: 'apply'; readonly patch: Patch }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'goto'; readonly index: number }
  | { readonly type: 'select'; readonly clipId: string | null; readonly mode?: SelectMode }
  | { readonly type: 'selectMany'; readonly ids: readonly string[] }
  | { readonly type: 'clearSelection' }
  | { readonly type: 'seek'; readonly time: number }
  | { readonly type: 'zoom'; readonly pxPerSecond: number }
  | { readonly type: 'playing'; readonly playing: boolean }
  | { readonly type: 'replaceAuthoritativeProject'; readonly project: Project }
  | { readonly type: 'registerAssets'; readonly ids: readonly string[] };

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'apply':
      return applyUserPatch(state, action.patch);
    case 'undo':
      return undoEdit(state);
    case 'redo':
      return redoEdit(state);
    case 'goto':
      return gotoEdit(state, action.index);
    case 'select':
      return selectClip(state, action.clipId, action.mode);
    case 'selectMany':
      return selectMany(state, action.ids);
    case 'clearSelection':
      return clearSelection(state);
    case 'seek':
      return seek(state, action.time);
    case 'zoom':
      return setZoom(state, action.pxPerSecond);
    case 'playing':
      return setPlaying(state, action.playing);
    case 'replaceAuthoritativeProject':
      return replaceAuthoritativeProject(state, action.project);
    case 'registerAssets':
      return registerAssets(state, action.ids);
  }
}

/** The editor API surfaced to React components. */
export interface UseEditor {
  readonly state: EditorState;
  readonly applyPatch: (patch: Patch) => void;
  /**
   * Validate `patch` against the CURRENT editor state and apply it only when
   * valid. Returns the error-severity issues (empty array = applied).
   *
   * `applyPatch` is fire-and-forget: a caller that needs to know whether the
   * edit actually landed (the AI sidebar's Accept, batch "Apply all") must use
   * this instead — an AI patch is assembled against the project as it was when
   * the run STARTED, and the timeline may have changed since. Reporting
   * "Applied" for a patch the store's validator rejected is a silent failure.
   */
  readonly applyPatchChecked: (patch: Patch) => readonly ValidationIssue[];
  readonly undo: () => void;
  readonly redo: () => void;
  /**
   * Jump to an arbitrary point in the edit history (time-travel). `index` is a
   * cursor position in `[0, history.entries.length]`: `0` is the pristine state,
   * `history.entries.length` is the latest edit. Powers the history panel's
   * click-to-jump; folds undo/redo under the hood.
   */
  readonly goto: (index: number) => void;
  /**
   * The full edit history (entries + cursor) so the history panel can render
   * every edit end to end. Reading it here is cheap — it is the same reference
   * the store already holds; nothing is recomputed.
   */
  readonly history: EditHistory;
  /**
   * Select a clip under a {@link SelectMode} (default `replace` = single-select),
   * or clear with `null`. Shift+click passes `add`, Cmd/Ctrl+click `toggle`.
   */
  readonly select: (clipId: string | null, mode?: SelectMode) => void;
  /** Replace the whole selection at once (marquee release). */
  readonly selectMany: (ids: readonly string[]) => void;
  /** Clear the selection entirely (Esc / empty-lane click). */
  readonly clearSelection: () => void;
  readonly seek: (time: number) => void;
  /**
   * Move the LIVE playhead only (the clock), without dispatching to the
   * reducer. The playback loop calls this ~60×/s: routing those frames through
   * the reducer re-rendered the whole editor subtree per frame (the source of
   * the playback jank). Components that display the live playhead subscribe via
   * {@link usePlayhead}; the reducer playhead is committed when playback stops
   * (`setPlaying(false)` commits the clock) or on any discrete {@link seek}.
   */
  readonly seekTransient: (time: number) => void;
  /**
   * Read the CURRENT playhead without subscribing a component to it.
   *
   * Stable identity (clock-backed), so a component's element can be memoised on
   * every state slice *except* `playhead` — skipping the per-frame re-render a
   * moving playhead would otherwise cause — while a click handler
   * ("insert at playhead", "At playhead") still resolves the live position
   * rather than a stale closure value. Perf slice 1 (plan Phase 12.1).
   */
  readonly getPlayhead: () => number;
  /**
   * Subscribe to live playhead changes (stable identity). Paired with
   * {@link getPlayhead} in {@link usePlayhead} so only the tiny nodes that
   * DISPLAY the playhead (marker/scrubber/ruler value) re-render on a seek.
   */
  readonly subscribePlayhead: (listener: () => void) => () => void;
  readonly setZoom: (pxPerSecond: number) => void;
  /**
   * Toggle a marker at `time` (persisted, undoable): adds one if none is
   * nearby, else removes the nearby one — via `add_marker`/`remove_marker`
   * patches through the same validate→apply→record pipeline as every other
   * edit (schema v9). See `patch-builders.ts#toggleMarkerPatch`.
   */
  readonly toggleMarker: (time: number) => void;
  /** Set the transport play/pause flag (Space / play button share this). */
  readonly setPlaying: (playing: boolean) => void;
  /** Register imported asset ids so `add_clip` patches referencing them validate. */
  readonly registerAssets: (ids: readonly string[]) => void;
  /** Reconcile a host-validated project without remounting the editor workspace. */
  readonly replaceAuthoritativeProject: (project: Project) => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/**
 * Wire a project's timeline + media bin into the patch-engine-backed editor store.
 *
 * @param timeline - The project's initial timeline.
 * @param options - Known asset ids (back-compat array) or full bin/view options
 *   (`assets`/`folders`/`assetIds`/view state). Full bin objects are required for
 *   folder editing; an id array still works for timeline-only callers.
 */
export function useEditor(
  timeline: Timeline,
  options?: readonly string[] | EditorStateOptions,
): UseEditor {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createEditorState(timeline, options ?? {}),
  );

  // Mirror the live playhead into a small external store so the nodes that
  // DISPLAY it can subscribe directly (via `usePlayhead`) and a seek re-renders
  // only them — not TimelineView/Toolbar/panels. `seek` is the sole runtime
  // playhead mutator (store.ts), so writing the clock there keeps it in lock-step
  // with the reducer; `getPlayhead` reads it with a stable identity for handlers.
  const clockRef = useRef<PlayheadClock | null>(null);
  if (clockRef.current === null) clockRef.current = createPlayheadClock(state.playhead);
  const clock = clockRef.current;

  // Latest state for the stable actions below (they are memoised once, so they
  // cannot close over `state` directly without going stale).
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo(
    () => ({
      applyPatch: (patch: Patch) => dispatch({ type: 'apply', patch }),
      applyPatchChecked: (patch: Patch): readonly ValidationIssue[] => {
        const current = stateRef.current;
        const result = validatePatch(current.timeline, patch, {
          assetIds: current.assetIds,
          folders: current.folders,
        });
        if (!result.valid) {
          return result.issues.filter((issue) => issue.severity === 'error');
        }
        dispatch({ type: 'apply', patch });
        return [];
      },
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
      goto: (index: number) => dispatch({ type: 'goto', index }),
      select: (clipId: string | null, mode?: SelectMode) =>
        dispatch(mode ? { type: 'select', clipId, mode } : { type: 'select', clipId }),
      selectMany: (ids: readonly string[]) => dispatch({ type: 'selectMany', ids }),
      clearSelection: () => dispatch({ type: 'clearSelection' }),
      seek: (time: number) => {
        clock.set(time < 0 ? 0 : time); // match the reducer's clamp
        dispatch({ type: 'seek', time });
      },
      seekTransient: (time: number) => {
        clock.set(time < 0 ? 0 : time); // clock only — no reducer dispatch per frame
      },
      getPlayhead: () => clock.get(),
      subscribePlayhead: (listener: () => void) => clock.subscribe(listener),
      setZoom: (pxPerSecond: number) => dispatch({ type: 'zoom', pxPerSecond }),
      toggleMarker: (time: number) => {
        const patch = toggleMarkerPatch(stateRef.current.markers, time);
        if (patch) dispatch({ type: 'apply', patch });
      },
      setPlaying: (playing: boolean) => {
        // Pausing commits the live (clock) playhead into the reducer so logic
        // that reads `state.playhead` (split, save, AI context) sees where
        // playback actually stopped — the loop only moved the clock.
        if (!playing && clock.get() !== stateRef.current.playhead) {
          dispatch({ type: 'seek', time: clock.get() });
        }
        dispatch({ type: 'playing', playing });
      },
      registerAssets: (ids: readonly string[]) => dispatch({ type: 'registerAssets', ids }),
      replaceAuthoritativeProject: (project: Project) =>
        dispatch({ type: 'replaceAuthoritativeProject', project }),
    }),
    [],
  );

  return {
    state,
    ...actions,
    history: state.history,
    canUndo: selectCanUndo(state),
    canRedo: selectCanRedo(state),
  };
}

/**
 * Subscribe a component to the LIVE playhead (seconds).
 *
 * Use this only in the small nodes that must display the moving playhead (the
 * timeline marker, the sr-only scrubber, the ruler value). They re-render on a
 * seek while their memoised ancestors (TimelineView/Toolbar) do not — the point
 * of perf slice 1b. Everything else should read `editor.state.playhead` (for a
 * value it already re-renders on) or `editor.getPlayhead()` (in a handler).
 */
export function usePlayhead(editor: UseEditor): number {
  return useSyncExternalStore(editor.subscribePlayhead, editor.getPlayhead, editor.getPlayhead);
}

/** Subscribe at project-frame cadence instead of display-refresh cadence.
 * Semantic UI (timecodes, range values, DOM captions) cannot show a value
 * between project frames; quantizing its snapshot prevents 120 Hz displays
 * from scheduling 4 React commits for each frame of a 30 fps project. */
export function useFramePlayhead(editor: UseEditor, fps: number): number {
  const getFrameSnapshot = useMemo(() => {
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
    return (): number => Math.floor((editor.getPlayhead() + Number.EPSILON) * safeFps) / safeFps;
  }, [editor.getPlayhead, fps]);
  return useSyncExternalStore(editor.subscribePlayhead, getFrameSnapshot, getFrameSnapshot);
}
