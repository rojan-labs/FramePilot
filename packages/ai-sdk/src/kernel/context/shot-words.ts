/**
 * @framepilot/ai-sdk/kernel/context/shot-words — turning measurements into the words a
 * clip row shows (ADR 0175, plan/visual-understanding VU2.3).
 *
 * The whole plan comes down to one line of text. Today the model reads `c12[0–4.2s]` and
 * knows nothing about the picture; after this it reads
 * `c12[61–66.4s] · MS man at desk · static · bright warm` and can answer "which clips are
 * dark?" without spending a turn and a thousand image tokens looking.
 *
 * Three rules decide everything in this file:
 *
 * 1. **The model reads words; the solver reads numbers.** A row never prints `0.47` or
 *    `+0.14`. A language model asked to compare two decimals will do it badly and
 *    confidently, and worse, it will then invent a third one to put in a grade. Numbers go
 *    to `match_color` and the transition policy, which can actually arithmetic.
 * 2. **Confidence gates language.** A `measured` fact is exact and always prints. A
 *    `labelled` or `described` fact prints only at {@link MIN_LABEL_CONFIDENCE}, because a
 *    guess rendered in the same typeface as a measurement becomes a fact the moment the
 *    model reads it.
 * 3. **Absent is silent.** A tier that has not run contributes nothing — never a neutral
 *    word. "Not measured yet" and "normal" must never look the same, or the agent will
 *    read an unindexed project as a uniformly average one.
 *
 * The budget is real: {@link MAX_ROW_CHARS} per clip, over the clip count the context
 * builder already bounds. That is what keeps the prompt from growing with the timeline.
 */
import type { DescribedFacts, LabelledFacts, MeasuredFacts } from '../../ledger.js';

/** Every fact a row can draw on, in the shape the picture slice hands over. */
export interface ShotFacts {
  readonly measured?: MeasuredFacts | null;
  readonly labelled?: LabelledFacts | null;
  readonly described?: DescribedFacts | null;
}

/**
 * Below this, a label is not said out loud.
 *
 * 0.6 rather than a rounder 0.5: at even odds the word carries no information, and a wrong
 * shot-size or subject in a clip row is worse than none — the model will plan a cutaway
 * around it.
 */
export const MIN_LABEL_CONFIDENCE = 0.6;

/**
 * Character budget for the fact suffix of one clip row.
 *
 * The context builder already bounds how many clips are shown; this bounds what each one
 * costs. ~90 characters is roughly 22 tokens — an order of magnitude under a single frame,
 * which is the trade the whole plan rests on.
 */
export const MAX_ROW_CHARS = 90;

/**
 * Exposure words, from `luma.mean` (0..1).
 *
 * Calibrated against the fixtures: a normally exposed interview sits at 0.40–0.43, and the
 * graded vertical fixture runs 0.20–0.45. The bands are deliberately wide — this is the
 * word an editor would use across the room, not a light meter.
 */
const DARK_BELOW = 0.22;
const DIM_BELOW = 0.35;
const BRIGHT_ABOVE = 0.62;
const BLOWN_ABOVE = 0.8;

/**
 * Warmth words, from `warmth` (-1..1, 0 = neutral).
 *
 * ±0.12 is the "you would not call this graded" band: the neutral interview fixture reads
 * within ±0.01 and the blue-graded opening of the vertical fixture reads about -0.6.
 */
const NEUTRAL_WARMTH = 0.12;
const STRONG_WARMTH = 0.45;

/** Contrast words, from `contrastIdx` (p90 − p10 of luma). */
const FLAT_BELOW = 0.25;
const PUNCHY_ABOVE = 0.65;

/** Below this the shot is soft enough that an editor would notice and not use it. */
const SOFT_BELOW = 0.35;

/** How much of the row a free-text description may take before it is trimmed. */
const MAX_SUBJECT_CHARS = 40;

export function exposureWord(lumaMean: number): string {
  if (lumaMean < DARK_BELOW) return 'dark';
  if (lumaMean < DIM_BELOW) return 'dim';
  if (lumaMean > BLOWN_ABOVE) return 'very bright';
  if (lumaMean > BRIGHT_ABOVE) return 'bright';
  return '';
}

export function warmthWord(warmth: number): string {
  if (warmth <= -STRONG_WARMTH) return 'very cool';
  if (warmth < -NEUTRAL_WARMTH) return 'cool';
  if (warmth >= STRONG_WARMTH) return 'very warm';
  if (warmth > NEUTRAL_WARMTH) return 'warm';
  return '';
}

