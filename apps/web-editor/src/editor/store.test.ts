import { describe, expect, it } from 'vitest';
import { toPersistedHistory, type Patch } from '@framepilot/editor-core';
import {
  applyUserPatch,
  createEditorState,
  DEFAULT_PX_PER_SECOND,
  gotoEdit,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  redoEdit,
  replaceAuthoritativeProject,
  seek,
  clearSelection,
  selectCanRedo,
  selectCanUndo,
  selectClip,
  selectHistory,
  selectMany,
  setPlaying,
  setZoom,
  undoEdit,
} from './store.js';
import { deleteClipPatch, deleteClipsPatch } from './patch-builders.js';
import { demoAssetIds, demoProject, demoTimeline } from './demo.js';

const trimIntro = (start: number, end: number): Patch => ({
  patchId: 'patch_trim' as Patch['patchId'],
  createdBy: 'user',
  reason: 'Trim the intro clip',
  operations: [{ type: 'trim_clip', clipId: 'clip_intro', start, end }],
});

/** Trim a clip that does not exist — the patch engine rejects it on replay. */
const trimMissing: Patch = {
  patchId: 'patch_bad' as Patch['patchId'],
  createdBy: 'user',
  reason: 'Trim a non-existent clip',
  operations: [{ type: 'trim_clip', clipId: 'does_not_exist', start: 0, end: 1 }],
};

const introEnd = (timeline: typeof demoTimeline): number | undefined =>
  timeline.tracks[0]?.clips[0]?.end;

describe('editor store', () => {
  it('initialises with empty history and no issues', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    expect(state.timeline).toBe(demoTimeline);
    expect(state.issues).toEqual([]);
    expect(selectCanUndo(state)).toBe(false);
    expect(selectCanRedo(state)).toBe(false);
  });

  it('validates, applies, and records a valid patch', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const next = applyUserPatch(state, trimIntro(0, 5));

    expect(introEnd(next.timeline)).toBe(5);
    expect(next.issues).toEqual([]);
    expect(selectCanUndo(next)).toBe(true);
    // Original state is untouched (immutability).
    expect(introEnd(state.timeline)).toBe(6);
  });

  it('rejects an invalid patch without mutating the timeline', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const next = applyUserPatch(state, trimMissing);

    expect(next.timeline).toBe(state.timeline); // unchanged
    expect(next.issues.length).toBeGreaterThan(0);
    expect(next.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(selectCanUndo(next)).toBe(false);
  });

  it('undoes a committed edit back to the previous state', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const edited = applyUserPatch(state, trimIntro(0, 4));
    const undone = undoEdit(edited);

    expect(introEnd(undone.timeline)).toBe(6);
    expect(selectCanUndo(undone)).toBe(false);
    expect(selectCanRedo(undone)).toBe(true);
  });

  it('redoes a previously undone edit', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const edited = applyUserPatch(state, trimIntro(0, 3));
    const redone = redoEdit(undoEdit(edited));

    expect(introEnd(redone.timeline)).toBe(3);
    expect(selectCanRedo(redone)).toBe(false);
  });

  it('clears issues on undo', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const rejected = applyUserPatch(state, trimMissing);
    expect(rejected.issues.length).toBeGreaterThan(0);

    const afterUndo = undoEdit(rejected); // nothing to undo, but issues clear
    expect(afterUndo.issues).toEqual([]);
  });

  it('treats undo/redo as no-ops at the ends of history', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    expect(undoEdit(state).timeline).toBe(state.timeline);
    expect(redoEdit(state).timeline).toBe(state.timeline);
  });

  it('truncates the redo tail when a new edit is committed after an undo', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const first = applyUserPatch(state, trimIntro(0, 5));
    const undone = undoEdit(first);
    const second = applyUserPatch(undone, trimIntro(0, 2));

    expect(introEnd(second.timeline)).toBe(2);
    expect(selectCanRedo(second)).toBe(false); // old redo entry was discarded
  });

  it('stamps committedAt on the recorded history entry', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const edited = applyUserPatch(state, trimIntro(0, 5), 1_700_000_000_000);
    const entries = selectHistory(edited).entries;
    expect(entries.at(-1)?.committedAt).toBe(1_700_000_000_000);
  });

  it('gotoEdit time-travels to an arbitrary point and reconciles selection', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const c1 = applyUserPatch(state, trimIntro(0, 5), 1);
    const c2 = applyUserPatch(c1, trimIntro(0, 8), 2);
    const c3 = applyUserPatch(c2, trimIntro(0, 3), 3);

    // Jump back to the pristine state.
    const start = gotoEdit(c3, 0);
    expect(introEnd(start.timeline)).toBe(introEnd(demoTimeline));
    expect(selectHistory(start).cursor).toBe(0);
    expect(selectCanRedo(start)).toBe(true);

    // Jump to the intermediate edit.
    const mid = gotoEdit(start, 1);
    expect(introEnd(mid.timeline)).toBe(5);
    expect(selectHistory(mid).cursor).toBe(1);

    // Jump forward to the latest.
    const latest = gotoEdit(mid, 3);
    expect(introEnd(latest.timeline)).toBe(3);
  });

  it('gotoEdit is a no-op when already at the target cursor', () => {
    const state = createEditorState(demoTimeline, demoAssetIds);
    const edited = applyUserPatch(state, trimIntro(0, 5));
    const same = gotoEdit(edited, selectHistory(edited).cursor);
    expect(same.timeline).toBe(edited.timeline);
  });

  it('restores a persisted history so undo still works after a reload', () => {
    // Session 1: two edits, then persist the applied stack.
    const s0 = createEditorState(demoTimeline, demoAssetIds);
    const s1 = applyUserPatch(s0, trimIntro(0, 5), 1);
    const s2 = applyUserPatch(s1, trimIntro(0, 3), 2);
    const persisted = toPersistedHistory(selectHistory(s2));
    expect(persisted).toHaveLength(2);

    // Session 2 (reload): seed the store from the persisted history + final timeline.
    const reloaded = createEditorState(s2.timeline, {
      assetIds: demoAssetIds,
      history: persisted,
    });
    expect(selectHistory(reloaded).cursor).toBe(2);
    expect(selectCanUndo(reloaded)).toBe(true);
    expect(reloaded.history.entries[1]?.committedAt).toBe(2);

    // Undo after reload reverts the last edit (8→... end back to 5).
    const undone = undoEdit(reloaded);
    expect(introEnd(undone.timeline)).toBe(5);
  });
});

