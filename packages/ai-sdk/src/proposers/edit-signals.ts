/**
 * @framepilot/ai-sdk/proposers/edit-signals — what is measurably THERE in a span, stated as
 * facts, for the agent to decide what to do about it.
 *
 * ## What this replaced, and why
 *
 * This module used to be `candidate-proposer.ts`, and it decided editorial moves: seven
 * hardcoded rules mapping a signal to a move and a hand-tuned score — every highlight earned
 * a `punch_in` at `(score ?? 0.5) + 0.5` with the rationale *"salient highlight — a push-in
 * makes it land"*; a chapter whose TITLE matched a regex of reveal words earned another at
 * `0.7`; a long chapter with no highlight earned a `speed` ramp at `0.5`; a vertical target
 * earned a `reframe` on every highlight at `+0.3`. The model's job was to pick from the
 * ranking.
 *
 * That is the wrong way round, and a captured run showed both halves of the cost. The
 * ceiling: five candidates came back with one identical rationale between them, because no
 * rule can express a choice its author did not anticipate. The floor: the scores read as
 * evidence, so a model that defers to them stops exercising the judgement it is there for.
 *
 * The split this module now sits on:
 *
 * - **Facts** — onset distance, silence, scene cuts, chapter shape, spoken emphasis — belong
 *   to the runtime. The model cannot compute them and must never guess them.
 * - **Guarantees** — legality, overlap, frame bounds, aspect fill — belong to the runtime.
 * - **Judgement** — which moment is best, which move suits it, whether a 124ms offset matters
 *   *here* — belongs to the agent. The runtime's job is to make that decision cheap, visible
 *   and reversible; never to make it.
 *
 * So: no `kind`, no `score`, no canned `why`. Every entry says what was observed and where the
 * observation came from, in time order, and the agent decides.
 *
 * ## On provenance
 *
 * The signals are passed IN by the caller, which means they are only as real as the caller's
 * evidence. The same run that exposed the rules above handed this module a chapter list it had
 * invented — it never called `map_footage` — and received it back with `cite:` stamped on it,
 * which it then narrated to the editor as what was in the footage. `from` therefore says
 * plainly that a signal was supplied rather than measured here, and the orchestrator adds a
 * note when the run holds no footage evidence at all. This module never fabricates a span.
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:proposers:edit-signals');

/** What kind of thing was observed. Descriptive — never a move, never a verdict. */
export type EditSignalKind = 'highlight' | 'chapter' | 'silence' | 'emphasis' | 'scene_change';

/** One measured observation about a span of the timeline. */
export interface EditSignal {
  /** What was observed. */
  readonly kind: EditSignalKind;
  /** Span start (timeline seconds, inclusive). */
  readonly t0: number;
  /** Span end (timeline seconds, exclusive). */
  readonly t1: number;
  /** The measurement, stated as a fact — no recommendation, no ranking. */
  readonly observation: string;
  /**
   * Where the observation came from: `"supplied"` for a signal the caller passed in (a
   * footage map's chapters and highlights, an `analyze_silence` result), `"measured here"` for
   * one derived from the project itself (transcript emphasis).
   */
  readonly from: 'supplied' | 'measured here';
}

/** A chapter of the footage map, in timeline seconds (subset of `FootageChapter`). */
export interface SignalChapter {
  readonly t0: number;
  readonly t1: number;
  readonly title: string;
  readonly summary?: string | undefined;
}

/** A highlight of the footage map, in timeline seconds (subset of `FootageHighlight`). */
export interface SignalHighlight {
  readonly t0: number;
  readonly t1: number;
  readonly label: string;
  readonly score?: number | undefined;
}

/** A silent range (from `analyze_silence`), timeline seconds. */
export interface SignalSilence {
  readonly start: number;
  readonly end: number;
}

/** A transcript word (for emphasis detection), timeline seconds. */
export interface SignalWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** The bounded, already-gathered signals to describe. All optional. */
export interface EditSignalInput {
  readonly chapters?: readonly SignalChapter[];
  readonly highlights?: readonly SignalHighlight[];
  readonly silences?: readonly SignalSilence[];
  /** Scene-cut times (visual change points). */
  readonly sceneCuts?: readonly number[];
  /** Transcript words, for emphasis detection. */
  readonly transcript?: readonly SignalWord[];
}

/**
 * Silences shorter than this are natural breaths rather than gaps, and reporting every one
 * would bury the ones an editor might act on. A measurement threshold, not a decision about
 * what to do with what it finds.
 */
