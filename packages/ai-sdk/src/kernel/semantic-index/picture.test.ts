/**
 * Tests for the `picture` slice (kernel/semantic-index/picture.ts, ADR 0175 / plan VU2.2).
 *
 * What these assert, in order: the asset→timeline projection under trim, speed, reverse and
 * a speed curve; dominance; that cuts exist only between touching neighbours on one layer;
 * every flag firing AND staying silent at its boundary; that a missing tier reads as unknown
 * rather than as agreement; memoization identity; and the empty-ledger case.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Effect, Project, Track } from '@framepilot/timeline-schema';
import { indexFor } from '../../project-index.js';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from '../../ledger.js';
import {
  DEFAULT_CUT_FPS,
  derivePicture,
  phashHamming,
  pictureFor,
  pictureSliceFor,
  PICTURE_FLAG_THRESHOLDS,
  type PictureSlice,
} from './picture.js';

// --- fixtures ---------------------------------------------------------------

const clip = (over: Partial<Clip> & Pick<Clip, 'id' | 'trackId' | 'assetId'>): Clip => ({
  start: 0,
  end: 5,
  sourceStart: 0,
  sourceEnd: 5,
  effects: [],
  keyframes: [],
  ...over,
});

const track = (id: string, type: Track['type'], clips: Clip[]): Track => ({ id, type, clips });

const project = (tracks: Track[], fps = 30): Project =>
  ({
    id: 'p1',
    name: 'Demo',
    version: 1,
    fps,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a1', path: '/media/a.mp4', kind: 'video' },
      { id: 'a2', path: '/media/b.mp4', kind: 'video' },
      { id: 'img', path: '/media/logo.png', kind: 'image' },
      { id: 'aud', path: '/media/music.mp3', kind: 'audio' },
    ],
    folders: [],
    timeline: { tracks },
    transcript: [],
    aiMemory: {},
    history: [],
    markers: [],
  }) as unknown as Project;

/** A fully measured tier-0 record; every test overrides only what it is about. */
const measured = (over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  tier0Version: 1,
  luma: { mean: 0.5, std: 0.1, p10: 0.2, p90: 0.8 },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: 0.6,
  motion: { si: 40, ti: 8, class: 'static' },
  cutScore: 0.3,
  black: false,
  freeze: false,
  sharpness: 0.8,
  phash: '0000000000000000',
  ...over,
});

const shot = (
  assetId: string,
  shotIndex: number,
  t0: number,
  t1: number,
  over: Partial<ShotRecord> = {},
): ShotRecord => ({
  assetId,
  contentHash: 'h1',
  shotIndex,
  t0,
  t1,
  keyframeT: (t0 + t1) / 2,
  splitOf: false,
  measured: measured(),
  ...over,
});

const ledgerOf = (shots: ShotRecord[]): LedgerSnapshot => ({
  shots,
  digests: [],
  coverage: { measured: shots.length, labelled: 0, described: 0, total: shots.length },
});

const sliceOf = (tracks: Track[], shots: ShotRecord[], fps = 30): PictureSlice => {
  const proj = project(tracks, fps);
  return pictureFor(proj, indexFor(proj), ledgerOf(shots));
};

const clipOf = (slice: PictureSlice, clipId: string) =>
  slice.clips.find((c) => c.clipId === clipId);

// --- asset -> timeline mapping ---------------------------------------------

