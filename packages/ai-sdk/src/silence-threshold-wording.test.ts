/**
 * "N silent ranges" is a count of stretches under a LEVEL, and the level is the whole
 * meaning (run `137d8fd0`).
 *
 * Wind-only GoPro audio, no speech, and an editor who asked "check whether there's any real
 * silence and tell me straight — I don't think there is". The probe found 728 stretches
 * under the -30 dB default (quiet wind is under -30 dB), and the run told the editor
 * "silences catalogued". The payload did not carry the floor it applied, so nothing
 * downstream could have said otherwise. Now it does, and both the card and the model's
 * digest say it — and say that it is a level, not a verdict.
 */
import { describe, expect, it } from 'vitest';
import { summarizeAnalysis } from './sidecar-executor.js';
import { summarizeReadResult } from './orchestrator.js';

const ranges = [
  { start: 0, end: 2.1, duration: 2.1 },
  { start: 4.3, end: 6.1, duration: 1.8 },
  { start: 8.1, end: 9.8, duration: 1.7 },
];

describe('the silence card names the level it measured against', () => {
  it('says "under N dB" when the payload carries the floor', () => {
    expect(summarizeAnalysis('analyze_silence', { ranges, noiseFloorDb: -30 })).toBe(
      'Found 3 stretches under -30 dB',
    );
    expect(
      summarizeAnalysis('analyze_silence', { ranges: ranges.slice(0, 1), noiseFloorDb: -40 }),
    ).toBe('Found 1 stretch under -40 dB');
  });

  it('keeps the old sentence for a payload with no floor (older engines)', () => {
    expect(summarizeAnalysis('analyze_silence', { ranges })).toBe('Found 3 silent ranges');
  });
});

describe('the model digest says it is a level, not a judgement', () => {
  it('qualifies the count with the floor and how to read it', () => {
    const digest = summarizeReadResult('analyze_silence', {
      assetId: 'asset_raw_skating',
      ranges,
      noiseFloorDb: -30,
    });
    expect(digest).toContain('3 silent gaps under -30 dB');
    expect(digest).toContain('a level, not a judgement');
    expect(digest).toContain('lower noiseFloorDb');
  });

  it('adds no qualification it cannot back, for a payload with no floor', () => {
    const digest = summarizeReadResult('analyze_silence', { assetId: 'a', ranges });
    expect(digest).toContain('3 silent gaps');
    expect(digest).not.toContain('dB');
  });
});
