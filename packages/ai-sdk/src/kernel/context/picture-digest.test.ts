/**
 * Tests for the PICTURE digest block (picture-digest.ts, ADR 0175 / plan VU2.4).
 *
 * What they assert: the block a realistic, fully covered project renders; that shares are
 * weighted by shots rather than by file, so one long interview does not read as one
 * fourteenth of the project; that an asset is only called dim when its brightest shot still
 * is; the 600-token bound; and the two honest-absence cases — no digests at all (omit), and
 * digests with nothing read yet (say so, in the words that stop the agent concluding the
 * footage is featureless).
 */
import { describe, expect, it } from 'vitest';
import type { AssetDigest, LedgerSnapshot } from '../../ledger.js';
import { MAX_DIGEST_CHARS, summarizePictureDigest } from './picture-digest.js';

const digest = (assetId: string, over: Partial<AssetDigest> = {}): AssetDigest => ({
  assetId,
  contentHash: 'h1',
  durationS: 120,
  shotCount: 10,
  medianShotS: 4.8,
  shotSizeMix: {},
  settingMix: {},
  motionMix: {},
  people: [],
  hasSpeech: false,
  lowQualityShots: [],
  coverage: { measured: 10, labelled: 10, described: 10, total: 10 },
  ...over,
});

const ledger = (digests: AssetDigest[]): LedgerSnapshot => ({
  shots: [],
  digests,
  coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
});

/** A small, fully covered project of the shape the plan's example describes. */
const covered = ledger([
  digest('a_host', {
    shotCount: 60,
    medianShotS: 6.2,
    shotSizeMix: { MS: 40, CU: 20 },
    settingMix: { 'indoor-office': 60 },
    motionMix: { static: 55, handheld: 5 },
    people: ['person_01'],
    exposureRange: [0.38, 0.52],
    warmthRange: [0.05, 0.2],
    hasSpeech: true,
    lowQualityShots: [3, 41],
  }),
  digest('a_street', {
    shotCount: 20,
    medianShotS: 3.4,
    shotSizeMix: { WS: 14, MS: 6 },
    settingMix: { street: 20 },
    motionMix: { handheld: 12, fast: 8 },
    people: ['person_01', 'person_02'],
    exposureRange: [0.2, 0.3],
    warmthRange: [-0.4, -0.1],
    coverage: { measured: 20, labelled: 20, described: 0, total: 20 },
  }),
]);

describe('summarizePictureDigest — a covered project', () => {
  const block = summarizePictureDigest(covered) as string;

  it('leads with the size of the project and the per-tier coverage', () => {
    expect(block.split('\n')[0]).toBe(
      'PICTURE — 2 assets · 80 shots · typical shot 4.8s · coverage: measured 2/2 assets, ' +
        'labelled 2/2, described 1/2',
    );
  });

  it('names the people by their ledger entity ids and how much footage they are in', () => {
    expect(block).toContain('People: person_01 (in 2 assets), person_02 (1)');
  });

  it('weights the mixes by shots, not by file', () => {
    // 60 of 80 shots are the office interview, so the office is 75% — not 50%, which is what
    // averaging the two assets would say.
    expect(block).toContain('Settings: indoor-office 75% · street 25%');
    expect(block).toContain('Shot sizes: MS 57% · CU 25% · WS 18%');
    expect(block).toContain('Motion: static 69% · handheld 21% · fast 10%');
  });

  it('calls out the dark asset, the warmth spread, and the flagged shots', () => {
    // a_street tops out at 0.30: even its brightest shot is dim. a_host does not qualify.
    expect(block).toContain('Exposure: 1 asset dim (a_street)');
    expect(block).toContain('warmth −0.40…+0.20 across assets');
    expect(block).toContain('Low quality: 2 shots flagged soft, black or frozen on a_host');
  });

  it('says nothing about a tier that ran, so the measured-only caveat stays away', () => {
    expect(block).not.toContain('Only the measured tier has run');
  });
});

describe('summarizePictureDigest — exposure judgement', () => {
  it('does not call a normally exposed asset dim because one shot is dark', () => {
    const block = summarizePictureDigest(
      ledger([digest('a1', { exposureRange: [0.05, 0.5], warmthRange: [0, 0] })]),
    ) as string;
    expect(block).not.toContain('dim');
    expect(block).not.toContain('dark');
  });

  it('calls an asset bright only when its darkest shot is already bright', () => {
    const block = summarizePictureDigest(
      ledger([digest('a1', { exposureRange: [0.7, 0.9] })]),
    ) as string;
    expect(block).toContain('Exposure: 1 asset bright (a1)');
  });
});

describe('summarizePictureDigest — honest absence', () => {
  it('is omitted entirely when the ledger carries no digests', () => {
    expect(summarizePictureDigest(null)).toBeUndefined();
    expect(summarizePictureDigest(undefined)).toBeUndefined();
    expect(summarizePictureDigest(ledger([]))).toBeUndefined();
  });

  it('says the footage is UNREAD, not featureless, when no tier has run', () => {
    const unread = ledger([
      digest('a1', {
        shotCount: 0,
        coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
      }),
      digest('a2', {
        shotCount: 0,
        coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
      }),
    ]);
    const block = summarizePictureDigest(unread) as string;
    expect(block).toContain('2 assets on this project, none of it read yet');
    expect(block).toContain('do not treat it as featureless');
    // No mix lines: there is nothing to summarise, and an empty-looking summary is the one
    // failure mode this block must never have.
    expect(block).not.toContain('Settings:');
    expect(block).not.toContain('Shot sizes:');
  });

  it('says what a keyless, measured-only install does and does not know', () => {
    const measuredOnly = ledger([
      digest('a1', {
        shotCount: 12,
        motionMix: { static: 12 },
        exposureRange: [0.4, 0.5],
        coverage: { measured: 12, labelled: 0, described: 0, total: 12 },
      }),
    ]);
    const block = summarizePictureDigest(measuredOnly) as string;
    expect(block).toContain('coverage: measured 1/1 assets, labelled 0/1, described 0/1');
    expect(block).toContain('who and what is on screen is not');
    expect(block).toContain('Motion: static 100%');
    expect(block).not.toContain('Settings:');
  });
});

describe('summarizePictureDigest — the budget', () => {
  it('never exceeds its character bound, however many assets there are', () => {
    const many = ledger(
      Array.from({ length: 200 }, (_, i) =>
        digest(`asset_${String(i)}`, {
          people: [`person_${String(i)}`],
          settingMix: { [`setting_${String(i)}`]: 1 },
          shotSizeMix: { MS: 1 },
          motionMix: { static: 1 },
          exposureRange: [0.05, 0.1],
          warmthRange: [-0.5, 0.5],
          lowQualityShots: [1, 2, 3],
        }),
      ),
    );
    const block = summarizePictureDigest(many) as string;
    expect(block.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    // The heading is never the line that gets dropped.
    expect(block.startsWith('PICTURE — 200 assets')).toBe(true);
  });

  it('collapses long tails to a count rather than printing them', () => {
    const block = summarizePictureDigest(
      ledger([
        digest('a1', {
          settingMix: Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [`setting_${String(i)}`, 9 - i]),
          ),
        }),
      ]),
    ) as string;
    expect(block).toContain('+4 more');
  });
});
