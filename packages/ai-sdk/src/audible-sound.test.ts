import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { audibleFrames } from './audible-sound.js';

const FPS = 30;
const PEAKS_PER_SECOND = 10;
const FLOOR_DBFS = -30;
const LOUD = 0.3;
const QUIET = 0.01;

/** One clip of a 20 s asset whose peaks are loud only over source seconds [4, 6). */
function projectWith(clip: Record<string, unknown>, track: Record<string, unknown> = {}): Project {
  const peaks = Array.from({ length: 20 * PEAKS_PER_SECOND }, (_, bucket) =>
    bucket >= 4 * PEAKS_PER_SECOND && bucket < 6 * PEAKS_PER_SECOND ? LOUD : QUIET,
  );
  return parseProject({
    id: 'p',
    name: 'Audible',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset_1',
        path: 'media/a.mp4',
        kind: 'video',
        durationSeconds: 20,
        media: { peaks, peaksPerSecond: PEAKS_PER_SECOND },
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'a',
              trackId: 'video_1',
              assetId: 'asset_1',
              effects: [],
              keyframes: [],
              ...clip,
            },
          ],
          ...track,
        },
      ],
      revision: 1,
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const window = { startFrame: 0, endFrame: 60 };
const count = (flags: readonly boolean[]): number => flags.filter(Boolean).length;

describe('audibleFrames — sound read off waveform peaks through the clip', () => {
  it('maps sequence time to source time, at speed', () => {
    // 2x from source 4 s: the loud source [4, 6) plays over the first second.
    const at2x = audibleFrames(
      projectWith({ start: 0, end: 2, sourceStart: 4, sourceEnd: 8, speed: 2 }),
      window,
      FPS,
      FLOOR_DBFS,
    );
    expect(at2x.measured).toBe(true);
    expect(at2x.audible.slice(0, 30).every(Boolean)).toBe(true);
    expect(count(at2x.audible.slice(30))).toBe(0);
  });

  it('hears nothing from a frozen clip, a muted track or a hidden picture track', () => {
    const loud = { start: 0, end: 2, sourceStart: 4, sourceEnd: 6 };
    for (const project of [
      projectWith({ ...loud, speed: 0 }),
      projectWith(loud, { muted: true }),
      projectWith(loud, { hidden: true }),
    ]) {
      const sound = audibleFrames(project, window, FPS, FLOOR_DBFS);
      // Known silent is evidence, so the caller does not fall back to the dialogue.
      expect(sound.measured).toBe(true);
      expect(count(sound.audible)).toBe(0);
    }
  });

  it('applies the clip gain', () => {
    const loud = { start: 0, end: 2, sourceStart: 4, sourceEnd: 6 };
    const gained = (gainDb: number) =>
      audibleFrames(
        projectWith({
          ...loud,
          effects: [{ id: 'g', type: 'audio_gain', params: { gainDb }, keyframes: [] }],
        }),
        window,
        FPS,
        FLOOR_DBFS,
      );
    expect(count(gained(-6).audible)).toBe(60);
    expect(count(gained(-20).audible)).toBe(0);
  });

  it('reports nothing measured when the asset was never probed', () => {
    const project = projectWith({ start: 0, end: 2, sourceStart: 4, sourceEnd: 6 });
    const unprobed = {
      ...project,
      assets: project.assets.map((asset) => ({ ...asset, media: null })),
    };
    const sound = audibleFrames(unprobed, window, FPS, FLOOR_DBFS);
    expect(sound.measured).toBe(false);
    expect(count(sound.audible)).toBe(0);
  });
});
