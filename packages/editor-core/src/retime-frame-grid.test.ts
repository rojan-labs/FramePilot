/**
 * A retime must land on the project frame grid (session 7, REMAINING §2.3).
 *
 * `refine-tighten` r1 turn 2 made 16 `set_clip_speed` calls at 1.3x and produced exactly
 * 16 off-grid clip edges. It is arithmetic, not model error: `set_clip_speed` carries no
 * time field, so `normalizeOperationTime` correctly returns it unchanged, and then
 * `apply` invents `end = start + sourceDuration / speed` — almost never a whole number
 * of frames.
 *
 * The grid rule exists so preview and export agree about where a cut is. These tests pin
 * the fix at the boundary the product actually commits through (`applyProjectPatch`,
 * which holds the project and therefore its fps) and pin the undo promise that comes
 * with it.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { applyOperation, invertOperation } from './operations.js';
import { applyProjectPatch, invertProjectPatch, type Patch } from './patch.js';
import { snapSecondsToFrame } from './frame-grid.js';

/**
 * Strict on-grid predicate, matching `mission-rubric.ts#onFrameGrid`'s intent with a
 * tolerance tight enough that the pre-fix arithmetic actually fails it.
 */
function isOnFrameGrid(seconds: number, fps: number): boolean {
  return Math.abs(seconds - snapSecondsToFrame(seconds, fps)) < 1e-9;
}

const FPS = 30;

function timeline(): Timeline {
  return {
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a1',
            trackId: 'v1',
            start: 0,
            end: 4,
            sourceStart: 0,
            sourceEnd: 4,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

function project(): Project {
  return {
    id: 'p1',
    name: 'retime',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    folders: [],
    timeline: timeline(),
    transcript: [],
    markers: [],
  } as unknown as Project;
}

function speedPatch(speed: number): Patch {
  return {
    patchId: 'patch_retime',
    createdBy: 'agent',
    reason: 'tighten',
    operations: [{ type: 'set_clip_speed', clipId: 'c1', speed }],
  } as unknown as Patch;
}

const edgesOf = (p: Project) => p.timeline.tracks[0]!.clips.map((c) => [c.start, c.end] as const);

describe('retime lands on the frame grid', () => {
  it('reproduces the off-grid edge without an fps (the pre-fix arithmetic)', () => {
    const next = applyOperation(timeline(), { type: 'set_clip_speed', clipId: 'c1', speed: 1.3 });
    const end = next.tracks[0]!.clips[0]!.end;
    expect(end).toBeCloseTo(4 / 1.3, 10);
    expect(isOnFrameGrid(end, FPS)).toBe(false);
  });

  it('snaps the retimed end when the caller knows the frame rate', () => {
    const next = applyOperation(
      timeline(),
      { type: 'set_clip_speed', clipId: 'c1', speed: 1.3 },
      { fps: FPS },
    );
    const end = next.tracks[0]!.clips[0]!.end;
    expect(isOnFrameGrid(end, FPS)).toBe(true);
    // Nearest frame to 3.0769…s at 30fps is frame 92 → 3.0666…s.
    expect(end).toBeCloseTo(92 / FPS, 12);
  });

  it('leaves every edge on the grid through applyProjectPatch, at 16 rates', () => {
    for (let i = 0; i < 16; i++) {
      const speed = 1.05 + i * 0.05;
      const after = applyProjectPatch(project(), speedPatch(speed));
      for (const [start, end] of edgesOf(after)) {
        expect(isOnFrameGrid(start, FPS), `start at ${speed}x`).toBe(true);
        expect(isOnFrameGrid(end, FPS), `end at ${speed}x`).toBe(true);
      }
    }
  });

  it('never collapses a clip, however extreme the rate', () => {
    const after = applyProjectPatch(project(), speedPatch(600));
    const [start, end] = edgesOf(after)[0]!;
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeCloseTo(1 / FPS, 12);
  });

  it('is exactly reversible through invertProjectPatch', () => {
    const before = project();
    const patch = speedPatch(1.3);
    const inverse = invertProjectPatch(before, patch);
    const after = applyProjectPatch(before, patch);
    const restored = applyProjectPatch(after, inverse);
    expect(restored.timeline.tracks).toEqual(before.timeline.tracks);
  });

  it('falls back to a snapshot when the same-shape inverse could not be exact', () => {
    // A clip whose `end` predates the grid: re-applying its own rate would land it on a
    // frame boundary it never sat on, so the readable inverse is not honest here.
    const drifted = timeline();
    const clip = { ...drifted.tracks[0]!.clips[0]!, end: 3.077, speed: 1.3 };
    const t = {
      tracks: [{ ...drifted.tracks[0]!, clips: [clip] }],
    } as unknown as Timeline;
    const inverse = invertOperation(
      t,
      { type: 'set_clip_speed', clipId: 'c1', speed: 2 },
      { fps: FPS },
    );
    expect(inverse.map((o) => o.type)).toEqual(['restore_clips']);
    const restored = applyOperation(
      t,
      { type: 'set_clip_speed', clipId: 'c1', speed: 2 },
      {
        fps: FPS,
      },
    );
    expect(applyOperation(restored, inverse[0]!, { fps: FPS }).tracks[0]!.clips[0]!.end).toBe(
      3.077,
    );
  });
});
