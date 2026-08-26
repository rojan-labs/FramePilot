/**
 * The preview shows the frame the export will contain (context-management P3.4 / ADR 0146).
 *
 * The render half of this invariant is measured in
 * `engine/python/tests/test_render_frame_accuracy.py`, which exports a two-shot timeline
 * and probes the file frame by frame around the cut. This is the other half: at the same
 * frame times, the editor's own picture selection must pick the same shot. The two legs
 * meet at one function — `secondsToFrame` — because there is now exactly one grid
 * (ADR 0146), and a second rounding rule on either side is precisely how a preview and an
 * export come to disagree about which frame a cut is on.
 *
 * What this can and cannot prove. It proves the SELECTION is frame-exact: which clip the
 * preview is showing at frame N. It cannot prove what a browser's decoder does with a
 * `currentTime` seek inside that clip — that is the browser's business, happens in no
 * test runner, and is why the preview seeks to a source offset derived from a boundary
 * that is now itself a frame rather than a float.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { frameToSeconds, secondsToFrame } from '@framepilot/editor-core';
import { activeClipsAt, createPlaybackIndex } from './selectors-base.js';

const FPS = 30;

const clip = (id: string, start: number, end: number): Clip => ({
  id,
  trackId: 'video_1',
  assetId: 'asset_1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

/** Two shots, cut on a frame that is deliberately nowhere near a round second. */
const CUT_FRAME = secondsToFrame(4.7, FPS);
const CUT_SECONDS = frameToSeconds(CUT_FRAME, FPS);
const END_SECONDS = frameToSeconds(secondsToFrame(9, FPS), FPS);

const timeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [clip('shot_one', 0, CUT_SECONDS), clip('shot_two', CUT_SECONDS, END_SECONDS)],
    },
  ],
});

/** Sample the MIDDLE of a frame's interval, exactly as the render probe does. */
const atFrame = (frame: number): string | null => {
  const index = createPlaybackIndex(timeline(), new Map());
  const t = frameToSeconds(frame, FPS) + 0.5 / FPS;
  return activeClipsAt(index, t)[0]?.clip.id ?? null;
};

describe('the preview cuts on the frame the export cuts on', () => {
  it('shows the outgoing shot on the frame before the cut', () => {
    expect(atFrame(CUT_FRAME - 1)).toBe('shot_one');
  });

  it('shows the incoming shot on the cut frame itself', () => {
    // The render probe asserts the same thing about the exported file at the same frame
    // index. Divergence: 0 frames.
    expect(atFrame(CUT_FRAME)).toBe('shot_two');
  });

  it('agrees on every frame across the seam, not only the two either side', () => {
    for (let frame = CUT_FRAME - 5; frame < CUT_FRAME; frame += 1) {
      expect(atFrame(frame), `frame ${frame}`).toBe('shot_one');
    }
    for (let frame = CUT_FRAME; frame <= CUT_FRAME + 5; frame += 1) {
      expect(atFrame(frame), `frame ${frame}`).toBe('shot_two');
    }
  });

  it('puts the boundary exactly on a frame, so there is a frame to agree about', () => {
    // The premise of the whole invariant. Before ADR 0146 a cut sat at an arbitrary float
    // and neither side could say which frame it meant.
    expect(frameToSeconds(secondsToFrame(CUT_SECONDS, FPS), FPS)).toBe(CUT_SECONDS);
  });
});
