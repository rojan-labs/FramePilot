import { describe, expect, it } from 'vitest';
import { activeTimedItemsAt, buildTemporalIndex } from './temporal-index.js';

describe('temporal preview index', () => {
  it('keeps movie-sized caption lookup in the current fine bucket', () => {
    const items = Array.from({ length: 7_200 }, (_, start) => ({
      id: `cue-${start}`,
      start,
      end: start + 0.8,
    }));
    const index = buildTemporalIndex(items);
    expect(index.buckets.get(720)?.length).toBeLessThanOrEqual(5);
    expect(index.coarseBuckets.size).toBe(0);
    expect(activeTimedItemsAt(index, 3_602.2).map((item) => item.id)).toEqual(['cue-3602']);
  });

  it('stores long effects in coarse buckets instead of every five-second bucket', () => {
    const effects = Array.from({ length: 100 }, (_, index) => ({
      id: `fx-${index}`,
      start: 0,
      end: 7_200,
    }));
    const temporal = buildTemporalIndex(effects);
    const fineRefs = [...temporal.buckets.values()].reduce((sum, entries) => sum + entries.length, 0);
    const coarseRefs = [...temporal.coarseBuckets.values()].reduce(
      (sum, entries) => sum + entries.length,
      0,
    );

    expect(fineRefs).toBe(0);
    expect(coarseRefs).toBe(2_400); // 24 five-minute buckets × 100, not 144,000 refs.
    expect(activeTimedItemsAt(temporal, 3_600)).toHaveLength(100);
  });

  it('preserves authoring order when fine and coarse intervals overlap', () => {
    const longBack = { id: 'long-back', start: 0, end: 7_200 };
    const localFront = { id: 'local-front', start: 99, end: 101 };
    const longTop = { id: 'long-top', start: 0, end: 7_200 };
    const index = buildTemporalIndex([longBack, localFront, longTop]);
    expect(activeTimedItemsAt(index, 100)).toEqual([longBack, localFront, longTop]);
  });

  it('keeps end-exclusive boundaries and overlapping short spans', () => {
    const back = { id: 'back', start: 0, end: 10 };
    const front = { id: 'front', start: 4, end: 5 };
    const index = buildTemporalIndex([back, front]);
    expect(activeTimedItemsAt(index, 4.5)).toEqual([back, front]);
    expect(activeTimedItemsAt(index, 5)).toEqual([back]);
    expect(activeTimedItemsAt(index, 10)).toEqual([]);
  });

  it('ignores invalid spans and falls back from an invalid bucket size', () => {
    const valid = { id: 'valid', start: 0, end: 1 };
    const index = buildTemporalIndex([valid, { id: 'empty', start: 2, end: 2 }], 0);
    expect(index.bucketSeconds).toBe(5);
    expect(index.coarseBucketSeconds).toBe(300);
    expect(activeTimedItemsAt(index, Number.NaN)).toEqual([]);
    expect(activeTimedItemsAt(index, 0)).toEqual([valid]);
  });
});
