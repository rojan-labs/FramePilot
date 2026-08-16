/**
 * Wipe-guard tests (agent continuity): the deterministic backstop for the
 * "ripple-delete everything and start over" failure loop. The guard must
 * reject a full-track wipe of pre-run work, and must NOT interfere with the
 * legitimate delete shapes (silence removal, single-clip deletes, reworking
 * clips the run itself created, or a reset the user explicitly asked for).
 */
import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import { makeProject } from './__fixtures__/project.js';
import { detectTimelineWipe, wipeGuardFor } from './wipe-guard.js';

const rippleDelete = (trackId: string, start: number, end: number): AnyOperation => ({
  type: 'ripple_delete',
  trackId,
  start,
  end,
});

describe('wipeGuardFor', () => {
  it('builds a baseline snapshot of every track', () => {
    const guard = wipeGuardFor('tighten the pacing', makeProject());
    expect(guard).toBeDefined();
    expect(guard!.baselineClipIds.get('video_1')).toEqual(new Set(['clip_a', 'clip_b']));
    expect(guard!.baselineClipIds.get('audio_1')).toEqual(new Set());
  });

  it.each([
    'delete everything and redo it',
    'clear the timeline',
    'start from scratch',
    'start over',
    'begin again',
    'start over the whole project',
    'start over with everything',
  ])('is disabled when the user asked for removal/reset: %s', (prompt) => {
    expect(wipeGuardFor(prompt, makeProject())).toBeUndefined();
  });

  it('stays enabled for a scoped category removal: remove all the b-roll', () => {
    // "remove all the b-roll" names a clip category, not the project/timeline itself.
    // Under the tightened reset-intent rule only an explicit project/timeline reset
    // disables the guard (see FULL_RESET_INTENT's doc comment); a scoped "remove all
    // <category>" request must still go through detectTimelineWipe so it cannot
    // silently clear an entire track of unrelated prior work.
    expect(wipeGuardFor('remove all the b-roll', makeProject())).toBeDefined();
  });

  it.each(['start over with just the intro', "let's start over on the color grade"])(
    'stays enabled for a scoped "start over": %s',
    (prompt) => {
      // "start over" followed by a narrower named object (the intro, the color grade) is
      // a scoped request, not a full reset — this was the bug: the phrase used to disable
      // continuity protection for the rest of the run regardless of what followed it, so
      // an unrelated delete on a different track later in the same run would go
      // undetected. Only a bare "start over" (no object) or one naming the whole
      // project/timeline/everything counts as a full reset (see FULL_RESET_INTENT).
      expect(wipeGuardFor(prompt, makeProject())).toBeDefined();
    },
  );

  it('stays enabled for an ordinary editing goal (and an absent prompt)', () => {
    expect(wipeGuardFor('make this punchier for Reels', makeProject())).toBeDefined();
    expect(wipeGuardFor(undefined, makeProject())).toBeDefined();
  });
});

describe('detectTimelineWipe', () => {
  const project = makeProject();
  const guard = wipeGuardFor('improve the pacing', project);

  it('rejects a ripple_delete that covers every clip on a multi-clip track', () => {
    const verdict = detectTimelineWipe([rippleDelete('video_1', 0, 10)], project, guard);
    expect(verdict).toMatch(/delete every clip/i);
    expect(verdict).toMatch(/continue from the current timeline/i);
  });

  it('rejects a delete_range wipe the same way (parity)', () => {
    const verdict = detectTimelineWipe(
      [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 12 }],
      project,
      guard,
    );
    expect(verdict).not.toBeNull();
  });

  it('allows a narrow ripple_delete that removes only part of the track (silence removal)', () => {
    expect(detectTimelineWipe([rippleDelete('video_1', 2, 3)], project, guard)).toBeNull();
  });

  it('allows a range that fully covers one clip but not the whole track', () => {
    expect(detectTimelineWipe([rippleDelete('video_1', 0, 6)], project, guard)).toBeNull();
  });

  it('allows deletes on a track with fewer than two clips', () => {
    expect(detectTimelineWipe([rippleDelete('audio_1', 0, 100)], project, guard)).toBeNull();
  });

  it('allows wiping clips the run itself created (iteration, not destruction)', () => {
    // Same shape of timeline, but every clip id is new relative to the baseline —
    // as if the run added these clips itself and is now reworking them.
    const reworked = makeProject();
    const track = reworked.timeline.tracks.find((t) => t.id === 'video_1')!;
    track.clips.forEach((clip, i) => {
      clip.id = `run_clip_${i}`;
    });
    expect(detectTimelineWipe([rippleDelete('video_1', 0, 10)], reworked, guard)).toBeNull();
  });

  it('is a no-op when the guard is disabled', () => {
    expect(detectTimelineWipe([rippleDelete('video_1', 0, 10)], project, undefined)).toBeNull();
  });

  it('ignores unknown tracks and non-delete operations', () => {
    const ops: AnyOperation[] = [
      rippleDelete('missing_track', 0, 100),
      { type: 'trim_clip', clipId: 'clip_a', start: 0, end: 5 },
    ];
    expect(detectTimelineWipe(ops, project, guard)).toBeNull();
  });
});

describe('detectTimelineWipe — aggregate coverage & remove_layer', () => {
  const project = makeProject();
  const guard = wipeGuardFor('improve the pacing', project);

  it('rejects several narrow deletes in ONE call that together clear the track', () => {
    // Each op alone covers only one clip (allowed); together they wipe the track.
    const verdict = detectTimelineWipe(
      [rippleDelete('video_1', 0, 6), rippleDelete('video_1', 6, 10)],
      project,
      guard,
    );
    expect(verdict).toMatch(/delete every clip on track "video_1" \(2 clips\)/i);
  });

  it('still allows narrow deletes that leave clips standing, even several per call', () => {
    expect(
      detectTimelineWipe(
        [rippleDelete('video_1', 2, 3), rippleDelete('video_1', 4, 5)],
        project,
        guard,
      ),
    ).toBeNull();
  });

  it('rejects remove_layer of a multi-clip track holding pre-run work', () => {
    const verdict = detectTimelineWipe(
      [{ type: 'remove_layer', layerId: 'video_1' }],
      project,
      guard,
    );
    expect(verdict).toMatch(/remove track "video_1" and every clip on it/i);
    expect(verdict).toMatch(/delete_clip/);
  });

  it('allows remove_layer of an empty or single-clip track', () => {
    expect(
      detectTimelineWipe([{ type: 'remove_layer', layerId: 'audio_1' }], project, guard),
    ).toBeNull();
    expect(
      detectTimelineWipe([{ type: 'remove_layer', layerId: 'missing' }], project, guard),
    ).toBeNull();
  });

  it('allows remove_layer of a track whose clips were all created by this run', () => {
    const reworked = makeProject();
    const track = reworked.timeline.tracks.find((t) => t.id === 'video_1')!;
    track.clips.forEach((clip, i) => {
      clip.id = `run_clip_${i}`;
    });
    expect(
      detectTimelineWipe([{ type: 'remove_layer', layerId: 'video_1' }], reworked, guard),
    ).toBeNull();
  });
});
