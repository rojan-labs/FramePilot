/**
 * Tests for the patch engine (PLAN §1.3): transactional apply, inverse patch,
 * revert, and timeline diff.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { PatchId } from '@framepilot/shared-types';
import { assertOperationContract } from './operation-contract.js';
import { applyOperation, invertOperation, type Operation } from './operations.js';
import {
  applyPatch,
  collapseClipSnapshots,
  diffTimeline,
  invertPatch,
  PatchError,
  revertPatch,
  structuredDiffTimeline,
  type Patch,
} from './patch.js';

const clip = (over: Partial<Clip> & Pick<Clip, 'id'>): Clip => ({
  trackId: 'video_1',
  assetId: 'asset_1',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

const timeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [clip({ id: 'a' }), clip({ id: 'b', start: 10, end: 20, sourceEnd: 10 })],
    },
    { id: 'overlay_1', type: 'overlay', clips: [] },
  ],
});

const patch = (operations: Patch['operations'], over: Partial<Patch> = {}): Patch => ({
  patchId: 'patch_1' as PatchId,
  createdBy: 'user',
  reason: 'test',
  operations,
  ...over,
});

describe('applyPatch', () => {
  it('applies operations in order', () => {
    const result = applyPatch(
      timeline(),
      patch([
        { type: 'trim_clip', clipId: 'a', start: 0, end: 5 },
        {
          type: 'add_text_overlay',
          trackId: 'overlay_1',
          text: 'hi',
          start: 1,
          end: 2,
          clipId: 't',
        },
      ]),
    );
    expect(result.tracks[0]!.clips[0]!.end).toBe(5);
    expect(result.tracks[1]!.clips).toHaveLength(1);
  });

  it('is all-or-nothing: a mid-patch failure leaves the input untouched', () => {
    const before = timeline();
    const snapshot = structuredClone(before);
    const bad = patch([
      { type: 'trim_clip', clipId: 'a', start: 0, end: 5 },
      { type: 'trim_clip', clipId: 'ghost', start: 0, end: 5 }, // fails
    ]);
    expect(() => applyPatch(before, bad)).toThrow(PatchError);
    expect(before).toEqual(snapshot);
  });

  it('PatchError reports the failing operation index', () => {
    try {
      applyPatch(timeline(), patch([{ type: 'trim_clip', clipId: 'ghost', start: 0, end: 5 }]));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      expect((e as PatchError).operationIndex).toBe(0);
      expect((e as PatchError).patchId).toBe('patch_1');
    }
  });

  it('wraps non-Error causes', () => {
    // applyOperation only throws OperationError; simulate via a hand-built check
    // by forcing a known failure and asserting the message survives.
    const err = new PatchError('p' as PatchId, 2, 'raw string cause');
    expect(err.message).toContain('raw string cause');
    expect(err.message).toContain('operation 2');
  });
});

describe('invertPatch / revertPatch', () => {
  it('round-trips a multi-op patch back to the original timeline', () => {
    const before = timeline();
    const p = patch([
      { type: 'split_clip', clipId: 'a', at: 4 },
      { type: 'ripple_delete', trackId: 'video_1', start: 0, end: 2 },
      { type: 'add_caption_layer', trackId: 'overlay_1', start: 1, end: 3, clipId: 'c' },
    ]);
    const after = applyPatch(before, p);
    const inverse = invertPatch(before, p);
    // Content round-trips; `revision` is a monotonic staleness marker (ADR 0076).
    expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
  });

  it('names the inverse patch after the original', () => {
    const inverse = invertPatch(
      timeline(),
      patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]),
    );
    expect(inverse.patchId).toBe('patch_1__inverse');
    expect(inverse.reason).toBe('Revert: test');
  });

  // The inverse of a lossy op is a whole-track snapshot, so a patch touching one
  // track N times used to store N of them — quadratic, and the source of a 115 MB
  // history entry for a single caption pass. These pin the collapse: it must shrink
  // the inverse and must never change what undo produces.
  describe('whole-track snapshot collapse', () => {
    const captionTimeline = (cues: number): Timeline => ({
      tracks: [
        {
          id: 'cap_1',
          type: 'caption',
          clips: Array.from({ length: cues }, (_, i) =>
            clip({ id: `c${String(i)}`, trackId: 'cap_1', start: i, end: i + 1, sourceEnd: 1 }),
          ),
        },
        { id: 'video_1', type: 'video', clips: [clip({ id: 'a' })] },
      ],
    });

    it('stores one snapshot per track instead of one per operation', () => {
      const before = captionTimeline(40);
      // Rewrite every cue: delete it, re-add it, restyle it — the real shape of
      // "generate captions", which produces a restore_clips per delete AND per add.
      const p = patch(
        Array.from({ length: 20 }, (_, i) => [
          { type: 'delete_range' as const, trackId: 'cap_1', start: i, end: i + 1 },
          {
            type: 'add_caption_layer' as const,
            trackId: 'cap_1',
            start: i,
            end: i + 1,
            clipId: `new${String(i)}`,
          },
        ]).flat(),
      );
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);

      const snapshots = inverse.operations.filter((o) => o.type === 'restore_clips');
      expect(snapshots).toHaveLength(1);
      // …and it is still an exact undo.
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });

    it('is exact for a patch spanning several tracks', () => {
      const before = captionTimeline(12);
      const p = patch([
        { type: 'delete_range', trackId: 'cap_1', start: 0, end: 1 },
        { type: 'split_clip', clipId: 'a', at: 4 },
        { type: 'delete_range', trackId: 'cap_1', start: 2, end: 3 },
        { type: 'set_track_caption_style', trackId: 'cap_1', captionStyle: { fontSize: 42 } },
        { type: 'delete_range', trackId: 'video_1', start: 6, end: 7 },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
      // One per touched track — not one per operation.
      expect(inverse.operations.filter((o) => o.type === 'restore_clips')).toHaveLength(2);
    });

    it('keeps track-level state that a clip snapshot cannot carry', () => {
      const before = captionTimeline(6);
      const p = patch([
        { type: 'set_track_caption_style', trackId: 'cap_1', captionStyle: { fontSize: 99 } },
        { type: 'delete_range', trackId: 'cap_1', start: 0, end: 1 },
        { type: 'set_track_flags', trackId: 'cap_1', locked: true },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);
      // restore_clips replaces clips only, so the style/flags inverses must survive.
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });

    it('leaves a patch with no snapshots untouched', () => {
      const before = timeline();
      const p = patch([{ type: 'trim_clip', clipId: 'a', start: 0, end: 5 }]);
      const inverse = invertPatch(before, p);
      expect(inverse.operations).toEqual([{ type: 'trim_clip', clipId: 'a', start: 0, end: 10 }]);
    });

    // The collapse decides, per operation, whether a whole-track snapshot makes it
    // redundant. A wrong call there corrupts undo silently, and hand-written cases
    // only cover the shapes we thought of — so randomise the shapes. Fixed seed, so
    // a failure is reproducible rather than flaky.
    it('never changes what an inverse does, across randomised patches', () => {
      let seed = 12_345;
      const rnd = (): number => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

      const fuzzTimeline = (): Timeline => ({
        tracks: [
          {
            id: 'cap_1',
            type: 'caption',
            clips: Array.from({ length: 6 }, (_, i) =>
              clip({
                id: `cap_c${String(i)}`,
                trackId: 'cap_1',
                start: i * 2,
                end: i * 2 + 2,
                sourceEnd: 2,
              }),
            ),
          },
          {
            id: 'video_1',
            type: 'video',
            clips: Array.from({ length: 4 }, (_, i) =>
              clip({
                id: `vid_c${String(i)}`,
                trackId: 'video_1',
                start: i * 2,
                end: i * 2 + 2,
                sourceEnd: 2,
              }),
            ),
          },
          { id: 'ov_1', type: 'overlay', clips: [] },
        ],
      });

      let collapsesExercised = 0;
      for (let trial = 0; trial < 60; trial += 1) {
        const before = fuzzTimeline();
        let working = before;
        const ops: Operation[] = [];
        for (let i = 0; i < 25; i += 1) {
          const all = working.tracks.flatMap((t) => t.clips.map((c) => ({ c, t })));
          if (all.length === 0) break;
          const { c, t } = pick(all);
          const track = pick(working.tracks);
          const op = pick<Operation>([
            { type: 'trim_clip', clipId: c.id, start: c.start, end: c.start + 1 },
            { type: 'delete_range', trackId: track.id, start: c.start, end: c.end },
            { type: 'split_clip', clipId: c.id, at: (c.start + c.end) / 2 },
            {
              type: 'add_caption_layer',
              trackId: 'cap_1',
              start: 40 + i,
              end: 41 + i,
              clipId: `gen${String(trial)}_${String(i)}`,
            },
            { type: 'set_caption_cue', clipId: c.id, captionCue: { text: `t${String(i)}` } },
            {
              type: 'set_track_caption_style',
              trackId: 'cap_1',
              captionStyle: { fontSize: 10 + i },
            },
            { type: 'set_track_flags', trackId: track.id, locked: rnd() > 0.5 },
            { type: 'set_clip_blend_mode', clipId: c.id, blendMode: 'screen' },
            { type: 'ripple_delete', trackId: t.id, start: c.start, end: c.end },
            { type: 'move_clip', clipId: c.id, toTrackId: t.id, toStart: Math.floor(rnd() * 12) },
          ]);
          // Keep only operations that legitimately apply to the running state.
          // The generator has to use the same gate `applyPatch` does — the
          // semantic contract (locked tracks, ranges, value domains) is part of
          // "legitimately applies", and skipping it here would build patches the
          // patch authority rightly rejects (e.g. editing a track a previous
          // random `set_track_flags` just locked).
          try {
            assertOperationContract(working, op);
            const next = applyOperation(working, op);
            ops.push(op);
            working = next;
          } catch {
            /* invalid for this state — skip */
          }
        }
        if (ops.length === 0) continue;

        const p = patch(ops);
        const after = applyPatch(before, p);
        const collapsed = invertPatch(before, p);

        // The inverse exactly as it was generated, before any collapse.
        let replay = before;
        const raw: Operation[] = [];
        for (const op of ops) {
          raw.unshift(...invertOperation(replay, op));
          replay = applyOperation(replay, op);
        }
        if (collapsed.operations.length < raw.length) collapsesExercised += 1;

        // `revision` is a monotonic staleness counter bumped per applied op, so a
        // shorter inverse advances it less; both move FORWARD, so staleness compares
        // identically (ADR 0076). Content is what must match.
        const viaCollapsed = { ...revertPatch(after, collapsed), revision: 0 };
        const viaRaw = { ...revertPatch(after, { ...collapsed, operations: raw }), revision: 0 };
        expect(viaCollapsed).toEqual(viaRaw);
        expect(viaCollapsed).toEqual({ ...before, revision: 0 });
      }
      // Guard the guard: a generator that stopped producing collapsible patches
      // would pass vacuously.
      expect(collapsesExercised).toBeGreaterThan(10);
    });

    it('keeps the snapshot of a track the patch deletes, and collapses the rest', () => {
      const before = captionTimeline(6);
      const p = patch([
        { type: 'delete_range', trackId: 'cap_1', start: 0, end: 2 },
        { type: 'remove_layer', layerId: 'cap_1' },
        { type: 'delete_range', trackId: 'video_1', start: 0, end: 2 },
        { type: 'delete_range', trackId: 'video_1', start: 4, end: 6 },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);

      // cap_1 is gone from `after`, so its lifecycle inverse (add_layer) and its
      // snapshot must both survive; only the surviving track's snapshots collapse.
      expect(inverse.operations.filter((o) => o.type === 'add_layer')).toHaveLength(1);
      expect(
        inverse.operations.filter((o) => o.type === 'restore_clips' && o.trackId === 'cap_1'),
      ).toHaveLength(1);
      expect(
        inverse.operations.filter((o) => o.type === 'restore_clips' && o.trackId === 'video_1'),
      ).toHaveLength(1);
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });

    it('refuses to collapse when the patch removes and re-adds the same track id', () => {
      const before = captionTimeline(6);
      // cap_1 exists on both sides, so it looks collapsible — but its clips only
      // survive because the inverse re-creates the layer, which the appended
      // snapshot would fight.
      const p = patch([
        { type: 'delete_range', trackId: 'cap_1', start: 0, end: 2 },
        { type: 'remove_layer', layerId: 'cap_1' },
        { type: 'add_layer', layerId: 'cap_1', layerType: 'caption', atIndex: 0 },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);

      expect(inverse.operations.filter((o) => o.type === 'remove_layer')).toHaveLength(1);
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });

    it('refuses to collapse a cross-track move that straddles the boundary', () => {
      const before: Timeline = {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [clip({ id: 'a' }), clip({ id: 'b', start: 10, end: 20, sourceEnd: 10 })],
          },
          { id: 'video_2', type: 'video', clips: [clip({ id: 'c', trackId: 'video_2' })] },
        ],
      };
      // video_2 gets a snapshot; video_1 does not. The moved clip writes both, so
      // the snapshot alone cannot undo it.
      const p = patch([
        { type: 'delete_range', trackId: 'video_2', start: 0, end: 2 },
        { type: 'move_clip', clipId: 'a', toTrackId: 'video_2', toStart: 20 },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);

      expect(inverse.operations.filter((o) => o.type === 'move_clip')).toHaveLength(1);
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });

    // No operation inverts to a track-addressed op the collapse cannot classify
    // today, so this guard is only reachable directly. It is what makes adding a
    // new operation safe: an inverse the collapse does not understand keeps the
    // exact inverse instead of being silently dropped.
    it('refuses to collapse an inverse op it cannot classify', () => {
      const before = timeline();
      const collapsed = collapseClipSnapshots(before, before, [
        { type: 'delete_range', trackId: 'video_1', start: 0, end: 1 },
        { type: 'restore_clips', trackId: 'video_1', clips: [] },
      ]);
      expect(collapsed).toBeNull();
    });

    it('refuses to collapse a track the patch itself creates', () => {
      const before = timeline();
      const p = patch([
        { type: 'add_layer', layerId: 'cap_new', layerType: 'caption', atIndex: 0 },
        {
          type: 'add_caption_layer',
          trackId: 'cap_new',
          start: 0,
          end: 1,
          clipId: 'x',
        },
      ]);
      const after = applyPatch(before, p);
      const inverse = invertPatch(before, p);
      expect({ ...revertPatch(after, inverse), revision: before.revision }).toEqual(before);
    });
  });
});

