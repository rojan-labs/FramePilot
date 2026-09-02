import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  firstFreePictureStart,
  coverCropFor,
  coverageVerdict,
  hidesWhatIsBehind,
  isFullFrameOpaque,
  picturePlacementConflict,
} from './picture-occupancy.js';

const video: Asset = { id: 'a_video', path: 'a.mp4', kind: 'video' };
const image: Asset = { id: 'a_image', path: 'a.jpg', kind: 'image' };
const audio: Asset = { id: 'a_audio', path: 'a.wav', kind: 'audio' };

function clip(assetId: string, start: number, end: number) {
  return { id: `${assetId}_${start}`, assetId, start, end, sourceStart: 0, sourceEnd: end - start };
}

function timeline(
  tracks: readonly { id: string; type?: string; clips: ReturnType<typeof clip>[] }[],
): Timeline {
  return { tracks } as unknown as Timeline;
}

describe('picturePlacementConflict', () => {
  const assets = [video, image, audio];

  it('is false over empty time', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 10, 20)).toBe(false);
  });

  it('is true over an overlapping picture clip', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 5, 15)).toBe(true);
    expect(picturePlacementConflict(tl, assets, 0, 1)).toBe(true);
    expect(picturePlacementConflict(tl, assets, 9.9, 12)).toBe(true);
  });

  it('treats touching edges as no conflict', () => {
    // Butting a cutaway against the clip before it is exactly what an editor
    // does; refusing that would make the feature unusable.
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 10, 20)).toBe(false);
    expect(picturePlacementConflict(tl, assets, -5, 0)).toBe(false);
  });

  it('sees a conflict on a track OTHER than the first, because the preview flattens them', () => {
    // The load-bearing ADR 0140 property, and the one a per-track refactor would
    // silently break: the occupied span is on `video_2` while `video_1` is empty
    // over it, so an implementation that only consulted "the" picture track
    // would report no conflict and ship an export that does not match the
    // preview. Overlap is measured in TIME, never by layer.
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('a_video', 0, 2)] },
      { id: 'video_2', type: 'video', clips: [clip('a_image', 6, 12)] },
    ]);
    expect(picturePlacementConflict(tl, assets, 7, 9)).toBe(true);
    // And the gap BETWEEN the two tracks' clips is genuinely free.
    expect(picturePlacementConflict(tl, assets, 2, 6)).toBe(false);
  });

  it('sees a conflict from two tracks whose clips together leave no gap', () => {
    // Neither track alone covers 3–7s; together they do. An implementation that
    // answered per track would let a clip through into the seam.
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('a_video', 0, 5)] },
      { id: 'video_2', type: 'video', clips: [clip('a_image', 5, 10)] },
    ]);
    expect(picturePlacementConflict(tl, assets, 3, 7)).toBe(true);
  });

  it('counts images as picture', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_image', 0, 5)] }]);
    expect(picturePlacementConflict(tl, assets, 1, 2)).toBe(true);
  });

  it('ignores audio, overlay, effect and caption layers', () => {
    const tl = timeline([
      { id: 'audio_1', type: 'audio', clips: [clip('a_audio', 0, 30)] },
      { id: 'overlay_1', type: 'overlay', clips: [clip('a_video', 0, 30)] },
      { id: 'caption_1', type: 'caption', clips: [clip('a_video', 0, 30)] },
    ]);
    // A title above a cutaway is not a conflict; those layers composite
    // separately from the picture chain.
    expect(picturePlacementConflict(tl, assets, 0, 10)).toBe(false);
  });

  it('treats an unknown asset as picture, because the failure modes are asymmetric', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('ghost', 0, 10)] }]);
    // Wrongly refusing costs one repositioning; wrongly allowing ships an export
    // that does not match the preview.
    expect(picturePlacementConflict(tl, [], 1, 2)).toBe(true);
  });

  it('is false for an empty or inverted span', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(picturePlacementConflict(tl, assets, 5, 5)).toBe(false);
    expect(picturePlacementConflict(tl, assets, 8, 2)).toBe(false);
  });

  it('handles an empty timeline', () => {
    expect(picturePlacementConflict(timeline([]), assets, 0, 10)).toBe(false);
  });
});

