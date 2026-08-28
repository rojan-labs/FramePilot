/**
 * Tests for the beat ledger and grid resolution.
 *
 * The cases are written against run `ea8e46ec`, which auditioned three tracks in one turn,
 * placed the third, and was then refused six montage proposals for not placing the second.
 * Each test below pins one link of that chain: writes must commute, an audition must be
 * remembered whole, and the grid must follow the music the picture actually sits against.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import {
  createBeatEvidence,
  hasBeatEvidence,
  readOnsetTimes,
  recordBeatAnalysis,
  resolveBeatGrid,
} from './beat-evidence.js';

/** `{ assetId, beats: [{ time }] }` — the raw `detect_beats` payload shape. */
function rawBeats(assetId: string, times: readonly number[]): unknown {
  return { assetId, beats: times.map((time) => ({ time })), bpm: 120 };
}

/** A project with `beds` placed on audio tracks: `[assetId, start, end]`. */
function projectWithBeds(beds: readonly (readonly [string, number, number])[]): Project {
  return parseProject({
    id: 'proj_1',
    name: 'Demo',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      { id: 'photo_1', path: 'media/p.jpg', kind: 'image', durationSeconds: 5 },
      ...beds.map(([assetId], index) => ({
        id: assetId,
        path: `media/${assetId}.mp3`,
        kind: 'audio' as const,
        durationSeconds: 60 + index,
      })),
    ],
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips: [] },
        ...beds.map(([assetId, start, end], index) => ({
          id: `audio_${String(index + 1)}`,
          type: 'audio' as const,
          clips: [
            {
              id: `clip_${assetId}`,
              assetId,
              trackId: `audio_${String(index + 1)}`,
              start,
              end,
              sourceStart: 0,
              sourceEnd: end - start,
              effects: [],
              keyframes: [],
            },
          ],
        })),
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function addClip(over: Partial<Extract<AnyOperation, { type: 'add_clip' }>>): AnyOperation {
  return {
    type: 'add_clip',
    trackId: 'video_1',
    assetId: 'photo_1',
    start: 0,
    end: 1,
    sourceStart: 0,
    sourceEnd: 1,
    ...over,
  } as AnyOperation;
}

describe('the beat ledger', () => {
  it('keeps every analysis in an audition, not just the last one', () => {
    // The brief this came from said "evaluate multiple suitable tracks and select the
    // strongest one". A single slot could remember exactly one of the three.
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [1, 2]), false);
    recordBeatAnalysis(evidence, rawBeats('music_b', [3, 4]), false);
    recordBeatAnalysis(evidence, rawBeats('music_c', [5, 6]), false);
    expect([...evidence.analyses.keys()]).toEqual(['music_a', 'music_b', 'music_c']);
    expect(readOnsetTimes(evidence.analyses.get('music_c'))).toEqual([5, 6]);
  });

  it('is order-independent — the write race that picked the wrong track cannot exist', () => {
    // `detect_beats` is a `pure_read`, so three calls in one turn run through `mapBounded`
    // and settle in completion order. Distinct keys commute; one field did not.
    const payloads = [
      rawBeats('music_a', [1]),
      rawBeats('music_b', [2]),
      rawBeats('music_c', [3]),
    ];
    const forward = createBeatEvidence();
    for (const payload of payloads) recordBeatAnalysis(forward, payload, false);
    const reversed = createBeatEvidence();
    for (const payload of [...payloads].reverse()) recordBeatAnalysis(reversed, payload, false);

    const project = projectWithBeds([['music_c', 0, 20]]);
    const proposal = [addClip({ start: 3, end: 4 })];
    expect(resolveBeatGrid(project, forward, proposal)).toEqual(
      resolveBeatGrid(project, reversed, proposal),
    );
  });

  it('replaces only the re-analysed track when one is measured again', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [1, 2]), false);
    recordBeatAnalysis(evidence, rawBeats('music_b', [3, 4]), false);
    recordBeatAnalysis(evidence, rawBeats('music_a', [1, 1.5, 2]), false);
    expect(evidence.analyses.size).toBe(2);
    expect(readOnsetTimes(evidence.analyses.get('music_a'))).toEqual([1, 1.5, 2]);
    expect(readOnsetTimes(evidence.analyses.get('music_b'))).toEqual([3, 4]);
  });

  it('makes hardSync sticky for the run but never unsets it', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [1]), false);
    expect(evidence.hardSync).toBe(false);
    recordBeatAnalysis(evidence, rawBeats('music_b', [2]), true);
    expect(evidence.hardSync).toBe(true);
    // A later re-analysis at a different sensitivity is not a change of intent.
    recordBeatAnalysis(evidence, rawBeats('music_b', [2, 3]), false);
    expect(evidence.hardSync).toBe(true);
  });

  it('drops a payload that names no asset rather than filing it under a placeholder', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, { beats: [{ time: 1 }] }, false);
    expect(hasBeatEvidence(evidence)).toBe(false);
    expect(hasBeatEvidence(undefined)).toBe(false);
  });
});