describe('derivePicture — asset time to timeline time', () => {
  it('places a shot at the same timeline seconds for an untrimmed 1x clip', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 10, sourceEnd: 10 }),
        ]),
      ],
      [shot('a1', 0, 2, 6)],
    );
    expect(clipOf(slice, 'c1')?.shots).toEqual([expect.objectContaining({ tStart: 2, tEnd: 6 })]);
  });

  it('offsets by the trim and clips a shot to the source window', () => {
    // Source [10,20) placed at timeline [4,14): asset 12 is timeline 6.
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({
            id: 'c1',
            trackId: 'v1',
            assetId: 'a1',
            start: 4,
            end: 14,
            sourceStart: 10,
            sourceEnd: 20,
          }),
        ]),
      ],
      [
        shot('a1', 0, 0, 12), // starts before the in-point: clipped to [10,12)
        shot('a1', 1, 12, 30), // runs past the out-point: clipped to [12,20)
        shot('a1', 2, 40, 44), // entirely outside: not shown at all
      ],
    );
    expect(clipOf(slice, 'c1')?.shots).toEqual([
      expect.objectContaining({ tStart: 4, tEnd: 6 }),
      expect.objectContaining({ tStart: 6, tEnd: 14 }),
    ]);
  });

  it('compresses source time by a constant speed', () => {
    // speed 2: source [0,10) occupies timeline [0,5); asset 4 lands at timeline 2.
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 5, sourceEnd: 10, speed: 2 }),
        ]),
      ],
      [shot('a1', 0, 4, 8)],
    );
    expect(clipOf(slice, 'c1')?.shots[0]).toMatchObject({ tStart: 2, tEnd: 4 });
  });

  it('stretches source time for slow motion', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 8, sourceEnd: 4, speed: 0.5 }),
        ]),
      ],
      [shot('a1', 0, 1, 2)],
    );
    expect(clipOf(slice, 'c1')?.shots[0]).toMatchObject({ tStart: 2, tEnd: 4 });
  });

  it('mirrors the span for a reversed clip', () => {
    // speed -1 over source [0,10): asset 8 is on screen at timeline 2, asset 6 at 4.
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 10, sourceEnd: 10, speed: -1 }),
        ]),
      ],
      [shot('a1', 0, 6, 8)],
    );
    expect(clipOf(slice, 'c1')?.shots[0]).toMatchObject({ tStart: 2, tEnd: 4 });
  });

  it('gives a freeze frame the whole clip when the span holds its frame, and nothing otherwise', () => {
    const frozen = clip({
      id: 'c1',
      trackId: 'v1',
      assetId: 'a1',
      start: 0,
      end: 3,
      sourceStart: 7,
      sourceEnd: 8,
      speed: 0,
    });
    const covering = sliceOf([track('v1', 'video', [frozen])], [shot('a1', 0, 6, 7.5)]);
    expect(covering.clips[0]?.shots[0]).toMatchObject({ tStart: 0, tEnd: 3 });

    const notCovering = sliceOf([track('v1', 'video', [frozen])], [shot('a1', 0, 7.5, 7.9)]);
    expect(notCovering.clips[0]?.shots).toEqual([]);
  });

  it('maps through a speed curve by its integral, not by a constant-speed guess', () => {
    // A linear ramp from 1x to 2x over source [0,8): the timeline duration is the integral
    // of the reciprocal rate, 8·ln2 ≈ 5.545s, and source second 4 lands at 8·ln1.5 ≈ 3.244s.
    const ramped = clip({
      id: 'c1',
      trackId: 'v1',
      assetId: 'a1',
      end: 8 * Math.LN2,
      sourceEnd: 8,
      speedRamp: [
        { id: 'p0', sourceTime: 0, rate: 1, easing: 'linear' },
        { id: 'p1', sourceTime: 8, rate: 2, easing: 'linear' },
      ],
    });
    const slice = sliceOf([track('v1', 'video', [ramped])], [shot('a1', 0, 4, 8)]);
    const span = slice.clips[0]?.shots[0];
    expect(span?.tStart).toBeCloseTo(8 * Math.log(1.5), 6);
    expect(span?.tEnd).toBeCloseTo(8 * Math.LN2, 6);
    // Reading the same clip at a constant 8/(8·ln2) would have put the shot's start at 2.77s.
    expect(span?.tStart).not.toBeCloseTo(4 / Math.LN2, 3);
  });

  it('never reports a picture clip for audio or caption clips', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })]),
        track('au1', 'audio', [clip({ id: 'c2', trackId: 'au1', assetId: 'aud' })]),
        track('ov1', 'overlay', [clip({ id: 'c3', trackId: 'ov1', assetId: '__caption__' })]),
        track('ov2', 'overlay', [clip({ id: 'c4', trackId: 'ov2', assetId: 'img' })]),
      ],
      [shot('a1', 0, 0, 5)],
    );
    expect(slice.clips.map((c) => c.clipId).sort()).toEqual(['c1', 'c4']);
  });
});

