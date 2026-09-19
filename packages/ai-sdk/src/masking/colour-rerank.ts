/**
 * Colour-aware re-ranking of mask candidates (AM2.5; plan 11 "SigLIP text-image re-ranking").
 *
 * "The red car" with two cars on screen is a question the detector cannot answer: both are
 * `car`. The Visual Embed pack can — if it is shown each car's crop. This module is the pure half
 * of that: which candidates to show it, which sentences to embed, and how the similarities become
 * the resolver's `rerank` evidence. The host (`apps/desktop/electron/ai/crop-reranker.ts`) runs the
 * pack; everything that decides is here, where it is tested without a model.
 *
 * The rules that keep it from guessing:
 *
 * - **It re-ranks, it never finds.** Only candidates the detector already classed as something the
 *   noun can mean are scored. An unclassed or wrong-class candidate is never shown to SigLIP, so a
 *   high similarity cannot turn a dog into "the red car".
 * - **The colour is a classification, not a similarity.** Each crop is classified against the same
 *   noun in every colour of {@link COLOUR_WORDS} (softmax at the pack's label temperature). A blue
 *   car and a grey car asked about as "the red car" both score low, and the resolver asks — a raw
 *   "closest to red" would have picked one of them.
 * - **The evidence is head to head** (AM2.6): the named colour's share against the crop's
 *   strongest OTHER colour, `named / (named + rival)`. Above 0.5 means the crop is more that colour
 *   than anything else. SigLIP spreads a crop's mass over neighbouring words (a white car on grass
 *   is 0.5 white, 0.3 green), so the raw share asked about crops it had plainly classified.
 * - **Achromatic words guard each other.** White, grey, silver and black are one lightness scale:
 *   on real weights every silver crop peaked on white or grey, and grey crops put up to 0.2 on
 *   silver. A crop asked about as one of them that holds {@link ACHROMATIC_RIVAL_SHARE} or more on
 *   another is undecided, and so is a crop whose named colour is not strictly ahead: its evidence
 *   stays just under the resolver's floor, so it blocks a rival but is never picked.
 * - **Only colour.** A request whose other descriptive words the crop cannot be classified on
 *   ("the shiny car", "the car that just parked") gets no plan: the resolver asks.
 * - **Two signals must agree (AM2.7).** When the host also measured each crop's colour
 *   (`colour-measure.ts`), a candidate is picked only when SigLIP and the measurement both say it
 *   is clearly the one ({@link agreedColourPick}); otherwise every candidate is held under the
 *   floor and the resolver asks. For a chromatic colour SigLIP decides and the measurement must
 *   confirm the crop is chromatic at all. For white, grey, silver and black the measurement
 *   decides — one crop in that lightness class, none in a band next to it — and SigLIP must
 *   confirm the crop is neutral and no more than one step away on the black-grey-silver-white
 *   scale, and must not name the colour for a rival while not naming it for the pick.
 *
 * **Measured** on real SigLIP 2 crops (`workers/visual-embed/tools/colour_rerank_eval.py`,
 * `reports/ai-masking/colour-rerank.json`): SigLIP alone made no confident-wrong pick but
 * resolved only 80.6% of colour targets (15 of 43 neutral ones); with the measurement every
 * target of the calibration and held-out sets resolves and none is wrong.
 */
import {
  measuredColour,
  measuredNeutralPick,
  NEUTRAL_SCALE,
  type CropColourMeasurement,
  type MeasuredColour,
  type NeutralColour,
} from './colour-measure.js';
import type { MaskCandidate } from './contracts.js';
import {
  RERANK_MARGIN_RATIO,
  RERANK_MIN_GROUNDING,
  colourOf,
  parseTargetRequest,
} from './target-resolution.js';
import { COLOUR_WORDS, GENERIC_OBJECT_WORDS, singularObjectWord } from './target-vocabulary.js';

/** The palette a colour request is classified against, re-exported for hosts and harnesses. */
export { COLOUR_WORDS } from './target-vocabulary.js';

/** Softmax temperature over the colour prompts: the Visual Embed pack's label temperature. */
export const COLOUR_RERANK_TEMPERATURE = 0.01;
/** Most crops one re-rank embeds: the protocol's per-request shot bound. */
export const MAX_RERANK_CROPS = 64;
/** The lightness scale SigLIP splits a pale or dark crop along (AM2.6). */
export const ACHROMATIC_COLOURS: ReadonlySet<string> = new Set([
  'white',
  'grey',
  'silver',
  'black',
]);
/** An achromatic crop holding this share on another achromatic word is undecided (AM2.6). */
export const ACHROMATIC_RIVAL_SHARE = 0.1;
/** Evidence for an undecided crop: just under the resolver's floor, never picked. */
const UNDECIDED_EVIDENCE = RERANK_MIN_GROUNDING - 1e-6;

