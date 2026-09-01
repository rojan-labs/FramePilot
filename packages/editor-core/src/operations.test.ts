/**
 * Tests for @framepilot/editor-core operations (PLAN §1.2).
 *
 * Every operation is exercised through both `apply` and `invert`: applying then
 * applying the inverse must reproduce the original timeline exactly (the core
 * reversibility guarantee), plus error/edge cases for 100% coverage.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Timeline, Track } from '@framepilot/timeline-schema';
import {
  applyOperation,
  CAPTION_ASSET_ID,
  invertOperation,
  isOperationOfType,
  OperationError,
  splitClipRightId,
  TEXT_OVERLAY_ASSET_ID,
  type Operation,
} from './operations.js';

// --- fixtures --------------------------------------------------------------

const clip = (over: Partial<Clip> & Pick<Clip, 'id' | 'trackId'>): Clip => ({
  assetId: 'asset_1',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

const baseTimeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        clip({ id: 'a', trackId: 'video_1', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 }),
        clip({ id: 'b', trackId: 'video_1', start: 10, end: 20, sourceStart: 5, sourceEnd: 15 }),
      ],
    },
    {
      id: 'audio_1',
      type: 'audio',
      clips: [clip({ id: 'au', trackId: 'audio_1', end: 20, sourceEnd: 20 })],
    },
    { id: 'caption_1', type: 'caption', clips: [] },
    { id: 'overlay_1', type: 'overlay', clips: [] },
  ],
});

const track = (tl: Timeline, id: string): Track => tl.tracks.find((t) => t.id === id)!;
const findClipById = (tl: Timeline, id: string): Clip | undefined =>
  tl.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

/**
 * Apply `op`, then apply its inverse, and assert we land back on `before`.
 *
 * `revision` is compared separately and deliberately: it is a **monotonic
 * staleness marker, not part of the timeline's content**, so it counts forward
 * through an undo rather than rewinding. Rewinding it would be the dangerous
 * direction — a caption derived *after* the edit would look current again while
 * matching neither state. Counting forward can only over-report staleness, which
 * costs a remap; under-reporting costs a wrong caption in the export.
 */
const expectRoundTrip = (before: Timeline, op: Operation): Timeline => {
  const after = applyOperation(before, op);
  const inverses = invertOperation(before, op);
  const restored = inverses.reduce(applyOperation, after);
  expect({ ...restored, revision: before.revision }).toEqual(before);
  expect(restored.revision ?? 0).toBeGreaterThanOrEqual(before.revision ?? 0);
  return after;
};

// --- type guard ------------------------------------------------------------

describe('isOperationOfType', () => {
  it('narrows by discriminant', () => {
    const op: Operation = { type: 'trim_clip', clipId: 'a', start: 1, end: 5 };
    expect(isOperationOfType(op, 'trim_clip')).toBe(true);
    expect(isOperationOfType(op, 'split_clip')).toBe(false);
    if (isOperationOfType(op, 'trim_clip')) expect(op.clipId).toBe('a');
  });
});

// --- immutability ----------------------------------------------------------

describe('immutability', () => {
  it('never mutates the input timeline', () => {
    const before = baseTimeline();
    const snapshot = structuredClone(before);
    const after = applyOperation(before, { type: 'trim_clip', clipId: 'a', start: 2, end: 8 });
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });
});

// --- trim_clip -------------------------------------------------------------

describe('trim_clip', () => {
  it('moves edges and remaps source 1:1, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'trim_clip', clipId: 'a', start: 2, end: 8 });
    const a = findClipById(after, 'a')!;
    expect([a.start, a.end, a.sourceStart, a.sourceEnd]).toEqual([2, 8, 2, 8]);
  });

  it('throws on non-positive duration', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'trim_clip', clipId: 'a', start: 5, end: 5 }),
    ).toThrow(OperationError);
  });

  it('throws when the source range becomes invalid', () => {
    const tl: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', trackId: 'video_1', start: 3, end: 10, sourceStart: 1, sourceEnd: 8 }),
          ],
        },
      ],
    };
    // Extend the left edge by 3s → sourceStart would go to -2.
    expect(() => applyOperation(tl, { type: 'trim_clip', clipId: 'a', start: 0, end: 10 })).toThrow(
      /source range/,
    );
  });

  it('states both time domains and both ranges when the source range is invalid', () => {
    // `trim_clip produces invalid source range on a` named the clip and nothing else. A
    // model whose only view of the rejection is that sentence can reissue the same call
    // or give up, and in the captured runs (`framepilot.runs.jsonl`) it reissued: 34
    // `trim_clip` failures, 29 of them this message, across three clips.
    //
    // The cause it could not see is one confusion — timeline time used where the clip's
    // SOURCE range is what constrains it. The message has to name both.
    const tl: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', trackId: 'video_1', start: 3, end: 10, sourceStart: 1, sourceEnd: 8 }),
          ],
        },
      ],
    };
    let message = '';
    try {
      applyOperation(tl, { type: 'trim_clip', clipId: 'a', start: 0, end: 10 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('timeline 3s to 10s');
    expect(message).toContain('source 1s to 8s');
    // The number that is actually out of bounds, said plainly.
    expect(message).toContain('needs source -2s, which is before the media starts');
    // And the fix, because naming the fault without the move is half an answer.
    expect(message).toContain('get_clip');
  });

  it('says which times gave a trim no duration', () => {
    let message = '';
    try {
      applyOperation(baseTimeline(), { type: 'trim_clip', clipId: 'a', start: 5, end: 5 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('5s → 5s');
  });
});

// --- set_clip_source_range -------------------------------------------------

describe('set_clip_source_range', () => {
  it('slips source media without moving sequence edges, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'set_clip_source_range',
      clipId: 'b',
      sourceStart: 7,
      sourceEnd: 17,
    });
    const b = findClipById(after, 'b')!;
    expect([b.start, b.end, b.sourceStart, b.sourceEnd]).toEqual([10, 20, 7, 17]);
  });

  it('rejects invalid source ranges and speed-duration mismatches', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_source_range',
        clipId: 'b',
        sourceStart: -1,
        sourceEnd: 9,
      }),
    ).toThrow(/invalid source range/);
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_source_range',
        clipId: 'b',
        sourceStart: 7,
        sourceEnd: 16,
      }),
    ).toThrow(/duration implied/);
  });
});

describe('set_clip_media', () => {
  it('replaces footage while preserving clip identity and editorial state, reversibly', () => {
    const before = baseTimeline();
    const original = findClipById(before, 'b')!;
    original.effects.push({ id: 'grade', type: 'color_grade', params: {}, keyframes: [] });
    original.keyframes.push({
      id: 'scale',
      property: 'scale',
      time: 1,
      value: 1.2,
      easing: 'linear',
    });
    const after = expectRoundTrip(before, {
      type: 'set_clip_media',
      clipId: 'b',
      assetId: 'asset_2',
      sourceStart: 8,
      sourceEnd: 18,
    });
    const replaced = findClipById(after, 'b')!;
    expect([replaced.assetId, replaced.sourceStart, replaced.sourceEnd]).toEqual([
      'asset_2',
      8,
      18,
    ]);
    expect(replaced.effects).toEqual(original.effects);
    expect(replaced.keyframes).toEqual(original.keyframes);
    expect([replaced.start, replaced.end]).toEqual([10, 20]);
  });
});

// --- split_clip ------------------------------------------------------------

describe('split_clip', () => {
  it('splits into two clips with remapped source, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'split_clip', clipId: 'a', at: 4 });
    const clips = track(after, 'video_1').clips;
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [4, 10],
      [10, 20],
    ]);
    expect(clips[0]!.sourceEnd).toBeCloseTo(4);
    expect(clips[1]!.sourceStart).toBeCloseTo(4);
  });

  it('partitions and re-bases keyframes across the split', () => {
    const kfs: Keyframe[] = [
      { id: 'k1', time: 2, property: 'scale', value: 1, easing: 'linear' },
      { id: 'k2', time: 7, property: 'scale', value: 2, easing: 'linear' },
    ];
    const tl: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'a', trackId: 'video_1', keyframes: kfs })],
        },
      ],
    };
    const after = applyOperation(tl, { type: 'split_clip', clipId: 'a', at: 5 });
    const [left, right] = track(after, 'video_1').clips;
    expect(left!.keyframes.map((k) => k.time)).toEqual([2]);
    expect(right!.keyframes.map((k) => k.time)).toEqual([2]); // 7 - 5
  });

  it('throws when split point is not strictly inside the clip', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'split_clip', clipId: 'a', at: 0 }),
    ).toThrow(/inside/);
    expect(() =>
      applyOperation(baseTimeline(), { type: 'split_clip', clipId: 'a', at: 10 }),
    ).toThrow(/inside/);
  });
});

// --- delete_range ----------------------------------------------------------

