/**
 * Frame snapping on the paths a PERSON uses, not just the ones the agent uses.
 *
 * `snapAddClip` (ADR 0146 / GAP-005) reaches `add_clip` through `quantizePatch`, which the
 * editor store and the undo history run on every user patch — so a stock drop, a media-bin
 * drag and an AI placement all land on the grid now, and the desktop app is where that
 * shows first. The risk this file covers is the seam between the two: placement decides
 * where a clip fits by reading RAW numbers (`picturePlacementConflict`, `hasRoomFor`) while
 * the committed operation carries SNAPPED ones, and a full-source placement is rescaled to
 * one frame past its asset's real end.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Project, Timeline } from '@framepilot/timeline-schema';
import { quantizePatch, secondsToFrame } from './frame-grid.js';
import type { AnyOperation, Patch } from './patch.js';
import { applyProjectPatch } from './patch.js';
import { buildAddStockOps } from './stock-placement.js';
import { validatePatch } from './validator.js';

const fps = 30;

/** Every edit point of every clip sits exactly on a frame boundary. */
const onGrid = (value: number): boolean =>
  Math.abs(value - secondsToFrame(value, fps) / fps) < 1e-9;

const stockVideo: Asset = {
  id: 'stock_1',
  path: 'media/stock/city.mp4',
  kind: 'video',
  // Deliberately off-grid at 30fps: 6.017s is 180.51 frames, so the out-point moves.
  durationSeconds: 6.017,
};

const existing: Asset = { id: 'cam', path: 'media/cam.mp4', kind: 'video', durationSeconds: 30 };

function project(clips: readonly { id: string; start: number; end: number }[]): Project {
  const timeline: Timeline = {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: clips.map((c) => ({
          id: c.id,
          assetId: existing.id,
          start: c.start,
          end: c.end,
          sourceStart: 0,
          sourceEnd: c.end - c.start,
          effects: [],
        })),
      },
    ],
  } as unknown as Timeline;
  return {
    schemaVersion: 21,
    fps,
    width: 1080,
    height: 1920,
    assets: [existing],
    timeline,
    history: [],
  } as unknown as Project;
}

const patchOf = (operations: readonly AnyOperation[]): Patch =>
  ({ id: 'p_test', operations, source: 'user' }) as unknown as Patch;

describe('frame snapping on the host placement paths', () => {
  it('lands a stock drop on the grid without stretching it or colliding', () => {
    const before = project([{ id: 'c_1', start: 0, end: 2 }]);
    const placement = buildAddStockOps(before.timeline, [existing], stockVideo, 2);
    expect(placement).not.toBeNull();

    const quantized = quantizePatch(patchOf(placement!.operations), fps);
    const added = quantized.operations.find((op) => op.type === 'add_clip');
    expect(added).toBeDefined();
    const clip = added as Extract<AnyOperation, { type: 'add_clip' }>;

    expect(onGrid(clip.start)).toBe(true);
    expect(onGrid(clip.end)).toBe(true);
    // A clip is MOVED onto the grid, not stretched: the duration survives to the frame.
    expect(clip.end - clip.start).toBeCloseTo(stockVideo.durationSeconds!, 1);

    // Validated against the timeline the patch is applied TO, which is what the store and
    // the undo history do — an overlap the snap manufactured shows up here or nowhere.
    const validation = validatePatch(before.timeline, quantized);
    expect(validation.valid).toBe(true);
    expect(() => applyProjectPatch(before, quantized)).not.toThrow();
  });

  it('reads the whole source even after the out-point snaps past the asset end', () => {
    const before = project([]);
    const placement = buildAddStockOps(before.timeline, [], stockVideo, 0);
    const quantized = quantizePatch(patchOf(placement!.operations), fps);
    const clip = quantized.operations.find((op) => op.type === 'add_clip') as Extract<
      AnyOperation,
      { type: 'add_clip' }
    >;
    // Snapping the out-point up can carry `sourceEnd` under a frame past the real end of
    // the media. That is intended and handled where it lands: `compiler.py`'s
    // `_subclipped_source` drops a `source_end` at or beyond the asset duration and plays
    // to the end. What must NOT happen is over-reading by more than the one frame.
    expect(clip.sourceEnd! - stockVideo.durationSeconds!).toBeLessThan(1 / fps);
  });

  it('does not manufacture an overlap against an off-grid neighbour', () => {
    // A project saved before snapping can hold clips at arbitrary times. Placement reads
    // the raw numbers; the committed operation carries snapped ones, so the two could
    // disagree at the seam and turn a legal drop into an `overlap_error`.
    const before = project([{ id: 'c_1', start: 0, end: 1.9873 }]);
    const placement = buildAddStockOps(before.timeline, [existing], stockVideo, 1.9873);
    expect(placement).not.toBeNull();
    const quantized = quantizePatch(patchOf(placement!.operations), fps);
    // Validated against the timeline the patch is applied TO, which is what the store and
    // the undo history do — an overlap the snap manufactured shows up here or nowhere.
    const validation = validatePatch(before.timeline, quantized);
    expect(validation.valid).toBe(true);
    expect(() => applyProjectPatch(before, quantized)).not.toThrow();
  });
});
