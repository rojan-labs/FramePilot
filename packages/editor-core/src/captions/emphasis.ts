/**
 * Deterministic semantic emphasis for creator captions.
 *
 * This deliberately stays model-free: caption generation must remain instant,
 * reproducible, and available offline. The scorer combines lexical meaning with
 * delivery evidence already present in the word-level transcript (pauses,
 * stretched delivery, sentence position and repetition). It returns a compact
 * keyword vocabulary that both renderers can persist through
 * `CaptionAccent.mode = 'keywords'`.
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or',
  'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** High-information words common to hooks, contrast and emotional delivery. */
const IMPACT_WORDS = new Set([
  'amazing', 'avoid', 'best', 'biggest', 'breakthrough', 'danger', 'easy', 'exactly',
  'fail', 'fear', 'free', 'hard', 'hate', 'important', 'impossible', 'instantly',
  'love', 'mistake', 'must', 'never', 'only', 'perfect', 'powerful', 'problem',
  'proof', 'real', 'secret', 'solution', 'stop', 'truth', 'viral', 'warning', 'worst',
]);

const bare = (token: string): string => token.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();
const sentenceEnd = (token: string): boolean => /[.!?…]["'”’)]*$/.test(token);

export interface AutoEmphasisOptions {
  /** Maximum fraction of transcript words represented by emphasis keywords. */
  readonly density?: number;
  /** Absolute cap; prevents a long transcript from turning emphasis into noise. */
  readonly maxKeywords?: number;
}

interface Candidate {
  readonly token: string;
  readonly firstIndex: number;
  score: number;
  occurrences: number;
}

/** Median of finite values, or zero for an empty input. */
const median = (values: readonly number[]): number => {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  /* v8 ignore next -- sole caller already returns early for an empty transcript */
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  /* v8 ignore next 3 -- indices are always in range; `?? 0` only satisfies noUncheckedIndexedAccess */
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/**
 * Select the transcript's strongest semantic anchor words.
 *
 * Selection is sparse by design: professional emphasis establishes hierarchy;
 * highlighting every content word removes it. Scores aggregate repeated uses,
 * but a logarithmic repetition penalty stops a repeated filler/topic word from
 * winning solely through frequency. Ties resolve by first spoken occurrence.
 */
export function autoEmphasisKeywords(
  words: readonly TranscriptWord[],
  options: AutoEmphasisOptions = {},
): readonly string[] {
  const usable = words.filter((word) => word.end > word.start && bare(word.word) !== '');
  if (usable.length === 0) return [];

  const typicalDuration = Math.max(0.08, median(usable.map((word) => word.end - word.start)));
  const candidates = new Map<string, Candidate>();

  usable.forEach((word, index) => {
    const token = bare(word.word);
    if (token.length < 3 || STOP_WORDS.has(token)) return;

    const previous = usable[index - 1];
    const next = usable[index + 1];
    const duration = word.end - word.start;
    const beforePause = previous ? Math.max(0, word.start - previous.end) : 0;
    const afterPause = next ? Math.max(0, next.start - word.end) : 0;

    let score = 1;
    score += Math.min(2.5, Math.max(0, duration / typicalDuration - 1) * 1.7);
    score += Math.min(2, beforePause / 0.18);
    score += Math.min(2, afterPause / 0.18);
    if (IMPACT_WORDS.has(token)) score += 3;
    if (/\d/.test(token)) score += 2;
    if (sentenceEnd(word.word)) score += 0.75;
    if (word.word.length >= 7) score += 0.5;
    if (word.confidence != null && word.confidence < 0.6) score -= 1.5;

    const existing = candidates.get(token);
    if (existing) {
      existing.score += score * 0.55;
      existing.occurrences += 1;
    } else {
      candidates.set(token, { token, firstIndex: index, score, occurrences: 1 });
    }
  });

  const density = Math.min(0.3, Math.max(0.04, options.density ?? 0.16));
  const maxKeywords = Math.max(1, Math.round(options.maxKeywords ?? 12));
  const desired = Math.min(maxKeywords, Math.max(1, Math.round(usable.length * density)));

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      adjusted: candidate.score / Math.sqrt(candidate.occurrences),
    }))
    .filter((candidate) => candidate.adjusted >= 1.75)
    .sort((a, b) => b.adjusted - a.adjusted || a.firstIndex - b.firstIndex)
    .slice(0, desired)
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((candidate) => candidate.token);
}
