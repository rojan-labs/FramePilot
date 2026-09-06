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
 * The stable, machine-readable identity of a refusal — what the rule IS, with none
 * of the sentence's particulars in it.
 *
 * ## Why the sentence cannot be the identity
 *
 * The run's proven-refusal guard (`orchestrator.ts#deterministicFailureKey`) keys run
 * memory on the failure text, so two refusals read as one only when they read the same.
 * A validator rejection does: its message is a schema fact. A POLICY refusal does not —
 * the picture-over-picture sentence names the asset, both times and the conflicting clip,
 * so in run `369e8c82` four refusals of the same rule produced four keys:
 *
 *     "Video_10374888….mp4" at 4.48–6s would sit on top of clip__v_main_…_0 …
 *     "Video_10374888….mp4" at 4.2–6s   would sit on top of clip__v_main_…_0 …
 *     "Video_10374888….mp4" at 4.2–6.2s would sit on top of clip__v_main_…_0 …
 *     "Video_5495901….mp4"  at 32.6–35.8s would sit on top of clip__v_main_…__split_4400 …
 *
 * Nothing matched, nothing was refused as a repeat, and roughly fifteen minutes of a
 * sixty-eight minute run went into the loop. Stripping prose the way `failureCause`
 * strips a validator's operation locator cannot help here: the varying parts ARE the
 * sentence. So the rule says its own name, once, and the sentence stays free to be as
 * specific as the editor needs.
 *
 * Add a member only when a refusal needs run-memory identity of its own. A refusal with
 * no cause keys on its text exactly as it always has.
 */
export type RefusalCause =
  | 'picture_over_picture'
  /**
   * The placement is a legal full-frame cutaway, and it would swallow another cutaway
   * whole — every frame of a clip that is on the timeline to be seen.
   *
   * ADR 0169 lifts a full-frame placement onto a layer in FRONT of the picture it covers,
   * which is exactly right when what it covers is the base A-roll: that is what a cutaway
   * IS. It is not right when the thing underneath is itself a cutaway with nothing behind
   * it left showing. Run `137d8fd0` lifted thirteen times at t=0 for a sixty-second
   * highlight and finished with 37 of its 48 picture clips never visible, every one of
   * those lifts reported as `completed`.
   *
   * Deliberately NOT in {@link ARRANGEMENT_INDEPENDENT_CAUSES}: removing or moving the
   * buried clip changes the answer, so a landed edit must clear the memory of it.
   */
  | 'hides_a_cutaway'
  /**
   * The tool has no implementation on this surface — `planSidecarCall` routes it
   * nowhere and no host override claims it. `render_preview` and `export_video` on the
   * sidecar executor are the standing cases: the editor renders through its own Export
   * dialog, and no argument the model can send changes that.
   *
   * Named rather than left to key on its text because the run has to be able to refuse
   * the SECOND call. The sentence is constant, so text keying would have matched — but
   * only `deterministicFailure` opts a host outcome into being remembered at all, and a
   * host failure that merely happened (a sidecar restart, a timeout) must never be. This
   * is the narrow other kind: a verdict about the surface, not an event on it. Run
   * `137d8fd0` called `render_preview` three times and `export_video` once, each time
   * reading "Do not call it again", and nothing enforced it.
   */
  | 'surface_unavailable';

/**
 * Refusal causes that are verdicts about the SURFACE, not about the arrangement — so no
 * edit the run makes can change the answer, and the run's memory of the refusal must
 * survive an applied patch.
 *
 * WHY this distinction has to be explicit. `ConductorState.seenFailureKeys` is cleared on
 * every landed edit, and for a validator refusal that is exactly right: "clips overlap at
 * 3s" describes the arrangement the validator was shown, and the patch just replaced it.
 * `surface_unavailable` describes the runtime — `render_preview` has no route on this
 * surface and never will, whatever the timeline says — and clearing it handed the model a
 * clean slate for a refusal it had already been given. Run 6 of 2026-09-05 (from
 * `framepilot.runs.jsonl`) called `render_preview` EIGHT times in 86 minutes, was refused
 * identically each time, and never once saw "already failed this run": between every
 * consecutive pair there were 3–69 completed mutations, each of which wiped the key. The
 * guard built for this in `1bd2f87` could not fire on any run that edits.
 *
 * `picture_over_picture` is deliberately NOT here: it is a verdict about where a clip
 * would land, and the next patch can move what it would have covered.
 */
export const ARRANGEMENT_INDEPENDENT_CAUSES: ReadonlySet<RefusalCause> = new Set<RefusalCause>([
  'surface_unavailable',
]);

/**
 * Does this `name:cause` failure key describe something an applied edit cannot change?
 * Keys are `${toolName}:${cause}` for a declared refusal (`deterministicFailureKey`), so the
 * cause is the last segment; a text-keyed refusal never matches.
 */
export function survivesAppliedEdit(failureKey: string): boolean {
  const cause = failureKey.slice(failureKey.lastIndexOf(':') + 1);
  return ARRANGEMENT_INDEPENDENT_CAUSES.has(cause as RefusalCause);
}

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
 * @param options.refusalCause - Which rule said no, for run memory. See
 *   {@link RefusalCause}. Absent ⇒ the refusal is remembered by its text.
 */
export class ToolRefusalError extends Error {
  /** Which rule refused, when the rule has a name. See {@link RefusalCause}. */
  public readonly refusalCause?: RefusalCause;

  public constructor(message: string, options?: { cause?: unknown; refusalCause?: RefusalCause }) {
    super(message, options);
    this.name = 'ToolRefusalError';
    if (options?.refusalCause) this.refusalCause = options.refusalCause;
  }
}
