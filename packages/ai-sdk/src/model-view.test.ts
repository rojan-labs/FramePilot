/**
 * The asset view the model reads (`list_assets`, `get_project_state`).
 */
import { describe, expect, it } from 'vitest';
import type { Asset } from '@framepilot/timeline-schema';
import { toModelAsset } from './model-view.js';

const video = (media: Asset['media']): Asset =>
  ({
    id: 'asset_ro',
    path: 'media/p/ro_2.mp4',
    kind: 'video',
    durationSeconds: 414.8,
    media,
  }) as Asset;

describe('toModelAsset — does a video carry sound?', () => {
  // Desktop run 001be135: the brief called the footage "video only (no sound)" while the
  // file in the bin carried the narration; nothing the model read said so.
  it('says a probed video with an audio stream has sound', () => {
    expect(toModelAsset(video({ width: 1920, height: 1080, peaks: [0.4, 0.9] }))).toMatchObject({
      sound: true,
      orientation: 'landscape',
    });
  });

  it('says a probed video with no audio stream has none', () => {
    expect(toModelAsset(video({ width: 1920, height: 1080, peaks: null }))).toMatchObject({
      sound: false,
    });
  });

  it('says nothing about sound for a file nobody probed', () => {
    const view = toModelAsset(video(null));
    expect(view).not.toHaveProperty('sound');
    expect(view).toMatchObject({ shape: 'unmeasured' });
  });

  it('never states it for audio or stills, whose kind already answers', () => {
    const audio = {
      id: 'vo',
      path: 'vo.m4a',
      kind: 'audio',
      durationSeconds: 10,
      media: { peaks: [0.5] },
    } as Asset;
    expect(toModelAsset(audio)).not.toHaveProperty('sound');
  });
});
