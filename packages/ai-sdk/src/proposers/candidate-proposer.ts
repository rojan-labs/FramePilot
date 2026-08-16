/**
 * @framepilot/ai-sdk/proposers/candidate-proposer — the deterministic grounded
 * candidate proposer (plan FI4.1).
 *
 * WHY: the primitives (`punch_in`, `set_clip_crop`, speed, transitions, ripple_delete)
 * and the craft skills exist, but nothing derived *where* those moves should go from
 * footage understanding — so the model invented placement from vibes (defect G4). This
 * module closes that gap: given the footage map, transcript emphasis, silence, scene
 * cuts, and loudness, it emits typed EDIT CANDIDATES — zoom/punch-in on emphasis and
 * reveals, reframe for subject-centering on a vertical target, speed ramps over
 * low-information stretches, cuts over dead air, and b-roll slots over narration.
 *
 * Every candidate carries a CITED span and a one-line WHY, so the model chooses taste
 * while the proposer guarantees each option is real and citable. It is a PURE function
 * of its inputs — no I/O, no model call, fully deterministic — so the same signals
 * always produce the same candidates (the model then picks and patches; "the model
 * decides taste, the proposer guarantees the evidence").
 *
 * Times are TIMELINE seconds throughout (the footage map is already projected onto
 * timeline time; the caller passes silence/scene/loudness in the same frame).
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:proposers:candidate-proposer');

/** The kinds of move the proposer can ground. Mirrors the real tool families. */
export type CandidateKind = 'punch_in' | 'reframe' | 'speed' | 'cut' | 'broll';

/** One grounded, citable edit candidate the model may accept and patch. */
export interface EditCandidate {
  /** Which move this is — maps to a real tool family (punch_in / set_clip_crop / …). */
  readonly kind: CandidateKind;
  /** Candidate start (timeline seconds, inclusive). */
  readonly t0: number;
  /** Candidate end (timeline seconds, exclusive). */
  readonly t1: number;
  /** One-line human rationale ("emphasis peak", "dead air", "low-information stretch"). */
  readonly why: string;
  /** The evidence this is grounded in ("highlight 1:05–1:20", "silence 3.2–5.1s"). */
  readonly cite: string;
  /** Salience; higher = stronger. Used only to order candidates, never a probability. */
  readonly score: number;
}

/** A chapter of the footage map, in timeline seconds (subset of `FootageChapter`). */
export interface ProposerChapter {
  readonly t0: number;
  readonly t1: number;
  readonly title: string;
  readonly summary?: string | undefined;
}

/** A highlight of the footage map, in timeline seconds (subset of `FootageHighlight`). */
export interface ProposerHighlight {
  readonly t0: number;
  readonly t1: number;
  readonly label: string;
  readonly score?: number | undefined;
}

/** A silent range (from `analyze_silence`), timeline seconds. */
export interface ProposerSilence {
  readonly start: number;
  readonly end: number;
}

/** A transcript word (for emphasis detection), timeline seconds. */
export interface ProposerWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** The bounded, already-gathered signals the proposer reasons over. All optional. */
export interface ProposerInput {
  readonly chapters?: readonly ProposerChapter[];
  readonly highlights?: readonly ProposerHighlight[];
  /** Silent ranges to cut (dead air). */
  readonly silences?: readonly ProposerSilence[];
  /** Scene-cut times (visual variety signal). */
  readonly sceneCuts?: readonly number[];
  /** Transcript words, for emphasis detection. */
  readonly transcript?: readonly ProposerWord[];
  /** When true, the target is vertical (9:16) → reframe candidates for subject-centering. */
  readonly verticalTarget?: boolean;
}

// --- Tunable heuristics (WHY each threshold, not magic numbers) ------------------

/** A silence at/over this long is dead air worth cutting; shorter gaps are natural breaths. */
const MIN_DEAD_AIR_SEC = 1.2;
/** A chapter at/over this long with no highlight is a low-information stretch → speed ramp. */
const LONG_CHAPTER_SEC = 20;
/** A talking chapter at/over this long earns a b-roll slot to break up the talking head. */
const BROLL_MIN_TALKING_SEC = 8;
/** A punch-in centred on an emphasis word runs this long (a brief push-in, not a hold). */
const PUNCH_IN_SEC = 1.5;
/** Cap on total candidates so the model gets a focused, rankable set, not a wall. */
const MAX_CANDIDATES = 40;

/** Chapter titles/summaries that read as a reveal/payoff earn a punch-in. */
const REVEAL_WORDS =
  /\b(reveal|reveals|revealed|introduc|unveil|result|payoff|the moment|finally|surprise|big|key)\b/i;
/** Summaries that read as talking-head narration earn a b-roll slot. */
const NARRATION_WORDS =
  /\b(talk|talking|speak|speaking|explain|narrat|discuss|interview|says|saying|to camera|piece to camera)\b/i;

/** Overlap test for two timeline ranges. */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

/**
 * Detect emphasised transcript words — ALL-CAPS words, exclamations, or elongated
 * spellings ("sooo"). Emphasis is a proven place a push-in earns its keep (a spoken
 * beat the editor wants the viewer to feel), so each becomes a punch-in candidate.
 */
function emphasisWords(transcript: readonly ProposerWord[]): ProposerWord[] {
  return transcript.filter((w) => {
    const raw = w.word.trim();
    if (raw.length < 2) return false;
    const letters = raw.replace(/[^A-Za-z]/g, '');
    const isCaps = letters.length >= 2 && letters === letters.toUpperCase();
    const isBang = /!/.test(raw);
    const isElongated = /([a-zA-Z])\1\1/.test(raw); // 3+ repeated letters
    return isCaps || isBang || isElongated;
  });
}

