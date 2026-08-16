/**
 * Footage search v1 over the transcript (plan H1.5/J4 — "search what's said,
 * jump to it"). Pure word-matching + word→clip/asset mapping; the media bin
 * renders from this. No React/DOM here, matching the rest of this
 * directory's split between deterministic logic (`captions.ts`, `selectors.ts`)
 * and thin component shells.
 *
 * `Project.transcript` words are timeline-time (the same clock `editor.seek`
 * and `TranscriptView`'s word buttons already use), not source-asset time —
 * confirmed by the `transcribe` AI tool, which writes `set_transcript` without
 * any per-asset scoping. So a match's `start` can be handed straight to
 * `clipsActiveAt` to find whatever clip/asset is on the timeline at that
 * instant, exactly the way the preview player already resolves "what's
 * playing now" (`selectors.ts`) — no new time-mapping logic invented here.
 */
import type { Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import { stripPunctuation } from './captions.js';
import { clipsActiveAt } from './selectors.js';

/** Words of context kept on each side of a match for its "keyword in context" snippet. */
export const SNIPPET_CONTEXT_WORDS = 4;

/** One transcript hit: where it is (asset/clip), when it's spoken, and its snippet. */
export interface TranscriptSearchResult {
  /** Index of the match's first word in the transcript (stable React key). */
  readonly wordIndex: number;
  /** Seek target — the first matched word's start time. */
  readonly start: number;
  readonly end: number;
  /** The matched phrase, verbatim. */
  readonly matchText: string;
  /** A few words before/after the match, for "keyword in context". */
  readonly snippet: string;
  /** The asset occupying the timeline at `start`, or `null` if nothing does
   * (e.g. the transcript is stale relative to a since-edited timeline). */
  readonly assetId: string | null;
  readonly clipId: string | null;
}

/**
 * Search `transcript` for `query`, matching **whole words** (not substrings):
 * a query token must equal a transcript word once both are folded to bare
 * letters/digits (`stripPunctuation`). Chosen over substring matching because
 * a transcript is prose, not filenames — "cat" silently matching every
 * "category"/"cats"/"catalog" would make results noisier than requiring the
 * exact word (typos aside, which substring matching wouldn't forgive well
 * either, since it only helps when the typo is a truncation). A multi-word
 * query ("thank you") matches a contiguous run of that many words, giving
 * phrase search for free. Returns matches in transcript order.
 */
export function searchTranscript(
  transcript: readonly TranscriptWord[],
  timeline: Timeline,
  query: string,
): readonly TranscriptSearchResult[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map(stripPunctuation)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  const normalizedWords = transcript.map((w) => stripPunctuation(w.word));
  const results: TranscriptSearchResult[] = [];
  for (let i = 0; i + tokens.length <= transcript.length; i++) {
    let matched = true;
    for (let j = 0; j < tokens.length; j++) {
      if (normalizedWords[i + j] !== tokens[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const first = transcript[i]!;
    const last = transcript[i + tokens.length - 1]!;
    const from = Math.max(0, i - SNIPPET_CONTEXT_WORDS);
    const to = Math.min(transcript.length, i + tokens.length + SNIPPET_CONTEXT_WORDS);
    // Reuse of "the clip/asset active at time t" — the same lookup the preview
    // player uses to decide what's on screen right now (selectors.ts).
    const active = clipsActiveAt(timeline, first.start)[0] ?? null;
    results.push({
      wordIndex: i,
      start: first.start,
      end: last.end,
      matchText: transcript
        .slice(i, i + tokens.length)
        .map((w) => w.word)
        .join(' '),
      snippet: transcript
        .slice(from, to)
        .map((w) => w.word)
        .join(' '),
      assetId: active?.clip.assetId ?? null,
      clipId: active?.clip.id ?? null,
    });
  }
  return results;
}
