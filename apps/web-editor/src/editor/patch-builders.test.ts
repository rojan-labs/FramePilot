import { describe, expect, it } from 'vitest';
import { buildAddMusicOps, pictureEndSeconds, type Operation } from '@framepilot/editor-core';
import { applyUserPatch, createEditorState, redoEdit, undoEdit } from './store.js';

type AddKeyframesOp = Extract<Operation, { type: 'add_keyframes' }>;
import {
  addAssetPatch,
  addKeyframePatch,
  moveKeyframePatch,
  removeKeyframePatch,
  setKeyframeAtPlayheadPatch,
  setKeyframesAtPlayheadPatch,
  setKeyframeEasingPatch,
  addMarkerPatch,
  addTextOverlayPatch,
  DEFAULT_TEXT_PARAMS,
  findNearbyMarker,
  overlayClips,
  readTextParams,
  removeMarkerPatch,
  setTextParamsPatch,
  textEffectOf,
  setClipTransformPatch,
  addMaskPatch,
  addTransitionPatch,
  removeTransitionPatch,
  applyTransitionToClipsPatch,
  resetTransitionParamsPatch,
  setTransitionDurationPatch,
  setTransitionParamsPatch,
  swapTransitionKindPatch,
  adjustAudioPatch,
  createFolderPatch,
  deleteFolderPatch,
  moveAssetToFolderPatch,
  moveFolderPatch,
  removeAssetPatch,
  renameFolderPatch,
  setAudioPatch,
  deleteClipPatch,
  deleteClipsPatch,
  duplicateClipAtPatch,
  duplicateClipPatch,
  duplicateClipsAtPatch,
  duplicateClipsPatch,
  insertClipPatch,
  moveClipPatch,
  moveClipsPatch,
  moveLayerPatch,
  pasteClipPatch,
  placeAssetPatch,
  addMusicTrackPatch,
  punchInPatch,
  removeAssetClipsPatch,
  rippleDeleteClipPatch,
  rollEditPatch,
  setCaptionStylePatch,
  setClipBlendModePatch,
  setClipCropPatch,
  setClipSpeedPatch,
  splitClipPatch,
  toggleMarkerPatch,
  trimClipPatch,
} from './patch-builders.js';
import { demoAssetIds, demoProject, demoTimeline } from './demo.js';
import type { Asset } from '@framepilot/timeline-schema';

const tl = demoTimeline; // clip_intro [0,6], clip_body [6,14] on video_1; clip_vo [0,14] on audio_1

describe('punchInPatch', () => {
  it('animates scale across the whole clip with the shared generator', () => {
    const patch = punchInPatch(tl, 'clip_intro', 1, 1.3, 'ease-out');
    expect(patch?.operations[0]).toMatchObject({ type: 'add_keyframes', clipId: 'clip_intro' });
    const op = patch!.operations[0] as AddKeyframesOp;
    expect(op.keyframes).toHaveLength(2);
    expect(op.keyframes[0]).toMatchObject({
      property: 'scale',
      value: 1,
      time: 0,
      easing: 'ease-out',
    });
    expect(op.keyframes[1]).toMatchObject({ value: 1.3, time: 6 }); // clip_intro is 0..6
  });

  it('returns null for a missing clip or a no-op (equal scales)', () => {
    expect(punchInPatch(tl, 'nope')).toBeNull();
    expect(punchInPatch(tl, 'clip_intro', 1.2, 1.2)).toBeNull();
  });

  it('produces a patch that applies cleanly through the store', () => {
    const patch = punchInPatch(tl, 'clip_intro')!;
    const next = applyUserPatch(createEditorState(tl, { assetIds: demoAssetIds }), patch);
    expect(next.issues).toEqual([]);
    expect(next.timeline.tracks[0]!.clips[0]!.keyframes.length).toBe(2);
  });
});

describe('addKeyframePatch', () => {
  it('adds one keyframe at a clamped clip-relative time', () => {
    const patch = addKeyframePatch(tl, 'clip_intro', 'opacity', 0.5, 99, 'linear');
    const op = patch!.operations[0] as AddKeyframesOp;
    expect(op.keyframes[0]).toMatchObject({ property: 'opacity', value: 0.5, time: 6 }); // clamped to clip end
  });

  it('returns null for a missing clip', () => {
    expect(addKeyframePatch(tl, 'nope', 'scale', 1, 0)).toBeNull();
  });
});

