/**
 * @framepilot/ai-sdk/transcript-loop — is this transcript mostly one phrase repeated?
 *
 * Shared by the Critic (which warns, and refuses to fail a run over the loop's words), the
 * context builder (which stops feeding the loop to the model as "the transcript"), and the
 * mission rubric. One detector, so the three can never disagree about the same recording.
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';

/** A stretch of transcript that is one phrase repeated — the ASR hallucination signature. */
export interface TranscriptLoop {
  /** The repeated phrase, as transcribed. */
  readonly phrase: string;
  /** How many times it repeats back to back. */
  readonly repeats: number;
  /** Seconds of the recording the repetition covers. */
  readonly seconds: number;
  /** That span as a share of the transcript's own span, 0..1. */
  readonly share: number;
  /** Source second the repetition starts at — the low edge of the unreliable stretch. */
  readonly startSeconds: number;
  /** Source second it ends at. Word timings in `[startSeconds, endSeconds]` mean nothing. */
  readonly endSeconds: number;
}

/** Repeats before a phrase is a hallucination rather than a chorus. */
const LOOP_MIN_REPEATS = 8;
/** …and the share of the transcript it must cover, so a real refrain is not flagged. */
const LOOP_MIN_SHARE = 0.5;

/**
 * Is this transcript mostly one phrase repeated — i.e. did ASR hallucinate?
 *
 * Whisper's best-known failure mode is a loop: over quiet or music-only audio it emits one
 * sentence again and again, with plausible timings, and nothing downstream can tell those
 * words from spoken ones. This function was written against `mission-podcast`, whose media
 * was then 2431 words of which 2384 — 92%, from 21.7s to 575.5s — were "I'll try to follow
 * you later." repeated 397 times over a clip whose real speech stopped around 30s. That
 * fixture has since been replaced (`speech-9min-c`), so the detector no longer fires on any
 * project in the repo; it stays because the failure it catches is whisper's, not that
 * fixture's, and the next quiet recording a user imports reproduces it exactly.
 *
 * That matters well beyond one fixture. The transcript is what grounds a highlight
 * selection, a silence pass and every caption, so a run that trusts a hallucinated one cuts
 * confidently on words nobody said, and every check that reads the transcript — `dead_air`,
 * `word_severed` — agrees with it. Detecting the loop is what lets the run say so instead.
 *
 * Deliberately conservative, because a chorus, a chant and a drill are all legitimately
 * repetitive: the phrase must repeat back to back at least {@link LOOP_MIN_REPEATS} times AND
 * cover at least half the transcript's span. Real speech does not do both.
 *
 * @param words - The transcript, in time order.
 * @returns The loop, or `undefined` when the transcript does not look fabricated.
 */
/**
 * Memo keyed on the transcript array itself.
 *
 * The scan is quadratic in the transcript and now runs on every context build (the
 * transcript slice consults it) as well as in the Critic. `Project.transcript` is replaced
 * as a whole when a transcript changes and is otherwise the same array turn after turn, so
 * identity is a sound key and the scan runs once per transcript, not once per model call.
 */
const LOOP_MEMO = new WeakMap<readonly TranscriptWord[], TranscriptLoop | undefined>();

export function detectTranscriptLoop(words: readonly TranscriptWord[]): TranscriptLoop | undefined {
  if (LOOP_MEMO.has(words)) return LOOP_MEMO.get(words);
  const loop = scanForLoop(words);
  LOOP_MEMO.set(words, loop);
  return loop;
}

function scanForLoop(words: readonly TranscriptWord[]): TranscriptLoop | undefined {
  if (words.length < LOOP_MIN_REPEATS * 2) return undefined;
  const span = words[words.length - 1]!.end - words[0]!.start;
  if (!(span > 0)) return undefined;
  const norm = (w: TranscriptWord): string => w.word.trim().toLowerCase();
  // Try each plausible phrase length, shortest first: the loop's period is unknown, and a
  // longer window would also match a multiple of the true one.
  for (let size = 1; size <= 12; size++) {
    for (let start = 0; start + size * LOOP_MIN_REPEATS <= words.length; start++) {
      const phrase = words
        .slice(start, start + size)
        .map(norm)
        .join(' ');
      if (!phrase) continue;
      let repeats = 1;
      let index = start + size;
      while (
        index + size <= words.length &&
        words
          .slice(index, index + size)
          .map(norm)
          .join(' ') === phrase
      ) {
        repeats++;
        index += size;
      }
      if (repeats < LOOP_MIN_REPEATS) continue;
      const seconds = words[index - 1]!.end - words[start]!.start;
      const share = seconds / span;
      if (share < LOOP_MIN_SHARE) continue;
      return {
        phrase: words
          .slice(start, start + size)
          .map((w) => w.word.trim())
          .join(' '),
        repeats,
        seconds,
        share,
        startSeconds: words[start]!.start,
        endSeconds: words[index - 1]!.end,
      };
    }
  }
  return undefined;
}