const MIN_REPORTABLE_SILENCE_SEC = 1.2;

/** Cap on reported signals so a long recording returns a readable set, not a wall. */
const MAX_SIGNALS = 60;

/** How long a scene-change observation's span is, for a point event. */
const SCENE_CHANGE_SPAN_SEC = 0.5;

const round1 = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);

/** Overlap test for two timeline ranges. */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

/**
 * Emphasised transcript words — ALL-CAPS, exclamations, or elongated spellings ("sooo").
 *
 * A measurement of the transcript, reported as one. What it is worth — a push-in, a caption
 * accent, nothing at all — is the agent's call.
 */
function emphasisWords(transcript: readonly SignalWord[]): SignalWord[] {
  return transcript.filter((word) => {
    const raw = word.word.trim();
    if (raw.length < 2) return false;
    const letters = raw.replace(/[^A-Za-z]/g, '');
    const isCaps = letters.length >= 2 && letters === letters.toUpperCase();
    const isBang = /!/.test(raw);
    const isElongated = /([a-zA-Z])\1\1/.test(raw); // 3+ repeated letters
    return isCaps || isBang || isElongated;
  });
}

/**
 * Describe every signal in the gathered inputs, in time order.
 *
 * Pure and deterministic: the same inputs always produce the same description, and an empty
 * input produces an empty list — never a fabricated span.
 */
export function readEditSignals(input: EditSignalInput): EditSignal[] {
  const chapters = input.chapters ?? [];
  const highlights = input.highlights ?? [];
  const silences = input.silences ?? [];
  const sceneCuts = input.sceneCuts ?? [];
  const transcript = input.transcript ?? [];
  const signals: EditSignal[] = [];

  for (const highlight of highlights) {
    const score =
      highlight.score === undefined ? '' : `, salience ${round1(highlight.score)} as supplied`;
    signals.push({
      kind: 'highlight',
      t0: highlight.t0,
      t1: highlight.t1,
      observation: `highlight "${highlight.label}", ${round1(highlight.t1 - highlight.t0)}s long${score}`,
      from: 'supplied',
    });
  }

  // A chapter's SHAPE, not a reading of its title. The old rule ran a reveal-word regex over
  // the title and emitted a punch-in; duration, highlight count and word count are what the
  // regex was standing in for, and the agent can read them itself.
  for (const chapter of chapters) {
    const inside = highlights.filter((h) => overlaps(chapter.t0, chapter.t1, h.t0, h.t1)).length;
    const words = transcript.filter((w) => overlaps(chapter.t0, chapter.t1, w.start, w.end)).length;
    const summary = chapter.summary?.trim();
    signals.push({
      kind: 'chapter',
      t0: chapter.t0,
      t1: chapter.t1,
      observation:
        `chapter "${chapter.title}", ${round1(chapter.t1 - chapter.t0)}s long, ` +
        `${String(inside)} highlight(s) inside, ${String(words)} transcript word(s)` +
        `${summary ? ` — ${summary}` : ''}`,
      from: 'supplied',
    });
  }

  for (const silence of silences) {
    const duration = silence.end - silence.start;
    if (duration < MIN_REPORTABLE_SILENCE_SEC) continue;
    signals.push({
      kind: 'silence',
      t0: silence.start,
      t1: silence.end,
      observation: `${round1(duration)}s of silence`,
      from: 'supplied',
    });
  }

  for (const cut of sceneCuts) {
    signals.push({
      kind: 'scene_change',
      t0: cut,
      t1: cut + SCENE_CHANGE_SPAN_SEC,
      observation: 'the picture changes here (detected scene cut)',
      from: 'supplied',
    });
  }

  for (const word of emphasisWords(transcript)) {
    signals.push({
      kind: 'emphasis',
      t0: word.start,
      t1: word.end,
      observation: `spoken emphasis: "${word.word.trim()}"`,
      from: 'measured here',
    });
  }

  // Time order, because that is the order an editor reads a timeline in. Ranking them would
  // be the judgement this module no longer makes.
  signals.sort((left, right) => left.t0 - right.t0 || left.t1 - right.t1);
  const capped = signals.slice(0, MAX_SIGNALS);
  log.action('readEditSignals → described spans', {
    chapters: chapters.length,
    highlights: highlights.length,
    silences: silences.length,
    sceneCuts: sceneCuts.length,
    reported: capped.length,
  });
  return capped;
}