describe('delete_range', () => {
  it('punches a hole in the middle of a clip (two remainders), reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'delete_range',
      trackId: 'video_1',
      start: 3,
      end: 5,
    });
    const clips = track(after, 'video_1').clips;
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [0, 3],
      [5, 10],
      [10, 20],
    ]);
  });

  it('removes a fully-covered clip', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'delete_range',
      trackId: 'video_1',
      start: 0,
      end: 10,
    });
    expect(track(after, 'video_1').clips.map((c) => c.id)).toEqual(['b']);
  });

  it('trims a clip overlapped on its left edge', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'delete_range',
      trackId: 'video_1',
      start: 8,
      end: 12,
    });
    const clips = track(after, 'video_1').clips;
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [0, 8],
      [12, 20],
    ]);
  });

  it('leaves non-overlapping clips untouched', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'delete_range',
      trackId: 'video_1',
      start: 100,
      end: 110,
    });
    expect(track(after, 'video_1').clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('throws on a non-positive range', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'delete_range',
        trackId: 'video_1',
        start: 5,
        end: 5,
      }),
    ).toThrow(/greater than start/);
  });
});

// --- ripple_delete ---------------------------------------------------------

describe('ripple_delete', () => {
  it('closes the gap by shifting later clips left, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'ripple_delete',
      trackId: 'video_1',
      start: 0,
      end: 4,
    });
    const clips = track(after, 'video_1').clips;
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [0, 6],
      [6, 16],
    ]);
  });

  it('shifts only clips after the gap, leaving earlier clips in place', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'ripple_delete',
      trackId: 'video_1',
      start: 12,
      end: 14,
    });
    const clips = track(after, 'video_1').clips;
    // a[0,10] untouched; b splits into [10,12] (kept) and [14,20] shifted left by 2 → [12,18].
    expect(clips.map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 12],
      [12, 18],
    ]);
  });

  it('throws on a non-positive range', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'ripple_delete',
        trackId: 'video_1',
        start: 2,
        end: 1,
      }),
    ).toThrow();
  });
});

// --- move_clip -------------------------------------------------------------

describe('move_clip', () => {
  it('moves within the same track, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'move_clip',
      clipId: 'a',
      toTrackId: 'video_1',
      toStart: 30,
    });
    const a = findClipById(after, 'a')!;
    expect([a.start, a.end]).toEqual([30, 40]);
  });

  it('moves across tracks, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'move_clip',
      clipId: 'au',
      toTrackId: 'video_1',
      toStart: 50,
    });
    expect(track(after, 'audio_1').clips).toHaveLength(0);
    const moved = findClipById(after, 'au')!;
    expect(moved.trackId).toBe('video_1');
  });

  it('throws when the destination track is missing', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'move_clip',
        clipId: 'a',
        toTrackId: 'nope',
        toStart: 0,
      }),
    ).toThrow(/Track not found/);
  });
});

// --- add_clip / overlays / captions ---------------------------------------

describe('add_clip', () => {
  it('adds with an explicit id, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'asset_2',
      start: 30,
      end: 35,
      sourceStart: 0,
      sourceEnd: 5,
      clipId: 'new',
    });
    expect(findClipById(after, 'new')).toBeDefined();
  });

  it('derives a deterministic id when none is given', () => {
    const a = applyOperation(baseTimeline(), {
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'x',
      start: 30,
      end: 35,
      sourceStart: 0,
      sourceEnd: 5,
    });
    const b = applyOperation(baseTimeline(), {
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'x',
      start: 30,
      end: 35,
      sourceStart: 0,
      sourceEnd: 5,
    });
    const idA = track(a, 'video_1').clips.find((c) => c.assetId === 'x')!.id;
    const idB = track(b, 'video_1').clips.find((c) => c.assetId === 'x')!.id;
    expect(idA).toBe(idB);
  });

  it('throws on duplicate clip id', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'x',
        start: 30,
        end: 35,
        sourceStart: 0,
        sourceEnd: 5,
        clipId: 'a',
      }),
    ).toThrow(/already exists/);
  });

  it('throws on non-positive timeline or source range', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'x',
        start: 5,
        end: 5,
        sourceStart: 0,
        sourceEnd: 5,
      }),
    ).toThrow();
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'x',
        start: 0,
        end: 5,
        sourceStart: 2,
        sourceEnd: 2,
      }),
    ).toThrow();
  });
});

describe('add_text_overlay', () => {
  it('adds a text clip carrying the text effect, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_text_overlay',
      trackId: 'overlay_1',
      text: 'Hi',
      start: 1,
      end: 3,
      clipId: 't1',
    });
    const c = findClipById(after, 't1')!;
    expect(c.assetId).toBe(TEXT_OVERLAY_ASSET_ID);
    expect(c.effects[0]!.params.text).toBe('Hi');
  });

  it('derives an id when omitted', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'add_text_overlay',
      trackId: 'overlay_1',
      text: 'Hi',
      start: 1,
      end: 3,
    });
    expect(track(after, 'overlay_1').clips).toHaveLength(1);
  });
});

describe('add_caption_layer', () => {
  it('adds a caption clip, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_caption_layer',
      trackId: 'caption_1',
      start: 1,
      end: 3,
      clipId: 'c1',
    });
    expect(findClipById(after, 'c1')!.assetId).toBe(CAPTION_ASSET_ID);
  });

  it('derives an id when omitted', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'add_caption_layer',
      trackId: 'caption_1',
      start: 1,
      end: 3,
    });
    expect(track(after, 'caption_1').clips).toHaveLength(1);
  });
});

// --- clip-attribute ops ----------------------------------------------------

