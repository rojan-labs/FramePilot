/**
 * @framepilot/ai-sdk/kernel/continuation — what a run is actually being asked to do when
 * the editor types "continue".
 *
 * ## Why this exists
 *
 * A run's objective is seeded from `input.userPrompt` (see `onCommand`), and that seed
 * becomes the acceptance criterion, the committed decision, and the criterion verification
 * reports against. When the editor's whole message is "contine", every one of those became
 * the literal string "contine": the run's durable memory of WHY it was working was the
 * filler word that asked it to keep working, and verification could only report
 * inconclusive because there was nothing in the criterion to check.
 *
 * The referent is not missing — it is the previous request, which the conversation history
 * already carries. Resolving it here keeps the objective machinery honest without asking
 * the model to re-state its goal, and without treating a nudge as a new goal.
 *
 * Deliberately deterministic: no model call, no fuzzy intent classification. A short
 * utterance made ENTIRELY of continuation and filler words is a nudge; anything carrying
 * its own content is a new request and is left exactly as typed.
 */
import type { AiMessage } from '../providers/types.js';

/**
 * Words that only ever mean "keep going with what we were doing". Kept separate from
 * {@link FILLER_WORDS} so a message must contain at least one of THESE to count as a
 * nudge — a message of pure filler ("ok then") is not an instruction to resume.
 */
const CONTINUATION_WORDS: readonly string[] = [
  'carry',
  'continue',
  'finish',
  'go',
  'keep',
  'more',
  'next',
  'onward',
  'proceed',
  'resume',
];

/**
 * Words that may accompany a nudge without adding a request to it. "it"/"that" are here
 * because "continue it" and "finish that" name the same prior work — resolving that
 * referent is the entire point of this module.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'ahead',
  'along',
  'and',
  'do',
  // "continue from here" is the phrase the editor of captured run `e36235cc` typed twice.
  // Without these it tokenized to [continue, from, here], `from` fell outside the
  // vocabulary, and a three-word nudge was recorded as a brand-new request — which threw
  // away the 50-clip brief it was nudging, criteria and all, and left verification with
  // nothing to check.
  'from',
  'going',
  'here',
  'it',
  'just',
  'now',
  'off',
  'ok',
  'okay',
  'on',
  'please',
  'pls',
  'that',
  'the',
  'then',
  'this',
  'thx',
  'yes',
  'yep',
]);

/** Longest utterance still considered a nudge, in words. Beyond this it carries content. */
const MAX_NUDGE_WORDS = 4;

/** Shortest token worth spell-checking; below it, edit distance is mostly noise. */
const MIN_FUZZY_LENGTH = 5;

/** Split an utterance into comparable lowercase word tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Levenshtein distance, capped: returns `limit + 1` as soon as it is provably exceeded.
 *
 * WHY spell-tolerance at all: the message that produced this whole class of failure was
 * "contine". A run that loses its objective to a one-character typo is a run whose memory
 * depends on the editor's keyboard, and "typed it wrong" is not a different request.
 */
function withinDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  // Single row rolled in place: these are short words, and the full matrix buys nothing.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    // Every path through the remaining rows can only add cost, so a row whose cheapest
    // cell already exceeds the limit ends it.
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return (previous[b.length] as number) <= limit;
}

/** Is this token a continuation word, allowing one typo in a long enough one? */
function isContinuationWord(token: string): boolean {
  return CONTINUATION_WORDS.some(
    (word) =>
      word === token ||
      (token.length >= MIN_FUZZY_LENGTH &&
        word.length >= MIN_FUZZY_LENGTH &&
        withinDistance(token, word, 1)),
  );
}

/**
 * True when `text` asks only to keep going, and so names no work of its own.
 *
 * Requires at least one continuation word and nothing outside the continuation/filler
 * vocabulary, so "continue but make it shorter" is correctly a NEW request: it carries
 * content, and overwriting it with the previous objective would lose what was asked.
 */
export function isBareContinuation(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > MAX_NUDGE_WORDS) return false;
  let sawContinuation = false;
  for (const token of tokens) {
    if (isContinuationWord(token)) {
      sawContinuation = true;
      continue;
    }
    if (!FILLER_WORDS.has(token)) return false;
  }
  return sawContinuation;
}

/**
 * The text a run's objective should be recorded from: the prompt itself, or — when the
 * prompt is a bare nudge — the most recent user message that actually asked for something.
 *
 * Falls back to the prompt when history holds nothing substantive: a nudge with no
 * resolvable referent is still the only thing the editor said, and recording it beats
 * recording an empty objective, which the stage guards treat as a broken run.
 */
export function deriveObjectiveText(userPrompt: string, history?: readonly AiMessage[]): string {
  const prompt = userPrompt.trim();
  if (!isBareContinuation(prompt)) return prompt;
  for (let i = (history?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = history?.[i];
    if (!message || message.role !== 'user') continue;
    const content = message.content.trim();
    // Skip earlier nudges too: three "continue"s in a row must still resolve to the
    // request underneath them, not to the first nudge.
    if (content.length === 0 || isBareContinuation(content)) continue;
    return content;
  }
  return prompt;
}
