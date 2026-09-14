import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import {
  PLACEMENT_NOTE_MAX_CLIPS,
  currentPlacement,
  placementNote,
  unchangedNote,
} from './placement-note.js';

interface ClipSpec {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly speed?: number;
}

function project(tracks: Record<string, readonly ClipSpec[]>): Project {
  return {
    fps: 30,
    timeline: {
      revision: 1,
      tracks: Object.entries(tracks).map(([id, clips]) => ({
        id,
        type: 'video',
        clips: clips.map((clip) => ({ assetId: 'a1', trackId: id, ...clip })),
      })),
    },
  } as unknown as Project;
}

const clip = (
  id: string,
  start: number,
  end: number,
  sourceStart = start,
  sourceEnd = end,
): ClipSpec => ({
  id,
  start,
  end,
  sourceStart,
  sourceEnd,
});

describe('placementNote', () => {
  it('says where a trimmed clip now sits, id first, in sequence and source seconds', () => {
    const before = project({ v1: [clip('c1', 0, 5, 10, 15)] });
    const after = project({ v1: [clip('c1', 0, 3, 10, 13)] });
    const ops: AnyOperation[] = [{ type: 'trim_clip', clipId: 'c1', start: 0, end: 3 }];
    expect(placementNote(ops, before, after)).toBe(' · now: c1 on v1 0s–3s (src 10s–13s)');
  });

  it('lists a clip that only exists after the patch, even when the op did not name it', () => {
    const before = project({ v1: [clip('c1', 0, 5)] });
    const after = project({ v1: [clip('c1', 0, 2), clip('c1_b', 2, 5, 2, 5)] });
    const ops: AnyOperation[] = [{ type: 'split_clip', clipId: 'c1', at: 2 }];
    expect(placementNote(ops, before, after)).toBe(
      ' · now: c1 on v1 0s–2s (src 0s–2s); c1_b on v1 2s–5s (src 2s–5s)',
    );
  });

  it('names a removed clip and the track it left', () => {
    const before = project({ v1: [clip('c1', 0, 5), clip('c2', 5, 8)] });
    const after = project({ v1: [clip('c1', 0, 5)] });
    const ops: AnyOperation[] = [{ type: 'delete_range', trackId: 'v1', start: 5, end: 8 }];
    expect(placementNote(ops, before, after)).toBe(' · now: c2 removed from v1');
  });

  it('shows a move as the new track, and a speed change with its rate', () => {
    const before = project({ v1: [clip('c1', 0, 4, 0, 4)], v2: [] });
    const after = project({ v1: [], v2: [{ ...clip('c1', 10, 12, 0, 4), speed: 2 }] });
    const ops: AnyOperation[] = [{ type: 'move_clip', clipId: 'c1', toTrackId: 'v2', toStart: 10 }];
    expect(placementNote(ops, before, after)).toBe(' · now: c1 on v2 10s–12s (src 0s–4s, 2×)');
  });

  it('is silent for an edit that moved no clip, such as a grade', () => {
    const before = project({ v1: [clip('c1', 0, 5)] });
    const ops: AnyOperation[] = [
      {
        type: 'apply_color_grade',
        clipId: 'c1',
        effect: { id: 'fx', type: 'color', params: {}, keyframes: [] },
      } as unknown as AnyOperation,
    ];
    expect(placementNote(ops, before, before)).toBe('');
  });

  it('caps the list and counts the rest, so a caption pass cannot flood the log', () => {
    const many = Array.from({ length: PLACEMENT_NOTE_MAX_CLIPS + 5 }, (_, i) =>
      clip(`cue_${String(i)}`, i, i + 1),
    );
    const note = placementNote([], project({ cap: [] }), project({ cap: many }));
    expect(note.split(';')).toHaveLength(PLACEMENT_NOTE_MAX_CLIPS + 1);
    expect(note).toContain('…and 5 more');
    expect(note).not.toContain(`cue_${String(PLACEMENT_NOTE_MAX_CLIPS)} `);
  });

  it('rounds to the millisecond, never a float tail', () => {
    const before = project({ v1: [clip('c1', 0, 5)] });
    const after = project({ v1: [clip('c1', 0, 3.0333333333, 0, 3.0333333333)] });
    expect(placementNote([], before, after)).toBe(' · now: c1 on v1 0s–3.033s (src 0s–3.033s)');
  });
});

describe('unchangedNote', () => {
  it('states the value the clip already holds instead of telling the model to read it', () => {
    const working = project({ v1: [clip('c1', 3.033, 5.2, 12, 14.167)] });
    const ops: AnyOperation[] = [{ type: 'trim_clip', clipId: 'c1', start: 3.033, end: 5.2 }];
    const note = unchangedNote(ops, working);
    expect(note).toBe(
      ' — nothing moved: the project already holds this — c1 on v1 3.033s–5.2s (src 12s–14.167s). ' +
        'Set a different value, or go on to the next part of the request.',
    );
    expect(note).not.toMatch(/get_timeline|get_clips/);
  });

  it('keeps the plain sentence when the operations name no clip', () => {
    const working = project({ v1: [] });
    const ops: AnyOperation[] = [
      { type: 'set_track_flags', trackId: 'v1', muted: true } as unknown as AnyOperation,
    ];
    expect(unchangedNote(ops, working)).toBe(
      ' — nothing moved: the project already said exactly this. Set a different value, or go on to the next part of the request.',
    );
  });
});

describe('currentPlacement', () => {
  it('resolves clipIds batches and skips ids the project does not hold', () => {
    const working = project({ v1: [clip('c1', 0, 1), clip('c2', 1, 2)] });
    const ops: AnyOperation[] = [
      {
        type: 'reorder_clips',
        trackId: 'v1',
        clipIds: ['c2', 'c1', 'ghost'],
      } as unknown as AnyOperation,
    ];
    expect(currentPlacement(ops, working)).toBe(
      'c2 on v1 1s–2s (src 1s–2s); c1 on v1 0s–1s (src 0s–1s)',
    );
  });
});