describe('clip-attribute operations', () => {
  const kf: Keyframe = { id: 'k', time: 1, property: 'scale', value: 2, easing: 'linear' };

  it('add_keyframes appends, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'add_keyframes', clipId: 'a', keyframes: [kf] });
    expect(findClipById(after, 'a')!.keyframes).toHaveLength(1);
  });

  // --- remove_keyframes (revamp Phase 5a) ---------------------------------
  //
  // The op the product was missing entirely: `add_keyframes.replace` only swaps a
  // keyframe at the same property AND time, so nothing could delete one — and a
  // move is a delete plus an add.

  /** A clip carrying a small animation to remove pieces of. */
  const animated = () =>
    expectRoundTrip(baseTimeline(), {
      type: 'add_keyframes',
      clipId: 'a',
      keyframes: [
        { id: 's0', time: 0, property: 'scale', value: 1, easing: 'linear' },
        { id: 's1', time: 1, property: 'scale', value: 2, easing: 'linear' },
        { id: 'x0', time: 1, property: 'x', value: 10, easing: 'linear' },
      ],
    });

  it('remove_keyframes drops one keyframe by property + time, reversibly', () => {
    const after = expectRoundTrip(animated(), {
      type: 'remove_keyframes',
      clipId: 'a',
      targets: [{ property: 'scale', time: 1 }],
    });
    const keyframes = findClipById(after, 'a')!.keyframes;
    // Only scale@1s went; scale@0s and the x keyframe at the same TIME survived.
    expect(keyframes.map((k) => k.id).sort()).toEqual(['s0', 'x0']);
  });

  it('remove_keyframes clears a whole property when no time is given', () => {
    const after = expectRoundTrip(animated(), {
      type: 'remove_keyframes',
      clipId: 'a',
      targets: [{ property: 'scale' }],
    });
    // "Clear this property's animation", without the caller enumerating times it
    // may not know.
    expect(findClipById(after, 'a')!.keyframes.map((k) => k.id)).toEqual(['x0']);
  });

  it('remove_keyframes handles several targets at once, as one operation', () => {
    const after = expectRoundTrip(animated(), {
      type: 'remove_keyframes',
      clipId: 'a',
      targets: [{ property: 'scale', time: 0 }, { property: 'x' }],
    });
    expect(findClipById(after, 'a')!.keyframes.map((k) => k.id)).toEqual(['s1']);
  });

  it('remove_keyframes matches a time within the SAME epsilon as replace', () => {
    // The two must agree, or a set-then-clear on one inspector diamond would leave
    // a stray keyframe a millisecond away from where the user clicked.
    const after = expectRoundTrip(animated(), {
      type: 'remove_keyframes',
      clipId: 'a',
      targets: [{ property: 'scale', time: 1.0005 }],
    });
    expect(findClipById(after, 'a')!.keyframes.some((k) => k.id === 's1')).toBe(false);

    const missed = applyOperation(animated(), {
      type: 'remove_keyframes',
      clipId: 'a',
      targets: [{ property: 'scale', time: 1.5 }],
    });
    expect(findClipById(missed, 'a')!.keyframes).toHaveLength(3);
  });

  it('remove_keyframes returns the SAME timeline when nothing matched', () => {
    // Reference equality, so a no-op removal cannot masquerade as a change to
    // anything comparing by identity (memoised selectors, signature guards).
    const before = animated();
    expect(
      applyOperation(before, {
        type: 'remove_keyframes',
        clipId: 'a',
        targets: [{ property: 'rotation' }],
      }),
    ).toBe(before);
    expect(applyOperation(before, { type: 'remove_keyframes', clipId: 'a', targets: [] })).toBe(
      before,
    );
  });

  it('remove_keyframes composes with add to MOVE a keyframe in one patch', () => {
    // A move is a delete at the old time plus an add at the new — the reason this op
    // unblocks dragging a keyframe on the timeline.
    const moved = expectRoundTrip(
      expectRoundTrip(animated(), {
        type: 'remove_keyframes',
        clipId: 'a',
        targets: [{ property: 'scale', time: 1 }],
      }),
      {
        type: 'add_keyframes',
        clipId: 'a',
        keyframes: [{ id: 's1', time: 3, property: 'scale', value: 2, easing: 'linear' }],
      },
    );
    const scale = findClipById(moved, 'a')!.keyframes.filter((k) => k.property === 'scale');
    expect(scale.map((k) => k.time).sort()).toEqual([0, 3]);
  });

  it('add_keyframes with replace swaps a same-property same-time keyframe (H4)', () => {
    const before = expectRoundTrip(baseTimeline(), {
      type: 'add_keyframes',
      clipId: 'a',
      keyframes: [kf, { ...kf, id: 'kx', property: 'x', value: 10 }],
    });
    const after = expectRoundTrip(before, {
      type: 'add_keyframes',
      clipId: 'a',
      keyframes: [{ ...kf, id: 'k2', value: 3 }],
      replace: true,
    });
    const keyframes = findClipById(after, 'a')!.keyframes;
    // The scale@1s keyframe was replaced (not stacked); the x keyframe survived.
    expect(keyframes.filter((k) => k.property === 'scale')).toEqual([
      { ...kf, id: 'k2', value: 3 },
    ]);
    expect(keyframes.some((k) => k.property === 'x')).toBe(true);
    // A different time still appends under replace.
    const later = expectRoundTrip(after, {
      type: 'add_keyframes',
      clipId: 'a',
      keyframes: [{ ...kf, id: 'k3', time: 2, value: 4 }],
      replace: true,
    });
    expect(findClipById(later, 'a')!.keyframes.filter((k) => k.property === 'scale')).toHaveLength(
      2,
    );
  });

  it('apply_color_grade attaches an effect, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'apply_color_grade',
      clipId: 'a',
      effect: { id: 'cg', type: 'color_grade', params: { contrast: 1.1 }, keyframes: [] },
    });
    expect(findClipById(after, 'a')!.effects.some((e) => e.type === 'color_grade')).toBe(true);
  });

  it('apply_color_grade replaces an effect with the same id (no compounding)', () => {
    const first = applyOperation(baseTimeline(), {
      type: 'apply_color_grade',
      clipId: 'a',
      effect: { id: 'a__grade', type: 'color_grade', params: { exposure: 0.2 }, keyframes: [] },
    });
    const second = applyOperation(first, {
      type: 'apply_color_grade',
      clipId: 'a',
      effect: { id: 'a__grade', type: 'color_grade', params: { exposure: 0.5 }, keyframes: [] },
    });
    const grades = findClipById(second, 'a')!.effects.filter((e) => e.type === 'color_grade');
    expect(grades).toHaveLength(1);
    expect(grades[0]!.params.exposure).toBe(0.5);
  });

  it('set_effect_params merges params into an existing effect, reversibly', () => {
    // A text overlay with a text effect whose params we edit (content + style).
    const before: Timeline = {
      tracks: [
        {
          id: 'overlay_1',
          type: 'overlay',
          clips: [
            clip({
              id: 't',
              trackId: 'overlay_1',
              assetId: TEXT_OVERLAY_ASSET_ID,
              effects: [
                { id: 'txt', type: 'text', params: { text: 'Hi', color: '#fff' }, keyframes: [] },
              ],
            }),
          ],
        },
      ],
    };
    const after = expectRoundTrip(before, {
      type: 'set_effect_params',
      clipId: 't',
      effectId: 'txt',
      params: { text: 'Hello', fontSize: 48 },
    });
    const effect = findClipById(after, 't')!.effects.find((e) => e.id === 'txt')!;
    // Merged: the edited keys change, the untouched key (color) is preserved.
    expect(effect.params).toEqual({ text: 'Hello', color: '#fff', fontSize: 48 });
    // id/type/keyframes are untouched.
    expect(effect.type).toBe('text');
  });

  it('set_effect_params clears a key set to undefined', () => {
    const before: Timeline = {
      tracks: [
        {
          id: 'overlay_1',
          type: 'overlay',
          clips: [
            clip({
              id: 't',
              trackId: 'overlay_1',
              assetId: TEXT_OVERLAY_ASSET_ID,
              effects: [
                { id: 'txt', type: 'text', params: { text: 'Hi', bg: '#000' }, keyframes: [] },
              ],
            }),
          ],
        },
      ],
    };
    const after = applyOperation(before, {
      type: 'set_effect_params',
      clipId: 't',
      effectId: 'txt',
      params: { bg: undefined },
    });
    expect(findClipById(after, 't')!.effects[0]!.params).toEqual({ text: 'Hi' });
  });

  it('set_effect_params throws when the effect id is not on the clip', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_effect_params',
        clipId: 'a',
        effectId: 'nope',
        params: { x: 1 },
      }),
    ).toThrow(OperationError);
  });

  it('adjust_audio sets gain and replaces a prior gain effect, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'adjust_audio', clipId: 'au', gainDb: -6 });
    const gain = findClipById(after, 'au')!.effects.find((e) => e.type === 'audio_gain')!;
    expect(gain.params.gainDb).toBe(-6);

    // Second adjust replaces (not duplicates) the gain effect.
    const twice = applyOperation(after, { type: 'adjust_audio', clipId: 'au', gainDb: 3 });
    const gains = findClipById(twice, 'au')!.effects.filter((e) => e.type === 'audio_gain');
    expect(gains).toHaveLength(1);
    expect(gains[0]!.params.gainDb).toBe(3);
  });

  it('adjust_audio persists fades/mute/normalize/duck, reversibly', () => {
    const after = expectRoundTrip(baseTimeline(), {
      type: 'adjust_audio',
      clipId: 'au',
      gainDb: -3,
      fadeInSeconds: 0.5,
      fadeCurve: 'equal-power',
      muted: true,
      normalize: true,
      duckUnderTrackId: 'video_1',
      duckAmountDb: -10,
    });
    const params = findClipById(after, 'au')!.effects.find((e) => e.type === 'audio_gain')!.params;
    expect(params.fadeInSeconds).toBe(0.5);
    expect(params.fadeCurve).toBe('equal-power');
    expect(params.muted).toBe(true);
    expect(params.normalize).toBe(true);
    expect(params.duckUnderTrackId).toBe('video_1');
    expect(params.fadeOutSeconds).toBeUndefined(); // unspecified → omitted
  });

  it('adjust_audio persists a fade-out when specified, reversibly', () => {
    // Covers the fadeOutSeconds branch (the sibling test omits it on purpose).
    const after = expectRoundTrip(baseTimeline(), {
      type: 'adjust_audio',
      clipId: 'au',
      gainDb: 0,
      fadeOutSeconds: 0.75,
    });
    const params = findClipById(after, 'au')!.effects.find((e) => e.type === 'audio_gain')!.params;
    expect(params.fadeOutSeconds).toBe(0.75);
    expect(params.fadeInSeconds).toBeUndefined(); // still omitted when unspecified
  });

  it('add_transition attaches a transition effect to the target clip, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    expect(findClipById(after, 'b')!.effects.some((e) => e.type === 'transition')).toBe(true);
  });

  it('add_transition accepts the wipe and slide kinds', () => {
    for (const kind of ['wipe', 'slide'] as const) {
      const after = expectRoundTrip(baseTimeline(), {
        type: 'add_transition',
        trackId: 'video_1',
        fromClipId: 'a',
        toClipId: 'b',
        kind,
        durationSeconds: 0.5,
      });
      const effect = findClipById(after, 'b')!.effects.find((e) => e.type === 'transition')!;
      expect(effect.params.kind).toBe(kind);
    }
  });

  /**
   * Two 0.4s clips — shorter than twice the UI's 0.5s default, which is what made
   * every short-clip cut (silence-removal output, stingers, quick b-roll) refuse a
   * transition: the op wrote the requested duration, and the post-apply
   * `transition_overlap` check then rejected the whole patch.
   */
  const shortClipTimeline = (): Timeline => ({
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          clip({ id: 'a', trackId: 'video_1', start: 0, end: 0.4, sourceStart: 0, sourceEnd: 0.4 }),
          clip({
            id: 'b',
            trackId: 'video_1',
            start: 0.4,
            end: 0.8,
            sourceStart: 1,
            sourceEnd: 1.4,
          }),
        ],
      },
    ],
  });

  it('add_transition clamps to what the cut can carry instead of refusing short clips', () => {
    const after = expectRoundTrip(shortClipTimeline(), {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    const effect = findClipById(after, 'b')!.effects.find((e) => e.type === 'transition')!;
    // Half the shorter clip — the boundary's maximum, not the 0.5s asked for.
    expect(effect.params.durationSeconds).toBe(0.2);
  });

  it('add_transition clamps both halves of a centred transition to the same duration', () => {
    // The outgoing half is written from the same clamped number, so the two halves
    // cannot disagree — a disagreement is itself a validation error.
    const after = applyOperation(shortClipTimeline(), {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'cross-dissolve',
      durationSeconds: 4,
      alignment: 'centre',
    });
    const incoming = findClipById(after, 'b')!.effects.find((e) => e.type === 'transition')!;
    const outgoing = findClipById(after, 'a')!.effects.find((e) => e.type === 'transition_out')!;
    expect(incoming.params.durationSeconds).toBe(0.2);
    expect(outgoing.params.durationSeconds).toBe(0.2);
  });

  it('add_transition leaves a duration the cut can carry untouched', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    expect(
      findClipById(after, 'b')!.effects.find((e) => e.type === 'transition')!.params
        .durationSeconds,
    ).toBe(0.5);
  });

  it('add_transition throws on non-positive duration', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_transition',
        trackId: 'video_1',
        fromClipId: 'a',
        toClipId: 'b',
        kind: 'fade',
        durationSeconds: 0,
      }),
    ).toThrow(/positive duration/);
  });

  it('add_transition is idempotent by transition id: re-adding replaces, never stacks', () => {
    const before = baseTimeline();
    const once = applyOperation(before, {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    // Re-add (e.g. a UI duration-resize / kind swap) on the same junction.
    const twice = applyOperation(once, {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'cross-dissolve',
      durationSeconds: 1.5,
    });
    const transitions = findClipById(twice, 'b')!.effects.filter((e) => e.type === 'transition');
    expect(transitions).toHaveLength(1); // replaced in place, not stacked
    expect(transitions[0]!.params.kind).toBe('cross-dissolve');
    expect(transitions[0]!.params.durationSeconds).toBe(1.5);
  });

  it('add_transition apply→invert restores exactly even after a prior transition', () => {
    const before = applyOperation(baseTimeline(), {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    // The round-trip helper proves the inverse restores `before` (one transition, fade@0.5).
    expectRoundTrip(before, {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'zoom',
      durationSeconds: 2,
    });
  });

  it('add_mask attaches a mask effect, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'add_mask', clipId: 'a', shape: 'ellipse' });
    const mask = findClipById(after, 'a')!.effects.find((e) => e.type === 'mask');
    expect(mask).toBeDefined();
    expect(mask!.params).toEqual({ shape: 'ellipse' });
  });

  it('add_mask stores geometry params and effect keyframes', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_mask',
      clipId: 'a',
      shape: 'rectangle',
      bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      points: [
        [0, 0],
        [1, 1],
      ],
      feather: 0.05,
      opacity: 0.8,
      invert: true,
      keyframes: [{ id: 'mk', time: 0, property: 'x', value: 0.1, easing: 'linear' }],
    });
    const mask = findClipById(after, 'a')!.effects.find((e) => e.type === 'mask')!;
    expect(mask.params).toMatchObject({
      shape: 'rectangle',
      bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      feather: 0.05,
      opacity: 0.8,
      invert: true,
    });
    expect(mask.keyframes).toHaveLength(1);
  });

  it('track_object attaches a tracking effect, reversibly', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, { type: 'track_object', clipId: 'a', target: 'face' });
    expect(findClipById(after, 'a')!.effects.some((e) => e.type === 'object_track')).toBe(true);
  });

  it('track_object stores an arbitrary object region, engine, and track keyframes', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'track_object',
      clipId: 'a',
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      engine: 'manual',
      keyframes: [{ id: 'b0', time: 0, property: 'x', value: 0.3, easing: 'linear' }],
    });
    const track = findClipById(after, 'a')!.effects.find((e) => e.type === 'object_track')!;
    expect(track.params).toMatchObject({
      target: 'object',
      region: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      engine: 'manual',
    });
    expect(track.keyframes).toHaveLength(1);
  });

  it('replaces canonical masks and tracks instead of stacking duplicate ids', () => {
    const masked = applyOperation(
      applyOperation(baseTimeline(), { type: 'add_mask', clipId: 'a', shape: 'ellipse' }),
      { type: 'add_mask', clipId: 'a', shape: 'rectangle' },
    );
    const tracked = applyOperation(
      applyOperation(masked, { type: 'track_object', clipId: 'a', target: 'face' }),
      { type: 'track_object', clipId: 'a', target: 'object', engine: 'manual' },
    );
    const effects = findClipById(tracked, 'a')!.effects;
    expect(effects.filter((effect) => effect.id === 'a__mask')).toHaveLength(1);
    expect(effects.filter((effect) => effect.id === 'a__track')).toHaveLength(1);
    expect(effects.find((effect) => effect.id === 'a__mask')?.params.shape).toBe('rectangle');
    expect(effects.find((effect) => effect.id === 'a__track')?.params.target).toBe('object');
  });
});