describe('editor view state', () => {
  it('defaults selection/playhead/zoom/markers and accepts the options form', () => {
    const positional = createEditorState(demoTimeline, demoAssetIds);
    expect(positional.assetIds).toEqual(demoAssetIds);
    expect(positional.selection).toBeNull();
    expect(positional.playhead).toBe(0);
    expect(positional.pxPerSecond).toBe(DEFAULT_PX_PER_SECOND);
    expect(positional.markers).toEqual([]);

    const seedMarkers = [
      { id: 'm1', time: 5 },
      { id: 'm2', time: 2 },
    ];
    const opts = createEditorState(demoTimeline, {
      assetIds: demoAssetIds,
      playhead: 3,
      pxPerSecond: 1000, // clamped
      markers: seedMarkers, // loaded verbatim from `project.markers`, not re-derived
    });
    expect(opts.playhead).toBe(3);
    expect(opts.pxPerSecond).toBe(MAX_PX_PER_SECOND);
    expect(opts.markers).toEqual(seedMarkers);
  });

  it('selects and clears a clip', () => {
    const state = createEditorState(demoTimeline);
    expect(selectClip(state, 'clip_intro').selection).toBe('clip_intro');
    expect(selectClip(state, null).selection).toBeNull();
  });

  it('seeks the playhead and clamps negatives to zero', () => {
    const state = createEditorState(demoTimeline);
    expect(seek(state, 4.5).playhead).toBe(4.5);
    expect(seek(state, -2).playhead).toBe(0);
  });

  it('toggles the transport play flag and no-ops when unchanged', () => {
    const state = createEditorState(demoTimeline);
    expect(state.playing).toBe(false);
    const playing = setPlaying(state, true);
    expect(playing.playing).toBe(true);
    expect(setPlaying(playing, true)).toBe(playing); // same reference, no churn
    expect(setPlaying(playing, false).playing).toBe(false);
  });

  it('clamps zoom to the supported range', () => {
    const state = createEditorState(demoTimeline);
    expect(setZoom(state, 80).pxPerSecond).toBe(80);
    expect(setZoom(state, 1).pxPerSecond).toBe(MIN_PX_PER_SECOND);
    expect(setZoom(state, 9999).pxPerSecond).toBe(MAX_PX_PER_SECOND);
  });

  // Marker add/remove/toggle is now persisted via `add_marker`/`remove_marker`
  // patches (schema v9) — see `patch-builders.test.ts#markers` for the
  // toggle/round-trip/undo coverage that used to live here as local-only state.

  it('drops the selection when the selected clip is deleted by a patch', () => {
    const selected = selectClip(createEditorState(demoTimeline, demoAssetIds), 'clip_intro');
    const patch = deleteClipPatch(selected.timeline, 'clip_intro');
    expect(patch).not.toBeNull();

    const next = applyUserPatch(selected, patch!);
    expect(next.selection).toBeNull();
  });

  it('keeps the selection when a patch leaves the selected clip intact', () => {
    const selected = selectClip(createEditorState(demoTimeline, demoAssetIds), 'clip_body');
    const next = applyUserPatch(selected, trimIntro(0, 4)); // trims a different clip
    expect(next.selection).toBe('clip_body');
  });

  it('reconciles an authoritative project without resetting session view state', () => {
    const initial = setPlaying(
      setZoom(selectClip(createEditorState(demoTimeline, demoAssetIds), 'clip_intro'), 96),
      true,
    );
    const authoritative = {
      ...demoProject,
      timeline: { tracks: [] },
      history: [],
    };
    const next = replaceAuthoritativeProject(initial, authoritative);
    expect(next.timeline).toBe(authoritative.timeline);
    expect(next.selection).toBeNull();
    expect(next.playing).toBe(true);
    expect(next.pxPerSecond).toBe(96);
  });
});

