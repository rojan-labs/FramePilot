/**
 * @framepilot/ai-sdk/reliability/sourcing-notes — what the MODEL is told when a music or
 * stock call fails.
 *
 * goal.md Workstream C: "Errors are prompts too. Every failure returned to the model must
 * say what was wrong and what a valid next action looks like. Dead-end errors cause loops."
 *
 * ## Why this exists beside `musicErrorMessage` / `stockErrorMessage`
 *
 * Those two are the SOUNDS and STOCK PANELS' vocabulary, written for a person looking at a
 * panel: "Add your Pexels API key in Settings to search.", "No network connection.",
 * "Too many searches in a row. Try again in a moment." Every one of them is right for that
 * reader and a dead end for the agent, which has no Settings window, no hands, and exactly
 * one move available — call something. The desktop host overrides
 * (`apps/desktop/electron/main.ts`, `ai/stock-host.ts`) forwarded the panel sentence to the
 * model verbatim, under a comment claiming it was "the provider's own reason". It is not:
 * it is our sentence, authored for the other audience. That is the same defect
 * `reliability/next-action.ts` pins as a negative fixture ("Place it from the bin…"), and
 * the same shape as the `hostTranscribe` copy fixed in `d95ec25`.
 *
 * `cancelled` makes the split unmissable. The panels render it as the EMPTY STRING on
 * purpose — a person who pressed Stop does not need to be told what they just did — and
 * the agent path forwarded that empty string as a tool failure with no reason at all. Run
 * `f014f3ac` re-issued "eagle flying mountain" three times against a blank refusal before
 * giving up on footage. A model told nothing asks again; there is no third option.
 *
 * ## The rule every sentence here follows
 *
 * The one `refusal-notes.ts` and `VISUAL_REASON_GUIDANCE` follow: say what happened, say
 * whether retrying helps, and name what to do INSTEAD — a tool the model can call, or an
 * explicit close ("do not call it again", "tell the editor"). Nothing here invents a
 * capability: every tool named below is asserted against the live registry by
 * `model-facing-failure.gate.test.ts`.
 *
 * Where retrying genuinely helps it says so ONCE and then names the close, because "try
 * again shortly" on its own is precisely what a dead end already produces.
 *
 * Pure: no clock, no I/O, no registry import, so this stays at the bottom of the graph
 * beside its siblings and `apps/desktop` can import it without dragging the run loop in.
 */
import { MUSIC_ERROR_CODES, type MusicErrorCode } from '../providers/music-types.js';
import { STOCK_ERROR_CODES, type StockErrorCode } from '../providers/stock-types.js';

/** The four registry tools whose work happens on the host's provider connection. */
export const SOURCING_TOOL_NAMES = [
  'search_music',
  'add_music',
  'search_stock',
  'add_stock',
] as const;
export type SourcingToolName = (typeof SOURCING_TOOL_NAMES)[number];

/** One refusal, split so the tables below read as prose. */
interface SourcingCopy {
  /** What went wrong, and whether anything changed. */
  readonly what: string;
  /**
   * Whether to retry and what to do instead. `{tool}` renders as the failing tool's own
   * name, so "call it once more" can say WHICH call without four near-copies per code.
   */
  readonly instead: string;
}

/**
 * The move when the network is gone. Named once because it is the same answer for all four
 * tools: no provider call of any kind can succeed, so the run's only path is the media the
 * project already holds.
 */
const OFFLINE_INSTEAD =
  'Do not call {tool} again this run — with no network no provider call can succeed. ' +
  'Build the edit from the media the project already holds (list_assets shows it) and ' +
  'tell the editor there is no network connection.';