// --- dominance --------------------------------------------------------------

describe('derivePicture — dominant shot', () => {
  it('picks the shot covering most of the clip, not the first one', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 10, sourceEnd: 10 }),
        ]),
      ],
      [shot('a1', 0, 0, 1), shot('a1', 1, 1, 8), shot('a1', 2, 8, 10)],
    );
    const c1 = clipOf(slice, 'c1');
    expect(c1?.shots).toHaveLength(3);
    expect(c1?.dominant?.shotIndex).toBe(1);
  });

  it('counts only the part of a shot the trim actually shows', () => {
    // Shot 0 is long in the asset but only 1s of it is inside the clip; shot 1 gives 4s.
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({
            id: 'c1',
            trackId: 'v1',
            assetId: 'a1',
            start: 0,
            end: 5,
            sourceStart: 9,
            sourceEnd: 14,
          }),
        ]),
      ],
      [shot('a1', 0, 0, 10), shot('a1', 1, 10, 20)],
    );
    expect(clipOf(slice, 'c1')?.dominant?.shotIndex).toBe(1);
  });

  it('leaves dominant null for a clip whose asset has no ledger rows', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1' }),
          clip({ id: 'c2', trackId: 'v1', assetId: 'a2', start: 5, end: 10 }),
        ]),
      ],
      [shot('a1', 0, 0, 5)],
    );
    expect(clipOf(slice, 'c2')?.dominant).toBeNull();
    expect(clipOf(slice, 'c2')?.shots).toEqual([]);
  });
});

// --- cut detection ----------------------------------------------------------

describe('derivePicture — which pairs are cuts', () => {
  const twoClips = (aEnd: number, bStart: number, trackA = 'v1', trackB = 'v1'): Track[] => {
    const clips: Record<string, Clip[]> = {};
    const push = (t: string, c: Clip) => {
      clips[t] = [...(clips[t] ?? []), c];
    };
    push(
      trackA,
      clip({ id: 'c1', trackId: trackA, assetId: 'a1', start: 0, end: aEnd, sourceEnd: aEnd }),
    );
    push(
      trackB,
      clip({ id: 'c2', trackId: trackB, assetId: 'a2', start: bStart, end: bStart + 5 }),
    );
    return Object.entries(clips).map(([id, cs]) => track(id, 'video', cs));
  };

  it('reports a cut when the edges butt exactly', () => {
    const slice = sliceOf(twoClips(5, 5), [shot('a1', 0, 0, 5), shot('a2', 0, 0, 5)]);
    expect(slice.cuts).toHaveLength(1);
    expect(slice.cuts[0]).toMatchObject({ fromClipId: 'c1', toClipId: 'c2', at: 5, trackId: 'v1' });
  });

  it('tolerates a sub-frame gap left by a trim but not a real one', () => {
    const withinAFrame = sliceOf(twoClips(5, 5 + 1 / 60), [shot('a1', 0, 0, 5)]);
    expect(withinAFrame.cuts).toHaveLength(1);

    const beyondAFrame = sliceOf(twoClips(5, 5.5), [shot('a1', 0, 0, 5)]);
    expect(beyondAFrame.cuts).toEqual([]);
  });

  it('does not cut between clips on different layers however aligned', () => {
    const slice = sliceOf(twoClips(5, 5, 'v1', 'v2'), [shot('a1', 0, 0, 5), shot('a2', 0, 0, 5)]);
    expect(slice.cuts).toEqual([]);
  });

  it('cuts only between adjacent neighbours, never across a clip', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 2 }),
          clip({ id: 'c2', trackId: 'v1', assetId: 'a1', start: 2, end: 4 }),
          clip({ id: 'c3', trackId: 'v1', assetId: 'a1', start: 4, end: 6 }),
        ]),
      ],
      [],
    );
    expect(slice.cuts.map((c) => [c.fromClipId, c.toClipId])).toEqual([
      ['c1', 'c2'],
      ['c2', 'c3'],
    ]);
  });

  it('carries the transition kind sitting on the incoming clip', () => {
    const transition: Effect = {
      id: 'e1',
      type: 'transition',
      params: { kind: 'cross-dissolve', durationSeconds: 0.5 },
      keyframes: [],
    };
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 5 }),
          clip({
            id: 'c2',
            trackId: 'v1',
            assetId: 'a2',
            start: 5,
            end: 10,
            effects: [transition],
          }),
        ]),
      ],
      [shot('a1', 0, 0, 5), shot('a2', 0, 0, 5)],
    );
    expect(slice.cuts[0]?.delta.transition).toBe('cross-dissolve');
  });
});

