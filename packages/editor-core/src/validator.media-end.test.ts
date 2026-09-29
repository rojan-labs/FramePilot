/**
 * AL42 / #156: the validator refuses a clip that reads more than a frame past its media.
 *
 * Judged on the delta: an operation that places or extends a clip past the end of its audio
 * or video is refused with the asset's length and a remedy; a project that already holds
 * such a clip can still be split, moved and undone. Stills and media of unknown length are
 * exempt.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import type { AnyOperation } from './patch.js';
import { validatePatch } from './validator.js';

const fps = 30;

const whoosh: Asset = {
  id: 'whoosh',
  path: 'media/Swipe_Whoosh.mp3',
  kind: 'audio',
  durationSeconds: 0.447506,
};
const shot: Asset = { id: 'shot', path: 'media/shot.mp4', kind: 'video', durationSeconds: 4 };
const photo: Asset = { id: 'photo', path: 'media/p.png', kind: 'image', durationSeconds: 0.2 };
const unprobed: Asset = { id: 'raw', path: 'media/raw.wav', kind: 'audio' };

const clip = (over: Partial<Clip> & Pick<Clip, 'id' | 'trackId' | 'assetId'>): Clip => ({
  start: 0,
  end: 1,
  sourceStart: 0,
  sourceEnd: 1,
  effects: [],
  keyframes: [],
  ...over,
});

const timeline = (sfx: readonly Clip[] = [], picture: readonly Clip[] = []): Timeline => ({
  tracks: [
    { id: 'v', type: 'video', clips: [...picture] },
    { id: 'sfx', type: 'audio', clips: [...sfx] },
  ],
});

const validate = (
  ops: readonly AnyOperation[],
  on: Timeline = timeline(),
  assets: readonly Asset[] = [whoosh, shot, photo, unprobed],
) => validatePatch(on, { operations: ops }, { assetIds: assets.map((a) => a.id), assets, fps });

const place = (assetId: string, sourceEnd: number, start = 2): AnyOperation => ({
  type: 'add_clip',
  trackId: 'sfx',
  assetId,
  clipId: 'placed',
  start,
  end: start + sourceEnd,
  sourceStart: 0,
  sourceEnd,
});

describe('source_past_media_end', () => {
  it('refuses a clip placed more than a frame past its audio, naming the length and the fix', () => {
    const result = validate([place(whoosh.id, 1.0)]);
    expect(result.valid).toBe(false);
    const [issue] = result.issues;
    expect(issue?.code).toBe('source_past_media_end');
    expect(issue?.operationIndex).toBe(0);
    expect(issue?.message).toContain("Clip 'placed'");
    expect(issue?.message).toContain("asset 'whoosh', which is 0.448s long");
    expect(issue?.message).toBe(
      "Clip 'placed' reads past the end of asset 'whoosh', which is 0.448s long. Its source " +
        'range must end by 0.448s: trim it with trim_clip, place it shorter, or slow it down, ' +
        'so the clip plays no more of the asset than it holds.',
    );
  });

  it('says the same thing however far past the end a retry lands', () => {
    // The message keys the repeated-failure guard; the overrun must not be in it.
    const first = validate([place(whoosh.id, 1.0)]).issues[0]?.message;
    const retry = validate([place(whoosh.id, 0.9)]).issues[0]?.message;
    expect(retry).toBe(first);
  });

  it('allows a sub-frame overrun: that is rounding, and the render plays it as silence', () => {
    expect(validate([place(whoosh.id, 14 / fps)]).valid).toBe(true);
  });

  it('refuses a trim that extends a video clip past its file', () => {
    const on = timeline(
      [],
      [clip({ id: 'c', trackId: 'v', assetId: shot.id, end: 3, sourceEnd: 3 })],
    );
    const result = validate([{ type: 'trim_clip', clipId: 'c', start: 0, end: 5 }], on);
    expect(result.issues.map((issue) => issue.code)).toContain('source_past_media_end');
  });

  describe("#156's retimes", () => {
    // A 4 s file placed as a 2 s clip from source 0.5 s.
    const on = timeline(
      [],
      [clip({ id: 'c', trackId: 'v', assetId: shot.id, end: 2, sourceStart: 0.5, sourceEnd: 2.5 })],
    );

    it('refuses a 3x retime that keeps the slot by reading to 6.5 s', () => {
      const result = validate(
        [
          { type: 'set_clip_speed', clipId: 'c', speed: 3 },
          // Back to its 2 s slot: at 3x that reads 6 s of source, to 6.5 s.
          { type: 'trim_clip', clipId: 'c', start: 0, end: 2 },
        ],
        on,
      );
      expect(result.issues.map((issue) => issue.code)).toContain('source_past_media_end');
    });

    it('refuses a fitted ramp whose curve reads past the file', () => {
      const result = validate(
        [
          {
            type: 'set_clip_speed_ramp',
            clipId: 'c',
            ramp: [{ id: 'r0', sourceTime: 0, rate: 3, easing: 'linear' }],
            keepDuration: true,
          },
        ],
        on,
      );
      expect(result.issues.map((issue) => issue.code)).toEqual(['source_past_media_end']);
    });

    it('allows a fitted ramp that stays inside the file', () => {
      const result = validate(
        [
          {
            type: 'set_clip_speed_ramp',
            clipId: 'c',
            ramp: [{ id: 'r0', sourceTime: 0, rate: 1.5, easing: 'linear' }],
            keepDuration: true,
          },
        ],
        on,
      );
      expect(result.valid).toBe(true);
    });
  });

  it('checks media that arrives in the same patch', () => {
    const fetched: Asset = { ...whoosh, id: 'fetched' };
    const result = validate(
      [{ type: 'add_asset', asset: fetched }, place(fetched.id, 1.0)],
      timeline(),
      [],
    );
    expect(result.issues.map((issue) => issue.code)).toEqual(['source_past_media_end']);
    expect(result.issues[0]?.operationIndex).toBe(1);
  });

  it('exempts stills, media of unknown length, and a caller that passes no assets', () => {
    expect(validate([place(photo.id, 1.0)]).valid).toBe(true);
    expect(validate([place(unprobed.id, 5.0)]).valid).toBe(true);
    const bare = validatePatch(timeline(), { operations: [place(whoosh.id, 1.0)] }, { fps });
    expect(bare.valid).toBe(true);
  });

  describe('a project that already holds an overrun', () => {
    const legacy = clip({ id: 'old', trackId: 'sfx', assetId: whoosh.id, end: 1, sourceEnd: 1 });

    it('can still split, move and delete around it', () => {
      const on = timeline([legacy]);
      expect(validate([{ type: 'split_clip', clipId: 'old', at: 0.5 }], on).valid).toBe(true);
      expect(
        validate([{ type: 'move_clip', clipId: 'old', toTrackId: 'sfx', toStart: 3 }], on).valid,
      ).toBe(true);
      expect(validate([{ type: 'trim_clip', clipId: 'old', start: 0, end: 0.8 }], on).valid).toBe(
        true,
      );
    });

    it('is restored exactly by an undo', () => {
      const result = validate(
        [{ type: 'restore_clips', trackId: 'sfx', clips: [legacy] }],
        timeline(),
      );
      expect(result.valid).toBe(true);
    });

    it('does not excuse a new clip that reads further than it did', () => {
      const on = timeline([legacy]);
      expect(validate([place(whoosh.id, 1.5, 4)], on).valid).toBe(false);
    });
  });
});
