/**
 * Caption segmentation — turning a flat word-level transcript into readable cues.
 *
 * This is the single authoritative segmenter for the whole product (ADR 0071).
 * Before it there were two, which disagreed: the Captions panel chunked every N
 * words regardless of what was being said, and the AI recipe path broke on
 * pauses over 0.8s — so captioning the same project two ways produced two
 * different cue sets.
 *
 * WHY scored break points rather than greedy chunking: where a caption breaks is
 * the single biggest determinant of whether it reads well. Fixed-N chunking
 * splits "I went to the / store and bought / milk" — ending lines on "the" and
 * "and" — because it cannot see the sentence. Professional subtitle practice
 * (BBC/Netflix house style, and what AutoCut/CapCut approximate) is to break at
 * the highest syntactic level available: after sentence-final punctuation first,
 * then at a clause boundary, then at a pause, and never between an article or
 * preposition and the word it governs.
 *
 * So instead of asking "have I used N words yet?", this module asks, for every
 * position a cue *could* legally end: "how good a break is this?" — and takes the
 * best one. Linguistic quality outweighs cue fullness, which is why a cue may
 * come out shorter than the limits allow.
 *
 * The pipeline, each stage independently testable and pure:
 *
 *   1. {@link splitIntoUtterances} — hard-split at silences and sentence ends
 *   2. {@link packSegment}        — choose the best break inside each run
 *   3. {@link enforceReadingSpeed} — re-split cues denser than the eye can read
 *   4. {@link layoutLines}        — place explicit `\n` breaks within a cue
 *   5. {@link enforceTiming}      — floor short cues, bridge flicker-gaps
 *
 * Everything here is deterministic: the same words + config always yield the same
 * cues, which is what lets the web preview and the Python renderer agree, and
 * what lets a caption golden be a golden.
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';

/**
 * How a transcript should be cut into cues. Every field is a hard limit except
 * {@link CaptionSegmentConfig.maxCharsPerSecond}, which is a readability ceiling
 * applied after packing.
 */
export interface CaptionSegmentConfig {
  /** Max characters on one displayed line, before wrapping to the next. */
  readonly maxCharsPerLine: number;
  /** Max displayed lines in one cue (1 for punchy short-form, 2 for subtitles). */
  readonly maxLines: number;
  /** Max words in one cue. The one-word template family sets this to 1. */
  readonly maxWordsPerCue: number;
  /** A cue is held at least this long, so it is readable at all. */
  readonly minCueSeconds: number;
  /** A cue never spans longer than this, even mid-sentence. */
  readonly maxCueSeconds: number;
  /**
   * Reading-speed ceiling in characters per second. ~17 is the broadcast norm
   * for adults; short-form tolerates more because the text is shorter.
   */
  readonly maxCharsPerSecond: number;
  /** A silence at least this long always ends a cue — speech has stopped. */
  readonly pauseSeconds: number;
  /**
   * A gap at most this long between two cues is absorbed by extending the
   * earlier cue, so captions don't blink off and on between words.
   */
  readonly bridgeGapSeconds: number;
  /** Semantic anchors that should receive extra visual room and balanced breaks. */
  readonly emphasisWords: readonly string[];
}

/** A cue produced by segmentation, ready to become a caption clip. */
export interface CaptionCueDraft {
  /** Displayed text; `\n` is a deliberate line break chosen by {@link layoutLines}. */
  readonly text: string;
  /** The words this cue covers, in order, with their original timings. */
  readonly words: readonly TranscriptWord[];
  /** Cue start in timeline seconds (may precede nothing; equals the first word's start). */
  readonly start: number;
  /** Cue end in timeline seconds — may extend past the last word (see `enforceTiming`). */
  readonly end: number;
}

/**
 * Named starting points, chosen so the common cases need no tuning.
 *
 * `short-form` is the default: one or two short lines, fast turnover — the
 * Reels/TikTok register the caption templates are designed for. `subtitle`
 * follows broadcast convention (42 chars, 2 lines, 17 cps) for long-form work.
 * `one-word` serves the one-word template family, where every word is its own
 * cue and the only real constraint is that each is held long enough to read.
 */
