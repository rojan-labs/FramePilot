/**
 * Tests for the beat-grid boundary rule. Each case pins one of the three failures the old
 * private assertion produced on a real "cut on every drum hit" run: an unsatisfiable music
 * bed / sequence tail, silent non-enforcement when the bed was placed by the same proposal,
 * and reject-only handling of a near-miss.
 */
import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import { makeProject } from '../../__fixtures__/project.js';
import { SNAP_WINDOW_SECONDS, alignBeatBackedBoundaries } from './beat-alignment.js';

/** A grid with uneven spacing, so "nearest onset" is never ambiguous by symmetry. */
const GRID = [0.5, 1.25, 2.0, 3.1, 4.4];

/** `{ assetId, beats: [{ time }] }` — the raw `detect_beats` payload shape. */
function rawBeats(assetId: string, times: readonly number[]): unknown {
  return { assetId, beats: times.map((time) => ({ time })), bpm: 120 };
}

function addClip(over: Partial<Extract<AnyOperation, { type: 'add_clip' }>> = {}): AnyOperation {
  return {
    type: 'add_clip',
    trackId: 'video_1',
    assetId: 'asset_1',
    start: 0.5,
    end: 1.25,
    sourceStart: 0,
    sourceEnd: 0.75,
    ...over,
  } as AnyOperation;
}

