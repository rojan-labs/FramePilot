import { describe, expect, it } from 'vitest';
import type { CropColourMeasurement } from './colour-measure.js';
import {
  ACHROMATIC_RIVAL_SHARE,
  COLOUR_RERANK_TEMPERATURE,
  agreedColourPick,
  colourEvidence,
  colourRerankPlan,
  colourRerankScores,
  type ColourRerankPlan,
} from './colour-rerank.js';
import type { MaskCandidate } from './contracts.js';
import {
  RERANK_MIN_GROUNDING,
  resolveMaskTargets,
  rankCandidates,
  type TargetDetection,
} from './target-resolution.js';
import { COLOUR_WORDS } from './target-vocabulary.js';

const candidate = (
  candidateId: string,
  objectClass: MaskCandidate['objectClass'],
  label: MaskCandidate['label'] = 'object',
): MaskCandidate => ({
  candidateId,
  label,
  score: 0.8,
  box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  sourceTime: 0,
  persistence: 1,
  ...(objectClass === undefined ? {} : { objectClass }),
});

/** A unit vector on one colour's axis: the synthetic space the harness also uses. */
const axis = (colour: string): number[] => COLOUR_WORDS.map((each) => (each === colour ? 1 : 0));

describe('colourRerankPlan', () => {
  const cars = [candidate('o0_a', 'car'), candidate('o0_b', 'car')];

  it('plans one prompt per palette colour, naming the singular noun', () => {
    const plan = colourRerankPlan('the red car', cars)!;
    expect(plan.colour).toBe('red');
    expect(plan.prompts).toHaveLength(COLOUR_WORDS.length);
    expect(plan.prompts[plan.colourIndex]).toBe('a photo of a red car');
    expect(plan.candidates.map((each) => each.candidateId)).toEqual(['o0_a', 'o0_b']);
    const grey = colourRerankPlan('the gray cars', cars)!;
    expect(grey.colour).toBe('grey');
    expect(grey.prompts[grey.colourIndex]).toBe('a photo of a grey car');
  });

  it('never shows SigLIP a candidate the detector did not class as the noun', () => {
    const plan = colourRerankPlan('the red car', [
      ...cars,
      candidate('o0_dog', 'dog'),
      candidate('o0_unclassed', undefined),
      candidate('p0_person', 'person', 'person'),
    ])!;
    expect(plan.candidates.map((each) => each.candidateId)).toEqual(['o0_a', 'o0_b']);
  });

  it.each([
    ['no colour', 'the car'],
    ['a word that is not a colour', 'the shiny car'],
    ['a colour and another word', 'the red shiny car'],
    ['two colours', 'the red and white car'],
    ['a person', 'the man in red'],
    ['out of vocabulary', 'the red sign'],
  ])('has no plan for %s', (_why, description) => {
    expect(colourRerankPlan(description, cars)).toBeUndefined();
  });

  it('has no plan with fewer than two candidates of the class', () => {
    expect(colourRerankPlan('the red car', [candidate('o0_a', 'car')])).toBeUndefined();
    expect(
      colourRerankPlan('the red car', [candidate('o0_a', 'car'), candidate('o0_b', 'dog')]),
    ).toBeUndefined();
  });
});

describe('colourRerankScores', () => {
  const plan = colourRerankPlan('the red car', [
    candidate('o0_red', 'car'),
    candidate('o0_grey', 'car'),
    candidate('o0_blue', 'car'),
  ])!;
  const prompts = COLOUR_WORDS.map(axis);

  it('scores each crop by its named colour head to head with its strongest other colour', () => {
    const scores = colourRerankScores(plan, [axis('red'), axis('grey'), axis('blue')], prompts);
    expect(scores.get('o0_red')).toBeGreaterThan(0.99);
    expect(scores.get('o0_grey')).toBeLessThan(0.01);
    expect(scores.get('o0_blue')).toBeLessThan(0.01);
  });

  it('uses the pack’s own label temperature', () => {
    expect(COLOUR_RERANK_TEMPERATURE).toBe(0.01);
  });

  it('refuses vectors that do not answer the plan', () => {
    expect(() => colourRerankScores(plan, [axis('red')], prompts)).toThrow(/3 crop vectors/);
    expect(() => colourRerankScores(plan, [axis('red'), axis('red'), axis('red')], [])).toThrow(
      /prompt vectors/,
    );
    expect(() => colourRerankScores(plan, [[1], [1], [1]], prompts)).toThrow(/Cannot compare/);
  });
});

