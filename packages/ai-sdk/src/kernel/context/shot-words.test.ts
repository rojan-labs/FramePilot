import { describe, expect, it } from 'vitest';
import { TIER0_VERSION, TIER1_VERSION, TIER2_VERSION } from '../../ledger.js';
import type { DescribedFacts, LabelledFacts, MeasuredFacts } from '../../ledger.js';
import {
  MAX_ROW_CHARS,
  MIN_LABEL_CONFIDENCE,
  contrastWord,
  exposureWord,
  hasShotWords,
  shotWords,
  trimToWords,
  warmthWord,
} from './shot-words.js';

function measured(over: Partial<MeasuredFacts> = {}): MeasuredFacts {
  return {
    tier0Version: TIER0_VERSION,
    luma: { mean: 0.42, std: 0.1, p10: 0.2, p90: 0.62 },
    chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
    warmth: 0,
    contrastIdx: 0.42,
    motion: { si: 40, ti: 1, class: 'static' },
    cutScore: 0,
    black: false,
    freeze: false,
    sharpness: 0.7,
    phash: '0000000000000000',
    ...over,
  };
}

function labelled(over: Partial<LabelledFacts> = {}): LabelledFacts {
  return { tier1Version: TIER1_VERSION, model: 'siglip', faces: 0, entities: [], ...over };
}

function described(over: Partial<DescribedFacts> = {}): DescribedFacts {
  return {
    tier2Version: TIER2_VERSION,
    model: 'smolvlm2',
    summary: '',
    subject: '',
    action: '',
    setting: '',
    camera: {},
    mood: '',
    onScreenText: [],
    quality: [],
    p: 0.9,
    ...over,
  };
}

describe('exposureWord', () => {
  it('says nothing about a normally exposed shot', () => {
    // The interview fixture sits at 0.40–0.43. A word here would be noise on every row.
    expect(exposureWord(0.42)).toBe('');
  });

  it('names the ends of the range', () => {
    expect(exposureWord(0.1)).toBe('dark');
    expect(exposureWord(0.3)).toBe('dim');
    expect(exposureWord(0.7)).toBe('bright');
    expect(exposureWord(0.9)).toBe('very bright');
  });
});

describe('warmthWord', () => {
  it('is silent inside the neutral band', () => {
    expect(warmthWord(0)).toBe('');
    expect(warmthWord(0.1)).toBe('');
    expect(warmthWord(-0.1)).toBe('');
  });

  it('names a real cast in both directions', () => {
    // -0.6 is the measured opening of the vertical fixture.
    expect(warmthWord(-0.6)).toBe('very cool');
    expect(warmthWord(-0.2)).toBe('cool');
    expect(warmthWord(0.2)).toBe('warm');
    expect(warmthWord(0.6)).toBe('very warm');
  });
});

describe('contrastWord', () => {
  it('names only the extremes', () => {
    expect(contrastWord(0.42)).toBe('');
    expect(contrastWord(0.1)).toBe('flat');
    expect(contrastWord(0.8)).toBe('punchy');
  });
});

describe('shotWords — provenance', () => {
  it('says nothing at all when no tier has run', () => {
    // The whole point: "not measured" and "normal" must never render the same.
    expect(shotWords({})).toBe('');
    expect(hasShotWords({})).toBe(false);
  });

  it('speaks from measurements alone', () => {
    const dimAndFlat = measured({
      luma: { mean: 0.15, std: 0.1, p10: 0.05, p90: 0.3 },
      contrastIdx: 0.25 - 0.05,
    });
    expect(shotWords({ measured: dimAndFlat })).toBe('static · dark flat');
  });

  it('drops a label it does not believe', () => {
    const facts = {
      measured: measured(),
      labelled: labelled({ shotSize: { value: 'MS', p: MIN_LABEL_CONFIDENCE - 0.01 } }),
    };
    expect(shotWords(facts)).not.toContain('MS');
  });

  it('says a label it does believe', () => {
    const facts = {
      measured: measured(),
      labelled: labelled({ shotSize: { value: 'MS', p: 0.81 } }),
    };
    expect(shotWords(facts)).toContain('MS');
  });

  it('prefers a described subject over a label', () => {
    const facts = {
      measured: measured(),
      labelled: labelled({ subjectKind: { value: 'person', p: 0.9 } }),
      described: described({ subject: 'man in grey jacket' }),
    };
    expect(shotWords(facts)).toContain('man in grey jacket');
    expect(shotWords(facts)).not.toContain('person');
  });

  it('falls back to the summary when a description has no subject', () => {
    const facts = { described: described({ summary: 'A street at night' }) };
    expect(shotWords(facts)).toContain('A street at night');
  });

  it('ignores a description the model itself doubted', () => {
    const facts = { described: described({ subject: 'maybe a dog', p: 0.3 }) };
    expect(shotWords(facts)).toBe('');
  });
});

