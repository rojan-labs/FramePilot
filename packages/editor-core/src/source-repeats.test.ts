import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  REPEATED_SOURCE_OVERLAP_SECONDS,
  repeatedSourceOf,
  repeatedSourcePairs,
} from './source-repeats.js';

interface ClipSpec {
  readonly id: string;
  readonly assetId: string;
  readonly start: number;
  readonly sourceStart: number;
  readonly length: number;
  readonly trackId?: string;
}

function project(clips: readonly ClipSpec[], extraTracks: Project['timeline']['tracks'] = []): Project {
  return parseProject({
    id: 'repeats',
    name: 'Repeats',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 60 },
      { id: 'b', path: 'b.mp4', kind: 'video', durationSeconds: 60 },
    ],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: clips.map((c) => ({
            id: c.id,
            assetId: c.assetId,
            trackId: 'v1',
            start: c.start,
            end: c.start + c.length,
            sourceStart: c.sourceStart,
            sourceEnd: c.sourceStart + c.length,
            effects: [],
            keyframes: [],
          })),
        },
        ...extraTracks,
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

describe('repeatedSourceOf', () => {
  it('names every later clip that replays source an earlier clip already plays', () => {
    const repeated = project([
      { id: 'first', assetId: 'a', start: 0, sourceStart: 0, length: 4 },
      { id: 'other', assetId: 'b', start: 4, sourceStart: 0, length: 4 },
      { id: 'again', assetId: 'a', start: 8, sourceStart: 1, length: 4 },
      { id: 'third', assetId: 'a', start: 12, sourceStart: 0, length: 4 },
    ]);
    // Both repeats point at the FIRST clip that plays the material, never at each other.
    expect([...repeatedSourceOf(repeated)]).toEqual([
      ['again', 'first'],
      ['third', 'first'],
    ]);
    expect(repeatedSourcePairs(repeated)).toHaveLength(3);
  });

  it('does NOT call two different moments of one asset a repeat — the Q5 failure', () => {
    // The recorded run: the same camera file at source 0, 10 and 20. Distinct takes.
    const moments = project([
      { id: 'm0', assetId: 'a', start: 0, sourceStart: 0, length: 4 },
      { id: 'm10', assetId: 'a', start: 4, sourceStart: 10, length: 4 },
      { id: 'm20', assetId: 'a', start: 8, sourceStart: 20, length: 4 },
    ]);
    expect(repeatedSourceOf(moments).size).toBe(0);
  });

  it('ignores an overlap at or under the threshold', () => {
    const grazing = project([
      { id: 'x', assetId: 'a', start: 0, sourceStart: 0, length: 4 },
      { id: 'y', assetId: 'a', start: 4, sourceStart: 4 - REPEATED_SOURCE_OVERLAP_SECONDS, length: 4 },
    ]);
    expect(repeatedSourceOf(grazing).size).toBe(0);
  });

  it('reads only picture tracks', () => {
    const withAudio = project(
      [{ id: 'v', assetId: 'a', start: 0, sourceStart: 0, length: 4 }],
      [
        {
          id: 'a1',
          type: 'audio',
          clips: [
            {
              id: 'aud',
              assetId: 'a',
              trackId: 'a1',
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
    );
    expect(repeatedSourceOf(withAudio).size).toBe(0);
  });
});