describe('firstFreePictureStart', () => {
  const assets = [video, image, audio];

  it('returns the requested moment when it is already free', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(firstFreePictureStart(tl, assets, 5, 10)).toBe(10);
    expect(firstFreePictureStart(timeline([]), assets, 5)).toBe(0);
  });

  it('skips past the clip in the way', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(firstFreePictureStart(tl, assets, 6, 0)).toBe(10);
  });

  it('uses a gap only when the whole clip fits in it', () => {
    const tl = timeline([
      {
        id: 'video_1',
        type: 'video',
        clips: [clip('a_video', 0, 10), clip('a_video', 14, 20)],
      },
    ]);
    // A 4s gap takes a 4s clip (touching edges are not an overlap) but not a 5s one.
    expect(firstFreePictureStart(tl, assets, 4, 0)).toBe(10);
    expect(firstFreePictureStart(tl, assets, 5, 0)).toBe(20);
  });

  it('merges overlapping spans across layers before measuring the gaps', () => {
    const tl = timeline([
      { id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] },
      { id: 'video_2', type: 'video', clips: [clip('a_video', 8, 18)] },
    ]);
    // The two clips are one 0–18s block, not two gaps with a 2s hole in them.
    expect(firstFreePictureStart(tl, assets, 3, 0)).toBe(18);
  });

  it('ignores layers that composite separately, like the predicate does', () => {
    const tl = timeline([{ id: 'audio_1', type: 'audio', clips: [clip('a_audio', 0, 30)] }]);
    expect(firstFreePictureStart(tl, assets, 5, 0)).toBe(0);
  });

  it('never suggests a moment the predicate would then refuse', () => {
    const tl = timeline([
      {
        id: 'video_1',
        type: 'video',
        clips: [clip('a_video', 0, 10), clip('a_video', 12, 15), clip('a_video', 40, 44)],
      },
    ]);
    for (const duration of [1, 2, 3, 5, 8, 30]) {
      for (const from of [0, 1, 9.5, 11, 13, 20, 41, 60]) {
        const start = firstFreePictureStart(tl, assets, duration, from);
        expect(start).toBeGreaterThanOrEqual(Math.max(0, from));
        expect(picturePlacementConflict(tl, assets, start, start + duration)).toBe(false);
      }
    }
  });

  it('clamps a negative floor and answers for a zero-length clip', () => {
    const tl = timeline([{ id: 'video_1', type: 'video', clips: [clip('a_video', 0, 10)] }]);
    expect(firstFreePictureStart(tl, assets, 5, -20)).toBe(10);
    // Nothing to fit, so nothing to move past.
    expect(firstFreePictureStart(tl, assets, 0, 3)).toBe(3);
  });
});

/**
 * ADR 0169 — the one predicate the agent's placement guard and the canvas preview's
 * eligibility test both ask. It answers "does this layer paint the WHOLE frame with
 * nothing showing through it", which is exactly when the preview's front-most clip and
 * the export's composite are the same picture.
 */
describe('isFullFrameOpaque', () => {
  it('is true for a plain clip', () => {
    expect(isFullFrameOpaque({})).toBe(true);
    expect(isFullFrameOpaque({ keyframes: [], effects: [] })).toBe(true);
  });

  it('is true for a normal blend mode written out explicitly', () => {
    expect(isFullFrameOpaque({ blendMode: 'normal' })).toBe(true);
  });

  it('is TRUE for a crop — a crop is geometry, not an opacity question', () => {
    // A crop changes how much of the frame the layer paints; it never makes the paint
    // translucent. Asking it here refused the cover crop `add_clip`'s auto-reframe writes,
    // which is the exact placement `coverageVerdict` exists to allow. The crop is folded
    // into the fitted rect there instead.
    expect(isFullFrameOpaque({ crop: { x: 0, y: 0, width: 0.5, height: 1 } })).toBe(true);
  });

  it('is false for a blend mode that folds in what is underneath', () => {
    expect(isFullFrameOpaque({ blendMode: 'multiply' })).toBe(false);
  });

  it('is false for ANY transform keyframe, whatever its value', () => {
    // Coverage would otherwise be a function of time: a clip that covers for two seconds
    // and uncovers for one is not a full-frame layer.
    expect(
      isFullFrameOpaque({
        keyframes: [{ id: 'k', time: 0, property: 'scale', value: 1, easing: 'linear' }],
      }),
    ).toBe(false);
    expect(
      isFullFrameOpaque({
        keyframes: [{ id: 'k', time: 0, property: 'opacity', value: 0.4, easing: 'linear' }],
      }),
    ).toBe(false);
  });

  it('is false for a mask or a transition — both let the frame beneath through', () => {
    for (const type of ['mask', 'transition', 'transition_out']) {
      expect(isFullFrameOpaque({ effects: [{ id: 'e', type, params: {}, keyframes: [] }] })).toBe(
        false,
      );
    }
  });

  it('is true with effects that change how the layer LOOKS, not what it covers', () => {
    expect(
      isFullFrameOpaque({
        effects: [
          { id: 'e1', type: 'color_grade', params: { exposure: 1 }, keyframes: [] },
          { id: 'e2', type: 'adjust_audio', params: { gainDb: -6 }, keyframes: [] },
        ],
      }),
    ).toBe(true);
  });
});

