import type { AnyOperation } from '@framepilot/editor-core';
import { describe, expect, it } from 'vitest';
import {
  frameToSeconds,
  normalizeOperationTime,
  normalizeOperationTimes,
  operationTimeChanged,
  rationalFrameRate,
  secondsToFrame,
  snapOptionalSeconds,
  snapSecondsToFrame,
} from './frame-time.js';

const fps = 30;
const frameTime = (frame: number): number => frameToSeconds(frame, fps);
const asOperation = (value: unknown): AnyOperation => value as AnyOperation;

describe('frame-time conversion', () => {
  it('uses stable rational rates for integer, decimal and NTSC frame rates', () => {
    expect(rationalFrameRate(30)).toEqual({ numerator: 30, denominator: 1 });
    expect(rationalFrameRate(29.97)).toEqual({ numerator: 30_000, denominator: 1001 });
    expect(rationalFrameRate(25.25)).toEqual({ numerator: 101, denominator: 4 });
  });

  it('rejects invalid frame rates and times', () => {
    expect(() => rationalFrameRate(0)).toThrow('positive finite');
    expect(() => rationalFrameRate(Number.NaN)).toThrow('positive finite');
    expect(() => secondsToFrame(Number.POSITIVE_INFINITY, fps)).toThrow('finite');
    expect(() => frameToSeconds(1.5, fps)).toThrow('integer');
  });

  it('converts with explicit rounding and round-trips frame boundaries', () => {
    expect(secondsToFrame(0.049, fps, 'floor')).toBe(1);
    expect(secondsToFrame(0.049, fps, 'ceil')).toBe(2);
    expect(secondsToFrame(0.049, fps)).toBe(1);
    expect(frameToSeconds(3, fps)).toBeCloseTo(0.1);
    expect(snapSecondsToFrame(0.049, fps)).toBeCloseTo(frameTime(1));
  });
});

