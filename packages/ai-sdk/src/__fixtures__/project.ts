/**
 * Shared test fixture: a small, valid {@link Project} used across ai-sdk tests.
 * It has a video track ("video_1") with two clips and an audio track, an asset,
 * and a short transcript — enough to exercise read tools, edit tools, context,
 * and the orchestrator end to end.
 */
import { parseProject, type Project } from '@framepilot/timeline-schema';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return parseProject({
    id: 'proj_1',
    name: 'Demo',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 }],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 0,
              end: 6,
              sourceStart: 0,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_b',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 6,
              end: 10,
              sourceStart: 6,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
    transcript: [
      { word: 'hello', start: 0, end: 0.5 },
      { word: 'world', start: 0.5, end: 1 },
    ],
    aiMemory: {},
    history: [],
    ...overrides,
  });
}
