import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  DEFAULT_CLIP_BLUR_AMOUNT,
  MAX_CLIP_BLUR_AMOUNT,
  clipBlurAmount,
  clipBlurEffect,
  clipBlurRadius,
} from './clip-blur.js';
import { colorGradeContractIssues } from './edit-value-contracts.js';
import { applyOperation } from './operations.js';
import { validatePatch } from './validator.js';
import type { Patch, PatchId } from './patch.js';

const timeline: Timeline = {
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'v1',
          start: 0,
          end: 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
} as unknown as Timeline;

const patchOf = (amount: unknown): Patch => ({
  patchId: 'p' as PatchId,
  createdBy: 'user',
  reason: 'blur',
  operations: [
    {
      type: 'apply_color_grade',
      clipId: 'c1',
      effect: { id: 'c1__blur', type: 'blur', params: { amount }, keyframes: [] },
    },
  ],
});

describe('clip blur', () => {
  it('reads amount the way the engine does: clamped, and 0 for anything malformed', () => {
    expect(clipBlurAmount({ amount: 0.05 })).toBe(0.05);
    expect(clipBlurAmount({ amount: 3 })).toBe(MAX_CLIP_BLUR_AMOUNT);
    expect(clipBlurAmount({ amount: -1 })).toBe(0);
    expect(clipBlurAmount({ amount: Number.NaN })).toBe(0);
    expect(clipBlurAmount({ amount: '0.1' })).toBe(0);
    expect(clipBlurAmount({})).toBe(0);
  });

  it('is a fraction of the smaller side, so the look survives any decode size', () => {
    expect(clipBlurRadius({ amount: 0.1 }, 1920, 1080)).toBeCloseTo(108, 9);
    expect(clipBlurRadius({ amount: 0.1 }, 640, 360)).toBeCloseTo(36, 9);
  });

  it('attaches through apply_color_grade under the shared id, and validates', () => {
    const effect = clipBlurEffect('c1');
    expect(effect).toEqual({
      id: 'c1__blur',
      type: 'blur',
      params: { amount: DEFAULT_CLIP_BLUR_AMOUNT },
      keyframes: [],
    });
    const next = applyOperation(timeline, { type: 'apply_color_grade', clipId: 'c1', effect });
    expect(next.tracks[0]!.clips[0]!.effects).toEqual([effect]);
    expect(validatePatch(timeline, patchOf(0.04))).toEqual({ valid: true, issues: [] });
  });

  it('refuses a blur with no amount or one past the ceiling', () => {
    for (const amount of [0, -0.1, 0.5, Number.POSITIVE_INFINITY, 'strong', undefined]) {
      const issues = colorGradeContractIssues({
        id: 'b',
        type: 'blur',
        params: amount === undefined ? {} : { amount },
        keyframes: [],
      });
      expect(
        issues.map((issue) => issue.field),
        String(amount),
      ).toEqual(['params.amount']);
    }
    expect(
      colorGradeContractIssues({ id: 'b', type: 'blur', params: { amount: 0.25 }, keyframes: [] }),
    ).toEqual([]);
  });
});