describe('keyframe patch builders (revamp Phase 5)', () => {
  /** clip_intro is [0,6] on video_1, so clip-relative times run 0…6. */
  const animate = (times: readonly number[]) => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    for (const time of times) {
      const patch = setKeyframeAtPlayheadPatch(state.timeline, 'clip_intro', 'scale', time, time)!;
      state = applyUserPatch(state, patch);
      expect(state.issues).toEqual([]);
    }
    return state;
  };

  const scaleKeyframes = (state: ReturnType<typeof animate>) =>
    state.timeline.tracks[0]!.clips[0]!.keyframes.filter((k) => k.property === 'scale');

  describe('setKeyframesAtPlayheadPatch', () => {
    it('writes a whole pose as ONE patch, so it is one press of undo to take back', () => {
      // The reason this exists rather than looping the singular builder: the
      // toolbar's keyframe button records every animatable property at once, and
      // five patches would be five undo steps for one thing the user did.
      const patch = setKeyframesAtPlayheadPatch(
        tl,
        'clip_intro',
        [
          { property: 'scale', value: 1 },
          { property: 'x', value: 0 },
          { property: 'opacity', value: 1 },
        ],
        2.5,
      )!;
      expect(patch.operations).toHaveLength(1);
      const op = patch.operations[0] as AddKeyframesOp;
      expect(op.replace).toBe(true);
      expect(op.keyframes.map((k) => k.property)).toEqual(['scale', 'x', 'opacity']);
      expect(op.keyframes.every((k) => k.time === 2.5)).toBe(true);
    });

    it('clamps the time into the clip, like the singular builder', () => {
      const patch = setKeyframesAtPlayheadPatch(
        tl,
        'clip_intro',
        [{ property: 'scale', value: 2 }],
        99,
      )!;
      expect((patch.operations[0] as AddKeyframesOp).keyframes[0]!.time).toBe(6);
    });

    it('returns null rather than a patch that would change nothing', () => {
      // A no-op patch still costs the user an undo press.
      expect(setKeyframesAtPlayheadPatch(tl, 'clip_intro', [], 1)).toBeNull();
      expect(
        setKeyframesAtPlayheadPatch(tl, 'ghost', [{ property: 'scale', value: 1 }], 1),
      ).toBeNull();
      expect(
        setKeyframesAtPlayheadPatch(
          tl,
          'clip_intro',
          [{ property: 'scale', value: Number.NaN }],
          1,
        ),
      ).toBeNull();
    });

    it('replaces rather than stacking when pressed twice at the same time', () => {
      let state = animate([2]);
      state = applyUserPatch(
        state,
        setKeyframesAtPlayheadPatch(
          state.timeline,
          'clip_intro',
          [{ property: 'scale', value: 9 }],
          2,
        )!,
      );
      expect(scaleKeyframes(state).map((k) => k.value)).toEqual([9]);
    });
  });

  describe('setKeyframeAtPlayheadPatch', () => {
    it('writes ONE replace-mode keyframe at the playhead, not at time 0', () => {
      // The distinction from setClipTransformPatch: that one always writes the base.
      const patch = setKeyframeAtPlayheadPatch(tl, 'clip_intro', 'scale', 1.5, 2.5);
      const op = patch!.operations[0] as AddKeyframesOp;
      expect(op.replace).toBe(true);
      expect(op.keyframes).toEqual([
        expect.objectContaining({ property: 'scale', value: 1.5, time: 2.5, easing: 'linear' }),
      ]);
    });

    it('clamps the time into the clip, so no keyframe lands where nothing evaluates it', () => {
      const late = setKeyframeAtPlayheadPatch(tl, 'clip_intro', 'scale', 2, 99)!;
      expect((late.operations[0] as AddKeyframesOp).keyframes[0]!.time).toBe(6);
      const early = setKeyframeAtPlayheadPatch(tl, 'clip_intro', 'scale', 2, -5)!;
      expect((early.operations[0] as AddKeyframesOp).keyframes[0]!.time).toBe(0);
    });

    it('replaces rather than stacks when written twice at the same time', () => {
      let state = animate([2]);
      state = applyUserPatch(
        state,
        setKeyframeAtPlayheadPatch(state.timeline, 'clip_intro', 'scale', 9, 2)!,
      );
      expect(scaleKeyframes(state).map((k) => k.value)).toEqual([9]);
    });

    it('returns null for a missing clip or a non-finite value', () => {
      expect(setKeyframeAtPlayheadPatch(tl, 'nope', 'scale', 1, 0)).toBeNull();
      expect(setKeyframeAtPlayheadPatch(tl, 'clip_intro', 'scale', Number.NaN, 0)).toBeNull();
    });
  });

  describe('removeKeyframePatch', () => {
    it('removes the keyframe at a time and leaves the others alone', () => {
      let state = animate([1, 3, 5]);
      state = applyUserPatch(state, removeKeyframePatch(state.timeline, 'clip_intro', 'scale', 3)!);
      expect(state.issues).toEqual([]);
      expect(scaleKeyframes(state).map((k) => k.time)).toEqual([1, 5]);
    });

    it('clears the whole property when no time is given', () => {
      let state = animate([1, 3, 5]);
      state = applyUserPatch(state, removeKeyframePatch(state.timeline, 'clip_intro', 'scale')!);
      expect(scaleKeyframes(state)).toEqual([]);
    });

    it('returns null when nothing would be removed, so no empty undo step', () => {
      const state = animate([1]);
      expect(removeKeyframePatch(state.timeline, 'clip_intro', 'rotation')).toBeNull();
      expect(removeKeyframePatch(state.timeline, 'clip_intro', 'scale', 4)).toBeNull();
      expect(removeKeyframePatch(tl, 'nope', 'scale')).toBeNull();
    });

    it('is undoable back to the exact prior animation', () => {
      const before = animate([1, 3]);
      const removed = applyUserPatch(
        before,
        removeKeyframePatch(before.timeline, 'clip_intro', 'scale', 1)!,
      );
      expect(scaleKeyframes(removed).map((k) => k.time)).toEqual([3]);
      const restored = undoEdit(removed);
      expect(scaleKeyframes(restored).map((k) => k.time)).toEqual([1, 3]);
      expect(scaleKeyframes(redoEdit(restored)).map((k) => k.time)).toEqual([3]);
    });
  });

  describe('moveKeyframePatch', () => {
    it('is ONE patch of two operations, so a drag is one undo step', () => {
      const state = animate([1, 3]);
      const patch = moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 1, 4)!;
      expect(patch.operations.map((o) => o.type)).toEqual(['remove_keyframes', 'add_keyframes']);
    });

    it('moves the keyframe, preserving its value and easing', () => {
      let state = animate([1, 3]);
      // Give the moving keyframe a non-default easing to prove the move keeps it —
      // resetting it to linear on a drag would quietly flatten the user's animation.
      state = applyUserPatch(
        state,
        setKeyframeEasingPatch(state.timeline, 'clip_intro', 'scale', 1, 'ease-out')!,
      );
      state = applyUserPatch(
        state,
        moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 1, 4.5)!,
      );
      expect(state.issues).toEqual([]);
      const moved = scaleKeyframes(state).find((k) => k.time === 4.5)!;
      expect(moved.value).toBe(1); // the value it was created with
      expect(moved.easing).toBe('ease-out');
      expect(scaleKeyframes(state).map((k) => k.time)).toEqual([3, 4.5]);
    });

    it('undoes in a single step', () => {
      const before = animate([1, 3]);
      const after = applyUserPatch(
        before,
        moveKeyframePatch(before.timeline, 'clip_intro', 'scale', 1, 5)!,
      );
      expect(scaleKeyframes(after).map((k) => k.time)).toEqual([3, 5]);
      expect(scaleKeyframes(undoEdit(after)).map((k) => k.time)).toEqual([1, 3]);
    });

    it('lands on an occupied destination instead of stacking a duplicate', () => {
      let state = animate([1, 3]);
      state = applyUserPatch(
        state,
        moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 1, 3)!,
      );
      expect(scaleKeyframes(state)).toHaveLength(1);
    });

    it('clamps the destination into the clip', () => {
      const state = animate([1]);
      const patch = moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 1, 99)!;
      expect((patch.operations[1] as AddKeyframesOp).keyframes[0]!.time).toBe(6);
    });

    it('returns null for a missing clip, a missing keyframe, or a no-op move', () => {
      const state = animate([1]);
      expect(moveKeyframePatch(tl, 'nope', 'scale', 0, 1)).toBeNull();
      expect(moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 2, 4)).toBeNull();
      expect(moveKeyframePatch(state.timeline, 'clip_intro', 'scale', 1, 1.0005)).toBeNull();
    });
  });

  describe('setKeyframeEasingPatch', () => {
    it('rewrites the easing in place, as one replace operation', () => {
      const state = animate([2]);
      const patch = setKeyframeEasingPatch(state.timeline, 'clip_intro', 'scale', 2, 'ease-in')!;
      expect(patch.operations).toHaveLength(1);
      const op = patch.operations[0] as AddKeyframesOp;
      expect(op.replace).toBe(true);
      expect(op.keyframes[0]).toMatchObject({ time: 2, easing: 'ease-in', value: 2 });
    });

    it('returns null when the easing is already what was asked for', () => {
      const state = animate([2]);
      expect(setKeyframeEasingPatch(state.timeline, 'clip_intro', 'scale', 2, 'linear')).toBeNull();
      expect(
        setKeyframeEasingPatch(state.timeline, 'clip_intro', 'scale', 5, 'ease-in'),
      ).toBeNull();
      expect(setKeyframeEasingPatch(tl, 'nope', 'scale', 0, 'ease-in')).toBeNull();
    });
  });
});

describe('setClipTransformPatch (H4)', () => {
  it('writes replace-mode base keyframes for the given properties only', () => {
    const patch = setClipTransformPatch(tl, 'clip_intro', { scale: 1.5, x: 120 });
    const op = patch!.operations[0] as AddKeyframesOp;
    expect(op.type).toBe('add_keyframes');
    expect(op.replace).toBe(true);
    expect(
      op.keyframes.map((k) => ({ property: k.property, value: k.value, time: k.time })),
    ).toEqual([
      { property: 'scale', value: 1.5, time: 0 },
      { property: 'x', value: 120, time: 0 },
    ]);
  });

  it('applies cleanly through the store and updates in place on a second drag', () => {
    const first = setClipTransformPatch(tl, 'clip_intro', { scale: 2 })!;
    let state = applyUserPatch(createEditorState(tl, { assetIds: demoAssetIds }), first);
    expect(state.issues).toEqual([]);
    const second = setClipTransformPatch(state.timeline, 'clip_intro', { scale: 3 })!;
    state = applyUserPatch(state, second);
    const scales = state.timeline.tracks[0]!.clips[0]!.keyframes.filter(
      (k) => k.property === 'scale',
    );
    expect(scales.map((k) => k.value)).toEqual([3]); // replaced, not stacked
  });

  it('returns null for a missing clip or empty values', () => {
    expect(setClipTransformPatch(tl, 'nope', { scale: 1 })).toBeNull();
    expect(setClipTransformPatch(tl, 'clip_intro', {})).toBeNull();
    expect(setClipTransformPatch(tl, 'clip_intro', { x: Number.NaN })).toBeNull();
  });
});

describe('setCaptionStylePatch (H1.1)', () => {
  it('writes a set_caption_style op carrying the given style', () => {
    const patch = setCaptionStylePatch(tl, 'clip_intro', {
      templateId: 'bold-pop',
      fontScale: 1.2,
      textColor: '#ffd84d',
      position: 'top',
    })!;
    expect(patch.operations).toEqual([
      {
        type: 'set_caption_style',
        clipId: 'clip_intro',
        captionStyle: {
          templateId: 'bold-pop',
          fontScale: 1.2,
          textColor: '#ffd84d',
          position: 'top',
        },
      },
    ]);
  });

  it('applies through the store and undoes back to the unstyled clip', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = setCaptionStylePatch(state.timeline, 'clip_intro', { textColor: '#ffd84d' })!;
    state = applyUserPatch(state, patch);
    expect(state.issues).toEqual([]);
    expect(state.timeline.tracks[0]!.clips[0]!.captionStyle).toEqual({ textColor: '#ffd84d' });

    state = undoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.captionStyle).toBeUndefined();

    state = redoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.captionStyle).toEqual({ textColor: '#ffd84d' });
  });

  it('clears a clip style back to unstyled with captionStyle: null', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    state = applyUserPatch(
      state,
      setCaptionStylePatch(state.timeline, 'clip_intro', { textColor: '#ffd84d' })!,
    );
    state = applyUserPatch(state, setCaptionStylePatch(state.timeline, 'clip_intro', null)!);
    expect(state.timeline.tracks[0]!.clips[0]!.captionStyle).toBeUndefined();
  });

  it('returns null for a missing clip', () => {
    expect(setCaptionStylePatch(tl, 'nope', { textColor: '#ffd84d' })).toBeNull();
  });
});