// --- deltas and flags -------------------------------------------------------

/** Two touching clips on one layer, each showing exactly one shot of its own asset. */
const cutBetween = (
  from: Partial<ShotRecord>,
  to: Partial<ShotRecord>,
  clipOver: { fromSourceEnd?: number; toSourceStart?: number; sameAsset?: boolean } = {},
): PictureSlice => {
  const toAsset = clipOver.sameAsset === false ? 'a2' : 'a1';
  const fromSourceEnd = clipOver.fromSourceEnd ?? 5;
  // Default source ranges are disjoint so each clip shows exactly one of the two shots, and
  // the default phashes differ so `duplicate` is false unless a test asks for it.
  const toSourceStart = clipOver.toSourceStart ?? 5;
  return sliceOf(
    [
      track('v1', 'video', [
        clip({
          id: 'c1',
          trackId: 'v1',
          assetId: 'a1',
          start: 0,
          end: 5,
          sourceStart: fromSourceEnd - 5,
          sourceEnd: fromSourceEnd,
        }),
        clip({
          id: 'c2',
          trackId: 'v1',
          assetId: toAsset,
          start: 5,
          end: 10,
          sourceStart: toSourceStart,
          sourceEnd: toSourceStart + 5,
        }),
      ]),
    ],
    [
      shot('a1', 0, fromSourceEnd - 5, fromSourceEnd, from),
      shot(toAsset, 1, toSourceStart, toSourceStart + 5, {
        measured: measured({ phash: 'ffff0000ffff0000' }),
        ...to,
      }),
    ],
  );
};