/** Every music failure, as the model should read it. Exhaustive over `MusicErrorCode`. */
const MUSIC_COPY: Readonly<Record<MusicErrorCode, SourcingCopy>> = {
  unauthorized: {
    what: 'the music provider rejected FramePilot’s request, so nothing was searched or downloaded',
    instead:
      'This is a credentials problem, not your arguments, and it will answer the same way ' +
      'for the rest of this run. Do not call {tool} again — score the edit with audio the ' +
      'project already holds (list_assets shows it) and tell the editor the music provider ' +
      'rejected FramePilot.',
  },
  rate_limited: {
    what: 'the music provider is rate-limiting FramePilot after too many requests in a row, so nothing came back',
    instead:
      'It clears on its own. Call {tool} once more, later in the run and not immediately; ' +
      'if it is limited again, continue without music and tell the editor.',
  },
  provider_unavailable: {
    what: 'the music provider did not respond, so nothing came back',
    instead:
      'Call {tool} once more. If it fails the same way, continue without music and tell ' +
      'the editor the music provider is down — the project’s own audio is still ' +
      'available through list_assets.',
  },
  unknown_track: {
    what: 'that track id is no longer valid, so nothing was downloaded and the timeline is unchanged',
    instead:
      'Do not send the same id again — it will be rejected the same way. Call search_music ' +
      'and use a remoteId from those fresh results.',
  },
  offline: {
    what: 'there is no network connection, so nothing was searched or downloaded',
    instead: OFFLINE_INSTEAD,
  },
  timeout: {
    what: 'the music provider took too long to answer, so nothing came back',
    instead:
      'Call {tool} once more. If it times out again, continue without music and tell the ' +
      'editor the music provider is not answering.',
  },
  cancelled: {
    what: 'this request was cancelled before it finished, so nothing was searched or downloaded',
    instead:
      'Nothing about the call was wrong. Call {tool} once more; if it is cancelled again ' +
      'the editor has stopped the run, so continue without music rather than re-issuing it.',
  },
  non_commercial_only: {
    what: 'that track is licensed for non-commercial use only, so it was not downloaded and the timeline is unchanged',
    instead:
      'The licence will not change on a retry. Pick a different result from search_music ' +
      'and add that one instead.',
  },
  disk_full: {
    what: 'there is not enough disk space to save the track, so nothing was written and the timeline is unchanged',
    instead:
      'Do not retry — a second download needs the same space. Continue without music and ' +
      'tell the editor to free up disk space.',
  },
  download_failed: {
    what: 'the download did not finish, so nothing was added and the timeline is unchanged',
    instead:
      'Pick a different result from search_music and add that one; if a second track fails ' +
      'the same way, continue without music and tell the editor the download is failing.',
  },
  derive_failed: {
    what: 'the track was saved but its waveform could not be read, so it was not handed back as a usable asset',
    instead:
      'Retrying reads the same file the same way. Pick a different result from search_music ' +
      'and add that one, or continue without music and tell the editor.',
  },
};

/** Every stock failure, as the model should read it. Exhaustive over `StockErrorCode`. */
const STOCK_COPY: Readonly<Record<StockErrorCode, SourcingCopy>> = {
  no_key: {
    what: 'no Pexels API key is configured, so no stock search or download can run at all',
    instead:
      'Only the editor can add a key, so this answers the same way for the rest of the run. ' +
      'Do not call {tool} again — build the edit from the footage the project already holds ' +
      '(list_assets shows it) and tell the editor that stock media needs a Pexels API key.',
  },
  unauthorized: {
    what: 'Pexels rejected the configured API key, so nothing was searched or downloaded',
    instead:
      'This is a credentials problem, not your arguments, and it will answer the same way ' +
      'for the rest of this run. Do not call {tool} again — build from the footage the ' +
      'project already holds (list_assets shows it) and tell the editor the Pexels key was ' +
      'rejected.',
  },
  rate_limited: {
    what: 'Pexels is rate-limiting FramePilot — about 200 requests an hour — so nothing came back',
    instead:
      'It clears within the hour, which is longer than this run. Call {tool} at most once ' +
      'more; if it is limited again, continue without stock footage and tell the editor the ' +
      'hourly Pexels limit was reached.',
  },
  quota_exhausted: {
    what: 'this month’s Pexels request allowance is used up, so nothing came back',
    instead:
      'It does not reset until next month, so no retry in this run can succeed. Do not call ' +
      '{tool} again — build from the footage the project already holds (list_assets shows ' +
      'it) and tell the editor the monthly Pexels allowance is spent.',
  },
  provider_unavailable: {
    what: 'Pexels did not respond, so nothing came back',
    instead:
      'Call {tool} once more. If it fails the same way, continue without stock footage and ' +
      'tell the editor Pexels is down — the project’s own footage is still available ' +
      'through list_assets.',
  },
  offline: {
    what: 'there is no network connection, so nothing was searched or downloaded',
    instead: OFFLINE_INSTEAD,
  },
  timeout: {
    what: 'Pexels took too long to answer, so nothing came back',
    instead:
      'Call {tool} once more. If it times out again, continue without stock footage and ' +
      'tell the editor Pexels is not answering.',
  },
  cancelled: {
    what: 'this request was cancelled before it finished, so nothing was searched or downloaded',
    instead:
      'Nothing about the call was wrong. Call {tool} once more; if it is cancelled again ' +
      'the editor has stopped the run, so continue without stock footage rather than ' +
      're-issuing it.',
  },
  too_large: {
    what: 'that file is over the 2 GB download limit, so nothing was added and the timeline is unchanged',
    instead:
      'The file will be the same size on a retry. Pick a different, shorter result from ' +
      'search_stock and add that one.',
  },
  disk_full: {
    what: 'there is not enough disk space to save the file, so nothing was written and the timeline is unchanged',
    instead:
      'Do not retry — a second download needs the same space. Continue without stock footage ' +
      'and tell the editor to free up disk space.',
  },
  download_failed: {
    what: 'the download did not finish, so nothing was added and the timeline is unchanged',
    instead:
      'Pick a different result from search_stock and add that one; if a second one fails the ' +
      'same way, continue without stock footage and tell the editor the download is failing.',
  },
  derive_failed: {
    what: 'the file was saved but its thumbnails could not be read, so it was not handed back as a usable asset',
    instead:
      'Retrying reads the same file the same way. Pick a different result from search_stock ' +
      'and add that one, or continue without stock footage and tell the editor.',
  },
};

