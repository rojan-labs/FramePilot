import { describe, expect, it } from 'vitest';
import type {
  PictureClip,
  PictureCut,
  PictureCutFlag,
  PictureSlice,
} from './semantic-index/picture.js';
import { diffPicture } from './briefing-picture.js';

function cut(over: Partial<PictureCut> & Pick<PictureCut, 'fromClipId' | 'toClipId'>): PictureCut {
  return {
    trackId: 'v1',
    at: 12,
    delta: {
      luma: null,
      warmth: null,
      sat: null,
      contrast: null,
      shotSizeSteps: null,
      sameSetting: null,
      sameEntities: [],
      motionChange: null,
      duplicate: null,
      transition: null,
    },
    flags: [],
    ...over,
  } as PictureCut;
}

function clipWithSize(clipId: string, shotSize: string | null): PictureClip {
  return {
    clipId,
    trackId: 'v1',
    start: 0,
    end: 4,
    assetId: 'a1',
    shots: [],
    dominant:
      shotSize === null
        ? null
        : ({
            shotKey: `${clipId}:0`,
            assetId: 'a1',
            contentHash: 'h',
            shotIndex: 0,
            t0: 0,
            t1: 4,
            splitOf: false,
            measured: null,
            labelled: { tier1Version: 1, model: 'm', shotSize: { value: shotSize, p: 0.9 } },
            described: null,
          } as PictureClip['dominant']),
  } as PictureClip;
}

function slice(cuts: readonly PictureCut[], clips: readonly PictureClip[] = []): PictureSlice {
  return {
    clips,
    cuts,
    coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
  } as PictureSlice;
}

describe('diffPicture', () => {
  it('reports a cut that this apply created', () => {
    const after = slice([cut({ fromClipId: 'a', toClipId: 'b' })]);
    const changes = diffPicture(slice([]), after);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('added');
  });

  it('reports a cut that this apply removed', () => {
    const changes = diffPicture(slice([cut({ fromClipId: 'a', toClipId: 'b' })]), slice([]));
    expect(changes[0]?.kind).toBe('removed');
  });

  it('separates a flag this apply caused from one the footage already had', () => {
    const before = slice([cut({ fromClipId: 'a', toClipId: 'b', flags: ['soft_in'] })]);
    const after = slice([
      cut({ fromClipId: 'a', toClipId: 'b', flags: ['soft_in', 'exposure_jump'] }),
    ]);
    const change = diffPicture(before, after)[0];
    expect(change?.kind).toBe('worsened');
    expect(change?.newFlags).toEqual(['exposure_jump']);
    expect(change?.inheritedFlags).toEqual(['soft_in']);
  });

  it('does not report an untouched, unflagged cut at all', () => {
    const same = [cut({ fromClipId: 'a', toClipId: 'b' })];
    expect(diffPicture(slice(same), slice(same))).toEqual([]);
  });

  it('treats the first apply of a run as all-new rather than throwing', () => {
    expect(diffPicture(null, slice([cut({ fromClipId: 'a', toClipId: 'b' })]))).toHaveLength(1);
  });
});

describe('a transition on a cut that already existed', () => {
  it('is reported, even though no flag changed', () => {
    // Keying on flags alone dropped this silently: `add_transitions` over an existing
    // sequence produced no picture line at all, which is the edit most worth reporting.
    const before = slice([cut({ fromClipId: 'a', toClipId: 'b', at: 12 })]);
    const after = slice([
      cut({
        fromClipId: 'a',
        toClipId: 'b',
        at: 12,
        delta: {
          luma: null,
          warmth: null,
          sat: null,
          contrast: null,
          shotSizeSteps: null,
          sameSetting: null,
          sameEntities: [],
          motionChange: null,
          duplicate: null,
          transition: 'cross-dissolve',
        },
      }),
    ]);
    const change = diffPicture(before, after)[0];
    expect(change?.kind).toBe('transitioned');
  });

  it('reports a transition that was removed as a return to a hard cut', () => {
    const withTransition = cut({
      fromClipId: 'a',
      toClipId: 'b',
      delta: {
        luma: null,
        warmth: null,
        sat: null,
        contrast: null,
        shotSizeSteps: null,
        sameSetting: null,
        sameEntities: [],
        motionChange: null,
        duplicate: null,
        transition: 'fade',
      },
    });
    const change = diffPicture(
      slice([withTransition]),
      slice([cut({ fromClipId: 'a', toClipId: 'b' })]),
    )[0];
    expect(change?.kind).toBe('transitioned');
  });

  it('still calls a new FLAG worse, not merely different', () => {
    const before = slice([cut({ fromClipId: 'a', toClipId: 'b' })]);
    const after = slice([cut({ fromClipId: 'a', toClipId: 'b', flags: ['jump_cut'] })]);
    expect(diffPicture(before, after)[0]?.kind).toBe('worsened');
  });
});