describe('derivePicture — flags at their boundaries', () => {
  it('raises exposure_jump above the threshold and not at it', () => {
    const at = cutBetween(
      { measured: measured({ luma: { mean: 0.3, std: 0.1, p10: 0.1, p90: 0.5 } }) },
      {
        measured: measured({
          luma: { mean: 0.3 + PICTURE_FLAG_THRESHOLDS.exposureJump, std: 0.1, p10: 0.1, p90: 0.5 },
        }),
      },
    );
    expect(at.cuts[0]?.delta.luma).toBeCloseTo(PICTURE_FLAG_THRESHOLDS.exposureJump, 9);
    expect(at.cuts[0]?.flags).not.toContain('exposure_jump');

    const over = cutBetween(
      { measured: measured({ luma: { mean: 0.3, std: 0.1, p10: 0.1, p90: 0.5 } }) },
      { measured: measured({ luma: { mean: 0.7, std: 0.1, p10: 0.1, p90: 0.5 } }) },
    );
    expect(over.cuts[0]?.flags).toContain('exposure_jump');
    // Signed to − from: this cut gets brighter.
    expect(over.cuts[0]?.delta.luma).toBeCloseTo(0.4, 9);
  });

  it('raises wb_jump above the threshold and not at it', () => {
    const at = cutBetween(
      { measured: measured({ warmth: 0 }) },
      { measured: measured({ warmth: PICTURE_FLAG_THRESHOLDS.wbJump }) },
    );
    expect(at.cuts[0]?.flags).not.toContain('wb_jump');

    const over = cutBetween(
      { measured: measured({ warmth: 0.1 }) },
      { measured: measured({ warmth: -0.3 }) },
    );
    expect(over.cuts[0]?.flags).toContain('wb_jump');
  });

  it('raises size_jump at three ladder steps but not at two', () => {
    const labelled = (value: string) => ({
      tier1Version: 1,
      model: 'siglip',
      shotSize: { value, p: 0.9 },
      faces: 0,
      entities: [],
    });
    const two = cutBetween(
      { labelled: labelled('MS') },
      { labelled: labelled('CU') }, // MS -> CU is 2 steps
    );
    expect(two.cuts[0]?.delta.shotSizeSteps).toBe(2);
    expect(two.cuts[0]?.flags).not.toContain('size_jump');

    const three = cutBetween({ labelled: labelled('MS') }, { labelled: labelled('ECU') });
    expect(three.cuts[0]?.delta.shotSizeSteps).toBe(3);
    expect(three.cuts[0]?.flags).toContain('size_jump');
  });

  it('raises jump_cut only for the same asset, a matching phash and a short excision', () => {
    const same = { measured: measured({ phash: 'ffffffffffffffff' }) };
    // Source 0–5 then 6–11: a one-second excision from one asset, same picture.
    const near = cutBetween(same, same, { fromSourceEnd: 5, toSourceStart: 6 });
    expect(near.cuts[0]?.delta.duplicate).toBe(true);
    expect(near.cuts[0]?.flags).toContain('jump_cut');

    const far = cutBetween(same, same, { fromSourceEnd: 5, toSourceStart: 40 });
    expect(far.cuts[0]?.delta.duplicate).toBe(true);
    expect(far.cuts[0]?.flags).not.toContain('jump_cut');

    const otherAsset = cutBetween(same, same, {
      fromSourceEnd: 5,
      toSourceStart: 6,
      sameAsset: false,
    });
    expect(otherAsset.cuts[0]?.flags).not.toContain('jump_cut');

    // 8 differing bits: past the Hamming threshold, so not a duplicate at all.
    const different = cutBetween(same, { measured: measured({ phash: '00ffffffffffffff' }) });
    expect(different.cuts[0]?.delta.duplicate).toBe(false);
    expect(different.cuts[0]?.flags).not.toContain('jump_cut');
  });

  it('raises black_in only for the incoming side', () => {
    const incoming = cutBetween({}, { measured: measured({ black: true }) });
    expect(incoming.cuts[0]?.flags).toContain('black_in');

    const outgoing = cutBetween({ measured: measured({ black: true }) }, {});
    expect(outgoing.cuts[0]?.flags).not.toContain('black_in');
  });

  it('raises soft_in below the sharpness threshold and not at it', () => {
    const at = cutBetween(
      {},
      { measured: measured({ sharpness: PICTURE_FLAG_THRESHOLDS.softSharpness }) },
    );
    expect(at.cuts[0]?.flags).not.toContain('soft_in');

    const under = cutBetween({}, { measured: measured({ sharpness: 0.2 }) });
    expect(under.cuts[0]?.flags).toContain('soft_in');
  });

  it('reports motion direction on the calm-to-busy ladder', () => {
    const up = cutBetween(
      { measured: measured({ motion: { si: 40, ti: 2, class: 'static' } }) },
      { measured: measured({ motion: { si: 40, ti: 30, class: 'fast' } }) },
    );
    expect(up.cuts[0]?.delta.motionChange).toBe('up');

    const down = cutBetween(
      { measured: measured({ motion: { si: 40, ti: 30, class: 'handheld' } }) },
      { measured: measured({ motion: { si: 40, ti: 2, class: 'slow' } }) },
    );
    expect(down.cuts[0]?.delta.motionChange).toBe('down');

    const none = cutBetween({}, {});
    expect(none.cuts[0]?.delta.motionChange).toBe('none');
  });
});

// --- unknown is not neutral -------------------------------------------------

