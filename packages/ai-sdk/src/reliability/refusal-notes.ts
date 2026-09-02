/**
 * @framepilot/ai-sdk/reliability/refusal-notes — the sentences a run hands the model when
 * a call it made cannot produce the edit it asked for.
 *
 * goal.md Workstream C: "Errors are prompts too. Every failure returned to the model must
 * say what was wrong and what a valid next action looks like. Dead-end errors cause loops."
 *
 * ## Why these live here and not at the seven throw sites they came from
 *
 * `sidecar-executor.ts` covers the seam where the ENGINE fails — unreachable, unreadable,
 * out of budget — and `6e39e64` gave that seam two shared producers (`unreadableEngineAnswer`,
 * `desktopOnlyCapability`) plus a gate that walks them. The seam this module covers is the
 * one AFTER that: the host answered `completed`, the orchestrator parsed what came back,
 * and the payload did not survive its schema. Seven of those refusals were written inline
 * in `orchestrator.ts`, fully literal, and every one of them stopped at the fact:
 *
 *     Rejected "add_music" — the download did not return a usable audio asset, so
 *     nothing was placed.
 *
 * True, and a dead end. Captured run `369e8c82` is the record of what a model does with a
 * fact it cannot act on: it repeats the call. Two of those sentences had also been copied
 * into `apps/desktop/electron/main.ts`, where the `hostTranscribe` override bypasses the
 * orchestrator's copy entirely — so the fix one layer down never reached the product's
 * primary surface. A shared producer is the only shape in which "say what to do instead"
 * can be true in both processes at once.
 *
 * ## The rule every sentence here follows
 *
 * The same one `VISUAL_REASON_GUIDANCE` follows, because it is the one that stopped the
 * `not_indexed` loop: say what happened, say whether retrying helps, and name what to do
 * INSTEAD — a tool the model can actually call, or an explicit close ("do not call this
 * again", "tell the editor"). Nothing here invents a capability: every tool named below is
 * asserted against the live registry by `model-facing-failure.gate.test.ts`, so a rename
 * or a removal fails the build rather than shipping advice that cannot be followed.
 *
 * Where there is honestly no move — a paid download that will not improve on a retry, a
 * pack worker measuring the same shot the same way — the sentence says so and closes the
 * call off rather than leaving the model to discover it by burning turns.
 *
 * Pure: no clock, no I/O, no registry import, so this stays at the bottom of the graph
 * beside its siblings and `apps/desktop` can import it without dragging the run loop in.
 */

/**
 * The refusal for a tool name that is not in the registry at all.
 *
 * Shared by the two paths that can meet one — `runAgentCall`'s serial dispatch and the
 * concurrent path's pre-flight — because they are one verdict, and the file's own comment
 * already said so ("this is the same verdict for the path that never reaches it") while
 * the two answered in different words. `Refused unknown tool "x"` was the shorter of the
 * two, and it is a bare token dressed as a sentence: it does not say the name is invented,
 * and it does not say not to send it again.
 *
 * @param tool - The name the model asked for, verbatim.
 */
export function unknownToolNote(tool: string): string {
  return (
    `There is no tool called "${tool}". Do not call that name again — use one of the ` +
    'tools offered on this turn; inventing a name will not make it exist on the next one.'
  );
}

/** What one unusable-payload refusal says, split so the table reads as prose. */
interface UnusablePayloadCopy {
  /** What came back and what it cost — including whether the project moved. */
  readonly what: string;
  /** Whether to retry, and the move to make instead. Names a tool, or closes the call. */
  readonly instead: string;
}

/**
 * Every tool whose host payload can arrive unusable, and the sentence for each.
 *
 * Keyed by the REGISTRY name, so the gate can check each key against the live registry:
 * a table entry for a tool that no longer exists is guidance nobody will ever read, and a
 * sentence naming a tool that no longer exists is worse than saying nothing.
 *
 * These are separate entries rather than one generic sentence because the honest INSTEAD
 * differs by what was asked. `transcribe` has a stored transcript to fall back on;
 * `add_music` has fifty other search results and a spent download quota; automatic
 * tracking has nothing but the editor to tell.
 */
const UNUSABLE_HOST_PAYLOAD: Readonly<Record<string, UnusablePayloadCopy>> = {
  transcribe: {
    what:
      'the speech-to-text provider returned no usable timed words, so the transcript ' +
      'already in the project was left untouched',
    instead:
      'Retry this call once; if it comes back the same way, do not call it again for this ' +
      'asset — read what the project already holds with get_transcript, and tell the ' +
      'editor that speech-to-text returned nothing usable for this clip.',
  },
  remove_silences: {
    what: 'the silence measurement came back in a shape FramePilot could not read, so nothing was cut',
    instead:
      'Retry this call once; if it comes back the same way, measure the same asset with ' +
      'analyze_silence to find out whether the engine can read it at all, and if that is ' +
      'unusable too, do not call either again for this asset and tell the editor the ' +
      'silence measurement failed.',
  },
  add_music: {
    what:
      'the download did not return a usable audio asset, so nothing was placed and the ' +
      'timeline is unchanged',
    instead:
      // No "retry once" here, unlike the two above: the request was already spent on a
      // metered provider, and the same track will be fetched the same way. The cheap move
      // is a different candidate from the search this run already paid for.
      'Do not retry the same track — the request was already spent and it will come back ' +
      'the same way. Pick a different result from search_music and add that one; if a ' +
      'second track fails like this, tell the editor the music download failed and move on.',
  },
  add_stock: {
    what:
      'the download did not return a usable photo or video asset, so nothing was placed ' +
      'and the timeline is unchanged',
    instead:
      'Do not retry the same asset — the request was already spent and it will come back ' +
      'the same way. Pick a different result from search_stock and add that one; if a ' +
      'second one fails like this, tell the editor the stock download failed and move on.',
  },
  track_subject_automatically: {
    what:
      'the tracking host returned a measurement FramePilot could not read, so the mask was ' +
      'not moved',
    instead:
      // Deliberately names no substitute. The manual path authors coordinates, and the
      // model is the one party that must never author them (`automatic-tracking.ts`), so
      // "keyframe it yourself" would be inventing a capability the contract forbids.
      'Do not call it again for this clip — repeating it measures the same shot the same ' +
      'way. Tell the editor that automatic tracking could not be read and that the mask is ' +
      'unchanged.',
  },
};

