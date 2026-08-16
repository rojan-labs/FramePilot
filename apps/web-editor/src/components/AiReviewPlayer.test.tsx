/**
 * Tests for the AI before/after review player (plan H1.5/J3): default "after"
 * view, the spring-loaded A/B compare, scrubber tick marks, and the auto-seek
 * to the first changed region — the honest review surface for a proposed edit,
 * mounted over the SAME real `PreviewPlayer` used elsewhere (render-vs-preview
 * rule: HTML video, never MoviePy).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { structuredDiffTimeline } from '@framepilot/editor-core';
import { SettingsProvider } from '../editor/useSettings.js';
import { AiReviewPlayer } from './AiReviewPlayer.js';

afterEach(() => localStorage.clear());

const assets = [{ id: 'a', path: 'blob:a', kind: 'video' as const }];

/** A clip trimmed (5s → 3s) between `before` and `after` — one `modified` region. */
const before: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};
const after: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 3,
          sourceStart: 0,
          sourceEnd: 3,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

/** Mark every rendered `<video>` slot as decoded/settled so the preview escapes
 *  the "Preparing preview…" prepare gate (mirrors PreviewPlayer.monitor.test.tsx). */
function settleVideos(container: HTMLElement): void {
  for (const el of container.querySelectorAll('video')) {
    Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(el, 'seeking', { value: false, configurable: true });
    fireEvent.seeked(el);
  }
}

function renderReview(regions = structuredDiffTimeline(before, after)): {
  container: HTMLElement;
} {
  const { container } = render(
    <SettingsProvider>
      <AiReviewPlayer
        before={before}
        after={after}
        changedRegions={regions}
        assets={assets}
        fps={30}
      />
    </SettingsProvider>,
  );
  settleVideos(container);
  return { container };
}

describe('AiReviewPlayer', () => {
  it('shows the "after" timeline by default', () => {
    renderReview();
    const badge = screen.getByText('After');
    expect(badge.className).toContain('ai-review-badge');
    const video = screen.getByLabelText('preview a') as HTMLVideoElement;
    // The "after" clip trims the source to 3s.
    expect(video.tagName).toBe('VIDEO');
  });

  it('holding the A/B control shows "before" and releasing returns to "after"', () => {
    renderReview();
    const ab = screen.getByRole('button', { name: 'Peek original' });
    fireEvent.pointerDown(ab);
    expect(screen.getByText('Before')).toBeTruthy();
    fireEvent.pointerUp(ab);
    expect(screen.getByText('After')).toBeTruthy();
  });

  it('holding the "b" key shows "before" and releasing returns to "after"', () => {
    renderReview();
    const ab = screen.getByRole('button', { name: 'Peek original' });
    fireEvent.keyDown(ab, { key: 'b' });
    expect(screen.getByText('Before')).toBeTruthy();
    fireEvent.keyUp(ab, { key: 'b' });
    expect(screen.getByText('After')).toBeTruthy();
  });

  it('renders one scrubber tick per changed region', () => {
    const regions = structuredDiffTimeline(before, after);
    const { container } = renderReview(regions);
    expect(regions.length).toBe(1);
    expect(container.querySelectorAll('.ai-review-tick').length).toBe(regions.length);
  });

  it("auto-seeks to the first changed region's start on mount", () => {
    // The single `modified` region here starts at 0, so assert via a region that
    // starts later: prepend an untouched clip so the changed region starts at 4s.
    const shiftedBefore: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c0',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
            { ...before.tracks[0]!.clips[0]!, id: 'c1', start: 4, end: 9, sourceEnd: 5 },
          ],
        },
      ],
    };
    const shiftedAfter: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            shiftedBefore.tracks[0]!.clips[0]!,
            { ...after.tracks[0]!.clips[0]!, id: 'c1', start: 4, end: 7, sourceEnd: 3 },
          ],
        },
      ],
    };
    const regions = structuredDiffTimeline(shiftedBefore, shiftedAfter);
    const { container } = render(
      <SettingsProvider>
        <AiReviewPlayer
          before={shiftedBefore}
          after={shiftedAfter}
          changedRegions={regions}
          assets={assets}
          fps={30}
        />
      </SettingsProvider>,
    );
    settleVideos(container);
    expect(screen.getByLabelText('current time').textContent).toBe('00:00:04:00');
  });

  it('exposes ONE shared playhead scrubber + transport for both panels', () => {
    renderReview();
    // A single, prominent playhead slider — not two separate per-panel ones.
    expect(screen.getByRole('slider', { name: 'Preview playhead' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jump to next change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jump to previous change' })).toBeTruthy();
  });

  it('the shared play button toggles playback for the whole review', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));
    // The one control flips to Pause — it drives both panels (shared `playing`).
    expect(screen.getByRole('button', { name: 'Pause preview' })).toBeTruthy();
  });

  describe('side-by-side layout (H1.5/J3)', () => {
    it('switches from hold-to-compare to side-by-side via the layout toggle', () => {
      const { container } = renderReview();
      // Hold layout by default: one preview, the "Hold for before" control.
      expect(screen.getByRole('button', { name: 'Peek original' })).toBeTruthy();
      expect(container.querySelectorAll('.preview').length).toBe(1);

      fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
      settleVideos(container);

      // Split layout: two mounted previews, hold-to-compare control is gone.
      expect(container.querySelectorAll('.preview').length).toBe(2);
      expect(screen.queryByRole('button', { name: 'Peek original' })).toBeNull();
      expect(screen.getAllByText('Before').length).toBeGreaterThan(0);
      expect(screen.getAllByText('After').length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));
      expect(container.querySelectorAll('.preview').length).toBe(1);
      expect(screen.getByRole('button', { name: 'Peek original' })).toBeTruthy();
    });

    it('renders both panels at the same scrubbed instant', () => {
      const { container } = renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
      settleVideos(container);

      const tick = container.querySelector('.ai-review-tick') as HTMLButtonElement;
      fireEvent.click(tick);

      const times = screen.getAllByLabelText('current time').map((el) => el.textContent);
      expect(times.length).toBe(2);
      expect(times[0]).toBe(times[1]);
    });

    it("mutes the before panel's video element but not the after panel's", () => {
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));

      const beforeSide = screen.getByText('Before').closest('[data-side="before"]') as HTMLElement;
      const afterSide = screen.getByText('After').closest('[data-side="after"]') as HTMLElement;
      const beforeVideo = beforeSide.querySelector(
        'video[aria-label="preview a"]',
      ) as HTMLVideoElement;
      const afterVideo = afterSide.querySelector(
        'video[aria-label="preview a"]',
      ) as HTMLVideoElement;
      expect(beforeVideo.muted).toBe(true);
      expect(afterVideo.muted).toBe(false);
    });
  });
});