// --- restore_clips (inverse primitive) ------------------------------------

describe('restore_clips', () => {
  it('replaces a track clip list and is self-inverse', () => {
    const before = baseTimeline();
    const op: Operation = { type: 'restore_clips', trackId: 'video_1', clips: [] };
    const after = applyOperation(before, op);
    expect(track(after, 'video_1').clips).toHaveLength(0);
    const restored = invertOperation(before, op).reduce(applyOperation, after);
    // Content round-trips; `revision` counts forward (see expectRoundTrip).
    expect({ ...restored, revision: before.revision }).toEqual(before);
  });
});

// --- timeline.revision (staleness marker, ADR 0076) ------------------------

describe('timeline.revision', () => {
  const revisionAfter = (op: Operation, before = baseTimeline()): number | undefined =>
    applyOperation(before, op).revision;

  it('starts absent and reaches 1 on the first structural edit', () => {
    expect(baseTimeline().revision).toBeUndefined();
    expect(revisionAfter({ type: 'trim_clip', clipId: 'a', start: 0, end: 5 })).toBe(1);
  });

  it('bumps for every operation that moves footage in the sequence', () => {
    const structural: Operation[] = [
      { type: 'trim_clip', clipId: 'a', start: 0, end: 5 },
      { type: 'set_clip_source_range', clipId: 'a', sourceStart: 1, sourceEnd: 11 },
      { type: 'split_clip', clipId: 'a', at: 4 },
      { type: 'delete_range', trackId: 'video_1', start: 1, end: 3 },
      { type: 'ripple_delete', trackId: 'video_1', start: 1, end: 3 },
      { type: 'move_clip', clipId: 'a', toTrackId: 'video_1', toStart: 30 },
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'asset_1',
        start: 40,
        end: 45,
        sourceStart: 0,
        sourceEnd: 5,
      },
      { type: 'set_clip_speed', clipId: 'a', speed: 2 },
      { type: 'restore_clips', trackId: 'video_1', clips: [] },
    ];
    for (const op of structural) {
      expect(revisionAfter(op), `${op.type} must bump the revision`).toBe(1);
    }
  });

  it('does NOT bump when captions are written to a caption track', () => {
    // The one that matters most: `generateCaptionsPatch` clears the old cues
    // with `delete_range` on the caption track before writing the new ones. If
    // that bumped the revision, every caption would be stale the instant it was
    // generated — the pipeline would never once report a synchronized result.
    const withCue = applyOperation(baseTimeline(), {
      type: 'add_caption_layer',
      trackId: 'caption_1',
      start: 0,
      end: 2,
      clipId: 'cap_0',
    });
    expect(withCue.revision).toBeUndefined();
    expect(
      applyOperation(withCue, { type: 'delete_range', trackId: 'caption_1', start: 0, end: 2 })
        .revision,
    ).toBeUndefined();
  });

  it('does NOT bump for styling, effects, or track flags', () => {
    const cosmetic: Operation[] = [
      { type: 'apply_color_grade', clipId: 'a', params: { saturation: 1.2 } },
      { type: 'adjust_audio', clipId: 'au', gainDb: -3 },
      { type: 'set_track_flags', trackId: 'video_1', muted: true },
      { type: 'set_clip_blend_mode', clipId: 'a', blendMode: 'screen' },
      {
        type: 'set_track_caption_style',
        trackId: 'caption_1',
        captionStyle: { templateId: 'minimal' },
      },
    ];
    for (const op of cosmetic) {
      expect(revisionAfter(op), `${op.type} must not bump the revision`).toBeUndefined();
    }
  });

  it('counts forward rather than rewinding, so it never under-reports staleness', () => {
    const before = baseTimeline();
    const op: Operation = { type: 'trim_clip', clipId: 'a', start: 0, end: 5 };
    const after = applyOperation(before, op);
    const undone = invertOperation(before, op).reduce(applyOperation, after);
    // A caption derived at revision 1 must not be able to look current again
    // after an undo — the timeline has changed twice and it matches neither.
    expect(undone.revision).toBe(2);
  });

  it('accumulates across a sequence of edits', () => {
    const one = applyOperation(baseTimeline(), {
      type: 'trim_clip',
      clipId: 'a',
      start: 0,
      end: 5,
    });
    const two = applyOperation(one, { type: 'trim_clip', clipId: 'b', start: 10, end: 15 });
    expect(two.revision).toBe(2);
  });
});

// --- shared error paths ----------------------------------------------------

describe('missing-entity errors', () => {
  it('throws for a missing clip', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'trim_clip', clipId: 'ghost', start: 1, end: 2 }),
    ).toThrow(/Clip not found/);
  });

  it('throws for a missing track', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'delete_range', trackId: 'ghost', start: 0, end: 1 }),
    ).toThrow(/Track not found/);
  });

  it('OperationError carries a code', () => {
    try {
      applyOperation(baseTimeline(), { type: 'trim_clip', clipId: 'ghost', start: 1, end: 2 });
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('missing_clip');
    }
  });
});

// --- set_track_flags (schema v4) -------------------------------------------

