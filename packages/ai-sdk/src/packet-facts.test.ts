/**
 * VU2.5 — visual evidence packets carry facts, and the `facts` filter is a real filter.
 *
 * The case that matters most is the last one: a filter over footage nothing has measured
 * must come back saying it was ignored. Returning the full result set silently would let
 * the model quote unfiltered packets as "the wide shots of the street".
 */
import { describe, expect, it } from 'vitest';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from './ledger.js';
import { applyPacketFacts, filterIsEmpty } from './packet-facts.js';

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

const shot = (over: Partial<ShotRecord> & Pick<ShotRecord, 'assetId'>): ShotRecord => ({
  contentHash: 'hash_1',
  shotIndex: 0,
  t0: 0,
  t1: 5,
  keyframeT: 2.5,
  splitOf: false,
  measured: measured(),
  ...over,
});

const ledgerOf = (shots: ShotRecord[]): LedgerSnapshot => ({
  shots,
  digests: [],
  coverage: { measured: shots.length, labelled: 0, described: 0, total: shots.length },
});

const packet = (assetId: string, t0: number, t1: number) => ({ assetId, t0, t1, score: 0.8 });

describe('applyPacketFacts', () => {
  it('attaches the structured description when the shot has one', () => {
    const ledger = ledgerOf([
      shot({
        assetId: 'a',
        described: {
          tier2Version: 1,
          model: 'vlm',
          summary: 'a woman crossing a street',
          subject: 'woman',
          action: 'crossing',
          setting: 'street',
          camera: { shotSize: 'WS', movement: 'static' },
          mood: 'busy',
          onScreenText: ['WALK'],
          quality: [],
          p: 0.8,
        },
      }),
    ]);
    const result = applyPacketFacts([packet('a', 1, 3)], ledger);
    expect(result.packets[0]).toMatchObject({
      facts: { provenance: 'described', summary: 'a woman crossing a street' },
    });
  });

  it('falls back to a words line when only the measurement exists', () => {
    const result = applyPacketFacts([packet('a', 1, 3)], ledgerOf([shot({ assetId: 'a' })]));
    const facts = (result.packets[0] as { facts: { provenance: string; words: string } }).facts;
    expect(facts.provenance).toBe('measured');
    expect(facts.words).toContain('static');
  });

  it('returns the packets untouched when there is no ledger', () => {
    const packets = [packet('a', 1, 3)];
    const result = applyPacketFacts(packets, null);
    expect(result.packets).toBe(packets);
    expect(result.note).toBe('');
  });

  it('filters by a measured motion class and reports what it dropped', () => {
    const ledger = ledgerOf([
      shot({ assetId: 'a' }),
      shot({ assetId: 'b', measured: measured({ motion: { si: 60, ti: 40, class: 'fast' } }) }),
    ]);
    const result = applyPacketFacts([packet('a', 0, 3), packet('b', 0, 3)], ledger, {
      motion: ['fast'],
    });
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]).toMatchObject({ assetId: 'b' });
    expect(result.removed).toBe(1);
    expect(result.note).toContain('dropped by the facts filter');
  });

  it('does not accept a label the model was not confident about', () => {
    const ledger = ledgerOf([
      shot({
        assetId: 'a',
        labelled: {
          tier1Version: 1,
          model: 'siglip',
          shotSize: { value: 'WS', p: 0.4 },
          faces: 0,
          entities: [],
        },
      }),
    ]);
    const result = applyPacketFacts([packet('a', 0, 3)], ledger, { shotSize: ['WS'] });
    expect(result.packets).toHaveLength(0);
  });

  it('says the filter was ignored rather than pretending every packet matched', () => {
    const packets = [packet('a', 0, 3)];
    const result = applyPacketFacts(packets, null, { shotSize: ['WS'] });
    expect(result.packets).toBe(packets);
    expect(result.note).toContain('the facts filter was ignored');
    expect(result.note).toContain('has not been measured yet');
  });

  it('treats an all-empty filter as no filter', () => {
    expect(filterIsEmpty({ shotSize: [], motion: [] })).toBe(true);
    expect(filterIsEmpty({ motion: ['fast'] })).toBe(false);
  });
});