describe('resolveBeatGrid', () => {
  it('has no opinion when the run analysed nothing', () => {
    const evidence = createBeatEvidence();
    expect(resolveBeatGrid(projectWithBeds([]), evidence, [])).toEqual({ kind: 'none' });
  });

  it('has no opinion when every analysis came back empty', () => {
    // Silent footage or a failed analysis is not a grid, and must not veto a montage.
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', []), false);
    expect(resolveBeatGrid(projectWithBeds([]), evidence, [])).toEqual({ kind: 'none' });
  });

  it('resolves the analysed bed that is ON THE TIMELINE — the incident, fixed', () => {
    // Three tracks analysed, the third placed. The old rule pinned whichever payload was
    // written last and refused every cut for not placing it.
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [0.5, 1.0]), false);
    recordBeatAnalysis(evidence, rawBeats('music_b', [0.25, 0.75]), false);
    recordBeatAnalysis(evidence, rawBeats('music_c', [1.5, 3.0, 4.5]), false);

    const project = projectWithBeds([['music_c', 0, 27.5]]);
    const resolved = resolveBeatGrid(project, evidence, [addClip({ start: 1.5, end: 3.0 })]);
    expect(resolved).toEqual({
      kind: 'grid',
      assetId: 'music_c',
      times: [1.5, 3.0, 4.5],
      source: 'timeline',
    });
  });

  it('translates onsets through the placed clip rather than assuming it starts at zero', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [1, 2, 3]), false);
    // Placed at 10s with no source trim, so source 1 → timeline 11.
    const project = projectWithBeds([['music_a', 10, 20]]);
    const resolved = resolveBeatGrid(project, evidence, []);
    expect(resolved).toMatchObject({ kind: 'grid', times: [11, 12, 13] });
  });

  it('prefers the longest-placed bed and breaks a tie on assetId, never on order', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_short', [1]), false);
    recordBeatAnalysis(evidence, rawBeats('music_long', [2]), false);
    const project = projectWithBeds([
      ['music_short', 0, 4],
      ['music_long', 0, 25],
    ]);
    expect(resolveBeatGrid(project, evidence, [])).toMatchObject({ assetId: 'music_long' });

    const tied = projectWithBeds([
      ['music_zeta', 0, 10],
      ['music_alpha', 0, 10],
    ]);
    const tiedEvidence = createBeatEvidence();
    recordBeatAnalysis(tiedEvidence, rawBeats('music_zeta', [1]), false);
    recordBeatAnalysis(tiedEvidence, rawBeats('music_alpha', [2]), false);
    expect(resolveBeatGrid(tied, tiedEvidence, [])).toMatchObject({ assetId: 'music_alpha' });
  });

  it('falls back to a bed the PROPOSAL places when nothing is on the timeline yet', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [3.0, 4.5, 6.0]), false);
    const proposal = [
      addClip({
        trackId: 'audio_1',
        assetId: 'music_a',
        start: 10,
        end: 20,
        sourceStart: 2,
        sourceEnd: 12,
      }),
      addClip({ start: 11, end: 12.5 }),
    ];
    expect(resolveBeatGrid(projectWithBeds([]), evidence, proposal)).toEqual({
      kind: 'grid',
      assetId: 'music_a',
      times: [11, 12.5, 14],
      source: 'proposal',
    });
  });

  it('prefers a placed bed over one the proposal is only about to place', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_placed', [1]), false);
    recordBeatAnalysis(evidence, rawBeats('music_new', [2]), false);
    const project = projectWithBeds([['music_placed', 0, 30]]);
    const proposal = [
      addClip({ trackId: 'audio_2', assetId: 'music_new', start: 0, end: 30, sourceEnd: 30 }),
    ];
    expect(resolveBeatGrid(project, evidence, proposal)).toMatchObject({
      assetId: 'music_placed',
      source: 'timeline',
    });
  });

  it('reports ungrounded, naming every analysed track, when none is placed', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_b', [1]), false);
    recordBeatAnalysis(evidence, rawBeats('music_a', [2]), false);
    expect(resolveBeatGrid(projectWithBeds([]), evidence, [])).toEqual({
      kind: 'ungrounded',
      analyzedAssetIds: ['music_a', 'music_b'],
    });
  });

  it('ignores onsets outside a proposed placement’s trimmed source window', () => {
    const evidence = createBeatEvidence();
    recordBeatAnalysis(evidence, rawBeats('music_a', [0.5, 3.0, 4.5, 40]), false);
    const proposal = [
      addClip({
        trackId: 'audio_1',
        assetId: 'music_a',
        start: 10,
        end: 20,
        sourceStart: 2,
        sourceEnd: 12,
      }),
    ];
    expect(resolveBeatGrid(projectWithBeds([]), evidence, proposal)).toMatchObject({
      times: [11, 12.5],
    });
  });
});
