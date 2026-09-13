import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { makeProject } from '../__fixtures__/project.js';
import { OPENING_SHOT_REPEATS, applyCaseSetup } from './case-setup.js';
import { GOLDEN_CASES, goldenCase } from './golden-cases.js';
import { duplicateTakePairs, scoreMissionScenario } from './mission-rubric.js';

function withoutClips(project: Project, ids: readonly string[]): Project {
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: project.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !ids.includes(clip.id)),
      })),
    },
  };
}

describe('repeat-opening-shot', () => {
  const base = makeProject();
  const seeded = applyCaseSetup(base, 'repeat-opening-shot');

  it('places the opening shot’s exact source range twice more, as a valid project', () => {
    expect(() => parseProject(seeded)).not.toThrow();
    const video = seeded.timeline.tracks.find((track) => track.id === 'video_1')!;
    const repeats = video.clips.filter((clip) => clip.id.startsWith('clip_a__repeat_'));
    expect(repeats).toHaveLength(OPENING_SHOT_REPEATS);
    for (const repeat of repeats) {
      expect([repeat.assetId, repeat.sourceStart, repeat.sourceEnd]).toEqual(['asset_1', 0, 6]);
    }
    // Placed after the last clip, butt-joined, never over existing material.
    expect(repeats.map((clip) => [clip.start, clip.end])).toEqual([
      [10, 16],
      [16, 22],
    ]);
  });

  it('gives the rubric real repeated material, which the fixture alone never had', () => {
    expect(duplicateTakePairs(base)).toHaveLength(0);
    // clip_a plus two copies: three pairs of the same take.
    expect(duplicateTakePairs(seeded)).toHaveLength(3);
  });

  it('scores the right answer in full: the repeats go, the unique shot stays', () => {
    const dropped = withoutClips(seeded, ['clip_a__repeat_1', 'clip_a__repeat_2']);
    const score = scoreMissionScenario('remove-duplicate-takes', { before: seeded, after: dropped });
    const byId = new Map(score.checks.map((check) => [check.id, check]));
    expect(byId.get('duplicate-takes-removed')).toMatchObject({ ok: true });
    expect(byId.get('duplicate-takes-removed')?.skipped).toBeUndefined();
    expect(byId.get('unique-takes-kept')).toMatchObject({ ok: true });
  });

  it('still fails the destructive answer that also deletes a unique shot', () => {
    const destructive = withoutClips(seeded, ['clip_a__repeat_1', 'clip_a__repeat_2', 'clip_b']);
    const score = scoreMissionScenario('remove-duplicate-takes', {
      before: seeded,
      after: destructive,
    });
    expect(score.checks.find((check) => check.id === 'unique-takes-kept')).toMatchObject({
      ok: false,
    });
  });

  it('refuses a project with nothing to repeat rather than running without its precondition', () => {
    const empty = makeProject({
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    });
    expect(() => applyCaseSetup(empty, 'repeat-opening-shot')).toThrow(/video track with clips/);
  });

  it('leaves a project without a setup untouched', () => {
    expect(applyCaseSetup(base, undefined)).toBe(base);
  });
});

describe('the duplicate-takes case', () => {
  it('starts from placed repeats and is a single turn, so it scores the removal only', () => {
    const c = goldenCase('remove-duplicate-takes');
    expect(c?.setup).toBe('repeat-opening-shot');
    expect(c?.turns.map((turn) => turn.rubric)).toEqual(['remove-duplicate-takes']);
  });

  it('every setup a case names can be applied', () => {
    for (const c of GOLDEN_CASES.filter((candidate) => candidate.setup !== undefined)) {
      expect(() => applyCaseSetup(makeProject(), c.setup), c.id).not.toThrow();
    }
  });
});