describe('AI operation normalization', () => {
  it('snaps sequence ranges and point times before validation', () => {
    const addClip = asOperation({
      type: 'add_clip',
      trackId: 'v',
      assetId: 'a',
      start: 0.049,
      end: 1.049,
      sourceStart: 0.049,
      sourceEnd: 1.049,
    });
    const operations = normalizeOperationTimes(
      [
        asOperation({ type: 'trim_clip', clipId: 'c', start: 0.049, end: 1.049 }),
        asOperation({ type: 'split_clip', clipId: 'c', at: 0.049 }),
        asOperation({ type: 'delete_range', trackId: 'v', start: 0.049, end: 0.149 }),
        asOperation({ type: 'ripple_delete', trackId: 'v', start: 0.049, end: 0.149 }),
        asOperation({ type: 'move_clip', clipId: 'c', toTrackId: 'v', toStart: 0.049 }),
        addClip,
        asOperation({ type: 'add_text_overlay', trackId: 'o', text: 'x', start: 0.049, end: 1 }),
        asOperation({ type: 'add_caption_layer', trackId: 'cc', start: 0.049, end: 1 }),
        asOperation({ type: 'add_marker', id: 'm', time: 0.049 }),
      ],
      fps,
    );

    expect(operations[0]).toMatchObject({ start: frameTime(1), end: frameTime(31) });
    expect(operations[1]).toMatchObject({ at: frameTime(1) });
    expect(operations[2]).toMatchObject({ start: frameTime(1), end: frameTime(4) });
    expect(operations[3]).toMatchObject({ start: frameTime(1), end: frameTime(4) });
    expect(operations[4]).toMatchObject({ toStart: frameTime(1) });
    expect(operations[5]).toBe(addClip);
    expect(operations[6]).toMatchObject({ start: frameTime(1), end: 1 });
    expect(operations[7]).toMatchObject({ start: frameTime(1), end: 1 });
    expect(operations[8]).toMatchObject({ time: frameTime(1) });
  });

  it('migrates the old split time field to canonical at and leaves malformed legacy input for validation', () => {
    const legacy = normalizeOperationTime(
      asOperation({ type: 'split_clip', clipId: 'c', time: 0.049 }),
      fps,
    );
    expect(legacy).toMatchObject({ type: 'split_clip', clipId: 'c', at: frameTime(1) });
    expect(legacy).not.toHaveProperty('time');

    const malformed = asOperation({ type: 'split_clip', clipId: 'c' });
    expect(normalizeOperationTime(malformed, fps)).toBe(malformed);
  });

  it('snaps nested sequence animation and effect timing without changing non-time values', () => {
    const keyframe = { id: 'k', time: 0.049, property: 'scale', value: 1.2, easing: 'linear' };
    const operations = [
      asOperation({ type: 'add_keyframes', clipId: 'c', keyframes: [keyframe] }),
      asOperation({
        type: 'remove_keyframes',
        clipId: 'c',
        targets: [{ property: 'scale', time: 0.049 }, { property: 'x' }],
      }),
      asOperation({
        type: 'apply_color_grade',
        clipId: 'c',
        effect: { id: 'e', type: 'color_grade', params: {}, keyframes: [keyframe] },
      }),
      asOperation({ type: 'add_mask', clipId: 'c', shape: 'rectangle', keyframes: [keyframe] }),
      asOperation({ type: 'add_mask', clipId: 'c', shape: 'ellipse' }),
      asOperation({ type: 'track_object', clipId: 'c', target: 'object', keyframes: [keyframe] }),
      asOperation({ type: 'track_object', clipId: 'c', target: 'object' }),
      asOperation({
        type: 'add_effect_layer',
        trackId: 'fx',
        layer: {
          id: 'l',
          effectId: 'grain',
          kind: 'grain',
          start: 0.049,
          end: 1.049,
          params: {},
          keyframes: [keyframe],
        },
      }),
      asOperation({ type: 'move_effect_layer', layerId: 'l', toStart: 0.049 }),
      asOperation({ type: 'trim_effect_layer', layerId: 'l', start: 0.049, end: 1.049 }),
    ].map((operation) => normalizeOperationTime(operation, fps));

    expect(operations[0]).toMatchObject({ keyframes: [{ time: frameTime(1), value: 1.2 }] });
    expect(operations[1]).toMatchObject({ targets: [{ time: frameTime(1) }, { property: 'x' }] });
    expect(operations[2]).toMatchObject({ effect: { keyframes: [{ time: frameTime(1) }] } });
    expect(operations[3]).toMatchObject({ keyframes: [{ time: frameTime(1) }] });
    expect(operations[4]).not.toHaveProperty('keyframes');
    expect(operations[5]).toMatchObject({ keyframes: [{ time: frameTime(1) }] });
    expect(operations[6]).not.toHaveProperty('keyframes');
    expect(operations[7]).toMatchObject({
      layer: { start: frameTime(1), end: frameTime(31), keyframes: [{ time: frameTime(1) }] },
    });
    expect(operations[8]).toMatchObject({ toStart: frameTime(1) });
    expect(operations[9]).toMatchObject({ start: frameTime(1), end: frameTime(31) });
  });

  it('normalizes durations while preserving absent optional fields and source-domain snapshots', () => {
    const transition = normalizeOperationTime(
      asOperation({
        type: 'add_transition',
        trackId: 'v',
        fromClipId: 'a',
        toClipId: 'b',
        kind: 'fade',
        durationSeconds: 0.001,
      }),
      fps,
    );
    const audioWithoutFades = normalizeOperationTime(
      asOperation({ type: 'adjust_audio', clipId: 'c', gainDb: -3 }),
      fps,
    );
    const audioWithFades = normalizeOperationTime(
      asOperation({
        type: 'adjust_audio',
        clipId: 'c',
        gainDb: -3,
        fadeInSeconds: 0.049,
        fadeOutSeconds: 0.149,
      }),
      fps,
    );
    const speedRamp = asOperation({
      type: 'set_clip_speed_ramp',
      clipId: 'c',
      ramp: [{ id: 's', sourceTime: 0.049, rate: 2, easing: 'linear' }],
    });
    const seededLayer = asOperation({
      type: 'add_layer',
      layerId: 'v',
      layerType: 'video',
      atIndex: 0,
      clips: [
        {
          id: 'c',
          trackId: 'v',
          assetId: 'a',
          start: 0.049,
          end: 1.049,
          sourceStart: 0.049,
          sourceEnd: 1.049,
          effects: [],
          keyframes: [{ id: 'k', time: 0.049, property: 'x', value: 0, easing: 'linear' }],
        },
      ],
    });

    expect(transition).toMatchObject({ durationSeconds: frameTime(1) });
    expect(audioWithoutFades).not.toHaveProperty('fadeInSeconds');
    expect(audioWithFades).toMatchObject({
      fadeInSeconds: frameTime(1),
      fadeOutSeconds: frameTime(4),
    });
    expect(normalizeOperationTime(speedRamp, fps)).toBe(speedRamp);
    expect(normalizeOperationTime(seededLayer, fps)).toBe(seededLayer);
  });

  it('leaves observations, snapshots and non-time edits byte-identical', () => {
    const unchangedTypes = [
      'add_asset',
      'remove_asset',
      'move_asset',
      'create_folder',
      'rename_folder',
      'move_folder',
      'delete_folder',
      'add_clip',
      'set_clip_source_range',
      'set_clip_media',
      'set_transcript',
      'remove_marker',
      'restore_assets',
      'restore_folders',
      'set_effect_params',
      'set_track_flags',
      'set_track_caption_style',
      'set_caption_style',
      'set_caption_cue',
      'set_clip_speed',
      'set_clip_speed_ramp',
      'set_clip_crop',
      'set_clip_blend_mode',
      'add_layer',
      'remove_layer',
      'move_layer',
      'remove_effect_layer',
      'set_effect_layer_params',
      'set_effect_layer_enabled',
      'restore_effect_layer',
      'restore_clips',
    ] as const;

    for (const type of unchangedTypes) {
      const operation = asOperation({ type, sentinel: true });
      expect(normalizeOperationTime(operation, fps)).toBe(operation);
    }
  });

  it('reports whether normalization changed an operation and snaps optional seconds', () => {
    const before = asOperation({ type: 'split_clip', clipId: 'c', at: 0.049 });
    const after = normalizeOperationTime(before, fps);
    expect(operationTimeChanged(before, after)).toBe(true);
    expect(operationTimeChanged(after, after)).toBe(false);
    expect(snapOptionalSeconds(undefined, fps)).toBeUndefined();
    expect(snapOptionalSeconds(0.049, fps)).toBeCloseTo(frameTime(1));
  });
});