describe('setClipSpeedPatch (H1.2h)', () => {
  it('writes a set_clip_speed op carrying the given speed', () => {
    const patch = setClipSpeedPatch(tl, 'clip_intro', 2)!;
    expect(patch.operations).toEqual([{ type: 'set_clip_speed', clipId: 'clip_intro', speed: 2 }]);
  });

  it('applies through the store and undoes back to the default (unset) speed', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = setClipSpeedPatch(state.timeline, 'clip_intro', 2)!;
    state = applyUserPatch(state, patch);
    expect(state.issues).toEqual([]);
    expect(state.timeline.tracks[0]!.clips[0]!.speed).toBe(2);

    state = undoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.speed).toBeUndefined();

    state = redoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.speed).toBe(2);
  });

  it('clears a clip speed back to default with speed: null', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    state = applyUserPatch(state, setClipSpeedPatch(state.timeline, 'clip_intro', 2)!);
    state = applyUserPatch(state, setClipSpeedPatch(state.timeline, 'clip_intro', null)!);
    expect(state.timeline.tracks[0]!.clips[0]!.speed).toBeUndefined();
  });

  it('returns null for a missing clip or a non-finite speed', () => {
    expect(setClipSpeedPatch(tl, 'nope', 2)).toBeNull();
    expect(setClipSpeedPatch(tl, 'clip_intro', Number.NaN)).toBeNull();
    expect(setClipSpeedPatch(tl, 'clip_intro', Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('accepts a freeze and a reverse, and names each one in its reason', () => {
    // Schema v15 (ADR 0090) widened the legal range: 0 is a freeze frame and a
    // negative value plays the source range backwards. The reason string is what
    // the undo history shows, so it has to say which of the three happened.
    expect(setClipSpeedPatch(tl, 'clip_intro', 0)?.reason).toMatch(/Freeze/);
    expect(setClipSpeedPatch(tl, 'clip_intro', -2)?.reason).toMatch(/Reverse/);
    expect(setClipSpeedPatch(tl, 'clip_intro', 2)?.reason).toMatch(/2x/);
  });
});

describe('setClipCropPatch (H1.2h)', () => {
  const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };

  it('writes a set_clip_crop op carrying the given rect', () => {
    const patch = setClipCropPatch(tl, 'clip_intro', crop)!;
    expect(patch.operations).toEqual([{ type: 'set_clip_crop', clipId: 'clip_intro', crop }]);
  });

  it('applies through the store and undoes back to uncropped', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = setClipCropPatch(state.timeline, 'clip_intro', crop)!;
    state = applyUserPatch(state, patch);
    expect(state.issues).toEqual([]);
    expect(state.timeline.tracks[0]!.clips[0]!.crop).toEqual(crop);

    state = undoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.crop).toBeUndefined();

    state = redoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.crop).toEqual(crop);
  });

  it('clears a clip crop back to uncropped with crop: null', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    state = applyUserPatch(state, setClipCropPatch(state.timeline, 'clip_intro', crop)!);
    state = applyUserPatch(state, setClipCropPatch(state.timeline, 'clip_intro', null)!);
    expect(state.timeline.tracks[0]!.clips[0]!.crop).toBeUndefined();
  });

  it('returns null for a missing clip or a non-finite field', () => {
    expect(setClipCropPatch(tl, 'nope', crop)).toBeNull();
    expect(setClipCropPatch(tl, 'clip_intro', { ...crop, width: Number.NaN })).toBeNull();
  });
});

describe('setClipBlendModePatch (H1.2h)', () => {
  it('writes a set_clip_blend_mode op carrying the given mode', () => {
    const patch = setClipBlendModePatch(tl, 'clip_intro', 'multiply')!;
    expect(patch.operations).toEqual([
      { type: 'set_clip_blend_mode', clipId: 'clip_intro', blendMode: 'multiply' },
    ]);
  });

  it('applies through the store and undoes back to normal', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = setClipBlendModePatch(state.timeline, 'clip_intro', 'screen')!;
    state = applyUserPatch(state, patch);
    expect(state.issues).toEqual([]);
    expect(state.timeline.tracks[0]!.clips[0]!.blendMode).toBe('screen');

    state = undoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.blendMode).toBeUndefined();

    state = redoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]!.blendMode).toBe('screen');
  });

  it('clears a clip blend mode back to normal with blendMode: null', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    state = applyUserPatch(state, setClipBlendModePatch(state.timeline, 'clip_intro', 'screen')!);
    state = applyUserPatch(state, setClipBlendModePatch(state.timeline, 'clip_intro', null)!);
    expect(state.timeline.tracks[0]!.clips[0]!.blendMode).toBeUndefined();
  });

  it('returns null for a missing clip', () => {
    expect(setClipBlendModePatch(tl, 'nope', 'multiply')).toBeNull();
  });
});

describe('addMaskPatch', () => {
  it('adds a centered mask with geometry the engine can rasterize', () => {
    const patch = addMaskPatch(tl, 'clip_intro', 'ellipse', 0.1, 0.8);
    expect(patch?.operations[0]).toMatchObject({
      type: 'add_mask',
      clipId: 'clip_intro',
      shape: 'ellipse',
      bounds: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      feather: 0.1,
      opacity: 0.8,
    });
  });

  it('returns null for a missing clip and applies cleanly through the store', () => {
    expect(addMaskPatch(tl, 'nope', 'rectangle')).toBeNull();
    const patch = addMaskPatch(tl, 'clip_intro', 'rectangle')!;
    const next = applyUserPatch(createEditorState(tl, { assetIds: demoAssetIds }), patch);
    expect(next.issues).toEqual([]);
    expect(next.timeline.tracks[0]!.clips[0]!.effects.some((e) => e.type === 'mask')).toBe(true);
  });
});

describe('duplicateClipPatch', () => {
  it('clones a clip onto its own track after itself, preserving the source range', () => {
    const patch = duplicateClipPatch(tl, 'clip_intro');
    expect(patch?.operations[0]).toMatchObject({
      type: 'add_clip',
      trackId: 'video_1',
      assetId: tl.tracks[0]!.clips[0]!.assetId,
      start: 6, // appended at clip_intro's end
      end: 12, // same 6s duration
      sourceStart: 0,
      sourceEnd: 6,
    });
  });

  it('returns null for a missing clip', () => {
    expect(duplicateClipPatch(tl, 'nope')).toBeNull();
  });
});

describe('pasteClipPatch', () => {
  const snapshot = {
    id: 'clip_intro',
    assetId: 'asset_intro',
    start: 0,
    end: 6,
    sourceStart: 0,
    sourceEnd: 6,
  };

  it('places a snapshot on a track at the given start', () => {
    const patch = pasteClipPatch(tl, snapshot, 'video_1', 14);
    expect(patch?.operations[0]).toMatchObject({
      type: 'add_clip',
      trackId: 'video_1',
      start: 14,
      end: 20,
    });
  });

  it('returns null when the target track is missing', () => {
    expect(pasteClipPatch(tl, snapshot, 'no_track', 0)).toBeNull();
  });
});

describe('trimClipPatch', () => {
  it('builds a deterministic trim_clip patch', () => {
    const patch = trimClipPatch(tl, 'clip_intro', 0, 5);
    expect(patch).toMatchObject({
      patchId: 'trim_clip_intro_0_5000',
      createdBy: 'user',
      operations: [{ type: 'trim_clip', clipId: 'clip_intro', start: 0, end: 5 }],
    });
  });

  it('returns null for a missing clip, a non-positive range, or a no-op', () => {
    expect(trimClipPatch(tl, 'nope', 0, 5)).toBeNull();
    expect(trimClipPatch(tl, 'clip_intro', 5, 5)).toBeNull();
    expect(trimClipPatch(tl, 'clip_intro', 0, 6)).toBeNull(); // unchanged
  });
});

describe('rollEditPatch (H8)', () => {
  // clip_intro [0,6] and clip_body [6,14] are adjacent (touching) on video_1.
  it('trims both clips at once to move the shared edit point', () => {
    const patch = rollEditPatch(tl, 'clip_intro', 'clip_body', 5);
    expect(patch?.operations).toEqual([
      { type: 'trim_clip', clipId: 'clip_intro', start: 0, end: 5 },
      { type: 'trim_clip', clipId: 'clip_body', start: 5, end: 14 },
    ]);
  });

  it('applies cleanly through the store and undoes back to the original cut', () => {
    let state = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = rollEditPatch(tl, 'clip_intro', 'clip_body', 5)!;
    state = applyUserPatch(state, patch);
    expect(state.issues).toEqual([]);
    const [intro, body] = state.timeline.tracks[0]!.clips;
    expect(intro).toMatchObject({ start: 0, end: 5 });
    expect(body).toMatchObject({ start: 5, end: 14 });

    state = undoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips).toEqual(tl.tracks[0]!.clips);

    state = redoEdit(state)!;
    expect(state.timeline.tracks[0]!.clips[0]).toMatchObject({ start: 0, end: 5 });
  });

  it('clamps the cut so neither clip shrinks below the minimum length', () => {
    // Requesting a cut at 0.4s would leave clip_intro under MIN_CLIP_SECONDS;
    // it clamps to the smallest valid cut instead of returning that value verbatim.
    const patch = rollEditPatch(tl, 'clip_intro', 'clip_body', 0.001);
    const introOp = patch?.operations[0] as { end: number };
    expect(introOp.end).toBeGreaterThan(0);
    expect(introOp.end).toBeLessThan(0.2); // clamped near clip_intro.start, not at 0.001 verbatim
  });

  it('returns null when the clips are not adjacent, missing, or the cut is unchanged', () => {
    expect(rollEditPatch(tl, 'clip_intro', 'clip_vo', 5)).toBeNull(); // different tracks
    expect(rollEditPatch(tl, 'nope', 'clip_body', 5)).toBeNull();
    expect(rollEditPatch(tl, 'clip_intro', 'nope', 5)).toBeNull();
    expect(rollEditPatch(tl, 'clip_intro', 'clip_body', 6)).toBeNull(); // no-op (unchanged cut)
  });
});