export function contrastWord(contrastIdx: number): string {
  if (contrastIdx < FLAT_BELOW) return 'flat';
  if (contrastIdx > PUNCHY_ABOVE) return 'punchy';
  return '';
}

/**
 * Trim free text to the row budget on a word boundary.
 *
 * Mid-word truncation reads as a typo and invites the model to "correct" it; an ellipsis at
 * a word boundary reads as an abbreviation, which is what it is.
 */
export function trimToWords(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, '')}…`;
}

/** A label worth saying: present, and believed enough to say without hedging. */
function confident(label: { value: string; p: number } | null | undefined): string {
  if (!label) return '';
  return label.p >= MIN_LABEL_CONFIDENCE ? label.value : '';
}

/**
 * What the shot is OF, in as few words as the evidence supports.
 *
 * Preference order is deliberate: a described subject is the most useful thing a human
 * would say, a label is the fallback, and silence is correct when neither tier has run.
 */
function subjectPhrase(facts: ShotFacts): string {
  const described = facts.described;
  if (described && described.p >= MIN_LABEL_CONFIDENCE) {
    const subject = described.subject.trim() || described.summary.trim();
    if (subject) return trimToWords(subject, MAX_SUBJECT_CHARS);
  }
  const kind = confident(facts.labelled?.subjectKind);
  const setting = confident(facts.labelled?.setting);
  if (kind && setting) return trimToWords(`${kind}, ${setting}`, MAX_SUBJECT_CHARS);
  return trimToWords(kind || setting, MAX_SUBJECT_CHARS);
}

/**
 * One-glyph warnings an editor would want without being asked.
 *
 * Only conditions that make footage unusable, and only from the exact tier: black and
 * freeze are measured, so they are certain; softness is measured too. Nothing probabilistic
 * earns a warning glyph.
 */
function flagWord(measured: MeasuredFacts | null | undefined): string {
  if (!measured) return '';
  if (measured.black) return '⚑black';
  if (measured.freeze) return '⚑frozen';
  if (measured.sharpness < SOFT_BELOW) return '⚑soft';
  return '';
}

/**
 * Render one clip row's fact suffix.
 *
 * Order is fixed — framing, subject, movement, look, warning — so a model comparing two
 * rows compares like with like, and so the same shot always renders the same string
 * (which is also what keeps the prompt prefix cacheable).
 *
 * @param facts - The dominant shot's facts, whichever tiers have run.
 * @param maxChars - Row budget; defaults to {@link MAX_ROW_CHARS}.
 * @returns The suffix WITHOUT its leading separator, or `''` when nothing is known.
 */
export function shotWords(facts: ShotFacts, maxChars: number = MAX_ROW_CHARS): string {
  const measured = facts.measured;
  const parts: string[] = [];

  const framing = confident(facts.labelled?.shotSize) || facts.described?.camera?.shotSize || '';
  const subject = subjectPhrase(facts);
  const head = [framing, subject].filter(Boolean).join(' ');
  if (head) parts.push(head);

  if (measured) {
    parts.push(measured.motion.class);
    // Exposure, warmth and contrast share one segment: they are one impression ("dim and
    // cool"), and splitting them into three would spend the row budget on separators.
    const look = [
      exposureWord(measured.luma.mean),
      warmthWord(measured.warmth),
      contrastWord(measured.contrastIdx),
    ]
      .filter(Boolean)
      .join(' ');
    if (look) parts.push(look);
  }

  const flag = flagWord(measured);
  if (flag) parts.push(flag);

  if (parts.length === 0) return '';
  const rendered = parts.join(' · ');
  if (rendered.length <= maxChars) return rendered;
  // Over budget: drop from the RIGHT, because the left is the most identifying. A row that
  // loses its warning glyph is worse than one that loses its contrast word, so the flag is
  // re-appended if it still fits.
  const trimmed: string[] = [];
  let used = 0;
  for (const part of parts) {
    const cost = used === 0 ? part.length : part.length + 3;
    if (used + cost > maxChars) break;
    trimmed.push(part);
    used += cost;
  }
  if (flag && !trimmed.includes(flag)) {
    while (trimmed.length > 0 && used + flag.length + 3 > maxChars) {
      const dropped = trimmed.pop() ?? '';
      used -= dropped.length + (trimmed.length === 0 ? 0 : 3);
    }
    trimmed.push(flag);
  }
  return trimmed.join(' · ');
}

/**
 * Does this set of facts say anything at all?
 *
 * Used by the row renderer to decide whether to print a separator, and by the perception
 * metric that counts how many shown rows carry facts.
 */
export function hasShotWords(facts: ShotFacts): boolean {
  return shotWords(facts).length > 0;
}
