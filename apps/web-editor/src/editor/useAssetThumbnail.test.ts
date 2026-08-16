/**
 * Tests for useAssetThumbnail — focused on the synchronous resolution order,
 * especially that an IMAGE asset renders from its own source (regression: an
 * older import mislabelled photos as video and left stale derived `thumb_*.png`
 * paths that were never generated → the fp-media ENOENT flood / blank tiles).
 *
 * The async video-frame capture path is DOM/canvas-only (jsdom has no media
 * pipeline) and is `v8 ignore`d in the hook; it is exercised manually / in e2e.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Asset } from '@framepilot/timeline-schema';
import { useAssetThumbnail } from './useAssetThumbnail.js';

describe('useAssetThumbnail', () => {
  it('returns none when there is no asset', () => {
    const { result } = renderHook(() => useAssetThumbnail(undefined));
    expect(result.current).toEqual({ status: 'none' });
  });

  it('renders an image from its OWN source, ignoring a stale derived thumb path', () => {
    const image: Asset = {
      id: 'img',
      path: 'media/p/photo.jpeg',
      kind: 'image',
      durationSeconds: 5,
      // A dead derived path left by an older video-misclassified import.
      media: { thumbnailPaths: ['.framepilot-derived/x/thumbs/thumb_000.png'] },
    };
    const { result } = renderHook(() => useAssetThumbnail(image));
    expect(result.current).toEqual({
      status: 'ready',
      url: 'fp-media://local/media%2Fp%2Fphoto.jpeg',
    });
  });

  it('uses the engine thumbnail path for a video that has one', () => {
    const video: Asset = {
      id: 'v',
      path: 'media/p/clip.mp4',
      kind: 'video',
      durationSeconds: 10,
      media: { thumbnailPaths: ['.framepilot-derived/y/thumbs/thumb_000.png'] },
    };
    const { result } = renderHook(() => useAssetThumbnail(video));
    expect(result.current).toEqual({
      status: 'ready',
      url: 'fp-media://local/.framepilot-derived%2Fy%2Fthumbs%2Fthumb_000.png',
    });
  });

  it('is loading for a session video with no engine thumbnail (async capture pending)', () => {
    const video: Asset = {
      id: 'v',
      path: 'blob:session-clip',
      kind: 'video',
      durationSeconds: 10,
    };
    const { result } = renderHook(() => useAssetThumbnail(video));
    // jsdom never resolves the capture, so the hook stays in its initial loading state.
    expect(result.current).toEqual({ status: 'loading' });
  });
});