describe('splitClipPatch', () => {
  it('builds a split_clip patch when the time is inside the clip', () => {
    expect(splitClipPatch(tl, 'clip_intro', 3)?.operations[0]).toEqual({
      type: 'split_clip',
      clipId: 'clip_intro',
      at: 3,
    });
  });

  it('returns null at the boundaries or for a missing clip', () => {
    expect(splitClipPatch(tl, 'clip_intro', 0)).toBeNull();
    expect(splitClipPatch(tl, 'clip_intro', 6)).toBeNull();
    expect(splitClipPatch(tl, 'nope', 3)).toBeNull();
  });
});

describe('deleteClipPatch', () => {
  it('builds a delete_range over the clip span on its track', () => {
    expect(deleteClipPatch(tl, 'clip_body')?.operations[0]).toEqual({
      type: 'delete_range',
      trackId: 'video_1',
      start: 6,
      end: 14,
    });
  });

  it('returns null for a missing clip', () => {
    expect(deleteClipPatch(tl, 'nope')).toBeNull();
  });
});

describe('rippleDeleteClipPatch', () => {
  it('builds a ripple_delete over the clip span on its track', () => {
    expect(rippleDeleteClipPatch(tl, 'clip_intro')?.operations[0]).toEqual({
      type: 'ripple_delete',
      trackId: 'video_1',
      start: 0,
      end: 6,
    });
  });

  it('returns null for a missing clip', () => {
    expect(rippleDeleteClipPatch(tl, 'nope')).toBeNull();
  });
});

describe('removeAssetClipsPatch', () => {
  it('deletes every clip that references the asset, across tracks', () => {
    // asset_intro backs clip_intro [0,6] and clip_body [6,14] on video_1.
    const patch = removeAssetClipsPatch(tl, 'asset_intro');
    expect(patch?.operations).toEqual([
      { type: 'delete_range', trackId: 'video_1', start: 0, end: 6 },
      { type: 'delete_range', trackId: 'video_1', start: 6, end: 14 },
    ]);
  });

  it('returns null when no clip uses the asset', () => {
    expect(removeAssetClipsPatch(tl, 'asset_unused')).toBeNull();
  });

  it('is accepted by the validate→apply pipeline, removing the clips', () => {
    const state = createEditorState(tl, demoAssetIds);
    const patch = removeAssetClipsPatch(tl, 'asset_intro')!;
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    expect(next.timeline.tracks[0]?.clips).toEqual([]); // video_1 emptied
  });
});

describe('moveClipPatch', () => {
  it('builds a move_clip patch (defaulting to the same track)', () => {
    // 8s leaves clip_body [8,16] clear of clip_intro [0,6] → a plain move.
    expect(moveClipPatch(tl, 'clip_body', 8)?.operations[0]).toEqual({
      type: 'move_clip',
      clipId: 'clip_body',
      toTrackId: 'video_1',
      toStart: 8,
    });
  });

  it('returns null for a missing clip or a same-track no-op move', () => {
    expect(moveClipPatch(tl, 'nope', 8)).toBeNull();
    expect(moveClipPatch(tl, 'clip_intro', 0)).toBeNull(); // already at 0 on its track
  });

  it('spawns a new front layer when the drop would overlap, instead of erroring', () => {
    // clip_body → start 0 makes [0,8], which overlaps clip_intro [0,6] on video_1.
    const patch = moveClipPatch(tl, 'clip_body', 0)!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations[0]).toMatchObject({ type: 'add_layer', atIndex: 0 });
    const layerId = (patch.operations[0] as { layerId: string }).layerId;
    expect(patch.operations[1]).toMatchObject({
      type: 'move_clip',
      clipId: 'clip_body',
      toTrackId: layerId,
      toStart: 0,
    });
  });

  it('still clamps a negative target start to zero (onto the new layer)', () => {
    expect(moveClipPatch(tl, 'clip_body', -3)?.operations.at(-1)).toMatchObject({ toStart: 0 });
  });

  it('does not collide with its own former position when nudged within a track', () => {
    // Moving clip_body a little earlier still clears clip_intro → a plain move.
    expect(moveClipPatch(tl, 'clip_body', 7)?.operations).toHaveLength(1);
  });

  it('produces an overlap-free timeline that applies cleanly through the store', () => {
    const patch = moveClipPatch(tl, 'clip_body', 0)!;
    const next = applyUserPatch(createEditorState(tl, { assetIds: demoAssetIds }), patch);
    expect(next.issues).toEqual([]);
  });
});

describe('adjustAudioPatch', () => {
  it('builds an adjust_audio patch', () => {
    expect(adjustAudioPatch(tl, 'clip_vo', -6)?.operations[0]).toEqual({
      type: 'adjust_audio',
      clipId: 'clip_vo',
      gainDb: -6,
    });
  });

  it('returns null for a missing clip or a zero-gain change', () => {
    expect(adjustAudioPatch(tl, 'nope', -6)).toBeNull();
    expect(adjustAudioPatch(tl, 'clip_vo', 0)).toBeNull();
  });
});

describe('setAudioPatch', () => {
  it('carries gain + fades + mute + normalize + duck, omitting unset fields', () => {
    const op = setAudioPatch(tl, 'clip_vo', {
      gainDb: -3,
      fadeInSeconds: 0.5,
      muted: true,
      normalize: true,
      duckUnderTrackId: 'video_1',
      duckAmountDb: -10,
    })?.operations[0] as unknown as Record<string, unknown>;
    expect(op).toMatchObject({
      type: 'adjust_audio',
      clipId: 'clip_vo',
      gainDb: -3,
      fadeInSeconds: 0.5,
      muted: true,
      normalize: true,
      duckUnderTrackId: 'video_1',
      duckAmountDb: -10,
    });
    expect(op.fadeOutSeconds).toBeUndefined();
  });

  it('gain-only settings omit every optional field', () => {
    const op = setAudioPatch(tl, 'clip_vo', { gainDb: 0 })?.operations[0] as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(op).sort()).toEqual(['clipId', 'gainDb', 'type']);
  });

  it('returns null for a missing clip', () => {
    expect(setAudioPatch(tl, 'nope', { gainDb: -3 })).toBeNull();
  });
});

describe('builders integrate with the validate→apply pipeline', () => {
  it('a built trim patch is accepted and applied by the store', () => {
    const state = createEditorState(tl, demoAssetIds);
    const patch = trimClipPatch(tl, 'clip_intro', 0, 4)!;
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    expect(next.timeline.tracks[0]?.clips[0]?.end).toBe(4);
  });
});

describe('text overlay styling (#5)', () => {
  /** A timeline with one text overlay on video_1, applied through the pipeline. */
  const withTextOverlay = () => {
    const state = createEditorState(tl, demoAssetIds);
    // caption_1 is empty in the demo — a text overlay there overlaps nothing.
    const add = addTextOverlayPatch(tl, 'caption_1', 'Hello', 0, 3)!;
    const next = applyUserPatch(state, add);
    expect(next.issues).toEqual([]);
    const clip = next.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => textEffectOf(c) !== undefined)!;
    return { timeline: next.timeline, clipId: clip.id };
  };

  it('readTextParams returns defaults for a freshly added overlay', () => {
    const { timeline, clipId } = withTextOverlay();
    const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    const params = readTextParams(clip);
    expect(params.text).toBe('Hello'); // real content
    expect(params.color).toBe(DEFAULT_TEXT_PARAMS.color); // default styling
    expect(params.align).toBe('center');
  });

  it('setTextParamsPatch merges style params reversibly and readTextParams reflects them', () => {
    const { timeline, clipId } = withTextOverlay();
    const patch = setTextParamsPatch(timeline, clipId, { color: '#ff0000', fontSizePercent: 12 })!;
    expect(patch.operations[0]).toMatchObject({ type: 'set_effect_params', clipId });
    const state = createEditorState(timeline, demoAssetIds);
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    const clip = next.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    const params = readTextParams(clip);
    expect(params.color).toBe('#ff0000');
    expect(params.fontSizePercent).toBe(12);
    expect(params.text).toBe('Hello'); // untouched content preserved
  });

  it('setTextParamsPatch returns null for a missing or non-text clip', () => {
    expect(setTextParamsPatch(tl, 'nope', { color: '#000' })).toBeNull();
    // A real video clip has no text effect → null.
    expect(setTextParamsPatch(tl, 'clip_intro', { color: '#000' })).toBeNull();
  });
});

