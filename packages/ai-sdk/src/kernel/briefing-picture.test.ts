import { describe, expect, it } from 'vitest';
import type {
  PictureClip,
  PictureCut,
  PictureCutFlag,
  PictureSlice,
} from './semantic-index/picture.js';
import { MAX_PICTURE_LINES, diffPicture, renderPictureBriefing } from './briefing-picture.js';

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

describe('renderPictureBriefing', () => {
  it('says nothing when nothing about the picture changed', () => {
    const same = [cut({ fromClipId: 'a', toClipId: 'b' })];
    expect(renderPictureBriefing(slice(same), slice(same))).toBe('');
  });

  it('names a new cut with its framing and exposure move, in words', () => {
    const after = slice(
      [
        cut({
          fromClipId: 'a',
          toClipId: 'b',
          at: 12,
          delta: {
            luma: 0.22,
            warmth: null,
            sat: null,
            contrast: null,
            shotSizeSteps: -2,
            sameSetting: null,
            sameEntities: [],
            motionChange: null,
            duplicate: null,
            transition: null,
          },
        }),
      ],
      [clipWithSize('a', 'MS'), clipWithSize('b', 'WS')],
    );
    const text = renderPictureBriefing(slice([]), after);
    expect(text).toContain('0:12.0 new cut');
    expect(text).toContain('MS→WS');
    expect(text).toContain('a stop brighter');
  });

  it('falls back to tighter/wider when a shot size is unknown', () => {
    const after = slice(
      [
        cut({
          fromClipId: 'a',
          toClipId: 'b',
          delta: {
            luma: null,
            warmth: null,
            sat: null,
            contrast: null,
            shotSizeSteps: 3,
            sameSetting: null,
            sameEntities: [],
            motionChange: null,
            duplicate: null,
            transition: null,
          },
        }),
      ],
      [clipWithSize('a', null), clipWithSize('b', null)],
    );
    expect(renderPictureBriefing(slice([]), after)).toContain('tighter');
  });

  it('marks an inherited defect as not this run’s to fix', () => {
    const before = slice([cut({ fromClipId: 'a', toClipId: 'b', flags: ['exposure_jump'] })]);
    const after = slice([cut({ fromClipId: 'a', toClipId: 'b', flags: ['exposure_jump'] })]);
    const text = renderPictureBriefing(before, after);
    expect(text).toContain('already there before this run');
    expect(text).toContain('fix only if asked');
  });

  it('puts a defect this run caused above one it inherited', () => {
    const before = slice([
      cut({ fromClipId: 'a', toClipId: 'b', at: 1, flags: ['soft_in'] }),
      cut({ fromClipId: 'c', toClipId: 'd', at: 30 }),
    ]);
    const after = slice([
      cut({ fromClipId: 'a', toClipId: 'b', at: 1, flags: ['soft_in'] }),
      cut({ fromClipId: 'c', toClipId: 'd', at: 30, flags: ['jump_cut'] }),
    ]);
    const lines = renderPictureBriefing(before, after).split('\n');
    // The jump cut is later in time but is the one this apply caused.
    expect(lines[1]).toContain('jump cut');
    expect(lines[2]).toContain('already there before this run');
  });

  it('collapses beyond the line budget rather than listing everything', () => {
    const cuts = Array.from({ length: MAX_PICTURE_LINES + 3 }, (_, index) =>
      cut({ fromClipId: `a${String(index)}`, toClipId: `b${String(index)}`, at: index }),
    );
    const text = renderPictureBriefing(slice([]), slice(cuts));
    expect(text.split('\n')).toHaveLength(MAX_PICTURE_LINES + 2);
    expect(text).toContain('and 3 more change(s)');
  });

  it('prints no bare decimals a model could copy into a grade', () => {
    const after = slice([
      cut({
        fromClipId: 'a',
        toClipId: 'b',
        delta: {
          luma: 0.44,
          warmth: -0.31,
          sat: 0.2,
          contrast: 0.1,
          shotSizeSteps: 2,
          sameSetting: null,
          sameEntities: [],
          motionChange: null,
          duplicate: null,
          transition: null,
        },
      }),
    ]);
    const text = renderPictureBriefing(slice([]), after);
    expect(text).toContain('cooler');
    // A timestamp is a time, not a value to grade with; nothing else may carry a decimal.
    const withoutClock = text.replace(/\d+:\d+\.\d/g, '');
    expect(withoutClock).not.toMatch(/\d+\.\d/);
  });

  it('names a removed cut without inventing detail for it', () => {
    const text = renderPictureBriefing(
      slice([cut({ fromClipId: 'a', toClipId: 'b', at: 5 })]),
      slice([]),
    );
    expect(text).toContain('0:05.0 cut removed');
  });

  it('renders every flag with a word an editor would use', () => {
    const flags: PictureCutFlag[] = [
      'exposure_jump',
      'wb_jump',
      'jump_cut',
      'size_jump',
      'black_in',
      'soft_in',
    ];
    for (const flag of flags) {
      const text = renderPictureBriefing(
        slice([]),
        slice([cut({ fromClipId: 'a', toClipId: 'b', flags: [flag] })]),
      );
      expect(text).not.toContain(flag);
      expect(text.length).toBeGreaterThan(0);
    }
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
    expect(renderPictureBriefing(before, after)).toContain('now a cross-dissolve');
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
    const text = renderPictureBriefing(
      slice([withTransition]),
      slice([cut({ fromClipId: 'a', toClipId: 'b' })]),
    );
    expect(text).toContain('hard cut');
  });

  it('still calls a new FLAG worse, not merely different', () => {
    const before = slice([cut({ fromClipId: 'a', toClipId: 'b' })]);
    const after = slice([cut({ fromClipId: 'a', toClipId: 'b', flags: ['jump_cut'] })]);
    expect(diffPicture(before, after)[0]?.kind).toBe('worsened');
  });
});
