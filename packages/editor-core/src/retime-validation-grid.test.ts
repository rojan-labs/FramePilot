/**
 * A committed fractional retime must not poison the track (issue #83).
 *
 * The commit path snaps a retimed `end` onto the project frame grid (ADR 0146), so a
 * 1.3x clip stores `92/30 = 3.0666…s` where the exact arithmetic says `4/1.3 =
 * 3.0769…s`. `speedConsistencyChecks` used to compare the stored duration against the
 * exact one with a 1e-6 epsilon and rescan the *whole* track after any timed op — so the
 * next trim of a completely different clip was rejected with `speed_duration_mismatch`
 * naming the old, untouched retimed clip, and the track became un-editable.
 *
 * These tests validate against the **committed** state, which is what the existing
 * frame-grid tests never did: they either build un-snapped timelines by hand
 * (`frame-grid.placement.test.ts`) or check placement and undo only
 * (`retime-frame-grid.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { applyProjectPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

const FPS = 30;

function clip(id: string, start: number, end: number) {
  return {
    id,
    assetId: 'a1',
    trackId: 'v1',
    start,
    end,
    sourceStart: start,
    sourceEnd: end,
    effects: [],
    keyframes: [],
  };
}

function project(): Project {
  return {
    id: 'p1',
    name: 'retime-validation',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'a1' }],
    folders: [],
    timeline: {
      tracks: [{ id: 'v1', type: 'video', clips: [clip('c1', 0, 4), clip('c2', 4, 8)] }],
    } as unknown as Timeline,
    transcript: [],
    markers: [],
  } as unknown as Project;
}

function patch(operations: unknown[]): Patch {
  return {
    patchId: 'patch_test',
    createdBy: 'agent',
    reason: 'test',
    operations,
  } as unknown as Patch;
}

const retimed = () =>
  applyProjectPatch(project(), patch([{ type: 'set_clip_speed', clipId: 'c1', speed: 1.3 }]));

const trimC2 = patch([{ type: 'trim_clip', clipId: 'c2', start: 4, end: 7 }]);

describe('validation after a committed fractional retime', () => {
  it('stores a frame-snapped end that the exact speed arithmetic disagrees with', () => {
    const after = retimed();
    const c1 = after.timeline.tracks[0]!.clips[0]!;
    expect(c1.end).toBeCloseTo(92 / FPS, 12);
    // The gap the old check tripped over: ~10ms, four orders past SPEED_EPSILON.
    expect(Math.abs(c1.end - 4 / 1.3)).toBeGreaterThan(1e-6);
  });

  it('accepts a later timed edit on another clip of the same track', () => {
    const after = retimed();
    const result = validatePatch(after.timeline, trimC2, {
      assetIds: ['a1'],
      fps: after.fps,
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a second retime of the already-retimed clip', () => {
    const after = retimed();
    const result = validatePatch(
      after.timeline,
      patch([{ type: 'set_clip_speed', clipId: 'c1', speed: 1.7 }]),
      { assetIds: ['a1'], fps: after.fps },
    );
    expect(result.valid).toBe(true);
  });

  it('commits that follow-up edit, so the whole loop closes', () => {
    const next = applyProjectPatch(retimed(), trimC2);
    const [c1, c2] = next.timeline.tracks[0]!.clips;
    expect(c1!.end).toBeCloseTo(92 / FPS, 12);
    expect(c2!.end).toBeCloseTo(7, 12);
  });

  it('survives sixteen fractional retimes followed by a trim (the refine-tighten shape)', () => {
    let current = project();
    for (let i = 0; i < 16; i++) {
      const speed = 1.05 + i * 0.05;
      current = applyProjectPatch(
        current,
        patch([{ type: 'set_clip_speed', clipId: 'c1', speed }]),
      );
      const result = validatePatch(current.timeline, trimC2, { assetIds: ['a1'], fps: FPS });
      expect(result.issues, `after ${speed}x`).toEqual([]);
    }
  });

  it('still reports a genuinely inconsistent duration, grid or no grid', () => {
    const broken = project();
    // Half the clip's timeline span at 1x: not a rounding error, a real mismatch.
    const track = broken.timeline.tracks[0]!;
    (track.clips as unknown as Record<string, number>[])[0]!.end = 2;
    const result = validatePatch(broken.timeline, trimC2, { assetIds: ['a1'], fps: FPS });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.code).toBe('speed_duration_mismatch');
  });

  it('reproduces the rejection when no fps is supplied (the pre-fix path)', () => {
    const after = retimed();
    const result = validatePatch(after.timeline, trimC2, { assetIds: ['a1'] });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.code).toBe('speed_duration_mismatch');
  });
});
