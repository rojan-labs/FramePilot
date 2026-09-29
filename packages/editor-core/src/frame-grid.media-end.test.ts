/**
 * AL42: an `add_clip` never lands its source out-point past the end of its media.
 *
 * Harness run 17 placed a 1.998229 s hit through `add_music` and the frame grid rounded the
 * clip up to 2.0 s; its `add_clip` calls asked for 2.0 s of that hit and 14 frames of a
 * 0.447506 s whoosh themselves. Nearest-frame rounding now yields to the media: within one
 * frame of its end the clip ends on the last whole frame inside it. Further past, the grid
 * leaves the op alone and the validator refuses it (`validator.media-end.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { Asset } from '@framepilot/timeline-schema';
import {
  mediaLengthSeconds,
  normalizeOperationTimes,
  quantizePatch,
  secondsToFrame,
} from './frame-grid.js';
import { buildAddMusicOps } from './music-placement.js';
import type { AddClipOp } from './operations.js';
import type { AnyOperation, Patch } from './patch.js';

const fps = 30;

const hit: Asset = {
  id: 'hit',
  path: 'media/BOOM_IMPACT_2.mp3',
  kind: 'audio',
  durationSeconds: 1.998229,
};
const whoosh: Asset = {
  id: 'whoosh',
  path: 'media/Swipe_Whoosh.mp3',
  kind: 'audio',
  durationSeconds: 0.447506,
};

const addClip = (over: Partial<AddClipOp>): AddClipOp => ({
  type: 'add_clip',
  trackId: 'sfx',
  assetId: whoosh.id,
  start: 0,
  end: 1,
  sourceStart: 0,
  sourceEnd: 1,
  ...over,
});

const placed = (operations: readonly AnyOperation[]): AddClipOp =>
  operations.find((op): op is AddClipOp => op.type === 'add_clip')!;

const onGrid = (seconds: number): boolean =>
  Math.abs(seconds * fps - Math.round(seconds * fps)) < 1e-9;

describe('an add_clip against the end of its media', () => {
  it("ends add_music's bed on the last whole frame of a track that is not whole frames", () => {
    // The run: a 1.998229 s hit placed at 39.667 s on an empty timeline.
    const ops = buildAddMusicOps({ tracks: [] }, hit, 39.667);
    const clip = placed(normalizeOperationTimes(ops, fps, []));

    expect(onGrid(clip.start)).toBe(true);
    expect(onGrid(clip.end)).toBe(true);
    expect(clip.sourceEnd).toBeLessThanOrEqual(hit.durationSeconds!);
    // 59 whole frames fit in 1.998 s; the 60th would read past the file.
    expect(secondsToFrame(clip.end - clip.start, fps)).toBe(59);
    expect(clip.end - clip.start).toBeCloseTo(clip.sourceEnd - clip.sourceStart, 9);
  });

  it('pulls an author-rounded length of the whole asset back inside it', () => {
    // The run's own add_clip: 14 frames (0.4667 s) of a 0.4475 s whoosh at 13.467 s.
    const clip = placed(
      normalizeOperationTimes(
        [addClip({ start: 13.467, end: 13.933, sourceStart: 0, sourceEnd: 0.466 })],
        fps,
        [whoosh],
      ),
    );
    expect(clip.sourceEnd).toBeLessThanOrEqual(whoosh.durationSeconds!);
    expect(secondsToFrame(clip.end - clip.start, fps)).toBe(13);
    expect(onGrid(clip.end)).toBe(true);
  });

  it('keeps nearest rounding when the nearest frame is inside the media', () => {
    const clip = placed(
      normalizeOperationTimes(
        [addClip({ assetId: hit.id, start: 1.0, end: 2.4, sourceStart: 0, sourceEnd: 1.4 })],
        fps,
        [hit],
      ),
    );
    expect(clip.end).toBeCloseTo(2.4, 9);
    expect(clip.sourceEnd).toBeCloseTo(1.4, 9);
  });

  it('leaves a request more than a frame past the media for the validator', () => {
    const clip = placed(
      normalizeOperationTimes([addClip({ start: 0, end: 1, sourceStart: 0, sourceEnd: 1 })], fps, [
        whoosh,
      ]),
    );
    expect(clip.sourceEnd).toBe(1);
  });

  it('keeps the speed and the in-point when it pulls the out-point in', () => {
    // Half speed from 0.2 s into the hit. The sequence end (107.9 frames) rounds up to 108,
    // which at half speed reads to 2.0 s — past the 1.998 s file.
    const clip = placed(
      normalizeOperationTimes(
        [addClip({ assetId: hit.id, start: 0, end: 3.5972, sourceStart: 0.2, sourceEnd: 1.9986 })],
        fps,
        [hit],
      ),
    );
    expect(clip.sourceStart).toBe(0.2);
    expect(clip.sourceEnd).toBeLessThanOrEqual(hit.durationSeconds!);
    expect((clip.sourceEnd - clip.sourceStart) / (clip.end - clip.start)).toBeCloseTo(0.5, 9);
    expect(secondsToFrame(clip.end, fps)).toBe(107);
    expect(onGrid(clip.end)).toBe(true);
  });

  it('exempts stills and media of unknown length', () => {
    const still: Asset = { id: 'photo', path: 'p.png', kind: 'image', durationSeconds: 0.447506 };
    const unprobed: Asset = { id: 'raw', path: 'r.wav', kind: 'audio' };
    expect(mediaLengthSeconds(still)).toBeUndefined();
    expect(mediaLengthSeconds(unprobed)).toBeUndefined();
    for (const asset of [still, unprobed]) {
      const clip = placed(
        normalizeOperationTimes(
          [addClip({ assetId: asset.id, start: 0, end: 0.466, sourceStart: 0, sourceEnd: 0.466 })],
          fps,
          [asset],
        ),
      );
      expect(secondsToFrame(clip.end, fps)).toBe(14);
    }
  });

  it('is idempotent, so the store and the history agree', () => {
    const patch = {
      patchId: 'p',
      createdBy: 'ai',
      reason: 'AL42',
      operations: buildAddMusicOps({ tracks: [] }, hit, 39.667),
    } as unknown as Patch;
    const once = quantizePatch(patch, fps, []);
    expect(quantizePatch(once, fps, [])).toBe(once);
  });
});