describe('media-bin (project-scoped) builders', () => {
  it('build the expected project operations', () => {
    expect(addAssetPatch({ id: 'a1', path: 'a.mp4', kind: 'video' }).operations[0]).toEqual({
      type: 'add_asset',
      asset: { id: 'a1', path: 'a.mp4', kind: 'video' },
    });
    expect(removeAssetPatch('a1').operations[0]).toEqual({ type: 'remove_asset', assetId: 'a1' });
    expect(createFolderPatch('f1', 'B-roll', null).operations[0]).toEqual({
      type: 'create_folder',
      folderId: 'f1',
      name: 'B-roll',
      parentId: null,
    });
    expect(createFolderPatch('f2', 'City', 'f1').operations[0]).toMatchObject({ parentId: 'f1' });
    expect(renameFolderPatch('f1', 'New').operations[0]).toEqual({
      type: 'rename_folder',
      folderId: 'f1',
      name: 'New',
    });
    expect(moveFolderPatch('f2', 'f1').operations[0]).toEqual({
      type: 'move_folder',
      folderId: 'f2',
      parentId: 'f1',
    });
    expect(deleteFolderPatch('f1').operations[0]).toEqual({
      type: 'delete_folder',
      folderId: 'f1',
    });
    expect(moveAssetToFolderPatch('a1', 'f1').operations[0]).toEqual({
      type: 'move_asset',
      assetId: 'a1',
      folderId: 'f1',
    });
    expect(moveAssetToFolderPatch('a1', null).operations[0]).toMatchObject({ folderId: null });
  });

  it('flow through the store: add asset, fold it, then undo restores the bin', () => {
    let state = createEditorState(tl, demoAssetIds);
    state = applyUserPatch(state, addAssetPatch({ id: 'gen_1', path: 'g/x.mp4', kind: 'video' }));
    expect(state.assets.map((a) => a.id)).toContain('gen_1');
    expect(state.assetIds).toContain('gen_1'); // allow-list updated for add_clip

    state = applyUserPatch(state, createFolderPatch('f_broll', 'B-roll', null));
    const foldered = applyUserPatch(state, moveAssetToFolderPatch('gen_1', 'f_broll'));
    expect(foldered.assets.find((a) => a.id === 'gen_1')?.folderId).toBe('f_broll');

    const undone = undoEdit(foldered);
    expect(undone.assets.find((a) => a.id === 'gen_1')?.folderId).toBeUndefined();
    const redone = redoEdit(undone);
    expect(redone.assets.find((a) => a.id === 'gen_1')?.folderId).toBe('f_broll');
  });

  it('rejects a folder cycle through the validator', () => {
    let state = createEditorState(tl, demoAssetIds);
    state = applyUserPatch(state, createFolderPatch('a', 'A', null));
    state = applyUserPatch(state, createFolderPatch('b', 'B', 'a'));
    const rejected = applyUserPatch(state, moveFolderPatch('a', 'b'));
    expect(rejected.issues.some((i) => i.code === 'folder_cycle')).toBe(true);
    expect(rejected.folders).toEqual(state.folders); // unchanged
  });
});

describe('markers (schema v9, H1.2 persistence follow-up)', () => {
  it('build the expected project operations', () => {
    expect(addMarkerPatch('m1', 4).operations[0]).toEqual({
      type: 'add_marker',
      id: 'm1',
      time: 4,
    });
    expect(addMarkerPatch('m2', 4, 'Intro', '#ff0000').operations[0]).toEqual({
      type: 'add_marker',
      id: 'm2',
      time: 4,
      label: 'Intro',
      color: '#ff0000',
    });
    expect(removeMarkerPatch('m1').operations[0]).toEqual({ type: 'remove_marker', id: 'm1' });
  });

  it('findNearbyMarker matches within epsilon, not beyond it', () => {
    const markers = [{ id: 'm1', time: 4 }];
    expect(findNearbyMarker(markers, 4)?.id).toBe('m1');
    expect(findNearbyMarker(markers, 4.0005)?.id).toBe('m1'); // within epsilon
    expect(findNearbyMarker(markers, 4.1)).toBeNull();
  });

  it('toggleMarkerPatch adds when none is nearby, removes when one is, no-ops on negative time', () => {
    const markers = [{ id: 'm1', time: 4 }];
    expect(toggleMarkerPatch([], 4, () => 'new_id')?.operations[0]).toEqual({
      type: 'add_marker',
      id: 'new_id',
      time: 4,
    });
    expect(toggleMarkerPatch(markers, 4, () => 'new_id')?.operations[0]).toEqual({
      type: 'remove_marker',
      id: 'm1',
    });
    expect(toggleMarkerPatch(markers, -1, () => 'new_id')).toBeNull();
  });

  it('flows through the store: add, undo removes it, redo restores it', () => {
    let state = createEditorState(tl, demoAssetIds);
    state = applyUserPatch(state, addMarkerPatch('m1', 4, 'Intro'));
    expect(state.markers).toEqual([{ id: 'm1', time: 4, label: 'Intro' }]);

    const undone = undoEdit(state);
    expect(undone.markers).toEqual([]);
    const redone = redoEdit(undone);
    expect(redone.markers).toEqual([{ id: 'm1', time: 4, label: 'Intro' }]);
  });

  it('remove round-trips through undo', () => {
    let state = createEditorState(tl, demoAssetIds);
    state = applyUserPatch(state, addMarkerPatch('m1', 4));
    state = applyUserPatch(state, removeMarkerPatch('m1'));
    expect(state.markers).toEqual([]);

    const undone = undoEdit(state); // undoes the remove
    expect(undone.markers).toEqual([{ id: 'm1', time: 4 }]);
  });

  it('rejects removing an unknown marker through the validator', () => {
    const state = createEditorState(tl, demoAssetIds);
    const rejected = applyUserPatch(state, removeMarkerPatch('nope'));
    expect(rejected.issues.some((i) => i.code === 'missing_marker')).toBe(true);
    expect(rejected.markers).toEqual(state.markers); // unchanged
  });
});

// --- Phase 2: layer builders + CapCut-style auto-layering ------------------

describe('moveLayerPatch', () => {
  it('builds a move_layer op to a clamped destination', () => {
    const patch = moveLayerPatch(tl, 'audio_1', 0)!;
    expect(patch.operations[0]).toEqual({ type: 'move_layer', layerId: 'audio_1', toIndex: 0 });
  });

  it('returns null for a missing layer or a no-op move', () => {
    expect(moveLayerPatch(tl, 'ghost', 0)).toBeNull();
    const idx = tl.tracks.findIndex((t) => t.id === 'video_1');
    expect(moveLayerPatch(tl, 'video_1', idx)).toBeNull();
  });
});

describe('placeAssetPatch (auto-layering)', () => {
  const assetById = new Map<string, Asset>(demoProject.assets.map((a) => [a.id, a]));
  const intro = assetById.get('asset_intro')!; // video, dur 14
  const imageAsset: Asset = {
    id: 'asset_logo',
    path: '/media/logo.png',
    kind: 'image',
    durationSeconds: 3,
  };
  const withImage = new Map(assetById).set(imageAsset.id, imageAsset);

  it('appends a same-kind clip onto an existing layer that has room', () => {
    // video_1 holds video clips ending at 14; placing a video at 14 reuses it.
    const patch = placeAssetPatch(tl, assetById, intro, 14)!;
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({ type: 'add_clip', trackId: 'video_1', start: 14 });
  });

  it('spawns a new front layer when the kind differs (image over video)', () => {
    const patch = placeAssetPatch(tl, withImage, imageAsset, 0)!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations[0]).toMatchObject({
      type: 'add_layer',
      atIndex: 0,
      layerType: 'video',
    });
    const layerId = (patch.operations[0] as { layerId: string }).layerId;
    expect(patch.operations[1]).toMatchObject({ type: 'add_clip', trackId: layerId, start: 0 });
  });

  it('spawns a new front layer when same-kind clips would overlap', () => {
    // A video at t=0 collides with clip_intro on video_1 → new layer on top.
    const patch = placeAssetPatch(tl, assetById, intro, 0)!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations[0]).toMatchObject({ type: 'add_layer', atIndex: 0 });
  });

  it('flows through the validate→apply pipeline and is undoable', () => {
    const state = createEditorState(tl, demoAssetIds);
    const patch = placeAssetPatch(tl, assetById, intro, 0)!; // new layer + clip
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    expect(next.timeline.tracks[0]!.clips).toHaveLength(1); // new front layer seeded
    const undone = undoEdit(next);
    expect(undone.timeline.tracks).toHaveLength(tl.tracks.length);
  });
});

