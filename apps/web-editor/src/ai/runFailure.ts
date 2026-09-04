/**
 * Turn a run-level throw into the "failed" state the sidebar is supposed to show
 * (P8.2): one plain sentence about what happened and what helps, with the raw
 * provider / FFmpeg / transport text behind "Show details".
 *
 * Until this existed, `AiSidebar`'s two catch blocks passed `error.message`
 * straight through as the notice's headline. That message is written for a
 * developer reading a log — an HTTP status and a JSON body, a stack-adjacent
 * one-liner, sometimes several hundred characters of provider response — and it
 * became the loudest text in the panel at the exact moment the user most needs
 * to know what to do next. The audience here is video editors (the 2026-07-12
 * "de-programmered UI" pass); the raw text is evidence, not the message.
 *
 * The mapping is deliberately shallow. It recognises the failure families a user
 * can actually act on and says the action; everything else keeps its own first
 * line as the headline and puts the full text behind the disclosure. Guessing at
 * a friendlier phrasing for an unrecognised failure would replace a true
 * technical sentence with a vague false one.
 */

/** The shortest failure text worth folding: below this the raw message IS the headline. */
const INLINE_LIMIT = 140;

/** What the notice renders: a headline, and the raw text when it adds anything. */
export interface RunFailureExplanation {
  readonly text: string;
  readonly detail?: string;
}

interface FailureFamily {
  readonly match: RegExp;
  readonly text: string;
}

/**
 * Ordered — the first match wins, so the specific families come before the ones
 * whose wording is common to many errors (a 401 body often also says "request
 * failed").
 */
const FAMILIES: readonly FailureFamily[] = [
  // FIRST, and it must stay first. The Claude Agent SDK provider signs in with the user's
  // Claude Code login, so it has no API key at all — but its failure text says things like
  // "Invalid API key · Please run /login", which the generic auth family below matches
  // happily and answers with "check the key in Settings → AI". That sends someone to a
  // field that does not exist for their provider. Matching `claude login` / `/login` first
  // is what keeps the advice actionable.
  {
    match: /claude login|\/login\b|not (logged in|signed in)|claude code (is )?not/i,
    text: 'FramePilot is not signed in to Claude. Run `claude login` in a terminal, then start the run again — this provider uses your Claude subscription, not an API key.',
  },
  {
    match: /\b(401|403)\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication[ _-]?error/i,
    text: 'The AI provider rejected FramePilot’s key. Check the key in Settings → AI, then try again.',
  },
  {
    match: /\b(429|529)\b|rate[ _-]?limit|too many requests|overloaded|quota/i,
    text: 'The AI provider is busy or over its rate limit right now. Wait a moment, then retry.',
  },
  {
    match: /credit|billing|payment|insufficient[ _-]?funds/i,
    text: 'The AI provider refused the request for billing reasons. Check the account, then retry.',
  },
  {
    match: /timed? ?out|timeout|ETIMEDOUT|deadline exceeded/i,
    text: 'The run hit its time limit before it finished. Retry, or ask for a smaller piece of the edit.',
  },
  {
    match: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error|failed to fetch/i,
    text: 'FramePilot could not reach the AI provider. Check the connection, then retry.',
  },
  {
    match: /sidecar|ffmpeg|ffprobe|render engine/i,
    text: 'The media engine stopped part-way through this run. Nothing was left half-applied — retry when you are ready.',
  },
];

/** The first non-empty line of `message`, trimmed. */
function firstLine(message: string): string {
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return message.trim();
}

/**
 * Explain a run-level failure for the sidebar's notice.
 *
 * @param message - The raw `Error.message` (or stringified throw) from the run.
 * @returns The headline to show, plus the raw text as `detail` whenever the
 *   headline is not already the whole of it — a disclosure that would repeat the
 *   headline is noise, so it is omitted.
 */
export function explainRunFailure(message: string): RunFailureExplanation {
  const raw = message.trim();
  if (raw.length === 0) {
    return {
      text: 'The run stopped without saying why. Retry, and the details should be clearer.',
    };
  }

  const family = FAMILIES.find((candidate) => candidate.match.test(raw));
  if (family) return { text: family.text, detail: raw };

  // Unrecognised: keep the author's own words. Fold only when there is genuinely
  // more behind the fold than in front of it.
  const headline = firstLine(raw);
  if (headline === raw && raw.length <= INLINE_LIMIT) return { text: raw };
  return {
    text:
      headline.length > INLINE_LIMIT ? `${headline.slice(0, INLINE_LIMIT).trimEnd()}…` : headline,
    detail: raw,
  };
}