describe('set_track_flags', () => {
  it('sets only the provided flag, leaving clips and other flags untouched', () => {
    const before = baseTimeline();
    const after = applyOperation(before, {
      type: 'set_track_flags',
      trackId: 'audio_1',
      muted: true,
    });
    expect(track(after, 'audio_1').muted).toBe(true);
    expect(track(after, 'audio_1').locked).toBeUndefined();
    // Clips are never touched by a flag change.
    expect(track(after, 'audio_1').clips).toEqual(track(before, 'audio_1').clips);
  });

  it('round-trips: inverse restores the prior flag value', () => {
    const before = baseTimeline();
    expectRoundTrip(before, { type: 'set_track_flags', trackId: 'video_1', hidden: true });
  });

  it('round-trips when toggling a flag back off', () => {
    const hidden = applyOperation(baseTimeline(), {
      type: 'set_track_flags',
      trackId: 'video_1',
      hidden: true,
    });
    expectRoundTrip(hidden, { type: 'set_track_flags', trackId: 'video_1', hidden: false });
  });

  it('round-trips: locked flag', () => {
    expectRoundTrip(baseTimeline(), { type: 'set_track_flags', trackId: 'video_1', locked: true });
  });

  it('round-trips: muted flag', () => {
    expectRoundTrip(baseTimeline(), { type: 'set_track_flags', trackId: 'audio_1', muted: true });
  });

  it('round-trips: all three flags together', () => {
    expectRoundTrip(baseTimeline(), {
      type: 'set_track_flags',
      trackId: 'video_1',
      locked: true,
      hidden: false,
      muted: false,
    });
  });

  it('inverse uses existing flag value (not ?? false fallback) when flag is already set', () => {
    const locked = applyOperation(baseTimeline(), {
      type: 'set_track_flags',
      trackId: 'video_1',
      locked: true,
    });
    expectRoundTrip(locked, { type: 'set_track_flags', trackId: 'video_1', locked: false });
  });

  it('throws for a missing track', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'set_track_flags', trackId: 'ghost', locked: true }),
    ).toThrow(/Track not found/);
  });
});

// --- set_caption_style (schema v5) -----------------------------------------

describe('set_caption_style', () => {
  const captionTimeline = (): Timeline => ({
    tracks: [
      {
        id: 'caption_1',
        type: 'caption',
        clips: [
          clip({
            id: 'cap_a',
            trackId: 'caption_1',
            assetId: CAPTION_ASSET_ID,
            start: 0,
            end: 2,
            sourceStart: 0,
            sourceEnd: 2,
            effects: [{ id: 'cap_a__caption', type: 'caption', params: {}, keyframes: [] }],
          }),
        ],
      },
    ],
  });

  it('sets a caption style on the target clip, leaving other fields untouched', () => {
    const before = captionTimeline();
    const after = applyOperation(before, {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { fontFamily: 'Inter', fontScale: 1.5, position: 'bottom' },
    });
    expect(findClipById(after, 'cap_a')?.captionStyle).toEqual({
      fontFamily: 'Inter',
      fontScale: 1.5,
      position: 'bottom',
    });
    expect(findClipById(after, 'cap_a')?.effects).toEqual(findClipById(before, 'cap_a')?.effects);
  });

  it('round-trips: inverse restores the prior (absent) style', () => {
    expectRoundTrip(captionTimeline(), {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { textColor: '#ffffff', highlight: { enabled: true, animation: 'pop' } },
    });
  });

  it('round-trips: inverse restores a prior style when replacing it with another', () => {
    const styled = applyOperation(captionTimeline(), {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { templateId: 'clean' },
    });
    expectRoundTrip(styled, {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { templateId: 'bold-pop' },
    });
  });

  it('round-trips clearing an existing style back to unstyled (captionStyle: null)', () => {
    const styled = applyOperation(captionTimeline(), {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { templateId: 'clean' },
    });
    const cleared = expectRoundTrip(styled, {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: null,
    });
    expect(findClipById(cleared, 'cap_a')?.captionStyle).toBeUndefined();
  });

  it('throws for a missing clip id', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_caption_style',
        clipId: 'ghost',
        captionStyle: { templateId: 'clean' },
      }),
    ).toThrow(/Clip not found/);
  });

  it('throws OperationError(invalid_style) for an out-of-range style value', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_caption_style',
        clipId: 'cap_a',
        // fontScale must be positive per CaptionStyleSchema.
        captionStyle: { fontScale: -1 },
      }),
    ).toThrow(OperationError);
    try {
      applyOperation(captionTimeline(), {
        type: 'set_caption_style',
        clipId: 'cap_a',
        captionStyle: { fontScale: -1 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_style');
    }
  });

  it('throws OperationError(invalid_style) for an invalid highlight animation', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_caption_style',
        clipId: 'cap_a',
        captionStyle: { highlight: { animation: 'spin' as never } },
      }),
    ).toThrow(OperationError);
  });
});

// --- splitClipRightId -------------------------------------------------------

describe('splitClipRightId', () => {
  it('predicts the id split_clip actually gives the right-hand piece', () => {
    // This is the whole reason it is exported: a caller that follows a split
    // with an op targeting the new clip (splitting a caption cue, which must
    // then set each half's own text) would otherwise hard-code the formula and
    // break silently when it changes. Asserted against a REAL split so the
    // prediction cannot drift from the operation.
    const before = baseTimeline();
    const after = applyOperation(before, { type: 'split_clip', clipId: 'a', at: 4 });
    const ids = after.tracks.flatMap((t) => t.clips.map((c) => c.id));
    expect(ids).toContain(splitClipRightId('a', 4));
  });

  it('is stable and millisecond-quantized', () => {
    expect(splitClipRightId('cap_1', 3.25)).toBe('cap_1__split_3250');
    // Sub-millisecond jitter cannot produce two different ids for one split.
    expect(splitClipRightId('cap_1', 3.2501)).toBe(splitClipRightId('cap_1', 3.25));
  });
});

// --- set_caption_cue (schema v11, ADR 0071) --------------------------------

describe('set_caption_cue', () => {
  const captionTimeline = (): Timeline => ({
    tracks: [
      {
        id: 'caption_1',
        type: 'caption',
        clips: [
          clip({
            id: 'cap_a',
            trackId: 'caption_1',
            assetId: CAPTION_ASSET_ID,
            start: 0,
            end: 2,
            sourceStart: 0,
            sourceEnd: 2,
            effects: [{ id: 'cap_a__caption', type: 'caption', params: {}, keyframes: [] }],
          }),
        ],
      },
    ],
  });

  const cue = {
    text: 'we shipped it',
    words: [
      { word: 'we', start: 0.1, end: 0.3 },
      { word: 'shipped', start: 0.3, end: 0.8 },
      { word: 'it', start: 0.8, end: 1.0 },
    ],
  };

  it('sets a cue on the target clip, leaving other fields untouched', () => {
    const before = captionTimeline();
    const after = applyOperation(before, {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: cue,
    });
    expect(findClipById(after, 'cap_a')?.captionCue).toEqual(cue);
    expect(findClipById(after, 'cap_a')?.effects).toEqual(findClipById(before, 'cap_a')?.effects);
    expect(findClipById(after, 'cap_a')?.start).toBe(0);
    expect(findClipById(after, 'cap_a')?.end).toBe(2);
  });

  it('stores words: [] for a cue authored without timings, so it round-trips through the file', () => {
    // A hand-typed cue has no word timing. Persisting the schema default rather
    // than a missing key keeps the saved project stable across a load/save cycle.
    const after = applyOperation(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: { text: 'typed by hand' } as never,
    });
    expect(findClipById(after, 'cap_a')?.captionCue).toEqual({ text: 'typed by hand', words: [] });
  });

  it('keeps text that differs from its words — an edit, not a derivation', () => {
    // This is the whole point of v11: the cue displays what the editor typed,
    // not what the transcript says.
    const after = applyOperation(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: { text: 'we shipped it (sic)', words: cue.words },
    });
    expect(findClipById(after, 'cap_a')?.captionCue?.text).toBe('we shipped it (sic)');
  });

  it('preserves an explicit line break in the cue text', () => {
    const after = applyOperation(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: { text: 'we shipped\nit on Friday', words: [] },
    });
    expect(findClipById(after, 'cap_a')?.captionCue?.text).toBe('we shipped\nit on Friday');
  });

  it('round-trips: inverse restores the prior (absent) cue', () => {
    expectRoundTrip(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: cue,
    });
  });

  it('round-trips: inverse restores a prior cue when replacing it with another', () => {
    const withCue = applyOperation(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: cue,
    });
    expectRoundTrip(withCue, {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: { text: 'reworded entirely', words: [] },
    });
  });

  it('round-trips clearing a cue back to transcript-derived (captionCue: null)', () => {
    const withCue = applyOperation(captionTimeline(), {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: cue,
    });
    const cleared = expectRoundTrip(withCue, {
      type: 'set_caption_cue',
      clipId: 'cap_a',
      captionCue: null,
    });
    // Deleted, not stored as an empty cue: *absent* is what means "derive from
    // the transcript", which is the v10 fallback.
    expect(findClipById(cleared, 'cap_a')?.captionCue).toBeUndefined();
    expect('captionCue' in findClipById(cleared, 'cap_a')!).toBe(false);
  });

  it('throws for a missing clip id', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_caption_cue',
        clipId: 'ghost',
        captionCue: cue,
      }),
    ).toThrow(/Clip not found/);
  });

  it('throws OperationError(invalid_cue) for a cue with a negative word timestamp', () => {
    try {
      applyOperation(captionTimeline(), {
        type: 'set_caption_cue',
        clipId: 'cap_a',
        captionCue: { text: 'bad', words: [{ word: 'bad', start: -1, end: 0.5 }] },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_cue');
    }
  });

  it('throws OperationError(invalid_cue) for a cue missing its text', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_caption_cue',
        clipId: 'cap_a',
        captionCue: { words: [] } as never,
      }),
    ).toThrow(OperationError);
  });
});