/** What to show the Visual Embed pack for one request, or why nothing is shown. */
export interface ColourRerankPlan {
  /** The canonical colour the editor named. */
  readonly colour: string;
  /** One sentence per {@link COLOUR_WORDS} entry, in that order, naming the same noun. */
  readonly prompts: readonly string[];
  /** Index of {@link ColourRerankPlan.colour} in `prompts`. */
  readonly colourIndex: number;
  /** The candidates to crop and score: already filtered by class, never added to. */
  readonly candidates: readonly MaskCandidate[];
}

/**
 * Plan a colour re-rank for a request, or return `undefined` when one cannot help.
 *
 * `undefined` means "no evidence": not an object request; no class set; descriptive words that
 * are not exactly one colour; or fewer than two candidates of the class (one needs no re-rank —
 * the detector already vouched for its class — and none has nothing to rank).
 *
 * @param description - The editor's target phrase, as `find_mask_targets` received it.
 * @param candidates - Plain (not pick-required) candidates, as `rankCandidates` listed them.
 */
export function colourRerankPlan(
  description: string,
  candidates: readonly MaskCandidate[],
): ColourRerankPlan | undefined {
  const request = parseTargetRequest(description);
  if (request.targetClass !== 'object' || request.objectClasses === undefined) return undefined;
  if (request.noun === undefined || request.appearance.length === 0) return undefined;
  const colours = new Set(request.appearance.map(colourOf));
  if (colours.size !== 1 || colours.has(undefined)) return undefined;
  const colour = [...colours][0]!;
  const wanted = request.objectClasses;
  const eligible = candidates.filter(
    (candidate) =>
      candidate.label === 'object' &&
      candidate.objectClass !== undefined &&
      wanted.has(candidate.objectClass),
  );
  if (eligible.length < 2 || eligible.length > MAX_RERANK_CROPS) return undefined;
  const noun = promptNoun(request.noun);
  return {
    colour,
    prompts: COLOUR_WORDS.map((each) => `a photo of a ${each} ${noun}`),
    colourIndex: COLOUR_WORDS.indexOf(colour),
    candidates: eligible,
  };
}

/** The noun as a prompt names it: singular, and "object" for the generic words. */
function promptNoun(noun: string): string {
  if (GENERIC_OBJECT_WORDS.has(noun)) return 'object';
  return singularObjectWord(noun) ?? noun;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `Cannot compare a ${String(left.length)}-d crop vector with a ${String(right.length)}-d prompt vector.`,
    );
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

/** One crop's colour classification: a softmax over the palette prompts. */
function colourDistribution(
  crop: readonly number[],
  prompts: readonly (readonly number[])[],
): number[] {
  const logits = prompts.map((prompt) => cosine(crop, prompt) / COLOUR_RERANK_TEMPERATURE);
  const peak = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - peak));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

/**
 * How strongly one crop is the named colour: head to head against its strongest other colour,
 * held under the resolver's floor when undecided (see the module notes).
 *
 * @param distribution - The crop's classification over {@link COLOUR_WORDS}, in that order.
 * @param at - Index of the named colour.
 */
export function colourEvidence(distribution: readonly number[], at: number): number {
  const named = distribution[at]!;
  let rival = 0;
  let achromaticRival = 0;
  distribution.forEach((share, index) => {
    if (index === at) return;
    rival = Math.max(rival, share);
    if (ACHROMATIC_COLOURS.has(COLOUR_WORDS[index]!)) {
      achromaticRival = Math.max(achromaticRival, share);
    }
  });
  const headToHead = named + rival === 0 ? 0 : named / (named + rival);
  const undecided =
    named <= rival ||
    (ACHROMATIC_COLOURS.has(COLOUR_WORDS[at]!) && achromaticRival >= ACHROMATIC_RIVAL_SHARE);
  return undecided ? Math.min(headToHead, UNDECIDED_EVIDENCE) : headToHead;
}

/** Whether SigLIP's own top colour for a crop is achromatic and within one step of `colour`. */
function siglipNeutralAgrees(distribution: readonly number[], colour: NeutralColour): boolean {
  const top = topColour(distribution);
  const at = NEUTRAL_SCALE.indexOf(top as NeutralColour);
  return at >= 0 && Math.abs(at - NEUTRAL_SCALE.indexOf(colour)) <= 1;
}

function topColour(distribution: readonly number[]): string {
  let best = 0;
  distribution.forEach((share, index) => {
    if (share > distribution[best]!) best = index;
  });
  return COLOUR_WORDS[best]!;
}