describe('shotWords — never numbers', () => {
  it('prints no digits, because the model must not read a value it could copy into a grade', () => {
    const rendered = shotWords({
      measured: measured({ warmth: -0.63, luma: { mean: 0.18, std: 0.2, p10: 0.02, p90: 0.9 } }),
      labelled: labelled({ shotSize: { value: 'WS', p: 0.9 } }),
    });
    expect(rendered).not.toMatch(/\d/);
  });
});

describe('shotWords — warnings', () => {
  it('flags a black shot', () => {
    expect(shotWords({ measured: measured({ black: true }) })).toContain('⚑black');
  });

  it('flags a frozen shot', () => {
    expect(shotWords({ measured: measured({ freeze: true }) })).toContain('⚑frozen');
  });

  it('flags a soft shot', () => {
    expect(shotWords({ measured: measured({ sharpness: 0.2 }) })).toContain('⚑soft');
  });

  it('never flags from a probabilistic tier', () => {
    const facts = { labelled: labelled({ subjectKind: { value: 'none', p: 0.99 } }) };
    expect(shotWords(facts)).not.toContain('⚑');
  });
});

describe('shotWords — budget', () => {
  it('stays inside the row budget', () => {
    const facts = {
      measured: measured({
        black: true,
        luma: { mean: 0.1, std: 0.2, p10: 0.02, p90: 0.95 },
        warmth: -0.9,
        motion: { si: 40, ti: 90, class: 'fast' as const },
      }),
      labelled: labelled({ shotSize: { value: 'EWS', p: 0.9 } }),
      described: described({
        subject: 'an extremely long description of a subject that will not fit in the row budget',
      }),
    };
    expect(shotWords(facts).length).toBeLessThanOrEqual(MAX_ROW_CHARS);
  });

  it('keeps the warning even when the row has to be trimmed', () => {
    const facts = {
      measured: measured({ black: true, motion: { si: 40, ti: 90, class: 'fast' as const } }),
      described: described({ subject: 'x'.repeat(200) }),
    };
    const rendered = shotWords(facts, 40);
    expect(rendered.length).toBeLessThanOrEqual(40);
    expect(rendered).toContain('⚑black');
  });

  it('drops from the right, keeping the most identifying part', () => {
    const facts = {
      measured: measured({ luma: { mean: 0.1, std: 0.1, p10: 0, p90: 0.2 } }),
      described: described({ subject: 'man at desk' }),
    };
    expect(shotWords(facts, 16)).toBe('man at desk');
  });

  it('renders the plan’s own example', () => {
    const facts = {
      measured: measured({
        warmth: 0.2,
        luma: { mean: 0.7, std: 0.1, p10: 0.5, p90: 0.9 },
        motion: { si: 40, ti: 1, class: 'static' as const },
      }),
      labelled: labelled({ shotSize: { value: 'MS', p: 0.81 } }),
      described: described({ subject: 'man at desk' }),
    };
    expect(shotWords(facts)).toBe('MS man at desk · static · bright warm');
  });
});

describe('trimToWords', () => {
  it('leaves short text alone', () => {
    expect(trimToWords('man at desk', 40)).toBe('man at desk');
  });

  it('cuts on a word boundary rather than mid-word', () => {
    expect(trimToWords('a man standing at a desk in an office', 20)).toBe('a man standing at a…');
  });

  it('collapses whitespace so a row cannot be padded by the model', () => {
    expect(trimToWords('  man   at\ndesk ', 40)).toBe('man at desk');
  });

  it('falls back to a hard cut when there is no usable boundary', () => {
    expect(trimToWords('x'.repeat(50), 10)).toBe('xxxxxxxxxx…');
  });
});