/** Which surface a sourcing tool talks to — the table its codes are drawn from. */
function copyFor(tool: SourcingToolName, code: string): SourcingCopy | undefined {
  const table: Readonly<Record<string, SourcingCopy | undefined>> =
    tool === 'search_music' || tool === 'add_music' ? MUSIC_COPY : STOCK_COPY;
  return table[code];
}

/**
 * The sentence a failed `search_music` / `add_music` / `search_stock` / `add_stock` hands
 * back to the model.
 *
 * @param tool - The registry name of the call that failed, as the model knows it.
 * @param code - The closed-union error code the provider surface reported.
 * @param detail - The specific fact the sentence cannot carry (a retry-after, an HTTP
 *   status). Appended verbatim, exactly as `musicErrorMessage` does, because dropping it
 *   loses the only per-incident evidence the run log will ever have.
 * @returns A sentence that says what happened, whether retrying helps, and what to do
 *   instead. Never empty — an empty refusal is the failure this module was written for.
 */
export function sourcingFailureNote(
  tool: SourcingToolName,
  code: MusicErrorCode | StockErrorCode,
  detail?: string,
): string {
  const copy = copyFor(tool, code);
  if (!copy) {
    // An unrecognized code is passed through as itself rather than dressed in invented
    // guidance (`visualReasonGuidance`'s fall-through rule), but it still says the one
    // thing that is true of every unknown failure: repeating the call will not explain it.
    return (
      `"${tool}" failed with an unrecognized error (${code})${detail === undefined ? '' : `: ${detail}`}. ` +
      'Do not repeat the same call — tell the editor what failed and carry on with the ' +
      'media the project already holds (list_assets shows it).'
    );
  }
  const instead = copy.instead.replaceAll('{tool}', tool);
  // The tool name is QUOTED here and bare inside `instead`, which is the house rule
  // `next-action.ts` reads: a quoted name is the SUBJECT (the call that failed), a bare one
  // is the INSTRUCTION. Writing the subject bare would let every sentence satisfy the gate
  // by naming itself.
  return `"${tool}" failed — ${copy.what}${detail === undefined ? '' : ` (${detail})`}. ${instead}`;
}

/**
 * Every sentence this module can produce, with the call it belongs to.
 *
 * Exported so the failure-quality gates WALK the tables instead of quoting them: a list
 * copied into a test rots the day someone adds an error code, and both unions are closed
 * and exported, so a new code is walked on the commit that adds it.
 */
export function sourcingFailureNoteEntries(): readonly {
  readonly tool: SourcingToolName;
  readonly code: string;
  readonly note: string;
}[] {
  return SOURCING_TOOL_NAMES.flatMap((tool) => {
    const codes: readonly string[] =
      tool === 'search_music' || tool === 'add_music' ? MUSIC_ERROR_CODES : STOCK_ERROR_CODES;
    return codes.map((code) => ({
      tool,
      code,
      note: sourcingFailureNote(tool, code as MusicErrorCode | StockErrorCode),
    }));
  });
}