// --- set_track_caption_style (schema v11, ADR 0071) ------------------------

describe('set_track_caption_style', () => {
  const captionTimeline = (): Timeline => ({
    tracks: [
      { id: 'video_1', type: 'video', clips: [] },
      {
        id: 'caption_1',
        type: 'caption',
        clips: [
          clip({
            id: 'cap_a',
            trackId: 'caption_1',
            assetId: CAPTION_ASSET_ID,
            start: 0,
            end: 2,
            sourceStart: 0,
            sourceEnd: 2,
          }),
        ],
      },
    ],
  });

  it('sets the track default without touching any clip', () => {
    const before = captionTimeline();
    const after = applyOperation(before, {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'hormozi' },
    });
    const track = after.tracks.find((t) => t.id === 'caption_1')!;
    expect(track.captionStyle).toEqual({ templateId: 'hormozi' });
    // One operation restyles every cue — that is the point (v10 needed one per cue).
    expect(track.clips).toEqual(before.tracks.find((t) => t.id === 'caption_1')!.clips);
  });

  it('leaves per-clip overrides in place — hand-tuned cues survive a restyle', () => {
    const tuned = applyOperation(captionTimeline(), {
      type: 'set_caption_style',
      clipId: 'cap_a',
      captionStyle: { textColor: '#ffd84d' },
    });
    const after = applyOperation(tuned, {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'hormozi' },
    });
    expect(findClipById(after, 'cap_a')?.captionStyle).toEqual({ textColor: '#ffd84d' });
  });

  it('does not touch other tracks', () => {
    const after = applyOperation(captionTimeline(), {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'hormozi' },
    });
    expect(after.tracks.find((t) => t.id === 'video_1')?.captionStyle).toBeUndefined();
  });

  it('round-trips: inverse restores the prior (absent) default', () => {
    expectRoundTrip(captionTimeline(), {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'karaoke', fontScale: 1.2 },
    });
  });

  it('round-trips: inverse restores a prior default when replacing it', () => {
    const styled = applyOperation(captionTimeline(), {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'karaoke' },
    });
    expectRoundTrip(styled, {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'boxed' },
    });
  });

  it('round-trips clearing the default (captionStyle: null), deleting the key', () => {
    const styled = applyOperation(captionTimeline(), {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: { templateId: 'karaoke' },
    });
    const cleared = expectRoundTrip(styled, {
      type: 'set_track_caption_style',
      trackId: 'caption_1',
      captionStyle: null,
    });
    const track = cleared.tracks.find((t) => t.id === 'caption_1')!;
    expect(track.captionStyle).toBeUndefined();
    expect('captionStyle' in track).toBe(false);
  });

  it('throws for a missing track id', () => {
    expect(() =>
      applyOperation(captionTimeline(), {
        type: 'set_track_caption_style',
        trackId: 'ghost',
        captionStyle: { templateId: 'karaoke' },
      }),
    ).toThrow(/Track not found/);
  });

  it('throws OperationError(invalid_style) for an out-of-range default', () => {
    try {
      applyOperation(captionTimeline(), {
        type: 'set_track_caption_style',
        trackId: 'caption_1',
        captionStyle: { fontScale: -1 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_style');
    }
  });
});

// --- set_clip_speed (schema v6, speed/time-remap) --------------------------

describe('set_clip_speed', () => {
  it('sets a 2x speed, halving the timeline duration while leaving the source range untouched', () => {
    const before = baseTimeline();
    const after = applyOperation(before, { type: 'set_clip_speed', clipId: 'a', speed: 2 });
    const clip = findClipById(after, 'a')!;
    expect(clip.speed).toBe(2);
    expect(clip.start).toBe(0);
    expect(clip.end).toBe(5); // sourceDuration (10) / speed (2)
    expect(clip.sourceStart).toBe(0);
    expect(clip.sourceEnd).toBe(10);
  });

  it('sets a 0.5x (slow-mo) speed, doubling the timeline duration', () => {
    const before = baseTimeline();
    const after = applyOperation(before, { type: 'set_clip_speed', clipId: 'a', speed: 0.5 });
    const clip = findClipById(after, 'a')!;
    expect(clip.speed).toBe(0.5);
    expect(clip.end).toBe(20); // sourceDuration (10) / speed (0.5)
  });

  it('resets to 1x via speed: null, deleting the field rather than storing speed: 1', () => {
    const sped = applyOperation(baseTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 2 });
    const reset = applyOperation(sped, { type: 'set_clip_speed', clipId: 'a', speed: null });
    const clip = findClipById(reset, 'a')!;
    expect(clip.speed).toBeUndefined();
    expect(clip.end).toBe(10);
  });

  it('resets to 1x via speed: 1 explicitly, same canonical (absent) result as null', () => {
    const sped = applyOperation(baseTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 2 });
    const reset = applyOperation(sped, { type: 'set_clip_speed', clipId: 'a', speed: 1 });
    expect(findClipById(reset, 'a')?.speed).toBeUndefined();
  });

  it('round-trips: inverse restores the prior (absent/1x) speed and end', () => {
    expectRoundTrip(baseTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 2 });
  });

  it('round-trips: inverse restores a prior non-1x speed when replacing it with another', () => {
    const sped = applyOperation(baseTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 2 });
    expectRoundTrip(sped, { type: 'set_clip_speed', clipId: 'a', speed: 0.25 });
  });

  it('round-trips clearing a speed back to 1x', () => {
    const sped = applyOperation(baseTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 4 });
    const cleared = expectRoundTrip(sped, { type: 'set_clip_speed', clipId: 'a', speed: null });
    expect(findClipById(cleared, 'a')?.speed).toBeUndefined();
  });

  it('throws for a missing clip id', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'set_clip_speed', clipId: 'ghost', speed: 2 }),
    ).toThrow(/Clip not found/);
  });

  it('accepts 0 as a FREEZE FRAME, keeping the span it already occupied', () => {
    // Schema v15 (ADR 0090) widened `speed` from strictly positive. A held frame's
    // length is set, not derived — there is no duration to compute from a division
    // by zero — so the clip keeps the timeline span it had rather than the op
    // inventing a number.
    const before = baseTimeline();
    const span = findClipById(before, 'a')!.end - findClipById(before, 'a')!.start;
    const frozen = applyOperation(before, { type: 'set_clip_speed', clipId: 'a', speed: 0 });
    const clip = findClipById(frozen, 'a')!;
    expect(clip.speed).toBe(0);
    expect(clip.end - clip.start).toBeCloseTo(span, 9);
  });

  it('accepts a NEGATIVE speed as reverse, using the magnitude for the duration', () => {
    // Reverse consumes the same footage backwards, which still takes positive
    // timeline time.
    const before = baseTimeline();
    const source = findClipById(before, 'a')!;
    const sourceSpan = source.sourceEnd - source.sourceStart;
    const reversed = applyOperation(before, { type: 'set_clip_speed', clipId: 'a', speed: -2 });
    const clip = findClipById(reversed, 'a')!;
    expect(clip.speed).toBe(-2);
    expect(clip.end - clip.start).toBeCloseTo(sourceSpan / 2, 9);
  });

  it('round-trips a freeze through restore_clips, not the same-shape inverse', () => {
    // At speed 0 there is no duration to recompute, so `set_clip_speed(0)` could not
    // restore the freeze's own span — the track snapshot is the established answer
    // for a lossy op here.
    const frozen = applyOperation(baseTimeline(), {
      type: 'set_clip_speed',
      clipId: 'a',
      speed: 0,
    });
    expectRoundTrip(frozen, { type: 'set_clip_speed', clipId: 'a', speed: 2 });
  });

  it('throws OperationError(invalid_speed) for a non-finite speed', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_speed',
        clipId: 'a',
        speed: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(OperationError);
  });
});

// --- set_clip_crop (schema v7, crop rect) -----------------------------------

