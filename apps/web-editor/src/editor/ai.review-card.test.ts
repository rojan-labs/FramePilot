/**
 * Guard: a review card is built once per edit.
 *
 * `structuredDiffTimeline` compares clips by `JSON.stringify`, so building a card
 * serialises every clip of both timelines. The sidebar's memo keys on the
 * conversation view's node array, whose identity changes on every streamed frame
 * batch (~60x/s), so an uncached card meant re-serialising every visible diff's
 * whole before/after timeline at display rate for the length of a run.
 */
import { describe, expect, it } from 'vitest';
import type { EditResult } from '@framepilot/ai-sdk';
import type { Timeline } from '@framepilot/timeline-schema';
import { toReviewCard } from './ai.js';

const timeline = (end: number): Timeline => ({
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end,
          sourceStart: 0,
          sourceEnd: end,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
});

const edit = (): EditResult =>
  ({
    text: 'Tightened the intro',
    patch: { patchId: 'p1', createdBy: 'agent', reason: 'r', operations: [] },
    validation: { valid: true, issues: [] },
    diff: { before: timeline(4), after: timeline(2), summary: ['Trimmed clip'] },
  }) as unknown as EditResult;

describe('toReviewCard', () => {
  it('returns the same card for the same edit instead of rebuilding it', () => {
    const result = edit();
    const first = toReviewCard(result);
    const second = toReviewCard(result);
    // Identity, not deep equality: a fresh-but-equal object means the whole
    // before/after serialisation ran again.
    expect(second).toBe(first);
  });

  it('still describes each distinct edit on its own terms', () => {
    const one = toReviewCard(edit());
    const two = toReviewCard(edit());
    expect(two).not.toBe(one);
    expect(two.changes).toEqual(['Trimmed clip']);
    expect(two.changedRegions.length).toBeGreaterThan(0);
  });
});
