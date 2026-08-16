/**
 * Tests for the useEditor React adapter's new surfaces:
 * - `seekTransient` (playback perf): moves the live playhead CLOCK only, never
 *   dispatching to the reducer, so a 60fps playback loop cannot re-render the
 *   whole editor tree.
 * - pause commit: `setPlaying(false)` folds the clock position back into the
 *   reducer so `state.playhead` is correct wherever playback stopped.
 * - `applyPatchChecked` (AI apply honesty): validates against the CURRENT state
 *   and reports the issues instead of silently dropping a stale patch.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Patch } from '@framepilot/editor-core';
import { demoAssetIds, demoTimeline } from './demo.js';
import { useEditor, useFramePlayhead, usePlayhead } from './useEditor.js';

const trimIntro: Patch = {
  patchId: 'patch_trim' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'Trim the intro clip',
  operations: [{ type: 'trim_clip', clipId: 'clip_intro', start: 0, end: 5 }],
};

const trimMissing: Patch = {
  patchId: 'patch_bad' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'Trim a non-existent clip',
  operations: [{ type: 'trim_clip', clipId: 'does_not_exist', start: 0, end: 1 }],
};

describe('useEditor seekTransient', () => {
  it('moves the live clock without dispatching to the reducer', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    act(() => {
      result.current.seekTransient(3.25);
    });
    expect(result.current.getPlayhead()).toBe(3.25);
    // The reducer playhead is deliberately NOT advanced per frame.
    expect(result.current.state.playhead).toBe(0);
  });

  it('clamps negative transient seeks like the reducer does', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    act(() => {
      result.current.seekTransient(-2);
    });
    expect(result.current.getPlayhead()).toBe(0);
  });

  it('commits the clock into the reducer when playback pauses', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    act(() => {
      result.current.setPlaying(true);
      result.current.seekTransient(4.5);
    });
    expect(result.current.state.playhead).toBe(0); // still transient while playing
    act(() => {
      result.current.setPlaying(false);
    });
    expect(result.current.state.playhead).toBe(4.5);
    expect(result.current.state.playing).toBe(false);
  });

  it('usePlayhead subscribers see transient seeks live', () => {
    const { result } = renderHook(() => {
      const editor = useEditor(demoTimeline, demoAssetIds);
      const playhead = usePlayhead(editor);
      return { editor, playhead };
    });
    act(() => {
      result.current.editor.seekTransient(1.75);
    });
    expect(result.current.playhead).toBe(1.75);
  });

  it('useFramePlayhead exposes at most one semantic update per project frame', () => {
    const { result } = renderHook(() => {
      const editor = useEditor(demoTimeline, demoAssetIds);
      const playhead = useFramePlayhead(editor, 30);
      return { editor, playhead };
    });
    act(() => result.current.editor.seekTransient(0.02));
    expect(result.current.playhead).toBe(0);
    act(() => result.current.editor.seekTransient(0.04));
    expect(result.current.playhead).toBe(1 / 30);
  });
});

describe('useEditor applyPatchChecked', () => {
  it('applies a valid patch and returns no issues', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    let issues: readonly unknown[] = ['sentinel'];
    act(() => {
      issues = result.current.applyPatchChecked(trimIntro);
    });
    expect(issues).toEqual([]);
    expect(result.current.state.timeline.tracks[0]?.clips[0]?.end).toBe(5);
    expect(result.current.canUndo).toBe(true);
  });

  it('refuses a stale/invalid patch and reports why', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    let issues: readonly { severity: string }[] = [];
    act(() => {
      issues = result.current.applyPatchChecked(trimMissing);
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
    // Nothing applied, nothing recorded.
    expect(result.current.state.timeline).toBe(demoTimeline);
    expect(result.current.canUndo).toBe(false);
  });

  it('validates against the CURRENT state, not the state at mount', () => {
    const { result } = renderHook(() => useEditor(demoTimeline, demoAssetIds));
    // First edit deletes the intro clip…
    act(() => {
      result.current.applyPatchChecked({
        patchId: 'patch_del' as Patch['patchId'],
        createdBy: 'user',
        reason: 'Delete intro',
        operations: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 6, mode: 'lift' }],
      } as unknown as Patch);
    });
    // …so a "stale" AI patch that still targets it must now be refused.
    let issues: readonly unknown[] = [];
    act(() => {
      issues = result.current.applyPatchChecked(trimIntro);
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});