/** The resolver's rule on SigLIP evidence alone: the top candidate if decisive, else none. */
function decisiveIndex(evidence: readonly number[]): number | undefined {
  const order = evidence.map((_score, index) => index).sort((a, b) => evidence[b]! - evidence[a]!);
  const [first, second] = order;
  if (first === undefined || second === undefined) return undefined;
  const top = evidence[first]!;
  return top >= RERANK_MIN_GROUNDING && top >= evidence[second]! * RERANK_MARGIN_RATIO
    ? first
    : undefined;
}

/**
 * The candidate SigLIP and the measurement agree is clearly the named colour, or `undefined`.
 *
 * @param colour - The canonical colour the editor named.
 * @param distributions - Each crop's SigLIP classification over {@link COLOUR_WORDS}.
 * @param evidence - Each crop's {@link colourEvidence} for `colour`.
 * @param classes - Each crop's {@link measuredColour}.
 * @returns The index of the agreed candidate, in candidate order.
 */
export function agreedColourPick(
  colour: string,
  distributions: readonly (readonly number[])[],
  evidence: readonly number[],
  classes: readonly MeasuredColour[],
): number | undefined {
  if (!ACHROMATIC_COLOURS.has(colour)) {
    const pick = decisiveIndex(evidence);
    return pick !== undefined && classes[pick] === 'chromatic' ? pick : undefined;
  }
  const neutral = colour as NeutralColour;
  const pick = measuredNeutralPick(neutral, classes);
  if (pick === undefined || !siglipNeutralAgrees(distributions[pick]!, neutral)) return undefined;
  const namesRival = distributions.some(
    (distribution, index) => index !== pick && topColour(distribution) === colour,
  );
  return namesRival && topColour(distributions[pick]!) !== colour ? undefined : pick;
}

/**
 * Evidence that makes the resolver take exactly the agreed decision: the pick at or above the
 * floor and every other candidate below both the floor and the margin; with no pick, everyone
 * held under the floor, so the resolver asks.
 */
function agreedEvidence(evidence: readonly number[], pick: number | undefined): number[] {
  if (pick === undefined) return evidence.map((score) => Math.min(score, UNDECIDED_EVIDENCE));
  const picked = Math.max(evidence[pick]!, RERANK_MIN_GROUNDING);
  const ceiling = Math.min(UNDECIDED_EVIDENCE, picked / RERANK_MARGIN_RATIO);
  return evidence.map((score, index) => (index === pick ? picked : Math.min(score, ceiling)));
}

/**
 * Turn the pack's vectors into the resolver's `rerank` evidence: candidate id →
 * {@link colourEvidence} of its crop's colour classification, in 0..1.
 *
 * With `measurements` (AM2.7) the evidence encodes {@link agreedColourPick}: the resolver picks
 * the agreed candidate, or asks. Without them it is SigLIP's alone (the AM2.6 behaviour, used
 * when the engine could not measure).
 *
 * @param plan - The plan the vectors answer.
 * @param cropVectors - One image vector per `plan.candidates` entry, in that order.
 * @param promptVectors - One text vector per `plan.prompts` entry, in that order.
 * @param measurements - One engine measurement per candidate (`undefined` where a crop was too
 *   small to measure), in that order.
 * @throws Error when a count or a dimension disagrees: two spaces are never compared.
 */
export function colourRerankScores(
  plan: ColourRerankPlan,
  cropVectors: readonly (readonly number[])[],
  promptVectors: readonly (readonly number[])[],
  measurements?: readonly (CropColourMeasurement | undefined)[],
): ReadonlyMap<string, number> {
  if (cropVectors.length !== plan.candidates.length) {
    throw new Error(
      `Expected ${String(plan.candidates.length)} crop vectors, got ${String(cropVectors.length)}.`,
    );
  }
  if (promptVectors.length !== plan.prompts.length) {
    throw new Error(
      `Expected ${String(plan.prompts.length)} prompt vectors, got ${String(promptVectors.length)}.`,
    );
  }
  if (measurements !== undefined && measurements.length !== plan.candidates.length) {
    throw new Error(
      `Expected ${String(plan.candidates.length)} colour measurements, got ${String(measurements.length)}.`,
    );
  }
  const distributions = cropVectors.map((crop) => colourDistribution(crop, promptVectors));
  const evidence = distributions.map((distribution) =>
    colourEvidence(distribution, plan.colourIndex),
  );
  const scores =
    measurements === undefined
      ? evidence
      : agreedEvidence(
          evidence,
          agreedColourPick(plan.colour, distributions, evidence, measurements.map(measuredColour)),
        );
  return new Map(
    plan.candidates.map((candidate, index) => [candidate.candidateId, scores[index]!]),
  );
}