describe('diffTimeline', () => {
  it('reports added, removed, and modified clips per track', () => {
    const before = timeline();
    const after = applyPatch(
      before,
      patch([
        { type: 'trim_clip', clipId: 'a', start: 0, end: 5 },
        { type: 'delete_range', trackId: 'video_1', start: 10, end: 20 },
        {
          type: 'add_text_overlay',
          trackId: 'overlay_1',
          text: 'hi',
          start: 1,
          end: 2,
          clipId: 't',
        },
      ]),
    );
    const diff = diffTimeline(before, after);
    expect(diff.summary).toEqual(
      expect.arrayContaining([
        expect.stringContaining('~ clip a'),
        expect.stringContaining('- clip b'),
        expect.stringContaining('+ clip t'),
      ]),
    );
  });

  it('reports "no changes" for identical timelines', () => {
    const t = timeline();
    expect(diffTimeline(t, t).summary).toEqual(['no changes']);
  });

  it('reports added and removed tracks', () => {
    const before: Timeline = { tracks: [{ id: 'video_1', type: 'video', clips: [] }] };
    const after: Timeline = {
      tracks: [{ id: 'audio_1', type: 'audio', clips: [clip({ id: 'x' })] }],
    };
    const diff = diffTimeline(before, after);
    expect(diff.summary).toEqual(
      expect.arrayContaining([
        expect.stringContaining('track audio_1 added'),
        expect.stringContaining('track video_1 removed'),
      ]),
    );
  });
});

