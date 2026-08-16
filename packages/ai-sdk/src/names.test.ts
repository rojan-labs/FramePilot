/**
 * Tests for {@link projectNames} (Phase 11 progress-clarity pass): resolving
 * clip/track/asset ids to friendly labels for the event stream. Covers name
 * resolution, per-type track numbering, and every id-not-found fallback. 100% cov.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { projectNames } from './names.js';

const project = (): Project =>
  ({
    schemaVersion: 4,
    id: 'p',
    assets: [
      { id: 'asset_1', path: '/media/Intro.mp4', kind: 'video' },
      { id: 'asset_2', path: 'C:\\clips\\B Roll.mov', kind: 'video' },
      { id: 'asset_blank', path: '/', kind: 'video' },
    ],
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
              end: 3,
              sourceStart: 0,
              sourceEnd: 3,
            },
            {
              id: 'clip_orphan',
              assetId: 'missing',
              trackId: 'video_1',
              start: 3,
              end: 5,
              sourceStart: 0,
              sourceEnd: 2,
            },
          ],
        },
        { id: 'video_2', type: 'video', clips: [] },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
  }) as unknown as Project;

describe('projectNames', () => {
  it('resolves a clip to its source asset file name (POSIX + Windows paths)', () => {
    const names = projectNames(project());
    expect(names.clip('clip_a')).toBe('Intro.mp4');
    expect(names.asset('asset_2')).toBe('B Roll.mov');
  });

  it('numbers tracks per type in order (Video 1, Video 2, Audio 1)', () => {
    const names = projectNames(project());
    expect(names.track('video_1')).toBe('Video 1');
    expect(names.track('video_2')).toBe('Video 2');
    expect(names.track('audio_1')).toBe('Audio 1');
  });

  it('falls back to the id for unknown clip/track/asset and orphaned clips', () => {
    const names = projectNames(project());
    expect(names.clip('clip_orphan')).toBe('clip_orphan'); // asset missing → clip id
    expect(names.clip('nope')).toBe('nope');
    expect(names.track('nope')).toBe('nope');
    expect(names.asset('nope')).toBe('nope');
  });

  it('falls back to the id when an asset path has no basename', () => {
    expect(projectNames(project()).asset('asset_blank')).toBe('asset_blank');
  });

  it('handles a project with no assets array', () => {
    const p = { schemaVersion: 4, id: 'p', timeline: { tracks: [] } } as unknown as Project;
    expect(projectNames(p).asset('x')).toBe('x');
  });
});