export const CAPTION_SEGMENT_PRESETS = {
  'short-form': {
    maxCharsPerLine: 24,
    maxLines: 2,
    maxWordsPerCue: 6,
    minCueSeconds: 0.5,
    maxCueSeconds: 3.5,
    maxCharsPerSecond: 24,
    pauseSeconds: 0.55,
    bridgeGapSeconds: 0.3,
    emphasisWords: [],
  },
  subtitle: {
    maxCharsPerLine: 42,
    maxLines: 2,
    maxWordsPerCue: 14,
    minCueSeconds: 0.8,
    maxCueSeconds: 6,
    maxCharsPerSecond: 17,
    pauseSeconds: 0.7,
    bridgeGapSeconds: 0.24,
    emphasisWords: [],
  },
  'one-word': {
    maxCharsPerLine: 20,
    maxLines: 1,
    maxWordsPerCue: 1,
    minCueSeconds: 0.25,
    maxCueSeconds: 2,
    maxCharsPerSecond: 60,
    pauseSeconds: 0.55,
    bridgeGapSeconds: 0.12,
    emphasisWords: [],
  },
} as const satisfies Record<string, CaptionSegmentConfig>;

/** Name of a {@link CAPTION_SEGMENT_PRESETS} entry. */
export type CaptionSegmentPresetName = keyof typeof CAPTION_SEGMENT_PRESETS;

/** The preset used when a caller expresses no preference. */
export const DEFAULT_CAPTION_SEGMENT_PRESET: CaptionSegmentPresetName = 'short-form';

/**
 * Build a config from a preset plus overrides, clamped to sane bounds.
 *
 * WHY clamping rather than validating: this is fed by UI sliders and by AI tool
 * arguments, and a nonsensical value (0 words per cue, a negative duration) must
 * degrade to the nearest workable setting rather than throw or, worse, loop
 * forever looking for a legal break.
 */
export function captionSegmentConfig(
  preset: CaptionSegmentPresetName = DEFAULT_CAPTION_SEGMENT_PRESET,
  overrides: Partial<CaptionSegmentConfig> = {},
): CaptionSegmentConfig {
  const base = CAPTION_SEGMENT_PRESETS[preset];
  const merged = { ...base, ...overrides };
  return {
    maxCharsPerLine: Math.max(1, Math.round(merged.maxCharsPerLine)),
    maxLines: Math.max(1, Math.round(merged.maxLines)),
    maxWordsPerCue: Math.max(1, Math.round(merged.maxWordsPerCue)),
    minCueSeconds: Math.max(0, merged.minCueSeconds),
    maxCueSeconds: Math.max(0.1, merged.maxCueSeconds),
    maxCharsPerSecond: Math.max(1, merged.maxCharsPerSecond),
    pauseSeconds: Math.max(0, merged.pauseSeconds),
    bridgeGapSeconds: Math.max(0, merged.bridgeGapSeconds),
    emphasisWords: [...new Set(merged.emphasisWords.map(bareWord).filter(Boolean))],
  };
}

/**
 * Pick the preset that suits a caption template's intended grouping.
 *
 * The template catalog already declares `suggestedWordsPerLine` (1 for the
 * one-word family), which is the only signal needed: one word per line means the
 * one-word register, a couple of words means short-form, and anything longer is
 * reading material and wants subtitle timing.
 */
export function presetForWordsPerLine(
  suggestedWordsPerLine: number,
): CaptionSegmentPresetName {
  if (suggestedWordsPerLine <= 1) return 'one-word';
  return suggestedWordsPerLine >= 7 ? 'subtitle' : 'short-form';
}

// ---------------------------------------------------------------------------
// Word classification — the linguistic signal break scoring reads
// ---------------------------------------------------------------------------

/**
 * Sentence-final punctuation. A break after one of these is the best break
 * available: the thought is complete, so the next cue starts fresh.
 * Closing quotes/brackets are allowed to trail (`said."`).
 */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/**
 * Clause-final punctuation — a real syntactic seam, just a weaker one than a
 * sentence end. An em/en dash counts: it marks an aside boundary.
 */
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/**
 * An abbreviation ending in a period that is NOT a sentence end. Without this,
 * "Dr. Smith" and "vs. the" would break after the abbreviation — a wrong break
 * that reads as a dropped sentence.
 *
 * Deliberately excludes "no." (as in "No. 5"): a spoken "No." is a complete
 * sentence far more often than it is an ordinal abbreviation, and treating it as
 * an abbreviation silently glued it to the next sentence.
 */
const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|fig|approx)\.$/i;

