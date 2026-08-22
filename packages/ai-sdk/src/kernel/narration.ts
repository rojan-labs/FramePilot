/**
 * @framepilot/ai-sdk/kernel/narration — the boundary between the run's internal control
 * state and the prose a video editor actually reads.
 *
 * ## Why this exists
 *
 * The agent contract hands the model a RUN STATE briefing (kernel/briefing.ts): the stage
 * it is at, what is established, what to do now. That briefing is load-bearing — without it
 * a resumed run re-derives everything it already knew. But it is also written in the second
 * person and in the imperative ("You are at 'interpret'. Continue from here."), and a model
 * asked to continue a run will, unprompted, open its reply by narrating that it is doing so:
 *
 *     "I'll continue from the interpret stage. The user wants enhanced captions…"
 *     "I'll continue from where the run left off. The track style is applied…"
 *
 * That sentence is harness-internal. An editor did not ask for a status report on the
 * orchestrator's state machine; they asked for captions. Worse, the same string is the run's
 * ONLY text channel — it becomes the patch `reason` and the proposed-edit `summary` too — so
 * the leak is persisted into the edit history and shown again on every review of that patch.
 *
 * ## Two layers, and why both
 *
 * The real fix is the contract: {@link buildStateBriefing} now states outright that the
 * briefing is private and must never be described, and the agent contract carries a
 * NARRATION rule saying the reply text is product copy about the video. That is what stops
 * the model producing the sentence at all.
 *
 * This module is the second layer: the kernel's own guarantee that even if a model ignores
 * the contract — or a future prompt edit weakens it — the sentence does not reach the user.
 * It is deliberately narrow. It strips only *leading* sentences (a preamble; harness talk in
 * the middle of a real answer is a different failure and is not silently rewritten), it
 * requires a harness reference rather than merely a continuation verb (so "I'll continue the
 * sequence with the wide shot" survives untouched), and it never empties a message.
 *
 * Streaming matters here: assistant text reaches the UI as token deltas, so a filter that
 * only ran on the settled text would let the preamble render and then snap away. The
 * streaming filter holds back at most {@link PREAMBLE_BUDGET} characters — one sentence's
 * worth — decides, and then passes everything through untouched for the rest of the message.
 */

/** How much leading text may be held back while deciding whether it is a preamble. */
const PREAMBLE_BUDGET = 400;

/** At most this many leading sentences can be stripped from one message. */
const MAX_STRIPPED_SENTENCES = 2;

/**
 * Naming the run's own machinery is a leak on its own terms — there is no sentence about
 * the "run state briefing" or an `[ev_3]` handle that an editor benefits from reading.
 */
const RUN_MACHINERY =
  /\b(?:run state|state briefing|the briefing|action log|evidence handle|ev_\d+|harness|reducer|orchestrat\w*)\b/i;

/** Opening a reply by announcing that the run is being carried on. */
const CONTINUATION =
  /\b(?:continu\w+|resum\w+|pick(?:ing|ed)?\s+up|carry(?:ing)?\s+on|proceed\w*|left\s+off|restart\w*)\b/i;

/**
 * A reference to the run itself rather than to the video — the half that turns a
 * continuation verb into harness chatter. "Continue the sequence" is editing; "continue the
 * run" is the state machine talking.
 */
const RUN_REFERENCE = /\b(?:this|the)\s+run\b|\b(?:previous|prior|last)\s+turn\b|\bturn\s+\d+\b/i;

/**
 * The reducer's stage names, in the grammatical position the leak actually uses ("from the
 * interpret stage", "from analyze"). Matching the bare word anywhere would misfire on real
 * editing prose — "apply", "review" and "complete" are ordinary editing verbs.
 */
const STAGE_REFERENCE =
  /\b(?:from|at|in)\s+(?:the\s+)?(?:interpret|analyz\w*|analys\w*|plan|apply|verify|review|complete|gather|execute)\b(?:\s+stage)?/i;

/** Where the run stopped, as a place to resume from. */
const LEFT_OFF = /\bwhere\s+(?:the\s+run|we|i|it)\s+(?:left\s+off|stopped|got\s+to)\b/i;

