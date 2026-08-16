/**
 * Tests for the undo/redo history stack and its persistence (PLAN §1.3).
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { PatchId } from '@framepilot/shared-types';
import type { Patch } from './patch.js';
import {
  canRedo,
  canUndo,
  commitPatch,
  emptyHistory,
  fromPersistedHistory,
  goto,
  redo,
  toPersistedHistory,
  undo,
} from './history.js';

const clip = (id: string, start = 0, end = 10): Clip => ({
  id,
  trackId: 'video_1',
  assetId: 'asset_1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const timeline = (): Timeline => ({
  tracks: [{ id: 'video_1', type: 'video', clips: [clip('a')] }],
});

/**
 * Compare two timelines by content, ignoring `revision`.
 *
 * `revision` is a monotonic staleness marker rather than part of the timeline's
 * content, so it counts forward through undo and redo instead of rewinding —
 * see `expectRoundTrip` in operations.test.ts for why that direction is the safe
 * one. History still restores the *timeline* exactly, which is what these tests
 * are about.
 */
const expectSameContent = (actual: Timeline, expected: Timeline): void => {
  expect({ ...actual, revision: expected.revision }).toEqual(expected);
};

let counter = 0;
const patch = (operations: Patch['operations']): Patch => ({
  patchId: `p_${(counter += 1)}` as PatchId,
  createdBy: 'user',
  reason: 'edit',
  operations,
});

describe('commit / undo / redo', () => {
  it('commits, then undo restores and redo re-applies', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    expect(c1.timeline.tracks[0]!.clips[0]!.end).toBe(5);
    expect(canUndo(c1.history)).toBe(true);
    expect(canRedo(c1.history)).toBe(false);

    const u = undo(c1.timeline, c1.history);
    expectSameContent(u.timeline, t0);
    expect(canUndo(u.history)).toBe(false);
    expect(canRedo(u.history)).toBe(true);

    const r = redo(u.timeline, u.history);
    expectSameContent(r.timeline, c1.timeline);
  });

  it('undo/redo are no-ops at the ends of the stack', () => {
    const t0 = timeline();
    const h0 = emptyHistory();
    expect(undo(t0, h0)).toEqual({ timeline: t0, history: h0 });
    expect(redo(t0, h0)).toEqual({ timeline: t0, history: h0 });
  });

  it('a new commit truncates the redo tail', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    const u = undo(c1.timeline, c1.history);
    // Branch off: commit something else while one edit is undone.
    const c2 = commitPatch(
      u.timeline,
      u.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 8 }]),
    );
    expect(c2.history.entries).toHaveLength(1);
    expect(canRedo(c2.history)).toBe(false);
    expect(c2.timeline.tracks[0]!.clips[0]!.end).toBe(8);
  });
});

describe('goto (jump to any point)', () => {
  // Build a 3-edit stack: end 5 → 8 → 3.
  const build = () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    const c2 = commitPatch(
      c1.timeline,
      c1.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 8 }]),
    );
    const c3 = commitPatch(
      c2.timeline,
      c2.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 3 }]),
    );
    return { t0, c1, c2, c3 };
  };

  it('jumps backward to an earlier point (undo fold)', () => {
    const { t0, c3 } = build();
    const g = goto(c3.timeline, c3.history, 0);
    expectSameContent(g.timeline, t0);
    expect(g.history.cursor).toBe(0);
    expect(canRedo(g.history)).toBe(true);
  });

  it('jumps to an intermediate point', () => {
    const { c1, c3 } = build();
    const g = goto(c3.timeline, c3.history, 1);
    expect(g.timeline.tracks[0]!.clips[0]!.end).toBe(5);
    expectSameContent(g.timeline, c1.timeline);
    expect(g.history.cursor).toBe(1);
  });

  it('jumps forward (redo fold) after undoing', () => {
    const { c3 } = build();
    const back = goto(c3.timeline, c3.history, 0);
    const fwd = goto(back.timeline, back.history, 3);
    expect(fwd.timeline.tracks[0]!.clips[0]!.end).toBe(3);
    expect(fwd.history.cursor).toBe(3);
  });

  it('is a no-op when already at the target', () => {
    const { c3 } = build();
    const g = goto(c3.timeline, c3.history, 3);
    expect(g.timeline).toBe(c3.timeline);
    expect(g.history).toBe(c3.history);
  });

  it('clamps an out-of-range or fractional target', () => {
    const { t0, c3 } = build();
    expect(goto(c3.timeline, c3.history, 99).history.cursor).toBe(3);
    const low = goto(c3.timeline, c3.history, -5);
    expect(low.history.cursor).toBe(0);
    expectSameContent(low.timeline, t0);
    expect(goto(c3.timeline, c3.history, 1.9).history.cursor).toBe(1);
  });
});