/**
 * The refusal for a host payload that did not survive its schema.
 *
 * @param tool - The registry name of the tool whose payload failed.
 * @returns The full note, envelope included, for use as `note`, `summary`, or both.
 * @throws When `tool` has no entry — a caller reaching for a sentence that was never
 *   written is a bug at the call site, and a generic fallback would quietly reintroduce
 *   the dead end this module exists to remove.
 */
export function unusableHostPayload(tool: string): string {
  const copy = UNUSABLE_HOST_PAYLOAD[tool];
  if (!copy) {
    throw new Error(
      `No unusable-payload guidance for "${tool}" — add an entry to UNUSABLE_HOST_PAYLOAD ` +
        'rather than writing the sentence at the call site.',
    );
  }
  // "This is not about your arguments" is `describeTransportFailure`'s clause, and it is
  // the half that stops the retry loop: without it the caller cannot tell a broken host
  // from a bad call, so its only move is to send the same call again with the numbers
  // nudged. WHAT went wrong is per-tool and stays in `what` — "could not be read" is true
  // of a payload that failed its schema and false of a provider that simply found nothing.
  return `Rejected "${tool}" — ${copy.what}. This is not about your arguments. ${copy.instead}`;
}

/**
 * Every sentence this module can produce for an unusable payload, with its tool.
 *
 * Exported so the failure-quality gate WALKS the table instead of quoting it: a list
 * copied into a test rots the day someone adds a tool, which is exactly how the
 * `map_footage` dead end survived next door to `describe_footage`'s guidance
 * (captured run `369e8c82`).
 */
export function unusableHostPayloadEntries(): readonly {
  readonly tool: string;
  readonly note: string;
}[] {
  return Object.keys(UNUSABLE_HOST_PAYLOAD).map((tool) => ({
    tool,
    note: unusableHostPayload(tool),
  }));
}

/**
 * The refusal when the host's speech-to-text provider could not run at all.
 *
 * The desktop's `transcribeTwelveLabs` is shared by the manual button and the agent, so its
 * `reason` is written for the PERSON — "Add a TwelveLabs API key in Settings → AI → Media
 * intelligence." is exactly right on a failure card and a dead end for a caller with no
 * Settings window (`next-action.ts`'s `HANDS_ONLY`). Rather than degrade the card's
 * sentence for the model's benefit, the host wraps it: the reason is passed through
 * VERBATIM, because it is the only evidence of what actually failed, and the move the
 * model can make is appended.
 *
 * The move is the same one `UNUSABLE_HOST_PAYLOAD.transcribe` names, and for the same
 * reason: a project that has been transcribed before still holds those words, and a run
 * that cannot transcribe now can still read them.
 *
 * @param reason - The provider's or host's own sentence, whatever it says.
 */
export function hostedTranscriptionUnavailable(reason: string): string {
  // The reason may be a card sentence (ends in a full stop) or a raw exception message
  // (ends in nothing). Normalizing here keeps the two halves from running together into
  // one unreadable line, which is a real cost when the whole point is that it be read.
  const said = reason.trim();
  const cause = said === '' ? 'the provider gave no reason' : said.replace(/[.!?]+$/, '');
  return (
    `Rejected "transcribe" — speech-to-text could not run: ${cause}. That is a setup or ` +
    'provider problem, not your arguments, so calling it again with different arguments ' +
    'will not change it. Read what the project already holds with get_transcript, and if ' +
    'there is nothing there, tell the editor that speech-to-text is unavailable and carry ' +
    'on without a transcript.'
  );
}

/**
 * The refusal for a tool that is registered but whose engine is not wired up.
 *
 * `Skipped "generate_mask" — not available yet` said the fact and stopped. "Yet" reads as
 * "wait and try later", which is the one thing that cannot work: `ToolSpec.available` is a
 * build-time constant, so the answer is identical on every turn of every run. Naming that
 * is what turns the second call into the last one.
 *
 * @param tool - The registry name of the unavailable tool.
 */
export function unavailableToolNote(tool: string): string {
  return (
    `Skipped "${tool}" — it is listed in your tools but its engine is not built into this ` +
    'version of FramePilot, so it will answer the same way for the rest of this run. Do ' +
    'not call it again: reach the same outcome with another tool if one exists, or tell ' +
    'the editor that FramePilot cannot do this yet.'
  );
}