/**
 * Function words that must not be left stranded at the end of a cue: an article,
 * preposition, auxiliary, or conjunction belongs with what follows it. Breaking
 * after "the" or "to" is the most recognisable amateur subtitle mistake.
 */
const TRAILING_FUNCTION_WORDS = new Set([
  // Articles and determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his',
  'her', 'its', 'our', 'their', 'some', 'any', 'no', 'every', 'each',
  // Prepositions
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
  'over', 'under', 'about', 'as', 'than', 'through', 'between', 'against',
  // Auxiliaries and copulas
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does',
  'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'shall', 'may', 'might', 'must',
  // Coordinators and subordinators
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'because', 'while', 'when',
  'which', 'who', 'whom', 'whose', 'not',
]);

/**
 * Words that begin a new clause. Breaking *before* one of these is good: it puts
 * the seam where a reader expects a new thought to start.
 */
const CLAUSE_STARTERS = new Set([
  'and', 'but', 'or', 'so', 'because', 'although', 'though', 'while', 'when',
  'if', 'unless', 'until', 'since', 'whereas', 'however', 'therefore', 'then',
  'that', 'which', 'who', 'after', 'before',
]);

/** Strip punctuation and case, so "The," and "the" classify the same. */
const bareWord = (token: string): string => token.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();

/** True when `token` ends a sentence (and is not a known abbreviation). */
export function isSentenceEnd(token: string): boolean {
  if (ABBREVIATION.test(token)) return false;
  return SENTENCE_END.test(token);
}

/** True when `token` ends a clause but not a sentence. */
export function isClauseEnd(token: string): boolean {
  return !isSentenceEnd(token) && CLAUSE_END.test(token);
}

// ---------------------------------------------------------------------------
// Break scoring
// ---------------------------------------------------------------------------

/**
 * Break-quality weights. Ordered so that a genuine syntactic seam always beats a
 * fuller cue: {@link FILL_WEIGHT} is deliberately below `CLAUSE_END_SCORE`, so
 * "break at the comma" wins over "cram in two more words", while a merely
 * mid-phrase break still prefers to fill the line.
 */
const SENTENCE_END_SCORE = 100;
const CLAUSE_END_SCORE = 60;
const CLAUSE_START_SCORE = 30;
/** Longest pause that still earns proportional credit; beyond it, full credit. */
const PAUSE_SATURATION_SECONDS = 0.5;
const PAUSE_MAX_SCORE = 50;
/** Penalty for stranding an article/preposition/auxiliary at the end of a cue. */
const DANGLING_WORD_PENALTY = 40;
/**
 * How much a *full* cue is worth when choosing where to end one.
 *
 * Deliberately well below {@link SENTENCE_END_SCORE}: ending a cue at a sentence
 * boundary is almost always right even when more words would have fit, so
 * fullness must not be able to outvote it. This was tuned against a real case —
 * at a higher weight, "I shipped it on a Friday. that was a mistake. never
 * again." scored a single 12-word cue *equal* to breaking after "Friday.", and
 * the tie-break toward fuller cues then swallowed all three sentences into one.
 */
const PACK_FILL_WEIGHT = 30;
/**
 * How much an evenly-balanced pair of lines is worth in {@link layoutLines}.
 * Below {@link DANGLING_WORD_PENALTY} on purpose: a line break after "the" is
 * the most visible flaw in a caption, so avoiding it outranks tidy balance.
 */
const LAYOUT_BALANCE_WEIGHT = 25;
/**
 * Per-character penalty for a line that overruns `maxCharsPerLine` in
 * {@link layoutLines}. Large enough that any non-overflowing split wins, but
 * finite so a cue too long for its lines still renders instead of being dropped.
 */
const OVERFLOW_PENALTY_PER_CHAR = 100;
/**
 * Bonus for putting the shorter line first — the broadcast convention, since the
 * eye travels downward into more text rather than less. Smallest of the layout
 * weights: it only ever settles a choice the other signals left open.
 */
const BOTTOM_HEAVY_BONUS = 10;

/**
 * How good a break between `words[index]` and `words[index + 1]` is, ignoring
 * how full the resulting cue would be. Higher is better; may go negative.
 *
 * Signals are additive rather than exclusive on purpose — a comma *and* a
 * half-second pause is a better break than either alone, which is exactly how it
 * reads on screen.
 */