describe('derivePicture — a missing tier is unknown, never a default', () => {
  it('leaves sameSetting null when tier 1 has not run, and false when it disagrees', () => {
    const unlabelled = cutBetween({}, {});
    expect(unlabelled.cuts[0]?.delta.sameSetting).toBeNull();
    expect(unlabelled.cuts[0]?.delta.shotSizeSteps).toBeNull();
    expect(unlabelled.cuts[0]?.delta.sameEntities).toEqual([]);

    const labelled = (setting: string) => ({
      tier1Version: 1,
      model: 'siglip',
      setting: { value: setting, p: 0.8 },
      faces: 0,
      entities: [],
    });
    const halfLabelled = cutBetween({ labelled: labelled('indoor-office') }, {});
    expect(halfLabelled.cuts[0]?.delta.sameSetting).toBeNull();

    const disagreeing = cutBetween(
      { labelled: labelled('indoor-office') },
      { labelled: labelled('street') },
    );
    expect(disagreeing.cuts[0]?.delta.sameSetting).toBe(false);

    const agreeing = cutBetween(
      { labelled: labelled('indoor-office') },
      { labelled: labelled('indoor-office') },
    );
    expect(agreeing.cuts[0]?.delta.sameSetting).toBe(true);
  });

  it('leaves every measured delta null when tier 0 is absent, rather than zero', () => {
    const unmeasured = cutBetween({ measured: null }, { measured: null });
    const delta = unmeasured.cuts[0]?.delta;
    expect(delta?.luma).toBeNull();
    expect(delta?.warmth).toBeNull();
    expect(delta?.sat).toBeNull();
    expect(delta?.contrast).toBeNull();
    expect(delta?.duplicate).toBeNull();
    expect(delta?.motionChange).toBeNull();
    expect(unmeasured.cuts[0]?.flags).toEqual([]);
  });

  it('reports an unknown delta, not a clean one, when a side has no ledger row', () => {
    const slice = sliceOf(
      [
        track('v1', 'video', [
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 5 }),
          clip({ id: 'c2', trackId: 'v1', assetId: 'a2', start: 5, end: 10 }),
        ]),
      ],
      [shot('a1', 0, 0, 5)],
    );
    expect(slice.cuts[0]?.delta.luma).toBeNull();
    expect(slice.cuts[0]?.delta.duplicate).toBeNull();
    expect(slice.cuts[0]?.flags).toEqual([]);
  });

  it('shares only the entities both sides actually carry', () => {
    const withEntities = (ids: string[]) => ({
      tier1Version: 1,
      model: 'siglip',
      faces: ids.length,
      entities: ids.map((id) => ({ id, kind: 'person', p: 0.9 })),
    });
    const slice = cutBetween(
      { labelled: withEntities(['person_01', 'person_02']) },
      { labelled: withEntities(['person_02', 'person_03']) },
    );
    expect(slice.cuts[0]?.delta.sameEntities).toEqual(['person_02']);
  });
});

// --- coverage ---------------------------------------------------------------

describe('derivePicture — coverage', () => {
  it('counts distinct joined shots per tier, not per clip appearance', () => {
    const described = {
      tier2Version: 1,
      model: 'vlm',
      summary: 'a man at a desk',
      subject: '',
      action: '',
      setting: '',
      camera: {},
      mood: '',
      onScreenText: [],
      quality: [],
      p: 0.7,
    };
    const slice = sliceOf(
      [
        track('v1', 'video', [
          // The same asset placed twice: shot 0 appears on both clips, counted once.
          clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 5, sourceEnd: 5 }),
          clip({ id: 'c2', trackId: 'v1', assetId: 'a1', start: 5, end: 10, sourceEnd: 5 }),
        ]),
      ],
      [shot('a1', 0, 0, 3), shot('a1', 1, 3, 5, { described })],
    );
    expect(slice.coverage).toEqual({ measured: 2, labelled: 0, described: 1, total: 2 });
  });

  it('ignores shots for assets that are not on the timeline', () => {
    const slice = sliceOf(
      [track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })])],
      [shot('a1', 0, 0, 5), shot('a2', 0, 0, 5)],
    );
    expect(slice.coverage.total).toBe(1);
  });
});

// --- absence ----------------------------------------------------------------

describe('derivePicture — absence is honest', () => {
  it('returns the picture clips with no facts and zero coverage for a null ledger', () => {
    const proj = project([
      track('v1', 'video', [
        clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 5 }),
        clip({ id: 'c2', trackId: 'v1', assetId: 'a1', start: 5, end: 10 }),
      ]),
    ]);
    const slice = derivePicture(indexFor(proj), null);
    expect(slice.clips.map((c) => c.clipId)).toEqual(['c1', 'c2']);
    expect(slice.clips.every((c) => c.dominant === null && c.shots.length === 0)).toBe(true);
    expect(slice.coverage).toEqual({ measured: 0, labelled: 0, described: 0, total: 0 });
    // The cut is still structurally there — it just has nothing to say about it.
    expect(slice.cuts).toHaveLength(1);
    expect(slice.cuts[0]?.flags).toEqual([]);
  });

  it('returns an empty slice for an empty timeline and an empty ledger', () => {
    const proj = project([track('v1', 'video', [])]);
    const slice = derivePicture(indexFor(proj), {
      shots: [],
      digests: [],
      coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
    });
    expect(slice).toEqual({
      clips: [],
      cuts: [],
      coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
    });
  });
});

