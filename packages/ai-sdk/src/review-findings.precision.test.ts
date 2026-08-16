import { describe, expect, it } from 'vitest';
import type { TimelineDiff } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  ReviewFindingQueue,
  regionsOverlap,
  touchedRegion,
  type ReviewFinding,
  type TouchedRegion,
} from './review-findings.js';

function timeline(input: {
  readonly aEnd?: number;
  readonly bStart?: number;
  readonly bEnd?: number;
  readonly muted?: boolean;
} = {}): Timeline {
  return {
    revision: 1,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        hidden: false,
        muted: input.muted ?? false,
        clips: [
          {
            id: 'a',
            assetId: 'asset-a',
            start: 0,
            end: input.aEnd ?? 4,
            effects: [],
          },
          {
            id: 'b',
            assetId: 'asset-b',
            start: input.bStart ?? 20,
            end: input.bEnd ?? 24,
            effects: [],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

function region(before: Timeline, after: Timeline): TouchedRegion {
  return touchedRegion({ before, after, summary: [] } as TimelineDiff);
}

function finding(scope: TouchedRegion): ReviewFinding {
  return {
    id: 'finding-a',
    turnIndex: 0,
    detail: 'Transition on clip A flashes black.',
    lineage: ['temporal:decision=fail'],
    scope: {
      ...scope,
      projectRevision: 2,
      patchId: 'patch-a',
    },
  };
}

describe('precise review regions', () => {
  it('does not overlap unrelated clips merely because they share a track', () => {
    const base = timeline();
    const editA = region(base, timeline({ aEnd: 3 }));
    const editB = region(base, timeline({ bStart: 21, bEnd: 24 }));

    expect(editA.trackIds.has('v1')).toBe(true);
    expect(editB.trackIds.has('v1')).toBe(true);
    expect(regionsOverlap(editA, editB)).toBe(false);
  });

  it('treats whole-track metadata changes as overlapping clips on that track', () => {
    const base = timeline();
    const editA = region(base, timeline({ aEnd: 3 }));
    const muteTrack = region(base, timeline({ muted: true }));

    expect(regionsOverlap(editA, muteTrack)).toBe(true);
    expect(regionsOverlap(muteTrack, editA)).toBe(true);
  });

  it('does not claim a delivered finding is resolved before the repair is reviewed', async () => {
    const base = timeline();
    const editA = region(base, timeline({ aEnd: 3 }));
    const queue = new ReviewFindingQueue();

    queue.recordTurn(0, editA);
    queue.markDelivered([finding(editA)]);
    queue.recordTurn(1, editA);

    expect(queue.takeResolved()).toEqual([]);

    queue.track(1, () => Promise.resolve([]));
    await queue.drainAll();
    expect(queue.takeResolved()).toHaveLength(1);
    expect(queue.takeResolved()).toEqual([]);
  });

  it('keeps a delivered finding open when the repair review still finds a defect', async () => {
    const base = timeline();
    const editA = region(base, timeline({ aEnd: 3 }));
    const queue = new ReviewFindingQueue();

    queue.recordTurn(0, editA);
    queue.markDelivered([finding(editA)]);
    queue.recordTurn(1, editA);
    queue.track(1, () =>
      Promise.resolve([
        {
          ...finding(editA),
          id: 'finding-a-recheck',
          turnIndex: 1,
        },
      ]),
    );

    await queue.drainAll();
    expect(queue.takeResolved()).toEqual([]);
  });
});