export function breakQuality(words: readonly TranscriptWord[], index: number): number {
  const current = words[index];
  const next = words[index + 1];
  /* v8 ignore next -- callers only pass in-range indices; guards the type */
  if (!current) return 0;

  let score = 0;
  if (isSentenceEnd(current.word)) score += SENTENCE_END_SCORE;
  else if (isClauseEnd(current.word)) score += CLAUSE_END_SCORE;

  if (next) {
    const gap = next.start - current.end;
    if (gap > 0) {
      score += PAUSE_MAX_SCORE * Math.min(1, gap / PAUSE_SATURATION_SECONDS);
    }
    if (CLAUSE_STARTERS.has(bareWord(next.word))) score += CLAUSE_START_SCORE;
  }

  // Stranding only matters when something follows; the last word of the
  // transcript ends the cue no matter what it is.
  if (next && TRAILING_FUNCTION_WORDS.has(bareWord(current.word))) {
    score -= DANGLING_WORD_PENALTY;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Stage 1 — hard splits at silences and sentence ends
// ---------------------------------------------------------------------------

/**
 * Cut `words` into utterances at the two *hard* boundaries: a silence of at
 * least `pauseSeconds`, and the end of a sentence.
 *
 * WHY both are hard rather than merely well-scored. A pause is obvious — speech
 * stopped, so no cue should span the silence however well the words would fit.
 *
 * A sentence end is hard for a different reason: **predictability**. Scored as a
 * preference, two complete sentences that both fit a cue tie at the same
 * linguistic score, and cue fullness silently decides between them — so "that
 * was a mistake. never again." merged into one cue while a slightly longer pair
 * did not, with nothing in the UI to explain the difference. Making it a boundary
 * gives the rule editors actually expect and every subtitle house style states:
 * **one sentence per cue.** A very short sentence ("Yes.") becomes its own cue,
 * held for {@link CaptionSegmentConfig.minCueSeconds} — which is correct, and is
 * exactly the punchy register short-form captions want.
 *
 * A long sentence is still subdivided by {@link packSegment}; this only
 * guarantees a cue never *spans* a sentence end.
 */
export function splitIntoUtterances(
  words: readonly TranscriptWord[],
  pauseSeconds: number,
): readonly (readonly TranscriptWord[])[] {
  const runs: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  for (const word of words) {
    const previous = current[current.length - 1];
    const paused = previous !== undefined && word.start - previous.end >= pauseSeconds;
    const sentenceEnded = previous !== undefined && isSentenceEnd(previous.word);
    if (paused || sentenceEnded) {
      runs.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

// ---------------------------------------------------------------------------
// Stage 2 — choose the best break inside a run
// ---------------------------------------------------------------------------

/** Character length of `words` rendered as a single spaced line. */
const renderedLength = (
  words: readonly TranscriptWord[],
  emphasisWords: readonly string[] = [],
): number => {
  const emphasized = new Set(emphasisWords);
  return words.reduce((total, word, index) => {
    const visualWeight = emphasized.has(bareWord(word.word)) ? Math.ceil(word.word.length * 0.45) : 0;
    return total + word.word.length + visualWeight + (index > 0 ? 1 : 0);
  }, 0);
};

/** Prefer an emphasized anchor at a composed phrase ending, not stranded alone. */
const emphasisBreakScore = (
  words: readonly TranscriptWord[],
  from: number,
  to: number,
  emphasisWords: readonly string[],
): number => {
  if (emphasisWords.length === 0) return 0;
  const emphasized = new Set(emphasisWords);
  /* v8 ignore next -- callers only pass in-range `to` indices; guards the type */
  const currentIsAnchor = emphasized.has(bareWord(words[to]?.word ?? ''));
  const spanLength = to - from + 1;
  if (!currentIsAnchor) return 0;
  return spanLength === 1 ? -18 : 18;
};

/**
 * Cut one pause-free run into cues, taking the best-scoring legal break each
 * time. Returns index ranges rather than cues so the caller owns cue shape.
 */
export function packSegment(
  words: readonly TranscriptWord[],
  config: CaptionSegmentConfig,
): readonly (readonly TranscriptWord[])[] {
  const capacity = config.maxCharsPerLine * config.maxLines;
  const cues: (readonly TranscriptWord[])[] = [];
  let from = 0;

  while (from < words.length) {
    // The furthest this cue may legally reach. Always at least one word, even
    // when that single word alone exceeds the limits — dropping it would
    // silently lose speech, and an over-long word is the lesser evil.
    let furthest = from;
    for (let to = from + 1; to < words.length; to += 1) {
      const span = words.slice(from, to + 1);
      const withinWords = span.length <= config.maxWordsPerCue;
      const withinChars = renderedLength(span, config.emphasisWords) <= capacity;
      // `words[to]!` — `to` is bounded by `words.length` above.
      const withinDuration = words[to]!.end - words[from]!.start <= config.maxCueSeconds;
      if (!withinWords || !withinChars || !withinDuration) break;
      furthest = to;
    }

    // Among every legal end position, take the best break. Fullness is a
    // tie-breaker, never the primary signal (see FILL_WEIGHT).
    const options = furthest - from;
    let bestIndex = furthest;
    let bestScore = -Infinity;
    for (let to = from; to <= furthest; to += 1) {
      const fill = options === 0 ? 1 : (to - from) / options;
      const score =
        breakQuality(words, to) +
        emphasisBreakScore(words, from, to, config.emphasisWords) +
        PACK_FILL_WEIGHT * fill;
      // `>=` keeps the LATER of two equal breaks, so cues stay as full as the
      // linguistics allow and the loop always advances.
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = to;
      }
    }

    cues.push(words.slice(from, bestIndex + 1));
    from = bestIndex + 1;
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Stage 3 — reading speed
// ---------------------------------------------------------------------------

/**
 * Split any cue whose text arrives faster than `maxCharsPerSecond` can be read.
 *
 * Packing bounds a cue by words, characters, and wall-clock duration, none of
 * which catches *density*: six short words rattled off in 0.4s fit every limit
 * and are still unreadable. Splitting such a cue does not create more reading
 * time, but it does let each half be held for {@link
 * CaptionSegmentConfig.minCueSeconds} by `enforceTiming`, and it keeps the
 * on-screen text short enough to take in at a glance.
 *
 * A single word is never split — there is nothing to split — so this always
 * terminates.
 */
export function enforceReadingSpeed(
  cues: readonly (readonly TranscriptWord[])[],
  config: CaptionSegmentConfig,
): readonly (readonly TranscriptWord[])[] {
  const result: (readonly TranscriptWord[])[] = [];
  // Stack in reverse timeline order: `pop()` is O(1), unlike the previous
  // shift/unshift deque emulation which moved the whole array for every cue.
  const pending = [...cues].reverse();
  while (pending.length > 0) {
    const cue = pending.pop()!;
    const duration = cue[cue.length - 1]!.end - cue[0]!.start;
    const readable =
      duration <= 0 ||
      renderedLength(cue, config.emphasisWords) / duration <= config.maxCharsPerSecond;
    if (cue.length < 2 || readable) {
      result.push(cue);
      continue;
    }
    // Halve at the best internal break rather than the midpoint, so the split
    // still lands on a syntactic seam where one exists.
    let bestIndex = Math.floor((cue.length - 1) / 2);
    let bestScore = -Infinity;
    for (let index = 0; index < cue.length - 1; index += 1) {
      const balance = 1 - Math.abs((index + 1) / cue.length - 0.5) * 2;
      const score = breakQuality(cue, index) + PACK_FILL_WEIGHT * balance;
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    // Re-queue BOTH halves rather than accepting the first: a very dense run may
    // need splitting more than once, and the first half is not known to be
    // readable yet. Terminates because each half is strictly shorter than `cue`
    // and a single word is never split.
    // Push right then left so the left half is popped/processed first.
    pending.push(cue.slice(bestIndex + 1), cue.slice(0, bestIndex + 1));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage 4 — line layout
// ---------------------------------------------------------------------------

/**
 * Lay a cue's words out across at most `maxLines`, returning the display text
 * with explicit `\n` breaks.
 *
 * WHY the editor decides this rather than the renderer: through v10 wrapping was
 * whatever each renderer's greedy fill produced at that frame size, so the same
 * cue broke differently in the preview and the export, and the editor could not
 * control it at all. Choosing here makes the break part of the cue's text —
 * visible, reviewable, and identical everywhere.
 *
 * Two-line cues break at the best-scoring position near the middle, preferring a
 * shorter first line (the "bottom-heavy" convention: the eye travels down to
 * more text, not less).
 */
export function layoutLines(
  words: readonly TranscriptWord[],
  config: CaptionSegmentConfig,
): string {
  const tokens = words.map((word) => word.word);
  if (config.maxLines <= 1 || tokens.length < 2) return tokens.join(' ');
  if (renderedLength(words, config.emphasisWords) <= config.maxCharsPerLine) return tokens.join(' ');

  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let index = 0; index < words.length - 1; index += 1) {
    const first = renderedLength(words.slice(0, index + 1), config.emphasisWords);
    const second = renderedLength(words.slice(index + 1), config.emphasisWords);
    // Overlong lines are permitted but heavily discouraged, so a cue whose text
    // cannot fit two lines still renders rather than being dropped.
    const overflow =
      Math.max(0, first - config.maxCharsPerLine) + Math.max(0, second - config.maxCharsPerLine);
    const balance = 1 - Math.abs(first - second) / Math.max(first, second);
    const bottomHeavy = second >= first ? 1 : 0;
    const score =
      breakQuality(words, index) +
      emphasisBreakScore(words, 0, index, config.emphasisWords) +
      LAYOUT_BALANCE_WEIGHT * balance +
      BOTTOM_HEAVY_BONUS * bottomHeavy -
      OVERFLOW_PENALTY_PER_CHAR * overflow;
    if (score >= bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return `${tokens.slice(0, bestIndex + 1).join(' ')}\n${tokens.slice(bestIndex + 1).join(' ')}`;
}

// ---------------------------------------------------------------------------
// Stage 5 — timing
// ---------------------------------------------------------------------------

/**
 * Give each cue its final `[start, end)`: hold short cues long enough to read,
 * and absorb gaps too small to be worth blinking for.
 *
 * A cue's words define when it *must* be up; they do not define when it should
 * come down. Ending a cue exactly on its last word makes captions flicker
 * between every phrase — the single most obvious tell that captions were
 * generated rather than authored. Extension never crosses into the next cue, so
 * cues stay non-overlapping and the timeline stays valid.
 */
export function enforceTiming(
  cues: readonly (readonly TranscriptWord[])[],
  config: CaptionSegmentConfig,
): readonly { readonly words: readonly TranscriptWord[]; start: number; end: number }[] {
  return cues.map((words, index) => {
    const start = words[0]!.start;
    const spokenEnd = words[words.length - 1]!.end;
    const nextStart = cues[index + 1]?.[0]?.start;

    // The latest this cue may end: butting against the next cue, or unbounded
    // for the last cue.
    const ceiling = nextStart ?? Infinity;
    const gap = ceiling - spokenEnd;

    // Bridge a small gap entirely (no blink); otherwise hold for the minimum.
    const wanted =
      gap <= config.bridgeGapSeconds
        ? ceiling
        : Math.max(spokenEnd, start + config.minCueSeconds);

    // Never overlap the next cue, and never end before the words finish. Finite
    // even for the last cue: an unbounded `ceiling` only ever widens the `min`.
    return { words, start, end: Math.max(spokenEnd, Math.min(wanted, ceiling)) };
  });
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Segment a word-level transcript into readable, well-timed caption cues.
 *
 * The one entry point every caller uses — the Captions panel, the AI
 * `add_captions` recipe, and any future importer — so cues are identical however
 * they were asked for. An empty transcript yields no cues.
 *
 * @param words - Word-level transcript in timeline seconds, in time order.
 * @param config - Limits and readability targets; see {@link captionSegmentConfig}.
 * @returns Cues in time order, each with display text, its words, and its range.
 */
export function segmentCaptions(
  words: readonly TranscriptWord[],
  config: CaptionSegmentConfig = captionSegmentConfig(),
): readonly CaptionCueDraft[] {
  // Drop zero/negative-duration entries up front: they carry no readable time
  // and would otherwise skew every pause and reading-speed calculation.
  const usable = words.filter((word) => word.end > word.start);
  if (usable.length === 0) return [];

  const runs = splitIntoUtterances(usable, config.pauseSeconds);
  const packed = runs.flatMap((run) => packSegment(run, config));
  const readable = enforceReadingSpeed(packed, config);
  return enforceTiming(readable, config).map(({ words: cueWords, start, end }) => ({
    text: layoutLines(cueWords, config),
    words: cueWords,
    start,
    end,
  }));
}