describe('structuredDiffTimeline', () => {
  it('reports an added clip with a null beforeRange', () => {
    const before: Timeline = { tracks: [{ id: 'video_1', type: 'video', clips: [] }] };
    const after: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 5 })] }],
    };
    expect(structuredDiffTimeline(before, after)).toEqual([
      {
        trackId: 'video_1',
        clipId: 'a',
        kind: 'added',
        beforeRange: null,
        afterRange: { start: 0, end: 5 },
      },
    ]);
  });

  it('reports a removed clip with a null afterRange', () => {
    const before: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 5 })] }],
    };
    const after: Timeline = { tracks: [{ id: 'video_1', type: 'video', clips: [] }] };
    expect(structuredDiffTimeline(before, after)).toEqual([
      {
        trackId: 'video_1',
        clipId: 'a',
        kind: 'removed',
        beforeRange: { start: 0, end: 5 },
        afterRange: null,
      },
    ]);
  });

  it('reports a modified clip with both ranges', () => {
    const before: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 10 })] }],
    };
    const after: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 5 })] }],
    };
    expect(structuredDiffTimeline(before, after)).toEqual([
      {
        trackId: 'video_1',
        clipId: 'a',
        kind: 'modified',
        beforeRange: { start: 0, end: 10 },
        afterRange: { start: 0, end: 5 },
      },
    ]);
  });

  it('returns no regions for identical timelines', () => {
    const t = timeline();
    expect(structuredDiffTimeline(t, t)).toEqual([]);
  });

  it('tags regions with their own trackId across multiple tracks, ordered by track then position', () => {
    const before: Timeline = {
      tracks: [
        { id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 10, end: 20 })] },
        { id: 'audio_1', type: 'audio', clips: [clip({ id: 'x', start: 0, end: 3 })] },
      ],
    };
    const after: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'b', start: 0, end: 2 }), clip({ id: 'a', start: 10, end: 15 })],
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    };

    const regions = structuredDiffTimeline(before, after);

    expect(regions).toEqual([
      {
        trackId: 'video_1',
        clipId: 'b',
        kind: 'added',
        beforeRange: null,
        afterRange: { start: 0, end: 2 },
      },
      {
        trackId: 'video_1',
        clipId: 'a',
        kind: 'modified',
        beforeRange: { start: 10, end: 20 },
        afterRange: { start: 10, end: 15 },
      },
      {
        trackId: 'audio_1',
        clipId: 'x',
        kind: 'removed',
        beforeRange: { start: 0, end: 3 },
        afterRange: null,
      },
    ]);
  });

  it('sorts a removed clip against a same-track added clip by position', () => {
    const before: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'old', start: 20, end: 25 })],
        },
      ],
    };
    const after: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'new', start: 0, end: 5 })],
        },
      ],
    };

    const regions = structuredDiffTimeline(before, after);
    expect(regions.map((r) => r.clipId)).toEqual(['new', 'old']);
  });

  it('reports clips on a track that only exists in after (no before track to look up)', () => {
    const before: Timeline = { tracks: [] };
    const after: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 5 })] }],
    };

    expect(structuredDiffTimeline(before, after)).toEqual([
      {
        trackId: 'video_1',
        clipId: 'a',
        kind: 'added',
        beforeRange: null,
        afterRange: { start: 0, end: 5 },
      },
    ]);
  });

  it('orders a removed track after tracks kept in after, per removed-clip position', () => {
    const before: Timeline = {
      tracks: [
        { id: 'video_1', type: 'video', clips: [] },
        { id: 'overlay_1', type: 'overlay', clips: [clip({ id: 'c', start: 1, end: 2 })] },
      ],
    };
    const after: Timeline = {
      tracks: [{ id: 'video_1', type: 'video', clips: [clip({ id: 'a', start: 0, end: 5 })] }],
    };

    const regions = structuredDiffTimeline(before, after);

    expect(regions.map((r) => r.trackId)).toEqual(['video_1', 'overlay_1']);
    expect(regions[1]).toEqual({
      trackId: 'overlay_1',
      clipId: 'c',
      kind: 'removed',
      beforeRange: { start: 1, end: 2 },
      afterRange: null,
    });
  });
});
