import { describe, expect, it } from 'vitest';
import {
  LedgerSnapshotSchema,
  MeasuredFactsSchema,
  SHOT_SIZE_LADDER,
  ShotRecordSchema,
  parseLedgerSnapshot,
  shotKey,
  shotSizeSteps,
  TIER0_VERSION,
} from './ledger.js';

const measured = {
  tier0Version: TIER0_VERSION,
  luma: { mean: 0.47, std: 0.18, p5: 0.08, p95: 0.86 },
  chroma: { uMean: 124.1, vMean: 133.8, satMean: 0.31 },
  warmth: 0.14,
  contrastIdx: 0.62,
  motion: { si: 41.2, ti: 7.9, class: 'static' },
  cutScore: 0.31,
  black: false,
  freeze: false,
  sharpness: 0.71,
  phash: '9f2c1a4b6d8e0f11',
  loudnessLufs: -18.2,
};

const shot = {
  assetId: 'a_7f3',
  contentHash: 'sha256:abcdef0123456789',
  shotIndex: 12,
  t0: 61,
  t1: 66.4,
  keyframeT: 62.5,
  measured,
};

describe('shot size ladder', () => {
  it('runs wide to close, which is what makes a step signed', () => {
    expect(SHOT_SIZE_LADDER[0]).toBe('EWS');
    expect(SHOT_SIZE_LADDER.at(-1)).toBe('ECU');
  });

  it('counts a tightening cut as positive steps', () => {
    expect(shotSizeSteps('WS', 'CU')).toBe(4);
    expect(shotSizeSteps('CU', 'WS')).toBe(-4);
    expect(shotSizeSteps('MS', 'MS')).toBe(0);
  });
});

describe('MeasuredFacts', () => {
  it('accepts a full tier-0 record', () => {
    expect(MeasuredFactsSchema.parse(measured).warmth).toBe(0.14);
  });

  it('allows a silent asset to carry no loudness', () => {
    const { loudnessLufs: _drop, ...noAudio } = measured;
    expect(MeasuredFactsSchema.parse(noAudio).loudnessLufs).toBeUndefined();
  });

  it('keeps the phash as text — a 64-bit value a JSON number would round', () => {
    expect(MeasuredFactsSchema.parse(measured).phash).toBe('9f2c1a4b6d8e0f11');
  });
});

describe('ShotRecord', () => {
  it('leaves the tiers that have not run undefined rather than defaulting them', () => {
    const parsed = ShotRecordSchema.parse(shot);
    expect(parsed.measured).toBeDefined();
    expect(parsed.labelled).toBeUndefined();
    expect(parsed.described).toBeUndefined();
  });

  it('treats a shot with no tier at all as valid — indexing has simply not reached it', () => {
    const { measured: _drop, ...bare } = shot;
    expect(() => ShotRecordSchema.parse(bare)).not.toThrow();
  });

  it('defaults splitOf to false so a real scene cut is the assumption', () => {
    expect(ShotRecordSchema.parse(shot).splitOf).toBe(false);
  });

  it('builds a stable key that survives a long content hash', () => {
    expect(shotKey(shot)).toBe('a_7f3:sha256:abcde:12');
  });
});

describe('parseLedgerSnapshot', () => {
  it('reads a snapshot and its coverage', () => {
    const snapshot = parseLedgerSnapshot({
      shots: [shot],
      digests: [],
      coverage: { measured: 1, labelled: 0, described: 0, total: 1 },
    });
    expect(snapshot?.shots).toHaveLength(1);
    expect(snapshot?.coverage.described).toBe(0);
  });

  it('degrades to null on a malformed payload rather than throwing into the run', () => {
    expect(parseLedgerSnapshot({ shots: [{ assetId: 5 }] })).toBeNull();
    expect(parseLedgerSnapshot('not a snapshot')).toBeNull();
  });

  it('reads an empty snapshot as real, and distinct from a broken one', () => {
    const empty = parseLedgerSnapshot({});
    expect(empty).not.toBeNull();
    expect(empty?.shots).toEqual([]);
    expect(empty?.coverage.total).toBe(0);
  });
});

describe('LedgerSnapshot paging', () => {
  it('carries a cursor when the engine had more rows to send', () => {
    const parsed = LedgerSnapshotSchema.parse({ shots: [], nextCursor: 'a_7f3:40' });
    expect(parsed.nextCursor).toBe('a_7f3:40');
  });
});