/**
 * Is this one sentence a report on the run rather than on the edit?
 *
 * Requires a harness *referent*, never a bare verb: continuation words are ordinary editing
 * vocabulary, and stripping them on sight would delete real sentences about continuing a
 * sequence, a look, or a motif.
 */
function isRunChatter(sentence: string): boolean {
  if (RUN_MACHINERY.test(sentence)) return true;
  if (!CONTINUATION.test(sentence)) return false;
  return RUN_REFERENCE.test(sentence) || STAGE_REFERENCE.test(sentence) || LEFT_OFF.test(sentence);
}

/**
 * Split leading text into its first sentence and the rest.
 *
 * Returns `undefined` when no terminator has arrived yet, which is how the streaming filter
 * knows it does not have enough to judge. A newline ends a sentence too: models routinely
 * write the preamble as its own line with no full stop.
 */
function firstSentence(text: string): { sentence: string; rest: string } | undefined {
  const match = /[.!?](?=\s|$)|\n/.exec(text);
  if (!match) return undefined;
  const end = match.index + match[0].length;
  return { sentence: text.slice(0, end), rest: text.slice(end) };
}

/**
 * Remove harness-internal preamble sentences from a settled assistant message.
 *
 * Never returns an empty string for a non-empty input: a message that is *entirely* run
 * chatter is a different (and louder) failure than a leaked preamble, and silently deleting
 * it would leave the editor staring at a blank reply with no way to tell what happened. It
 * is returned as-is so the contract-level regression tests can see it.
 */
export function stripRunNarration(text: string): string {
  let remaining = text.trimStart();
  let stripped = 0;
  while (stripped < MAX_STRIPPED_SENTENCES) {
    const split = firstSentence(remaining);
    if (!split || !isRunChatter(split.sentence)) break;
    const rest = split.rest.trimStart();
    // Everything left is this preamble — keep the original rather than emit nothing.
    if (rest === '') return text;
    remaining = rest;
    stripped += 1;
  }
  return stripped === 0 ? text : remaining;
}

/** A streaming narration filter: hold the preamble, judge it, then get out of the way. */
export interface NarrationFilter {
  /** Feed one raw text delta; returns the text that is safe to surface now (may be ''). */
  push(chunk: string): string;
  /** End of stream: returns whatever is still held (may be ''). */
  flush(): string;
}

/**
 * Create a filter that suppresses a leading run-chatter preamble as it streams.
 *
 * Once the preamble question is settled — either a sentence was judged, or
 * {@link PREAMBLE_BUDGET} characters arrived without one — the filter becomes a pass-through
 * for the remainder of the message. The budget is what keeps a model that streams one very
 * long sentence from being held back indefinitely.
 */
export function createNarrationFilter(): NarrationFilter {
  let held = '';
  let open = true;
  let stripped = 0;

  /** Judge as many complete leading sentences as `held` currently contains. */
  const drain = (): string => {
    let out = '';
    for (;;) {
      if (stripped >= MAX_STRIPPED_SENTENCES) {
        open = false;
        out += held;
        held = '';
        return out;
      }
      const split = firstSentence(held);
      if (!split) {
        // No terminator yet. Release only once the budget is spent, so an unusually long
        // first sentence cannot stall the stream.
        if (held.length < PREAMBLE_BUDGET) return out;
        open = false;
        out += held;
        held = '';
        return out;
      }
      if (!isRunChatter(split.sentence)) {
        open = false;
        out += held;
        held = '';
        return out;
      }
      // Drop it, and keep judging: a second preamble sentence can follow the first. The
      // whitespace that separated the two sentences goes with the one being dropped, so a
      // suppressed preamble never leaves the message opening on a space or a blank line.
      stripped += 1;
      held = split.rest.trimStart();
    }
  };

  return {
    push(chunk: string): string {
      if (!open) return chunk;
      held += chunk;
      return drain();
    },
    flush(): string {
      if (!open) return '';
      // Stream ended while still deciding. Anything held is an incomplete sentence the
      // judge never got to rule on, so it is released rather than swallowed — unless it is
      // itself unmistakable run chatter with no terminator.
      const rest = held;
      held = '';
      open = false;
      return stripped > 0 && isRunChatter(rest) ? '' : rest;
    },
  };
}
