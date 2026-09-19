import { describe, expect, it } from 'vitest';
import {
  ACHROMATIC_RIVAL_SHARE,
  COLOUR_RERANK_TEMPERATURE,
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
