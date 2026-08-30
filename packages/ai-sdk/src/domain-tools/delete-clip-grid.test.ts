/**
 * `delete_clip` on an off-grid clip removes the whole clip (P1.1, mission ledger).
 *
 * The bug this pins: `assembleEdit` quantizes to the frame grid with *nearest* rounding,
 * so a delete range built from an off-grid clip's own `end` was rounded back inside the
 * clip and left a sub-frame husk behind — reported as a successful delete. The husk's
 * start and end then rounded to the SAME frame, so every later attempt to delete it
 * failed with `delete_range.end must be greater than start.`, which is 29 of the 48
 * failed delete calls in `docs/reports/system-mission/01-call-classification.md`.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { applyProjectPatch } from '@framepilot/editor-core';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import type { AnyOperation } from '@framepilot/editor-core';

/** Two abutting clips; the second ENDS 8 ms past a 30fps frame boundary (4040 = 134.6667s). */
const OFF_GRID_END = 134.674735;
const GRID_START = 130.5;

function offGridProject(): Project {
  return parseProject({
    id: 'proj_offgrid',
    name: 'Off-grid import',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 200 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_keep',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 0,
              end: GRID_START,
              sourceStart: 0,
              sourceEnd: GRID_START,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_offgrid',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: GRID_START,
              end: OFF_GRID_END,
              sourceStart: GRID_START,
              sourceEnd: OFF_GRID_END,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
      markers: [],
    },
  });
}

function deleteClip(project: Project, clipId: string, ripple: boolean): Project {
  const tool = getTool('delete_clip');
  if (!tool || tool.kind !== 'mutate') throw new Error('delete_clip is not a mutate tool');
  const ops = tool.buildOps({ clipId, ripple }, { project }) as AnyOperation[];
  const assembled = assembleEdit(project, ops, 'delete', 'agent');
  expect(assembled.validation.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  return applyProjectPatch(project, assembled.patch);
}

describe('delete_clip on an off-grid clip', () => {
  it('covers every frame of the clip, so frame quantization cannot leave a husk', () => {
    const tool = getTool('delete_clip');
    if (!tool || tool.kind !== 'mutate') throw new Error('delete_clip is not a mutate tool');
    const project = offGridProject();
    const [op] = tool.buildOps({ clipId: 'clip_offgrid' }, { project }) as AnyOperation[];
    const range = op as { type: string; start: number; end: number };

    // Floored start, ceiled end: the range is already on the grid, so `assembleEdit`'s
    // nearest-rounding normalization is a no-op on it and cannot shrink it.
    expect(range.type).toBe('delete_range');
    expect(range.start).toBe(GRID_START);
    // Nearest rounding — what normalization applies — would have pulled this back to
    // 134.6667 and left the 8 ms husk. Ceiling it puts the range past the clip's end.
    expect(range.end).toBeCloseTo(134.7, 9);
    expect(range.end).toBeGreaterThan(OFF_GRID_END);
  });

  it('leaves nothing behind — the clip is gone after one delete', () => {
    const after = deleteClip(offGridProject(), 'clip_offgrid', false);
    const clips = after.timeline.tracks[0]!.clips;
    expect(clips.map((clip) => clip.id)).toEqual(['clip_keep']);
  });

  it('a grid-aligned clip is deleted exactly as before', () => {
    const tool = getTool('delete_clip');
    if (!tool || tool.kind !== 'mutate') throw new Error('delete_clip is not a mutate tool');
    const project = offGridProject();
    const [op] = tool.buildOps(
      { clipId: 'clip_keep', ripple: true },
      {
        project,
      },
    ) as AnyOperation[];
    const range = op as { type: string; start: number; end: number };
    expect(range.type).toBe('ripple_delete');
    expect(range.start).toBe(0);
    // `clip_keep` is already frame-aligned, so floor/ceil return its own boundaries.
    expect(range.end).toBe(GRID_START);
  });

  it('a sub-frame husk left by an older run is deletable instead of un-deletable', () => {
    // The exact husk the montage run kept re-deleting: 8 ms wide, both edges inside one
    // frame. With nearest rounding its range collapsed to zero length and the validator
    // answered `delete_range.end must be greater than start.` on every attempt.
    const project = parseProject({
      id: 'proj_husk',
      name: 'Husk',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 200 }],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_husk',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 134.66666666666666,
                end: OFF_GRID_END,
                sourceStart: 134.66666666666666,
                sourceEnd: OFF_GRID_END,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
        markers: [],
      },
    }) as Project;
    const after = deleteClip(project, 'clip_husk', false);
    expect(after.timeline.tracks[0]!.clips).toEqual([]);
  });
});