describe('set_clip_crop', () => {
  it('sets a crop rect on the target clip, leaving other fields untouched', () => {
    const before = baseTimeline();
    const after = applyOperation(before, {
      type: 'set_clip_crop',
      clipId: 'a',
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    });
    expect(findClipById(after, 'a')?.crop).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    expect(findClipById(after, 'a')?.effects).toEqual(findClipById(before, 'a')?.effects);
    expect(findClipById(after, 'a')?.start).toBe(0);
    expect(findClipById(after, 'a')?.end).toBe(10);
  });

  it('round-trips: inverse restores the prior (absent) crop', () => {
    expectRoundTrip(baseTimeline(), {
      type: 'set_clip_crop',
      clipId: 'a',
      crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
    });
  });

  it('round-trips: inverse restores a prior crop when replacing it with another', () => {
    const cropped = applyOperation(baseTimeline(), {
      type: 'set_clip_crop',
      clipId: 'a',
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    expectRoundTrip(cropped, {
      type: 'set_clip_crop',
      clipId: 'a',
      crop: { x: 0.25, y: 0.25, width: 0.75, height: 0.75 },
    });
  });

  it('round-trips clearing an existing crop back to uncropped (crop: null)', () => {
    const cropped = applyOperation(baseTimeline(), {
      type: 'set_clip_crop',
      clipId: 'a',
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    const cleared = expectRoundTrip(cropped, { type: 'set_clip_crop', clipId: 'a', crop: null });
    expect(findClipById(cleared, 'a')?.crop).toBeUndefined();
  });

  it('throws for a missing clip id', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_crop',
        clipId: 'ghost',
        crop: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toThrow(/Clip not found/);
  });

  it('throws OperationError(invalid_crop) for an out-of-bounds crop rect', () => {
    try {
      applyOperation(baseTimeline(), {
        type: 'set_clip_crop',
        clipId: 'a',
        crop: { x: 0.6, y: 0, width: 0.6, height: 0.5 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_crop');
    }
  });

  it('throws OperationError(invalid_crop) for a zero-width crop rect', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_crop',
        clipId: 'a',
        crop: { x: 0, y: 0, width: 0, height: 0.5 },
      }),
    ).toThrow(OperationError);
  });

  it('throws OperationError(invalid_crop) for a negative-height crop rect', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_crop',
        clipId: 'a',
        crop: { x: 0, y: 0, width: 0.5, height: -0.1 },
      }),
    ).toThrow(OperationError);
  });
});

// --- set_clip_blend_mode (schema v8, compositing) ---------------------------

describe('set_clip_blend_mode', () => {
  it('sets a blend mode on the target clip, leaving other fields untouched', () => {
    const before = baseTimeline();
    const after = applyOperation(before, {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'multiply',
    });
    expect(findClipById(after, 'a')?.blendMode).toBe('multiply');
    expect(findClipById(after, 'a')?.effects).toEqual(findClipById(before, 'a')?.effects);
    expect(findClipById(after, 'a')?.start).toBe(0);
    expect(findClipById(after, 'a')?.end).toBe(10);
  });

  it('round-trips: inverse restores the prior (absent) blend mode', () => {
    expectRoundTrip(baseTimeline(), {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'screen',
    });
  });

  it('round-trips: inverse restores a prior blend mode when replacing it with another', () => {
    const blended = applyOperation(baseTimeline(), {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'darken',
    });
    expectRoundTrip(blended, {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'lighten',
    });
  });

  it('round-trips clearing an existing blend mode back to normal (blendMode: null)', () => {
    const blended = applyOperation(baseTimeline(), {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'overlay',
    });
    const cleared = expectRoundTrip(blended, {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: null,
    });
    expect(findClipById(cleared, 'a')?.blendMode).toBeUndefined();
  });

  it('canonicalizes an explicit "normal" the same as absent (deletes the field)', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'set_clip_blend_mode',
      clipId: 'a',
      blendMode: 'normal',
    });
    expect(findClipById(after, 'a')?.blendMode).toBeUndefined();
  });

  it('throws for a missing clip id', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'set_clip_blend_mode',
        clipId: 'ghost',
        blendMode: 'multiply',
      }),
    ).toThrow(/Clip not found/);
  });

  it('throws OperationError(invalid_blend_mode) for an unknown blend mode string', () => {
    try {
      applyOperation(baseTimeline(), {
        type: 'set_clip_blend_mode',
        clipId: 'a',
        // Intentionally invalid at the type level to exercise the defensive
        // runtime re-check (mirrors set_clip_crop/set_caption_style's own test).
        blendMode: 'not-a-real-mode' as never,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_blend_mode');
    }
  });
});

// --- add_layer / remove_layer (Phase 2) ------------------------------------

describe('add_layer / remove_layer', () => {
  it('inserts a layer at the front (index 0) and round-trips', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'add_layer',
      layerId: 'layer_x',
      layerType: 'video',
      atIndex: 0,
    });
    expect(after.tracks[0]!.id).toBe('layer_x');
    expect(after.tracks).toHaveLength(before.tracks.length + 1);
  });

  it('clamps an out-of-range index to append', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'add_layer',
      layerId: 'layer_end',
      layerType: 'audio',
      atIndex: 999,
    });
    expect(after.tracks[after.tracks.length - 1]!.id).toBe('layer_end');
  });

  it('throws on a duplicate layer id', () => {
    expect(() =>
      applyOperation(baseTimeline(), {
        type: 'add_layer',
        layerId: 'video_1',
        layerType: 'video',
        atIndex: 0,
      }),
    ).toThrow(/already exists/);
  });

  it('removes a non-empty layer losslessly (inverse restores clips + index)', () => {
    const before = baseTimeline();
    // audio_1 carries a clip — its inverse must restore the clip and the slot.
    expectRoundTrip(before, { type: 'remove_layer', layerId: 'audio_1' });
  });

  it('throws when removing a missing layer', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'remove_layer', layerId: 'ghost' }),
    ).toThrow(/Track not found/);
  });

  it('labels a new audio layer with the mix role its caller declared', () => {
    // `Track.role` is never *inferred* — guessing "Audio 2" is music mixes the
    // wrong thing. But a caller placing a fetched music bed knows, and until
    // now there was no way to say so: `duck_roles` read a label nothing wrote.
    const after = expectRoundTrip(baseTimeline(), {
      type: 'add_layer',
      layerId: 'music_1',
      layerType: 'audio',
      atIndex: 0,
      role: 'music',
    });
    expect(after.tracks[0]!.role).toBe('music');
  });

  it('leaves a layer unlabelled when no role was declared', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'add_layer',
      layerId: 'plain',
      layerType: 'audio',
      atIndex: 0,
    });
    expect(after.tracks[0]!.role).toBeUndefined();
  });

  it('restores the mix role when a labelled layer is deleted and undone', () => {
    // Without this the track came back unlabelled and `duck_roles` quietly
    // stopped finding the bed — a silent regression in a working mix.
    const withMusic = applyOperation(baseTimeline(), {
      type: 'add_layer',
      layerId: 'music_1',
      layerType: 'audio',
      atIndex: 0,
      role: 'music',
    });
    const restored = expectRoundTrip(withMusic, { type: 'remove_layer', layerId: 'music_1' });
    expect(restored.tracks.find((t) => t.id === 'music_1')).toBeUndefined();
  });
});

// --- move_layer (Phase 2) --------------------------------------------------

describe('move_layer', () => {
  it('reorders a layer to a new index and round-trips', () => {
    const before = baseTimeline();
    const after = expectRoundTrip(before, {
      type: 'move_layer',
      layerId: 'audio_1', // starts at index 1
      toIndex: 0, // move to the front
    });
    expect(after.tracks[0]!.id).toBe('audio_1');
    expect(after.tracks).toHaveLength(before.tracks.length);
    // Clips are never touched by a reorder.
    expect(after.tracks[0]!.clips).toEqual(before.tracks[1]!.clips);
  });

  it('clamps an out-of-range destination to the back', () => {
    const after = applyOperation(baseTimeline(), {
      type: 'move_layer',
      layerId: 'video_1',
      toIndex: 999,
    });
    expect(after.tracks[after.tracks.length - 1]!.id).toBe('video_1');
  });

  it('throws when moving a missing layer', () => {
    expect(() =>
      applyOperation(baseTimeline(), { type: 'move_layer', layerId: 'ghost', toIndex: 0 }),
    ).toThrow(/Track not found/);
  });
});

// --- set_clip_speed_ramp + speed-aware edge ops (schema v15, ADR 0090) -------

describe('set_clip_speed_ramp', () => {
  /** A 10s source range on a 10s timeline span — 1x, so a ramp visibly changes it. */
  const rampTimeline = (): Timeline => ({
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          clip({ id: 'a', trackId: 'video_1', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 }),
        ],
      },
    ],
  });

  const ramp = (rate: number) => [
    { id: 'p1', sourceTime: 0, rate, easing: 'linear' as const },
    { id: 'p2', sourceTime: 10, rate, easing: 'linear' as const },
  ];

  it('derives the timeline duration from the INTEGRAL of the reciprocal rate', () => {
    // A flat 2x curve must land on exactly what ADR 0046's division would give —
    // the constant case falling out of the integral is the whole design.
    const after = applyOperation(rampTimeline(), {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(2),
    });
    const a = findClipById(after, 'a')!;
    expect(a.end - a.start).toBeCloseTo(5, 6);
    expect(a.sourceEnd - a.sourceStart).toBe(10); // the source range is untouched
  });

  it('clears any constant speed, so a clip never stores two contradictory rates', () => {
    const sped = applyOperation(rampTimeline(), { type: 'set_clip_speed', clipId: 'a', speed: 4 });
    const ramped = applyOperation(sped, {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(2),
    });
    expect(findClipById(ramped, 'a')?.speed).toBeUndefined();
  });

  it('and set_clip_speed clears any ramp, for the same reason', () => {
    const ramped = applyOperation(rampTimeline(), {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(2),
    });
    const constant = applyOperation(ramped, { type: 'set_clip_speed', clipId: 'a', speed: 1 });
    expect(findClipById(constant, 'a')?.speedRamp).toBeUndefined();
  });

  it('rejects a non-positive rate rather than integrating to infinity', () => {
    expect(() =>
      applyOperation(rampTimeline(), {
        type: 'set_clip_speed_ramp',
        clipId: 'a',
        ramp: [{ id: 'p', sourceTime: 0, rate: 0, easing: 'linear' }],
      }),
    ).toThrow(OperationError);
  });

  it('round-trips, restoring a prior ramp rather than collapsing it to a constant', () => {
    // The shared inverse is what makes this work: a ramp undone through
    // `set_clip_speed` would come back as a constant rate — a silent loss.
    const ramped = applyOperation(rampTimeline(), {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(2),
    });
    // `expectRoundTrip` asserts apply → invert → original internally and returns
    // the APPLIED state, so the assertion here is on the new ramp; the restoration
    // of the prior 2x curve is what the helper itself proved.
    const applied = expectRoundTrip(ramped, {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(0.5),
    });
    expect(findClipById(applied, 'a')?.speedRamp?.[0]?.rate).toBe(0.5);
  });

  it('round-trips clearing a ramp back to constant speed', () => {
    const ramped = applyOperation(rampTimeline(), {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: ramp(2),
    });
    const cleared = expectRoundTrip(ramped, {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: null,
    });
    expect(findClipById(cleared, 'a')?.speedRamp).toBeUndefined();
  });
});