describe('colourEvidence (AM2.6)', () => {
  /** A classification over the palette with the given shares, the rest spread evenly. */
  const classified = (shares: Readonly<Record<string, number>>): number[] => {
    const named = Object.values(shares).reduce((sum, share) => sum + share, 0);
    const rest = (1 - named) / (COLOUR_WORDS.length - Object.keys(shares).length);
    return COLOUR_WORDS.map((colour) => shares[colour] ?? rest);
  };
  const at = (colour: string): number => COLOUR_WORDS.indexOf(colour);

  it('counts a crop the colour it most is, though SigLIP spread its mass (white car on grass)', () => {
    const evidence = colourEvidence(classified({ red: 0.45, green: 0.3 }), at('red'));
    expect(evidence).toBeCloseTo(0.6, 5);
    expect(evidence).toBeGreaterThanOrEqual(RERANK_MIN_GROUNDING);
  });

  it('keeps a crop whose named colour is not strictly ahead under the floor', () => {
    expect(colourEvidence(classified({ red: 0.3, green: 0.3 }), at('red'))).toBeLessThan(
      RERANK_MIN_GROUNDING,
    );
    // No colour at all: an even spread is a tie, not a match.
    expect(colourEvidence(classified({}), at('red'))).toBeLessThan(RERANK_MIN_GROUNDING);
    expect(colourEvidence(classified({ red: 0.1, blue: 0.8 }), at('red'))).toBeLessThan(0.2);
  });

  it('holds an achromatic crop undecided when another achromatic word has a real share', () => {
    // A pale silver ball reads 0.79 white, 0.16 grey on real weights: never "the white ball".
    const silverBall = classified({ white: 0.79, grey: 0.16, silver: 0.02 });
    expect(colourEvidence(silverBall, at('white'))).toBeLessThan(RERANK_MIN_GROUNDING);
    // A white ball is 0.97 white: decided.
    const whiteBall = classified({ white: 0.97, grey: 0.02 });
    expect(colourEvidence(whiteBall, at('white'))).toBeGreaterThan(0.9);
    expect(ACHROMATIC_RIVAL_SHARE).toBe(0.1);
  });

  it('leaves chromatic colours to the head-to-head rule alone', () => {
    const redWithGreyWheels = classified({ red: 0.7, grey: 0.2 });
    expect(colourEvidence(redWithGreyWheels, at('red'))).toBeGreaterThan(RERANK_MIN_GROUNDING);
  });
});

describe('colour re-ranking decides only what it can', () => {
  const FRAMES = [0, 8, 16, 24];
  const car = (x: number): TargetDetection[] =>
    FRAMES.map((frame) => ({
      frame,
      label: 'object',
      box: { x, y: 0.4, width: 0.4, height: 0.35 },
      confidence: 0.9,
      objectClass: 'car',
      classScore: 0.9,
    }));
  const input = {
    clipId: 'shot',
    assetId: 'asset',
    fps: 24,
    sampledFrames: FRAMES,
    detections: [...car(0.05), ...car(0.55)],
    engine: 'test',
  };
  const scored = (colours: readonly [string, string]) => {
    const plain = rankCandidates({ ...input, description: 'the red car' });
    const plan: ColourRerankPlan = colourRerankPlan('the red car', plain)!;
    const byId = new Map(plain.map((each, index) => [each.candidateId, colours[index]!]));
    const rerank = colourRerankScores(
      plan,
      plan.candidates.map((each) => axis(byId.get(each.candidateId)!)),
      COLOUR_WORDS.map(axis),
    );
    return {
      plain,
      result: resolveMaskTargets({ ...input, description: 'the red car', evidence: { rerank } }),
    };
  };

  it('picks the red car when one of two cars is red', () => {
    const { plain, result } = scored(['red', 'grey']);
    expect(result.status).toBe('resolved');
    expect(result.chosenCandidateIds).toEqual([plain[0]!.candidateId]);
  });

  it('asks when neither car is red — the closer colour is not a match', () => {
    expect(scored(['blue', 'grey']).result.status).toBe('ambiguous_target');
  });

  it('asks when both cars are red', () => {
    expect(scored(['red', 'red']).result.status).toBe('ambiguous_target');
  });
});

