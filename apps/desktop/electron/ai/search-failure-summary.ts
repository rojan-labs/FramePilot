/**
 * The sentence a failed agent search reports back to the model.
 *
 * ## Why this is a module and not a closure in `main.ts`
 *
 * It exists to close a hole that only shows up where two correct decisions meet.
 *
 * `musicErrorMessage`/`stockErrorMessage` deliberately render `cancelled` as the empty
 * string — a person who pressed Stop does not need to be told what they just did, and the
 * Sounds and Stock panels treat `''` as "return to idle silently". That is right for a
 * panel and wrong for a MODEL: an empty summary reaches the agent loop as a tool card with
 * a red cross and no reason, and as a blank line in the action log the run reads back next
 * turn. The only move left to a model told "this failed, no reason given" is to ask the
 * same question again.
 *
 * Run `f014f3ac` did exactly that. Fifteen of its twenty-one stock searches came back
 * `cancelled` (the panel's supersede rule aborting the agent's own parallel batch — fixed
 * separately in `stock-service.ts`), every one of them silent, and the run re-issued
 * "eagle flying mountain" three times before giving up on footage altogether.
 *
 * Fixing the cancellation removes today's cause. This removes the whole CLASS: any code
 * whose sentence is empty now reaches the model as something it can act on. A harness that
 * tells a model nothing is a harness that gets asked again.
 */

/**
 * @param tool - The tool name as the model knows it (`search_stock`, `search_music`).
 * @param message - The provider vocabulary's sentence, which may be empty.
 * @param code - The wire error code, included so the run's log carries the real cause even
 *   when there is no sentence for it.
 * @returns `message` when it says something; otherwise a sentence that names the tool, the
 *   code, and the fact that retrying is legitimate.
 */
export function agentSearchFailureSummary(tool: string, message: string, code: string): string {
  if (message !== '') return message;
  return `${tool} did not complete (${code}) — nothing was searched. Try it again.`;
}