// --- memoization ------------------------------------------------------------

describe('pictureSliceFor — memoization', () => {
  it('returns the identical object for the same snapshot and ledger', () => {
    const proj = project([
      track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })]),
    ]);
    const index = indexFor(proj);
    const ledger = ledgerOf([shot('a1', 0, 0, 5)]);
    const first = pictureSliceFor(index, ledger);
    expect(pictureSliceFor(index, ledger)).toBe(first);
    expect(pictureFor(proj, index, ledger)).toBe(first);
  });

  it('re-derives for a different ledger snapshot and for a different project snapshot', () => {
    const proj = project([
      track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })]),
    ]);
    const index = indexFor(proj);
    const ledger = ledgerOf([shot('a1', 0, 0, 5)]);
    const first = pictureSliceFor(index, ledger);

    expect(pictureSliceFor(index, ledgerOf([shot('a1', 0, 0, 5)]))).not.toBe(first);

    const trimmed = project([
      track('v1', 'video', [
        clip({ id: 'c1', trackId: 'v1', assetId: 'a1', end: 3, sourceEnd: 3 }),
      ]),
    ]);
    const after = pictureSliceFor(indexFor(trimmed), ledger);
    expect(after).not.toBe(first);
    expect(after.clips[0]?.shots[0]).toMatchObject({ tStart: 0, tEnd: 3 });
  });

  it('caches per fps, since fps decides which pairs touch', () => {
    const proj = project([
      track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })]),
    ]);
    const index = indexFor(proj);
    const ledger = ledgerOf([shot('a1', 0, 0, 5)]);
    expect(pictureSliceFor(index, ledger, 24)).not.toBe(pictureSliceFor(index, ledger, 30));
    expect(pictureSliceFor(index, ledger, 24)).toBe(pictureSliceFor(index, ledger, 24));
  });

  it('shares one cache entry for null and an omitted ledger', () => {
    const proj = project([
      track('v1', 'video', [clip({ id: 'c1', trackId: 'v1', assetId: 'a1' })]),
    ]);
    const index = indexFor(proj);
    expect(pictureSliceFor(index, null)).toBe(pictureSliceFor(index, undefined));
  });
});

// --- phash ------------------------------------------------------------------

describe('phashHamming', () => {
  it('counts differing bits across the full 64, nibble by nibble', () => {
    expect(phashHamming('0000000000000000', '0000000000000000')).toBe(0);
    expect(phashHamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    // A single low bit — the one a float round-trip would lose.
    expect(phashHamming('0000000000000000', '0000000000000001')).toBe(1);
    expect(phashHamming('0000000000000000', '00000000000000ff')).toBe(8);
  });

  it('is unknown, not far, for hashes it cannot compare', () => {
    expect(phashHamming('abcd', 'abcdef')).toBeNull();
    expect(phashHamming('', '')).toBeNull();
    expect(phashHamming('zzzz', '0000')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(phashHamming('ABCDEF0123456789', 'abcdef0123456789')).toBe(0);
  });
});

describe('DEFAULT_CUT_FPS', () => {
  it('is the fallback tolerance when no project fps is available', () => {
    const proj = project([
      track('v1', 'video', [
        clip({ id: 'c1', trackId: 'v1', assetId: 'a1', start: 0, end: 5 }),
        // 1/40 s apart: inside one frame at 30fps, outside one frame at 60.
        clip({ id: 'c2', trackId: 'v1', assetId: 'a1', start: 5 + 1 / 40, end: 10 }),
      ]),
    ]);
    expect(DEFAULT_CUT_FPS).toBe(30);
    expect(derivePicture(indexFor(proj), null).cuts).toHaveLength(1);
    expect(derivePicture(indexFor(proj), null, 60).cuts).toHaveLength(0);
  });
});
