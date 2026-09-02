/**
 * @framepilot/ai-sdk/tool-refusal — "your arguments were fine; the answer is no".
 *
 * ## Why this is its own error, and its own module
 *
 * A mutating tool refuses for two very different reasons, and until now they
 * arrived at the model as one sentence. `operationsForCall` wraps every throw out
 * of `buildOps` as `invalid_args`, so a POLICY refusal — the picture-over-picture
 * rule of ADR 0140, a caption cue that would cross a cut — reached the model as
 * `Invalid arguments for "add_clip": Refused: …`.
 *
 * That prefix is not cosmetic. It tells the model the arguments are wrong, so it
 * fixes arguments that were already correct: it re-sends the same placement with
 * a nudged `start`, a different `trackId`, a re-read of the asset list. The
 * refusal sentence names the real move (place a cutaway; call `caption_the_edit`)
 * and the prefix argues against it.
 *
 * Throwing this instead says which kind of "no" it was. `operationsForCall`
 * re-labels it `refusal` rather than `invalid_args`, and the orchestrator writes
 * `Refused "add_clip": <sentence>` with nothing in front of the sentence. It is
 * still a {@link AgentCallOutcome.deterministicFailure}: a policy refusal is the
 * most certainly-repeatable failure there is.
 *
 * ## Why a module of its own
 *
 * `tool-dispatch.ts` imports the registry, the registry imports every domain-tool
 * family, and the families need to throw this — so putting it in either would
 * close a cycle. This file imports nothing, on purpose. Keep it that way.
 */

/**
 * A tool declining to act on arguments it understood.
 *
 * `message` is the whole model-facing sentence and is used verbatim in both
 * directions — the model reads it to pick its next move, and the editor's failure
 * card shows it unchanged. Refusals are written in plain language for exactly
 * that reason, so unlike a Zod error there is no machine-speak to translate.
 *
 * @param message - Why the tool refused, and what to do instead. One or two
 *   sentences, no schema jargon, always naming a legal next move.
 */
export class ToolRefusalError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ToolRefusalError';
  }
}