describe('hidesWhatIsBehind', () => {
  const frame = { width: 1080, height: 1920 };
  const WIDE = { width: 1920, height: 1080 };
  const landscape = { width: 1920, height: 1080 };
  const square = { width: 1000, height: 1000 };
  const fourThree = { width: 1600, height: 1200 };
  const portrait = { width: 1080, height: 1920 };
  const shaped = (source: { width: number; height: number } | undefined, clip = {}) => ({
    clip,
    source,
  });

  it('lets a letterboxed overlay hide a base of the SAME shape', () => {
    // Both are fitted identically, so their transparent bars coincide: the export blends
    // transparent over transparent and paints black, and so does the monitor. Refusing this
    // buys nothing, and the property version refused it.
    expect(
      hidesWhatIsBehind(shaped(landscape), [shaped(landscape)], frame),
    ).toBe(true);
  });

  it('refuses an overlay whose bars leak the base through them', () => {
    // A square overlay over a 16:9 base IN A 16:9 FRAME: the base fills the width, the
    // overlay is fitted to a 1080x1080 pillar, and the export shows the base's left and
    // right edges where the monitor shows only the overlay.
    //
    // The frame matters, which is the whole point of the relation. In the PORTRAIT frame
    // used by the rest of this block the same pair is legal: a 1080x1080 square contains a
    // 1080x607.5 landscape, so nothing leaks — see the test below.
    expect(hidesWhatIsBehind(shaped(square), [shaped(landscape)], WIDE)).toBe(false);
    expect(hidesWhatIsBehind(shaped(square), [shaped(landscape)], frame)).toBe(true);
  });

  it('lets a WIDER front cover a narrower base it does not share an aspect with', () => {
    // 4:3 over 1:1 in a 16:9 frame. Both are fitted to full height and the 4:3 is fitted
    // WIDER, so it hides the square completely — and the same-aspect reduction this
    // replaced refused it. Containment is the real test.
    expect(hidesWhatIsBehind(shaped(fourThree), [shaped(square)], WIDE)).toBe(true);
  });

  it('refuses the same pair the other way round', () => {
    expect(hidesWhatIsBehind(shaped(square), [shaped(fourThree)], WIDE)).toBe(false);
  });

  it('lets a cover-cropped landscape front hide a portrait base', () => {
    // The crop `add_clip`'s auto-reframe writes, on the placement it is written for. The
    // cropped region is exactly the frame's aspect, so the fit becomes a cover and there is
    // no bar left for the base to show through. `isFullFrameOpaque` used to refuse this
    // outright, which is the defect that motivated moving the crop arm out of it.
    const cropped = shaped(landscape, { crop: coverCropFor(landscape, frame) });
    expect(hidesWhatIsBehind(cropped, [shaped(portrait)], frame)).toBe(true);
  });

  it('refuses the same front WITHOUT the crop', () => {
    expect(hidesWhatIsBehind(shaped(landscape), [shaped(portrait)], frame)).toBe(false);
  });

  it('lets anything through when the overlay fills the frame', () => {
    expect(hidesWhatIsBehind(shaped(frame), [shaped(square), shaped(landscape)], frame)).toBe(true);
  });

  it('trusts two clips of the SAME asset even when nothing measured them', () => {
    // Identical fit by construction — which is what keeps a montage cut from one source
    // legal on a project nobody has probed.
    const a = { clip: { assetId: 'asset_1' }, source: undefined };
    expect(hidesWhatIsBehind(a, [a], frame)).toBe(true);
  });

  it('refuses two DIFFERENT unmeasured assets — their shapes are unknown, not equal', () => {
    expect(
      hidesWhatIsBehind(
        { clip: { assetId: 'a' }, source: undefined },
        [{ clip: { assetId: 'b' }, source: undefined }],
        frame,
      ),
    ).toBe(false);
  });

  it('still refuses a masked or blended overlay, whatever its shape', () => {
    expect(
      hidesWhatIsBehind(shaped(frame, { blendMode: 'multiply' }), [shaped(frame)], frame),
    ).toBe(false);
    expect(
      hidesWhatIsBehind(
        shaped(frame, { effects: [{ id: 'e', type: 'mask', params: {}, keyframes: [] }] }),
        [shaped(frame)],
        frame,
      ),
    ).toBe(false);
  });

  it('covers nothing ⇒ trivially true', () => {
    expect(hidesWhatIsBehind(shaped(undefined), [], frame)).toBe(true);
  });
});