describe('addMusicTrackPatch (fetched music bed)', () => {
  const bed: Asset = {
    id: 'music_openverse_ov_1',
    path: 'media/p1/calm_bed.mp3',
    kind: 'audio',
    durationSeconds: 92,
    source: {
      provider: 'openverse',
      remoteId: 'ov-1',
      license: 'by',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attributionRequired: true,
      attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
      creator: 'Ada',
      fetchedAt: '2026-08-23T12:00:00.000Z',
    },
  };

  it('is ONE patch of three ops — bin, music layer, clip', () => {
    // One patch because the user did one thing. Three patches would demand a
    // three-press undo through two states that make no sense alone: an asset
    // whose clip is gone, then an empty layer.
    const patch = addMusicTrackPatch(tl, bed, 0);
    expect(patch.operations.map((op) => op.type)).toEqual(['add_asset', 'add_layer', 'add_clip']);
  });

  it('labels the new layer as music so ducking can find the bed', () => {
    const patch = addMusicTrackPatch(tl, bed, 0);
    expect(patch.operations[1]).toMatchObject({
      type: 'add_layer',
      layerType: 'audio',
      role: 'music',
    });
  });

  it('carries the provenance into the bin, which is what makes the credit durable', () => {
    // If `source` is not written here the Credits view is empty and the feature
    // is unsafe, not merely incomplete.
    const patch = addMusicTrackPatch(tl, bed, 0);
    const added = patch.operations[0] as { type: 'add_asset'; asset: Asset };
    expect(added.asset.source?.attribution).toContain('Ada');
    expect(added.asset.source?.attributionRequired).toBe(true);
  });

  it('stops the bed where the picture stops, rather than spanning the whole track', () => {
    // This used to assert the full 92s from a start of 5s — a 97-second timeline under a
    // 14-second film, with 83 seconds of black after it. The same builder serves the
    // agent's `add_music`, and run `e8cb2636` shipped exactly that: a 49.767s talking head
    // scored by a 93.64s track, 43.9 seconds of music over an empty frame. Dropping a song
    // on a film is asking for a bed under the film, not for the film to become as long as
    // the song.
    const patch = addMusicTrackPatch(tl, bed, 5);
    expect(patch.operations[2]).toMatchObject({
      type: 'add_clip',
      start: 5,
      end: pictureEndSeconds(tl),
      sourceStart: 0,
      sourceEnd: pictureEndSeconds(tl) - 5,
    });
  });

  it('still lays the whole track down when there is no picture to score', () => {
    // A music-led montage puts the song first and cuts to it.
    const patch = addMusicTrackPatch({ ...tl, tracks: [] }, bed, 0);
    expect(patch.operations[2]).toMatchObject({ type: 'add_clip', start: 0, end: 92 });
  });

  it('clamps a negative start to zero rather than producing an invalid clip', () => {
    expect(addMusicTrackPatch(tl, bed, -4).operations[2]).toMatchObject({ start: 0 });
  });

  it('falls back to a default length when the provider gave no duration', () => {
    const { durationSeconds: _omitted, ...noDuration } = bed;
    const patch = addMusicTrackPatch(tl, noDuration as Asset, 0);
    expect((patch.operations[2] as { end: number }).end).toBeGreaterThan(0);
  });

  // THE cross-path parity test. This is the only package that can import both
  // the renderer's builder and the agent's, so it is the only place the two can
  // actually be compared — a frozen literal elsewhere would only assert that
  // someone once wrote the expectation down. The drift this catches is real:
  // before the builders converged, the agent used `music_N` layer ids and a 30s
  // fallback while this path used `layer_audio_N` and 5s, so an agent-placed bed
  // and a hand-placed one were different beds.
  describe('agrees with the agent path, operation for operation', () => {
    it.each([
      ['a bed at the head', bed, 0],
      ['a bed placed later in the timeline', bed, 12],
      ['a bed whose provider reported no duration', { ...bed, durationSeconds: undefined }, 0],
    ])('%s', (_label, asset, at) => {
      const manual = addMusicTrackPatch(tl, asset as Asset, at);
      const agent = buildAddMusicOps(tl, asset as Asset, at);
      expect(agent).toEqual(manual.operations);
    });
  });

  it('validates, applies, and ONE undo removes asset, layer and clip together', () => {
    const state = createEditorState(tl, demoAssetIds);
    const next = applyUserPatch(state, addMusicTrackPatch(tl, bed, 0));
    expect(next.issues).toEqual([]);

    const musicTrack = next.timeline.tracks[0]!;
    expect(musicTrack.role).toBe('music');
    expect(musicTrack.clips).toHaveLength(1);

    const undone = undoEdit(next);
    // All three gone in one press — not one, then a dangling layer.
    expect(undone.timeline.tracks).toHaveLength(tl.tracks.length);
    expect(undone.timeline.tracks.some((t) => t.role === 'music')).toBe(false);

    const redone = redoEdit(undone);
    expect(redone.timeline.tracks[0]!.role).toBe('music');
    expect(redone.timeline.tracks[0]!.clips).toHaveLength(1);
  });
});

describe('deleteClipsPatch (batch delete, M2a)', () => {
  it('emits ONE lift patch with one delete_range op per clip', () => {
    const patch = deleteClipsPatch(tl, ['clip_intro', 'clip_body'], false)!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations.every((o) => o.type === 'delete_range')).toBe(true);
  });

  it('orders ripple ops back-to-front so earlier ops stay valid', () => {
    // clip_body starts at 6, clip_intro at 0 → body must be deleted first.
    const patch = deleteClipsPatch(tl, ['clip_intro', 'clip_body'], true)!;
    expect(patch.operations.map((o) => (o as { start: number }).start)).toEqual([6, 0]);
    expect(patch.operations.every((o) => o.type === 'ripple_delete')).toBe(true);
  });

  it('de-duplicates ids and ignores missing clips; returns null when none exist', () => {
    const patch = deleteClipsPatch(tl, ['clip_intro', 'clip_intro', 'nope'], false)!;
    expect(patch.operations).toHaveLength(1);
    expect(deleteClipsPatch(tl, ['nope', 'gone'], false)).toBeNull();
    expect(deleteClipsPatch(tl, [], false)).toBeNull();
  });

  it('removes all selected clips in one undoable step (apply → undo restores all)', () => {
    const start = createEditorState(tl, { assetIds: demoAssetIds });
    const patch = deleteClipsPatch(tl, ['clip_intro', 'clip_body'], false)!;
    const after = applyUserPatch(start, patch);
    expect(after.issues).toEqual([]);
    expect(after.timeline.tracks[0]!.clips.map((c) => c.id)).toEqual([]);
    // One undo brings both back.
    const undone = undoEdit(after);
    expect(undone.timeline.tracks[0]!.clips.map((c) => c.id)).toEqual(['clip_intro', 'clip_body']);
    // Redo re-applies the whole batch.
    const redone = redoEdit(undone);
    expect(redone.timeline.tracks[0]!.clips).toEqual([]);
  });
});

describe('moveClipsPatch (batch move, M2a)', () => {
  it('emits ONE patch with one move_clip op per moved clip', () => {
    const patch = moveClipsPatch(tl, [
      { clipId: 'clip_intro', toTrackId: 'video_1', toStart: 20 },
      { clipId: 'clip_body', toTrackId: 'video_1', toStart: 26 },
    ])!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations.every((o) => o.type === 'move_clip')).toBe(true);
  });

  it('drops no-op moves (same track + same start) and clamps negatives to 0', () => {
    const patch = moveClipsPatch(tl, [
      { clipId: 'clip_intro', toTrackId: 'video_1', toStart: 0 }, // no-op (already at 0)
      { clipId: 'clip_body', toTrackId: 'video_1', toStart: -5 }, // clamps to 0
    ])!;
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({ clipId: 'clip_body', toStart: 0 });
  });

  it('returns null when every move is a no-op or missing', () => {
    expect(
      moveClipsPatch(tl, [{ clipId: 'clip_intro', toTrackId: 'video_1', toStart: 0 }]),
    ).toBeNull();
    expect(moveClipsPatch(tl, [{ clipId: 'nope', toTrackId: 'video_1', toStart: 5 }])).toBeNull();
  });

  it('moves the whole batch in one undoable step (apply → undo restores positions)', () => {
    const start = createEditorState(tl, { assetIds: demoAssetIds });
    // Shift both video clips right by 20s into empty space (no overlap).
    const patch = moveClipsPatch(tl, [
      { clipId: 'clip_intro', toTrackId: 'video_1', toStart: 20 },
      { clipId: 'clip_body', toTrackId: 'video_1', toStart: 26 },
    ])!;
    const after = applyUserPatch(start, patch);
    expect(after.issues).toEqual([]);
    const starts = after.timeline.tracks[0]!.clips.map((c) => c.start).sort((a, b) => a - b);
    expect(starts).toEqual([20, 26]);
    const undone = undoEdit(after);
    expect(undone.timeline.tracks[0]!.clips.map((c) => c.start).sort((a, b) => a - b)).toEqual([
      0, 6,
    ]);
  });
});