describe('agreedColourPick (AM2.7): SigLIP and the measurement must agree', () => {
  /** A SigLIP classification whose top colour is `top` (0.7), the rest spread evenly. */
  const reads = (top: string): number[] =>
    COLOUR_WORDS.map((colour) => (colour === top ? 0.7 : 0.3 / (COLOUR_WORDS.length - 1)));
  const at = (colour: string): number => COLOUR_WORDS.indexOf(colour);
  const evidenceFor = (colour: string, distributions: number[][]): number[] =>
    distributions.map((distribution) => colourEvidence(distribution, at(colour)));
  const pick = (
    colour: string,
    tops: string[],
    classes: Parameters<typeof agreedColourPick>[3],
  ) => {
    const distributions = tops.map(reads);
    return agreedColourPick(colour, distributions, evidenceFor(colour, distributions), classes);
  };

  it('picks SigLIP’s chromatic choice only when its crop measures chromatic', () => {
    expect(pick('red', ['red', 'blue'], ['chromatic', 'chromatic'])).toBe(0);
    expect(pick('red', ['red', 'blue'], ['white', 'chromatic'])).toBeUndefined();
    expect(pick('red', ['red', 'blue'], ['mixed', 'chromatic'])).toBeUndefined();
    expect(pick('red', ['red', 'blue'], ['unmeasured', 'chromatic'])).toBeUndefined();
    // The measurement never promotes a crop SigLIP did not choose.
    expect(pick('red', ['blue', 'green'], ['chromatic', 'chromatic'])).toBeUndefined();
  });

  it('picks the one crop measured in a neutral class when SigLIP reads it neutral nearby', () => {
    // SigLIP reads flat silver as white: one step away, so the measurement decides.
    expect(pick('silver', ['white', 'white'], ['silver', 'white'])).toBe(0);
    expect(pick('white', ['white', 'white'], ['silver', 'white'])).toBe(1);
    expect(pick('black', ['grey', 'red'], ['black', 'chromatic'])).toBe(0);
  });

  it('asks when SigLIP reads the measured crop as a colour, or two steps away', () => {
    expect(pick('white', ['yellow', 'red'], ['white', 'chromatic'])).toBeUndefined();
    expect(pick('white', ['black', 'red'], ['white', 'chromatic'])).toBeUndefined();
    expect(pick('black', ['silver', 'red'], ['black', 'chromatic'])).toBeUndefined();
  });

  it('asks when SigLIP names the colour for a rival but not for the measured crop', () => {
    expect(pick('silver', ['white', 'silver'], ['silver', 'white'])).toBeUndefined();
    // Both named: SigLIP does not prefer the rival, the measurement decides.
    expect(pick('white', ['white', 'white'], ['white', 'silver'])).toBe(0);
  });

  it('asks when the measurement cannot single one crop out', () => {
    expect(pick('white', ['white', 'white'], ['white', 'white'])).toBeUndefined();
    expect(pick('white', ['white', 'white'], ['white', 'silver|white'])).toBeUndefined();
    expect(pick('grey', ['grey', 'red'], ['grey', 'mixed'])).toBeUndefined();
  });
});

describe('colourRerankScores with measurements (AM2.7)', () => {
  const FRAMES = [0, 8, 16, 24];
  const car = (x: number): TargetDetection[] =>
    FRAMES.map((frame) => ({
      frame,
      label: 'object',
      box: { x, y: 0.4, width: 0.3, height: 0.35 },
      confidence: 0.9,
      objectClass: 'car',
      classScore: 0.9,
    }));
  const input = {
    clipId: 'shot',
    assetId: 'asset',
    fps: 24,
    sampledFrames: FRAMES,
    detections: [...car(0.02), ...car(0.35), ...car(0.68)],
    engine: 'test',
  };
  const WHITE: CropColourMeasurement = { neutralShare: 0.97, neutralLightness: 90 };
  const SILVER: CropColourMeasurement = { neutralShare: 0.97, neutralLightness: 72 };
  const BLUE: CropColourMeasurement = { neutralShare: 0.05, neutralLightness: null };
  /** SigLIP on real weights reads both white and silver crops as white. */
  const vectors = ['white', 'white', 'blue'];

  const resolve = (
    description: string,
    measurements: readonly (CropColourMeasurement | undefined)[] | undefined,
  ) => {
    const plain = rankCandidates({ ...input, description });
    const plan = colourRerankPlan(description, plain)!;
    const rerank = colourRerankScores(
      plan,
      plan.candidates.map((_candidate, index) => axis(vectors[index]!)),
      COLOUR_WORDS.map(axis),
      measurements,
    );
    return {
      plain,
      rerank,
      result: resolveMaskTargets({ ...input, description, evidence: { rerank } }),
    };
  };

  it('resolves "the silver car" SigLIP alone could not, and "the white car" beside it', () => {
    const measured = [SILVER, WHITE, BLUE];
    expect(resolve('the silver car', undefined).result.status).toBe('ambiguous_target');
    const silver = resolve('the silver car', measured);
    expect(silver.result.status).toBe('resolved');
    expect(silver.result.chosenCandidateIds).toEqual([silver.plain[0]!.candidateId]);
    const white = resolve('the white car', measured);
    expect(white.result.chosenCandidateIds).toEqual([white.plain[1]!.candidateId]);
  });

  it('holds every candidate under the floor when the signals disagree', () => {
    const { rerank, result } = resolve('the white car', [WHITE, WHITE, BLUE]);
    expect(result.status).toBe('ambiguous_target');
    expect(Math.max(...rerank.values())).toBeLessThan(RERANK_MIN_GROUNDING);
  });

  it('asks for a colour no car has, even where SigLIP alone is sure of a chromatic one', () => {
    expect(resolve('the grey car', [SILVER, WHITE, BLUE]).result.status).toBe('ambiguous_target');
    expect(resolve('the blue car', undefined).result.status).toBe('resolved');
    expect(resolve('the blue car', [SILVER, WHITE, WHITE]).result.status).toBe('ambiguous_target');
  });

  it('treats a crop too small to measure as unknown, never as a match', () => {
    expect(resolve('the white car', [SILVER, undefined, BLUE]).result.status).toBe(
      'ambiguous_target',
    );
  });

  it('refuses measurements that do not answer the plan', () => {
    expect(() => resolve('the white car', [WHITE])).toThrow(/3 colour measurements/);
  });
});