describe('coverCropFor — the crop that turns "contain" into "cover", in either direction', () => {
  it('cuts a wider source horizontally, full height, centred', () => {
    // 0.5625 / 1.7778 = 0.31640625 of the source width; the rest is what the bars were.
    expect(coverCropFor({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toEqual({
      x: 0.341797,
      y: 0,
      width: 0.316406,
      height: 1,
    });
  });

  it('cuts a TALLER source vertically, full width, centred', () => {
    // The direction `ai-sdk`'s portrait-only `coverCropForFrame` deliberately declines to
    // take on its own; the refusal that suggests a crop still needs the rect.
    expect(coverCropFor({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0.341797,
      width: 1,
      height: 0.316406,
    });
  });

  it('returns nothing when the source already fills the frame', () => {
    expect(coverCropFor({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBeUndefined();
    expect(coverCropFor({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toBeUndefined();
  });

  it('refuses a degenerate size rather than dividing by zero', () => {
    expect(coverCropFor({ width: 0, height: 1080 }, { width: 1080, height: 1920 })).toBeUndefined();
    expect(coverCropFor({ width: 1920, height: 1080 }, { width: 1080, height: 0 })).toBeUndefined();
  });
});

describe('coverageVerdict — the reason, so a refusal need not re-derive it', () => {
  const frame = { width: 1920, height: 1080 };
  const square = { width: 1000, height: 1000 };

  it('names the blend mode', () => {
    expect(
      coverageVerdict({ clip: { blendMode: 'multiply' }, source: frame }, [{ clip: {}, source: frame }], frame),
    ).toEqual({ hides: false, reason: 'blend', detail: 'multiply' });
  });

  it('names keyframes and the coverage-breaking effect', () => {
    expect(
      coverageVerdict(
        { clip: { keyframes: [{ id: 'k', time: 0, property: 'scale', value: 1, easing: 'linear' }] }, source: frame },
        [{ clip: {}, source: frame }],
        frame,
      ).hides,
    ).toBe(false);
    expect(
      coverageVerdict(
        { clip: { effects: [{ id: 'e', type: 'mask', params: {}, keyframes: [] }] }, source: frame },
        [{ clip: {}, source: frame }],
        frame,
      ),
    ).toEqual({ hides: false, reason: 'effect', detail: 'mask' });
  });

  it('names what leaks, by how much, and the crop that would fix it', () => {
    const verdict = coverageVerdict(
      { clip: { id: 'front_1', assetId: 'a' }, source: square },
      [{ clip: { id: 'base_1', assetId: 'b' }, source: frame }],
      frame,
    );
    expect(verdict.hides).toBe(false);
    if (verdict.hides) throw new Error('unreachable');
    expect(verdict.reason).toBe('leaks');
    // 1000x1000 fits to 1080x1080 in a 1920x1080 frame: (1920 - 1080) / 2 = 420.
    expect(verdict.detail).toBe(
      'the 1920x1080 frame fits it with 420px bars left and right, and base_1 shows through them at export',
    );
    expect(verdict.coverCrop).toEqual({ x: 0, y: 0.21875, width: 1, height: 0.5625 });
  });

  it('names the covered clip when a shape is unknown, and suggests no crop', () => {
    expect(
      coverageVerdict(
        { clip: { assetId: 'a' }, source: undefined },
        [{ clip: { id: 'base_1', assetId: 'b' }, source: undefined }],
        frame,
      ),
    ).toEqual({ hides: false, reason: 'unmeasured', detail: 'base_1' });
  });
});