describe('duplicateClipsPatch (batch duplicate, M2a)', () => {
  it('clones every clip after itself in one patch; ignores missing ids', () => {
    const patch = duplicateClipsPatch(tl, ['clip_intro', 'nope'])!;
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({ type: 'add_clip', trackId: 'video_1', start: 6 });
    expect(duplicateClipsPatch(tl, ['nope'])).toBeNull();
  });
});

describe('duplicateClipAtPatch (Cmd/Ctrl-drag duplicate, H8)', () => {
  it('places a clone at the resolved drop position, leaving the source untouched', () => {
    const patch = duplicateClipAtPatch(tl, 'clip_intro', 'video_1', 20)!;
    expect(patch.operations[0]).toMatchObject({
      type: 'add_clip',
      trackId: 'video_1',
      assetId: 'asset_intro',
      start: 20,
      end: 26, // same 6s duration
      sourceStart: 0,
      sourceEnd: 6,
    });
    // Unlike a move, the original clip is never referenced by a move/trim op.
    expect(patch.operations).toHaveLength(1);
  });

  it('returns null for a missing clip', () => {
    expect(duplicateClipAtPatch(tl, 'nope', 'video_1', 20)).toBeNull();
  });
});

describe('duplicateClipsAtPatch (batch Cmd/Ctrl-drag duplicate, H8)', () => {
  it('places every clone at its own resolved position in one patch; ignores missing ids', () => {
    const patch = duplicateClipsAtPatch(tl, [
      { clipId: 'clip_intro', toTrackId: 'video_1', toStart: 20 },
      { clipId: 'clip_body', toTrackId: 'video_1', toStart: 30 },
      { clipId: 'nope', toTrackId: 'video_1', toStart: 0 },
    ])!;
    expect(patch.operations).toHaveLength(2);
    expect(patch.operations[0]).toMatchObject({ type: 'add_clip', start: 20, end: 26 });
    expect(patch.operations[1]).toMatchObject({ type: 'add_clip', start: 30, end: 38 });
  });

  it('returns null when no listed clip resolves', () => {
    expect(
      duplicateClipsAtPatch(tl, [{ clipId: 'nope', toTrackId: 'video_1', toStart: 0 }]),
    ).toBeNull();
  });
});

describe('insertClipPatch (Insert edit mode, M2b-1)', () => {
  // A short clip to insert; video so it shares video_1's kind.
  const insertAsset: Asset = {
    id: 'asset_intro',
    path: '/media/intro.mp4',
    kind: 'video',
    durationSeconds: 3,
  };

  it('returns null when the target track is missing', () => {
    expect(insertClipPatch(tl, 'nope', insertAsset, 0)).toBeNull();
  });

  it('shifts every downstream same-lane clip right by the duration, then adds the clip', () => {
    // video_1: clip_intro [0,6], clip_body [6,14]. Insert dur=3 at 0.
    const patch = insertClipPatch(tl, 'video_1', insertAsset, 0)!;
    // Two shifts (back-to-front: body first, then intro) + the add_clip last.
    expect(patch.operations).toHaveLength(3);
    expect(patch.operations[0]).toMatchObject({
      type: 'move_clip',
      clipId: 'clip_body',
      toTrackId: 'video_1',
      toStart: 9, // 6 + 3
    });
    expect(patch.operations[1]).toMatchObject({
      type: 'move_clip',
      clipId: 'clip_intro',
      toStart: 3, // 0 + 3
    });
    expect(patch.operations[2]).toMatchObject({
      type: 'add_clip',
      trackId: 'video_1',
      start: 0,
      end: 3,
    });
  });

  it('only shifts clips at/after the insertion point', () => {
    // Insert at t=6 (the clip_body boundary): only clip_body is downstream.
    const patch = insertClipPatch(tl, 'video_1', insertAsset, 6)!;
    expect(patch.operations).toHaveLength(2); // one shift + one add
    expect(patch.operations[0]).toMatchObject({ clipId: 'clip_body', toStart: 9 });
    expect(patch.operations[1]).toMatchObject({ type: 'add_clip', start: 6 });
  });

  it('clamps a negative start to 0', () => {
    const patch = insertClipPatch(tl, 'video_1', insertAsset, -5)!;
    const add = patch.operations.at(-1) as { start: number; end: number };
    expect(add.start).toBe(0);
    expect(add.end).toBe(3);
  });

  it('applies through validate→apply without overlap, and one undo reverts the whole insert', () => {
    const state = createEditorState(tl, demoAssetIds);
    const before = state.timeline.tracks[0]!.clips;
    expect(before).toHaveLength(2);
    const patch = insertClipPatch(tl, 'video_1', insertAsset, 0)!;
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]); // no transient or final overlap
    const after = next.timeline.tracks[0]!.clips;
    expect(after).toHaveLength(3);
    // Downstream clips were pushed right; the new clip occupies [0,3].
    const byId = new Map(after.map((c) => [c.id, c]));
    expect(byId.get('clip_intro')).toMatchObject({ start: 3, end: 9 });
    expect(byId.get('clip_body')).toMatchObject({ start: 9, end: 17 });
    expect(after.some((c) => c.start === 0 && c.end === 3)).toBe(true);
    // One undo restores the original two clips at their original positions.
    const undone = undoEdit(next);
    const restored = undone.timeline.tracks[0]!.clips;
    expect(restored).toHaveLength(2);
    expect(restored.find((c) => c.id === 'clip_intro')).toMatchObject({ start: 0, end: 6 });
    expect(restored.find((c) => c.id === 'clip_body')).toMatchObject({ start: 6, end: 14 });
  });

  it('on an empty lane is just an append (no shifts)', () => {
    const patch = insertClipPatch(tl, 'caption_1', insertAsset, 4)!;
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({ type: 'add_clip', trackId: 'caption_1', start: 4 });
  });
});