describe('committedAt timestamps', () => {
  it('records committedAt when provided and carries it through persistence', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
      1_700_000_000_000,
    );
    expect(c1.history.entries[0]!.committedAt).toBe(1_700_000_000_000);
    const restored = fromPersistedHistory(toPersistedHistory(c1.history));
    expect(restored.entries[0]!.committedAt).toBe(1_700_000_000_000);
  });

  it('omits committedAt when not provided (back-compat)', () => {
    const c1 = commitPatch(
      timeline(),
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    expect(c1.history.entries[0]!.committedAt).toBeUndefined();
    expect('committedAt' in c1.history.entries[0]!).toBe(false);
  });
});

describe('persistence', () => {
  it('persists only applied entries and rebuilds them', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    const c2 = commitPatch(
      c1.timeline,
      c1.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 3 }]),
    );
    const u = undo(c2.timeline, c2.history); // cursor now 1; second edit is redoable

    const persisted = toPersistedHistory(u.history);
    expect(persisted).toHaveLength(1); // redo tail dropped

    const restored = fromPersistedHistory(persisted);
    expect(restored.cursor).toBe(1);
    expect(canRedo(restored)).toBe(false);
    // Undo still works after reload.
    expectSameContent(undo(u.timeline, restored).timeline, t0);
  });

  it('keeps only the newest contiguous entries within durable limits', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 9 }]),
    );
    const c2 = commitPatch(
      c1.timeline,
      c1.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 8 }]),
    );
    const c3 = commitPatch(
      c2.timeline,
      c2.history,
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 7 }]),
    );

    const persisted = toPersistedHistory(c3.history, { maxEntries: 2 });
    expect(persisted.map((entry) => entry.patch.patchId)).toEqual([
      c2.history.entries[1]!.patch.patchId,
      c3.history.entries[2]!.patch.patchId,
    ]);
  });

  it('does not retain older entries when the newest one exceeds the byte budget', () => {
    const t0 = timeline();
    const small = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 9 }]),
    );
    const largePatch = patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 8 }]);
    const large = commitPatch(small.timeline, small.history, {
      ...largePatch,
      reason: 'x'.repeat(2_000),
    });

    expect(toPersistedHistory(large.history, { maxBytes: 512 })).toEqual([]);
  });

  it('walks backward across several entries to fill a mid-sized byte budget', () => {
    let step = { timeline: timeline(), history: emptyHistory() };
    for (let end = 9; end >= 5; end -= 1) {
      step = commitPatch(
        step.timeline,
        step.history,
        patch([{ type: 'trim_clip', clipId: 'a', start: 0, end }]),
      );
    }
    const unbounded = toPersistedHistory(step.history);
    expect(unbounded).toHaveLength(5);

    // Budget fits two of the five equally-sized entries: neither the
    // single-entry short-circuit nor a jump straight to the full history.
    const persisted = toPersistedHistory(step.history, { maxBytes: 1_100 });
    expect(persisted).toHaveLength(2);
    expect(persisted.map((entry) => entry.patch.patchId)).toEqual(
      unbounded.slice(3).map((entry) => entry.patch.patchId),
    );
  });

  it('stops at an exhausted budget rather than reading past it', () => {
    let step = { timeline: timeline(), history: emptyHistory() };
    for (let end = 9; end >= 5; end -= 1) {
      step = commitPatch(
        step.timeline,
        step.history,
        patch([{ type: 'trim_clip', clipId: 'a', start: 0, end }]),
      );
    }
    const countFor = (maxBytes: number): number =>
      toPersistedHistory(step.history, { maxBytes }).length;

    // Binary-search the minimal budget that fits exactly two of these five
    // equally-sized entries. At that minimal budget the second entry consumes
    // every remaining byte, so a third attempt finds none left: the loop's
    // exhausted-budget exit, not just its "doesn't fit" exit.
    let lo = 0;
    let hi = 8_192;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (countFor(mid) >= 2) hi = mid;
      else lo = mid + 1;
    }
    expect(countFor(lo)).toBe(2);
  });

  it('accounts for null and boolean values in the byte-budget estimate', () => {
    const t0 = timeline();
    const c1 = commitPatch(
      t0,
      emptyHistory(),
      patch([{ type: 'adjust_audio', clipId: 'a', gainDb: 0, muted: true }]),
    );
    const c2 = commitPatch(
      c1.timeline,
      c1.history,
      patch([{ type: 'set_clip_speed', clipId: 'a', speed: null }]),
    );

    const persisted = toPersistedHistory(c2.history, { maxBytes: 4_096 });
    expect(persisted.map((entry) => entry.patch.patchId)).toEqual([
      c1.history.entries[0]!.patch.patchId,
      c2.history.entries[1]!.patch.patchId,
    ]);
  });
});
