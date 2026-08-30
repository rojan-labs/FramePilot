import { describe, expect, it } from 'vitest';
import type { Clip, Project } from '@framepilot/timeline-schema';
import { makeProject } from '../__fixtures__/project.js';
import {
  checkCutsOnBeats,
  checkCutsOnFrameGrid,
  checkKeptClipsUntouched,
  checkNoMidWordCuts,
  checkNoOverlaps,
  checkValidRefs,
  scoreMissionScenario,
  projectDuration,
} from './mission-rubric.js';

function clip(id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    assetId: 'asset_1',
    trackId: 'video_1',
    start,
    end,
    sourceStart: start,
    sourceEnd: end,
    effects: [],
    keyframes: [],
    ...extra,
  } as Clip;
}

function withClips(clips: Clip[], audio: Clip[] = []): Project {
  const base = makeProject();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: [
        { id: 'video_1', type: 'video', clips },
        { id: 'audio_1', type: 'audio', clips: audio },
      ],
    },
  } as Project;
}

describe('mission rubric — primitive checks', () => {
  it('measures timeline duration as the furthest clip end on any track', () => {
    expect(projectDuration(withClips([clip('a', 0, 4), clip('b', 4, 9.5)]))).toBe(9.5);
  });

  it('flags off-grid edges at the project fps', () => {
    expect(checkCutsOnFrameGrid(withClips([clip('a', 0, 1), clip('b', 1, 2.5)])).ok).toBe(true);
    const off = checkCutsOnFrameGrid(withClips([clip('a', 0, 1.01)]));
    expect(off.ok).toBe(false);
    expect(off.detail).toContain('1 clip edge');
  });

  it('flags overlapping clips on one track', () => {
    expect(checkNoOverlaps(withClips([clip('a', 0, 5), clip('b', 4, 9)])).ok).toBe(false);
    expect(checkNoOverlaps(withClips([clip('a', 0, 5), clip('b', 5, 9)])).ok).toBe(true);
  });

  it('flags dangling asset refs and empty ranges', () => {
    expect(checkValidRefs(withClips([clip('a', 0, 5, { assetId: 'ghost' })])).ok).toBe(false);
    expect(checkValidRefs(withClips([clip('a', 3, 3)])).ok).toBe(false);
    expect(checkValidRefs(withClips([clip('a', 0, 3)])).ok).toBe(true);
  });

  it('flags a clip edge that lands inside a spoken word', () => {
    const p = withClips([clip('a', 0, 0.75)]);
    // makeProject transcript: hello 0–0.5, world 0.5–1 → edge at 0.75 is inside "world"
    expect(checkNoMidWordCuts(p).ok).toBe(false);
    expect(checkNoMidWordCuts(withClips([clip('a', 0, 0.5)])).ok).toBe(true);
  });

  it('scores cuts against a beat grid anchored on the placed music', () => {
    const music = clip('m', 1, 25, { assetId: 'music', trackId: 'audio_1', sourceStart: 0, sourceEnd: 24 });
    const base = withClips([clip('a', 0, 1.6), clip('b', 1.6, 2.2), clip('c', 2.2, 2.8)], [music]);
    const p = { ...base, assets: [...base.assets, { id: 'music', path: 'm.wav', kind: 'audio' as const }] } as Project;
    const on = checkCutsOnBeats(p, 0.6);
    expect(on.ok).toBe(true);
    expect(on.detail).toContain('2/2');
    const offBase = withClips([clip('a', 0, 1.9), clip('b', 1.9, 2.2)], [music]);
    const off = checkCutsOnBeats({ ...offBase, assets: p.assets } as Project, 0.6);
    expect(off.ok).toBe(false);
    expect(checkCutsOnBeats(withClips([clip('a', 0, 1), clip('b', 1, 2)]), 0.6).detail).toBe('no music placed');
  });

  it('detects a named "keep" clip whose source range changed', () => {
    const before = withClips([clip('a', 0, 5), clip('b', 5, 10)]);
    const after = withClips([clip('a', 0, 5), clip('b', 5, 8, { sourceEnd: 8 })]);
    expect(checkKeptClipsUntouched({ before, after, keepClipIds: ['a'] }).ok).toBe(true);
    expect(checkKeptClipsUntouched({ before, after, keepClipIds: ['b'] }).ok).toBe(false);
  });
});

describe('mission rubric — scenarios', () => {
  it('montage-30s: unchanged timeline scores the common checks only', () => {
    const before = makeProject();
    const s = scoreMissionScenario('montage-30s', { before, after: before });
    expect(s.checks.find((c) => c.id === 'timeline-changed')?.ok).toBe(false);
    expect(s.checks.find((c) => c.id === 'duration-within')?.ok).toBe(false);
    expect(s.score).toBeLessThan(0.6);
  });

  it('montage-30s: a 30-second, 6-clip, on-grid, non-overlapping timeline scores 1', () => {
    const before = makeProject();
    const clips = Array.from({ length: 6 }, (_, i) => clip(`c${i}`, i * 5, i * 5 + 5));
    const s = scoreMissionScenario('montage-30s', { before, after: withClips(clips) });
    expect(s.score).toBe(1);
  });

  it('remove-dead-air: shorter + changed + no mid-word cuts passes', () => {
    const before = withClips([clip('a', 0, 10)]);
    const after = withClips([clip('a', 0, 0.5), clip('b', 0.5, 4, { sourceStart: 1, sourceEnd: 4.5 })]);
    const s = scoreMissionScenario('remove-dead-air', { before, after });
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });

  it('memory-captions: needs a caption track with clips', () => {
    const before = makeProject();
    const after = {
      ...before,
      timeline: {
        ...before.timeline,
        tracks: [...before.timeline.tracks, { id: 'cap_1', type: 'caption', clips: [clip('k', 0, 1)] }],
      },
    } as Project;
    expect(scoreMissionScenario('memory-captions', { before, after }).checks.find((c) => c.id === 'has-captions')?.ok).toBe(true);
    expect(scoreMissionScenario('memory-captions', { before, after: before }).checks.find((c) => c.id === 'has-captions')?.ok).toBe(false);
  });
});