describe('transition patch-builders (M3b)', () => {
  const assetIds = demoAssetIds;
  // demoTimeline: clip_intro [0,6] then clip_body [6,14] on video_1 — adjacent,
  // so a transition entering clip_body references clip_intro.
  const withTransition = (durationSeconds = 0.5) => {
    const patch = addTransitionPatch(tl, 'clip_intro', 'cross-dissolve', durationSeconds)!;
    return applyUserPatch(createEditorState(tl, { assetIds }), patch);
  };

  it('addTransitionPatch attaches the effect to the incoming (later) clip', () => {
    const patch = addTransitionPatch(tl, 'clip_intro', 'fade', 0.5)!;
    expect(patch.operations[0]).toMatchObject({
      type: 'add_transition',
      fromClipId: 'clip_intro',
      toClipId: 'clip_body',
      kind: 'fade',
      durationSeconds: 0.5,
    });
    const next = withTransition();
    expect(next.issues).toEqual([]);
    const body = next.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!;
    expect(body.effects.some((e) => e.type === 'transition')).toBe(true);
  });

  it('addTransitionPatch returns null when there is no following clip', () => {
    expect(addTransitionPatch(tl, 'clip_body', 'fade')).toBeNull();
    expect(addTransitionPatch(tl, 'nope', 'fade')).toBeNull();
  });

  it('setTransitionDurationPatch replaces in place (idempotent), preserving kind', () => {
    const state = withTransition(0.5);
    const patch = setTransitionDurationPatch(state.timeline, 'clip_body', 1)!;
    expect(patch.operations[0]).toMatchObject({
      type: 'add_transition',
      fromClipId: 'clip_intro',
      kind: 'cross-dissolve',
      durationSeconds: 1,
    });
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    const body = next.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!;
    const transitions = body.effects.filter((e) => e.type === 'transition');
    expect(transitions).toHaveLength(1); // never stacks
    expect(transitions[0]!.params.durationSeconds).toBe(1);
  });

  it('setTransitionDurationPatch clamps an over-long drag instead of failing the edit', () => {
    const state = withTransition(0.5);
    // clip_intro is 6s and clip_body is 8s → the cut carries half the shorter, 3s.
    // Dragging the pill past that lands on the maximum, which is what a resize
    // handle should do; it used to make the whole patch a validation error.
    const patch = setTransitionDurationPatch(state.timeline, 'clip_body', 99)!;
    const next = applyUserPatch(state, patch);
    expect(next.issues).toEqual([]);
    const body = next.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!;
    expect(body.effects.find((e) => e.type === 'transition')!.params.durationSeconds).toBe(3);
  });

  it('swapTransitionKindPatch changes kind, keeping duration AND the look params', () => {
    // Deliberately `set_effect_params`, not `add_transition`. The duration does not
    // change, so the eligibility `add_transition` re-checks cannot have become false
    // — and routing through it would rebuild the params bag from scratch, silently
    // discarding the direction, intensity, softness and easing the user tuned
    // (revamp Phase 9).
    const state = withTransition(0.75);
    const patch = swapTransitionKindPatch(state.timeline, 'clip_body', 'zoom')!;
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({
      type: 'set_effect_params',
      clipId: 'clip_body',
      params: { kind: 'zoom' },
    });
    const swapped = applyUserPatch(state, patch);
    expect(swapped.issues).toEqual([]);
    const effect = swapped.timeline.tracks[0]!.clips.find(
      (c) => c.id === 'clip_body',
    )!.effects.find((e) => e.type === 'transition')!;
    expect(effect.params.kind).toBe('zoom');
    // 0.75s is 22.5 frames at 30fps; the grid rounds ties away from zero, so the ramp is
    // 23 frames (ADR 0146). The point of the assertion is that the swap KEEPS the
    // duration, and it does — on the grid, as every edit point now is.
    expect(effect.params.durationSeconds).toBeCloseTo(23 / 30, 6);
  });

  it('setTransitionDurationPatch keeps the look params across the rebuild', () => {
    // `add_transition` rebuilds `params`, so a resize used to reset the look. Both
    // ops ride in ONE patch: two patches would make undo show the transition resized
    // but reset, which reads as data loss.
    const state = withTransition(0.75);
    const tuned = applyUserPatch(
      state,
      setTransitionParamsPatch(state.timeline, 'clip_body', {
        direction: 'down',
        intensity: 0.4,
      })!,
    );
    const patch = setTransitionDurationPatch(tuned.timeline, 'clip_body', 0.5)!;
    expect(patch.operations.map((op) => op.type)).toEqual(['add_transition', 'set_effect_params']);
    const resized = applyUserPatch(tuned, patch);
    expect(resized.issues).toEqual([]);
    const params = resized.timeline.tracks[0]!.clips.find(
      (c) => c.id === 'clip_body',
    )!.effects.find((e) => e.type === 'transition')!.params;
    expect(params.durationSeconds).toBe(0.5);
    expect(params.direction).toBe('down');
    expect(params.intensity).toBe(0.4);
  });

  it('resetTransitionParamsPatch CLEARS the look params rather than writing defaults', () => {
    // A stored `intensity: 1` and an absent one render identically today, but only
    // the absent one keeps rendering identically if a default ever changes.
    const state = withTransition(0.75);
    const tuned = applyUserPatch(
      state,
      setTransitionParamsPatch(state.timeline, 'clip_body', { intensity: 0.4 })!,
    );
    const reset = applyUserPatch(tuned, resetTransitionParamsPatch(tuned.timeline, 'clip_body')!);
    const params = reset.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!.effects.find(
      (e) => e.type === 'transition',
    )!.params;
    expect(params).not.toHaveProperty('intensity');
    expect(params.kind).toBeDefined(); // the transition itself survives
    // Nothing left to reset ⇒ no patch, so the button cannot burn an undo step.
    expect(resetTransitionParamsPatch(reset.timeline, 'clip_body')).toBeNull();
  });

  it('setTransitionParamsPatch and its friends are null without a transition', () => {
    const state = withTransition(0.5);
    const bare = applyUserPatch(state, removeTransitionPatch(state.timeline, 'clip_body')!);
    expect(setTransitionParamsPatch(bare.timeline, 'clip_body', { intensity: 0.5 })).toBeNull();
    expect(resetTransitionParamsPatch(bare.timeline, 'clip_body')).toBeNull();
    expect(applyTransitionToClipsPatch(bare.timeline, 'clip_body', ['clip_intro'])).toBeNull();
    // An empty param set is a no-op, not an empty patch.
    expect(setTransitionParamsPatch(state.timeline, 'clip_body', {})).toBeNull();
  });

  it('removeTransitionPatch drops the effect and undo restores it', () => {
    const state = withTransition(0.5);
    const patch = removeTransitionPatch(state.timeline, 'clip_body')!;
    expect(patch.operations[0]).toMatchObject({ type: 'restore_clips', trackId: 'video_1' });
    const removed = applyUserPatch(state, patch);
    expect(removed.issues).toEqual([]);
    const body = removed.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!;
    expect(body.effects.some((e) => e.type === 'transition')).toBe(false);
    // Undo brings it back exactly (apply→invert round-trip).
    const undone = undoEdit(removed);
    const restored = undone.timeline.tracks[0]!.clips.find((c) => c.id === 'clip_body')!;
    expect(restored.effects.some((e) => e.type === 'transition')).toBe(true);
  });

  it('resize / swap / remove return null when there is no transition', () => {
    expect(setTransitionDurationPatch(tl, 'clip_body', 1)).toBeNull();
    expect(swapTransitionKindPatch(tl, 'clip_body', 'zoom')).toBeNull();
    expect(removeTransitionPatch(tl, 'clip_body')).toBeNull();
    expect(removeTransitionPatch(tl, 'nope')).toBeNull();
  });
});

describe('overlayClips', () => {
  const assetById = new Map<string, Asset>([['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }]]);
  const clip = (over: Record<string, unknown>) => ({
    id: 'c',
    assetId: 'vid',
    trackId: 't',
    start: 0,
    end: 3,
    sourceStart: 0,
    sourceEnd: 3,
    effects: [],
    keyframes: [],
    ...over,
  });

  it('returns a text overlay with its resolved styled text + span', () => {
    const timeline = {
      tracks: [
        {
          id: 't',
          type: 'video' as const,
          clips: [
            clip({
              id: 'text_1',
              assetId: '__text__',
              start: 1,
              end: 4,
              effects: [{ id: 'e', type: 'text', params: { text: 'Hello' }, keyframes: [] }],
            }),
          ],
        },
      ],
    };
    const overlays = overlayClips(timeline, assetById);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({ id: 'text_1', start: 1, end: 4 });
    expect(overlays[0]!.params.text).toBe('Hello');
  });

  it('falls back to a later text effect when the styled text param is empty', () => {
    // Mirrors PreviewPlayer's `params.text || texts[0]`: readTextParams reads
    // the (empty) first `text` effect, so the resolved text falls back to the
    // first non-empty text effect.
    const timeline = {
      tracks: [
        {
          id: 't',
          type: 'video' as const,
          clips: [
            clip({
              id: 'text_1',
              assetId: '__text__',
              effects: [
                { id: 'e1', type: 'text', params: { text: '' }, keyframes: [] },
                { id: 'e2', type: 'text', params: { text: 'Subtitle' }, keyframes: [] },
              ],
            }),
          ],
        },
      ],
    };
    const overlays = overlayClips(timeline, assetById);
    expect(overlays[0]?.params.text).toBe('Subtitle');
  });

  it('excludes caption clips — they render via the DOM CaptionOverlay (schema v10)', () => {
    const timeline = {
      tracks: [
        {
          id: 't',
          type: 'caption' as const,
          clips: [
            clip({
              id: 'cap_1',
              assetId: '__caption__',
              effects: [{ id: 'e2', type: 'caption', params: { text: 'Subtitle' }, keyframes: [] }],
            }),
          ],
        },
      ],
    };
    expect(overlayClips(timeline, assetById)).toHaveLength(0);
  });

  it('drops empty-text overlays and ignores non-overlay clips + hidden tracks', () => {
    const timeline = {
      tracks: [
        { id: 't', type: 'video' as const, clips: [clip({ id: 'v1' })] }, // a video clip: not an overlay
        {
          id: 't2',
          type: 'video' as const,
          clips: [clip({ id: 'empty', assetId: '__text__', effects: [] })], // default text is truthy → kept
        },
        {
          id: 't3',
          type: 'video' as const,
          hidden: true,
          clips: [
            clip({
              id: 'hidden_text',
              assetId: '__text__',
              effects: [{ id: 'e', type: 'text', params: { text: 'Nope' }, keyframes: [] }],
            }),
          ],
        },
      ],
    };
    const overlays = overlayClips(timeline, assetById);
    // Only the visible __text__ clip (with its default 'Text'); the hidden one excluded.
    expect(overlays.map((o) => o.params.text)).toEqual(['Text']);
  });
});