describe('multi-selection (M2a)', () => {
  const base = (): ReturnType<typeof createEditorState> =>
    createEditorState(demoTimeline, demoAssetIds);

  it('replace mode (default) makes the clip the sole selection', () => {
    const s = selectClip(selectClip(base(), 'clip_intro'), 'clip_body');
    expect(s.selection).toBe('clip_body');
    expect(s.selectedIds).toEqual(['clip_body']);
  });

  it('add mode (Shift) extends the selection and promotes primary', () => {
    const s = selectClip(selectClip(base(), 'clip_intro'), 'clip_body', 'add');
    expect(s.selectedIds).toEqual(['clip_intro', 'clip_body']);
    expect(s.selection).toBe('clip_body');
    // Adding an already-selected clip just promotes it to primary (no dup).
    const again = selectClip(s, 'clip_intro', 'add');
    expect(again.selectedIds).toEqual(['clip_intro', 'clip_body']);
    expect(again.selection).toBe('clip_intro');
  });

  it('toggle mode (Cmd/Ctrl) adds then removes a clip, fixing up the primary', () => {
    const added = selectClip(selectClip(base(), 'clip_intro'), 'clip_body', 'toggle');
    expect(added.selectedIds).toEqual(['clip_intro', 'clip_body']);
    const removed = selectClip(added, 'clip_body', 'toggle');
    expect(removed.selectedIds).toEqual(['clip_intro']);
    expect(removed.selection).toBe('clip_intro'); // primary fell back to last remaining
  });

  it('selectMany replaces the whole set (last id = primary, deduped)', () => {
    const s = selectMany(base(), ['clip_intro', 'clip_body', 'clip_intro']);
    expect(s.selectedIds).toEqual(['clip_intro', 'clip_body']);
    expect(s.selection).toBe('clip_body');
    expect(selectMany(s, []).selection).toBeNull();
  });

  it('clearSelection empties the set and is a no-op (same ref) when already empty', () => {
    const s = selectClip(base(), 'clip_intro', 'add');
    const cleared = clearSelection(s);
    expect(cleared.selection).toBeNull();
    expect(cleared.selectedIds).toEqual([]);
    expect(clearSelection(cleared)).toBe(cleared);
  });

  it('select(null) clears regardless of mode', () => {
    const s = selectClip(base(), 'clip_intro', 'add');
    expect(selectClip(s, null, 'add').selectedIds).toEqual([]);
  });

  it('a batch delete prunes every removed clip from the selection in one step', () => {
    const selected = selectMany(base(), ['clip_intro', 'clip_body']);
    const patch = deleteClipsPatch(selected.timeline, ['clip_intro', 'clip_body'], false)!;
    const next = applyUserPatch(selected, patch);
    expect(next.selectedIds).toEqual([]);
    expect(next.selection).toBeNull();
  });
});
