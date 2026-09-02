/**
 * @framepilot/ai-sdk/reliability/next-action — does this failure tell the MODEL what to
 * do next?
 *
 * goal.md Workstream C: "Errors are prompts too. Every failure returned to the model must
 * say what was wrong and what a valid next action looks like. Dead-end errors cause loops."
 *
 * ## Why this is not `plain-failure.ts`, and not `golden-metrics.ts#failureQuality`
 *
 * Three failure-quality properties live in this package and they are NOT the same idea:
 *
 *  - `reliability/plain-failure.ts` — can a VIDEO EDITOR act on this? (no stack traces,
 *    no wire text, plain words). Audience: the failure card.
 *  - `eval/golden-metrics.ts#failureQuality` — did the run fail LOUDLY, and does the
 *    message explain rather than leak an internal? Audience: the failure card again, and
 *    the harness scores whether the user was told anything at all.
 *  - this module — does the text name a move the MODEL can actually execute? Audience:
 *    the tool result the agent loop feeds back into the next request.
 *
 * Conflating the first two audiences with the third is a defect this codebase has already
 * paid for twice, in one captured run (`369e8c82`), which is why the historical strings
 * below are pinned as negative fixtures in `next-action.test.ts`:
 *
 *  - `"map_footage": not_indexed` — a bare machine token. Six calls over six clips, and
 *    nothing learned from any of them (fixed in `92a0387`).
 *  - `That track is already in your media bin — it was not downloaded again. Place it
 *    from the bin, or pick a different track.` — the Sounds panel's sentence. True for a
 *    person looking at a bin; the caller has no hands and no panel, so the run gave up on
 *    the request (fixed in `92a0387`).
 *
 * The second one is why this predicate has no "offers some alternative" arm: it OFFERS an
 * alternative ("or pick a different track") and is still a dead end. A move only counts
 * when the model can execute it — a tool it can call, or an instruction to stop calling
 * and say so.
 *
 * ## What "names a next action" means, as code
 *
 * BOTH halves must hold:
 *
 *  1. It said what happened — more than a bare token or a three-word fragment, once the
 *     `"tool_name":` envelope the executor wraps every outcome in is stripped off.
 *  2. It named a move the model can execute — a REGISTERED tool (checked against the live
 *     registry the caller passes in, so guidance naming a tool that does not exist fails
 *     the gate too), or an explicit closing directive ("do not call this again", "say
 *     plainly", "tell the editor").
 *
 * Pure: no clock, no I/O, no registry import (the names come in as an argument, so this
 * module stays at the bottom of the dependency graph beside its siblings).
 */

/** The verdict, with the reason spelled out — the gate prints `why` on a failure. */
export interface NextActionVerdict {
  readonly ok: boolean;
  /** Which half is missing (or that both held). Written to be read in a test failure. */
  readonly why: string;
}

/**
 * Fewer real words than this and the text cannot have said what went wrong, let alone what
 * to do. Deliberately low: rule 2 does the real work, and this only catches fragments
 * (`not_indexed`, `search response was malformed`) whose problem is obvious on sight.
 */
const MIN_WORDS = 4;

/**
 * The envelope `sidecar-executor.ts` puts on every host-tool outcome — `"map_footage":
 * …`, `"transcribe" failed: …`, `"get_frame" timed out …`. It is not part of the
 * instruction, and leaving it in would let EVERY message satisfy rule 2 by quoting its
 * own name.
 */
const TOOL_ENVELOPE = /^(?:refused\s+|rejected\s+)?"[a-z0-9_]+"\s*(?:failed)?\s*:?\s*/i;

/**
 * A tool name written in quotes is the SUBJECT of the sentence (the call that failed, an
 * asset id), never the instruction. House style writes an instruction's tool bare —
 * `look at a moment with get_frame`, `Call discover_caption_styles first`, `Place it with
 * add_clip` — so quoted identifiers are removed before rule 2 looks for one.
 */
const QUOTED_IDENTIFIER = /"[A-Za-z0-9_]+"/g;

/**
 * Explicit closes: "this will not work, here is what to do with the rest of the run."
 *
 * Every entry is an instruction addressed to the caller. "Try again later" is absent on
 * purpose — a bare invitation to retry is what a dead end already produces by default.
 */
const CLOSING_DIRECTIVE =
  /\bdo not (?:call|retry|try|run|repeat|use)\b|\bdon't (?:call|retry|try|repeat)\b|\bsay (?:plainly|so)\b|\btell the (?:editor|user)\b|\bstop and ask\b|\bcontinue without\b/i;

/**
 * Moves only a person with a mouse can make. Not a failure on their own — a message may
 * legitimately tell the model to relay one to the user — but they never satisfy rule 2,
 * and naming them in `why` is what makes a `Place it from the bin` failure legible.
 */
const HANDS_ONLY =
  /\bfrom the bin\b|\bclick\b|\bdrag\b|Settings\s*→|\bExport dialog\b|\bpanel\b|\bby hand\b/i;

/** The text as the instruction, with the executor's envelope and quoted subjects removed. */
function instructionOf(text: string): string {
  return text.replace(TOOL_ENVELOPE, '').replace(QUOTED_IDENTIFIER, ' ').trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

/** The registered tools this text tells the model to call, bare (not quoted). */
export function toolsNamedIn(text: string, toolNames: Iterable<string>): string[] {
  const instruction = instructionOf(text);
  const named: string[] = [];
  for (const name of toolNames) {
    // Word-boundary on both ends so `add_clip` does not match inside `add_clips`, and an
    // id like `music_openverse_ov_1` does not count as naming `add_music`.
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(instruction)) named.push(name);
  }
  return named;
}

/**
 * Does this model-facing failure text name a next action?
 *
 * @param text - Exactly what the model reads. For a host tool that is the outcome's
 *   `summary` plus its string `data` — the orchestrator hands the model both (it builds
 *   the log note as `summary → <digest of data>`), so judging either alone would grade a
 *   string the model never sees on its own.
 * @param toolNames - The live tool registry's names. Passed in rather than imported so a
 *   sentence naming a tool that was renamed or removed stops passing the moment it is.
 * @returns Whether both halves hold, and which one is missing when they do not.
 */
export function namesNextAction(text: string, toolNames: Iterable<string>): NextActionVerdict {
  const instruction = instructionOf(text ?? '');
  if (instruction === '')
    return { ok: false, why: 'says nothing at all once the tool name is removed' };

  const words = wordCount(instruction);
  if (words < MIN_WORDS) {
    return {
      ok: false,
      why: `is a bare token or fragment (${String(words)} word(s)): "${instruction}" — it does not say what happened`,
    };
  }

  const named = toolsNamedIn(instruction, toolNames);
  if (named.length > 0) return { ok: true, why: `names the tool(s) ${named.join(', ')}` };
  if (CLOSING_DIRECTIVE.test(instruction)) return { ok: true, why: 'closes itself off explicitly' };

  const handsOnly = HANDS_ONLY.exec(instruction);
  return {
    ok: false,
    why: handsOnly
      ? `offers only a move a person with a mouse could make ("${handsOnly[0]}") — no tool the model can call, and no "do not call this again"`
      : 'names no registered tool and does not close itself off ("do not call this again", "say plainly", "tell the editor")',
  };
}
