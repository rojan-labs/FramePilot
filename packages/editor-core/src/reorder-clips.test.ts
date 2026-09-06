/**
 * `reorder_clips` — the atomic route that does not destroy footage (REMAINING §2.1).
 *
 * Four of six clean reorder runs in the session-6 baseline lost the editor's content.
 * Asked to move the last clip to the front, the agent deleted the sequence and then
 * asked how to proceed, describing the damage as the project's own state. Every
 * individual operation was legal, which is why nothing caught it: `move_clip` moves ONE
 * clip to a start time and clips cannot overlap, so a reorder had no expressible route
 * except destroy-and-rebuild — and instant-apply commits the destroy before the rebuild
 * is composed.
 *
 * These tests pin the property that makes the new route safe: the clip SET is invariant
 * under `reorder_clips`, so a run that stops immediately afterwards has lost nothing.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { applyOperation, invertOperation, OperationError } from './operations.js';
import { snapSecondsToFrame } from './frame-grid.js';

const FPS = 30;

function clip(id: string, start: number, end: number): Clip {
  return {
    id,
    assetId: `asset_${id}`,
    trackId: 'v1',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  } as unknown as Clip;
}

/** Five clips of unequal length, butted end to end — the montage shape of the run. */
function timeline(
  clips: readonly Clip[] = [
    clip('c1', 0, 2),
    clip('c2', 2, 5),
    clip('c3', 5, 6),
    clip('c4', 6, 10),
    clip('c5', 10, 11),
  ],
): Timeline {
  return { tracks: [{ id: 'v1', type: 'video', clips }] } as unknown as Timeline;
}

const ids = (t: Timeline) => t.tracks[0]!.clips.map((c) => c.id);
const spans = (t: Timeline) => t.tracks[0]!.clips.map((c) => [c.start, c.end] as const);
const reorder = (clipIds: readonly string[]) =>
  ({ type: 'reorder_clips', trackId: 'v1', clipIds }) as const;

describe('reorder_clips', () => {
  it('moves the last clip to the front without losing any clip', () => {
    const before = timeline();
    const after = applyOperation(before, reorder(['c5', 'c1', 'c2', 'c3', 'c4']), { fps: FPS });
    expect(ids(after)).toEqual(['c5', 'c1', 'c2', 'c3', 'c4']);
    expect(after.tracks[0]!.clips).toHaveLength(before.tracks[0]!.clips.length);
  });

  it('keeps every clip its own duration and source range', () => {
    const before = timeline();
    const after = applyOperation(before, reorder(['c5', 'c1', 'c2', 'c3', 'c4']), { fps: FPS });
    for (const c of after.tracks[0]!.clips) {
      const original = before.tracks[0]!.clips.find((b) => b.id === c.id)!;
      expect(c.end - c.start).toBeCloseTo(original.end - original.start, 12);
      expect(c.sourceStart).toBe(original.sourceStart);
      expect(c.sourceEnd).toBe(original.sourceEnd);
    }
  });

  it('lays the track out gaplessly from its earliest start, on the frame grid', () => {
    const after = applyOperation(timeline(), reorder(['c5', 'c1', 'c2', 'c3', 'c4']), { fps: FPS });
    expect(spans(after)).toEqual([
      [0, 1],
      [1, 3],
      [3, 6],
      [6, 7],
      [7, 11],
    ]);
    for (const [start, end] of spans(after)) {
      expect(snapSecondsToFrame(start, FPS)).toBe(start);
      expect(snapSecondsToFrame(end, FPS)).toBe(end);
    }
  });

  it('stays on the grid where seconds arithmetic would have drifted', () => {
    // Five thirds-of-a-second clips: butting them in seconds accumulates float error
    // into every boundary after the first.
    const third = snapSecondsToFrame(1 / 3, FPS);
    const clips = [0, 1, 2, 3, 4].map((i) => clip(`c${i}`, i * third, (i + 1) * third));
    const after = applyOperation(timeline(clips), reorder(['c4', 'c3', 'c2', 'c1', 'c0']), {
      fps: FPS,
    });
    for (const [start, end] of spans(after)) {
      expect(snapSecondsToFrame(start, FPS)).toBe(start);
      expect(snapSecondsToFrame(end, FPS)).toBe(end);
    }
  });

  it('leaves no overlap and no gap', () => {
    const after = applyOperation(timeline(), reorder(['c3', 'c5', 'c1', 'c4', 'c2']), { fps: FPS });
    const s = spans(after);
    for (let i = 1; i < s.length; i++) expect(s[i]![0]).toBe(s[i - 1]![1]);
  });

  it('anchors at the earliest start rather than at zero', () => {
    const clips = [clip('a', 4, 6), clip('b', 6, 7)];
    const after = applyOperation(timeline(clips), reorder(['b', 'a']), { fps: FPS });
    expect(spans(after)).toEqual([
      [4, 5],
      [5, 7],
    ]);
  });

  it('refuses a partial list and names what is missing', () => {
    expect(() => applyOperation(timeline(), reorder(['c5', 'c1']), { fps: FPS })).toThrow(
      /must list them all.*Missing: c2, c3, c4/s,
    );
  });

  it('refuses a duplicate and an unknown clip', () => {
    expect(() =>
      applyOperation(timeline(), reorder(['c1', 'c1', 'c2', 'c3', 'c4']), { fps: FPS }),
    ).toThrow(/listed twice/);
    expect(() =>
      applyOperation(timeline(), reorder(['c9', 'c1', 'c2', 'c3', 'c4']), { fps: FPS }),
    ).toThrow(OperationError);
  });

  it('inverts exactly, back to the original array', () => {
    const before = timeline();
    const op = reorder(['c5', 'c4', 'c3', 'c2', 'c1']);
    const inverse = invertOperation(before, op, { fps: FPS });
    const after = applyOperation(before, op, { fps: FPS });
    const restored = applyOperation(after, inverse[0]!, { fps: FPS });
    expect(restored.tracks[0]!.clips).toEqual(before.tracks[0]!.clips);
  });

  it('bumps the revision, because the sequence mapping changed', () => {
    const before = timeline();
    const after = applyOperation(before, reorder(['c5', 'c1', 'c2', 'c3', 'c4']), { fps: FPS });
    expect(after.revision).toBe((before.revision ?? 0) + 1);
  });

  it('is a no-op in content terms when the order is unchanged', () => {
    const before = timeline();
    const after = applyOperation(before, reorder(['c1', 'c2', 'c3', 'c4', 'c5']), { fps: FPS });
    expect(spans(after)).toEqual(spans(before));
  });
});