describe('edge ops are speed-aware (ADR 0046 known limitation, fixed in v15)', () => {
  /** A 2x clip: 10s of source in 5s of timeline. */
  const spedTimeline = (): Timeline => ({
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          clip({
            id: 'a',
            trackId: 'video_1',
            start: 0,
            end: 5,
            sourceStart: 0,
            sourceEnd: 10,
            speed: 2,
          }),
        ],
      },
    ],
  });

  it('trim_clip rescales the source delta by the speed', () => {
    // Before this, trimming a 2x clip moved source 1:1 and the resulting clip was
    // rejected by `speed_duration_mismatch` — an ordinary trim you could not do.
    const after = applyOperation(spedTimeline(), {
      type: 'trim_clip',
      clipId: 'a',
      start: 1,
      end: 4,
    });
    const a = findClipById(after, 'a')!;
    expect([a.start, a.end]).toEqual([1, 4]);
    // 1s of timeline at 2x consumes 2s of source, from both ends.
    expect([a.sourceStart, a.sourceEnd]).toEqual([2, 8]);
    expect(a.sourceEnd - a.sourceStart).toBeCloseTo((a.end - a.start) * 2, 9);
  });

  it('trim_clip still handles an EXTENSION, where the delta is negative', () => {
    const shifted: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({
              id: 'a',
              trackId: 'video_1',
              start: 5,
              end: 10,
              sourceStart: 4,
              sourceEnd: 14,
              speed: 2,
            }),
          ],
        },
      ],
    };
    const after = applyOperation(shifted, { type: 'trim_clip', clipId: 'a', start: 4, end: 10 });
    const a = findClipById(after, 'a')!;
    expect(a.sourceStart).toBeCloseTo(2, 9); // extended 1s at 2x → 2s more source
    expect(a.sourceEnd - a.sourceStart).toBeCloseTo((a.end - a.start) * 2, 9);
  });

  it('split_clip splits the source range through the speed, not linearly', () => {
    const after = applyOperation(spedTimeline(), { type: 'split_clip', clipId: 'a', at: 2 });
    const [left, right] = after.tracks[0]!.clips;
    expect(left!.sourceEnd).toBeCloseTo(4, 9); // 2s of timeline at 2x = 4s of source
    expect(right!.sourceStart).toBeCloseTo(4, 9);
    // Both halves stay internally consistent, which is what the validator checks.
    for (const half of [left!, right!]) {
      expect(half.sourceEnd - half.sourceStart).toBeCloseTo((half.end - half.start) * 2, 6);
    }
  });

  it('splits a RAMPED clip at the right frame, not at the linear midpoint', () => {
    // On a clip that starts slow and ends fast, halfway in TIME is nowhere near
    // halfway in FOOTAGE — a split placed on a gesture would otherwise cut
    // somewhere else entirely.
    // Built through the op so the clip's `end` is DERIVED from the curve. Writing
    // the ramp straight into the fixture would leave a clip whose stored duration
    // contradicts its own curve — which the validator rejects, and which would make
    // this test assert against a state the product can never reach.
    const ramped = applyOperation(
      {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              clip({
                id: 'a',
                trackId: 'video_1',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
              }),
            ],
          },
        ],
      },
      {
        type: 'set_clip_speed_ramp',
        clipId: 'a',
        ramp: [
          { id: 'p1', sourceTime: 0, rate: 0.5, easing: 'linear' },
          { id: 'p2', sourceTime: 10, rate: 4, easing: 'linear' },
        ],
      },
    );
    const total = findClipById(ramped, 'a')!;
    const after = applyOperation(ramped, {
      type: 'split_clip',
      clipId: 'a',
      at: (total.end - total.start) / 2,
    });
    const [left, right] = after.tracks[0]!.clips;
    // The slow half consumes far LESS than half the footage.
    expect(left!.sourceEnd - left!.sourceStart).toBeLessThan(5);
    // The two halves still account for exactly the whole source range.
    expect(left!.sourceStart).toBe(0);
    expect(right!.sourceEnd).toBeCloseTo(10, 6);
    expect(right!.sourceStart).toBeCloseTo(left!.sourceEnd, 9);
    // And the right half's ramp is RE-BASED — without which both halves would
    // carry the whole original curve and each render the wrong speeds.
    expect(right!.speedRamp?.[0]?.sourceTime).toBe(0);
    expect(right!.speedRamp?.[0]?.rate).toBeGreaterThan(0.5);
  });

  it('extends a RAMPED clip past its own footage span at the held end rate', () => {
    // Trimming isn't only shrinking — an edge can also stretch OUTWARD past where
    // the clip currently ends. Past the ramp's own source span there is no curve
    // left to consult, so the extension is priced at the rate held at that edge
    // (matching `rateAt`'s extrapolation rule), not by re-entering the integral.
    const tenSecondSource: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', trackId: 'video_1', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 }),
          ],
        },
      ],
    };
    const ramped = applyOperation(tenSecondSource, {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: [
        { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
        { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
      ],
    });
    const before = findClipById(ramped, 'a')!;
    expect(before.end - before.start).toBeCloseTo(5, 6); // 10s source / 2x
    const after = applyOperation(ramped, {
      type: 'trim_clip',
      clipId: 'a',
      start: before.start,
      end: before.end + 1, // 1s further than the ramp's own footage covers
    });
    const a = findClipById(after, 'a')!;
    // The whole 10s of source is already spent by `before.end`; the extra 1s of
    // timeline is priced at the rate held at the end of the curve (2x) — not
    // re-derived from the integral, which has nothing left to give.
    expect(a.sourceEnd).toBeCloseTo(10 + 1 * 2, 9);
  });

  it('extends a RAMPED clip backward past its own start, priced at the held start rate', () => {
    // The mirror of the tail extension above: pulling the HEAD earlier than the
    // clip's own start is a negative timeline delta, priced at the rate held at
    // source time 0 rather than through the (source-only, non-negative) integral.
    const tenSecondSource: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', trackId: 'video_1', start: 5, end: 15, sourceStart: 4, sourceEnd: 14 }),
          ],
        },
      ],
    };
    const ramped = applyOperation(tenSecondSource, {
      type: 'set_clip_speed_ramp',
      clipId: 'a',
      ramp: [
        { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
        { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
      ],
    });
    const before = findClipById(ramped, 'a')!;
    const after = applyOperation(ramped, {
      type: 'trim_clip',
      clipId: 'a',
      start: before.start - 1, // pull the head 1s earlier than the clip's own start
      end: before.end,
    });
    const a = findClipById(after, 'a')!;
    // 1s earlier at the held start rate (2x) reaches 2s before the clip's own source start.
    expect(a.sourceStart).toBeCloseTo(4 - 1 * 2, 9);
  });

  it("leaves a FREEZE frame's source range alone when trimmed", () => {
    // A held frame consumes no footage however long it is held; consuming source
    // proportionally would shrink the range to nothing and make a freeze
    // impossible to trim.
    const frozen: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({
              id: 'a',
              trackId: 'video_1',
              start: 0,
              end: 6,
              sourceStart: 3,
              sourceEnd: 3.04,
              speed: 0,
            }),
          ],
        },
      ],
    };
    const after = applyOperation(frozen, { type: 'trim_clip', clipId: 'a', start: 1, end: 4 });
    const a = findClipById(after, 'a')!;
    expect([a.start, a.end]).toEqual([1, 4]);
    expect([a.sourceStart, a.sourceEnd]).toEqual([3, 3.04]);
  });

  it("consumes a REVERSED clip's footage from the correct end", () => {
    // Trimming the timeline HEAD of a reversed clip consumes source from the
    // source END. Getting this backwards is invisible in the duration check and
    // obvious in the picture.
    const reversed: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({
              id: 'a',
              trackId: 'video_1',
              start: 0,
              end: 10,
              sourceStart: 0,
              sourceEnd: 10,
              speed: -1,
            }),
          ],
        },
      ],
    };
    const after = applyOperation(reversed, { type: 'trim_clip', clipId: 'a', start: 2, end: 10 });
    const a = findClipById(after, 'a')!;
    expect(a.sourceStart).toBe(0);
    expect(a.sourceEnd).toBe(8);
  });
});
