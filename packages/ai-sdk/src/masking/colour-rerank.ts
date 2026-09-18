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
 * - **The colour is a classification, not a similarity.** Each crop is scored against the same noun
 *   in every colour of {@link COLOUR_WORDS} and the named colour's softmax share is its score. A
 *   blue car and a grey car asked about as "the red car" both score low, and the resolver asks —
 *   a raw "closest to red" would have picked one of them.
 * - **Only colour.** A request whose other descriptive words the crop cannot be classified on
 *   ("the shiny car", "the car that just parked") gets no plan: the resolver asks.
 *
 * **Unmeasured calibration.** The temperature is the pack's own zero-shot label temperature
 * (`workers/visual-embed/.../policy.py` `LABEL_TEMPERATURE`, 0.01), not a value measured on crops.
 * The resolver's margin (winner ≥ 0.5 and ≥ 1.25× the runner-up) is what stands between a weak
 * separation and a pick; no accuracy on real footage is claimed.
 */
import type { MaskCandidate } from './contracts.js';
import { colourOf, parseTargetRequest } from './target-resolution.js';
import { COLOUR_WORDS, GENERIC_OBJECT_WORDS, singularObjectWord } from './target-vocabulary.js';

/** The palette a colour request is classified against, re-exported for hosts and harnesses. */
export { COLOUR_WORDS } from './target-vocabulary.js';

/** Softmax temperature over the colour prompts: the Visual Embed pack's label temperature. */
export const COLOUR_RERANK_TEMPERATURE = 0.01;
/** Most crops one re-rank embeds: the protocol's per-request shot bound. */
export const MAX_RERANK_CROPS = 64;

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

/** The named colour's softmax share among the palette, for one crop. */
function colourShare(
  crop: readonly number[],
  prompts: readonly (readonly number[])[],
  at: number,
): number {
  const logits = prompts.map((prompt) => cosine(crop, prompt) / COLOUR_RERANK_TEMPERATURE);
  const peak = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - peak));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights[at]! / total;
}

/**
 * Turn the pack's vectors into the resolver's `rerank` evidence: candidate id → the share of its
 * crop's colour classification that the named colour gets, in 0..1.
 *
 * @param plan - The plan the vectors answer.
 * @param cropVectors - One image vector per `plan.candidates` entry, in that order.
 * @param promptVectors - One text vector per `plan.prompts` entry, in that order.
 * @throws Error when a count or a dimension disagrees: two spaces are never compared.
 */
export function colourRerankScores(
  plan: ColourRerankPlan,
  cropVectors: readonly (readonly number[])[],
  promptVectors: readonly (readonly number[])[],
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
  return new Map(
    plan.candidates.map((candidate, index) => [
      candidate.candidateId,
      colourShare(cropVectors[index]!, promptVectors, plan.colourIndex),
    ]),
  );
}
