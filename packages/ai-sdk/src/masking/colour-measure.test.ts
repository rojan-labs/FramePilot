import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLOUR_MEASURE_THRESHOLDS,
  measuredColour,
  measuredNeutralPick,
  type MeasuredColour,
} from './colour-measure.js';

const neutral = (neutralLightness: number) => ({ neutralShare: 0.95, neutralLightness });

describe('measuredColour', () => {
  it.each([
    [5, 'black'],
    [21.6, 'black'],
    [30, 'black|grey'],
    [39.3, 'grey'],
    [55.1, 'grey'],
    [60, 'grey|silver'],
    [65.4, 'silver'],
    [77.7, 'silver'],
    [80, 'silver|white'],
    [83.8, 'white'],
    [99, 'white'],
  ] as const)('reads a neutral crop at L* %d as %s', (lightness, expected) => {
    expect(measuredColour(neutral(lightness))).toBe(expected);
  });

  it('calls a crop chromatic, mixed or neutral by its neutral share', () => {
    expect(measuredColour({ neutralShare: 0.1, neutralLightness: null })).toBe('chromatic');
    expect(measuredColour({ neutralShare: 0.5, neutralLightness: 90 })).toBe('chromatic');
    expect(measuredColour({ neutralShare: 0.6, neutralLightness: 90 })).toBe('mixed');
    expect(measuredColour({ neutralShare: 0.72, neutralLightness: 90 })).toBe('white');
    expect(measuredColour({ neutralShare: 0.9, neutralLightness: null })).toBe('mixed');
  });

  it('refuses to classify what was not measured or is not a measurement', () => {
    expect(measuredColour(undefined)).toBe('unmeasured');
    expect(measuredColour({ neutralShare: Number.NaN, neutralLightness: 50 })).toBe('unmeasured');
    expect(measuredColour({ neutralShare: 1.5, neutralLightness: 50 })).toBe('unmeasured');
    expect(measuredColour({ neutralShare: 0.9, neutralLightness: 140 })).toBe('unmeasured');
  });
});

describe('measuredNeutralPick', () => {
  const pick = (colour: 'white' | 'grey' | 'silver' | 'black', classes: MeasuredColour[]) =>
    measuredNeutralPick(colour, classes);

  it('picks the one crop in the named class', () => {
    expect(pick('white', ['chromatic', 'white', 'silver'])).toBe(1);
    expect(pick('silver', ['grey', 'silver', 'white'])).toBe(1);
    expect(pick('black', ['black', 'grey', 'chromatic'])).toBe(0);
  });

  it('asks when two crops are that colour or none is', () => {
    expect(pick('white', ['white', 'white', 'chromatic'])).toBeUndefined();
    expect(pick('grey', ['white', 'black', 'chromatic'])).toBeUndefined();
  });

  it('asks when another crop might be that colour', () => {
    expect(pick('white', ['white', 'silver|white'])).toBeUndefined();
    expect(pick('silver', ['silver', 'silver|white'])).toBeUndefined();
    expect(pick('silver', ['silver', 'grey|silver'])).toBeUndefined();
    expect(pick('grey', ['grey', 'mixed'])).toBeUndefined();
    expect(pick('black', ['black', 'unmeasured'])).toBeUndefined();
    // A band that does not touch the colour does not block it.
    expect(pick('black', ['black', 'silver|white'])).toBe(0);
  });

  it('never picks a crop that is itself in a band', () => {
    expect(pick('white', ['silver|white', 'chromatic'])).toBeUndefined();
  });
});

describe('the frozen thresholds (AM2.7)', () => {
  it('are the calibration fit the replay set records', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const replay = JSON.parse(
      readFileSync(join(repo, 'reports', 'ai-masking', 'colour-rerank-replay.json'), 'utf8'),
    ) as { thresholds: { frozen: unknown } };
    expect(replay.thresholds.frozen).toEqual(COLOUR_MEASURE_THRESHOLDS);
  });

  it('leave a dead band between every pair of neighbouring classes', () => {
    const { chromaticMaxShare, neutralMinShare, lightness } = COLOUR_MEASURE_THRESHOLDS;
    expect(chromaticMaxShare).toBeLessThan(neutralMinShare);
    let previous = 0;
    for (const band of lightness) {
      expect(band.darkMax).toBeGreaterThan(previous);
      expect(band.lightMin).toBeGreaterThan(band.darkMax);
      previous = band.lightMin;
    }
  });
});