describe('alignBeatBackedBoundaries', () => {
  it('accepts interior cuts that already sit exactly on detected onsets', () => {
    const operations = [
      addClip({ start: 0.5, end: 1.25, sourceStart: 0, sourceEnd: 0.75 }),
      addClip({ start: 1.25, end: 2.0, sourceStart: 3, sourceEnd: 3.75 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result).toMatchObject({ ok: true, snapped: 0 });
  });

  it('exempts an audio bed whose end can never be an onset (the old "off-grid: 30")', () => {
    const operations = [
      addClip({ trackId: 'audio_1', assetId: 'asset_1', start: 0, end: 30, sourceEnd: 30 }),
      addClip({ start: 0.5, end: 1.25, sourceStart: 0, sourceEnd: 0.75 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(true);
  });

  it('exempts the sequence tail past the last onset, so a montage can fill the music', () => {
    const operations = [
      addClip({ start: 0.5, end: 1.25, sourceStart: 0, sourceEnd: 0.75 }),
      addClip({ start: 1.25, end: 5.0, sourceStart: 2, sourceEnd: 5.75 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(true);
  });

  it('exempts an opening before the first onset', () => {
    const operations = [
      addClip({ start: 0, end: 0.5, sourceStart: 0, sourceEnd: 0.5 }),
      addClip({ start: 0.5, end: 1.25, sourceStart: 1, sourceEnd: 1.75 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(true);
  });

  it('still checks a head/tail that lands inside the grid range (a lone clip cannot opt out)', () => {
    const operations = [addClip({ start: 0.9, end: 2.0, sourceStart: 0, sourceEnd: 1.1 })];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('0.900');
    expect(result.error).toContain('1.250');
  });

  it('snaps a near-miss onto the real onset and keeps the source window consistent', () => {
    const drift = SNAP_WINDOW_SECONDS / 2;
    const operations = [
      addClip({ start: 0.5, end: 1.25 + drift, sourceStart: 0, sourceEnd: 0.75 + drift }),
      addClip({ start: 1.25 + drift, end: 2.0, sourceStart: 4, sourceEnd: 4.75 - drift }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result).toMatchObject({ ok: true, snapped: 2 });
    if (!result.ok) return;
    const [first, second] = result.operations as Extract<AnyOperation, { type: 'add_clip' }>[];
    // Both sides of the shared boundary land on the same onset, so the cut stays continuous.
    expect(first!.end).toBe(1.25);
    expect(second!.start).toBe(1.25);
    // sourceEnd follows the timeline span: a snap must not silently change clip speed.
    expect(first!.sourceEnd).toBeCloseTo(first!.sourceStart + (first!.end - first!.start), 10);
    expect(second!.sourceEnd).toBeCloseTo(second!.sourceStart + (second!.end - second!.start), 10);
  });

  it('rejects a boundary with no onset nearby and names the nearest legal onset', () => {
    const operations = [
      addClip({ start: 0.5, end: 1.25, sourceStart: 0, sourceEnd: 0.75 }),
      addClip({ start: 1.25, end: 2.6, sourceStart: 2, sourceEnd: 3.35 }),
      addClip({ start: 2.6, end: 4.4, sourceStart: 5, sourceEnd: 6.8 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('2.600');
    expect(result.error).toContain('nearest detected onset 3.100');
  });

  it('holds split_clip and trim_clip cut points to the grid too', () => {
    const split: AnyOperation = { type: 'split_clip', clipId: 'clip_a', at: 2.6 };
    const result = alignBeatBackedBoundaries(makeProject(), [split], GRID, undefined);
    expect(result.ok).toBe(false);

    const trim: AnyOperation = { type: 'trim_clip', clipId: 'clip_a', start: 0.5, end: 2.6 };
    const trimmed = alignBeatBackedBoundaries(makeProject(), [trim], GRID, undefined);
    expect(trimmed.ok).toBe(false);
  });

  it('snaps a near-miss split point too (a cut point has no source window to keep)', () => {
    const split: AnyOperation = { type: 'split_clip', clipId: 'clip_a', at: 2.0 + 0.03 };
    const result = alignBeatBackedBoundaries(makeProject(), [split], GRID, undefined);
    expect(result).toMatchObject({ ok: true, snapped: 1 });
    if (!result.ok) return;
    expect(result.operations[0]).toMatchObject({ type: 'split_clip', at: 2.0 });
  });

  it('never checks caption or audio clip boundaries', () => {
    const project = makeProject({
      timeline: {
        tracks: [
          { id: 'audio_1', type: 'audio', clips: [] },
          { id: 'caption_1', type: 'caption', clips: [] },
        ],
      },
    } as never);
    const operations = [
      addClip({ trackId: 'audio_1', start: 0.13, end: 29.7, sourceEnd: 29.57 }),
      addClip({ trackId: 'caption_1', start: 0.42, end: 1.9, sourceEnd: 1.48 }),
    ];
    expect(alignBeatBackedBoundaries(project, operations, GRID, undefined).ok).toBe(true);
  });

  describe('when the analyzed asset is not on the timeline yet', () => {
    it('recovers the grid from a music placement in the SAME proposal (no silent pass)', () => {
      // The bed starts at 10s with a 2s source trim, so a source onset at 3.0 is at 11.0.
      const operations = [
        addClip({
          trackId: 'audio_1',
          assetId: 'music_1',
          start: 10,
          end: 20,
          sourceStart: 2,
          sourceEnd: 12,
        }),
        addClip({ start: 11.0, end: 12.5, sourceStart: 0, sourceEnd: 1.5 }),
      ];
      const beats = rawBeats('music_1', [3.0, 4.5, 6.0]);
      const result = alignBeatBackedBoundaries(makeProject(), operations, undefined, beats);
      expect(result.ok).toBe(true);

      const offGrid = [operations[0]!, addClip({ start: 11.0, end: 13.9, sourceEnd: 2.9 })];
      const rejected = alignBeatBackedBoundaries(makeProject(), offGrid, undefined, beats);
      expect(rejected.ok).toBe(false);
    });

    it('rejects an ungrounded montage when nothing places the analyzed asset', () => {
      const operations = [addClip({ start: 0.4, end: 1.9, sourceEnd: 1.5 })];
      const beats = rawBeats('music_1', [3.0, 4.5]);
      const result = alignBeatBackedBoundaries(makeProject(), operations, undefined, beats);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('music_1');
      expect(result.error).toContain('not on the timeline');
    });
  });

  it('holds nobody to a grid when beat detection returned nothing usable', () => {
    const operations = [addClip({ start: 0.4, end: 1.9, sourceEnd: 1.5 })];
    expect(alignBeatBackedBoundaries(makeProject(), operations, [], { beats: [] }).ok).toBe(true);
    expect(alignBeatBackedBoundaries(makeProject(), operations, undefined, undefined).ok).toBe(
      true,
    );
  });

  it('rejects a snap that would collapse a clip below one frame', () => {
    // 1.25 and 1.26 both snap to the onset at 1.25, which would leave a zero-length clip.
    const operations = [
      addClip({ start: 0.5, end: 1.25, sourceStart: 0, sourceEnd: 0.75 }),
      addClip({ start: 1.25, end: 1.26, sourceStart: 2, sourceEnd: 2.01 }),
      addClip({ start: 1.26, end: 2.0, sourceStart: 5, sourceEnd: 5.74 }),
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('shorter than one frame');
  });

  it('never checks a trim or split of an audio clip', () => {
    const project = makeProject({
      timeline: {
        tracks: [
          {
            id: 'audio_1',
            type: 'audio',
            clips: [
              {
                id: 'music_clip',
                assetId: 'asset_1',
                trackId: 'audio_1',
                start: 0,
                end: 30,
                sourceStart: 0,
                sourceEnd: 30,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    } as never);
    const operations: AnyOperation[] = [
      { type: 'trim_clip', clipId: 'music_clip', start: 0.13, end: 29.7 },
      { type: 'split_clip', clipId: 'music_clip', at: 7.77 },
    ];
    expect(alignBeatBackedBoundaries(project, operations, GRID, undefined).ok).toBe(true);
  });

  it('summarises the tail of a long off-grid list instead of dumping every miss', () => {
    const operations = Array.from({ length: 8 }, (_, index) =>
      addClip({
        start: 0.5 + index * 0.37,
        end: 0.5 + (index + 1) * 0.37,
        sourceStart: index,
        sourceEnd: index + 0.37,
      }),
    );
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/plus \d+ more/);
  });

  it('ignores onsets that fall outside the proposed placement’s trimmed source window', () => {
    const bed = addClip({
      trackId: 'audio_1',
      assetId: 'music_1',
      start: 10,
      end: 20,
      sourceStart: 2,
      sourceEnd: 12,
    });
    // 0.5 is before the trim point and 40 is past the clip's end: neither lands on the
    // timeline, so the grid is just the two onsets that do (11.0 and 12.5).
    const beats = rawBeats('music_1', [0.5, 3.0, 4.5, 40]);
    const picture = [
      addClip({ start: 11.0, end: 12.5, sourceEnd: 1.5 }),
      addClip({ start: 12.5, end: 14.0, sourceStart: 5, sourceEnd: 6.5 }),
    ];
    expect(alignBeatBackedBoundaries(makeProject(), [bed, ...picture], undefined, beats).ok).toBe(
      true,
    );

    // A cut at the UNMAPPED source onset (0.5) is not a timeline onset at all.
    const usesUnmappedOnset = [
      addClip({ start: 11.0, end: 11.5, sourceEnd: 0.5 }),
      addClip({ start: 11.5, end: 12.5, sourceStart: 5, sourceEnd: 6 }),
    ];
    const rejected = alignBeatBackedBoundaries(
      makeProject(),
      [bed, ...usesUnmappedOnset],
      undefined,
      beats,
    );
    expect(rejected.ok).toBe(false);
  });

  it('leaves operations without governed boundaries untouched', () => {
    const operations: AnyOperation[] = [
      { type: 'move_clip', clipId: 'clip_a', toTrackId: 'video_1', toStart: 2.37 },
    ];
    const result = alignBeatBackedBoundaries(makeProject(), operations, GRID, undefined);
    expect(result).toMatchObject({ ok: true, snapped: 0 });
  });
});