/**
 * Propose grounded edit candidates from the gathered signals (plan FI4.1).
 *
 * Deterministic and pure: every candidate is derived from a real span in the inputs and
 * carries a citation the model can echo in its human-language WHY. The result is ordered
 * best-first (by score, then time) and capped to {@link MAX_CANDIDATES}. An empty input
 * yields an empty list (honest — never a fabricated move).
 */
export function proposeCandidates(input: ProposerInput): EditCandidate[] {
  const chapters = input.chapters ?? [];
  const highlights = input.highlights ?? [];
  const silences = input.silences ?? [];
  const transcript = input.transcript ?? [];
  const candidates: EditCandidate[] = [];

  // 1) Cut dead air: each long silence is a citable ripple_delete/delete_range target.
  for (const s of silences) {
    const dur = s.end - s.start;
    if (dur < MIN_DEAD_AIR_SEC) continue;
    candidates.push({
      kind: 'cut',
      t0: s.start,
      t1: s.end,
      why: `dead air (${dur.toFixed(1)}s of silence)`,
      cite: `silence ${s.start.toFixed(1)}–${s.end.toFixed(1)}s`,
      score: Math.min(1, dur / 5) + 1, // longer gaps rank higher; cuts are high-value
    });
  }

  // 2) Punch-in on highlights (the moments Pegasus judged salient) — a push-in makes the
  //    payoff land. Highlight score (when present) carries through to ordering.
  for (const h of highlights) {
    candidates.push({
      kind: 'punch_in',
      t0: h.t0,
      t1: h.t1,
      why: 'salient highlight — a push-in makes it land',
      cite: `highlight "${h.label}" ${h.t0.toFixed(1)}–${h.t1.toFixed(1)}s`,
      score: (h.score ?? 0.5) + 0.5,
    });
  }

  // 3) Punch-in on chapter reveals (a titled reveal/payoff is a deliberate beat).
  for (const c of chapters) {
    if (!REVEAL_WORDS.test(`${c.title} ${c.summary ?? ''}`)) continue;
    candidates.push({
      kind: 'punch_in',
      t0: c.t0,
      t1: Math.min(c.t1, c.t0 + PUNCH_IN_SEC * 2),
      why: 'chapter reads as a reveal/payoff',
      cite: `chapter "${c.title}" ${c.t0.toFixed(1)}–${c.t1.toFixed(1)}s`,
      score: 0.7,
    });
  }

  // 4) Punch-in on spoken emphasis (a beat the speaker leaned on).
  for (const w of emphasisWords(transcript)) {
    const mid = (w.start + w.end) / 2;
    candidates.push({
      kind: 'punch_in',
      t0: Math.max(0, mid - PUNCH_IN_SEC / 2),
      t1: mid + PUNCH_IN_SEC / 2,
      why: `spoken emphasis ("${w.word.trim()}")`,
      cite: `transcript @${w.start.toFixed(1)}s`,
      score: 0.6,
    });
  }

  // 5) Speed ramp over low-information stretches: a long chapter with no highlight in it
  //    is dead weight — ramp it so the edit keeps moving.
  for (const c of chapters) {
    const dur = c.t1 - c.t0;
    if (dur < LONG_CHAPTER_SEC) continue;
    const hasHighlight = highlights.some((h) => overlaps(c.t0, c.t1, h.t0, h.t1));
    if (hasHighlight) continue;
    candidates.push({
      kind: 'speed',
      t0: c.t0,
      t1: c.t1,
      why: `low-information stretch (${dur.toFixed(0)}s, no highlight)`,
      cite: `chapter "${c.title}" ${c.t0.toFixed(1)}–${c.t1.toFixed(1)}s`,
      score: 0.5,
    });
  }

  // 6) B-roll slot over sustained narration: a long talking chapter earns cutaways so it
  //    is not a static talking head. Grounded either by a narration-flavoured summary or
  //    by sustained dialogue with no scene variety.
  for (const c of chapters) {
    const dur = c.t1 - c.t0;
    if (dur < BROLL_MIN_TALKING_SEC) continue;
    const words = transcript.filter((w) => overlaps(c.t0, c.t1, w.start, w.end)).length;
    const reads = NARRATION_WORDS.test(`${c.title} ${c.summary ?? ''}`);
    if (!reads && words < 5) continue;
    candidates.push({
      kind: 'broll',
      t0: c.t0,
      t1: c.t1,
      why: 'sustained narration — cutaways break up the talking head',
      cite: `chapter "${c.title}" ${c.t0.toFixed(1)}–${c.t1.toFixed(1)}s`,
      score: 0.4,
    });
  }

  // 7) Reframe for subject-centering — only when the target is vertical (9:16), where a
  //    wide shot must be re-cropped to keep the subject in frame.
  if (input.verticalTarget) {
    for (const h of highlights) {
      candidates.push({
        kind: 'reframe',
        t0: h.t0,
        t1: h.t1,
        why: 'vertical target — center the subject on this highlight',
        cite: `highlight "${h.label}" ${h.t0.toFixed(1)}–${h.t1.toFixed(1)}s`,
        score: (h.score ?? 0.5) + 0.3,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.t0 - b.t0);
  const capped = candidates.slice(0, MAX_CANDIDATES);
  log.action('proposeCandidates → grounded candidates', {
    chapters: chapters.length,
    highlights: highlights.length,
    silences: silences.length,
    proposed: capped.length,
  });
  return capped;
}
