/**
 * Reading a caption clip's displayed text — the single definition, shared by the
 * editor list, the live preview, and (mirrored) the Python renderer.
 *
 * WHY this module exists. Through schema v10 there was no cue text: every
 * consumer re-derived a caption's words from `Project.transcript` by time, and
 * they did not agree on how. `CaptionEditor` matched by **start containment**
 * (`w.start >= start && w.start < end`); `PreviewPlayer` and
 * `render/captions.py` matched by **overlap** (`w.start < end && w.end > start`).
 * For any word straddling a cue boundary — common, because v10 placed boundaries
 * by word count rather than by pauses — the caption list showed one thing and the
 * export produced another. Three implementations, two semantics, no single place
 * to fix it.
 *
 * Now there is one function. A clip either carries its own `captionCue` (schema
 * v11, authoritative) or it does not, in which case its words are derived by
 * **overlap** — the correct rule, and the one two of the three implementations
 * already used: a word audible during a cue belongs to that cue.
 *
 * The other job here is {@link alignCueWords}. A cue's `text` is authoritative
 * for what is drawn and may legitimately differ from its `words` — an edited
 * line, an explicit `\n`, a redaction. Renderers therefore cannot assume token
 * *i* of the text is word *i* of the timing array by identity; they need an
 * explicit alignment, which is what turns a cue into drawable, timed lines.
 */
import type { Clip, TranscriptWord } from '@framepilot/timeline-schema';

/**
 * A caption ready to draw: its text, its timings, and its text laid out as timed
 * display lines.
 */
export interface ResolvedCaptionCue {
  /** The displayed text, `\n`-separated for author-chosen line breaks. */
  readonly text: string;
  /** Word timings driving emphasis, in absolute timeline seconds. */
  readonly words: readonly TranscriptWord[];
  /**
   * `text` split into lines, each a list of timed display tokens — what a
   * renderer actually iterates. Token text always comes from `text`; timing
   * comes from `words` where an alignment exists.
   */
  readonly lines: readonly (readonly TranscriptWord[])[];
  /**
   * True when this cue carries its own text (schema v11) rather than being
   * derived from the project transcript. Surfaced so the UI can mark a cue as
   * edited, and so a regeneration can tell which cues it would overwrite.
   */
  readonly authored: boolean;
}

/**
 * The transcript words audible during `[start, end)` — the **overlap** rule.
 *
 * A word counts when any part of it sounds inside the range, which is why the
 * comparison is `w.start < end && w.end > start` rather than a containment test
 * on `w.start`. This is the one derivation rule; nothing else in the codebase
 * may define its own.
 */
export function transcriptWordsInRange(
  transcript: readonly TranscriptWord[],
  start: number,
  end: number,
): readonly TranscriptWord[] {
  return transcript.filter((word) => word.start < end && word.end > start);
}

/**
 * Align a cue's display `text` to its `words`, producing timed tokens grouped by
 * line.
 *
 * Alignment is **positional**: the nth display token takes the nth word's
 * timing. That is deliberate rather than a text match — an editor who fixes a
 * typo ("recieve" → "receive") or redacts a word ("[name]") must keep the
 * karaoke timing that word had, and a text match would lose it. Line breaks do
 * not consume a word, so timings stay aligned across a `\n`.
 *
 * When `text` has more tokens than `words` (a word split in two, or a cue typed
 * from scratch), the surplus tokens are timed to `fallback` so they are still
 * drawn — visible and untimed beats invisible. When it has fewer, the extra
 * timings are simply unused.
 *
 * @param text - Display text; `\n` separates lines.
 * @param words - Word timings, in order.
 * @param fallback - Range to time surplus tokens with (normally the clip's own).
 * @returns Lines of timed display tokens.
 */
export function alignCueWords(
  text: string,
  words: readonly TranscriptWord[],
  fallback: { readonly start: number; readonly end: number },
): readonly (readonly TranscriptWord[])[] {
  let consumed = 0;
  return text.split('\n').map((line) =>
    line
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => {
        const timing = words[consumed];
        consumed += 1;
        return timing === undefined
          ? { word: token, start: fallback.start, end: fallback.end }
          : // Keep the timing, take the DISPLAY token's text — that is what
            // makes an edited word keep its karaoke beat.
            { word: token, start: timing.start, end: timing.end };
      }),
  );
}

/**
 * What a caption clip displays: its own cue when it has one, otherwise the
 * transcript words audible during its range.
 *
 * The one entry point for "what does this caption say?". A clip with an explicit
 * `captionCue` is authoritative — including a deliberately blanked cue
 * (`text: ''`), which draws nothing and must NOT silently fall back to the
 * transcript, or clearing a caption would be impossible.
 *
 * ## The fallback's timebase — read before using it
 *
 * The derivation compares `transcript` timestamps against `clip.start`/`clip.end`,
 * which are **sequence** times. So `transcript` must be in sequence time too.
 * `Project.transcript` is in **source** time (schema v12, ADR 0076) and the two
 * coincide only until the first cut — passing it raw derives the wrong words on
 * any edited timeline. Map it first with `mapTranscript` from
 * `captions/derive.ts` and pass the mapped words.
 *
 * This is a legacy path: every cue generated since schema v11 carries its own
 * `captionCue` and never reaches the fallback, so today it fires only for
 * projects captioned before v11. It is documented rather than removed because
 * those projects must still render, and rather than "fixed" silently because the
 * fix belongs at the call sites that know the timeline.
 *
 * @param clip - The caption clip (its `start`/`end` bound the derivation).
 * @param transcript - Words **in sequence time**, used only for the fallback path.
 */
export function resolveCaptionCue(
  clip: Pick<Clip, 'start' | 'end' | 'captionCue'>,
  transcript: readonly TranscriptWord[],
): ResolvedCaptionCue {
  const fallbackRange = { start: clip.start, end: clip.end };
  if (clip.captionCue !== undefined) {
    const { text, words } = clip.captionCue;
    return {
      text,
      words,
      lines: alignCueWords(text, words, fallbackRange),
      authored: true,
    };
  }
  // Pre-v11 path: derive by overlap. Text is the words joined, with no author
  // line break to honour — wrapping stays the renderer's business, as it was.
  const words = transcriptWordsInRange(transcript, clip.start, clip.end);
  const text = words.map((word) => word.word).join(' ');
  return { text, words, lines: words.length > 0 ? [words] : [], authored: false };
}
