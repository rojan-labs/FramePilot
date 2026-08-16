import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  buildTransitionBoundaryIndex,
  transitionEligibility,
  transitionEligibilityIn,
} from './edit-boundaries.js';

const timeline: Timeline = {
  tracks: [
    {
      id: 'video-1',
      type: 'video',
      clips: [
        {
          id: 'a',
          assetId: 'asset-a',
          trackId: 'video-1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
        {
          id: 'b',
          assetId: 'asset-b',
          trackId: 'video-1',
          start: 5,
          end: 10,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const request = (durationSeconds: number) => ({
  fromClipId: 'a',
  toClipId: 'b',
  durationSeconds,
  kind: 'cross-dissolve',
});

describe('transition duration eligibility invariant', () => {
  const index = buildTransitionBoundaryIndex(timeline);

  for (const bad of [-1, -0.001, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects ${String(bad)} through the indexed authority`, () => {
      const verdict = transitionEligibilityIn(index, request(bad));
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toBe('invalid_duration');
    });

    it(`rejects ${String(bad)} through the convenience authority`, () => {
      const verdict = transitionEligibility(timeline, request(bad));
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toBe('invalid_duration');
    });
  }
});
